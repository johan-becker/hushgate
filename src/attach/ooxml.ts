/**
 * Text out of the ZIP-based office formats.
 *
 * A .docx is not a document, it is a small filesystem. The sentence an operator
 * sees on one line is spread over a run of `<w:t>` elements because someone
 * bolded a word in the middle of it, and the half of it that matters may sit in
 * a footnote, a header or a comment — separate files inside the container. A
 * detector works on prose, so the work here is putting the pieces back in an
 * order and with the spacing that lets one read: `Anna Schmidt`, never
 * `AnnaSchmidt` and never `Anna` on its own.
 *
 * The XML is scanned, not parsed, and that is a security decision before it is
 * a performance one. A parser that understands a DOCTYPE is a parser that can
 * be talked into opening `/etc/passwd`; the only defence against XXE worth
 * having is code with no notion of an entity declaration to abuse. Only the
 * five predefined entities and numeric character references are decoded. Every
 * other reference stays the literal text it arrived as.
 */
import type { AttachmentFormat, ExtractionContext, ExtractionResult, Extractor } from './types.js';
import { readZip, ZipError, type ZipEntry } from './zip.js';

const EXTRACTOR_NAME = 'builtin.ooxml';

/** Decides whether one entry of a container is worth inflating. */
type PartMatcher = (name: string) => boolean;

/** ODF puts the whole body, notes and all, in a single part. */
const OPEN_DOCUMENT_PARTS: readonly PartMatcher[] = [(name) => name === 'content.xml'];

/**
 * The parts that carry text, per format, in reading order.
 *
 * Order is the point of the array: the entries come back in central directory
 * order, which is whatever the producing application felt like, and a document
 * whose footnotes precede its body reads as nonsense to a human reviewing the
 * audit trail. For xlsx the order is also load-bearing in a second way — the
 * shared string table holds nearly all cell text, while the sheets hold only
 * the inline strings, and a workbook written with `t="inlineStr"` has an empty
 * string table. Reading one and not the other loses every cell of one kind of
 * workbook without saying so.
 */
const PARTS: Partial<Record<AttachmentFormat, readonly PartMatcher[]>> = {
  docx: [
    (name) => name === 'word/document.xml',
    (name) => name === 'word/footnotes.xml' || name === 'word/endnotes.xml',
    (name) => name === 'word/comments.xml',
    (name) => /^word\/(?:header|footer)\d*\.xml$/u.test(name),
  ],
  xlsx: [
    (name) => name === 'xl/sharedStrings.xml',
    (name) => /^xl\/worksheets\/sheet\d*\.xml$/u.test(name),
  ],
  pptx: [
    (name) => /^ppt\/slides\/slide\d*\.xml$/u.test(name),
    (name) => /^ppt\/notesSlides\/notesSlide\d*\.xml$/u.test(name),
  ],
  odt: OPEN_DOCUMENT_PARTS,
  ods: OPEN_DOCUMENT_PARTS,
  odp: OPEN_DOCUMENT_PARTS,
};

/** Elements whose character data is document text rather than markup detail. */
const TEXT_ELEMENTS = new Set(['w:t', 'a:t', 't', 'text:p', 'text:span']);

/**
 * Elements whose end starts a new line.
 *
 * `si` is one shared string, which is to say one cell's worth of text, so two
 * of them must not run together. Note that `t` is deliberately absent: a run of
 * `<t>` inside one `<si>` is rich text, and `Anna` + ` Schmidt` is a single
 * value that was merely typed in two fonts.
 */
const LINE_AFTER = new Set(['w:p', 'text:p', 'a:p', 'row', 'si']);

/** Elements whose end separates one value from the next within a line. */
const TAB_AFTER = new Set(['c']);

/** Empty elements standing in for whitespace that no text node contains. */
const VOID_WHITESPACE: Readonly<Record<string, string>> = {
  'w:tab': '\t',
  'w:br': '\n',
  'w:cr': '\n',
  'text:tab': '\t',
  'text:line-break': '\n',
  'text:s': ' ',
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** `&#x10FFFF;` is the longest reference we decode; anything longer is text. */
const MAX_REFERENCE_LENGTH = 12;

const SEPARATOR_RANK: Readonly<Record<string, number>> = { ' ': 1, '\t': 2, '\n': 3 };

/** The characters XML 1.0 permits. Excludes the surrogate range and most controls. */
const isXmlCharacter = (code: number): boolean =>
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0d ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x1_0000 && code <= 0x10_ffff);

/** Decode one reference body, or `null` for anything that is not ours to decode. */
const decodeReference = (body: string): string | null => {
  if (body === '') return null;

  if (!body.startsWith('#')) {
    // Exactly the five predefined names. Anything else — including a name some
    // DOCTYPE went to the trouble of declaring — is left alone on purpose.
    return NAMED_ENTITIES[body] ?? null;
  }

  const hex = body.startsWith('#x') || body.startsWith('#X');
  const digits = body.slice(hex ? 2 : 1);
  // Bounded repetition: a character reference has a small fixed maximum, and an
  // unbounded quantifier here is a regex an attacker gets to choose the input to.
  const shape = hex ? /^[\da-f]{1,6}$/iu : /^\d{1,7}$/u;
  if (!shape.test(digits)) return null;

  const code = Number.parseInt(digits, hex ? 16 : 10);
  return isXmlCharacter(code) ? String.fromCodePoint(code) : null;
};

const decodeEntities = (raw: string): string => {
  if (!raw.includes('&')) return raw;

  let out = '';
  let at = 0;

  while (at < raw.length) {
    const amp = raw.indexOf('&', at);
    if (amp === -1) {
      out += raw.slice(at);
      break;
    }

    out += raw.slice(at, amp);
    const semicolon = raw.indexOf(';', amp + 1);
    const body =
      semicolon === -1 || semicolon - amp > MAX_REFERENCE_LENGTH
        ? null
        : decodeReference(raw.slice(amp + 1, semicolon));

    if (body === null) {
      out += '&';
      at = amp + 1;
    } else {
      out += body;
      at = semicolon + 1;
    }
  }

  return out;
};

/**
 * Collects text under a hard character budget.
 *
 * Separators are held back until text arrives to justify them. A spreadsheet is
 * mostly empty cells and a presentation is mostly empty placeholders, so
 * emitting a tab or a newline the moment an element closes would spend the
 * budget on whitespace and hand the detectors a page of blank lines.
 */
interface Sink {
  push(text: string): void;
  separate(separator: string): void;
  readonly full: boolean;
  text(): string;
}

const createSink = (maxChars: number): Sink => {
  const chunks: string[] = [];
  let used = 0;
  let pending = '';

  return {
    push(text: string): void {
      if (text === '' || used >= maxChars) return;

      if (pending !== '') {
        chunks.push(pending);
        used += pending.length;
        pending = '';
        if (used >= maxChars) return;
      }

      const room = maxChars - used;
      const piece = text.length > room ? text.slice(0, room) : text;
      chunks.push(piece);
      used += piece.length;
    },

    separate(separator: string): void {
      if (chunks.length === 0) return;
      if ((SEPARATOR_RANK[separator] ?? 0) > (SEPARATOR_RANK[pending] ?? 0)) pending = separator;
    },

    get full(): boolean {
      return used >= maxChars;
    },

    text(): string {
      return chunks.join('');
    },
  };
};

/**
 * The index of the `>` that ends the tag opened at `open`.
 *
 * Quoting is respected because `>` is legal inside an attribute value, and a
 * scanner that stops at the first one can be steered past a `<w:t>` it should
 * have seen. Text this scanner misses is text the detectors never inspect,
 * which is the failure mode that matters here.
 */
const findTagEnd = (xml: string, open: number): number => {
  let quote = 0;

  for (let at = open + 1; at < xml.length; at += 1) {
    const code = xml.charCodeAt(at);
    if (quote !== 0) {
      if (code === quote) quote = 0;
      continue;
    }
    if (code === 0x22 || code === 0x27) quote = code;
    else if (code === 0x3e) return at;
  }

  return -1;
};

const isNameEnd = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x2f;

const tagName = (xml: string, from: number, to: number): string => {
  let end = from;
  while (end < to && !isNameEnd(xml.charCodeAt(end))) end += 1;
  return xml.slice(from, end);
};

/**
 * Skip a `<!…>` declaration, internal subset and all.
 *
 * This is where a DOCTYPE's entity declarations live. They are stepped over
 * without being read: an entity hushgate never learns about is an entity
 * hushgate cannot be tricked into expanding.
 */
const skipDeclaration = (xml: string, open: number): number => {
  let depth = 0;

  for (let at = open + 2; at < xml.length; at += 1) {
    const code = xml.charCodeAt(at);
    if (code === 0x5b) depth += 1;
    else if (code === 0x5d) depth -= 1;
    else if (code === 0x3e && depth <= 0) return at + 1;
  }

  return xml.length;
};

const emitText = (raw: string, sink: Sink): void => {
  // Whitespace between elements is indentation as often as it is content, so it
  // becomes a separator rather than text and collapses with its neighbours.
  if (raw.trim() === '') sink.separate(' ');
  else sink.push(decodeEntities(raw));
};

/** Walk one XML part, pushing the text of the elements that hold any. */
const scanXml = (xml: string, sink: Sink): void => {
  let at = 0;
  let capturing = 0;

  while (at < xml.length && !sink.full) {
    const open = xml.indexOf('<', at);
    if (open === -1) {
      if (capturing > 0) emitText(xml.slice(at), sink);
      return;
    }

    if (capturing > 0 && open > at) emitText(xml.slice(at, open), sink);

    if (xml.startsWith('<!--', open)) {
      const close = xml.indexOf('-->', open + 4);
      if (close === -1) return;
      at = close + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', open)) {
      const close = xml.indexOf(']]>', open + 9);
      // CDATA is literal by definition, so no reference in it is decoded.
      if (capturing > 0) sink.push(xml.slice(open + 9, close === -1 ? xml.length : close));
      if (close === -1) return;
      at = close + 3;
      continue;
    }

    if (xml.startsWith('<!', open)) {
      at = skipDeclaration(xml, open);
      continue;
    }

    if (xml.startsWith('<?', open)) {
      const close = xml.indexOf('?>', open + 2);
      if (close === -1) return;
      at = close + 2;
      continue;
    }

    const close = findTagEnd(xml, open);
    if (close === -1) return;

    const closing = xml.charCodeAt(open + 1) === 0x2f;
    const name = tagName(xml, open + (closing ? 2 : 1), close);
    const selfClosing = xml.charCodeAt(close - 1) === 0x2f;
    at = close + 1;

    if (closing) {
      if (capturing > 0 && TEXT_ELEMENTS.has(name)) capturing -= 1;
      if (LINE_AFTER.has(name)) sink.separate('\n');
      else if (TAB_AFTER.has(name)) sink.separate('\t');
      continue;
    }

    const whitespace = VOID_WHITESPACE[name];
    if (whitespace !== undefined) sink.separate(whitespace);
    else if (!selfClosing && TEXT_ELEMENTS.has(name)) capturing += 1;
  }
};

/** The number in `sheet10.xml`, so that it sorts after `sheet9.xml`. */
const numberIn = (name: string): number => {
  const match = /(\d+)(?=\.xml$)/u.exec(name);
  return match === null ? 0 : Number(match[1]);
};

const orderParts = (entries: readonly ZipEntry[], parts: readonly PartMatcher[]): ZipEntry[] => {
  const rank = (name: string): number => {
    const index = parts.findIndex((part) => part(name));
    return index === -1 ? parts.length : index;
  };

  return [...entries].toSorted((left, right) => {
    const byRank = rank(left.name) - rank(right.name);
    if (byRank !== 0) return byRank;
    const byNumber = numberIn(left.name) - numberIn(right.name);
    if (byNumber !== 0) return byNumber;
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  });
};

/** A ZIP container starts `PK\x03\x04`; anything else is a mislabelled file. */
const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Extract the readable text of one OOXML or ODF document.
 *
 * `pages` is always null: pagination is decided by the renderer from fonts,
 * page size and printer metrics, so a page count taken from the XML would be a
 * guess, and a guess in the audit trail is worse than an honest absence.
 */
export function extractOoxml(
  bytes: Uint8Array,
  format: AttachmentFormat,
  maxChars: number,
): ExtractionResult {
  const parts = PARTS[format];
  if (parts === undefined) return { ok: false, reason: `the ooxml extractor does not read ${format} files` };
  if (maxChars <= 0) return { ok: false, reason: 'no character budget was left for this attachment' };
  if (!looksLikeZip(bytes)) return { ok: false, reason: 'file is not a zip container' };

  let entries: ZipEntry[];
  try {
    entries = readZip(bytes, (name) => parts.some((part) => part(name)));
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof ZipError ? error.message : 'zip container could not be read',
    };
  }

  if (entries.length === 0) {
    return { ok: false, reason: `the ${format} container holds none of the parts that carry text` };
  }

  const sink = createSink(maxChars);
  const decoder = new TextDecoder();

  for (const entry of orderParts(entries, parts)) {
    if (sink.full) break;
    sink.separate('\n');
    scanXml(decoder.decode(entry.bytes), sink);
  }

  const text = sink.text();
  if (text === '') return { ok: false, reason: `the ${format} document contains no extractable text` };

  return { ok: true, value: { text, pages: null, extractor: EXTRACTOR_NAME } };
}

export const ooxmlExtractor: Extractor = {
  name: EXTRACTOR_NAME,

  supports(format: AttachmentFormat, _mediaType: string | null): boolean {
    // The declared media type is ignored: callers mislabel .docx as
    // application/octet-stream constantly, and the container itself is checked
    // before anything is read out of it.
    return PARTS[format] !== undefined;
  },

  extract(bytes: Uint8Array, context: ExtractionContext): Promise<ExtractionResult> {
    return Promise.resolve(extractOoxml(bytes, context.format, context.maxChars));
  },
};
