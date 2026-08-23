/**
 * Whether extracted text is worth believing.
 *
 * The dangerous failure of an extractor is not an error. `pdftotext` on a
 * scanned page exits 0 and prints a single form feed; a spreadsheet read with
 * the wrong encoding exits 0 and prints mojibake. Both are successes to
 * anything that only checks the exit status, and a proxy that believes them
 * forwards a scan full of patient names as "nothing personal in here".
 *
 * So every extraction is asked a second question: does this look like prose a
 * detector could have found anything in? The thresholds below are deliberately
 * crude. They decide only whether a document is unreadable, and an unreadable
 * document is refused rather than guessed at, so being wrong costs an operator
 * a warning and never costs a data subject their name.
 */

export interface QualityLimits {
  /** Fewer non-whitespace characters than this is not a document. */
  readonly minChars: number;
  /** What a paged document must clear per page, or its pages were images. */
  readonly minCharsPerPage: number;
  /** Share of U+FFFD above which the encoding was guessed, not read. */
  readonly maxReplacementRatio: number;
  /** Share of control characters above which this is binary, not text. */
  readonly maxNonPrintableRatio: number;
  /**
   * Share of one- and two-character alphabetic runs above which the extractor
   * was shredding words rather than reading them.
   */
  readonly maxFragmentRatio: number;
  /** Below this many alphabetic runs, the fragment ratio is not meaningful. */
  readonly minRunsForFragmentCheck: number;
}

export const DEFAULT_QUALITY_LIMITS: QualityLimits = {
  minChars: 16,
  minCharsPerPage: 8,
  maxReplacementRatio: 0.1,
  maxNonPrintableRatio: 0.3,
  // Deliberately loose. This ratio is the coarse net for a document that is
  // shredded from end to end; the precise work — a passage of shredding inside
  // an otherwise clean page — is done by `hidesIdentifiers` in
  // attach/rewrite.ts, which can tell that case apart from a table of country
  // codes. Tightening this instead would refuse ordinary business documents: a
  // short letter carrying a two-line code table sits at about 0.4.
  maxFragmentRatio: 0.6,
  minRunsForFragmentCheck: 40,
};

/** Either the text may be trusted, or an operator is told why it may not. */
export type QualityVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the words came out whole, taken over the document as a whole.
 *
 * A coarse net, and knowingly so: it catches a document that is fragmented
 * throughout. A passage of shredding inside an otherwise clean page is left to
 * `hidesIdentifiers`, which can tell it apart from a table of short codes.
 *
 * It guards a different failure from the floors above. An extractor that loses a paragraph costs the model
 * context, and nothing more: the text it dropped is text hushgate never
 * forwards either, so nothing leaks.
 *
 * An extractor that *shreds* words is the opposite. `johan.beck er@klinik.de`
 * is forwarded, matches no e-mail pattern, and reaches the provider as
 * personal data that hushgate reported as clean. Splitting on glyph advance
 * widths is a known failure of several PDF paths, so text whose alphabetic
 * runs are overwhelmingly one and two characters long is refused, however
 * fluent the character counts make it look.
 */
function fragmentRatio(text: string): { ratio: number; runs: number } {
  let runs = 0;
  let short = 0;
  let current = 0;

  const finish = (): void => {
    if (current === 0) return;
    runs += 1;
    if (current <= 2) short += 1;
    current = 0;
  };

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (isLetter(code)) current += 1;
    else finish();
  }
  finish();

  return { ratio: runs === 0 ? 0 : short / runs, runs };
}

/** Letters in the ranges European business documents actually use. */
const isLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  (code >= 0xc0 && code <= 0x24f) ||
  (code >= 0x370 && code <= 0x3ff) ||
  (code >= 0x400 && code <= 0x4ff);

/**
 * Separators outside the ASCII range. A page of non-breaking spaces is as
 * empty as a page of spaces, and an extractor that emits U+00A0 for every gap
 * in a PDF is common enough that missing them would defeat the floors.
 */
const WIDE_SPACES = new Set([0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]);

const isWhitespace = (code: number): boolean =>
  code === 0x20 ||
  (code >= 0x09 && code <= 0x0d) ||
  (code >= 0x2000 && code <= 0x200a) ||
  WIDE_SPACES.has(code);

/**
 * C0 controls other than tab, newline and carriage return, plus the C1 block.
 * The form feed is in here on purpose: it is precisely what a scanned page
 * extracts to, and treating it as ordinary layout would hide the failure this
 * module exists to catch.
 */
const isNonPrintable = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
  (code >= 0x80 && code <= 0x9f);

const REPLACEMENT = 0xfffd;

interface Counts {
  /** Code points, whitespace included. The denominator of both ratios. */
  readonly total: number;
  /** Code points that are not whitespace. What the floors are measured in. */
  readonly substantive: number;
  readonly replacement: number;
  readonly nonPrintable: number;
}

const count = (text: string): Counts => {
  let total = 0;
  let substantive = 0;
  let replacement = 0;
  let nonPrintable = 0;

  // Iterating the string yields code points, not UTF-16 units, so an emoji or
  // a CJK extension character counts once rather than twice.
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    total += 1;
    if (!isWhitespace(code)) substantive += 1;
    if (code === REPLACEMENT) replacement += 1;
    if (isNonPrintable(code)) nonPrintable += 1;
  }

  return { total, substantive, replacement, nonPrintable };
};

/**
 * Merged field by field rather than by spread: a limits object parsed from a
 * config file can carry an explicit `undefined`, and spreading that over the
 * defaults would turn every later comparison into `NaN`, which is false — the
 * check would silently pass instead of failing loudly.
 */
const resolveLimits = (limits: Partial<QualityLimits> | undefined): QualityLimits => ({
  minChars: limits?.minChars ?? DEFAULT_QUALITY_LIMITS.minChars,
  minCharsPerPage: limits?.minCharsPerPage ?? DEFAULT_QUALITY_LIMITS.minCharsPerPage,
  maxReplacementRatio: limits?.maxReplacementRatio ?? DEFAULT_QUALITY_LIMITS.maxReplacementRatio,
  maxNonPrintableRatio: limits?.maxNonPrintableRatio ?? DEFAULT_QUALITY_LIMITS.maxNonPrintableRatio,
  maxFragmentRatio: limits?.maxFragmentRatio ?? DEFAULT_QUALITY_LIMITS.maxFragmentRatio,
  minRunsForFragmentCheck:
    limits?.minRunsForFragmentCheck ?? DEFAULT_QUALITY_LIMITS.minRunsForFragmentCheck,
});

const round1 = (value: number): number => Math.round(value * 10) / 10;

const percent = (ratio: number): string => {
  const value = round1(ratio * 100);
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
};

const reject = (reason: string): QualityVerdict => ({ ok: false, reason });

/**
 * Judge one extraction.
 *
 * Every reason names the number that failed, because the operator's next step
 * is to decide whether their document is genuinely a scan or whether their
 * thresholds are wrong, and they cannot tell those apart from a verdict alone.
 */
export function assessText(
  text: string,
  pages: number | null,
  limits?: Partial<QualityLimits>,
): QualityVerdict {
  const active = resolveLimits(limits);
  const counts = count(text);

  // A page count of zero, or a nonsensical one an extractor invented, must not
  // reach the division below: `0 characters per 0 pages` is not a verdict.
  const paged = pages !== null && Number.isFinite(pages) && pages >= 1 ? Math.floor(pages) : null;

  if (counts.substantive < active.minChars) {
    return reject(
      paged === null
        ? `extracted only ${counts.substantive} characters, which is not a readable document`
        : `extracted only ${counts.substantive} characters from ${paged} pages, which is not a readable document`,
    );
  }

  if (paged !== null) {
    const perPage = counts.substantive / paged;
    if (perPage < active.minCharsPerPage) {
      return reject(
        `extracted ${counts.substantive} characters from ${paged} pages, which is ${round1(perPage)} per page and below the floor of ${active.minCharsPerPage}`,
      );
    }
  }

  // Only reachable with a `minChars` of 0, but the ratios below divide by it.
  if (counts.total === 0) return { ok: true };

  const replacementRatio = counts.replacement / counts.total;
  if (replacementRatio > active.maxReplacementRatio) {
    return reject(
      `${percent(replacementRatio)} of the extracted text is the Unicode replacement character, above the limit of ${percent(active.maxReplacementRatio)}`,
    );
  }

  const nonPrintableRatio = counts.nonPrintable / counts.total;
  if (nonPrintableRatio > active.maxNonPrintableRatio) {
    return reject(
      `${percent(nonPrintableRatio)} of the extracted text is control characters, above the limit of ${percent(active.maxNonPrintableRatio)}`,
    );
  }

  // Document-wide on purpose. A window small enough to catch a shredded
  // address block is also small enough to sit entirely inside a table of
  // country codes or a bibliography, and those are ordinary business documents
  // that must not be refused. The localised case is caught precisely, by
  // asking whether closing the gaps reveals an identifier — see
  // `hidesIdentifiers` in attach/rewrite.ts — rather than by guessing from
  // word lengths.
  const fragments = fragmentRatio(text);
  if (fragments.runs >= active.minRunsForFragmentCheck && fragments.ratio > active.maxFragmentRatio) {
    return reject(
      `${percent(fragments.ratio)} of the extracted words are one or two characters long, so the text is fragmented and identifiers in it would not be recognised`,
    );
  }

  return { ok: true };
}
