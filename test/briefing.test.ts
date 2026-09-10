/**
 * The briefing: what it says, when it is attached, and where in a request body
 * it lands.
 */
import { describe, expect, it } from 'vitest';
import {
  attachBriefing,
  briefingContext,
  briefingFor,
  builtinBriefing,
  defaultBriefingConfig,
  hasPlaceholders,
  isBriefingMode,
  type BriefingConfig,
} from '../src/briefing/index.js';
import { PLACEHOLDER_PATTERN } from '../src/redact/placeholder.js';
import { Session } from '../src/redact/session.js';
import type { Finding, Policy } from '../src/types.js';

const finding = (kind: string, policy: Policy = 'pseudonymize'): Finding => ({
  kind,
  policy,
  placeholder: null,
  start: 0,
  end: 0,
  value: '',
  detector: 'test',
  priority: 0,
});

const config = (overrides: Partial<BriefingConfig> = {}): BriefingConfig => ({
  ...defaultBriefingConfig(),
  ...overrides,
});

describe('the text', () => {
  it('names the kinds this request actually carries, in ordinary language', () => {
    const text = builtinBriefing(briefingContext([finding('EMAIL'), finding('IBAN')]));

    expect(text).toContain('e-mail addresses ([EMAIL_n])');
    expect(text).toContain('bank accounts ([IBAN_n])');
    expect(text).not.toContain('phone numbers');
  });

  it('falls back to the kind name for an operator’s own rule', () => {
    const text = builtinBriefing(briefingContext([finding('EMPLOYEE_ID')]));
    expect(text).toContain('employee id ([EMPLOYEE_ID_n])');
  });

  it('states the positive rule before the prohibitions', () => {
    const text = builtinBriefing(briefingContext([finding('EMAIL')]));
    const reuse = text.indexOf('write the identical placeholder');
    const never = text.indexOf('Never put an invented value');

    expect(reuse).toBeGreaterThan(-1);
    expect(never).toBeGreaterThan(reuse);
  });

  it('forbids the two failures that actually happen', () => {
    const text = builtinBriefing(briefingContext([finding('EMAIL')]));

    // Inventing a value: the re-hydrator has nothing to replace, so it reaches
    // the caller's application looking exactly like a real address.
    expect(text).toContain('Never put an invented value where a placeholder belongs');
    // The preamble the whole feature exists to stop.
    expect(text).toContain('do not begin your answer by describing what you can or cannot see');
  });

  it('keeps the answer in the user’s language', () => {
    expect(builtinBriefing(briefingContext([finding('EMAIL')]))).toContain(
      'Write in the language the user wrote in',
    );
  });

  it('explains the irreversible tokens only when the request has one', () => {
    const clean = builtinBriefing(briefingContext([finding('EMAIL')]));
    expect(clean).not.toContain('not reversible');

    const masked = builtinBriefing(
      briefingContext([finding('SECRET', 'redact'), finding('GERMAN_TAX_ID', 'hash')]),
    );
    expect(masked).toContain('[SECRET_REDACTED]');
    expect(masked).toContain('[GERMAN_TAX_ID:9f2c4a]');
    expect(masked).toContain('do not guess what it');
  });

  it('contains no token the re-hydrator would try to replace', () => {
    // The trap this guards: an example written [EMAIL_1] is a *real* token in
    // the grammar, so a model quoting the instruction back would have its
    // quotation rehydrated into the address hushgate was hiding.
    const text = builtinBriefing(
      briefingContext([finding('EMAIL'), finding('SECRET', 'redact'), finding('IBAN', 'hash')]),
    );

    expect(text.match(PLACEHOLDER_PATTERN)).toBeNull();
  });

  it('summarises rather than listing twenty kinds', () => {
    const kinds = Array.from({ length: 14 }, (_, index) => `KIND_${index}`);
    const text = builtinBriefing(briefingContext(kinds.map((kind) => finding(kind))));

    expect(text).toContain('and 4 more kinds');
  });

  it('is the same text every time for the same request', () => {
    const one = builtinBriefing(briefingContext([finding('IBAN'), finding('EMAIL')]));
    const two = builtinBriefing(briefingContext([finding('EMAIL'), finding('IBAN')]));
    expect(one).toBe(two);
  });

  it('stays short enough to forget about', () => {
    const text = builtinBriefing(briefingContext([finding('EMAIL'), finding('NAME')]));
    expect(text.length).toBeLessThan(1200);
  });
});

describe('when it is attached', () => {
  it('is attached by default once a request carries a placeholder', () => {
    expect(briefingFor(config(), [finding('EMAIL')])).not.toBeNull();
  });

  it('is not attached to a request nothing was found in', () => {
    expect(briefingFor(config(), [])).toBeNull();
  });

  it('ignores a finding the allow policy left in place', () => {
    expect(briefingFor(config(), [finding('IPV4', 'allow')])).toBeNull();
  });

  it('is attached to every request in always mode', () => {
    const text = briefingFor(config({ mode: 'always' }), []);
    expect(text).toContain('A placeholder is written [KIND_n]');
  });

  it('is never attached in off mode', () => {
    expect(briefingFor(config({ mode: 'off' }), [finding('EMAIL')])).toBeNull();
  });

  it('replaces the built-in text outright', () => {
    const text = briefingFor(config({ text: 'Answer as a pirate.' }), [finding('EMAIL')]);
    expect(text).toBe('Answer as a pirate.');
  });

  it('appends house rules after whichever text is used', () => {
    const text = briefingFor(config({ append: 'Sign off as Acme.' }), [finding('EMAIL')]);

    expect(text).toContain('e-mail addresses');
    expect(text?.endsWith('\n\nSign off as Acme.')).toBe(true);
  });

  it('accepts only the three documented modes', () => {
    expect(isBriefingMode('auto')).toBe(true);
    expect(isBriefingMode('always')).toBe(true);
    expect(isBriefingMode('off')).toBe(true);
    expect(isBriefingMode('sometimes')).toBe(false);
  });

  it('reports whether a context has anything to explain', () => {
    expect(hasPlaceholders(briefingContext([]))).toBe(false);
    expect(hasPlaceholders(briefingContext([finding('EMAIL', 'hash')]))).toBe(true);
  });
});

describe('where it lands — OpenAI', () => {
  it('goes in front of the conversation when there is no system message', () => {
    const body = attachBriefing(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      'openai',
      'BRIEFING',
    ) as { messages: { role: string; content: string }[] };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'BRIEFING' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('goes after the caller’s own system messages, never before them', () => {
    // Position is a cost decision: both providers cache on a prefix, so
    // inserting at index 0 would invalidate the caller's cached prompt on every
    // single request.
    const body = attachBriefing(
      {
        messages: [
          { role: 'system', content: 'You are Acme support.' },
          { role: 'developer', content: 'Never quote a price.' },
          { role: 'user', content: 'hi' },
        ],
      },
      'openai',
      'BRIEFING',
    ) as { messages: { role: string; content: string }[] };

    expect(body.messages.map((message) => message.content)).toEqual([
      'You are Acme support.',
      'Never quote a price.',
      'BRIEFING',
      'hi',
    ]);
  });

  it('leaves every other field of the request alone', () => {
    const original = {
      model: 'gpt-4o',
      temperature: 0.2,
      tools: [{ type: 'function' }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const body = attachBriefing(original, 'openai', 'BRIEFING') as typeof original;

    expect(body.model).toBe('gpt-4o');
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toEqual([{ type: 'function' }]);
    // The caller's array is not mutated.
    expect(original.messages).toHaveLength(1);
  });

  it('forwards a body it does not recognise untouched', () => {
    const body = { model: 'gpt-4o', messages: 'not an array' };
    expect(attachBriefing(body, 'openai', 'BRIEFING')).toEqual(body);
  });
});

describe('where it lands — Anthropic', () => {
  it('creates the system field when the caller sent none', () => {
    const body = attachBriefing(
      { model: 'claude', messages: [{ role: 'user', content: 'hi' }] },
      'anthropic',
      'BRIEFING',
    ) as { system: string };

    expect(body.system).toBe('BRIEFING');
  });

  it('appends to a string system prompt, keeping it a string', () => {
    const body = attachBriefing(
      { system: 'You are Acme support.', messages: [] },
      'anthropic',
      'BRIEFING',
    ) as { system: string };

    expect(body.system).toBe('You are Acme support.\n\nBRIEFING');
  });

  it('appends a block to a block array, leaving a cache breakpoint intact', () => {
    const body = attachBriefing(
      {
        system: [{ type: 'text', text: 'You are Acme support.', cache_control: { type: 'ephemeral' } }],
        messages: [],
      },
      'anthropic',
      'BRIEFING',
    ) as { system: { type: string; text: string; cache_control?: unknown }[] };

    expect(body.system).toHaveLength(2);
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[1]).toEqual({ type: 'text', text: 'BRIEFING' });
  });

  it('forwards a system field of an undocumented shape untouched', () => {
    const body = { system: 42, messages: [] };
    expect(attachBriefing(body, 'anthropic', 'BRIEFING')).toEqual(body);
  });
});

describe('against a real session', () => {
  it('describes the tokens the redactor actually issued', () => {
    const session = new Session();
    const result = session.redact('Write to anna.schmidt@nordlicht.example about DE89370400440532013000.');
    const text = briefingFor(defaultBriefingConfig(), result.findings);

    expect(result.text).toContain('[EMAIL_1]');
    expect(text).toContain('e-mail addresses ([EMAIL_n])');
    expect(text).toContain('bank accounts ([IBAN_n])');
  });
});
