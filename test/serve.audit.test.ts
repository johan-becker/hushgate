/**
 * `hushgate serve` and the audit trails it keeps.
 *
 * What is under test here is the wiring rather than the writer: which files
 * get a sink, that one file never gets two, that a trail which cannot be
 * opened stops the proxy before it binds, and that the operator is told where
 * each chain stood when it was opened and where it ended.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, type AuditSink } from '../src/audit/log.js';
import { GENESIS_HASH, type AuditEvent, type AuditRecord } from '../src/audit/record.js';
import { parseAuditLines } from '../src/audit/trail.js';
import { verifyChain } from '../src/audit/verify.js';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { Metrics } from '../src/metrics/registry.js';
import { defaultResidencyConfig, evaluateUpstream } from '../src/residency/policy.js';
import { hashKey } from '../src/tenants/tenant.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { waitFor } from './helpers/wait.js';

const dirs: string[] = [];
let upstream: FakeUpstream | undefined;
let harness: Harness | undefined;

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-serve-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await upstream?.close();
  upstream = undefined;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function capture(argv: string[], overrides: Partial<Cli> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      cwd: process.cwd(),
      ...overrides,
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

interface Running {
  readonly origin: string;
  readonly output: Capture;
  /** Stop serve as Ctrl-C would, and return its exit code. */
  stop(): Promise<number>;
}

/** Start `hushgate serve` in `dir` and wait for its banner. */
async function serve(dir: string, argv: string[] = []): Promise<Running> {
  const controller = new AbortController();
  const output = capture(['serve', ...argv], { cwd: dir, signal: controller.signal });
  const finished = run(output.cli);

  await waitFor(() => output.out().includes('listening on'), { what: 'the startup banner' });
  const origin = /listening on (\S+)/u.exec(output.out())![1]!;

  return {
    origin,
    output,
    stop(): Promise<number> {
      controller.abort();
      return finished;
    },
  };
}

function chat(origin: string, key: string | null): Promise<Response> {
  return fetch(`${origin}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'mail a@x.de' }] }),
  });
}

function readRecords(path: string): AuditRecord[] {
  const { records, malformed } = parseAuditLines(readFileSync(path, 'utf8'));
  expect(malformed).toEqual([]);
  return records;
}

const tenant = (id: string, path?: string): Record<string, unknown> => ({
  id,
  keyHash: `sha256:${hashKey(`hg_${id}`)}`,
  ...(path === undefined ? {} : { audit: { path } }),
});

function config(origin: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ port: 0, upstreams: { openai: origin, anthropic: origin }, ...extra });
}

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  tenant: null,
  route: 'openai.chat.completions',
  outcome: 'forwarded',
  status: 200,
  latencyMs: 12,
  stream: false,
  upstream: 'api.openai.com',
  tokens: 0,
  findings: { EMAIL: 1 },
  policies: { EMAIL: 'pseudonymize' },
  residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'US', controls: [] },
  ...overrides,
});

describe('one file, one chain', () => {
  it('shares the global trail with tenants that name the same file, however it is spelled', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    // A second name for the same directory: the path differs as a string and
    // matches as a file.
    symlinkSync(dir, join(dir, 'alias'));
    writeFileSync(
      join(dir, 'hushgate.config.json'),
      config(upstream.origin, {
        tenants: [
          tenant('acme', './hushgate-audit.jsonl'),
          tenant('beta', 'alias/hushgate-audit.jsonl'),
        ],
      }),
    );

    const proxy = await serve(dir);
    expect((await chat(proxy.origin, 'hg_acme')).status).toBe(200);
    expect((await chat(proxy.origin, null)).status).toBe(401);
    expect((await chat(proxy.origin, 'hg_beta')).status).toBe(200);
    expect((await chat(proxy.origin, 'hg_acme')).status).toBe(200);
    expect(await proxy.stop()).toBe(EXIT.ok);

    const records = readRecords(join(dir, 'hushgate-audit.jsonl'));
    // Interleaved writers on one file, and still a single unbroken chain.
    expect(verifyChain(records)).toMatchObject({ ok: true, records: 4, firstBreak: null });
    // Sharing a file does not mean sharing an identity.
    expect(records.map((record) => record.tenant)).toEqual(['acme', null, 'beta', 'acme']);
    // And the banner lists the file once.
    expect(proxy.output.out()).toContain(`${join(dir, 'hushgate-audit.jsonl')} (global) — starting a new trail`);
    expect(proxy.output.out()).not.toContain('alias');
  });

  it('gives tenants that share a file of their own one chain, labelled by both', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    writeFileSync(
      join(dir, 'hushgate.config.json'),
      config(upstream.origin, { tenants: [tenant('b', './team.jsonl'), tenant('a', 'team.jsonl')] }),
    );

    const proxy = await serve(dir);
    await chat(proxy.origin, 'hg_a');
    await chat(proxy.origin, 'hg_b');
    await chat(proxy.origin, 'hg_a');

    const metrics = await (
      await fetch(`${proxy.origin}/metrics`, { headers: { authorization: 'Bearer hg_a' } })
    ).text();
    expect(await proxy.stop()).toBe(EXIT.ok);

    const records = readRecords(join(dir, 'team.jsonl'));
    expect(verifyChain(records).ok).toBe(true);
    expect(records.map((record) => record.tenant)).toEqual(['a', 'b', 'a']);

    expect(proxy.output.out()).toContain(`${join(dir, 'team.jsonl')} (a,b) — starting a new trail`);
    expect(metrics).toContain('# TYPE hushgate_audit_dropped_records_total counter');
    expect(metrics).toContain('hushgate_audit_dropped_records_total{trail="global"} 0');
    expect(metrics).toContain('hushgate_audit_dropped_records_total{trail="a,b"} 0');
  });
});

describe('a trail that cannot be opened', () => {
  it('stops serve before it binds, naming the file', async () => {
    const dir = workspace({ blocker: 'a regular file, where a directory was expected' });
    const c = capture(['serve', '--port', '0', '--audit', 'blocker/audit.jsonl'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain(`cannot open the audit trail ${join(dir, 'blocker', 'audit.jsonl')}`);
    expect(c.out()).not.toContain('listening on');
  });

  it('stops serve when only a tenant trail is the problem', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace({ blocker: 'a regular file' });
    writeFileSync(
      join(dir, 'hushgate.config.json'),
      config(upstream.origin, { tenants: [tenant('acme', 'blocker/acme.jsonl')] }),
    );
    const c = capture(['serve'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain(`cannot open the audit trail ${join(dir, 'blocker', 'acme.jsonl')}`);
    expect(c.out()).not.toContain('listening on');
  });
});

describe('telling the operator where each chain stands', () => {
  it('continues an existing chain, says so, and prints the head it ends on', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    writeFileSync(join(dir, 'hushgate.config.json'), config(upstream.origin));
    const path = join(dir, 'hushgate-audit.jsonl');

    const earlier = new JsonlAuditLog({ path });
    earlier.write(event());
    earlier.write(event());
    const head = earlier.headHash;
    await earlier.close();

    const proxy = await serve(dir);
    expect(proxy.output.out()).toContain(`  audit      ${path} — continuing chain from ${head.slice(0, 12)}\n`);

    await chat(proxy.origin, null);
    expect(await proxy.stop()).toBe(EXIT.ok);

    const records = readRecords(path);
    expect(verifyChain(records)).toMatchObject({ ok: true, records: 3 });
    const last = records.at(-1)!;
    // The full head, after the sinks have closed: the line an operator anchors.
    const shutdown = proxy.output.out().slice(proxy.output.out().indexOf('shutting down'));
    expect(shutdown).toContain(`${path} head ${last.hash}`);
  });

  it('says a trail with no file yet is new', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    writeFileSync(join(dir, 'hushgate.config.json'), config(upstream.origin));
    const path = join(dir, 'hushgate-audit.jsonl');

    const proxy = await serve(dir);
    expect(proxy.output.out()).toContain(`  audit      ${path} — starting a new trail\n`);
    expect(await proxy.stop()).toBe(EXIT.ok);
    // Worth anchoring all the same, since verify finds it at the start of the
    // chain, but not to be read as the hash of a record.
    expect(proxy.output.out()).toContain(`${path} head ${GENESIS_HASH} (no records yet)\n`);
  });

  it('says on the way out how many lost records no record in the trail counts', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    writeFileSync(join(dir, 'hushgate.config.json'), config(upstream.origin));
    const path = join(dir, 'hushgate-audit.jsonl');

    const proxy = await serve(dir);
    await (await chat(proxy.origin, null)).text();
    const head = readRecords(path)[0]!.hash;

    // The trail becomes impossible to write: the next record is lost, and
    // hushgate stops before another one could carry the count.
    rmSync(path);
    mkdirSync(path);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void errors.push(args);
    try {
      expect((await chat(proxy.origin, null)).status).toBe(200);
      expect(await proxy.stop()).toBe(EXIT.ok);
    } finally {
      console.error = original;
    }

    expect(errors.length).toBeGreaterThan(0);
    expect(proxy.output.out()).toContain(
      `${path} head ${head} (1 record could not be written, 1 of them not counted in the trail)\n`,
    );
  });

  it('does not pass off a trail whose last record is unreadable as a new one', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace({ 'hushgate-audit.jsonl': 'not a record\n' });
    writeFileSync(join(dir, 'hushgate.config.json'), config(upstream.origin));

    const proxy = await serve(dir);
    expect(proxy.output.out()).toContain('last record unreadable, starting a new chain');
    expect(proxy.output.out()).not.toContain('starting a new trail');
    expect(await proxy.stop()).toBe(EXIT.ok);
  });

  it('says auditing is disabled, and prints no head', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace();
    writeFileSync(join(dir, 'hushgate.config.json'), config(upstream.origin));

    const proxy = await serve(dir, ['--no-audit']);
    expect(proxy.output.out()).toContain('  audit      disabled\n');
    expect(await proxy.stop()).toBe(EXIT.ok);
    expect(proxy.output.out()).not.toContain(' head ');
  });
});

describe('the dropped-records metric', () => {
  it('reads each trail when rendered, starting from zero', () => {
    const metrics = new Metrics();
    const global = { droppedRecords: 0 };
    metrics.watchAuditTrail('global', global);
    metrics.watchAuditTrail('support', { droppedRecords: 0 });

    const before = metrics.render();
    expect(before).toContain(
      '# HELP hushgate_audit_dropped_records_total Audit records that could not be written, by trail.',
    );
    expect(before).toContain('# TYPE hushgate_audit_dropped_records_total counter');
    expect(before).toContain('hushgate_audit_dropped_records_total{trail="global"} 0');
    expect(before).toContain('hushgate_audit_dropped_records_total{trail="support"} 0');

    global.droppedRecords = 3;
    expect(metrics.render()).toContain('hushgate_audit_dropped_records_total{trail="global"} 3');
  });
});

/** A sink that keeps the events it is handed, before any record is built from them. */
function capturing(): { sink: AuditSink; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    sink: {
      write: (recorded): void => {
        events.push(recorded);
      },
      close: (): Promise<void> => Promise.resolve(),
    },
  };
}

describe('which allowlist entry admitted a request', () => {
  it('names the endpoint as configured, even when two entries share a host', async () => {
    const { sink, events } = capturing();
    let gateway = '';
    harness = await startHarness({
      config: (base, origin) => {
        gateway = origin;
        return {
          ...base,
          upstreams: { openai: `${origin}/gw/openai`, anthropic: `${origin}/gw/anthropic` },
          residency: {
            ...base.residency,
            allow: [
              { endpoint: `${origin}/gw/openai`, jurisdiction: 'US', legalBasis: 'OpenAI DPA', note: null },
              { endpoint: `${origin}/gw/anthropic`, jurisdiction: 'US', legalBasis: 'Anthropic DPA', note: null },
            ],
          },
        };
      },
      proxy: { audit: sink },
    });

    await harness.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
    });
    await harness.post('/v1/messages', {
      model: 'm',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(events.map((recorded) => recorded.residency?.endpoint)).toEqual([
      `${gateway}/gw/openai`,
      `${gateway}/gw/anthropic`,
    ]);
    // One host for both, which is exactly why the host could not say.
    expect(new Set(events.map((recorded) => recorded.upstream)).size).toBe(1);
  });

  it('records null when no allowlist is configured', async () => {
    const { sink, events } = capturing();
    harness = await startHarness({ proxy: { audit: sink } });

    await harness.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.residency).toMatchObject({ endpoint: null });
  });

  it('is decided by the residency verdict', () => {
    const allow = [
      { endpoint: 'https://gw.example/acct/openai', jurisdiction: 'US', legalBasis: 'OpenAI DPA', note: null },
      { endpoint: 'https://gw.example/acct/anthropic', jurisdiction: 'US', legalBasis: 'Anthropic DPA', note: null },
    ];
    const residency = { ...defaultResidencyConfig(), allow };

    expect(evaluateUpstream('https://gw.example/acct/anthropic', residency).endpoint).toBe(
      'https://gw.example/acct/anthropic',
    );
    expect(evaluateUpstream('https://elsewhere.example', residency).endpoint).toBeNull();
    expect(evaluateUpstream('https://gw.example/acct/openai', defaultResidencyConfig()).endpoint).toBeNull();
  });
});
