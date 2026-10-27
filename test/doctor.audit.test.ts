/**
 * The audit section of `hushgate doctor`: every trail `serve` would write,
 * whether `serve` could write it, and whether what is in it verifies.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog } from '../src/audit/log.js';
import { GENESIS_HASH, toRecord, type AuditEvent } from '../src/audit/record.js';
import type { Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { defaultConfig, parseConfig, type HushgateConfig } from '../src/config.js';
import { runChecks, type DoctorInput, type Finding } from '../src/doctor/checks.js';

const isRoot = process.getuid?.() === 0;
const dirs: string[] = [];
const locked: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-doctor-audit-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  // Give back what a test took away, or the directory cannot be removed.
  while (locked.length > 0) chmodSync(locked.pop()!, 0o755);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

async function writeTrail(path: string, count: number): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true });
  const log = new JsonlAuditLog({ path });
  for (let index = 0; index < count; index += 1) log.write(event);
  await log.close();
}

/** Only the audit section, from the real file system unless a test injects otherwise. */
function auditFindings(config: HushgateConfig, cwd: string, overrides: Partial<DoctorInput> = {}): Finding[] {
  return runChecks({ config, configPath: null, cwd, onPath: () => true, ...overrides }).filter(
    (finding) => finding.section === 'audit',
  );
}

const has = (findings: readonly Finding[], severity: string, fragment: string): boolean =>
  findings.some((finding) => finding.severity === severity && finding.message.includes(fragment));

function withTenants(tenants: { id: string; path?: string }[]): HushgateConfig {
  return parseConfig({
    tenants: tenants.map(({ id, path }, index) => ({
      id,
      name: id,
      keyHash: String(index).repeat(64),
      ...(path === undefined ? {} : { audit: { path } }),
    })),
  });
}

describe('doctor on a trail it cannot read', () => {
  it('notes a trail that does not exist yet, and nothing else', () => {
    const findings = auditFindings(defaultConfig(), workspace());
    expect(findings).toHaveLength(1);
    expect(has(findings, 'note', 'yet; it is written on the first request')).toBe(true);
  });

  it('fails on a trail that is a directory, rather than calling it not there yet', () => {
    const dir = workspace();
    mkdirSync(join(dir, 'hushgate-audit.jsonl'));

    const findings = auditFindings(defaultConfig(), dir);
    expect(has(findings, 'fail', 'cannot be read (EISDIR)')).toBe(true);
    expect(has(findings, 'fail', 'cannot be written (EISDIR)')).toBe(true);
    expect(findings.some((finding) => finding.message.includes('yet'))).toBe(false);
  });

  it.skipIf(isRoot)('fails on a trail this user may not open, naming the error', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    await writeTrail(path, 1);
    chmodSync(path, 0o000);
    locked.push(path);

    const findings = auditFindings(defaultConfig(), dir);
    expect(has(findings, 'fail', 'cannot be read (EACCES)')).toBe(true);
    expect(has(findings, 'fail', 'cannot be written (EACCES)')).toBe(true);
  });

  it.skipIf(isRoot)('fails when the trail would go in a directory serve cannot write to', () => {
    const dir = workspace();
    const sealed = join(dir, 'sealed');
    mkdirSync(sealed);
    chmodSync(sealed, 0o555);
    locked.push(sealed);

    const config = parseConfig({ audit: { path: 'sealed/logs/hushgate-audit.jsonl' } });
    const findings = auditFindings(config, dir);
    expect(has(findings, 'fail', `cannot be written (EACCES at ${sealed})`)).toBe(true);
    expect(findings.find((finding) => finding.severity === 'fail')?.message).toContain('would refuse to start');
  });

  it('fails when a file stands where a directory of the path should be', () => {
    const dir = workspace();
    writeFileSync(join(dir, 'logs'), 'not a directory');

    const config = parseConfig({ audit: { path: 'logs/hushgate-audit.jsonl' } });
    expect(has(auditFindings(config, dir), 'fail', 'cannot be written (ENOTDIR')).toBe(true);
  });
});

describe('doctor on what the trail holds', () => {
  it('reads the file itself, and gives the full head', async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'hushgate-audit.jsonl'), 2);
    const head = JSON.parse(readFileSync(join(dir, 'hushgate-audit.jsonl'), 'utf8').trim().split('\n')[1]!).hash;

    const findings = auditFindings(defaultConfig(), dir);
    expect(findings).toEqual([
      {
        section: 'audit',
        severity: 'ok',
        message: `trail ${join(dir, 'hushgate-audit.jsonl')}: 2 record(s), chain intact, head ${head}`,
      },
    ]);
  });

  it('names the file line of a break, and how many there are', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    await writeTrail(path, 3);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const tampered = lines.map((line) => line.replace('"latencyMs":1', '"latencyMs":2'));
    writeFileSync(path, `\n${tampered.join('\n')}\n`);

    const findings = auditFindings(defaultConfig(), dir);
    expect(has(findings, 'fail', 'chain broken at record 1, line 2 (altered)')).toBe(true);
    expect(has(findings, 'fail', '3 breaks in all')).toBe(true);
  });

  it('warns about records the writer lost, without failing the chain', () => {
    const dir = workspace();
    const first = toRecord(event, '2026-03-02T08:00:00.000Z', 'a', GENESIS_HASH);
    const second = toRecord(event, '2026-03-02T08:01:00.000Z', 'b', first.hash, 3);
    writeFileSync(join(dir, 'hushgate-audit.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    const findings = auditFindings(defaultConfig(), dir);
    expect(has(findings, 'ok', 'chain intact')).toBe(true);
    expect(has(findings, 'warn', '3 records could not be written (first gap before record 2, line 2)')).toBe(true);
  });

  it('keeps the injected reader working', () => {
    const findings = auditFindings(defaultConfig(), '/srv', {
      auditPath: '/srv/audit.jsonl',
      readTrail: () => 'not json\n',
      writeProblem: () => null,
    });
    expect(has(findings, 'fail', '1 unreadable line(s) in trail /srv/audit.jsonl, first at line 1')).toBe(true);
  });
});

describe('doctor on tenant trails', () => {
  it("verifies each tenant's own trail, not only the global one", async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'hushgate-audit.jsonl'), 1);
    await writeTrail(join(dir, 'tenants', 'acme.jsonl'), 2);
    const path = join(dir, 'tenants', 'acme.jsonl');
    writeFileSync(path, readFileSync(path, 'utf8').replace('"status":200', '"status":500'));

    const findings = auditFindings(withTenants([{ id: 'acme', path: 'tenants/acme.jsonl' }, { id: 'beta' }]), dir);
    expect(has(findings, 'ok', `global trail ${join(dir, 'hushgate-audit.jsonl')}: 1 record(s), chain intact`)).toBe(true);
    expect(has(findings, 'fail', `trail of tenant acme ${path}: chain broken at record 1`)).toBe(true);
  });

  it('checks a shared file once, and notes who shares it', async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'hushgate-audit.jsonl'), 1);
    await writeTrail(join(dir, 'shared.jsonl'), 1);

    const findings = auditFindings(
      withTenants([
        { id: 'acme', path: 'shared.jsonl' },
        { id: 'beta', path: './shared.jsonl' },
        { id: 'gamma', path: 'hushgate-audit.jsonl' },
      ]),
      dir,
    );
    expect(findings.filter((finding) => finding.severity === 'ok')).toHaveLength(2);
    expect(has(findings, 'note', `tenants acme, beta share one trail, ${join(dir, 'shared.jsonl')}, and one chain`)).toBe(true);
    expect(has(findings, 'note', 'tenant gamma names the global trail')).toBe(true);
    expect(has(findings, 'ok', 'global trail (also tenant gamma)')).toBe(true);
  });

  it('checks that serve could write every tenant trail', () => {
    const dir = workspace();
    const asked: string[] = [];

    auditFindings(withTenants([{ id: 'acme', path: 'tenants/acme.jsonl' }]), dir, {
      writeProblem: (path) => {
        asked.push(path);
        return null;
      },
    });
    expect(asked).toEqual([join(dir, 'hushgate-audit.jsonl'), join(dir, 'tenants', 'acme.jsonl')]);
  });

  it('reports tenant trails from the command, against its working directory', async () => {
    const dir = workspace();
    writeFileSync(
      join(dir, 'hushgate.config.json'),
      JSON.stringify({
        tenants: [{ id: 'acme', name: 'Acme', keyHash: '0'.repeat(64), audit: { path: 'acme.jsonl' } }],
      }),
    );
    await writeTrail(join(dir, 'acme.jsonl'), 1);

    const out: string[] = [];
    const cli: Cli = { argv: ['doctor', '--json'], stdout: (t) => out.push(t), stderr: () => {}, env: {}, cwd: dir };
    await run(cli);
    const { findings } = JSON.parse(out.join('')) as { findings: Finding[] };
    expect(has(findings, 'ok', `trail of tenant acme ${join(dir, 'acme.jsonl')}: 1 record(s), chain intact`)).toBe(true);
  });
});

describe('doctor when a section throws', () => {
  it('reports that section as a failure and still runs the others', () => {
    const findings = runChecks({
      config: defaultConfig(),
      configPath: null,
      auditPath: '/srv/audit.jsonl',
      readTrail: () => null,
      writeProblem: () => null,
      onPath: () => {
        throw new Error('PATH lookup exploded\u001b[2K');
      },
    });

    const attachments = findings.filter((finding) => finding.section === 'attachments');
    expect(attachments).toEqual([
      expect.objectContaining({
        severity: 'fail',
        message: 'the attachments checks could not finish: PATH lookup exploded\\u001b[2K',
      }),
    ]);
    expect(findings.some((finding) => finding.section === 'audit')).toBe(true);
    expect(findings.some((finding) => finding.section === 'configuration')).toBe(true);
  });

  it('turns an error reading a trail into a failure that names its code', () => {
    const findings = runChecks({
      config: defaultConfig(),
      configPath: null,
      auditPath: '/srv/audit.jsonl',
      readTrail: () => {
        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      },
      writeProblem: () => null,
      onPath: () => true,
    });
    expect(has(findings, 'fail', 'trail /srv/audit.jsonl cannot be read (EIO)')).toBe(true);
  });
});
