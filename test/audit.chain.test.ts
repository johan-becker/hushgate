import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, parseAuditLines, readHead } from '../src/audit/log.js';
import {
  GENESIS_HASH,
  recomputeHash,
  toRecord,
  verifyChain,
  type AuditEvent,
  type AuditRecord,
} from '../src/audit/record.js';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-chain-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  tenant: null,
  route: 'openai.chat.completions',
  outcome: 'forwarded',
  status: 200,
  latencyMs: 12,
  stream: false,
  upstream: 'api.mistral.ai',
  tokens: 100,
  findings: { EMAIL: 1 },
  policies: { EMAIL: 'pseudonymize' },
  residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'FR', controls: [] },
  ...overrides,
});

/** Write `count` chained records and return the file path. */
async function trail(count: number, dir = workspace()): Promise<string> {
  const path = join(dir, 'audit.jsonl');
  const log = new JsonlAuditLog({ path });
  for (let i = 0; i < count; i += 1) log.write(event({ status: 200 + i }));
  await log.close();
  return path;
}

function read(path: string): AuditRecord[] {
  const { records, malformed } = parseAuditLines(readFileSync(path, 'utf8'));
  expect(malformed).toEqual([]);
  return records;
}

describe('record hashing', () => {
  it('links the first record to the genesis hash', () => {
    const record = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    expect(record.prev).toBe(GENESIS_HASH);
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('hashes deterministically', () => {
    const a = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    const b = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    expect(a.hash).toBe(b.hash);
  });

  it('changes the hash when anything at all changes', () => {
    const base = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    expect(toRecord(event({ status: 201 }), '2026-01-01T00:00:00.000Z', 'id-1').hash).not.toBe(
      base.hash,
    );
    expect(toRecord(event(), '2026-01-01T00:00:00.001Z', 'id-1').hash).not.toBe(base.hash);
    expect(toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-2').hash).not.toBe(base.hash);
    expect(toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1', 'a'.repeat(64)).hash).not.toBe(
      base.hash,
    );
  });

  it('survives a round trip through JSON, which is what verification depends on', () => {
    const record = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    const parsed = JSON.parse(JSON.stringify(record)) as AuditRecord;
    expect(recomputeHash(parsed)).toBe(record.hash);
  });
});

describe('the trail on disk', () => {
  it('chains every record to the one before it', async () => {
    const records = read(await trail(5));
    expect(records).toHaveLength(5);
    expect(records[0]!.prev).toBe(GENESIS_HASH);
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]!.prev).toBe(records[i - 1]!.hash);
    }
    expect(verifyChain(records).ok).toBe(true);
  });

  it('continues the chain across a restart', async () => {
    const dir = workspace();
    const path = await trail(2, dir);

    const reopened = new JsonlAuditLog({ path });
    reopened.write(event());
    await reopened.close();

    const records = read(path);
    expect(records).toHaveLength(3);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('reads the head without parsing the whole file', async () => {
    const path = await trail(3);
    const records = read(path);
    expect(readHead(path)).toBe(records.at(-1)!.hash);
  });

  it('starts from genesis for a file that does not exist yet', () => {
    expect(readHead(join(workspace(), 'nothing.jsonl'))).toBe(GENESIS_HASH);
  });

  it('exposes the head hash so it can be anchored elsewhere', async () => {
    const log = new JsonlAuditLog({ path: join(workspace(), 'audit.jsonl') });
    expect(log.headHash).toBe(GENESIS_HASH);
    log.write(event());
    const head = log.headHash;
    expect(head).not.toBe(GENESIS_HASH);
    log.write(event());
    expect(log.headHash).not.toBe(head);
    await log.close();
  });
});

describe('verifyChain', () => {
  it('accepts an empty trail', () => {
    expect(verifyChain([])).toEqual({
      ok: true,
      records: 0,
      firstBreak: null,
      head: GENESIS_HASH,
    });
  });

  it('spots a record whose contents were edited', async () => {
    const path = await trail(4);
    const records = read(path);
    const tampered = [...records];
    tampered[2] = { ...tampered[2]!, findings: { EMAIL: 0 } };

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: 'altered' });
    expect(result.firstBreak!.detail).toContain('hash');
  });

  it('spots a record removed from the middle', async () => {
    const path = await trail(4);
    const records = read(path);
    const shortened = [...records.slice(0, 2), ...records.slice(3)];

    const result = verifyChain(shortened);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: 'unlinked' });
  });

  it('spots a record inserted into the middle', async () => {
    const path = await trail(3);
    const records = read(path);
    const forged = toRecord(event({ status: 999 }), '2026-01-01T00:00:00.000Z', 'forged');
    const spliced = [records[0]!, forged, ...records.slice(1)];

    const result = verifyChain(spliced);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 2, reason: 'unlinked' });
  });

  it('reports the first break, not the last', async () => {
    const path = await trail(6);
    const records = read(path);
    const tampered = [...records];
    tampered[1] = { ...tampered[1]!, status: 500 };
    tampered[4] = { ...tampered[4]!, status: 500 };
    expect(verifyChain(tampered).firstBreak!.index).toBe(2);
  });

  it('cannot detect a truncated tail, and the contract says so', async () => {
    const path = await trail(5);
    const records = read(path);
    // Dropping the last records leaves a shorter but consistent chain. This is
    // exactly why headHash exists: anchor it somewhere hushgate cannot reach.
    expect(verifyChain(records.slice(0, 3)).ok).toBe(true);
    expect(verifyChain(records.slice(0, 3)).head).toBe(records[2]!.hash);
  });

  it('catches an appended record that was not chained', async () => {
    const path = await trail(2);
    const forged = toRecord(event({ status: 418 }), '2026-01-01T00:00:00.000Z', 'forged');
    appendFileSync(path, `${JSON.stringify(forged)}\n`);

    const result = verifyChain(read(path));
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: 'unlinked' });
  });

  it('notices when a whole trail is replaced by a plausible-looking one', async () => {
    const dir = workspace();
    const path = join(dir, 'audit.jsonl');
    const record = toRecord(event(), '2026-01-01T00:00:00.000Z', 'id-1');
    // Same shape, hash left over from a different record: not a chain.
    writeFileSync(path, `${JSON.stringify({ ...record, hash: 'f'.repeat(64) })}\n`);
    expect(verifyChain(read(path)).firstBreak).toMatchObject({ reason: 'altered' });
  });
});
