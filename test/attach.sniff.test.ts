import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { emlToText } from '../src/attach/eml.js';
import { probePdf } from '../src/attach/pdf.js';
import { normaliseMediaType, sniffFormat } from '../src/attach/sniff.js';
import type { ExtractionResult } from '../src/attach/types.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const raw = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** Bytes with a magic prefix and enough filler to look like a real file. */
const magic = (...values: number[]): Uint8Array =>
  Uint8Array.from([...values, ...Array.from({ length: 64 }, (_, index) => index & 0x7f)]);

interface ZipInput {
  readonly name: string;
  readonly data: string;
  /** Stored rather than deflated, as ODF requires of its `mimetype` entry. */
  readonly stored?: boolean;
}

/**
 * A ZIP built here rather than committed as a fixture.
 *
 * The CRC fields are left at zero on purpose: nothing under test verifies them,
 * and a hand-rolled CRC in a test is a second implementation to get wrong.
 */
const zip = (entries: readonly ZipInput[]): Uint8Array => {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const plain = Buffer.from(entry.data, 'utf8');
    const stored = entry.stored === true;
    const data = stored ? plain : deflateRawSync(plain);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += 30 + name.length + data.length;
  }

  const body = Buffer.concat(locals);
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(body.length, 16);

  return new Uint8Array(Buffer.concat([body, central, end]));
};

const OOXML_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';

const MINIMAL_PDF = [
  '%PDF-1.7',
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >> endobj',
  '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  '5 0 obj << /Length 41 >>',
  'stream',
  'BT /F1 12 Tf 72 720 Td (Anna Schmidt) Tj ET',
  'endstream endobj',
  'trailer << /Size 6 /Root 1 0 R >>',
  '%%EOF',
].join('\n');

describe('sniffing by magic bytes', () => {
  it('reads a PDF header as pdf', () => {
    expect(sniffFormat(utf8(MINIMAL_PDF), null, null)).toBe('pdf');
  });

  it('believes the bytes over a caller who labelled a PDF text/plain', () => {
    expect(sniffFormat(utf8(MINIMAL_PDF), 'text/plain; charset=utf-8', 'notizen.txt')).toBe('pdf');
  });

  it('finds a PDF header that a producer prefixed with junk', () => {
    const bytes = utf8(`${' '.repeat(200)}${MINIMAL_PDF}`);
    expect(sniffFormat(bytes, null, null)).toBe('pdf');
  });

  it('reads {\\rtf as rtf', () => {
    expect(sniffFormat(utf8(String.raw`{\rtf1\ansi Anna Schmidt}`), null, null)).toBe('rtf');
  });

  const images: readonly (readonly [string, Uint8Array])[] = [
    ['png', magic(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['jpeg', magic(0xff, 0xd8, 0xff, 0xe0)],
    ['gif', magic(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)],
    ['webp', magic(0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)],
    ['tiff, little endian', magic(0x49, 0x49, 0x2a, 0x00)],
    ['tiff, big endian', magic(0x4d, 0x4d, 0x00, 0x2a)],
  ];

  it.each(images)('reads %s as image', (_label, bytes) => {
    expect(sniffFormat(bytes, null, null)).toBe('image');
  });

  it('reads a bitmap with a plausible DIB header as image', () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x42, 0x4d]);
    new DataView(bytes.buffer).setUint32(14, 40, true);
    expect(sniffFormat(bytes, null, null)).toBe('image');
  });

  it('does not read a sentence beginning BM as a bitmap', () => {
    const bytes = utf8('BMW Karlsruhe, Rechnung 4711 für Anna Schmidt');
    expect(sniffFormat(bytes, null, null)).toBe('text');
  });

  it('reads a doctype as html', () => {
    expect(sniffFormat(utf8('<!DOCTYPE html><title>Hallo</title>'), null, null)).toBe('html');
  });

  it('reads a leading html element as html, past a byte order mark', () => {
    const bytes = utf8('﻿\n  <html lang="de"><body>Anna</body></html>');
    expect(sniffFormat(bytes, null, null)).toBe('html');
  });

  it('reads an xml declaration as xml', () => {
    expect(sniffFormat(utf8('<?xml version="1.0"?><rechnung/>'), null, null)).toBe('xml');
  });

  it('reads an xhtml root as html rather than xml', () => {
    const bytes = utf8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>');
    expect(sniffFormat(bytes, null, null)).toBe('html');
  });
});

describe('sniffing what a zip container holds', () => {
  it('reads the OOXML main part as docx, xlsx or pptx', () => {
    const docx = zip([{ name: '[Content_Types].xml', data: OOXML_TYPES }, { name: 'word/document.xml', data: '<w/>' }]);
    const xlsx = zip([{ name: '[Content_Types].xml', data: OOXML_TYPES }, { name: 'xl/workbook.xml', data: '<w/>' }]);
    const pptx = zip([{ name: '[Content_Types].xml', data: OOXML_TYPES }, { name: 'ppt/presentation.xml', data: '<p/>' }]);

    expect(sniffFormat(docx, null, null)).toBe('docx');
    expect(sniffFormat(xlsx, null, null)).toBe('xlsx');
    expect(sniffFormat(pptx, null, null)).toBe('pptx');
  });

  const odf: readonly (readonly [string, string])[] = [
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ];

  it.each(odf)('reads a stored mimetype entry as %s', (format, mimetype) => {
    const bytes = zip([
      { name: 'mimetype', data: mimetype, stored: true },
      { name: 'content.xml', data: '<office/>' },
    ]);
    expect(sniffFormat(bytes, null, null)).toBe(format);
  });

  it('reads an ODF template as the format it templates', () => {
    const bytes = zip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text-template', stored: true },
      { name: 'content.xml', data: '<office/>' },
    ]);
    expect(sniffFormat(bytes, null, null)).toBe('odt');
  });

  it('still reads a producer that deflated the mimetype entry and put it last', () => {
    const bytes = zip([
      { name: 'content.xml', data: '<office/>' },
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' },
    ]);
    expect(sniffFormat(bytes, null, null)).toBe('ods');
  });

  it('refuses a bare archive however it is named', () => {
    const bytes = zip([{ name: 'notizen.txt', data: 'Anna Schmidt' }]);
    expect(sniffFormat(bytes, 'application/zip', 'bericht.docx')).toBe('unknown');
  });

  it('refuses a container whose directory does not parse', () => {
    const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...Array.from({ length: 40 }, () => 0xff)]);
    expect(sniffFormat(bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe(
      'unknown',
    );
  });
});

describe('falling back to the declared type and then the filename', () => {
  const declared: readonly (readonly [string, string])[] = [
    ['text/csv', 'csv'],
    ['application/json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['application/xml', 'xml'],
    ['text/html', 'html'],
    ['message/rfc822', 'eml'],
    ['text/markdown', 'text'],
  ];

  it.each(declared)('reads %s as %s', (mediaType, format) => {
    expect(sniffFormat(utf8('Anna;Schmidt;Karlsruhe'), mediaType, null)).toBe(format);
  });

  it('prefers the declared type to the extension', () => {
    expect(sniffFormat(utf8('a,b,c'), 'text/csv', 'liste.txt')).toBe('csv');
  });

  const named: readonly (readonly [string, string])[] = [
    ['liste.csv', 'csv'],
    ['notizen.TXT', 'text'],
    ['seite.htm', 'html'],
    ['mail.eml', 'eml'],
    ['daten.json', 'json'],
  ];

  it.each(named)('reads %s as %s', (filename, format) => {
    expect(sniffFormat(utf8('irgendetwas'), null, filename)).toBe(format);
  });

  it('reads printable UTF-8 with no hints at all as text', () => {
    expect(sniffFormat(utf8('Sehr geehrte Frau Schmidt,\n\nvielen Dank für Ihre Nachricht.\n'), null, null)).toBe(
      'text',
    );
  });

  it('refuses bytes that are neither valid UTF-8 nor printable', () => {
    expect(sniffFormat(raw(0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x7f), null, null)).toBe('unknown');
  });

  it('refuses an empty attachment', () => {
    expect(sniffFormat(new Uint8Array(0), null, null)).toBe('unknown');
  });
});

describe('normalising a declared media type', () => {
  it('lowercases the type and drops its parameters', () => {
    expect(normaliseMediaType('Text/Plain; charset=UTF-8')).toBe('text/plain');
  });

  it('trims surrounding space', () => {
    expect(normaliseMediaType('  application/PDF  ')).toBe('application/pdf');
  });

  it.each([null, '', 'nonsense', 'text/', '/plain', 'text plain'])('answers null for %j', (value) => {
    expect(normaliseMediaType(value)).toBeNull();
  });
});

describe('probing a PDF', () => {
  it('reports the version, the page count and a font resource', () => {
    const probe = probePdf(utf8(MINIMAL_PDF));
    expect(probe).toEqual({
      isPdf: true,
      version: '1.7',
      pages: 1,
      encrypted: false,
      hasTextLayer: true,
    });
  });

  it('prefers the page tree count to the page objects it can see', () => {
    const scan = [
      '%PDF-1.4',
      '1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R 4 0 R] /Count 3 >> endobj',
      '2 0 obj << /Type /Page /Parent 1 0 R /Resources << /XObject << /Im0 9 0 R >> >> >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF',
    ].join('\n');

    const probe = probePdf(utf8(scan));
    expect(probe.pages).toBe(3);
    expect(probe.hasTextLayer).toBe(false);
  });

  it('counts page objects when no page tree says how many there are', () => {
    const bare = ['%PDF-1.3', '1 0 obj << /Type /Page >> endobj', '2 0 obj << /Type/Page >> endobj', '%%EOF'].join(
      '\n',
    );
    expect(probePdf(utf8(bare)).pages).toBe(2);
  });

  it('reports an encrypted trailer', () => {
    const locked = `${MINIMAL_PDF}\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF`;
    expect(probePdf(utf8(locked)).encrypted).toBe(true);
  });

  it('answers nothing at all about a file that is not a PDF', () => {
    expect(probePdf(utf8('Guten Tag, Frau Schmidt'))).toEqual({
      isPdf: false,
      version: null,
      pages: null,
      encrypted: false,
      hasTextLayer: false,
    });
  });
});

const mail = (lines: readonly string[]): Uint8Array => Buffer.from(lines.join('\r\n'), 'latin1');

/** The text, or a failure loud enough to read: a refusal must never assert true. */
const textOf = (result: ExtractionResult): string => {
  if (!result.ok) throw new Error(`extraction refused the message: ${result.reason}`);
  return result.value.text;
};

describe('reading a mail', () => {
  const multipart = mail([
    'From: Anna Schmidt <anna.schmidt@example.de>',
    'To: Team <team@example.de>',
    'Cc: Buchhaltung <buchhaltung@example.de>',
    'Subject: =?UTF-8?B?S8O8bmRpZ3VuZyBBbm5hIFNjaG1pZHQ=?=',
    'Date: Tue, 12 Mar 2024 09:14:00 +0100',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="grenze"',
    '',
    '--grenze',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=C3=BC=C3=9Fe aus Karlsruhe, IBAN DE89 3704 0044 0532 0130 00',
    '--grenze',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>diese Fassung soll niemand zweimal lesen</p>',
    '--grenze--',
    '',
  ]);

  it('puts the five envelope fields on their own lines', () => {
    const result = emlToText(multipart, 4000);
    expect(textOf(result)).toContain('From: Anna Schmidt <anna.schmidt@example.de>');
    expect(textOf(result)).toContain('Cc: Buchhaltung <buchhaltung@example.de>');
    expect(textOf(result)).toContain('Date: Tue, 12 Mar 2024 09:14:00 +0100');
    expect(result.ok && result.value.extractor).toBe('builtin.eml');
    expect(result.ok && result.value.pages).toBeNull();
  });

  it('decodes a base64 encoded word in the subject', () => {
    expect(textOf(emlToText(multipart, 4000))).toContain('Subject: Kündigung Anna Schmidt');
  });

  it('decodes the quoted-printable alternative and reads it only once', () => {
    const text = textOf(emlToText(multipart, 4000));
    expect(text).toContain('Grüße aus Karlsruhe, IBAN DE89 3704 0044 0532 0130 00');
    expect(text).not.toContain('niemand zweimal');
  });

  it('falls back to the html alternative when there is no plain one', () => {
    const bytes = mail([
      'From: a@example.de',
      'Content-Type: multipart/alternative; boundary="g"',
      '',
      '--g',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>Frau <b>Schmidt</b></p>',
      '--g--',
      '',
    ]);
    expect(textOf(emlToText(bytes, 4000))).toContain('Frau Schmidt');
  });

  it('joins a folded subject and the encoded words it was folded between', () => {
    const bytes = mail([
      'From: a@example.de',
      'Subject: =?UTF-8?Q?Anna?=',
      ' =?UTF-8?Q?_Schmidt?=',
      '',
      'Text',
      '',
    ]);
    expect(textOf(emlToText(bytes, 4000))).toContain('Subject: Anna Schmidt');
  });

  it('names an attached file without decoding it', () => {
    const bytes = mail([
      'From: a@example.de',
      'Content-Type: multipart/mixed; boundary="g"',
      '',
      '--g',
      'Content-Type: text/plain',
      '',
      'Anbei die Unterlagen.',
      '--g',
      'Content-Type: application/pdf',
      'Content-Disposition: attachment; filename="Kuendigung_Anna_Schmidt.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjcKQW5uYSBTY2htaWR0Cg==',
      '--g--',
      '',
    ]);

    const text = textOf(emlToText(bytes, 4000));
    expect(text).toContain('[attachment: Kuendigung_Anna_Schmidt.pdf]');
    expect(text).toContain('Anbei die Unterlagen.');
    expect(text).not.toContain('JVBERi0x');
  });

  it('decodes an RFC 2231 filename', () => {
    const bytes = mail([
      'From: a@example.de',
      'Content-Type: multipart/mixed; boundary="g"',
      '',
      '--g',
      'Content-Type: application/pdf',
      "Content-Disposition: attachment; filename*=UTF-8''K%C3%BCndigung.pdf",
      '',
      'x',
      '--g--',
      '',
    ]);
    expect(textOf(emlToText(bytes, 4000))).toContain('[attachment: Kündigung.pdf]');
  });

  it('reads the envelope of a forwarded message too', () => {
    const bytes = mail([
      'From: team@example.de',
      'Content-Type: multipart/mixed; boundary="g"',
      '',
      '--g',
      'Content-Type: message/rfc822',
      '',
      'From: Anna Schmidt <anna.schmidt@example.de>',
      'Subject: Umzug',
      '',
      'Neue Anschrift folgt.',
      '--g--',
      '',
    ]);

    const text = textOf(emlToText(bytes, 4000));
    expect(text).toContain('From: Anna Schmidt <anna.schmidt@example.de>');
    expect(text).toContain('Neue Anschrift folgt.');
  });

  it('stops at the character budget', () => {
    expect(textOf(emlToText(multipart, 20)).length).toBeLessThanOrEqual(20);
  });

  it('decodes a quoted-printable soft line break', () => {
    const bytes = mail([
      'From: a@example.de',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Anna Schmidt, Karls=',
      'ruhe',
      '',
    ]);
    expect(textOf(emlToText(bytes, 4000))).toContain('Anna Schmidt, Karlsruhe');
  });

  it('stops walking a message that nests multiparts past the depth cap', () => {
    let body = ['Content-Type: text/plain', '', 'Anna Schmidt'];
    for (let level = 12; level > 0; level -= 1) {
      body = [
        `Content-Type: multipart/mixed; boundary="g${level}"`,
        '',
        `--g${level}`,
        ...body,
        `--g${level}--`,
      ];
    }

    const text = textOf(emlToText(mail(['From: a@example.de', ...body, '']), 4000));
    expect(text).toContain('too deeply nested');
    expect(text).not.toContain('Anna Schmidt');
  });

  it('refuses input that has no header fields', () => {
    const result = emlToText(utf8('nur etwas text\nund noch eine zeile\n'), 4000);
    expect(result).toEqual({ ok: false, reason: 'no rfc 822 header fields before the first blank line' });
  });

  it('refuses an empty message', () => {
    expect(emlToText(new Uint8Array(0), 4000)).toEqual({ ok: false, reason: 'the message is empty' });
  });
});
