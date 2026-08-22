import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from '../src/config.js';
import { ConfigError, ResidencyError } from '../src/errors.js';
import { createProxyServer } from '../src/proxy/server.js';
import {
  assertUpstreamsPermitted,
  covers,
  defaultResidencyConfig,
  enforcementFor,
  evaluateUpstream,
  strictest,
  type AllowEntry,
  type ResidencyConfig,
} from '../src/residency/policy.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const residency = (overrides: Partial<ResidencyConfig> = {}): ResidencyConfig => ({
  ...defaultResidencyConfig(),
  ...overrides,
});

const allow = (endpoint: string, extra: Partial<AllowEntry> = {}): AllowEntry => ({
  endpoint,
  jurisdiction: null,
  legalBasis: 'DPA signed 2026-01-12',
  note: null,
  ...extra,
});

describe('covers', () => {
  it('matches on origin', () => {
    expect(covers('https://api.mistral.ai', 'https://api.mistral.ai')).toBe(true);
    expect(covers('https://api.mistral.ai', 'https://api.openai.com')).toBe(false);
  });

  it('respects a path prefix', () => {
    expect(covers('https://eu.example/v1', 'https://eu.example/v1')).toBe(true);
    expect(covers('https://eu.example/v1', 'https://eu.example/v1/deep')).toBe(true);
    expect(covers('https://eu.example/v1', 'https://eu.example/v2')).toBe(false);
  });

  it('does not treat a longer host as a match', () => {
    expect(covers('https://api.mistral.ai', 'https://api.mistral.ai.evil.test')).toBe(false);
  });
});

describe('evaluateUpstream', () => {
  it('permits everything when no allowlist is configured, and says so', () => {
    const verdict = evaluateUpstream('https://api.openai.com', residency());
    expect(verdict.permitted).toBe(true);
    expect(verdict.rule).toBe('residency.allow (empty)');
    expect(verdict.reason).toMatch(/no allowlist is configured/u);
    expect(verdict.jurisdiction.code).toBe('US');
  });

  it('refuses an upstream that is not on a configured allowlist', () => {
    const verdict = evaluateUpstream(
      'https://api.openai.com',
      residency({ allow: [allow('https://api.mistral.ai')] }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.rule).toBe('residency.allow');
    expect(verdict.reason).toContain('not on the residency allowlist');
  });

  it('permits an allowlisted upstream and reports the legal basis', () => {
    const verdict = evaluateUpstream(
      'https://api.mistral.ai',
      residency({ allow: [allow('https://api.mistral.ai')] }),
    );
    expect(verdict.permitted).toBe(true);
    expect(verdict.rule).toBe('residency.allow[0]');
    expect(verdict.legalBasis).toBe('DPA signed 2026-01-12');
    expect(verdict.jurisdiction.code).toBe('FR');
    expect(verdict.jurisdiction.status).toBe('eea');
  });

  it('lets the operator declare a jurisdiction the registry cannot know', () => {
    const verdict = evaluateUpstream(
      'https://contoso.openai.azure.com',
      residency({
        allow: [allow('https://contoso.openai.azure.com', { jurisdiction: 'SE' })],
      }),
    );
    expect(verdict.jurisdiction.code).toBe('SE');
    expect(verdict.jurisdiction.status).toBe('eea');
  });

  it('reports an unknown endpoint as undeclared rather than guessing', () => {
    const verdict = evaluateUpstream('https://llm.internal.example', residency());
    expect(verdict.registry).toBeNull();
    expect(verdict.jurisdiction.code).toBe('UNKNOWN');
  });

  it('refuses an endpoint with no data control when they are required', () => {
    const verdict = evaluateUpstream(
      'https://llm.internal.example',
      residency({
        allow: [allow('https://llm.internal.example')],
        requireDataControls: true,
      }),
    );
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/no documented retention or training control/u);
  });

  it('accepts a local runtime as inherently retention-free', () => {
    const verdict = evaluateUpstream(
      'http://127.0.0.1:11434',
      residency({ allow: [allow('http://127.0.0.1:11434')], requireDataControls: true }),
    );
    expect(verdict.permitted).toBe(true);
    expect(verdict.jurisdiction.status).toBe('local');
  });
});

describe('assertUpstreamsPermitted', () => {
  it('names every upstream it refuses, and the rule that refused it', () => {
    expect(() =>
      assertUpstreamsPermitted(
        { openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com' },
        residency({ allow: [allow('https://api.mistral.ai')] }),
      ),
    ).toThrow(ResidencyError);

    try {
      assertUpstreamsPermitted(
        { openai: 'https://api.openai.com', anthropic: 'https://api.mistral.ai' },
        residency({ allow: [allow('https://api.mistral.ai')] }),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('upstreams.openai');
      expect(message).toContain('[residency.allow]');
      expect(message).not.toContain('upstreams.anthropic');
    }
  });

  it('returns a verdict per upstream when everything is permitted', () => {
    const verdicts = assertUpstreamsPermitted(
      { openai: 'https://api.mistral.ai', anthropic: 'https://api.aleph-alpha.com' },
      residency({
        allow: [allow('https://api.mistral.ai'), allow('https://api.aleph-alpha.com')],
      }),
    );
    expect(verdicts.map((verdict) => verdict.jurisdiction.code)).toEqual(['FR', 'DE']);
  });
});

describe('enforcementFor', () => {
  it('falls back to the global mode', () => {
    expect(enforcementFor(residency(), 'openai.chat.completions', ['EMAIL'])).toEqual({
      mode: 'sanitize',
      rule: 'residency.mode',
    });
  });

  it('prefers a route rule over the global mode', () => {
    const config = residency({ mode: 'sanitize', routes: { 'anthropic.messages': 'warn' } });
    expect(enforcementFor(config, 'anthropic.messages', ['EMAIL']).mode).toBe('warn');
    expect(enforcementFor(config, 'openai.chat.completions', ['EMAIL']).mode).toBe('sanitize');
  });

  it('prefers a category rule over a route rule', () => {
    const config = residency({
      routes: { 'openai.chat.completions': 'allow' },
      categories: { GERMAN_TAX_ID: 'block' },
    });
    expect(enforcementFor(config, 'openai.chat.completions', ['GERMAN_TAX_ID'])).toEqual({
      mode: 'block',
      rule: 'residency.categories.GERMAN_TAX_ID',
    });
  });

  it('takes the strictest category when several apply', () => {
    const config = residency({ categories: { EMAIL: 'warn', IBAN: 'block', IPV4: 'allow' } });
    expect(enforcementFor(config, 'r', ['EMAIL', 'IPV4', 'IBAN']).rule).toBe(
      'residency.categories.IBAN',
    );
  });

  it('orders modes from strictest to loosest', () => {
    expect(strictest('warn', 'block')).toBe('block');
    expect(strictest('sanitize', 'allow')).toBe('sanitize');
    expect(strictest('warn', 'allow')).toBe('warn');
  });
});

describe('the residency config block', () => {
  it('parses an allowlist with a legal basis', () => {
    const config = parseConfig({
      residency: {
        mode: 'block',
        allow: [
          {
            endpoint: 'https://api.mistral.ai/',
            jurisdiction: 'FR',
            legalBasis: 'Art. 28 DPA, processing in France',
            note: 'reviewed by the DPO 2026-02-01',
          },
        ],
        routes: { 'anthropic.messages': 'warn' },
        categories: { SECRET: 'block' },
        requireDataControls: true,
      },
    });

    expect(config.residency.mode).toBe('block');
    expect(config.residency.allow[0]!.endpoint).toBe('https://api.mistral.ai');
    expect(config.residency.allow[0]!.legalBasis).toContain('Art. 28');
    expect(config.residency.routes['anthropic.messages']).toBe('warn');
    expect(config.residency.categories['SECRET']).toBe('block');
  });

  it('insists on a legal basis for every allowlist entry', () => {
    expect(() =>
      parseConfig({ residency: { allow: [{ endpoint: 'https://api.mistral.ai' }] } }),
    ).toThrow(/legalBasis/u);
  });

  it('rejects an unknown enforcement mode', () => {
    expect(() => parseConfig({ residency: { mode: 'strip' } })).toThrow(
      /is not an enforcement mode/u,
    );
  });

  it('parses registry extensions, including a header data control', () => {
    const config = parseConfig({
      residency: {
        endpoints: [
          {
            id: 'acme.vllm',
            label: 'Acme vLLM',
            operator: 'Acme GmbH',
            hosts: ['llm.acme.internal'],
            jurisdiction: 'de',
            dataControls: [
              {
                kind: 'no-training',
                mechanism: 'header',
                header: { name: 'X-Acme-No-Training', value: '1' },
                note: 'honoured by our inference gateway',
              },
            ],
            note: 'on premise, Karlsruhe',
          },
        ],
      },
    });

    const entry = config.residency.endpoints[0]!;
    expect(entry.jurisdiction).toBe('DE');
    expect(entry.dataControls[0]!.header).toEqual({ name: 'X-Acme-No-Training', value: '1' });
  });

  it('refuses a header control with no header', () => {
    expect(() =>
      parseConfig({
        residency: {
          endpoints: [
            {
              id: 'x',
              hosts: ['x.example'],
              jurisdiction: 'DE',
              dataControls: [{ kind: 'no-training', mechanism: 'header' }],
            },
          ],
        },
      }),
    ).toThrow(ConfigError);
  });
});

describe('the proxy under a residency policy', () => {
  it('refuses to start when the upstream is not allowlisted', () => {
    const config = {
      ...defaultConfig(),
      residency: residency({ allow: [allow('https://api.mistral.ai')] }),
    };
    expect(() => createProxyServer({ config })).toThrow(ResidencyError);
  });

  it('starts when the upstream is allowlisted', async () => {
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: residency({ allow: [allow(origin)] }),
      }),
    });
    const response = await harness.get('/healthz');
    expect(response.status).toBe(200);
  });

  it('blocks a request whose category is under a block rule', async () => {
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: residency({
          allow: [allow(origin, { jurisdiction: 'US' })],
          categories: { IBAN: 'block' },
        }),
      }),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'IBAN DE89370400440532013000 bitte' }],
    });

    expect(response.status).toBe(403);
    const payload = (await response.json()) as {
      error: { type: string; rule: string; jurisdiction: string; counts: Record<string, number> };
    };
    expect(payload.error.type).toBe('hushgate_residency_blocked');
    expect(payload.error.rule).toBe('residency.categories.IBAN');
    expect(payload.error.jurisdiction).toBe('US');
    expect(payload.error.counts).toEqual({ IBAN: 1 });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('still forwards a request with nothing to block in it', async () => {
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: residency({ allow: [allow(origin)], mode: 'block' }),
      }),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'no personal data here' }],
    });
    expect(response.status).toBe(200);
    expect(harness.upstream.requests).toHaveLength(1);
  });

  it('sends the data unchanged in warn mode, and says that it did', async () => {
    const warnings: string[] = [];
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: residency({ allow: [allow(origin)], mode: 'warn' }),
      }),
      proxy: { onWarning: (message) => warnings.push(message) },
    });

    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'mail johan@example.com' }],
    });

    expect(harness.upstream.lastRequest!.body).toContain('johan@example.com');
    expect(warnings[0]).toContain('warn');
    expect(warnings[0]).toContain('EMAIL (1)');
    // The warning reports the category, never the address.
    expect(warnings[0]).not.toContain('johan@example.com');
  });

  it('records the residency decision in the audit trail', async () => {
    const records: unknown[] = [];
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: residency({ allow: [allow(origin, { jurisdiction: 'DE' })] }),
      }),
      proxy: {
        audit: {
          write: (record) => records.push(record),
          close: () => Promise.resolve(),
        },
      },
    });

    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'a@x.de' }],
    });

    expect(records[0]).toMatchObject({
      residency: { mode: 'sanitize', rule: 'residency.mode', jurisdiction: 'DE' },
    });
  });
});
