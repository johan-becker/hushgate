/**
 * Chain verification.
 *
 * Kept apart from the record so that the code that writes evidence and the code
 * that checks it are two things, the way an auditor would want them to be.
 */
import { HushgateError } from '../errors.js';
import { GENESIS_HASH, recomputeHash, type AuditRecord } from './record.js';
import {
  isHash,
  readTrailEntries,
  type MalformedLine,
  type TrailEntry,
  type TrailReadOptions,
} from './trail.js';

/**
 * How many breaks, gaps and unreadable lines a result lists. Beyond this it
 * only counts them: a trail rewritten wholesale would otherwise produce one
 * entry per record, which is no more useful to read than the first hundred and
 * costs memory in proportion to the damage.
 */
export const REPORTED_LIMIT = 100;

/**
 * The longest id or timestamp a result repeats. Real ones are 36 and 24
 * characters; a tamperer's can be megabytes, and a hundred of them kept for a
 * report should not be.
 */
const FIELD_LIMIT = 128;

const NON_CANONICAL =
  "line is not in hushgate's canonical form (duplicate keys, added whitespace or re-spelt values), " +
  'so what a reader sees is not exactly what was hashed';

export interface ChainBreak {
  /** 1-based index of the record within the trail. */
  readonly index: number;
  /** 1-based line of the file the record was read from, when it was read from one. */
  readonly line?: number;
  readonly id: string;
  readonly ts: string;
  readonly reason: 'altered' | 'unlinked';
  readonly detail: string;
}

/**
 * A record that says the writer lost records immediately before it.
 *
 * Not a break: the chain links cleanly across the loss, because the writer
 * chained this record to the last one that reached the disk and said so. It is
 * reported so that an auditor sees, at the place it happened, that requests
 * were served for which there is no evidence.
 */
export interface ChainGap {
  readonly index: number;
  readonly line?: number;
  readonly id: string;
  readonly ts: string;
  /** Records the writer failed to write immediately before this one. */
  readonly dropped: number;
}

/** Whether a hash anchored outside hushgate is still in the trail. */
export interface AnchorCheck {
  /** The anchor, as 64 lower-case hex digits. */
  readonly hash: string;
  readonly found: boolean;
  /**
   * The record whose stored hash it is; 0 when it is the hash the chain starts
   * from (genesis, or `from`), which comes before every record; `null` when
   * no record has it.
   */
  readonly index: number | null;
  /** The file line of that record, or `null` when there is none to name. */
  readonly line: number | null;
  /** Records after it: what has been appended since the anchor was taken. */
  readonly following: number | null;
}

export interface ChainVerification {
  /** No breaks, and every anchor found. Gaps do not make a chain fail. */
  readonly ok: boolean;
  readonly records: number;
  /** The first break, or `null` when the chain is intact. */
  readonly firstBreak: ChainBreak | null;
  /**
   * Stored hash of the last record — the trail's tail, intact or not — to
   * anchor the next append; `from` when there are no records.
   */
  readonly head: string;
  /** The hash the first record had to link to: genesis, unless told otherwise. */
  readonly from: string;
  /** Every break, in order, up to {@link REPORTED_LIMIT}. */
  readonly breaks: readonly ChainBreak[];
  /** How many breaks there were, listed or not. */
  readonly breakCount: number;
  /** Every record carrying a `dropped` count, in order, up to {@link REPORTED_LIMIT}. */
  readonly gaps: readonly ChainGap[];
  readonly gapCount: number;
  /** Records the writer reported lost, summed over the whole trail. */
  readonly dropped: number;
  /** One entry per anchor asked about, in the order given. */
  readonly anchors: readonly AnchorCheck[];
}

export interface VerifyOptions {
  /**
   * The hash the first record must link to, for a trail whose start was pruned
   * for retention, or one that continues another file. Defaults to genesis.
   */
  readonly from?: string;
  /**
   * Head hashes recorded outside hushgate. Each must be the stored hash of a
   * record that verifies, or the hash the chain starts from, or the chain
   * fails: that is how truncation and wholesale rewriting, which leave a
   * shorter but consistent chain, show up.
   */
  readonly anchors?: readonly string[];
}

/** A whole trail's verdict: the chain, and the lines that were not records. */
export interface TrailVerification {
  /** The chain verifies, every anchor was found, and every line was a record. */
  readonly ok: boolean;
  readonly verification: ChainVerification;
  /** Unreadable lines, in order, up to {@link REPORTED_LIMIT}. */
  readonly malformed: readonly MalformedLine[];
  readonly malformedCount: number;
}

/** Where a record sits, for the break or gap that names it. */
interface Position {
  readonly index: number;
  readonly line?: number;
  readonly id: string;
  readonly ts: string;
}

/**
 * Verify a chain one record at a time.
 *
 * Two kinds of break are distinguished because they mean different things: a
 * record whose own hash no longer matches its contents was *altered*, while a
 * record whose `prev` does not match the record before it means something was
 * inserted or removed at that point.
 *
 * The whole chain is walked, not just up to the first break. After a break the
 * next record is judged against the hash the broken one *stores*, so a single
 * edited record is one break and the records after it still verify; a torn
 * line from a crash no longer hides a tamper further on. After an unlinked
 * record, the next one may also link to what the unlinked one should have
 * linked to, so a record slipped into the middle is one break rather than two.
 * Neither can hide anything: the record that broke the chain is still reported.
 *
 * What this cannot detect on its own is truncation of the tail — dropping the
 * last records leaves a shorter but internally consistent chain. Ship the head
 * hash somewhere hushgate does not control, and pass it back as an anchor.
 *
 * Nothing a record holds can make this throw: a missing or wrongly typed `hash`
 * or `prev` is a break, like any other way of not verifying.
 */
export class ChainVerifier {
  private readonly start: string;
  /** Each anchor, and where it was found once it has been. */
  private readonly anchors: Map<string, { index: number; line: number | null } | null>;
  private readonly breaks: ChainBreak[] = [];
  private readonly gaps: ChainGap[] = [];
  private count = 0;
  private breakCount = 0;
  private gapCount = 0;
  private dropped = 0;
  /** The hash the next record has to link to, or `null` when there is none to offer. */
  private previous: string | null;
  /** After an unlinked record, the hash it should have linked to. */
  private bridge: string | null = null;

  constructor(options: VerifyOptions = {}) {
    this.start = options.from === undefined ? GENESIS_HASH : normaliseHash(options.from, 'from');
    this.previous = this.start;
    // The hash the chain starts from is a state every trail with that start
    // has been in, before its first record: what `serve` prints as the head of
    // a trail that holds no records yet, and what a pruned trail continues.
    // No record stores it, so it is found at the start rather than looked for.
    // That vouches for nothing it should not: a first record that does not
    // link to it is a break, and fails the chain on its own.
    this.anchors = new Map(
      (options.anchors ?? []).map((anchor) => {
        const hash = normaliseHash(anchor, 'an anchor');
        return [hash, hash === this.start ? { index: 0, line: null } : null];
      }),
    );
  }

  /**
   * Judge the next record.
   *
   * `line` is where it was read from, for the break that names it; `canonical`
   * says whether that line was exactly what hushgate writes. A record handed
   * over without a line was never text, so it is taken as canonical.
   */
  push(record: AuditRecord, line?: number, canonical = true): void {
    this.count += 1;
    const at: Position = {
      index: this.count,
      ...(line === undefined ? {} : { line }),
      id: clip(field(record, 'id')),
      ts: clip(field(record, 'ts')),
    };

    const stored = field(record, 'hash');
    const prev = field(record, 'prev');
    const contents = contentHash(record);
    const altered = alteration(stored, contents, canonical);
    const linked = typeof prev === 'string' && (prev === this.previous || prev === this.bridge);

    if (altered !== null) {
      this.addBreak(at, 'altered', altered);
    } else {
      if (!linked) this.addBreak(at, 'unlinked', this.unlinked(prev, at.index));
      // Not altered means the stored hash is the contents' own. An unlinked
      // record is still exactly the record that was anchored, if its hash is
      // an anchor; what is wrong is around it, and the break says so.
      this.noteAnchor(stored as string, at);
    }

    this.noteGap(record, at);

    this.bridge = linked ? null : this.previous;
    // The stored hash, when there is one, is what the next record was chained
    // to. When there is not, the contents' own hash is the best guess at it:
    // right whenever only the hash itself was damaged.
    this.previous = isHash(stored) ? stored : contents;
  }

  result(): ChainVerification {
    const anchors: AnchorCheck[] = [...this.anchors].map(([hash, at]) =>
      at === null
        ? { hash, found: false, index: null, line: null, following: null }
        : { hash, found: true, index: at.index, line: at.line, following: this.count - at.index },
    );

    return {
      ok: this.breakCount === 0 && anchors.every((anchor) => anchor.found),
      records: this.count,
      firstBreak: this.breaks[0] ?? null,
      head: this.count === 0 ? this.start : (this.previous ?? ''),
      from: this.start,
      breaks: [...this.breaks],
      breakCount: this.breakCount,
      gaps: [...this.gaps],
      gapCount: this.gapCount,
      dropped: this.dropped,
      anchors,
    };
  }

  private addBreak(at: Position, reason: ChainBreak['reason'], detail: string): void {
    this.breakCount += 1;
    if (this.breaks.length < REPORTED_LIMIT) this.breaks.push({ ...at, reason, detail });
  }

  private unlinked(prev: unknown, index: number): string {
    if (this.previous === null) {
      return `record links to ${short(prev)}, but the record before it has no hash to link to`;
    }
    const before = index === 1 ? 'the chain starts from' : 'the record before it hashes to';
    return `record links to ${short(prev)}, but ${before} ${short(this.previous)}`;
  }

  private noteAnchor(stored: string, at: Position): void {
    // `undefined`: not an anchor. An object: already found, and the first
    // occurrence is the one that counts.
    if (this.anchors.get(stored) !== null) return;
    this.anchors.set(stored, { index: at.index, line: at.line ?? null });
  }

  private noteGap(record: AuditRecord, at: Position): void {
    const dropped = field(record, 'dropped');
    if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped <= 0) return;
    this.gapCount += 1;
    this.dropped += dropped;
    if (this.gaps.length < REPORTED_LIMIT) this.gaps.push({ ...at, dropped });
  }
}

/** Verify a whole chain held in memory. */
export function verifyChain(
  records: Iterable<AuditRecord>,
  options: VerifyOptions = {},
): ChainVerification {
  const verifier = new ChainVerifier(options);
  for (const record of records) verifier.push(record);
  return verifier.result();
}

/**
 * Verify a trail from its entries, as `readTrailEntries` or `parseAuditLines`
 * produce them, so that line numbers and non-canonical lines reach the verdict.
 */
export function verifyTrail(
  entries: Iterable<TrailEntry>,
  options: VerifyOptions = {},
): TrailVerification {
  const verifier = new ChainVerifier(options);
  const malformed: MalformedLine[] = [];
  let malformedCount = 0;

  for (const entry of entries) {
    if ('malformed' in entry) {
      malformedCount += 1;
      if (malformed.length < REPORTED_LIMIT) malformed.push({ line: entry.line, reason: entry.malformed });
      continue;
    }
    verifier.push(entry.record, entry.line, entry.canonical);
  }

  const verification = verifier.result();
  return { ok: verification.ok && malformedCount === 0, verification, malformed, malformedCount };
}

/**
 * Verify a trail file in one call, in bounded memory.
 *
 * The file is streamed through the verifier; no string of it and no array of
 * its records is built, so a trail of any length verifies. Errors reading the
 * file are thrown unchanged — see `readTrailEntries`.
 */
export function verifyTrailFile(
  path: string,
  options: VerifyOptions & TrailReadOptions = {},
): TrailVerification {
  return verifyTrail(readTrailEntries(path, options), options);
}

/** Why a record does not verify on its own, or `null` when it does. */
function alteration(stored: unknown, contents: string | null, canonical: boolean): string | null {
  if (contents === null) return 'record is not a JSON object';
  if (stored !== contents) {
    return `record hash is ${short(stored)}, but its contents hash to ${short(contents)}`;
  }
  return canonical ? null : NON_CANONICAL;
}

/** The hash a record's contents produce, or `null` for something that is not a record at all. */
function contentHash(record: unknown): string | null {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  try {
    return recomputeHash(record as AuditRecord);
  } catch {
    // Only reachable for an object built in code — a cycle, a BigInt — never
    // for one parsed from a line. It is not a record either way.
    return null;
  }
}

function field(record: unknown, name: string): unknown {
  if (typeof record !== 'object' || record === null) return undefined;
  return (record as Record<string, unknown>)[name];
}

function clip(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > FIELD_LIMIT ? `${value.slice(0, FIELD_LIMIT)}…` : value;
}

/**
 * A hash as a detail quotes it. Only a well-formed hash is quoted at all, so a
 * detail never carries text a tamperer chose.
 */
function short(hash: unknown): string {
  if (hash === undefined) return '(missing)';
  if (typeof hash !== 'string') return `(not a hash: ${hash === null ? 'null' : typeof hash})`;
  if (!isHash(hash)) return '(not a hash)';
  return `${hash.slice(0, 12)}…`;
}

function normaliseHash(value: string, what: string): string {
  const hash = typeof value === 'string' ? value.toLowerCase() : value;
  if (!isHash(hash)) throw new HushgateError(`${what} must be a 64-character hex hash`);
  return hash;
}
