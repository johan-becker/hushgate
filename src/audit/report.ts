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
 */
import type { HushgateConfig } from '../config.js';
import { jurisdiction, type TransferStatus } from '../residency/jurisdictions.js';
import { verifyChain, type AuditRecord, type ChainVerification } from './record.js';

export interface ReportPeriod {
  /** Inclusive `YYYY-MM-DD`, or `null` for "from the beginning". */
  readonly from: string | null;
  /** Inclusive `YYYY-MM-DD`, or `null` for "until the end". */
  readonly to: string | null;
}

export interface CategoryRow {
  readonly kind: string;
  /** Total findings of this kind. */
  readonly findings: number;
  /** Requests that contained at least one. */
  readonly requests: number;
  /** Policies that were applied to it, in the period. */
  readonly policies: readonly string[];
}

export interface RecipientRow {
  readonly host: string;
  readonly jurisdiction: string;
  readonly jurisdictionName: string;
  readonly status: TransferStatus;
  readonly requests: number;
  readonly tokens: number;
  /** The legal basis the operator recorded for this endpoint, if any. */
  readonly legalBasis: string | null;
  /** Retention and training controls hushgate set on those requests. */
  readonly controls: readonly string[];
}

export interface ProcessingReport {
  readonly generatedAt: string;
  readonly source: string;
  readonly period: ReportPeriod & { readonly first: string | null; readonly last: string | null };
  readonly organisation: HushgateConfig['organisation'];
  readonly volumes: {
    readonly requests: number;
    readonly tokens: number;
    readonly byOutcome: Readonly<Record<string, number>>;
    readonly byRoute: Readonly<Record<string, number>>;
    readonly byEnforcement: Readonly<Record<string, number>>;
  };
  readonly categories: readonly CategoryRow[];
  readonly recipients: readonly RecipientRow[];
  readonly tenants: readonly { readonly id: string; readonly requests: number; readonly tokens: number }[];
  readonly chain: ChainVerification;
}

export interface ReportOptions {
  readonly source: string;
  readonly period?: ReportPeriod;
  readonly config: HushgateConfig;
  readonly now?: () => Date;
}

/** Keep the records inside an inclusive day range. */
export function withinPeriod(records: readonly AuditRecord[], period: ReportPeriod): AuditRecord[] {
  return records.filter((record) => {
    const day = record.ts.slice(0, 10);
    if (period.from !== null && day < period.from) return false;
    if (period.to !== null && day > period.to) return false;
    return true;
  });
}

export function buildReport(
  records: readonly AuditRecord[],
  options: ReportOptions,
): ProcessingReport {
  const period = options.period ?? { from: null, to: null };
  const selected = withinPeriod(records, period);
  const now = options.now ?? ((): Date => new Date());

  const byOutcome: Record<string, number> = {};
  const byRoute: Record<string, number> = {};
  const byEnforcement: Record<string, number> = {};
  const findings = new Map<string, { findings: number; requests: number; policies: Set<string> }>();
  const recipients = new Map<
    string,
    { jurisdiction: string; requests: number; tokens: number; controls: Set<string> }
  >();
  const tenants = new Map<string, { requests: number; tokens: number }>();
  let tokens = 0;

  for (const record of selected) {
    byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    byRoute[record.route] = (byRoute[record.route] ?? 0) + 1;
    tokens += record.tokens ?? 0;

    const mode = record.residency?.mode ?? 'n/a';
    byEnforcement[mode] = (byEnforcement[mode] ?? 0) + 1;

    for (const [kind, count] of Object.entries(record.findings ?? {})) {
      const row = findings.get(kind) ?? { findings: 0, requests: 0, policies: new Set<string>() };
      row.findings += count;
      row.requests += 1;
      const policy = record.policies?.[kind];
      if (policy !== undefined) row.policies.add(policy);
      findings.set(kind, row);
    }

    // A blocked request reached no recipient, which is the point of recording it.
    if (record.upstream !== null && record.upstream !== undefined) {
      const row = recipients.get(record.upstream) ?? {
        jurisdiction: record.residency?.jurisdiction ?? 'UNKNOWN',
        requests: 0,
        tokens: 0,
        controls: new Set<string>(),
      };
      row.requests += 1;
      row.tokens += record.tokens ?? 0;
      for (const control of record.residency?.controls ?? []) row.controls.add(control);
      recipients.set(record.upstream, row);
    }

    if (record.tenant !== null && record.tenant !== undefined) {
      const row = tenants.get(record.tenant) ?? { requests: 0, tokens: 0 };
      row.requests += 1;
      row.tokens += record.tokens ?? 0;
      tenants.set(record.tenant, row);
    }
  }

  return {
    generatedAt: now().toISOString(),
    source: options.source,
    period: {
      ...period,
      first: selected[0]?.ts ?? null,
      last: selected.at(-1)?.ts ?? null,
    },
    organisation: options.config.organisation,
    volumes: { requests: selected.length, tokens, byOutcome, byRoute, byEnforcement },
    categories: [...findings.entries()]
      .map(([kind, row]) => ({
        kind,
        findings: row.findings,
        requests: row.requests,
        policies: [...row.policies].toSorted(),
      }))
      .toSorted((a, b) => b.findings - a.findings || (a.kind < b.kind ? -1 : 1)),
    recipients: [...recipients.entries()]
      .map(([host, row]) => {
        const where = jurisdiction(row.jurisdiction);
        return {
          host,
          jurisdiction: where.code,
          jurisdictionName: where.name,
          status: where.status,
          requests: row.requests,
          tokens: row.tokens,
          legalBasis: legalBasisFor(host, options.config),
          controls: [...row.controls].toSorted(),
        };
      })
      .toSorted((a, b) => b.requests - a.requests || (a.host < b.host ? -1 : 1)),
    tenants: [...tenants.entries()]
      .map(([id, row]) => ({ id, requests: row.requests, tokens: row.tokens }))
      .toSorted((a, b) => b.requests - a.requests || (a.id < b.id ? -1 : 1)),
    // The whole trail is verified, not just the slice: a break outside the
    // period still means the numbers inside it cannot be trusted.
    chain: verifyChain(records),
  };
}

function legalBasisFor(host: string, config: HushgateConfig): string | null {
  for (const entry of config.residency.allow) {
    try {
      if (new URL(entry.endpoint).host === host) return entry.legalBasis;
    } catch {
      continue;
    }
  }
  return null;
}

/** Render the report as Markdown, which is what gets pasted into a ticket. */
export function renderMarkdown(report: ProcessingReport): string {
  const lines: string[] = [
    '# Record of processing activities',
    '',
    '_Article 30 style summary, generated by hushgate from its own audit trail._',
    '',
    `- **Generated**: ${report.generatedAt}`,
    `- **Source**: ${report.source}`,
    `- **Period**: ${describePeriod(report)}`,
    `- **Controller**: ${report.organisation.name ?? 'not recorded (set organisation.name)'}`,
    `- **Contact**: ${report.organisation.contact ?? 'not recorded'}`,
    `- **Data protection officer**: ${report.organisation.dpo ?? 'not recorded'}`,
    `- **Audit chain**: ${describeChain(report.chain)}`,
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
    lines.push(...report.organisation.purposes.map((purpose) => `- ${purpose}`), '');
  }

  lines.push(
    '## Volumes',
    '',
    `- Requests: **${report.volumes.requests}**`,
    `- Tokens reported by providers: **${report.volumes.tokens}**`,
    `- Outcomes: ${describeCounts(report.volumes.byOutcome)}`,
    `- Routes: ${describeCounts(report.volumes.byRoute)}`,
    `- Residency enforcement: ${describeCounts(report.volumes.byEnforcement)}`,
    '',
    '## Categories of personal data',
    '',
  );

  if (report.categories.length === 0) {
    lines.push('_No personal data was detected in this period._', '');
  } else {
    lines.push(
      '| Category | Findings | Requests | Handling |',
      '| --- | ---: | ---: | --- |',
      ...report.categories.map(
        (row) =>
          `| ${row.kind} | ${row.findings} | ${row.requests} | ${row.policies.join(', ') || 'n/a'} |`,
      ),
      '',
    );
  }

  lines.push('## Recipients and transfers', '');

  if (report.recipients.length === 0) {
    lines.push('_Nothing was forwarded to any upstream in this period._', '');
  } else {
    lines.push(
      '| Recipient | Jurisdiction | Transfer | Requests | Tokens | Safeguard recorded |',
      '| --- | --- | --- | ---: | ---: | --- |',
      ...report.recipients.map(
        (row) =>
          `| ${row.host} | ${row.jurisdictionName} (${row.jurisdiction}) | ${describeTransfer(row.status)} | ${row.requests} | ${row.tokens} | ${row.legalBasis ?? '**none recorded**'} |`,
      ),
      '',
      '### Controls applied to outbound requests',
      '',
      ...report.recipients.map(
        (row) =>
          `- ${row.host}: ${row.controls.length === 0 ? 'none set per request' : row.controls.join(', ')}`,
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
      ...report.tenants.map((row) => `| ${row.id} | ${row.requests} | ${row.tokens} |`),
      '',
    );
  }

  lines.push(
    '## Technical measures',
    '',
    'Personal data detected in outbound requests is replaced with pseudonymous',
    'placeholders before the request leaves the machine, and restored in the',
    'response. The audit trail records categories and counts only; it contains no',
    'personal data itself, by construction.',
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

function describePeriod(report: ProcessingReport): string {
  const from = report.period.from ?? 'beginning';
  const to = report.period.to ?? 'end';
  if (report.period.first === null) return `${from} → ${to} (no records)`;
  return `${from} → ${to} (records from ${report.period.first} to ${report.period.last})`;
}

function describeChain(chain: ChainVerification): string {
  if (chain.ok) return `intact over ${chain.records} records (head ${chain.head.slice(0, 12)}…)`;
  const first = chain.firstBreak;
  return `**BROKEN at record ${first?.index ?? 0}** — ${first?.detail ?? 'unknown'}`;
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

function describeCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).toSorted(([a], [b]) => (a < b ? -1 : 1));
  return entries.length === 0 ? 'none' : entries.map(([key, count]) => `${key} ${count}`).join(', ');
}
