/**
 * Turning attachment bytes into characters.
 *
 * Nothing downstream works on bytes: the detectors match on strings, so the
 * first decision hushgate makes about a text attachment is which encoding it
 * was written in — and there is no metadata to ask. Getting it wrong is not
 * cosmetic. `Müller` decoded as latin-1 when the bytes are UTF-8 reads as
 * `MÃ¼ller`, and a name the dictionary never sees is a name that leaves the
 * machine intact.
 *
 * The sniff is therefore ordered by how much evidence each answer needs. A byte
 * order mark is proof. Alternating NUL bytes are strong evidence, and worth the
 * scan because a Windows export of a `.txt` file is routinely UTF-16 with no
 * mark at all. Valid UTF-8 is self-checking, which is why it is asked with
 * `fatal: true` — a decoder that silently substitutes U+FFFD answers "yes" to
 * every question. Windows-1252 comes last precisely because it never refuses:
 * that makes it the only safe fallback and a terrible early guess.
 */
import type { AttachmentFormat, Extractor } from './types.js';

/** What {@link decodeText} concluded, so the caller can record the guess. */
export interface DecodedText {
  readonly text: string;
  /** The label handed to `TextDecoder`, e.g. `windows-1252`. */
  readonly encoding: string;
}

/** Byte order marks, longest first so UTF-8 is never read as UTF-16. */
const BYTE_ORDER_MARKS: readonly { readonly bytes: readonly number[]; readonly encoding: string }[] =
  [
    { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
    { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
    { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
  ];

/** Prefix examined by the BOM-less UTF-16 heuristic. Enough to be sure, cheap to scan. */
const UTF16_SAMPLE_BYTES = 4096;

/** Share of the sampled code units that must be NUL-padded before UTF-16 is believed. */
const UTF16_NUL_RATIO = 0.3;

const hasPrefix = (bytes: Uint8Array, prefix: readonly number[]): boolean => {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
};

const detectBom = (bytes: Uint8Array): { readonly length: number; readonly encoding: string } | null => {
  for (const mark of BYTE_ORDER_MARKS) {
    if (hasPrefix(bytes, mark.bytes)) return { length: mark.bytes.length, encoding: mark.encoding };
  }
  return null;
};

/**
 * Guess UTF-16 from the padding alone.
 *
 * Western text in UTF-16 is half NUL bytes, all of them on the same side of
 * each code unit: on the odd offsets for little-endian, the even ones for
 * big-endian. A NUL is not legal in any of the other encodings considered here,
 * so the side that carries none of them is the side carrying the characters.
 */
const sniffUtf16 = (bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null => {
  // An odd byte count cannot be a whole sequence of 16-bit code units.
  if (bytes.length < 4 || bytes.length % 2 !== 0) return null;

  const limit = Math.min(bytes.length, UTF16_SAMPLE_BYTES);
  let evenNuls = 0;
  let oddNuls = 0;

  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }

  const threshold = Math.floor(limit / 2) * UTF16_NUL_RATIO;
  if (oddNuls > threshold && evenNuls === 0) return 'utf-16le';
  if (evenNuls > threshold && oddNuls === 0) return 'utf-16be';
  return null;
};

/**
 * Decode, or say the decoder could not.
 *
 * Two different failures land here: a label this build of Node has no ICU data
 * for (the constructor throws) and bytes that `fatal` rejected (the decode
 * throws). Both mean the same thing to the caller — try the next candidate —
 * and neither is an error an operator can act on.
 */
const decodeWith = (label: string, bytes: Uint8Array, fatal: boolean): string | null => {
  try {
    return new TextDecoder(label, { fatal, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
};

/**
 * windows-1252, bytes 0x80 to 0x9F, as data rather than as a question for ICU.
 *
 * This used to be `new TextDecoder('windows-1252')`, which is right until it is
 * not there. A Node built with small-icu or `--without-intl` throws for that
 * label, and what happened then was not a clean failure: the decoder fell back
 * to latin-1, where 0x92 is the C1 control U+0092 rather than a right single
 * quote, and the control was stripped a few lines later. `Kün’s` arrived as
 * `Küns` — an apostrophe deleted from somebody's name, on one class of machine
 * and not another, with nothing in the log to say so.
 *
 * Thirty-two characters are not worth an environment dependency. The five bytes
 * windows-1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) keep their C1
 * code points, which is what the WHATWG Encoding Standard specifies and what
 * `TextDecoder` does; a test compares all 256 bytes against the platform
 * decoder wherever there is one, so this literal cannot drift from it.
 */
export const WINDOWS_1252_C1 =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021' +
  '\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014' +
  '\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

/**
 * Decode windows-1252 without the platform's help.
 *
 * Every byte maps to exactly one character, so this cannot fail and is the last
 * candidate in {@link decodeText} for that reason. Outside the C1 range
 * windows-1252 is latin-1, which is the identity on code points.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  const chars: string[] = Array.from({ length: bytes.length });
  for (const [index, byte] of bytes.entries()) {
    chars[index] =
      byte >= 0x80 && byte <= 0x9f
        ? WINDOWS_1252_C1[byte - 0x80]!
        : String.fromCodePoint(byte);
  }
  return chars.join('');
}

const stripTrailingNuls = (text: string): string => {
  let end = text.length;
  while (end > 0 && text.codePointAt(end - 1) === 0) end -= 1;
  return end === text.length ? text : text.slice(0, end);
};

const normaliseNewlines = (text: string): string =>
  text.includes('\r') ? text.replaceAll('\r\n', '\n').replaceAll('\r', '\n') : text;

/**
 * A fixed-width padded export ends in a run of NUL, and a Windows editor ends
 * every line with CRLF. Neither is content, and both would otherwise reach the
 * model as characters.
 */
const finish = (raw: string, encoding: string): DecodedText => ({
  text: stripTrailingNuls(normaliseNewlines(raw)),
  encoding,
});

/**
 * Cut `text` to `maxChars` without splitting a surrogate pair.
 *
 * `maxChars` is a budget in characters, but a cut that lands between the halves
 * of one astral character leaves a lone surrogate — a string that no longer
 * survives being serialised into a JSON request body. Shared by every extractor
 * so the rule is stated once.
 */
export function clampChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';

  const cut = text.length <= maxChars ? text : text.slice(0, maxChars);
  // `codePointAt` on the last unit of a complete pair reports the low half, so
  // this matches an unpaired high half and nothing else. It is checked even
  // when nothing was cut here, because an extractor that filled its budget
  // exactly has already made the cut itself.
  const last = cut.codePointAt(cut.length - 1) ?? 0;
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Decode attachment bytes, reporting which encoding the sniff settled on. */
export function decodeText(bytes: Uint8Array): DecodedText {
  const bom = detectBom(bytes);
  if (bom !== null) {
    const decoded = decodeWith(bom.encoding, bytes.subarray(bom.length), false);
    if (decoded !== null) return finish(decoded, bom.encoding);
  }

  const utf16 = sniffUtf16(bytes);
  if (utf16 !== null) {
    const decoded = decodeWith(utf16, bytes, false);
    if (decoded !== null) return finish(decoded, utf16);
  }

  const utf8 = decodeWith('utf-8', bytes, true);
  if (utf8 !== null) return finish(utf8, 'utf-8');

  // Last, and always: windows-1252 accepts every byte, so there is nothing left
  // to fall back to and no build of Node that can decline it.
  return finish(decodeWindows1252(bytes), 'windows-1252');
}

/** Formats whose bytes are already the text, once the encoding is settled. */
const TEXT_FORMATS: ReadonlySet<AttachmentFormat> = new Set(['text', 'csv', 'json', 'xml']);

/**
 * The plain-text extractor.
 *
 * An empty result is a refusal rather than an empty success: a file that
 * decoded to nothing was not read, and forwarding it as "extracted, no
 * content" would let a container hushgate does not understand through under the
 * wrong label.
 */
export const plaintextExtractor: Extractor = {
  name: 'builtin.text',

  supports: (format) => TEXT_FORMATS.has(format),

  extract: async (bytes, context) => {
    const decoded = decodeText(bytes);
    const text = clampChars(decoded.text, context.maxChars);
    if (text.trim() === '') return { ok: false, reason: 'the file decoded to no text' };
    return { ok: true, value: { text, pages: null, extractor: 'builtin.text' } };
  },
};
