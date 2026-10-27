/**
 * The upstream client, behind an interface so tests can substitute a fake — and
 * so the residency layer has one place to decorate every outbound call.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
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
  /**
   * Abandon the call when this aborts, whether it is still waiting for the
   * headers or already streaming the body.
   *
   * The proxy aborts it when it shuts down and the grace period is over. A
   * handler writes its audit record only once the upstream has answered or
   * failed, so a call left to run on would hold that record back until after
   * the trail had been closed — and a record written into a closed trail is a
   * request the trail never mentions.
   */
  readonly signal?: AbortSignal;
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

    // Already abandoned: not one byte goes out on behalf of a caller who has
    // stopped waiting.
    const { signal } = request;
    if (signal?.aborted === true) {
      reject(abandoned(url));
      return;
    }

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = Buffer.from(request.body, 'utf8');

    // The response, once its headers are in; an abort has to reach it too.
    let received: IncomingMessage | undefined;

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
        received = response;
        response.once('close', release);
        resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response });
      },
    );

    // The body is the caller's to read, but an abort still has to reach it:
    // a caller blocked on a provider that has gone quiet mid-stream would
    // otherwise never learn the call was abandoned. Destroying the body with
    // an UpstreamError is what turns that into an ordinary upstream failure.
    const onAbort = (): void => {
      const error = abandoned(url);
      received?.destroy(error);
      outbound.destroy(error);
    };
    // Every call on a long-lived signal adds a listener; leaving them behind
    // would grow it by one per request for the life of the process.
    function release(): void {
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    outbound.once('close', release);

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

/** The error an abandoned call fails with: a network failure, as far as the caller can tell. */
function abandoned(url: URL): UpstreamError {
  return new UpstreamError(`request to upstream ${url.host} was abandoned`, 'network');
}

/**
 * Collect a response body into a string, refusing anything over `maxBytes`.
 *
 * The counterpart of readBody's limit on the request side. A buffered response
 * is concatenated, decoded, JSON-parsed, cloned by restoreJson and
 * re-serialised, so several times its own size is resident at once; without a
 * bound, one provider returning a very large payload — or a compromised or
 * MITM'd one doing it deliberately — takes the whole process down and every
 * tenant with it.
 *
 * The stream is destroyed rather than drained: unlike a client mid-upload,
 * there is no one on the other end whose error message we are trying to keep
 * intelligible, and there is no reason to keep paying for bytes we have already
 * decided to discard.
 */
export async function collect(stream: Readable, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;

    if (size > maxBytes) {
      stream.destroy();
      throw new UpstreamError(
        `upstream response exceeds ${maxBytes} bytes [limits.maxResponseBytes]`,
        'network',
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}
