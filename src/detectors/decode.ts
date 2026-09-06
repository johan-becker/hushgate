/**
 * Decode-and-rescan: the scan copies for values that were encoded rather than
 * disguised.
 *
 * `REU4OTM3MDQwMDQ0MDUzMjAxMzAwMA==` is an IBAN, `anna%40acme.example` is an
 * address and `anna&#64;acme.example` is the same address again. None of them
 * matches any detector, all of them are one function call away from the value
 * they carry, and every one of them is a copy-paste out of a log line, a URL or
 * an HTML mail — which is to say they arrive by accident at least as often as
 * on purpose, and either way the value leaves the machine while the audit
 * record says nothing was found.
 *
 * Each decoder rebuilds the *whole* text with only the encoded runs replaced,
 * rather than handing the decoded fragment to the detectors on its own. That
 * costs nothing extra and keeps the surrounding words in place, which is what
 * lets a label-proximity detector still see the `Steuer-ID:` that stands in
 * front of the blob.
 *
 * The offset map points every decoded character at the encoded run that
 * produced it, so a span found inside the decode maps back onto the encoded
 * text and is redacted and rehydrated as the encoded text — hushgate never
 * hands back a body whose base64 has quietly become plain text.
 */
import type { NormalisedText } from './normalise.js';

/**
 * Shortest base64 run worth decoding.
 *
 * Sixteen characters is twelve bytes: below that the decode is too short to
 * carry anything a detector would claim, while the population of ordinary words
 * that happen to be valid base64 is still large. Together with the padding and
 * printability checks this is what keeps `Sehrgeehrtedamenundherren` from being
 * read as ciphertext.
 */
const MIN_BASE64_LENGTH = 16;

/** Standard alphabet only. */
const BASE64_RUN = /[A-Za-z0-9+/]{12,}={0,2}/gu;

/** A maximal run of `%XX` escapes, decoded together so UTF-8 survives. */
const PERCENT_RUN = /(?:%[0-9A-Fa-f]{2})+/gu;

/** Numeric and named character references. */
const HTML_ENTITY = /&(?:#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/gu;

/**
 * The named references worth carrying.
 *
 * The full HTML5 table is 2 231 entries and would be a dependency in all but
 * name; these are the ones that can hide a finding — the characters that hold
 * an address, a URL or a key together.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  commat: '@',
  period: '.',
  dot: '.',
  sol: '/',
  bsol: '\\',
  lowbar: '_',
  hyphen: '-',
  dash: '-',
  num: '#',
  percnt: '%',
  plus: '+',
  equals: '=',
  colon: ':',
  semi: ';',
  comma: ',',
  excl: '!',
  quest: '?',
  dollar: '$',
  ast: '*',
  lpar: '(',
  rpar: ')',
};

/** UTF-8 that must be exactly right, or the run is left as it was written. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Text that a person could have typed.
 *
 * The point of the test is not to prove the decode is meaningful but to reject
 * the overwhelming majority of accidental matches, whose bytes are compressed
 * data, an image header or a hash. Control characters other than tab, newline
 * and carriage return are what those always carry and text never does.
 */
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}\t\n\r]+$/u;

/**
 * Every decode copy that applies to `text`, in a fixed order.
 *
 * Lazy on purpose: a copy is built only when the cheap test for its encoding
 * finds something, and a caller that stops early pays for nothing after that.
 */
export function* decodeCopies(text: string): Generator<NormalisedText> {
  const base64 = decodeBase64Runs(text);
  if (base64 !== null) yield base64;

  const percent = decodePercentRuns(text);
  if (percent !== null) yield percent;

  const entities = decodeHtmlEntities(text);
  if (entities !== null) yield entities;
}

/**
 * True when a run is worth handing to the base64 decoder.
 *
 * Length, alphabet and padding are the cheap half of the guard: a run that is
 * not a multiple of four cannot be base64 at all, and no amount of decoding
 * will make it one.
 */
export function isBase64Shaped(run: string): boolean {
  if (run.length < MIN_BASE64_LENGTH) return false;
  if (run.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(run);
}

/** The text a base64 run carries, or `null` when it does not carry text. */
export function decodeBase64Text(run: string): string | null {
  if (!isBase64Shaped(run)) return null;

  const bytes = Buffer.from(run, 'base64');
  // Node accepts almost anything here and silently drops what it cannot use,
  // so the round trip is the only honest test that the run really is base64.
  if (bytes.length === 0 || bytes.toString('base64') !== run) return null;

  let decoded: string;
  try {
    decoded = strictUtf8.decode(bytes);
  } catch {
    return null;
  }

  return PRINTABLE.test(decoded) ? decoded : null;
}

/** The scan copy with every decodable base64 run replaced by its text. */
export function decodeBase64Runs(text: string): NormalisedText | null {
  return rewriteRuns(text, BASE64_RUN, decodeBase64Text);
}

/** The scan copy with every `%XX` run replaced by the bytes it spells. */
export function decodePercentRuns(text: string): NormalisedText | null {
  if (!text.includes('%')) return null;

  return rewriteRuns(text, PERCENT_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    try {
      const decoded = strictUtf8.decode(bytes);
      return PRINTABLE.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  });
}

/** The scan copy with every character reference replaced by its character. */
export function decodeHtmlEntities(text: string): NormalisedText | null {
  if (!text.includes('&')) return null;

  return rewriteRuns(text, HTML_ENTITY, (run) => {
    const body = run.slice(1, -1);

    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Surrogates and out-of-range values are what a fuzzer sends, not a mail
      // client; `String.fromCodePoint` would throw on the second kind.
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null;
      if (code >= 0xd800 && code <= 0xdfff) return null;
      return String.fromCodePoint(code);
    }

    return NAMED_ENTITIES[body.toLowerCase()] ?? null;
  });
}

/**
 * Rebuild `text` with every run `pattern` finds and `decode` accepts replaced.
 *
 * The offset map is the whole reason this is not a `replaceAll`. Text outside a
 * run keeps its own index; inside one, decoded characters are spread across the
 * run in proportion, and the character after the run points past its end.
 *
 * What that buys and what it costs: a span covering the whole decode — the
 * ordinary case, because a blob almost always encodes exactly the value that
 * was hidden — maps onto the run exactly, so the placeholder replaces the whole
 * blob and rehydration hands the blob back byte for byte. A span that stops
 * part-way through a run lands inside the encoded unit that produced its last
 * character, which can leave one encoded unit of the tail standing. Collapsing
 * the run to a single index would avoid that at the price of making every span
 * inside a long blob claim the entire blob, which is the worse trade: several
 * findings in one run would then all resolve onto the same range and all but
 * one would be dropped as an overlap.
 */
function rewriteRuns(
  text: string,
  pattern: RegExp,
  decode: (run: string) => string | null,
): NormalisedText | null {
  const re = new RegExp(pattern.source, pattern.flags);
  const parts: string[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const run = match[0];
    const decoded = decode(run);
    if (decoded === null || decoded === run) continue;

    parts.push(text.slice(cursor, match.index));
    for (let i = cursor; i < match.index; i += 1) offsets.push(i);

    parts.push(decoded);
    // Spread the decoded characters across the run rather than piling them all
    // on its first character: a run is often long enough to hold several
    // findings, and a map that collapses it to one index would make every span
    // in it claim the whole blob.
    const step = decoded.length === 0 ? 0 : run.length / decoded.length;
    for (let i = 0; i < decoded.length; i += 1) {
      offsets.push(match.index + Math.floor(i * step));
    }

    cursor = match.index + run.length;
    changed = true;
  }

  if (!changed) return null;

  parts.push(text.slice(cursor));
  for (let i = cursor; i < text.length; i += 1) offsets.push(i);
  offsets.push(text.length);

  return { text: parts.join(''), offsets, changed: true };
}
