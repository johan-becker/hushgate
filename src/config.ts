/**
 * Configuration: defaults, `hushgate.config.json`, environment, explicit
 * overrides — resolved in that order, validated strictly.
 *
 * Strictly, because this file decides what leaves the building. A typo in a
 * policy name must not silently degrade to "send everything"; it must stop the
 * process. Every rejection names the exact key and what was expected.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { CustomRule } from './detectors/custom.js';
import type { DictionaryInput } from './detectors/dictionary.js';
import type { DobYearRange } from './detectors/dob.js';
import { ConfigError } from './errors.js';
import type { SessionOptions } from './redact/session.js';
import { isPolicy, type Policy } from './types.js';

/** File name looked up in the working directory when no path is given. */
export const CONFIG_FILENAME = 'hushgate.config.json';

/** Where a resolved configuration came from. */
export interface ConfigSource {
  /** Absolute path of the config file that was read, or `null` when none was. */
  readonly path: string | null;
  /** True when a file was explicitly requested (and therefore must exist). */
  readonly required: boolean;
}

export interface UpstreamConfig {
  /** Base URL for the OpenAI-compatible route. */
  readonly openai: string;
  /** Base URL for the Anthropic-compatible route. */
  readonly anthropic: string;
}

export interface LimitsConfig {
  /** Largest request body hushgate will read, in bytes. */
  readonly maxBodyBytes: number;
  /** How long an upstream request may take before it is aborted. */
  readonly upstreamTimeoutMs: number;
}

export interface RedactionConfig {
  readonly defaultPolicy: Policy;
  readonly policies: Readonly<Record<string, Policy>>;
  readonly dictionary: DictionaryInput;
  readonly custom: readonly CustomRule[];
  readonly dobYearRange: DobYearRange | null;
  /** Key for the `hash` policy. Prefer the environment over the file. */
  readonly hmacKey: string | null;
}

export interface AuditConfig {
  /** Whether to write an audit trail at all. */
  readonly enabled: boolean;
  /** Where the JSONL trail is appended. */
  readonly path: string;
}

export interface HushgateConfig {
  readonly host: string;
  readonly port: number;
  readonly upstreams: UpstreamConfig;
  readonly redaction: RedactionConfig;
  readonly limits: LimitsConfig;
  readonly audit: AuditConfig;
}

export interface LoadedConfig {
  readonly config: HushgateConfig;
  readonly source: ConfigSource;
}

/** Deep-partial overlay used by the CLI for command-line flags. */
export interface ConfigOverrides {
  readonly host?: string;
  readonly port?: number;
  readonly upstreams?: Partial<UpstreamConfig>;
  readonly limits?: Partial<LimitsConfig>;
  readonly redaction?: Partial<RedactionConfig>;
  readonly audit?: Partial<AuditConfig>;
}

const KNOWN_KEYS = new Set(['host', 'port', 'upstreams', 'redaction', 'limits', 'audit']);

/** Default audit trail, relative to the working directory. */
export const DEFAULT_AUDIT_PATH = 'hushgate-audit.jsonl';

/**
 * Bind to loopback by default: hushgate holds the mapping from placeholders back
 * to real personal data, so an accidental 0.0.0.0 is a data-protection incident,
 * not a convenience.
 */
export function defaultConfig(): HushgateConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    upstreams: {
      openai: 'https://api.openai.com',
      anthropic: 'https://api.anthropic.com',
    },
    redaction: {
      defaultPolicy: 'pseudonymize',
      policies: {},
      dictionary: {},
      custom: [],
      dobYearRange: null,
      hmacKey: null,
    },
    limits: {
      maxBodyBytes: 4 * 1024 * 1024,
      upstreamTimeoutMs: 120_000,
    },
    // On by default: a privacy control nobody can evidence is a claim, not a
    // control. The trail holds categories and counts only, never values.
    audit: {
      enabled: true,
      path: DEFAULT_AUDIT_PATH,
    },
  };
}

/**
 * Validate a parsed `hushgate.config.json` and overlay it on the defaults.
 *
 * `where` is used verbatim in error messages, so pass the file path.
 */
export function parseConfig(raw: unknown, where = CONFIG_FILENAME): HushgateConfig {
  const base = defaultConfig();
  const root = asObject(raw, where);
  rejectUnknownKeys(root, KNOWN_KEYS, where);

  const upstreams = asObject(root['upstreams'] ?? {}, `${where}: "upstreams"`);
  rejectUnknownKeys(upstreams, new Set(['openai', 'anthropic']), `${where}: "upstreams"`);

  const limits = asObject(root['limits'] ?? {}, `${where}: "limits"`);
  rejectUnknownKeys(limits, new Set(['maxBodyBytes', 'upstreamTimeoutMs']), `${where}: "limits"`);

  const audit = asObject(root['audit'] ?? {}, `${where}: "audit"`);
  rejectUnknownKeys(audit, new Set(['enabled', 'path']), `${where}: "audit"`);

  return {
    host: optionalString(root['host'], `${where}: "host"`) ?? base.host,
    port: optionalPort(root['port'], `${where}: "port"`) ?? base.port,
    upstreams: {
      openai:
        optionalUrl(upstreams['openai'], `${where}: "upstreams.openai"`) ?? base.upstreams.openai,
      anthropic:
        optionalUrl(upstreams['anthropic'], `${where}: "upstreams.anthropic"`) ??
        base.upstreams.anthropic,
    },
    redaction: parseRedaction(root['redaction'], where, base.redaction),
    limits: {
      maxBodyBytes:
        optionalPositiveInt(limits['maxBodyBytes'], `${where}: "limits.maxBodyBytes"`) ??
        base.limits.maxBodyBytes,
      upstreamTimeoutMs:
        optionalPositiveInt(limits['upstreamTimeoutMs'], `${where}: "limits.upstreamTimeoutMs"`) ??
        base.limits.upstreamTimeoutMs,
    },
    audit: {
      enabled: optionalBoolean(audit['enabled'], `${where}: "audit.enabled"`) ?? base.audit.enabled,
      path: optionalString(audit['path'], `${where}: "audit.path"`) ?? base.audit.path,
    },
  };
}

function parseRedaction(raw: unknown, where: string, base: RedactionConfig): RedactionConfig {
  const scope = `${where}: "redaction"`;
  const node = asObject(raw ?? {}, scope);
  rejectUnknownKeys(
    node,
    new Set(['defaultPolicy', 'policies', 'dictionary', 'custom', 'dobYearRange', 'hmacKey']),
    scope,
  );

  return {
    defaultPolicy: optionalPolicy(node['defaultPolicy'], `${scope}.defaultPolicy`) ??
      base.defaultPolicy,
    policies: parsePolicies(node['policies'], `${scope}.policies`),
    dictionary: parseDictionary(node['dictionary'], `${scope}.dictionary`),
    custom: parseCustomRules(node['custom'], `${scope}.custom`),
    dobYearRange: parseDobYearRange(node['dobYearRange'], `${scope}.dobYearRange`),
    hmacKey: optionalString(node['hmacKey'], `${scope}.hmacKey`) ?? base.hmacKey,
  };
}

function parsePolicies(raw: unknown, where: string): Record<string, Policy> {
  if (raw === undefined || raw === null) return {};
  const node = asObject(raw, where);
  const out: Record<string, Policy> = {};

  for (const [kind, policy] of Object.entries(node)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(kind)) {
      throw new ConfigError(`${where}: "${kind}" is not a valid kind; kinds are UPPER_SNAKE_CASE`);
    }
    if (!isPolicy(policy)) {
      throw new ConfigError(
        `${where}.${kind}: "${String(policy)}" is not a policy; use pseudonymize, redact, hash, allow or block`,
      );
    }
    out[kind] = policy;
  }

  return out;
}

function parseDictionary(raw: unknown, where: string): DictionaryInput {
  if (raw === undefined || raw === null) return {};
  const node = asObject(raw, where);
  rejectUnknownKeys(node, new Set(['names', 'terms', 'entries']), where);

  const entries = node['entries'];
  return {
    names: optionalStringArray(node['names'], `${where}.names`) ?? [],
    terms: optionalStringArray(node['terms'], `${where}.terms`) ?? [],
    entries:
      entries === undefined
        ? []
        : asArray(entries, `${where}.entries`).map((entry, index) => {
            const scope = `${where}.entries[${index}]`;
            const record = asObject(entry, scope);
            rejectUnknownKeys(record, new Set(['value', 'kind']), scope);
            return {
              value: requiredString(record['value'], `${scope}.value`),
              kind: optionalString(record['kind'], `${scope}.kind`) ?? 'NAME',
            };
          }),
  };
}

function parseCustomRules(raw: unknown, where: string): CustomRule[] {
  if (raw === undefined || raw === null) return [];

  return asArray(raw, where).map((entry, index) => {
    const scope = `${where}[${index}]`;
    const record = asObject(entry, scope);
    rejectUnknownKeys(record, new Set(['name', 'pattern', 'flags', 'priority']), scope);

    const rule: {
      name: string;
      pattern: string;
      flags?: string;
      priority?: number;
    } = {
      name: requiredString(record['name'], `${scope}.name`),
      pattern: requiredString(record['pattern'], `${scope}.pattern`),
    };

    if (record['flags'] !== undefined) {
      rule.flags = requiredString(record['flags'], `${scope}.flags`);
    }
    if (record['priority'] !== undefined) {
      rule.priority = optionalPositiveInt(record['priority'], `${scope}.priority`);
    }

    return rule satisfies CustomRule;
  });
}

function parseDobYearRange(raw: unknown, where: string): DobYearRange | null {
  if (raw === undefined || raw === null) return null;
  const node = asObject(raw, where);
  rejectUnknownKeys(node, new Set(['minYear', 'maxYear']), where);

  const minYear = optionalPositiveInt(node['minYear'], `${where}.minYear`) ?? 1900;
  const maxYear =
    optionalPositiveInt(node['maxYear'], `${where}.maxYear`) ?? new Date().getUTCFullYear();

  if (minYear > maxYear) {
    throw new ConfigError(`${where}: minYear ${minYear} is after maxYear ${maxYear}`);
  }
  return { minYear, maxYear };
}

/**
 * Overlay environment variables. Every knob a container needs is settable
 * without a config file, which is what a Kubernetes deployment wants.
 */
export function applyEnv(
  config: HushgateConfig,
  env: NodeJS.ProcessEnv = process.env,
): HushgateConfig {
  const host = env['HUSHGATE_HOST'];
  const port = env['HUSHGATE_PORT'];
  const openai = env['HUSHGATE_UPSTREAM_OPENAI'];
  const anthropic = env['HUSHGATE_UPSTREAM_ANTHROPIC'];
  const defaultPolicy = env['HUSHGATE_DEFAULT_POLICY'];
  const hmacKey = env['HUSHGATE_HMAC_KEY'];
  const maxBodyBytes = env['HUSHGATE_MAX_BODY_BYTES'];
  const upstreamTimeoutMs = env['HUSHGATE_UPSTREAM_TIMEOUT_MS'];
  const auditPath = env['HUSHGATE_AUDIT_PATH'];
  const auditEnabled = env['HUSHGATE_AUDIT'];

  return {
    ...config,
    host: host ?? config.host,
    port: port === undefined ? config.port : envPort(port, 'HUSHGATE_PORT'),
    upstreams: {
      openai:
        openai === undefined
          ? config.upstreams.openai
          : envUrl(openai, 'HUSHGATE_UPSTREAM_OPENAI'),
      anthropic:
        anthropic === undefined
          ? config.upstreams.anthropic
          : envUrl(anthropic, 'HUSHGATE_UPSTREAM_ANTHROPIC'),
    },
    redaction: {
      ...config.redaction,
      defaultPolicy:
        defaultPolicy === undefined
          ? config.redaction.defaultPolicy
          : envPolicy(defaultPolicy, 'HUSHGATE_DEFAULT_POLICY'),
      hmacKey: hmacKey ?? config.redaction.hmacKey,
    },
    limits: {
      maxBodyBytes:
        maxBodyBytes === undefined
          ? config.limits.maxBodyBytes
          : envPositiveInt(maxBodyBytes, 'HUSHGATE_MAX_BODY_BYTES'),
      upstreamTimeoutMs:
        upstreamTimeoutMs === undefined
          ? config.limits.upstreamTimeoutMs
          : envPositiveInt(upstreamTimeoutMs, 'HUSHGATE_UPSTREAM_TIMEOUT_MS'),
    },
    audit: {
      enabled:
        auditEnabled === undefined
          ? config.audit.enabled
          : envBoolean(auditEnabled, 'HUSHGATE_AUDIT'),
      path: auditPath ?? config.audit.path,
    },
  };
}

/** Apply explicit overrides — command-line flags, or a caller's own values. */
export function applyOverrides(
  config: HushgateConfig,
  overrides: ConfigOverrides = {},
): HushgateConfig {
  return {
    ...config,
    host: overrides.host ?? config.host,
    port: overrides.port ?? config.port,
    upstreams: { ...config.upstreams, ...overrides.upstreams },
    redaction: { ...config.redaction, ...overrides.redaction },
    limits: { ...config.limits, ...overrides.limits },
    audit: { ...config.audit, ...overrides.audit },
  };
}

export interface LoadConfigOptions {
  /** Explicit path. When set, a missing file is an error. */
  readonly path?: string | undefined;
  /** Directory to look for {@link CONFIG_FILENAME} in. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly overrides?: ConfigOverrides;
}

/**
 * Resolve the effective configuration: defaults, then the config file, then the
 * environment, then explicit overrides.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.path;
  const path =
    explicit === undefined
      ? resolvePath(cwd, CONFIG_FILENAME)
      : isAbsolute(explicit)
        ? explicit
        : resolvePath(cwd, explicit);

  let text: string | null = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (explicit !== undefined || code !== 'ENOENT') {
      throw new ConfigError(`cannot read config file ${path}: ${(cause as Error).message}`, {
        cause,
      });
    }
  }

  let fileConfig = defaultConfig();
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new ConfigError(`${path} is not valid JSON: ${(cause as Error).message}`, { cause });
    }
    fileConfig = parseConfig(parsed, path);
  }

  const config = applyOverrides(applyEnv(fileConfig, options.env ?? process.env), options.overrides);

  return {
    config,
    source: { path: text === null ? null : path, required: explicit !== undefined },
  };
}

/* ------------------------------------------------------------------ helpers */

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(`${where} must be an array, got ${describe(value)}`);
  }
  return value;
}

function rejectUnknownKeys(
  node: Record<string, unknown>,
  known: ReadonlySet<string>,
  where: string,
): void {
  const unknown = Object.keys(node).filter((key) => !known.has(key));
  if (unknown.length === 0) return;
  throw new ConfigError(
    `${where}: unknown key${unknown.length > 1 ? 's' : ''} ${unknown
      .map((key) => `"${key}"`)
      .join(', ')}; known keys are ${[...known].map((key) => `"${key}"`).join(', ')}`,
  );
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, where);
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${where} must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function optionalStringArray(value: unknown, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return asArray(value, where).map((item, index) => requiredString(item, `${where}[${index}]`));
}

function optionalPositiveInt(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${where} must be a positive integer, got ${describe(value)}`);
  }
  return value;
}

/** Port 0 is allowed on purpose: it binds an ephemeral port, which is what the
 * test suite and supervised sidecars want. The chosen port is printed at start. */
function optionalPort(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new ConfigError(`${where} must be an integer between 0 and 65535, got ${describe(value)}`);
  }
  return value;
}

function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where} must be true or false, got ${describe(value)}`);
  }
  return value;
}

function optionalPolicy(value: unknown, where: string): Policy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPolicy(value)) {
    throw new ConfigError(
      `${where}: "${String(value)}" is not a policy; use pseudonymize, redact, hash, allow or block`,
    );
  }
  return value;
}

function optionalUrl(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normaliseUrl(requiredString(value, where), where);
}

/** Absolute http(s) URL, trailing slash removed so path joining stays simple. */
export function normaliseUrl(value: string, where: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${where} must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${where} must use http or https, got "${value}"`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${where} must not carry a query string or fragment, got "${value}"`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, '');
}

function envPort(value: string, name: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`${name} must be an integer between 0 and 65535, got "${value}"`);
  }
  return port;
}

function envPositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function envPolicy(value: string, name: string): Policy {
  if (!isPolicy(value)) {
    throw new ConfigError(
      `${name}: "${value}" is not a policy; use pseudonymize, redact, hash, allow or block`,
    );
  }
  return value;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function envBoolean(value: string, name: string): boolean {
  const normalised = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalised)) return true;
  if (FALSE_VALUES.has(normalised)) return false;
  throw new ConfigError(`${name} must be one of true/false/1/0/yes/no/on/off, got "${value}"`);
}

function envUrl(value: string, name: string): string {
  return normaliseUrl(value, name);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Project the redaction section onto the options a {@link Session} takes.
 *
 * One place turns configuration into behaviour, so the proxy, the CLI and the
 * tests cannot drift apart on what a config file means.
 */
export function redactionOptions(config: HushgateConfig): SessionOptions {
  const { defaultPolicy, policies, dictionary, custom, dobYearRange, hmacKey } = config.redaction;
  return {
    defaultPolicy,
    policies,
    dictionary,
    custom,
    dobYearRange: dobYearRange ?? undefined,
    hmacKey: hmacKey ?? undefined,
  };
}
