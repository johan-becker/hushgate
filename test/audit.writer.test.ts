import {
  appendFileSync,
  chmodSync,
  closeSync,
  fdatasyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, readHead, type AuditFileSystem } from '../src/audit/log.js';
import {
  GENESIS_HASH,
  INVALID_VALUE,
  recomputeHash,
  toRecord,
  type AuditAttachment,
  type AuditEvent,
  type AuditRecord,
} from '../src/audit/record.js';
import { parseAuditLines } from '../src/audit/trail.js';
import { verifyChain } from '../src/audit/verify.js';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-writer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Permission tests mean nothing to a superuser, who can write anywhere. */
const isRoot = process.getuid?.() === 0;

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

const attachment = (): AuditAttachment => ({
  format: 'text',
  mediaType: 'text/plain',
  bytes: 78,
  chars: 78,
  pages: null,
  extractor: 'utf8',
  outcome: 'extracted',
  reason: null,
});

function parse(path: string): ReturnType<typeof parseAuditLines> {
  return parseAuditLines(readFileSync(path, 'utf8'));
}

/** Write `count` chained records to a fresh trail and return its path. */
async function trail(count: number): Promise<string> {
  const path = join(workspace(), 'audit.jsonl');
  const log = new JsonlAuditLog({ path });
  for (let i = 0; i < count; i += 1) log.write(event({ status: 200 + i }));
  await log.close();
  return path;
}

/** A writer whose warnings and failures are collected rather than printed. */
function writer(
  path: string,
  fs?: Partial<AuditFileSystem>,
): { log: JsonlAuditLog; messages: string[] } {
  const messages: string[] = [];
  const log = new JsonlAuditLog({ path, onError: (error) => messages.push(error.message), fs });
  return { log, messages };
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  error.code = code;
  return error;
}

/** Node's writeSync, failing on the calls `plan` says to. Counts every call. */
function scriptedWrites(
  plan: (call: number, length: number) => 'write' | 'fail' | number,
  code = 'ENOSPC',
): AuditFileSystem['writeSync'] {
  let call = 0;
  return (fd, buffer, offset, length, position) => {
    call += 1;
    const step = plan(call, length);
    if (step === 'fail') throw errno(code);
    return writeSync(fd, buffer, offset, step === 'write' ? length : step, position);
  };
}

function thrown(action: () => unknown): NodeJS.ErrnoException | undefined {
  try {
    action();
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  return undefined;
}

describe('writing through failures', () => {
  it('counts each record a failing disk loses and marks the gap on the next one written', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = writer(path, {
      writeSync: scriptedWrites((call) => (call === 2 || call === 3 ? 'fail' : 'write')),
    });

    log.write(event({ status: 200 }));
    const headAfterFirst = log.headHash;
    log.write(event({ status: 201 }));
    log.write(event({ status: 202 }));
    // Nothing reached the disk, so the head must not have moved.
    expect(log.headHash).toBe(headAfterFirst);
    log.write(event({ status: 203 }));
    log.write(event({ status: 204 }));
    await log.close();

    expect(log.droppedRecords).toBe(2);
    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records.map((record) => record.status)).toEqual([200, 203, 204]);
    expect(records[1]!.dropped).toBe(2);
    expect(Object.hasOwn(records[0]!, 'dropped')).toBe(false);
    expect(Object.hasOwn(records[2]!, 'dropped')).toBe(false);
    expect(verifyChain(records).ok).toBe(true);
    expect(log.headHash).toBe(records[2]!.hash);
  });

  it('reports the first failure at once and does not repeat it for every record', () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path, {
      writeSync: scriptedWrites((call) => (call <= 10 ? 'fail' : 'write')),
    });

    for (let i = 0; i < 10; i += 1) log.write(event());
    expect(log.droppedRecords).toBe(10);
    expect(messages.filter((message) => message.includes('could not write'))).toHaveLength(1);
    expect(messages[0]).toContain('ENOSPC');

    log.write(event());
    expect(messages.filter((message) => message.includes('writable again'))).toHaveLength(1);
    expect(messages.at(-1)).toContain('dropped: 10');
  });

  it('does not flood the reporter when the disk keeps failing and recovering', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path, {
      writeSync: scriptedWrites((call) => (call % 2 === 1 ? 'fail' : 'write')),
    });

    for (let i = 0; i < 10; i += 1) log.write(event({ status: 200 + i }));
    await log.close();

    expect(log.droppedRecords).toBe(5);
    expect(messages).toHaveLength(2);
    const { records } = parse(path);
    expect(records.map((record) => record.dropped)).toEqual([1, 1, 1, 1, 1]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('keeps a torn fragment on its own line and links past it', async () => {
    const path = join(workspace(), 'audit.jsonl');
    // The second record gets half of its bytes in, then the disk fills up.
    const { log } = writer(path, {
      writeSync: scriptedWrites((call, length) => {
        if (call === 2) return Math.floor(length / 2);
        return call === 3 ? 'fail' : 'write';
      }),
    });

    log.write(event({ status: 200 }));
    log.write(event({ status: 201 }));
    log.write(event({ status: 202 }));
    await log.close();

    expect(log.droppedRecords).toBe(1);
    const { records, malformed } = parse(path);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.line).toBe(2);
    expect(records.map((record) => record.status)).toEqual([200, 202]);
    expect(records[1]!.dropped).toBe(1);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('treats a record whose newline alone failed as written, since it is on disk', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path, {
      writeSync: scriptedWrites((call, length) => {
        if (call === 2) return length - 1;
        return call === 3 ? 'fail' : 'write';
      }),
    });

    log.write(event({ status: 200 }));
    log.write(event({ status: 201 }));
    log.write(event({ status: 202 }));
    await log.close();

    expect(log.droppedRecords).toBe(0);
    expect(messages.some((message) => message.includes('not the newline'))).toBe(true);
    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records.map((record) => record.status)).toEqual([200, 201, 202]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('reopens the trail when its descriptor has gone bad', async () => {
    const path = join(workspace(), 'audit.jsonl');
    let opens = 0;
    const { log } = writer(path, {
      openSync: (file, flags, mode) => {
        opens += 1;
        return openSync(file, flags, mode);
      },
      writeSync: scriptedWrites((call) => (call === 2 ? 'fail' : 'write'), 'EBADF'),
    });

    log.write(event({ status: 200 }));
    log.write(event({ status: 201 }));
    log.write(event({ status: 202 }));
    await log.close();

    expect(opens).toBe(2);
    expect(log.droppedRecords).toBe(1);
    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records.map((record) => record.status)).toEqual([200, 202]);
    expect(records[1]!.dropped).toBe(1);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('never throws, even when the error reporter does', () => {
    const path = join(workspace(), 'audit.jsonl');
    const log = new JsonlAuditLog({
      path,
      onError: () => {
        throw new Error('reporter down');
      },
      fs: { writeSync: scriptedWrites(() => 'fail', 'EIO') },
    });

    expect(() => log.write(event())).not.toThrow();
    expect(log.droppedRecords).toBe(1);
  });
});

describe('opening a trail', () => {
  it('starts from genesis on a new file and says so', async () => {
    const { log } = writer(join(workspace(), 'audit.jsonl'));
    expect(log.startedFrom).toEqual({ from: 'genesis', head: GENESIS_HASH });
    await log.close();
  });

  it('says which head it continued from on an existing trail', async () => {
    const path = await trail(2);
    const head = parse(path).records[1]!.hash;
    const { log, messages } = writer(path);
    expect(log.startedFrom).toEqual({ from: 'existing', head });
    expect(messages).toEqual([]);
    await log.close();
  });

  it('seals a torn final line and continues the chain from the last complete record', async () => {
    const path = await trail(2);
    appendFileSync(path, '{"ts":"2026-10-27T10:0');

    const { log, messages } = writer(path);
    expect(messages.join('\n')).toContain('part-way through a line');
    expect(log.headHash).toBe(parse(path).records[1]!.hash);
    log.write(event({ status: 300 }));
    log.write(event({ status: 301 }));
    await log.close();

    const { records, malformed } = parse(path);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.line).toBe(3);
    expect(records.map((record) => record.status)).toEqual([200, 201, 300, 301]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('keeps a valid last record that lost its trailing newline', async () => {
    const path = await trail(2);
    writeFileSync(path, readFileSync(path, 'utf8').slice(0, -1));
    const head = parse(path).records[1]!.hash;
    expect(readHead(path)).toBe(head);

    const { log } = writer(path);
    expect(log.startedFrom).toEqual({ from: 'existing', head });
    log.write(event({ status: 300 }));
    await log.close();

    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records.map((record) => record.status)).toEqual([200, 201, 300]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('walks back over lines that are not records instead of restarting at genesis', async () => {
    const path = await trail(2);
    const head = parse(path).records[1]!.hash;
    appendFileSync(path, '# rotated\n\n{"hash":"not a hash"}\n');
    expect(readHead(path)).toBe(head);

    const { log, messages } = writer(path);
    expect(log.headHash).toBe(head);
    expect(messages.join('\n')).toContain('last 2 line(s)');
    log.write(event({ status: 300 }));
    await log.close();

    const { records, malformed } = parse(path);
    expect(malformed).toHaveLength(2);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('treats a tail of NUL bytes left by a crash as one torn line', async () => {
    const path = await trail(2);
    appendFileSync(path, Buffer.alloc(512));

    const { log } = writer(path);
    log.write(event({ status: 300 }));
    await log.close();

    const { records, malformed } = parse(path);
    expect(malformed).toHaveLength(1);
    expect(records).toHaveLength(3);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('finds a last record far longer than 64 KiB', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const first = new JsonlAuditLog({ path });
    first.write(event());
    first.write(event({ attachments: Array.from({ length: 2000 }, attachment) }));
    await first.close();

    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines.at(-1)!.length).toBeGreaterThan(4 * 64 * 1024);
    expect(readHead(path)).toBe(first.headHash);

    const second = new JsonlAuditLog({ path });
    expect(second.startedFrom).toEqual({ from: 'existing', head: first.headHash });
    second.write(event());
    await second.close();

    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records).toHaveLength(3);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('walks back over a junk line longer than the first window', async () => {
    const path = await trail(2);
    const head = parse(path).records[1]!.hash;
    appendFileSync(path, `${'x'.repeat(300 * 1024)}\n`);
    expect(readHead(path)).toBe(head);
  });

  it('says so when a non-empty trail holds no record at all', async () => {
    const path = join(workspace(), 'audit.jsonl');
    writeFileSync(path, 'not a trail\n');
    const { log, messages } = writer(path);
    expect(log.startedFrom.from).toBe('genesis');
    expect(messages.join('\n')).toContain('holds no readable record');
    await log.close();
  });

  it.skipIf(isRoot)('refuses to start in a directory it cannot write to', () => {
    const locked = join(workspace(), 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    try {
      const error = thrown(() => new JsonlAuditLog({ path: join(locked, 'audit.jsonl') }));
      expect(error?.code).toBe('EACCES');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(isRoot)('refuses to start on a trail it cannot append to', async () => {
    const path = await trail(1);
    chmodSync(path, 0o444);
    const error = thrown(() => new JsonlAuditLog({ path }));
    expect(error?.code).toBe('EACCES');
  });

  it('refuses to start when the path is a directory', () => {
    const error = thrown(() => new JsonlAuditLog({ path: workspace() }));
    expect(error?.code).toBe('EISDIR');
  });

  it('creates a new trail readable by owner and group only', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const log = new JsonlAuditLog({ path });
    await log.close();
    // The umask can only take permissions away, never add the world's.
    expect(statSync(path).mode & 0o007).toBe(0);
  });
});

describe('a trail changed under a running writer', () => {
  it('reopens at the path when the file is moved aside, and leaves the old chain intact', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path);
    log.write(event({ status: 200 }));
    log.write(event({ status: 201 }));
    const rotatedHead = log.headHash;

    renameSync(path, `${path}.1`);
    log.write(event({ status: 202 }));
    await log.close();

    expect(messages.some((message) => message.includes('moved or deleted'))).toBe(true);
    expect(messages.some((message) => message.includes(rotatedHead))).toBe(true);

    const rotated = parse(`${path}.1`).records;
    expect(rotated.map((record) => record.status)).toEqual([200, 201]);
    expect(verifyChain(rotated)).toMatchObject({ ok: true, head: rotatedHead });

    const fresh = parse(path).records;
    expect(fresh.map((record) => record.status)).toEqual([202]);
    expect(fresh[0]!.prev).toBe(GENESIS_HASH);
    expect(verifyChain(fresh).ok).toBe(true);
    expect(log.droppedRecords).toBe(0);
  });

  it('recreates the file when it is deleted, instead of writing to an orphan', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path);
    log.write(event({ status: 200 }));

    rmSync(path);
    log.write(event({ status: 201 }));
    await log.close();

    expect(messages.some((message) => message.includes('moved or deleted'))).toBe(true);
    const { records } = parse(path);
    expect(records.map((record) => record.status)).toEqual([201]);
    expect(verifyChain(records).ok).toBe(true);
  });

  it('warns when the file is truncated, and keeps the chain verifiable across the copy', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path);
    log.write(event({ status: 200 }));
    log.write(event({ status: 201 }));
    const head = log.headHash;

    // copytruncate: copy the file, then cut the original to nothing.
    const copy = parseAuditLines(readFileSync(path, 'utf8')).records;
    truncateSync(path, 0);
    log.write(event({ status: 202 }));
    await log.close();

    expect(messages.some((message) => message.includes('shrank'))).toBe(true);
    const { records, malformed } = parse(path);
    expect(malformed).toEqual([]);
    expect(records.map((record) => record.status)).toEqual([202]);
    expect(records[0]!.prev).toBe(head);
    expect(verifyChain([...copy, ...records]).ok).toBe(true);
  });
});

describe('closing', () => {
  it('flushes the trail to disk before it closes it, once', async () => {
    const calls: string[] = [];
    const { log } = writer(join(workspace(), 'audit.jsonl'), {
      fdatasyncSync: (fd) => {
        calls.push('sync');
        fdatasyncSync(fd);
      },
      closeSync: (fd) => {
        calls.push('close');
        closeSync(fd);
      },
    });
    log.write(event());
    await log.close();
    await log.close();
    expect(calls).toEqual(['sync', 'close']);
  });

  it('counts and reports a record that arrives after close', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log, messages } = writer(path);
    log.write(event());
    await log.close();

    expect(() => log.write(event())).not.toThrow();
    expect(log.droppedRecords).toBe(1);
    expect(messages.at(-1)).toContain('record arrived after the trail was closed');
    expect(parse(path).records).toHaveLength(1);
  });
});

describe('record validation', () => {
  it('writes invalid for an outcome, mode, policy or attachment outcome outside its set', () => {
    const smuggled = {
      ...event(),
      outcome: 'anna@example.com',
      policies: { EMAIL: { policy: 'pseudonymize', sample: 'anna@example.com' }, IBAN: 'redact' },
      residency: {
        mode: { mode: 'sanitize', note: 'anna@example.com' },
        rule: 'residency.mode',
        jurisdiction: 'FR',
        controls: [],
      },
      attachments: [{ ...attachment(), outcome: 'anna@example.com' }],
    } as unknown as AuditEvent;

    const record = toRecord(smuggled, '2026-01-01T00:00:00.000Z', 'id-1');
    expect(record.outcome).toBe(INVALID_VALUE);
    expect(record.policies).toEqual({ EMAIL: INVALID_VALUE, IBAN: 'redact' });
    expect(record.residency!.mode).toBe(INVALID_VALUE);
    expect(record.attachments![0]!.outcome).toBe(INVALID_VALUE);
    expect(JSON.stringify(record)).not.toContain('anna@example.com');
  });

  it('accepts every value of each closed set unchanged', () => {
    for (const outcome of ['forwarded', 'blocked', 'rejected', 'failed'] as const) {
      expect(toRecord(event({ outcome }), 't', 'i').outcome).toBe(outcome);
    }
    for (const mode of ['block', 'sanitize', 'warn', 'allow'] as const) {
      const residency = { mode, rule: 'r', jurisdiction: 'FR', controls: [] };
      expect(toRecord(event({ residency }), 't', 'i').residency!.mode).toBe(mode);
    }
    for (const policy of ['pseudonymize', 'redact', 'hash', 'allow', 'block'] as const) {
      expect(toRecord(event({ policies: { EMAIL: policy } }), 't', 'i').policies).toEqual({
        EMAIL: policy,
      });
    }
    for (const outcome of ['extracted', 'truncated', 'withheld', 'forwarded', 'blocked'] as const) {
      const attachments = [{ ...attachment(), outcome }];
      expect(toRecord(event({ attachments }), 't', 'i').attachments![0]!.outcome).toBe(outcome);
    }
  });

  it('does not throw on values JSON or String cannot handle', () => {
    const hostile = {
      ...event(),
      route: {
        toString(): string {
          throw new Error('no');
        },
      },
      status: Symbol('status'),
      tokens: 10n,
      policies: { EMAIL: 10n },
      findings: null,
      residency: { mode: 'sanitize', rule: 'r', jurisdiction: 'FR', controls: 'none' },
      attachments: 'none',
    } as unknown as AuditEvent;

    const record = toRecord(hostile, '2026-01-01T00:00:00.000Z', 'id-1');
    expect(record.route).toBe(INVALID_VALUE);
    expect(record.tokens).toBe(10);
    expect(record.policies).toEqual({ EMAIL: INVALID_VALUE });
    expect(record.findings).toEqual({});
    expect(record.residency!.controls).toEqual([INVALID_VALUE]);
    expect(record.attachments).toEqual([]);
    const parsed = JSON.parse(JSON.stringify(record)) as AuditRecord;
    expect(parsed.status).toBeNull();
    expect(recomputeHash(parsed)).toBe(record.hash);
  });

  it('writes the record rather than losing it when an event carries a BigInt', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const { log } = writer(path);
    expect(() =>
      log.write(event({ policies: { EMAIL: 1n } } as unknown as Partial<AuditEvent>)),
    ).not.toThrow();
    await log.close();

    expect(log.droppedRecords).toBe(0);
    const { records } = parse(path);
    expect(records[0]!.policies).toEqual({ EMAIL: INVALID_VALUE });
    expect(verifyChain(records).ok).toBe(true);
  });
});

describe('record fields added for gaps and residency', () => {
  it('copies the admitting endpoint as the last residency key', () => {
    const residency = {
      mode: 'sanitize' as const,
      rule: 'residency.allow',
      jurisdiction: 'FR',
      controls: ['zero-retention'],
      endpoint: 'https://api.mistral.ai',
    };
    const record = toRecord(event({ residency }), 't', 'i');
    expect(Object.keys(record.residency!)).toEqual([
      'mode',
      'rule',
      'jurisdiction',
      'controls',
      'endpoint',
    ]);
    expect(record.residency!.endpoint).toBe('https://api.mistral.ai');
    const parsed = JSON.parse(JSON.stringify(record)) as AuditRecord;
    expect(recomputeHash(parsed)).toBe(record.hash);
  });

  it('writes a null endpoint when the caller says no allowlist entry decided', () => {
    const residency = { mode: 'warn' as const, rule: 'r', jurisdiction: 'US', controls: [], endpoint: null };
    expect(toRecord(event({ residency }), 't', 'i').residency).toHaveProperty('endpoint', null);
  });

  it('leaves the residency shape untouched for a caller that does not supply an endpoint', () => {
    const record = toRecord(event(), 't', 'i');
    expect(Object.keys(record.residency!)).toEqual(['mode', 'rule', 'jurisdiction', 'controls']);
    // The exact line an older hushgate would have written for the same event.
    expect(JSON.stringify(record)).toContain(
      '"residency":{"mode":"sanitize","rule":"residency.mode","jurisdiction":"FR","controls":[]},',
    );
  });

  it('writes dropped just before prev, and only as a positive integer', () => {
    const record = toRecord(event(), 't', 'i', GENESIS_HASH, 3);
    expect(Object.keys(record).slice(-3)).toEqual(['dropped', 'prev', 'hash']);
    expect(record.dropped).toBe(3);
    const parsed = JSON.parse(JSON.stringify(record)) as AuditRecord;
    expect(recomputeHash(parsed)).toBe(record.hash);

    for (const dropped of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Object.hasOwn(toRecord(event(), 't', 'i', GENESIS_HASH, dropped), 'dropped')).toBe(
        false,
      );
    }
    expect(toRecord(event(), 't', 'i', GENESIS_HASH, 0).hash).toBe(toRecord(event(), 't', 'i').hash);
  });
});
