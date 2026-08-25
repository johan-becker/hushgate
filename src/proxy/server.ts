/**
 * The proxy: an OpenAI- and Anthropic-compatible HTTP front end that redacts
 * what goes out and re-hydrates what comes back.
 *
 * Point your SDK's base URL at it and nothing else in your application changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { nullAuditLog, type AuditSink } from '../audit/log.js';
import type { AuditOutcome, AuditResidency } from '../audit/record.js';
import { redactionOptions, type HushgateConfig } from '../config.js';
import {
  AttachmentBlockedError,
  AuthenticationError,
  BlockedContentError,
  ConfigError,
  HushgateError,
  QuotaExceededError,
  RequestError,
  ResidencyBlockedError,
  TraversalDepthError,
  UpstreamError,
} from '../errors.js';
import { Metrics } from '../metrics/registry.js';
import { applyDataControls } from '../residency/controls.js';
import { QuotaTracker } from '../tenants/quota.js';
import {
  assertNotOpenRelay,
  createTenantRegistry,
  deriveTenantKey,
  presentedKey,
  type Tenant,
} from '../tenants/tenant.js';
import { tokensFrom } from './usage.js';
import {
  assertNotBlocked,
  assertUpstreamsPermitted,
  enforcementFor,
  type ResidencyVerdict,
} from '../residency/policy.js';
import { countByKind, Session, type SessionOptions } from '../redact/session.js';
import { buildExtractors } from '../attach/registry.js';
import { rewriteAttachments } from '../attach/rewrite.js';
import type { AttachmentReport } from '../attach/types.js';
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
  sendText,
} from './http.js';
import { findRoute, type ProviderId, type Route } from './routes.js';
import { withRetry } from './retry.js';
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
  readonly createSession?: (route: Route, tenant: Tenant | null) => Session;
  /** Where upstream credentials are read from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Audit sink per tenant. Falls back to `audit`. */
  readonly auditFor?: (tenant: Tenant | null) => AuditSink;
  /** Quota state. Injected so tests can drive the clock. */
  readonly quotas?: QuotaTracker;
  /** Metrics registry served at /metrics. One is created when omitted. */
  readonly metrics?: Metrics;
  /** Where request records go. Defaults to discarding them. */
  readonly audit?: AuditSink;
  /** Sink for failures the handler threw. Defaults to {@link reportFailure}. */
  readonly onInternalError?: (error: unknown) => void;
  /** Sink for residency warnings. Defaults to `console.warn`. */
  readonly onWarning?: (message: string) => void;
}

export interface ProxyServer {
  readonly server: Server;
  /** The metrics this server is recording into. */
  readonly metrics: Metrics;
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
  const onWarning = options.onWarning ?? ((message): void => console.warn(message));

  const upstream = withRetry(options.upstream ?? nodeUpstreamClient, {
    retries: config.limits.upstreamRetries,
    backoffMs: config.limits.retryBackoffMs,
    onRetry: (attempt, delayMs, error) =>
      onWarning(
        `hushgate: upstream attempt ${attempt} failed (${error.reason}), retrying in ${delayMs} ms`,
      ),
  });
  const env = options.env ?? process.env;

  const registry = createTenantRegistry(config.tenants);
  assertNotOpenRelay(config.host, registry);

  // One profile per tenant, resolved once: a tenant's policies, dictionary and
  // hash namespace are fixed for the lifetime of the process.
  const profiles = new Map<string, SessionOptions>(
    config.tenants.map((tenant) => [tenant.id, tenantProfile(config, tenant)]),
  );
  const globalProfile = redactionOptions(config);

  const createSession =
    options.createSession ??
    ((_route: Route, tenant: Tenant | null): Session =>
      new Session(tenant === null ? globalProfile : (profiles.get(tenant.id) ?? globalProfile)));

  // Built once: an external extractor spec becomes a closure over its command
  // and arguments, and nothing about it varies per request.
  const extractors = buildExtractors(config.attachments.extractors);

  const audit = options.audit ?? nullAuditLog;
  const auditFor = options.auditFor ?? ((): AuditSink => audit);
  const quotas = options.quotas ?? new QuotaTracker();
  const metrics = options.metrics ?? new Metrics();
  const onInternalError = options.onInternalError ?? ((error: unknown): void => reportFailure(error));

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

    if (pathname === '/metrics') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        methodNotAllowed(response, 'GET');
        return;
      }
      // Scraped like any other endpoint: open on loopback, authenticated once
      // tenants exist. The numbers are counts, but counts are still telemetry.
      authenticate(request);
      sendText(response, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
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

  /**
   * Resolve the caller's tenant.
   *
   * With no tenants configured hushgate is single-tenant and loopback-only (see
   * assertNotOpenRelay), and the caller's own provider key is passed straight
   * through.
   */
  function authenticate(request: IncomingMessage): Tenant | null {
    if (registry.empty) return null;

    const tenant = registry.authenticate(presentedKey(request.headers));
    if (tenant === null) {
      throw new AuthenticationError(
        'a hushgate tenant key is required; send it as Authorization: Bearer <key> or x-api-key',
      );
    }
    return tenant;
  }

  /**
   * Swap the caller's credential for the upstream one.
   *
   * This is the security-critical part of multi-tenant operation: a hushgate
   * tenant key must never reach a provider. Once a key has authenticated a
   * tenant, the header carrying it is dropped and replaced by the upstream
   * credential, or by nothing at all when none is configured.
   */
  function upstreamHeaders(
    tenant: Tenant | null,
    route: Route,
    headers: Record<string, string>,
  ): Record<string, string> {
    if (tenant === null) return headers;

    const withoutCallerKey = { ...headers };
    delete withoutCallerKey['authorization'];
    delete withoutCallerKey['x-api-key'];

    const variable = tenant.upstreamKeyEnv ?? DEFAULT_KEY_ENV[route.provider];
    const key = env[variable];
    if (key === undefined || key.length === 0) return withoutCallerKey;

    return {
      ...withoutCallerKey,
      ...(route.provider === 'openai'
        ? { authorization: `Bearer ${key}` }
        : { 'x-api-key': key }),
    };
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
    // Authentication and quota admission are inside the try for that reason:
    // a rejected key and an exhausted quota are exactly the events an auditor
    // and an on-call operator need to see, and running them out here would
    // leave a brute force against tenant keys no trace at all.
    let tenant: Tenant | null = null;
    let outcome: AuditOutcome = 'rejected';
    let status = 500;
    let stream = false;
    let reached: string | null = null;
    let findings: readonly Finding[] = [];
    let blockedCounts: Record<string, number> | null = null;
    let residency: AuditResidency | null = null;
    let tokens = 0;
    let attachments: readonly AttachmentReport[] = [];

    try {
      // Authentication happens before the body is read: an unauthenticated
      // caller must not get as far as spending memory on their payload.
      tenant = authenticate(request);
      // Refused before the body is read: an over-quota caller should not be
      // able to make hushgate buffer four megabytes on their behalf.
      if (tenant !== null) quotas.admit(tenant);

      const body = await readBody(request, config.limits.maxBodyBytes);
      const session = createSession(route, tenant);

      // Attachments first, and the result is what everything downstream sees.
      // A document becomes a text content part here, so by the time the
      // redactor runs there is nothing left in the body but prose — which is
      // the only thing it knows how to protect.
      //
      // Note that `parsed` itself is rebound. The residency `warn` and `allow`
      // modes forward `parsed` rather than the redacted body, deliberately, so
      // an operator can see what would be redacted before it is. That
      // concession is about redaction; it must not extend to forwarding a
      // document hushgate never read, so both bodies descend from the rewritten
      // one.
      const rewritten = await rewriteAttachments(parseJsonObject(body) as JsonValue, {
        limits: config.attachments,
        extractors,
        // The route's own rules, so the rewrite can check that the text it is
        // about to insert lands somewhere redaction will visit.
        rules: route.rules,
        // The same detectors that will run over the text a moment later, so the
        // rewrite can ask whether the extraction hid anything from them.
        countFindings: (text) => session.countFindings(text),
      });
      const parsed = rewritten.body;
      attachments = rewritten.reports;
      for (const report of attachments) {
        metrics.observeAttachment({
          format: report.format,
          outcome: report.outcome,
          extractor: report.extractor,
          bytes: report.bytes,
        });
      }

      // Outbound: only the content-bearing leaves are rewritten. A `block`
      // policy throws here, before a single byte has left the machine.
      const redacted = redactJson(parsed, session, route.rules);
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
        headers: {
          ...upstreamHeaders(tenant, route, forwardRequestHeaders(request.headers)),
          ...controlled.headers,
        },
        body: JSON.stringify(controlled.body),
        timeoutMs: config.limits.upstreamTimeoutMs,
      });

      outcome = 'forwarded';
      status = upstreamResponse.status;

      const countTokens = (json: JsonValue): void => {
        tokens += tokensFrom(json);
      };

      const contentType = upstreamResponse.headers['content-type'] ?? '';
      if (contentType.includes('text/event-stream')) {
        stream = true;
        await pipeEventStream(
          route,
          session,
          upstreamResponse,
          response,
          countTokens,
          config.limits.maxResponseBytes,
        );
        return;
      }

      const raw = await collect(upstreamResponse.body, config.limits.maxResponseBytes);
      const restored = rehydrate(raw, contentType, session, countTokens);
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
        metrics.observeBlocked(
          error instanceof ResidencyBlockedError ? 'residency' : 'policy',
          error instanceof ResidencyBlockedError ? error.rule : 'redaction.policies',
        );
      } else if (error instanceof AttachmentBlockedError) {
        // Nothing was sent: the refusal happens before the body is serialised.
        outcome = 'blocked';
        reached = null;
        // The error carries the whole list, including the attachments handled
        // before the one that failed — those were decoded, and the trail has to
        // say so.
        attachments = error.reports as readonly AttachmentReport[];
        metrics.observeBlocked('attachment', 'attachments.onUnreadable');
        for (const report of attachments) {
          metrics.observeAttachment({
            format: report.format,
            outcome: report.outcome,
            extractor: report.extractor,
            bytes: report.bytes,
          });
        }
      } else if (error instanceof UpstreamError) {
        outcome = 'failed';
      } else if (outcome === 'forwarded') {
        outcome = 'failed';
      }
      throw error;
    } finally {
      if (tenant !== null && tokens > 0) quotas.recordTokens(tenant.id, tokens);

      const latencyMs = Date.now() - started;
      metrics.observeRequest({
        route: route.label,
        outcome,
        tenant: tenant?.id ?? null,
        status,
        latencyMs,
        tokens,
        findings: blockedCounts ?? countByKind(findings),
        policies: blockedCounts === null ? policiesOf(findings) : policiesForBlock(blockedCounts),
      });

      auditFor(tenant).write({
        tenant: tenant?.id ?? null,
        route: route.label,
        outcome,
        status,
        latencyMs,
        stream,
        upstream: reached,
        tokens,
        findings: blockedCounts ?? countByKind(findings),
        policies: blockedCounts === null ? policiesOf(findings) : policiesForBlock(blockedCounts),
        residency,
        attachments,
      });
    }
  }

  // Node's two knobs bound less than their names promise: `requestTimeout` is
  // re-checked only at request boundaries and `headersTimeout` is pushed
  // forward by every arriving byte, and both are polled on an interval of
  // their own. A client that drips one byte every few hundred milliseconds, or
  // that connects and then says nothing at all, is reaped by neither. They stay
  // because they still cost nothing and still catch the cases they catch; the
  // sweeper below is what actually bounds a hostile connection.
  server.requestTimeout = config.limits.requestTimeoutMs;
  server.headersTimeout = Math.min(config.limits.requestTimeoutMs, 60_000);

  // What a connection is currently entitled to spend time on.
  //
  // The distinction is the whole point: `receiving` is the client's turn to
  // talk and is bounded by `requestTimeoutMs`, `idle` is nobody's turn and is
  // bounded by `idleTimeoutMs` — but `serving` is hushgate's turn, and is
  // deliberately not bounded here. A model can think in silence for minutes
  // before the first SSE token arrives, and an upstream request that is
  // retrying is silent for longer still; reaping on quiet alone would kill
  // streaming, which is why a plain `socket.setTimeout` is not enough on its
  // own. What bounds that phase is `upstreamTimeoutMs`, one layer down.
  type Phase = 'idle' | 'receiving' | 'serving';
  const connections = new Map<Socket, { phase: Phase; since: number }>();

  server.on('connection', (socket: Socket) => {
    // Accepted but silent counts against the idle budget from the first
    // moment: a socket that never sends a request line is the cheapest
    // file-descriptor exhaustion there is.
    connections.set(socket, { phase: 'idle', since: Date.now() });
    socket.once('close', () => connections.delete(socket));
  });

  // Prepended so the phase is set before the handler can answer: a request
  // served synchronously would otherwise finish before anything was listening
  // for it, and the socket would stay stuck in the phase it had left.
  server.prependListener('request', (request: IncomingMessage, response: ServerResponse) => {
    const state = connections.get(request.socket as Socket);
    if (state === undefined) return;

    // The headers are in and the body is not: the clock now running is the
    // client's, and it is never restamped on incoming data. Restamping is
    // exactly what lets a drip live forever.
    state.phase = 'receiving';
    state.since = Date.now();

    request.once('end', () => {
      state.phase = 'serving';
      state.since = Date.now();
    });
    // Finished, or the caller hung up mid-response: either way the socket is
    // back in the keep-alive pool and the idle budget applies to it again.
    const settle = (): void => {
      state.phase = 'idle';
      state.since = Date.now();
    };
    response.once('finish', settle);
    response.once('close', settle);
  });

  // One timer for the whole server. A timer per socket would make this attack
  // cheaper rather than dearer — every squatting connection would allocate its
  // own — which is the same amplification the sweeper exists to prevent.
  const sweepMs = Math.min(
    1_000,
    Math.max(25, Math.floor(Math.min(config.limits.idleTimeoutMs, config.limits.requestTimeoutMs) / 4)),
  );
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [socket, state] of connections) {
      if (state.phase === 'serving') continue;
      const budget =
        state.phase === 'receiving' ? config.limits.requestTimeoutMs : config.limits.idleTimeoutMs;
      if (now - state.since >= budget) socket.destroy();
    }
  }, sweepMs);
  // This timer exists to end connections, never to wait for them: unref'd, it
  // cannot be the reason a CLI run refuses to exit.
  sweeper.unref();

  return {
    server,
    metrics,

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
          clearInterval(sweeper);
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
  onEvent: (json: JsonValue) => void,
  maxEventBytes: number,
): Promise<void> {
  const rehydrator = new SseRehydrator({
    deltaRules: route.streamRules,
    resolve: (token) => session.lookup(token),
    onEvent,
    maxEventBytes,
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
function rehydrate(
  raw: string,
  contentType: string,
  session: Session,
  onJson: (json: JsonValue) => void,
): string {
  if (raw.length === 0) return raw;

  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(raw) as JsonValue;
      onJson(parsed);
      return JSON.stringify(restoreJson(parsed, session));
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

/** Where each provider's credential is read from when a tenant authenticated. */
const DEFAULT_KEY_ENV: Readonly<Record<ProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** A tenant's redaction profile, with its own namespace for hashed values. */
function tenantProfile(config: HushgateConfig, tenant: Tenant): SessionOptions {
  const base = redactionOptions({ ...config, redaction: tenant.redaction });
  const key = config.redaction.hmacKey;
  return key === null ? base : { ...base, hmacKey: deriveTenantKey(key, tenant.id) };
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

/**
 * Default sink for a failure the request handler threw.
 *
 * A refusal hushgate itself decided on — a blocked category, a residency rule,
 * a rejected key, an exhausted quota, an oversized body — is an expected
 * outcome, not a crash. It already carries an HTTP status, a metrics label and
 * an audit record, and its message is built from kinds and counts rather than
 * values, so one line says everything there is to say. Printing a stack trace
 * for it would bury the case that really is a bug: an error nothing mapped,
 * which still gets the full object.
 *
 * An upstream failure keeps the full object too. hushgate did not decide it,
 * and the `cause` is usually the only thing that explains it.
 */
export function reportFailure(
  error: unknown,
  log: (value: unknown) => void = console.error,
): void {
  if (error instanceof HushgateError && statusOf(error) < 500) {
    log(`hushgate: ${error.message}`);
    return;
  }
  log(error);
}

/** The status a failure maps to, shared by the responder and the audit trail. */
export function statusOf(error: unknown): number {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof QuotaExceededError) return 429;
  if (error instanceof BlockedContentError) return 403;
  if (error instanceof AttachmentBlockedError) return 422;
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

  if (error instanceof AuthenticationError) {
    sendJson(response, statusOf(error), errorPayload('authentication_error', error.message));
    return;
  }

  if (error instanceof QuotaExceededError) {
    sendJson(
      response,
      statusOf(error),
      errorPayload('rate_limit_error', error.message, {
        scope: error.scope,
        limit: error.limit,
      }),
      { 'retry-after': String(error.retryAfterSeconds) },
    );
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

  if (error instanceof AttachmentBlockedError) {
    // 422 rather than 403: the request was well-formed and permitted, but it
    // carried something hushgate could not process. The caller's fix is to send
    // a readable document, or for their operator to configure an extractor —
    // so the message names the media type and the reason.
    sendJson(
      response,
      statusOf(error),
      errorPayload('hushgate_attachment_unreadable', error.message, {
        mediaType: error.mediaType,
        bytes: error.bytes,
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
