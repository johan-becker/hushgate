import { describe, expect, it } from 'vitest';
import { applyEnv, defaultConfig, parseConfig } from '../src/config.js';
import { RequestError } from '../src/errors.js';
import { ConfigError } from '../src/errors.js';
import { parseJsonObject } from '../src/proxy/http.js';

describe('M2 regression: JSON parse errors must not quote the request body', () => {
  it('reports only position info, never the body content', () => {
    // The body contains a person's name. V8's own parse error would inline a
    // slice of the source ("...\"essages\": Anna Schmi\"..."), and redaction
    // has not run at this point — so the message must be built from the offset
    // alone.
    const body = Buffer.from('{"messages": Anna Schmidt}', 'utf8');

    let error: unknown;
    try {
      parseJsonObject(body);
      expect.unreachable('parseJsonObject must reject this body');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RequestError);
    const requestError = error as RequestError;
    expect(requestError.status).toBe(400);
    expect(requestError.type).toBe('invalid_request_error');

    const message = requestError.message;
    // Position info is allowed when the runtime reports one; a generic
    // content-free message is equally acceptable.
    if (/at position \d+/u.test(message)) {
      expect(message).toMatch(/not valid JSON \(at position \d+\)/u);
    } else {
      expect(message).toBe('request body is not valid JSON');
    }
    // The caller's bytes are not.
    expect(message).not.toContain('Anna');
    expect(message).not.toContain('Schmidt');
    expect(message).not.toContain('messages');
    expect(message).not.toContain(body.toString('utf8'));
  });
});

// Declared out here rather than inside each `it`: neither closes over anything
// the test body owns, and `expect(fn).toThrow` needs the call deferred.
const loadLowercaseCategory = (): void => {
  parseConfig({
    residency: {
      categories: { phone: 'block' },
    },
  });
};

const loadMisspelledRoute = (): void => {
  parseConfig({
    residency: {
      routes: { 'openai.chat.completion': 'block' },
    },
  });
};

describe('M3 regression: residency keys that can never match are load errors', () => {
  it('rejects a lowercase categories key with a suggestion', () => {
    const run = loadLowercaseCategory;

    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      expect((error as ConfigError).message).toContain('did you mean "PHONE"');
    }
  });

  it('rejects a routes key missing its trailing s', () => {
    const run = loadMisspelledRoute;

    // A misspelled route would silently enforce nothing; it must fail the
    // load instead.
    expect(run).toThrow(ConfigError);
    try {
      run();
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain('openai.chat.completion');
      expect(message).toContain('is not a route hushgate serves');
    }
  });
});

describe('H1 regression: idle sweeper timeout is configured', () => {
  it('defaults to one minute', () => {
    expect(defaultConfig().limits.idleTimeoutMs).toBe(60_000);
  });

  it('accepts a custom value from the config file', () => {
    const config = parseConfig({ limits: { idleTimeoutMs: 30_000 } });
    expect(config.limits.idleTimeoutMs).toBe(30_000);
  });

  it('accepts an environment override', () => {
    const base = defaultConfig();
    const overridden = applyEnv(base, { HUSHGATE_IDLE_TIMEOUT_MS: '45000' });
    expect(overridden.limits.idleTimeoutMs).toBe(45_000);

    // And leaves it alone when the variable is unset.
    const untouched = applyEnv(base, {});
    expect(untouched.limits.idleTimeoutMs).toBe(60_000);
  });
});
