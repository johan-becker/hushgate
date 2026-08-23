import { describe, expect, it } from 'vitest';
import { base64DecodedLength, decodeBase64, parseDataUrl } from '../src/attach/decode.js';
import { findAttachmentSites } from '../src/attach/shapes.js';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

describe('data URLs', () => {
  it('splits media type, encoding and payload', () => {
    expect(parseDataUrl('data:application/pdf;base64,JVBERi0=')).toEqual({
      mediaType: 'application/pdf',
      base64: true,
      payload: 'JVBERi0=',
    });
  });

  it('accepts a data URL with no media type', () => {
    expect(parseDataUrl('data:;base64,QQ==')?.mediaType).toBe(null);
  });

  it('returns null for anything that is not one, so a remote URL is refused not parsed', () => {
    expect(parseDataUrl('https://example.com/x.pdf')).toBe(null);
    expect(parseDataUrl('data:no-comma')).toBe(null);
  });
});

describe('base64 sizing', () => {
  it('computes the decoded length without decoding', () => {
    expect(base64DecodedLength(b64('hello'))).toBe(5);
    expect(base64DecodedLength(b64('a'.repeat(1000)))).toBe(1000);
  });

  it('ignores the line breaks real encoders insert', () => {
    const wrapped = b64('a'.repeat(300)).replace(/(.{76})/g, '$1\n');
    expect(base64DecodedLength(wrapped)).toBe(300);
  });

  it('rejects a payload before allocating it', () => {
    const result = decodeBase64(b64('a'.repeat(5000)), 1000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.oversize).toBe(true);
      expect(result.reason).toContain('over the');
    }
  });

  it('rejects data that only looks like base64', () => {
    // Buffer.from is lenient and would silently return short output.
    const result = decodeBase64('!!!!not base64 at all!!!!', 1024);
    expect(result.ok).toBe(false);
  });
});

describe('finding Anthropic attachments', () => {
  it('finds a base64 document block', () => {
    const sites = findAttachmentSites({
      model: 'claude-3',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'here is the invoice' },
            {
              type: 'document',
              title: 'Rechnung.pdf',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
            },
          ],
        },
      ],
    });

    expect(sites).toHaveLength(1);
    expect(sites[0]?.path).toEqual(['messages', 0, 'content', 1]);
    expect(sites[0]?.declaredMediaType).toBe('application/pdf');
    expect(sites[0]?.filename).toBe('Rechnung.pdf');
    expect(sites[0]?.data).toBe('JVBERi0=');
  });

  it('refuses a URL source rather than fetching it', () => {
    const sites = findAttachmentSites({
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://x/y.pdf' } }] },
      ],
    });
    expect(sites[0]?.unresolvable).toContain('will not fetch');
    expect(sites[0]?.data).toBe(null);
  });

  it('refuses a provider file id', () => {
    const sites = findAttachmentSites({
      messages: [
        { role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: 'file_1' } }] },
      ],
    });
    expect(sites[0]?.unresolvable).toContain('provider file id');
  });

  it('treats a text source as an attachment, not as prose', () => {
    const sites = findAttachmentSites({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Anna Schmidt' } },
          ],
        },
      ],
    });
    expect(sites).toHaveLength(1);
    expect(Buffer.from(sites[0]?.data ?? '', 'base64').toString('utf8')).toBe('Anna Schmidt');
  });

  it('finds a document quoted back inside a tool_result', () => {
    const sites = findAttachmentSites({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
              ],
            },
          ],
        },
      ],
    });
    expect(sites).toHaveLength(1);
    expect(sites[0]?.path).toEqual(['messages', 0, 'content', 0, 'content', 0]);
  });
});

describe('finding OpenAI attachments', () => {
  it('finds a file part carrying a data URL', () => {
    const sites = findAttachmentSites({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: { filename: 'vertrag.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' },
            },
          ],
        },
      ],
    });
    expect(sites[0]?.declaredMediaType).toBe('application/pdf');
    expect(sites[0]?.filename).toBe('vertrag.pdf');
    expect(sites[0]?.data).toBe('JVBERi0=');
  });

  it('finds an inline image_url', () => {
    const sites = findAttachmentSites({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }],
        },
      ],
    });
    expect(sites[0]?.data).toBe('iVBOR');
  });

  it('refuses a remote image_url', () => {
    const sites = findAttachmentSites({
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      ],
    });
    expect(sites[0]?.unresolvable).toContain('will not fetch');
  });

  it('refuses audio, which hushgate cannot transcribe', () => {
    const sites = findAttachmentSites({
      messages: [
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } }] },
      ],
    });
    expect(sites[0]?.unresolvable).toContain('transcribed');
  });
});

describe('what the walk deliberately ignores', () => {
  it('leaves ordinary text parts alone', () => {
    expect(
      findAttachmentSites({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'no attachment here' }] }],
      }),
    ).toEqual([]);
  });

  it('does not walk configuration keys, only the conversation', () => {
    // A tool schema cannot hold a document, and walking it would be attack
    // surface for nothing.
    expect(
      findAttachmentSites({
        tools: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }],
        metadata: { type: 'document', source: { type: 'base64', data: 'AAA' } },
      }),
    ).toEqual([]);
  });

  it('stops descending at an attachment so its source is not matched twice', () => {
    const sites = findAttachmentSites({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
            },
          ],
        },
      ],
    });
    expect(sites).toHaveLength(1);
  });

  it('survives a body nested past the depth guard without throwing', () => {
    let deep: unknown = { type: 'text', text: 'x' };
    for (let index = 0; index < 200; index += 1) deep = { content: [deep] };
    expect(() => findAttachmentSites({ messages: [deep] })).not.toThrow();
  });
});
