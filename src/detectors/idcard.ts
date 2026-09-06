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
import type { Detector, Kind, LabelProximity, Span } from '../types.js';
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

const PASSPORT_LABELS: LabelProximity = { labels: ['Passnr', 'Pass-Nr', 'Reisepass'] };
const ID_CARD_LABELS: LabelProximity = { labels: ['Ausweis', 'Ausweisnr', 'Ausweis-Nr', 'Personalausweis'] };

/**
 * Priority for both kinds.
 *
 * `DEFAULT_PRIORITIES` has no entry for them yet, and this module does not own
 * `types.ts`. 78 places a document serial below the Steuer-ID, whose two
 * independent checks make it the safer read when both claim the same
 * characters, and above an email, which never will.
 */
export const ID_DOCUMENT_PRIORITY = 78;

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
function findSerials(text: string, withCheckDigit: boolean, name: string): Span[] {
  const out: Span[] = [];
  const want = withCheckDigit ? SERIAL_LENGTH + 1 : SERIAL_LENGTH;
  let i = 0;

  while (i < text.length) {
    if (!memberAt(text, i, isAlnum) || isWordChar(text, i - 1)) {
      i += 1;
      continue;
    }

    const run = collectRun(text, i, isAlnum, isScanSeparator, want);
    if (run.chars.length !== want) {
      i += 1;
      continue;
    }

    const end = run.offsets.at(-1)! + 1;
    if (memberAt(text, end, isAlnum)) {
      i += 1;
      continue;
    }

    const serial = readGermanDocumentSerial(run.chars.slice(0, SERIAL_LENGTH));
    if (serial === null) {
      i += 1;
      continue;
    }

    if (withCheckDigit) {
      const given = run.chars[SERIAL_LENGTH]!;
      // The check digit is a digit even where the serial tolerates a confusable
      // letter: nothing is printed after it, so there is no reading to recover.
      if (!isDigit(given) || icaoCheckDigit(serial) !== given.codePointAt(0)! - 48) {
        i += 1;
        continue;
      }
    }

    out.push({
      start: i,
      end,
      kind: classify(text, i, end, serial),
      value: text.slice(i, end),
      detector: name,
      priority: ID_DOCUMENT_PRIORITY,
    });
    i = end;
  }

  return out;
}

/**
 * Personalausweis and Reisepass numbers carrying their ICAO check digit.
 *
 * Ten characters that agree with their own check digit are a strong enough
 * claim to report unaccompanied: the digit costs a wrong candidate nine times
 * out of ten, and the alphabet costs it again for every letter it holds.
 */
export const germanIdDocumentDetector: Detector = {
  name: 'german-id-document',
  priority: ID_DOCUMENT_PRIORITY,

  find(text: string): Span[] {
    return findSerials(text, true, 'german-id-document');
  },
};

/**
 * The same serials written without their check digit.
 *
 * Nine characters prove nothing on their own — no checksum, and the shape is
 * one an internal part number can have — so this form is licensed by the word
 * next to it and nothing else. Enforcement is `detect()`'s, which is why the
 * two forms are two detectors: `requiresLabel` applies to everything a
 * detector returns, and the check-digit form must not be gated by it.
 */
export const labelledGermanIdDocumentDetector: Detector = {
  name: 'german-id-document-labelled',
  priority: ID_DOCUMENT_PRIORITY,
  requiresLabel: { labels: GERMAN_ID_DOCUMENT_LABELS },

  find(text: string): Span[] {
    return findSerials(text, false, 'german-id-document-labelled');
  },
};
