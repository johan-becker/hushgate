import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog, parseAuditLines } from '../src/audit/log.js';
import { defaultConfig, type HushgateConfig } from '../src/config.js';
import { hashKey, type Tenant } from '../src/tenants/tenant.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

let harness: Harness | undefined;
const dirs: string[] = [];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-tenants-'));
  dirs.push(dir);
  return dir;
}

const tenant = (id: string, key: string, overrides: Partial<Tenant> = {}): Tenant => ({
  id,
  name: id,
  keyHashes: [hashKey(key)],
  redaction: defaultConfig().redaction,
  briefing: defaultConfig().briefing,
  quotas: { requestsPerMinute: null, tokensPerDay: null },
  auditPath: null,
  upstreamKeyEnv: null,
  ...overrides,
});

const chat = (content: string): Record<string, unknown> => ({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content }],
});

/** An upstream that echoes whatever the request asked it to echo. */
const echoUpstream = {
  handler: (request: { json: unknown }): { headers: Record<string, string>; body: string } => {
    const body = request.json as { messages: { content: string }[] };
    return {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ echo: body.messages[0]!.content }),
    };
  },
};

describe('pseudonym isolation between tenants', () => {
  it('does not let one tenant resolve another tenant placeholder', async () => {
    // The upstream replies with a token from a previous, different tenant.
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        tenants: [tenant('alpha', 'hg_alpha'), tenant('beta', 'hg_beta')],
      }),
      handler: () => ({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ choices: [{ message: { content: 'contact [EMAIL_1]' } }] }),
      }),
    });

    const alpha = await harness.post(
      '/v1/chat/completions',
      chat('write to alpha@example.com'),
      { authorization: 'Bearer hg_alpha' },
    );
    const alphaPayload = (await alpha.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(alphaPayload.choices[0]!.message.content).toBe('contact alpha@example.com');

    // Beta sends a request with no e-mail in it at all, so its session has no
    // mapping. The same upstream reply must come back unresolved.
    const beta = await harness.post('/v1/chat/completions', chat('nothing here'), {
      authorization: 'Bearer hg_beta',
    });
    const betaPayload = (await beta.json()) as { choices: { message: { content: string } }[] };
    expect(betaPayload.choices[0]!.message.content).toBe('contact [EMAIL_1]');
    expect(JSON.stringify(betaPayload)).not.toContain('alpha@example.com');
  });

  it('gives two tenants different hashes for the same value', async () => {
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        redaction: {
          ...base.redaction,
          hmacKey: 'shared-secret',
          policies: { EMAIL: 'hash' },
        },
        tenants: [
          tenant('alpha', 'hg_alpha', {
            redaction: { ...base.redaction, policies: { EMAIL: 'hash' } },
          }),
          tenant('beta', 'hg_beta', {
            redaction: { ...base.redaction, policies: { EMAIL: 'hash' } },
          }),
        ],
      }),
      ...echoUpstream,
    });

    await harness.post('/v1/chat/completions', chat('same@example.com'), {
      authorization: 'Bearer hg_alpha',
    });
    const alphaSent = harness.upstream.lastRequest!.body;

    await harness.post('/v1/chat/completions', chat('same@example.com'), {
      authorization: 'Bearer hg_beta',
    });
    const betaSent = harness.upstream.lastRequest!.body;

    expect(alphaSent).toMatch(/\[EMAIL:[0-9a-f]{12}\]/u);
    // A shared digest would let one tenant confirm another tenant's data by
    // guessing it; the namespaces are derived per tenant precisely to stop that.
    expect(alphaSent).not.toBe(betaSent);
  });

  it('applies each tenant own policy profile', async () => {
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        tenants: [
          tenant('strict', 'hg_strict', {
            redaction: { ...base.redaction, policies: { SECRET: 'block' } },
          }),
          tenant('relaxed', 'hg_relaxed'),
        ],
      }),
      ...echoUpstream,
    });

    const secret = 'deploy sk-abcdefghijklmnopqrstuvwx now';

    const strict = await harness.post('/v1/chat/completions', chat(secret), {
      authorization: 'Bearer hg_strict',
    });
    expect(strict.status).toBe(403);

    const relaxed = await harness.post('/v1/chat/completions', chat(secret), {
      authorization: 'Bearer hg_relaxed',
    });
    expect(relaxed.status).toBe(200);
    expect(harness.upstream.lastRequest!.body).toContain('[SECRET_1]');
  });

  it('applies each tenant own dictionary', async () => {
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        tenants: [
          tenant('sales', 'hg_sales', {
            redaction: { ...base.redaction, dictionary: { names: ['Projekt Nordlicht'] } },
          }),
          tenant('ops', 'hg_ops'),
        ],
      }),
      ...echoUpstream,
    });

    await harness.post('/v1/chat/completions', chat('Status Projekt Nordlicht?'), {
      authorization: 'Bearer hg_sales',
    });
    expect(harness.upstream.lastRequest!.body).toContain('[NAME_1]');

    await harness.post('/v1/chat/completions', chat('Status Projekt Nordlicht?'), {
      authorization: 'Bearer hg_ops',
    });
    expect(harness.upstream.lastRequest!.body).toContain('Projekt Nordlicht');
  });
});

describe('per-tenant audit streams', () => {
  it('writes each tenant to its own trail, and tags every record', async () => {
    const dir = workspace();
    const alphaLog = new JsonlAuditLog({ path: join(dir, 'alpha.jsonl') });
    const betaLog = new JsonlAuditLog({ path: join(dir, 'beta.jsonl') });

    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        tenants: [tenant('alpha', 'hg_alpha'), tenant('beta', 'hg_beta')],
      }),
      ...echoUpstream,
      proxy: {
        auditFor: (t) => (t?.id === 'alpha' ? alphaLog : betaLog),
      },
    });

    await harness.post('/v1/chat/completions', chat('alpha@example.com'), {
      authorization: 'Bearer hg_alpha',
    });
    await harness.post('/v1/chat/completions', chat('beta@example.com'), {
      authorization: 'Bearer hg_beta',
    });
    await harness.post('/v1/chat/completions', chat('beta2@example.com'), {
      authorization: 'Bearer hg_beta',
    });

    await Promise.all([alphaLog.close(), betaLog.close()]);

    const alphaRecords = parseAuditLines(readFileSync(join(dir, 'alpha.jsonl'), 'utf8')).records;
    const betaRecords = parseAuditLines(readFileSync(join(dir, 'beta.jsonl'), 'utf8')).records;

    expect(alphaRecords).toHaveLength(1);
    expect(betaRecords).toHaveLength(2);
    expect(alphaRecords.every((record) => record.tenant === 'alpha')).toBe(true);
    expect(betaRecords.every((record) => record.tenant === 'beta')).toBe(true);

    // Neither trail contains anything of the other's, values least of all.
    expect(readFileSync(join(dir, 'alpha.jsonl'), 'utf8')).not.toContain('beta');
    expect(readFileSync(join(dir, 'beta.jsonl'), 'utf8')).not.toContain('alpha');
  });
});
