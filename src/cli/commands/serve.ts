/** `hushgate serve` — run the proxy in the foreground. */
import { JsonlAuditLog, nullAuditLog } from '../../audit/log.js';
import { GENESIS_HASH } from '../../audit/record.js';
import { loadConfig, type ConfigOverrides, type HushgateConfig } from '../../config.js';
import { HushgateError } from '../../errors.js';
import { Metrics } from '../../metrics/registry.js';
import { createProxyServer, type ProxyServer } from '../../proxy/server.js';
import { ROUTES } from '../../proxy/routes.js';
import { VERSION } from '../../version.js';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as joinPath } from 'node:path';
import { boolFlag, intFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';
import { untilStopped } from '../stop.js';

/** One line about who may call this proxy. */
function describeTenants(config: HushgateConfig): string {
  if (config.tenants.length === 0) {
    return 'none — single tenant, no key required (loopback only)';
  }
  return config.tenants.map((tenant) => `${tenant.id} (${tenant.name})`).join(', ');
}

/** Resolve a configured path against the working directory. */
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : joinPath(cwd, path);
}

export const SERVE_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  host: { type: 'string', alias: 'H', description: 'address to bind (default 127.0.0.1)', placeholder: '<host>' },
  port: { type: 'number', alias: 'p', description: 'port to bind (default 8787)', placeholder: '<port>' },
  'upstream-openai': { type: 'string', description: 'base URL for /v1/chat/completions', placeholder: '<url>' },
  'upstream-anthropic': { type: 'string', description: 'base URL for /v1/messages', placeholder: '<url>' },
  audit: { type: 'string', description: 'path of the JSONL audit trail', placeholder: '<path>' },
  'no-audit': { type: 'boolean', description: 'do not write an audit trail' },
};

export const SERVE_SUMMARY = 'run the redacting proxy in the foreground';

export async function serve(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SERVE_FLAGS);

  const overrides: ConfigOverrides = {
    host: stringFlag(parsed, 'host'),
    port: intFlag(parsed, 'port', { min: 0, max: 65_535 }),
    upstreams: {
      openai: stringFlag(parsed, 'upstream-openai'),
      anthropic: stringFlag(parsed, 'upstream-anthropic'),
    },
    audit: auditOverride(parsed),
  };

  const { config, source } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
    overrides: pruneOverrides(overrides),
  });

  // Opened before the port is bound, and allowed to fail: a proxy that cannot
  // write its trail must not start forwarding personal data without one.
  const trails = config.audit.enabled ? await openTrails(cli.cwd, config) : null;

  const metrics = new Metrics();
  for (const trail of trails?.all ?? []) metrics.watchAuditTrail(labelOf(trail), trail.sink);

  const audit = trails?.global.sink ?? nullAuditLog;
  let proxy: ProxyServer | undefined;
  try {
    proxy = createProxyServer({
      config,
      metrics,
      audit,
      auditFor: (tenant) => (tenant === null ? audit : (trails?.byTenant.get(tenant.id)?.sink ?? audit)),
    });
    await proxy.listen();
  } catch (error) {
    // Nothing was served, so nothing was recorded: the trails only need
    // releasing before the error is reported.
    await proxy?.close({ graceMs: 0 });
    await closeTrails(trails?.all ?? []);
    throw error;
  }

  cli.stdout(
    banner(config, proxy.origin ?? `http://${config.host}:${config.port}`, source.path, trails),
  );

  await untilStopped(cli.signal);
  cli.stdout('\nhushgate: shutting down\n');
  // Resolves only once every request still in flight has handed its record to
  // a sink, so the trails can be closed straight afterwards without losing one.
  await proxy.close();
  await closeTrails(trails?.all ?? []);
  cli.stdout(describeHeads(trails));

  return EXIT.ok;
}

function auditOverride(parsed: ReturnType<typeof parseFlags>): { enabled?: boolean; path?: string } {
  const override: { enabled?: boolean; path?: string } = {};
  const path = stringFlag(parsed, 'audit');
  if (path !== undefined) override.path = path;
  if (boolFlag(parsed, 'no-audit')) override.enabled = false;
  return override;
}

/** Drop keys the user did not pass, so they do not overwrite file values. */
function pruneOverrides(overrides: ConfigOverrides): ConfigOverrides {
  const upstreams: Record<string, string> = {};
  if (overrides.upstreams?.openai !== undefined) upstreams['openai'] = overrides.upstreams.openai;
  if (overrides.upstreams?.anthropic !== undefined) {
    upstreams['anthropic'] = overrides.upstreams.anthropic;
  }

  const pruned: ConfigOverrides = {};
  if (overrides.host !== undefined) Object.assign(pruned, { host: overrides.host });
  if (overrides.port !== undefined) Object.assign(pruned, { port: overrides.port });
  if (Object.keys(upstreams).length > 0) Object.assign(pruned, { upstreams });
  if (overrides.audit !== undefined && Object.keys(overrides.audit).length > 0) {
    Object.assign(pruned, { audit: overrides.audit });
  }
  return pruned;
}

/* ----------------------------------------------------------------- trails */

/** One audit trail file, and whose records land in it. */
interface Trail {
  /** Absolute path, as first configured. */
  readonly path: string;
  readonly sink: JsonlAuditLog;
  /** Whether this is the trail every tenant without a file of its own uses. */
  readonly global: boolean;
  /** Tenants that named this file as their own trail. */
  readonly tenants: string[];
  /** The chain's head when the file was opened, before this process wrote. */
  readonly openedAt: string;
  /** Whether the file already held anything when it was opened. */
  readonly held: boolean;
}

interface Trails {
  readonly global: Trail;
  readonly byTenant: ReadonlyMap<string, Trail>;
  /** Every distinct file, the global trail first. */
  readonly all: readonly Trail[];
}

/**
 * Open every audit trail the config names, one sink per file.
 *
 * A sink keeps its chain's head in memory, so two sinks on one file would each
 * extend a chain of their own, and the file would break at the first switch
 * between them: a false tamper alarm, in the one file an auditor has to be able
 * to verify. Paths are therefore compared as files rather than as strings. A
 * tenant pointed at the global trail, or two tenants spelling one path
 * differently, share a sink and a chain — and each record still names its own
 * tenant, so nobody's requests are passed off as anybody else's.
 *
 * Should one trail fail to open, those opened before it are closed again and
 * the error goes to the caller.
 */
async function openTrails(cwd: string, config: HushgateConfig): Promise<Trails> {
  const all: Trail[] = [];
  const byFile = new Map<string, Trail>();

  const open = (configured: string, tenant: string | null): Trail => {
    const path = resolvePath(cwd, configured);
    const known = fileKeys(path)
      .map((key) => byFile.get(key))
      .find((trail) => trail !== undefined);
    if (known !== undefined) {
      if (tenant !== null) known.tenants.push(tenant);
      return known;
    }

    const trail = openTrail(path, tenant);
    all.push(trail);
    // Keyed again now that it is open: opening may have created the file, and
    // a file that exists can be recognised by its inode however it is spelled.
    for (const key of fileKeys(path)) byFile.set(key, trail);
    return trail;
  };

  try {
    const global = open(config.audit.path, null);
    const byTenant = new Map<string, Trail>();
    for (const tenant of config.tenants) {
      if (tenant.auditPath !== null) byTenant.set(tenant.id, open(tenant.auditPath, tenant.id));
    }
    return { global, byTenant, all };
  } catch (error) {
    await closeTrails(all);
    throw error;
  }
}

/** Open one trail, noting what it held beforehand. */
function openTrail(path: string, tenant: string | null): Trail {
  // Looked at first, because opening may create the file.
  const held = sizeOf(path) > 0;

  let sink: JsonlAuditLog;
  try {
    sink = new JsonlAuditLog({ path });
  } catch (cause) {
    throw new HushgateError(`cannot open the audit trail ${path}: ${(cause as Error).message}`, {
      cause,
    });
  }

  return {
    path,
    sink,
    global: tenant === null,
    tenants: tenant === null ? [] : [tenant],
    openedAt: sink.headHash,
    held,
  };
}

function closeTrails(trails: readonly Trail[]): Promise<void> {
  return Promise.all(trails.map((trail) => trail.sink.close())).then(() => undefined);
}

/**
 * Every name one file goes by: its real path and, once it exists, its device
 * and inode. The real path catches `./a` against `a` and a symlinked directory;
 * the inode also catches a hard link, and `Audit.jsonl` against `audit.jsonl`
 * on a file system that ignores case.
 */
function fileKeys(path: string): string[] {
  const keys = [`path:${realPath(path)}`];
  try {
    const { dev, ino } = statSync(path);
    keys.push(`inode:${dev}:${ino}`);
  } catch {
    // Not there yet: the path is all there is to go by.
  }
  return keys;
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

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The trail's label, in /metrics and in the banner: `global` for the trail
 * every tenant without a file of its own writes to, otherwise the ids of the
 * tenants that share the file. Both come from the config file, so the label
 * cannot grow with traffic.
 */
function labelOf(trail: Trail): string {
  return trail.global ? 'global' : trail.tenants.toSorted().join(',');
}

/**
 * Where the chain stood when the trail was opened.
 *
 * Twelve hex digits are enough to tell one chain from another at a glance;
 * the full head is printed at shutdown, where it is worth anchoring.
 */
function describeStart(trail: Trail): string {
  if (trail.openedAt !== GENESIS_HASH) return `continuing chain from ${trail.openedAt.slice(0, 12)}`;
  // Something is there, but no last record could be read from it. The chain
  // starts again, and `audit verify` is what shows where.
  if (trail.held) return 'last record unreadable, starting a new chain (see hushgate audit verify)';
  return 'starting a new trail';
}

/** One line per trail: where it is, and where its chain stood when opened. */
function describeTrails(trails: Trails | null, labelled: boolean): string[] {
  if (trails === null) return ['  audit      disabled'];
  return trails.all.map((trail, index) => {
    const lead = index === 0 ? '  audit      ' : '             ';
    const label = labelled ? ` (${labelOf(trail)})` : '';
    return `${lead}${trail.path}${label} — ${describeStart(trail)}`;
  });
}

/**
 * The head of every trail, in full, once the sinks are closed.
 *
 * Records dropped from the end of a trail can only be noticed against a head
 * kept somewhere hushgate cannot rewrite. Printing it on the way out puts it in
 * the service log — journald, the container log — at no cost to anybody.
 */
function describeHeads(trails: Trails | null): string {
  if (trails === null) return '';
  const lines = trails.all.map((trail, index) => {
    const lead = index === 0 ? '  audit      ' : '             ';
    const dropped = trail.sink.droppedRecords;
    const note =
      dropped === 0 ? '' : ` (${dropped} ${dropped === 1 ? 'record' : 'records'} could not be written)`;
    return `${lead}${trail.path} head ${trail.sink.headHash}${note}`;
  });
  return `${lines.join('\n')}\n`;
}

function banner(
  config: HushgateConfig,
  origin: string,
  configPath: string | null,
  trails: Trails | null,
): string {
  const policies = Object.entries(config.redaction.policies);
  const overrides =
    policies.length === 0
      ? 'none'
      : policies.map(([kind, policy]) => `${kind}=${policy}`).join(' ');

  const lines = [
    `hushgate ${VERSION} listening on ${origin}`,
    `  config     ${configPath ?? 'built-in defaults (no hushgate.config.json found)'}`,
    `  upstreams  openai     ${config.upstreams.openai}`,
    `             anthropic  ${config.upstreams.anthropic}`,
    `  policy     ${config.redaction.defaultPolicy} by default; overrides: ${overrides}`,
    ...describeTrails(trails, config.tenants.length > 0),
    `  tenants    ${describeTenants(config)}`,
    `  routes     ${ROUTES.map((route) => `POST ${route.path}`).join(', ')}, GET /healthz, GET /metrics`,
    `             ${config.tenants.length === 0 ? '/metrics is open on loopback' : '/metrics needs a tenant key, like the proxy routes'}`,
    '',
    '  Point your SDK at this address:',
    `    OPENAI_BASE_URL=${origin}/v1`,
    `    ANTHROPIC_BASE_URL=${origin}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}
