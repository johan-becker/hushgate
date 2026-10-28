/**
 * `hushgate update` — is there a newer hushgate, and install it.
 *
 * The one command that talks to anything but the configured upstream, and only
 * because the operator typed it: `serve`, `doctor` and the rest never ask a
 * registry anything. It asks npm rather than fetching a URL itself, so that a
 * company's own registry mirror, proxy and credentials apply to the check
 * exactly as they will to the install.
 *
 * It updates only what npm installed — globally, or into a project. A copy
 * that npm did not put there (npx's cache, a git clone, the Docker image) is
 * not this command's to rewrite; it says what updates that one instead.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HushgateError, UsageError } from '../../errors.js';
import { VERSION } from '../../version.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';
import { invokedAs } from '../invocation.js';
import { npmInstaller, type InstallOutcome, type InstallScope } from '../install.js';

export const UPDATE_FLAGS: FlagSpecs = {
  check: { type: 'boolean', description: 'only say whether a newer version exists; install nothing' },
  to: { type: 'string', description: 'install this version rather than the newest, older ones included', placeholder: '<version>' },
  yes: { type: 'boolean', alias: 'y', description: 'install without asking; needed where there is no terminal' },
  json: { type: 'boolean', description: 'with --check: machine-readable output' },
};

export const UPDATE_SUMMARY = 'see whether a newer hushgate exists, and install it';

const REPOSITORY = 'https://github.com/johan-becker/hushgate';

/** Everything the command needs from npm and the file system, injectable for tests. */
export interface Updater {
  /** The directory this hushgate is installed in, symbolic links resolved. */
  readonly packageRoot: string;
  /** The version the registry resolves `spec` to — `latest`, or an exact version — or undefined if it has none. */
  resolve(spec: string): Promise<string | undefined>;
  /** npm's global `node_modules`, or undefined if npm cannot say. */
  globalRoot(): Promise<string | undefined>;
  /** Install hushgate at `version`, globally or into the project at `cwd`. */
  install(version: string, scope: InstallScope, cwd: string): Promise<InstallOutcome>;
  /** The version now installed at {@link packageRoot}, read afresh. */
  installedVersion(): string;
}

/** How this hushgate got where it is, which decides who updates it. */
type InstalledBy = 'global' | 'project' | 'npx' | 'clone' | 'undeclared' | 'other';

interface Location {
  readonly by: InstalledBy;
  /** The project for `project`, the clone for `clone`, the package otherwise. */
  readonly dir: string;
}

export async function update(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, UPDATE_FLAGS);
  if (parsed.positionals.length > 0) {
    throw new UsageError(`hushgate update takes no arguments; to install a particular version, use --to ${parsed.positionals[0]}`);
  }
  const check = boolFlag(parsed, 'check');
  const json = boolFlag(parsed, 'json');
  const to = stringFlag(parsed, 'to');
  if (json && !check) throw new UsageError('--json goes with --check; an update itself reports in text');
  if (to !== undefined && !/^\d+\.\d+\.\d+$/u.test(to)) {
    throw new UsageError(`--to needs a version such as 0.6.0, got "${to}"`);
  }

  const updater = cli.updater ?? npmUpdater();
  const where = await locate(updater);

  let target: string | undefined;
  try {
    target = await updater.resolve(to ?? 'latest');
  } catch (error) {
    throw new HushgateError(
      `cannot ask npm about hushgate releases: ${error instanceof Error ? error.message : String(error)}\n` +
        '  hushgate update needs the npm registry, or the mirror npm is configured to use.',
      { cause: error },
    );
  }
  if (target === undefined) throw new HushgateError(`the registry has no hushgate ${to ?? 'release'}`);

  const order = compareVersions(target, VERSION);
  const command = invokedAs(cli.env);

  if (json) {
    cli.stdout(
      `${JSON.stringify(
        { installed: VERSION, latest: target, updateAvailable: order > 0, installedBy: where.by, location: where.dir },
        null,
        2,
      )}\n`,
    );
    return EXIT.ok;
  }

  const lines = [
    'hushgate update',
    `  installed  ${VERSION}  (${describe(where)})`,
    `  ${to === undefined ? 'latest   ' : 'requested'}  ${target}`,
  ];

  if (order === 0) {
    cli.stdout(`${[...lines, '  up to date', ''].join('\n')}\n`);
    return EXIT.ok;
  }
  if (order < 0 && to === undefined) {
    cli.stdout(`${[...lines, '  this version is newer than the newest release; nothing to do', ''].join('\n')}\n`);
    return EXIT.ok;
  }

  lines.push(`  changes    ${REPOSITORY}/blob/v${order > 0 ? target : VERSION}/CHANGELOG.md`);
  if (order > 0 && changesBehaviour(VERSION, target)) {
    lines.push('', `  Before 1.0, a minor release can change behaviour: read the changes first.`);
  }
  if (order < 0) lines.push('', `  This is going back to an older version.`);

  const manual = instructionsFor(where, target);
  if (check) {
    lines.push('', manual === undefined ? `  Run "${command} update" to install it.` : manual);
    cli.stdout(`${lines.join('\n')}\n\n`);
    return EXIT.ok;
  }
  if (manual !== undefined) {
    // Not ours to rewrite: say what updates it, and that nothing was updated.
    cli.stdout(`${lines.join('\n')}\n\n${manual}\n\n`);
    return EXIT.failure;
  }

  cli.stdout(`${lines.join('\n')}\n\n`);
  if (!boolFlag(parsed, 'yes')) {
    if (cli.prompt === undefined) {
      throw new UsageError('there is no terminal to ask on; pass --yes to update without asking, or --check to only look');
    }
    const prompter = cli.prompt();
    let go: boolean;
    try {
      go = await prompter.confirm(`Update hushgate from ${VERSION} to ${target}?`, true);
    } finally {
      prompter.close();
    }
    if (!go) {
      cli.stdout('  nothing changed\n');
      return EXIT.ok;
    }
  }

  const scope: InstallScope = where.by === 'global' ? 'global' : 'folder';
  const cwd = where.by === 'global' ? cli.cwd : where.dir;
  const outcome = await updater.install(target, scope, cwd);
  if (!outcome.ok) {
    throw new HushgateError(`the update did not finish: ${outcome.reason ?? 'npm did not say why'}; ${VERSION} is still installed`);
  }

  const now = updater.installedVersion();
  if (now !== target) {
    throw new HushgateError(`npm finished, but ${now} is installed rather than ${target}`);
  }

  cli.stdout(
    [
      `  updated to ${target}`,
      '',
      `  A running "hushgate serve" keeps ${VERSION} until it is restarted. Restart it, or`,
      '  the service that runs it, and check the configuration against the new version:',
      '',
      `    ${command} doctor`,
      '',
    ].join('\n'),
  );
  return EXIT.ok;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A new major version, or a new minor one before 1.0: either may change behaviour. */
function changesBehaviour(from: string, to: string): boolean {
  const [fromMajor, fromMinor] = from.split('.').map(Number);
  const [toMajor, toMinor] = to.split('.').map(Number);
  return toMajor! > fromMajor! || (fromMajor === 0 && toMinor! > fromMinor!);
}

async function locate(updater: Updater): Promise<Location> {
  const root = updater.packageRoot;
  if (root.split(sep).includes('_npx')) return { by: 'npx', dir: root };
  if (existsSync(join(root, '.git'))) return { by: 'clone', dir: root };

  const modules = dirname(root);
  if (basename(modules) !== 'node_modules') return { by: 'other', dir: root };

  // A project install is decided by what is on disk: the project's own
  // package.json names hushgate, because npm wrote it there.
  const project = dirname(modules);
  if (declaresHushgate(join(project, 'package.json'))) return { by: 'project', dir: project };

  // A global one only by npm's word, and npm prints any path segment that
  // looks like a token as ***. When the two cannot be matched, nothing is
  // guessed: installing into the wrong place is worse than not installing.
  const global = await updater.globalRoot();
  if (global !== undefined && resolvePath(global) === resolvePath(modules)) return { by: 'global', dir: root };
  return { by: 'undeclared', dir: project };
}

function declaresHushgate(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((field) => {
      const deps = manifest[field];
      return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, 'hushgate');
    });
  } catch {
    return false;
  }
}

function describe(where: Location): string {
  switch (where.by) {
    case 'global':
      return 'installed globally by npm';
    case 'project':
      return `installed by npm into ${where.dir}`;
    case 'npx':
      return 'run by npx from its cache';
    case 'clone':
      return `a clone at ${where.dir}`;
    case 'undeclared':
      return `installed by npm under ${where.dir}, neither globally nor as a dependency`;
    case 'other':
      return `not installed by npm: ${where.dir}`;
  }
}

/** What updates a copy this command does not, or undefined when it does. */
function instructionsFor(where: Location, target: string): string | undefined {
  switch (where.by) {
    case 'global':
    case 'project':
      return undefined;
    case 'npx':
      return [
        '  npx runs whichever version you name, so there is nothing to install:',
        `    npx hushgate@${target} <command>`,
      ].join('\n');
    case 'undeclared':
      return [
        '  npm installed this copy, but not where npm says global installs go, and no',
        '  package.json here names it, so it is not clear which npm command owns it.',
        '  Whichever of these installed it updates it:',
        `    npm install --global hushgate@${target}`,
        `    cd ${where.dir} && npm install hushgate@${target}`,
      ].join('\n');
    case 'clone':
      return [
        `  This is a clone. Update it there, at the release you want:`,
        `    cd ${where.dir} && git pull && git checkout v${target} && npm ci && npm run build`,
      ].join('\n');
    case 'other':
      return [
        '  npm did not install this copy, so npm cannot update it. In the Docker image,',
        `  build or pull the image for ${target} and restart the container.`,
      ].join('\n');
  }
}

/* -------------------------------------------------------------- the real one */

/** The package this command is part of: dist/cli/commands/ is three levels down. */
function ownPackageRoot(): string {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  try {
    return realpathSync(root);
  } catch {
    return resolvePath(root);
  }
}

/** Run npm and collect what it prints, giving up after a minute. */
function npmOutput(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(firstErrorLine(err) ?? `npm ${args[0]} exited ${code}`));
    });
  });
}

/** npm's most telling line: the first "npm error" that is not boilerplate. */
function firstErrorLine(stderr: string): string | undefined {
  return stderr
    .split('\n')
    .map((line) => line.replace(/^npm (error|ERR!)\s*/u, '').trim())
    .find((line) => line !== '' && !/^(code|errno|A complete log)/u.test(line));
}

export function npmUpdater(): Updater {
  const packageRoot = ownPackageRoot();
  const install = npmInstaller();
  return {
    packageRoot,
    async resolve(spec) {
      let out: string;
      try {
        out = (await npmOutput(['view', `hushgate@${spec}`, 'version', '--json'])).trim();
      } catch (error) {
        // A version the registry does not have is an answer, not a failure to ask.
        if (error instanceof Error && /\b404\b|No match found/u.test(error.message)) return undefined;
        throw error;
      }
      if (out === '') return undefined;
      const parsed = JSON.parse(out) as string | string[];
      return Array.isArray(parsed) ? parsed.at(-1) : parsed;
    },
    async globalRoot() {
      try {
        return (await npmOutput(['root', '--global'])).trim();
      } catch {
        return undefined;
      }
    },
    install: (version, scope, cwd) => install(scope, cwd, version),
    installedVersion() {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string };
      return manifest.version;
    },
  };
}

