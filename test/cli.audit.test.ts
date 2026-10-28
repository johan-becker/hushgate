/**
 * `hushgate audit verify`, as an auditor uses it: on the file they name, on
 * a tenant's own trail, on every trail at once, against a head anchored
 * somewhere hushgate cannot rewrite, and on a trail whose start was pruned.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as hushgate from '../src/index.js';
import { JsonlAuditLog } from '../src/audit/log.js';
import { GENESIS_HASH, toRecord, type AuditEvent, type AuditRecord } from '../src/audit/record.js';
import { parseFlags, listFlag, stringFlag, type FlagSpecs } from '../src/cli/args.js';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-cli-audit-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
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

async function hushgateIn(cwd: string, ...argv: string[]): Promise<Capture & { code: number }> {
  const c = capture(argv, cwd);
  const code = await run(c.cli);
  return { ...c, code };
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

/** Write `count` records to a trail through the real writer, and return their lines. */
async function writeTrail(path: string, count: number, tenant: string | null = null): Promise<string[]> {
  mkdirSync(join(path, '..'), { recursive: true });
  let index = 0;
  const log = new JsonlAuditLog({
    path,
    now: () => new Date(Date.UTC(2026, 2, 2, 8, index)),
    id: () => `id-${index}`,
  });
  for (; index < count; index += 1) log.write(event({ tenant }));
  await log.close();
  return lines(path);
}

function lines(path: string): string[] {
  return readFileSync(path, 'utf8').trim().split('\n');
}

const hashOf = (line: string): string => (JSON.parse(line) as AuditRecord).hash;

/** Records chained by hand, for the fields the real writer only sets on failure. */
function chainOf(entries: { id?: string; dropped?: number }[]): string {
  let prev = GENESIS_HASH;
  const out: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const record = toRecord(
      event(),
      `2026-03-02T08:0${index}:00.000Z`,
      entry.id ?? `id-${index}`,
      prev,
      entry.dropped ?? 0,
    );
    out.push(JSON.stringify(record));
    prev = record.hash;
  }
  return `${out.join('\n')}\n`;
}

const TENANT_KEY = '0'.repeat(64);

/** A config with a tenant that has its own trail, two that share one, and one that has none. */
const TENANT_CONFIG = JSON.stringify({
  tenants: [
    { id: 'acme', name: 'Acme', keyHash: TENANT_KEY, audit: { path: 'tenants/acme.jsonl' } },
    { id: 'beta', name: 'Beta', keyHash: TENANT_KEY.replace(/0$/u, '1'), audit: { path: 'tenants/shared.jsonl' } },
    { id: 'gamma', name: 'Gamma', keyHash: TENANT_KEY.replace(/0$/u, '2'), audit: { path: './tenants/shared.jsonl' } },
    { id: 'delta', name: 'Delta', keyHash: TENANT_KEY.replace(/0$/u, '3') },
  ],
});

describe('repeatable options', () => {
  const specs: FlagSpecs = {
    anchor: { type: 'string', repeatable: true, description: 'a head' },
    file: { type: 'string', description: 'a file' },
  };

  it('collects every value of a repeatable option, in order', () => {
    const parsed = parseFlags(['--anchor', 'a', '--anchor=b', '--file', 'x', '--file', 'y'], specs);
    expect(listFlag(parsed, 'anchor')).toEqual(['a', 'b']);
    // Any other option still keeps the last value, as before.
    expect(stringFlag(parsed, 'file')).toBe('y');
  });

  it('reads an absent repeatable option as none, and refuses an empty one', () => {
    expect(listFlag(parseFlags([], specs), 'anchor')).toEqual([]);
    expect(() => listFlag(parseFlags(['--anchor='], specs), 'anchor')).toThrow(/non-empty/u);
  });
});

describe('hushgate audit verify <file>', () => {
  it('verifies the file it is given, not the default trail beside it', async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'hushgate-audit.jsonl'), 2);
    const copy = await writeTrail(join(dir, 'copy.jsonl'), 3);
    copy[1] = copy[1]!.replace('"tokens":100', '"tokens":1');
    writeFileSync(join(dir, 'copy.jsonl'), `${copy.join('\n')}\n`);

    const tampered = await hushgateIn(dir, 'audit', 'verify', 'copy.jsonl');
    expect(tampered.code).toBe(EXIT.failure);
    expect(tampered.out()).toContain(join(dir, 'copy.jsonl'));
    expect(tampered.out()).toContain('record 2 (altered)');

    // The same file through --file, and the intact default trail without either.
    expect((await hushgateIn(dir, 'audit', 'verify', '--file', 'copy.jsonl')).code).toBe(EXIT.failure);
    expect((await hushgateIn(dir, 'audit', 'verify')).code).toBe(EXIT.ok);
  });

  it('needs no config to verify a file it was handed', async () => {
    // An auditor's shell: somebody else's config that does not even parse.
    const dir = workspace({ 'hushgate.config.json': '{ this is not json' });
    await writeTrail(join(dir, 'handed-over.jsonl'), 2);

    const result = await hushgateIn(dir, 'audit', 'verify', 'handed-over.jsonl');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain('chain        intact');
  });

  it('still loads a config named with -c, and fails when it is missing', async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'trail.jsonl'), 1);

    const result = await hushgateIn(dir, 'audit', 'verify', 'trail.jsonl', '-c', 'nowhere.json');
    expect(result.code).toBe(EXIT.failure);
    expect(result.err()).toContain('configuration error');
  });

  it.each([
    [['verify', 'a.jsonl', '--file', 'b.jsonl'], /name the trail once/u],
    [['verify', 'a.jsonl', 'b.jsonl'], /reads one trail file, but was given 2/u],
    [['verify', '--from', '2026-03-01'], /"hushgate audit verify" always checks the whole trail/u],
    [['verify', '--to', '2026-03-01'], /--from and --to choose the period of a report/u],
    [['report', '--all'], /--all is for "hushgate audit verify"/u],
    [['verify', 'a.jsonl', '--tenant', 'acme'], /either it or a trail file/u],
    [['verify', '--all', '--tenant', 'acme'], /takes no trail file and no --tenant/u],
    [['verify', '--all', '--anchor', 'a'.repeat(64)], /describe one trail/u],
    [['verify', '--anchor', 'not-a-hash'], /--anchor needs a 64-character hex hash/u],
    [['verify', '--continues-from', 'abc'], /--continues-from needs a 64-character hex hash/u],
    [['report', '--from', '2026-02-31'], /that exists/u],
    [['report', '--from', '2026-03-02', '--to', '2026-03-01'], /would hold no days/u],
  ])('refuses %j as a usage error', async (argv, message) => {
    const dir = workspace({ 'hushgate.config.json': TENANT_CONFIG });
    const result = await hushgateIn(dir, 'audit', ...argv);
    expect(result.code).toBe(EXIT.usage);
    expect(result.err()).toMatch(message);
  });
});

describe('hushgate audit verify, read for a person', () => {
  it('lists every break with its record and file line, and does not overstate them', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    const written = await writeTrail(path, 5);
    written[1] = written[1]!.replace('"latencyMs":40', '"latencyMs":41');
    written[3] = written[3]!.replace('"latencyMs":40', '"latencyMs":42');
    // A blank line pushes every later file line one past its record number.
    writeFileSync(path, `${written.slice(0, 3).join('\n')}\n\n${written.slice(3).join('\n')}\n`);

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.failure);
    expect(result.out()).toContain('chain        BROKEN at 2 points');
    expect(result.out()).toContain('record 2 (altered), line 2: id id-1');
    expect(result.out()).toContain('record 4 (altered), line 5: id id-3');
    expect(result.out()).toContain('Records outside the points listed still link correctly.');
    expect(result.out()).not.toContain('Everything from it onwards');
  });

  it('escapes control characters a tamperer put in an id', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    // ESC [1A ESC [2K: cursor up, erase line — the BROKEN line would vanish.
    const text = chainOf([{}, { id: 'x\u001b[1A\u001b[2Ky\u202e' }]).replace(
      /"tokens":100(?=[^\n]*\n$)/u,
      '"tokens":7',
    );
    writeFileSync(path, text);

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.failure);
    expect(result.out()).toContain('id x\\u001b[1A\\u001b[2Ky\\u202e');
    expect(result.out()).not.toContain('\u001b');
    expect(result.out()).not.toContain('\u202e');
  });

  it('warns about records the writer lost, without failing the chain', async () => {
    const dir = workspace();
    writeFileSync(join(dir, 'hushgate-audit.jsonl'), chainOf([{}, {}, { dropped: 2 }]));

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain('gap          2 records could not be written before record 3 (line 3)');
    expect(result.out()).toContain('Warning: the writer could not write 2 records');
  });

  it('warns that an empty trail proves nothing', async () => {
    const dir = workspace({ 'hushgate-audit.jsonl': '' });

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain('records      0');
    expect(result.out()).toContain('Warning: the trail holds no records.');
    expect(result.out()).not.toContain('Anchor the head hash outside hushgate');
  });

  it('caps the unreadable lines it lists, and counts the rest', async () => {
    const dir = workspace();
    const garbage = Array.from({ length: 103 }, () => '{ not json').join('\n');
    writeFileSync(join(dir, 'hushgate-audit.jsonl'), `${garbage}\n`);

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.failure);
    expect(result.out().match(/^ {2}unreadable {3}line \d+:/gmu)).toHaveLength(100);
    expect(result.out()).toContain('unreadable   …and 3 more');
  });
});

describe('hushgate audit verify --json', () => {
  it('keeps its keys, and makes ok the verdict the exit code gives', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    await writeTrail(path, 2);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{ not json\n`);

    const result = await hushgateIn(dir, 'audit', 'verify', '--json');
    expect(result.code).toBe(EXIT.failure);
    const parsed = JSON.parse(result.out()) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      file: path,
      ok: false,
      chainOk: true,
      records: 2,
      firstBreak: null,
      breaks: [],
      breakCount: 0,
      gaps: [],
      gapCount: 0,
      dropped: 0,
      anchors: [],
      from: GENESIS_HASH,
      malformed: [{ line: 3, reason: 'not valid JSON (at position 2)' }],
      malformedCount: 1,
    });
    expect(parsed['head']).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('says ok when, and only when, it exits 0', async () => {
    const dir = workspace();
    await writeTrail(join(dir, 'hushgate-audit.jsonl'), 1);

    const result = await hushgateIn(dir, 'audit', 'verify', '--json');
    expect(result.code).toBe(EXIT.ok);
    expect(JSON.parse(result.out())).toMatchObject({ ok: true, chainOk: true });
  });
});

describe('hushgate audit verify --anchor', () => {
  it('passes when a verified record carries the anchored head, and says what followed it', async () => {
    const dir = workspace();
    const written = await writeTrail(join(dir, 'hushgate-audit.jsonl'), 3);

    const result = await hushgateIn(dir, 'audit', 'verify', '--anchor', hashOf(written[1]!).toUpperCase());
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain(`anchor       ${hashOf(written[1]!)} found at record 2 (line 2), 1 record after it`);
  });

  it('fails when records were cut from the end, which the chain alone cannot see', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    const written = await writeTrail(path, 3);
    const anchored = hashOf(written[2]!);
    writeFileSync(path, `${written.slice(0, 2).join('\n')}\n`);

    // Without the anchor, the shortened trail is a perfectly good chain.
    expect((await hushgateIn(dir, 'audit', 'verify')).code).toBe(EXIT.ok);

    const result = await hushgateIn(dir, 'audit', 'verify', '--anchor', hashOf(written[0]!), '--anchor', anchored);
    expect(result.code).toBe(EXIT.failure);
    expect(result.out()).toContain('chain        intact');
    expect(result.out()).toContain(`anchor       ${anchored} NOT FOUND`);
    expect(result.out()).toContain('removed from the end of the trail');

    const json = await hushgateIn(dir, 'audit', 'verify', '--anchor', anchored, '--json');
    expect(json.code).toBe(EXIT.failure);
    expect(JSON.parse(json.out())).toMatchObject({
      ok: false,
      chainOk: false,
      anchors: [{ hash: anchored, found: false, index: null, line: null, following: null }],
    });
  });

  it('finds the head serve printed for a trail that had no records yet', async () => {
    const dir = workspace({ 'archive.jsonl': '' });

    const empty = await hushgateIn(dir, 'audit', 'verify', 'archive.jsonl', '--anchor', GENESIS_HASH);
    expect(empty.code).toBe(EXIT.ok);
    expect(empty.out()).toContain(`anchor       ${GENESIS_HASH} found at the start of the chain, 0 records after it`);
    expect(empty.out()).not.toContain('NOT FOUND');

    // Records written since then follow it, as they would any other head.
    await writeTrail(join(dir, 'archive.jsonl'), 2);
    const later = await hushgateIn(dir, 'audit', 'verify', 'archive.jsonl', '--anchor', GENESIS_HASH);
    expect(later.code).toBe(EXIT.ok);
    expect(later.out()).toContain('found at the start of the chain, 2 records after it');
  });
});

describe('hushgate audit verify --continues-from', () => {
  it('verifies a trail whose first records were pruned, from the hash it continues', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    const written = await writeTrail(path, 3);
    writeFileSync(path, `${written.slice(1).join('\n')}\n`);

    const pruned = await hushgateIn(dir, 'audit', 'verify');
    expect(pruned.code).toBe(EXIT.failure);
    expect(pruned.out()).toContain('record 1 (unlinked)');

    const result = await hushgateIn(dir, 'audit', 'verify', '--continues-from', hashOf(written[0]!));
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain(`from         ${hashOf(written[0]!)}`);
    expect(result.out()).toContain('records      2');
  });

  it('finds an anchor equal to the hash the pruned trail continues from', async () => {
    const dir = workspace();
    const path = join(dir, 'hushgate-audit.jsonl');
    const written = await writeTrail(path, 3);
    writeFileSync(path, `${written.slice(1).join('\n')}\n`);
    const from = hashOf(written[0]!);

    const result = await hushgateIn(dir, 'audit', 'verify', '--continues-from', from, '--anchor', from);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain(`anchor       ${from} found at the start of the chain, 2 records after it`);
  });
});

async function tenantWorkspace(): Promise<string> {
  const dir = workspace({ 'hushgate.config.json': TENANT_CONFIG });
  await writeTrail(join(dir, 'hushgate-audit.jsonl'), 2);
  await writeTrail(join(dir, 'tenants', 'acme.jsonl'), 1, 'acme');
  await writeTrail(join(dir, 'tenants', 'shared.jsonl'), 3, 'beta');
  return dir;
}

describe('hushgate audit verify, with tenant trails', () => {
  it('says which tenant trails a plain verify did not check', async () => {
    const dir = await tenantWorkspace();

    const result = await hushgateIn(dir, 'audit', 'verify');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain(`audit trail ${join(dir, 'hushgate-audit.jsonl')} (global)`);
    expect(result.out()).toContain('not checked: the trails of tenants acme, beta, gamma');
    expect(result.out()).toContain('verify --all');

    // The JSON keeps its one-object shape; the note goes beside it.
    const json = await hushgateIn(dir, 'audit', 'verify', '--json');
    expect(JSON.parse(json.out())).toMatchObject({ file: join(dir, 'hushgate-audit.jsonl'), ok: true });
    expect(json.err()).toContain('not checked');
  });

  it("verifies a tenant's own trail with --tenant", async () => {
    const dir = await tenantWorkspace();
    const shared = lines(join(dir, 'tenants', 'shared.jsonl'));
    shared[2] = shared[2]!.replace('"tokens":100', '"tokens":5');
    writeFileSync(join(dir, 'tenants', 'shared.jsonl'), `${shared.join('\n')}\n`);

    const acme = await hushgateIn(dir, 'audit', 'verify', '--tenant', 'acme');
    expect(acme.code).toBe(EXIT.ok);
    expect(acme.out()).toContain(`${join(dir, 'tenants', 'acme.jsonl')} (tenant acme)`);
    expect(acme.out()).toContain('records      1');

    const gamma = await hushgateIn(dir, 'audit', 'verify', '--tenant', 'gamma');
    expect(gamma.code).toBe(EXIT.failure);
    expect(gamma.out()).toContain('(tenants beta, gamma)');
  });

  it('uses the global trail for a tenant without one of its own, and says so', async () => {
    const dir = await tenantWorkspace();

    const result = await hushgateIn(dir, 'audit', 'verify', '--tenant', 'delta');
    expect(result.code).toBe(EXIT.ok);
    expect(result.out()).toContain(join(dir, 'hushgate-audit.jsonl'));
    expect(result.out()).toContain('tenant delta has no audit trail of its own');
  });

  it('refuses a tenant the config does not have', async () => {
    const dir = await tenantWorkspace();

    const result = await hushgateIn(dir, 'audit', 'verify', '--tenant', 'omega');
    expect(result.code).toBe(EXIT.usage);
    expect(result.err()).toContain('no tenant "omega": known tenants are acme, beta, gamma, delta');
  });

  it('verifies every distinct trail with --all, once per file, and fails if any one does', async () => {
    const dir = await tenantWorkspace();

    const intact = await hushgateIn(dir, 'audit', 'verify', '--all');
    expect(intact.code).toBe(EXIT.ok);
    expect(intact.out()).toContain(`${join(dir, 'hushgate-audit.jsonl')} (global)`);
    expect(intact.out()).toContain(`${join(dir, 'tenants', 'acme.jsonl')} (tenant acme)`);
    // Two spellings of one path are one trail, shared by both tenants.
    expect(intact.out()).toContain(`${join(dir, 'tenants', 'shared.jsonl')} (tenants beta, gamma)`);
    expect(intact.out().match(/^audit trail /gmu)).toHaveLength(3);
    expect(intact.out()).toContain('All 3 trails verified.');

    const acme = lines(join(dir, 'tenants', 'acme.jsonl'));
    writeFileSync(join(dir, 'tenants', 'acme.jsonl'), `${acme[0]!.replace('"status":200', '"status":201')}\n`);

    const broken = await hushgateIn(dir, 'audit', 'verify', '--all');
    expect(broken.code).toBe(EXIT.failure);
    expect(broken.out()).toContain('1 of 3 trails did not verify.');
  });

  it('prints {ok, trails} for --all --json, a trail that cannot be read included', async () => {
    const dir = await tenantWorkspace();
    rmSync(join(dir, 'tenants', 'acme.jsonl'));

    const result = await hushgateIn(dir, 'audit', 'verify', '--all', '--json');
    expect(result.code).toBe(EXIT.failure);
    const parsed = JSON.parse(result.out()) as { ok: boolean; trails: Record<string, unknown>[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.trails).toHaveLength(3);
    expect(parsed.trails[0]).toMatchObject({ file: join(dir, 'hushgate-audit.jsonl'), ok: true, global: true, tenants: [] });
    expect(parsed.trails[1]).toMatchObject({ file: join(dir, 'tenants', 'acme.jsonl'), ok: false, global: false, tenants: ['acme'] });
    expect(String(parsed.trails[1]!['error'])).toContain('cannot read the audit trail');
    expect(parsed.trails[2]).toMatchObject({ ok: true, records: 3, tenants: ['beta', 'gamma'] });
  });
});

describe('hushgate help audit', () => {
  it('names the new options, and says the dates are UTC days', async () => {
    const result = await hushgateIn(workspace(), 'help', 'audit');
    for (const flag of ['--anchor <hash>', '--continues-from <hash>', '--tenant <id>', '--all', 'verify [<file>']) {
      expect(result.out()).toContain(flag);
    }
    expect(result.out()).toContain('first UTC day to include');
    expect(result.out()).toContain('(repeatable)');
  });
});

describe('the public API', () => {
  it('exports the streaming reader, the verifier, the report builder and the trail paths', () => {
    for (const name of [
      'INVALID_VALUE',
      'readTrailEntries',
      'parseTrailLine',
      'printable',
      'isHash',
      'TRAIL_CHUNK_BYTES',
      'MAX_LINE_BYTES',
      'ChainVerifier',
      'verifyTrail',
      'verifyTrailFile',
      'REPORTED_LIMIT',
      'parsePeriod',
      'ReportBuilder',
      'configuredTrails',
      'resolveTrailPath',
      'trailWriteProblem',
    ]) {
      expect(hushgate, name).toHaveProperty(name);
    }
  });
});
