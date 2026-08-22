import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog } from '../src/audit/log.js';
import type { AuditEvent } from '../src/audit/record.js';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { CONFIG_FILENAME, defaultConfig, loadConfig, parseConfig } from '../src/config.js';
import { runChecks, tally, type Finding } from '../src/doctor/checks.js';

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-doctor-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

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

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const check = (
  config: Parameters<typeof runChecks>[0]['config'],
  overrides: Partial<Parameters<typeof runChecks>[0]> = {},
): Finding[] =>
  runChecks({
    config,
    configPath: '/srv/hushgate.config.json',
    auditPath: '/srv/audit.jsonl',
    readTrail: () => null,
    ...overrides,
  });

const has = (findings: readonly Finding[], severity: string, fragment: string): boolean =>
  findings.some((f) => f.severity === severity && f.message.includes(fragment));

describe('hushgate init', () => {
  it('writes a config that hushgate itself can read', async () => {
    const dir = workspace();
    const c = capture(['init'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);

    const written = readFileSync(join(dir, CONFIG_FILENAME), 'utf8');
    expect(written).toContain('// hushgate configuration');

    // The comments are the point, and they must survive the round trip.
    const { config } = loadConfig({ cwd: dir, env: {} });
    expect(config.redaction.policies['SECRET']).toBe('block');
    expect(config.audit.enabled).toBe(true);
  });

  it('tells the reader what to do next', async () => {
    const dir = workspace();
    const c = capture(['init'], dir);
    await run(c.cli);
    expect(c.out()).toContain('hushgate doctor');
    expect(c.out()).toContain('residency.allow');
  });

  it('refuses to overwrite without --force', async () => {
    const dir = workspace({ [CONFIG_FILENAME]: '{}' });
    const c = capture(['init'], dir);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('--force');
    expect(readFileSync(join(dir, CONFIG_FILENAME), 'utf8')).toBe('{}');
  });

  it('overwrites with --force', async () => {
    const dir = workspace({ [CONFIG_FILENAME]: '{}' });
    expect(await run(capture(['init', '--force'], dir).cli)).toBe(EXIT.ok);
    expect(readFileSync(join(dir, CONFIG_FILENAME), 'utf8')).toContain('hushgate configuration');
  });

  it('writes where it is told', async () => {
    const dir = workspace();
    const c = capture(['init', '--path', 'other.json'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'other.json'), 'utf8')).toContain('hushgate configuration');
  });

  it('fails rather than half-succeeding when the directory is missing', async () => {
    const dir = workspace();
    const c = capture(['init', '--path', 'nowhere/hushgate.json'], dir);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(existsSync(join(dir, 'nowhere'))).toBe(false);
  });
});

describe('doctor checks', () => {
  it('is quiet about a well-configured setup', () => {
    const config = parseConfig({
      upstreams: { openai: 'https://api.mistral.ai', anthropic: 'https://api.aleph-alpha.com' },
      residency: {
        allow: [
          { endpoint: 'https://api.mistral.ai', legalBasis: 'DPA 2026-01-12' },
          { endpoint: 'https://api.aleph-alpha.com', legalBasis: 'DPA 2025-11-03' },
        ],
      },
    });

    const counts = tally(check(config));
    expect(counts.fail).toBe(0);
    expect(counts.warn).toBe(0);
  });

  it('warns that an empty allowlist permits everything', () => {
    expect(has(check(defaultConfig()), 'warn', 'no residency allowlist')).toBe(true);
  });

  it('fails when an upstream is not allowlisted', () => {
    const config = parseConfig({
      residency: { allow: [{ endpoint: 'https://api.mistral.ai', legalBasis: 'DPA' }] },
    });
    expect(has(check(config), 'fail', 'upstreams.openai')).toBe(true);
  });

  it('warns about warn mode left on', () => {
    const config = parseConfig({ residency: { mode: 'warn' } });
    expect(has(check(config), 'warn', 'residency.mode is "warn"')).toBe(true);
  });

  it('warns about a route or category left loose', () => {
    const config = parseConfig({
      residency: {
        routes: { 'anthropic.messages': 'allow' },
        categories: { EMAIL: 'warn' },
      },
    });
    const findings = check(config);
    expect(has(findings, 'warn', 'residency.routes.anthropic.messages')).toBe(true);
    expect(has(findings, 'warn', 'residency.categories.EMAIL')).toBe(true);
  });

  it('warns about an allow policy on a category', () => {
    const config = parseConfig({ redaction: { policies: { IPV4: 'allow' } } });
    expect(has(check(config), 'warn', 'redaction.policies.IPV4')).toBe(true);
  });

  it('fails on a default policy of allow', () => {
    const config = parseConfig({ redaction: { defaultPolicy: 'allow' } });
    expect(has(check(config), 'fail', 'the default policy is "allow"')).toBe(true);
  });

  it('warns when hashing without a stable key', () => {
    const config = parseConfig({ redaction: { policies: { GERMAN_TAX_ID: 'hash' } } });
    expect(has(check(config), 'warn', 'no HMAC key is configured')).toBe(true);
  });

  it('fails on an open relay', () => {
    const config = { ...defaultConfig(), host: '0.0.0.0' };
    expect(has(check(config), 'fail', 'open relay')).toBe(true);
  });

  it('notes tenants without quotas', () => {
    const config = parseConfig({
      host: '0.0.0.0',
      tenants: [{ id: 'a', keyHash: '0'.repeat(64) }],
    });
    const findings = check(config);
    expect(has(findings, 'ok', '1 tenant(s) defined')).toBe(true);
    expect(has(findings, 'note', 'have no quota')).toBe(true);
  });

  it('fails when auditing is switched off', () => {
    const config = parseConfig({ audit: { enabled: false } });
    expect(has(check(config), 'fail', 'auditing is disabled')).toBe(true);
  });

  it('reports an intact chain and a broken one', async () => {
    const dir = workspace();
    const path = join(dir, 'audit.jsonl');
    const log = new JsonlAuditLog({ path });
    const event: AuditEvent = {
      tenant: null,
      route: 'openai.chat.completions',
      outcome: 'forwarded',
      status: 200,
      latencyMs: 1,
      stream: false,
      upstream: 'api.openai.com',
      tokens: 0,
      findings: {},
      policies: {},
      residency: null,
    };
    log.write(event);
    log.write(event);
    await log.close();

    const intact = check(defaultConfig(), {
      auditPath: path,
      readTrail: () => readFileSync(path, 'utf8'),
    });
    expect(has(intact, 'ok', 'chain intact')).toBe(true);

    const tampered = readFileSync(path, 'utf8').replace('"latencyMs":1', '"latencyMs":9');
    const broken = check(defaultConfig(), { auditPath: path, readTrail: () => tampered });
    expect(has(broken, 'fail', 'chain broken at record 1')).toBe(true);
  });

  it('reports an unreadable line in the trail', () => {
    const findings = check(defaultConfig(), { readTrail: () => 'not json\n' });
    expect(has(findings, 'fail', 'unreadable line(s)')).toBe(true);
  });
});

describe('hushgate doctor', () => {
  it('prints findings with remedies and exits non-zero on a warning', async () => {
    const dir = workspace();
    const c = capture(['doctor'], dir);

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('hushgate doctor');
    expect(c.out()).toContain('warn  no residency allowlist');
    expect(c.out()).toContain('→ list the endpoints you have assessed');
    expect(c.out()).toContain('1 warning');
  });

  it('accepts warnings when asked to', async () => {
    const dir = workspace();
    expect(await run(capture(['doctor', '--allow-warnings'], dir).cli)).toBe(EXIT.ok);
  });

  it('still fails on a failure, even with --allow-warnings', async () => {
    const dir = workspace({
      [CONFIG_FILENAME]: JSON.stringify({ audit: { enabled: false } }),
    });
    expect(await run(capture(['doctor', '--allow-warnings'], dir).cli)).toBe(EXIT.failure);
  });

  it('says nothing unsafe was found when that is true', async () => {
    const dir = workspace({
      [CONFIG_FILENAME]: JSON.stringify({
        upstreams: { openai: 'https://api.mistral.ai', anthropic: 'https://api.mistral.ai' },
        residency: { allow: [{ endpoint: 'https://api.mistral.ai', legalBasis: 'DPA' }] },
      }),
    });

    const c = capture(['doctor'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('Nothing unsafe found.');
  });

  it('reports a broken config file as a finding rather than a crash', async () => {
    const dir = workspace({ [CONFIG_FILENAME]: '{ "port": "eighty" }' });
    const c = capture(['doctor'], dir);

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('FAIL');
    expect(c.out()).toContain('nothing else can be checked until it parses');
  });

  it('emits JSON for CI', async () => {
    const dir = workspace();
    const c = capture(['doctor', '--json'], dir);
    await run(c.cli);

    const report = JSON.parse(c.out()) as {
      findings: Finding[];
      counts: Record<string, number>;
    };
    expect(report.counts['warn']).toBeGreaterThan(0);
    expect(report.findings.every((f) => typeof f.section === 'string')).toBe(true);
  });
});

describe('the --allow-warnings summary', () => {
  it('does not tell you to use the flag you are already using', async () => {
    const dir = workspace({ 'hushgate.config.json': JSON.stringify({ host: '127.0.0.1' }) });

    const plain = capture(['doctor'], dir);
    expect(await run(plain.cli)).toBe(EXIT.failure);
    expect(plain.out()).toContain('re-run with --allow-warnings');

    const accepted = capture(['doctor', '--allow-warnings'], dir);
    expect(await run(accepted.cli)).toBe(EXIT.ok);
    expect(accepted.out()).toContain('Accepted via --allow-warnings.');
    expect(accepted.out()).not.toContain('re-run with --allow-warnings');
  });

  it('still says how to accept them when a failure is present too', async () => {
    const dir = workspace({ 'hushgate.config.json': '{ not json' });
    const c = capture(['doctor', '--allow-warnings'], dir);
    // A failure is never accepted by the flag, so the advice still applies.
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('re-run with --allow-warnings');
  });
});
