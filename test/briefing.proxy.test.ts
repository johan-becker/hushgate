/**
 * The briefing as the provider sees it: through the proxy, in a real request
 * body, under the residency modes and the per-tenant overrides.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import { hashKey } from '../src/tenants/tenant.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { replyJson } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const reply = replyJson({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });

const chatBody = (text: string, system?: string): Record<string, unknown> => ({
  model: 'gpt-4o-mini',
  messages: [
    ...(system === undefined ? [] : [{ role: 'system', content: system }]),
    { role: 'user', content: text },
  ],
});

/** The messages the fake provider received for request `index`. */
const sentMessages = (index = 0): { role: string; content: string }[] =>
  (JSON.parse(harness!.upstream.requests[index]!.body) as {
    messages: { role: string; content: string }[];
  }).messages;

describe('the briefing on the wire', () => {
  it('reaches the provider when a request carried personal data', async () => {
    harness = await startHarness({ handler: reply });
    await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));

    const messages = sentMessages();
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('e-mail addresses ([EMAIL_n])');
    expect(messages[1]?.content).toContain('[EMAIL_1]');
  });

  it('is absent from a request nothing was found in', async () => {
    harness = await startHarness({ handler: reply });
    await harness.post('/v1/chat/completions', chatBody('what is the capital of France'));

    expect(sentMessages()).toEqual([
      { role: 'user', content: 'what is the capital of France' },
    ]);
  });

  it('never carries a real value, only the categories', async () => {
    harness = await startHarness({ handler: reply });
    await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));

    expect(sentMessages()[0]!.content).not.toContain('johan@example.com');
    expect(sentMessages()[0]!.content).not.toContain('johan');
  });

  it('sits after the caller’s own system prompt, which is untouched', async () => {
    harness = await startHarness({ handler: reply });
    await harness.post(
      '/v1/chat/completions',
      chatBody('mail johan@example.com', 'You are Acme support.'),
    );

    const messages = sentMessages();
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Acme support.' });
    expect(messages[1]?.content).toContain('placeholder');
    expect(messages[2]?.content).toContain('[EMAIL_1]');
  });

  it('goes into the system field on the Anthropic route', async () => {
    harness = await startHarness({ handler: replyJson({ content: [{ type: 'text', text: 'ok' }] }) });
    await harness.post('/v1/messages', {
      model: 'claude-sonnet-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'mail johan@example.com' }],
    });

    const body = JSON.parse(harness.upstream.requests[0]!.body) as { system: string };
    expect(body.system).toContain('e-mail addresses ([EMAIL_n])');
  });

  it('is left off in warn mode, where the caller’s own text is forwarded', async () => {
    // Nothing was replaced, so there are no placeholders to explain; a briefing
    // here would describe tokens the provider cannot see.
    harness = await startHarness({
      handler: reply,
      config: (base) => ({
        ...base,
        residency: { ...base.residency, mode: 'warn' },
      }),
      proxy: { onWarning: () => {} },
    });
    await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));

    const messages = sentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('mail johan@example.com');
  });

  it('honours a mode of off', async () => {
    harness = await startHarness({
      handler: reply,
      config: (base) => ({ ...base, briefing: { mode: 'off', text: null, append: null } }),
    });
    await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));

    expect(sentMessages()).toHaveLength(1);
  });

  it('honours a mode of always on a request with nothing in it', async () => {
    harness = await startHarness({
      handler: reply,
      config: (base) => ({ ...base, briefing: { mode: 'always', text: null, append: null } }),
    });
    await harness.post('/v1/chat/completions', chatBody('hello'));

    expect(sentMessages()[0]?.content).toContain('A placeholder is written [KIND_n]');
  });

  it('gives a tenant its own house rules', async () => {
    const base = defaultConfig();
    harness = await startHarness({
      handler: reply,
      config: (config) => ({
        ...config,
        host: '127.0.0.1',
        tenants: [
          {
            id: 'support',
            name: 'support',
            keyHashes: [hashKey('hg_test')],
            redaction: base.redaction,
            briefing: { mode: 'auto', text: null, append: 'Answer in German.' },
            quotas: { requestsPerMinute: null, tokensPerDay: null },
            auditPath: null,
            upstreamKeyEnv: null,
          },
        ],
      }),
    });

    await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'), {
      authorization: 'Bearer hg_test',
    });

    const briefing = sentMessages()[0]!.content;
    expect(briefing).toContain('e-mail addresses');
    expect(briefing.endsWith('Answer in German.')).toBe(true);
  });

  it('does not stop the reply being re-hydrated', async () => {
    harness = await startHarness({
      handler: (request) => {
        const body = request.json as { messages: { content: string }[] };
        const echoed = body.messages.at(-1)!.content;
        return {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: echoed } }] }),
        };
      },
    });

    const response = await harness.post('/v1/chat/completions', chatBody('mail johan@example.com'));
    const payload = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(payload.choices[0]!.message.content).toBe('mail johan@example.com');
  });
});
