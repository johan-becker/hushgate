/**
 * Reading a trail back.
 *
 * The writer in `log.ts` only ever appends; everything that reads a trail —
 * `hushgate audit`, `hushgate doctor`, the report — starts here.
 *
 * A trail is evidence that somebody may have tampered with, so nothing on a
 * line is taken on trust: not its shape, not its encoding, not its length, and
 * not the text in its fields. What this module hands on is either a record that
 * carries the fields verification depends on, or a line number and a reason
 * that names the field at fault without repeating anything the line contained.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import { jsonErrorPosition } from '../json-error.js';
import type { AuditRecord } from './record.js';

/** A line that held a record. */
export interface TrailRecord {
  /** 1-based line number in the file, counting blank lines. */
  readonly line: number;
  readonly record: AuditRecord;
  /**
   * Whether the line is byte for byte what hushgate would have written for the
   * record it parses to. The hash covers the parsed values, not the text, so a
   * line with a duplicate key or added whitespace can hash correctly while
   * showing `grep` — or any reader that keeps the first of two keys — something
   * other than what was hashed. Every line hushgate writes is canonical.
   */
  readonly canonical: boolean;
}

/** A line that did not hold a record. */
export interface MalformedEntry {
  readonly line: number;
  /** Why not, naming the field at fault. Never any of the line's content. */
  readonly malformed: string;
}

/** One non-blank line of a trail, in file order. */
export type TrailEntry = TrailRecord | MalformedEntry;

/** An unreadable line, as summaries list it. */
export interface MalformedLine {
  readonly line: number;
  readonly reason: string;
}

export interface TrailReadOptions {
  /** Bytes read per system call. Tests make it tiny to exercise chunk boundaries. */
  readonly chunkBytes?: number;
  /** The longest line read as a record; a longer one is reported, never buffered. */
  readonly maxLineBytes?: number;
}

/** Read a trail a megabyte at a time: large enough to be quick, small enough to never matter. */
export const TRAIL_CHUNK_BYTES = 1024 * 1024;

/**
 * The longest line taken for a record.
 *
 * A real record is well under a kilobyte, and a request with a few hundred
 * attachments stays far below this. The cap exists so that a file which has
 * lost its newlines — or was replaced by one huge line — is reported as such
 * instead of being assembled in memory until the process falls over.
 */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

/** Whether a value is a hash as hushgate writes one: 64 lower-case hex digits. */
export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

/**
 * Read a trail file one entry at a time.
 *
 * Synchronous on purpose, so the CLI and `hushgate doctor` — which is
 * synchronous throughout — share one reader. The file is read in chunks and
 * split on newline bytes, so neither the whole file nor an array of its
 * records is ever held: V8 refuses to build a string longer than 512 MiB, and a
 * busy office reaches that in a few months. Splitting on the byte rather than
 * on decoded text is safe because a newline byte never occurs inside a
 * multi-byte UTF-8 sequence, and a line split across two chunks is decoded
 * only once it is whole.
 *
 * Errors opening or reading the file — ENOENT, EISDIR, EACCES — are thrown
 * unchanged, so a caller can tell a trail that does not exist yet from one it
 * is not allowed to read.
 */
export function* readTrailEntries(
  path: string,
  options: TrailReadOptions = {},
): Generator<TrailEntry, void, undefined> {
  const chunkBytes = positive(options.chunkBytes, TRAIL_CHUNK_BYTES, 'chunkBytes');
  const maxLineBytes = positive(options.maxLineBytes, MAX_LINE_BYTES, 'maxLineBytes');
  // Fatal, so a byte sequence that is not UTF-8 is reported rather than quietly
  // replaced by U+FFFD; and the byte-order mark is kept, so a line that gained
  // one in an editor fails to parse instead of being read as if it had not.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const chunk = Buffer.alloc(chunkBytes);
  const handle = openSync(path, 'r');

  try {
    // The start of a line that began in an earlier chunk.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let overlong = false;
    let line = 0;

    const take = (view: Buffer, start: number, end: number): void => {
      if (overlong || end === start) return;
      if (pendingBytes + (end - start) > maxLineBytes) {
        overlong = true;
        pending = [];
        pendingBytes = 0;
        return;
      }
      pending.push(Buffer.from(view.subarray(start, end)));
      pendingBytes += end - start;
    };

    const finish = (): TrailEntry | null => {
      line += 1;
      if (overlong) {
        overlong = false;
        return { line, malformed: `line is longer than ${maxLineBytes} bytes` };
      }
      const bytes = Buffer.concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      return decodeLine(decoder, bytes, line);
    };

    for (;;) {
      const read = readSync(handle, chunk, 0, chunkBytes, null);
      if (read === 0) break;

      const view = chunk.subarray(0, read);
      let start = 0;
      for (let newline = view.indexOf(0x0a); newline !== -1; newline = view.indexOf(0x0a, start)) {
        let entry: TrailEntry | null;
        if (pendingBytes === 0 && !overlong && newline - start <= maxLineBytes) {
          // The whole line is in this chunk: decode it in place, no copy.
          line += 1;
          entry = decodeLine(decoder, view.subarray(start, newline), line);
        } else {
          take(view, start, newline);
          entry = finish();
        }
        if (entry !== null) yield entry;
        start = newline + 1;
      }
      take(view, start, read);
    }

    // A last line without a newline — the writer was interrupted, or the file
    // was edited by hand — is still a line.
    if (pendingBytes > 0 || overlong) {
      const entry = finish();
      if (entry !== null) yield entry;
    }
  } finally {
    closeSync(handle);
  }
}

/**
 * Parse a JSONL audit file already held as text.
 *
 * The same rules as {@link readTrailEntries}, for callers that have the text
 * anyway. `records` and `lines` are parallel: `lines[i]` is the file line
 * `records[i]` came from. `entries` is everything in file order, which is what
 * `verifyTrail` takes so that non-canonical lines are judged as such.
 */
export function parseAuditLines(text: string): {
  records: AuditRecord[];
  lines: number[];
  entries: TrailEntry[];
  malformed: MalformedLine[];
} {
  const records: AuditRecord[] = [];
  const lines: number[] = [];
  const entries: TrailEntry[] = [];
  const malformed: MalformedLine[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    const entry = parseTrailLine(raw, index + 1);
    if (entry === null) continue;
    entries.push(entry);
    if ('malformed' in entry) {
      malformed.push({ line: entry.line, reason: entry.malformed });
    } else {
      records.push(entry.record);
      lines.push(entry.line);
    }
  }

  return { records, lines, entries, malformed };
}

/**
 * Parse one line of a trail, or return `null` for a blank one.
 *
 * A trailing carriage return is dropped first, so a trail that passed through
 * a Windows tool still reads. Beyond being JSON, a line has to carry the fields
 * that identify and chain a record — `ts`, `id`, `route`, `prev` and `hash` —
 * because a record without them cannot be verified, only guessed at, and the
 * verifier would otherwise have to defend against every shape a line can take.
 */
export function parseTrailLine(raw: string, line: number): TrailEntry | null {
  const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (text.trim().length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const position = jsonErrorPosition(cause);
    return {
      line,
      malformed: position === null ? 'not valid JSON' : `not valid JSON (at position ${position})`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { line, malformed: 'not a JSON object' };
  }

  const problem = shapeProblem(parsed as Record<string, unknown>);
  if (problem !== null) return { line, malformed: problem };

  return { line, record: parsed as AuditRecord, canonical: text === JSON.stringify(parsed) };
}

/** Characters that steer a terminal or reorder what it shows, rather than being shown. */
// oxlint-disable-next-line no-control-regex -- matching them is the point
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Make text from a trail safe to print on a terminal.
 *
 * A record's id and timestamp are whatever the line says they are, and a
 * tamperer chooses them. Printed raw, an id holding `ESC[1A ESC[2K` moves the
 * cursor up and erases the `BROKEN` line an auditor was about to read, and
 * `ESC[8m` hides everything after it. C0 and C1 control characters are
 * therefore written as `\u` escapes, and so are the bidirectional overrides
 * and line separators that can reorder or split a line without a control
 * character. JSON output needs none of this: `JSON.stringify` already escapes
 * control characters.
 */
export function printable(text: string): string {
  return text.replace(
    UNPRINTABLE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** The first field a record cannot be verified without, and what is wrong with it. */
function shapeProblem(fields: Record<string, unknown>): string | null {
  for (const name of ['ts', 'id', 'route'] as const) {
    if (!Object.hasOwn(fields, name)) return `${name} is missing`;
    if (typeof fields[name] !== 'string') return `${name} is not a string`;
  }

  for (const name of ['prev', 'hash'] as const) {
    if (!Object.hasOwn(fields, name)) return `${name} is missing`;
    if (!isHash(fields[name])) return `${name} is not a 64-character hex hash`;
  }

  if (Object.hasOwn(fields, 'dropped')) {
    const dropped = fields['dropped'];
    if (typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0) {
      return 'dropped is not a whole number';
    }
  }

  return null;
}

function decodeLine(decoder: TextDecoder, bytes: Uint8Array, line: number): TrailEntry | null {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { line, malformed: 'not valid UTF-8' };
  }
  return parseTrailLine(text, line);
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number`);
  }
  return value;
}
