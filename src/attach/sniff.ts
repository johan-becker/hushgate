/**
 * Deciding what an attachment actually is.
 *
 * The media type and the filename are claims made by the caller, and a filter
 * that believes them can be steered: label a PDF `text/plain` and the text
 * extractor hands the model a page of mojibake with every name in it intact,
 * because no detector ever saw a readable word. So the bytes decide. The claims
 * are consulted only where bytes cannot answer — CSV, JSON, a mail and plain
 * prose share the same absent signature, and no amount of looking will separate
 * them.
 *
 * Nothing here decompresses anything. A sniff runs on every attachment,
 * including the ones built to be expensive, before any extractor has agreed to
 * spend memory on it; a ZIP's entry names sit uncompressed in its central
 * directory, and those alone separate a .docx from a .odp.
 */
import type { AttachmentFormat } from './types.js';
import { readZip } from './zip.js';

/**
 * How far in a `%PDF-` header may hide.
 *
 * The specification says offset zero, but producers prepend junk and every
 * real reader scans a kilobyte, so hushgate does too. The asymmetry justifies
 * it: a file wrongly called a PDF is refused, while a PDF wrongly called text
 * is forwarded with its contents unread.
 */
const PDF_HEADER_WINDOW = 1024;

/** Bytes the printable-text test is willing to decode before deciding. */
const TEXT_SAMPLE_BYTES = 64 * 1024;

/** Share of the sample that may be control characters and still read as prose. */
const MAX_CONTROL_RATIO = 0.01;

/** Entry names collected from a container. A document is not thousands of files. */
const MAX_ZIP_NAMES = 512;

/** An ODF `mimetype` entry is one line; anything longer is not one. */
const MAX_MIMETYPE_BYTES = 128;

/** Characters of markup examined for a root element. */
const MARKUP_PREFIX_CHARS = 512;

/** Characters searched for the root element of an XML document. */
const XML_ROOT_WINDOW = 4096;

const MAX_MEDIA_TYPE_CHARS = 128;
const MAX_EXTENSION_CHARS = 16;

/** `type/subtype` in RFC 9110 tokens. One repetition each side: nothing to backtrack. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$%&'*+.^_|~-]*\/[a-z0-9][a-z0-9!#$%&'*+.^_|~-]*$/u;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const RTF_HEADER = [0x7b, 0x5c, 0x72, 0x74, 0x66]; // {\rtf
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_END_OF_DIRECTORY = [0x50, 0x4b, 0x05, 0x06];
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08];
const MIMETYPE_NAME = 'mimetype';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Signatures that need nothing but a prefix match to be conclusive. */
const IMAGE_MAGIC: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // png
  [0xff, 0xd8, 0xff], // jpeg
  [0x47, 0x49, 0x46, 0x38], // gif87a and gif89a
  [0x49, 0x49, 0x2a, 0x00], // tiff, little endian
  [0x4d, 0x4d, 0x00, 0x2a], // tiff, big endian
];

/** Sizes the DIB header of a bitmap is allowed to declare. */
const DIB_HEADER_SIZES: ReadonlySet<number> = new Set([12, 40, 52, 56, 64, 108, 124]);

/**
 * Media types that say something the bytes could not.
 *
 * A `Map`, not an object literal: the key is caller-controlled, and a lookup of
 * `constructor` on an object literal answers with `Object.prototype`'s.
 */
const MEDIA_TYPE_FORMATS: ReadonlyMap<string, AttachmentFormat> = new Map([
  ['text/plain', 'text'],
  ['text/csv', 'csv'],
  ['application/csv', 'csv'],
  ['text/tab-separated-values', 'csv'],
  ['application/json', 'json'],
  ['text/json', 'json'],
  ['application/xml', 'xml'],
  ['text/xml', 'xml'],
  ['text/html', 'html'],
  ['application/xhtml+xml', 'html'],
  ['message/rfc822', 'eml'],
]);

/** Filename extensions, for the same reason and with the same caveat. */
const EXTENSION_FORMATS: ReadonlyMap<string, AttachmentFormat> = new Map([
  ['txt', 'text'],
  ['text', 'text'],
  ['log', 'text'],
  ['md', 'text'],
  ['markdown', 'text'],
  ['csv', 'csv'],
  ['tsv', 'csv'],
  ['json', 'json'],
  ['jsonl', 'json'],
  ['ndjson', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xhtml', 'html'],
  ['eml', 'eml'],
]);

/** The three OpenDocument bodies hushgate reads, by the mimetype they declare. */
const ODF_MIMETYPES: ReadonlyMap<string, AttachmentFormat> = new Map([
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
]);

/** The part that only one of the three OOXML formats can have. */
const OOXML_MAIN_PARTS: readonly (readonly [string, AttachmentFormat])[] = [
  ['word/document.xml', 'docx'],
  ['xl/workbook.xml', 'xlsx'],
  ['ppt/presentation.xml', 'pptx'],
];

/** The same answer from the directory alone, for producers that rename the part. */
const OOXML_PREFIXES: readonly (readonly [string, AttachmentFormat])[] = [
  ['word/', 'docx'],
  ['xl/', 'xlsx'],
  ['ppt/', 'pptx'],
];

const hasPrefix = (bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean => {
  if (offset < 0 || offset + prefix.length > bytes.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
};

const u16 = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

const u32 = (bytes: Uint8Array, offset: number): number =>
  ((u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0);

/** One byte per character, for reading the ASCII that structures a container. */
const ascii = (bytes: Uint8Array, offset: number, length: number): string => {
  const end = Math.min(bytes.length, offset + length);
  let out = '';
  for (let index = offset; index < end; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
};

const findPdfHeader = (bytes: Uint8Array): number | null => {
  const limit = Math.min(bytes.length, PDF_HEADER_WINDOW);
  for (let index = 0; index + PDF_HEADER.length <= limit; index += 1) {
    if (hasPrefix(bytes, index, PDF_HEADER)) return index;
  }
  return null;
};

const isBitmap = (bytes: Uint8Array): boolean => {
  // `BM` is two bytes of ASCII that an ordinary sentence may open with ("BMW
  // Karlsruhe, Rechnung …"), so the two-byte signature alone is not evidence.
  // The reserved field and a known DIB header size are.
  if (!hasPrefix(bytes, 0, [0x42, 0x4d]) || bytes.length < 18) return false;
  return u32(bytes, 6) === 0 && DIB_HEADER_SIZES.has(u32(bytes, 14));
};

const isImage = (bytes: Uint8Array): boolean => {
  if (IMAGE_MAGIC.some((magic) => hasPrefix(bytes, 0, magic))) return true;
  if (hasPrefix(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return true;
  }
  return isBitmap(bytes);
};

const isZip = (bytes: Uint8Array): boolean =>
  hasPrefix(bytes, 0, ZIP_LOCAL_HEADER) ||
  hasPrefix(bytes, 0, ZIP_END_OF_DIRECTORY) ||
  hasPrefix(bytes, 0, ZIP_SPANNED);

const odfFormat = (mimetype: string): AttachmentFormat | null => {
  const base = mimetype.endsWith('-template') ? mimetype.slice(0, -'-template'.length) : mimetype;
  return ODF_MIMETYPES.get(base) ?? null;
};

/**
 * The `mimetype` entry, read out of the first local header.
 *
 * OpenDocument requires this entry to come first and to be stored rather than
 * deflated for exactly this purpose: a reader identifies the document without
 * unpacking it. Any archive that does not open this way goes the long way
 * round below.
 */
const storedMimetype = (bytes: Uint8Array): string | null => {
  if (!hasPrefix(bytes, 0, ZIP_LOCAL_HEADER)) return null;
  if (u16(bytes, 8) !== 0) return null;

  const nameLength = u16(bytes, 26);
  if (nameLength !== MIMETYPE_NAME.length) return null;
  if (ascii(bytes, 30, nameLength) !== MIMETYPE_NAME) return null;

  const size = u32(bytes, 18);
  if (size === 0 || size > MAX_MIMETYPE_BYTES) return null;

  const start = 30 + nameLength + u16(bytes, 28);
  if (start + size > bytes.length) return null;
  return ascii(bytes, start, size).trim().toLowerCase();
};

/**
 * Every entry name in the archive, with nothing inflated.
 *
 * `readZip` runs its predicate over the whole central directory before it
 * decompresses anything, so a predicate that records each name and accepts none
 * of them turns the hardened reader into the name-only pass a sniff wants —
 * rather than a second ZIP parser living here. An archive malformed enough to
 * throw is not a document either, and `unknown` is the honest answer for it.
 */
const zipEntryNames = (bytes: Uint8Array): string[] => {
  const names: string[] = [];
  try {
    readZip(bytes, (name) => {
      if (names.length < MAX_ZIP_NAMES) names.push(name);
      return false;
    });
  } catch {
    return [];
  }
  return names;
};

/** The ODF fallback: a container that named the entry but did not store it. */
const inflatedMimetype = (bytes: Uint8Array): AttachmentFormat | null => {
  try {
    const [entry] = readZip(bytes, (name) => name === MIMETYPE_NAME, {
      maxEntryBytes: MAX_MIMETYPE_BYTES,
      maxTotalBytes: MAX_MIMETYPE_BYTES,
    });
    if (entry === undefined) return null;
    return odfFormat(ascii(entry.bytes, 0, MAX_MIMETYPE_BYTES).trim().toLowerCase());
  } catch {
    return null;
  }
};

const ooxmlFormat = (names: readonly string[]): AttachmentFormat | null => {
  for (const [part, format] of OOXML_MAIN_PARTS) {
    if (names.includes(part)) return format;
  }
  for (const name of names) {
    for (const [prefix, format] of OOXML_PREFIXES) {
      if (name.startsWith(prefix)) return format;
    }
  }
  return null;
};

/**
 * Which document, if any, a ZIP container holds.
 *
 * A bare archive answers `unknown` on purpose. Several files zipped together
 * are several documents; pseudonymising them as one would mean unpacking
 * arbitrary content on the strength of a `.zip` suffix, which is a different
 * feature with a different threat model.
 */
const classifyZip = (bytes: Uint8Array): AttachmentFormat => {
  const stored = storedMimetype(bytes);
  if (stored !== null) {
    const odf = odfFormat(stored);
    if (odf !== null) return odf;
  }

  const names = zipEntryNames(bytes);
  const ooxml = ooxmlFormat(names);
  if (ooxml !== null) return ooxml;

  if (names.includes(MIMETYPE_NAME)) {
    const odf = inflatedMimetype(bytes);
    if (odf !== null) return odf;
  }

  return 'unknown';
};

const isSpaceByte = (byte: number): boolean =>
  byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;

/** Where the markup starts, past a byte order mark and any leading blank lines. */
const markupStart = (bytes: Uint8Array): number => {
  let index = hasPrefix(bytes, 0, UTF8_BOM) ? UTF8_BOM.length : 0;
  const limit = Math.min(bytes.length, index + MARKUP_PREFIX_CHARS);
  while (index < limit && isSpaceByte(bytes[index] ?? 0)) index += 1;
  return index;
};

const sniffMarkup = (bytes: Uint8Array): AttachmentFormat | null => {
  const start = markupStart(bytes);
  const head = ascii(bytes, start, MARKUP_PREFIX_CHARS).toLowerCase();

  if (head.startsWith('<!doctype html')) return 'html';
  if (/^<html[\s>]/u.test(head)) return 'html';
  if (!head.startsWith('<?xml')) return null;

  // XHTML is XML, but the html extractor reads it and the xml one flattens it
  // into attribute soup, so the more specific answer is the useful one.
  const root = ascii(bytes, start, XML_ROOT_WINDOW).toLowerCase();
  return root.includes(XHTML_NAMESPACE) || /<html[\s>]/u.test(root) ? 'html' : 'xml';
};

const decodesAsUtf8 = (sample: Uint8Array): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return null;
  }
};

/**
 * The last question, asked of files that carry no signature at all.
 *
 * Valid UTF-8 is self-checking, which is why the decode is strict; printability
 * is what separates prose from a container that happens to decode. Both must
 * hold, because `unknown` — a refusal — is the safe answer here and `text` is
 * the one that sends bytes onward.
 */
const looksLikeText = (bytes: Uint8Array): boolean => {
  if (bytes.length === 0) return false;
  // A mark is proof, and plaintext.ts can decode what it announces.
  if (hasPrefix(bytes, 0, UTF16_LE_BOM) || hasPrefix(bytes, 0, UTF16_BE_BOM)) return true;

  let end = Math.min(bytes.length, TEXT_SAMPLE_BYTES);
  // Cutting the sample mid-sequence would fail the strict decode on a file that
  // is in fact valid UTF-8, so step back over continuation bytes at the edge.
  for (let steps = 0; steps < 3 && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80; steps += 1) {
    end -= 1;
  }

  const text = decodesAsUtf8(bytes.subarray(0, end));
  if (text === null) return false;

  let controls = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) return false; // a NUL belongs to a container, never to prose
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d)) {
      controls += 1;
    }
  }
  return controls <= text.length * MAX_CONTROL_RATIO;
};

const fromMediaType = (mediaType: string | null): AttachmentFormat | null => {
  if (mediaType === null) return null;

  const known = MEDIA_TYPE_FORMATS.get(mediaType);
  if (known !== undefined) return known;
  if (mediaType.endsWith('+json')) return 'json';
  if (mediaType.endsWith('+xml')) return 'xml';
  // Every other `text/*` is prose as far as a detector is concerned.
  return mediaType.startsWith('text/') ? 'text' : null;
};

const fromFilename = (filename: string | null): AttachmentFormat | null => {
  if (filename === null) return null;

  const dot = filename.lastIndexOf('.');
  if (dot === -1) return null;
  return EXTENSION_FORMATS.get(filename.slice(dot + 1, dot + 1 + MAX_EXTENSION_CHARS).toLowerCase()) ?? null;
};

/** Lowercase `type/subtype`, parameters dropped, or `null` when it is not one. */
export function normaliseMediaType(value: string | null): string | null {
  if (value === null) return null;

  const semicolon = value.indexOf(';');
  const bare = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  if (bare.length === 0 || bare.length > MAX_MEDIA_TYPE_CHARS) return null;

  return MEDIA_TYPE.test(bare) ? bare : null;
}

/**
 * What this attachment is, decided from its bytes first.
 *
 * `declaredMediaType` and `filename` are read only once the bytes have had
 * their say, and only for the formats no signature distinguishes.
 */
export function sniffFormat(
  bytes: Uint8Array,
  declaredMediaType: string | null,
  filename: string | null,
): AttachmentFormat {
  if (findPdfHeader(bytes) !== null) return 'pdf';
  // `unknown` from a container is an answer, not an absence of one: the file is
  // a ZIP, and no later guess about it could be better informed.
  if (isZip(bytes)) return classifyZip(bytes);
  if (hasPrefix(bytes, 0, RTF_HEADER)) return 'rtf';
  if (isImage(bytes)) return 'image';

  const markup = sniffMarkup(bytes);
  if (markup !== null) return markup;

  const declared = fromMediaType(normaliseMediaType(declaredMediaType));
  if (declared !== null) return declared;

  const named = fromFilename(filename);
  if (named !== null) return named;

  return looksLikeText(bytes) ? 'text' : 'unknown';
}
