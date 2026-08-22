import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageError } from '../src/errors.js';
import { boolFlag, formatFlags, intFlag, parseFlags, stringFlag } from '../src/cli/args.js';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { VERSION } from '../src/version.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { waitFor } from './helpers/wait.js';

const SPECS = {
  config: { type: 'string', alias: 'c', description: 'config path' },
  port: { type: 'number', alias: 'p', description: 'port' },
  json: { type: 'boolean', description: 'json output' },
} as const;

describe('parseFlags', () => {
  it('accepts --name value and --name=value', () => {
    expect(parseFlags(['--config', 'a.json'], SPECS).values['config']).toBe('a.json');
    expect(parseFlags(['--config=a.json'], SPECS).values['config']).toBe('a.json');
  });

  it('accepts short aliases in both forms', () => {
    expect(parseFlags(['-c', 'a.json'], SPECS).values['config']).toBe('a.json');
    expect(parseFlags(['-c=a.json'], SPECS).values['config']).toBe('a.json');
  });

  it('parses numbers', () => {
    expect(parseFlags(['-p', '8080'], SPECS).values['port']).toBe(8080);
  });

  it('handles boolean flags and their negation', () => {
    expect(parseFlags(['--json'], SPECS).values['json']).toBe(true);
    expect(parseFlags(['--no-json'], SPECS).values['json']).toBe(false);
    expect(parseFlags([], SPECS).values['json']).toBeUndefined();
  });

  it('collects positionals, including a lone dash', () => {
    const parsed = parseFlags(['scan', '-', 'notes.txt'], SPECS);
    expect(parsed.positionals).toEqual(['scan', '-', 'notes.txt']);
  });

  it('stops parsing options after --', () => {
    const parsed = parseFlags(['--', '--config', '-p'], SPECS);
    expect(parsed.positionals).toEqual(['--config', '-p']);
    expect(parsed.values['config']).toBeUndefined();
  });

  it('rejects an unknown option instead of ignoring it', () => {
    // Silently dropping --upstrem is precisely the wrong behaviour for a tool
    // whose job is being sure about where data goes.
    expect(() => parseFlags(['--upstrem', 'x'], SPECS)).toThrow(UsageError);
  });

  it('rejects a missing value', () => {
    expect(() => parseFlags(['--config'], SPECS)).toThrow(/needs a value/u);
  });

  it('rejects a value given to a boolean flag', () => {
    expect(() => parseFlags(['--json=yes'], SPECS)).toThrow(/takes no value/u);
  });

  it('rejects a non-numeric number', () => {
    expect(() => parseFlags(['-p', 'eighty'], SPECS)).toThrow(/needs a number/u);
  });
});

describe('flag accessors', () => {
  it('validates integer ranges', () => {
    const parsed = parseFlags(['-p', '70000'], SPECS);
    expect(() => intFlag(parsed, 'port', { min: 1, max: 65_535 })).toThrow(UsageError);
    expect(intFlag(parseFlags(['-p', '80'], SPECS), 'port', { min: 1, max: 65_535 })).toBe(80);
  });

  it('rejects an empty string value', () => {
    expect(() => stringFlag(parseFlags(['--config='], SPECS), 'config')).toThrow(UsageError);
  });

  it('treats an absent boolean as false', () => {
    expect(boolFlag(parseFlags([], SPECS), 'json')).toBe(false);
  });

  it('renders an aligned help table', () => {
    const help = formatFlags(SPECS);
    expect(help).toContain('-c, --config');
    expect(help).toContain('--json');
    expect(help.split('\n').every((line) => line.startsWith('  '))).toBe(true);
  });
});

/* --------------------------------------------------------------- dispatch */

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

const dirs: string[] = [];
let upstream: FakeUpstream | undefined;

function capture(argv: string[], overrides: Partial<Cli> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      cwd: process.cwd(),
      ...overrides,
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-cli-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(async () => {
  await upstream?.close();
  upstream = undefined;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('run', () => {
  it('prints help when called with no arguments', async () => {
    const c = capture([]);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('usage: hushgate <command>');
    expect(c.out()).toContain('serve');
  });

  it('prints the version', async () => {
    const c = capture(['--version']);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out().trim()).toBe(VERSION);
  });

  it('prints per-command help', async () => {
    const c = capture(['serve', '--help']);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('usage: hushgate serve');
    expect(c.out()).toContain('--upstream-openai');
  });

  it('exits 2 on an unknown command', async () => {
    const c = capture(['flush']);
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('unknown command "flush"');
  });

  it('exits 2 on a bad option', async () => {
    const c = capture(['serve', '--porrt', '80']);
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('unknown option');
  });

  it('exits 1 with a readable message on a configuration error', async () => {
    const dir = workspace();
    const c = capture(['serve', '--config', 'missing.json'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('configuration error');
  });

  it('reports the offending key when the config file is invalid', async () => {
    const dir = workspace({
      'hushgate.config.json': JSON.stringify({ redaction: { policies: { EMAIL: 'nope' } } }),
    });
    const c = capture(['serve'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('is not a policy');
  });
});

describe('hushgate serve', () => {
  it('starts the proxy, reports how to reach it, and shuts down cleanly', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace({
      'hushgate.config.json': JSON.stringify({
        port: 0,
        upstreams: { openai: upstream.origin, anthropic: upstream.origin },
        redaction: { policies: { SECRET: 'block' } },
      }),
    });

    const controller = new AbortController();
    const c = capture(['serve'], { cwd: dir, signal: controller.signal });
    const finished = run(c.cli);

    await waitFor(() => c.out().includes('listening on'), { what: 'the startup banner' });

    const origin = /listening on (\S+)/u.exec(c.out())![1]!;
    expect(c.out()).toContain(`OPENAI_BASE_URL=${origin}/v1`);
    expect(c.out()).toContain('SECRET=block');
    expect(c.out()).toContain(join(dir, 'hushgate.config.json'));

    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);

    const chat = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'a@x.de' }] }),
    });
    expect(chat.status).toBe(200);
    expect(upstream.lastRequest!.body).toContain('[EMAIL_1]');

    controller.abort();
    expect(await finished).toBe(EXIT.ok);
    expect(c.out()).toContain('shutting down');
  });

  it('lets command-line flags win over the config file', async () => {
    upstream = await startFakeUpstream();
    const dir = workspace({
      'hushgate.config.json': JSON.stringify({ port: 0, host: '127.0.0.1' }),
    });

    const controller = new AbortController();
    const c = capture(['serve', '--upstream-openai', upstream.origin], {
      cwd: dir,
      signal: controller.signal,
    });
    const finished = run(c.cli);

    await waitFor(() => c.out().includes('listening on'), { what: 'the startup banner' });
    expect(c.out()).toContain(`openai     ${upstream.origin}`);
    expect(c.out()).toContain('anthropic  https://api.anthropic.com');

    controller.abort();
    await finished;
  });

  it('refuses a port outside the valid range', async () => {
    const dir = workspace();
    const c = capture(['serve', '--port', '70000'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.usage);
  });
});
