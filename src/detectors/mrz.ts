/**
 * ICAO Doc 9303 machine-readable zones: TD1, TD2 and TD3.
 *
 * Deliberately generic rather than German-only. A French or Turkish MRZ pasted
 * into a German prompt is exactly as much personal data, the algorithm is
 * identical, and the false-positive rate does not change. Germany is merely
 * identifiable by the issuing-state code `D<<`.
 *
 * This is the strongest detector hushgate ships and the highest-value one. A
 * pasted passport scan is the densest PII payload the proxy will ever see —
 * name, date of birth, sex, nationality, expiry and document number in one
 * block — and it is also the most completely checksummed: four or five
 * independent ICAO 7-3-1 check digits, one of them a composite over the
 * others. Ordinary text does not pass all of them. A 44-character uppercase
 * blob shape-matches and is rejected; that is the whole point.
 *
 * Unicode evasion is NOT handled here. `normaliseForScan` builds the scan copy
 * every detector sees, stripping invisibles and folding full-width characters
 * back to ASCII, and maps findings onto the original offsets. Tolerating the
 * same things a second time here would produce duplicate candidates fighting
 * in `resolveSpans`, so the patterns below assume clean, canonical input.
 */
import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { icaoCheckDigit } from './idcard.js';

/*
 * Why `DEFAULT_PRIORITIES.TRAVEL_DOCUMENT_MRZ` is 99: directly below `SECRET`
 * (100) and above everything else, `SESSION_TOKEN` (98) included.
 *
 * An MRZ block is by construction longer than any candidate inside it — a
 * `DATE_OF_BIRTH`, a `NAME`, a stray driving-licence or VAT shape between two
 * `<` fillers — so `resolveSpans`'s longest-wins already protects it. The
 * priority exists so that a degenerate equal-length tie can never go the wrong
 * way. It sits below `SECRET` because a PEM block or an API key found inside a
 * pasted document must still win.
 *
 * 99 rather than 98, which is what this said when it was written: `SESSION_TOKEN`
 * took 98 in the meantime, and the deliberate ties in `DEFAULT_PRIORITIES` are
 * documented there as exactly one — `ID_CARD_NUMBER` and `PASSPORT_NUMBER`,
 * which come from a single detector and therefore cannot overlap. Two unrelated
 * detectors sharing a number would be a tie nothing breaks. The MRZ alphabet is
 * `A`-`Z`, `0`-`9` and `<`, so a cookie assignment cannot occur inside a block
 * and the pair can never actually collide — but a number that says so is
 * cheaper than a reader who has to work it out.
 */
const MRZ_KIND = 'TRAVEL_DOCUMENT_MRZ';
const MRZ_DETECTOR = 'travel-document-mrz';

/** The three ICAO document sizes, by line width. */
export type MrzFormat = 'TD1' | 'TD2' | 'TD3';

/** Line widths that can start a block. Anything else is rejected in O(1). */
const TD1_WIDTH = 30;
const TD2_WIDTH = 36;
const TD3_WIDTH = 44;

/**
 * How many empty lines may sit between two lines of one block.
 *
 * Not pedantry: a PDF or OCR text extractor routinely emits a blank line per
 * rendered row, so the block a user pastes out of a scanned passport arrives
 * double-spaced as often as not. Refusing those would fail on exactly the
 * input this detector exists for. One is the limit — a wider gap is no longer
 * one block, and each extra line of tolerance is another line the two-line
 * forms could swallow, because their upper line carries no check digit of its
 * own.
 */
const MAX_BLANK_LINES = 1;

/** A located MRZ block. Offsets are into the text that was scanned. */
export interface MrzBlock {
  /** Inclusive start offset, at the first character of the first line. */
  readonly start: number;
  /** Exclusive end offset, just past the last character of the last line. */
  readonly end: number;
  /** Which ICAO document type validated. */
  readonly format: MrzFormat;
  /** Lines the block covers: 1 (lone lower line), 2, or 3. */
  readonly lineCount: number;
}

/* -------------------------------------------------------------------------- */
/* Character classes                                                          */
/* -------------------------------------------------------------------------- */

/** `A`-`Z`, `0`-`9` or the filler `<` — the entire MRZ alphabet. */
function isMrzCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    code === 60 // <
  );
}

/** Horizontal whitespace and the `\r` of a CRLF: trimmed off both line ends. */
function isTrimmable(code: number): boolean {
  return code === 32 || code === 9 || code === 13;
}

/** Value of a check-digit character, or `-1` when it is not a digit. */
function digitValue(ch: string | undefined): number {
  if (ch === undefined || ch < '0' || ch > '9') return -1;
  return ch.codePointAt(0)! - 48;
}

/** True when every character of `line` is in the MRZ alphabet. */
function isMrzShaped(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (!isMrzCode(line.charCodeAt(i))) return false;
  }
  return true;
}

/** True when `[from, to)` is a three-character state code: `A`-`Z` or filler. */
function isStateCode(line: string, from: number): boolean {
  for (let i = from; i < from + 3; i++) {
    const code = line.charCodeAt(i);
    if (!((code >= 65 && code <= 90) || code === 60)) return false;
  }
  return true;
}

/** ICAO 9303 sex field: male, female, or unspecified. */
function isSexField(ch: string | undefined): boolean {
  return ch === 'M' || ch === 'F' || ch === '<';
}

/**
 * `YYMMDD` plausibility. Cheap, and worth having: it costs one comparison per
 * field and removes most of the random blobs before any arithmetic runs.
 *
 * Day is only bounded at 31 rather than by the month's real length. The MRZ
 * date is a truncated two-digit year, so a real calendar check would need a
 * century rule that ICAO does not define, and the check digit over the same six
 * characters is a far stronger filter than the last day of February.
 */
function isDateField(line: string, from: number): boolean {
  for (let i = from; i < from + 6; i++) {
    const code = line.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  const month = Number(line.slice(from + 2, from + 4));
  const day = Number(line.slice(from + 4, from + 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * Document code, positions 1-2 of the upper line of any multi-line form.
 *
 * `P` passport, `I`/`A`/`C` the identity-card family, `V` visa; position 2 is
 * the issuer's own subtype letter or filler. Kept to the first character rather
 * than an exhaustive two-letter list, because an exhaustive list would have to
 * be maintained per issuing state and would start producing false negatives the
 * moment one of them added a subtype.
 */
function isDocumentCode(line: string): boolean {
  const first = line[0];
  if (first !== 'P' && first !== 'I' && first !== 'A' && first !== 'C' && first !== 'V') {
    return false;
  }
  const second = line.charCodeAt(1);
  return (second >= 65 && second <= 90) || second === 60;
}

/* -------------------------------------------------------------------------- */
/* Check digits                                                               */
/* -------------------------------------------------------------------------- */

/** `icaoCheckDigit(line[from..to))` must equal the digit at `at`. */
function checkField(line: string, from: number, to: number, at: number): boolean {
  const expected = digitValue(line[at]);
  return expected >= 0 && icaoCheckDigit(line.slice(from, to)) === expected;
}

/**
 * The optional-data check digit of a TD3 lower line.
 *
 * When the field is entirely filler the issuer may write either `0` or `<`,
 * and both occur on real documents — ICAO 9303-4 permits the filler because
 * there is nothing to check. Anything else must carry the real digit.
 */
function checkOptionalField(line: string, from: number, to: number, at: number): boolean {
  let allFiller = true;
  for (let i = from; i < to; i++) {
    if (line.charCodeAt(i) !== 60) {
      allFiller = false;
      break;
    }
  }
  if (allFiller) {
    const ch = line[at];
    return ch === '<' || ch === '0';
  }
  return checkField(line, from, to, at);
}

/* -------------------------------------------------------------------------- */
/* Per-format validation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * TD3 lower line, 44 characters (passport).
 *
 * ```
 *   1-9   document number      -> 10
 *  11-13  issuing state
 *  14-19  date of birth        -> 20
 *     21  sex
 *  22-27  date of expiry       -> 28
 *  29-42  optional data        -> 43
 *  composite over 1-10, 14-20, 22-43 -> 44
 * ```
 *
 * The composite deliberately excludes the issuing state (11-13) and the sex
 * field (21). Carrying every one of its own check digits is what makes a lone
 * lower line safely validatable when it is pasted without its name line.
 */
export function isValidTd3Lower(line: string): boolean {
  if (line.length !== TD3_WIDTH || !isMrzShaped(line)) return false;
  if (!isStateCode(line, 10)) return false;
  if (!isSexField(line[20])) return false;
  if (!isDateField(line, 13) || !isDateField(line, 21)) return false;

  if (!checkField(line, 0, 9, 9)) return false;
  if (!checkField(line, 13, 19, 19)) return false;
  if (!checkField(line, 21, 27, 27)) return false;
  if (!checkOptionalField(line, 28, 42, 42)) return false;

  const composite = line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43);
  const expected = digitValue(line[43]);
  return expected >= 0 && icaoCheckDigit(composite) === expected;
}

/**
 * TD2 lower line, 36 characters.
 *
 * Same field order as TD3 with a shorter optional-data field that carries no
 * check digit of its own; the composite runs over 1-10, 14-20, 22-35 -> 36.
 */
export function isValidTd2Lower(line: string): boolean {
  if (line.length !== TD2_WIDTH || !isMrzShaped(line)) return false;
  if (!isStateCode(line, 10)) return false;
  if (!isSexField(line[20])) return false;
  if (!isDateField(line, 13) || !isDateField(line, 21)) return false;

  if (!checkField(line, 0, 9, 9)) return false;
  if (!checkField(line, 13, 19, 19)) return false;
  if (!checkField(line, 21, 27, 27)) return false;

  const composite = line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 35);
  const expected = digitValue(line[35]);
  return expected >= 0 && icaoCheckDigit(composite) === expected;
}

/**
 * TD1 upper + middle lines, 30 characters each (identity card).
 *
 * ```
 *  L1  1-2   document code
 *  L1  3-5   issuing state
 *  L1  6-14  document number   -> L1 15
 *  L1 16-30  optional data 1
 *  L2  1-6   date of birth     -> L2 7
 *  L2    8   sex
 *  L2  9-14  date of expiry    -> L2 15
 *  L2 16-18  nationality
 *  L2 19-29  optional data 2
 *  composite over L1 6-30 and L2 1-7, 9-15, 19-29 -> L2 30
 * ```
 *
 * The third line is the name and carries nothing checkable, so the whole
 * validation lives in these two — which is why a TD1 pasted without its name
 * line is still accepted, while a *lone* TD1 line never is: its composite
 * spans two lines and cannot be verified from one.
 *
 * Long document number: when L1[15] is the filler `<`, the number overflows
 * into optional data 1 and its check digit moves with it. German numbers are
 * nine characters so this never applies to a `D<<` document, but a generic
 * detector must not choke on a foreign one. The document-number check is
 * skipped in that case; the birth, expiry and composite digits still run, and
 * the composite covers the overflow field anyway.
 */
export function isValidTd1(upper: string, middle: string): boolean {
  if (upper.length !== TD1_WIDTH || middle.length !== TD1_WIDTH) return false;
  if (!isMrzShaped(upper) || !isMrzShaped(middle)) return false;

  if (!isDocumentCode(upper)) return false;
  if (!isStateCode(upper, 2)) return false;
  if (!isStateCode(middle, 15)) return false;
  if (!isSexField(middle[7])) return false;
  if (!isDateField(middle, 0) || !isDateField(middle, 8)) return false;

  if (upper[14] !== '<' && !checkField(upper, 5, 14, 14)) return false;
  if (!checkField(middle, 0, 6, 6)) return false;
  if (!checkField(middle, 8, 14, 14)) return false;

  const composite =
    upper.slice(5, 30) + middle.slice(0, 7) + middle.slice(8, 15) + middle.slice(18, 29);
  const expected = digitValue(middle[29]);
  return expected >= 0 && icaoCheckDigit(composite) === expected;
}

/* -------------------------------------------------------------------------- */
/* Block finding                                                              */
/* -------------------------------------------------------------------------- */

/** One line that already passed the width and alphabet test. */
interface ShapedLine {
  readonly start: number;
  readonly end: number;
  readonly width: number;
}

/**
 * Locate every MRZ block in `text`.
 *
 * **Span extent.** A block is emitted as ONE range covering all its lines,
 * newlines included, rather than one range per line. `resolveSpans`'s
 * longest-wins then automatically stops an inner `DATE_OF_BIRTH` or `NAME`
 * candidate from carving the block into pieces, and re-hydration puts the block
 * back exactly as it was written. The range starts at the first non-blank
 * character of the first line and ends at the last non-blank character of the
 * last line, so surrounding indentation, trailing spaces and a trailing `\r`
 * are never inside the value.
 *
 * **Line separators.** `\n` and `\r\n` are equivalent; a `\r\n` inside a block
 * is part of the span because the span is contiguous. Up to
 * {@link MAX_BLANK_LINES} empty line may sit between two lines of one block,
 * and it too falls inside the span.
 *
 * **Deliberate overlap.** When a two-line TD3 or TD2 block matches, its lower
 * line also matches the lone-line rule, so two candidates are returned. That is
 * intended: detectors return candidates, resolution is central, and the longer
 * span wins without any special-casing here. It also means a block whose upper
 * line was lost — a copy-paste that clipped the first row — still degrades to
 * the fully validated lower line rather than to nothing.
 */
export function findMrzBlocks(text: string): MrzBlock[] {
  const blocks: MrzBlock[] = [];
  let group: ShapedLine[] = [];
  let blankRun = 0;

  const flush = (): void => {
    if (group.length > 0) {
      interpret(text, group, blocks);
      group = [];
    }
  };

  const length = text.length;
  let pos = 0;

  while (pos <= length) {
    const newline = text.indexOf('\n', pos);
    const lineEnd = newline === -1 ? length : newline;

    let from = pos;
    let to = lineEnd;
    while (to > from && isTrimmable(text.charCodeAt(to - 1))) to--;
    while (from < to && isTrimmable(text.charCodeAt(from))) from++;

    const width = to - from;
    if (width === 0) {
      blankRun++;
      if (blankRun > MAX_BLANK_LINES) flush();
    } else if (
      (width === TD1_WIDTH || width === TD2_WIDTH || width === TD3_WIDTH) &&
      isMrzShaped(text.slice(from, to))
    ) {
      // The width test above is what keeps this affordable over a 4 MiB body:
      // all but a vanishing fraction of lines are rejected by an integer
      // comparison, and only a shaped line is ever sliced or arithmetic'd.
      group.push({ start: from, end: to, width });
      blankRun = 0;
    } else {
      flush();
      blankRun = 0;
    }

    pos = newline === -1 ? length + 1 : newline + 1;
  }

  flush();

  // Multi-line blocks are found before lone lines, so sort into reading order.
  // Longer first at an equal start keeps the containing block ahead of the
  // lone-line candidate it contains, which is only cosmetic — `resolveSpans`
  // orders candidates itself — but makes the detector's own output readable.
  return blocks.toSorted((a, b) => a.start - b.start || b.end - a.end);
}

/** Interpret one run of consecutive shaped lines. */
function interpret(text: string, lines: readonly ShapedLine[], out: MrzBlock[]): void {
  const read = (line: ShapedLine): string => text.slice(line.start, line.end);

  let i = 0;
  while (i < lines.length) {
    const consumed = tryMultiLine(lines, i, read, out);
    // On failure advance by one, not by the window: a stray shaped line before
    // a real block (a table rule, a base32 fragment) must not hide it.
    i += consumed > 0 ? consumed : 1;
  }

  // A lone lower line carries all its own check digits, so it is safe to accept
  // on its own. A lone TD1 line is not, and is never emitted.
  for (const line of lines) {
    if (line.width === TD3_WIDTH && isValidTd3Lower(read(line))) {
      out.push({ start: line.start, end: line.end, format: 'TD3', lineCount: 1 });
    } else if (line.width === TD2_WIDTH && isValidTd2Lower(read(line))) {
      out.push({ start: line.start, end: line.end, format: 'TD2', lineCount: 1 });
    }
  }
}

/** Try the multi-line forms at `i`; returns how many lines were consumed. */
function tryMultiLine(
  lines: readonly ShapedLine[],
  i: number,
  read: (line: ShapedLine) => string,
  out: MrzBlock[],
): number {
  const first = lines[i]!;
  const second = lines[i + 1];
  if (second === undefined || second.width !== first.width) return 0;

  if (first.width === TD1_WIDTH) {
    if (!isValidTd1(read(first), read(second))) return 0;
    // The name line carries no check digit, so it is taken on adjacency alone —
    // and only when it is there. A TD1 clipped to its first two lines is still
    // fully validated and still reported.
    const third = lines[i + 2];
    const fourth = lines[i + 3];
    const startsAnotherCard =
      third !== undefined &&
      fourth !== undefined &&
      fourth.width === TD1_WIDTH &&
      isValidTd1(read(third), read(fourth));
    const hasName = third !== undefined && third.width === TD1_WIDTH && !startsAnotherCard;
    const last = hasName ? third : second;
    out.push({ start: first.start, end: last.end, format: 'TD1', lineCount: hasName ? 3 : 2 });
    return hasName ? 3 : 2;
  }

  // TD2 and TD3 upper lines hold the document code and the name; every check
  // digit lives on the lower line. The document code is what rejects a
  // shape-matching blob sitting immediately above a real lower line.
  if (!isDocumentCode(read(first)) || !isStateCode(read(first), 2)) return 0;

  if (first.width === TD3_WIDTH && isValidTd3Lower(read(second))) {
    out.push({ start: first.start, end: second.end, format: 'TD3', lineCount: 2 });
    return 2;
  }
  if (first.width === TD2_WIDTH && isValidTd2Lower(read(second))) {
    out.push({ start: first.start, end: second.end, format: 'TD2', lineCount: 2 });
    return 2;
  }
  return 0;
}

/**
 * True when `block` is, in its entirety, one valid MRZ.
 *
 * Accepts the same shapes {@link findMrzBlocks} does — a lone TD2 or TD3 lower
 * line, a two- or three-line TD1, a two-line TD2 or TD3 — with the same
 * tolerance for `\r\n`, indentation and a single blank line between rows. It is
 * the whole-string form of the check, for callers that already have a candidate
 * in hand; the detector uses {@link findMrzBlocks}.
 */
export function isValidMrzBlock(block: string): boolean {
  const lines: string[] = [];
  let blankRun = 0;

  for (const raw of block.split('\n')) {
    let from = 0;
    let to = raw.length;
    while (to > from && isTrimmable(raw.charCodeAt(to - 1))) to--;
    while (from < to && isTrimmable(raw.charCodeAt(from))) from++;

    if (to === from) {
      // Leading and trailing blank lines are framing, not content.
      if (lines.length > 0) blankRun++;
      continue;
    }
    if (blankRun > MAX_BLANK_LINES) return false;
    blankRun = 0;
    lines.push(raw.slice(from, to));
  }

  const [a, b, c] = lines;
  if (a === undefined) return false;

  if (lines.length === 1) {
    if (a.length === TD3_WIDTH) return isValidTd3Lower(a);
    if (a.length === TD2_WIDTH) return isValidTd2Lower(a);
    return false;
  }

  if (b === undefined || a.length !== b.length) return false;

  if (a.length === TD1_WIDTH) {
    if (lines.length > 3) return false;
    if (c !== undefined && c.length !== TD1_WIDTH) return false;
    return isValidTd1(a, b);
  }

  if (lines.length !== 2) return false;
  if (!isDocumentCode(a) || !isStateCode(a, 2)) return false;
  if (a.length === TD3_WIDTH) return isValidTd3Lower(b);
  if (a.length === TD2_WIDTH) return isValidTd2Lower(b);
  return false;
}

/**
 * The MRZ detector.
 *
 * Always-on. Unlike the nine-character document serials in `identitydoc.ts`,
 * this needs no German label to be safe: the check-digit chain is the gate.
 */
export const mrzDetector: Detector = {
  name: MRZ_DETECTOR,
  priority: DEFAULT_PRIORITIES.TRAVEL_DOCUMENT_MRZ,

  find(text: string): Span[] {
    return findMrzBlocks(text).map((block): Span => ({
      start: block.start,
      end: block.end,
      kind: MRZ_KIND,
      value: text.slice(block.start, block.end),
      detector: MRZ_DETECTOR,
      priority: DEFAULT_PRIORITIES.TRAVEL_DOCUMENT_MRZ,
    }));
  },
};
