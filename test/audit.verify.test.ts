import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HushgateError } from '../src/errors.js';
import {
  GENESIS_HASH,
  hashBody,
  toRecord,
  type AuditEvent,
  type AuditRecord,
} from '../src/audit/record.js';
import {
  parseAuditLines,
  parseTrailLine,
  printable,
  readTrailEntries,
  type TrailRecord,
} from '../src/audit/trail.js';
import {
  ChainVerifier,
  REPORTED_LIMIT,
  verifyChain,
  verifyTrail,
  verifyTrailFile,
} from '../src/audit/verify.js';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-verify-'));
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

const at = (i: number): string => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();

/**
 * `count` records chained as the writer chains them, starting from `from`.
 * `dropped` maps a 1-based record index to the count that record carries,
 * written just before `prev` as the writer writes it.
 */
function chain(
  count: number,
  options: { from?: string; dropped?: Readonly<Record<number, number>>; tenant?: string } = {},
): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prev = options.from ?? GENESIS_HASH;
  for (let i = 0; i < count; i += 1) {
    const base = toRecord(
      event({ status: 200 + i, tenant: options.tenant ?? null }),
      at(i),
      `id-${i + 1}`,
      prev,
    );
    const dropped = options.dropped?.[i + 1];
    let record = base;
    if (dropped !== undefined) {
      const { prev: link, hash: _hash, ...rest } = base;
      const body = { ...rest, dropped, prev: link };
      record = { ...body, hash: hashBody(body) };
    }
    out.push(record);
    prev = record.hash;
  }
  return out;
}

/** Recompute a record's hash, as a forger who knows the scheme would. */
function rehash(record: Omit<AuditRecord, 'hash'>): AuditRecord {
  const { hash: _ignored, ...body } = record as AuditRecord;
  return { ...body, hash: hashBody(body) };
}

const jsonl = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const text = (records: readonly AuditRecord[]): string => jsonl(records.map((r) => JSON.stringify(r)));

function file(contents: string | Buffer): string {
  const path = join(workspace(), 'audit.jsonl');
  writeFileSync(path, contents);
  return path;
}

function errorCode(fn: () => unknown): unknown {
  try {
    fn();
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code;
  }
  return undefined;
}

const ESC = String.fromCharCode(0x1b);
const escaped = (hex: string): string => `${'\\'}u${hex}`;

describe('reading a trail in chunks', () => {
  it('reads a file a few bytes at a time to exactly what parseAuditLines makes of it', () => {
    const records = chain(4, { tenant: 'zürich-€-𝄞' });
    const contents =
      `\n${JSON.stringify(records[0])}\n` +
      `${JSON.stringify(records[1])}\r\n` +
      'not json at all\n' +
      '   \n' +
      `${JSON.stringify(records[2])}\n` +
      // The last line has no newline, as after an interrupted write.
      `${JSON.stringify(records[3])}`;
    const path = file(contents);
    const expected = parseAuditLines(contents).entries;
    expect(expected.filter((entry) => 'record' in entry)).toHaveLength(4);

    for (const chunkBytes of [1, 2, 3, 7, 64, 1024 * 1024]) {
      expect([...readTrailEntries(path, { chunkBytes })]).toEqual(expected);
    }
    expect(verifyTrailFile(path, { chunkBytes: 3 })).toEqual(verifyTrail(expected));
  });

  it('reports the same line numbers the text has, blank lines included', () => {
    const records = chain(2);
    const path = file(`\n\n${JSON.stringify(records[0])}\n\n${JSON.stringify(records[1])}\n\n`);
    const lines = [...readTrailEntries(path, { chunkBytes: 5 })].map((entry) => entry.line);
    expect(lines).toEqual([3, 5]);
    expect(parseAuditLines(readFileSync(path, 'utf8')).lines).toEqual([3, 5]);
  });

  it('reports a line longer than the limit without assembling it, and reads on', () => {
    const records = chain(2);
    const huge = 'x'.repeat(5000);
    const path = file(`${JSON.stringify(records[0])}\n${huge}\n${JSON.stringify(records[1])}\n${huge}`);

    for (const chunkBytes of [64, 1024 * 1024]) {
      const entries = [...readTrailEntries(path, { chunkBytes, maxLineBytes: 2000 })];
      expect(entries.map((entry) => entry.line)).toEqual([1, 2, 3, 4]);
      expect(entries[1]).toEqual({ line: 2, malformed: 'line is longer than 2000 bytes' });
      expect(entries[3]).toEqual({ line: 4, malformed: 'line is longer than 2000 bytes' });
      expect((entries[2] as TrailRecord).record.id).toBe('id-2');
    }
  });

  it('reports bytes that are not UTF-8 rather than quietly replacing them', () => {
    const records = chain(1);
    const line = Buffer.from(JSON.stringify(records[0]), 'utf8');
    // Swap one byte of the id for 0xff, which UTF-8 never uses.
    line[line.indexOf('id-1')] = 0xff;
    const path = file(Buffer.concat([line, Buffer.from('\n')]));
    expect([...readTrailEntries(path)]).toEqual([{ line: 1, malformed: 'not valid UTF-8' }]);
  });

  it('refuses a line that gained a byte-order mark in an editor', () => {
    const records = chain(1);
    const path = file(`${String.fromCharCode(0xfeff)}${JSON.stringify(records[0])}\n`);
    const [entry] = [...readTrailEntries(path)];
    expect(entry).toMatchObject({ line: 1, malformed: expect.stringMatching(/^not valid JSON/u) });
  });

  it('throws the file system error unchanged, so a caller can tell missing from unreadable', () => {
    const dir = workspace();
    mkdirSync(join(dir, 'a-directory'));
    expect(errorCode(() => verifyTrailFile(join(dir, 'nothing.jsonl')))).toBe('ENOENT');
    expect(errorCode(() => verifyTrailFile(join(dir, 'a-directory')))).toBe('EISDIR');
  });
});

describe('unreadable lines', () => {
  it('never repeats the content of a line it could not read', () => {
    const path = file(
      jsonl([
        'Anna Schmidt, IBAN DE89370400440532013000',
        '{"ts": Anna Schmidt}',
        '{"ts":"t" Anna Schmidt}',
        '{"ts":"Anna Schmidt',
        `${ESC}[8mAnna Schmidt`,
      ]),
    );
    const result = verifyTrailFile(path);

    expect(result.ok).toBe(false);
    expect(result.malformedCount).toBe(5);
    for (const { reason } of result.malformed) {
      expect(reason).toMatch(/^not valid JSON( \(at position \d+\))?$/u);
    }
    expect(result.malformed.map(({ reason }) => reason)).toContain('not valid JSON (at position 10)');
    const everything = JSON.stringify(result);
    expect(everything).not.toContain('Anna');
    expect(everything).not.toContain('DE89');
    expect(everything).not.toContain(ESC);
  });

  it('names the field at fault in a record that cannot be verified', () => {
    const [record] = chain(1);
    const reasons = [
      { ...record, hash: null },
      { ...record, prev: 5 },
      { ...record, id: 7 },
      { ...record, ts: undefined },
      { ...record, prev: 'A'.repeat(64) },
      { ...record, dropped: '3' },
      { ...record, dropped: -1 },
      [record],
    ].map((value, index) => parseTrailLine(JSON.stringify(value), index + 1));

    expect(reasons).toEqual([
      { line: 1, malformed: 'hash is not a 64-character hex hash' },
      { line: 2, malformed: 'prev is not a 64-character hex hash' },
      { line: 3, malformed: 'id is not a string' },
      { line: 4, malformed: 'ts is missing' },
      { line: 5, malformed: 'prev is not a 64-character hex hash' },
      { line: 6, malformed: 'dropped is not a whole number' },
      { line: 7, malformed: 'dropped is not a whole number' },
      { line: 8, malformed: 'not a JSON object' },
    ]);
  });

  it('fails a trail whose last record was replaced by junk, though the chain before it holds', () => {
    const records = chain(3);
    const lines = records.map((r) => JSON.stringify(r));
    lines[2] = '{"ts":"x"';
    const result = verifyTrailFile(file(jsonl(lines)));

    expect(result.verification.ok).toBe(true);
    expect(result.verification.records).toBe(2);
    expect(result.malformed).toEqual([{ line: 3, reason: 'not valid JSON (at position 9)' }]);
    expect(result.ok).toBe(false);
  });
});

describe('wrongly typed fields', () => {
  it('treats a hash that is not a string as an altered record instead of throwing', () => {
    const records = chain(4);
    const tampered = [...records];
    tampered[1] = { ...records[1]!, hash: null as unknown as string };

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.firstBreak).toMatchObject({ index: 2, reason: 'altered' });
    expect(result.firstBreak!.detail).toContain('(not a hash: null)');
    // Only the hash was damaged: the next record still links to what it was.
    expect(result.breakCount).toBe(1);
  });

  it('treats a prev that is not a string as an unlinked record instead of throwing', () => {
    const records = chain(3);
    const forged = rehash({ ...records[1]!, prev: 5 as unknown as string });

    const result = verifyChain([records[0]!, forged, records[2]!]);
    expect(result.firstBreak).toMatchObject({ index: 2, reason: 'unlinked' });
    expect(result.firstBreak!.detail).toContain('(not a hash: number)');
  });

  it('treats an id that is not a string as part of an altered record', () => {
    const records = chain(2);
    const result = verifyChain([records[0]!, { ...records[1]!, id: 7 as unknown as string }]);
    expect(result.firstBreak).toMatchObject({ index: 2, id: '', reason: 'altered' });
  });

  it('treats something that is not an object at all as an altered record', () => {
    const records = chain(2);
    for (const junk of [null, 'record', 42, [records[0]]]) {
      const result = verifyChain([records[0]!, junk as unknown as AuditRecord, records[1]!]);
      expect(result.firstBreak).toMatchObject({
        index: 2,
        reason: 'altered',
        detail: 'record is not a JSON object',
      });
    }
  });
});

describe('walking the whole chain', () => {
  it('finds one break for one edited record in five, and the records after it still verify', () => {
    const records = chain(5);
    const tampered = [...records];
    tampered[1] = { ...records[1]!, tokens: 999_999 };

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.breakCount).toBe(1);
    expect(result.breaks).toEqual([
      expect.objectContaining({ index: 2, id: 'id-2', ts: at(1), reason: 'altered' }),
    ]);
    expect(result.firstBreak).toEqual(result.breaks[0]);
    // The head is the file's tail, not the last record before the break.
    expect(result.head).toBe(records[4]!.hash);
  });

  it('finds two breaks for two separate edits', () => {
    const records = chain(6);
    const tampered = [...records];
    tampered[1] = { ...records[1]!, status: 500 };
    tampered[4] = { ...records[4]!, status: 500 };

    const result = verifyChain(tampered);
    expect(result.breakCount).toBe(2);
    expect(result.breaks.map(({ index, reason }) => ({ index, reason }))).toEqual([
      { index: 2, reason: 'altered' },
      { index: 5, reason: 'altered' },
    ]);
  });

  it('finds one break where a record was inserted', () => {
    const records = chain(4);
    const forged = toRecord(event({ status: 999 }), at(9), 'forged', 'a'.repeat(64));
    const result = verifyChain([...records.slice(0, 2), forged, ...records.slice(2)]);

    expect(result.breakCount).toBe(1);
    expect(result.firstBreak).toMatchObject({ index: 3, id: 'forged', reason: 'unlinked' });
  });

  it('finds one break where a record was removed', () => {
    const records = chain(5);
    const result = verifyChain([...records.slice(0, 2), ...records.slice(3)]);

    expect(result.breakCount).toBe(1);
    expect(result.firstBreak).toMatchObject({ index: 3, id: 'id-4', reason: 'unlinked' });
    expect(result.firstBreak!.detail).toContain('the record before it hashes to');
  });

  it('finds one break where a record was repeated', () => {
    const records = chain(3);
    const result = verifyChain([records[0]!, records[1]!, records[1]!, records[2]!]);

    expect(result.breakCount).toBe(1);
    expect(result.firstBreak).toMatchObject({ index: 3, reason: 'unlinked' });
  });

  it('gives the file line of each break, counting blank and unreadable lines', () => {
    const records = chain(4);
    const altered = { ...records[2]!, tokens: 1 };
    const contents = jsonl([
      '',
      JSON.stringify(records[0]),
      'garbage',
      '',
      JSON.stringify(records[1]),
      '{}',
      JSON.stringify(altered),
      JSON.stringify(records[3]),
    ]);
    const result = verifyTrailFile(file(contents));

    expect(result.verification.breaks).toEqual([
      expect.objectContaining({ index: 3, line: 7, reason: 'altered' }),
    ]);
    expect(result.malformed).toEqual([
      { line: 3, reason: 'not valid JSON' },
      { line: 6, reason: 'ts is missing' },
    ]);
  });

  it('lists at most a hundred breaks and unreadable lines, but counts them all', () => {
    const count = REPORTED_LIMIT + 50;
    // Every record carries a hash left over from somewhere else, and every one
    // is followed by a line that is not a record at all.
    const lines = chain(count).flatMap((record) => [
      JSON.stringify(Object.assign(record, { hash: 'f'.repeat(64) })),
      'garbage',
    ]);
    const result = verifyTrailFile(file(jsonl(lines)));

    expect(result.verification.breakCount).toBe(count);
    expect(result.verification.breaks).toHaveLength(REPORTED_LIMIT);
    expect(result.malformedCount).toBe(count);
    expect(result.malformed).toHaveLength(REPORTED_LIMIT);
  });

  it('repeats only the start of an id a tamperer made enormous', () => {
    const records = chain(1);
    const result = verifyChain([{ ...records[0]!, id: 'x'.repeat(100_000) }]);
    expect(result.firstBreak!.id.length).toBeLessThanOrEqual(129);
  });

  it('gives the same verdict pushed one record at a time as all at once', () => {
    const records = chain(6);
    const tampered = [...records];
    tampered[3] = { ...records[3]!, latencyMs: 1 };
    const verifier = new ChainVerifier({ anchors: [records[1]!.hash] });
    for (const record of tampered) verifier.push(record);
    expect(verifier.result()).toEqual(verifyChain(tampered, { anchors: [records[1]!.hash] }));
  });
});

describe('a trail that does not start at genesis', () => {
  it('verifies a pruned trail from the hash of the last record removed', () => {
    const records = chain(5);
    const pruned = records.slice(2);

    expect(verifyChain(pruned).firstBreak).toMatchObject({ index: 1, reason: 'unlinked' });

    const result = verifyChain(pruned, { from: records[1]!.hash });
    expect(result.ok).toBe(true);
    expect(result.from).toBe(records[1]!.hash);
    expect(result.head).toBe(records[4]!.hash);

    const path = file(text(pruned));
    expect(verifyTrailFile(path, { from: records[1]!.hash.toUpperCase() }).ok).toBe(true);
  });

  it('fails at record 1, and only there, when told the wrong starting hash', () => {
    const records = chain(5).slice(2);
    const result = verifyTrailFile(file(text(records)), { from: 'a'.repeat(64) });

    expect(result.ok).toBe(false);
    expect(result.verification.breakCount).toBe(1);
    expect(result.verification.firstBreak).toMatchObject({ index: 1, line: 1, reason: 'unlinked' });
    expect(result.verification.firstBreak!.detail).toContain('the chain starts from aaaaaaaaaaaa');
  });

  it('refuses a starting hash that is not one', () => {
    expect(() => verifyChain([], { from: 'not-a-hash' })).toThrow(HushgateError);
  });
});

describe('anchors', () => {
  it('confirms an anchor still in the trail and says how many records follow it', () => {
    const records = chain(5);
    const result = verifyTrailFile(file(text(records)), { anchors: [records[2]!.hash] });

    expect(result.ok).toBe(true);
    expect(result.verification.anchors).toEqual([
      { hash: records[2]!.hash, found: true, index: 3, line: 3, following: 2 },
    ]);
  });

  it('fails when an anchor is gone: the trail was truncated', () => {
    const records = chain(5);
    const result = verifyChain(records.slice(0, 3), {
      anchors: [records[1]!.hash, records[4]!.hash],
    });

    // The shortened chain is consistent; only the anchor gives it away.
    expect(result.breakCount).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.anchors).toEqual([
      { hash: records[1]!.hash, found: true, index: 2, line: null, following: 1 },
      { hash: records[4]!.hash, found: false, index: null, line: null, following: null },
    ]);
  });

  it('fails an empty trail that was expected to hold an anchor', () => {
    const anchor = chain(1)[0]!.hash;
    const result = verifyTrailFile(file(''), { anchors: [anchor] });
    expect(result.verification.records).toBe(0);
    expect(result.ok).toBe(false);
  });

  it('does not count an anchor carried by a record that no longer verifies', () => {
    const records = chain(3);
    const tampered = [records[0]!, { ...records[1]!, tokens: 0 }, records[2]!];
    const result = verifyChain(tampered, { anchors: [records[1]!.hash] });
    expect(result.anchors[0]).toMatchObject({ found: false });
  });

  it('refuses an anchor that is not a full hash', () => {
    const records = chain(1);
    expect(() => verifyChain(records, { anchors: [records[0]!.hash.slice(0, 12)] })).toThrow(
      HushgateError,
    );
  });
});

describe('lines not in canonical form', () => {
  it('still verifies a trail exactly as hushgate wrote it', () => {
    const result = verifyTrailFile(file(text(chain(3))));
    expect(result.ok).toBe(true);
  });

  it('does not verify a line carrying a duplicate-key decoy', () => {
    const records = chain(3);
    const lines = records.map((r) => JSON.stringify(r));
    // JSON.parse keeps the last of two keys, so the hash still matches, while
    // grep and a first-wins reader see the decoy.
    lines[1] = lines[1]!.replace('"outcome":"forwarded"', '"outcome":"blocked","outcome":"forwarded"');
    const contents = jsonl(lines);

    const entry = parseAuditLines(contents).entries[1] as TrailRecord;
    expect(entry.canonical).toBe(false);

    const result = verifyTrailFile(file(contents));
    expect(result.ok).toBe(false);
    expect(result.verification.breakCount).toBe(1);
    expect(result.verification.firstBreak).toMatchObject({ index: 2, line: 2, reason: 'altered' });
    expect(result.verification.firstBreak!.detail).toContain('canonical form');
  });

  it('does not verify a line with whitespace added', () => {
    const records = chain(2);
    const lines = records.map((r) => JSON.stringify(r));
    lines[0] = lines[0]!.replaceAll('","', '", "');
    const result = verifyTrailFile(file(jsonl(lines)));
    expect(result.verification.breaks).toEqual([
      expect.objectContaining({ index: 1, reason: 'altered' }),
    ]);
  });
});

describe('dropped records', () => {
  it('reports a record carrying a dropped count as a gap where it happened, not as a break', () => {
    const records = chain(5, { dropped: { 3: 4, 5: 1 } });
    const result = verifyTrailFile(file(text(records)));

    expect(result.ok).toBe(true);
    expect(result.verification.breakCount).toBe(0);
    expect(result.verification.gaps).toEqual([
      { index: 3, line: 3, id: 'id-3', ts: at(2), dropped: 4 },
      { index: 5, line: 5, id: 'id-5', ts: at(4), dropped: 1 },
    ]);
    expect(result.verification.gapCount).toBe(2);
    expect(result.verification.dropped).toBe(5);
  });

  it('cannot have a dropped count erased without the record failing to verify', () => {
    const [, , third] = chain(3, { dropped: { 3: 4 } });
    const forged = { ...third!, dropped: 0 };
    expect(verifyChain([...chain(2), forged]).firstBreak).toMatchObject({ reason: 'altered' });
  });
});

describe('printable', () => {
  it('escapes the escape character, so a record cannot steer the terminal', () => {
    expect(printable(`${ESC}[1A${ESC}[2K  chain        intact`)).toBe(
      `${escaped('001b')}[1A${escaped('001b')}[2K  chain        intact`,
    );
  });

  it('escapes C1 controls, DEL, newlines and bidirectional overrides as well', () => {
    const csi = String.fromCharCode(0x9b);
    const del = String.fromCharCode(0x7f);
    const rlo = String.fromCharCode(0x202e);
    const separator = String.fromCharCode(0x2028);
    expect(printable(`a${csi}b${del}c\nd\te${rlo}f${separator}g`)).toBe(
      `a${escaped('009b')}b${escaped('007f')}c${escaped('000a')}d${escaped('0009')}e${escaped('202e')}f${escaped('2028')}g`,
    );
  });

  it('leaves ordinary text alone, accents and all', () => {
    expect(printable('Grüße aus Zürich — 2026-01-01T00:00:00.000Z')).toBe(
      'Grüße aus Zürich — 2026-01-01T00:00:00.000Z',
    );
  });
});
