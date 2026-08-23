/**
 * Text out of RTF.
 *
 * RTF interleaves the characters a reader sees with the control words that
 * describe them, and the two cannot be told apart by inspection. `\'e4` is the
 * letter ä; which letter depends on an `\ansicpg` that appeared in the header
 * hundreds of bytes earlier. `{\*\datastore ...}` is a block of hex that reads
 * like prose to anything scanning for words. Both failures are the same
 * failure: a mangled `M\'fcller` is a name no detector recognises, and a font
 * table spent against the character budget is content that never got extracted
 * before `maxChars` cut it off.
 *
 * So this is a real machine over the bytes — groups, control words, code page,
 * Unicode escapes and their fallback runs — and it is written to survive a file
 * that lies. Braces need not balance, `\bin` announces a length that must be
 * skipped rather than parsed (its payload contains braces, and a parser that
 * reads them loses track of every group after it), and no count taken from the
 * input is used to allocate anything.
 */
import { clampChars } from './plaintext.js';
import type { Extractor } from './types.js';

/**
 * Destinations that never hold document text.
 *
 * The list is deliberately closed. An unrecognised destination is far more
 * likely to hold prose than markup, and dropping content is the one failure
 * this product cannot audit its way out of.
 */
const DROPPED_DESTINATIONS: ReadonlySet<string> = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'themedata',
  'datastore', 'generator',
]);

/** Code pages RTF writers actually emit, mapped to labels `TextDecoder` knows. */
const CODE_PAGES: ReadonlyMap<number, string> = new Map([
  [874, 'windows-874'], [1250, 'windows-1250'], [1251, 'windows-1251'],
  [1252, 'windows-1252'], [1253, 'windows-1253'], [1254, 'windows-1254'],
  [1255, 'windows-1255'], [1256, 'windows-1256'], [1257, 'windows-1257'],
  [1258, 'windows-1258'], [10000, 'macintosh'],
]);

const DEFAULT_CODE_PAGE = 'windows-1252';

/** The specification's own limit on a control word; a longer run is malformed. */
const MAX_CONTROL_WORD = 32;

/** Ten digits overflow every parameter RTF defines. */
const MAX_PARAMETER_DIGITS = 10;

/** Nesting past this is not a document. Depth is still counted; only the stack stops growing. */
const MAX_GROUP_DEPTH = 256;

/** A `\ucN` larger than this would swallow the rest of the paragraph. */
const MAX_UNICODE_SKIP = 16;

/** At most one blank line survives a run of paragraph breaks. */
const MAX_CONSECUTIVE_NEWLINES = 2;

const buildTable = (label: string): readonly string[] | null => {
  const bytes = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) bytes[index] = index;
  try {
    const chars = [...new TextDecoder(label).decode(bytes)];
    return chars.length === 256 ? chars : null;
  } catch {
    return null;
  }
};

const buildLatin1Table = (): readonly string[] => {
  const chars: string[] = Array.from({ length: 256 });
  for (let index = 0; index < 256; index += 1) chars[index] = String.fromCodePoint(index);
  return chars;
};

const tableCache = new Map<string, readonly string[]>();

/**
 * A byte-to-character table for one code page.
 *
 * Built once per code page and cached: `\'hh` appears thousands of times in a
 * real document, and standing up a `TextDecoder` for each of them would make
 * the decode cost more than the parse.
 */
const codePageTable = (label: string): readonly string[] => {
  const cached = tableCache.get(label);
  if (cached !== undefined) return cached;

  const table = buildTable(label) ?? buildTable(DEFAULT_CODE_PAGE) ?? buildLatin1Table();
  tableCache.set(label, table);
  return table;
};

const isAsciiLetter = (byte: number): boolean =>
  (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

const isAsciiDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;

const hexValue = (byte: number | undefined): number | null => {
  if (byte === undefined) return null;
  if (isAsciiDigit(byte)) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  return null;
};

const asciiSlice = (bytes: Uint8Array, start: number, end: number): string => {
  let out = '';
  for (let index = start; index < end; index += 1) out += String.fromCodePoint(bytes[index] ?? 0);
  return out;
};

/** Flatten RTF to text, stopping as soon as `maxChars` is reached. */
export function rtfToText(bytes: Uint8Array, maxChars: number): string {
  if (maxChars <= 0) return '';

  const parts: string[] = [];
  let written = 0;
  let full = false;
  let pendingNewlines = 0;
  let pendingTab = false;

  const append = (piece: string): void => {
    if (full || piece.length === 0) return;
    const room = maxChars - written;
    if (piece.length >= room) {
      parts.push(piece.slice(0, room));
      written = maxChars;
      full = true;
      return;
    }
    parts.push(piece);
    written += piece.length;
  };

  /** Breaks are held back so the header's own groups cannot open the text with blank lines. */
  const emit = (piece: string): void => {
    if (full || piece.length === 0) return;
    if (parts.length > 0) {
      if (pendingNewlines > 0) append('\n'.repeat(Math.min(pendingNewlines, MAX_CONSECUTIVE_NEWLINES)));
      else if (pendingTab) append('\t');
    }
    pendingNewlines = 0;
    pendingTab = false;
    append(piece);
  };

  let index = 0;
  let depth = 0;
  /** Depth of the innermost destination being discarded, or `null` when emitting. */
  let ignoreFrom: number | null = null;
  let unicodeSkip = 1;
  const unicodeSkipStack: number[] = [];
  /** Fallback characters still owed to a `\u`, which must not reach the output. */
  let pending = 0;
  let table = codePageTable(DEFAULT_CODE_PAGE);

  while (index < bytes.length) {
    if (full) break;
    const byte = bytes[index] ?? 0;

    if (byte === 0x7b) {
      depth += 1;
      if (depth <= MAX_GROUP_DEPTH) unicodeSkipStack.push(unicodeSkip);
      pending = 0;
      index += 1;
      continue;
    }

    if (byte === 0x7d) {
      // A closing brace with nothing open is a corrupt file, not an instruction
      // to unwind past the document.
      if (depth > 0) {
        if (depth <= MAX_GROUP_DEPTH) unicodeSkip = unicodeSkipStack.pop() ?? unicodeSkip;
        depth -= 1;
        if (ignoreFrom !== null && depth < ignoreFrom) ignoreFrom = null;
      }
      pending = 0;
      index += 1;
      continue;
    }

    if (byte !== 0x5c) {
      // Control bytes are layout in the file, never content: RTF writes its own
      // line breaks as \par and its own tabs as \tab.
      if (byte < 0x20) {
        index += 1;
        continue;
      }
      if (pending > 0) {
        pending -= 1;
        index += 1;
        continue;
      }

      let end = index;
      while (end < bytes.length) {
        const next = bytes[end] ?? 0;
        if (next === 0x5c || next === 0x7b || next === 0x7d || next < 0x20) break;
        end += 1;
      }
      if (ignoreFrom === null) {
        let run = '';
        for (let cursor = index; cursor < end; cursor += 1) run += table[bytes[cursor] ?? 0] ?? '';
        emit(run);
      }
      index = end;
      continue;
    }

    const escaped = bytes[index + 1];
    if (escaped === undefined) break;

    if (escaped === 0x5c || escaped === 0x7b || escaped === 0x7d) {
      if (ignoreFrom === null && pending === 0) emit(String.fromCodePoint(escaped));
      if (pending > 0) pending -= 1;
      index += 2;
      continue;
    }

    if (escaped === 0x2a) {
      if (ignoreFrom === null) ignoreFrom = depth;
      index += 2;
      continue;
    }

    if (escaped === 0x27) {
      const high = hexValue(bytes[index + 2]);
      const low = hexValue(bytes[index + 3]);
      if (high === null || low === null) {
        index += 2;
        continue;
      }
      index += 4;
      if (pending > 0) {
        pending -= 1;
        continue;
      }
      if (ignoreFrom === null) emit(table[high * 16 + low] ?? '');
      continue;
    }

    if (!isAsciiLetter(escaped)) {
      // Control symbols: a non-breaking space and a non-breaking hyphen are
      // characters, an optional hyphen is a hint the reader never sees.
      if (ignoreFrom === null && pending === 0) {
        if (escaped === 0x7e) emit(' ');
        else if (escaped === 0x5f) emit('-');
      }
      if (pending > 0) pending -= 1;
      index += 2;
      continue;
    }

    let cursor = index + 1;
    const wordStart = cursor;
    while (
      cursor < bytes.length &&
      isAsciiLetter(bytes[cursor] ?? 0) &&
      cursor - wordStart < MAX_CONTROL_WORD
    ) {
      cursor += 1;
    }
    const word = asciiSlice(bytes, wordStart, cursor);

    const negative = bytes[cursor] === 0x2d;
    if (negative) cursor += 1;
    const digitsStart = cursor;
    while (
      cursor < bytes.length &&
      isAsciiDigit(bytes[cursor] ?? 0) &&
      cursor - digitsStart < MAX_PARAMETER_DIGITS
    ) {
      cursor += 1;
    }
    const digits = asciiSlice(bytes, digitsStart, cursor);
    const parameter = digits === '' ? null : Number(digits) * (negative ? -1 : 1);

    // Exactly one space belongs to the control word; a second one is text.
    if (bytes[cursor] === 0x20) cursor += 1;
    index = cursor;

    if (word === 'bin') {
      // Skipped even inside a dropped destination: the payload is arbitrary
      // bytes, and parsing it would desynchronise every group that follows.
      const count = parameter === null || parameter <= 0 ? 0 : parameter;
      index += Math.min(count, bytes.length - index);
      pending = 0;
      continue;
    }

    if (DROPPED_DESTINATIONS.has(word)) {
      if (ignoreFrom === null) ignoreFrom = depth;
      pending = 0;
      continue;
    }

    if (ignoreFrom !== null) {
      pending = 0;
      continue;
    }

    // Any other control word ends a `\u` fallback run: the writer has moved on.
    const owed = word === 'u' ? pending : 0;
    pending = 0;

    switch (word) {
      case 'par':
      case 'line':
      case 'sect':
      case 'row': {
        pendingNewlines = Math.min(pendingNewlines + 1, MAX_CONSECUTIVE_NEWLINES);
        break;
      }
      case 'tab':
      case 'cell': {
        pendingTab = true;
        break;
      }
      case 'uc': {
        if (parameter !== null && parameter >= 0) unicodeSkip = Math.min(parameter, MAX_UNICODE_SKIP);
        break;
      }
      case 'ansicpg': {
        if (parameter !== null) table = codePageTable(CODE_PAGES.get(parameter) ?? DEFAULT_CODE_PAGE);
        break;
      }
      case 'u': {
        if (parameter === null) break;
        // The parameter is a signed 16-bit integer, so anything above U+7FFF
        // arrives negative.
        const code = parameter < 0 ? parameter + 0x10000 : parameter;
        const astral = code >= 0xd800 && code <= 0xdfff;
        if (owed === 0 && code > 0 && code <= 0x10ffff && !astral) emit(String.fromCodePoint(code));
        pending = unicodeSkip;
        break;
      }
      default: {
        break;
      }
    }
  }

  return clampChars(parts.join('').trim(), maxChars);
}

const hasRtfSignature = (bytes: Uint8Array): boolean => {
  let index = 0;
  while (index < bytes.length && index < 8 && (bytes[index] ?? 0) <= 0x20) index += 1;
  return (
    bytes[index] === 0x7b &&
    bytes[index + 1] === 0x5c &&
    asciiSlice(bytes, index + 2, index + 5).toLowerCase() === 'rtf'
  );
};

/**
 * The RTF extractor.
 *
 * The signature is checked before the parse, not to save work but to say the
 * right thing: a `.rtf` that is really a Word binary should be reported as the
 * wrong format, not as a document that happened to contain no words.
 */
export const rtfExtractor: Extractor = {
  name: 'builtin.rtf',

  supports: (format) => format === 'rtf',

  extract: async (bytes, context) => {
    if (!hasRtfSignature(bytes)) return { ok: false, reason: 'the file does not begin with an rtf signature' };

    const text = rtfToText(bytes, context.maxChars);
    if (text.trim() === '') return { ok: false, reason: 'the document contains no readable text' };
    return { ok: true, value: { text, pages: null, extractor: 'builtin.rtf' } };
  },
};
