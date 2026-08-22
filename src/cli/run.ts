/**
 * Command dispatch. Every command is a function of a {@link Cli} and its own
 * arguments, returning an exit code — never calling `process.exit` itself, so
 * the whole surface stays testable in-process.
 */
import { ConfigError, HushgateError, UsageError } from '../errors.js';
import { VERSION } from '../version.js';
import { formatFlags, type FlagSpecs } from './args.js';
import { EXIT, type Cli } from './cli.js';
import { check, CHECK_FLAGS, CHECK_SUMMARY } from './commands/check.js';
import { scan, SCAN_FLAGS, SCAN_SUMMARY } from './commands/scan.js';
import { serve, SERVE_FLAGS, SERVE_SUMMARY } from './commands/serve.js';

interface Command {
  readonly summary: string;
  readonly usage: string;
  readonly flags: FlagSpecs;
  run(cli: Cli, argv: readonly string[]): Promise<number>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  serve: {
    summary: SERVE_SUMMARY,
    usage: 'hushgate serve [options]',
    flags: SERVE_FLAGS,
    run: serve,
  },
  scan: {
    summary: SCAN_SUMMARY,
    usage: 'hushgate scan [options] <file...>',
    flags: SCAN_FLAGS,
    run: scan,
  },
  check: {
    summary: CHECK_SUMMARY,
    usage: 'cat file | hushgate check [options]',
    flags: CHECK_FLAGS,
    run: check,
  },
};

export async function run(cli: Cli): Promise<number> {
  const [first, ...rest] = cli.argv;

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    const topic = first === 'help' ? rest[0] : undefined;
    cli.stdout(topic === undefined ? overallHelp() : commandHelp(topic));
    return EXIT.ok;
  }

  if (first === '--version' || first === '-v' || first === 'version') {
    cli.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }

  const command = COMMANDS[first];
  if (command === undefined) {
    cli.stderr(`hushgate: unknown command "${first}"\n\n${overallHelp()}`);
    return EXIT.usage;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    cli.stdout(commandHelp(first));
    return EXIT.ok;
  }

  try {
    return await command.run(cli, rest);
  } catch (error) {
    return report(cli, error);
  }
}

function report(cli: Cli, error: unknown): number {
  if (error instanceof UsageError) {
    cli.stderr(`hushgate: ${error.message}\n`);
    return EXIT.usage;
  }

  if (error instanceof ConfigError) {
    cli.stderr(`hushgate: configuration error\n  ${error.message}\n`);
    return EXIT.failure;
  }

  if (error instanceof HushgateError) {
    cli.stderr(`hushgate: ${error.message}\n`);
    return EXIT.failure;
  }

  cli.stderr(`hushgate: ${error instanceof Error ? error.message : String(error)}\n`);
  return EXIT.failure;
}

function overallHelp(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
    .join('\n');

  return `hushgate ${VERSION} — a local-first PII firewall for cloud LLM APIs

usage: hushgate <command> [options]

commands:
${commands}

  help [command]  show help, optionally for one command
  version         print the version

exit codes: 0 success, 1 failure, 2 usage, 3 hushgate scan found personal data.

Nothing personal leaves the machine.
`;
}

function commandHelp(name: string): string {
  const command = COMMANDS[name];
  if (command === undefined) return overallHelp();

  return `${command.summary}

usage: ${command.usage}

options:
${formatFlags(command.flags)}
`;
}
