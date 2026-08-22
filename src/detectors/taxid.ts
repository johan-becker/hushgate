import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

const TAX_ID_LENGTH = 11;

/**
 * ISO 7064 MOD 11,10 check digit over the first ten digits.
 *
 * This is the scheme the Bundeszentralamt für Steuern uses for the
 * Steuerliche Identifikationsnummer.
 */
export function mod1110CheckDigit(firstTen: string): number {
  let product = 10;

  for (const ch of firstTen) {
    let sum = ((ch.codePointAt(0)! - 48) + product) % 10;
    if (sum === 0) sum = 10;
    product = (sum * 2) % 11;
  }

  return (11 - product) % 10;
}

/**
 * The digit-frequency rule, which is what actually makes the Steuer-ID
 * distinguishable from any other eleven-digit number.
 *
 * Within the first ten digits exactly one digit may repeat: either twice, or
 * three times — and if three times, never at three directly consecutive
 * positions. Every other digit appears at most once. `1234567890` therefore
 * fails even though its check digit can be computed.
 */
export function hasValidDigitFrequency(firstTen: string): boolean {
  if (firstTen.length !== 10) return false;

  const counts = new Map<string, number>();
  for (const ch of firstTen) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  const repeats = [...counts.values()].filter((count) => count > 1);
  if (repeats.length !== 1) return false;

  const repeat = repeats[0]!;
  if (repeat > 3) return false;

  if (repeat === 3) {
    for (let i = 0; i + 2 < firstTen.length; i++) {
      if (firstTen[i] === firstTen[i + 1] && firstTen[i + 1] === firstTen[i + 2]) return false;
    }
  }

  return true;
}

/** Full validation of a German tax identification number. */
export function isValidGermanTaxId(digits: string): boolean {
  if (digits.length !== TAX_ID_LENGTH) return false;
  if (!/^\d{11}$/u.test(digits)) return false;
  // The number is never issued with a leading zero.
  if (digits.startsWith('0')) return false;

  const firstTen = digits.slice(0, 10);
  if (!hasValidDigitFrequency(firstTen)) return false;

  return mod1110CheckDigit(firstTen) === digits.codePointAt(10)! - 48;
}

const isSeparator = (ch: string): boolean => ch === ' ' || ch === '/';

/**
 * German tax ID detector.
 *
 * Accepts the grouped forms the tax office prints (`86 095 742 719`) as well as
 * the bare eleven digits, then applies both official rules.
 */
export const germanTaxIdDetector: Detector = {
  name: 'german-tax-id',
  priority: DEFAULT_PRIORITIES.GERMAN_TAX_ID,

  find(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      if (!memberAt(text, i, isDigit) || isWordChar(text, i - 1)) {
        i += 1;
        continue;
      }

      const run = collectRun(text, i, isDigit, isSeparator, TAX_ID_LENGTH);
      const end = (run.offsets.at(-1) ?? i) + 1;

      if (
        run.chars.length === TAX_ID_LENGTH &&
        !memberAt(text, end, isDigit) &&
        isValidGermanTaxId(run.chars)
      ) {
        out.push({
          start: i,
          end,
          kind: 'GERMAN_TAX_ID',
          value: text.slice(i, end),
          detector: 'german-tax-id',
          priority: DEFAULT_PRIORITIES.GERMAN_TAX_ID,
        });
        i = end;
        continue;
      }

      // Move past the whole digit group; a tax ID never starts mid-group.
      i = run.offsets.length > 0 ? Math.max(i + 1, groupEnd(run)) : i + 1;
    }

    return out;
  },
};

/** End of the first contiguous digit group in the scanned run. */
function groupEnd(run: { offsets: readonly number[] }): number {
  let previous = run.offsets[0]!;
  for (const offset of run.offsets.slice(1)) {
    if (offset !== previous + 1) return previous + 1;
    previous = offset;
  }
  return previous + 1;
}
