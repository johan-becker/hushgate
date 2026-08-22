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
