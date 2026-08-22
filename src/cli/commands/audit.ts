/**
 * `hushgate audit verify` and `hushgate audit report`.
 *
 * The two questions an auditor asks: can I trust this file, and what does it
 * say? The first is answered by walking the hash chain, the second by an
 * Article 30 style summary derived from it.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as joinPath } from 'node:path';
import { parseAuditLines } from '../../audit/log.js';
import { buildReport, renderMarkdown } from '../../audit/report.js';
import { verifyChain, type AuditRecord } from '../../audit/record.js';
import { loadConfig, type HushgateConfig } from '../../config.js';
import { HushgateError, UsageError } from '../../errors.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const AUDIT_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  file: { type: 'string', alias: 'f', description: 'audit trail to read (default: from the config)', placeholder: '<path>' },
  from: { type: 'string', description: 'first day to include, YYYY-MM-DD', placeholder: '<date>' },
  to: { type: 'string', description: 'last day to include, YYYY-MM-DD', placeholder: '<date>' },
  json: { type: 'boolean', description: 'machine-readable output' },
};

export const AUDIT_SUMMARY = 'verify the audit chain, or report on what it contains';

export function audit(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, AUDIT_FLAGS);
  const [subcommand] = parsed.positionals;

  const { config } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const path = resolveTrail(cli, config, stringFlag(parsed, 'file'));
  const json = boolFlag(parsed, 'json');

  switch (subcommand) {
    case 'verify': {
      return Promise.resolve(verify(cli, path, json));
    }
    case 'report': {
      return Promise.resolve(
        report(cli, path, config, json, {
          from: day(stringFlag(parsed, 'from'), '--from'),
          to: day(stringFlag(parsed, 'to'), '--to'),
        }),
      );
    }
    default: {
      throw new UsageError(
        'hushgate audit needs a subcommand: "verify" to check the hash chain, or "report" for an Article 30 summary',
      );
    }
  }
}

function verify(cli: Cli, path: string, json: boolean): number {
  const { records, malformed } = read(path);
  const result = verifyChain(records);

  if (json) {
    cli.stdout(`${JSON.stringify({ file: path, ...result, malformed }, null, 2)}\n`);
    return result.ok && malformed.length === 0 ? EXIT.ok : EXIT.failure;
  }

  cli.stdout(`audit trail ${path}\n  records      ${result.records}\n`);

  for (const line of malformed) {
    cli.stdout(`  unreadable   line ${line.line}: ${line.reason}\n`);
  }

  if (result.ok) {
    cli.stdout(
      `  chain        intact\n  head         ${result.head}\n\n` +
        'Anchor the head hash outside hushgate (a ticket, a signed note, another\n' +
        'system) if you also need to detect records being dropped from the end.\n',
    );
    return malformed.length === 0 ? EXIT.ok : EXIT.failure;
  }

  const first = result.firstBreak!;
  cli.stdout(
    [
      '  chain        BROKEN',
      `  first break  record ${first.index} (${first.reason})`,
      `  id           ${first.id}`,
      `  timestamp    ${first.ts}`,
      `  detail       ${first.detail}`,
      '',
      'Everything before that record still verifies. Everything from it onwards',
      'has been altered, or had records inserted or removed.',
      '',
    ].join('\n'),
  );
  return EXIT.failure;
}

function report(
  cli: Cli,
  path: string,
  config: HushgateConfig,
  json: boolean,
  period: { from: string | null; to: string | null },
): number {
  const { records } = read(path);
  const built = buildReport(records, { source: path, config, period });

  cli.stdout(json ? `${JSON.stringify(built, null, 2)}\n` : renderMarkdown(built));

  // A report from a broken trail is still worth printing — it just cannot be
  // relied on, which is why the exit code says so as well as the document.
  return built.chain.ok ? EXIT.ok : EXIT.failure;
}

function read(path: string): { records: AuditRecord[]; malformed: { line: number; reason: string }[] } {
  try {
    return parseAuditLines(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new HushgateError(`cannot read the audit trail ${path}: ${(cause as Error).message}`, {
      cause,
    });
  }
}

function resolveTrail(cli: Cli, config: HushgateConfig, override: string | undefined): string {
  const path = override ?? config.audit.path;
  return isAbsolute(path) ? path : joinPath(cli.cwd, path);
}

function day(value: string | undefined, flag: string): string | null {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new UsageError(`${flag} needs a date as YYYY-MM-DD, got "${value}"`);
  }
  return value;
}
