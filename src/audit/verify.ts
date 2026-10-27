/**
 * Chain verification.
 *
 * Kept apart from the record so that the code that writes evidence and the code
 * that checks it are two things, the way an auditor would want them to be.
 */
import { GENESIS_HASH, recomputeHash, type AuditRecord } from './record.js';

export interface ChainBreak {
  /** 1-based index of the record within the trail. */
  readonly index: number;
  readonly id: string;
  readonly ts: string;
  readonly reason: 'altered' | 'unlinked';
  readonly detail: string;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly records: number;
  /** The first break, or `null` when the chain is intact. */
  readonly firstBreak: ChainBreak | null;
  /** Hash of the last record, to anchor the next append. */
  readonly head: string;
}

/**
 * Walk a chain and report the first break.
 *
 * Two kinds of break are distinguished because they mean different things: a
 * record whose own hash no longer matches its contents was *altered*, while a
 * record whose `prev` does not match the record before it means something was
 * inserted or removed at that point.
 *
 * What this cannot detect is truncation of the tail — dropping the last records
 * leaves a shorter but internally consistent chain. Ship the head hash somewhere
 * hushgate does not control if that matters to you.
 */
export function verifyChain(records: readonly AuditRecord[]): ChainVerification {
  let previous = GENESIS_HASH;

  for (const [index, record] of records.entries()) {
    const expected = recomputeHash(record);

    if (record.hash !== expected) {
      return {
        ok: false,
        records: records.length,
        head: previous,
        firstBreak: {
          index: index + 1,
          id: record.id ?? '',
          ts: record.ts ?? '',
          reason: 'altered',
          detail: `record hash is ${short(record.hash)}, but its contents hash to ${short(expected)}`,
        },
      };
    }

    if (record.prev !== previous) {
      return {
        ok: false,
        records: records.length,
        head: previous,
        firstBreak: {
          index: index + 1,
          id: record.id ?? '',
          ts: record.ts ?? '',
          reason: 'unlinked',
          detail: `record links to ${short(record.prev)}, but the record before it hashes to ${short(previous)}`,
        },
      };
    }

    previous = record.hash;
  }

  return { ok: true, records: records.length, firstBreak: null, head: previous };
}

function short(hash: string | undefined): string {
  return hash === undefined ? '(missing)' : `${hash.slice(0, 12)}…`;
}
