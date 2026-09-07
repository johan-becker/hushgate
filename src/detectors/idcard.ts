/**
 * Personalausweis and Reisepass.
 *
 * One module for both because they are one format: nine characters from the
 * same restricted alphabet, an optional ICAO 9303 check digit, and nothing in
 * the serial itself that says which document it came off. What separates them
 * is the word a human wrote next to it, and failing that the series letter —
 * so the split lives at the end, in {@link germanDocumentKind}, rather than in
 * two detectors that would each re-implement the whole scan.
 */
import { DEFAULT_PRIORITIES, type Detector, type Kind, type LabelProximity, type Span } from '../types.js';
import { isScanSeparator, labelNear } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/** Serial length without the check digit. */
const SERIAL_LENGTH = 9;

/**
 * The letters a German document serial is issued from.
 *
 * This is the Bundesdruckerei's alphabet, and it is chosen so that a machine
 * reader can never confuse two of its members: A, B, D, E, I, O, Q, S and U are
 * all absent. Two things fall out of that, and both are load-bearing here.
 *
 * It contains no vowel, so no German word of the right length can be read as a
 * serial — which is what makes the bare nine-character shape safe enough to
 * report at all once a label licenses it.
 *
 * And a letter outside it has exactly one honest reading: `LO1XOOT47` is not a
 * serial with an O in it, because no such serial exists — it is `L01X00T47`
 * typed by someone whose eye or OCR could not tell the two apart. See
 * {@link CONFUSABLE_LETTERS}.
 */
export const GERMAN_DOCUMENT_LETTERS = 'CFGHJKLMNPRTVWXYZ';

/**
 * Letters the issuing alphabet excludes, mapped to the digit they were meant
 * to be.
 *
 * Only the two whose exclusion is purely a shape argument are folded. B for 8
 * or S for 5 would be leetspeak, and phase 1 already declines to apply that
 * outside mostly-letter tokens; guessing it here would trade a real gain in
 * recall for a class of false positive nobody can explain to a customer.
 */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = { O: '0', I: '1' };

const letters = new Set(GERMAN_DOCUMENT_LETTERS);

/**
 * ICAO 9303 check digit: weights 7, 3, 1 repeating, modulo 10.
 *
 * Character values are the digit itself, the alphabet position plus nine for a
 * letter, and zero for the `<` filler the machine-readable zone pads with.
 *
 * Returns -1 rather than throwing when a character has no ICAO value, because
 * every caller here is asking a question about untrusted text and would only
 * have to catch it again.
 */
export function icaoCheckDigit(value: string): number {
  const weights = [7, 3, 1];
  let sum = 0;

  for (let i = 0; i < value.length; i++) {
    const digit = charValue(value[i]!);
    if (digit < 0) return -1;
    sum += digit * weights[i % 3]!;
  }

  return sum % 10;
}

function charValue(ch: string): number {
  if (ch === '<') return 0;
  if (ch >= '0' && ch <= '9') return ch.codePointAt(0)! - 48;
  if (ch >= 'A' && ch <= 'Z') return ch.codePointAt(0)! - 55;
  return -1;
}

/**
 * Read nine raw characters as a serial, or reject them.
 *
 * Case is folded and the confusable letters are resolved; the result is the
 * canonical spelling the check digit is computed over. The span keeps the
 * characters as written — this reading is only ever used to decide.
 *
 * The leading character must be an issuing letter. That is the rule that keeps
 * `Ausweisnr. 123456789` out: nine digits behind that label are an order
 * number far more often than they are a document, and a detector that reports
 * both is a detector the customer switches off.
 */
export function readGermanDocumentSerial(raw: string): string | null {
  if (raw.length !== SERIAL_LENGTH) return null;

  let serial = '';
  for (const ch of raw.toUpperCase()) {
    const resolved = CONFUSABLE_LETTERS[ch] ?? ch;
    if (!isDigit(resolved) && !letters.has(resolved)) return null;
    serial += resolved;
  }

  return letters.has(serial[0]!) ? serial : null;
}

/**
 * Which document a serial came off, when no label says.
 *
 * `C` is the series the Bundesdruckerei issues German passports from; every
 * other issuing letter belongs to a card. It is a guess, and it is the only
 * one available from nine characters alone — a label, when there is one,
 * overrides it in {@link classify}. Guessing wrong costs a mislabelled
 * placeholder, never a leak, because both kinds are redacted either way.
 */
export function germanDocumentKind(serial: string): Kind {
  return serial.startsWith('C') ? 'PASSPORT_NUMBER' : 'ID_CARD_NUMBER';
}

/**
 * The labels that license a serial with no check digit to prove it.
 *
 * Declared once at module level, never rebuilt inside `find`: the fold that
 * turns these into comparison keys is cached against this array's identity.
 */
export const GERMAN_ID_DOCUMENT_LABELS: readonly string[] = [
  'Ausweis',
  'Ausweisnr',
  'Personalausweis',
  'Passnr',
  'Reisepass',
  'Pass-Nr',
  'Ausweis-Nr',
];

/**
 * The gate a serial without a check digit is reported through.
 *
 * Built once from {@link GERMAN_ID_DOCUMENT_LABELS} rather than inside `find`,
 * for the reason stated there: the fold that turns labels into comparison keys
 * is cached against the array's identity, and a fresh object per span would
 * miss the cache on every one of them.
 */
const LABEL_PROXIMITY: LabelProximity = { labels: GERMAN_ID_DOCUMENT_LABELS };

const PASSPORT_LABELS: LabelProximity = { labels: ['Passnr', 'Pass-Nr', 'Reisepass'] };
const ID_CARD_LABELS: LabelProximity = { labels: ['Ausweis', 'Ausweisnr', 'Ausweis-Nr', 'Personalausweis'] };

/**
 * Priority for both kinds.
 *
 * `DEFAULT_PRIORITIES` gives `ID_CARD_NUMBER` and `PASSPORT_NUMBER` the same 78
 * deliberately: one detector decides which of the two a serial is, so two spans
 * of those kinds can never overlap and there is no tie between them to break.
 * 78 places a document serial below the Steuer-ID (80) and the
 * Sozialversicherungsnummer (79), whose independent checks make them the safer
 * read when two of them claim the same characters, and above an email, which
 * never will.
 */
export const ID_DOCUMENT_PRIORITY = DEFAULT_PRIORITIES.ID_CARD_NUMBER;

const isAlnum = (ch: string): boolean =>
  isDigit(ch) || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

/**
 * The label decides the kind; the series letter only gets asked when no label
 * is in reach. A form that says `Reisepass` next to a serial beginning `L` is
 * a human telling us something the alphabet cannot.
 */
function classify(text: string, start: number, end: number, serial: string): Kind {
  if (labelNear(text, start, end, PASSPORT_LABELS)) return 'PASSPORT_NUMBER';
  if (labelNear(text, start, end, ID_CARD_LABELS)) return 'ID_CARD_NUMBER';
  return germanDocumentKind(serial);
}

/**
 * Walk the text for runs of exactly `want` alphanumerics, separators folded.
 *
 * Exactly `want` characters are collected and the character sitting directly
 * against the run then has to not be one: `L01X00T471X` must not be read as
 * the first ten of eleven. Collecting one extra instead would be simpler and
 * wrong, because a separator counts as part of the run — `L01X00T471 wurde`
 * would pull the `w` in and fail on length.
 *
 * Separators come from `isScanSeparator`, so the raw pass already sees
 * `L 01 X 00 T 47` and `L.01.X.00.T.47` as one run — this detector does not
 * wait for the identifier scan copy, which only folds runs that are mostly
 * digits and would drop the grouped spellings a card actually prints.
 */
function findSerials(text: string, name: string): Span[] {
  const out: Span[] = [];
  let i = 0;

  while (i < text.length) {
    if (!memberAt(text, i, isAlnum) || isWordChar(text, i - 1)) {
      i += 1;
      continue;
    }

    const run = collectRun(text, i, isAlnum, isScanSeparator, SERIAL_LENGTH);
    if (run.chars.length !== SERIAL_LENGTH) {
      i += 1;
      continue;
    }

    const serial = readGermanDocumentSerial(run.chars);
    if (serial === null) {
      i += 1;
      continue;
    }

    let furthest = -1;

    // The serial on its own. Nine characters prove nothing — no checksum, and
    // the shape is one an internal part number can have — so the label carries
    // it, declared on the span and enforced by `detect()`.
    if (!memberAt(text, run.end, isAlnum)) {
      out.push({
        ...spanAt(text, i, run.end, serial, name),
        requiresLabel: LABEL_PROXIMITY,
      });
      furthest = run.end;
    }

    // The same serial followed by its ICAO check digit, which is licence enough
    // to report unaccompanied: the digit costs a wrong candidate nine times out
    // of ten, and the alphabet costs it again for every letter it holds.
    //
    // Read forward from the nine rather than collected as ten in a second walk.
    // Ten was what the separate detector this replaces asked for, and asking
    // for it here would break the nine-character reading: `Ausweis-Nr.
    // L01X00T47 folgt` collects a tenth character from the word behind the
    // space, because a separator is part of a run — the serial would then fail
    // on its check digit and the label would have licensed nothing.
    const gap = run.end;
    const at = memberAt(text, gap, isAlnum)
      ? gap
      : isScanSeparator(text[gap] ?? '') && memberAt(text, gap + 1, isAlnum)
        ? gap + 1
        : -1;

    if (at >= 0 && !memberAt(text, at + 1, isAlnum)) {
      const given = text[at]!;
      // The check digit is a digit even where the serial tolerates a confusable
      // letter: nothing is printed after it, so there is no reading to recover.
      if (isDigit(given) && icaoCheckDigit(serial) === given.codePointAt(0)! - 48) {
        out.push(spanAt(text, i, at + 1, serial, name));
        furthest = at + 1;
      }
    }

    i = furthest > i ? furthest : i + 1;
  }

  return out;
}

const spanAt = (
  text: string,
  start: number,
  end: number,
  serial: string,
  detector: string,
): Span => ({
  start,
  end,
  kind: classify(text, start, end, serial),
  value: text.slice(start, end),
  detector,
  priority: ID_DOCUMENT_PRIORITY,
});

/**
 * Personalausweis and Reisepass numbers, with or without their check digit.
 *
 * Ten characters that agree with their own check digit are a strong enough
 * claim to report unaccompanied: the digit costs a wrong candidate nine times
 * out of ten, and the alphabet costs it again for every letter it holds. The
 * same serial printed without the digit is licensed by the word next to it
 * instead, which the span says for itself through {@link Span.requiresLabel}.
 *
 * One detector rather than the two this used to be. The two existed because
 * `Detector.requiresLabel` applies to everything a detector returns and the
 * check-digit form must not be gated by it. What the split cost was a second
 * walk of the whole body over the same runs with the same predicates, to
 * collect ten characters where the first walk had collected eleven — measured
 * at 229 ms per 512 KiB of dense alphanumerics.
 */
export const germanIdDocumentDetector: Detector = {
  name: 'german-id-document',
  priority: ID_DOCUMENT_PRIORITY,

  find(text: string): Span[] {
    return findSerials(text, 'german-id-document');
  },
};
