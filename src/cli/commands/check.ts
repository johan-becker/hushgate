/**
 * `hushgate check` — redact standard input to standard output.
 *
 * The Unix half of the tool: `cat notes.md | hushgate check > safe.md`, or pipe
 * a payload through it before handing it to something else. Findings are
 * summarised on stderr so stdout stays exactly what you asked for.
 */
import { loadConfig, redactionOptions } from '../../config.js';
import { BlockedContentError, HushgateError } from '../../errors.js';
import { countByKind, Session } from '../../redact/session.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, readAll, type Cli } from '../cli.js';

export const CHECK_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  quiet: { type: 'boolean', alias: 'q', description: 'do not write the summary to stderr' },
};

export const CHECK_SUMMARY = 'redact standard input to standard output';

export async function check(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, CHECK_FLAGS);

  if (parsed.positionals.length > 0) {
    throw new HushgateError(
      `hushgate check reads standard input; pass files to hushgate scan instead of "${parsed.positionals[0]!}"`,
    );
  }

  if (cli.stdin === undefined) throw new HushgateError('no standard input to read');

  const { config } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const session = new Session(redactionOptions(config));
  const input = await readAll(cli.stdin);

  let result;
  try {
    result = session.redact(input);
  } catch (error) {
    if (error instanceof BlockedContentError) {
      // Nothing is written to stdout: a blocked payload must not be piped on in
      // any form, not even a redacted one.
      cli.stderr(`hushgate: ${error.message}\n`);
      return EXIT.failure;
    }
    throw error;
  }

  cli.stdout(result.text);

  if (!boolFlag(parsed, 'quiet')) {
    const counts = countByKind(result.findings);
    const breakdown = Object.entries(counts)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(([kind, count]) => `${kind} ${count}`)
      .join(', ');

    cli.stderr(
      result.findings.length === 0
        ? 'hushgate: nothing to redact\n'
        : `hushgate: redacted ${result.findings.length} finding${
            result.findings.length === 1 ? '' : 's'
          } (${breakdown})\n`,
    );
  }

  return EXIT.ok;
}
