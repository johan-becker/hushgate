import { describe, expect, it } from 'vitest';
import { TraversalDepthError } from '../src/errors.js';
import { Session } from '../src/redact/session.js';
import { ANTHROPIC_MESSAGES_RULES, OPENAI_CHAT_RULES } from '../src/redact/shapes.js';
import {
  compileRule,
  mapStrings,
  matchesRule,
  redactJson,
  restoreJson,
  type JsonValue,
} from '../src/redact/traverse.js';

const session = (): Session => new Session({ dobYearRange: { minYear: 1900, maxYear: 2013 } });

const match = (rule: string, path: (string | number)[]): boolean =>
  matchesRule(compileRule(rule), path);

describe('path rules', () => {
  it('matches literal segments', () => {
    expect(match('metadata.user_id', ['metadata', 'user_id'])).toBe(true);
    expect(match('metadata.user_id', ['metadata', 'user'])).toBe(false);
    expect(match('metadata.user_id', ['metadata'])).toBe(false);
  });

  it('matches array indices with a single wildcard', () => {
    expect(match('messages.*.content', ['messages', 0, 'content'])).toBe(true);
    expect(match('messages.*.content', ['messages', 12, 'content'])).toBe(true);
    expect(match('messages.*.content', ['messages', 0, 'content', 0, 'text'])).toBe(false);
  });

  it('matches any depth with a double wildcard', () => {
    const rule = 'messages.*.content.*.input.**';
    expect(match(rule, ['messages', 0, 'content', 1, 'input'])).toBe(true);
    expect(match(rule, ['messages', 0, 'content', 1, 'input', 'a'])).toBe(true);
    expect(match(rule, ['messages', 0, 'content', 1, 'input', 'a', 0, 'b'])).toBe(true);
    expect(match(rule, ['messages', 0, 'content', 1, 'other', 'a'])).toBe(false);
  });

  it('does not confuse a key with an index of the same spelling', () => {
    expect(match('a.0.b', ['a', 0, 'b'])).toBe(true);
    expect(match('a.0.b', ['a', '0', 'b'])).toBe(true);
  });
});

describe('mapStrings', () => {
  it('rewrites every string leaf when nothing is selected', () => {
    const input = { a: 'x', b: [{ c: 'y' }], n: 1, t: true, z: null };
    expect(mapStrings(input as JsonValue, (s) => s.toUpperCase())).toEqual({
      a: 'X',
      b: [{ c: 'Y' }],
      n: 1,
      t: true,
      z: null,
    });
  });

  it('leaves the input untouched', () => {
    const input = { a: 'x', b: ['y'] };
    mapStrings(input as JsonValue, () => 'changed');
    expect(input).toEqual({ a: 'x', b: ['y'] });
  });

  it('passes the path of each leaf to the transform', () => {
    const seen: string[] = [];
    mapStrings({ a: [{ b: 'v' }] } as JsonValue, (s, path) => {
      seen.push(path.join('.'));
      return s;
    });
    expect(seen).toEqual(['a.0.b']);
  });

  it('refuses absurdly deep bodies instead of blowing the stack', () => {
    let deep: JsonValue = 'bottom';
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => mapStrings(deep, (s) => s)).toThrow(TraversalDepthError);
    expect(() => mapStrings(deep, (s) => s, { maxDepth: 64 })).not.toThrow();
  });

  it('preserves array holes as null rather than dropping them', () => {
    expect(mapStrings([1, 'a', null] as JsonValue, (s) => `${s}!`)).toEqual([1, 'a!', null]);
  });
});

const openAiBody = (): JsonValue => ({
  model: 'gpt-4o-mini',
  stream: false,
  user: 'account-42',
  messages: [
    { role: 'system', content: 'You help Acme staff.' },
    { role: 'user', content: 'Mail johan@example.com about IBAN DE89370400440532013000.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'and call +49 721 1234567' },
        { type: 'image_url', image_url: { url: 'https://cdn.example/a.png' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'send_mail', arguments: '{"to":"johan@example.com"}' },
        },
      ],
    },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'send_mail',
        description: 'Send mail, e.g. to johan@example.com',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
      },
    },
  ],
});

describe('redactJson over an OpenAI chat body', () => {
  it('redacts content, parts, tool arguments and tool descriptions', () => {
    const s = session();
    const { body: out } = redactJson(openAiBody(), s, OPENAI_CHAT_RULES);
    const json = JSON.stringify(out);

    expect(json).not.toContain('johan@example.com');
    expect(json).not.toContain('DE89370400440532013000');
    expect(json).not.toContain('721 1234567');
    expect(json).toContain('[EMAIL_1]');
  });

  it('leaves everything that is not user content exactly as it was', () => {
    const s = session();
    const { body: out } = redactJson(openAiBody(), s, OPENAI_CHAT_RULES);
    const record = out as Record<string, JsonValue>;
    expect(record['model']).toBe('gpt-4o-mini');
    expect(record['stream']).toBe(false);
    expect(record['user']).toBe('account-42');

    const messages = record['messages'] as Record<string, JsonValue>[];
    expect(messages[3]!['role']).toBe('assistant');
    const call = (messages[3]!['tool_calls'] as Record<string, JsonValue>[])[0]!;
    expect(call['id']).toBe('call_1');
    expect((call['function'] as Record<string, JsonValue>)['name']).toBe('send_mail');
  });

  it('does not scan image URLs', () => {
    const s = session();
    const { body: out } = redactJson(openAiBody(), s, OPENAI_CHAT_RULES);
    const messages = (out as Record<string, JsonValue>)['messages'] as Record<string, JsonValue>[];
    const parts = messages[2]!['content'] as Record<string, JsonValue>[];
    expect(parts[1]!['image_url']).toEqual({ url: 'https://cdn.example/a.png' });
  });

  it('keeps the same value on the same placeholder across the whole body', () => {
    const s = session();
    const { body: out } = redactJson(openAiBody(), s, OPENAI_CHAT_RULES);
    const json = JSON.stringify(out);
    // The address appears in a message, in tool arguments and in a description.
    expect(json.match(/\[EMAIL_1\]/gu)).toHaveLength(3);
  });

  it('produces findings for every leaf it touched', () => {
    const s = session();
    const { findings } = redactJson(openAiBody(), s, OPENAI_CHAT_RULES);
    const kinds = findings.map((f) => f.kind).toSorted();
    expect(kinds).toContain('EMAIL');
    expect(kinds).toContain('IBAN');
    expect(kinds).toContain('PHONE');
  });

  it('round-trips through restoreJson', () => {
    const s = session();
    const original = openAiBody();
    const { body: redacted } = redactJson(original, s, OPENAI_CHAT_RULES);
    expect(restoreJson(redacted, s)).toEqual(original);
  });
});

const anthropicBody = (): JsonValue => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: 'Support desk for johan@example.com',
  metadata: { user_id: 'anna@example.de' },
  messages: [
    { role: 'user', content: 'IBAN DE89370400440532013000 bitte prüfen' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Ich schreibe an johan@example.com' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup',
          input: { customer: { email: 'anna@example.de', tags: ['vip', '10.0.0.9'] } },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found anna@example.de' },
      ],
    },
  ],
  tools: [{ name: 'lookup', description: 'Look up johan@example.com', input_schema: {} }],
});

describe('redactJson over an Anthropic messages body', () => {
  it('reaches system prompts, tool inputs and tool results', () => {
    const s = session();
    const { body: out } = redactJson(anthropicBody(), s, ANTHROPIC_MESSAGES_RULES);
    const json = JSON.stringify(out);
    expect(json).not.toContain('johan@example.com');
    expect(json).not.toContain('anna@example.de');
    expect(json).not.toContain('10.0.0.9');
    expect(json).toContain('claude-sonnet-4-5');
    expect(json).toContain('toolu_1');
  });

  it('handles a system prompt given as text blocks', () => {
    const s = session();
    const { body: out } = redactJson(
      { system: [{ type: 'text', text: 'write to a@x.de' }] } as JsonValue,
      s,
      ANTHROPIC_MESSAGES_RULES,
    );
    expect(JSON.stringify(out)).toContain('[EMAIL_1]');
  });

  it('round-trips through restoreJson', () => {
    const s = session();
    const original = anthropicBody();
    const { body: redacted } = redactJson(original, s, ANTHROPIC_MESSAGES_RULES);
    expect(restoreJson(redacted, s)).toEqual(original);
  });
});

describe('restoreJson', () => {
  it('visits every leaf, including ones redaction would not have touched', () => {
    const s = session();
    const redacted = s.redact('a@x.de').text;
    const restored = restoreJson({ deep: { nested: [redacted] } } as JsonValue, s);
    expect(restored).toEqual({ deep: { nested: ['a@x.de'] } });
  });

  it('leaves tokens from another session alone', () => {
    const s = session();
    expect(restoreJson({ a: '[EMAIL_9]' } as JsonValue, s)).toEqual({ a: '[EMAIL_9]' });
  });
});

// Roughly 126k IPv4 addresses in one string: 1 MB, a quarter of the default
// limits.maxBodyBytes, so readBody accepts it without comment.
const dense = (count: number): JsonValue =>
  ({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: '1.1.1.1 '.repeat(count) }],
  }) as JsonValue;

describe('a body with very many findings', () => {
  it('redacts it instead of blowing the call stack', () => {
    const s = new Session();
    const result = redactJson(dense(126_000), s, ['messages.*.content']);

    expect(result.findings.length).toBe(126_000);
    const content = (result.body as { messages: { content: string }[] }).messages[0]!.content;
    expect(content).not.toContain('1.1.1.1');
    expect(content).toContain('[IPV4_1]');
  });

  it('re-hydrates it as well', () => {
    const s = new Session();
    const { body } = redactJson(dense(126_000), s, ['messages.*.content']);
    const restored = restoreJson(body, s) as { messages: { content: string }[] };
    expect(restored.messages[0]!.content).toBe('1.1.1.1 '.repeat(126_000));
  });
});
