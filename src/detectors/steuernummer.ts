/**
 * Steuernummer — the number the Finanzamt gives a file, not the taxpayer.
 *
 * A different number from the eleven-digit Steuer-ID in `taxid.ts`, and the
 * harder of the two to find: it has no nationwide check digit, its length
 * depends on which Land issued it, and stripped of its separators it is ten to
 * thirteen digits, which is also what an order number, an invoice number and a
 * customer reference look like. Nothing in the digits themselves says which it
 * is.
 *
 * So the module is split by how much the *spelling* proves. The grouped form a
 * tax office prints — `27/123/45678`, slashes and one of four layouts the
 * Länder actually use — is distinctive enough to report on sight. Every other
 * spelling waits for a label, which is why there are two detectors over one
 * candidate generator: `requiresLabel` is all-or-nothing per detector, and the
 * two are disjoint by construction so nothing is reported twice.
 */
import type { Detector, LabelProximity, Span } from '../types.js';
import { isScanSeparator } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/**
 * Priority for `GERMAN_TAX_NUMBER`, pending an entry in `DEFAULT_PRIORITIES`.
 *
 * Below `GERMAN_TAX_ID` (80) on purpose. Eleven digits behind the word
 * `Steuernummer` can be either number, and the Steuer-ID is the only one of the
 * two that can prove itself — a check digit and the digit-frequency rule both
 * have to come out. When both claim the same characters, the one that verified
 * them should win, and rank is what settles a tie of equal length.
 */
export const GERMAN_TAX_NUMBER_PRIORITY = 77;

/** Shortest and longest a Steuernummer gets, separators removed. */
const MIN_DIGITS = 10;
const MAX_DIGITS = 13;

/**
 * The smallest group a tax office prints.
 *
 * Runs are collected across separators, so `12.03.2024 15` is one run of ten
 * digits as far as the scanner is concerned. Requiring every group to hold at
 * least two digits costs nothing real — no Land prints a single digit between
 * two slashes — and keeps the most common shape of accidental run, a date with
 * something numeric after it, out of the labelled form.
 */
const MIN_GROUP = 2;

/**
 * The group layouts the Länder print, as digit counts between the slashes.
 *
 * `27/123/45678` is Berlin, Hamburg, Niedersachsen and the other 2-3-5 Länder;
 * 3-3-5 is Bayern, Hessen, Sachsen and most of the rest; 3-4-4 is
 * Nordrhein-Westfalen; 5-5 is Baden-Württemberg, which is also the reason two
 * groups have to be allowed at all. Together they are the whole Länder scheme,
 * ten or eleven digits, and that closed set is precisely what licenses this
 * form to fire with no label: `01/02/2024` and `5/2019` are not in it.
 *
 * The thirteen-digit bundeseinheitliche Steuernummer is deliberately absent —
 * it is not printed slash-grouped, so it arrives through the labelled detector.
 */
export const STEUERNUMMER_LAYOUTS: readonly (readonly number[])[] = [
  [2, 3, 5],
  [3, 3, 5],
  [3, 4, 4],
  [5, 5],
];

/** True when `groups` is one of the layouts a Finanzamt actually prints. */
export function isSteuernummerLayout(groups: readonly number[]): boolean {
  return STEUERNUMMER_LAYOUTS.some(
    (layout) =>
      layout.length === groups.length && layout.every((size, i) => size === groups[i]),
  );
}

/**
 * The words that license the spellings which prove nothing on their own.
 *
 * Declared once at module level, never rebuilt inside `find`: `labelNear`
 * caches the folded forms against this array's identity, so a fresh array per
 * call would repay the fold on every request.
 */
export const STEUERNUMMER_LABELS: readonly string[] = [
  'Steuernummer',
  'St.-Nr',
  'StNr',
  'Steuer-Nr',
  'Steuernr',
];

const LABEL_PROXIMITY: LabelProximity = { labels: STEUERNUMMER_LABELS };

interface Candidate {
  readonly start: number;
  readonly end: number;
  /** Written the way a tax office prints it: slashes only, and a known layout. */
  readonly slashGrouped: boolean;
}

/** Digit counts per contiguous group, and the single character between them. */
function groupsOf(
  text: string,
  offsets: readonly number[],
): { groups: number[]; separators: string[] } {
  const groups: number[] = [];
  const separators: string[] = [];
  let size = 1;

  for (let i = 1; i < offsets.length; i++) {
    const previous = offsets[i - 1]!;
    if (offsets[i] === previous + 1) {
      size += 1;
      continue;
    }
    groups.push(size);
    // `collectRun` only ever steps over a single separator, so the gap is one
    // character and this reads it rather than searching for it.
    separators.push(text[previous + 1]!);
    size = 1;
  }

  groups.push(size);
  return { groups, separators };
}

/**
 * Every digit run of Steuernummer length, classified by how it is written.
 *
 * Shared by both detectors so the two can never disagree about where a
 * candidate starts and ends; they differ only in which classification they act
 * on. Separators come from `isScanSeparator`, so the raw pass already sees
 * `27/123/45678`, `27-123-45678` and the tab-separated spelling as one run and
 * does not have to wait for the identifier scan copy — which would fold the
 * slashes away and take the standalone form's only evidence with them.
 */
function* candidates(text: string): Generator<Candidate> {
  let i = 0;

  while (i < text.length) {
    if (!memberAt(text, i, isDigit) || isWordChar(text, i - 1)) {
      i += 1;
      continue;
    }

    // One digit past the maximum, so a longer number is recognised as longer
    // rather than truncated into a plausible-looking candidate.
    const run = collectRun(text, i, isDigit, isScanSeparator, MAX_DIGITS + 1);
    const { groups, separators } = groupsOf(text, run.offsets);
    const end = run.offsets[run.offsets.length - 1]! + 1;

    if (
      run.chars.length >= MIN_DIGITS &&
      run.chars.length <= MAX_DIGITS &&
      !isWordChar(text, end) &&
      groups.every((size) => size >= MIN_GROUP)
    ) {
      yield {
        start: i,
        end,
        slashGrouped:
          separators.length > 0 &&
          separators.every((ch) => ch === '/') &&
          isSteuernummerLayout(groups) &&
          // A slash on either side means the run is a stretch of a longer
          // slash chain — a URL path such as `/2024/12/123/45678/page` — and
          // not a number a tax office printed. Demoted rather than dropped, so
          // a label can still license it.
          text[i - 1] !== '/' &&
          text[end] !== '/',
      };
      i = end;
      continue;
    }

    // Skip the first group only, not the whole rejected run: `Az. 5/2019,
    // 27/123/45678` collects as one over-long run, and jumping past all of it
    // would take the real Steuernummer with it.
    i = Math.max(i + 1, i + groups[0]!);
  }
}

const spanAt = (text: string, candidate: Candidate, detector: string): Span => ({
  start: candidate.start,
  end: candidate.end,
  kind: 'GERMAN_TAX_NUMBER',
  value: text.slice(candidate.start, candidate.end),
  detector,
  priority: GERMAN_TAX_NUMBER_PRIORITY,
});

/**
 * The slash-grouped Steuernummer, reported unaccompanied.
 *
 * Two or three groups of the right sizes joined by slashes is a shape almost
 * nothing else in a German document has: a date has four digits in the last
 * group and eight in total, an Aktenzeichen has two groups and far fewer
 * digits. That is the whole argument for firing without a label, and it is why
 * the layout set above is closed rather than a range.
 */
export const steuernummerDetector: Detector = {
  name: 'steuernummer',
  priority: GERMAN_TAX_NUMBER_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (!candidate.slashGrouped) continue;
      out.push(spanAt(text, candidate, 'steuernummer'));
    }
    return out;
  },
};

/**
 * Every other spelling — bare, spaced, hyphenated, thirteen digits — gated on
 * a label.
 *
 * `2712345678` is a Steuernummer, a customer number or a phone number, and
 * only the word next to it decides. Enforcement is `detect()`'s, which is the
 * reason for the split: `requiresLabel` cannot say "unless it is slash-grouped",
 * so the condition lives in the two disjoint detectors instead.
 */
export const labelledSteuernummerDetector: Detector = {
  name: 'steuernummer-labelled',
  priority: GERMAN_TAX_NUMBER_PRIORITY,
  requiresLabel: LABEL_PROXIMITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (candidate.slashGrouped) continue;
      out.push(spanAt(text, candidate, 'steuernummer-labelled'));
    }
    return out;
  },
};
