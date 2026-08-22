/**
 * Append-only JSONL audit log.
 *
 * One JSON object per line, opened with O_APPEND, written in arrival order.
 * The format is deliberately boring: `grep`, `jq` and every log shipper on
 * earth can read it, and appending is the only operation the process performs.
 */
import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, readSync, statSync, type WriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { GENESIS_HASH, toRecord, type AuditEvent, type AuditRecord } from './record.js';

export interface AuditSink {
  /** Record one request. Never throws: auditing must not take the proxy down. */
  write(event: AuditEvent): void;
  /** Flush and release the file handle. */
  close(): Promise<void>;
}

export interface AuditLogOptions {
  readonly path: string;
  /** Injected for tests; defaults to the wall clock. */
  readonly now?: () => Date;
  /** Injected for tests; defaults to `randomUUID`. */
  readonly id?: () => string;
  /** Called when a write fails. Defaults to `console.error`. */
  readonly onError?: (error: Error) => void;
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

export class JsonlAuditLog implements AuditSink {
  readonly path: string;

  private readonly stream: WriteStream;
  private readonly now: () => Date;
  private readonly nextId: () => string;
  private readonly onError: (error: Error) => void;
  private dropped = 0;
  private head: string;

  constructor(options: AuditLogOptions) {
    this.path = resolve(options.path);
    this.now = options.now ?? ((): Date => new Date());
    this.nextId = options.id ?? randomUUID;
    this.onError = options.onError ?? ((error): void => console.error(`hushgate audit: ${error.message}`));

    mkdirSync(dirname(this.path), { recursive: true });
    // Continue the existing chain rather than starting a new one: restarting
    // the process must not look like tampering.
    this.head = readHead(this.path);
    this.stream = createWriteStream(this.path, { flags: 'a', encoding: 'utf8' });
    this.stream.on('error', (error) => {
      this.dropped += 1;
      this.onError(error);
    });
  }

  /** Records that could not be written. `hushgate doctor` surfaces this. */
  get droppedRecords(): number {
    return this.dropped;
  }

  write(event: AuditEvent): void {
    const record = toRecord(event, this.now().toISOString(), this.nextId(), this.head);
    this.head = record.hash;
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  /** Hash of the most recent record. Anchor it externally to detect truncation. */
  get headHash(): string {
    return this.head;
  }

  close(): Promise<void> {
    return new Promise((resolve_) => {
      this.stream.end(() => resolve_());
    });
  }
}

/** How much of the tail to read when looking for the last record. */
const TAIL_BYTES = 64 * 1024;

/**
 * The hash of the last record already in a trail.
 *
 * Read from the tail rather than by parsing the whole file: an audit trail is
 * meant to get long, and startup should not depend on its length.
 */
export function readHead(path: string): string {
  if (!existsSync(path)) return GENESIS_HASH;

  const { size } = statSync(path);
  if (size === 0) return GENESIS_HASH;

  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = openSync(path, 'r');
  try {
    readSync(handle, buffer, 0, length, size - length);
  } finally {
    closeSync(handle);
  }

  const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) return GENESIS_HASH;

  try {
    const parsed = JSON.parse(last) as { hash?: unknown };
    return typeof parsed.hash === 'string' ? parsed.hash : GENESIS_HASH;
  } catch {
    // An unreadable tail is itself a broken chain; `audit verify` will say so.
    return GENESIS_HASH;
  }
}

/** Parse a JSONL audit file into records, reporting the lines that were not. */
export function parseAuditLines(text: string): {
  records: AuditRecord[];
  malformed: { line: number; reason: string }[];
} {
  const records: AuditRecord[] = [];
  const malformed: { line: number; reason: string }[] = [];

  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (typeof parsed.ts !== 'string' || typeof parsed.route !== 'string') {
        malformed.push({ line: index + 1, reason: 'missing ts or route' });
        return;
      }
      records.push(parsed);
    } catch (cause) {
      malformed.push({ line: index + 1, reason: (cause as Error).message });
    }
  });

  return { records, malformed };
}
