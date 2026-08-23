import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractOoxml, ooxmlExtractor } from '../src/attach/ooxml.js';
import type { ExtractionResult } from '../src/attach/types.js';
import { readZip } from '../src/attach/zip.js';

const encoder = new TextEncoder();

interface Fixture {
  readonly name: string;
  readonly content: string | Uint8Array;
  /** Store the bytes rather than deflating them. */
  readonly store?: boolean;
  /** Uncompressed size to declare, whatever the bytes actually are. */
  readonly declaredSize?: number;
  /** Compression method to declare, for methods hushgate does not support. */
  readonly method?: number;
  /** `full` puts the sizes in a zip64 extra field; `sentinels` omits the field. */
  readonly zip64?: 'full' | 'sentinels';
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const zip64Extra = (uncompressed: number, compressed: number): Uint8Array => {
  const extra = new Uint8Array(20);
  const view = new DataView(extra.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, 16, true);
  view.setBigUint64(4, BigInt(uncompressed), true);
  view.setBigUint64(12, BigInt(compressed), true);
  return extra;
};

/**
 * Build a ZIP by hand, including the shapes a well-behaved zipper never emits.
 *
 * A fixture on disk could not express a container that lies about its own
 * sizes, and a binary in the repository is a binary nobody reviews. CRCs are
 * left at zero throughout: this reader never verifies them, and a fixture that
 * pretended otherwise would be testing the builder.
 */
const buildZip = (fixtures: readonly Fixture[]): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const fixture of fixtures) {
    const name = encoder.encode(fixture.name);
    const raw = typeof fixture.content === 'string' ? encoder.encode(fixture.content) : fixture.content;
    const stored = fixture.store === true;
    const body = stored ? raw : new Uint8Array(deflateRawSync(raw));
    const method = fixture.method ?? (stored ? 0 : 8);
    const declared = fixture.declaredSize ?? raw.length;
    const wide = fixture.zip64 !== undefined;

    const local = new Uint8Array(30 + name.length + body.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, body.length, true);
    localView.setUint32(22, declared, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const extra = fixture.zip64 === 'full' ? zip64Extra(declared, body.length) : new Uint8Array(0);
    const central = new Uint8Array(46 + name.length + extra.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x0201_4b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, wide ? 0xffff_ffff : body.length, true);
    centralView.setUint32(24, wide ? 0xffff_ffff : declared, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, extra.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.length);
    centrals.push(central);

    offset += local.length;
  }

  const directory = concat(centrals);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x0605_4b50, true);
  eocdView.setUint16(8, fixtures.length, true);
  eocdView.setUint16(10, fixtures.length, true);
  eocdView.setUint32(12, directory.length, true);
  eocdView.setUint32(16, offset, true);

  return concat([...locals, directory, eocd]);
};

/** Claim a central directory a megabyte long inside a file of a few hundred bytes. */
const overstateDirectory = (zip: Uint8Array): Uint8Array => {
  const copy = zip.slice();
  new DataView(copy.buffer).setUint32(copy.length - 10, 0x10_0000, true);
  return copy;
};

/** Cut ten bytes off the front of the central directory, so its first entry is not one. */
const shiftDirectory = (zip: Uint8Array): Uint8Array => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const start = view.getUint32(zip.length - 6, true);
  return concat([zip.subarray(0, start), zip.subarray(start + 10)]);
};

const textOf = (result: ExtractionResult): string => {
  if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
  return result.value.text;
};

const reasonOf = (result: ExtractionResult): string => {
  if (result.ok) throw new Error('extraction was expected to fail and did not');
  return result.reason;
};

const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.example/wordml"><w:body>' +
  '<w:p><w:r><w:t>Anna</w:t></w:r><w:r><w:t xml:space="preserve"> Schmidt</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>M&#252;nchen &amp; Co</w:t></w:r></w:p>' +
  '<w:p/>' +
  '</w:body></w:document>';

describe('the zip reader', () => {
  it('inflates the entries the predicate accepts and no others', () => {
    const zip = buildZip([
      { name: 'kept.txt', content: 'kept' },
      { name: 'skipped.txt', content: 'skipped' },
      { name: 'stored.txt', content: 'stored', store: true },
    ]);

    const entries = readZip(zip, (name) => name !== 'skipped.txt');

    expect(entries.map((entry) => entry.name)).toEqual(['kept.txt', 'stored.txt']);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('kept');
    expect(new TextDecoder().decode(entries[1]?.bytes)).toBe('stored');
  });

  it('never inflates an entry the predicate rejected, however hostile it is', () => {
    const zip = buildZip([
      { name: 'bomb.bin', content: new Uint8Array(4 * 1024 * 1024), declaredSize: 100 },
      { name: 'keep.txt', content: 'hello' },
    ]);

    const entries = readZip(zip, (name) => name === 'keep.txt', { maxEntryBytes: 1024 });

    expect(entries).toHaveLength(1);
  });

  it('refuses a file with no end of central directory record', () => {
    expect(() => readZip(new Uint8Array(512), () => true)).toThrow(
      /end of central directory record was not found/,
    );
  });

  it('refuses a central directory that runs past the end of the file', () => {
    const zip = overstateDirectory(buildZip([{ name: 'a.txt', content: 'a'.repeat(64) }]));

    expect(() => readZip(zip, () => true)).toThrow(/central directory is truncated/);
  });

  it('refuses a central directory whose first entry is not one', () => {
    const zip = shiftDirectory(buildZip([{ name: 'a.txt', content: 'a'.repeat(64) }]));

    expect(() => readZip(zip, () => true)).toThrow(/central directory entry has a bad signature/);
  });

  it('refuses more entries than the limit allows before reading any of them', () => {
    const zip = buildZip([
      { name: 'a.txt', content: 'a' },
      { name: 'b.txt', content: 'b' },
      { name: 'c.txt', content: 'c' },
    ]);

    expect(() => readZip(zip, () => true, { maxEntries: 2 })).toThrow(/more than 2 entries/);
  });

  it('refuses an entry whose declared uncompressed size is enormous', () => {
    const zip = buildZip([{ name: 'huge.bin', content: 'small', declaredSize: 0xffff_ff00 }]);

    expect(() => readZip(zip, () => true)).toThrow(/declares 4294967040 bytes of output/);
  });

  it('stops a bomb that understates its size while it is inflating', () => {
    // Four megabytes of zeroes deflate to a few kilobytes, and the central
    // directory claims a hundred bytes: nothing but a bounded inflate catches it.
    const zip = buildZip([
      { name: 'bomb.bin', content: new Uint8Array(4 * 1024 * 1024), declaredSize: 100 },
    ]);

    expect(() => readZip(zip, () => true, { maxEntryBytes: 64 * 1024 })).toThrow(
      /inflates past the 65536 byte limit/,
    );
  });

  it('refuses an entry that expands past the ratio limit', () => {
    const zip = buildZip([{ name: 'flat.bin', content: 'A'.repeat(1024 * 1024) }]);

    expect(() => readZip(zip, () => true)).toThrow(/over the ratio limit of 200/);
  });

  it('refuses a total expansion over the limit even when each entry fits', () => {
    const zip = buildZip([
      { name: 'a.bin', content: 'a'.repeat(4096), store: true },
      { name: 'b.bin', content: 'b'.repeat(4096), store: true },
    ]);

    expect(() => readZip(zip, () => true, { maxTotalBytes: 5000 })).toThrow(
      /more than 5000 bytes in total/,
    );
  });

  it('skips a compression method it does not implement instead of failing', () => {
    const zip = buildZip([
      { name: 'exotic.bin', content: 'bzip2 pretender', method: 12 },
      { name: 'plain.txt', content: 'plain' },
    ]);

    expect(readZip(zip, () => true).map((entry) => entry.name)).toEqual(['plain.txt']);
  });

  it('reads sizes out of a zip64 extra field', () => {
    const zip = buildZip([{ name: 'wide.txt', content: 'zip64 payload', zip64: 'full' }]);

    expect(new TextDecoder().decode(readZip(zip, () => true)[0]?.bytes)).toBe('zip64 payload');
  });

  it('refuses zip64 sentinels with no extra field rather than reading them as sizes', () => {
    const zip = buildZip([{ name: 'wide.txt', content: 'zip64 payload', zip64: 'sentinels' }]);

    expect(() => readZip(zip, () => true)).toThrow(/carries no zip64 extra field/);
  });
});

describe('extracting a docx', () => {
  const docx = buildZip([
    { name: 'word/document.xml', content: DOCUMENT_XML },
    {
      name: 'word/footnotes.xml',
      content: '<w:footnotes><w:p><w:r><w:t>Fu&#223;note</w:t></w:r></w:p></w:footnotes>',
    },
    { name: 'word/header1.xml', content: '<w:hdr><w:p><w:t>Kopfzeile</w:t></w:p></w:hdr>' },
    { name: 'word/settings.xml', content: '<w:settings><w:t>SETTINGS</w:t></w:settings>' },
  ]);

  it('joins the runs of a paragraph and breaks lines between paragraphs', () => {
    expect(textOf(extractOoxml(docx, 'docx', 4096))).toBe(
      'Anna Schmidt\nMünchen & Co\nFußnote\nKopfzeile',
    );
  });

  it('leaves the parts that are not text alone', () => {
    expect(textOf(extractOoxml(docx, 'docx', 4096))).not.toContain('SETTINGS');
  });

  it('reports no page count, because the xml does not know one', () => {
    const result = extractOoxml(docx, 'docx', 4096);

    expect(result.ok && result.value.pages).toBeNull();
    expect(result.ok && result.value.extractor).toBe('builtin.ooxml');
  });

  it('stops at the character budget', () => {
    const long = buildZip([
      { name: 'word/document.xml', content: `<w:document><w:p><w:t>${'x'.repeat(500)}</w:t></w:p></w:document>` },
    ]);

    expect(textOf(extractOoxml(long, 'docx', 10))).toBe('xxxxxxxxxx');
  });

  it('reads text out of a comment and a CDATA section but not out of markup', () => {
    const odd = buildZip([
      {
        name: 'word/document.xml',
        content:
          '<w:document><!-- Kommentar mit anna@example.de -->' +
          '<w:p><w:t><![CDATA[Konto DE89 3704]]></w:t></w:p></w:document>',
      },
    ]);

    const text = textOf(extractOoxml(odd, 'docx', 4096));

    expect(text).toBe('Konto DE89 3704');
    expect(text).not.toContain('anna@example.de');
  });

  it('does not resolve an external entity declared in a doctype', () => {
    const xxe = buildZip([
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0"?>' +
          '<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
          '<w:document><w:body><w:p><w:t>Anna Schmidt &xxe;</w:t></w:p></w:body></w:document>',
      },
    ]);

    const text = textOf(extractOoxml(xxe, 'docx', 4096));

    expect(text).toBe('Anna Schmidt &xxe;');
    expect(text).not.toContain('/etc/passwd');
    expect(text).not.toContain('root:');
  });
});

describe('extracting a xlsx', () => {
  it('reads the shared string table, keeping rich text runs in one value', () => {
    const workbook = buildZip([
      {
        name: 'xl/sharedStrings.xml',
        content:
          '<sst><si><t>Anna Schmidt</t></si>' +
          '<si><r><t>Karl</t></r><r><t>-Heinz</t></r></si></sst>',
      },
    ]);

    expect(textOf(extractOoxml(workbook, 'xlsx', 4096))).toBe('Anna Schmidt\nKarl-Heinz');
  });

  it('reads inline strings out of the sheets, which the string table never holds', () => {
    const workbook = buildZip([
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1">' +
          '<c r="A1" t="inlineStr"><is><t>Anna</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>Schmidt</t></is></c>' +
          '</row><row r="2"><c r="A2"><v>42</v></c></row>' +
          '</sheetData></worksheet>',
      },
    ]);

    expect(textOf(extractOoxml(workbook, 'xlsx', 4096))).toBe('Anna\tSchmidt');
  });

  it('reads the string table before the sheets', () => {
    const workbook = buildZip([
      {
        name: 'xl/worksheets/sheet1.xml',
        content: '<worksheet><sheetData><row><c t="inlineStr"><is><t>inline</t></is></c></row></sheetData></worksheet>',
      },
      { name: 'xl/sharedStrings.xml', content: '<sst><si><t>shared</t></si></sst>' },
    ]);

    expect(textOf(extractOoxml(workbook, 'xlsx', 4096))).toBe('shared\ninline');
  });
});

describe('extracting a pptx', () => {
  it('reads slides in numeric order and then the speaker notes', () => {
    const deck = buildZip([
      { name: 'ppt/slides/slide10.xml', content: '<p:sld><a:p><a:r><a:t>Zehn</a:t></a:r></a:p></p:sld>' },
      { name: 'ppt/notesSlides/notesSlide1.xml', content: '<p:notes><a:p><a:t>Notiz</a:t></a:p></p:notes>' },
      { name: 'ppt/slides/slide2.xml', content: '<p:sld><a:p><a:t>Zwei</a:t></a:p></p:sld>' },
    ]);

    expect(textOf(extractOoxml(deck, 'pptx', 4096))).toBe('Zwei\nZehn\nNotiz');
  });
});

describe('extracting an odt', () => {
  it('reads spans inside a paragraph as one line', () => {
    const document = buildZip([
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text', store: true },
      {
        name: 'content.xml',
        content:
          '<office:document-content><office:body><office:text>' +
          '<text:p>Sehr geehrte <text:span>Frau Schmidt</text:span>,</text:p>' +
          '<text:p>mit freundlichen Gr&#252;&#223;en</text:p>' +
          '</office:text></office:body></office:document-content>',
      },
    ]);

    expect(textOf(extractOoxml(document, 'odt', 4096))).toBe(
      'Sehr geehrte Frau Schmidt,\nmit freundlichen Grüßen',
    );
  });
});

describe('refusing what it cannot read', () => {
  it('says so when the format is not one of its own', () => {
    const docx = buildZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]);

    expect(reasonOf(extractOoxml(docx, 'pdf', 4096))).toBe('the ooxml extractor does not read pdf files');
  });

  it('says so when the bytes are not a zip at all', () => {
    const plain = encoder.encode('Sehr geehrte Frau Schmidt, dies ist kein Archiv.');

    expect(reasonOf(extractOoxml(plain, 'docx', 4096))).toBe('file is not a zip container');
  });

  it('turns a broken container into a reason rather than an exception', () => {
    const broken = overstateDirectory(buildZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]));

    expect(reasonOf(extractOoxml(broken, 'docx', 4096))).toMatch(/central directory is truncated/);
  });

  it('says so when the container holds none of the parts it reads', () => {
    const empty = buildZip([{ name: 'word/settings.xml', content: '<w:settings/>' }]);

    expect(reasonOf(extractOoxml(empty, 'docx', 4096))).toMatch(/none of the parts that carry text/);
  });

  it('says so when the document is readable but empty', () => {
    const blank = buildZip([
      { name: 'word/document.xml', content: '<w:document><w:body><w:p/></w:body></w:document>' },
    ]);

    expect(reasonOf(extractOoxml(blank, 'docx', 4096))).toMatch(/no extractable text/);
  });

  it('says so when there is no character budget left', () => {
    const docx = buildZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]);

    expect(reasonOf(extractOoxml(docx, 'docx', 0))).toMatch(/no character budget/);
  });
});

describe('the extractor as the registry sees it', () => {
  it('answers to the formats that are zips of xml and to nothing else', () => {
    expect(ooxmlExtractor.name).toBe('builtin.ooxml');
    expect(ooxmlExtractor.supports('docx', null)).toBe(true);
    expect(ooxmlExtractor.supports('ods', 'application/octet-stream')).toBe(true);
    expect(ooxmlExtractor.supports('pdf', 'application/pdf')).toBe(false);
  });

  it('resolves to the same result as the function underneath it', async () => {
    const docx = buildZip([{ name: 'word/document.xml', content: DOCUMENT_XML }]);

    const result = await ooxmlExtractor.extract(docx, {
      format: 'docx',
      mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      maxChars: 4096,
      timeoutMs: 1000,
    });

    expect(textOf(result)).toBe(textOf(extractOoxml(docx, 'docx', 4096)));
  });
});
