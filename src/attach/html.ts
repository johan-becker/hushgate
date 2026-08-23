/**
 * Readable text out of HTML.
 *
 * Most of an HTML attachment is not content — markup, style rules and script
 * bodies outnumber the prose — but the parts a browser never shows a reader are
 * exactly where personal data hides from a naive strip. `<title>` is invisible
 * in the page and names the customer in half the exports in existence;
 * `<a href="mailto:anna@example.de">` and `<img alt="Anna Schmidt">` carry a
 * mail address and a name in attribute position, outside every text node. All
 * of it has to reach the detectors, or hushgate pseudonymises the visible
 * copy of a name and forwards the hidden one.
 *
 * The parse is a hand-written index walk rather than a regex, and that is a
 * security decision, not a taste one. `/<[^>]*>/g` over a document holding a
 * million unclosed `<` characters rescans to the end of the input from every
 * one of them: quadratic time on an input an attacker chooses. A machine that
 * advances at least one character per step cannot be made to do that.
 */
import { clampChars, decodeText } from './plaintext.js';
import type { Extractor } from './types.js';

/** Elements whose content is instructions for the machine, never text for a reader. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * How many newlines an element asks for, opening or closing.
 *
 * Two tiers rather than one, because the request is the *most* any tag in a run
 * asked for and not their sum: `</p><p>` would otherwise be a different gap
 * from `</p>\n<p>`, and `</tr><tr>` would put a blank line between every row of
 * a table. A paragraph earns a blank line; a row, a list item or a `<br>` earns
 * a line.
 */
const LINE_BREAKS: ReadonlyMap<string, number> = new Map([
  ['br', 1], ['dd', 1], ['dt', 1], ['li', 1], ['tr', 1],
  ['address', 2], ['article', 2], ['aside', 2], ['blockquote', 2], ['div', 2],
  ['dl', 2], ['fieldset', 2], ['figcaption', 2], ['figure', 2], ['footer', 2],
  ['form', 2], ['h1', 2], ['h2', 2], ['h3', 2], ['h4', 2], ['h5', 2], ['h6', 2],
  ['header', 2], ['hr', 2], ['main', 2], ['nav', 2], ['ol', 2], ['p', 2],
  ['pre', 2], ['section', 2], ['table', 2], ['tbody', 2], ['tfoot', 2],
  ['thead', 2], ['title', 2], ['ul', 2],
]);

/**
 * Attributes worth reading as text.
 *
 * `content` is here for `<meta name="author" content="Anna Schmidt">`, which
 * lives inside the `<head>` this module otherwise discards — the one place
 * where dropping an element and reading its attributes have to disagree.
 */
const TEXT_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'alt', 'title', 'content']);

/** More attributes than this on one tag is not a document; nothing is allocated past it. */
const MAX_ATTRIBUTES_PER_TAG = 32;

/** At most one blank line survives a run of block elements. */
const MAX_CONSECUTIVE_NEWLINES = 2;

/** `&` followed by this much text without a `;` was never an entity reference. */
const MAX_ENTITY_LENGTH = 32;

/**
 * HTML 4 names every code point from U+00A0 to U+00FF, contiguously and in
 * order, which is why this is a list and not ninety-six hand-written pairs.
 */
const LATIN1_ENTITY_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr ' +
  'deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ' +
  'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml ' +
  'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

const buildNamedEntities = (): ReadonlyMap<string, string> => {
  const entities = new Map<string, string>([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['euro', '€'], ['hellip', '…'], ['mdash', '—'], ['ndash', '–'],
    ['lsquo', '‘'], ['rsquo', '’'], ['ldquo', '“'], ['rdquo', '”'],
    ['bull', '•'], ['dagger', '†'], ['permil', '‰'], ['trade', '™'],
  ]);

  for (const [index, name] of LATIN1_ENTITY_NAMES.entries()) {
    entities.set(name, String.fromCodePoint(0xa0 + index));
  }

  // A non-breaking space is invisible to a reader and fatal to a detector: a
  // name joined by U+00A0 is not the string the dictionary holds, so it folds
  // to the plain space the author meant.
  entities.set('nbsp', ' ');
  return entities;
};

const NAMED_ENTITIES = buildNamedEntities();

/**
 * `&#146;` is not U+0092. Authors write windows-1252 byte values into numeric
 * references, and the HTML standard legalised it by mapping 0x80–0x9F through
 * that table rather than treating them as the C1 controls they nominally are.
 */
const buildC1Table = (): string => {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) bytes[index] = 0x80 + index;
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return '';
  }
};

const C1_TABLE = buildC1Table();

const isHtmlSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d;

const isNameStart = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isNameChar = (code: number): boolean =>
  isNameStart(code) ||
  (code >= 0x30 && code <= 0x39) ||
  code === 0x2d ||
  code === 0x5f ||
  code === 0x3a;

const parseDigits = (digits: string, radix: 10 | 16): number | null => {
  // Eight digits reach past the last code point; a longer run is not a number
  // we would accept anyway, so it is refused before it is parsed.
  if (digits.length === 0 || digits.length > 8) return null;

  let value = 0;
  for (const char of digits) {
    const digit = Number.parseInt(char, radix);
    if (Number.isNaN(digit)) return null;
    value = value * radix + digit;
  }
  return value;
};

const codePointToString = (code: number): string | null => {
  if (code <= 0 || code > 0x10ffff) return null;
  // A lone surrogate is not a character and would not survive serialisation.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  if (code >= 0x80 && code <= 0x9f && C1_TABLE.length === 32) return C1_TABLE[code - 0x80] ?? null;
  return String.fromCodePoint(code);
};

/** Resolve one reference at `start`, or `null` when the `&` is just an ampersand. */
const decodeEntity = (source: string, start: number): { readonly text: string; readonly next: number } | null => {
  const semicolon = source.indexOf(';', start + 1);
  if (semicolon === -1 || semicolon - start > MAX_ENTITY_LENGTH) return null;

  const body = source.slice(start + 1, semicolon);
  if (body.length === 0) return null;

  if (body.codePointAt(0) === 0x23) {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = parseDigits(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (code === null) return null;
    const text = codePointToString(code);
    return text === null ? null : { text, next: semicolon + 1 };
  }

  const named = NAMED_ENTITIES.get(body);
  return named === undefined ? null : { text: named, next: semicolon + 1 };
};

const decodeEntities = (raw: string): string => {
  let index = raw.indexOf('&');
  if (index === -1) return raw;

  let out = raw.slice(0, index);
  while (index < raw.length) {
    const entity = decodeEntity(raw, index);
    if (entity === null) {
      out += '&';
      index += 1;
    } else {
      out += entity.text;
      index = entity.next;
    }

    const next = raw.indexOf('&', index);
    out += next === -1 ? raw.slice(index) : raw.slice(index, next);
    if (next === -1) break;
    index = next;
  }
  return out;
};

interface ParsedTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  /** Values of the attributes that can carry personal data, in source order. */
  readonly attributeText: readonly string[];
  /** Index of the first character after the tag. */
  readonly next: number;
}

/**
 * Read one tag, or refuse.
 *
 * A `<` that is not followed by a name is text — `a < b` is a comparison, and
 * treating it as the start of a tag is the mistake that makes a scanner
 * quadratic, because the scan for the matching `>` then restarts at every one.
 */
const parseTag = (html: string, start: number): ParsedTag | null => {
  let index = start + 1;
  const closing = html.codePointAt(index) === 0x2f;
  if (closing) index += 1;

  const nameStart = index;
  if (!isNameStart(html.codePointAt(index) ?? 0)) return null;
  while (index < html.length && isNameChar(html.codePointAt(index) ?? 0)) index += 1;
  const name = html.slice(nameStart, index).toLowerCase();

  const attributeText: string[] = [];
  let selfClosing = false;

  while (index < html.length) {
    const code = html.codePointAt(index) ?? 0;
    if (isHtmlSpace(code)) {
      index += 1;
      continue;
    }
    if (code === 0x3e) {
      index += 1;
      break;
    }
    if (code === 0x2f) {
      selfClosing = true;
      index += 1;
      continue;
    }

    const attributeStart = index;
    while (index < html.length) {
      const inner = html.codePointAt(index) ?? 0;
      if (isHtmlSpace(inner) || inner === 0x3d || inner === 0x3e || inner === 0x2f) break;
      index += 1;
    }
    // A stray `=` where a name belongs stops the scan on the spot; stepping over
    // it is what keeps this loop from standing still.
    if (index === attributeStart) {
      index += 1;
      continue;
    }
    const attribute = html.slice(attributeStart, index).toLowerCase();

    while (index < html.length && isHtmlSpace(html.codePointAt(index) ?? 0)) index += 1;

    let value = '';
    if (html.codePointAt(index) === 0x3d) {
      index += 1;
      while (index < html.length && isHtmlSpace(html.codePointAt(index) ?? 0)) index += 1;

      const quote = html.codePointAt(index) ?? 0;
      if (quote === 0x22 || quote === 0x27) {
        const close = html.indexOf(String.fromCodePoint(quote), index + 1);
        value = close === -1 ? html.slice(index + 1) : html.slice(index + 1, close);
        index = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = index;
        while (index < html.length) {
          const inner = html.codePointAt(index) ?? 0;
          if (isHtmlSpace(inner) || inner === 0x3e) break;
          index += 1;
        }
        value = html.slice(valueStart, index);
      }
    }

    if (value !== '' && attributeText.length < MAX_ATTRIBUTES_PER_TAG && TEXT_ATTRIBUTES.has(attribute)) {
      attributeText.push(value);
    }
  }

  return { name, closing, selfClosing, attributeText, next: index };
};

/** Index of `</name`, searched forward with `indexOf` so the scan stays linear. */
const findEndTag = (html: string, name: string, from: number): number => {
  let index = from;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) return -1;
    if (html.codePointAt(open + 1) === 0x2f) {
      const end = open + 2 + name.length;
      if (html.slice(open + 2, end).toLowerCase() === name) {
        const after = html.codePointAt(end);
        if (after === undefined || after === 0x3e || after === 0x2f || isHtmlSpace(after)) return open;
      }
    }
    index = open + 1;
  }
  return -1;
};

/** Flatten HTML to text, stopping as soon as `maxChars` is reached. */
export function htmlToText(html: string, maxChars: number): string {
  if (maxChars <= 0) return '';

  const parts: string[] = [];
  let written = 0;
  let full = false;
  let pendingNewlines = 0;
  let pendingTab = false;
  let pendingSpace = false;

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

  /**
   * Separators are deferred rather than written when they are met, so that the
   * markup around a document — a `<head>`, a wrapper `<div>`, a trailing
   * `<br>` — cannot contribute leading or trailing whitespace of its own.
   */
  const flushSeparators = (): void => {
    if (parts.length > 0) {
      if (pendingNewlines > 0) append('\n'.repeat(Math.min(pendingNewlines, MAX_CONSECUTIVE_NEWLINES)));
      else if (pendingTab) append('\t');
      else if (pendingSpace) append(' ');
    }
    pendingNewlines = 0;
    pendingTab = false;
    pendingSpace = false;
  };

  const emitText = (raw: string): void => {
    let index = 0;
    while (index < raw.length) {
      if (full) break;
      if (isHtmlSpace(raw.codePointAt(index) ?? 0)) {
        pendingSpace = true;
        index += 1;
        continue;
      }
      let end = index;
      while (end < raw.length && !isHtmlSpace(raw.codePointAt(end) ?? 0)) end += 1;
      flushSeparators();
      append(raw.slice(index, end));
      index = end;
    }
  };

  let index = 0;
  let inHead = false;
  let inTitle = false;

  while (index < html.length) {
    if (full) break;
    if (html.codePointAt(index) !== 0x3c) {
      const open = html.indexOf('<', index);
      const end = open === -1 ? html.length : open;
      if (!inHead || inTitle) emitText(decodeEntities(html.slice(index, end)));
      index = end;
      continue;
    }

    if (html.startsWith('<!--', index)) {
      const end = html.indexOf('-->', index + 4);
      // An unterminated comment swallows the rest of the document, which is
      // both what a browser does and the safe direction to be wrong in.
      index = end === -1 ? html.length : end + 3;
      continue;
    }

    if (html.startsWith('<!', index) || html.startsWith('<?', index)) {
      const end = html.indexOf('>', index + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = parseTag(html, index);
    if (tag === null) {
      emitText('<');
      index += 1;
      continue;
    }
    index = tag.next;

    // Attribute values are read even inside `<head>`: see TEXT_ATTRIBUTES.
    for (const value of tag.attributeText) {
      pendingSpace = true;
      emitText(decodeEntities(value));
      pendingSpace = true;
    }

    if (RAW_TEXT_ELEMENTS.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) {
        const end = findEndTag(html, tag.name, index);
        index = end === -1 ? html.length : end;
      }
      continue;
    }

    if (tag.name === 'head') inHead = !tag.closing;
    if (tag.name === 'title') inTitle = !tag.closing;

    const newlines = LINE_BREAKS.get(tag.name);
    if (newlines !== undefined) {
      pendingNewlines = Math.max(pendingNewlines, Math.min(newlines, MAX_CONSECUTIVE_NEWLINES));
    } else if (tag.closing && (tag.name === 'td' || tag.name === 'th')) {
      pendingTab = true;
    }
  }

  return clampChars(parts.join(''), maxChars);
}

/**
 * The HTML extractor.
 *
 * The encoding is settled from the bytes, not from a `<meta charset>`: the
 * declaration is part of the same attacker-controlled document, and a sniff
 * that validates UTF-8 strictly already answers the question the declaration
 * would have.
 */
export const htmlExtractor: Extractor = {
  name: 'builtin.html',

  supports: (format) => format === 'html',

  extract: async (bytes, context) => {
    const text = htmlToText(decodeText(bytes).text, context.maxChars);
    if (text.trim() === '') return { ok: false, reason: 'the document contains no readable text' };
    return { ok: true, value: { text, pages: null, extractor: 'builtin.html' } };
  },
};
