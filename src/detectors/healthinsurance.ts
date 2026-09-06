import type { Detector, LabelProximity, Span } from '../types.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';
import { isScanSeparator } from './normalise.js';

/**
 * Priority for `HEALTH_INSURANCE_ID`, pending an entry in `DEFAULT_PRIORITIES`.
 *
 * One below `SOCIAL_SECURITY_ID` and above `EMAIL` (75), for the same reason:
 * same family, and the rank only settles ties between spans of equal length.
 */
export const HEALTH_INSURANCE_PRIORITY = 78;

/** Digits after the leading letter: eight of payload plus the check digit. */
const KVNR_DIGITS = 9;

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

/**
 * The check digit for the letter and the eight digits before it, or `null` when
 * those nine characters cannot have one.
 *
 * The unveränderbarer Teil of the Krankenversichertennummer (§ 290 SGB V): the
 * letter expands to its two-digit alphabet position (`A` = 01 … `Z` = 26),
 * giving ten digits, which are multiplied alternately by 1 and 2 from the left.
 * A two-digit product is replaced by its digit sum — which for a doubled digit
 * is the same as subtracting nine, written here the long way so the rule the
 * specification states is the rule the code states.
 *
 * This is *not* Luhn: Luhn weights from the right and would land on the other
 * parity for a ten-digit sequence, quietly rejecting every real number.
 */
export function healthInsuranceCheckDigit(letterAndEight: string): number | null {
  if (letterAndEight.length !== 9) return null;

  const letter = letterAndEight[0]!;
  if (!isAsciiLetter(letter)) return null;

  const position = letter.toUpperCase().codePointAt(0)! - 64;
  const digits = [Math.floor(position / 10), position % 10];

  for (const ch of letterAndEight.slice(1)) {
    if (!isDigit(ch)) return null;
    digits.push(ch.codePointAt(0)! - 48);
  }

  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const product = digits[i]! * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 10) + (product % 10);
  }

  return sum % 10;
}

/** Full validation of a Krankenversichertennummer. Separators must be gone. */
export function isValidHealthInsuranceNumber(value: string): boolean {
  if (value.length !== KVNR_DIGITS + 1) return false;
  if (!/^[A-Za-z]\d{9}$/u.test(value)) return false;

  return healthInsuranceCheckDigit(value.slice(0, 9)) === value.codePointAt(9)! - 48;
}

/**
 * The words that license an unverified KVNR.
 *
 * Declared once at module level, not inside `find`: `labelNear` caches the
 * folded forms in a `WeakMap` keyed on this array's identity, so a fresh array
 * per call would repay the fold on every request instead of once per process.
 */
export const HEALTH_INSURANCE_LABELS: readonly string[] = [
  'KVNR',
  'Versichertennr',
  'Versichertennummer',
  'eGK',
  'Krankenversichertennummer',
  'Vers.-Nr',
];

const LABEL_PROXIMITY: LabelProximity = { labels: HEALTH_INSURANCE_LABELS };

/**
 * Candidate ranges of the shape `letter + nine digits`, separators tolerated.
 *
 * Shared by both detectors below so that the two can never disagree about where
 * a candidate starts and ends — they differ only in what they do with one.
 */
function* candidates(text: string): Generator<{ start: number; end: number; chars: string }> {
  for (let i = 0; i < text.length; i++) {
    if (!memberAt(text, i, isAsciiLetter) || isWordChar(text, i - 1)) continue;

    // `A-123456789` and `A 123 456 789` put a separator between the letter and
    // the digits, which `collectRun` will not skip while it holds nothing yet.
    let from = i + 1;
    if (memberAt(text, from, isScanSeparator) && memberAt(text, from + 1, isDigit)) from += 1;

    const run = collectRun(text, from, isDigit, isScanSeparator, KVNR_DIGITS);
    if (run.chars.length !== KVNR_DIGITS) continue;

    const end = run.offsets[run.offsets.length - 1]! + 1;
    // A tenth digit, or a letter glued to the end, means this was something
    // longer that merely opens with the right shape.
    if (isWordChar(text, end)) continue;

    yield { start: i, end, chars: text[i]! + run.chars };
    i = end - 1;
  }
}

const spanAt = (
  text: string,
  candidate: { start: number; end: number },
  detector: string,
): Span => ({
  start: candidate.start,
  end: candidate.end,
  kind: 'HEALTH_INSURANCE_ID',
  value: text.slice(candidate.start, candidate.end),
  detector,
  priority: HEALTH_INSURANCE_PRIORITY,
});

/**
 * Krankenversichertennummer detector, checksum-verified.
 *
 * Reports without needing a label, because a correct check digit over the
 * letter expansion is evidence the shape alone is not: one candidate in ten
 * survives it, and the surviving one is far likelier to be a KVNR than an
 * order number that happens to open with a letter.
 */
export const healthInsuranceDetector: Detector = {
  name: 'health-insurance',
  priority: HEALTH_INSURANCE_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (!isValidHealthInsuranceNumber(candidate.chars)) continue;
      out.push(spanAt(text, candidate, 'health-insurance'));
    }
    return out;
  },
};

/**
 * Krankenversichertennummer detector for numbers whose check digit does *not*
 * come out, gated on a label.
 *
 * Two detectors rather than one, because `requiresLabel` is enforced centrally
 * and per detector: it cannot say "unless the checksum holds". Splitting the
 * shape between a strict detector and this one expresses that condition without
 * weakening the mechanism, and the split is disjoint — this one skips exactly
 * what the strict one accepts — so a labelled, checksum-valid number is still
 * reported once.
 *
 * What it buys: `KVNR: A123456789` is redacted even though that number's check
 * digit is 0. Test data, transcription slips and the placeholders that fill
 * half the tickets in a Krankenkasse's queue are still real enough to be worth
 * keeping off the wire, and the writer's own label is what says so.
 */
export const healthInsuranceLabelDetector: Detector = {
  name: 'health-insurance-labelled',
  priority: HEALTH_INSURANCE_PRIORITY,
  requiresLabel: LABEL_PROXIMITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (isValidHealthInsuranceNumber(candidate.chars)) continue;
      out.push(spanAt(text, candidate, 'health-insurance-labelled'));
    }
    return out;
  },
};
