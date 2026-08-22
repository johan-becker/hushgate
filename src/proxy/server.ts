/**
 * The proxy: an OpenAI- and Anthropic-compatible HTTP front end that redacts
 * what goes out and re-hydrates what comes back.
 *
 * Point your SDK's base URL at it and nothing else in your application changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactionOptions, type HushgateConfig } from '../config.js';
import {
  BlockedContentError,
  ConfigError,
  RequestError,
  TraversalDepthError,
  UpstreamError,
} from '../errors.js';
import { Session } from '../redact/session.js';
import { redactJson, restoreJson, type JsonValue } from '../redact/traverse.js';
import { VERSION } from '../version.js';
import {
  errorPayload,
  forwardRequestHeaders,
  forwardResponseHeaders,
  parseJsonObject,
  readBody,
  sendJson,
} from './http.js';
import { findRoute, type Route } from './routes.js';
import { collect, nodeUpstreamClient, type UpstreamClient } from './upstream.js';

export interface ProxyOptions {
  readonly config: HushgateConfig;
  /** Substitutable so tests can run against a fake provider. */
  readonly upstream?: UpstreamClient;
  /**
   * Session factory. The default mints one session per request: the placeholder
   * mapping only has to survive long enough to re-hydrate that request's
   * response, and a mapping that outlives the request is a liability, not a
   * feature — the client resends the whole conversation anyway.
   */
  readonly createSession?: (route: Route) => Session;
  /** Sink for internal failures. Defaults to `console.error`. */
  readonly onInternalError?: (error: unknown) => void;
}

export interface ProxyServer {
  readonly server: Server;
  /** Start listening on the configured host and port. */
  listen(): Promise<AddressInfo>;
  /** Stop accepting connections and wait for in-flight requests to finish. */
  close(options?: { readonly graceMs?: number }): Promise<void>;
  /** `http://host:port` once listening, otherwise `null`. */
  readonly origin: string | null;
}

/** Build the proxy. Nothing is bound until {@link ProxyServer.listen} is called. */
export function createProxyServer(options: ProxyOptions): ProxyServer {
  const { config } = options;
  const upstream = options.upstream ?? nodeUpstreamClient;
  const sessionOptions = redactionOptions(config);
  const createSession = options.createSession ?? ((): Session => new Session(sessionOptions));
  const onInternalError = options.onInternalError ?? ((error): void => console.error(error));

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      onInternalError(error);
      respondWithError(response, error);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = pathOf(request);

    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, 'GET');
        return;
      }
      sendJson(response, 200, { status: 'ok', version: VERSION });
      return;
    }

    const route = findRoute(pathname);
    if (route === undefined) {
      sendJson(
        response,
        404,
        errorPayload('not_found', `hushgate does not proxy ${request.method ?? 'GET'} ${pathname}`),
      );
      return;
    }

    if (request.method !== 'POST') {
      methodNotAllowed(response, 'POST');
      return;
    }

    await proxy(route, request, response);
  }

  async function proxy(
    route: Route,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request, config.limits.maxBodyBytes);
    const parsed = parseJsonObject(body);
    const session = createSession(route);

    // Outbound: only the content-bearing leaves are rewritten. A `block` policy
    // throws here, before a single byte has left the machine.
    const { body: sanitised } = redactJson(parsed as JsonValue, session, route.rules);

    const upstreamResponse = await upstream({
      url: `${upstreamBase(config, route)}${route.path}`,
      method: 'POST',
      headers: forwardRequestHeaders(request.headers),
      body: JSON.stringify(sanitised),
      timeoutMs: config.limits.upstreamTimeoutMs,
    });

    const raw = await collect(upstreamResponse.body);
    const restored = rehydrate(raw, upstreamResponse.headers['content-type'], session);
    const payload = Buffer.from(restored, 'utf8');

    if (response.writableEnded) return;
    response.writeHead(upstreamResponse.status, {
      ...forwardResponseHeaders(upstreamResponse.headers),
      'content-length': String(payload.length),
    });
    response.end(payload);
  }

  return {
    server,

    listen(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', onError);
          resolve(server.address() as AddressInfo);
        });
      });
    },

    close({ graceMs = 5_000 }: { readonly graceMs?: number } = {}): Promise<void> {
      return new Promise((resolve, reject) => {
        // Idle keep-alive sockets would otherwise hold the server open for as
        // long as the client felt like it.
        server.closeIdleConnections();
        const forced = setTimeout(() => server.closeAllConnections(), graceMs);
        forced.unref();

        server.close((error) => {
          clearTimeout(forced);
          if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },

    get origin(): string | null {
      const address = server.address();
      if (address === null || typeof address === 'string') return null;
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      return `http://${host}:${address.port}`;
    },
  };
}

/**
 * Re-hydrate a complete response body.
 *
 * JSON is walked structurally; anything else — an SSE stream, an HTML error page
 * from a corporate proxy — is treated as text. Both are safe: only tokens this
 * session issued are ever replaced.
 */
function rehydrate(raw: string, contentType: string | undefined, session: Session): string {
  if (raw.length === 0) return raw;

  if ((contentType ?? '').includes('json')) {
    try {
      return JSON.stringify(restoreJson(JSON.parse(raw) as JsonValue, session));
    } catch {
      // A body that claims to be JSON but is not still has to reach the caller.
      return session.restore(raw);
    }
  }

  return session.restore(raw);
}

function upstreamBase(config: HushgateConfig, route: Route): string {
  return route.provider === 'openai' ? config.upstreams.openai : config.upstreams.anthropic;
}

function pathOf(request: IncomingMessage): string {
  const target = request.url ?? '/';
  const query = target.indexOf('?');
  return query === -1 ? target : target.slice(0, query);
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  sendJson(
    response,
    405,
    errorPayload('method_not_allowed', `this route only accepts ${allow}`),
    { allow },
  );
}

/** Map an internal failure onto the error envelope the SDKs understand. */
export function respondWithError(response: ServerResponse, error: unknown): void {
  if (error instanceof BlockedContentError) {
    sendJson(
      response,
      403,
      errorPayload('hushgate_policy_blocked', error.message, {
        kinds: error.kinds,
        counts: error.counts,
      }),
    );
    return;
  }

  if (error instanceof RequestError) {
    sendJson(response, error.status, errorPayload(error.type, error.message));
    return;
  }

  if (error instanceof TraversalDepthError) {
    sendJson(response, 400, errorPayload('invalid_request_error', error.message));
    return;
  }

  if (error instanceof UpstreamError) {
    sendJson(response, error.status, errorPayload('upstream_error', error.message));
    return;
  }

  if (error instanceof ConfigError) {
    sendJson(response, 500, errorPayload('hushgate_config_error', error.message));
    return;
  }

  // Deliberately generic: an unexpected error's message can quote the request,
  // and the request is exactly what must not be echoed back over the wire.
  sendJson(
    response,
    500,
    errorPayload('hushgate_error', 'hushgate failed to process this request'),
  );
}
