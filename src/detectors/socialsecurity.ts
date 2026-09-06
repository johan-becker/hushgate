import type { Detector, Span } from '../types.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';
import { isScanSeparator } from './normalise.js';

/**
 * Priority for `SOCIAL_SECURITY_ID`, pending an entry in `DEFAULT_PRIORITIES`.
 *
 * Placed just under `GERMAN_TAX_ID` (80) and above `EMAIL` (75): it is the same
 * family — a checksum-backed German government identifier — and the exact rank
 * within that family only ever decides a tie between two spans of identical
 * length, which the twelve-character shape makes close to impossible.
 */
export const SOCIAL_SECURITY_PRIORITY = 79;

/** `SVNR` length once separators are removed: 2 + 6 + 1 + 2 + 1. */
const SVNR_LENGTH = 12;

/**
 * Weights the Deutsche Rentenversicherung applies to the twelve digits that the
 * first eleven characters expand to.
 *
 * The `5` and the `7` in the middle are what make this not a Luhn variant, and
 * are the reason the table is written out rather than generated: an alternating
 * 1/2 pattern would validate a different set of numbers entirely and would fail
 * silently, accepting and rejecting roughly the right *proportion* of inputs
 * while being wrong about which ones.
 *
 * The trap is worse than it looks. The DRV's own worked example, 65170839J003,
 * comes out to 3 under the alternating table too, so a wrong implementation
 * passes the one test anybody thinks to write. The test file therefore recovers
 * each weight by probing rather than trusting that example.
 */
const WEIGHTS = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1] as const;

/**
 * Bereichsnummern outside `02`–`89` are not allocated to any Rentenversicherungs-
 * träger.
 *
 * This is a range check standing in for a closed list: the authoritative
 * allocation (DSRV, Anlage 1 zur Gemeinsamen Grundsätze §28b SGB IV) has gaps
 * inside this range, so a real number always passes here but a few impossible
 * ones do too. The range is the part that can be stated without inventing it,
 * and the check digit removes nine tenths of what slips through.
 */
const MIN_AREA = 2;
const MAX_AREA = 89;

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

const isSvnrChar = (ch: string): boolean => isDigit(ch) || isAsciiLetter(ch);

/**
 * The check digit for the first eleven characters of a Versicherungsnummer, or
 * `null` when those characters are not the right shape to have one.
 *
 * The letter — the first letter of the birth surname — expands to its two-digit
 * alphabet position (`A` = 01 … `Z` = 26), which turns eleven characters into
 * twelve digits. Each digit is multiplied by its weight, the *digit sums* of the
 * products are added, and the check digit is that total modulo ten. Taking the
 * digit sum rather than the product is the step a Luhn implementation gets right
 * by accident and a naive one gets wrong: `7 × 7` contributes 4, not 49.
 */
export function socialSecurityCheckDigit(firstEleven: string): number | null {
  if (firstEleven.length !== 11) return null;

  const digits: number[] = [];

  for (let i = 0; i < firstEleven.length; i++) {
    const ch = firstEleven[i]!;

    if (i === 8) {
      if (!isAsciiLetter(ch)) return null;
      const position = ch.toUpperCase().codePointAt(0)! - 64;
      digits.push(Math.floor(position / 10), position % 10);
      continue;
    }

    if (!isDigit(ch)) return null;
    digits.push(ch.codePointAt(0)! - 48);
  }

  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const product = digits[i]! * WEIGHTS[i]!;
    sum += Math.floor(product / 10) + (product % 10);
  }

  return sum % 10;
}

/**
 * True when the six date digits spell a day that a calendar has.
 *
 * The year is two digits, so the century — and with it whether February had 29
 * days — is unknowable. 29 February is therefore always accepted: rejecting it
 * would throw away every leap-day birth in three quarters of the possible
 * centuries, and letting through one impossible date per century is the
 * cheaper error for a firewall to make.
 */
function isPlausibleBirthDate(ddmmyy: string): boolean {
  const day = Number(ddmmyy.slice(0, 2));
  const month = Number(ddmmyy.slice(2, 4));

  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  if (month === 2) return day <= 29;
  return day <= ([4, 6, 9, 11].includes(month) ? 30 : 31);
}

/**
 * Full validation of a Sozial-/Rentenversicherungsnummer.
 *
 * `value` must already have its separators removed; case is folded here because
 * the letter is written both ways in practice and the raw pass sees whichever
 * the author typed.
 */
export function isValidSocialSecurityNumber(value: string): boolean {
  if (value.length !== SVNR_LENGTH) return false;
  if (!/^\d{8}[A-Za-z]\d{3}$/u.test(value)) return false;

  const area = Number(value.slice(0, 2));
  if (area < MIN_AREA || area > MAX_AREA) return false;

  if (!isPlausibleBirthDate(value.slice(2, 8))) return false;

  return socialSecurityCheckDigit(value.slice(0, 11)) === value.codePointAt(11)! - 48;
}

/**
 * Sozialversicherungsnummer detector.
 *
 * Gated on the check digit alone, deliberately: `DD MMYY L SS P` with a real
 * birth date, an allocated Bereichsnummer and a correct check digit is a shape
 * ordinary text does not produce by accident, so demanding `RV-Nr.:` next to it
 * as well would cost real findings in the tables and CSV exports where these
 * numbers actually travel — precisely the places where the column header sits
 * far outside any proximity window.
 *
 * Separator handling uses {@link isScanSeparator} rather than a private list,
 * so the grouped spellings are found on the raw pass and never depend on the
 * identifier scan copy — which would not fold this shape anyway, the single
 * letter being a group that is not mostly digits.
 */
export const socialSecurityDetector: Detector = {
  name: 'social-security',
  priority: SOCIAL_SECURITY_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];

    for (let i = 0; i < text.length; i++) {
      // The word-boundary guard is also what keeps this linear: inside a digit
      // group every position but the first is preceded by a word character, so
      // only group heads ever collect a run.
      if (!memberAt(text, i, isDigit) || isWordChar(text, i - 1)) continue;

      const run = collectRun(text, i, isSvnrChar, isScanSeparator, SVNR_LENGTH);
      if (run.chars.length !== SVNR_LENGTH) continue;

      const end = run.offsets[run.offsets.length - 1]! + 1;
      // A thirteenth character means this was never a Versicherungsnummer, only
      // the first twelve characters of something longer.
      if (memberAt(text, end, isSvnrChar)) continue;
      if (!isValidSocialSecurityNumber(run.chars)) continue;

      out.push({
        start: i,
        end,
        kind: 'SOCIAL_SECURITY_ID',
        value: text.slice(i, end),
        detector: 'social-security',
        priority: SOCIAL_SECURITY_PRIORITY,
      });

      i = end - 1;
    }

    return out;
  },
};
