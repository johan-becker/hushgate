import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, parseAuditLines } from '../src/audit/log.js';
import { buildReport, renderMarkdown, withinPeriod } from '../src/audit/report.js';
import type { AuditEvent, AuditRecord } from '../src/audit/record.js';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { defaultConfig, parseConfig, type HushgateConfig } from '../src/config.js';

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-report-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function capture(argv: string[], cwd: string): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: { argv, stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  tenant: null,
  route: 'openai.chat.completions',
  outcome: 'forwarded',
  status: 200,
  latencyMs: 40,
  stream: false,
  upstream: 'api.mistral.ai',
  tokens: 100,
  findings: { EMAIL: 2 },
  policies: { EMAIL: 'pseudonymize' },
  residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'FR', controls: [] },
  ...overrides,
});

/** Build a trail with controlled timestamps. */
async function writeTrail(dir: string, events: { at: string; event: AuditEvent }[]): Promise<string> {
  const path = join(dir, 'hushgate-audit.jsonl');
  let index = 0;
  const log = new JsonlAuditLog({
    path,
    now: () => new Date(events[index]!.at),
    id: () => `id-${index}`,
  });
  for (const entry of events) {
    log.write(entry.event);
    index += 1;
  }
  await log.close();
  return path;
}

function readRecords(path: string): AuditRecord[] {
  return parseAuditLines(readFileSync(path, 'utf8')).records;
}

const CONFIG: HushgateConfig = parseConfig({
  organisation: {
    name: 'Acme GmbH',
    contact: 'datenschutz@acme.example',
    dpo: 'A. Datenschutz',
    purposes: ['Customer support drafting', 'Internal summarisation'],
  },
  residency: {
    allow: [
      {
        endpoint: 'https://api.mistral.ai',
        jurisdiction: 'FR',
        legalBasis: 'Art. 28 DPA of 2026-01-12, processing in France',
      },
    ],
  },
});

describe('withinPeriod', () => {
  const records = [
    { ts: '2026-03-01T10:00:00.000Z' },
    { ts: '2026-03-15T10:00:00.000Z' },
    { ts: '2026-04-01T10:00:00.000Z' },
  ] as AuditRecord[];

  it('includes both end days', () => {
    expect(withinPeriod(records, { from: '2026-03-01', to: '2026-03-15' })).toHaveLength(2);
  });

  it('treats an open end as unbounded', () => {
    expect(withinPeriod(records, { from: null, to: '2026-03-01' })).toHaveLength(1);
    expect(withinPeriod(records, { from: '2026-03-15', to: null })).toHaveLength(2);
    expect(withinPeriod(records, { from: null, to: null })).toHaveLength(3);
  });
});

describe('buildReport', () => {
  it('summarises volumes, categories, recipients and tenants', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      { at: '2026-03-02T08:00:00.000Z', event: event({ tenant: 'support' }) },
      {
        at: '2026-03-02T09:00:00.000Z',
        event: event({
          tenant: 'support',
          findings: { EMAIL: 1, IBAN: 3 },
          policies: { EMAIL: 'pseudonymize', IBAN: 'hash' },
          tokens: 250,
        }),
      },
      {
        at: '2026-03-03T09:00:00.000Z',
        event: event({
          tenant: 'research',
          outcome: 'blocked',
          status: 403,
          upstream: null,
          tokens: 0,
          findings: { SECRET: 1 },
          policies: { SECRET: 'block' },
        }),
      },
    ]);

    const report = buildReport(readRecords(path), { source: path, config: CONFIG });

    expect(report.volumes.requests).toBe(3);
    expect(report.volumes.tokens).toBe(350);
    expect(report.volumes.byOutcome).toEqual({ forwarded: 2, blocked: 1 });
    expect(report.volumes.byRoute).toEqual({ 'openai.chat.completions': 3 });

    expect(report.categories[0]).toMatchObject({ kind: 'EMAIL', findings: 3, requests: 2 });
    expect(report.categories.find((row) => row.kind === 'IBAN')?.policies).toEqual(['hash']);

    // The blocked request reached no recipient, which is the point of it.
    expect(report.recipients).toHaveLength(1);
    expect(report.recipients[0]).toMatchObject({
      host: 'api.mistral.ai',
      jurisdiction: 'FR',
      status: 'eea',
      requests: 2,
      tokens: 350,
      legalBasis: 'Art. 28 DPA of 2026-01-12, processing in France',
    });

    expect(report.tenants).toEqual([
      { id: 'support', requests: 2, tokens: 350 },
      { id: 'research', requests: 1, tokens: 0 },
    ]);
  });

  it('respects the period, but verifies the whole chain', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      { at: '2026-02-27T08:00:00.000Z', event: event() },
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-04-02T08:00:00.000Z', event: event() },
    ]);

    const report = buildReport(readRecords(path), {
      source: path,
      config: CONFIG,
      period: { from: '2026-03-01', to: '2026-03-31' },
    });

    expect(report.volumes.requests).toBe(1);
    expect(report.chain.records).toBe(3);
    expect(report.chain.ok).toBe(true);
  });

  it('reports a missing safeguard as missing', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({
          upstream: 'api.openai.com',
          residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'US', controls: [] },
        }),
      },
    ]);

    const report = buildReport(readRecords(path), { source: path, config: CONFIG });
    expect(report.recipients[0]).toMatchObject({ status: 'third-country', legalBasis: null });
  });
});

describe('renderMarkdown', () => {
  it('produces a document an auditor can read', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      { at: '2026-03-02T08:00:00.000Z', event: event({ tenant: 'support' }) },
    ]);

    const markdown = renderMarkdown(
      buildReport(readRecords(path), { source: path, config: CONFIG }),
    );

    expect(markdown).toContain('# Record of processing activities');
    expect(markdown).toContain('Acme GmbH');
    expect(markdown).toContain('Customer support drafting');
    expect(markdown).toContain('| EMAIL | 2 | 1 | pseudonymize |');
    expect(markdown).toContain('api.mistral.ai');
    expect(markdown).toContain('within EEA');
    expect(markdown).toContain('Art. 28 DPA of 2026-01-12');
    expect(markdown).toContain('intact over 1 records');
    expect(markdown).toContain('not legal advice');
  });

  it('says what is missing instead of inventing it', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const markdown = renderMarkdown(
      buildReport(readRecords(path), { source: path, config: defaultConfig() }),
    );

    expect(markdown).toContain('not recorded (set organisation.name)');
    expect(markdown).toContain('hushgate cannot know why you process this data');
    expect(markdown).toContain('**none recorded**');
  });

  it('flags a broken chain in the document itself', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-03-02T09:00:00.000Z', event: event() },
    ]);

    const records = readRecords(path);
    records[1] = { ...records[1]!, tokens: 999_999 };

    const markdown = renderMarkdown(buildReport(records, { source: path, config: CONFIG }));
    expect(markdown).toContain('**BROKEN at record 2**');
  });
});

describe('hushgate audit', () => {
  it('verifies an intact trail and prints the head', async () => {
    const dir = workspace();
    await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const c = capture(['audit', 'verify'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('chain        intact');
    expect(c.out()).toMatch(/head {9}[0-9a-f]{64}/u);
    expect(c.out()).toContain('Anchor the head hash outside hushgate');
  });

  it('fails and names the first broken record', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-03-02T09:00:00.000Z', event: event({ tokens: 10 }) },
      { at: '2026-03-02T10:00:00.000Z', event: event() },
    ]);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines[1] = lines[1]!.replace('"tokens":10', '"tokens":10000');
    writeFileSync(path, `${lines.join('\n')}\n`);

    const c = capture(['audit', 'verify'], dir);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('chain        BROKEN');
    expect(c.out()).toContain('record 2 (altered)');
  });

  it('reports an unreadable line', async () => {
    const dir = workspace();
    const path = await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{ not json\n`);

    const c = capture(['audit', 'verify'], dir);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('unreadable   line 2');
  });

  it('verifies as JSON for CI', async () => {
    const dir = workspace();
    await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const c = capture(['audit', 'verify', '--json'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    const result = JSON.parse(c.out()) as { ok: boolean; records: number; head: string };
    expect(result).toMatchObject({ ok: true, records: 1 });
    expect(result.head).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reports over a period, in Markdown by default', async () => {
    const dir = workspace({
      'hushgate.config.json': JSON.stringify({
        organisation: { name: 'Acme GmbH', purposes: ['Support drafting'] },
      }),
    });
    await writeTrail(dir, [
      { at: '2026-02-01T08:00:00.000Z', event: event() },
      { at: '2026-03-02T08:00:00.000Z', event: event() },
    ]);

    const c = capture(['audit', 'report', '--from', '2026-03-01', '--to', '2026-03-31'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('# Record of processing activities');
    expect(c.out()).toContain('Acme GmbH');
    expect(c.out()).toContain('Requests: **1**');
  });

  it('reports as JSON when asked', async () => {
    const dir = workspace();
    await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const c = capture(['audit', 'report', '--json'], dir);
    await run(c.cli);
    const report = JSON.parse(c.out()) as { volumes: { requests: number } };
    expect(report.volumes.requests).toBe(1);
  });

  it('rejects a malformed date', async () => {
    const dir = workspace();
    await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const c = capture(['audit', 'report', '--from', 'March'], dir);
    // A malformed flag value is a usage error: exit 2, not 1.
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('YYYY-MM-DD');
  });

  it('needs a subcommand, and says which ones exist', async () => {
    const dir = workspace();
    await writeTrail(dir, [{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const c = capture(['audit'], dir);
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('verify');
    expect(c.err()).toContain('report');
  });

  it('fails clearly when the trail does not exist', async () => {
    const c = capture(['audit', 'verify'], workspace());
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('cannot read the audit trail');
  });
});
