/**
 * The audit record.
 *
 * This file is the evidence a DPO or an auditor will actually read, so it is
 * built from an explicit field list rather than by spreading whatever the caller
 * passed. A record can therefore never grow a field the list does not name, and
 * what the list names is categories and counts, never values.
 *
 * Each field is copied as the type it is meant to be. Counts must be finite
 * numbers, and every field with a closed set of values — the outcome, the
 * residency mode, each policy, each attachment outcome — is checked against that
 * set; anything else is written as the literal `invalid` rather than copied, so
 * an object or a stray string in one of those places cannot carry content in.
 *
 * Two things the copy cannot vouch for, and does not pretend to. The keys of the
 * `findings` and `policies` maps are written as given: they are finding kinds —
 * the built-in names, or ones that config and the dictionary loader hold to
 * UPPER_SNAKE_CASE — so a library caller that builds events itself is trusted
 * to put kinds there, and nothing else. And
 * the free-text fields — route, tenant, upstream, the residency rule,
 * jurisdiction, controls and endpoint, an attachment's format, media type,
 * extractor and reason — are operator or code vocabulary that hushgate fills in
 * itself; they are coerced to strings, not checked against a list.
 */
import { createHash } from 'node:crypto';
import type { AttachmentOutcome, AttachmentReport } from '../attach/types.js';
import { isEnforcementMode, type EnforcementMode } from '../residency/policy.js';
import { isPolicy, type Policy } from '../types.js';

/** `prev` of the first record in a trail: there is nothing before it. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Written in place of a value that is not one of its field's known values.
 *
 * Deliberately not a member of any of those sets, so a report counting outcomes
 * or modes shows it as a row of its own rather than folding it into a real one.
 */
export const INVALID_VALUE = 'invalid';

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

/**
 * The closed sets the record checks against, kept as maps so that adding a
 * member to one of the unions without adding it here is a compile error, rather
 * than a value the trail quietly starts writing as `invalid`.
 */
const AUDIT_OUTCOMES: Readonly<Record<AuditOutcome, true>> = {
  forwarded: true,
  blocked: true,
  rejected: true,
  failed: true,
};

const ATTACHMENT_OUTCOMES: Readonly<Record<AttachmentOutcome, true>> = {
  extracted: true,
  truncated: true,
  withheld: true,
  forwarded: true,
  blocked: true,
};

function isAuditOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'string' && Object.hasOwn(AUDIT_OUTCOMES, value);
}

function isAttachmentOutcome(value: unknown): value is AttachmentOutcome {
  return typeof value === 'string' && Object.hasOwn(ATTACHMENT_OUTCOMES, value);
}

/** The residency decision that applied to a request. */
export interface AuditResidency {
  readonly mode: EnforcementMode;
  /** Config path of the rule that decided, e.g. `residency.categories.IBAN`. */
  readonly rule: string;
  /** Jurisdiction the upstream is operated in, as decided at startup. */
  readonly jurisdiction: string;
  /** Retention and training controls hushgate set on the outbound request. */
  readonly controls: readonly string[];
  /**
   * The `residency.allow` endpoint that admitted the request, as configured,
   * or `null` when no allowlist entry decided. Operator text, never request
   * data. Absent from records written before hushgate recorded it.
   */
  readonly endpoint?: string | null;
}

/**
 * One attachment, as the trail records it.
 *
 * Deliberately shaped like the rest of the record: categories, counts and
 * sizes, never content. The omission worth naming is the **filename**. A
 * filename is routinely personal data all by itself — `Kuendigung_Anna_Schmidt.pdf`
 * names a person and discloses an employment event — and a trail an auditor is
 * meant to read must not be the one place hushgate writes such a thing down.
 * The filename does reach the outbound prompt, where the detectors pseudonymise
 * it like any other text.
 */
export interface AuditAttachment {
  readonly format: string;
  readonly mediaType: string;
  readonly bytes: number;
  /** Characters of text extracted. A length, not the text. */
  readonly chars: number;
  readonly pages: number | null;
  readonly extractor: string | null;
  readonly outcome: AttachmentOutcome;
  readonly reason: string | null;
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
  /**
   * One entry per attachment the request carried, in the order they appeared.
   * Optional because most requests carry none, and a caller should not have to
   * say so; the record always writes the list, empty or not.
   */
  readonly attachments?: readonly AuditAttachment[];
}

/** An event plus the fields the log stamps on it. */
export interface AuditRecord extends AuditEvent {
  /** RFC 3339 timestamp, UTC. */
  readonly ts: string;
  /** Unique id for this record. */
  readonly id: string;
  /**
   * Records the log failed to write immediately before this one. Written only
   * when non-zero, so an auditor sees a gap where it happened rather than a
   * chain that links cleanly over missing requests.
   */
  readonly dropped?: number;
  /** SHA-256 of the record before this one, forming the chain. */
  readonly prev: string;
  /** SHA-256 of this record's other fields, in the order they are written. */
  readonly hash: string;
}

/**
 * Build the serialisable record.
 *
 * Copying field by field is the guarantee that no unnamed field can ride along,
 * and the counts are re-derived as numbers so a caller cannot smuggle a string
 * through the `findings` map. The hash is computed last, over exactly the text
 * that precedes it on the line, which is what makes verification a
 * re-serialisation rather than a parse of a separate format.
 *
 * It does not throw on anything a caller can put in a field — a BigInt, a
 * Symbol, an object whose `toString` throws, a map or a list that is not one —
 * because it runs in the proxy's `finally`, where an exception would cost the
 * record of a request that has already been answered. What it cannot make sense
 * of is written as `invalid`, which a reader can see, rather than left out.
 *
 * `dropped` is the writer's count of records it failed to write immediately
 * before this one. It is written only when it is a positive integer, just before
 * `prev`, so a trail without gaps keeps exactly the shape it always had.
 */
export function toRecord(
  event: AuditEvent,
  ts: string,
  id: string,
  prev: string = GENESIS_HASH,
  dropped = 0,
): AuditRecord {
  const body = {
    ts: text(ts),
    id: text(id),
    tenant: event.tenant === null ? null : text(event.tenant),
    route: text(event.route),
    outcome: oneOf(event.outcome, isAuditOutcome),
    status: numeric(event.status),
    latencyMs: numeric(event.latencyMs),
    stream: Boolean(event.stream),
    upstream: event.upstream === null ? null : text(event.upstream),
    tokens: numeric(event.tokens),
    findings: countsOnly(event.findings),
    policies: policiesOnly(event.policies),
    residency: residencyOnly(event.residency),
    attachments: Array.isArray(event.attachments) ? event.attachments.map(attachmentOnly) : [],
    ...(Number.isSafeInteger(dropped) && dropped > 0 ? { dropped } : {}),
    prev: text(prev),
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

function countsOnly(findings: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [kind, count] of entriesOf(findings)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) continue;
    out[kind] = count;
  }
  return out;
}

/**
 * Copy the policy map, keeping each kind and checking each policy.
 *
 * A policy that is not one of the five is written as `invalid`: an object in
 * that position — `{ policy, sample }` — would otherwise serialise whatever it
 * carries straight into the evidence.
 */
function policiesOnly(policies: unknown): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const [kind, policy] of entriesOf(policies)) out[kind] = oneOf(policy, isPolicy);
  return out;
}

/**
 * Copy the residency decision field by field.
 *
 * `endpoint` is written only when the caller supplied it, and as the last key,
 * so a record from a caller that does not know about it keeps the exact shape —
 * and therefore the exact bytes — it had before the field existed.
 */
function residencyOnly(residency: AuditResidency | null): AuditResidency | null {
  if (residency === null || typeof residency !== 'object') return null;
  const copy: AuditResidency = {
    mode: oneOf(residency.mode, isEnforcementMode),
    rule: text(residency.rule),
    jurisdiction: text(residency.jurisdiction),
    controls: Array.isArray(residency.controls)
      ? residency.controls.map((control: unknown) => text(control))
      : [INVALID_VALUE],
  };
  if (residency.endpoint === undefined) return copy;
  return { ...copy, endpoint: residency.endpoint === null ? null : text(residency.endpoint) };
}

/**
 * Copy an attachment report field by field.
 *
 * Same reasoning as {@link countsOnly}: an explicit field list is what stops a
 * future caller from handing the trail a richer object and having the extra —
 * a filename, a snippet, an extractor's stderr — ride along into the evidence.
 */
function attachmentOnly(report: AttachmentReport | AuditAttachment): AuditAttachment {
  const source: Partial<AuditAttachment> =
    report !== null && typeof report === 'object' ? report : {};
  return {
    format: text(source.format),
    mediaType: text(source.mediaType),
    bytes: numeric(source.bytes),
    chars: numeric(source.chars),
    pages: source.pages === null ? null : numeric(source.pages),
    extractor: source.extractor === null ? null : text(source.extractor),
    outcome: oneOf(source.outcome, isAttachmentOutcome),
    reason: source.reason === null ? null : text(source.reason),
  };
}

/**
 * The value, if it is one of its field's known values; `invalid` otherwise.
 *
 * The cast is the one place the record's types are narrower on paper than in
 * practice: `invalid` is not an `AuditOutcome` or a `Policy`, and it can only
 * appear when a caller got past the type checker. Readers treat it as the
 * unknown value it is.
 */
function oneOf<T extends string>(value: unknown, isMember: (value: unknown) => value is T): T {
  return isMember(value) ? value : (INVALID_VALUE as T);
}

/** A string, whatever arrived; `invalid` for a value that refuses to become one. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return INVALID_VALUE;
  }
}

/** A number, whatever arrived; NaN (written as `null`) for a value that refuses. */
function numeric(value: unknown): number {
  if (typeof value === 'number') return value;
  try {
    return Number(value);
  } catch {
    return Number.NaN;
  }
}

/** The entries of a map, or none for anything that is not an object. */
function entriesOf(map: unknown): [string, unknown][] {
  if (map === null || typeof map !== 'object') return [];
  try {
    return Object.entries(map);
  } catch {
    return [];
  }
}
