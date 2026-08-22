import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEnv,
  applyOverrides,
  CONFIG_FILENAME,
  defaultConfig,
  loadConfig,
  normaliseUrl,
  parseConfig,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-config-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('defaults', () => {
  it('binds to loopback', () => {
    // Anything else would expose the placeholder mapping to the network.
    expect(defaultConfig().host).toBe('127.0.0.1');
  });

  it('pseudonymises by default', () => {
    expect(defaultConfig().redaction.defaultPolicy).toBe('pseudonymize');
  });
});

describe('parseConfig', () => {
  it('overlays a partial file on the defaults', () => {
    const config = parseConfig({ port: 9000, redaction: { policies: { SECRET: 'block' } } });
    expect(config.port).toBe(9000);
    expect(config.host).toBe(defaultConfig().host);
    expect(config.redaction.policies).toEqual({ SECRET: 'block' });
  });

  it('reads dictionary, custom rules and the birth-year window', () => {
    const config = parseConfig({
      redaction: {
        dictionary: { names: ['Anna Schmidt'], entries: [{ value: 'Projekt Nord', kind: 'TERM' }] },
        custom: [{ name: 'employee id', pattern: 'EMP-\\d{5}', flags: 'i' }],
        dobYearRange: { minYear: 1920, maxYear: 2010 },
      },
    });
    expect(config.redaction.dictionary.names).toEqual(['Anna Schmidt']);
    expect(config.redaction.dictionary.entries).toEqual([{ value: 'Projekt Nord', kind: 'TERM' }]);
    expect(config.redaction.custom[0]).toEqual({
      name: 'employee id',
      pattern: 'EMP-\\d{5}',
      flags: 'i',
    });
    expect(config.redaction.dobYearRange).toEqual({ minYear: 1920, maxYear: 2010 });
  });

  it('rejects an unknown top-level key and says which keys exist', () => {
    expect(() => parseConfig({ prot: 1234 })).toThrow(/unknown key "prot"/u);
    expect(() => parseConfig({ prot: 1234 })).toThrow(/known keys are/u);
  });

  it('rejects an unknown nested key', () => {
    expect(() => parseConfig({ redaction: { polices: {} } })).toThrow(ConfigError);
  });

  it('rejects a misspelled policy rather than degrading quietly', () => {
    expect(() => parseConfig({ redaction: { policies: { EMAIL: 'pseudonymise' } } })).toThrow(
      /is not a policy/u,
    );
  });

  it('rejects a lowercase kind', () => {
    expect(() => parseConfig({ redaction: { policies: { email: 'redact' } } })).toThrow(
      /UPPER_SNAKE_CASE/u,
    );
  });

  it('rejects an out-of-range port but allows the ephemeral 0', () => {
    expect(parseConfig({ port: 0 }).port).toBe(0);
    expect(() => parseConfig({ port: -1 })).toThrow(/between 0 and 65535/u);
    expect(() => parseConfig({ port: 70_000 })).toThrow(ConfigError);
    expect(() => parseConfig({ port: '8080' })).toThrow(ConfigError);
  });

  it('rejects a birth-year window that runs backwards', () => {
    expect(() =>
      parseConfig({ redaction: { dobYearRange: { minYear: 2010, maxYear: 1990 } } }),
    ).toThrow(/is after maxYear/u);
  });

  it('names the offending path in the message', () => {
    expect(() => parseConfig({ redaction: { custom: [{ pattern: 'x' }] } }, 'my.json')).toThrow(
      /my\.json: "redaction"\.custom\[0\]\.name/u,
    );
  });
});

describe('the shipped example config', () => {
  it('is valid — the file people copy must not be the file that fails', () => {
    const example = readFileSync(join(import.meta.dirname, '..', 'hushgate.config.example.json'), 'utf8');
    const config = parseConfig(JSON.parse(example), 'hushgate.config.example.json');
    expect(config.redaction.policies['SECRET']).toBe('block');
    expect(config.audit.enabled).toBe(true);
  });

  it('ignores a $schema key', () => {
    expect(() => parseConfig({ $schema: 'https://example/schema.json' })).not.toThrow();
  });
});

describe('normaliseUrl', () => {
  it('drops trailing slashes so path joining stays simple', () => {
    expect(normaliseUrl('https://api.openai.com/', 'x')).toBe('https://api.openai.com');
    expect(normaliseUrl('https://eu.example/v1/', 'x')).toBe('https://eu.example/v1');
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    expect(() => normaliseUrl('api.openai.com', 'x')).toThrow(ConfigError);
    expect(() => normaliseUrl('ftp://example.com', 'x')).toThrow(/http or https/u);
    expect(() => normaliseUrl('https://example.com/?k=v', 'x')).toThrow(/query string/u);
  });
});

describe('applyEnv', () => {
  it('overlays every knob a container needs', () => {
    const config = applyEnv(defaultConfig(), {
      HUSHGATE_HOST: '0.0.0.0',
      HUSHGATE_PORT: '9999',
      HUSHGATE_UPSTREAM_OPENAI: 'https://eu.example/openai/',
      HUSHGATE_UPSTREAM_ANTHROPIC: 'https://eu.example/anthropic',
      HUSHGATE_DEFAULT_POLICY: 'redact',
      HUSHGATE_HMAC_KEY: 'k',
      HUSHGATE_MAX_BODY_BYTES: '1024',
      HUSHGATE_UPSTREAM_TIMEOUT_MS: '5000',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
    expect(config.upstreams.openai).toBe('https://eu.example/openai');
    expect(config.redaction.defaultPolicy).toBe('redact');
    expect(config.redaction.hmacKey).toBe('k');
    expect(config.limits.maxBodyBytes).toBe(1024);
    expect(config.limits.upstreamTimeoutMs).toBe(5000);
  });

  it('leaves the config alone when nothing is set', () => {
    expect(applyEnv(defaultConfig(), {})).toEqual(defaultConfig());
  });

  it('rejects a malformed environment value', () => {
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_PORT: 'eighty' })).toThrow(ConfigError);
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_DEFAULT_POLICY: 'nope' })).toThrow(
      ConfigError,
    );
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_UPSTREAM_OPENAI: 'nope' })).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig', () => {
  it('reads the config file from the working directory', () => {
    const dir = workspace({ [CONFIG_FILENAME]: JSON.stringify({ port: 4242 }) });
    const { config, source } = loadConfig({ cwd: dir, env: {} });
    expect(config.port).toBe(4242);
    expect(source.path).toBe(join(dir, CONFIG_FILENAME));
  });

  it('falls back to the defaults when there is no file', () => {
    const dir = workspace();
    const { config, source } = loadConfig({ cwd: dir, env: {} });
    expect(config).toEqual(defaultConfig());
    expect(source.path).toBeNull();
  });

  it('fails loudly when an explicitly named file is missing', () => {
    const dir = workspace();
    expect(() => loadConfig({ cwd: dir, path: 'nope.json', env: {} })).toThrow(
      /cannot read config file/u,
    );
  });

  it('reports invalid JSON with the file name', () => {
    const dir = workspace({ [CONFIG_FILENAME]: '{ "port": }' });
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/is not valid JSON/u);
  });

  it('applies file, then environment, then overrides', () => {
    const dir = workspace({ [CONFIG_FILENAME]: JSON.stringify({ port: 1111, host: 'file' }) });
    const { config } = loadConfig({
      cwd: dir,
      env: { HUSHGATE_PORT: '2222', HUSHGATE_HOST: 'env' },
      overrides: { port: 3333 },
    });
    expect(config.port).toBe(3333);
    expect(config.host).toBe('env');
  });
});

describe('applyOverrides', () => {
  it('merges nested sections instead of replacing them', () => {
    const config = applyOverrides(defaultConfig(), { upstreams: { openai: 'https://eu.example' } });
    expect(config.upstreams.openai).toBe('https://eu.example');
    expect(config.upstreams.anthropic).toBe(defaultConfig().upstreams.anthropic);
  });
});
