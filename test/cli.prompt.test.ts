import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter, type Prompter } from '../src/cli/prompt.js';

/**
 * Drive a prompter with scripted answers.
 *
 * Answers are written *in response to* a prompt rather than queued up front:
 * readline drops lines that arrive before a question is asked, so a
 * pre-written script produces a promise that never settles.
 */
function driven(answers: readonly string[]): { prompter: Prompter; output(): string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const queue = [...answers];
  const written: string[] = [];
  let pending = '';

  output.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    written.push(text);
    pending += text;

    // Every prompt this module writes ends in "> ". A list of choices does not,
    // so it does not consume an answer.
    if (!pending.endsWith('> ')) return;

    pending = '';
    const next = queue.shift();
    if (next !== undefined) setImmediate(() => input.write(`${next}\n`));
  });

  return { prompter: createPrompter({ input, output }), output: () => written.join('') };
}

describe('createPrompter', () => {
  it('returns the typed answer, trimmed', async () => {
    const { prompter } = driven(['  Nordwerk GmbH  ']);
    expect(await prompter.text('Company')).toBe('Nordwerk GmbH');
    prompter.close();
  });

  it('returns an empty string for an optional question left blank', async () => {
    const { prompter } = driven(['']);
    expect(await prompter.text('Data protection officer')).toBe('');
    prompter.close();
  });

  it('falls back to the default when the answer is empty', async () => {
    const { prompter, output } = driven(['']);
    expect(await prompter.text('Port', { default: '8787' })).toBe('8787');
    expect(output()).toContain('[8787]');
    prompter.close();
  });

  it('asks again when a required answer is empty', async () => {
    const { prompter, output } = driven(['', 'finally']);
    expect(await prompter.text('Provider', { required: true })).toBe('finally');
    expect(output()).toContain('an answer is required');
    prompter.close();
  });

  it('maps a chosen number to its value', async () => {
    const { prompter, output } = driven(['2']);
    const picked = await prompter.choose('Which provider', [
      { label: 'Mistral AI', hint: 'FR', value: 'mistral' },
      { label: 'OpenAI', hint: 'US', value: 'openai' },
    ]);
    expect(picked).toBe('openai');
    expect(output()).toContain('1 Mistral AI  FR');
    prompter.close();
  });

  it('rejects a number outside the list and asks again', async () => {
    const { prompter, output } = driven(['9', '1']);
    const picked = await prompter.choose('Which provider', [
      { label: 'Mistral AI', value: 'mistral' },
      { label: 'OpenAI', value: 'openai' },
    ]);
    expect(picked).toBe('mistral');
    expect(output()).toContain('pick a number between 1 and 2');
    prompter.close();
  });

  it('rejects an answer that is not a number at all', async () => {
    const { prompter, output } = driven(['openai', '2']);
    const picked = await prompter.choose('Which provider', [
      { label: 'Mistral AI', value: 'mistral' },
      { label: 'OpenAI', value: 'openai' },
    ]);
    expect(picked).toBe('openai');
    expect(output()).toContain('pick a number between 1 and 2');
    prompter.close();
  });

  it('takes the fallback on an empty confirm, both ways round', async () => {
    const yes = driven(['']);
    expect(await yes.prompter.confirm('Continue', true)).toBe(true);
    expect(yes.output()).toContain('[Y/n]');
    yes.prompter.close();

    const no = driven(['']);
    expect(await no.prompter.confirm('Continue', false)).toBe(false);
    expect(no.output()).toContain('[y/N]');
    no.prompter.close();
  });

  it('reads an explicit yes or no regardless of case', async () => {
    const { prompter } = driven(['N', 'YES']);
    expect(await prompter.confirm('Continue', true)).toBe(false);
    expect(await prompter.confirm('Continue', false)).toBe(true);
    prompter.close();
  });

  it('asks again when a confirm is neither', async () => {
    const { prompter, output } = driven(['maybe', 'y']);
    expect(await prompter.confirm('Continue', false)).toBe(true);
    expect(output()).toContain('answer y or n');
    prompter.close();
  });
});
