import { afterEach, describe, expect, it } from 'vitest';
import { reportFailure } from '../src/proxy/server.js';
import { VERSION } from '../src/version.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { replyJson, type FakeReply } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface ErrorEnvelope {
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly kinds?: string[];
    readonly counts?: Record<string, number>;
  };
}

const errorOf = async (response: Response): Promise<ErrorEnvelope['error']> =>
  ((await response.json()) as ErrorEnvelope).error;

const chatBody = (text: string): Record<string, unknown> => ({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: text }],
});

describe('routing', () => {
  it('answers /healthz without touching an upstream', async () => {
    harness = await startHarness();
    const response = await harness.get('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: VERSION });
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('rejects an unknown path with 404', async () => {
    harness = await startHarness();
    const response = await harness.post('/v1/embeddings', {});
    expect(response.status).toBe(404);
    expect((await errorOf(response)).type).toBe('not_found');
  });

  it('rejects the wrong method with 405 and an Allow header', async () => {
    harness = await startHarness();
    const response = await harness.get('/v1/chat/completions');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('ignores the query string when routing', async () => {
    harness = await startHarness();
    const response = await harness.post('/v1/chat/completions?beta=1', chatBody('hello'));
    expect(response.status).toBe(200);
  });
});

describe('outbound redaction', () => {
  it('never lets personal data reach the upstream', async () => {
    harness = await startHarness({
      handler: replyJson({ choices: [{ message: { content: 'done' } }] }),
    });

    await harness.post(
      '/v1/chat/completions',
      chatBody('Mail johan@example.com, IBAN DE89370400440532013000, Tel +49 721 1234567'),
    );

    const sent = harness.upstream.lastRequest!;
    expect(sent.body).not.toContain('johan@example.com');
    expect(sent.body).not.toContain('DE89370400440532013000');
    expect(sent.body).not.toContain('721');
    expect(sent.body).toContain('[EMAIL_1]');
    expect(sent.body).toContain('[IBAN_1]');
    expect(sent.body).toContain('[PHONE_1]');
  });

  it('forwards the request to the configured upstream path', async () => {
    harness = await startHarness();
    await harness.post('/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hallo' }],
    });
    expect(harness.upstream.lastRequest!.path).toBe('/v1/messages');
    expect(harness.upstream.lastRequest!.method).toBe('POST');
  });

  it('leaves the non-content fields of the request alone', async () => {
    harness = await startHarness();
    await harness.post('/v1/chat/completions', {
      ...chatBody('a@x.de'),
      temperature: 0.2,
      max_tokens: 64,
      stream: false,
    });

    const sent = harness.upstream.lastRequest!.json as Record<string, unknown>;
    expect(sent['model']).toBe('gpt-4o-mini');
    expect(sent['temperature']).toBe(0.2);
    expect(sent['max_tokens']).toBe(64);
  });

  it('passes the caller API key through and drops everything else', async () => {
    harness = await startHarness();
    await harness.post('/v1/chat/completions', chatBody('hi'), {
      authorization: 'Bearer sk-caller-key',
      cookie: 'session=abc',
      'x-forwarded-for': '203.0.113.9',
      'anthropic-version': '2023-06-01',
    });

    const headers = harness.upstream.lastRequest!.headers;
    expect(headers['authorization']).toBe('Bearer sk-caller-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['cookie']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBeUndefined();
  });

  it('recomputes the content length after rewriting the body', async () => {
    harness = await startHarness();
    await harness.post('/v1/chat/completions', chatBody('write to johan@example.com'));
    const sent = harness.upstream.lastRequest!;
    expect(sent.headers['content-length']).toBe(String(Buffer.byteLength(sent.body)));
  });
});

describe('inbound re-hydration', () => {
  it('gives the caller their own data back', async () => {
    harness = await startHarness({
      handler: (request) => {
        const body = request.json as { messages: { content: string }[] };
        const echoed = body.messages[0]!.content;
        return {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: echoed } }] }),
        };
      },
    });

    const response = await harness.post(
      '/v1/chat/completions',
      chatBody('ping johan@example.com'),
    );
    const payload = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    expect(payload.choices[0]!.message.content).toBe('ping johan@example.com');
  });

  it('re-hydrates tool call arguments in the response', async () => {
    harness = await startHarness({
      handler: replyJson({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: 'mail', arguments: '{"to":"[EMAIL_1]"}' } },
              ],
            },
          },
        ],
      }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));
    const payload = (await response.json()) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    expect(payload.choices[0]!.message.tool_calls[0]!.function.arguments).toBe(
      '{"to":"johan@example.com"}',
    );
  });

  it('preserves the upstream status and headers', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
        body: JSON.stringify({ error: { message: 'slow down' } }),
      }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('hi'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('passes a non-JSON upstream body through untouched', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        status: 502,
        headers: { 'content-type': 'text/html' },
        body: '<html>gateway</html>',
      }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('hi'));
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('<html>gateway</html>');
  });

  it('gives each request its own placeholder namespace', async () => {
    harness = await startHarness({
      handler: (request) => {
        const body = request.json as { messages: { content: string }[] };
        return {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ echo: body.messages[0]!.content }),
        };
      },
    });

    const first = await harness.post('/v1/chat/completions', chatBody('a@x.de'));
    const second = await harness.post('/v1/chat/completions', chatBody('b@x.de'));

    // Both requests start counting at 1 — the mapping does not outlive the
    // request that created it.
    expect(harness.upstream.requests[0]!.body).toContain('[EMAIL_1]');
    expect(harness.upstream.requests[1]!.body).toContain('[EMAIL_1]');
    expect(((await first.json()) as { echo: string }).echo).toBe('a@x.de');
    expect(((await second.json()) as { echo: string }).echo).toBe('b@x.de');
  });
});

describe('policy enforcement', () => {
  it('refuses a blocked request before anything leaves the machine', async () => {
    harness = await startHarness({
      config: (base) => ({
        ...base,
        redaction: { ...base.redaction, policies: { SECRET: 'block' } },
      }),
    });

    const response = await harness.post(
      '/v1/chat/completions',
      chatBody('deploy with sk-abcdefghijklmnopqrstuvwx'),
    );

    expect(response.status).toBe(403);
    const failure = await errorOf(response);
    expect(failure.type).toBe('hushgate_policy_blocked');
    expect(failure.kinds).toEqual(['SECRET']);
    expect(failure.counts).toEqual({ SECRET: 1 });
    expect(JSON.stringify(failure)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(harness.upstream.requests).toHaveLength(0);
  });
});

describe('malformed requests', () => {
  it('rejects a body that is not JSON', async () => {
    harness = await startHarness();
    const response = await harness.post('/v1/chat/completions', 'not json');
    expect(response.status).toBe(400);
    expect((await errorOf(response)).type).toBe('invalid_request_error');
  });

  it('rejects a body that is not a JSON object', async () => {
    harness = await startHarness();
    const response = await harness.post('/v1/chat/completions', '[1,2,3]');
    expect(response.status).toBe(400);
  });

  it('rejects an empty body', async () => {
    harness = await startHarness();
    const response = await harness.post('/v1/chat/completions', '');
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body with 413', async () => {
    harness = await startHarness({
      config: (base) => ({ ...base, limits: { ...base.limits, maxBodyBytes: 256 } }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('x'.repeat(4096)));
    expect(response.status).toBe(413);
    expect((await errorOf(response)).type).toBe('request_too_large');
    expect(harness.upstream.requests).toHaveLength(0);
  });

  it('rejects an absurdly nested body instead of blowing the stack', async () => {
    harness = await startHarness();
    let deep: unknown = 'bottom';
    for (let i = 0; i < 50; i += 1) deep = { next: deep };

    const response = await harness.post('/v1/chat/completions', { model: 'm', messages: deep });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/nested deeper/u);
  });

  // V8 answers this body with `Unexpected token 'A', ..."essages": Anna Schmi"...`
  // — a slice of the body, quoted before redaction has run. Repeating it would
  // echo a name back to the caller and, worse, print it to stderr, which ops
  // ships to a log aggregator that processes personal data of its own.
  it('refuses a body broken mid-name without quoting the name', async () => {
    const logged: unknown[] = [];
    harness = await startHarness({
      proxy: { onInternalError: (error) => reportFailure(error, (value) => logged.push(value)) },
    });

    const response = await harness.post('/v1/chat/completions', '{"messages": Anna Schmidt}');
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain('Anna');
    expect(raw).not.toContain('Schmi');

    const failure = (JSON.parse(raw) as ErrorEnvelope).error;
    expect(failure.type).toBe('invalid_request_error');
    expect(failure.message).toBe('request body is not valid JSON');
    expect(logged).toEqual(['hushgate: request body is not valid JSON']);
  });

  it('reports where a truncated body stopped, and nothing else the parser said', async () => {
    harness = await startHarness();

    const response = await harness.post(
      '/v1/chat/completions',
      '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Anna Schmidt',
    );
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain('Anna');
    expect(raw).not.toContain('Schmi');
    // The offset is the only part of the parser's message a client author can
    // act on, and the only part that cannot spell a person's name.
    expect((JSON.parse(raw) as ErrorEnvelope).error.message).toMatch(
      /^request body is not valid JSON \(at position \d+\)$/u,
    );
  });

  it('names no part of a body that parses but is not an object', async () => {
    harness = await startHarness();

    const response = await harness.post('/v1/chat/completions', '["Anna Schmidt"]');
    expect(response.status).toBe(400);

    const raw = await response.text();
    expect(raw).not.toContain('Anna');
    expect((JSON.parse(raw) as ErrorEnvelope).error.message).toBe(
      'request body must be a JSON object',
    );
  });
});

describe('upstream failures', () => {
  it('answers 504 when the upstream stays silent', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({ body: '', hang: true }),
      config: (base) => ({ ...base, limits: { ...base.limits, upstreamTimeoutMs: 150 } }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('hi'));
    expect(response.status).toBe(504);
    expect((await errorOf(response)).type).toBe('upstream_error');
  });

  it('answers 502 when the upstream cannot be reached', async () => {
    harness = await startHarness({
      config: (base) => ({
        ...base,
        // Port 1 is reserved and refuses immediately; still loopback only.
        upstreams: { openai: 'http://127.0.0.1:1', anthropic: 'http://127.0.0.1:1' },
      }),
    });

    const response = await harness.post('/v1/chat/completions', chatBody('hi'));
    expect(response.status).toBe(502);
  });
});

const oversized = (bytes: number): FakeReply => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ choices: [{ message: { content: 'x'.repeat(bytes) } }] }),
});

describe('the upstream response is bounded', () => {
  it('refuses a response over limits.maxResponseBytes', async () => {
    harness = await startHarness({
      handler: () => oversized(200_000),
      config: (base) => ({
        ...base,
        limits: { ...base.limits, maxResponseBytes: 64 * 1024 },
      }),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // A gateway failure, not a 500: hushgate did not decide the response.
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { type: string; message: string } };
    expect(payload.error.type).toBe('upstream_error');
    expect(payload.error.message).toMatch(/limits\.maxResponseBytes/u);
  });

  it('passes a response inside the limit through untouched', async () => {
    harness = await startHarness({
      handler: () => oversized(1_000),
      config: (base) => ({
        ...base,
        limits: { ...base.limits, maxResponseBytes: 64 * 1024 },
      }),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(payload.choices[0]!.message.content).toBe('x'.repeat(1_000));
  });
});
