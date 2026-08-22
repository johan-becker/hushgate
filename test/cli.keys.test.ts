import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { run } from '../src/cli/run.js';
import { hashKey } from '../src/tenants/tenant.js';

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function capture(argv: string[], stdin?: string): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      cwd: process.cwd(),
      ...(stdin === undefined ? {} : { stdin: Readable.from([stdin]) as NodeJS.ReadableStream }),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('hushgate keys new', () => {
  it('prints the key once and the config snippet to paste', async () => {
    const c = capture(['keys', 'new', 'support']);
    expect(await run(c.cli)).toBe(EXIT.ok);

    const key = /\b(hg_[A-Za-z0-9_-]+)\b/u.exec(c.out())?.[1];
    expect(key).toBeDefined();
    expect(c.out()).toContain(`"keyHash": "sha256:${hashKey(key!)}"`);
    expect(c.out()).toContain('hushgate does not store it');
    expect(c.out()).toContain('"id": "support"');
  });

  it('emits JSON when asked', async () => {
    const c = capture(['keys', 'new', 'support', '--json']);
    await run(c.cli);
    const payload = JSON.parse(c.out()) as { tenant: string; key: string; keyHash: string };
    expect(payload.tenant).toBe('support');
    expect(payload.keyHash).toBe(`sha256:${hashKey(payload.key)}`);
  });

  it('needs a tenant id, and a usable one', async () => {
    expect(await run(capture(['keys', 'new']).cli)).toBe(EXIT.failure);
    expect(await run(capture(['keys', 'new', 'has space']).cli)).toBe(EXIT.failure);
  });

  it('needs a subcommand', async () => {
    const c = capture(['keys']);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('needs a subcommand');
  });
});

describe('hushgate keys hash', () => {
  it('hashes a key from standard input, for rotation', async () => {
    const c = capture(['keys', 'hash'], 'hg_existing_key\n');
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out().trim()).toBe(`sha256:${hashKey('hg_existing_key')}`);
  });

  it('warns when the key was not issued by hushgate but hashes it anyway', async () => {
    const c = capture(['keys', 'hash'], 'sk-someone-elses-key');
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.err()).toContain('does not look like one hushgate issued');
    expect(c.out().trim()).toBe(`sha256:${hashKey('sk-someone-elses-key')}`);
  });

  it('refuses an empty key', async () => {
    const c = capture(['keys', 'hash'], '   \n');
    expect(await run(c.cli)).toBe(EXIT.failure);
  });
});
