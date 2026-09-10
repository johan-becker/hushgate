/**
 * `hushgate briefing` — the command that makes the words hushgate adds to
 * somebody else's request visible before an answer goes wrong.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';

const dirs: string[] = [];

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function workspace(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-briefing-'));
  dirs.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'hushgate.config.json'), JSON.stringify(config, null, 2));
  }
  return dir;
}

function capture(argv: string[], cwd: string): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: { argv, stdout: (text) => out.push(text), stderr: (text) => err.push(text), env: {}, cwd },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('hushgate briefing', () => {
  it('prints the built-in text on a default configuration', async () => {
    const c = capture(['briefing'], workspace());

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('mode     auto');
    expect(c.out()).toContain('text     the built-in briefing');
    expect(c.out()).toContain('A placeholder is written [KIND_n]');
    expect(c.out()).toContain('Never put an invented value');
  });

  it('renders it for the kinds a request would carry', async () => {
    const c = capture(['briefing', '--kinds', 'EMAIL,IBAN'], workspace());

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('e-mail addresses ([EMAIL_n])');
    expect(c.out()).toContain('bank accounts ([IBAN_n])');
  });

  it('takes the policy that produced each token', async () => {
    const c = capture(['briefing', '--kinds', 'EMAIL,SECRET:redact'], workspace());

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('[SECRET_REDACTED]');
    expect(c.out()).toContain('is not reversible');
  });

  it('refuses a policy that produces no placeholder', async () => {
    const c = capture(['briefing', '--kinds', 'EMAIL:allow'], workspace());

    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('is not a policy that produces a placeholder');
  });

  it('shows a custom briefing as custom, and shows it', async () => {
    const dir = workspace({ briefing: { text: 'Answer as Acme support.' } });
    const c = capture(['briefing'], dir);

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('text     replaced by briefing.text');
    expect(c.out()).toContain('Answer as Acme support.');
  });

  it('says plainly when nothing is attached to any request', async () => {
    const c = capture(['briefing'], workspace({ briefing: { mode: 'off' } }));

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('nothing is added to any request');
  });

  it('renders one tenant’s briefing', async () => {
    const dir = workspace({
      briefing: { append: 'House rule.' },
      tenants: [
        { id: 'support', keyHash: `sha256:${'0'.repeat(64)}`, briefing: { append: 'Answer in German.' } },
        { id: 'legal', keyHash: `sha256:${'1'.repeat(64)}` },
      ],
    });

    const support = capture(['briefing', '--tenant', 'support'], dir);
    expect(await run(support.cli)).toBe(EXIT.ok);
    expect(support.out()).toContain('Answer in German.');
    expect(support.out()).not.toContain('House rule.');

    // A tenant that says nothing inherits the house rules rather than losing them.
    const legal = capture(['briefing', '--tenant', 'legal'], dir);
    expect(await run(legal.cli)).toBe(EXIT.ok);
    expect(legal.out()).toContain('House rule.');
  });

  it('names the tenants it knows when asked for one it does not', async () => {
    const dir = workspace({ tenants: [{ id: 'support', keyHash: `sha256:${'0'.repeat(64)}` }] });
    const c = capture(['briefing', '--tenant', 'sales'], dir);

    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('known tenants are support');
  });

  it('reports the whole state as JSON', async () => {
    const dir = workspace({ briefing: { mode: 'always', append: 'House rule.' } });
    const c = capture(['briefing', '--json', '--kinds', 'EMAIL'], dir);

    expect(await run(c.cli)).toBe(EXIT.ok);
    const report = JSON.parse(c.out()) as {
      mode: string;
      origin: string;
      appended: boolean;
      attached: boolean;
      text: string;
    };

    expect(report.mode).toBe('always');
    expect(report.origin).toBe('built-in');
    expect(report.appended).toBe(true);
    expect(report.attached).toBe(true);
    expect(report.text).toContain('e-mail addresses');
  });

  it('shows the text even when auto would not attach it to an empty request', async () => {
    const c = capture(['briefing', '--json'], workspace());

    expect(await run(c.cli)).toBe(EXIT.ok);
    const report = JSON.parse(c.out()) as { attached: boolean; text: string };
    expect(report.attached).toBe(false);
    expect(report.text).toContain('A placeholder is written');
  });

  it('is listed in the overall help', async () => {
    const c = capture(['--help'], workspace());
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('briefing');
  });
});
