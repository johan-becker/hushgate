import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

const MIN_PAN_LENGTH = 13;
const MAX_PAN_LENGTH = 19;

/**
 * Luhn (ISO/IEC 7812-1) check digit.
 *
 * Double every second digit from the right, subtract 9 from anything above 9,
 * and require the total to be a multiple of ten.
 */
export function luhnValid(digits: string): boolean {
  if (digits.length === 0) return false;

  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    const code = digits.codePointAt(i);
    if (code === undefined || code < 48 || code > 57) return false;
    let value = code - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * Issuer identification check.
 *
 * Luhn alone accepts one in ten random digit runs, which turns every long
 * order number into a false positive. Requiring a real issuer prefix *and* the
 * length that issuer actually uses cuts that down by roughly another order of
 * magnitude while still accepting every card network in common use.
 */
export function hasIssuerPrefix(digits: string): boolean {
  const n = digits.length;

  if (digits.startsWith('4')) return n === 13 || n === 16 || n === 19; // Visa
  if (/^3[47]/u.test(digits)) return n === 15; // American Express
  if (/^5[1-5]/u.test(digits)) return n === 16; // Mastercard
  if (/^2(?:2[2-9]|[3-6]\d|7[01]|720)/u.test(digits)) return n === 16; // Mastercard 2-series
  if (/^3(?:0[0-5]|[68]\d)/u.test(digits)) return n === 14; // Diners Club
  if (/^35(?:2[89]|[3-8]\d)/u.test(digits)) return n >= 16 && n <= 19; // JCB
  if (/^(?:6011|64[4-9]|65)/u.test(digits)) return n === 16 || n === 19; // Discover
  if (digits.startsWith('62')) return n >= 16 && n <= 19; // UnionPay

  return false;
}

/** A digit run is a plausible card number when it has a real prefix and passes Luhn. */
export function isValidCardNumber(digits: string): boolean {
  if (digits.length < MIN_PAN_LENGTH || digits.length > MAX_PAN_LENGTH) return false;
  if (!hasIssuerPrefix(digits)) return false;
  return luhnValid(digits);
}

const isSeparator = (ch: string): boolean => ch === ' ' || ch === '-';

/**
 * Credit card detector.
 *
 * Scans digit runs that may be grouped with single spaces or hyphens. For each
 * run it tries the longest valid prefix first, so a card followed by another
 * number (`4111 1111 1111 1111 2024`) is still found — but only if the digit
 * immediately after the accepted prefix is not itself a digit, which keeps a
 * 17-digit run from being reported as a 16-digit card.
 */
export const creditCardDetector: Detector = {
  name: 'credit-card',
  priority: DEFAULT_PRIORITIES.CREDIT_CARD,

  find(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      if (!memberAt(text, i, isDigit) || isWordChar(text, i - 1)) {
        i += 1;
        continue;
      }

      const run = collectRun(text, i, isDigit, isSeparator, MAX_PAN_LENGTH);
      let accepted: Span | null = null;

      for (let length = run.chars.length; length >= MIN_PAN_LENGTH; length--) {
        const digits = run.chars.slice(0, length);
        const end = (run.offsets[length - 1] ?? i) + 1;
        if (memberAt(text, end, isDigit)) continue;
        if (!isValidCardNumber(digits)) continue;

        accepted = {
          start: i,
          end,
          kind: 'CREDIT_CARD',
          value: text.slice(i, end),
          detector: 'credit-card',
          priority: DEFAULT_PRIORITIES.CREDIT_CARD,
        };
        break;
      }

      if (accepted !== null) {
        out.push(accepted);
        i = accepted.end;
        continue;
      }

      // Skip past this digit group and try the next one, so a card that starts
      // partway into a longer run is not lost.
      i = nextGroupStart(text, i, run);
    }

    return out;
  },
};

/** Index of the next digit group inside (or just after) the scanned run. */
function nextGroupStart(text: string, from: number, run: { offsets: readonly number[] }): number {
  for (const offset of run.offsets) {
    if (offset > from && !memberAt(text, offset - 1, isDigit)) return offset;
  }
  return from + 1;
}
