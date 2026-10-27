/**
 * The proxy has to tell the attachment rewrite which media types the
 * operator's extractors claim. Without that, a document read by a configured
 * extractor is recorded in the trail as `application/octet-stream` — true of
 * its bytes, and useless to an auditor asking what was processed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditSink } from '../src/audit/log.js';
import type { AuditEvent } from '../src/audit/record.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

const reply = (): { body: string } => ({
  body: JSON.stringify({ id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
});

/** An extractor for a vendor format: node itself, reading stdin and printing fixed text. */
const LEDGER_EXTRACTOR = {
  mediaTypes: ['application/x-acme-ledger'],
  formats: [],
  command: process.execPath,
  args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('Ledger entry 42, booked.'))"],
  timeoutMs: 10_000,
};

function recording(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    sink: {
      write: (event) => events.push(event),
      close: () => Promise.resolve(),
    },
  };
}

describe('the media type the trail records for an attachment', () => {
  it('is the declared one when a configured extractor claims it', async () => {
    const audit = recording();
    harness = await startHarness({
      handler: reply,
      config: (base) => ({
        ...base,
        attachments: { ...base.attachments, onUnreadable: 'withhold', extractors: [LEDGER_EXTRACTOR] },
      }),
      proxy: { audit: audit.sink },
    });

    const bytes = Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 0, 0, 1]);
    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'ledger.bin',
                file_data: `data:application/x-acme-ledger;base64,${bytes.toString('base64')}`,
              },
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(200);
    await response.text();

    expect(audit.events).toHaveLength(1);
    const [attachment] = audit.events[0]!.attachments ?? [];
    expect(attachment?.mediaType).toBe('application/x-acme-ledger');
    expect(attachment?.extractor).toMatch(/^external\./u);
  });
});
