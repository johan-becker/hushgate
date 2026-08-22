import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, nullAuditLog, parseAuditLines } from '../src/audit/log.js';
import { toRecord, type AuditEvent, type AuditRecord } from '../src/audit/record.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { replyJson, type FakeReply } from './helpers/fake-upstream.js';

const dirs: string[] = [];
let harness: Harness | undefined;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-audit-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  tenant: null,
  route: 'openai.chat.completions',
  outcome: 'forwarded',
  status: 200,
  latencyMs: 12,
  stream: false,
  upstream: 'api.openai.com',
  tokens: 0,
  findings: { EMAIL: 2 },
  policies: { EMAIL: 'pseudonymize' },
  residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'US', controls: [] },
  ...overrides,
});

function readRecords(path: string): AuditRecord[] {
  const { records, malformed } = parseAuditLines(readFileSync(path, 'utf8'));
  expect(malformed).toEqual([]);
  return records;
}

describe('record construction', () => {
  it('copies a fixed field list rather than whatever it was handed', () => {
    const smuggled = { ...event(), value: 'johan@example.com' } as AuditEvent;
    const record = toRecord(smuggled, '2026-01-01T00:00:00.000Z', 'id-1');
    expect(Object.keys(record).toSorted()).toEqual([
      'findings',
      'id',
      'latencyMs',
      'outcome',
      'policies',
      'residency',
      'route',
      'status',
      'stream',
      'tenant',
      'tokens',
      'ts',
      'upstream',
    ]);
    expect(JSON.stringify(record)).not.toContain('johan@example.com');
  });

  it('keeps only numeric counts', () => {
    const record = toRecord(
      event({ findings: { EMAIL: 1, IBAN: 'DE89' as unknown as number } }),
      '2026-01-01T00:00:00.000Z',
      'id-1',
    );
    expect(record.findings).toEqual({ EMAIL: 1 });
  });
});

describe('JsonlAuditLog', () => {
  it('appends one JSON object per line', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const log = new JsonlAuditLog({ path });
    log.write(event());
    log.write(event({ outcome: 'blocked', status: 403 }));
    await log.close();

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(readRecords(path).map((record) => record.outcome)).toEqual(['forwarded', 'blocked']);
  });

  it('appends to an existing file instead of truncating it', async () => {
    const path = join(workspace(), 'audit.jsonl');

    const first = new JsonlAuditLog({ path });
    first.write(event());
    await first.close();

    const second = new JsonlAuditLog({ path });
    second.write(event());
    await second.close();

    expect(readRecords(path)).toHaveLength(2);
  });

  it('creates the directory the trail lives in', async () => {
    const path = join(workspace(), 'nested', 'deeper', 'audit.jsonl');
    const log = new JsonlAuditLog({ path });
    log.write(event());
    await log.close();
    expect(readRecords(path)).toHaveLength(1);
  });

  it('stamps a timestamp and a unique id', async () => {
    const path = join(workspace(), 'audit.jsonl');
    let counter = 0;
    const log = new JsonlAuditLog({
      path,
      now: () => new Date('2026-03-04T05:06:07.008Z'),
      id: () => `id-${++counter}`,
    });
    log.write(event());
    log.write(event());
    await log.close();

    const records = readRecords(path);
    expect(records[0]!.ts).toBe('2026-03-04T05:06:07.008Z');
    expect(records.map((record) => record.id)).toEqual(['id-1', 'id-2']);
  });

  it('does nothing at all when disabled', async () => {
    nullAuditLog.write(event());
    await expect(nullAuditLog.close()).resolves.toBeUndefined();
  });
});

describe('parseAuditLines', () => {
  it('reports the line number of anything unreadable', () => {
    const { records, malformed } = parseAuditLines('{"ts":"t","route":"r"}\nnot json\n\n{}\n');
    expect(records).toHaveLength(1);
    expect(malformed).toEqual([
      { line: 2, reason: expect.any(String) },
      { line: 4, reason: 'missing ts or route' },
    ]);
  });
});

describe('the proxy trail', () => {
  const secrets = {
    email: 'johan@example.com',
    iban: 'DE89370400440532013000',
    key: 'sk-abcdefghijklmnopqrstuvwx',
  };

  async function serveWithAudit(
    path: string,
    options: Parameters<typeof startHarness>[0] = {},
  ): Promise<{ log: JsonlAuditLog }> {
    const log = new JsonlAuditLog({ path });
    harness = await startHarness({ ...options, proxy: { audit: log, ...options.proxy } });
    return { log };
  }

  it('records counts, policies and latency for a forwarded request', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path, {
      handler: replyJson({ choices: [{ message: { content: 'ok' } }] }),
    });

    await harness!.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: `${secrets.email} und ${secrets.iban}` },
        { role: 'user', content: secrets.email },
      ],
    });
    await log.close();

    const [record] = readRecords(path);
    expect(record!.route).toBe('openai.chat.completions');
    expect(record!.outcome).toBe('forwarded');
    expect(record!.status).toBe(200);
    expect(record!.findings).toEqual({ EMAIL: 2, IBAN: 1 });
    expect(record!.policies).toEqual({ EMAIL: 'pseudonymize', IBAN: 'pseudonymize' });
    expect(record!.upstream).toBe(new URL(harness!.upstream.origin).host);
    expect(record!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(record!.stream).toBe(false);
  });

  it('never writes a raw value, whatever the request contained', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path);

    await harness!.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: `${secrets.email} ${secrets.iban} ${secrets.key} 4111111111111111 +49 721 1234567`,
        },
      ],
    });
    await log.close();

    const raw = readFileSync(path, 'utf8');
    for (const value of [...Object.values(secrets), '4111111111111111', '721 1234567']) {
      expect(raw).not.toContain(value);
    }
    // What it does contain is categories and counts.
    expect(readRecords(path)[0]!.findings['SECRET']).toBe(1);
  });

  it('records a blocked request, with nothing reached upstream', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path, {
      config: (base) => ({
        ...base,
        redaction: { ...base.redaction, policies: { SECRET: 'block' } },
      }),
    });

    const response = await harness!.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: secrets.key }],
    });
    expect(response.status).toBe(403);
    await log.close();

    const [record] = readRecords(path);
    expect(record!.outcome).toBe('blocked');
    expect(record!.status).toBe(403);
    expect(record!.upstream).toBeNull();
    expect(record!.findings).toEqual({ SECRET: 1 });
    expect(record!.policies).toEqual({ SECRET: 'block' });
    expect(readFileSync(path, 'utf8')).not.toContain(secrets.key);
  });

  it('records a rejected request that never reached redaction', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path);

    await harness!.post('/v1/chat/completions', 'not json');
    await log.close();

    const [record] = readRecords(path);
    expect(record!.outcome).toBe('rejected');
    expect(record!.status).toBe(400);
    expect(record!.findings).toEqual({});
  });

  it('records an upstream failure as failed', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path, {
      config: (base) => ({
        ...base,
        upstreams: { openai: 'http://127.0.0.1:1', anthropic: 'http://127.0.0.1:1' },
      }),
    });

    await harness!.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    await log.close();

    const [record] = readRecords(path);
    expect(record!.outcome).toBe('failed');
    expect(record!.status).toBe(502);
  });

  it('records a streamed response once the stream has finished', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path, {
      handler: (): FakeReply => ({
        headers: { 'content-type': 'text/event-stream' },
        body: '',
        chunks: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n'],
      }),
    });

    const response = await harness!.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: secrets.email }],
    });
    await response.text();
    await log.close();

    const [record] = readRecords(path);
    expect(record!.stream).toBe(true);
    expect(record!.findings).toEqual({ EMAIL: 1 });
  });

  it('writes one record per request, in order', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = await serveWithAudit(path);

    for (const content of ['a@x.de', 'plain', 'b@x.de']) {
      // oxlint-disable-next-line no-await-in-loop
      await harness!.post('/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content }],
      });
    }
    await log.close();

    const records = readRecords(path);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.findings['EMAIL'] ?? 0)).toEqual([1, 0, 1]);
  });
});
