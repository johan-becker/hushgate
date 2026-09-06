/**
 * Führerscheinnummer — `B072RRE2I55`.
 *
 * Eleven characters from the full alphanumeric alphabet, with no check digit
 * anyone outside the issuing authority can verify. That is a weak shape: every
 * eleven-character token in a German sentence has it, and quite a few of them
 * — `Verkehrsamt` is exactly eleven letters — sit next to the very words that
 * would license the number. So the label is required, and three structural
 * rules keep the label from licensing the wrong eleven characters:
 *
 *  1. digits *and* letters, because a licence number carries a laufende Nummer
 *     and an authority key and no German word carries a digit;
 *  2. the letters all in one case, which is what separates `B072RRE2I55` from
 *     `Ende Mai 2019` — eleven alphanumerics with a digit, bounded by spaces,
 *     and mixed-cased the way prose is;
 *  3. when it is written in groups, every group is at least three characters
 *     and carries a digit of its own — a licence number interleaves its
 *     authority key and its running number, where a run assembled out of the
 *     spaces between words (`2019 gueltig`, `Ende Mai 2019`) puts all its
 *     digits in one group and all its letters in another.
 *
 * The third rule gives up the fully spaced-out evasion `B 0 7 2 R R E 2 I 5 5`
 * — which is not lost, because the wordShape scan copy collapses runs of four
 * or more single characters before this detector ever sees them.
 */
import type { Detector, LabelProximity, Span } from '../types.js';
import { isScanSeparator } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt, type RunScan } from './util.js';

/**
 * Priority for `DRIVER_LICENCE_ID`, pending an entry in `DEFAULT_PRIORITIES`.
 *
 * Below both tax numbers: an all-digit run of eleven is a Steuer-ID far more
 * often than a licence, and the Steuer-ID can prove it with a check digit.
 */
export const DRIVER_LICENCE_PRIORITY = 76;

/** Behördenschlüssel, laufende Nummer, Prüfziffer and Ausfertigung. */
const LICENCE_LENGTH = 11;

/** The smallest group the number is ever printed in: `B072 RRE2 I55`. */
const MIN_GROUP = 3;

/**
 * The words that license eleven characters to be a licence number.
 *
 * Declared once at module level, never rebuilt inside `find`: `labelNear`
 * caches the folded forms against this array's identity. Both spellings of the
 * umlaut are listed because the fold strips combining marks rather than
 * transliterating — `Führerschein` folds to `fuhrerschein` and the `ue`
 * spelling to `fuehrerschein`, and neither contains the other.
 */
export const DRIVER_LICENCE_LABELS: readonly string[] = [
  'Führerschein',
  'Fuehrerschein',
  'FS-Nr',
  'Führerscheinnummer',
  'Fahrerlaubnis',
];

const LABEL_PROXIMITY: LabelProximity = { labels: DRIVER_LICENCE_LABELS };

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

const isAlnum = (ch: string): boolean => isDigit(ch) || isAsciiLetter(ch);

/**
 * Can these eleven characters be a licence number?
 *
 * Separators are already gone; what is left is the shape argument the module
 * comment sets out. Case consistency is checked over the letters only, so
 * `b072rre2i55` and `B072RRE2I55` both pass and `Ende Mai 2019` does not.
 */
export function isDriverLicenceShape(value: string): boolean {
  if (value.length !== LICENCE_LENGTH) return false;

  let digits = 0;
  let upper = 0;
  let lower = 0;

  for (const ch of value) {
    if (isDigit(ch)) {
      digits += 1;
      continue;
    }
    if (ch >= 'A' && ch <= 'Z') upper += 1;
    else if (ch >= 'a' && ch <= 'z') lower += 1;
    else return false;
  }

  if (digits === 0 || upper + lower === 0) return false;
  return upper === 0 || lower === 0;
}

/**
 * True when the run is written in one piece, or in groups a licence is printed
 * in.
 *
 * Separators are what let a run cross the spaces between words, so a run that
 * used them has to answer for them: at most three groups, none shorter than
 * `B072`'s neighbour `I55`, and each holding a digit. The last condition is the
 * one that does the work — `2019 gueltig` and `Ende Mai 2019` are eleven
 * alphanumerics with digits and letters and a clean boundary either side, and
 * what gives them away is that their digits and their letters never mix.
 *
 * The ungrouped form is not asked any of this: eleven characters written
 * against each other are already one token, and nothing was assembled.
 */
function isPrintedGrouping(run: RunScan): boolean {
  const groups: string[] = [];
  let from = 0;

  for (let i = 1; i < run.offsets.length; i++) {
    if (run.offsets[i] === run.offsets[i - 1]! + 1) continue;
    groups.push(run.chars.slice(from, i));
    from = i;
  }
  groups.push(run.chars.slice(from));

  if (groups.length === 1) return true;
  return (
    groups.length <= 3 &&
    groups.every((group) => group.length >= MIN_GROUP && [...group].some(isDigit))
  );
}

/**
 * Führerschein detector.
 *
 * Exactly eleven characters are collected and the character sitting against
 * the run then has to not be one: `B072RRE2I556` must not be read as the first
 * eleven of twelve. Collecting one more instead would be simpler and wrong,
 * because a separator counts as part of the run and would pull in the next
 * word.
 */
export const driverLicenceDetector: Detector = {
  name: 'driver-licence',
  priority: DRIVER_LICENCE_PRIORITY,
  requiresLabel: LABEL_PROXIMITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      if (!memberAt(text, i, isAlnum) || isWordChar(text, i - 1)) {
        i += 1;
        continue;
      }

      const run = collectRun(text, i, isAlnum, isScanSeparator, LICENCE_LENGTH);
      if (
        run.chars.length !== LICENCE_LENGTH ||
        !isDriverLicenceShape(run.chars) ||
        !isPrintedGrouping(run)
      ) {
        i += 1;
        continue;
      }

      const end = run.offsets[LICENCE_LENGTH - 1]! + 1;
      if (isWordChar(text, end)) {
        i += 1;
        continue;
      }

      out.push({
        start: i,
        end,
        kind: 'DRIVER_LICENCE_ID',
        value: text.slice(i, end),
        detector: 'driver-licence',
        priority: DRIVER_LICENCE_PRIORITY,
      });
      i = end;
    }

    return out;
  },
};
