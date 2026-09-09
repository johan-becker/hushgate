/**
 * The routes the trial page is made of.
 *
 * Mounted only by `hushgate setup`. The page turns placeholders back into
 * personal data, which is precisely what a production proxy must not offer, so
 * `serve` has no flag that switches this on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errorPayload, parseJsonObject, readBody, sendJson } from '../proxy/http.js';
import { nodeUpstreamClient, type UpstreamClient } from '../proxy/upstream.js';
import { countByKind, Session } from '../redact/session.js';
import { SseParser, StreamRehydrator } from '../stream/index.js';
import { PAGE_CSS, PAGE_JS, renderPage, type PlaygroundEndpoint } from './page.js';
import type { TrialStore } from './session.js';

/** A document the page dropped in, carried as base64 so the body stays JSON. */
export interface DroppedFile {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly mediaType: string | null;
}

/** Turn a dropped document into text. Injected, because the extractor set is
 * assembled from the operator's configuration and this module has none. */
export type ExtractText = (file: DroppedFile) => Promise<string>;

export const PLAYGROUND_PREFIX = '/__playground';

export interface PlaygroundOptions {
  /** Where the placeholder mappings live between preview and send. */
  readonly store: TrialStore;
  /**
   * The key typed at the terminal. It reaches the provider from here and
   * nowhere else: it is never rendered into the page, never sent to the
   * browser, and never written to a file.
   */
  readonly apiKey: string;
  readonly endpoint: PlaygroundEndpoint;
  /** Whether to say out loud that names come only from the dictionary. */
  readonly dictionaryIsEmpty: boolean;
  /** Reads a dropped document. Without it, dropping one is refused. */
  readonly extract?: ExtractText;
  /** Substitutable so a test can stand in for the provider. */
  readonly upstream?: UpstreamClient;
}

/** Enough for a pasted letter or a decent-sized PDF; not a file upload service. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/**
 * Headers on everything this module serves.
 *
 * `default-src 'none'` with `script-src 'self'` is why the script and the
 * stylesheet are separate routes rather than inline blocks: the page can then
 * load exactly two things, both from this server, and reach nothing else.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/** Like `sendText`, but carrying the page's headers. */
function sendAsset(response: ServerResponse, body: string, contentType: string): void {
  if (response.writableEnded) return;
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.length),
    ...SECURITY_HEADERS,
  });
  response.end(bytes);
}

/**
 * Answer a request under {@link PLAYGROUND_PREFIX}.
 *
 * Returns `false` when this module has nothing to say about it, so the caller
 * falls through to its ordinary handling — including its ordinary 404.
 */
export function handlePlayground(
  request: IncomingMessage,
  response: ServerResponse,
  options: PlaygroundOptions,
  pathname: string,
): Promise<boolean> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (pathname === PLAYGROUND_PREFIX || pathname === `${PLAYGROUND_PREFIX}/`) {
      sendAsset(
        response,
        renderPage({ endpoint: options.endpoint, dictionaryIsEmpty: options.dictionaryIsEmpty }),
        'text/html; charset=utf-8',
      );
      return Promise.resolve(true);
    }

    if (pathname === `${PLAYGROUND_PREFIX}/app.css`) {
      sendAsset(response, PAGE_CSS, 'text/css; charset=utf-8');
      return Promise.resolve(true);
    }

    if (pathname === `${PLAYGROUND_PREFIX}/app.js`) {
      sendAsset(response, PAGE_JS, 'text/javascript; charset=utf-8');
      return Promise.resolve(true);
    }
  }

  if (request.method === 'POST' && pathname === `${PLAYGROUND_PREFIX}/preview`) {
    return preview(request, response, options).then(() => true);
  }

  if (request.method === 'POST' && pathname === `${PLAYGROUND_PREFIX}/send`) {
    return send(request, response, options).then(() => true);
  }

  return Promise.resolve(false);
}

/**
 * What the provider would see, and the session that will send it.
 *
 * The proxy pseudonymises while forwarding, but the trial has to show the
 * sanitised text and then send exactly that. So one `Session` runs here and is
 * kept: the placeholders on screen are the ones the model receives, and the
 * reply rehydrates from the same mapping.
 */
async function preview(
  request: IncomingMessage,
  response: ServerResponse,
  options: PlaygroundOptions,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = parseJsonObject(await readBody(request, MAX_BODY_BYTES));
  } catch {
    sendJson(response, 400, errorPayload('bad_request', 'that was not a JSON object'), SECURITY_HEADERS);
    return;
  }

  const model = typeof body['model'] === 'string' && body['model'] !== ''
    ? body['model']
    : options.endpoint.trialModel;

  let text: string;
  let extracted: string | undefined;

  const file = body['file'];
  if (isDroppedFile(file)) {
    if (options.extract === undefined) {
      sendJson(
        response,
        422,
        errorPayload('unreadable', 'this document could not be read: no extractor is configured'),
        SECURITY_HEADERS,
      );
      return;
    }

    try {
      extracted = await options.extract({
        bytes: Buffer.from(file.data, 'base64'),
        filename: typeof file.name === 'string' ? file.name : null,
        mediaType: typeof file.mediaType === 'string' ? file.mediaType : null,
      });
    } catch {
      // Fail closed, exactly as the proxy does: a document hushgate cannot read
      // is one it cannot pseudonymise, and forwarding it is the one outcome
      // that would put the original in front of the provider.
      sendJson(
        response,
        422,
        errorPayload('unreadable', 'this document could not be read, so it was not sent anywhere'),
        SECURITY_HEADERS,
      );
      return;
    }
    text = extracted;
  } else {
    text = typeof body['text'] === 'string' ? body['text'] : '';
  }

  if (text.trim() === '') {
    sendJson(response, 400, errorPayload('bad_request', 'there was no text to check'), SECURITY_HEADERS);
    return;
  }

  const session = new Session();
  const result = session.redact(text);
  const entry = options.store.create(session, result.text, model);

  sendJson(
    response,
    200,
    {
      sessionId: entry.id,
      sanitised: result.text,
      // Kinds and counts. Never values — this is the same thing the audit
      // trail records, for the same reason.
      findings: countByKind(result.findings),
      ...(extracted === undefined ? {} : { extracted }),
    },
    SECURITY_HEADERS,
  );
}

interface DroppedPayload {
  readonly data: string;
  readonly name?: unknown;
  readonly mediaType?: unknown;
}

function isDroppedFile(value: unknown): value is DroppedPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { data?: unknown }).data === 'string'
  );
}

/** How long to wait on the provider before giving up on the trial. */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** Anthropic requires a ceiling; the trial is a demonstration, not a workload. */
const TRIAL_MAX_TOKENS = 1024;

/**
 * Send the sanitised text, and stream the answer back on two channels.
 *
 * `raw` is the provider's delta exactly as it arrived, placeholders intact.
 * `hydrated` is the same delta through a {@link StreamRehydrator}, which holds
 * characters back whenever a placeholder falls across a chunk boundary. The
 * lag that produces is not smoothed away: it is the mechanism, visible.
 */
async function send(
  request: IncomingMessage,
  response: ServerResponse,
  options: PlaygroundOptions,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = parseJsonObject(await readBody(request, MAX_BODY_BYTES));
  } catch {
    sendJson(response, 400, errorPayload('bad_request', 'that was not a JSON object'), SECURITY_HEADERS);
    return;
  }

  const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
  const entry = options.store.get(sessionId);
  if (entry === undefined) {
    sendJson(
      response,
      404,
      errorPayload('no_such_session', 'that preview has expired; check the text again'),
      SECURITY_HEADERS,
    );
    return;
  }

  // Whatever the page sent as a key is ignored on purpose. The page has no
  // business carrying one, and a page that could choose the credential would
  // be a way to spend someone else's.
  const client = options.upstream ?? nodeUpstreamClient;
  const shape = requestFor(options, entry.model);

  let upstream;
  try {
    upstream = await client({
      url: `${options.endpoint.baseUrl}${shape.path}`,
      method: 'POST',
      headers: shape.headers,
      body: JSON.stringify(shape.payload(entry.sanitised)),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
    });
  } catch {
    sendJson(
      response,
      502,
      errorPayload('upstream_unreachable', 'the provider could not be reached'),
      SECURITY_HEADERS,
    );
    return;
  }

  if (upstream.status >= 400) {
    upstream.body.resume();
    sendJson(
      response,
      502,
      errorPayload('upstream_error', `the provider answered ${upstream.status}`),
      SECURITY_HEADERS,
    );
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    ...SECURITY_HEADERS,
  });

  const parser = new SseParser();
  const rehydrator = new StreamRehydrator((token) => entry.session.lookup(token));
  const emit = (event: string, delta: string): void => {
    if (delta === '') return;
    response.write(`event: ${event}\ndata: ${JSON.stringify({ delta })}\n\n`);
  };

  upstream.body.setEncoding('utf8');
  for await (const chunk of upstream.body) {
    for (const event of parser.push(String(chunk))) {
      if (!event.hasData || event.data.trim() === '[DONE]') continue;

      let json: unknown;
      try {
        json = JSON.parse(event.data);
      } catch {
        continue;
      }

      const delta = deltaOf(json, options.endpoint.api);
      emit('raw', delta);
      emit('hydrated', rehydrator.push(delta));
    }
  }

  emit('hydrated', rehydrator.flush());
  response.write('event: done\ndata: {}\n\n');
  response.end();
}

interface RequestShape {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  payload(text: string): unknown;
}

/** The two protocols hushgate speaks, as the trial has to send them. */
function requestFor(options: PlaygroundOptions, model: string): RequestShape {
  if (options.endpoint.api === 'anthropic') {
    return {
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      payload: (text) => ({
        model,
        max_tokens: TRIAL_MAX_TOKENS,
        stream: true,
        messages: [{ role: 'user', content: text }],
      }),
    };
  }

  return {
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.apiKey}`,
    },
    payload: (text) => ({
      model,
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  };
}

/** The incremental text in one event, for whichever protocol produced it. */
function deltaOf(json: unknown, api: 'openai' | 'anthropic'): string {
  if (typeof json !== 'object' || json === null) return '';

  if (api === 'anthropic') {
    const delta = (json as { delta?: { text?: unknown } }).delta;
    return typeof delta?.text === 'string' ? delta.text : '';
  }

  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return '';

  let out = '';
  for (const choice of choices) {
    const content = (choice as { delta?: { content?: unknown } })?.delta?.content;
    if (typeof content === 'string') out += content;
  }
  return out;
}
