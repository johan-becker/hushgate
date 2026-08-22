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
import {
  defaultResidencyConfig,
  isEnforcementMode,
  type AllowEntry,
  type EnforcementMode,
  type ResidencyConfig,
} from './residency/policy.js';
import type { DataControl, EndpointEntry } from './residency/registry.js';
import { hashKey, type Tenant, type TenantQuotas } from './tenants/tenant.js';
import { isPolicy, type Policy } from './types.js';

/**
 * Remove `//` and block comments from JSON text.
 *
 * `hushgate init` writes a commented config, because the config file is where a
 * team records *why* an upstream is permitted, and a format that cannot hold an
 * explanation invites the explanation to be dropped. Newlines are preserved so
 * a parse error still points at the right line.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      } else if (char === '\n') {
        out += char;
      }
      continue;
    }

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    out += char;
  }

  return out;
}

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
  /**
   * Largest upstream response hushgate will buffer, in bytes.
   *
   * The request side has had a limit from the start; this is its counterpart.
   * A response is parsed, cloned and re-serialised, so several times its own
   * size is resident at once, and a compromised, misbehaving or simply
   * very chatty provider must not be able to push the process past its
   * memory limit and take every tenant down with it.
   */
  readonly maxResponseBytes: number;
  /** How long an upstream request may take before it is aborted. */
  readonly upstreamTimeoutMs: number;
  /** How long a client may take to deliver its request. */
  readonly requestTimeoutMs: number;
  /** How many times to retry an upstream that never answered. */
  readonly upstreamRetries: number;
  /** Base delay for the retry backoff, doubled each attempt. */
  readonly retryBackoffMs: number;
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

/**
 * Who is doing the processing.
 *
 * Only used to head the Article 30 report. Nothing here changes behaviour, and
 * anything left out is printed as "not recorded" rather than invented.
 */
export interface OrganisationConfig {
  readonly name: string | null;
  readonly contact: string | null;
  readonly dpo: string | null;
  /** Purposes of processing, in the operator's own words. */
  readonly purposes: readonly string[];
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
  readonly residency: ResidencyConfig;
  /** Tenants, or an empty list for single-tenant operation. */
  readonly tenants: readonly Tenant[];
  readonly organisation: OrganisationConfig;
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
  readonly residency?: Partial<ResidencyConfig>;
  readonly tenants?: readonly Tenant[];
  readonly organisation?: Partial<OrganisationConfig>;
}

// `$schema` is accepted and ignored so editors can be pointed at a schema
// without the file being rejected for it.
const KNOWN_KEYS = new Set([
  '$schema',
  'host',
  'port',
  'upstreams',
  'redaction',
  'limits',
  'audit',
  'residency',
  'tenants',
  'organisation',
]);

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
      maxResponseBytes: 16 * 1024 * 1024,
      upstreamTimeoutMs: 120_000,
      requestTimeoutMs: 60_000,
      upstreamRetries: 2,
      retryBackoffMs: 250,
    },
    // On by default: a privacy control nobody can evidence is a claim, not a
    // control. The trail holds categories and counts only, never values.
    audit: {
      enabled: true,
      path: DEFAULT_AUDIT_PATH,
    },
    residency: defaultResidencyConfig(),
    tenants: [],
    organisation: { name: null, contact: null, dpo: null, purposes: [] },
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
  rejectUnknownKeys(
    limits,
    new Set([
      'maxBodyBytes',
      'maxResponseBytes',
      'upstreamTimeoutMs',
      'requestTimeoutMs',
      'upstreamRetries',
      'retryBackoffMs',
    ]),
    `${where}: "limits"`,
  );

  const audit = asObject(root['audit'] ?? {}, `${where}: "audit"`);
  rejectUnknownKeys(audit, new Set(['enabled', 'path']), `${where}: "audit"`);

  const redaction = parseRedaction(root['redaction'], where, base.redaction);

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
    redaction,
    limits: {
      maxBodyBytes:
        optionalPositiveInt(limits['maxBodyBytes'], `${where}: "limits.maxBodyBytes"`) ??
        base.limits.maxBodyBytes,
      maxResponseBytes:
        optionalPositiveInt(limits['maxResponseBytes'], `${where}: "limits.maxResponseBytes"`) ??
        base.limits.maxResponseBytes,
      upstreamTimeoutMs:
        optionalPositiveInt(limits['upstreamTimeoutMs'], `${where}: "limits.upstreamTimeoutMs"`) ??
        base.limits.upstreamTimeoutMs,
      requestTimeoutMs:
        optionalPositiveInt(limits['requestTimeoutMs'], `${where}: "limits.requestTimeoutMs"`) ??
        base.limits.requestTimeoutMs,
      upstreamRetries:
        optionalCount(limits['upstreamRetries'], `${where}: "limits.upstreamRetries"`) ??
        base.limits.upstreamRetries,
      retryBackoffMs:
        optionalPositiveInt(limits['retryBackoffMs'], `${where}: "limits.retryBackoffMs"`) ??
        base.limits.retryBackoffMs,
    },
    audit: {
      enabled: optionalBoolean(audit['enabled'], `${where}: "audit.enabled"`) ?? base.audit.enabled,
      path: optionalString(audit['path'], `${where}: "audit.path"`) ?? base.audit.path,
    },
    residency: parseResidency(root['residency'], where, base.residency),
    tenants: parseTenants(root['tenants'], `${where}: "tenants"`, redaction),
    organisation: parseOrganisation(root['organisation'], `${where}: "organisation"`),
  };
}

function parseOrganisation(raw: unknown, where: string): OrganisationConfig {
  if (raw === undefined || raw === null) {
    return { name: null, contact: null, dpo: null, purposes: [] };
  }

  const node = asObject(raw, where);
  rejectUnknownKeys(node, new Set(['name', 'contact', 'dpo', 'purposes']), where);

  return {
    name: optionalString(node['name'], `${where}.name`) ?? null,
    contact: optionalString(node['contact'], `${where}.contact`) ?? null,
    dpo: optionalString(node['dpo'], `${where}.dpo`) ?? null,
    purposes: optionalStringArray(node['purposes'], `${where}.purposes`) ?? [],
  };
}

function parseTenants(
  raw: unknown,
  where: string,
  globalRedaction: RedactionConfig,
): Tenant[] {
  if (raw === undefined || raw === null) return [];

  const tenants = asArray(raw, where).map((item, index) => {
    const scope = `${where}[${index}]`;
    const node = asObject(item, scope);
    rejectUnknownKeys(
      node,
      new Set([
        'id',
        'name',
        'keyHash',
        'keyHashes',
        'keyEnv',
        'upstreamKeyEnv',
        'quotas',
        'audit',
        'redaction',
      ]),
      scope,
    );

    const id = requiredString(node['id'], `${scope}.id`);
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) {
      throw new ConfigError(
        `${scope}.id must be a short identifier of letters, digits, dots, dashes or underscores, got "${id}"`,
      );
    }

    const audit = asObject(node['audit'] ?? {}, `${scope}.audit`);
    rejectUnknownKeys(audit, new Set(['path']), `${scope}.audit`);

    return {
      id,
      name: optionalString(node['name'], `${scope}.name`) ?? id,
      keyHashes: parseKeyHashes(node, scope),
      redaction: parseRedaction(node['redaction'], scope, globalRedaction),
      quotas: parseQuotas(node['quotas'], `${scope}.quotas`),
      auditPath: optionalString(audit['path'], `${scope}.audit.path`) ?? null,
      upstreamKeyEnv: optionalString(node['upstreamKeyEnv'], `${scope}.upstreamKeyEnv`) ?? null,
    } satisfies Tenant;
  });

  const ids = new Set(tenants.map((tenant) => tenant.id));
  if (ids.size !== tenants.length) {
    throw new ConfigError(`${where}: tenant ids must be unique`);
  }

  return tenants;
}

/**
 * Accept a hash, a list of hashes (for rotation), or the name of an environment
 * variable holding the key itself — which is how a container gets one without a
 * secret ever touching the config file.
 */
function parseKeyHashes(node: Record<string, unknown>, scope: string): string[] {
  const hashes: string[] = [];

  const single = optionalString(node['keyHash'], `${scope}.keyHash`);
  if (single !== undefined) hashes.push(normaliseHash(single, `${scope}.keyHash`));

  for (const [index, value] of (
    optionalStringArray(node['keyHashes'], `${scope}.keyHashes`) ?? []
  ).entries()) {
    hashes.push(normaliseHash(value, `${scope}.keyHashes[${index}]`));
  }

  const keyEnv = optionalString(node['keyEnv'], `${scope}.keyEnv`);
  if (keyEnv !== undefined) {
    const key = process.env[keyEnv];
    if (key === undefined || key.length === 0) {
      throw new ConfigError(
        `${scope}.keyEnv names ${keyEnv}, which is not set; export it or use keyHash instead`,
      );
    }
    hashes.push(hashKey(key));
  }

  if (hashes.length === 0) {
    throw new ConfigError(
      `${scope} needs keyHash, keyHashes or keyEnv; run "hushgate keys new ${String(node['id'])}" to mint one`,
    );
  }

  return hashes;
}

function normaliseHash(value: string, where: string): string {
  const hash = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  if (!/^[0-9a-f]{64}$/iu.test(hash)) {
    throw new ConfigError(`${where} must be a SHA-256 hex digest, optionally prefixed with sha256:`);
  }
  return hash.toLowerCase();
}

function parseQuotas(raw: unknown, where: string): TenantQuotas {
  if (raw === undefined || raw === null) {
    return { requestsPerMinute: null, tokensPerDay: null };
  }

  const node = asObject(raw, where);
  rejectUnknownKeys(node, new Set(['requestsPerMinute', 'tokensPerDay']), where);

  return {
    requestsPerMinute:
      optionalPositiveInt(node['requestsPerMinute'], `${where}.requestsPerMinute`) ?? null,
    tokensPerDay: optionalPositiveInt(node['tokensPerDay'], `${where}.tokensPerDay`) ?? null,
  };
}

function parseResidency(raw: unknown, where: string, base: ResidencyConfig): ResidencyConfig {
  const scope = `${where}: "residency"`;
  const node = asObject(raw ?? {}, scope);
  rejectUnknownKeys(
    node,
    new Set(['mode', 'routes', 'categories', 'allow', 'requireDataControls', 'endpoints']),
    scope,
  );

  return {
    mode: optionalMode(node['mode'], `${scope}.mode`) ?? base.mode,
    routes: parseModeMap(node['routes'], `${scope}.routes`),
    categories: parseModeMap(node['categories'], `${scope}.categories`),
    allow: parseAllowList(node['allow'], `${scope}.allow`),
    requireDataControls:
      optionalBoolean(node['requireDataControls'], `${scope}.requireDataControls`) ??
      base.requireDataControls,
    endpoints: parseEndpoints(node['endpoints'], `${scope}.endpoints`),
  };
}

function parseModeMap(raw: unknown, where: string): Record<string, EnforcementMode> {
  if (raw === undefined || raw === null) return {};
  const node = asObject(raw, where);
  const out: Record<string, EnforcementMode> = {};

  for (const [key, value] of Object.entries(node)) {
    const mode = optionalMode(value, `${where}.${key}`);
    if (mode !== undefined) out[key] = mode;
  }

  return out;
}

function parseAllowList(raw: unknown, where: string): AllowEntry[] {
  if (raw === undefined || raw === null) return [];

  return asArray(raw, where).map((item, index) => {
    const scope = `${where}[${index}]`;
    const node = asObject(item, scope);
    rejectUnknownKeys(node, new Set(['endpoint', 'jurisdiction', 'legalBasis', 'note']), scope);

    return {
      endpoint: normaliseUrl(requiredString(node['endpoint'], `${scope}.endpoint`), `${scope}.endpoint`),
      jurisdiction: optionalString(node['jurisdiction'], `${scope}.jurisdiction`) ?? null,
      // Required on purpose: an allowlist without reasons is a wish list, and
      // the reason is what the operator will be asked for.
      legalBasis: requiredString(node['legalBasis'], `${scope}.legalBasis`),
      note: optionalString(node['note'], `${scope}.note`) ?? null,
    };
  });
}

function parseEndpoints(raw: unknown, where: string): EndpointEntry[] {
  if (raw === undefined || raw === null) return [];

  return asArray(raw, where).map((item, index) => {
    const scope = `${where}[${index}]`;
    const node = asObject(item, scope);
    rejectUnknownKeys(
      node,
      new Set(['id', 'label', 'operator', 'hosts', 'jurisdiction', 'dataControls', 'note']),
      scope,
    );

    const hosts = optionalStringArray(node['hosts'], `${scope}.hosts`) ?? [];
    if (hosts.length === 0) {
      throw new ConfigError(`${scope}.hosts must list at least one host`);
    }

    return {
      id: requiredString(node['id'], `${scope}.id`),
      label: optionalString(node['label'], `${scope}.label`) ?? requiredString(node['id'], `${scope}.id`),
      operator: optionalString(node['operator'], `${scope}.operator`) ?? 'undeclared',
      hosts,
      jurisdiction: requiredString(node['jurisdiction'], `${scope}.jurisdiction`).toUpperCase(),
      dataControls: parseDataControls(node['dataControls'], `${scope}.dataControls`),
      note: optionalString(node['note'], `${scope}.note`) ?? '',
    };
  });
}

function parseDataControls(raw: unknown, where: string): DataControl[] {
  if (raw === undefined || raw === null) return [];

  return asArray(raw, where).map((item, index) => {
    const scope = `${where}[${index}]`;
    const node = asObject(item, scope);
    rejectUnknownKeys(node, new Set(['kind', 'mechanism', 'header', 'body', 'note']), scope);

    const kind = requiredString(node['kind'], `${scope}.kind`);
    if (kind !== 'zero-retention' && kind !== 'no-training') {
      throw new ConfigError(`${scope}.kind must be "zero-retention" or "no-training", got "${kind}"`);
    }

    const mechanism = requiredString(node['mechanism'], `${scope}.mechanism`);
    const known = new Set(['header', 'body', 'account', 'contract', 'inherent']);
    if (!known.has(mechanism)) {
      throw new ConfigError(
        `${scope}.mechanism must be one of ${[...known].join(', ')}, got "${mechanism}"`,
      );
    }

    const control: {
      kind: 'zero-retention' | 'no-training';
      mechanism: DataControl['mechanism'];
      header?: { name: string; value: string };
      body?: { path: string; value: boolean | string | number };
      note: string;
    } = {
      kind,
      mechanism: mechanism as DataControl['mechanism'],
      note: optionalString(node['note'], `${scope}.note`) ?? '',
    };

    if (node['header'] !== undefined) {
      const header = asObject(node['header'], `${scope}.header`);
      rejectUnknownKeys(header, new Set(['name', 'value']), `${scope}.header`);
      control.header = {
        name: requiredString(header['name'], `${scope}.header.name`),
        value: requiredString(header['value'], `${scope}.header.value`),
      };
    }

    if (node['body'] !== undefined) {
      const body = asObject(node['body'], `${scope}.body`);
      rejectUnknownKeys(body, new Set(['path', 'value']), `${scope}.body`);
      const value = body['value'];
      if (typeof value !== 'boolean' && typeof value !== 'string' && typeof value !== 'number') {
        throw new ConfigError(`${scope}.body.value must be a boolean, string or number`);
      }
      control.body = { path: requiredString(body['path'], `${scope}.body.path`), value };
    }

    if (mechanism === 'header' && control.header === undefined) {
      throw new ConfigError(`${scope}: a header control needs a "header" object`);
    }
    if (mechanism === 'body' && control.body === undefined) {
      throw new ConfigError(`${scope}: a body control needs a "body" object`);
    }

    return control satisfies DataControl;
  });
}

function optionalMode(value: unknown, where: string): EnforcementMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isEnforcementMode(value)) {
    throw new ConfigError(
      `${where}: "${String(value)}" is not an enforcement mode; use block, sanitize, warn or allow`,
    );
  }
  return value;
}

function parseRedaction(raw: unknown, where: string, base: RedactionConfig): RedactionConfig {
  const scope = `${where}: "redaction"`;
  const node = asObject(raw ?? {}, scope);
  rejectUnknownKeys(
    node,
    new Set(['defaultPolicy', 'policies', 'dictionary', 'custom', 'dobYearRange', 'hmacKey']),
    scope,
  );

  // Every field is folded *over* the base rather than replacing it. A tenant
  // block is an override, not a fresh start: an organisation's blocked kinds,
  // name dictionary and custom rules must keep applying to a tenant that never
  // mentioned them, and the common case — a tenant with no redaction block at
  // all — has to behave exactly like the global profile.
  return {
    defaultPolicy: optionalPolicy(node['defaultPolicy'], `${scope}.defaultPolicy`) ??
      base.defaultPolicy,
    policies: { ...base.policies, ...parsePolicies(node['policies'], `${scope}.policies`) },
    dictionary: mergeDictionaries(
      base.dictionary,
      parseDictionary(node['dictionary'], `${scope}.dictionary`),
    ),
    custom: mergeCustomRules(base.custom, parseCustomRules(node['custom'], `${scope}.custom`)),
    dobYearRange:
      parseDobYearRange(node['dobYearRange'], `${scope}.dobYearRange`) ?? base.dobYearRange,
    hmacKey: optionalString(node['hmacKey'], `${scope}.hmacKey`) ?? base.hmacKey,
  };
}

/**
 * Union of two dictionaries, in base-then-override order.
 *
 * Adding rather than replacing is the safe direction: a tenant that wants to
 * protect one more name must not be able to stop protecting the ones the
 * organisation listed.
 */
function mergeDictionaries(base: DictionaryInput, override: DictionaryInput): DictionaryInput {
  return {
    names: dedupeStrings([...(base.names ?? []), ...(override.names ?? [])]),
    terms: dedupeStrings([...(base.terms ?? []), ...(override.terms ?? [])]),
    entries: [...(base.entries ?? []), ...(override.entries ?? [])],
  };
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Union of two custom-rule lists, keyed by name. A tenant rule of the same
 * name replaces the global one — it is an override of that rule, not a second
 * detector reporting the same category twice.
 */
function mergeCustomRules(
  base: readonly CustomRule[],
  override: readonly CustomRule[],
): CustomRule[] {
  const byName = new Map(base.map((rule) => [rule.name, rule]));
  for (const rule of override) byName.set(rule.name, rule);
  return [...byName.values()];
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
  const maxResponseBytes = env['HUSHGATE_MAX_RESPONSE_BYTES'];
  const upstreamTimeoutMs = env['HUSHGATE_UPSTREAM_TIMEOUT_MS'];
  const auditPath = env['HUSHGATE_AUDIT_PATH'];
  const auditEnabled = env['HUSHGATE_AUDIT'];
  const residencyMode = env['HUSHGATE_RESIDENCY_MODE'];

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
      ...config.limits,
      maxBodyBytes:
        maxBodyBytes === undefined
          ? config.limits.maxBodyBytes
          : envPositiveInt(maxBodyBytes, 'HUSHGATE_MAX_BODY_BYTES'),
      maxResponseBytes:
        maxResponseBytes === undefined
          ? config.limits.maxResponseBytes
          : envPositiveInt(maxResponseBytes, 'HUSHGATE_MAX_RESPONSE_BYTES'),
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
    residency: {
      ...config.residency,
      mode:
        residencyMode === undefined
          ? config.residency.mode
          : envMode(residencyMode, 'HUSHGATE_RESIDENCY_MODE'),
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
    residency: { ...config.residency, ...overrides.residency },
    tenants: overrides.tenants ?? config.tenants,
    organisation: { ...config.organisation, ...overrides.organisation },
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
      parsed = JSON.parse(stripJsonComments(text));
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
/** A non-negative integer: zero is meaningful for a retry count. */
function optionalCount(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${where} must be a non-negative integer, got ${describe(value)}`);
  }
  return value;
}

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

function envMode(value: string, name: string): EnforcementMode {
  if (!isEnforcementMode(value)) {
    throw new ConfigError(
      `${name}: "${value}" is not an enforcement mode; use block, sanitize, warn or allow`,
    );
  }
  return value;
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
