import type { Detector, LabelProximity, Span } from '../types.js';
import { isScanSeparator, labelNear } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/**
 * Kind and priority for the BIC.
 *
 * `DEFAULT_PRIORITIES` has no entry for this kind, so the weight lives here and
 * is exported for whoever registers the detector. It sits above the free-text
 * detectors — a dictionary term or a custom rule are the only things that can
 * plausibly claim the same eight letters — and below every format that carries
 * a checksum, because a BIC has none to offer against them.
 */
export const BIC_KIND = 'BIC';
export const BIC_PRIORITY = 60;

/**
 * ISO 3166-1 alpha-2, complete: all 249 assigned codes, plus `XK`.
 *
 * This is the whole filter. A BIC has no check digit, so the country code in
 * position five and six is the only part of it arithmetic can argue with —
 * which is why this list is complete rather than seeded. It is also short
 * enough to be complete, unlike the bank-code register behind the first four
 * characters, which is not public in a form worth shipping.
 *
 * `XK` is not an ISO code. It is the user-assigned code the SWIFT and IBAN
 * registries use for Kosovo, and Kosovar BICs carry it, so a table used for
 * this purpose needs it. Withdrawn codes are deliberately absent: `AN`, `CS`,
 * `YU` and the rest are not in circulation, and `UK` was never assigned at all
 * — the United Kingdom is `GB`.
 */
export const ISO_3166_ALPHA2: ReadonlySet<string> = new Set([
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
  'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'XK',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
]);

/**
 * ISO 9362, in one expression.
 *
 * Four letters of bank code, two letters of country, then the location code:
 * its first character may not be `0` or `1` and its second may not be `O`,
 * because those are the pairs a reader confuses. That is the rule that turns
 * `C0BADEFFXXX` — a zero where the letter belongs — into a non-BIC. The branch
 * code is three alphanumerics or absent; nine and ten characters do not exist.
 */
const BIC_SHAPE = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9](?:[A-Z0-9]{3})?$/u;

/** True when `value`, ignoring case, is a well-formed BIC. */
export function isBicShaped(value: string): boolean {
  const bic = value.toUpperCase();
  if (bic.length !== 8 && bic.length !== 11) return false;
  if (!BIC_SHAPE.test(bic)) return false;
  return ISO_3166_ALPHA2.has(bic.slice(4, 6));
}

/**
 * The label that licenses a candidate on its own, and how close it must sit.
 *
 * The window is a quarter of the default, and that is the point: a BIC label is
 * written against its value (`BIC: COBADEFFXXX`, `SWIFT-Code COBADEFFXXX`),
 * never a sentence away. At the default sixty-four characters the word `BIC` in
 * a payment block licenses every eight-letter word in the two lines around it —
 * `consectetur` sitting near a real BIC was reported, which is exactly the kind
 * of finding that teaches an operator to ignore findings.
 *
 * Declared once, at module level, because `labelNear` caches the folded labels
 * against this array's identity — rebuilt per call, the fold would be repaid on
 * every candidate in every request.
 */
const BIC_PROXIMITY: LabelProximity = { labels: ['BIC', 'SWIFT'], window: 16 };

/**
 * The countries whose BICs are reported without a label.
 *
 * hushgate sits in front of German-speaking businesses, so a bare `…DE…` is a
 * bank identifier often enough to be worth the occasional word; a bare `…NU…`
 * is `RECHNUNG`, `…OM…` is `CUSTOMER` and `…BA…` is `DATABASE`. All three were
 * reported before this filter existed. A BIC from anywhere else still lands —
 * with its label, which is how a foreign bank's BIC is written in the payment
 * block of an invoice — and a business that banks abroad widens the set.
 */
export const DEFAULT_BIC_HOME_COUNTRIES: readonly string[] = ['DE', 'AT', 'CH'];

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
const isAsciiAlnum = (ch: string): boolean => isAsciiLetter(ch) || isDigit(ch);
const noSeparator = (): boolean => false;

/** One BIC candidate: the characters that make it up and where it ends. */
interface Candidate {
  readonly chars: string;
  readonly end: number;
}

/** The canonical spelling: eight or eleven alphanumerics and nothing else. */
function readSolid(text: string, start: number): Candidate | null {
  // One more than the longest BIC, so a longer token fails on length instead of
  // being cut down to a BIC-shaped prefix.
  const run = collectRun(text, start, isAsciiAlnum, noSeparator, 12);
  if (run.chars.length !== 8 && run.chars.length !== 11) return null;
  return { chars: run.chars, end: start + run.chars.length };
}

/**
 * The spelling a payment block prints: `COBA DE FF XXX`.
 *
 * Every boundary must be separated, not just some — and that is the whole
 * point of reading groups instead of letting a run walk through separators.
 * `COBADEFF ist eine Bank` would otherwise collect eleven characters across the
 * space and report `COBADEFF IST`, which is a valid BIC shape and a sentence.
 * Insisting on the 4-2-2(-3) segmentation makes the difference decidable:
 * a token separated in the middle of a group is prose.
 */
function readGrouped(text: string, start: number): Candidate | null {
  const chars: string[] = [];
  let i = start;

  const take = (size: number): boolean => {
    for (let n = 0; n < size; n += 1) {
      const ch = text[i];
      if (ch === undefined || !isAsciiAlnum(ch)) return false;
      chars.push(ch);
      i += 1;
    }
    return true;
  };

  const separated = (): boolean => {
    const ch = text[i];
    if (ch === undefined || !isScanSeparator(ch)) return false;
    i += 1;
    return true;
  };

  if (!take(4) || !separated() || !take(2) || !separated() || !take(2)) return null;
  if (memberAt(text, i, isAsciiAlnum)) return null;

  // The branch group is optional; without it the eight-character BIC stands on
  // its own, so the head is kept before the attempt that may consume more.
  const head: Candidate = { chars: chars.join(''), end: i };
  if (!separated() || !take(3) || memberAt(text, i, isAsciiAlnum)) return head;

  return { chars: chars.join(''), end: i };
}

/**
 * True when the candidate is written the way a BIC is written and no way a word
 * is: in capitals, with a digit in it, or ending in the `XXX` filler that only
 * a BIC uses to mean "no branch".
 *
 * This is what separates `cobadeffxxx` from `rechnung`, `arbeitgeber` and
 * `engineering` — each of those is eight or eleven letters with an assigned
 * country code in position five and six, and lower-case prose is most of what
 * this proxy carries.
 */
function writtenLikeABic(chars: string): boolean {
  if (chars === chars.toUpperCase()) return true;
  if (/\d/u.test(chars)) return true;
  return chars.length === 11 && chars.slice(8).toUpperCase() === 'XXX';
}

/** How to build the detector. */
export interface BicOptions {
  /**
   * Countries whose BICs are reported without a label. Defaults to
   * {@link DEFAULT_BIC_HOME_COUNTRIES}; codes outside ISO 3166-1 are ignored.
   */
  readonly homeCountries?: Iterable<string>;
}

/**
 * BIC/SWIFT detector.
 *
 * There is no checksum here, so acceptance is a question of evidence rather
 * than arithmetic, and there are exactly two ways to get it: the candidate is
 * a home-country BIC written the way BICs are written, or its label is next to
 * it. What that leaves through is worth naming: an all-capitals word from a
 * home country — `EINSCHUB` reads as bank `EINS` in Switzerland — is still
 * reported. Nothing structural separates it from `COBADEFF`, and refusing the
 * bare form would mean refusing the spelling every payment block uses.
 */
export function createBicDetector(options: BicOptions = {}): Detector {
  const home = new Set(
    [...(options.homeCountries ?? DEFAULT_BIC_HOME_COUNTRIES)].map((code) => code.toUpperCase()),
  );

  return {
    name: 'bic',
    priority: BIC_PRIORITY,

    find(text: string): Span[] {
      const out: Span[] = [];
      let i = 0;

      while (i < text.length) {
        if (!memberAt(text, i, isAsciiLetter) || isWordChar(text, i - 1)) {
          i += 1;
          continue;
        }

        const candidate = readSolid(text, i) ?? readGrouped(text, i);
        if (candidate === null || !isBicShaped(candidate.chars)) {
          i += 1;
          continue;
        }

        const country = candidate.chars.slice(4, 6).toUpperCase();
        const accepted =
          (home.has(country) && writtenLikeABic(candidate.chars)) ||
          labelNear(text, i, candidate.end, BIC_PROXIMITY);
        if (!accepted) {
          i += 1;
          continue;
        }

        out.push({
          start: i,
          end: candidate.end,
          kind: BIC_KIND,
          value: text.slice(i, candidate.end),
          detector: 'bic',
          priority: BIC_PRIORITY,
        });
        i = candidate.end;
      }

      return out;
    },
  };
}

/** The detector as registered: German-speaking home countries, labels for the rest. */
export const bicDetector: Detector = createBicDetector();
