/**
 * Tenants: one team, department or application each, with its own key, its own
 * policy profile, its own pseudonym namespace, its own audit stream and its own
 * allowance.
 *
 * Keys are stored as SHA-256 hashes, never in plain text. A config file gets
 * copied into a wiki, a ticket and a screenshot; a hash there is a nuisance to
 * an attacker, a key there is a gift.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ConfigError } from '../errors.js';
// Type-only: erased at compile time, so there is no import cycle at runtime.
import type { RedactionConfig } from '../config.js';

export interface TenantQuotas {
  /** Requests per rolling minute, or `null` for unlimited. */
  readonly requestsPerMinute: number | null;
  /** Upstream tokens per UTC day, or `null` for unlimited. */
  readonly tokensPerDay: number | null;
}

export interface Tenant {
  readonly id: string;
  readonly name: string;
  /** SHA-256 hex digests of the accepted keys. Several allow rotation. */
  readonly keyHashes: readonly string[];
  /** Complete redaction profile, already merged over the global one. */
  readonly redaction: RedactionConfig;
  readonly quotas: TenantQuotas;
  /** Dedicated audit trail, or `null` to share the global one. */
  readonly auditPath: string | null;
  /** Environment variable holding the upstream credential for this tenant. */
  readonly upstreamKeyEnv: string | null;
}

/** Prefix that makes a hushgate key recognisable in a log or a paste. */
export const KEY_PREFIX = 'hg_';

/** Mint a key. Returned once, in plain text; only its hash is ever stored. */
export function issueKey(bytes = 32): { key: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(bytes).toString('base64url')}`;
  return { key, hash: hashKey(key) };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Compare two hex digests without leaking their contents through timing. */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface TenantRegistry {
  readonly tenants: readonly Tenant[];
  /** True when no tenants are configured: hushgate is running single-tenant. */
  readonly empty: boolean;
  /** The tenant this key belongs to, or `null`. */
  authenticate(key: string): Tenant | null;
  get(id: string): Tenant | undefined;
}

export function createTenantRegistry(tenants: readonly Tenant[]): TenantRegistry {
  const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  if (byId.size !== tenants.length) {
    throw new ConfigError('tenant ids must be unique');
  }

  return {
    tenants,
    empty: tenants.length === 0,

    authenticate(key: string): Tenant | null {
      if (key.length === 0) return null;
      const presented = hashKey(key);

      // Every tenant is checked, so the time taken does not reveal which one
      // matched — or how far down the list a near miss got.
      let found: Tenant | null = null;
      for (const tenant of tenants) {
        for (const hash of tenant.keyHashes) {
          if (digestsMatch(presented, hash)) found = tenant;
        }
      }
      return found;
    },

    get(id: string): Tenant | undefined {
      return byId.get(id);
    },
  };
}

/**
 * The credential a caller presented, from either provider's convention.
 *
 * Both are read because an OpenAI SDK sends `Authorization: Bearer …` and an
 * Anthropic SDK sends `x-api-key`, and hushgate speaks both.
 */
export function presentedKey(headers: {
  authorization?: string | string[] | undefined;
  'x-api-key'?: string | string[] | undefined;
}): string {
  const authorization = first(headers.authorization);
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1].trim();
    return authorization.trim();
  }

  return first(headers['x-api-key'])?.trim() ?? '';
}

function first(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Derive a tenant's HMAC key from the global one.
 *
 * The `hash` policy must be stable for a tenant across restarts, and must not
 * be comparable between tenants: if two tenants hashed the same value to the
 * same token, one could confirm the other's data by guessing it.
 */
export function deriveTenantKey(base: string, tenantId: string): string {
  return createHash('sha256').update(`${base} ${tenantId}`, 'utf8').digest('hex');
}

/** Loopback addresses: the only ones safe to serve without authentication. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase().replaceAll(/^\[|\]$/gu, ''));
}

/**
 * Refuse to be an open relay.
 *
 * On loopback no key is required: the only thing that can reach it is already
 * on the machine. On any other address a caller must authenticate, because the
 * thing being relayed is the mapping back to real personal data.
 *
 * @throws {ConfigError} when bound off-loopback with no tenants configured.
 */
export function assertNotOpenRelay(host: string, registry: TenantRegistry): void {
  if (!registry.empty || isLoopback(host)) return;
  throw new ConfigError(
    `hushgate is configured to bind ${host} with no tenants defined, which would be an open relay on the network. ` +
      'Define tenants (run "hushgate keys new <id>") or bind 127.0.0.1.',
  );
}
