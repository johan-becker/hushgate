/**
 * The one thing hushgate installs. What it hands npm, and what it makes of
 * how npm exits, both decide what the operator is told at the end of setup.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installArgs, npmInstaller, type SpawnNpm } from '../src/cli/install.js';
import { VERSION } from '../src/version.js';

describe('installArgs', () => {
  it('pins the running version rather than fetching the latest', () => {
    // The operator answered the questions in this version and read a doctor
    // report out of it; a newer one would describe something else.
    expect(installArgs('folder')).toEqual(['install', `hushgate@${VERSION}`]);
  });

  it('asks npm for a global install when that is the scope', () => {
    expect(installArgs('global')).toEqual(['install', '--global', `hushgate@${VERSION}`]);
  });
});

/** A real child process that exits with the given code — no npm, no network. */
const exitsWith =
  (code: number): SpawnNpm =>
  (_args, cwd) =>
    spawn(process.execPath, ['-e', `process.exit(${code})`], { cwd, stdio: 'ignore' });

describe('npmInstaller', () => {
  it('succeeds when npm exits clean', async () => {
    expect(await npmInstaller(exitsWith(0))('folder', process.cwd())).toEqual({ ok: true });
  });

  it('reports the exit code when npm does not finish', async () => {
    // The global install on a locked-down machine is exactly this branch:
    // npm prints its own EACCES and leaves with a non-zero code.
    expect(await npmInstaller(exitsWith(243))('global', process.cwd())).toEqual({
      ok: false,
      reason: 'npm install exited 243',
    });
  });

  it('reports the reason when npm cannot be started at all', async () => {
    const outcome = await npmInstaller()('folder', join(tmpdir(), 'hushgate-no-such-dir'));
    expect(outcome.ok).toBe(false);
    expect(outcome.reason ?? '').toContain('ENOENT');
  });
});
