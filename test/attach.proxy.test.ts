/**
 * The end-to-end claim: a document in a request is turned into pseudonymised
 * text before it leaves, and the binary never reaches the upstream at all.
 *
 * Every assertion is made against what the fake upstream *received*, because
 * that is the only place the claim can be checked.
 */
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { HushgateConfig } from '../src/config.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const reply = (): { body: string } => ({
  body: JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
});

const withAttachments = (
  overrides: Partial<HushgateConfig['attachments']> = {},
): ((base: HushgateConfig, origin: string) => HushgateConfig) =>
  (base) => ({
    ...base,
    redaction: { ...base.redaction, dictionary: { names: ['Anna Schmidt'] } },
    attachments: { ...base.attachments, extractors: [], ...overrides },
  });

/** A one-entry ZIP, built here so no binary fixture enters the repo. */
function zip(entries: ReadonlyMap<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    locals.push(local, deflated);

    const entry = Buffer.alloc(46 + nameBytes.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(deflated.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    nameBytes.copy(entry, 46);
    central.push(entry);

    offset += local.length + deflated.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const docx = (text: string): Buffer =>
  zip(
    new Map([
      ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
      [
        'word/document.xml',
        `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ],
    ]),
  );

describe('a document in a request', () => {
  it('reaches the provider as pseudonymised text, never as bytes', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const file = docx('Rechnung an Anna Schmidt, anna.schmidt@nordlicht.example, IBAN DE89370400440532013000.');
    const base64 = file.toString('base64');

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Fasse die Rechnung zusammen.' },
            {
              type: 'file',
              file: {
                filename: 'Rechnung.docx',
                file_data: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${base64}`,
              },
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);

    const sent = harness.upstream.requests[0]?.body ?? '';

    // The bytes are gone.
    expect(sent).not.toContain(base64.slice(0, 64));
    expect(sent).not.toContain('file_data');

    // The text is there, and it is pseudonymised.
    expect(sent).toContain('--- attachment:');
    expect(sent).toContain('Rechnung an [NAME_1]');
    expect(sent).toContain('[EMAIL_1]');
    expect(sent).toContain('[IBAN_1]');
    expect(sent).not.toContain('Anna Schmidt');
    expect(sent).not.toContain('anna.schmidt@nordlicht.example');
    expect(sent).not.toContain('DE89370400440532013000');
  });

  it('pseudonymises a filename, which is personal data as often as the contents are', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    await harness.post('/v1/messages', {
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              title: 'Kuendigung Anna Schmidt.docx',
              source: {
                type: 'base64',
                media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                data: docx('Sehr geehrte Damen und Herren, hiermit kuendige ich.').toString('base64'),
              },
            },
          ],
        },
      ],
    });

    const sent = harness.upstream.requests[0]?.body ?? '';
    expect(sent).toContain('[NAME_1]');
    expect(sent).not.toContain('Anna Schmidt');
  });

  it('restores the real values in the reply, so the caller never sees a placeholder', async () => {
    harness = await startHarness({
      handler: () => ({
        body: JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Die Rechnung ist an [NAME_1].' } }],
        }),
      }),
      config: withAttachments(),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: { filename: 'r.docx', file_data: `data:application/octet-stream;base64,${docx('Rechnung an Anna Schmidt und Kollegen.').toString('base64')}` },
            },
          ],
        },
      ],
    });

    expect(await response.text()).toContain('Die Rechnung ist an Anna Schmidt.');
  });
});

describe('a document hushgate cannot read', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n');

  const pdfRequest = {
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Was steht da?' },
          {
            type: 'file',
            file: { filename: 'scan.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` },
          },
        ],
      },
    ],
  };

  it('refuses the request by default, and nothing reaches the upstream', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const response = await harness.post('/v1/chat/completions', pdfRequest);

    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { type: string; message: string } };
    expect(payload.error.type).toBe('hushgate_attachment_unreadable');
    expect(payload.error.message).toContain('application/pdf');
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('withholds it when told to, and says so in the prompt', async () => {
    harness = await startHarness({
      handler: reply,
      config: withAttachments({ onUnreadable: 'withhold' }),
    });

    const response = await harness.post('/v1/chat/completions', pdfRequest);
    expect(response.status).toBe(200);

    const sent = harness.upstream.requests[0]?.body ?? '';
    expect(sent).toContain('attachment withheld');
    expect(sent).toContain('Was steht da?');
    expect(sent).not.toContain(pdf.toString('base64'));
  });

  it('forwards it only when the operator has asked for exactly that', async () => {
    harness = await startHarness({
      handler: reply,
      config: withAttachments({ onUnreadable: 'forward' }),
    });

    const response = await harness.post('/v1/chat/completions', pdfRequest);
    expect(response.status).toBe(200);
    expect(harness.upstream.requests[0]?.body ?? '').toContain(pdf.toString('base64'));
  });

  it('refuses a remote URL rather than fetching it', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const response = await harness.post('/v1/messages', {
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'url', url: 'https://example.invalid/x.pdf' } }],
        },
      ],
    });

    expect(response.status).toBe(422);
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('refuses an attachment over the size limit before decoding it', async () => {
    harness = await startHarness({
      handler: reply,
      config: withAttachments({ maxBytes: 1024, maxTotalBytes: 4096 }),
    });

    const big = Buffer.alloc(64 * 1024, 0x41).toString('base64');
    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'file', file: { filename: 'big.txt', file_data: `data:text/plain;base64,${big}` } }] },
      ],
    });

    expect(response.status).toBe(422);
    expect(harness.upstream.requests).toHaveLength(0);
  });
});

const asAttachment = (text: string): unknown => ({
  model: 'gpt-4o',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          file: {
            filename: 'brief.txt',
            file_data: `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`,
          },
        },
      ],
    },
  ],
});

describe('a document whose spacing splits its identifiers', () => {
  /**
   * What ordinary PDF kerning does to an address block. A `TJ` array with an
   * offset every three glyphs is normal typesetting, and pdftotext turns it
   * into `E-M ail : a nna .sc hmi dt@ nor dli cht` — text with no short words
   * at all, fluent to every ratio, and matching no detector.
   *
   * The extractor here is a stub, so the test needs no poppler; the input is
   * the output poppler was measured producing.
   */
  const shredded =
    'Sac hbe arb eit eri n: Ann a S chm idt\n' +
    'E-M ail : a nna .sc hmi dt@ nor dli cht .ex amp le\n' +
    'IBA N: DE8 937 040 044 053 201 300 0';

  it('is refused, rather than forwarded with the address in clear', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const response = await harness.post('/v1/chat/completions', asAttachment(shredded));

    expect(response.status).toBe(422);
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('does not refuse the same letter set properly', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const clean =
      'Sachbearbeiterin: Anna Schmidt\n' +
      'E-Mail: anna.schmidt@nordlicht.example\n' +
      'IBAN: DE89370400440532013000';
    const response = await harness.post('/v1/chat/completions', asAttachment(clean));

    expect(response.status).toBe(200);
    const sent = harness.upstream.requests[0]?.body ?? '';
    expect(sent).toContain('[EMAIL_1]');
    expect(sent).not.toContain('anna.schmidt@nordlicht.example');
  });

  it('does not refuse a letter that merely contains a table of short codes', async () => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const table =
      'Sehr geehrte Damen und Herren, anbei die Auswertung des vergangenen Quartals.\n' +
      'Umsatz nach Land\nDE AT CH FR IT ES NL BE PL CZ\nDK SE NO FI PT IE GR HU RO BG\n' +
      'Mit freundlichen Gruessen, die Sachbearbeitung des Hauses Nordlicht.\n';
    const response = await harness.post('/v1/chat/completions', asAttachment(table));

    expect(response.status).toBe(200);
  });
});

describe('when attachment handling is off', () => {
  it('leaves the request exactly as it arrived', async () => {
    harness = await startHarness({
      handler: reply,
      config: withAttachments({ enabled: false }),
    });

    const data = docx('Anna Schmidt').toString('base64');
    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'file', file: { filename: 'x.docx', file_data: `data:application/octet-stream;base64,${data}` } }] },
      ],
    });

    expect(harness.upstream.requests[0]?.body ?? '').toContain(data);
  });
});

describe('separators that are invisible in the extracted text', () => {
  // A hand-picked list of these leaves gaps, and every gap is a working
  // separator: the character renders as nothing and the address matches
  // nothing. U+FE00 is a variation selector, which an earlier list missed.
  const SEPARATORS = ['​', '︀', '᠋', '⁥', 'ㅤ', '‪', '­'];

  it.each(SEPARATORS)('does not let %j hide an address', async (separator) => {
    harness = await startHarness({ handler: reply, config: withAttachments() });

    const hidden = `Kundin Anna Schmidt, ${[...'anna.schmidt@nordlicht.example'].join(separator)}`;
    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'x.txt',
                file_data: `data:text/plain;base64,${Buffer.from(hidden, 'utf8').toString('base64')}`,
              },
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    const sent = harness.upstream.requests[0]?.body ?? '';
    expect(sent).toContain('[EMAIL_1]');
    expect(sent).not.toContain('nordlicht.example');
  });
});

describe('a document cut at the character limit', () => {
  it('says so, in the prompt and in the report', async () => {
    harness = await startHarness({
      handler: reply,
      config: withAttachments({ maxTextChars: 100 }),
    });

    // The trailing whitespace matters: `tidy` strips it, and measuring
    // truncation after that would spend the headroom and record a document cut
    // to a third of itself as having been read in full.
    const long = `${'A'.repeat(120)}${'   '.repeat(40)}Anna Schmidt`;
    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'l.txt',
                file_data: `data:text/plain;base64,${Buffer.from(long, 'utf8').toString('base64')}`,
              },
            },
          ],
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(harness.upstream.requests[0]?.body ?? '').toContain('truncated by hushgate');
  });
});
