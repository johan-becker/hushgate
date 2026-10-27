/**
 * The Article 30 style record of processing.
 *
 * GDPR Article 30 asks a controller to keep a record of its processing
 * activities: the categories of personal data, the purposes, the recipients,
 * the transfers outside the EEA and the safeguards for them. hushgate cannot
 * know the purposes — those are the operator's, and they are read from the
 * config — but it knows exactly what categories it saw, where each request
 * went, under which jurisdiction and rule, and how much of it there was.
 *
 * The report is derived entirely from the audit trail, and it carries the
 * chain verification with it. A summary that cannot be checked against its
 * source is a claim; one that ships with the check is evidence.
 *
 * It follows that the document may say only what the trail supports. Where
 * the trail records an intention rather than an outcome — the policy that
 * would have applied to a request that residency `warn` forwarded as it came
 * in — the report states the outcome. Where the trail is silent — an empty
 * period, an unreadable line, a record the writer lost — it says that it is
 * silent rather than reading the silence as good news.
 */
import type { HushgateConfig } from '../config.js';
import { UsageError } from '../errors.js';
import { jurisdiction, type TransferStatus } from '../residency/jurisdictions.js';
import { VERSION } from '../version.js';
import { GENESIS_HASH, INVALID_VALUE, type AuditRecord } from './record.js';
import { printable } from './trail.js';
import { REPORTED_LIMIT, verifyChain, type ChainVerification } from './verify.js';

export interface ReportPeriod {
  /** Inclusive `YYYY-MM-DD` UTC day, or `null` for "from the beginning". */
  readonly from: string | null;
  /** Inclusive `YYYY-MM-DD` UTC day, or `null` for "until the end". */
  readonly to: string | null;
}

export interface CategoryRow {
  readonly kind: string;
  /** Total findings of this kind. */
  readonly findings: number;
  /** Requests that contained at least one. */
  readonly requests: number;
  /**
   * How it was handled in the period: the policy that was applied, or
   * `sent unredacted (residency warn)` (or `allow`) where the residency mode
   * forwarded the request as it came in. The trail records the policy that
   * would have applied either way, so reading it back as "applied" would
   * claim a pseudonymisation that never happened.
   */
  readonly policies: readonly string[];
  /**
   * Findings of this kind that reached a provider as they were written:
   * forwarded under residency `warn` or `allow`, or under the policy `allow`.
   */
  readonly unredacted: number;
}

export interface RecipientRow {
  readonly host: string;
  /**
   * The `residency.allow` endpoint that admitted these requests, as the trail
   * recorded it, or `null` when no allowlist entry decided. Absent for
   * records written before hushgate recorded it; those are grouped by host.
   */
  readonly endpoint?: string | null;
  readonly jurisdiction: string;
  readonly jurisdictionName: string;
  readonly status: TransferStatus;
  readonly requests: number;
  readonly tokens: number;
  /**
   * The legal basis the operator recorded for this endpoint, if any, read
   * from the configuration the report was generated with.
   */
  readonly legalBasis: string | null;
  /**
   * True when the records do not say which allowlist entry admitted them and
   * several entries for this host give different legal bases. `legalBasis`
   * is then `null` rather than whichever entry happens to be listed first.
   */
  readonly legalBasisAmbiguous: boolean;
  /** The differing legal bases when the basis is ambiguous; empty otherwise. */
  readonly legalBasisCandidates: readonly string[];
  /** Retention and training controls hushgate set on those requests. */
  readonly controls: readonly string[];
}

/** Lines of a trail that could not be read back as records. */
export interface UnreadableLines {
  readonly count: number;
  /** 1-based line number of the first of them, when known. */
  readonly firstLine: number | null;
}

/** What a caller knows about the unreadable lines; the first one is optional. */
export interface MalformedLines {
  readonly count: number;
  readonly firstLine?: number | null;
}

export interface ProcessingReport {
  readonly generatedAt: string;
  /** What produced the document, e.g. `hushgate 0.4.0`. */
  readonly generator: string;
  readonly source: string;
  /**
   * The config file the report was generated with, or `null` when none was
   * found and the defaults were used. Absent when the caller did not say.
   */
  readonly configPath?: string | null;
  /**
   * Tenants whose records go to audit trails of their own and are therefore
   * not in this document. Absent when the caller named none.
   */
  readonly tenantsElsewhere?: readonly string[];
  readonly period: ReportPeriod & { readonly first: string | null; readonly last: string | null };
  readonly organisation: HushgateConfig['organisation'];
  readonly volumes: {
    readonly requests: number;
    readonly tokens: number;
    readonly byOutcome: Readonly<Record<string, number>>;
    readonly byRoute: Readonly<Record<string, number>>;
    readonly byEnforcement: Readonly<Record<string, number>>;
    /**
     * Requests carrying findings that residency `warn` or `allow` forwarded as
     * they came in, so that none of their findings was replaced.
     */
    readonly unredactedRequests: number;
    /**
     * Records the log reported it failed to write, where the whole stretch of
     * the trail they were lost in lies inside the period: from the record
     * before the loss to the one whose `dropped` field counts it. Each one is
     * a request of this period that went unrecorded.
     */
    readonly lostRecords: number;
    /**
     * Records lost in a stretch that reaches outside the period, so that some,
     * all or none of them belong to it: the trail says only that they were
     * lost between two records, not when. Counted here rather than in
     * `lostRecords`, and listed in `possiblyLostWindows`.
     */
    readonly possiblyLostRecords: number;
    /** The stretches behind `possiblyLostRecords`, in trail order, up to {@link REPORTED_LIMIT}. */
    readonly possiblyLostWindows: readonly LossWindow[];
  };
  readonly categories: readonly CategoryRow[];
  readonly attachments: readonly AttachmentRow[];
  readonly recipients: readonly RecipientRow[];
  readonly tenants: readonly { readonly id: string; readonly requests: number; readonly tokens: number }[];
  readonly chain: ChainVerification;
  /**
   * Lines of the trail that could not be read. The chain is verified over the
   * records that could be, and a line that cannot be read cannot be checked,
   * so a non-zero count means the figures cannot be relied on.
   */
  readonly unreadable: UnreadableLines;
  /**
   * `attachments.enabled` in the configuration the report was generated with.
   * While it is off, documents are forwarded without being read and leave no
   * row in the trail, so the document has to say it cannot account for them.
   */
  readonly attachmentsEnabled: boolean;
}

/**
 * A stretch of the trail in which the log lost records.
 *
 * The writer counts what it could not write in the `dropped` field of the next
 * record that reaches the file, so a loss is known to lie between that record
 * and the one before it, and nowhere more precisely: a disk can fill at 23:00
 * and be cleared at 02:00 the next day.
 */
export interface LossWindow {
  /** `ts` of the record before the loss, or `null` when the loss came before the trail's first record. */
  readonly after: string | null;
  /** `ts` of the record whose `dropped` field counts the loss. */
  readonly before: string;
  readonly records: number;
}

/**
 * Documents handled in the period, by format and by what became of them.
 *
 * The row an auditor will stop on is `forwarded`: it counts the documents that
 * reached a provider without hushgate having read them, which is the only way
 * this feature can fail against the claim the rest of the report makes.
 */
export interface AttachmentRow {
  readonly format: string;
  readonly count: number;
  readonly bytes: number;
  /** How many of each outcome, e.g. `{ extracted: 12, withheld: 1 }`. */
  readonly outcomes: Readonly<Record<string, number>>;
  readonly extractors: readonly string[];
  /**
   * Documents that were read, but whose text went out in a request residency
   * `warn` or `allow` forwarded as it came in: read, and not redacted.
   */
  readonly unredacted: number;
}

export interface ReportOptions {
  readonly source: string;
  readonly period?: ReportPeriod;
  readonly config: HushgateConfig;
  readonly now?: () => Date;
  /**
   * The config file `config` was read from, or `null` when none was found and
   * the defaults were used. Leave it out when the config never came from a
   * file at all; the document then says nothing about it.
   */
  readonly configPath?: string | null;
  /** Lines of the trail that could not be read, as the reader counted them. */
  readonly malformed?: MalformedLines;
  /**
   * Tenants that keep audit trails of their own, which this report does not
   * read. A tenant with its own `audit.path` is recorded only there, so a
   * report on the global trail is not the organisation's whole processing,
   * and the document has to say whose processing it leaves out.
   */
  readonly tenantsElsewhere?: readonly string[];
}

/** Everything {@link ReportBuilder} needs up front; the evidence comes at the end. */
export type ReportBuilderOptions = Omit<ReportOptions, 'malformed'>;

/** What {@link ReportBuilder.finish} needs once every record has been added. */
export interface ReportEvidence {
  /** Verification of the whole trail, not just the period. */
  readonly chain: ChainVerification;
  readonly malformed?: MalformedLines;
}

/**
 * Parse the `--from` and `--to` of a report into a period.
 *
 * Both are whole UTC days, because the trail's timestamps are UTC and that is
 * what {@link withinPeriod} compares. A date is checked against the calendar,
 * not just against its pattern: `2026-02-31` would otherwise be printed
 * verbatim as the period of a document someone signs off. A range that ends
 * before it starts selects nothing, and a report over nothing reads too much
 * like a report of nothing, so that is refused as well.
 */
export function parsePeriod(from?: string, to?: string): ReportPeriod {
  const period = { from: calendarDay(from, '--from'), to: calendarDay(to, '--to') };
  if (period.from !== null && period.to !== null && period.from > period.to) {
    throw new UsageError(
      `--from ${period.from} is after --to ${period.to}; the period would hold no days`,
    );
  }
  return period;
}

function calendarDay(value: string | undefined, flag: string): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new UsageError(`${flag} needs a date as YYYY-MM-DD, got "${value}"`);
  }
  // A day that does not exist rolls over (2026-02-31 becomes 2026-03-03), so
  // the round trip is what tells a real date from a well-formed one.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new UsageError(`${flag} needs a date as YYYY-MM-DD that exists, got "${value}"`);
  }
  return value;
}

/** Keep the records inside an inclusive range of UTC days. */
export function withinPeriod(records: readonly AuditRecord[], period: ReportPeriod): AuditRecord[] {
  return records.filter((record) => inPeriod(record, period));
}

function inPeriod(record: AuditRecord, period: ReportPeriod): boolean {
  const day = dayOf(record.ts);
  if (period.from !== null && day < period.from) return false;
  if (period.to !== null && day > period.to) return false;
  return true;
}

/** The UTC day of a timestamp, `YYYY-MM-DD`; empty, and so before any period, for one that is not text. */
function dayOf(ts: unknown): string {
  return typeof ts === 'string' ? ts.slice(0, 10) : '';
}

/**
 * Where a loss lies against the period, by UTC day.
 *
 * `inside` when the whole stretch it may have happened in falls within the
 * period, so its records certainly belong to it; `straddles` when the stretch
 * reaches outside as well, so they may or may not; `outside` when the two do
 * not meet. A loss before the trail's first record has no start, so it can
 * be inside only a period that is open at the beginning. A clock set back can
 * put the record before the loss later than the record after it; the stretch
 * is the span between the two either way.
 */
function placeLoss(window: LossWindow, period: ReportPeriod): 'inside' | 'straddles' | 'outside' {
  const end = dayOf(window.before);
  const start = window.after === null ? null : dayOf(window.after);
  const low = start === null ? null : start < end ? start : end;
  const high = start !== null && start > end ? start : end;

  const meets =
    (period.to === null || low === null || low <= period.to) && (period.from === null || high >= period.from);
  if (!meets) return 'outside';
  const within =
    (period.from === null || (low !== null && low >= period.from)) && (period.to === null || high <= period.to);
  return within ? 'inside' : 'straddles';
}

/**
 * Build a report from a trail held in memory.
 *
 * A thin wrapper over {@link ReportBuilder}, kept for callers that already
 * have the records. The whole trail is verified, not just the slice: a break
 * outside the period still means the numbers inside it cannot be trusted.
 */
export function buildReport(
  records: readonly AuditRecord[],
  options: ReportOptions,
): ProcessingReport {
  const builder = new ReportBuilder(options);
  for (const record of records) builder.add(record);
  return builder.finish({ chain: verifyChain(records), malformed: options.malformed });
}

interface CategoryTally {
  findings: number;
  requests: number;
  unredacted: number;
  readonly policies: Set<string>;
}

interface RecipientTally {
  readonly host: string;
  readonly endpoint: string | null | undefined;
  readonly jurisdiction: string;
  requests: number;
  tokens: number;
  readonly controls: Set<string>;
}

interface AttachmentTally {
  count: number;
  bytes: number;
  unredacted: number;
  readonly outcomes: Record<string, number>;
  readonly extractors: Set<string>;
}

/**
 * Accumulates a report one record at a time.
 *
 * A trail grows for as long as the proxy runs, and a report over a quarter
 * should not need all of it in memory as an array: the builder keeps running
 * totals only, so a caller can read the file line by line, verify the chain
 * as it goes, and hand the verification to {@link ReportBuilder.finish}.
 *
 * Feed it every record of the trail, in order; it keeps those inside the
 * period itself, so the selection is the same as {@link buildReport}'s. The
 * records outside the period still matter for one thing: a loss is placed
 * between the record that reports it and the one before it, wherever either
 * falls, so a disk that filled on the last evening of March is a possible
 * loss in the March report, not only in April's.
 *
 * Nothing a record holds can make it throw. Records reach it whether or not
 * they verified, and a document that cannot be printed because one line was
 * edited would leave the auditor with nothing, so a field of the wrong shape
 * is read as absent, or as `invalid` where a value of a fixed set belongs.
 */
export class ReportBuilder {
  private readonly options: ReportBuilderOptions;
  private readonly period: ReportPeriod;
  private first: string | null = null;
  private last: string | null = null;
  private requests = 0;
  private tokens = 0;
  private unredactedRequests = 0;
  private lostRecords = 0;
  private possiblyLostRecords = 0;
  private readonly possiblyLostWindows: LossWindow[] = [];
  /** `ts` of the record added last, in or out of the period; `null` before the first. */
  private previousTs: string | null = null;
  private readonly byOutcome: Record<string, number> = {};
  private readonly byRoute: Record<string, number> = {};
  private readonly byEnforcement: Record<string, number> = {};
  private readonly categories = new Map<string, CategoryTally>();
  private readonly recipients = new Map<string, RecipientTally>();
  private readonly tenants = new Map<string, { requests: number; tokens: number }>();
  private readonly attachments = new Map<string, AttachmentTally>();

  constructor(options: ReportBuilderOptions) {
    this.options = options;
    this.period = options.period ?? { from: null, to: null };
  }

  add(record: AuditRecord): void {
    const previous = this.previousTs;
    this.previousTs = typeof record.ts === 'string' ? record.ts : null;
    this.placeLoss(previous, record);

    if (!inPeriod(record, this.period)) return;

    this.first ??= record.ts;
    this.last = record.ts;
    this.requests += 1;

    const tokens = amount(record.tokens);
    this.tokens += tokens;
    tally(this.byOutcome, word(record.outcome));
    tally(this.byRoute, word(record.route));

    const residency = objectOrNull(record.residency);
    const mode = residency === null ? 'n/a' : word(residency['mode']);
    tally(this.byEnforcement, mode);

    // A blocked request reached no recipient, which is the point of recording
    // it; whatever its policies say, nothing in it left the machine.
    const reached = record.upstream !== null && record.upstream !== undefined;
    const asWritten = reached && forwardsAsWritten(mode);
    const found = Object.entries(objectOrNull(record.findings) ?? {}).map(
      ([kind, count]) => [kind, amount(count)] as const,
    );
    if (asWritten && found.some(([, count]) => count > 0)) this.unredactedRequests += 1;

    const policies = objectOrNull(record.policies) ?? {};
    for (const [kind, count] of found) {
      const row = this.categories.get(kind) ?? {
        findings: 0,
        requests: 0,
        unredacted: 0,
        policies: new Set<string>(),
      };
      row.findings += count;
      row.requests += 1;
      const policy = Object.hasOwn(policies, kind) ? word(policies[kind]) : undefined;
      const handling = asWritten ? `sent unredacted (residency ${mode})` : policy;
      if (handling !== undefined) row.policies.add(handling);
      if (asWritten || (reached && policy === 'allow')) row.unredacted += count;
      this.categories.set(kind, row);
    }

    for (const item of listOf(record.attachments)) {
      const attachment = objectOrNull(item);
      if (attachment === null) continue;
      const format = word(attachment['format']);
      const outcome = word(attachment['outcome']);
      const row = this.attachments.get(format) ?? {
        count: 0,
        bytes: 0,
        unredacted: 0,
        outcomes: {},
        extractors: new Set<string>(),
      };
      row.count += 1;
      row.bytes += amount(attachment['bytes']);
      tally(row.outcomes, outcome);
      const extractor = attachment['extractor'];
      if (extractor !== null && extractor !== undefined) row.extractors.add(word(extractor));
      if (asWritten && (outcome === 'extracted' || outcome === 'truncated')) {
        row.unredacted += 1;
      }
      this.attachments.set(format, row);
    }

    if (reached) {
      const host = String(record.upstream);
      const endpoint = admittedBy(residency);
      const where = jurisdiction(String(residency?.['jurisdiction'] ?? 'UNKNOWN')).code;
      const key = JSON.stringify([host, endpoint === undefined ? 0 : endpoint, where]);
      const row = this.recipients.get(key) ?? {
        host,
        endpoint,
        jurisdiction: where,
        requests: 0,
        tokens: 0,
        controls: new Set<string>(),
      };
      row.requests += 1;
      row.tokens += tokens;
      for (const control of listOf(residency?.['controls'])) row.controls.add(word(control));
      this.recipients.set(key, row);
    }

    if (record.tenant !== null && record.tenant !== undefined) {
      const tenant = word(record.tenant);
      const row = this.tenants.get(tenant) ?? { requests: 0, tokens: 0 };
      row.requests += 1;
      row.tokens += tokens;
      this.tenants.set(tenant, row);
    }
  }

  /**
   * Count a loss the record reports, by where it may have happened.
   *
   * Done for every record, in the period or not, because the stretch a loss
   * lies in runs from the record before it, and either end can be outside.
   * A stretch wholly outside the period is no concern of this document.
   */
  private placeLoss(after: string | null, record: AuditRecord): void {
    const records = amount(record.dropped);
    if (records <= 0) return;

    const window: LossWindow = { after, before: String(record.ts), records };
    const place = placeLoss(window, this.period);
    if (place === 'inside') {
      this.lostRecords += records;
    } else if (place === 'straddles') {
      this.possiblyLostRecords += records;
      if (this.possiblyLostWindows.length < REPORTED_LIMIT) this.possiblyLostWindows.push(window);
    }
  }

  finish(evidence: ReportEvidence): ProcessingReport {
    const { config } = this.options;
    const now = this.options.now ?? ((): Date => new Date());

    return {
      generatedAt: now().toISOString(),
      generator: `hushgate ${VERSION}`,
      source: this.options.source,
      ...(this.options.configPath === undefined ? {} : { configPath: this.options.configPath }),
      ...(this.options.tenantsElsewhere === undefined || this.options.tenantsElsewhere.length === 0
        ? {}
        : { tenantsElsewhere: [...this.options.tenantsElsewhere] }),
      period: { from: this.period.from, to: this.period.to, first: this.first, last: this.last },
      organisation: config.organisation,
      volumes: {
        requests: this.requests,
        tokens: this.tokens,
        byOutcome: { ...this.byOutcome },
        byRoute: { ...this.byRoute },
        byEnforcement: { ...this.byEnforcement },
        unredactedRequests: this.unredactedRequests,
        lostRecords: this.lostRecords,
        possiblyLostRecords: this.possiblyLostRecords,
        possiblyLostWindows: [...this.possiblyLostWindows],
      },
      categories: [...this.categories.entries()]
        .map(([kind, row]) => ({
          kind,
          findings: row.findings,
          requests: row.requests,
          policies: [...row.policies].toSorted(),
          unredacted: row.unredacted,
        }))
        .toSorted((a, b) => b.findings - a.findings || (a.kind < b.kind ? -1 : 1)),
      attachments: [...this.attachments.entries()]
        .map(([format, row]) => ({
          format,
          count: row.count,
          bytes: row.bytes,
          outcomes: { ...row.outcomes },
          extractors: [...row.extractors].toSorted(),
          unredacted: row.unredacted,
        }))
        .toSorted((a, b) => b.count - a.count || (a.format < b.format ? -1 : 1)),
      recipients: [...this.recipients.values()]
        .map((row) => recipientRow(row, config))
        .toSorted(byRecipient),
      tenants: [...this.tenants.entries()]
        .map(([id, row]) => ({ id, requests: row.requests, tokens: row.tokens }))
        .toSorted((a, b) => b.requests - a.requests || (a.id < b.id ? -1 : 1)),
      chain: evidence.chain,
      unreadable: {
        count: amount(evidence.malformed?.count),
        firstLine: evidence.malformed?.firstLine ?? null,
      },
      attachmentsEnabled: config.attachments.enabled,
    };
  }
}

/**
 * Whether a residency mode sends the caller's original body.
 *
 * The proxy forwards the request as it came in under `warn` and `allow` — that
 * is the point of a staged rollout — and records the policy that would have
 * applied, so the policy alone overstates what happened to the data.
 */
function forwardsAsWritten(mode: string): boolean {
  return mode === 'warn' || mode === 'allow';
}

/** The recorded admitting endpoint: a string, `null`, or absent on older records. */
function admittedBy(residency: Readonly<Record<string, unknown>> | null): string | null | undefined {
  const endpoint = residency?.['endpoint'];
  if (endpoint === null) return null;
  return typeof endpoint === 'string' ? endpoint : undefined;
}

function recipientRow(row: RecipientTally, config: HushgateConfig): RecipientRow {
  const where = jurisdiction(row.jurisdiction);
  const safeguard = safeguardFor(row.host, row.endpoint, config);
  return {
    host: row.host,
    ...(row.endpoint === undefined ? {} : { endpoint: row.endpoint }),
    jurisdiction: where.code,
    jurisdictionName: where.name,
    status: where.status,
    requests: row.requests,
    tokens: row.tokens,
    legalBasis: safeguard.legalBasis,
    legalBasisAmbiguous: safeguard.candidates.length > 0,
    legalBasisCandidates: safeguard.candidates,
    controls: [...row.controls].toSorted(),
  };
}

function byRecipient(a: RecipientRow, b: RecipientRow): number {
  return (
    b.requests - a.requests ||
    compare(a.host, b.host) ||
    compare(a.endpoint ?? '', b.endpoint ?? '') ||
    compare(a.jurisdiction, b.jurisdiction)
  );
}

/**
 * The safeguard the configuration records for one recipient row.
 *
 * Read from the configuration in force now, which the document says. When the
 * record names the allowlist entry that admitted it, that entry is the only
 * one that counts — the proxy matched it by origin and path, and two entries
 * on one gateway host can carry two different contracts. Older records name
 * only the host; one basis among the entries for it is unambiguous, several
 * different ones are reported as such rather than resolved by list order.
 */
function safeguardFor(
  host: string,
  endpoint: string | null | undefined,
  config: HushgateConfig,
): { legalBasis: string | null; candidates: string[] } {
  if (endpoint === null) return { legalBasis: null, candidates: [] };
  if (endpoint !== undefined) {
    const entry = config.residency.allow.find((candidate) => candidate.endpoint === endpoint);
    return { legalBasis: entry?.legalBasis ?? null, candidates: [] };
  }

  const bases = [
    ...new Set(
      config.residency.allow
        .filter((entry) => hostOf(entry.endpoint) === host)
        .map((entry) => entry.legalBasis),
    ),
  ];
  if (bases.length > 1) return { legalBasis: null, candidates: bases };
  return { legalBasis: bases[0] ?? null, candidates: [] };
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** Render the report as Markdown, which is what gets pasted into a ticket. */
export function renderMarkdown(report: ProcessingReport): string {
  const empty = report.volumes.requests === 0;
  const lines: string[] = [
    '# Record of processing activities',
    '',
    '_Article 30 style summary, generated by hushgate from its own audit trail._',
    '',
    `- **Generated**: ${plain(report.generatedAt)}`,
    `- **Generator**: ${plain(report.generator)}`,
    `- **Source**: ${plain(report.source)}`,
    ...describeElsewhere(report.tenantsElsewhere),
    ...describeConfiguration(report.configPath),
    `- **Period**: ${describePeriod(report)}`,
    `- **Controller**: ${optional(report.organisation.name, 'not recorded (set organisation.name)')}`,
    `- **Contact**: ${optional(report.organisation.contact, 'not recorded')}`,
    `- **Data protection officer**: ${optional(report.organisation.dpo, 'not recorded')}`,
    `- **Audit chain**: ${describeChain(report)}`,
    '',
    '## Purposes of processing',
    '',
  ];

  if (report.organisation.purposes.length === 0) {
    lines.push(
      '_Not recorded._ hushgate cannot know why you process this data; list the purposes in `organisation.purposes`.',
      '',
    );
  } else {
    lines.push(...report.organisation.purposes.map((purpose) => `- ${plain(purpose)}`), '');
  }

  lines.push(
    '## Volumes',
    '',
    `- Requests: **${report.volumes.requests}**`,
    `- Tokens reported by providers: **${report.volumes.tokens}**`,
    `- Outcomes: ${describeCounts(report.volumes.byOutcome)}`,
    `- Routes: ${describeCounts(report.volumes.byRoute)}`,
    `- Residency enforcement: ${describeCounts(report.volumes.byEnforcement)}`,
    `- Requests forwarded unredacted under residency warn or allow: **${report.volumes.unredactedRequests}**`,
    ...describeLoss(report.volumes.lostRecords),
    ...describePossibleLoss(report.volumes.possiblyLostRecords, report.volumes.possiblyLostWindows),
    '',
    '## Categories of personal data',
    '',
  );

  if (empty) {
    lines.push(NOTHING_RECORDED, '');
  } else if (report.categories.length === 0) {
    lines.push('_No personal data was detected in this period._', '');
  } else {
    lines.push(
      '| Category | Findings | Requests | Handling |',
      '| --- | ---: | ---: | --- |',
      ...report.categories.map(
        (row) =>
          `| ${cell(row.kind)} | ${row.findings} | ${row.requests} | ${row.policies.map(cell).join(', ') || 'n/a'} |`,
      ),
      '',
    );
  }

  if (report.attachments.length > 0) {
    lines.push(
      '## Attachments',
      '',
      '| Format | Documents | Bytes | Outcomes | Read by |',
      '| --- | ---: | ---: | --- | --- |',
      ...report.attachments.map(
        (row) =>
          `| ${cell(row.format)} | ${row.count} | ${row.bytes} | ${describeCounts(row.outcomes)} | ${row.extractors.map(cell).join(', ') || 'n/a'} |`,
      ),
      '',
      ...describeDocuments(report.attachments),
    );
  }

  lines.push('## Recipients and transfers', '');

  if (empty) {
    lines.push(NOTHING_RECORDED, '');
  } else if (report.recipients.length === 0) {
    lines.push('_Nothing was forwarded to any upstream in this period._', '');
  } else {
    lines.push(
      '| Recipient | Jurisdiction | Transfer | Requests | Tokens | Safeguard recorded |',
      '| --- | --- | --- | ---: | ---: | --- |',
      ...report.recipients.map(
        (row) =>
          `| ${describeRecipient(row, cell)} | ${cell(row.jurisdictionName)} (${cell(row.jurisdiction)}) | ${describeTransfer(row.status)} | ${row.requests} | ${row.tokens} | ${describeSafeguard(row)} |`,
      ),
      '',
      '_Safeguards are read from the configuration in force when this report was generated, not from the time of each request: an allowlist entry added, changed or removed since then changes this column._',
      '',
      '### Controls applied to outbound requests',
      '',
      ...report.recipients.map(
        (row) =>
          `- ${describeRecipient(row)} (${plain(row.jurisdiction)}): ${row.controls.length === 0 ? 'none set per request' : row.controls.map(plain).join(', ')}`,
      ),
      '',
    );
  }

  if (report.tenants.length > 0) {
    lines.push(
      '## Tenants',
      '',
      '| Tenant | Requests | Tokens |',
      '| --- | ---: | ---: |',
      ...report.tenants.map((row) => `| ${cell(row.id)} | ${row.requests} | ${row.tokens} |`),
      '',
    );
  }

  lines.push(
    '## Technical measures',
    '',
    ...describeMeasures(report),
    '',
    'The audit trail records categories and counts only; it holds no personal',
    'data from requests. Identifiers the operator chooses, such as tenant ids,',
    'are recorded as configured.',
    '',
    '---',
    '',
    'This document is generated from a technical control. It supports a record of',
    'processing activities; it is not legal advice and does not by itself make any',
    'transfer lawful.',
    '',
  );

  return lines.join('\n');
}

/**
 * What the document says about a period with no records in it.
 *
 * Zero records is what an empty or truncated trail, the wrong file, or a
 * disabled audit log all look like, so it is no evidence that nothing was
 * processed — and the document must not read as if it were.
 */
const NOTHING_RECORDED =
  '_No requests were recorded in this period; this document makes no statement about processing in it._';

/**
 * Make free text safe to place in the document.
 *
 * Organisation details, purposes and legal bases are the operator's own words,
 * and kinds, routes, hosts and tenant ids come from a file anyone with write
 * access could have edited. A `|` adds a table cell that renderers drop
 * silently, a line break ends a list item or starts a heading, and a leading
 * marker turns a purpose into a nested list or a quote. This helper, or
 * {@link cell} inside a table, is applied to every interpolated string and
 * keeps each value inside the place it was put.
 *
 * What a terminal would obey rather than show is escaped first, as `\uXXXX`,
 * before the Markdown escaping turns the backslash into a visible one. The
 * document is printed to a terminal as often as it is rendered, and a route
 * holding `ESC[1A ESC[2K` would otherwise move the cursor up and erase the line
 * that says BROKEN — the same attack `audit verify` is already closed to.
 */
function plain(text: string): string {
  return orderedListMarker(cell(text));
}

/**
 * {@link plain} for a table cell.
 *
 * A cell holds inline text only, so a number followed by a full stop — an
 * address such as `127.0.0.1:9099` — cannot start a list there, and escaping
 * it only puts a backslash into the raw document for nothing.
 */
function cell(text: string): string {
  return printable(String(text).replaceAll(/\s*[\r\n\p{Zl}\p{Zp}]+\s*/gu, ' ').trim())
    .replaceAll(/[\\|<]/gu, '\\$&')
    .replace(/^[#>+*`~_[-]/u, '\\$&');
}

/**
 * Escape a leading ordered-list marker: one to nine digits, then `.` or `)`,
 * then a space or the end of the text, which is what CommonMark reads as one.
 * `1. numbered` at the start of a list item would nest a list inside it;
 * `127.0.0.1` would not, and is left alone.
 */
function orderedListMarker(text: string): string {
  return text.replace(/^(\d{1,9})([.)])(?=[ \t]|$)/u, '$1\\$2');
}

function optional(value: string | null, missing: string): string {
  return value === null ? missing : plain(value);
}

/**
 * The line naming the tenants whose processing this document leaves out.
 *
 * Their requests are in trails of their own, so nothing about them is in the
 * figures below — which would otherwise read as covering the whole
 * organisation.
 */
function describeElsewhere(tenants: readonly string[] | undefined): string[] {
  if (tenants === undefined || tenants.length === 0) return [];
  const ids = tenants.map(plain).join(', ');
  return [
    `- **Not covered**: tenant${tenants.length === 1 ? '' : 's'} ${ids} ${tenants.length === 1 ? 'keeps an audit trail' : 'keep audit trails'} of ${tenants.length === 1 ? 'its' : 'their'} own, which this document does not include; report on each with \`hushgate audit report --tenant <id>\``,
  ];
}

function describeConfiguration(path: string | null | undefined): string[] {
  if (path === undefined) return [];
  if (path === null) {
    return [
      '- **Configuration**: **none found — defaults used**; organisation details and safeguards below are missing for that reason, not because they were left out of a config',
    ];
  }
  return [`- **Configuration**: ${plain(path)}`];
}

function describePeriod(report: ProcessingReport): string {
  const from = report.period.from ?? 'beginning';
  const to = report.period.to ?? 'end';
  if (report.period.first === null) return `${from} → ${to} (UTC days, inclusive; no records)`;
  return `${from} → ${to} (UTC days, inclusive; records from ${plain(report.period.first)} to ${plain(report.period.last ?? report.period.first)})`;
}

/**
 * The Audit chain line.
 *
 * The head is printed in full, with the number of records it covers, because
 * it is what an operator anchors outside hushgate and a prefix is a weak
 * thing to compare against later. Unreadable lines are never called intact:
 * the chain can only vouch for the records it was able to read. A break names
 * the file line as well as the record, because the line is what somebody
 * opens the file at, and an anchored head that is missing is said to be,
 * because a shortened trail links up as cleanly as a whole one.
 *
 * Gaps the writer left are named beside whichever verdict it is, for the
 * whole trail: they do not break the chain, but a chain called intact should
 * not read as a chain with nothing missing. Whether a gap touches this period
 * is for the Volumes section to say.
 */
function describeChain(report: ProcessingReport): string {
  const { chain, unreadable } = report;
  const unread =
    unreadable.count === 0
      ? ''
      : `**${unreadable.count} unreadable line${unreadable.count === 1 ? '' : 's'}**${unreadable.firstLine === null ? '' : `, first at line ${unreadable.firstLine}`}`;
  const missing = describeMissingAnchors(chain);
  const gaps = describeGaps(chain);

  if (chain.breakCount > 0) {
    const first = chain.firstBreak;
    const line = first?.line === undefined ? '' : ` (line ${first.line})`;
    const more = chain.breakCount === 1 ? '' : `; ${chain.breakCount} breaks in all`;
    const broken = `**BROKEN at record ${first?.index ?? 0}** of ${chain.records} — ${plain(first?.detail ?? 'unknown')}${line}${more}`;
    return [broken, missing, unread, gaps].filter((part) => part !== '').join('; also ');
  }

  const alsoGaps = gaps === '' ? '' : `; also ${gaps}`;

  if (missing !== '') {
    const also = unread === '' ? '' : `; also ${unread}`;
    const present = chain.records === 1 ? 'the 1 record present links' : `the ${chain.records} records present link`;
    return `${missing}: ${present} up to head ${chain.head}, but records were removed from the end or the trail was rewritten${also}${alsoGaps}`;
  }

  if (unreadable.count > 0) {
    return `${unread}: a line that cannot be read cannot be checked, so the figures in this document cannot be relied on (the ${chain.records} records that could be read link up to head ${chain.head})${alsoGaps}`;
  }

  const from = chain.from === GENESIS_HASH ? '' : `continuing from ${chain.from}; `;
  const intact = `intact over ${chain.records} records (${from}head ${chain.head})`;
  return gaps === '' ? intact : `${intact}, across ${gaps}`;
}

/** The gaps the writer left anywhere in the trail, or nothing when there are none. */
function describeGaps(chain: ChainVerification): string {
  if (chain.gapCount === 0) return '';
  const first = chain.gaps[0];
  const line = first?.line === undefined ? '' : `, line ${first.line}`;
  const where = first === undefined ? '' : `, the first before record ${first.index}${line}`;
  const gaps = `${chain.gapCount} gap${chain.gapCount === 1 ? '' : 's'}`;
  return `**${gaps}** where the log could not write ${chain.dropped} record${chain.dropped === 1 ? '' : 's'}${where}`;
}

/** The anchored heads that no verified record carries, or nothing when every one was found. */
function describeMissingAnchors(chain: ChainVerification): string {
  const missing = chain.anchors.filter((anchor) => !anchor.found);
  if (missing.length === 0) return '';
  const heads = missing.map((anchor) => anchor.hash).join(', ');
  return missing.length === 1
    ? `**anchored head ${heads} not found**`
    : `**${missing.length} anchored heads not found** (${heads})`;
}

function describeLoss(lost: number): string[] {
  if (lost === 0) return [];
  return [
    `- **${lost} audit record${lost === 1 ? ' was' : 's were'} lost**: the log could not write ${lost === 1 ? 'it' : 'them'}, so requests in this period went unrecorded and every figure in this document is a lower bound`,
  ];
}

/**
 * The line for records lost in a stretch of the trail that reaches outside
 * the period.
 *
 * The trail cannot say on which side of the period's edge they were lost, so
 * the document says "up to" and "may", gives the stretch so a reader can judge
 * it, and treats every figure as a lower bound — a loss that may belong to
 * this period is not one it may leave out.
 */
function describePossibleLoss(records: number, windows: readonly LossWindow[]): string[] {
  if (records === 0) return [];
  const stretches = windows.map(describeWindow);
  const listed = windows.reduce((sum, window) => sum + window.records, 0);
  const unlisted = listed < records ? ', and in further stretches' : '';
  const reach = windows.length === 1 ? 'a stretch that reaches' : 'stretches that reach';
  return [
    `- **up to ${records} audit record${records === 1 ? '' : 's'} may be missing from this period**: the log could not write ${records === 1 ? 'it' : 'them'} somewhere ${stretches.join(', or ')}${unlisted}, ${reach} outside this period, so every figure in this document is a lower bound`,
  ];
}

function describeWindow(window: LossWindow): string {
  return window.after === null
    ? `before ${plain(window.before)}, the trail's first record`
    : `between ${plain(window.after)} and ${plain(window.before)}`;
}

function describeDocuments(rows: readonly AttachmentRow[]): string[] {
  const unread = rows.reduce((sum, row) => sum + (row.outcomes['forwarded'] ?? 0), 0);
  const unredacted = rows.reduce((sum, row) => sum + row.unredacted, 0);
  const lines: string[] = [];

  if (unread > 0) {
    lines.push(
      `**${unread} document${unread === 1 ? '' : 's'} reached a provider without being read**, because attachments.onUnreadable is set to "forward". Personal data in those documents was not pseudonymised.`,
      '',
    );
  }
  if (unredacted > 0) {
    lines.push(
      `**${unredacted} document${unredacted === 1 ? ' was' : 's were'} read but forwarded unredacted**, because residency enforcement for ${unredacted === 1 ? 'its request' : 'their requests'} was \`warn\` or \`allow\`, which forward a request as it came in.`,
      '',
    );
  }
  // Said of the rows, because the rows are all the trail has: a document sent
  // while attachments.enabled was false — for a day, or a week, of a period
  // the current configuration has it on for — leaves no row at all.
  if (lines.length === 0) {
    lines.push(
      'Every document recorded in the trail for this period was either read, so that its text was handled like the rest of the request, or refused; none of those reached a provider unread. Documents sent while `attachments.enabled` was false leave no row, and this statement does not cover them.',
      '',
    );
  }
  return lines;
}

/** A recipient's host and admitting endpoint, escaped for where it goes: a table cell or a list item. */
function describeRecipient(row: RecipientRow, escape: (text: string) => string = plain): string {
  if (row.endpoint === undefined || row.endpoint === null) return escape(row.host);
  return `${escape(row.host)} via ${cell(row.endpoint)}`;
}

/** The Safeguard recorded cell. */
function describeSafeguard(row: RecipientRow): string {
  if (row.legalBasis !== null) return cell(row.legalBasis);
  if (row.legalBasisAmbiguous) {
    return `**ambiguous**: ${row.legalBasisCandidates.length} allowlist entries share this host with different legal bases (${row.legalBasisCandidates.map(cell).join('; ')}), and these records do not say which admitted them`;
  }
  if (typeof row.endpoint === 'string') return '**none in the current configuration** for this endpoint';
  if (row.endpoint === null) return '**none recorded**; no allowlist entry admitted these requests';
  return '**none recorded**';
}

/**
 * The Technical measures section, built from what the period actually holds.
 *
 * Each sentence is tied to the handling the categories table shows, so a
 * claim of pseudonymisation appears only when something was pseudonymised and
 * covers only the categories that were. What went out as written is said in
 * bold, in the same style as documents forwarded unread.
 */
function describeMeasures(report: ProcessingReport): string[] {
  if (report.volumes.requests === 0) {
    return [
      '_No requests were recorded in this period, so this document makes no statement about the measures applied to them._',
    ];
  }

  const handledBy = (policy: string): string =>
    report.categories
      .filter((row) => row.policies.includes(policy))
      .map((row) => plain(row.kind))
      .join(', ');

  const measures: string[] = [];
  const say = (policy: string, sentence: (kinds: string) => string): void => {
    const kinds = handledBy(policy);
    if (kinds !== '') measures.push(`- ${sentence(kinds)}`);
  };

  say(
    'pseudonymize',
    (kinds) =>
      `Where a category is handled by \`pseudonymize\` (${kinds}), its values were replaced with placeholders before the request left the machine, and restored in the response.`,
  );
  say(
    'hash',
    (kinds) =>
      `Where a category is handled by \`hash\` (${kinds}), its values were replaced with a keyed hash (HMAC-SHA256) before the request left the machine; the response does not restore them.`,
  );
  say(
    'redact',
    (kinds) =>
      `Where a category is handled by \`redact\` (${kinds}), its values were masked before the request left the machine, and cannot be restored.`,
  );
  say(
    'block',
    (kinds) =>
      `Where a category is handled by \`block\` (${kinds}), the request was refused and nothing in it left the machine.`,
  );
  say(
    'allow',
    (kinds) =>
      `**Where a category is handled by \`allow\` (${kinds}), its values were left as they were**: a forwarded request carried them to the provider unredacted.`,
  );

  const unredacted = report.volumes.unredactedRequests;
  if (unredacted > 0) {
    measures.push(
      `- **${unredacted} request${unredacted === 1 ? '' : 's'} carrying personal data ${unredacted === 1 ? 'was' : 'were'} forwarded unredacted**, because residency enforcement for ${unredacted === 1 ? 'it' : 'them'} was \`warn\` or \`allow\`, which forward a request as it came in. ${unredacted === 1 ? 'Its categories show' : 'Their categories show'} as "sent unredacted" under Handling.`,
    );
  }

  if (report.categories.length === 0) {
    measures.push('- hushgate detected no personal data in the requests of this period, so it replaced none.');
  }

  if (!report.attachmentsEnabled) {
    measures.push(
      '- **Attachment reading is off** in the configuration this report was generated with (`attachments.enabled` is false). While it is off, documents are forwarded without being read and leave no row in the trail, so this document cannot account for them.',
    );
  }

  return measures;
}

function describeTransfer(status: TransferStatus): string {
  switch (status) {
    case 'eea': {
      return 'within EEA';
    }
    case 'adequate': {
      return 'adequacy decision';
    }
    case 'third-country': {
      return '**third country**';
    }
    case 'local': {
      return 'no transfer';
    }
    case 'unknown': {
      return '**undeclared**';
    }
  }
}

/** Counts by key, for a table cell or after a label: never at the start of a line. */
function describeCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return entries.length === 0
    ? 'none'
    : entries.map(([key, count]) => `${cell(key)} ${count}`).join(', ');
}

function tally(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * A count read back from the trail, as a number.
 *
 * The writer only ever stores numbers, but the reader parses whatever is on
 * disk; a string in a count would otherwise concatenate into every total
 * after it, and a document should never print a figure it did not add up.
 */
function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * A value read back as one of a field's words — an outcome, a mode, a format,
 * a policy, a control — or `invalid` for anything that is not text, which is
 * what the writer itself puts in a field it cannot make sense of. A number or
 * an object would otherwise become a table row of its own, spelt however
 * JavaScript happens to turn it into a key.
 */
function word(value: unknown): string {
  return typeof value === 'string' ? value : INVALID_VALUE;
}

/** A map read back from the trail, or `null` for anything that is not one. */
function objectOrNull(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A list read back from the trail, or none for anything that is not one. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
