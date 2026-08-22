/**
 * Append-only JSONL audit log.
 *
 * One JSON object per line, opened with O_APPEND, written in arrival order.
 * The format is deliberately boring: `grep`, `jq` and every log shipper on
 * earth can read it, and appending is the only operation the process performs.
 */
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { toRecord, type AuditEvent, type AuditRecord } from './record.js';

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

  constructor(options: AuditLogOptions) {
    this.path = resolve(options.path);
    this.now = options.now ?? ((): Date => new Date());
    this.nextId = options.id ?? randomUUID;
    this.onError = options.onError ?? ((error): void => console.error(`hushgate audit: ${error.message}`));

    mkdirSync(dirname(this.path), { recursive: true });
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
    const record = toRecord(event, this.now().toISOString(), this.nextId());
    this.stream.write(`${JSON.stringify(record)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve_) => {
      this.stream.end(() => resolve_());
    });
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
