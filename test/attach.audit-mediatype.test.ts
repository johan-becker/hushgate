/**
 * The audit trail records categories and counts, never what a caller typed.
 * A media type is typed by the caller, so only the ones hushgate knows may be
 * reported; anything else is replaced by what the bytes were sniffed as.
 */
import { describe, expect, it } from 'vitest';
import { rewriteAttachments, type RewriteOptions } from '../src/attach/rewrite.js';
import { BUILTIN_EXTRACTORS } from '../src/attach/registry.js';
import { isKnownMediaType } from '../src/attach/sniff.js';
import { AttachmentBlockedError } from '../src/errors.js';

const limits = {
  enabled: true,
  maxBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxTextChars: 10_000,
  timeoutMs: 5_000,
  onUnreadable: 'withhold' as const,
};

const options = (overrides: Partial<RewriteOptions> = {}): RewriteOptions => ({
  limits,
  extractors: BUILTIN_EXTRACTORS,
  rules: ['messages.*.content.*.file.file_data', 'messages.*.content.*.text'],
  ...overrides,
});

const request = (mediaType: string, bytes: Buffer) => ({
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'file',
          file: { filename: 'a.bin', file_data: `data:${mediaType};base64,${bytes.toString('base64')}` },
        },
      ],
    },
  ],
});

const prose = Buffer.from('Sehr geehrte Damen und Herren, hiermit kuendige ich meinen Vertrag zum Monatsende.', 'utf8');
const noise = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 0, 0, 1]);

describe('audit media type', () => {
  it('replaces an unknown text type with the sniffed one in the report', async () => {
    const result = await rewriteAttachments(
      request('text/x-kuendigung.anna-schmidt', prose) as never,
      options(),
    );
    expect(JSON.stringify(result.reports)).not.toMatch(/anna|kuendigung/iu);
    expect(result.reports[0]?.mediaType).toBe('text/plain');
  });

  it('reports an unknown type on unreadable bytes as octet-stream, in the reason too', async () => {
    const result = await rewriteAttachments(
      request('application/x-anna-schmidt', noise) as never,
      options(),
    );
    expect(JSON.stringify(result.reports)).not.toMatch(/anna|schmidt/iu);
    expect(result.reports[0]?.mediaType).toBe('application/octet-stream');
  });

  it('keeps the unknown type out of a blocking error and its reports', async () => {
    const error = await rewriteAttachments(
      request('application/x-anna-schmidt', noise) as never,
      options({ limits: { ...limits, onUnreadable: 'block' } }),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AttachmentBlockedError);
    const blocked = error as AttachmentBlockedError;
    expect(JSON.stringify(blocked.reports)).not.toMatch(/anna/iu);
    expect(blocked.mediaType).not.toMatch(/anna/iu);
    expect(blocked.message).not.toMatch(/anna/iu);
  });

  it('keeps a known declared type as declared', async () => {
    const result = await rewriteAttachments(request('text/csv', Buffer.from('a;b\n1;2\n')) as never, options());
    expect(result.reports[0]?.mediaType).toBe('text/csv');
  });

  it('knows its own types and those of a configured extractor, and nothing else', () => {
    expect(isKnownMediaType('application/pdf')).toBe(true);
    expect(isKnownMediaType('TEXT/CSV; charset=utf-8')).toBe(true);
    expect(isKnownMediaType('application/x-anna-schmidt')).toBe(false);
    const config = { extractors: [{ mediaTypes: ['application/x-vendor'] }] };
    expect(isKnownMediaType('application/x-vendor', config)).toBe(true);
    expect(isKnownMediaType('application/x-vendor')).toBe(false);
  });
});
