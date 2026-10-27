/**
 * Append-only JSONL audit log.
 *
 * One JSON object per line, appended in arrival order. The format is
 * deliberately boring: `grep`, `jq` and every log shipper on earth can read it,
 * and appending is the only thing the writer ever does to it.
 *
 * Each record goes to the file with one synchronous `write` before `write()`
 * returns. That blocks the event loop for the microseconds a local disk takes,
 * which is nothing next to the LLM round trip the record describes, and it buys
 * what an asynchronous stream could not: a record the proxy has answered for is
 * in the kernel rather than in a buffer a crash would lose, and every failure is
 * known record by record instead of as one error event after which a stream
 * quietly stops writing. On a network filesystem the block can be far longer,
 * which is one more reason to keep the trail on local disk.
 *
 * The writer never fakes a tamper signal and never hides a gap. A record that
 * did not reach the file does not become the head of the chain, so the next one
 * links to what is actually on disk and says how many went missing before it.
 * A file that ends mid-line is sealed before anything is appended to it, a file
 * moved or deleted under the running writer is reopened at its path rather
 * than written into the void, and a record too long for a reader to take as
 * one line is never written at all.
 */
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { GENESIS_HASH, toRecord, type AuditEvent } from './record.js';
import { MAX_LINE_BYTES } from './trail.js';

export interface AuditSink {
  /** Record one request. Never throws: auditing must not take the proxy down. */
  write(event: AuditEvent): void;
  /** Flush and release the file handle. */
  close(): Promise<void>;
}

/** What the writer needs to know about a file: which one it is, and how long. */
export interface AuditFileStat {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

/**
 * The file operations the writer performs, and nothing else.
 *
 * Injectable so that tests can make a disk fill up, a write tear halfway or a
 * descriptor go bad on exactly the record they mean to; replacing named imports
 * from `node:fs` is not a reliable way to do that in ESM. `statSync` must throw
 * an error with code `ENOENT` when the path does not exist, as Node's does.
 */
export interface AuditFileSystem {
  openSync(path: string, flags: string, mode: number): number;
  writeSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  fstatSync(fd: number): AuditFileStat;
  statSync(path: string): AuditFileStat;
  fdatasyncSync(fd: number): void;
  closeSync(fd: number): void;
}

export interface AuditLogOptions {
  readonly path: string;
  /** Injected for tests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Injected for tests; defaults to `randomUUID`. */
  readonly id?: () => string;
  /**
   * Called when a write fails, and to warn about what the writer found and
   * repaired: a torn final line, a moved or truncated file, records that could
   * not be written. Defaults to `console.error`.
   */
  readonly onError?: (error: Error) => void;
  /** Injected for tests; any operation left out is Node's own. */
  readonly fs?: Partial<AuditFileSystem>;
}

/** Where a writer's chain began when it opened its trail. */
export interface AuditStart {
  /** `genesis` for a new or empty trail, `existing` when it continues one on disk. */
  readonly from: 'genesis' | 'existing';
  /** The hash its first record links to: genesis, or the last record on disk. */
  readonly head: string;
}

/** A sink that discards everything, for `scan`, `check` and disabled auditing. */
export const nullAuditLog: AuditSink = {
  write(): void {
    /* intentionally empty */
  },
  close(): Promise<void> {
    return Promise.resolve();
  },
};

const nodeFileSystem: AuditFileSystem = {
  openSync,
  writeSync,
  readSync,
  fstatSync,
  statSync,
  fdatasyncSync,
  closeSync,
};

/**
 * How often a failure that keeps happening is reported again.
 *
 * The first failure is always reported at once. After that, a full disk under
 * steady traffic would otherwise print one line per request; once a minute is
 * enough to keep it on screen, and `droppedRecords` keeps the exact count.
 */
const REPORT_INTERVAL_MS = 60_000;

/** The conditions that can recur record after record, each limited on its own. */
type RecurringReport = 'write' | 'recovered' | 'closed';

/** Readable by owner and group: the trail is evidence, not a public file. */
const FILE_MODE = 0o640;

const NEWLINE = 0x0a;

export class JsonlAuditLog implements AuditSink {
  readonly path: string;

  private readonly now: () => Date;
  private readonly nextId: () => string;
  private readonly onError: (error: Error) => void;
  private readonly fs: AuditFileSystem;
  private readonly start: AuditStart;

  /** The open descriptor, or `undefined` when it has to be (re)opened first. */
  private fd: number | undefined;
  /** Device and inode of the file `fd` writes to, to notice it being replaced. */
  private identity: { readonly dev: number; readonly ino: number } = { dev: -1, ino: -1 };
  /** Bytes the file is known to hold, to notice it being truncated. */
  private size = 0;
  /** Whether the file ends part-way through a line, so the next record needs a newline first. */
  private torn = false;
  /** Hash of the last record known to be on disk. */
  private head = GENESIS_HASH;
  /** Records lost over the writer's lifetime. */
  private dropped = 0;
  /** Records lost since the last one that reached the file. */
  private missing = 0;
  private closed = false;
  /** When each kind of recurring report was last made. */
  private readonly reported = new Map<RecurringReport, number>();

  constructor(options: AuditLogOptions) {
    this.path = resolve(options.path);
    this.now = options.now ?? ((): Date => new Date());
    this.nextId = options.id ?? randomUUID;
    this.onError = options.onError ?? ((error): void => console.error(`hushgate audit: ${error.message}`));
    this.fs = { ...nodeFileSystem, ...options.fs };

    // Opened here, synchronously, so that a trail that cannot be written —
    // a read-only directory, a path that is a directory — stops `serve` before
    // it listens, rather than surfacing later as records that never arrive.
    // Continuing the existing chain rather than starting a new one is what
    // keeps a restart from looking like tampering.
    this.open();
    this.start = { from: this.head === GENESIS_HASH ? 'genesis' : 'existing', head: this.head };
  }

  /**
   * Records that could not be written, over the writer's lifetime.
   * Each one is also counted in the `dropped` field of the next record that
   * does reach the file, unless the trail was closed first.
   */
  get droppedRecords(): number {
    return this.dropped;
  }

  /**
   * Records lost since the last one that reached the file: lost, and not yet
   * counted in any record's `dropped`. Once the trail is closed nothing will
   * count them, so this is the part of the loss the trail itself never shows.
   */
  get droppedSinceLastRecord(): number {
    return this.missing;
  }

  /**
   * Hash of the most recent record on disk. Anchor it externally to detect
   * truncation. A record that failed to write never becomes the head.
   */
  get headHash(): string {
    return this.head;
  }

  /** Where the chain began when this writer opened its trail, for `serve` to log. */
  get startedFrom(): AuditStart {
    return this.start;
  }

  write(event: AuditEvent): void {
    if (this.closed) {
      this.lose('closed', new Error('record arrived after the trail was closed'));
      return;
    }

    try {
      const fd = this.descriptor();
      const record = toRecord(event, this.now().toISOString(), this.nextId(), this.head, this.missing);
      const json = JSON.stringify(record);
      assertReadable(json);
      this.append(fd, json, record.hash);
    } catch (error) {
      this.lose('write', asError(error));
    }
  }

  /** Flush the trail to disk and release it. Safe to call more than once. */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.release();
    }
    return Promise.resolve();
  }

  /**
   * Open the trail at `path` and find where its chain stands. Throws when the
   * file cannot be opened for appending.
   *
   * Opened for reading as well as appending so that the last byte and the last
   * record are read through the very descriptor that will write, not through a
   * second open that could land on a different file. `O_APPEND` still puts
   * every write at the end, whatever has been read.
   */
  private open(): number {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = this.fs.openSync(this.path, 'a+', FILE_MODE);

    try {
      const stat = this.fs.fstatSync(fd);
      let size = stat.size;

      // A crash or a full disk can leave half a line at the end. Appending
      // straight onto it would fuse the next record into the fragment and lose
      // both; a newline first keeps the fragment as one unreadable line, which
      // `audit verify` will name, and lets the chain continue past it.
      if (size > 0 && !endsWithNewline(this.fs, fd, size)) {
        writeFully(this.fs, fd, Buffer.from('\n'));
        this.warn(
          `${this.path} ended part-way through a line at byte ${size}; sealed it with a newline, ` +
            'so the fragment stays visible as one unreadable line and new records start on a line of their own',
        );
        size += 1;
      }

      const found = size === 0 ? { head: GENESIS_HASH, skipped: 0 } : findHead(this.fs, fd, size);
      if (found.head === GENESIS_HASH && size > 0) {
        this.warn(`${this.path} holds no readable record; a new chain starts from genesis`);
      } else if (found.skipped > 0) {
        this.warn(
          `the last ${found.skipped} line(s) of ${this.path} are not readable records; ` +
            `the chain continues from the last one that is (${found.head})`,
        );
      }

      this.fd = fd;
      this.identity = { dev: stat.dev, ino: stat.ino };
      this.size = size;
      this.torn = false;
      this.head = found.head;
      return fd;
    } catch (error) {
      closeQuietly(this.fs, fd);
      throw error;
    }
  }

  /**
   * The descriptor to write the next record to, checked against the path.
   *
   * Log rotation is the usual reason the two part ways. A move or a delete
   * leaves the descriptor writing to a file nobody will look at — or to none at
   * all — so the trail is reopened at its path, and the file there starts or
   * continues a chain of its own. A copy-and-truncate leaves the descriptor in
   * place but the file shorter than written; the chain carries on in memory,
   * and the warning says that the first record after it links to a record that
   * now lives only in the copy. One `stat` per record is cheap next to the
   * request it records.
   */
  private descriptor(): number {
    if (this.fd === undefined) return this.open();

    let onDisk: AuditFileStat | undefined;
    try {
      onDisk = this.fs.statSync(this.path);
    } catch (error) {
      // Anything but "not there" says nothing about rotation: keep writing.
      if (!isMissing(error)) return this.fd;
    }

    if (onDisk === undefined || onDisk.dev !== this.identity.dev || onDisk.ino !== this.identity.ino) {
      this.warn(
        `${this.path} was moved or deleted while hushgate was writing to it; reopening it there. ` +
          `The file it was writing ends at ${this.head}: anchor that hash to verify it, ` +
          `because the trail at ${this.path} starts a chain of its own from here on`,
      );
      this.release();
      return this.open();
    }

    if (onDisk.size < this.size) {
      this.warn(
        `${this.path} shrank from ${this.size} to ${onDisk.size} bytes while hushgate was writing to it, ` +
          'as copy-and-truncate rotation does; the chain continues in memory, so the next record links to ' +
          `${this.head}, which this file no longer holds`,
      );
      this.torn = onDisk.size > 0 && !endsWithNewline(this.fs, this.fd, onDisk.size);
    }
    this.size = onDisk.size;
    return this.fd;
  }

  /**
   * Write one record's line, and move the head only if the record got there.
   *
   * Short writes are retried until the line is complete. If a write fails
   * part-way, whatever reached the file stays there as a fragment and the next
   * line starts with a newline. The record counts as written once all of its
   * JSON is in the file, even if the newline after it is not: on disk it is a
   * complete record, a restart would continue the chain from it, and so must
   * this writer.
   */
  private append(fd: number, json: string, hash: string): void {
    const line = Buffer.from(`${this.torn ? '\n' : ''}${json}\n`, 'utf8');
    const recordEnd = line.length - 1;

    let written = 0;
    let failure: Error | undefined;
    try {
      while (written < line.length) {
        const count = this.fs.writeSync(fd, line, written, line.length - written, null);
        if (count <= 0) throw new Error(`the file took ${written} of ${line.length} bytes and then no more`);
        written += count;
      }
    } catch (error) {
      failure = asError(error);
    }

    if (written > 0) {
      this.size += written;
      this.torn = line[written - 1] !== NEWLINE;
    }
    // A descriptor that is no longer valid will not become valid again; open
    // the trail afresh for the next record.
    if (failure !== undefined && errorCode(failure) === 'EBADF') this.forget();

    if (written >= recordEnd) {
      this.head = hash;
      this.recovered();
      if (failure !== undefined) {
        this.warn(
          `wrote a record but not the newline after it (${failure.message}); the next record starts on a new line`,
        );
      }
      return;
    }

    // Only a failure can stop the loop short, but a record that is not on disk
    // must never be passed over in silence, whatever the reason.
    const cause = failure ?? new Error(`only ${written} of ${line.length} bytes were written`);
    if (written > 0) {
      throw new Error(
        `${cause.message}; ${written} of ${line.length} bytes reached the file, ` +
          'so that fragment stays as an unreadable line and the next record starts on a new one',
        { cause },
      );
    }
    throw cause;
  }

  /** A record reached the file: say so if earlier ones had not. */
  private recovered(): void {
    if (this.missing > 0) {
      this.periodically(
        'recovered',
        new Error(
          `the trail is writable again after ${this.missing} record(s) could not be written; ` +
            `the record just written carries dropped: ${this.missing}, so the gap shows in the trail`,
        ),
      );
    }
    this.missing = 0;
  }

  /**
   * Count a record that did not reach the file, and say so.
   *
   * The count lives in memory until a record reaches the file and carries it,
   * so the message says what happens if none does: a writer stopped, or
   * killed, while its disk is still full takes the count with it, and only the
   * shutdown line and the metric are left to show it.
   */
  private lose(kind: 'write' | 'closed', error: Error): void {
    this.dropped += 1;
    this.missing += 1;

    const message =
      kind === 'closed'
        ? `${error.message}; it was not written (${this.dropped} record(s) lost so far)`
        : `could not write an audit record: ${error.message} (${this.dropped} record(s) lost so far). ` +
          'The next record written will carry the count as dropped, if hushgate writes one before it stops; ' +
          'if it does not, the count is only in the shutdown line and in hushgate_audit_dropped_records_total';
    this.periodically(kind, new Error(message, { cause: error }));
  }

  /**
   * Report a recurring condition at once the first time, then at most once per
   * {@link REPORT_INTERVAL_MS}, so a disk that fills up — or one that keeps
   * failing and recovering — under steady traffic does not print a line per
   * request. `droppedRecords` keeps the exact count either way.
   */
  private periodically(kind: RecurringReport, error: Error): void {
    const now = Date.now();
    const last = this.reported.get(kind);
    if (last !== undefined && now - last < REPORT_INTERVAL_MS) return;
    this.reported.set(kind, now);
    this.report(error);
  }

  /** Sync and close the descriptor, reporting rather than throwing. */
  private release(): void {
    const fd = this.fd;
    if (fd === undefined) return;
    this.fd = undefined;

    try {
      this.fs.fdatasyncSync(fd);
    } catch (error) {
      this.warn(`could not flush ${this.path} to disk: ${asError(error).message}`);
    }
    try {
      this.fs.closeSync(fd);
    } catch (error) {
      this.warn(`could not close ${this.path}: ${asError(error).message}`);
    }
  }

  /** Drop a descriptor that is no longer usable, without trying to sync it. */
  private forget(): void {
    if (this.fd === undefined) return;
    closeQuietly(this.fs, this.fd);
    this.fd = undefined;
  }

  private warn(message: string): void {
    this.report(new Error(message));
  }

  /** Hand an error to `onError`, which is caller code and must not take the proxy down either. */
  private report(error: Error): void {
    try {
      this.onError(error);
    } catch {
      /* nowhere left to report it */
    }
  }
}

/** How much to read first when walking back from the end of a trail. */
const FIRST_CHUNK = 64 * 1024;
/** Chunks double up to this, so a long walk does not mean one huge read. */
const LARGEST_CHUNK = 8 * 1024 * 1024;

const RECORD_HASH = /^[0-9a-f]{64}$/u;

/**
 * The hash of the last record already in a trail.
 *
 * Read from the tail rather than by parsing the whole file: an audit trail is
 * meant to get long, and startup should not depend on its length.
 */
export function readHead(path: string): string {
  if (!existsSync(path)) return GENESIS_HASH;

  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    return size === 0 ? GENESIS_HASH : findHead(nodeFileSystem, fd, size).head;
  } finally {
    closeSync(fd);
  }
}

/**
 * Walk back from the end of a trail to the last line that is a record.
 *
 * Reads backwards in chunks that start at 64 KiB and double, so a final record
 * of any length a reader accepts is found whole: a request with a few hundred
 * attachments writes a line longer than any fixed window, and a writer that
 * read only a window would take the fragment for junk, restart at genesis, and
 * plant a false tamper signal in the trail. Lines that are not records — a
 * torn write, a comment someone appended, a run of NUL bytes left by a crash —
 * are skipped and counted; `audit verify` reports them as malformed. Genesis
 * is the answer only when no line at all is a record.
 *
 * A line longer than {@link MAX_LINE_BYTES} counts as junk however well it
 * parses, because that is what `audit verify` makes of it. Continuing the
 * chain from a record no reader will take would leave the next record linked
 * to a hash the verifier never sees: a break nobody made. This writer never
 * writes such a line, but an older one could have.
 *
 * Memory is bounded by the read chunk plus the longest line a reader accepts,
 * not by the file.
 */
function findHead(
  fs: Pick<AuditFileSystem, 'readSync'>,
  fd: number,
  size: number,
): { head: string; skipped: number } {
  let skipped = 0;
  let position = size;
  let chunk = FIRST_CHUNK;
  // The bytes from `position` up to the end of the earliest line not yet
  // examined, whose start is not known until a newline before it is read.
  let unfinished: Buffer = Buffer.alloc(0);
  // Whether that line is already too long to be a record. Its bytes are then
  // let go rather than kept, and only where it starts is still looked for.
  let overlong = false;

  while (position > 0) {
    const length = Math.min(chunk, position);
    position -= length;
    chunk = Math.min(chunk * 2, LARGEST_CHUNK);
    const read = readAt(fs, fd, position, length);
    const data: Buffer = overlong ? read : Buffer.concat([read, unfinished]);

    let end = data.length;
    let newline = lastNewline(data, end);
    if (overlong) {
      if (newline === -1) continue;
      skipped += 1;
      overlong = false;
      end = newline;
      newline = lastNewline(data, end);
    }

    while (newline !== -1) {
      const verdict = lineVerdict(data.subarray(newline + 1, end));
      if (typeof verdict === 'object') return { head: verdict.hash, skipped };
      if (verdict === 'junk') skipped += 1;
      end = newline;
      newline = lastNewline(data, end);
    }

    overlong = end > MAX_LINE_BYTES;
    unfinished = overlong ? Buffer.alloc(0) : data.subarray(0, end);
  }

  // What is left is the first line of the file.
  if (overlong) return { head: GENESIS_HASH, skipped: skipped + 1 };
  const verdict = lineVerdict(unfinished);
  if (typeof verdict === 'object') return { head: verdict.hash, skipped };
  if (verdict === 'junk') skipped += 1;
  return { head: GENESIS_HASH, skipped };
}

/** Index of the last newline before `end`, or -1. */
function lastNewline(data: Buffer, end: number): number {
  // A negative offset would count from the end of the buffer instead.
  return end === 0 ? -1 : data.lastIndexOf(NEWLINE, end - 1);
}

/** A line that is a record, a blank line, or anything else. */
function lineVerdict(bytes: Buffer): { readonly hash: string } | 'blank' | 'junk' {
  // Too long for any reader to take as a record, so not one to chain onto.
  if (bytes.length > MAX_LINE_BYTES) return 'junk';
  const text = bytes.toString('utf8');
  if (text.trim().length === 0) return 'blank';
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const { hash } = parsed as { hash?: unknown };
      if (typeof hash === 'string' && RECORD_HASH.test(hash)) return { hash };
    }
  } catch {
    // Not JSON: fall through to junk.
  }
  return 'junk';
}

function readAt(
  fs: Pick<AuditFileSystem, 'readSync'>,
  fd: number,
  position: number,
  length: number,
): Buffer {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const count = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    // The file shrank under us; the zeros left in the buffer read as junk.
    if (count <= 0) break;
    filled += count;
  }
  return buffer;
}

/**
 * Refuse a record whose line no reader would take.
 *
 * `audit verify` reports a line longer than {@link MAX_LINE_BYTES} as
 * unreadable, and the record after it as linked to a hash the chain never
 * showed. Written anyway, one such record would leave a trail nobody tampered
 * with failing verification for good. Not written, it is a lost record like
 * any other: counted, reported, and carried as `dropped` by the next one.
 * `attachments.maxCount` keeps the proxy's records far below the limit; this
 * is the check that holds whatever a library caller puts in an event.
 */
function assertReadable(json: string): void {
  // UTF-8 spends at most three bytes per UTF-16 unit, so a short line needs no count.
  if (json.length * 3 <= MAX_LINE_BYTES) return;
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= MAX_LINE_BYTES) return;
  throw new Error(
    `the record would be a ${bytes}-byte line, longer than the ${MAX_LINE_BYTES} bytes a reader takes ` +
      'as one record, so it was not written',
  );
}

function endsWithNewline(fs: Pick<AuditFileSystem, 'readSync'>, fd: number, size: number): boolean {
  return readAt(fs, fd, size - 1, 1)[0] === NEWLINE;
}

function writeFully(fs: Pick<AuditFileSystem, 'writeSync'>, fd: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.length) {
    const count = fs.writeSync(fd, bytes, written, bytes.length - written, null);
    if (count <= 0) throw new Error(`the file took ${written} of ${bytes.length} bytes and then no more`);
    written += count;
  }
}

function closeQuietly(fs: Pick<AuditFileSystem, 'closeSync'>, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* already unusable; nothing to release */
  }
}

/** An Error for whatever was thrown, without risking a second throw on the way. */
function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  try {
    return new Error(String(value));
  } catch {
    return new Error('a value that cannot be described was thrown');
  }
}

function errorCode(error: Error): unknown {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  const code = error instanceof Error ? errorCode(error) : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
