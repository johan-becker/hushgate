import { afterEach, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import type { FakeReply } from './helpers/fake-upstream.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

const openAiChunk = (content: string): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;

/** Rebuild the assistant message from an OpenAI SSE response. */
function assembleOpenAi(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((payload) => payload !== '[DONE]' && payload.length > 0)
    .map((payload) => {
      const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      return parsed.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
}

/** Rebuild the assistant text from an Anthropic SSE response. */
function assembleAnthropic(body: string): string {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((payload) => payload.length > 0)
    .map((payload) => (JSON.parse(payload) as { delta?: { text?: string } }).delta?.text ?? '')
    .join('');
}

const anthropicEvent = (payload: Record<string, unknown>): string =>
  `event: ${String(payload['type'])}\ndata: ${JSON.stringify(payload)}\n\n`;

const streamRequest = (content: string): Record<string, unknown> => ({
  model: 'gpt-4o-mini',
  stream: true,
  messages: [{ role: 'user', content }],
});

describe('streaming responses', () => {
  it('re-hydrates a placeholder the model emitted one character at a time', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [
          openAiChunk('Schreib an '),
          openAiChunk('['),
          openAiChunk('EMAIL'),
          openAiChunk('_1'),
          openAiChunk(']'),
          openAiChunk(' zurück'),
          'data: [DONE]\n\n',
        ],
      }),
    });

    const response = await harness.post(
      '/v1/chat/completions',
      streamRequest('Antwort an johan@example.com'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('content-length')).toBeNull();

    const body = await response.text();
    expect(assembleOpenAi(body)).toBe('Schreib an johan@example.com zurück');
    expect(body).toContain('data: [DONE]');
    expect(harness.upstream.lastRequest!.body).toContain('[EMAIL_1]');
    expect(harness.upstream.lastRequest!.body).not.toContain('johan@example.com');
  });

  it('re-hydrates a placeholder split across transport chunks', async () => {
    const wire = [openAiChunk('an ['), openAiChunk('EMAIL_1]'), 'data: [DONE]\n\n'].join('');

    // Cut the whole wire format at a byte offset that lands mid-token.
    const cut = wire.indexOf('EMAIL') + 2;
    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [wire.slice(0, cut), wire.slice(cut)],
      }),
    });

    const response = await harness.post(
      '/v1/chat/completions',
      streamRequest('an johan@example.com'),
    );
    expect(assembleOpenAi(await response.text())).toBe('an johan@example.com');
  });

  it('delivers events as they arrive instead of buffering the stream', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [openAiChunk('erste '), openAiChunk('zweite '), openAiChunk('dritte')],
        chunkDelayMs: 60,
      }),
    });

    const started = Date.now();
    const response = await harness.post('/v1/chat/completions', streamRequest('hallo'));
    const reader = response.body!.getReader();

    const first = await reader.read();
    const firstByteAfterMs = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain('erste');

    // The upstream needs ~180 ms to finish; the first event must not wait for it.
    expect(firstByteAfterMs).toBeLessThan(150);
    await reader.cancel();
  });

  it('does not lose text when the stream ends mid-token', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [openAiChunk('ende ['), openAiChunk('EMAIL_')],
      }),
    });

    const response = await harness.post('/v1/chat/completions', streamRequest('x'));
    expect(assembleOpenAi(await response.text())).toBe('ende [EMAIL_');
  });

  it('re-hydrates an Anthropic content block stream', async () => {
    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [
          anthropicEvent({ type: 'message_start', message: { id: 'msg_1' } }),
          anthropicEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Konto [IB' },
          }),
          anthropicEvent({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'AN_1] geprüft' },
          }),
          anthropicEvent({ type: 'content_block_stop', index: 0 }),
          anthropicEvent({ type: 'message_stop' }),
        ],
      }),
    });

    const response = await harness.post('/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'Konto DE89370400440532013000 prüfen' }],
    });

    const body = await response.text();
    expect(assembleAnthropic(body)).toBe('Konto DE89370400440532013000 geprüft');
    expect(body).not.toContain('[IB');
    expect(harness.upstream.lastRequest!.body).toContain('[IBAN_1]');
  });

  it('keeps multi-byte characters intact when they straddle chunks', async () => {
    const wire = openAiChunk('Grüße aus München');
    const bytes = Buffer.from(wire, 'utf8');
    // Cut inside the two-byte sequence of "ü".
    const cut = bytes.indexOf(Buffer.from('ü', 'utf8')) + 1;

    harness = await startHarness({
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [bytes.subarray(0, cut), bytes.subarray(cut)],
      }),
    });

    const response = await harness.post('/v1/chat/completions', streamRequest('hallo'));
    expect(assembleOpenAi(await response.text())).toBe('Grüße aus München');
  });
});
