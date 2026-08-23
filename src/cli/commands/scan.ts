/**
 * `hushgate scan` — find personal data in files, and say where it is.
 *
 * Built for CI: it exits 3 when it finds anything, so a pipeline step can fail
 * a build that is about to ship a fixture full of real customer records.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as joinPath } from 'node:path';
import { assessText, hidesIdentifiers } from '../../attach/quality.js';
import { buildExtractors } from '../../attach/registry.js';
import { mediaTypeForFormat, sniffFormat } from '../../attach/sniff.js';
import type { Extractor } from '../../attach/types.js';
import { loadConfig, redactionOptions, type HushgateConfig } from '../../config.js';
import { createDetectors, detect } from '../../detectors/index.js';
import { HushgateError, UsageError } from '../../errors.js';
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
  /** Why this file could not be read, when it could not be. */
  readonly unreadable?: string;
}

export async function scan(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SCAN_FLAGS);
  const targets = parsed.positionals;

  if (targets.length === 0) {
    throw new UsageError('hushgate scan needs at least one file, or - for standard input');
  }

  const { config } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const options = redactionOptions(config);
  const extractors = buildExtractors(config.attachments.extractors);
  const detectors = createDetectors(options);
  const session = new Session(options);
  const showValues = boolFlag(parsed, 'show-values');

  const reports: FileReport[] = [];
  for (const target of targets) {
    // Sequential on purpose: the report has to follow the order of the
    // arguments, and a scan is bounded by the files the user named.
    //
    // One target that cannot be read must not discard the run. The command
    // exists to sweep a folder of documents, and a single logo among two
    // hundred contracts would otherwise print nothing at all — the operator
    // sees silence and concludes the folder is clean.
    let text: string;
    try {
      // oxlint-disable-next-line no-await-in-loop
      text = await readTarget(cli, target, config, extractors, session);
    } catch (error) {
      if (!(error instanceof HushgateError)) throw error;
      // Written to stderr as well as recorded in the report: the report is the
      // result, but a file that could not be read is a diagnostic, and a
      // pipeline redirecting stdout to a findings file still has to see it.
      cli.stderr(`hushgate: ${error.message}\n`);
      reports.push({ path: target, hits: [], unreadable: reasonOf(error, target) });
      continue;
    }

    const hits = detect(text, detectors).map((span) =>
      toHit(span, text, session.policyFor(span.kind), showValues),
    );
    reports.push({ path: target, hits });
  }

  const total = reports.reduce((sum, report) => sum + report.hits.length, 0);
  const unreadable = reports.filter((report) => report.unreadable !== undefined).length;

  if (boolFlag(parsed, 'json')) {
    cli.stdout(`${JSON.stringify(jsonReport(cli, reports, total), null, 2)}\n`);
  } else {
    cli.stdout(textReport(cli, reports, total, boolFlag(parsed, 'quiet')));
  }

  // A file that could not be read is not a file that was found clean, so the
  // run does not report success on it. Findings still win the exit code,
  // because a pipeline that fails a build on personal data must keep doing so.
  if (total > 0) return EXIT.findings;
  return unreadable > 0 ? EXIT.failure : EXIT.ok;
}

/** The message an operator can act on, with the path they typed left in it. */
function reasonOf(error: HushgateError, target: string): string {
  const prefix = `cannot read ${target}: `;
  return error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
}

/**
 * Read one target as text.
 *
 * A PDF or a Word file read as UTF-8 is mojibake, and a scan over mojibake
 * finds nothing — which would report a folder of customer contracts as clean.
 * So the same extractors the proxy uses run here, and a document that cannot be
 * read is an error rather than an empty result.
 */
async function readTarget(
  cli: Cli,
  target: string,
  config: HushgateConfig,
  extractors: readonly Extractor[],
  session: Session,
): Promise<string> {
  if (target === '-') {
    if (cli.stdin === undefined) throw new HushgateError('no standard input to read');
    return readAll(cli.stdin);
  }

  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new HushgateError(`cannot read ${target}: ${(cause as Error).message}`, { cause });
  }

  const format = sniffFormat(bytes, null, target);
  // Plain text is read as it always was: routing it through an extractor would
  // only risk changing what a long-standing scan reports.
  if (format === 'text' || format === 'csv' || format === 'json' || format === 'xml') {
    return bytes.toString('utf8');
  }

  const context = {
    format,
    // No caller declared anything here, so the type sniffing inferred stands in
    // for one — otherwise an extractor configured by media type, which is the
    // usual way, would never match a file named on the command line.
    mediaType: mediaTypeForFormat(format),
    maxChars: config.attachments.maxTextChars,
    timeoutMs: config.attachments.timeoutMs,
  };

  let reason = `no extractor handles ${format}`;
  for (const extractor of extractors) {
    if (!extractor.supports(format, context.mediaType)) continue;
    // Sequential on purpose: the first extractor to produce trustworthy text is
    // the one the proxy would have used.
    // oxlint-disable-next-line no-await-in-loop
    const result = await extractor.extract(bytes, context);
    if (!result.ok) {
      reason = result.reason;
      continue;
    }
    const verdict = assessText(result.value.text, result.value.pages);
    if (!verdict.ok) {
      reason = verdict.reason;
      continue;
    }

    // The same question the proxy asks. This command exists to show what
    // hushgate would send, so a document the proxy would refuse must be
    // refused here too rather than printed as though it were readable.
    if (hidesIdentifiers(result.value.text, (text) => session.countFindings(text))) {
      reason = 'the spacing in this document splits identifiers, so they would not be recognised';
      continue;
    }
    return result.value.text;
  }

  throw new HushgateError(`cannot read ${target}: ${reason}`);
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
      // Present only when the file could not be read, so a consumer can tell a
      // clean file from one that was never scanned. An absent key means it was.
      ...(report.unreadable === undefined ? {} : { unreadable: report.unreadable }),
    })),
    counts: countKinds(reports.flatMap((report) => report.hits)),
    findings: total,
    unreadable: reports.filter((report) => report.unreadable !== undefined).length,
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
      if (report.unreadable !== undefined) {
        lines.push(display(cli, report.path), `  unreadable  ${report.unreadable}`, '');
        continue;
      }
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

  const unreadable = reports.filter((report) => report.unreadable !== undefined).length;
  const scanned = reports.length - unreadable;

  lines.push(
    total === 0
      ? `no personal data found in ${plural(scanned, 'file')}`
      : `${plural(total, 'finding')} in ${plural(scanned, 'file')}: ${breakdown}`,
  );

  // Said out loud, and never folded into the "no personal data found" line: a
  // file that was not read is not a file that was found clean.
  if (unreadable > 0) {
    lines.push(`${plural(unreadable, 'file')} could not be read and ${unreadable === 1 ? 'was' : 'were'} not scanned`);
  }

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
