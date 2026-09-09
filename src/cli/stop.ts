/**
 * Waiting for the operator to stop a foreground command.
 *
 * Shared by `serve` and by `setup`'s trial, because both bind a port and then
 * do nothing until Ctrl-C — and a second copy of this would be a second place
 * for a listener to be left attached.
 */

/** Resolve on Ctrl-C, on SIGTERM, or when the caller's signal aborts. */
export function untilStopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      signal?.removeEventListener('abort', stop);
      resolve();
    };

    if (signal?.aborted === true) {
      resolve();
      return;
    }

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
