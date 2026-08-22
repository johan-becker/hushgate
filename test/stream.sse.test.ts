import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_STREAM_DELTAS,
  OPENAI_STREAM_DELTAS,
  renderEvent,
  SseParser,
  SseRehydrator,
} from '../src/stream/index.js';

const MAPPING: Record<string, string> = {
  '[EMAIL_1]': 'johan@example.com',
  '[NAME_1]': 'Anna Schmidt',
  '[IBAN_1]': 'DE89370400440532013000',
};

const resolve = (token: string): string | undefined => MAPPING[token];

const openAi = (): SseRehydrator =>
  new SseRehydrator({ deltaRules: OPENAI_STREAM_DELTAS, resolve });
const anthropic = (): SseRehydrator =>
  new SseRehydrator({ deltaRules: ANTHROPIC_STREAM_DELTAS, resolve });

/** Push `text` through in the given pieces and join everything that comes out. */
function stream(rehydrator: SseRehydrator, pieces: readonly string[]): string {
  return pieces.map((piece) => rehydrator.push(piece)).join('') + rehydrator.flush();
}

/** Concatenate the `content` deltas of an OpenAI stream. */
function openAiText(sse: string): string {
  return dataPayloads(sse)
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => {
      const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
      return parsed.choices?.[0]?.delta?.content ?? '';
    })
    .join('');
}

/** Concatenate the text deltas of an Anthropic stream. */
function anthropicText(sse: string): string {
  return dataPayloads(sse)
    .map((payload) => {
      const parsed = JSON.parse(payload) as { delta?: { text?: string } };
      return parsed.delta?.text ?? '';
    })
    .join('');
}

function dataPayloads(sse: string): string[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim());
}

const openAiChunk = (content: string): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;

const toolCallChunk = (index: number, argument: string): string =>
  `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: argument } }] } }],
  })}\n\n`;

const anthropicChunk = (text: string, index = 0): string =>
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })}\n\n`;

describe('SseParser', () => {
  it('splits on a blank line', () => {
    const events = new SseParser().push('data: a\n\ndata: b\n\n');
    expect(events.map((event) => event.data)).toEqual(['a', 'b']);
  });

  it('handles CRLF and lone CR terminators', () => {
    expect(new SseParser().push('data: a\r\n\r\n')[0]!.data).toBe('a');
    // The trailing "data: c" removes the ambiguity of a stream-final CR.
    const events = new SseParser().push('data: a\r\rdata: b\r\rdata: c');
    expect(events.map((event) => event.data)).toEqual(['a', 'b']);
  });

  it('waits for the rest of a terminator split across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\r')).toEqual([]);
    expect(parser.push('\n\r\n')[0]!.data).toBe('a');
  });

  it('joins multiple data lines with a newline', () => {
    expect(new SseParser().push('data: one\ndata: two\n\n')[0]!.data).toBe('one\ntwo');
  });

  it('keeps the event name and ignores comments', () => {
    const [event] = new SseParser().push(': keep-alive\nevent: ping\ndata: {}\n\n');
    expect(event!.name).toBe('ping');
    expect(event!.data).toBe('{}');
  });

  it('reports an unterminated trailing event through flush', () => {
    const parser = new SseParser();
    expect(parser.push('data: half')).toEqual([]);
    expect(parser.flush()).toBe('data: half');
  });

  it('does not lose an event when a chunk ends inside the payload', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"a":')).toEqual([]);
    expect(parser.push('1}\n\n')[0]!.data).toBe('{"a":1}');
  });
});

describe('renderEvent', () => {
  it('leaves the block untouched when there is nothing to replace', () => {
    const [event] = new SseParser().push('event: ping\ndata: {}\n\n');
    expect(renderEvent(event!, null)).toBe('event: ping\ndata: {}\n\n');
  });

  it('keeps comments, event names and ids in place', () => {
    const [event] = new SseParser().push(': hello\nevent: x\nid: 7\ndata: old\n\n');
    expect(renderEvent(event!, 'new')).toBe(': hello\nevent: x\nid: 7\ndata: new\n\n');
  });

  it('collapses multiple data lines into the replacement', () => {
    const [event] = new SseParser().push('data: a\ndata: b\nid: 1\n\n');
    expect(renderEvent(event!, 'c')).toBe('data: c\nid: 1\n\n');
  });
});

describe('OpenAI streams', () => {
  const wire = [
    openAiChunk('Write to '),
    openAiChunk('['),
    openAiChunk('EMAIL'),
    openAiChunk('_1'),
    openAiChunk(']'),
    openAiChunk(' today'),
    'data: [DONE]\n\n',
  ].join('');

  it('re-assembles a token spread over five events', () => {
    expect(openAiText(stream(openAi(), [wire]))).toBe('Write to johan@example.com today');
  });

  it('survives the stream being cut at every single byte offset', () => {
    for (let cut = 0; cut <= wire.length; cut += 1) {
      const out = stream(openAi(), [wire.slice(0, cut), wire.slice(cut)]);
      expect(openAiText(out)).toBe('Write to johan@example.com today');
      expect(out).toContain('data: [DONE]');
    }
  });

  it('survives being delivered one byte at a time', () => {
    expect(openAiText(stream(openAi(), [...wire]))).toBe('Write to johan@example.com today');
  });

  it('emits a held-back token before [DONE] rather than dropping it', () => {
    const truncated = [openAiChunk('bye ['), openAiChunk('EMAIL_1'), 'data: [DONE]\n\n'].join('');
    const out = stream(openAi(), [truncated]);
    expect(openAiText(out)).toBe('bye [EMAIL_1');
    expect(out.indexOf('[EMAIL_1')).toBeLessThan(out.indexOf('[DONE]'));
  });

  it('emits a held-back token at end of stream when [DONE] never comes', () => {
    const out = stream(openAi(), [openAiChunk('bye ['), openAiChunk('EMAIL_')]);
    expect(openAiText(out)).toBe('bye [EMAIL_');
  });

  it('keeps two tool call argument streams apart', () => {
    // The two calls are streamed one after the other, each split mid-token.
    const out = stream(openAi(), [
      toolCallChunk(0, '{"to":"[EMA'),
      toolCallChunk(0, 'IL_1]"}'),
      toolCallChunk(1, '{"who":"[NAM'),
      toolCallChunk(1, 'E_1]"}'),
    ]);

    expect(out).toContain('johan@example.com');
    expect(out).toContain('Anna Schmidt');
    expect(out).not.toContain('[EMA');
    expect(out).not.toContain('[NAM');
  });

  it('substitutes complete tokens outside the delta fields', () => {
    const out = stream(openAi(), [
      `data: ${JSON.stringify({ system_fingerprint: '[NAME_1]', choices: [] })}\n\n`,
    ]);
    expect(out).toContain('Anna Schmidt');
  });

  it('passes through events it does not understand', () => {
    const out = stream(openAi(), [': ping\n\n', 'event: keepalive\ndata: nope\n\n']);
    expect(out).toContain(': ping');
    expect(out).toContain('data: nope');
  });
});

describe('Anthropic streams', () => {
  const wire = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    anthropicChunk('Schreib an '),
    anthropicChunk('[EM'),
    anthropicChunk('AIL_1]'),
    anthropicChunk(' bitte'),
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join('');

  it('re-assembles a token split across events', () => {
    expect(anthropicText(stream(anthropic(), [wire]))).toBe(
      'Schreib an johan@example.com bitte',
    );
  });

  it('survives the stream being cut at every single byte offset', () => {
    for (let cut = 0; cut <= wire.length; cut += 1) {
      const out = stream(anthropic(), [wire.slice(0, cut), wire.slice(cut)]);
      expect(anthropicText(out)).toBe('Schreib an johan@example.com bitte');
      expect(out).toContain('message_stop');
    }
  });

  it('flushes a partial token before the block that owns it closes', () => {
    const out = stream(anthropic(), [
      anthropicChunk('ende ['),
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);

    expect(anthropicText(out)).toBe('ende [');
    expect(out.indexOf('ende')).toBeLessThan(out.indexOf('content_block_stop'));
  });

  it('keeps two interleaved content blocks apart', () => {
    const out = stream(anthropic(), [
      anthropicChunk('a [EM', 0),
      anthropicChunk('b [NAM', 1),
      anthropicChunk('AIL_1]', 0),
      anthropicChunk('E_1]', 1),
    ]);

    // A client concatenates deltas per block index, so that is what must hold:
    // block 0 carries the address, block 1 the name, neither leaks into the other.
    const byIndex = new Map<number, string>();
    for (const payload of dataPayloads(out)) {
      const event = JSON.parse(payload) as { index: number; delta?: { text?: string } };
      byIndex.set(event.index, (byIndex.get(event.index) ?? '') + (event.delta?.text ?? ''));
    }

    expect(byIndex.get(0)).toBe('a johan@example.com');
    expect(byIndex.get(1)).toBe('b Anna Schmidt');
  });

  it('re-hydrates streamed tool input JSON', () => {
    const out = stream(anthropic(), [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"iban":"[IB' },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'AN_1]"}' },
      })}\n\n`,
    ]);

    expect(out).toContain('DE89370400440532013000');
    expect(out).not.toContain('[IB');
  });
});

describe('stream integrity', () => {
  it('emits well-formed events whatever the chunking', () => {
    const wire = [openAiChunk('['), openAiChunk('EMAIL_1]'), 'data: [DONE]\n\n'].join('');

    for (let cut = 0; cut <= wire.length; cut += 1) {
      const out = stream(openAi(), [wire.slice(0, cut), wire.slice(cut)]);
      // Every block ends with a blank line, and every data line is parseable.
      expect(out.endsWith('\n\n')).toBe(true);
      for (const payload of dataPayloads(out)) {
        if (payload === '[DONE]') continue;
        expect(() => JSON.parse(payload)).not.toThrow();
      }
    }
  });
});
