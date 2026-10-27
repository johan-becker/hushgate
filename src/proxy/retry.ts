/**
 * Retrying an upstream that never answered.
 *
 * Only failures that happened *before* a response was received are retried: a
 * connection refused, a DNS failure, a timeout waiting for headers. A response
 * is never retried, whatever its status — a 429 with a retry-after belongs to
 * the caller, and quietly resending a request the provider has already seen and
 * charged for would be worse than the error.
 *
 * Nor is an abandoned call: once the request's signal has aborted, the caller
 * has stopped waiting, and sending the request again on their behalf would do
 * the one thing the abort was there to stop.
 */
import { UpstreamError } from '../errors.js';
import type { UpstreamClient, UpstreamRequest, UpstreamResponse } from './upstream.js';

export interface RetryOptions {
  /** How many additional attempts to make. Zero disables retrying. */
  readonly retries: number;
  /** Delay before the first retry; doubled each time, with jitter. */
  readonly backoffMs: number;
  /**
   * Injected so tests do not actually sleep. Handed the request's signal, and
   * expected to wake early when it aborts.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injected so the jitter is reproducible in tests. */
  readonly random?: () => number;
  /** Called before each retry, for logging. */
  readonly onRetry?: (attempt: number, delayMs: number, error: UpstreamError) => void;
}

export function withRetry(client: UpstreamClient, options: RetryOptions): UpstreamClient {
  const sleep = options.sleep ?? pause;
  const random = options.random ?? Math.random;

  return async function retrying(request: UpstreamRequest): Promise<UpstreamResponse> {
    let lastError: UpstreamError | undefined;
    const abandoned = (): boolean => request.signal?.aborted === true;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      try {
        // Sequential by nature: each attempt only happens because the previous
        // one failed.
        // oxlint-disable-next-line no-await-in-loop
        return await client(request);
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        lastError = error;
        if (attempt === options.retries || abandoned()) break;

        // Full jitter: without it, every stalled client retries in lockstep.
        const window = options.backoffMs * 2 ** attempt;
        const delay = Math.round(window * (0.5 + random() * 0.5));
        options.onRetry?.(attempt + 1, delay, error);
        // oxlint-disable-next-line no-await-in-loop
        await sleep(delay, request.signal);
        // Abandoned while backing off: the failure that started the wait is
        // the one worth reporting.
        if (abandoned()) break;
      }
    }

    throw lastError ?? new UpstreamError('upstream request failed', 'network');
  };
}

/**
 * Wait out a backoff, but wake as soon as the call is abandoned.
 *
 * A shutdown should not sit out a retry delay, and the timer is cleared rather
 * than left to run: a pending timer is a reason for the process not to exit.
 */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const wake = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal?.addEventListener('abort', wake, { once: true });
  });
}
