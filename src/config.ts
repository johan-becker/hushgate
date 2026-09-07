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
import {
  ATTACHMENT_FORMATS,
  type AttachmentFormat,
  type ExternalExtractorSpec,
  type UnreadableAction,
} from './attach/types.js';
import type { PostalAddressOptions } from './detectors/address.js';
import type { BicOptions } from './detectors/bic.js';
import { normaliseKindName, type CustomRule } from './detectors/custom.js';
import type { DictionaryInput, DictionaryOptions } from './detectors/dictionary.js';
import type { DobYearRange } from './detectors/dob.js';
import type { Icd10Options, MedicationOptions } from './detectors/health.js';
import type { BankAccountOptions } from './detectors/bankaccount.js';
import type { PostcodeOptions } from './detectors/postcode.js';
import type { SessionTokenOptions } from './detectors/sessiontoken.js';
import type { VatIdOptions } from './detectors/vatid.js';
import type { VehiclePlateOptions } from './detectors/vehicleplate.js';
import { ConfigError } from './errors.js';
// Importing from proxy/ is safe in this direction: routes.ts reaches only the
// shape tables, none of which import this file, so nothing here closes a cycle.
// The alternative — a second hand-written copy of the labels — is what let a
// misspelled rule pass in the first place.
import { ROUTE_LABELS } from './proxy/routes.js';
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
import { BUILTIN_KINDS, isPolicy, type Policy } from './types.js';

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
  /**
   * How long a connection may sit with nothing happening on it before it is
   * closed — accepted and silent, or pooled between two requests.
   *
   * Distinct from {@link requestTimeoutMs}, which bounds a request already in
   * progress. Neither bounds the wait for an answer: a model may think in
   * silence for a long time, and that is the upstream timeout's job.
   */
  readonly idleTimeoutMs: number;
  /** How many times to retry an upstream that never answered. */
  readonly upstreamRetries: number;
  /** Base delay for the retry backoff, doubled each attempt. */
  readonly retryBackoffMs: number;
}

/**
 * What the operator narrowed each configurable detector to, under
 * `redaction.detectors`.
 *
 * These are the detectors' own option types rather than a parallel set of
 * config-only shapes. A second copy would be one more place for the file format
 * and the detector to disagree about what a field means, and that disagreement
 * shows up as a detector quietly not firing rather than as a load error.
 *
 * Two kinds of option are deliberately unreachable from the file, and this is
 * where a reader will look for them:
 *
 *  - the ones that stand for a whole register — `postcode.placeMatches`,
 *    `icd10.catalogue`, `postalAddress.postcodes` and the per-country
 *    `vatId.rules` table. They are the extension points for the official
 *    tables (the PLZ-Verzeichnis, ICD-10-GM, the FZV): a deployment that
 *    licenses one loads it and hands it to `new Session(...)`. Inlining 8200
 *    postcodes in a config file is not a format, it is a paste. The types still
 *    carry those fields, so a library caller keeps the escape hatch; the parser
 *    never produces one. `bankAccount.bankCodes` belongs here too: it is a
 *    function, and the register behind it is the Bundesbank's quarterly file.
 *  - `dictionary.priority`. Reordering the priority ladder from a config file
 *    would let an operator silently invert which detector wins a tie, and that
 *    ladder is argued entry by entry in DEFAULT_PRIORITIES.
 */
export interface DetectorsConfig {
  /** Near-miss matching for the dictionary; `dictionaryMatching` downstream. */
  readonly dictionary: DictionaryOptions;
  readonly vatId: VatIdOptions;
  readonly bic: BicOptions;
  readonly postcode: PostcodeOptions;
  readonly bankAccount: BankAccountOptions;
  readonly vehiclePlate: VehiclePlateOptions;
  readonly sessionToken: SessionTokenOptions;
  readonly postalAddress: PostalAddressOptions;
  readonly icd10: Icd10Options;
  readonly medication: MedicationOptions;
}

export interface RedactionConfig {
  readonly defaultPolicy: Policy;
  readonly policies: Readonly<Record<string, Policy>>;
  readonly dictionary: DictionaryInput;
  readonly custom: readonly CustomRule[];
  /** Per-detector narrowing. Every group is `{}` until someone writes one. */
  readonly detectors: DetectorsConfig;
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

/**
 * How attachments are handled.
 *
 * Before this section existed, a base64 PDF inside a content part was
 * forwarded to the provider byte for byte: the redaction layer selects string
 * leaves that carry prose, and a document is not one. `enabled` therefore
 * defaults to true. Turning it off restores that behaviour, which is why
 * `hushgate doctor` reports the off state rather than staying quiet about it.
 */
export interface AttachmentsConfig {
  readonly enabled: boolean;
  /** Largest single attachment hushgate will decode, in bytes. */
  readonly maxBytes: number;
  /** Largest total across one request, in bytes. */
  readonly maxTotalBytes: number;
  /** Characters of extracted text kept per attachment. */
  readonly maxTextChars: number;
  /** Wall-clock budget for extracting one attachment. */
  readonly timeoutMs: number;
  /** What to do with an attachment whose text could not be read. */
  readonly onUnreadable: UnreadableAction;
  /** Operator-provided extractors, tried before the built-in ones. */
  readonly extractors: readonly ExternalExtractorSpec[];
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
  readonly attachments: AttachmentsConfig;
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
  readonly attachments?: Partial<AttachmentsConfig>;
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
  'attachments',
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
      detectors: emptyDetectors(),
      dobYearRange: null,
      hmacKey: null,
    },
    limits: {
      // Raised from 4 MiB when attachments arrived: base64 inflates a document
      // by a third, so the old cap refused most real ones before an extractor
      // could even look at them.
      maxBodyBytes: 16 * 1024 * 1024,
      maxResponseBytes: 16 * 1024 * 1024,
      upstreamTimeoutMs: 120_000,
      requestTimeoutMs: 60_000,
      // A pooled keep-alive socket between two turns of a conversation is
      // ordinary; a socket that has not said a word for a minute is not one a
      // client is still using. A minute sits above what mainstream HTTP clients
      // keep a free socket for, and matches the idle timeout the load balancers
      // in front of a deployment like this already impose — so nothing
      // legitimate is reaped, and a squatter costs one descriptor per minute
      // instead of one descriptor forever.
      idleTimeoutMs: 60_000,
      upstreamRetries: 2,
      retryBackoffMs: 250,
    },
    // On by default: a privacy control nobody can evidence is a claim, not a
    // control. The trail holds categories and counts only, never values.
    audit: {
      enabled: true,
      path: DEFAULT_AUDIT_PATH,
    },
    // On by default: leaving it off would preserve the gap this section closes,
    // and a document hushgate never reads is a document it cannot pseudonymise.
    attachments: {
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
      maxTotalBytes: 32 * 1024 * 1024,
      maxTextChars: 200_000,
      timeoutMs: 20_000,
      onUnreadable: 'block',
      // Configured by default so the Docker image, which installs
      // poppler-utils, reads PDFs with no config at all. On a host without
      // pdftotext the spawn fails, the attachment is unreadable, and the
      // request is refused with a reason naming the missing command — which is
      // the same outcome as not listing it, but explains itself.
      extractors: [
        {
          mediaTypes: ['application/pdf'],
          formats: ['pdf'],
          command: 'pdftotext',
          args: ['-q', '-enc', 'UTF-8', '-', '-'],
          timeoutMs: 20_000,
        },
      ],
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
      'idleTimeoutMs',
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
      idleTimeoutMs:
        optionalPositiveInt(limits['idleTimeoutMs'], `${where}: "limits.idleTimeoutMs"`) ??
        base.limits.idleTimeoutMs,
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
    attachments: parseAttachments(root['attachments'], where, base.attachments),
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
    routes: parseModeMap(node['routes'], `${scope}.routes`, assertRouteLabel),
    categories: parseModeMap(node['categories'], `${scope}.categories`, assertKindName),
    allow: parseAllowList(node['allow'], `${scope}.allow`),
    requireDataControls:
      optionalBoolean(node['requireDataControls'], `${scope}.requireDataControls`) ??
      base.requireDataControls,
    endpoints: parseEndpoints(node['endpoints'], `${scope}.endpoints`),
  };
}

/**
 * The shape `normaliseKindName` produces: UPPER_SNAKE_CASE, starting with a
 * letter, with single underscores between segments and none at either end.
 * A residency rule may legitimately name a custom rule's kind, so the key set
 * cannot be closed — but the spelling can be, and `phone` is not it.
 */
const CUSTOM_KIND_SHAPE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u;

/**
 * Both residency maps key on names hushgate has to recognise later, and a key
 * it does not recognise enforces nothing at all. Silence there is the worst
 * failure this file can produce: the operator reads their own rule back, sees
 * `block`, and is one typo away from an unprotected proxy. So a key that will
 * never match is a load error, and the error says what to write instead.
 */
function parseModeMap(
  raw: unknown,
  where: string,
  assertKey: (key: string, where: string) => void,
): Record<string, EnforcementMode> {
  if (raw === undefined || raw === null) return {};
  const node = asObject(raw, where);
  const out: Record<string, EnforcementMode> = {};

  for (const [key, value] of Object.entries(node)) {
    assertKey(key, where);
    const mode = optionalMode(value, `${where}.${key}`);
    if (mode !== undefined) out[key] = mode;
  }

  return out;
}

function assertRouteLabel(key: string, where: string): void {
  if (ROUTE_LABELS.includes(key)) return;
  throw new ConfigError(
    `${where}: "${key}" is not a route hushgate serves; expected one of ${ROUTE_LABELS.join(', ')}`,
  );
}

function assertKindName(key: string, where: string): void {
  if ((BUILTIN_KINDS as readonly string[]).includes(key)) return;
  // A custom rule contributes its own kind, so an unknown-but-well-formed name
  // is accepted; the rule may live in a tenant's section, or in no section at
  // all yet. What is refused is a spelling no detector can ever report.
  if (CUSTOM_KIND_SHAPE.test(key)) return;

  // The suggestion is produced by the same function a custom rule's name goes
  // through, so what it prints is exactly what would have matched. It refuses
  // names it cannot normalise at all, and a key like "42" has no suggestion.
  let suggestion = '';
  try {
    const upper = normaliseKindName(key);
    if (upper !== key) suggestion = ` (did you mean "${upper}"?)`;
  } catch {
    suggestion = '';
  }
  throw new ConfigError(
    `${where}: "${key}" is not a finding kind${suggestion}; kinds are UPPER_SNAKE_CASE — either a built-in (${BUILTIN_KINDS.join(', ')}) or the kind a custom rule reports`,
  );
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
    new Set([
      'defaultPolicy',
      'policies',
      'dictionary',
      'custom',
      'detectors',
      'dobYearRange',
      'hmacKey',
    ]),
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
    detectors: mergeDetectors(
      base.detectors,
      parseDetectors(node['detectors'], `${scope}.detectors`),
    ),
    dobYearRange:
      parseDobYearRange(node['dobYearRange'], `${scope}.dobYearRange`) ?? base.dobYearRange,
    hmacKey: optionalString(node['hmacKey'], `${scope}.hmacKey`) ?? base.hmacKey,
  };
}

/** Every detector group at its seeded default: narrowed by nobody. */
function emptyDetectors(): DetectorsConfig {
  return {
    dictionary: {},
    vatId: {},
    bic: {},
    postcode: {},
    bankAccount: {},
    vehiclePlate: {},
    sessionToken: {},
    postalAddress: {},
    icd10: {},
    medication: {},
  };
}

/** The groups `redaction.detectors` accepts, and the keys inside each. */
const DETECTOR_GROUP_KEYS: Readonly<Record<string, readonly string[]>> = {
  dictionary: ['fuzzy', 'maxEditDistance'],
  vatId: ['requireGermanCheckDigit'],
  bic: ['homeCountries'],
  postcode: ['countryPrefixes', 'places'],
  bankAccount: ['accountLabels', 'bankCodeLabels', 'sortCodeLabels', 'routingLabels'],
  vehiclePlate: ['districts'],
  sessionToken: ['names', 'prefixes'],
  postalAddress: ['streetSuffixes', 'weakStreetSuffixes', 'nonAddressWords', 'labels'],
  icd10: ['codes', 'labels', 'blockedPrefixWords'],
  medication: ['names', 'requireDosage', 'dosageWindow'],
};

/**
 * Validate the `redaction.detectors` block.
 *
 * Unknown keys are refused at both levels — a group nobody has heard of, and a
 * key inside a group — because the failure a typo would otherwise cause is the
 * worst kind this product has: `homeCountrys` would load without complaint and
 * the detector would go on using its seed list, so the operator would believe
 * they had narrowed something they had not.
 */
function parseDetectors(raw: unknown, where: string): DetectorsConfig {
  if (raw === undefined || raw === null) return emptyDetectors();
  const node = asObject(raw, where);
  rejectUnknownKeys(node, new Set(Object.keys(DETECTOR_GROUP_KEYS)), where);

  const group = (name: keyof typeof DETECTOR_GROUP_KEYS): Record<string, unknown> => {
    const value = node[name];
    if (value === undefined || value === null) return {};
    const inner = asObject(value, `${where}.${name}`);
    rejectUnknownKeys(inner, new Set(DETECTOR_GROUP_KEYS[name]), `${where}.${name}`);
    return inner;
  };

  const dictionary = group('dictionary');
  const vatId = group('vatId');
  const bic = group('bic');
  const postcode = group('postcode');
  const bankAccount = group('bankAccount');
  const vehiclePlate = group('vehiclePlate');
  const sessionToken = group('sessionToken');
  const postalAddress = group('postalAddress');
  const icd10 = group('icd10');
  const medication = group('medication');

  return {
    dictionary: strip({
      fuzzy: optionalBoolean(dictionary['fuzzy'], `${where}.dictionary.fuzzy`),
      maxEditDistance: optionalEditDistance(
        dictionary['maxEditDistance'],
        `${where}.dictionary.maxEditDistance`,
      ),
    }),
    vatId: strip({
      requireGermanCheckDigit: optionalBoolean(
        vatId['requireGermanCheckDigit'],
        `${where}.vatId.requireGermanCheckDigit`,
      ),
    }),
    bic: strip({
      homeCountries: optionalStringArray(bic['homeCountries'], `${where}.bic.homeCountries`),
    }),
    postcode: strip({
      countryPrefixes: optionalStringArray(
        postcode['countryPrefixes'],
        `${where}.postcode.countryPrefixes`,
      ),
      places: optionalStringArray(postcode['places'], `${where}.postcode.places`),
    }),
    bankAccount: strip({
      accountLabels: optionalStringArray(
        bankAccount['accountLabels'],
        `${where}.bankAccount.accountLabels`,
      ),
      bankCodeLabels: optionalStringArray(
        bankAccount['bankCodeLabels'],
        `${where}.bankAccount.bankCodeLabels`,
      ),
      sortCodeLabels: optionalStringArray(
        bankAccount['sortCodeLabels'],
        `${where}.bankAccount.sortCodeLabels`,
      ),
      routingLabels: optionalStringArray(
        bankAccount['routingLabels'],
        `${where}.bankAccount.routingLabels`,
      ),
    }),
    vehiclePlate: strip({
      districts: optionalStringArray(
        vehiclePlate['districts'],
        `${where}.vehiclePlate.districts`,
      ),
    }),
    sessionToken: strip({
      names: optionalStringArray(sessionToken['names'], `${where}.sessionToken.names`),
      prefixes: optionalStringArray(sessionToken['prefixes'], `${where}.sessionToken.prefixes`),
    }),
    postalAddress: strip({
      streetSuffixes: optionalStringArray(
        postalAddress['streetSuffixes'],
        `${where}.postalAddress.streetSuffixes`,
      ),
      weakStreetSuffixes: optionalStringArray(
        postalAddress['weakStreetSuffixes'],
        `${where}.postalAddress.weakStreetSuffixes`,
      ),
      nonAddressWords: optionalStringArray(
        postalAddress['nonAddressWords'],
        `${where}.postalAddress.nonAddressWords`,
      ),
      labels: optionalStringArray(postalAddress['labels'], `${where}.postalAddress.labels`),
    }),
    icd10: strip({
      codes: optionalStringArray(icd10['codes'], `${where}.icd10.codes`),
      labels: optionalStringArray(icd10['labels'], `${where}.icd10.labels`),
      blockedPrefixWords: optionalStringArray(
        icd10['blockedPrefixWords'],
        `${where}.icd10.blockedPrefixWords`,
      ),
    }),
    medication: strip({
      names: optionalStringArray(medication['names'], `${where}.medication.names`),
      requireDosage: optionalBoolean(
        medication['requireDosage'],
        `${where}.medication.requireDosage`,
      ),
      dosageWindow: optionalPositiveInt(
        medication['dosageWindow'],
        `${where}.medication.dosageWindow`,
      ),
    }),
  };
}

/**
 * Drop the keys nobody set.
 *
 * The detector factories distinguish an absent option from a present one — an
 * absent list means "use the seeds", an empty list means "use nothing" — so a
 * key carrying `undefined` would read as the second and silently disable a
 * detector that the operator never mentioned.
 */
function strip<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as T;
}

function optionalEditDistance(value: unknown, where: string): 0 | 1 | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== 0 && value !== 1) {
    throw new ConfigError(`${where} must be 0 or 1, got ${describe(value)}`);
  }
  return value;
}

/**
 * Fold a tenant's detector block over the organisation's.
 *
 * ONE RULE, and it is the same one `mergeDictionaries` follows: a tenant may
 * only ever widen what is detected, never narrow it. An organisation that
 * listed a street suffix must keep it however the tenant is configured, so
 * lists union rather than replace. The flags follow the same rule rather than
 * the more obvious "last writer wins", which is why they are not all `??`:
 *
 *  - `fuzzy` and `maxEditDistance` widen as they rise, so they take the more
 *    generous of the two.
 *  - `requireGermanCheckDigit` and `requireDosage` narrow as they rise — they
 *    are demands a candidate has to meet — so a `false` anywhere wins.
 *  - `dosageWindow` is how far a dosage may sit from the name, so wider wins.
 *
 * The consequence is deliberate and worth stating: a tenant cannot switch a
 * detector off. Turning something off is the organisation's decision, made in
 * the `policies` table where it is visible in the Article 30 report.
 */
function mergeDetectors(base: DetectorsConfig, override: DetectorsConfig): DetectorsConfig {
  return {
    dictionary: strip({
      fuzzy: eitherTrue(base.dictionary.fuzzy, override.dictionary.fuzzy),
      maxEditDistance: larger(base.dictionary.maxEditDistance, override.dictionary.maxEditDistance),
    }),
    vatId: strip({
      requireGermanCheckDigit: eitherFalse(
        base.vatId.requireGermanCheckDigit,
        override.vatId.requireGermanCheckDigit,
      ),
    }),
    bic: strip({ homeCountries: unionLists(base.bic.homeCountries, override.bic.homeCountries) }),
    postcode: strip({
      countryPrefixes: unionLists(base.postcode.countryPrefixes, override.postcode.countryPrefixes),
      places: unionLists(base.postcode.places, override.postcode.places),
    }),
    bankAccount: strip({
      accountLabels: unionLists(base.bankAccount.accountLabels, override.bankAccount.accountLabels),
      bankCodeLabels: unionLists(
        base.bankAccount.bankCodeLabels,
        override.bankAccount.bankCodeLabels,
      ),
      sortCodeLabels: unionLists(
        base.bankAccount.sortCodeLabels,
        override.bankAccount.sortCodeLabels,
      ),
      routingLabels: unionLists(base.bankAccount.routingLabels, override.bankAccount.routingLabels),
    }),
    vehiclePlate: strip({
      districts: unionLists(base.vehiclePlate.districts, override.vehiclePlate.districts),
    }),
    sessionToken: strip({
      names: unionLists(base.sessionToken.names, override.sessionToken.names),
      prefixes: unionLists(base.sessionToken.prefixes, override.sessionToken.prefixes),
    }),
    postalAddress: strip({
      streetSuffixes: unionLists(
        base.postalAddress.streetSuffixes,
        override.postalAddress.streetSuffixes,
      ),
      weakStreetSuffixes: unionLists(
        base.postalAddress.weakStreetSuffixes,
        override.postalAddress.weakStreetSuffixes,
      ),
      nonAddressWords: unionLists(
        base.postalAddress.nonAddressWords,
        override.postalAddress.nonAddressWords,
      ),
      labels: unionLists(base.postalAddress.labels, override.postalAddress.labels),
    }),
    icd10: strip({
      codes: unionLists(base.icd10.codes, override.icd10.codes),
      labels: unionLists(base.icd10.labels, override.icd10.labels),
      blockedPrefixWords: unionLists(
        base.icd10.blockedPrefixWords,
        override.icd10.blockedPrefixWords,
      ),
    }),
    medication: strip({
      names: unionLists(base.medication.names, override.medication.names),
      requireDosage: eitherFalse(base.medication.requireDosage, override.medication.requireDosage),
      dosageWindow: larger(base.medication.dosageWindow, override.medication.dosageWindow),
    }),
  };
}

/** Both lists, deduped, or `undefined` when neither side set one. */
function unionLists(
  base: Iterable<string> | undefined,
  override: Iterable<string> | undefined,
): string[] | undefined {
  if (base === undefined && override === undefined) return undefined;
  return dedupeStrings([...(base ?? []), ...(override ?? [])]);
}

/** True when either side asked for it; `undefined` when neither mentioned it. */
function eitherTrue(base: boolean | undefined, override: boolean | undefined): boolean | undefined {
  if (base === undefined && override === undefined) return undefined;
  return (base ?? false) || (override ?? false);
}

/** False when either side said so — a demand only one party can lift. */
function eitherFalse(base: boolean | undefined, override: boolean | undefined): boolean | undefined {
  if (base === undefined && override === undefined) return undefined;
  return (base ?? true) && (override ?? true);
}

function larger<T extends number>(base: T | undefined, override: T | undefined): T | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return base >= override ? base : override;
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
  const host = envValue(env, 'HUSHGATE_HOST');
  const port = envValue(env, 'HUSHGATE_PORT');
  const openai = envValue(env, 'HUSHGATE_UPSTREAM_OPENAI');
  const anthropic = envValue(env, 'HUSHGATE_UPSTREAM_ANTHROPIC');
  const defaultPolicy = envValue(env, 'HUSHGATE_DEFAULT_POLICY');
  const hmacKey = envValue(env, 'HUSHGATE_HMAC_KEY');
  const maxBodyBytes = envValue(env, 'HUSHGATE_MAX_BODY_BYTES');
  const maxResponseBytes = envValue(env, 'HUSHGATE_MAX_RESPONSE_BYTES');
  const upstreamTimeoutMs = envValue(env, 'HUSHGATE_UPSTREAM_TIMEOUT_MS');
  const idleTimeoutMs = envValue(env, 'HUSHGATE_IDLE_TIMEOUT_MS');
  const auditPath = envValue(env, 'HUSHGATE_AUDIT_PATH');
  const auditEnabled = envValue(env, 'HUSHGATE_AUDIT');
  const residencyMode = envValue(env, 'HUSHGATE_RESIDENCY_MODE');
  const attachmentsEnabled = envValue(env, 'HUSHGATE_ATTACHMENTS');
  const onUnreadable = envValue(env, 'HUSHGATE_ATTACHMENTS_ON_UNREADABLE');
  const attachmentMaxBytes = envValue(env, 'HUSHGATE_ATTACHMENT_MAX_BYTES');

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
    attachments: {
      ...config.attachments,
      enabled:
        attachmentsEnabled === undefined
          ? config.attachments.enabled
          : envBoolean(attachmentsEnabled, 'HUSHGATE_ATTACHMENTS'),
      onUnreadable:
        onUnreadable === undefined
          ? config.attachments.onUnreadable
          : envUnreadable(onUnreadable, 'HUSHGATE_ATTACHMENTS_ON_UNREADABLE'),
      maxBytes:
        attachmentMaxBytes === undefined
          ? config.attachments.maxBytes
          : envPositiveInt(attachmentMaxBytes, 'HUSHGATE_ATTACHMENT_MAX_BYTES'),
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
      // Settable from the environment because a deployment that has to tighten
      // the reaper — the one knob standing between a hostile client and the
      // file-descriptor budget — should not need a new config file to do it.
      idleTimeoutMs:
        idleTimeoutMs === undefined
          ? config.limits.idleTimeoutMs
          : envPositiveInt(idleTimeoutMs, 'HUSHGATE_IDLE_TIMEOUT_MS'),
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
    attachments: { ...config.attachments, ...overrides.attachments },
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

/**
 * Read one variable, treating an empty or whitespace-only value as absent.
 *
 * That is how a container passes "unset": `HUSHGATE_PORT=${PORT}` in a compose
 * file or a Kubernetes manifest expands to "" when PORT is not set. Reading ""
 * as a value is worse than ignoring it — Number("") is 0, which envPort accepts,
 * and the proxy then binds a random ephemeral port while looking healthy. An
 * empty string is not a host, a URL, a key or a path either, so every read goes
 * through here rather than only the ones that happen to throw.
 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
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

function envUnreadable(value: string, name: string): UnreadableAction {
  if (!(UNREADABLE_ACTIONS as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${UNREADABLE_ACTIONS.join(', ')}, got ${describe(value)}`);
  }
  return value as UnreadableAction;
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
  const { defaultPolicy, policies, dictionary, custom, detectors, dobYearRange, hmacKey } =
    config.redaction;
  return {
    defaultPolicy,
    policies,
    dictionary,
    custom,
    // Spread group by group rather than handed over as one object: the names
    // differ on purpose. `redaction.detectors.dictionary` narrows how the
    // dictionary MATCHES, while `redaction.dictionary` is what it matches
    // against, and calling both of them `dictionary` downstream would be a
    // silent collision.
    dictionaryMatching: detectors.dictionary,
    vatId: detectors.vatId,
    bic: detectors.bic,
    postcode: detectors.postcode,
    bankAccount: detectors.bankAccount,
    vehiclePlate: detectors.vehiclePlate,
    sessionToken: detectors.sessionToken,
    postalAddress: detectors.postalAddress,
    icd10: detectors.icd10,
    medication: detectors.medication,
    dobYearRange: dobYearRange ?? undefined,
    hmacKey: hmacKey ?? undefined,
  };
}

/** Actions `attachments.onUnreadable` accepts, in the order doctor reports them. */
const UNREADABLE_ACTIONS: readonly UnreadableAction[] = ['block', 'withhold', 'forward'];

/**
 * Validate the `attachments` section.
 *
 * The one field worth arguing about is `onUnreadable`. `forward` means an
 * attachment hushgate could not read is sent to the provider as it arrived,
 * which is the exact event the rest of the product exists to prevent. It is
 * accepted, because an operator who knowingly wants images through should not
 * have to patch the source — but it is a decision, so it is spelled out in
 * config rather than reached by leaving something unset, and `doctor` reports
 * it.
 */
function parseAttachments(
  raw: unknown,
  where: string,
  base: AttachmentsConfig,
): AttachmentsConfig {
  const scope = `${where}: "attachments"`;
  const node = asObject(raw ?? {}, scope);
  rejectUnknownKeys(
    node,
    new Set([
      'enabled',
      'maxBytes',
      'maxTotalBytes',
      'maxTextChars',
      'timeoutMs',
      'onUnreadable',
      'extractors',
    ]),
    scope,
  );

  const maxBytes = optionalPositiveInt(node['maxBytes'], `${scope}.maxBytes`) ?? base.maxBytes;
  const maxTotalBytes =
    optionalPositiveInt(node['maxTotalBytes'], `${scope}.maxTotalBytes`) ?? base.maxTotalBytes;

  if (maxTotalBytes < maxBytes) {
    throw new ConfigError(
      `${scope}.maxTotalBytes (${maxTotalBytes}) is below maxBytes (${maxBytes}), so no attachment could ever be accepted`,
    );
  }

  return {
    enabled: optionalBoolean(node['enabled'], `${scope}.enabled`) ?? base.enabled,
    maxBytes,
    maxTotalBytes,
    maxTextChars:
      optionalPositiveInt(node['maxTextChars'], `${scope}.maxTextChars`) ?? base.maxTextChars,
    timeoutMs: optionalPositiveInt(node['timeoutMs'], `${scope}.timeoutMs`) ?? base.timeoutMs,
    onUnreadable: parseUnreadable(node['onUnreadable'], `${scope}.onUnreadable`) ?? base.onUnreadable,
    extractors: parseExtractors(node['extractors'], `${scope}.extractors`) ?? base.extractors,
  };
}

function parseUnreadable(value: unknown, where: string): UnreadableAction | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(UNREADABLE_ACTIONS as readonly string[]).includes(value)) {
    throw new ConfigError(
      `${where} must be one of ${UNREADABLE_ACTIONS.join(', ')}, got ${describe(value)}`,
    );
  }
  return value as UnreadableAction;
}

/**
 * External extractors.
 *
 * `command` and `args` come from here and from nowhere else. Nothing derived
 * from a request may reach a child process's argv: a document named `-layout`
 * handed to pdftotext as an argument is read as a flag, and the tool then exits
 * zero having produced nothing — a silent, caller-chosen truncation. Config is
 * the only source, and the request only ever reaches the child over stdin.
 */
function parseExtractors(raw: unknown, where: string): ExternalExtractorSpec[] | undefined {
  if (raw === undefined) return undefined;
  const items = asArray(raw, where);

  return items.map((item, index) => {
    const scope = `${where}[${index}]`;
    const node = asObject(item, scope);
    rejectUnknownKeys(
      node,
      new Set(['mediaTypes', 'formats', 'command', 'args', 'timeoutMs']),
      scope,
    );

    const command = requiredString(node['command'], `${scope}.command`);
    if (command.trim() === '') throw new ConfigError(`${scope}.command must not be empty`);

    const mediaTypes = optionalStringArray(node['mediaTypes'], `${scope}.mediaTypes`) ?? [];
    const formats = parseFormats(node['formats'], `${scope}.formats`);
    if (mediaTypes.length === 0 && formats.length === 0) {
      throw new ConfigError(
        `${scope} must name at least one of mediaTypes or formats, or it would never be used`,
      );
    }

    return {
      mediaTypes: mediaTypes.map((value) => value.toLowerCase()),
      formats,
      command,
      args: optionalStringArray(node['args'], `${scope}.args`) ?? [],
      timeoutMs: optionalPositiveInt(node['timeoutMs'], `${scope}.timeoutMs`) ?? 20_000,
    };
  });
}

function parseFormats(raw: unknown, where: string): AttachmentFormat[] {
  const values = optionalStringArray(raw, where) ?? [];
  for (const value of values) {
    if (!(ATTACHMENT_FORMATS as readonly string[]).includes(value)) {
      throw new ConfigError(
        `${where} contains ${describe(value)}, which is not a known format; expected one of ${ATTACHMENT_FORMATS.join(', ')}`,
      );
    }
  }
  return values as AttachmentFormat[];
}
