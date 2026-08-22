import { describe, expect, it } from 'vitest';
import { overlaps, resolveSpans } from '../src/detectors/resolve.js';
import type { Span } from '../src/types.js';

function span(
  start: number,
  end: number,
  kind: string,
  priority: number,
  detector = kind.toLowerCase(),
): Span {
  return { start, end, kind, value: 'x'.repeat(end - start), detector, priority };
}

describe('resolveSpans', () => {
  it('returns non-overlapping spans sorted by start offset', () => {
    const resolved = resolveSpans([span(10, 15, 'B', 10), span(0, 5, 'A', 10)]);
    expect(resolved.map((s) => s.kind)).toEqual(['A', 'B']);
  });

  it('prefers the longest match when two spans overlap', () => {
    // A short, high-priority span loses to a long, low-priority one.
    const long = span(0, 20, 'URL_CREDENTIALS', 1);
    const short = span(8, 18, 'EMAIL', 99);
    expect(resolveSpans([short, long]).map((s) => s.kind)).toEqual(['URL_CREDENTIALS']);
  });

  it('breaks length ties with detector priority', () => {
    const dob = span(0, 10, 'DATE_OF_BIRTH', 58);
    const phone = span(0, 10, 'PHONE', 55);
    expect(resolveSpans([phone, dob]).map((s) => s.kind)).toEqual(['DATE_OF_BIRTH']);
    // ...and the result does not depend on input order.
    expect(resolveSpans([dob, phone]).map((s) => s.kind)).toEqual(['DATE_OF_BIRTH']);
  });

  it('breaks priority ties with the earlier start offset', () => {
    const a = span(0, 5, 'A', 50);
    const b = span(3, 8, 'B', 50);
    expect(resolveSpans([b, a]).map((s) => s.start)).toEqual([0]);
  });

  it('breaks remaining ties by detector name so output is order independent', () => {
    const a = span(0, 5, 'K', 50, 'alpha');
    const b = span(0, 5, 'K', 50, 'beta');
    expect(resolveSpans([a, b]).map((s) => s.detector)).toEqual(['alpha']);
    expect(resolveSpans([b, a]).map((s) => s.detector)).toEqual(['alpha']);
  });

  it('lets a long winner suppress two shorter spans it covers', () => {
    const wide = span(0, 30, 'SECRET', 10);
    const left = span(0, 10, 'EMAIL', 90);
    const right = span(20, 30, 'PHONE', 90);
    expect(resolveSpans([left, right, wide]).map((s) => s.kind)).toEqual(['SECRET']);
  });

  it('keeps adjacent but non-overlapping spans', () => {
    // Half-open ranges: [0,5) and [5,10) touch but do not overlap.
    const resolved = resolveSpans([span(0, 5, 'A', 10), span(5, 10, 'B', 10)]);
    expect(resolved).toHaveLength(2);
  });

  it('de-duplicates identical ranges of the same kind, keeping the highest priority', () => {
    const resolved = resolveSpans([span(0, 5, 'SECRET', 10), span(0, 5, 'SECRET', 99)]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.priority).toBe(99);
  });

  it('drops empty spans', () => {
    expect(resolveSpans([span(4, 4, 'A', 10)])).toEqual([]);
  });

  it('handles an empty input', () => {
    expect(resolveSpans([])).toEqual([]);
  });

  it('is stable under shuffling of the input', () => {
    const input = [
      span(0, 12, 'IBAN', 90),
      span(4, 9, 'PHONE', 55),
      span(12, 20, 'EMAIL', 75),
      span(15, 25, 'SECRET', 100),
      span(30, 34, 'IPV4', 65),
    ];
    const expected = resolveSpans(input);
    for (let seed = 1; seed <= 25; seed++) {
      expect(resolveSpans(shuffle(input, seed))).toEqual(expected);
    }
  });
});

/** Deterministic Fisher-Yates shuffle driven by a tiny LCG, so failures repeat. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

describe('overlaps', () => {
  it('treats ranges as half-open', () => {
    expect(overlaps(span(0, 5, 'A', 1), span(5, 9, 'B', 1))).toBe(false);
    expect(overlaps(span(0, 5, 'A', 1), span(4, 9, 'B', 1))).toBe(true);
    expect(overlaps(span(4, 9, 'B', 1), span(0, 5, 'A', 1))).toBe(true);
  });
});
