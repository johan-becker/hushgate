import { describe, expect, it } from 'vitest';
import {
  clampChars,
  decodeText,
  decodeWindows1252,
  WINDOWS_1252_C1,
  plaintextExtractor,
} from '../src/attach/plaintext.js';
import { htmlExtractor, htmlToText } from '../src/attach/html.js';
import { rtfExtractor, rtfToText } from '../src/attach/rtf.js';
import type { ExtractionContext, ExtractionResult } from '../src/attach/types.js';

const context = (overrides: Partial<ExtractionContext> = {}): ExtractionContext => ({
  format: 'text',
  mediaType: null,
  maxChars: 10_000,
  timeoutMs: 1000,
  ...overrides,
});

/** Bytes as an editor would write them: one byte per character, no encoding applied. */
const raw = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** A latin-1 source string to bytes, for hand-written RTF that is pure ASCII. */
const bytes = (source: string): Uint8Array =>
  Uint8Array.from([...source], (char) => char.codePointAt(0) ?? 0);

const utf16 = (text: string, options: { readonly bom?: boolean; readonly big?: boolean } = {}): Uint8Array => {
  const source = options.bom === true ? `\uFEFF${text}` : text;
  const out = new Uint8Array(source.length * 2);
  for (let index = 0; index < source.length; index += 1) {
    const unit = source.charCodeAt(index);
    out[index * 2] = options.big === true ? unit >> 8 : unit & 0xff;
    out[index * 2 + 1] = options.big === true ? unit & 0xff : unit >> 8;
  }
  return out;
};

const extracted = (result: ExtractionResult): string => {
  if (!result.ok) throw new Error(`expected text, got: ${result.reason}`);
  return result.value.text;
};

describe('byte order marks', () => {
  it('strips a UTF-8 mark instead of leaking it into the text', () => {
    const decoded = decodeText(raw(0xef, 0xbb, 0xbf, 0x68, 0x69));
    expect(decoded).toEqual({ text: 'hi', encoding: 'utf-8' });
  });

  it('reads a marked UTF-16LE file', () => {
    expect(decodeText(utf16('Müller', { bom: true }))).toEqual({
      text: 'Müller',
      encoding: 'utf-16le',
    });
  });

  it('reads a marked UTF-16BE file', () => {
    expect(decodeText(utf16('Müller', { bom: true, big: true }))).toEqual({
      text: 'Müller',
      encoding: 'utf-16be',
    });
  });
});

describe('encoding sniffing without a mark', () => {
  it('recognises the NUL padding of a Windows UTF-16LE export', () => {
    const decoded = decodeText(utf16('Kunde: Anna Schmidt\r\nIBAN DE89 3704 0044 0532 0130 00\r\n'));
    expect(decoded.encoding).toBe('utf-16le');
    expect(decoded.text).toBe('Kunde: Anna Schmidt\nIBAN DE89 3704 0044 0532 0130 00\n');
  });

  it('recognises UTF-16BE from padding on the other side', () => {
    const decoded = decodeText(utf16('Rechnung für Herrn Müller', { big: true }));
    expect(decoded).toEqual({ text: 'Rechnung für Herrn Müller', encoding: 'utf-16be' });
  });

  it('does not mistake plain ASCII for UTF-16', () => {
    expect(decodeText(bytes('plain ascii text, no nul bytes')).encoding).toBe('utf-8');
  });

  it('prefers strict UTF-8 when the bytes validate', () => {
    const decoded = decodeText(new TextEncoder().encode('Müller & Söhne GmbH'));
    expect(decoded).toEqual({ text: 'Müller & Söhne GmbH', encoding: 'utf-8' });
  });

  it('falls back to windows-1252 for bytes that are not UTF-8', () => {
    // M ü l l e r — 0xFC followed by an ASCII byte is not a UTF-8 sequence.
    const decoded = decodeText(raw(0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72));
    expect(decoded).toEqual({ text: 'Müller', encoding: 'windows-1252' });
  });

  it('decodes the windows-1252 C1 range rather than treating it as latin-1', () => {
    expect(decodeText(raw(0x4b, 0xfc, 0x6e, 0x92, 0x73)).text).toBe('Kün’s');
  });
});

/**
 * windows-1252 without asking the platform for it.
 *
 * Both the plain-text decoder and the HTML entity reader used to get this
 * mapping from `new TextDecoder('windows-1252')`, which is correct — on a Node
 * that has the table. A build without full ICU throws for that label, and the
 * fallbacks were worse than they looked: the decoder dropped to latin-1, where
 * 0x92 is the C1 control U+0092 rather than a right single quote and is then
 * stripped as a control character, and the entity reader gave up and dropped
 * the reference. `Kün’s` came out `Küns` and `Anna’s` came out `Annas` — the
 * apostrophe silently deleted from somebody's name, on one class of machine and
 * not another.
 *
 * So the thirty-two characters are data now, and these tests are what keeps
 * them honest.
 */
describe('the windows-1252 C1 table', () => {
  it('is thirty-two characters, one per byte from 0x80 to 0x9F', () => {
    expect([...WINDOWS_1252_C1]).toHaveLength(32);
  });

  it('maps 0x92 to the right single quotation mark', () => {
    // The byte behind every mangled apostrophe in every CSV export ever made.
    expect(WINDOWS_1252_C1[0x92 - 0x80]).toBe('\u2019');
  });

  it('agrees with the platform decoder on all 256 bytes, where the platform has one', () => {
    // The cross-check that makes the shipped table trustworthy: on a full-ICU
    // Node the two must be identical, so a typo in the literal cannot survive
    // CI. Where the platform has no table there is nothing to compare against
    // and the assertion is skipped rather than faked.
    //
    // "No table" is not only the label throwing. Node 20 accepts
    // `windows-1252` and hands back a latin-1 decoder — the same silent
    // fallback this table exists to route around — so the probe asks for the
    // one byte that tells the two apart instead of trusting the label.
    const all = Uint8Array.from({ length: 256 }, (_, byte) => byte);
    let platform: InstanceType<typeof TextDecoder>;
    try {
      platform = new TextDecoder('windows-1252');
    } catch {
      return;
    }
    if (platform.decode(raw(0x80)) !== '\u20AC') return;
    expect(decodeWindows1252(all)).toBe(platform.decode(all));
  });

  it('decodes the C1 range with no help from the platform at all', () => {
    // The regression proper. This calls the table directly, so it holds on a
    // Node that has never heard of windows-1252.
    expect(decodeWindows1252(raw(0x4b, 0xfc, 0x6e, 0x92, 0x73))).toBe('Kün\u2019s');
  });
});

describe('normalisation', () => {
  it('turns CRLF and a lone CR into a newline', () => {
    expect(decodeText(bytes('a\r\nb\rc\nd')).text).toBe('a\nb\nc\nd');
  });

  it('strips a trailing NUL run without touching the text before it', () => {
    expect(decodeText(raw(0x68, 0x69, 0x00, 0x00, 0x00)).text).toBe('hi');
  });
});

describe('clamping', () => {
  it('never cuts a surrogate pair in half', () => {
    const text = `abc${'\u{1F600}'}`;
    expect(clampChars(text, 4)).toBe('abc');
    expect(clampChars(text, 5)).toBe(text);
  });
});

describe('the plaintext extractor', () => {
  it('answers for the formats whose bytes are already text', () => {
    expect(plaintextExtractor.supports('text', null)).toBe(true);
    expect(plaintextExtractor.supports('csv', null)).toBe(true);
    expect(plaintextExtractor.supports('json', null)).toBe(true);
    expect(plaintextExtractor.supports('xml', null)).toBe(true);
    expect(plaintextExtractor.supports('html', null)).toBe(false);
  });

  it('names itself in the result', async () => {
    const result = await plaintextExtractor.extract(bytes('hello'), context());
    expect(result).toEqual({ ok: true, value: { text: 'hello', pages: null, extractor: 'builtin.text' } });
  });

  it('stops at maxChars', async () => {
    const result = await plaintextExtractor.extract(bytes('x'.repeat(500)), context({ maxChars: 12 }));
    expect(extracted(result)).toBe('x'.repeat(12));
  });

  it('refuses a file that decoded to nothing', async () => {
    const result = await plaintextExtractor.extract(raw(0x00, 0x00), context());
    expect(result).toEqual({ ok: false, reason: 'the file decoded to no text' });
  });
});

describe('htmlToText', () => {
  it('drops script, style and head but keeps the title', () => {
    const html =
      '<html><head><meta charset="utf-8"><title>Kündigung</title>' +
      '<style>body{color:red}</style></head>' +
      '<body><script>var a = "not text";</script><p>Sehr geehrte Frau Schmidt</p></body></html>';
    const text = htmlToText(html, 1000);
    expect(text).toContain('Kündigung');
    expect(text).toContain('Sehr geehrte Frau Schmidt');
    expect(text).not.toContain('color');
    expect(text).not.toContain('not text');
  });

  it('decodes named, decimal and hexadecimal references', () => {
    expect(htmlToText('<p>M&uuml;ller &amp; S&#246;hne &#x26; Co&hellip;</p>', 1000)).toBe(
      'Müller & Söhne & Co…',
    );
  });

  it('maps a numeric reference in the C1 range through windows-1252', () => {
    expect(htmlToText('<p>Anna&#146;s</p>', 1000)).toBe('Anna’s');
  });

  it('folds a non-breaking space so a name stays one name', () => {
    expect(htmlToText('<p>Anna&nbsp;Schmidt</p>', 1000)).toBe('Anna Schmidt');
  });

  it('reads addresses and names out of attributes', () => {
    const html =
      '<meta name="author" content="Anna Schmidt">' +
      '<a href="mailto:anna@example.de" title="schreiben">Kontakt</a>' +
      '<img src="p.png" alt="Foto von Herrn Müller">';
    const text = htmlToText(html, 1000);
    expect(text).toContain('Anna Schmidt');
    expect(text).toContain('mailto:anna@example.de');
    expect(text).toContain('Foto von Herrn Müller');
    expect(text).not.toContain('p.png');
  });

  it('turns block elements into lines and closing cells into tabs', () => {
    const html = '<table><tr><td>Name</td><td>Anna</td></tr><tr><td>Ort</td><td>Köln</td></tr></table>';
    expect(htmlToText(html, 1000)).toBe('Name\tAnna\nOrt\tKöln');
  });

  it('collapses the whitespace a pretty-printed document is full of', () => {
    expect(htmlToText('<p>eins\n\n   zwei\t\tdrei</p>', 1000)).toBe('eins zwei drei');
  });

  it('never emits more than two consecutive newlines', () => {
    const text = htmlToText(`<div>a</div>${'<br>'.repeat(40)}<div>b</div>`, 1000);
    expect(text).toBe('a\n\nb');
  });

  it('drops comments, including the markup hidden inside them', () => {
    expect(htmlToText('<p>vor<!-- <b>Anna</b> -->nach</p>', 1000)).toBe('vornach');
  });

  it('treats a bare less-than as text rather than the start of a tag', () => {
    expect(htmlToText('<p>a &lt; b und c < d</p>', 1000)).toBe('a < b und c < d');
  });

  it('stops at maxChars', () => {
    expect(htmlToText('<p>abcdefghij</p>', 4)).toBe('abcd');
  });

  it('reads the content of a CDATA section a browser would render as nothing', () => {
    expect(htmlToText('<p><![CDATA[Anna Schmidt]]> kam</p>', 100)).toBe('Anna Schmidt kam');
  });

  it('leaves no half of a surrogate pair behind when the budget runs out', () => {
    expect(htmlToText('<p>ab&#128512;</p>', 3)).toBe('ab');
    expect(htmlToText('<p>ab&#128512;</p>', 4)).toBe('ab\u{1F600}');
  });

  it('finishes fast on a document that is nothing but ampersands', () => {
    const started = Date.now();
    expect(htmlToText('&'.repeat(400_000), 2000)).toBe('&'.repeat(2000));
    expect(htmlToText(`${'&amp'.repeat(200_000)};`, 40).length).toBe(40);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('finishes fast on a document that is nothing but less-than signs', () => {
    const started = Date.now();
    const text = htmlToText('<'.repeat(300_000), 2000);
    expect(text.length).toBe(2000);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('finishes fast on hundreds of thousands of unterminated tags', () => {
    const started = Date.now();
    expect(htmlToText('<div'.repeat(200_000), 5000)).toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not hang on an unterminated comment, tag or quoted value', () => {
    expect(htmlToText('<p>a</p><!-- unterminated', 100)).toBe('a');
    expect(htmlToText('<p>a</p><div class="x', 100)).toBe('a');
    expect(htmlToText('<p>a</p><a href="mailto:b@c.de', 100)).toBe('a\n\nmailto:b@c.de');
  });

  it('refuses a document with nothing readable in it', async () => {
    const result = await htmlExtractor.extract(bytes('<html><head></head><body></body></html>'), context());
    expect(result).toEqual({ ok: false, reason: 'the document contains no readable text' });
  });

  it('extracts through the registry-facing surface', async () => {
    expect(htmlExtractor.supports('html', 'text/html')).toBe(true);
    const result = await htmlExtractor.extract(raw(0x3c, 0x70, 0x3e, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72), context());
    expect(result).toEqual({ ok: true, value: { text: 'Müller', pages: null, extractor: 'builtin.html' } });
  });
});

const RTF_HEADER = '{\\rtf1\\ansi\\ansicpg1252\\deff0';

describe('rtfToText', () => {
  it('decodes hex escapes in the default code page', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} Herr M\\'fcller\\par Gr\\'fc\\'dfe}`), 1000)).toBe(
      'Herr Müller\nGrüße',
    );
  });

  it('honours the code page the header declares', () => {
    const cp1250 = '{\\rtf1\\ansi\\ansicpg1250\\deff0 \\\'e5}';
    const cp1252 = '{\\rtf1\\ansi\\ansicpg1252\\deff0 \\\'e5}';
    expect(rtfToText(bytes(cp1250), 100)).toBe('ĺ');
    expect(rtfToText(bytes(cp1252), 100)).toBe('å');
  });

  it('drops the font table and every ignorable destination', () => {
    const source =
      `${RTF_HEADER}{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1 Arial;}}` +
      '{\\colortbl;\\red0\\green0\\blue0;}' +
      '{\\*\\generator Riched20 10.0.19041;}' +
      '{\\info{\\author Anna Schmidt}{\\title Kuendigung}}' +
      ' Sehr geehrte Damen und Herren}';
    expect(rtfToText(bytes(source), 1000)).toBe('Sehr geehrte Damen und Herren');
  });

  it('turns paragraph marks into newlines and tabs into tabs', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} a\\par b\\line c\\tab d\\sect e}`), 1000)).toBe(
      'a\nb\nc\td\ne',
    );
  });

  it('decodes a Unicode escape and swallows its fallback character', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} M\\u252 ?ller}`), 1000)).toBe('Müller');
  });

  it('swallows as many fallback characters as \\uc asks for', () => {
    expect(rtfToText(bytes(`${RTF_HEADER}\\uc2 A\\u8364??B}`), 1000)).toBe('A€B');
  });

  it('reads a negative Unicode parameter as the unsigned code point it stands for', () => {
    // 64257 does not fit a signed 16-bit parameter, so writers emit 64257 - 65536.
    expect(rtfToText(bytes(`${RTF_HEADER} \\u-1279 ?}`), 1000)).toBe('\uFB01');
  });

  it('joins the two escapes of an astral character back together', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} \\u-10179 ?\\u-8698 ?}`), 1000)).toBe('\u{1F606}');
  });

  it('drops a surrogate half whose partner never arrives', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} a\\u-10179 ?b}`), 1000)).toBe('ab');
  });

  it('skips a \\bin payload whole, braces and all', () => {
    const payload = '}}}\\par LEAKED';
    const source = `${RTF_HEADER}{\\*\\pict\\bin${payload.length} ${payload}}  sichtbar}`;
    expect(rtfToText(bytes(source), 1000)).toBe('sichtbar');
  });

  it('survives braces that never balance', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} a}}}}}} b`), 1000)).toBe('a b');
    expect(rtfToText(bytes(`${RTF_HEADER}{{{{ a`), 1000)).toBe('a');
  });

  it('finishes fast on pathological nesting', () => {
    const started = Date.now();
    const source = `${RTF_HEADER}${'{'.repeat(200_000)}Anna${'}'.repeat(200_000)}}`;
    expect(rtfToText(bytes(source), 1000)).toBe('Anna');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops at maxChars', () => {
    expect(rtfToText(bytes(`${RTF_HEADER} ${'ab'.repeat(100)}}`), 7)).toBe('abababa');
  });

  it('refuses a file that is not RTF at all', async () => {
    const result = await rtfExtractor.extract(bytes('%PDF-1.7 not rtf'), context({ format: 'rtf' }));
    expect(result).toEqual({ ok: false, reason: 'the file does not begin with an rtf signature' });
  });

  it('extracts through the registry-facing surface', async () => {
    expect(rtfExtractor.supports('rtf', 'application/rtf')).toBe(true);
    const result = await rtfExtractor.extract(
      bytes(`${RTF_HEADER} Anna Schmidt}`),
      context({ format: 'rtf' }),
    );
    expect(result).toEqual({ ok: true, value: { text: 'Anna Schmidt', pages: null, extractor: 'builtin.rtf' } });
  });
});
