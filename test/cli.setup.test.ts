import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import type { Choice, Prompter } from '../src/cli/prompt.js';
import { run } from '../src/cli/run.js';
import { waitFor } from './helpers/wait.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-setup-'));
  dirs.push(dir);
  return dir;
}

/** A prompter that reads from a script and records what it was asked. */
function scripted(answers: readonly string[]): { prompt: () => Prompter; asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];

  const next = (question: string): string => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unscripted question: ${question}`);
    return answer;
  };

  const prompter: Prompter = {
    text: (question) => Promise.resolve(next(question)),
    choose: <T,>(question: string, choices: readonly Choice<T>[]): Promise<T> => {
      const picked = choices[Number.parseInt(next(question), 10) - 1];
      if (picked === undefined) throw new Error(`no such choice for ${question}`);
      return Promise.resolve(picked.value);
    },
    confirm: (question) => Promise.resolve(next(question) === 'y'),
    close: () => {},
  };

  return { prompt: () => prompter, asked };
}

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function capture(argv: string[], cwd: string, prompt?: () => Prompter): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      env: {},
      cwd,
      ...(prompt === undefined ? {} : { prompt }),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

/** Set it up, pick OpenAI, answer everything else with the given lines. */
function configure(rest: readonly string[]): ReturnType<typeof scripted> {
  return scripted(['2', '2', ...rest]);
}

const NOTHING = ['', '', '', '', ''];

describe('hushgate setup — the configuration branch', () => {
  it('writes a configuration from the answers', async () => {
    const dir = workspace();
    const script = configure([
      'Nordwerk Maschinenbau GmbH',
      'datenschutz@nordwerk-gmbh.de',
      '',
      '',
      '',
    ]);

    const c = capture(['setup'], dir, script.prompt);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'hushgate.config.json'))).toBe(true);

    const written = readFileSync(join(dir, 'hushgate.config.json'), 'utf8');
    expect(written).toContain('"name": "Nordwerk Maschinenbau GmbH"');
    expect(written).toContain('"contact": "datenschutz@nordwerk-gmbh.de"');
    expect(written).toContain('"dpo": null');
    expect(written).toContain('https://api.openai.com');
  });

  it('points both routes at the chosen provider', async () => {
    const dir = workspace();
    const script = scripted(['2', '1', ...NOTHING]); // Mistral
    const c = capture(['setup'], dir, script.prompt);
    await run(c.cli);

    // Leaving the other route on its default would name a provider that is not
    // on the allowlist, and the residency check is fail-closed: the proxy would
    // refuse to start on a file the wizard had just written.
    const written = readFileSync(join(dir, 'hushgate.config.json'), 'utf8');
    expect(written).toContain('"openai": "https://api.mistral.ai"');
    expect(written).toContain('"anthropic": "https://api.mistral.ai"');
    expect(c.out()).toContain('Both routes forward to');
  });

  it('writes a configuration the proxy would actually start on', async () => {
    const dir = workspace();
    const script = scripted(['2', '1', '', '', '', '', 'Art. 28 DPA of 2026-01-12']);
    const c = capture(['setup'], dir, script.prompt);
    await run(c.cli);

    // doctor exits 0 only when nothing failed and nothing warned.
    expect(await run(capture(['doctor'], dir).cli)).toBe(EXIT.ok);
    expect(c.out()).not.toContain('FAIL');
  });

  it('marks every question after the provider as optional', async () => {
    const dir = workspace();
    const script = configure(NOTHING);
    await run(capture(['setup'], dir, script.prompt).cli);

    // The first two are the mode and the provider; everything after is optional.
    for (const question of script.asked.slice(2)) expect(question).toMatch(/optional/iu);
  });

  it('offers the provider question before anything else', async () => {
    const dir = workspace();
    const script = configure(NOTHING);
    await run(capture(['setup'], dir, script.prompt).cli);

    expect(script.asked[0]).toContain('What would you like to do');
    expect(script.asked[1]).toContain('Which provider');
  });

  it('says what is still missing instead of asking for it', async () => {
    const dir = workspace();
    const c = capture(['setup'], dir, configure(NOTHING).prompt);
    await run(c.cli);

    expect(c.out()).toContain('no residency allowlist is configured');
    expect(c.out()).toContain('residency.allow');
  });

  it('records a legal basis when one is given, and then says nothing is missing', async () => {
    const dir = workspace();
    const script = scripted(['2', '1', '', '', '', '', 'Art. 28 DPA of 2026-01-12']);
    const c = capture(['setup'], dir, script.prompt);
    await run(c.cli);

    const written = readFileSync(join(dir, 'hushgate.config.json'), 'utf8');
    expect(written).toContain('Art. 28 DPA of 2026-01-12');
    expect(written).toContain('"jurisdiction": "FR"');
    expect(written).toContain('"endpoint": "https://api.mistral.ai"');
    expect(c.out()).not.toContain('no residency allowlist is configured');
    expect(c.out()).toContain('nothing unsafe found');
  });

  it('writes a file the loader accepts', async () => {
    const dir = workspace();
    await run(capture(['setup'], dir, configure(NOTHING).prompt).cli);

    const c = capture(['doctor', '--allow-warnings'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
  });

  it('tells the operator how to start it', async () => {
    const dir = workspace();
    const c = capture(['setup'], dir, configure(NOTHING).prompt);
    await run(c.cli);
    expect(c.out()).toContain('hushgate serve');
  });

  it('refuses to overwrite an existing configuration without --force', async () => {
    const dir = workspace();
    await run(capture(['setup'], dir, configure(NOTHING).prompt).cli);

    const c = capture(['setup'], dir, configure(NOTHING).prompt);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('--force');
  });

  it('overwrites when told to', async () => {
    const dir = workspace();
    await run(capture(['setup'], dir, configure(NOTHING).prompt).cli);

    const second = configure(['Second GmbH', '', '', '', '']);
    expect(await run(capture(['setup', '--force'], dir, second.prompt).cli)).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'hushgate.config.json'), 'utf8')).toContain('Second GmbH');
  });

  it('writes where --path says', async () => {
    const dir = workspace();
    const c = capture(['setup', '--path', 'config/hg.json'], dir, configure(NOTHING).prompt);
    await run(c.cli);
    expect(existsSync(join(dir, 'config/hg.json'))).toBe(true);
  });

  it('sends a caller with no terminal to init', async () => {
    const dir = workspace();
    const c = capture(['setup'], dir); // no prompt factory: not a TTY
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('hushgate init');
    expect(existsSync(join(dir, 'hushgate.config.json'))).toBe(false);
  });
});

describe('hushgate setup — the trial branch', () => {
  /** Run the trial until it has printed its banner, then stop it. */
  async function runTrial(
    dir: string,
    argv: readonly string[],
    answers: readonly string[],
  ): Promise<Capture> {
    const script = scripted(answers);
    const c = capture([...argv], dir, script.prompt);
    const controller = new AbortController();
    const running = run({ ...c.cli, signal: controller.signal });

    await waitFor(() => c.out().includes('__playground') || c.err() !== '');
    controller.abort();
    await running;
    return c;
  }

  it('asks only for the provider and the key, then serves the page', async () => {
    const dir = workspace();
    const c = await runTrial(dir, ['setup'], ['1', '2', 'sk-test']);

    expect(c.out()).toMatch(/http:\/\/127\.0\.0\.1:\d+\/__playground/u);
    expect(existsSync(join(dir, 'hushgate.config.json'))).toBe(false);
  });

  it('asks three questions and no more', async () => {
    const dir = workspace();
    const script = scripted(['1', '2', 'sk-test']);
    const c = capture(['setup'], dir, script.prompt);
    const controller = new AbortController();
    const running = run({ ...c.cli, signal: controller.signal });

    await waitFor(() => c.out().includes('__playground'));
    controller.abort();
    await running;

    expect(script.asked).toHaveLength(3);
    expect(script.asked[2]).toMatch(/key/iu);
  });

  it('never prints the key it was given', async () => {
    const dir = workspace();
    const c = await runTrial(dir, ['setup'], ['1', '2', 'sk-very-secret']);
    expect(c.out()).not.toContain('sk-very-secret');
    expect(c.err()).not.toContain('sk-very-secret');
  });

  it('refuses a trial that would not be loopback', async () => {
    const dir = workspace();
    const script = scripted(['1', '2', 'sk-test']);
    const c = capture(['setup', '--host', '0.0.0.0'], dir, script.prompt);

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('loopback');
  });

  it('insists on a key rather than starting without one', async () => {
    const dir = workspace();
    const script = scripted(['1', '2', '']);
    const c = capture(['setup'], dir, script.prompt);
    const controller = new AbortController();

    // An empty answer to a required question would loop forever against a real
    // prompter; the scripted one returns it once, and setup must not proceed.
    const running = run({ ...c.cli, signal: controller.signal });
    await waitFor(() => c.err() !== '' || c.out().includes('__playground'));
    controller.abort();
    await running;

    expect(c.err()).toContain('key');
    expect(c.out()).not.toContain('__playground');
  });
});
