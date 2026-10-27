/**
 * `hushgate audit verify` and `hushgate audit report`.
 *
 * The two questions an auditor asks: can I trust this file, and what does it
 * say? The first is answered by walking the hash chain, the second by an
 * Article 30 style summary derived from it.
 *
 * Both read the trail as a stream, a megabyte at a time, so a trail of any
 * length can be checked: neither the file as one string nor its records as an
 * array is ever held.
 */
import { configuredTrails, resolveTrailPath, trailFileKeys, type ConfiguredTrail } from '../../audit/paths.js';
import { parsePeriod, renderMarkdown, ReportBuilder, type ReportPeriod } from '../../audit/report.js';
import { isHash, printable, readTrailEntries, type TrailEntry } from '../../audit/trail.js';
import {
  ChainVerifier,
  verifyTrailFile,
  type ChainVerification,
  type TrailVerification,
  type VerifyOptions,
} from '../../audit/verify.js';
import { loadConfig, type LoadedConfig } from '../../config.js';
import { HushgateError, UsageError } from '../../errors.js';
import { boolFlag, listFlag, parseFlags, stringFlag, type FlagSpecs, type ParsedFlags } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const AUDIT_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  file: {
    type: 'string',
    alias: 'f',
    description: 'audit trail to read, the same as naming it after the subcommand (default: from the config)',
    placeholder: '<path>',
  },
  tenant: {
    type: 'string',
    description: "read this tenant's own trail (the global one if it has none)",
    placeholder: '<id>',
  },
  all: { type: 'boolean', description: "verify: every trail the config names, the global one and each tenant's" },
  anchor: {
    type: 'string',
    repeatable: true,
    description: 'a head recorded outside hushgate; fails unless a verified record has it (repeatable)',
    placeholder: '<hash>',
  },
  'continues-from': {
    type: 'string',
    description: 'the hash the first record links to, for a trail whose start was pruned or rotated away',
    placeholder: '<hash>',
  },
  from: { type: 'string', description: 'report: first UTC day to include, YYYY-MM-DD', placeholder: '<date>' },
  to: { type: 'string', description: 'report: last UTC day to include, YYYY-MM-DD', placeholder: '<date>' },
  json: { type: 'boolean', description: 'machine-readable output' },
};

export const AUDIT_SUMMARY = 'verify the audit chain, or report on what it contains';

type Subcommand = 'verify' | 'report';

/** What was asked for, once the flags have been checked against each other. */
interface AuditRequest {
  readonly subcommand: Subcommand;
  /** `-c` as given; `undefined` when the config is to be looked for in the working directory. */
  readonly config: string | undefined;
  /** A trail named on the command line, positionally or with `--file`. */
  readonly file: string | undefined;
  readonly tenant: string | undefined;
  readonly all: boolean;
  readonly json: boolean;
  readonly verify: VerifyOptions;
  readonly period: ReportPeriod;
}

/** The trail a command reads, and what its reader should know about the choice. */
interface Selection {
  readonly path: string;
  /** Whose records the file holds, when it came from the config. */
  readonly trail: ConfiguredTrail | null;
  /** Labelled in output only when tenants make the label informative. */
  readonly labelled: boolean;
  readonly notes: readonly string[];
  /** Tenants recorded in trails of their own, which this one does not cover. */
  readonly elsewhere: readonly string[];
}

export function audit(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, AUDIT_FLAGS);
  const [subcommand, ...operands] = parsed.positionals;

  if (subcommand !== 'verify' && subcommand !== 'report') {
    throw new UsageError(
      'hushgate audit needs a subcommand: "verify" to check the hash chain, or "report" for an Article 30 summary',
    );
  }

  const request = readRequest(parsed, subcommand, operands);

  if (needsNoConfig(request)) {
    return Promise.resolve(verify(cli, request, named(cli, request.file!, [])));
  }

  const loaded = loadConfig({ path: request.config, cwd: cli.cwd, env: cli.env });
  if (request.subcommand === 'report') return Promise.resolve(report(cli, request, loaded));
  if (request.all) return Promise.resolve(verifyAll(cli, request, loaded));
  return Promise.resolve(verify(cli, request, select(cli, request, loaded)));
}

/* ----------------------------------------------------------------- request */

/**
 * Check the flags against each other.
 *
 * Every combination that would otherwise be quietly ignored is refused. An
 * auditor who types `audit verify copy.jsonl --file live.jsonl`, or adds
 * `--from` to a verify, would get a confident verdict on something other
 * than what they asked about — the one failure this command must not have.
 */
function readRequest(parsed: ParsedFlags, subcommand: Subcommand, operands: readonly string[]): AuditRequest {
  const command = `"hushgate audit ${subcommand}"`;

  if (operands.length > 1) {
    throw new UsageError(
      `${command} reads one trail file, but was given ${operands.length}; use "verify --all" to check every trail the config names`,
    );
  }

  const flagFile = stringFlag(parsed, 'file');
  if (operands.length === 1 && flagFile !== undefined) {
    throw new UsageError(`name the trail once: after "${subcommand}" or with --file, not both`);
  }

  const file = operands[0] ?? flagFile;
  const tenant = stringFlag(parsed, 'tenant');
  const all = boolFlag(parsed, 'all');
  const from = stringFlag(parsed, 'from');
  const to = stringFlag(parsed, 'to');
  const anchors = listFlag(parsed, 'anchor').map((value) => hashFlag(value, '--anchor'));
  const continuesFrom = stringFlag(parsed, 'continues-from');

  if (subcommand === 'verify' && (from !== undefined || to !== undefined)) {
    throw new UsageError(
      '--from and --to choose the period of a report; "hushgate audit verify" always checks the whole trail',
    );
  }
  if (subcommand === 'report' && all) {
    throw new UsageError(
      '--all is for "hushgate audit verify"; a report covers one trail, chosen with --tenant <id> or a file',
    );
  }
  if (file !== undefined && tenant !== undefined) {
    throw new UsageError('--tenant picks a trail from the config; give either it or a trail file, not both');
  }
  if (all && (file !== undefined || tenant !== undefined)) {
    throw new UsageError('--all verifies every trail the config names, so it takes no trail file and no --tenant');
  }
  if (all && (anchors.length > 0 || continuesFrom !== undefined)) {
    throw new UsageError('--anchor and --continues-from describe one trail; name that trail instead of using --all');
  }

  return {
    subcommand,
    config: stringFlag(parsed, 'config'),
    file,
    tenant,
    all,
    json: boolFlag(parsed, 'json'),
    verify: {
      ...(continuesFrom === undefined ? {} : { from: hashFlag(continuesFrom, '--continues-from') }),
      anchors,
    },
    period: subcommand === 'report' ? parsePeriod(from, to) : { from: null, to: null },
  };
}

/**
 * A hash given on the command line, as the verifier wants it.
 *
 * Checked here rather than left to the verifier, so that a mistyped anchor is
 * a usage error (exit 2) that names the flag, not a failure (exit 1) that
 * reads as if the trail were at fault.
 */
function hashFlag(value: string, flag: string): string {
  const hash = value.toLowerCase();
  if (!isHash(hash)) {
    const shown = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    throw new UsageError(
      `${flag} needs a 64-character hex hash, as "hushgate audit verify" prints a head; got "${printable(shown)}"`,
    );
  }
  return hash;
}

/**
 * Whether the command can run without a configuration.
 *
 * Verifying a trail named on the command line needs nothing from the config.
 * Loading it anyway would let a config that does not load here — a broken
 * `hushgate.config.json` in the working directory, or a tenant whose key
 * secret is not exported in this shell — stop an auditor from checking a file
 * they were handed. An explicit `-c` is still loaded, and still has to load;
 * a report always needs one, for the organisation and its safeguards.
 */
function needsNoConfig(request: AuditRequest): boolean {
  return request.subcommand === 'verify' && request.file !== undefined && request.config === undefined;
}

/* ---------------------------------------------------------------- trails */

/**
 * The one trail a command reads.
 *
 * Without a file or `--tenant`, that is the global trail — and since a tenant
 * with its own `audit.path` is recorded only there, the reader is told which
 * trails were left out rather than left to assume the global one is all.
 */
function select(cli: Cli, request: AuditRequest, loaded: LoadedConfig): Selection {
  const trails = configuredTrails(loaded.config, cli.cwd);
  const labelled = loaded.config.tenants.length > 0;
  const global = trails[0]!;

  if (request.file !== undefined) {
    // Named by hand, but it may still be the global trail, and then it leaves
    // out the same tenants as when it is found through the config.
    const path = resolveTrailPath(cli.cwd, request.file);
    return named(cli, request.file, sameFile(path, global.path) ? tenantsElsewhere(trails) : []);
  }

  if (request.tenant === undefined) {
    const others = tenantsElsewhere(trails);
    const notes =
      request.subcommand === 'verify' && others.length > 0
        ? [
            `not checked: the trail${trails.length > 2 ? 's' : ''} of tenant${others.length === 1 ? '' : 's'} ${others.join(', ')}; "hushgate audit verify --all" checks every trail`,
          ]
        : [];
    return { path: global.path, trail: global, labelled, notes, elsewhere: others };
  }

  const tenant = loaded.config.tenants.find((candidate) => candidate.id === request.tenant);
  if (tenant === undefined) {
    const known = loaded.config.tenants.map((candidate) => candidate.id).join(', ');
    throw new UsageError(
      known === ''
        ? `no tenant "${request.tenant}": this configuration has no tenants`
        : `no tenant "${request.tenant}": known tenants are ${known}`,
    );
  }

  if (tenant.auditPath === null) {
    return {
      path: global.path,
      trail: global,
      labelled,
      notes: [
        `tenant ${tenant.id} has no audit trail of its own, so its records are in the global trail, which is what was ${request.subcommand === 'verify' ? 'verified' : 'reported on'}; it also holds every other request recorded there`,
      ],
      elsewhere: [],
    };
  }

  const own = trails.find((trail) => trail.tenants.includes(tenant.id))!;
  return { path: own.path, trail: own, labelled, notes: [], elsewhere: [] };
}

/** A trail named on the command line: no label, since nothing says whose it is. */
function named(cli: Cli, file: string, elsewhere: readonly string[]): Selection {
  return { path: resolveTrailPath(cli.cwd, file), trail: null, labelled: false, notes: [], elsewhere };
}

/** Tenants whose records go to a file other than the global trail. */
function tenantsElsewhere(trails: readonly ConfiguredTrail[]): string[] {
  return trails.slice(1).flatMap((trail) => trail.tenants);
}

function sameFile(a: string, b: string): boolean {
  const keys = trailFileKeys(b);
  return trailFileKeys(a).some((key) => keys.includes(key));
}

/** Whose records a trail holds, as a header names it. */
function labelOf(trail: ConfiguredTrail): string {
  const tenants = trail.tenants.join(', ');
  const plural = trail.tenants.length === 1 ? '' : 's';
  if (trail.global) return trail.tenants.length === 0 ? 'global' : `global; also tenant${plural} ${tenants}`;
  return `tenant${plural} ${tenants}`;
}

/* ---------------------------------------------------------------- verify */

function verify(cli: Cli, request: AuditRequest, selection: Selection): number {
  const result = verifyFile(selection.path, request.verify);

  if (request.json) {
    cli.stdout(`${JSON.stringify(verificationJson(selection.path, result), null, 2)}\n`);
    // stdout is the JSON a script parses; what a person should also know goes beside it.
    for (const note of selection.notes) cli.stderr(`hushgate: ${note}\n`);
    return result.ok ? EXIT.ok : EXIT.failure;
  }

  const label = selection.labelled && selection.trail !== null ? labelOf(selection.trail) : null;
  const lines = describeTrail(selection.path, label, result, request.verify);
  if (result.ok && result.verification.records > 0) lines.push('', ...ANCHOR_ADVICE);
  for (const note of selection.notes) lines.push('', `Note: ${note}.`);

  cli.stdout(`${lines.join('\n')}\n`);
  return result.ok ? EXIT.ok : EXIT.failure;
}

/**
 * Verify every distinct trail the config names.
 *
 * Each trail is verified and reported on its own, a trail that cannot be read
 * included, and the exit code fails if any one of them does: a CI step that
 * checks only the global trail would stay green while a tenant's chain broke.
 */
function verifyAll(cli: Cli, request: AuditRequest, loaded: LoadedConfig): number {
  const outcomes = configuredTrails(loaded.config, cli.cwd).map((trail) => {
    try {
      return { trail, result: verifyFile(trail.path, request.verify), error: null };
    } catch (error) {
      if (!(error instanceof HushgateError)) throw error;
      return { trail, result: null, error: error.message };
    }
  });
  const ok = outcomes.every((outcome) => outcome.result?.ok === true);

  if (request.json) {
    const trails = outcomes.map(({ trail, result, error }) => ({
      ...(result === null
        ? { file: trail.path, ok: false, error }
        : verificationJson(trail.path, result)),
      global: trail.global,
      tenants: trail.tenants,
    }));
    cli.stdout(`${JSON.stringify({ ok, trails }, null, 2)}\n`);
    return ok ? EXIT.ok : EXIT.failure;
  }

  const blocks = outcomes.map(({ trail, result, error }) =>
    result === null
      ? [`audit trail ${printable(trail.path)} (${labelOf(trail)})`, `  error        ${printable(error ?? '')}`]
      : describeTrail(trail.path, labelOf(trail), result, request.verify),
  );
  const failed = outcomes.filter((outcome) => outcome.result?.ok !== true).length;
  const summary =
    failed === 0
      ? `All ${outcomes.length} trail${outcomes.length === 1 ? '' : 's'} verified.`
      : `${failed} of ${outcomes.length} trail${outcomes.length === 1 ? '' : 's'} did not verify.`;

  const lines = separated(blocks);
  lines.push('', summary);
  if (ok && outcomes.some((outcome) => (outcome.result?.verification.records ?? 0) > 0)) {
    lines.push('', ...ANCHOR_ADVICE);
  }

  cli.stdout(`${lines.join('\n')}\n`);
  return ok ? EXIT.ok : EXIT.failure;
}

const ANCHOR_ADVICE = [
  'Anchor the head hash outside hushgate (a ticket, a signed note, another',
  'system) and pass it back with --anchor, so that records dropped from the',
  'end are detected too.',
];

/**
 * One trail's verdict, as lines a person reads.
 *
 * Everything that came from the file — an id, a timestamp, a detail — goes
 * through `printable`, because a tamperer chooses those bytes and a terminal
 * obeys the control sequences among them: an id can move the cursor up and
 * erase the line that says BROKEN.
 */
function describeTrail(
  path: string,
  label: string | null,
  result: TrailVerification,
  options: VerifyOptions,
): string[] {
  const chain = result.verification;
  const lines = [
    `audit trail ${printable(path)}${label === null ? '' : ` (${label})`}`,
    `  records      ${chain.records}`,
  ];

  if (options.from !== undefined) lines.push(`  from         ${chain.from}`);

  for (const line of result.malformed) {
    lines.push(`  unreadable   line ${line.line}: ${printable(line.reason)}`);
  }
  const unlisted = result.malformedCount - result.malformed.length;
  if (unlisted > 0) lines.push(`  unreadable   …and ${unlisted} more`);

  lines.push(
    chain.breakCount === 0
      ? '  chain        intact'
      : `  chain        BROKEN at ${chain.breakCount} point${chain.breakCount === 1 ? '' : 's'}`,
  );
  for (const at of chain.breaks) {
    const line = at.line === undefined ? '' : `, line ${at.line}`;
    lines.push(
      `  break        record ${at.index} (${at.reason})${line}: id ${printable(at.id)}, ts ${printable(at.ts)}`,
      `               ${printable(at.detail)}`,
    );
  }
  const moreBreaks = chain.breakCount - chain.breaks.length;
  if (moreBreaks > 0) lines.push(`  break        …and ${moreBreaks} more breaks`);

  lines.push(`  head         ${chain.head}`);

  for (const anchor of chain.anchors) lines.push(`  anchor       ${describeAnchor(anchor)}`);

  for (const gap of chain.gaps) {
    const line = gap.line === undefined ? '' : ` (line ${gap.line})`;
    lines.push(
      `  gap          ${gap.dropped} record${gap.dropped === 1 ? '' : 's'} could not be written before record ${gap.index}${line}`,
    );
  }
  const moreGaps = chain.gapCount - chain.gaps.length;
  if (moreGaps > 0) lines.push(`  gap          …and ${moreGaps} more gaps`);

  const explanations = explain(result);
  if (explanations.length > 0) lines.push('', ...separated(explanations.map((text) => [text])));
  return lines;
}

/** Blocks of lines, with one blank line between each. */
function separated(blocks: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    if (out.length > 0) out.push('');
    out.push(...block);
  }
  return out;
}

/**
 * Where an anchor was found. Index 0 is the hash the chain starts from, which
 * no record stores: a head taken while the trail was still empty.
 */
function describeAnchor(anchor: ChainVerification['anchors'][number]): string {
  if (!anchor.found) return `${anchor.hash} NOT FOUND`;
  const line = anchor.line === null ? '' : ` (line ${anchor.line})`;
  const where = anchor.index === 0 ? 'the start of the chain' : `record ${anchor.index}${line}`;
  const following = anchor.following ?? 0;
  return `${anchor.hash} found at ${where}, ${following} record${following === 1 ? '' : 's'} after it`;
}

/**
 * What the verdict means, in sentences.
 *
 * A break is where the chain stops agreeing with itself, and nothing more: the
 * records either side of it still link, so the damage is at the points listed,
 * not everything after the first. What the chain cannot show by itself — an
 * empty trail, records dropped from the end — is said as plainly, because both
 * verify as intact.
 */
function explain(result: TrailVerification): string[] {
  const chain = result.verification;
  const out: string[] = [];

  if (chain.breakCount > 0) {
    out.push(
      'Records outside the points listed still link correctly. At each listed\n' +
        'point a record was altered, or records were inserted or removed.',
    );
  }
  if (chain.anchors.some((anchor) => !anchor.found)) {
    out.push(
      'An anchored head that no verified record carries means records were\n' +
        'removed from the end of the trail, or the trail was rewritten, after the\n' +
        'anchor was taken.',
    );
  }
  if (result.malformedCount > 0) {
    out.push(
      'A line that cannot be read cannot be checked, so nothing it held is\n' +
        'covered by this verdict.',
    );
  }
  if (chain.gapCount > 0) {
    out.push(
      `Warning: the writer could not write ${chain.dropped} record${chain.dropped === 1 ? '' : 's'}, so requests were served\n` +
        'for which there is no record. The chain links across each gap, so this\n' +
        'does not fail verification; the service log from that time says why.',
    );
  }
  if (chain.records === 0) {
    out.push(
      'Warning: the trail holds no records. An empty trail verifies trivially,\n' +
        'and so does one that was emptied: compare it against a head anchored\n' +
        'outside hushgate (--anchor) before relying on it.',
    );
  }
  return out;
}

/**
 * The JSON verdict.
 *
 * `ok` is the whole verdict and matches the exit code: the chain links, every
 * anchor was found, and every line could be read. `chainOk` is the chain's
 * own verdict, without the unreadable lines. The keys a script read before —
 * file, records, firstBreak, head, malformed — keep their meaning.
 */
function verificationJson(path: string, result: TrailVerification): Record<string, unknown> {
  const chain = result.verification;
  return {
    file: path,
    ok: result.ok,
    chainOk: chain.ok,
    records: chain.records,
    firstBreak: chain.firstBreak,
    head: chain.head,
    from: chain.from,
    breaks: chain.breaks,
    breakCount: chain.breakCount,
    gaps: chain.gaps,
    gapCount: chain.gapCount,
    dropped: chain.dropped,
    anchors: chain.anchors,
    malformed: result.malformed,
    malformedCount: result.malformedCount,
  };
}

function verifyFile(path: string, options: VerifyOptions): TrailVerification {
  try {
    return verifyTrailFile(path, options);
  } catch (cause) {
    throw cannotRead(path, cause);
  }
}

/* ---------------------------------------------------------------- report */

/**
 * Build the report in one pass over the file.
 *
 * Every record is fed both to the chain verifier and to the report, so the
 * whole trail is verified — a break outside the period still means the figures
 * inside it cannot be trusted — without reading it twice or holding it.
 */
function report(cli: Cli, request: AuditRequest, loaded: LoadedConfig): number {
  const selection = select(cli, request, loaded);
  const verifier = new ChainVerifier(request.verify);
  const builder = new ReportBuilder({
    source: selection.path,
    config: loaded.config,
    period: request.period,
    configPath: loaded.source.path,
    tenantsElsewhere: selection.elsewhere,
  });

  let malformed = 0;
  let firstLine: number | null = null;
  for (const entry of entriesOf(selection.path)) {
    if ('malformed' in entry) {
      malformed += 1;
      firstLine ??= entry.line;
      continue;
    }
    verifier.push(entry.record, entry.line, entry.canonical);
    builder.add(entry.record);
  }

  const built = builder.finish({ chain: verifier.result(), malformed: { count: malformed, firstLine } });
  cli.stdout(request.json ? `${JSON.stringify(built, null, 2)}\n` : renderMarkdown(built));
  // stdout is the document; a note about which trail it covers goes beside it.
  for (const note of selection.notes) cli.stderr(`hushgate: ${note}\n`);

  // A report from a trail that does not verify is still worth printing — it
  // just cannot be relied on, which is why the exit code says so as well as
  // the document.
  return built.chain.ok && built.unreadable.count === 0 ? EXIT.ok : EXIT.failure;
}

/**
 * The trail's entries, with an error reading the file said as such.
 *
 * Only the reader's own errors pass through the `catch`: one thrown while the
 * caller handles an entry ends the loop without ever reaching the generator.
 */
function* entriesOf(path: string): Generator<TrailEntry, void, undefined> {
  try {
    yield* readTrailEntries(path);
  } catch (cause) {
    throw cannotRead(path, cause);
  }
}

function cannotRead(path: string, cause: unknown): Error {
  if (cause instanceof HushgateError) return cause;
  return new HushgateError(
    `cannot read the audit trail ${printable(path)}: ${printable((cause as Error).message)}`,
    { cause },
  );
}
