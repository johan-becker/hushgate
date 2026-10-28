import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import type { Choice, Prompter } from '../src/cli/prompt.js';
import { run } from '../src/cli/run.js';
import { compareVersions, type Updater } from '../src/cli/commands/update.js';
import { installArgs } from '../src/cli/install.js';
import { VERSION } from '../src/version.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-update-'));
  dirs.push(dir);
  return dir;
}

/** The version one minor release after the running one. */
const NEXT = ((): string => {
  const [major, minor] = VERSION.split('.').map(Number);
  return `${major}.${minor! + 1}.0`;
})();

type Where = 'global' | 'project' | 'npx' | 'clone' | 'other' | 'undeclared';

interface Fake {
  readonly updater: Updater;
  readonly installs: { version: string; scope: string; cwd: string }[];
  readonly root: string;
}

/** An updater whose hushgate sits where `where` says, against a registry with `latest`. */
function fake(where: Where, options: { latest?: string; registryDown?: boolean; installFails?: boolean } = {}): Fake {
  const root = workspace();
  const globalRoot = join(root, 'prefix', 'lib', 'node_modules');
  const packageRoot = {
    global: join(globalRoot, 'hushgate'),
    project: join(root, 'shop', 'node_modules', 'hushgate'),
    // In a node_modules, but neither npm's global root nor a project that declares it.
    undeclared: join(root, 'loose', 'node_modules', 'hushgate'),
    npx: join(root, 'cache', '_npx', '1a2b3c', 'node_modules', 'hushgate'),
    clone: join(root, 'hushgate'),
    other: join(root, 'app'),
  }[where];
  mkdirSync(packageRoot, { recursive: true });
  if (where === 'clone') mkdirSync(join(packageRoot, '.git'));
  if (where === 'project') {
    writeFileSync(join(root, 'shop', 'package.json'), JSON.stringify({ dependencies: { hushgate: `^${VERSION}` } }));
  }

  const installs: { version: string; scope: string; cwd: string }[] = [];
  let installed = VERSION;
  const latest = options.latest ?? NEXT;

  const updater: Updater = {
    packageRoot,
    resolve: (spec) => {
      if (options.registryDown === true) return Promise.reject(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'));
      if (spec === 'latest') return Promise.resolve(latest);
      return Promise.resolve(spec === '9.9.9' ? undefined : spec);
    },
    globalRoot: () => Promise.resolve(globalRoot),
    install: (version, scope, cwd) => {
      installs.push({ version, scope, cwd });
      if (options.installFails === true) return Promise.resolve({ ok: false, reason: 'npm install exited 1' });
      installed = version;
      return Promise.resolve({ ok: true });
    },
    installedVersion: () => installed,
  };
  return { updater, installs, root };
}

function prompter(answer: boolean, asked: string[] = []): () => Prompter {
  return () => ({
    text: () => Promise.reject(new Error('no text question expected')),
    choose: <T,>(_q: string, _c: readonly Choice<T>[]): Promise<T> => Promise.reject(new Error('no choice expected')),
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(answer);
    },
    close: () => {},
  });
}

function capture(argv: string[], extra: Partial<Cli> = {}): { cli: Cli; out(): string; err(): string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: { argv, stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: {}, cwd: process.cwd(), ...extra },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('hushgate update --check', () => {
  it('says so when the installed version is the newest', async () => {
    const f = fake('global', { latest: VERSION });
    const c = capture(['update', '--check'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain(`installed  ${VERSION}`);
    expect(c.out()).toContain('up to date');
    expect(f.installs).toEqual([]);
  });

  it('names the newer release and how to install it, and installs nothing', async () => {
    const f = fake('global');
    const c = capture(['update', '--check'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain(`latest     ${NEXT}`);
    expect(c.out()).toContain(`https://github.com/johan-becker/hushgate/blob/v${NEXT}/CHANGELOG.md`);
    expect(c.out()).toContain('hushgate update');
    expect(f.installs).toEqual([]);
  });

  it('answers in JSON for monitoring', async () => {
    const f = fake('project');
    const c = capture(['update', '--check', '--json'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(JSON.parse(c.out())).toEqual({
      installed: VERSION,
      latest: NEXT,
      updateAvailable: true,
      installedBy: 'project',
      location: join(f.root, 'shop'),
    });
  });

  it('fails plainly when npm cannot reach a registry', async () => {
    const f = fake('global', { registryDown: true });
    const c = capture(['update', '--check'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('cannot ask npm about hushgate releases');
    expect(c.err()).toContain('ENOTFOUND registry.npmjs.org');
  });
});

describe('hushgate update', () => {
  it('asks, installs the newest release where this one is, and says what is left to do', async () => {
    const f = fake('global');
    const asked: string[] = [];
    const c = capture(['update'], { updater: f.updater, prompt: prompter(true, asked) });

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(asked).toEqual([`Update hushgate from ${VERSION} to ${NEXT}?`]);
    expect(f.installs).toEqual([{ version: NEXT, scope: 'global', cwd: c.cli.cwd }]);
    expect(c.out()).toContain(`updated to ${NEXT}`);
    // The process that is serving still runs the old code.
    expect(c.out()).toContain('A running "hushgate serve" keeps');
    expect(c.out()).toContain('hushgate doctor');
  });

  it('warns that a 0.x minor release can change behaviour', async () => {
    const f = fake('global');
    const c = capture(['update', '--check'], { updater: f.updater });
    await run(c.cli);
    expect(c.out()).toContain('can change behaviour');
  });

  it('installs nothing when the operator says no', async () => {
    const f = fake('global');
    const c = capture(['update'], { updater: f.updater, prompt: prompter(false) });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(f.installs).toEqual([]);
    expect(c.out()).toContain('nothing changed');
  });

  it('needs --yes where there is no terminal to ask on', async () => {
    const f = fake('global');
    const c = capture(['update'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('--yes');
    expect(f.installs).toEqual([]);

    const yes = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(yes.cli)).toBe(EXIT.ok);
    expect(f.installs).toHaveLength(1);
  });

  it('updates a project install inside that project', async () => {
    const f = fake('project');
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(f.installs).toEqual([{ version: NEXT, scope: 'folder', cwd: join(f.root, 'shop') }]);
  });

  it('installs the version --to names, older ones included', async () => {
    const f = fake('global');
    const c = capture(['update', '--to', '0.1.0', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(f.installs[0]!.version).toBe('0.1.0');
    expect(c.out()).toContain('going back');
  });

  it('refuses a --to that is not a version, and one the registry does not have', async () => {
    const f = fake('global');
    const bad = capture(['update', '--to', 'newest'], { updater: f.updater });
    expect(await run(bad.cli)).toBe(EXIT.usage);

    const missing = capture(['update', '--to', '9.9.9', '--yes'], { updater: f.updater });
    expect(await run(missing.cli)).toBe(EXIT.failure);
    expect(missing.err()).toContain('9.9.9');
    expect(f.installs).toEqual([]);
  });

  it('says so when npm fails, and does not claim the update', async () => {
    const f = fake('global', { installFails: true });
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('npm install exited 1');
    expect(c.out()).not.toContain('updated to');
  });

  it('leaves alone a version newer than the newest release', async () => {
    const f = fake('global', { latest: '0.0.1' });
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(f.installs).toEqual([]);
    expect(c.out()).toContain('newer than the newest release');
  });
});

describe('hushgate update where npm did not put it', () => {
  it('tells an npx caller to name the version instead', async () => {
    const f = fake('npx');
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain(`npx hushgate@${NEXT}`);
    expect(f.installs).toEqual([]);
  });

  it('tells a clone to pull and build', async () => {
    const f = fake('clone');
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('git pull');
    expect(f.installs).toEqual([]);
  });

  it('installs nothing where it cannot tell how npm installed it, and says both ways', async () => {
    // npm prints a path it considers secret-looking as ***, so its global root
    // cannot always be matched; a guess would install into the wrong place.
    const f = fake('undeclared');
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain(`npm install --global hushgate@${NEXT}`);
    expect(c.out()).toContain(`npm install hushgate@${NEXT}`);
    expect(f.installs).toEqual([]);
  });

  it('tells an image to be rebuilt', async () => {
    const f = fake('other');
    const c = capture(['update', '--yes'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('image');
    expect(f.installs).toEqual([]);
  });

  it('still answers --check for them, with exit 0', async () => {
    const f = fake('clone');
    const c = capture(['update', '--check'], { updater: f.updater });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain(`latest     ${NEXT}`);
  });
});

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
    expect(compareVersions('0.6.0', '0.6.1')).toBeLessThan(0);
  });
});

describe('installArgs with a version', () => {
  it('installs the version it is given', () => {
    expect(installArgs('global', '0.7.0')).toEqual(['install', '--global', 'hushgate@0.7.0']);
    expect(installArgs('folder', '0.7.0')).toEqual(['install', 'hushgate@0.7.0']);
  });
});
