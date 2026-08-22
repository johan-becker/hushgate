import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, type HushgateConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { createProxyServer } from '../src/proxy/server.js';
import {
  assertNotOpenRelay,
  createTenantRegistry,
  deriveTenantKey,
  hashKey,
  isLoopback,
  issueKey,
  presentedKey,
  type Tenant,
} from '../src/tenants/tenant.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { replyJson } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const tenant = (id: string, key: string, overrides: Partial<Tenant> = {}): Tenant => ({
  id,
  name: id,
  keyHashes: [hashKey(key)],
  redaction: defaultConfig().redaction,
  quotas: { requestsPerMinute: null, tokensPerDay: null },
  auditPath: null,
  upstreamKeyEnv: null,
  ...overrides,
});

const withTenants = (base: HushgateConfig, tenants: readonly Tenant[]): HushgateConfig => ({
  ...base,
  tenants,
});

describe('key issuing', () => {
  it('mints a recognisable key and its hash', () => {
    const { key, hash } = issueKey();
    expect(key.startsWith('hg_')).toBe(true);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashKey(key)).toBe(hash);
  });

  it('never mints the same key twice', () => {
    const keys = new Set(Array.from({ length: 100 }, () => issueKey().key));
    expect(keys.size).toBe(100);
  });

  it('derives a different hash namespace per tenant', () => {
    expect(deriveTenantKey('base', 'a')).not.toBe(deriveTenantKey('base', 'b'));
    expect(deriveTenantKey('base', 'a')).toBe(deriveTenantKey('base', 'a'));
  });
});

describe('presentedKey', () => {
  it('reads a bearer token', () => {
    expect(presentedKey({ authorization: 'Bearer hg_abc' })).toBe('hg_abc');
    expect(presentedKey({ authorization: 'bearer  hg_abc  ' })).toBe('hg_abc');
  });

  it('reads the Anthropic header', () => {
    expect(presentedKey({ 'x-api-key': 'hg_abc' })).toBe('hg_abc');
  });

  it('is empty when nothing was presented', () => {
    expect(presentedKey({})).toBe('');
  });
});

describe('the registry', () => {
  const registry = createTenantRegistry([tenant('a', 'hg_a'), tenant('b', 'hg_b')]);

  it('resolves a key to its tenant', () => {
    expect(registry.authenticate('hg_a')?.id).toBe('a');
    expect(registry.authenticate('hg_b')?.id).toBe('b');
  });

  it('rejects an unknown or empty key', () => {
    expect(registry.authenticate('hg_c')).toBeNull();
    expect(registry.authenticate('')).toBeNull();
  });

  it('accepts several hashes for one tenant, which is how rotation works', () => {
    const rotating = createTenantRegistry([
      tenant('a', 'hg_old', { keyHashes: [hashKey('hg_old'), hashKey('hg_new')] }),
    ]);
    expect(rotating.authenticate('hg_old')?.id).toBe('a');
    expect(rotating.authenticate('hg_new')?.id).toBe('a');
  });

  it('refuses duplicate tenant ids', () => {
    expect(() => createTenantRegistry([tenant('a', 'x'), tenant('a', 'y')])).toThrow(ConfigError);
  });
});

describe('the open relay guard', () => {
  it('knows what loopback is', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('[::1]')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('10.0.0.5')).toBe(false);
  });

  it('allows an unauthenticated proxy only on loopback', () => {
    const empty = createTenantRegistry([]);
    expect(() => assertNotOpenRelay('127.0.0.1', empty)).not.toThrow();
    expect(() => assertNotOpenRelay('0.0.0.0', empty)).toThrow(/open relay/u);
  });

  it('allows any address once tenants exist', () => {
    const registry = createTenantRegistry([tenant('a', 'hg_a')]);
    expect(() => assertNotOpenRelay('0.0.0.0', registry)).not.toThrow();
  });

  it('refuses to build a server that would be an open relay', () => {
    expect(() => createProxyServer({ config: { ...defaultConfig(), host: '0.0.0.0' } })).toThrow(
      ConfigError,
    );
  });
});

describe('the tenants config block', () => {
  it('reads hashes, quotas, audit paths and a policy profile', () => {
    const config = parseConfig({
      redaction: { policies: { EMAIL: 'redact' } },
      tenants: [
        {
          id: 'support',
          name: 'Support desk',
          keyHash: `sha256:${hashKey('hg_x')}`,
          quotas: { requestsPerMinute: 60, tokensPerDay: 100000 },
          audit: { path: 'audit/support.jsonl' },
          redaction: { policies: { SECRET: 'block' } },
        },
      ],
    });

    const [entry] = config.tenants;
    expect(entry!.id).toBe('support');
    expect(entry!.keyHashes).toEqual([hashKey('hg_x')]);
    expect(entry!.quotas).toEqual({ requestsPerMinute: 60, tokensPerDay: 100000 });
    expect(entry!.auditPath).toBe('audit/support.jsonl');
    expect(entry!.redaction.policies).toEqual({ SECRET: 'block' });
    // The profile inherits everything it did not override.
    expect(entry!.redaction.defaultPolicy).toBe('pseudonymize');
  });

  it('insists on a key', () => {
    expect(() => parseConfig({ tenants: [{ id: 'support' }] })).toThrow(/hushgate keys new/u);
  });

  it('rejects a malformed hash', () => {
    expect(() => parseConfig({ tenants: [{ id: 'a', keyHash: 'not-a-hash' }] })).toThrow(
      /SHA-256 hex digest/u,
    );
  });

  it('rejects duplicate ids', () => {
    const keyHash = hashKey('hg_x');
    expect(() =>
      parseConfig({ tenants: [{ id: 'a', keyHash }, { id: 'a', keyHash }] }),
    ).toThrow(/unique/u);
  });

  it('reads a key from the environment for container deployments', () => {
    process.env['HUSHGATE_TEST_TENANT_KEY'] = 'hg_from_env';
    try {
      const config = parseConfig({
        tenants: [{ id: 'a', keyEnv: 'HUSHGATE_TEST_TENANT_KEY' }],
      });
      expect(config.tenants[0]!.keyHashes).toEqual([hashKey('hg_from_env')]);
    } finally {
      delete process.env['HUSHGATE_TEST_TENANT_KEY'];
    }
  });

  it('fails when the named environment variable is not set', () => {
    expect(() => parseConfig({ tenants: [{ id: 'a', keyEnv: 'HUSHGATE_NOT_SET_ANYWHERE' }] })).toThrow(
      /which is not set/u,
    );
  });
});

describe('authentication at the proxy', () => {
  it('refuses a request with no key', async () => {
    harness = await startHarness({ config: (base) => withTenants(base, [tenant('a', 'hg_a')]) });

    const response = await harness.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { type: string } }).error.type).toBe(
      'authentication_error',
    );
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('refuses an unknown key', async () => {
    harness = await startHarness({ config: (base) => withTenants(base, [tenant('a', 'hg_a')]) });
    const response = await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer hg_wrong' },
    );
    expect(response.status).toBe(401);
  });

  it('accepts a valid key on either header', async () => {
    harness = await startHarness({
      config: (base) => withTenants(base, [tenant('a', 'hg_a')]),
      handler: replyJson({ ok: true }),
    });

    const bearer = await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer hg_a' },
    );
    const apiKey = await harness.post(
      '/v1/messages',
      { model: 'm', messages: [] },
      { 'x-api-key': 'hg_a' },
    );

    expect(bearer.status).toBe(200);
    expect(apiKey.status).toBe(200);
  });

  it('leaves /healthz open, because probes cannot authenticate', async () => {
    harness = await startHarness({ config: (base) => withTenants(base, [tenant('a', 'hg_a')]) });
    expect((await harness.get('/healthz')).status).toBe(200);
  });

  it('never forwards the tenant key upstream', async () => {
    harness = await startHarness({
      config: (base) => withTenants(base, [tenant('a', 'hg_secret_key')]),
    });

    await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer hg_secret_key' },
    );

    const headers = harness.upstream.lastRequest!.headers;
    expect(JSON.stringify(headers)).not.toContain('hg_secret_key');
  });

  it('substitutes the upstream credential hushgate holds', async () => {
    harness = await startHarness({
      config: (base) => withTenants(base, [tenant('a', 'hg_a')]),
      proxy: { env: { OPENAI_API_KEY: 'sk-real-provider-key' } },
    });

    await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer hg_a' },
    );

    expect(harness.upstream.lastRequest!.headers['authorization']).toBe(
      'Bearer sk-real-provider-key',
    );
  });

  it('lets a tenant use its own upstream credential', async () => {
    harness = await startHarness({
      config: (base) =>
        withTenants(base, [tenant('a', 'hg_a', { upstreamKeyEnv: 'TEAM_A_KEY' })]),
      proxy: { env: { OPENAI_API_KEY: 'sk-shared', TEAM_A_KEY: 'sk-team-a' } },
    });

    await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer hg_a' },
    );

    expect(harness.upstream.lastRequest!.headers['authorization']).toBe('Bearer sk-team-a');
  });

  it('passes the caller key through when running single-tenant', async () => {
    harness = await startHarness();
    await harness.post(
      '/v1/chat/completions',
      { model: 'm', messages: [] },
      { authorization: 'Bearer sk-caller' },
    );
    expect(harness.upstream.lastRequest!.headers['authorization']).toBe('Bearer sk-caller');
  });
});
