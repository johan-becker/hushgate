/**
 * The audit record.
 *
 * This file is the evidence a DPO or an auditor will actually read, so it is
 * built from an explicit field list rather than by spreading whatever the caller
 * passed. A record can therefore never accidentally grow a field carrying the
 * data hushgate exists to keep out of it: categories and counts, never values.
 */
import type { EnforcementMode } from '../residency/policy.js';
import type { Policy } from '../types.js';

export type AuditOutcome =
  /** Sanitised and forwarded upstream. */
  | 'forwarded'
  /** Refused by a `block` policy; nothing left the machine. */
  | 'blocked'
  /** Refused before redaction: malformed, oversized, unroutable. */
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
  /** The residency decision, when the request got as far as one. */
  readonly residency: AuditResidency | null;
}

/** An event plus the fields the log stamps on it. */
export interface AuditRecord extends AuditEvent {
  /** RFC 3339 timestamp, UTC. */
  readonly ts: string;
  /** Unique id for this record. */
  readonly id: string;
}

/**
 * Build the serialisable record. Copying field by field is the guarantee that
 * nothing else can ride along, and the counts are re-derived as numbers so a
 * caller cannot smuggle a string through the `findings` map.
 */
export function toRecord(event: AuditEvent, ts: string, id: string): AuditRecord {
  return {
    ts,
    id,
    tenant: event.tenant === null ? null : String(event.tenant),
    route: String(event.route),
    outcome: event.outcome,
    status: Number(event.status),
    latencyMs: Number(event.latencyMs),
    stream: Boolean(event.stream),
    upstream: event.upstream === null ? null : String(event.upstream),
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
  };
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
