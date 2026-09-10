import { afterEach, describe, expect, it } from 'vitest';
import type { BriefingConfig } from '../src/briefing/index.js';
import type { PlaygroundEndpoint, PlaygroundOptions } from '../src/playground/index.js';
import { TrialStore } from '../src/playground/session.js';
import { startFakeUpstream, type FakeHandler, type FakeUpstream } from './helpers/fake-upstream.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

const LETTER = 'Write to k.vogelsang@nordwerk-gmbh.de about DE89 3704 0044 0532 0130 00 please.';

/** An OpenAI-shaped stream that cuts "[EMAIL_1]" in half between two events. */
const SPLIT_PLACEHOLDER: FakeHandler = () => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: '',
  chunks: [
    'data: {"choices":[{"delta":{"content":"I will write to [EMA"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"IL_1] today."}}]}\n\n',
    'data: [DONE]\n\n',
  ],
});

const open: { harness?: Harness; upstream?: FakeUpstream }[] = [];
afterEach(async () => {
  const closing = open.splice(0).flatMap((entry) => [entry.harness?.close(), entry.upstream?.close()]);
  await Promise.all(closing);
});

/** A proxy whose trial page forwards to a fake provider we control. */
async function trial(
  handler: FakeHandler,
  endpointOver: Partial<PlaygroundEndpoint> = {},
  briefing?: BriefingConfig,
): Promise<{ harness: Harness; upstream: FakeUpstream; store: TrialStore }> {
  const upstream = await startFakeUpstream(handler);
  const store = new TrialStore();

  const endpoint: PlaygroundEndpoint = {
    label: 'a local provider',
    baseUrl: upstream.origin,
    api: 'openai',
    trialModel: 'gpt-4o-mini',
    ...endpointOver,
  };

  const playground: PlaygroundOptions = {
    store,
    apiKey: 'sk-from-the-terminal',
    endpoint,
    dictionaryIsEmpty: true,
    ...(briefing === undefined ? {} : { briefing }),
  };

  const harness = await startHarness({ proxy: { playground } });
  open.push({ harness, upstream });
  return { harness, upstream, store };
}

/** Open a session by previewing, and return its id. */
async function preview(harness: Harness, text = LETTER): Promise<string> {
  const response = await harness.post('/__playground/preview', { text });
  const body = (await response.json()) as { sessionId: string };
  return body.sessionId;
}

/** Collect an SSE body into its two channels. */
async function collect(response: Response): Promise<{ raw: string; hydrated: string; done: boolean }> {
  const text = await response.text();
  const out = { raw: '', hydrated: '', done: false };

  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/mu.exec(block)?.[1]?.trim();
    const data = /^data: (.*)$/mu.exec(block)?.[1];
    if (name === undefined) continue;
    if (name === 'done') {
      out.done = true;
      continue;
    }
    if (data === undefined) continue;

    const delta = (JSON.parse(data) as { delta?: string }).delta ?? '';
    if (name === 'raw') out.raw += delta;
    if (name === 'hydrated') out.hydrated += delta;
  }

  return out;
}

describe('POST /__playground/send', () => {
  it('streams the reply raw and rehydrated, across a split placeholder', async () => {
    const { harness } = await trial(SPLIT_PLACEHOLDER);
    const sessionId = await preview(harness);

    const response = await harness.post('/__playground/send', { sessionId });
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const { raw, hydrated, done } = await collect(response);
    expect(raw).toBe('I will write to [EMAIL_1] today.');
    expect(hydrated).toBe('I will write to k.vogelsang@nordwerk-gmbh.de today.');
    expect(done).toBe(true);
  });

  it('sends the sanitised text upstream, never the original', async () => {
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER);
    const sessionId = await preview(harness);
    await harness.post('/__playground/send', { sessionId });

    const seen = upstream.lastRequest?.body ?? '';
    expect(seen).toContain('[EMAIL_1]');
    expect(seen).toContain('[IBAN_1]');
    expect(seen).not.toContain('vogelsang');
    expect(seen).not.toContain('0532 0130 00');
  });

  it('asks for a stream, with the model the session carries', async () => {
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER);
    const response = await harness.post('/__playground/preview', {
      text: LETTER,
      model: 'gpt-4o',
    });
    const { sessionId } = (await response.json()) as { sessionId: string };

    await harness.post('/__playground/send', { sessionId });

    const body = JSON.parse(upstream.lastRequest?.body ?? '{}') as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o');
    expect(body['stream']).toBe(true);
    expect(upstream.lastRequest?.path).toBe('/v1/chat/completions');
  });

  it('carries the key the CLI holds, and ignores one offered by the page', async () => {
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER);
    const sessionId = await preview(harness);

    await harness.post('/__playground/send', {
      sessionId,
      apiKey: 'sk-injected-by-a-page',
    });

    expect(upstream.lastRequest?.headers['authorization']).toBe('Bearer sk-from-the-terminal');
    expect(upstream.lastRequest?.body ?? '').not.toContain('sk-injected-by-a-page');
  });

  it('speaks the Anthropic shape when the endpoint does', async () => {
    const { harness, upstream } = await trial(
      () => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: '',
        chunks: [
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Mailing [EMAIL_1]."}}\n\n',
        ],
      }),
      { api: 'anthropic', trialModel: 'claude-sonnet-5' },
    );

    const sessionId = await preview(harness);
    const { raw, hydrated } = await collect(
      await harness.post('/__playground/send', { sessionId }),
    );

    expect(upstream.lastRequest?.path).toBe('/v1/messages');
    expect(upstream.lastRequest?.headers['x-api-key']).toBe('sk-from-the-terminal');
    expect(raw).toBe('Mailing [EMAIL_1].');
    expect(hydrated).toBe('Mailing k.vogelsang@nordwerk-gmbh.de.');
  });

  it('answers 404 for a session it never issued', async () => {
    const { harness } = await trial(SPLIT_PLACEHOLDER);
    expect((await harness.post('/__playground/send', { sessionId: 'nope' })).status).toBe(404);
  });

  it('reports an upstream refusal rather than pretending it streamed', async () => {
    const { harness } = await trial(() => ({
      status: 401,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'bad key' }),
    }));

    const sessionId = await preview(harness);
    const response = await harness.post('/__playground/send', { sessionId });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('401');
  });

  it('is not reachable when the playground is not mounted', async () => {
    const harness = await startHarness();
    open.push({ harness });
    expect((await harness.post('/__playground/send', { sessionId: 'x' })).status).toBe(404);
  });
});

describe('the briefing the trial sends', () => {
  it('goes to the provider with the sanitised text, as serve would send it', async () => {
    // The trial exists to show the round trip as it will really behave. A trial
    // that skipped the briefing would demo the answer the briefing prevents.
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER);
    const sessionId = await preview(harness);
    await harness.post('/__playground/send', { sessionId });

    const body = JSON.parse(upstream.requests[0]!.body) as {
      messages: { role: string; content: string }[];
    };

    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('e-mail addresses ([EMAIL_n])');
    expect(body.messages.at(-1)?.content).toContain('[EMAIL_1]');
    // Still nothing real, on either message.
    expect(upstream.requests[0]!.body).not.toContain('k.vogelsang');
  });

  it('is left off a request nothing was found in', async () => {
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER);
    const sessionId = await preview(harness, 'What is the capital of France?');
    await harness.post('/__playground/send', { sessionId });

    const body = JSON.parse(upstream.requests[0]!.body) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });

  it('honours a configuration that switches it off', async () => {
    const { harness, upstream } = await trial(SPLIT_PLACEHOLDER, {}, { mode: 'off', text: null, append: null });
    const sessionId = await preview(harness);
    await harness.post('/__playground/send', { sessionId });

    const body = JSON.parse(upstream.requests[0]!.body) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });
});
