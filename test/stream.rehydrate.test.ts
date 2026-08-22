import { describe, expect, it } from 'vitest';
import { MAX_PLACEHOLDER_LENGTH } from '../src/redact/placeholder.js';
import { holdBackFrom, rehydrateChunks, StreamRehydrator } from '../src/stream/rehydrate.js';

const MAPPING: Record<string, string> = {
  '[EMAIL_1]': 'johan@example.com',
  '[IBAN_2]': 'DE89370400440532013000',
  '[NAME_1]': 'Anna Schmidt',
};

const resolve = (token: string): string | undefined => MAPPING[token];

/** Feed `text` to a fresh re-hydrator in the given pieces and join the output. */
function through(pieces: readonly string[]): string {
  const rehydrator = new StreamRehydrator(resolve);
  return pieces.map((piece) => rehydrator.push(piece)).join('') + rehydrator.flush();
}

/** Every way of cutting `text` into two pieces, including the empty cuts. */
function twoWaySplits(text: string): [string, string][] {
  return Array.from({ length: text.length + 1 }, (_, index) => [
    text.slice(0, index),
    text.slice(index),
  ]);
}

describe('holdBackFrom', () => {
  it('holds back a trailing partial token', () => {
    expect(holdBackFrom('hello [EMA')).toBe(6);
    expect(holdBackFrom('hello [')).toBe(6);
    expect(holdBackFrom('hello [EMAIL_1')).toBe(6);
  });

  it('holds back nothing when the tail cannot become a token', () => {
    expect(holdBackFrom('hello world')).toBe(11);
    expect(holdBackFrom('hello [EMAIL_1]')).toBe(15);
    expect(holdBackFrom('hello [lower')).toBe(12);
    expect(holdBackFrom('array [1, 2')).toBe(11);
  });

  it('only ever considers the last bracket', () => {
    // The earlier '[' cannot start a token any more: a token body has no '['.
    expect(holdBackFrom('[EMAIL_1] and [IB')).toBe(14);
  });
});

describe('chunk boundaries', () => {
  const text = 'to [EMAIL_1] now';

  it('restores a token split at every possible byte offset', () => {
    for (const [head, tail] of twoWaySplits(text)) {
      expect(through([head, tail])).toBe('to johan@example.com now');
    }
  });

  it('restores a token split into three pieces at every pair of offsets', () => {
    for (let first = 0; first <= text.length; first += 1) {
      for (let second = first; second <= text.length; second += 1) {
        const pieces = [text.slice(0, first), text.slice(first, second), text.slice(second)];
        expect(through(pieces)).toBe('to johan@example.com now');
      }
    }
  });

  it('restores a token delivered one character at a time', () => {
    expect(through([...text])).toBe('to johan@example.com now');
  });

  it('restores several tokens across arbitrary splits', () => {
    const mixed = 'x [EMAIL_1] y [IBAN_2] z [NAME_1]';
    const expected = 'x johan@example.com y DE89370400440532013000 z Anna Schmidt';
    for (const [head, tail] of twoWaySplits(mixed)) {
      expect(through([head, tail])).toBe(expected);
    }
  });

  it('emits everything it received, byte for byte, when nothing resolves', () => {
    const noise = 'plain [UNKNOWN_9] text [x] [';
    for (const [head, tail] of twoWaySplits(noise)) {
      expect(through([head, tail])).toBe(noise);
    }
  });
});

describe('holding back', () => {
  it('emits the safe part of a chunk immediately', () => {
    const rehydrator = new StreamRehydrator(resolve);
    expect(rehydrator.push('hello [EMA')).toBe('hello ');
    expect(rehydrator.pending).toBe('[EMA');
    expect(rehydrator.push('IL_1] world')).toBe('johan@example.com world');
  });

  it('never holds back more than one token could need', () => {
    const rehydrator = new StreamRehydrator(resolve);
    const runaway = `[${'A'.repeat(MAX_PLACEHOLDER_LENGTH * 3)}`;
    const emitted = rehydrator.push(runaway);
    // The moment the run is longer than any token, it is released.
    expect(emitted.length).toBeGreaterThan(0);
    expect(rehydrator.pending.length).toBeLessThanOrEqual(MAX_PLACEHOLDER_LENGTH);
  });

  it('does not deadlock on a stream that is nothing but open brackets', () => {
    const rehydrator = new StreamRehydrator(resolve);
    let emitted = '';
    for (let i = 0; i < 1000; i += 1) emitted += rehydrator.push('[');
    emitted += rehydrator.flush();
    expect(emitted).toBe('['.repeat(1000));
  });

  it('delivers the tail when the stream ends mid-token', () => {
    const rehydrator = new StreamRehydrator(resolve);
    expect(rehydrator.push('done [EMAIL_')).toBe('done ');
    expect(rehydrator.flush()).toBe('[EMAIL_');
  });

  it('flushes to empty and stays usable', () => {
    const rehydrator = new StreamRehydrator(resolve);
    rehydrator.push('[EMA');
    expect(rehydrator.flush()).toBe('[EMA');
    expect(rehydrator.flush()).toBe('');
    expect(rehydrator.push('[EMAIL_1]')).toBe('johan@example.com');
  });

  it('ignores empty pushes', () => {
    const rehydrator = new StreamRehydrator(resolve);
    expect(rehydrator.push('')).toBe('');
    expect(rehydrator.push('[EMAIL_1]')).toBe('johan@example.com');
  });
});

describe('substitution safety', () => {
  it('does not rescan a restored value that looks like a token', () => {
    const rehydrator = new StreamRehydrator((token) =>
      token === '[LITERAL_1]' ? '[EMAIL_1]' : MAPPING[token],
    );
    expect(rehydrator.push('[LITERAL_1] and [EMAIL_1]')).toBe('[EMAIL_1] and johan@example.com');
  });

  it('leaves a token from another session alone', () => {
    expect(through(['[EMAIL_77]'])).toBe('[EMAIL_77]');
  });
});

async function* splitSource(): AsyncGenerator<string> {
  yield 'start [EMA';
  yield 'IL_1] middle [IBA';
  yield 'N_2] end [NAME_';
}

describe('rehydrateChunks', () => {
  it('re-hydrates an async stream and never drops the tail', async () => {
    const out: string[] = [];
    for await (const piece of rehydrateChunks(splitSource(), resolve)) out.push(piece);

    expect(out.join('')).toBe(
      'start johan@example.com middle DE89370400440532013000 end [NAME_',
    );
  });
});
