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
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-residency-'));
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
    cli: {
      argv,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      cwd,
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('hushgate residency', () => {
  it('reports the default US endpoints as an unrestricted configuration', async () => {
    const c = capture(['residency'], workspace());
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('US — United States [third-country]');
    expect(c.out()).toContain('no allowlist is configured');
    expect(c.out()).toContain('2 of 2 routes permitted');
    expect(c.out()).toContain('not legal advice');
  });

  it('shows the rule, the legal basis and the jurisdiction for an allowlisted upstream', async () => {
    const dir = workspace({
      upstreams: { openai: 'https://api.mistral.ai', anthropic: 'https://api.aleph-alpha.com' },
      residency: {
        allow: [
          { endpoint: 'https://api.mistral.ai', legalBasis: 'Art. 28 DPA, processing in France' },
          { endpoint: 'https://api.aleph-alpha.com', legalBasis: 'Art. 28 DPA, Heidelberg' },
        ],
      },
    });

    const c = capture(['residency'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('FR — France [eea]');
    expect(c.out()).toContain('DE — Germany [eea]');
    expect(c.out()).toContain('residency.allow[0]');
    expect(c.out()).toContain('Art. 28 DPA, processing in France');
    expect(c.out()).toContain('no third-country transfer');
  });

  it('exits non-zero and says REFUSED when a route is not allowlisted', async () => {
    const dir = workspace({
      residency: { allow: [{ endpoint: 'https://api.mistral.ai', legalBasis: 'DPA' }] },
    });

    const c = capture(['residency'], dir);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('REFUSED');
    expect(c.out()).toContain('hushgate will not start with this configuration');
  });

  it('reports the enforcement mode that applies to each route', async () => {
    const dir = workspace({
      residency: { mode: 'sanitize', routes: { 'anthropic.messages': 'warn' } },
    });

    const c = capture(['residency'], dir);
    await run(c.cli);
    expect(c.out()).toContain('sanitize  (residency.mode)');
    expect(c.out()).toContain('warn  (residency.routes.anthropic.messages)');
  });

  it('lists the retention controls in force', async () => {
    const c = capture(['residency'], workspace());
    await run(c.cli);
    expect(c.out()).toContain('zero-retention via body store=false [set per request]');
    expect(c.out()).toContain('[arranged with the provider]');
  });

  it('produces JSON for CI', async () => {
    const dir = workspace({
      upstreams: { openai: 'https://api.mistral.ai', anthropic: 'https://api.mistral.ai' },
      residency: { allow: [{ endpoint: 'https://api.mistral.ai', legalBasis: 'DPA' }] },
    });

    const c = capture(['residency', '--json'], dir);
    expect(await run(c.cli)).toBe(EXIT.ok);

    const report = JSON.parse(c.out()) as {
      permitted: boolean;
      routes: { jurisdiction: { code: string; status: string }; rule: string }[];
    };
    expect(report.permitted).toBe(true);
    expect(report.routes).toHaveLength(2);
    expect(report.routes[0]!.jurisdiction).toEqual({
      code: 'FR',
      name: 'France',
      status: 'eea',
    });
    expect(report.routes[0]!.rule).toBe('residency.allow[0]');
  });

  it('lists the built-in registry so an EU alternative can be found', async () => {
    const c = capture(['residency', '--registry'], workspace());
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('Mistral AI');
    expect(c.out()).toContain('Aleph Alpha');
    expect(c.out()).toContain('bedrock-runtime.eu-central-1.amazonaws.com');
    expect(c.out()).toContain('Confirm them against your own contract');
  });

  it('lists the registry as JSON too', async () => {
    const c = capture(['residency', '--registry', '--json'], workspace());
    await run(c.cli);
    const report = JSON.parse(c.out()) as { endpoints: { id: string; status: string }[] };
    expect(report.endpoints.some((entry) => entry.id === 'mistral.api' && entry.status === 'eea')).toBe(
      true,
    );
  });
});
