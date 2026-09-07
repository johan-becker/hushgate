import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { collectRun, isDigit, isUpperAlnum, isWordChar, memberAt } from './util.js';

/**
 * Registered IBAN lengths per ISO 3166-1 alpha-2 country code.
 *
 * The length is part of the validation, not a convenience: a German IBAN is
 * always 22 characters, so `DE89370400440532013` cannot be one no matter what
 * the checksum says. Country codes outside this table are rejected rather than
 * guessed — an unknown two-letter prefix followed by digits is far more likely
 * to be an order number than an IBAN.
 */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22,
  BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27,
  JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21,
  MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31,
  SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20,
};

/**
 * ISO 13616 / ISO 7064 MOD 97-10 check.
 *
 * Move the first four characters to the end, expand letters to two digits
 * (A = 10 … Z = 35) and take the whole thing modulo 97. A valid IBAN leaves a
 * remainder of exactly 1. The number is far too large for a JS `number`, so the
 * modulo is folded digit by digit.
 */
export function ibanChecksum(normalized: string): number {
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;

  for (const ch of rearranged) {
    const code = ch.codePointAt(0) ?? 0;
    const expanded = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const digit of expanded) {
      remainder = (remainder * 10 + (digit.codePointAt(0)! - 48)) % 97;
    }
  }

  return remainder;
}

/** Validate a candidate IBAN. Spaces are ignored; case must already be upper. */
export function isValidIban(candidate: string): boolean {
  const normalized = candidate.replaceAll(/\s/gu, '');
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(normalized)) return false;

  const expected = IBAN_LENGTHS[normalized.slice(0, 2)];
  if (expected === undefined || normalized.length !== expected) return false;

  return ibanChecksum(normalized) === 1;
}

const isSeparator = (ch: string): boolean => ch === ' ';

/**
 * IBAN detector.
 *
 * Anchors on `CC99` at a word boundary, looks up the expected length for the
 * country, collects exactly that many alphanumerics (tolerating single spaces
 * between groups) and only then runs the checksum. Anything longer or shorter
 * than the registered length is rejected outright.
 */
export const ibanDetector: Detector = {
  name: 'iban',
  priority: DEFAULT_PRIORITIES.IBAN,

  find(text: string): Span[] {
    const out: Span[] = [];
    const anchor = /[A-Z]{2}\d{2}/gu;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(text)) !== null) {
      const start = match.index;
      if (isWordChar(text, start - 1)) continue;

      const expected = IBAN_LENGTHS[text.slice(start, start + 2)];
      if (expected === undefined) continue;

      const run = collectRun(text, start, isUpperAlnum, isSeparator, expected);
      if (run.chars.length !== expected) continue;

      const end = run.end;
      // Reject when the run continues: `DE89…013000X` is not an IBAN.
      if (memberAt(text, end, isUpperAlnum) || memberAt(text, end, isDigit)) continue;
      if (!isValidIban(run.chars)) continue;

      out.push({
        start,
        end,
        kind: 'IBAN',
        value: text.slice(start, end),
        detector: 'iban',
        priority: DEFAULT_PRIORITIES.IBAN,
      });

      anchor.lastIndex = end;
    }

    return out;
  },
};
