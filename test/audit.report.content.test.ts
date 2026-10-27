import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog } from '../src/audit/log.js';
import {
  GENESIS_HASH,
  hashBody,
  toRecord,
  type AuditEvent,
  type AuditRecord,
} from '../src/audit/record.js';
import {
  buildReport,
  parsePeriod,
  renderMarkdown,
  ReportBuilder,
  type ReportOptions,
} from '../src/audit/report.js';
import { parseAuditLines } from '../src/audit/trail.js';
import { verifyChain } from '../src/audit/verify.js';
import { defaultConfig, parseConfig, type HushgateConfig } from '../src/config.js';
import { UsageError } from '../src/errors.js';
import { VERSION } from '../src/version.js';

const dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-report-content-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  tenant: null,
  route: 'openai.chat.completions',
  outcome: 'forwarded',
  status: 200,
  latencyMs: 40,
  stream: false,
  upstream: 'api.mistral.ai',
  tokens: 100,
  findings: { EMAIL: 2 },
  policies: { EMAIL: 'pseudonymize' },
  residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'FR', controls: [] },
  ...overrides,
});

interface Entry {
  readonly at: string;
  readonly event: AuditEvent;
  /** `residency.endpoint`, which the writer of this wave does not stamp yet. */
  readonly endpoint?: string | null;
  /** Records the writer lost before this one. */
  readonly dropped?: number;
}

/**
 * A valid chain in memory, carrying the two optional fields where asked.
 *
 * They are placed where the record contract puts them — `endpoint` last in
 * `residency`, `dropped` immediately before `prev` — and the hash is taken
 * over the result, so the report sees a trail that verifies.
 */
function chain(entries: readonly Entry[]): AuditRecord[] {
  const records: AuditRecord[] = [];
  let prev = GENESIS_HASH;
  for (const [index, entry] of entries.entries()) {
    const { hash: _hash, prev: _prev, ...fields } = toRecord(entry.event, entry.at, `id-${index}`, prev);
    const body = {
      ...fields,
      residency:
        fields.residency === null || entry.endpoint === undefined
          ? fields.residency
          : { ...fields.residency, endpoint: entry.endpoint },
      ...(entry.dropped === undefined ? {} : { dropped: entry.dropped }),
      prev,
    };
    const record = { ...body, hash: hashBody(body) };
    records.push(record);
    prev = record.hash;
  }
  return records;
}

/** Write a trail through the real log, then append whatever else is asked. */
async function writeTrail(entries: readonly Entry[], tail = ''): Promise<string> {
  const path = join(workspace(), 'hushgate-audit.jsonl');
  let index = 0;
  const log = new JsonlAuditLog({
    path,
    now: () => new Date(entries[index]!.at),
    id: () => `id-${index}`,
  });
  for (const entry of entries) {
    log.write(entry.event);
    index += 1;
  }
  await log.close();
  if (tail !== '') appendFileSync(path, tail);
  return path;
}

const CONFIG: HushgateConfig = parseConfig({
  organisation: {
    name: 'Acme GmbH',
    contact: 'datenschutz@acme.example',
    dpo: 'A. Datenschutz',
    purposes: ['Customer support drafting'],
  },
  residency: {
    allow: [
      {
        endpoint: 'https://api.mistral.ai',
        jurisdiction: 'FR',
        legalBasis: 'Art. 28 DPA of 2026-01-12, processing in France',
      },
    ],
  },
});

const OPENAI_GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw/openai';
const ANTHROPIC_GATEWAY = 'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic';

/** Two providers behind one gateway host, each under its own contract. */
const GATEWAY_CONFIG: HushgateConfig = parseConfig({
  residency: {
    allow: [
      { endpoint: OPENAI_GATEWAY, jurisdiction: 'US', legalBasis: 'OpenAI DPA + SCC Module 2' },
      { endpoint: ANTHROPIC_GATEWAY, jurisdiction: 'US', legalBasis: 'Anthropic DPA + SCC Module 2' },
    ],
  },
});

const gatewayEvent = (overrides: Partial<AuditEvent> = {}): AuditEvent =>
  event({
    route: 'anthropic.messages',
    upstream: 'gateway.ai.cloudflare.com',
    residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'US', controls: [] },
    ...overrides,
  });

const residency = (mode: 'sanitize' | 'warn' | 'allow' | 'block'): AuditEvent['residency'] => ({
  mode,
  rule: 'residency.mode',
  jurisdiction: 'FR',
  controls: [],
});

const options = (overrides: Partial<ReportOptions> = {}): ReportOptions => ({
  source: '/srv/hushgate-audit.jsonl',
  config: CONFIG,
  now: () => new Date('2026-04-01T09:00:00.000Z'),
  ...overrides,
});

/** The one line of the document that starts with `prefix`. */
function lineStarting(markdown: string, prefix: string): string {
  const line = markdown.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`no line starts with ${prefix}`);
  return line;
}

/** The Technical measures section, as one string. */
function measures(markdown: string): string {
  return markdown.slice(markdown.indexOf('## Technical measures'), markdown.indexOf('\n---\n'));
}

/** Pipes that separate cells, i.e. not escaped with a backslash. */
function cellSeparators(line: string): number {
  return line.match(/(?<!\\)\|/gu)?.length ?? 0;
}

describe('handling: what actually happened to the data', () => {
  it('does not claim pseudonymisation for a request residency warn forwarded as it came in', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event({ residency: residency('warn') }) }]);

    const report = buildReport(records, options());
    expect(report.categories[0]).toMatchObject({
      kind: 'EMAIL',
      policies: ['sent unredacted (residency warn)'],
      unredacted: 2,
    });
    expect(report.volumes.unredactedRequests).toBe(1);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain('| EMAIL | 2 | 1 | sent unredacted (residency warn) |');
    expect(markdown).toContain('**1 request carrying personal data was forwarded unredacted**');
    expect(markdown).not.toContain('placeholders');
    expect(markdown).not.toContain('| pseudonymize |');
  });

  it('treats residency allow the same way, and names the mode', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event({ residency: residency('allow') }) }]);

    const report = buildReport(records, options());
    expect(report.categories[0]?.policies).toEqual(['sent unredacted (residency allow)']);
    expect(report.volumes.unredactedRequests).toBe(1);
  });

  it('keeps the pseudonymisation sentence for what was pseudonymised, and only that', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      {
        at: '2026-03-02T09:00:00.000Z',
        event: event({
          findings: { PHONE: 1 },
          policies: { PHONE: 'pseudonymize' },
          residency: residency('warn'),
        }),
      },
    ]);

    const report = buildReport(records, options());
    expect(report.volumes.unredactedRequests).toBe(1);

    const section = measures(renderMarkdown(report));
    expect(section).toContain('Where a category is handled by `pseudonymize` (EMAIL), its values were replaced');
    expect(section).not.toMatch(/`pseudonymize` \([^)]*PHONE/u);
    expect(section).toContain('**1 request carrying personal data was forwarded unredacted**');
  });

  it('counts nothing as sent when the request never left the machine', () => {
    const records = chain([
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({ outcome: 'rejected', status: 400, upstream: null, residency: residency('warn') }),
      },
    ]);

    const report = buildReport(records, options());
    expect(report.volumes.unredactedRequests).toBe(0);
    expect(report.categories[0]).toMatchObject({ policies: ['pseudonymize'], unredacted: 0 });
  });

  it('names a category whose policy is allow in Technical measures', () => {
    const records = chain([
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({
          findings: { EMAIL: 1, PERSON: 3 },
          policies: { EMAIL: 'pseudonymize', PERSON: 'allow' },
        }),
      },
    ]);

    const report = buildReport(records, options());
    expect(report.categories.find((row) => row.kind === 'PERSON')).toMatchObject({
      policies: ['allow'],
      unredacted: 3,
    });
    expect(report.categories.find((row) => row.kind === 'EMAIL')?.unredacted).toBe(0);
    // A policy is not a residency mode: the request itself was sanitised.
    expect(report.volumes.unredactedRequests).toBe(0);

    const section = measures(renderMarkdown(report));
    expect(section).toContain('**Where a category is handled by `allow` (PERSON), its values were left as they were**');
    expect(section).toContain('`pseudonymize` (EMAIL)');
  });

  it('describes hash, redact and block for what they are, not as pseudonymisation', () => {
    const records = chain([
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({ findings: { IBAN: 1, PHONE: 1 }, policies: { IBAN: 'hash', PHONE: 'redact' } }),
      },
      {
        at: '2026-03-02T09:00:00.000Z',
        event: event({
          outcome: 'blocked',
          status: 403,
          upstream: null,
          findings: { SECRET: 1 },
          policies: { SECRET: 'block' },
        }),
      },
    ]);

    const section = measures(renderMarkdown(buildReport(records, options())));
    expect(section).toContain('`hash` (IBAN), its values were replaced with a keyed hash');
    expect(section).toContain('`redact` (PHONE), its values were masked');
    expect(section).toContain('`block` (SECRET), the request was refused');
    expect(section).not.toContain('`pseudonymize`');
  });

  it('does not call documents in a warn-mode request pseudonymised', () => {
    const records = chain([
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({
          residency: residency('warn'),
          attachments: [
            {
              format: 'pdf',
              mediaType: 'application/pdf',
              bytes: 2048,
              chars: 900,
              pages: 1,
              extractor: 'builtin-pdf',
              outcome: 'extracted',
              reason: null,
            },
          ],
        }),
      },
    ]);

    const report = buildReport(records, options());
    expect(report.attachments[0]?.unredacted).toBe(1);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain('**1 document was read but forwarded unredacted**');
    expect(markdown).not.toContain('Every document was either read');
    expect(markdown).not.toContain('pseudonymised');
  });

  it('says when attachment reading is off in the configuration the report was generated with', () => {
    const config = parseConfig({ attachments: { enabled: false } });
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

    const markdown = renderMarkdown(buildReport(records, options({ config })));
    expect(measures(markdown)).toContain('`attachments.enabled` is false');
    expect(measures(renderMarkdown(buildReport(records, options())))).not.toContain(
      'attachments.enabled',
    );
  });

  it('says the trail holds no personal data from requests, and that tenant ids are recorded as configured', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event({ tenant: 'support' }) }]);
    const text = measures(renderMarkdown(buildReport(records, options()))).replaceAll('\n', ' ');

    expect(text).toContain('it holds no personal data from requests');
    expect(text).toContain('Identifiers the operator chooses, such as tenant ids, are recorded as configured');
    expect(text).not.toContain('by construction');
  });
});

describe('recipients and safeguards', () => {
  it('looks the legal basis up by the endpoint that admitted the request', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: gatewayEvent(), endpoint: ANTHROPIC_GATEWAY },
      { at: '2026-03-02T09:00:00.000Z', event: gatewayEvent(), endpoint: ANTHROPIC_GATEWAY },
      {
        at: '2026-03-02T10:00:00.000Z',
        event: gatewayEvent({ route: 'openai.chat.completions' }),
        endpoint: OPENAI_GATEWAY,
      },
    ]);

    const report = buildReport(records, options({ config: GATEWAY_CONFIG }));
    expect(report.chain.ok).toBe(true);
    expect(report.recipients).toEqual([
      expect.objectContaining({
        host: 'gateway.ai.cloudflare.com',
        endpoint: ANTHROPIC_GATEWAY,
        requests: 2,
        legalBasis: 'Anthropic DPA + SCC Module 2',
        legalBasisAmbiguous: false,
      }),
      expect.objectContaining({
        endpoint: OPENAI_GATEWAY,
        requests: 1,
        legalBasis: 'OpenAI DPA + SCC Module 2',
      }),
    ]);

    const markdown = renderMarkdown(report);
    expect(markdown).toContain(`| gateway.ai.cloudflare.com via ${ANTHROPIC_GATEWAY} |`);
  });

  it('renders the basis as ambiguous when older records name only a host several entries share', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: gatewayEvent() }]);

    const report = buildReport(records, options({ config: GATEWAY_CONFIG }));
    expect(report.recipients[0]).toMatchObject({
      legalBasis: null,
      legalBasisAmbiguous: true,
      legalBasisCandidates: ['OpenAI DPA + SCC Module 2', 'Anthropic DPA + SCC Module 2'],
    });
    expect(report.recipients[0]).not.toHaveProperty('endpoint');

    const row = lineStarting(renderMarkdown(report), '| gateway.ai.cloudflare.com |');
    expect(row).toContain('**ambiguous**: 2 allowlist entries share this host with different legal bases');
    expect(row.endsWith('| OpenAI DPA + SCC Module 2 |')).toBe(false);
  });

  it('names one basis when the entries sharing a host agree on it', () => {
    const config = parseConfig({
      residency: {
        allow: [
          { endpoint: OPENAI_GATEWAY, legalBasis: 'Gateway DPA' },
          { endpoint: ANTHROPIC_GATEWAY, legalBasis: 'Gateway DPA' },
        ],
      },
    });
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: gatewayEvent() }]);

    expect(buildReport(records, options({ config })).recipients[0]).toMatchObject({
      legalBasis: 'Gateway DPA',
      legalBasisAmbiguous: false,
      legalBasisCandidates: [],
    });
  });

  it('says when the endpoint that admitted a request is no longer configured', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: gatewayEvent(), endpoint: 'https://gateway.ai.cloudflare.com/v1/acct/gw/mistral' },
    ]);

    const report = buildReport(records, options({ config: GATEWAY_CONFIG }));
    expect(report.recipients[0]).toMatchObject({ legalBasis: null, legalBasisAmbiguous: false });
    expect(renderMarkdown(report)).toContain('**none in the current configuration** for this endpoint');
  });

  it('does not borrow a basis for requests no allowlist entry admitted', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event(), endpoint: null },
    ]);

    const report = buildReport(records, options());
    expect(report.recipients[0]).toMatchObject({ endpoint: null, legalBasis: null });
    expect(renderMarkdown(report)).toContain('**none recorded**; no allowlist entry admitted these requests');
  });

  it('states that safeguards come from the configuration in force when the report was generated', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    expect(renderMarkdown(buildReport(records, options()))).toContain(
      'Safeguards are read from the configuration in force when this report was generated',
    );
  });

  it('gives each jurisdiction of one host its own row, whichever came first', () => {
    const at = (jurisdiction: string): AuditEvent =>
      gatewayEvent({ residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction, controls: [] } });

    for (const order of [
      ['UNKNOWN', 'US', 'US'],
      ['US', 'US', 'UNKNOWN'],
    ]) {
      const records = chain(
        order.map((code, index) => ({ at: `2026-03-0${index + 2}T08:00:00.000Z`, event: at(code) })),
      );
      const report = buildReport(records, options({ config: defaultConfig() }));

      expect(report.recipients.map((row) => [row.jurisdiction, row.requests])).toEqual([
        ['US', 2],
        ['UNKNOWN', 1],
      ]);
    }
  });
});

describe('an empty period', () => {
  it('makes no statement about processing in a period with no records', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const markdown = renderMarkdown(
      buildReport(records, options({ period: { from: '2026-05-01', to: '2026-05-31' } })),
    );

    expect(markdown).toContain(
      '_No requests were recorded in this period; this document makes no statement about processing in it._',
    );
    expect(markdown).not.toContain('No personal data was detected');
    expect(markdown).not.toContain('Nothing was forwarded');
    expect(measures(markdown)).not.toContain('placeholders');
    expect(measures(markdown)).toContain('makes no statement about the measures applied');
  });

  it('says the same of an empty trail', () => {
    const markdown = renderMarkdown(buildReport([], options()));
    expect(markdown).toContain('_No requests were recorded in this period;');
    expect(markdown).not.toContain('No personal data was detected');
  });

  it('still says nothing was detected when requests were recorded without findings', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event({ findings: {}, policies: {} }) },
    ]);
    const markdown = renderMarkdown(buildReport(records, options()));

    expect(markdown).toContain('_No personal data was detected in this period._');
    expect(measures(markdown)).toContain('hushgate detected no personal data in the requests of this period');
  });
});

describe('escaping free text', () => {
  it("keeps a '|' and a newline in a legal basis inside its cell", () => {
    const config = parseConfig({
      residency: {
        allow: [
          {
            endpoint: 'https://api.mistral.ai',
            jurisdiction: 'FR',
            legalBasis: 'SCC 2021/914 | TIA\n2026-03',
          },
        ],
      },
    });
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const markdown = renderMarkdown(buildReport(records, options({ config })));

    const row = lineStarting(markdown, '| api.mistral.ai |');
    // Six columns are seven separators, however many pipes the text carries.
    expect(cellSeparators(row)).toBe(7);
    expect(row).toContain('SCC 2021/914 \\| TIA 2026-03');
    expect(markdown.split('\n').some((line) => line.startsWith('2026-03'))).toBe(false);
  });

  it('keeps organisation details and purposes from starting headings or lists', () => {
    const config = parseConfig({
      organisation: {
        name: 'Acme\n# Injected',
        contact: 'a@b.example\r\n> quoted',
        purposes: ['Support\n## Smuggled', '- nested', '1. numbered'],
      },
    });
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const markdown = renderMarkdown(buildReport(records, options({ config })));

    const headings = markdown.split('\n').filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '# Record of processing activities',
      '## Purposes of processing',
      '## Volumes',
      '## Categories of personal data',
      '## Recipients and transfers',
      '### Controls applied to outbound requests',
      '## Technical measures',
    ]);
    expect(markdown).toContain('- **Controller**: Acme # Injected');
    expect(markdown).toContain('- **Contact**: a@b.example > quoted');
    expect(markdown).toContain('- Support ## Smuggled');
    expect(markdown).toContain('- \\- nested');
    expect(markdown).toContain('- 1\\. numbered');
    expect(markdown.split('\n').some((line) => line.startsWith('>'))).toBe(false);
  });

  it('escapes what comes from the trail: kinds, hosts, routes and tenant ids', () => {
    const records = chain([
      {
        at: '2026-03-02T08:00:00.000Z',
        event: event({
          tenant: 'ops|team',
          route: 'custom|route',
          upstream: 'evil|host.example',
          findings: { 'X|Y': 1 },
          policies: { 'X|Y': 'pseudonymize' },
        }),
      },
    ]);
    const markdown = renderMarkdown(buildReport(records, options()));

    expect(cellSeparators(lineStarting(markdown, '| ops\\|team |'))).toBe(4);
    expect(cellSeparators(lineStarting(markdown, '| X\\|Y |'))).toBe(5);
    expect(cellSeparators(lineStarting(markdown, '| evil\\|host.example |'))).toBe(7);
    expect(markdown).toContain('- Routes: custom\\|route 1');
  });
});

describe('parsePeriod', () => {
  it('accepts real dates and open ends', () => {
    expect(parsePeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
    expect(parsePeriod('2024-02-29')).toEqual({ from: '2024-02-29', to: null });
    expect(parsePeriod(undefined, '2026-03-31')).toEqual({ from: null, to: '2026-03-31' });
    expect(parsePeriod()).toEqual({ from: null, to: null });
    expect(parsePeriod('2026-03-01', '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01' });
  });

  it('rejects a date that is well formed but does not exist', () => {
    for (const day of ['2026-02-31', '2026-13-01', '2025-02-29', '2026-04-31', '2026-00-10']) {
      expect(() => parsePeriod(day)).toThrow(UsageError);
      expect(() => parsePeriod(day)).toThrow(/--from needs a date as YYYY-MM-DD that exists/u);
      expect(() => parsePeriod(undefined, day)).toThrow(/--to/u);
    }
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    expect(() => parsePeriod('March')).toThrow(UsageError);
    expect(() => parsePeriod('2026-3-1')).toThrow(/YYYY-MM-DD/u);
  });

  it('rejects a range that ends before it starts', () => {
    expect(() => parsePeriod('2026-08-31', '2026-08-01')).toThrow(UsageError);
    expect(() => parsePeriod('2026-08-31', '2026-08-01')).toThrow(/--from 2026-08-31 is after --to 2026-08-01/u);
  });

  it('labels the period in the document as UTC days', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const markdown = renderMarkdown(
      buildReport(records, options({ period: { from: '2026-03-01', to: '2026-03-31' } })),
    );

    expect(lineStarting(markdown, '- **Period**:')).toBe(
      '- **Period**: 2026-03-01 → 2026-03-31 (UTC days, inclusive; records from 2026-03-02T08:00:00.000Z to 2026-03-02T08:00:00.000Z)',
    );
  });
});

describe('provenance', () => {
  const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);

  it('names the config file the report was generated with', () => {
    const report = buildReport(records, options({ configPath: '/etc/hushgate/hushgate.config.json' }));

    expect(report.configPath).toBe('/etc/hushgate/hushgate.config.json');
    expect(renderMarkdown(report)).toContain('- **Configuration**: /etc/hushgate/hushgate.config.json');
  });

  it('warns when no config file was found and the defaults were used', () => {
    const report = buildReport(records, options({ config: defaultConfig(), configPath: null }));

    expect(report.configPath).toBeNull();
    expect(JSON.parse(JSON.stringify(report))).toHaveProperty('configPath', null);
    expect(renderMarkdown(report)).toContain('- **Configuration**: **none found — defaults used**');
  });

  it('says nothing about configuration when the caller did not say where it came from', () => {
    const report = buildReport(records, options());

    expect(report).not.toHaveProperty('configPath');
    expect(renderMarkdown(report)).not.toContain('**Configuration**');
  });

  it('records the generator', () => {
    const report = buildReport(records, options());

    expect(report.generator).toBe(`hushgate ${VERSION}`);
    expect(renderMarkdown(report)).toContain(`- **Generator**: hushgate ${VERSION}`);
  });
});

describe('the Audit chain line', () => {
  it('prints the full head and the record count', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-03-02T09:00:00.000Z', event: event() },
    ]);
    const report = buildReport(records, options());

    expect(report.chain.head).toMatch(/^[0-9a-f]{64}$/u);
    expect(lineStarting(renderMarkdown(report), '- **Audit chain**:')).toBe(
      `- **Audit chain**: intact over 2 records (head ${report.chain.head})`,
    );
  });

  it('does not call a trail with unreadable lines intact', async () => {
    const path = await writeTrail(
      [
        { at: '2026-03-02T08:00:00.000Z', event: event() },
        { at: '2026-03-02T09:00:00.000Z', event: event() },
      ],
      '{"ts":"2026-03-02T10:00:00.000Z","rou\n',
    );
    const { records, malformed } = parseAuditLines(readFileSync(path, 'utf8'));
    expect(malformed).toHaveLength(1);

    const report = buildReport(
      records,
      options({ source: path, malformed: { count: malformed.length, firstLine: malformed[0]?.line } }),
    );
    expect(report.chain.ok).toBe(true);
    expect(report.unreadable).toEqual({ count: 1, firstLine: 3 });

    const line = lineStarting(renderMarkdown(report), '- **Audit chain**:');
    expect(line).not.toContain('intact');
    expect(line).toContain('**1 unreadable line**, first at line 3');
    expect(line).toContain('cannot be relied on');
  });

  it('names unreadable lines next to a break', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-03-02T09:00:00.000Z', event: event() },
    ]);
    records[1] = { ...records[1]!, tokens: 999_999 };

    const line = lineStarting(
      renderMarkdown(buildReport(records, options({ malformed: { count: 2 } }))),
      '- **Audit chain**:',
    );
    expect(line).toContain('**BROKEN at record 2** of 2 — ');
    expect(line).toContain('also **2 unreadable lines**');
  });

  it('counts no unreadable lines when the caller reports none', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    expect(buildReport(records, options()).unreadable).toEqual({ count: 0, firstLine: null });
  });
});

describe('lost records', () => {
  it('totals the records the log could not write, and says requests went unrecorded', () => {
    const records = chain([
      { at: '2026-03-02T08:00:00.000Z', event: event() },
      { at: '2026-03-02T09:00:00.000Z', event: event(), dropped: 2 },
      { at: '2026-03-02T10:00:00.000Z', event: event(), dropped: 1 },
    ]);

    const report = buildReport(records, options());
    expect(report.chain.ok).toBe(true);
    expect(report.volumes.lostRecords).toBe(3);
    expect(renderMarkdown(report)).toContain(
      '- **3 audit records were lost**: the log could not write them, so requests in this period went unrecorded',
    );
  });

  it('counts only the losses recorded inside the period', () => {
    const records = chain([
      { at: '2026-02-27T08:00:00.000Z', event: event(), dropped: 5 },
      { at: '2026-03-02T09:00:00.000Z', event: event(), dropped: 1 },
    ]);

    const report = buildReport(records, options({ period: { from: '2026-03-01', to: '2026-03-31' } }));
    expect(report.volumes.lostRecords).toBe(1);
    expect(renderMarkdown(report)).toContain('**1 audit record was lost**: the log could not write it');
  });

  it('says nothing about losses when there were none', () => {
    const records = chain([{ at: '2026-03-02T08:00:00.000Z', event: event() }]);
    const report = buildReport(records, options());

    expect(report.volumes.lostRecords).toBe(0);
    expect(renderMarkdown(report)).not.toContain('lost');
  });
});

describe('ReportBuilder', () => {
  it('builds the same report as buildReport, one record at a time', () => {
    const records = chain([
      { at: '2026-02-27T08:00:00.000Z', event: event({ tenant: 'support' }) },
      { at: '2026-03-02T08:00:00.000Z', event: event({ tenant: 'support', residency: residency('warn') }) },
      { at: '2026-03-02T09:00:00.000Z', event: gatewayEvent(), endpoint: OPENAI_GATEWAY, dropped: 1 },
      { at: '2026-03-03T09:00:00.000Z', event: gatewayEvent() },
      {
        at: '2026-03-04T09:00:00.000Z',
        event: event({
          tenant: 'research',
          outcome: 'blocked',
          status: 403,
          upstream: null,
          findings: { SECRET: 1 },
          policies: { SECRET: 'block' },
        }),
      },
      { at: '2026-04-02T08:00:00.000Z', event: event() },
    ]);
    const shared = options({
      config: GATEWAY_CONFIG,
      configPath: '/etc/hushgate/hushgate.config.json',
      period: { from: '2026-03-01', to: '2026-03-31' },
    });
    const malformed = { count: 1, firstLine: 7 };

    const builder = new ReportBuilder(shared);
    for (const record of records) builder.add(record);
    const streamed = builder.finish({ chain: verifyChain(records), malformed });

    expect(streamed).toEqual(buildReport(records, { ...shared, malformed }));
    expect(streamed.volumes.requests).toBe(4);
    expect(streamed.chain.records).toBe(6);
  });
});
