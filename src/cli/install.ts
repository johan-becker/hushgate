/**
 * Putting hushgate within reach of the operator who just configured it.
 *
 * `npx hushgate setup` runs from a cache npm throws away, so the wizard can
 * finish having written a configuration for a command that does not exist.
 * This is the one thing hushgate installs, it installs it only when asked, and
 * it says which of the two places it went.
 *
 * Injected through {@link Cli} like the prompter: a test drives the wizard
 * through the whole install question without npm ever running.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { VERSION } from '../version.js';

/** `folder`: beside the configuration. `global`: on PATH. */
export type InstallScope = 'folder' | 'global';

export interface InstallOutcome {
  readonly ok: boolean;
  /** Why npm did not finish, for the operator to read. */
  readonly reason?: string;
}

export type Installer = (scope: InstallScope, cwd: string) => Promise<InstallOutcome>;

/**
 * Install the *running* version rather than the latest.
 *
 * The operator answered the questions in this version and the doctor report
 * they just read came out of it; fetching a newer one behind their back would
 * make that report a description of something else.
 */
export function installArgs(scope: InstallScope): string[] {
  return ['install', ...(scope === 'global' ? ['--global'] : []), `hushgate@${VERSION}`];
}

/**
 * Starting npm, as its own seam.
 *
 * A test drives the outcomes through a real child process with a known exit
 * code, which is the only way to cover them without either mocking an event
 * emitter or letting the suite run `npm install` for real.
 */
export type SpawnNpm = (args: readonly string[], cwd: string) => ChildProcess;

// Inherited, not captured: an install is the one part of setup that can take a
// while, and npm's own progress is better than silence.
const spawnNpm: SpawnNpm = (args, cwd) =>
  spawn('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

export function npmInstaller(start: SpawnNpm = spawnNpm): Installer {
  return (scope, cwd) =>
    new Promise<InstallOutcome>((resolve) => {
      const child = start(installArgs(scope), cwd);

      child.on('error', (error) => {
        resolve({ ok: false, reason: error.message });
      });
      child.on('close', (code) => {
        resolve(code === 0 ? { ok: true } : { ok: false, reason: `npm install exited ${code}` });
      });
    });
}
