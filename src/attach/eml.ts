/**
 * Text out of an RFC 822 message.
 *
 * A mail is the densest personal data hushgate ever sees, and almost none of it
 * is readable where it lies. The envelope names two people and their employers.
 * A German subject arrives as `=?UTF-8?B?S8O8bmRpZ3VuZyBTY2htaWR0?=`, the body
 * as quoted-printable inside a multipart tree, and every one of those wrappers
 * is a place a detector's regex stops matching. Handing that to the detectors
 * untouched would pseudonymise the punctuation and forward the names.
 *
 * So this module undoes transport encodings and nothing else. It decodes, it
 * does not render; it walks the part tree, it does not follow it anywhere; and
 * it names attached files without opening them, because an attachment is an
 * attachment in its own right and the layer above decides what happens to it.
 */
import { formatBytes } from './decode.js';
import { htmlToText } from './html.js';
import { clampChars, decodeText } from './plaintext.js';
import type { ExtractionResult, Extractor } from './types.js';

/**
 * Beyond this a "mail" is a file transfer with a covering note.
 *
 * Refused rather than truncated: a message read halfway is a message whose
 * second half was never shown to a detector, and the product's whole claim is
 * that it does not guess about that.
 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/** Header fields parsed before the rest are ignored. */
const MAX_HEADERS = 512;

/** Characters of a single header field kept. Longer is a probe, not a subject. */
const MAX_HEADER_CHARS = 8 * 1024;

/** Characters of the header block parsed, for a message with no blank line. */
const MAX_HEADER_BLOCK_CHARS = 256 * 1024;

/** Nesting a mail may reach. Eight is generous; forwarded threads reach three. */
const MAX_DEPTH = 8;

/** Parts visited across the whole message, at any depth. */
const MAX_PARTS = 64;

/** Encoded words decoded per header field. */
const MAX_ENCODED_WORDS = 128;

/** Parameters read from one `Content-Type` or `Content-Disposition`. */
const MAX_PARAMETERS = 16;

/** Longest charset label handed to `TextDecoder`. */
const MAX_CHARSET_CHARS = 64;

/**
 * The five fields worth a line of their own.
 *
 * They are where the people are: who wrote, who received, and the subject,
 * which in practice carries the surname and the case number that the body then
 * refers to only as "your request".
 */
const REPORTED_HEADERS: readonly (readonly [string, string])[] = [
  ['from', 'From'],
  ['to', 'To'],
  ['cc', 'Cc'],
  ['subject', 'Subject'],
  ['date', 'Date'],
];

/** `=?charset?B?text?=`. Each field is delimited by `?`, so nothing backtracks. */
const ENCODED_WORD = /=\?([^?]{1,64})\?([BbQq])\?([^?]{0,2048})\?=/gu;

const HEX_PAIR = /^[\dA-Fa-f]{2}$/u;

interface Header {
  readonly name: string;
  readonly value: string;
}

/** A message, or one part of one: its fields and the text after the blank line. */
interface Part {
  readonly headers: readonly Header[];
  /** Still transport-encoded, one character per byte. */
  readonly body: string;
}

interface ContentType {
  readonly type: string;
  readonly parameters: ReadonlyMap<string, string>;
}

/** Parts already visited, shared by every branch of the walk. */
interface Budget {
  parts: number;
}

/**
 * A bounded accumulator.
 *
 * The cap belongs here rather than at the end because the point of stopping
 * early is not to trim the answer, it is to not decode the rest of a mail whose
 * text will be thrown away.
 */
interface Sink {
  push(text: string): void;
  full(): boolean;
  remaining(): number;
  text(): string;
}

const createSink = (limit: number): Sink => {
  const pieces: string[] = [];
  let used = 0;

  return {
    push: (text) => {
      if (text === '' || used >= limit) return;
      const piece = clampChars(text, limit - used);
      pieces.push(piece);
      used += piece.length;
    },
    full: () => used >= limit,
    remaining: () => Math.max(0, limit - used),
    text: () => pieces.join(''),
  };
};

/** Bytes as characters, so a transport decoder sees exactly what was sent. */
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const bytesOf = (text: string): Uint8Array => Buffer.from(text, 'latin1');

const headerValue = (headers: readonly Header[], name: string): string | undefined =>
  headers.find((header) => header.name === name)?.value;

/**
 * Split a field list into fields, undoing RFC 822 folding.
 *
 * A line beginning with space or tab continues the one before it; a subject
 * long enough to wrap is the normal case, not an edge one.
 */
const parseHeaders = (block: string): Header[] => {
  const headers: Header[] = [];

  for (const line of block.split('\n')) {
    if (headers.length >= MAX_HEADERS) break;

    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text === '') continue;

    if (text.startsWith(' ') || text.startsWith('\t')) {
      const previous = headers.pop();
      if (previous === undefined) continue;
      const joined = `${previous.value} ${text.trim()}`;
      headers.push({ name: previous.name, value: clampChars(joined, MAX_HEADER_CHARS) });
      continue;
    }

    const colon = text.indexOf(':');
    // A line that is not a field is not a guess to make: skip it and keep the
    // fields around it rather than treating the whole block as body.
    if (colon === -1) continue;
    headers.push({
      name: text.slice(0, colon).trim().toLowerCase(),
      value: clampChars(text.slice(colon + 1).trim(), MAX_HEADER_CHARS),
    });
  }

  return headers;
};

/** Fields and body, split at the first blank line, whichever line ending is used. */
const splitMessage = (raw: string): Part => {
  const crlf = raw.indexOf('\r\n\r\n');
  const lf = raw.indexOf('\n\n');

  const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
  if (end === -1) return { headers: parseHeaders(raw.slice(0, MAX_HEADER_BLOCK_CHARS)), body: '' };

  const bodyStart = end === crlf ? end + 4 : end + 2;
  return {
    headers: parseHeaders(raw.slice(0, Math.min(end, MAX_HEADER_BLOCK_CHARS))),
    body: raw.slice(bodyStart),
  };
};

const decodeCharset = (bytes: Uint8Array, charset: string | null): string => {
  if (charset === null || charset === '' || charset.length > MAX_CHARSET_CHARS) {
    return decodeText(bytes).text;
  }

  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // An invented or misspelled label — `utf8x`, `cp-1252`, `unicode`. The byte
    // sniff in plaintext.ts answers better than refusing the part would.
    return decodeText(bytes).text;
  }
};

const decodeQuotedPrintable = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  let length = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '=') {
      out[length] = text.charCodeAt(index) & 0xff;
      length += 1;
      continue;
    }

    const next = text.slice(index + 1, index + 3);
    if (next.startsWith('\r\n')) {
      index += 2; // a soft line break carries nothing
      continue;
    }
    if (next.startsWith('\n')) {
      index += 1;
      continue;
    }
    if (HEX_PAIR.test(next)) {
      out[length] = Number.parseInt(next, 16);
      length += 1;
      index += 2;
      continue;
    }

    // A bare `=` is not an escape, and mailers do emit them. Keeping it is one
    // stray character; dropping it could join two words the detectors read.
    out[length] = 0x3d;
    length += 1;
  }

  return out.subarray(0, length);
};

const decodeTransfer = (body: string, encoding: string): Uint8Array => {
  if (encoding === 'base64') return Buffer.from(body, 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return bytesOf(body);
};

/**
 * Decode the `=?…?=` words a header may be built from.
 *
 * Whitespace between two adjacent encoded words is folding rather than content
 * and must not survive: `=?UTF-8?Q?Anna?= =?UTF-8?Q?_Schmidt?=` is one name,
 * and a space left in the wrong place splits it into two the dictionary misses.
 */
const decodeEncodedWords = (value: string): string => {
  ENCODED_WORD.lastIndex = 0;

  let out = '';
  let cursor = 0;
  let previousWasWord = false;
  let count = 0;
  let match: RegExpExecArray | null;

  while (count < MAX_ENCODED_WORDS && (match = ENCODED_WORD.exec(value)) !== null) {
    const gap = value.slice(cursor, match.index);
    if (!(previousWasWord && gap.trim() === '')) out += gap;

    const charset = (match[1] ?? '').split('*')[0] ?? '';
    const encoding = (match[2] ?? 'q').toLowerCase();
    const text = match[3] ?? '';
    const bytes =
      encoding === 'b'
        ? Buffer.from(text, 'base64')
        : decodeQuotedPrintable(text.replaceAll('_', ' '));
    out += decodeCharset(bytes, charset);

    cursor = match.index + match[0].length;
    previousWasWord = true;
    count += 1;
  }

  return out + value.slice(cursor);
};

/** Split on `separator`, except inside a quoted string. */
const splitUnquoted = (text: string, separator: string, limit: number): string[] => {
  const out: string[] = [];
  let start = 0;
  let quoted = false;

  for (let index = 0; index < text.length && out.length < limit; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) {
      out.push(text.slice(start, index));
      start = index + 1;
    }
  }

  out.push(text.slice(start));
  return out;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  const inner = trimmed.slice(1, trimmed.endsWith('"') ? -1 : undefined);
  return inner.replaceAll(/\\(.)/gu, '$1');
};

const parseContentType = (raw: string | undefined): ContentType => {
  const segments = splitUnquoted(raw ?? '', ';', MAX_PARAMETERS);
  const parameters = new Map<string, string>();

  for (const segment of segments.slice(1)) {
    const equals = segment.indexOf('=');
    if (equals === -1) continue;
    const name = segment.slice(0, equals).trim().toLowerCase();
    parameters.set(name, unquote(segment.slice(equals + 1)));
  }

  return { type: (segments[0] ?? '').trim().toLowerCase(), parameters };
};

const percentDecode = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length);
  let length = 0;

  for (let index = 0; index < text.length; index += 1) {
    const pair = text[index] === '%' ? text.slice(index + 1, index + 3) : '';
    if (pair !== '' && HEX_PAIR.test(pair)) {
      out[length] = Number.parseInt(pair, 16);
      index += 2;
    } else {
      out[length] = text.charCodeAt(index) & 0xff;
    }
    length += 1;
  }

  return out.subarray(0, length);
};

/**
 * A parameter, preferring the RFC 2231 extended spelling.
 *
 * `filename*=UTF-8''K%C3%BCndigung.pdf` is how every modern mailer writes a
 * name with an umlaut in it, and a filename is personal data in its own right.
 */
const parameterValue = (contentType: ContentType, name: string): string | null => {
  const extended = contentType.parameters.get(`${name}*`);
  if (extended !== undefined) {
    const fields = extended.split("'");
    const charset = (fields[0] ?? '').toLowerCase();
    const encoded = fields.length >= 3 ? fields.slice(2).join("'") : extended;
    return decodeCharset(percentDecode(encoded), charset === '' ? null : charset);
  }

  const plain = contentType.parameters.get(name);
  return plain === undefined ? null : decodeEncodedWords(plain);
};

/** Where a delimiter line sits, and what it delimits. */
interface Delimiter {
  /** End of the preceding part, with the line ending that belongs to the line. */
  readonly index: number;
  /** Start of the next part. */
  readonly end: number;
  readonly closing: boolean;
}

const findDelimiter = (body: string, delimiter: string, from: number): Delimiter | null => {
  let at = from;

  while (at <= body.length) {
    const found = body.indexOf(delimiter, at);
    if (found === -1) return null;

    if (found !== 0 && body[found - 1] !== '\n') {
      at = found + delimiter.length;
      continue;
    }

    let cursor = found + delimiter.length;
    const closing = body.startsWith('--', cursor);
    if (closing) cursor += 2;
    while (body[cursor] === ' ' || body[cursor] === '\t') cursor += 1;

    if (cursor < body.length) {
      if (body.startsWith('\r\n', cursor)) cursor += 2;
      else if (body[cursor] === '\n') cursor += 1;
      else {
        // Text that merely begins with the boundary is not a delimiter line.
        at = found + delimiter.length;
        continue;
      }
    }

    const before = found === 0 ? 0 : found - (body.startsWith('\r\n', found - 2) ? 2 : 1);
    return { index: before, end: cursor, closing };
  }

  return null;
};

/** The parts a boundary delimits. The preamble and the epilogue are not parts. */
const splitParts = (body: string, boundary: string, limit: number): string[] => {
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let start = -1;
  let cursor = 0;

  while (parts.length < limit) {
    const found = findDelimiter(body, delimiter, cursor);
    if (found === null) break;
    if (start !== -1) parts.push(body.slice(start, found.index));
    if (found.closing) return parts;
    start = found.end;
    cursor = found.end;
  }

  // No closing delimiter. A mailer that truncated its own message still wrote
  // the part before the cut, and that part is text a detector should see.
  if (start !== -1 && parts.length < limit) parts.push(body.slice(start));
  return parts;
};

/** A part whose bytes are characters once the transport encoding is undone. */
const isReadableText = (type: string): boolean =>
  type === '' || type.startsWith('text/') || type === 'application/xhtml+xml';

const partText = (part: Part, contentType: ContentType): string => {
  const declared = headerValue(part.headers, 'content-transfer-encoding') ?? '';
  const bytes = decodeTransfer(part.body, declared.trim().toLowerCase());
  return decodeCharset(bytes, contentType.parameters.get('charset') ?? null);
};

/**
 * The one part of a `multipart/alternative` worth reading.
 *
 * The alternatives hold the same words in ascending fidelity, so reading them
 * all would give the detectors — and the model — the message three times over.
 * Plain text is preferred because it needs no interpretation at all.
 */
const pickAlternative = (children: readonly Part[]): Part | null => {
  let plain: Part | null = null;
  let markup: Part | null = null;
  let nested: Part | null = null;

  for (const child of children) {
    const type = parseContentType(headerValue(child.headers, 'content-type')).type;
    if (type === 'text/plain' || type === '') plain = child;
    else if (type === 'text/html' || type === 'application/xhtml+xml') markup = child;
    else if (type.startsWith('multipart/')) nested = child;
  }

  return plain ?? markup ?? nested;
};

const collectMessage = (message: Part, depth: number, sink: Sink, budget: Budget): void => {
  for (const [name, label] of REPORTED_HEADERS) {
    const value = headerValue(message.headers, name);
    if (value === undefined || value === '') continue;
    sink.push(`${label}: ${decodeEncodedWords(value)}\n`);
  }
  sink.push('\n');
  collectPart(message, depth, sink, budget);
};

// A declaration where the rest of this file uses arrows: this and
// collectMessage call each other, and hoisting is what lets the pair be written
// in the order they are read in.
function collectPart(part: Part, depth: number, sink: Sink, budget: Budget): void {
  if (sink.full()) return;

  const contentType = parseContentType(headerValue(part.headers, 'content-type'));
  const disposition = parseContentType(headerValue(part.headers, 'content-disposition'));
  const filename = parameterValue(disposition, 'filename') ?? parameterValue(contentType, 'name');

  if (contentType.type.startsWith('multipart/')) {
    if (depth >= MAX_DEPTH) {
      sink.push('[nested message parts not read: too deeply nested]\n');
      return;
    }

    const boundary = contentType.parameters.get('boundary');
    if (boundary === undefined || boundary === '') {
      // Nothing can be found in a multipart with no boundary, and a body that
      // silently went missing is the failure this module is written against.
      sink.push('[message body not read: multipart without a boundary]\n');
      return;
    }

    const children = splitParts(part.body, boundary, MAX_PARTS).map((raw) => splitMessage(raw));
    const alternative = contentType.type === 'multipart/alternative';
    const chosen = alternative ? [pickAlternative(children)] : children;

    for (const child of chosen) {
      if (child === null || sink.full() || budget.parts >= MAX_PARTS) break;
      budget.parts += 1;
      collectPart(child, depth + 1, sink, budget);
    }
    return;
  }

  if (contentType.type === 'message/rfc822') {
    // A forwarded mail is a message, not a file: its own From and Subject are
    // exactly the personal data this module exists to expose to the detectors.
    if (depth >= MAX_DEPTH) {
      sink.push('[forwarded message not read: too deeply nested]\n');
      return;
    }
    collectMessage(splitMessage(part.body), depth + 1, sink, budget);
    return;
  }

  // Named but never opened. The name reaches the detectors because
  // `Kuendigung_Anna_Schmidt.pdf` is personal data; the bytes behind it are a
  // separate attachment for the layer above to route or refuse.
  if (filename !== null) sink.push(`[attachment: ${filename}]\n`);
  else if (!isReadableText(contentType.type)) sink.push(`[attachment: ${contentType.type}]\n`);
  if (!isReadableText(contentType.type)) return;

  const text = partText(part, contentType);
  const markup = contentType.type === 'text/html' || contentType.type === 'application/xhtml+xml';
  sink.push(markup ? htmlToText(text, sink.remaining()) : text);
  sink.push('\n');
}

/**
 * Read a message into the text a detector can work on.
 *
 * The five envelope fields come first and always, then the body: a mail whose
 * body is an image still has to have its sender pseudonymised.
 */
export function emlToText(bytes: Uint8Array, maxChars: number): ExtractionResult {
  if (maxChars <= 0) return { ok: false, reason: 'no character budget left for this attachment' };
  if (bytes.length === 0) return { ok: false, reason: 'the message is empty' };
  if (bytes.length > MAX_MESSAGE_BYTES) {
    const size = formatBytes(bytes.length);
    const limit = formatBytes(MAX_MESSAGE_BYTES);
    return {
      ok: false,
      reason: `the message is ${size}, over the ${limit} the mail reader accepts`,
    };
  }

  const message = splitMessage(latin1(bytes));
  if (message.headers.length === 0) {
    return { ok: false, reason: 'no rfc 822 header fields before the first blank line' };
  }

  const sink = createSink(maxChars);
  collectMessage(message, 0, sink, { parts: 0 });

  const text = sink.text().trim();
  if (text === '') return { ok: false, reason: 'the message carries no readable text' };
  return { ok: true, value: { text, pages: null, extractor: 'builtin.eml' } };
}

/** The mail reader, for the registry. */
export const emlExtractor: Extractor = {
  name: 'builtin.eml',

  supports: (format, mediaType) => format === 'eml' || mediaType === 'message/rfc822',

  extract: async (bytes, context) => emlToText(bytes, context.maxChars),
};
