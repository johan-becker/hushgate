/**
 * The small HTTP mechanics the proxy needs: bounded body reading, header
 * hygiene, and provider-shaped error payloads.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { RequestError } from '../errors.js';

/**
 * Headers that describe one hop and must never be forwarded to the next one.
 * `connection` is included so its listed headers cannot be smuggled through.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Request headers hushgate passes upstream. Everything else is dropped: the
 * caller's `host`, cookies, tracing headers and whatever else a framework added
 * are not the provider's business, and a length header would be wrong anyway
 * once the body has been rewritten.
 */
export const FORWARDED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'authorization',
  'content-type',
  'openai-beta',
  'openai-organization',
  'openai-project',
  'user-agent',
  'x-api-key',
  'x-stainless-lang',
  'x-stainless-package-version',
]);

/** Response headers hushgate never copies back: they describe a rewritten body. */
const REWRITTEN_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  'content-encoding',
]);

/**
 * How far past the limit an oversized upload is allowed to run before the
 * socket is cut instead of drained. See {@link readBody}.
 */
const DRAIN_ALLOWANCE = 4;

/**
 * Read the whole request body, refusing anything over `maxBytes`.
 *
 * The limit is enforced as bytes arrive, so an oversized body costs the memory
 * of the bytes up to the limit and no more. Past the limit the remaining upload
 * is drained rather than reset: the client is usually still writing, and
 * destroying the socket would replace hushgate's 413 with a network error at the
 * caller. A client that keeps pushing well past the limit is not making an
 * honest mistake, and gets the reset.
 */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;

      if (settled) {
        if (size > maxBytes * DRAIN_ALLOWANCE) request.destroy();
        return;
      }

      if (size > maxBytes) {
        settled = true;
        reject(
          new RequestError(
            413,
            'request_too_large',
            `request body exceeds the configured limit of ${maxBytes} bytes`,
          ),
        );
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    request.on('error', (cause) => {
      if (settled) return;
      settled = true;
      reject(
        new RequestError(
          400,
          'request_read_failed',
          `could not read request body: ${cause.message}`,
        ),
      );
    });
  });
}

/** Parse a JSON request body, or fail with a 400 the SDKs can display. */
export function parseJsonObject(body: Buffer): Record<string, unknown> {
  if (body.length === 0) {
    throw new RequestError(400, 'invalid_request_error', 'request body is empty');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (cause) {
    throw new RequestError(
      400,
      'invalid_request_error',
      `request body is not valid JSON: ${(cause as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RequestError(400, 'invalid_request_error', 'request body must be a JSON object');
  }

  return parsed as Record<string, unknown>;
}

/** Select the request headers that may travel upstream. */
export function forwardRequestHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(lower)) continue;
    if (value === undefined) continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }

  return out;
}

/** Copy upstream response headers back, minus the ones the rewrite invalidated. */
export function forwardResponseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (REWRITTEN_RESPONSE_HEADERS.has(lower)) continue;
    out[lower] = value;
  }

  return out;
}

/** The error envelope both the OpenAI and the Anthropic SDKs know how to read. */
export function errorPayload(
  type: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return { error: { type, message, ...extra } };
}

/** Write a text response (used by /metrics), unless the client gave up. */
export function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  contentType: string,
): void {
  if (response.writableEnded) return;
  const body = Buffer.from(text, 'utf8');
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
  });
  response.end(body);
}

/** Write a JSON response, unless the client already gave up. */
export function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  if (response.writableEnded) return;
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  });
  response.end(body);
}
