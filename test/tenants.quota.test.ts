import { afterEach, describe, expect, it } from 'vitest';
import { QuotaExceededError } from '../src/errors.js';
import { defaultConfig, type HushgateConfig } from '../src/config.js';
import { tokensFrom } from '../src/proxy/usage.js';
import { Metrics } from '../src/metrics/registry.js';
import { QuotaTracker, utcDay } from '../src/tenants/quota.js';
import { hashKey, type Tenant } from '../src/tenants/tenant.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import type { FakeReply } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const tenant = (id: string, key: string, quotas: Partial<Tenant['quotas']> = {}): Tenant => ({
  id,
  name: id,
  keyHashes: [hashKey(key)],
  redaction: defaultConfig().redaction,
  quotas: { requestsPerMinute: null, tokensPerDay: null, ...quotas },
  auditPath: null,
  upstreamKeyEnv: null,
});

const chat = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

describe('tokensFrom', () => {
  it('reads the OpenAI shape', () => {
    expect(tokensFrom({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toBe(
      15,
    );
    expect(tokensFrom({ usage: { prompt_tokens: 10, completion_tokens: 5 } })).toBe(15);
  });

  it('reads the Anthropic shape, including the streamed halves', () => {
    expect(tokensFrom({ usage: { input_tokens: 12, output_tokens: 8 } })).toBe(20);
    expect(tokensFrom({ type: 'message_start', message: { usage: { input_tokens: 12 } } })).toBe(12);
    expect(tokensFrom({ type: 'message_delta', usage: { output_tokens: 8 } })).toBe(8);
  });

  it('is zero when nothing was reported', () => {
    expect(tokensFrom({ choices: [] })).toBe(0);
    expect(tokensFrom({ usage: null })).toBe(0);
    expect(tokensFrom('a string')).toBe(0);
    expect(tokensFrom({ usage: { total_tokens: 'lots' } })).toBe(0);
  });
});

describe('QuotaTracker', () => {
  it('admits requests up to the limit and then refuses', () => {
    const now = 1_000_000;
    const tracker = new QuotaTracker(() => now);
    const team = tenant('a', 'hg_a', { requestsPerMinute: 3 });

    for (let i = 0; i < 3; i += 1) tracker.admit(team);
    expect(() => tracker.admit(team)).toThrow(QuotaExceededError);
  });

  it('says how long to wait, and is right', () => {
    let now = 1_000_000;
    const tracker = new QuotaTracker(() => now);
    const team = tenant('a', 'hg_a', { requestsPerMinute: 1 });

    tracker.admit(team);
    now += 20_000;

    try {
      tracker.admit(team);
      expect.unreachable('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError);
      const quota = error as QuotaExceededError;
      expect(quota.scope).toBe('requests');
      expect(quota.limit).toBe(1);
      expect(quota.retryAfterSeconds).toBe(40);
    }

    now += 41_000;
    expect(() => tracker.admit(team)).not.toThrow();
  });

  it('slides the window rather than resetting it on the minute', () => {
    let now = 1_000_000;
    const tracker = new QuotaTracker(() => now);
    const team = tenant('a', 'hg_a', { requestsPerMinute: 2 });

    tracker.admit(team);
    now += 30_000;
    tracker.admit(team);
    now += 31_000; // the first request has aged out, the second has not
    expect(() => tracker.admit(team)).not.toThrow();
    expect(() => tracker.admit(team)).toThrow(QuotaExceededError);
  });

  it('keeps tenants apart', () => {
    const tracker = new QuotaTracker(() => 1_000_000);
    const a = tenant('a', 'hg_a', { requestsPerMinute: 1 });
    const b = tenant('b', 'hg_b', { requestsPerMinute: 1 });

    tracker.admit(a);
    expect(() => tracker.admit(b)).not.toThrow();
    expect(() => tracker.admit(a)).toThrow(QuotaExceededError);
  });

  it('refuses once the daily token allowance is spent', () => {
    const tracker = new QuotaTracker(() => Date.UTC(2026, 2, 4, 12));
    const team = tenant('a', 'hg_a', { tokensPerDay: 100 });

    tracker.admit(team);
    tracker.recordTokens('a', 120);
    expect(() => tracker.admit(team)).toThrow(/daily allowance of 100 tokens/u);
  });

  it('counts the day in UTC and starts again at midnight', () => {
    let now = Date.UTC(2026, 2, 4, 23, 59, 0);
    const tracker = new QuotaTracker(() => now);
    const team = tenant('a', 'hg_a', { tokensPerDay: 100 });

    tracker.recordTokens('a', 500);
    expect(() => tracker.admit(team)).toThrow(QuotaExceededError);
    expect(tracker.usage('a').day).toBe('2026-03-04');

    now = Date.UTC(2026, 2, 5, 0, 1, 0);
    expect(() => tracker.admit(team)).not.toThrow();
    expect(tracker.usage('a')).toMatchObject({ tokensToday: 0, day: '2026-03-05' });
  });

  it('says how long until the allowance renews', () => {
    const now = Date.UTC(2026, 2, 4, 23, 0, 0);
    const tracker = new QuotaTracker(() => now);
    const team = tenant('a', 'hg_a', { tokensPerDay: 10 });
    tracker.recordTokens('a', 10);

    try {
      tracker.admit(team);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as QuotaExceededError).retryAfterSeconds).toBe(3600);
    }
  });

  it('does nothing when no quota is configured', () => {
    const tracker = new QuotaTracker(() => 0);
    const team = tenant('a', 'hg_a');
    for (let i = 0; i < 1000; i += 1) tracker.admit(team);
    expect(tracker.usage('a').requestsInWindow).toBe(1000);
  });

  it('names the UTC day', () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 3, 4))).toBe('2026-01-02');
  });
});

const withTenant =
  (team: Tenant) =>
  (base: HushgateConfig): HushgateConfig => ({ ...base, tenants: [team] });

describe('quotas at the proxy', () => {
  it('answers 429 with a retry-after header', async () => {
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a', { requestsPerMinute: 1 })),
    });

    const first = await harness.post('/v1/chat/completions', chat, {
      authorization: 'Bearer hg_a',
    });
    const second = await harness.post('/v1/chat/completions', chat, {
      authorization: 'Bearer hg_a',
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0);

    const payload = (await second.json()) as {
      error: { type: string; scope: string; limit: number };
    };
    expect(payload.error.type).toBe('rate_limit_error');
    expect(payload.error.scope).toBe('requests');
    expect(payload.error.limit).toBe(1);

    // The refused request never reached the provider.
    expect(harness.upstream.requests).toHaveLength(1);
  });

  it('counts the tokens the provider reported', async () => {
    const records: { tokens: number }[] = [];
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a', { tokensPerDay: 50 })),
      handler: (): FakeReply => ({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ usage: { prompt_tokens: 40, completion_tokens: 20 } }),
      }),
      proxy: {
        audit: {
          write: (record) => records.push(record as unknown as { tokens: number }),
          close: () => Promise.resolve(),
        },
      },
    });

    const first = await harness.post('/v1/chat/completions', chat, {
      authorization: 'Bearer hg_a',
    });
    expect(first.status).toBe(200);
    expect(records[0]!.tokens).toBe(60);

    // 60 of 50 spent: the next request is refused, and says why.
    const second = await harness.post('/v1/chat/completions', chat, {
      authorization: 'Bearer hg_a',
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { scope: string } }).error.scope).toBe('tokens');
  });

  it('counts the tokens a stream reported', async () => {
    const records: { tokens: number }[] = [];
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a', { tokensPerDay: 1000 })),
      handler: (): FakeReply => ({
        headers: { 'content-type': 'text/event-stream' },
        body: '',
        chunks: [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":30}}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'data: {"type":"message_delta","usage":{"output_tokens":12}}\n\n',
        ],
      }),
      proxy: {
        audit: {
          write: (record) => records.push(record as unknown as { tokens: number }),
          close: () => Promise.resolve(),
        },
      },
    });

    const response = await harness.post(
      '/v1/messages',
      { ...chat, stream: true },
      { authorization: 'Bearer hg_a' },
    );
    await response.text();

    expect(records[0]!.tokens).toBe(42);
  });

  it('leaves single-tenant operation unmetered', async () => {
    harness = await startHarness();
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await harness.post('/v1/chat/completions', chat);
      expect(response.status).toBe(200);
    }
  });
});

describe('a refused request is as auditable as a served one', () => {
  interface Recorded {
    readonly outcome: string;
    readonly status: number;
    readonly tenant: string | null;
    readonly upstream: string | null;
  }

  const collector = (
    into: Recorded[],
  ): { write: (record: unknown) => void; close: () => Promise<void> } => ({
    write: (record) => into.push(record as Recorded),
    close: () => Promise.resolve(),
  });

  it('records a rejected tenant key', async () => {
    const records: Recorded[] = [];
    const metrics = new Metrics();
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a')),
      proxy: { audit: collector(records), metrics },
    });

    const response = await harness.post('/v1/chat/completions', chat, {
      authorization: 'Bearer wrong',
    });

    expect(response.status).toBe(401);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'rejected',
      status: 401,
      // Which tenant it would have been is exactly what was not established.
      tenant: null,
      upstream: null,
    });
    expect(metrics.render()).toContain(
      'hushgate_requests_total{outcome="rejected",route="openai.chat.completions",status="401",tenant="none"} 1',
    );
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('records an exhausted quota', async () => {
    const records: Recorded[] = [];
    const metrics = new Metrics();
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a', { requestsPerMinute: 1 })),
      proxy: { audit: collector(records), metrics },
    });

    const key = { authorization: 'Bearer hg_a' };
    expect((await harness.post('/v1/chat/completions', chat, key)).status).toBe(200);
    expect((await harness.post('/v1/chat/completions', chat, key)).status).toBe(429);

    expect(records.map((record) => [record.outcome, record.status])).toEqual([
      ['forwarded', 200],
      ['rejected', 429],
    ]);
    expect(records[1]!.tenant).toBe('a');
    expect(records[1]!.upstream).toBeNull();

    const rendered = metrics.render();
    expect(rendered).toContain(
      'hushgate_requests_total{outcome="rejected",route="openai.chat.completions",status="429",tenant="a"} 1',
    );
    expect(rendered).toContain(
      'hushgate_requests_total{outcome="forwarded",route="openai.chat.completions",status="200",tenant="a"} 1',
    );
  });

  it('leaves a trace for every attempt of a key brute force', async () => {
    const records: Recorded[] = [];
    harness = await startHarness({
      config: withTenant(tenant('a', 'hg_a')),
      proxy: { audit: collector(records) },
    });

    const attempts = [0, 1, 2, 3, 4].map((attempt) =>
      harness!.post('/v1/chat/completions', chat, {
        authorization: `Bearer hg_guess${attempt}`,
      }),
    );
    expect((await Promise.all(attempts)).every((response) => response.status === 401)).toBe(true);

    expect(records).toHaveLength(5);
    expect(records.every((record) => record.status === 401)).toBe(true);
  });
});
