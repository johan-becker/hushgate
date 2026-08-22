/**
 * The audit record.
 *
 * This file is the evidence a DPO or an auditor will actually read, so it is
 * built from an explicit field list rather than by spreading whatever the caller
 * passed. A record can therefore never accidentally grow a field carrying the
 * data hushgate exists to keep out of it: categories and counts, never values.
 */
import { createHash } from 'node:crypto';
import type { EnforcementMode } from '../residency/policy.js';
import type { Policy } from '../types.js';

/** `prev` of the first record in a trail: there is nothing before it. */
export const GENESIS_HASH = '0'.repeat(64);

export type AuditOutcome =
  /** Sanitised and forwarded upstream. */
  | 'forwarded'
  /** Refused by a `block` policy; nothing left the machine. */
  | 'blocked'
  /**
   * Refused before anything left the machine: a rejected tenant key, an
   * exhausted quota, or a body that was malformed, oversized or unroutable.
   * The `status` field says which — 401, 429, 400 or 413.
   */
  | 'rejected'
  /** Reached the upstream, which failed or timed out. */
  | 'failed';

/** The residency decision that applied to a request. */
export interface AuditResidency {
  readonly mode: EnforcementMode;
  /** Config path of the rule that decided, e.g. `residency.categories.IBAN`. */
  readonly rule: string;
  /** Jurisdiction the upstream is operated in, as decided at startup. */
  readonly jurisdiction: string;
  /** Retention and training controls hushgate set on the outbound request. */
  readonly controls: readonly string[];
}

/** What a caller reports. Timestamp and id are stamped by the log itself. */
export interface AuditEvent {
  /** Tenant the request was authenticated as, or `null` in single-tenant mode. */
  readonly tenant: string | null;
  /** Route label, e.g. `openai.chat.completions`. */
  readonly route: string;
  readonly outcome: AuditOutcome;
  /** HTTP status returned to the caller. */
  readonly status: number;
  readonly latencyMs: number;
  /** Whether the response was an event stream. */
  readonly stream: boolean;
  /** Host of the upstream the request was sent to, or `null` if it never was. */
  readonly upstream: string | null;
  /** How many findings of each kind. */
  readonly findings: Readonly<Record<string, number>>;
  /** Which policy was applied to each kind. */
  readonly policies: Readonly<Record<string, Policy>>;
  /** Tokens the upstream reported, or 0 when it reported none. */
  readonly tokens: number;
  /** The residency decision, when the request got as far as one. */
  readonly residency: AuditResidency | null;
}

/** An event plus the fields the log stamps on it. */
export interface AuditRecord extends AuditEvent {
  /** RFC 3339 timestamp, UTC. */
  readonly ts: string;
  /** Unique id for this record. */
  readonly id: string;
  /** SHA-256 of the record before this one, forming the chain. */
  readonly prev: string;
  /** SHA-256 of this record's other fields, in the order they are written. */
  readonly hash: string;
}

/**
 * Build the serialisable record.
 *
 * Copying field by field is the guarantee that nothing else can ride along, and
 * the counts are re-derived as numbers so a caller cannot smuggle a string
 * through the `findings` map. The hash is computed last, over exactly the text
 * that precedes it on the line, which is what makes verification a
 * re-serialisation rather than a parse of a separate format.
 */
export function toRecord(
  event: AuditEvent,
  ts: string,
  id: string,
  prev: string = GENESIS_HASH,
): AuditRecord {
  const body = {
    ts,
    id,
    tenant: event.tenant === null ? null : String(event.tenant),
    route: String(event.route),
    outcome: event.outcome,
    status: Number(event.status),
    latencyMs: Number(event.latencyMs),
    stream: Boolean(event.stream),
    upstream: event.upstream === null ? null : String(event.upstream),
    tokens: Number(event.tokens),
    findings: countsOnly(event.findings),
    policies: policiesOnly(event.policies),
    residency:
      event.residency === null
        ? null
        : {
            mode: event.residency.mode,
            rule: String(event.residency.rule),
            jurisdiction: String(event.residency.jurisdiction),
            controls: event.residency.controls.map(String),
          },
    prev,
  };

  return { ...body, hash: hashBody(body) };
}

/**
 * Hash everything on the line except the hash itself.
 *
 * Property order matters and is stable: `toRecord` writes the fields in a fixed
 * order, `JSON.parse` preserves the order it read, and object rest preserves the
 * order of what it keeps. So a record read back from disk re-serialises to
 * exactly the bytes that were hashed — as long as nobody has rewritten the file,
 * which is the thing the chain is there to detect.
 */
export function hashBody(body: Omit<AuditRecord, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

/** Recompute a record's hash from the record itself. */
export function recomputeHash(record: AuditRecord): string {
  const { hash: _ignored, ...body } = record;
  return hashBody(body);
}

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

function countsOnly(findings: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, count] of Object.entries(findings)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    out[kind] = count;
  }
  return out;
}

function policiesOnly(policies: Readonly<Record<string, Policy>>): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const [kind, policy] of Object.entries(policies)) out[kind] = policy;
  return out;
}
