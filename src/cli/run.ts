/**
 * Command dispatch. Every command is a function of a {@link Cli} and its own
 * arguments, returning an exit code — never calling `process.exit` itself, so
 * the whole surface stays testable in-process.
 */
import { ConfigError, HushgateError, UsageError } from '../errors.js';
import { VERSION } from '../version.js';
import { formatFlags, type FlagSpecs } from './args.js';
import { EXIT, type Cli } from './cli.js';
import { audit, AUDIT_FLAGS, AUDIT_SUMMARY } from './commands/audit.js';
import { briefing, BRIEFING_FLAGS, BRIEFING_SUMMARY } from './commands/briefing.js';
import { check, CHECK_FLAGS, CHECK_SUMMARY } from './commands/check.js';
import { doctor, DOCTOR_FLAGS, DOCTOR_SUMMARY } from './commands/doctor.js';
import { init, INIT_FLAGS, INIT_SUMMARY } from './commands/init.js';
import { keys, KEYS_FLAGS, KEYS_SUMMARY } from './commands/keys.js';
import { residency, RESIDENCY_FLAGS, RESIDENCY_SUMMARY } from './commands/residency.js';
import { extract, EXTRACT_FLAGS, EXTRACT_SUMMARY } from './commands/extract.js';
import { scan, SCAN_FLAGS, SCAN_SUMMARY } from './commands/scan.js';
import { serve, SERVE_FLAGS, SERVE_SUMMARY } from './commands/serve.js';
import { setup, SETUP_FLAGS, SETUP_SUMMARY } from './commands/setup.js';
import { update, UPDATE_FLAGS, UPDATE_SUMMARY } from './commands/update.js';
import { invokedAs } from './invocation.js';
import { didYouMean } from './suggest.js';

interface Command {
  readonly summary: string;
  readonly usage: string;
  readonly flags: FlagSpecs;
  run(cli: Cli, argv: readonly string[]): Promise<number>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  init: {
    summary: INIT_SUMMARY,
    usage: 'hushgate init [--path <path>] [--force]',
    flags: INIT_FLAGS,
    run: init,
  },
  setup: {
    summary: SETUP_SUMMARY,
    usage: 'hushgate setup [--path <path>] [--force]',
    flags: SETUP_FLAGS,
    run: setup,
  },
  serve: {
    summary: SERVE_SUMMARY,
    usage: 'hushgate serve [options]',
    flags: SERVE_FLAGS,
    run: serve,
  },
  scan: {
    summary: SCAN_SUMMARY,
    usage: [
      'hushgate scan [options] <file or folder...>',
      '',
      'A folder is walked, every file in it and below in name order; entries whose',
      'name starts with a dot, and node_modules, are left alone. - reads standard',
      'input. A file that cannot be read is named as unreadable, never counted as',
      'scanned.',
    ].join('\n'),
    flags: SCAN_FLAGS,
    run: scan,
  },
  extract: {
    summary: EXTRACT_SUMMARY,
    usage: 'hushgate extract [options] <file>',
    flags: EXTRACT_FLAGS,
    run: extract,
  },
  residency: {
    summary: RESIDENCY_SUMMARY,
    usage: 'hushgate residency [--json] [--registry]',
    flags: RESIDENCY_FLAGS,
    run: residency,
  },
  briefing: {
    summary: BRIEFING_SUMMARY,
    usage: 'hushgate briefing [--tenant <id>] [--kinds EMAIL,IBAN] [--json]',
    flags: BRIEFING_FLAGS,
    run: briefing,
  },
  doctor: {
    summary: DOCTOR_SUMMARY,
    usage: 'hushgate doctor [--json] [--allow-warnings]',
    flags: DOCTOR_FLAGS,
    run: doctor,
  },
  audit: {
    summary: AUDIT_SUMMARY,
    usage: [
      'hushgate audit verify [<file> | --tenant <id> | --all] [--anchor <hash>]...',
      '                             [--continues-from <hash>] [--json]',
      '       hushgate audit report [<file> | --tenant <id>] [--from <date>] [--to <date>]',
      '                             [--anchor <hash>]... [--continues-from <hash>] [--json]',
      '',
      'Without a file or --tenant, both read the global trail from the config. A',
      'tenant with its own audit.path is recorded only in that file: verify --all',
      'checks every trail the config names. Dates are UTC days, both inclusive.',
      'Exit 0 when the trail verifies, 1 when it does not, 2 on a usage error.',
    ].join('\n'),
    flags: AUDIT_FLAGS,
    run: audit,
  },
  keys: {
    summary: KEYS_SUMMARY,
    usage: 'hushgate keys new <tenant-id> | hushgate keys hash < key',
    flags: KEYS_FLAGS,
    run: keys,
  },
  check: {
    summary: CHECK_SUMMARY,
    usage: 'cat file | hushgate check [options]',
    flags: CHECK_FLAGS,
    run: check,
  },
  update: {
    summary: UPDATE_SUMMARY,
    usage: [
      'hushgate update [--check [--json]] [--to <version>] [--yes]',
      '',
      'Asks npm, through whatever registry npm is configured to use, for the newest',
      'hushgate, and installs it where this one is: globally, or into the project.',
      'The only command that contacts anything but the configured upstream, and',
      'only when run. A running "hushgate serve" keeps the old version until it is',
      'restarted.',
    ].join('\n'),
    flags: UPDATE_FLAGS,
    run: update,
  },
};

const HELP_WORDS = new Set(['help', '--help', '-h']);
const VERSION_WORDS = new Set(['version', '--version', '-v']);
const LIST_HINT = 'Run "hushgate help" for the list of commands.\n';

const isCommand = (token: string): boolean => Object.hasOwn(COMMANDS, token);

export async function run(cli: Cli): Promise<number> {
  const { argv } = cli;
  const first = argv[0];

  if (first === undefined) {
    cli.stdout(overallHelp(cli));
    return EXIT.ok;
  }
  if (VERSION_WORDS.has(first)) {
    cli.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  if (HELP_WORDS.has(first)) return help(cli, argv[1]);

  // The command is the first word that names one. Whatever stands before it is
  // handed to it along with the rest, so `hushgate --json residency` works as
  // well as `hushgate residency --json`: someone who has just read the flag
  // table should not be told that "--json" is an unknown command.
  const at = argv.findIndex(isCommand);
  if (at === -1) {
    if (argv.some((token) => HELP_WORDS.has(token))) {
      cli.stdout(overallHelp(cli));
      return EXIT.ok;
    }
    if (first.startsWith('-')) {
      cli.stderr(`hushgate: no command given, only options\n${LIST_HINT}`);
      return EXIT.usage;
    }
    return unknownCommand(cli, first);
  }

  const name = argv[at]!;
  const rest = argv.filter((_, index) => index !== at);
  const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
  if (options.some((token) => token === '--help' || token === '-h')) {
    cli.stdout(commandHelp(name));
    return EXIT.ok;
  }

  try {
    return await COMMANDS[name]!.run(cli, rest);
  } catch (error) {
    return report(cli, error);
  }
}

/** `hushgate help`, or `hushgate help <command>`. */
function help(cli: Cli, topic: string | undefined): number {
  if (topic === undefined || HELP_WORDS.has(topic) || VERSION_WORDS.has(topic)) {
    cli.stdout(overallHelp(cli));
    return EXIT.ok;
  }
  if (!isCommand(topic)) return unknownCommand(cli, topic);
  cli.stdout(commandHelp(topic));
  return EXIT.ok;
}

/**
 * Short, and on stderr: the whole command list is what `hushgate help` is
 * for, and a slip of the fingers is better answered with the word meant.
 */
function unknownCommand(cli: Cli, word: string): number {
  const hint = didYouMean(word, [...Object.keys(COMMANDS), 'help', 'version']);
  cli.stderr(`hushgate: unknown command "${word}"${hint === undefined ? '' : `; ${hint}`}\n${LIST_HINT}`);
  return EXIT.usage;
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

/**
 * The general help, led by the one command a newcomer needs. Someone who has
 * just typed `npx hushgate` to see what it is should not have to read eleven
 * commands to find out where to begin. Spelt the way this process was invoked,
 * since under npx there is no `hushgate` on PATH.
 */
function overallHelp(cli: Cli): string {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const commands = Object.entries(COMMANDS)
    .map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`)
    .join('\n');

  return `hushgate ${VERSION} — a local-first PII firewall for cloud LLM APIs

Start here:  ${invokedAs(cli.env)} setup

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
  if (command === undefined) throw new Error(`no help for an unknown command: ${name}`);

  return `${command.summary}

usage: ${command.usage}

options:
${formatFlags(command.flags)}
`;
}
