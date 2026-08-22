/**
 * `hushgate scan` — find personal data in files, and say where it is.
 *
 * Built for CI: it exits 3 when it finds anything, so a pipeline step can fail
 * a build that is about to ship a fixture full of real customer records.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as joinPath } from 'node:path';
import { loadConfig, redactionOptions } from '../../config.js';
import { createDetectors, detect } from '../../detectors/index.js';
import { HushgateError } from '../../errors.js';
import { Session } from '../../redact/session.js';
import type { Policy, Span } from '../../types.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, readAll, type Cli } from '../cli.js';

export const SCAN_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  json: { type: 'boolean', description: 'machine-readable output' },
  'show-values': {
    type: 'boolean',
    description: 'print the data itself, not a masked preview',
  },
  quiet: { type: 'boolean', alias: 'q', description: 'only report the summary' },
};

export const SCAN_SUMMARY = 'find personal data in files; exits 3 when it finds any';

interface Hit {
  readonly kind: string;
  readonly policy: Policy;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
  readonly preview: string;
}

interface FileReport {
  readonly path: string;
  readonly hits: readonly Hit[];
}

export async function scan(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SCAN_FLAGS);
  const targets = parsed.positionals;

  if (targets.length === 0) {
    throw new HushgateError('hushgate scan needs at least one file, or - for standard input');
  }

  const { config } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const options = redactionOptions(config);
  const detectors = createDetectors(options);
  const session = new Session(options);
  const showValues = boolFlag(parsed, 'show-values');

  const reports: FileReport[] = [];
  for (const target of targets) {
    // Sequential on purpose: the report has to follow the order of the
    // arguments, and a scan is bounded by the files the user named.
    // oxlint-disable-next-line no-await-in-loop
    const text = await readTarget(cli, target);
    const hits = detect(text, detectors).map((span) =>
      toHit(span, text, session.policyFor(span.kind), showValues),
    );
    reports.push({ path: target, hits });
  }

  const total = reports.reduce((sum, report) => sum + report.hits.length, 0);

  if (boolFlag(parsed, 'json')) {
    cli.stdout(`${JSON.stringify(jsonReport(cli, reports, total), null, 2)}\n`);
  } else {
    cli.stdout(textReport(cli, reports, total, boolFlag(parsed, 'quiet')));
  }

  return total === 0 ? EXIT.ok : EXIT.findings;
}

async function readTarget(cli: Cli, target: string): Promise<string> {
  if (target === '-') {
    if (cli.stdin === undefined) throw new HushgateError('no standard input to read');
    return readAll(cli.stdin);
  }

  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new HushgateError(`cannot read ${target}: ${(cause as Error).message}`, { cause });
  }
}

function toHit(span: Span, text: string, policy: Policy, showValues: boolean): Hit {
  const { line, column } = position(text, span.start);
  return {
    kind: span.kind,
    policy,
    line,
    column,
    start: span.start,
    end: span.end,
    preview: showValues ? span.value : mask(span.value),
  };
}

/** 1-based line and column of an offset. */
export function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }

  return { line, column: offset - lineStart + 1 };
}

/**
 * A preview that identifies the finding without reproducing it.
 *
 * `scan` output ends up in CI logs, and a CI log is not a place to publish an
 * IBAN. `--show-values` is there for the local case where you want to see it.
 */
export function mask(value: string): string {
  const collapsed = value.replaceAll(/\s+/gu, ' ');
  if (collapsed.length <= 4) return '•'.repeat(collapsed.length);
  return `${collapsed.slice(0, 2)}${'•'.repeat(Math.min(6, collapsed.length - 4))}${collapsed.slice(-2)}`;
}

function jsonReport(cli: Cli, reports: readonly FileReport[], total: number): unknown {
  return {
    files: reports.map((report) => ({
      path: display(cli, report.path),
      findings: report.hits,
      counts: countKinds(report.hits),
    })),
    counts: countKinds(reports.flatMap((report) => report.hits)),
    findings: total,
  };
}

function textReport(
  cli: Cli,
  reports: readonly FileReport[],
  total: number,
  quiet: boolean,
): string {
  const lines: string[] = [];

  if (!quiet) {
    for (const report of reports) {
      if (report.hits.length === 0) continue;
      lines.push(display(cli, report.path));

      const width = Math.max(...report.hits.map((hit) => `${hit.line}:${hit.column}`.length));
      const kindWidth = Math.max(...report.hits.map((hit) => hit.kind.length));

      for (const hit of report.hits) {
        const where = `${hit.line}:${hit.column}`.padEnd(width);
        lines.push(`  ${where}  ${hit.kind.padEnd(kindWidth)}  ${hit.preview}  → ${hit.policy}`);
      }
      lines.push('');
    }
  }

  const counts = countKinds(reports.flatMap((report) => report.hits));
  const breakdown = Object.entries(counts)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');

  lines.push(
    total === 0
      ? `no personal data found in ${plural(reports.length, 'file')}`
      : `${plural(total, 'finding')} in ${plural(reports.length, 'file')}: ${breakdown}`,
  );

  return `${lines.join('\n')}\n`;
}

function countKinds(hits: readonly Hit[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const hit of hits) counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
  return counts;
}

function display(cli: Cli, target: string): string {
  if (target === '-') return '<stdin>';
  return isAbsolute(target) ? relative(cli.cwd, target) : target;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
