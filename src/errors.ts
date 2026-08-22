/** Base class for every error hushgate throws on purpose. */
export class HushgateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Configuration that cannot be used: bad regex, unknown policy, bad port… */
export class ConfigError extends HushgateError {}

/**
 * Thrown when a finding matched a `block` policy. Carries per-kind counts only —
 * never the values that triggered it, so the error is safe to log.
 */
export class BlockedContentError extends HushgateError {
  readonly counts: Readonly<Record<string, number>>;

  constructor(counts: Readonly<Record<string, number>>) {
    const summary = Object.entries(counts)
      .map(([kind, count]) => `${kind} (${count})`)
      .join(', ');
    super(`request blocked by policy: ${summary}`);
    this.counts = counts;
  }

  /** The kinds that caused the block, sorted for stable output. */
  get kinds(): string[] {
    return Object.keys(this.counts).toSorted();
  }
}

/** Thrown when a request body is nested far deeper than any real payload. */
export class TraversalDepthError extends HushgateError {
  constructor(readonly maxDepth: number) {
    super(`request body is nested deeper than ${maxDepth} levels; refusing to traverse it`);
  }
}

/**
 * A request hushgate refuses before it ever reaches an upstream: unreadable
 * body, wrong method, unknown route, oversized payload.
 */
export class RequestError extends HushgateError {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

/** The upstream provider could not be reached, or did not answer in time. */
export class UpstreamError extends HushgateError {
  constructor(
    message: string,
    readonly reason: 'timeout' | 'network',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  /** 504 for a timeout, 502 for everything else, as a gateway should. */
  get status(): number {
    return this.reason === 'timeout' ? 504 : 502;
  }
}

/** The command line was not understood. Reported with usage, and exit code 2. */
export class UsageError extends HushgateError {}

/**
 * A residency rule refused the configuration. Thrown at startup, before the
 * listener is bound: a misconfigured upstream must never silently leak.
 */
export class ResidencyError extends ConfigError {}

/**
 * A residency rule refused a request. Like {@link BlockedContentError} it
 * carries kinds and counts, never values, so it is safe to log verbatim.
 */
export class ResidencyBlockedError extends HushgateError {
  constructor(
    message: string,
    readonly rule: string,
    readonly jurisdiction: string,
    readonly counts: Readonly<Record<string, number>>,
  ) {
    super(message);
  }

  get kinds(): string[] {
    return Object.keys(this.counts).toSorted();
  }
}
