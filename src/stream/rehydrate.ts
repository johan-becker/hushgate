/**
 * Re-hydration for text that arrives in pieces.
 *
 * A response body is not delivered in tidy units: `[EMAIL_1]` can arrive as
 * `[EMA` in one TCP segment and `IL_1]` in the next, and a model can just as
 * easily emit it as five separate SSE deltas. A replace-per-chunk pass would
 * hand the caller `[EMA` followed by `IL_1]` and never restore anything.
 *
 * So this holds back exactly the trailing run of bytes that could still grow
 * into a placeholder, and nothing else. Three properties make it safe:
 *
 *  - it never holds back more than one token's worth of text, because a viable
 *    prefix is bounded by MAX_PLACEHOLDER_LENGTH — no deadlock, no unbounded
 *    buffer, no waiting for a byte that never comes;
 *  - the held-back text is always emitted by `flush()`, so a stream that ends
 *    mid-token still delivers its tail verbatim;
 *  - substitution is a single left-to-right pass, so a restored value that
 *    itself looks like a placeholder is never re-examined.
 */
import { isViablePlaceholderPrefix, PLACEHOLDER_PATTERN } from '../redact/placeholder.js';

/** Resolve a complete token, or return `undefined` to leave it alone. */
export type TokenResolver = (token: string) => string | undefined;

export class StreamRehydrator {
  private held = '';

  constructor(private readonly resolve: TokenResolver) {}

  /** Feed the next piece of text; returns everything that is safe to emit now. */
  push(text: string): string {
    if (text.length === 0) return '';

    const combined = this.held + text;
    const boundary = holdBackFrom(combined);

    this.held = combined.slice(boundary);
    return this.substitute(combined.slice(0, boundary));
  }

  /** Emit whatever is still held back. Call exactly once, at end of stream. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return this.substitute(rest);
  }

  /** Text currently held back. Exposed for tests and for flush decisions. */
  get pending(): string {
    return this.held;
  }

  private substitute(text: string): string {
    return substituteComplete(text, this.resolve);
  }
}

/**
 * Replace every complete token in `text`, in a single left-to-right pass.
 *
 * Single pass matters: a restored value may itself look like a placeholder, and
 * re-examining it would turn a caller's own data into a second lookup.
 */
export function substituteComplete(text: string, resolve: TokenResolver): string {
  if (text.length === 0) return text;
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, PLACEHOLDER_PATTERN.flags);
  return text.replaceAll(pattern, (token) => resolve(token) ?? token);
}

/**
 * Index from which `text` must be held back.
 *
 * Only the last `[` can start a viable prefix: `[` is not a character a
 * placeholder body may contain, so any earlier one would produce a suffix that
 * contains a `[` in the middle and is therefore already ruled out.
 */
export function holdBackFrom(text: string): number {
  const open = text.lastIndexOf('[');
  if (open === -1) return text.length;
  return isViablePlaceholderPrefix(text.slice(open)) ? open : text.length;
}

/** Convenience wrapper: re-hydrate an async stream of text pieces. */
export async function* rehydrateChunks(
  source: AsyncIterable<string>,
  resolve: TokenResolver,
): AsyncGenerator<string> {
  const rehydrator = new StreamRehydrator(resolve);

  for await (const chunk of source) {
    const out = rehydrator.push(chunk);
    if (out.length > 0) yield out;
  }

  const tail = rehydrator.flush();
  if (tail.length > 0) yield tail;
}
