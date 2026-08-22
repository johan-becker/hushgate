/**
 * `hushgate doctor` — is this configuration safe to run?
 *
 * Built to be the CI step: it exits non-zero on anything unsafe, and every line
 * it prints says what to do about it. A checker that reports a problem without a
 * remedy just moves the work.
 */
import { isAbsolute, resolve as joinPath } from 'node:path';
import { loadConfig } from '../../config.js';
import { runChecks, tally, type Finding, type Severity } from '../../doctor/checks.js';
import { ConfigError } from '../../errors.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const DOCTOR_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  json: { type: 'boolean', description: 'machine-readable output' },
  'allow-warnings': { type: 'boolean', description: 'exit 0 when only warnings were found' },
};

export const DOCTOR_SUMMARY = 'check the configuration, the residency policy and the audit chain';

const MARKS: Readonly<Record<Severity, string>> = {
  ok: 'ok  ',
  note: 'note',
  warn: 'warn',
  fail: 'FAIL',
};

export function doctor(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, DOCTOR_FLAGS);
  const json = boolFlag(parsed, 'json');
  const allowWarnings = boolFlag(parsed, 'allow-warnings');

  let findings: Finding[];
  try {
    const { config, source } = loadConfig({
      path: stringFlag(parsed, 'config'),
      cwd: cli.cwd,
      env: cli.env,
    });

    findings = runChecks({
      config,
      configPath: source.path,
      auditPath: isAbsolute(config.audit.path)
        ? config.audit.path
        : joinPath(cli.cwd, config.audit.path),
    });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    // A config that will not parse is the first thing doctor should report, in
    // the same shape as everything else, rather than as a stack trace.
    findings = [
      {
        section: 'configuration',
        severity: 'fail',
        message: error.message,
        remedy: 'fix the configuration file; nothing else can be checked until it parses',
      },
    ];
  }

  const counts = tally(findings);

  if (json) {
    cli.stdout(`${JSON.stringify({ findings, counts }, null, 2)}\n`);
  } else {
    cli.stdout(render(findings, counts));
  }

  if (counts.fail > 0) return Promise.resolve(EXIT.failure);
  if (counts.warn > 0 && !allowWarnings) return Promise.resolve(EXIT.failure);
  return Promise.resolve(EXIT.ok);
}

function render(findings: readonly Finding[], counts: Record<Severity, number>): string {
  const lines: string[] = ['hushgate doctor', ''];
  let section = '';

  for (const finding of findings) {
    if (finding.section !== section) {
      section = finding.section;
      lines.push(section);
    }
    lines.push(`  ${MARKS[finding.severity]}  ${finding.message}`);
    if (finding.remedy !== undefined) lines.push(`        → ${finding.remedy}`);
  }

  lines.push('');

  if (counts.fail === 0 && counts.warn === 0) {
    lines.push('Nothing unsafe found.', '');
    return lines.join('\n');
  }

  const parts: string[] = [];
  if (counts.fail > 0) parts.push(`${counts.fail} failure${counts.fail === 1 ? '' : 's'}`);
  if (counts.warn > 0) parts.push(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`);

  lines.push(
    `${parts.join(', ')}. Fix them, or re-run with --allow-warnings to accept the warnings.`,
    '',
  );

  return lines.join('\n');
}
