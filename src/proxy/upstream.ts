/**
 * The upstream client, behind an interface so tests can substitute a fake — and
 * so the residency layer has one place to decorate every outbound call.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import { UpstreamError } from '../errors.js';

export interface UpstreamRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Abort the attempt after this many milliseconds of silence. */
  readonly timeoutMs: number;
}

export interface UpstreamResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The response body as a stream; the caller decides whether to buffer it. */
  readonly body: Readable;
}

export type UpstreamClient = (request: UpstreamRequest) => Promise<UpstreamResponse>;

/**
 * Forward with node:http / node:https — no dependency, and full control over
 * headers and streaming.
 *
 * `accept-encoding: identity` is deliberate: hushgate has to rewrite the
 * response body, and asking for a compressed one only to inflate it again would
 * add a decompressor to the trusted path for nothing.
 */
export const nodeUpstreamClient: UpstreamClient = (request) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch (cause) {
      reject(new UpstreamError(`invalid upstream URL "${request.url}"`, 'network', { cause }));
      return;
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = Buffer.from(request.body, 'utf8');

    const outbound = send(
      url,
      {
        method: request.method,
        headers: {
          ...request.headers,
          'accept-encoding': 'identity',
          'content-length': String(payload.length),
        },
      },
      (response) => {
        resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
      },
    );

    outbound.setTimeout(request.timeoutMs, () => {
      outbound.destroy(
        new UpstreamError(
          `upstream ${url.host} did not respond within ${request.timeoutMs} ms`,
          'timeout',
        ),
      );
    });

    outbound.on('error', (cause) => {
      reject(
        cause instanceof UpstreamError
          ? cause
          : new UpstreamError(`upstream ${url.host} is unreachable: ${cause.message}`, 'network', {
              cause,
            }),
      );
    });

    outbound.end(payload);
  });

/** Collect a response body into a string. */
export async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}
