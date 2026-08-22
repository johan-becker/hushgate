/**
 * The placeholder grammar, kept in one place because three very different
 * pieces of code depend on it agreeing exactly: the redactor that issues
 * tokens, the restorer that consumes them, and the streaming re-hydrator that
 * has to recognise a *partial* token split across SSE chunks.
 */

/** Matches a complete reversible placeholder such as `[EMAIL_12]`. */
export const PLACEHOLDER_PATTERN = /\[[A-Z][A-Z0-9_]*_\d+\]/gu;

/** Matches a complete reversible placeholder anchored to the whole string. */
export const PLACEHOLDER_EXACT = /^\[[A-Z][A-Z0-9_]*_\d+\]$/u;

/** Longest token hushgate will ever issue; also the re-hydrator's hold-back cap. */
export const MAX_PLACEHOLDER_LENGTH = 72;

/** Build the reversible token for a kind and ordinal. */
export function makePlaceholder(kind: string, ordinal: number): string {
  return `[${kind}_${ordinal}]`;
}

/** Irreversible mask emitted by the `redact` policy. */
export function makeRedactedMask(kind: string): string {
  return `[${kind}_REDACTED]`;
}

/**
 * Irreversible but stable token emitted by the `hash` policy.
 *
 * Deliberately *not* in the reversible grammar (`:` instead of `_<digits>`), so
 * `restore` and the streaming re-hydrator never try to look it up.
 */
export function makeHashToken(kind: string, digest: string): string {
  return `[${kind}:${digest}]`;
}

/**
 * True when `candidate` could still grow into a complete placeholder.
 *
 * `[`, `[E`, `[EMAIL_`, `[EMAIL_1` are all viable; `[1`, `[email`, `[EMAIL_1]x`
 * are not. The streaming re-hydrator uses this to decide how many trailing
 * bytes it must hold back.
 */
export function isViablePlaceholderPrefix(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > MAX_PLACEHOLDER_LENGTH) return false;
  if (!candidate.startsWith('[')) return false;
  return /^\[(?:[A-Z][A-Z0-9_]*)?$/u.test(candidate);
}

/** Find every complete placeholder in `text`, as `[start, end)` ranges. */
export function findPlaceholders(text: string): { start: number; end: number; value: string }[] {
  const re = new RegExp(PLACEHOLDER_PATTERN.source, PLACEHOLDER_PATTERN.flags);
  const out: { start: number; end: number; value: string }[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    out.push({ start: match.index, end: match.index + match[0].length, value: match[0] });
  }

  return out;
}
