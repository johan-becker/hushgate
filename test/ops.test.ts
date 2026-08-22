import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  BlockedContentError,
  QuotaExceededError,
  RequestError,
  UpstreamError,
} from '../src/errors.js';
import { defaultConfig } from '../src/config.js';
import { Metrics } from '../src/metrics/registry.js';
import { withRetry } from '../src/proxy/retry.js';
import { reportFailure } from '../src/proxy/server.js';
import type { UpstreamClient, UpstreamResponse } from '../src/proxy/upstream.js';
import { Session } from '../src/redact/session.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { replyJson } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const ok = { status: 200, headers: {}, body: null } as unknown as UpstreamResponse;
const request = {
  url: 'http://127.0.0.1/v1/chat/completions',
  method: 'POST',
  headers: {},
  body: '{}',
  timeoutMs: 1000,
};

const noSleep = { sleep: (): Promise<void> => Promise.resolve(), random: (): number => 0.5 };

const alwaysFails: UpstreamClient = () => Promise.reject(new UpstreamError('t', 'timeout'));
const notAnUpstreamError: UpstreamClient = () => Promise.reject(new TypeError('bug'));

/** A document of roughly `sizeKb` kilobytes with personal data sprinkled in. */
function document(sizeKb: number): string {
  const paragraph = [
    'Sehr geehrte Frau Schmidt, wir haben Ihre Anfrage vom 12. Februar erhalten.',
    'Bitte bestätigen Sie die Adresse anna.schmidt@example.de und die IBAN',
    'DE89 3704 0044 0532 0130 00. Rückfragen unter +49 721 1234567 oder an',
    'support@example.com. Server 10.0.0.42, MAC 00:1A:2B:3C:4D:5E.',
    'Ansonsten bleibt der Text gewöhnliche Prosa ohne besondere Merkmale.',
  ].join(' ');

  const target = sizeKb * 1024;
  let text = '';
  while (text.length < target) text += `${paragraph}\n`;
  return text.slice(0, target);
}

/** Milliseconds to redact `text` in a fresh session, best of `runs`. */
function timeRedaction(text: string, runs = 3): number {
  let best = Infinity;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    new Session().redact(text);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Text with a finding roughly every eight characters, which is what makes the
 * *resolution* phase rather than the regex phase decide the runtime. Ordinary
 * prose dilutes a quadratic resolver enough to hide it completely.
 */
function dense(count: number): string {
  return '1.1.1.1 '.repeat(count);
}

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      return Promise.resolve(ok);
    };

    await withRetry(client, { retries: 3, backoffMs: 10, ...noSleep })(request);
    expect(calls).toBe(1);
  });

  it('retries a connection failure and succeeds', async () => {
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      if (calls < 3) return Promise.reject(new UpstreamError('refused', 'network'));
      return Promise.resolve(ok);
    };

    await expect(
      withRetry(client, { retries: 3, backoffMs: 10, ...noSleep })(request),
    ).resolves.toBe(ok);
    expect(calls).toBe(3);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      return Promise.reject(new UpstreamError('refused', 'network'));
    };

    await expect(
      withRetry(client, { retries: 2, backoffMs: 10, ...noSleep })(request),
    ).rejects.toThrow(UpstreamError);
    expect(calls).toBe(3);
  });

  it('backs off exponentially, with jitter', async () => {
    const delays: number[] = [];

    await expect(
      withRetry(alwaysFails, {
        retries: 3,
        backoffMs: 100,
        random: () => 1,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
      })(request),
    ).rejects.toThrow(UpstreamError);

    expect(delays).toEqual([100, 200, 400]);
  });

  it('never retries when retries is zero', async () => {
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      return Promise.reject(new UpstreamError('refused', 'network'));
    };

    await expect(withRetry(client, { retries: 0, backoffMs: 10, ...noSleep })(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('does not swallow an error that is not an upstream failure', async () => {
    await expect(
      withRetry(notAnUpstreamError, { retries: 3, backoffMs: 10, ...noSleep })(request),
    ).rejects.toThrow(TypeError);
  });

  it('retries an unreachable upstream through the real proxy', async () => {
    const warnings: string[] = [];
    harness = await startHarness({
      config: (base) => ({
        ...base,
        upstreams: { openai: 'http://127.0.0.1:1', anthropic: 'http://127.0.0.1:1' },
        limits: { ...base.limits, upstreamRetries: 2, retryBackoffMs: 1 },
      }),
      proxy: { onWarning: (message) => warnings.push(message) },
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(502);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('retrying in');
  });
});

describe('metrics', () => {
  it('renders the exposition format', () => {
    const metrics = new Metrics([0.1, 1]);
    metrics.observeRequest({
      route: 'openai.chat.completions',
      outcome: 'forwarded',
      tenant: 'support',
      status: 200,
      latencyMs: 500,
      tokens: 120,
      findings: { EMAIL: 2 },
      policies: { EMAIL: 'pseudonymize' },
    });

    const text = metrics.render();
    expect(text).toContain('# TYPE hushgate_requests_total counter');
    expect(text).toContain(
      'hushgate_requests_total{outcome="forwarded",route="openai.chat.completions",status="200",tenant="support"} 1',
    );
    expect(text).toContain('hushgate_findings_total{kind="EMAIL",policy="pseudonymize"} 2');
    expect(text).toContain('hushgate_upstream_tokens_total{route="openai.chat.completions",tenant="support"} 120');
    expect(text).toContain('hushgate_build_info{version=');
  });

  it('accumulates a histogram correctly', () => {
    const metrics = new Metrics([0.1, 1, 10]);
    for (const latencyMs of [50, 500, 5000]) {
      metrics.observeRequest({
        route: 'r',
        outcome: 'forwarded',
        tenant: null,
        status: 200,
        latencyMs,
        tokens: 0,
        findings: {},
        policies: {},
      });
    }

    const text = metrics.render();
    expect(text).toContain('hushgate_request_duration_seconds_bucket{route="r",le="0.1"} 1');
    expect(text).toContain('hushgate_request_duration_seconds_bucket{route="r",le="1"} 2');
    expect(text).toContain('hushgate_request_duration_seconds_bucket{route="r",le="10"} 3');
    expect(text).toContain('hushgate_request_duration_seconds_bucket{route="r",le="+Inf"} 3');
    expect(text).toContain('hushgate_request_duration_seconds_count{route="r"} 3');
  });

  it('labels an unauthenticated request as tenant none', () => {
    const metrics = new Metrics();
    metrics.observeRequest({
      route: 'r',
      outcome: 'forwarded',
      tenant: null,
      status: 200,
      latencyMs: 1,
      tokens: 0,
      findings: {},
      policies: {},
    });
    expect(metrics.render()).toContain('tenant="none"');
  });

  it('renders every sample value as a parsable number', () => {
    const metrics = new Metrics();
    // 1000 x 10 ms accumulates to 9.999999999999831 seconds, not an integer,
    // which rounds to "10.000000" at six decimals. Trimming the zeros without
    // the separator would emit the bare "10." — tolerated by Go's ParseFloat,
    // rejected by the OpenMetrics grammar.
    for (let i = 0; i < 1000; i++) {
      metrics.observeRequest({
        route: 'r',
        outcome: 'forwarded',
        tenant: null,
        status: 200,
        latencyMs: 10,
        tokens: 0,
        findings: {},
        policies: {},
      });
    }

    const sum = /^hushgate_request_duration_seconds_sum\{route="r"\} (.+)$/mu.exec(
      metrics.render(),
    );
    expect(sum).not.toBeNull();
    expect(sum![1]).toBe('10');
    expect(Number.isFinite(Number(sum![1]))).toBe(true);

    for (const line of metrics.render().split('\n')) {
      if (line.length === 0 || line.startsWith('#')) continue;
      const value = line.slice(line.lastIndexOf(' ') + 1);
      expect(value).toMatch(/^-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?$/u);
    }
  });

  it('counts refusals by the rule that refused them', () => {
    const metrics = new Metrics();
    metrics.observeBlocked('residency', 'residency.categories.IBAN');
    metrics.observeBlocked('policy', 'redaction.policies');
    expect(metrics.render()).toContain(
      'hushgate_blocked_total{reason="residency",rule="residency.categories.IBAN"} 1',
    );
  });

  it('serves them over HTTP after real traffic', async () => {
    harness = await startHarness({ handler: replyJson({ ok: true }) });

    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'mail a@x.de and b@x.de' }],
    });

    const response = await harness.get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();
    expect(text).toContain('hushgate_requests_total{outcome="forwarded"');
    expect(text).toContain('hushgate_findings_total{kind="EMAIL",policy="pseudonymize"} 2');
    // Counts, never values.
    expect(text).not.toContain('a@x.de');
  });

  it('requires a tenant key once tenants exist', async () => {
    harness = await startHarness({
      config: (base) => ({
        ...base,
        tenants: [
          {
            id: 'a',
            name: 'a',
            keyHashes: ['0'.repeat(64)],
            redaction: defaultConfig().redaction,
            quotas: { requestsPerMinute: null, tokensPerDay: null },
            auditPath: null,
            upstreamKeyEnv: null,
          },
        ],
      }),
    });

    expect((await harness.get('/metrics')).status).toBe(401);
  });

  it('rejects the wrong method', async () => {
    harness = await startHarness();
    const response = await harness.post('/metrics', {});
    expect(response.status).toBe(405);
  });
});

/** Collect what the failure sink was handed, instead of writing to the terminal. */
function capture(error: unknown): unknown[] {
  const logged: unknown[] = [];
  reportFailure(error, (value) => logged.push(value));
  return logged;
}

describe('reportFailure', () => {
  it('reports a policy refusal as one line, not a stack trace', () => {
    expect(capture(new BlockedContentError({ SECRET: 1 }))).toEqual([
      'hushgate: request blocked by policy: SECRET (1)',
    ]);
  });

  it('reports a rejected key and an exhausted quota the same way', () => {
    expect(capture(new AuthenticationError('no tenant key presented'))).toEqual([
      'hushgate: no tenant key presented',
    ]);
    expect(
      capture(new QuotaExceededError('support is over its quota', 'support', 'requests', 60, 30)),
    ).toEqual(['hushgate: support is over its quota']);
  });

  it('reports a rejected request as one line, whatever its 4xx status', () => {
    expect(capture(new RequestError(413, 'body_too_large', 'body exceeds 4194304 bytes'))).toEqual([
      'hushgate: body exceeds 4194304 bytes',
    ]);
  });

  it('keeps the whole error for an upstream failure, whose cause is the point', () => {
    const error = new UpstreamError('upstream did not answer in time', 'timeout');
    expect(capture(error)).toEqual([error]);
  });

  it('keeps the whole error for a failure nothing mapped, so a real bug still shows', () => {
    const bug = new TypeError('cannot read properties of undefined');
    expect(capture(bug)).toEqual([bug]);
  });

  it('does not print a stack when the proxy refuses a blocked request', async () => {
    const logged: unknown[] = [];
    harness = await startHarness({
      config: (base) => ({
        ...base,
        redaction: { ...base.redaction, policies: { SECRET: 'block' } },
      }),
      proxy: { onInternalError: (error) => reportFailure(error, (value) => logged.push(value)) },
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'token sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA' }],
    });

    expect(response.status).toBe(403);
    expect(logged).toEqual(['hushgate: request blocked by policy: SECRET (1)']);
  });
});

describe('the hot path stays linear', () => {
  it('processes a large document within a sane budget', () => {
    const session = new Session({ dictionary: { names: ['Anna Schmidt'] } });
    const text = document(512);

    const started = performance.now();
    const { text: redacted, findings } = session.redact(text);
    const elapsed = performance.now() - started;

    expect(findings.length).toBeGreaterThan(1000);
    expect(redacted).not.toContain('anna.schmidt@example.de');
    // Generous, because CI machines are not benchmarking rigs — but tight
    // enough that a real regression trips it. 512 KiB of this prose costs a
    // few hundred milliseconds.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('does not degrade super-linearly as the input grows', () => {
    // Warm the JIT so the first measurement is not the slow one.
    timeRedaction(document(128), 1);

    // An 8x step, not 2x. A doubling cannot separate linear from quadratic on
    // a shared CI runner: linear predicts 2x and quadratic 4x, and ordinary
    // scheduling jitter on a small sample covers that whole gap -- measured at
    // 2.59 and 3.05 on two consecutive runs of this very suite, against a
    // correct implementation. Over 8x the prediction is 8x against 64x, so a
    // threshold of 20 has an order of magnitude of headroom on both sides:
    // noise cannot reach it, and the quadratic resolver this test was written
    // for cannot fit under it.
    const small = timeRedaction(document(128), 5);
    const large = timeRedaction(document(1_024), 3);

    expect(large / small).toBeLessThan(20);
  });

  it('stays linear when almost every character is part of a finding', () => {
    // The prose fixture above carries one finding per ~45 bytes, which lets the
    // linear regex phase mask a quadratic resolver. This one carries one per 8.
    timeRedaction(dense(4_000), 1);

    const small = timeRedaction(dense(8_000));
    const large = timeRedaction(dense(32_000));

    expect(new Session().redact(dense(8_000)).findings.length).toBe(8_000);
    // Four times the findings, well under six times the work.
    expect(large / small).toBeLessThan(6);
  });

  it('resolves a body at the default size limit in a sane time', () => {
    // 4 MiB is limits.maxBodyBytes, so this is a request readBody accepts. The
    // proxy is single-threaded: whatever this costs, every other tenant waits.
    const text = dense(512_000);
    const started = performance.now();
    const { findings } = new Session().redact(text);
    const elapsed = performance.now() - started;

    expect(findings.length).toBe(512_000);
    expect(elapsed).toBeLessThan(10_000);
  });
});
