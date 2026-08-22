import { afterEach, describe, expect, it } from 'vitest';
import { applyDataControls, setPath } from '../src/residency/controls.js';
import { defaultResidencyConfig, evaluateUpstream } from '../src/residency/policy.js';
import { lookupEndpoint, type DataControl } from '../src/residency/registry.js';
import type { JsonValue } from '../src/redact/traverse.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('setPath', () => {
  it('sets a top-level field', () => {
    expect(setPath({ model: 'm' } as JsonValue, 'store', false)).toEqual({
      model: 'm',
      store: false,
    });
  });

  it('creates intermediate objects', () => {
    expect(setPath({} as JsonValue, 'a.b.c', 'x')).toEqual({ a: { b: { c: 'x' } } });
  });

  it('overrides what the caller sent', () => {
    // A policy layer where one caller can opt out of the policy is not one.
    expect(setPath({ store: true } as JsonValue, 'store', false)).toEqual({ store: false });
  });

  it('leaves the input untouched', () => {
    const body = { store: true } as JsonValue;
    setPath(body, 'store', false);
    expect(body).toEqual({ store: true });
  });

  it('refuses to clobber a non-object on the way', () => {
    expect(setPath({ a: 'string' } as JsonValue, 'a.b', 1)).toEqual({ a: 'string' });
  });
});

describe('applyDataControls', () => {
  const header: DataControl = {
    kind: 'no-training',
    mechanism: 'header',
    header: { name: 'X-No-Training', value: '1' },
    note: '',
  };
  const body: DataControl = {
    kind: 'zero-retention',
    mechanism: 'body',
    body: { path: 'store', value: false },
    note: '',
  };
  const account: DataControl = { kind: 'zero-retention', mechanism: 'account', note: '' };

  it('applies header and body controls and reports both', () => {
    const result = applyDataControls([header, body], { model: 'm' } as JsonValue);
    expect(result.headers).toEqual({ 'x-no-training': '1' });
    expect(result.body).toEqual({ model: 'm', store: false });
    expect(result.applied).toEqual([
      'no-training via header X-No-Training',
      'zero-retention via body store=false',
    ]);
  });

  it('reports what it cannot set instead of pretending it did', () => {
    const result = applyDataControls([account], {} as JsonValue);
    expect(result.applied).toEqual([]);
    expect(result.manual).toEqual(['zero-retention (account)']);
  });

  it('is a no-op without controls', () => {
    const result = applyDataControls([], { a: 1 } as JsonValue);
    expect(result.body).toEqual({ a: 1 });
  });
});

describe('the registry controls', () => {
  it('switches off stored completions for the OpenAI endpoint', () => {
    const controls = lookupEndpoint('api.openai.com')!.entry.dataControls;
    const result = applyDataControls(controls, { model: 'gpt-4o-mini' } as JsonValue);
    expect(result.body).toMatchObject({ store: false });
    expect(result.manual).toContain('no-training (account)');
  });

  it('has nothing to set for Anthropic, and says so', () => {
    const controls = lookupEndpoint('api.anthropic.com')!.entry.dataControls;
    const result = applyDataControls(controls, {} as JsonValue);
    expect(result.applied).toEqual([]);
    expect(result.manual.length).toBeGreaterThan(0);
  });
});

describe('block mode implies requiring a control', () => {
  it('refuses an endpoint that documents none', () => {
    const verdict = evaluateUpstream('https://llm.unknown.example', {
      ...defaultResidencyConfig(),
      mode: 'block',
      allow: [
        {
          endpoint: 'https://llm.unknown.example',
          jurisdiction: 'DE',
          legalBasis: 'on premise',
          note: null,
        },
      ],
    });
    expect(verdict.permitted).toBe(false);
    expect(verdict.reason).toMatch(/residency\.mode is block/u);
  });
});

describe('the proxy applying controls', () => {
  it('sets the controls of the matched endpoint on every request', async () => {
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: {
          ...defaultResidencyConfig(),
          allow: [
            { endpoint: origin, jurisdiction: 'DE', legalBasis: 'on premise', note: null },
          ],
          endpoints: [
            {
              id: 'test.local',
              label: 'Test upstream',
              operator: 'test',
              hosts: ['127.0.0.1'],
              jurisdiction: 'DE',
              dataControls: [
                {
                  kind: 'no-training',
                  mechanism: 'header',
                  header: { name: 'X-No-Training', value: '1' },
                  note: 'test',
                },
                {
                  kind: 'zero-retention',
                  mechanism: 'body',
                  body: { path: 'store', value: false },
                  note: 'test',
                },
              ],
              note: 'test',
            },
          ],
        },
      }),
    });

    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      store: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const sent = harness.upstream.lastRequest!;
    expect(sent.headers['x-no-training']).toBe('1');
    expect((sent.json as { store: boolean }).store).toBe(false);
  });

  it('records the applied controls in the audit trail', async () => {
    const records: { residency?: { controls: string[] } }[] = [];
    harness = await startHarness({
      config: (base, origin) => ({
        ...base,
        residency: {
          ...defaultResidencyConfig(),
          allow: [{ endpoint: origin, jurisdiction: 'DE', legalBasis: 'x', note: null }],
          endpoints: [
            {
              id: 'test.local',
              label: 'Test upstream',
              operator: 'test',
              hosts: ['127.0.0.1'],
              jurisdiction: 'DE',
              dataControls: [
                {
                  kind: 'zero-retention',
                  mechanism: 'body',
                  body: { path: 'store', value: false },
                  note: 'test',
                },
              ],
              note: 'test',
            },
          ],
        },
      }),
      proxy: {
        audit: {
          write: (record) => records.push(record as { residency?: { controls: string[] } }),
          close: () => Promise.resolve(),
        },
      },
    });

    await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(records[0]!.residency!.controls).toEqual(['zero-retention via body store=false']);
  });
});
