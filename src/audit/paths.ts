/**
 * Where the audit trails are.
 *
 * `hushgate serve` writes one trail per distinct file the config names: the
 * global one, and the `audit.path` of every tenant that has its own. Whatever
 * reads trails back — `hushgate audit`, `hushgate doctor` — has to agree with
 * it about which files those are, or a tenant's chain is written every day and
 * never checked. This module is that agreement: a configured path resolves
 * against the working directory exactly as `serve` resolves it, and two
 * spellings of one file are one trail.
 */
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { HushgateConfig } from '../config.js';

/** One trail file the config names, and whose records go to it. */
export interface ConfiguredTrail {
  /** Absolute path, as first configured. */
  readonly path: string;
  /**
   * Whether this is the global trail: the one requests without a tenant, and
   * tenants without a file of their own, are recorded in.
   */
  readonly global: boolean;
  /** Tenants that named this file as their own trail, in config order. */
  readonly tenants: readonly string[];
}

/** What would stop a trail being written: the error, and where it was met. */
export interface TrailWriteProblem {
  /** The error code, e.g. `EACCES`, `EISDIR`, `ENOTDIR`. */
  readonly code: string;
  /** The file or directory it was met at. */
  readonly path: string;
}

/** Resolve a configured trail path against the working directory, as `serve` does. */
export function resolveTrailPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Every distinct trail the config names, the global one first.
 *
 * Files are compared the way `serve` compares them when it decides two
 * tenants share a sink — by real path and, once the file exists, by device and
 * inode — so the list is the set of files `serve` writes, and tenants that
 * share a file are listed together under it. Whether auditing is enabled is
 * the caller's question; this only says where the trails would be.
 */
export function configuredTrails(config: HushgateConfig, cwd: string): ConfiguredTrail[] {
  const trails: { path: string; global: boolean; tenants: string[]; keys: string[] }[] = [];

  const add = (configured: string, tenant: string | null): void => {
    const path = resolveTrailPath(cwd, configured);
    const keys = trailFileKeys(path);
    const known = trails.find((trail) => trail.keys.some((key) => keys.includes(key)));
    if (known === undefined) {
      trails.push({ path, global: tenant === null, tenants: tenant === null ? [] : [tenant], keys });
    } else if (tenant === null) {
      known.global = true;
    } else {
      known.tenants.push(tenant);
    }
  };

  add(config.audit.path, null);
  for (const tenant of config.tenants) {
    if (tenant.auditPath !== null) add(tenant.auditPath, tenant.id);
  }

  return trails.map(({ path, global, tenants }) => ({ path, global, tenants }));
}

/**
 * Every name one file goes by: its real path and, once it exists, its device
 * and inode. The real path catches `./a` against `a` and a symlinked directory;
 * the inode also catches a hard link, and `Audit.jsonl` against `audit.jsonl`
 * on a file system that ignores case.
 */
export function trailFileKeys(path: string): string[] {
  const keys = [`path:${realPath(path)}`];
  try {
    const { dev, ino } = statSync(path);
    keys.push(`inode:${dev}:${ino}`);
  } catch {
    // Not there yet: the path is all there is to go by.
  }
  return keys;
}

/**
 * Why `hushgate serve` could not open this trail, or `null` when nothing would stop it.
 *
 * Checked the way the writer will meet it. The writer creates any missing
 * directories and then opens the file to read its last record and append, so
 * an existing file has to be a file this process may read and write, and a
 * missing one needs the nearest directory that does exist to be one it may
 * create entries in. `access` answers for the user running the check, so the
 * answer holds for `serve` only when both run as the same user.
 */
export function trailWriteProblem(path: string): TrailWriteProblem | null {
  for (let at = path; ; at = dirname(at)) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(at).isDirectory();
    } catch (error) {
      const code = codeOf(error);
      // Not there yet: whatever is missing will be created, inside the
      // nearest directory that is there.
      if (code === 'ENOENT' && dirname(at) !== at) continue;
      return { code, path: at };
    }

    if (at === path && isDirectory) return { code: 'EISDIR', path: at };
    if (at !== path && !isDirectory) return { code: 'ENOTDIR', path: at };

    try {
      accessSync(at, at === path ? constants.R_OK | constants.W_OK : constants.W_OK | constants.X_OK);
      return null;
    } catch (error) {
      return { code: codeOf(error), path: at };
    }
  }
}

/** The real path, or the real directory plus the name for a file not yet created. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not there yet; its directory may be.
  }
  try {
    return join(realpathSync(dirname(path)), basename(path));
  } catch {
    return path;
  }
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'EUNKNOWN';
}
