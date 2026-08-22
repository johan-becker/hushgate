import type { Span } from '../types.js';

/**
 * Resolve overlapping candidate spans into a disjoint, ordered set.
 *
 * The rules, in order, are fully deterministic:
 *
 *  1. **Longest match wins.** A span covering more characters beats a shorter
 *     one it overlaps. `https://u:p@host` beats the `u:p@host` e-mail-shaped
 *     substring inside it.
 *  2. **Detector priority breaks length ties.** Two spans of identical length
 *     that overlap are decided by `priority` (higher wins) — this is what makes
 *     `01.02.1990` a DATE_OF_BIRTH rather than a phone number.
 *  3. **Earlier start breaks priority ties**, then detector name, then kind.
 *     These last two exist only so the result never depends on the order in
 *     which detectors happened to run.
 *
 * Selection is greedy over that ordering: take the best remaining span, drop
 * everything that overlaps it, repeat. Exactly identical spans (same range,
 * same kind) are de-duplicated first, keeping the highest priority.
 */
export function resolveSpans(spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];

  const deduped = dedupe(spans);
  const ordered = deduped.toSorted(compareSpans);

  const accepted: Span[] = [];
  for (const span of ordered) {
    if (span.start >= span.end) continue;
    if (accepted.some((taken) => overlaps(taken, span))) continue;
    accepted.push(span);
  }

  return accepted.toSorted((a, b) => a.start - b.start);
}

/** True when two half-open ranges share at least one character. */
export function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Ordering used for greedy selection. Lower sorts first, i.e. "better". */
function compareSpans(a: Span, b: Span): number {
  const lengthDiff = b.end - b.start - (a.end - a.start);
  if (lengthDiff !== 0) return lengthDiff;

  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.start !== b.start) return a.start - b.start;
  if (a.detector !== b.detector) return a.detector < b.detector ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return 0;
}

/**
 * Collapse spans with the same range and kind, keeping the highest priority.
 * Equal priorities are settled by detector name so the survivor never depends
 * on the order detectors ran in.
 */
function dedupe(spans: readonly Span[]): Span[] {
  const seen = new Map<string, Span>();
  for (const span of spans) {
    const key = `${span.start}:${span.end}:${span.kind}`;
    const existing = seen.get(key);
    if (existing === undefined || beats(span, existing)) {
      seen.set(key, span);
    }
  }
  return [...seen.values()];
}

function beats(candidate: Span, incumbent: Span): boolean {
  if (candidate.priority !== incumbent.priority) return candidate.priority > incumbent.priority;
  return candidate.detector < incumbent.detector;
}
