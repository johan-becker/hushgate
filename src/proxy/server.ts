/**
 * The proxy: an OpenAI- and Anthropic-compatible HTTP front end that redacts
 * what goes out and re-hydrates what comes back.
 *
 * Point your SDK's base URL at it and nothing else in your application changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nullAuditLog, type AuditSink } from '../audit/log.js';
import type { AuditOutcome, AuditResidency } from '../audit/record.js';
import { redactionOptions, type HushgateConfig } from '../config.js';
import {
  BlockedContentError,
  ConfigError,
  RequestError,
  ResidencyBlockedError,
  TraversalDepthError,
  UpstreamError,
} from '../errors.js';
import { applyDataControls } from '../residency/controls.js';
import {
  assertNotBlocked,
  assertUpstreamsPermitted,
  enforcementFor,
  type ResidencyVerdict,
} from '../residency/policy.js';
import { countByKind, Session } from '../redact/session.js';
import { redactJson, restoreJson, type JsonValue } from '../redact/traverse.js';
import { SseRehydrator } from '../stream/sse.js';
import type { Finding, Policy } from '../types.js';
import { VERSION } from '../version.js';
import {
  errorPayload,
  forwardRequestHeaders,
  forwardResponseHeaders,
  parseJsonObject,
  readBody,
  sendJson,
} from './http.js';
import { findRoute, type ProviderId, type Route } from './routes.js';
import { collect, nodeUpstreamClient, type UpstreamClient, type UpstreamResponse } from './upstream.js';

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
  /** Where request records go. Defaults to discarding them. */
  readonly audit?: AuditSink;
  /** Sink for internal failures. Defaults to `console.error`. */
  readonly onInternalError?: (error: unknown) => void;
  /** Sink for residency warnings. Defaults to `console.warn`. */
  readonly onWarning?: (message: string) => void;
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

  // Fail closed, and fail early: nothing is bound until every configured
  // upstream has been checked against the residency allowlist.
  const verdicts = assertUpstreamsPermitted(
    { openai: config.upstreams.openai, anthropic: config.upstreams.anthropic },
    config.residency,
  );
  const residencyByProvider: Readonly<Record<ProviderId, ResidencyVerdict>> = {
    openai: verdicts[0]!,
    anthropic: verdicts[1]!,
  };
  const upstream = options.upstream ?? nodeUpstreamClient;
  const sessionOptions = redactionOptions(config);
  const createSession = options.createSession ?? ((): Session => new Session(sessionOptions));
  const audit = options.audit ?? nullAuditLog;
  const onInternalError = options.onInternalError ?? ((error): void => console.error(error));
  const onWarning = options.onWarning ?? ((message): void => console.warn(message));

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
    const started = Date.now();
    const base = upstreamBase(config, route);

    // Filled in as the request progresses; written exactly once, whatever
    // happens, so a refused or failed request is as auditable as a served one.
    let outcome: AuditOutcome = 'rejected';
    let status = 500;
    let stream = false;
    let reached: string | null = null;
    let findings: readonly Finding[] = [];
    let blockedCounts: Record<string, number> | null = null;
    let residency: AuditResidency | null = null;

    try {
      const body = await readBody(request, config.limits.maxBodyBytes);
      const parsed = parseJsonObject(body);
      const session = createSession(route);

      // Outbound: only the content-bearing leaves are rewritten. A `block`
      // policy throws here, before a single byte has left the machine.
      const redacted = redactJson(parsed as JsonValue, session, route.rules);
      findings = redacted.findings;

      const verdict = residencyByProvider[route.provider];
      const counts = countByKind(findings);
      const decision = enforcementFor(config.residency, route.label, Object.keys(counts));
      residency = {
        mode: decision.mode,
        rule: decision.rule,
        jurisdiction: verdict.jurisdiction.code,
        controls: [],
      };

      // Refuses before serialisation: in `block` mode nothing leaves at all.
      assertNotBlocked(decision, verdict, counts);

      // `warn` and `allow` forward the request as it came in. That is the point
      // of a staged rollout: you see what would be redacted before it is.
      const outbound = decision.mode === 'warn' || decision.mode === 'allow' ? parsed : redacted.body;
      if (decision.mode === 'warn' && findings.length > 0) {
        onWarning(
          `hushgate: ${decision.rule} is set to warn — ${describeCounts(counts)} left the machine for ${verdict.host} [${verdict.jurisdiction.code}]`,
        );
      }

      // Retention and training opt-outs are set here, not left to each caller:
      // one application forgetting `store: false` should not opt the whole
      // organisation back into retention.
      const controlled = applyDataControls(verdict.dataControls, outbound as JsonValue);
      residency = { ...residency, controls: controlled.applied };

      reached = hostOf(base);
      const upstreamResponse = await upstream({
        url: `${base}${route.path}`,
        method: 'POST',
        headers: { ...forwardRequestHeaders(request.headers), ...controlled.headers },
        body: JSON.stringify(controlled.body),
        timeoutMs: config.limits.upstreamTimeoutMs,
      });

      outcome = 'forwarded';
      status = upstreamResponse.status;

      const contentType = upstreamResponse.headers['content-type'] ?? '';
      if (contentType.includes('text/event-stream')) {
        stream = true;
        await pipeEventStream(route, session, upstreamResponse, response);
        return;
      }

      const raw = await collect(upstreamResponse.body);
      const restored = rehydrate(raw, contentType, session);
      const payload = Buffer.from(restored, 'utf8');

      if (response.writableEnded) return;
      response.writeHead(upstreamResponse.status, {
        ...forwardResponseHeaders(upstreamResponse.headers),
        'content-length': String(payload.length),
      });
      response.end(payload);
    } catch (error) {
      status = statusOf(error);
      if (error instanceof BlockedContentError || error instanceof ResidencyBlockedError) {
        outcome = 'blocked';
        blockedCounts = { ...error.counts };
        // Nothing was sent, so nothing was reached.
        reached = null;
      } else if (error instanceof UpstreamError) {
        outcome = 'failed';
      } else if (outcome === 'forwarded') {
        outcome = 'failed';
      }
      throw error;
    } finally {
      audit.write({
        route: route.label,
        outcome,
        status,
        latencyMs: Date.now() - started,
        stream,
        upstream: reached,
        findings: blockedCounts ?? countByKind(findings),
        policies: blockedCounts === null ? policiesOf(findings) : policiesForBlock(blockedCounts),
        residency,
      });
    }
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
 * Stream an SSE response through, re-hydrating as it goes.
 *
 * Buffering the stream would restore just as correctly and destroy the only
 * reason the caller asked for a stream, so nothing is held back except the
 * handful of bytes that might still be part of a placeholder.
 */
async function pipeEventStream(
  route: Route,
  session: Session,
  upstreamResponse: UpstreamResponse,
  response: ServerResponse,
): Promise<void> {
  const rehydrator = new SseRehydrator({
    deltaRules: route.streamRules,
    resolve: (token) => session.lookup(token),
  });
  // A multi-byte character can straddle two TCP segments just as easily as a
  // placeholder can; a per-chunk toString would corrupt it.
  const decoder = new TextDecoder('utf-8');

  response.writeHead(upstreamResponse.status, {
    ...forwardResponseHeaders(upstreamResponse.headers),
    'cache-control': 'no-cache, no-transform',
    // Ask intermediaries not to buffer the stream they are relaying.
    'x-accel-buffering': 'no',
  });
  response.flushHeaders();

  // If the caller hangs up, stop pulling tokens we are paying for.
  const abandon = (): void => {
    upstreamResponse.body.destroy();
  };
  response.once('close', abandon);

  try {
    for await (const chunk of upstreamResponse.body) {
      const text = decoder.decode(chunk as Buffer, { stream: true });
      await writeChunk(response, rehydrator.push(text));
    }

    await writeChunk(response, rehydrator.push(decoder.decode()));
    await writeChunk(response, rehydrator.flush());
    response.end();
  } finally {
    response.removeListener('close', abandon);
  }
}

/** Write one piece, respecting backpressure without ever hanging on a dead socket. */
function writeChunk(response: ServerResponse, text: string): Promise<void> {
  if (text.length === 0 || response.writableEnded || response.destroyed) return Promise.resolve();

  return new Promise((resolve) => {
    if (response.write(text)) {
      resolve();
      return;
    }
    const done = (): void => {
      response.removeListener('drain', done);
      response.removeListener('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

/**
 * Re-hydrate a complete response body.
 *
 * JSON is walked structurally; anything else — an SSE stream, an HTML error page
 * from a corporate proxy — is treated as text. Both are safe: only tokens this
 * session issued are ever replaced.
 */
function rehydrate(raw: string, contentType: string, session: Session): string {
  if (raw.length === 0) return raw;

  if (contentType.includes('json')) {
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

/** Host of an upstream base URL, for the audit trail. Never the full URL. */
function hostOf(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

/** Which policy was applied to each kind that was found. */
function policiesOf(findings: readonly Finding[]): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const finding of findings) out[finding.kind] = finding.policy;
  return out;
}

function policiesForBlock(counts: Readonly<Record<string, number>>): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const kind of Object.keys(counts)) out[kind] = 'block';
  return out;
}

/** `EMAIL (2), IBAN (1)` — counts only, safe to print. */
function describeCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([kind, count]) => `${kind} (${count})`)
    .join(', ');
}

/** The status a failure maps to, shared by the responder and the audit trail. */
export function statusOf(error: unknown): number {
  if (error instanceof BlockedContentError) return 403;
  if (error instanceof ResidencyBlockedError) return 403;
  if (error instanceof RequestError) return error.status;
  if (error instanceof TraversalDepthError) return 400;
  if (error instanceof UpstreamError) return error.status;
  return 500;
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
  // Once a streaming response has started there is no envelope left to write
  // into; the only honest thing is to end the stream.
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error instanceof ResidencyBlockedError) {
    sendJson(
      response,
      statusOf(error),
      errorPayload('hushgate_residency_blocked', error.message, {
        rule: error.rule,
        jurisdiction: error.jurisdiction,
        kinds: error.kinds,
        counts: error.counts,
      }),
    );
    return;
  }

  if (error instanceof BlockedContentError) {
    sendJson(
      response,
      statusOf(error),
      errorPayload('hushgate_policy_blocked', error.message, {
        kinds: error.kinds,
        counts: error.counts,
      }),
    );
    return;
  }

  if (error instanceof RequestError) {
    sendJson(response, statusOf(error), errorPayload(error.type, error.message));
    return;
  }

  if (error instanceof TraversalDepthError) {
    sendJson(response, statusOf(error), errorPayload('invalid_request_error', error.message));
    return;
  }

  if (error instanceof UpstreamError) {
    sendJson(response, statusOf(error), errorPayload('upstream_error', error.message));
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
