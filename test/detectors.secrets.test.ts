import { describe, expect, it } from 'vitest';
import { isJwtHeaderSegment, secretDetector } from '../src/detectors/secret.js';
import { urlCredentialsDetector } from '../src/detectors/urlcredentials.js';
import { createDictionaryDetector } from '../src/detectors/dictionary.js';
import { createCustomDetector, normaliseKindName } from '../src/detectors/custom.js';
import { ConfigError } from '../src/errors.js';
import type { Detector } from '../src/types.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((s) => s.value);

/** A real-shaped but entirely synthetic JWT: {"alg":"HS256","typ":"JWT"}. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJuYW1lIjoiVGVzdCJ9.qq0m3nQ1yQ0m3nQ1yQ';

describe('SECRET', () => {
  it.each([
    ['sk-abcdefghijklmnopqrstuvwx', 'OpenAI key'],
    ['sk-proj-abcdefghijklmnopqrstuvwx', 'OpenAI project key'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'Anthropic key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub PAT'],
    ['gho_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub OAuth token'],
    ['ghs_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub server token'],
    ['github_pat_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub fine-grained PAT'],
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    ['ASIAIOSFODNN7EXAMPLE', 'AWS session key id'],
    ['AIzaSyA0123456789abcdefghijklmnopqrstuv', 'Google API key'],
    ['xoxb-123456789012-abcdefghijkl', 'Slack bot token'],
    ['xoxp-123456789012-abcdefghijkl', 'Slack user token'],
    [JWT, 'JWT'],
  ])('finds %s (%s)', (secret) => {
    expect(values(`token: ${secret}`, secretDetector)).toEqual([secret]);
  });

  it('finds a PEM private key block including its armour', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
      'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const found = secretDetector.find(`key:\n${pem}\nrest`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(pem);
  });

  it('rejects three base64-ish blobs that are not a JWT', () => {
    expect(isJwtHeaderSegment('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(true);
    expect(isJwtHeaderSegment('bm90LWpzb24tYXQtYWxs')).toBe(false);
    expect(secretDetector.find('aaaaaaaa.bbbbbbbb.cccccccc')).toEqual([]);
  });

  it('rejects a JWT-shaped string whose header is not a JSON object', () => {
    // base64url of "[1,2,3]" — valid JSON, but an array, so no alg/typ.
    expect(isJwtHeaderSegment('WzEsMiwzXQ')).toBe(false);
  });

  it('reports overlapping key patterns as a single span', () => {
    // `sk-ant-…` matches both the Anthropic and the generic OpenAI pattern.
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345';
    const found = secretDetector.find(key);
    const starts = new Set(found.map((s) => `${s.start}:${s.end}`));
    expect(starts.size).toBe(1);
  });

  it('does not fire on ordinary prose', () => {
    expect(secretDetector.find('The sky is blue and the key is under the mat.')).toEqual([]);
  });
});

describe('URL_CREDENTIALS', () => {
  it.each([
    'postgres://admin:s3cr3t@db.internal.example:5432/app',
    'https://user:pass@intranet.example.com/reports',
    'redis://default:hunter2@cache.example.com:6379',
    'ftp://bob:@files.example.org/pub',
  ])('finds %s', (url) => {
    expect(values(`connect to ${url} now`, urlCredentialsDetector)).toEqual([url]);
  });

  it('claims the whole URL, host included', () => {
    const url = 'postgres://admin:s3cr3t@db.internal.example:5432/app';
    const [span] = urlCredentialsDetector.find(url);
    expect(span?.value).toBe(url);
  });

  it('ignores a URL with a port but no credentials', () => {
    expect(urlCredentialsDetector.find('https://example.com:8080/path')).toEqual([]);
  });

  it('drops trailing sentence punctuation', () => {
    expect(values('see https://u:p@host.example/x.', urlCredentialsDetector)).toEqual([
      'https://u:p@host.example/x',
    ]);
  });
});

describe('dictionary NAME / TERM', () => {
  const detector = createDictionaryDetector([
    { value: 'Johan Becker', kind: 'NAME' },
    { value: 'Johan', kind: 'NAME' },
    { value: 'Projekt Nordstern', kind: 'TERM' },
    { value: 'Zoë', kind: 'NAME' },
  ]);

  it('matches case-insensitively', () => {
    expect(values('JOHAN BECKER kommt', detector)).toEqual(['JOHAN BECKER']);
    expect(values('johan kommt', detector)).toEqual(['johan']);
  });

  it('prefers the longest entry at the same offset', () => {
    const [span] = detector.find('Johan Becker ruft an');
    expect(span?.value).toBe('Johan Becker');
    expect(span?.kind).toBe('NAME');
  });

  it('matches whole words only', () => {
    expect(detector.find('Johannes kommt')).toEqual([]);
    expect(detector.find('SuperJohan')).toEqual([]);
  });

  it('handles non-ASCII entries, where \\b would fail', () => {
    // `\bZoë\b` never matches because ë is not a \w character.
    expect(values('Hallo Zoë!', detector)).toEqual(['Zoë']);
    expect(detector.find('Zoëy')).toEqual([]);
  });

  it('reports the configured kind', () => {
    expect(detector.find('Projekt Nordstern startet')[0]?.kind).toBe('TERM');
  });

  it('returns nothing for an empty dictionary', () => {
    expect(createDictionaryDetector([]).find('anything at all')).toEqual([]);
    expect(createDictionaryDetector([{ value: '   ' }]).find('anything')).toEqual([]);
  });

  it('rejects a kind that is not UPPER_SNAKE_CASE', () => {
    expect(() => createDictionaryDetector([{ value: 'x', kind: 'lower' }])).toThrow(ConfigError);
  });
});

describe('CUSTOM rules', () => {
  it('reports the normalised rule name as the kind', () => {
    const detector = createCustomDetector({ name: 'employee id', pattern: String.raw`EMP-\d{6}` });
    const [span] = detector.find('ticket from EMP-123456 today');
    expect(span?.kind).toBe('EMPLOYEE_ID');
    expect(span?.value).toBe('EMP-123456');
  });

  it('normalises names', () => {
    expect(normaliseKindName('employee-id')).toBe('EMPLOYEE_ID');
    expect(normaliseKindName('  Case Number  ')).toBe('CASE_NUMBER');
  });

  it('rejects names that cannot become a kind', () => {
    expect(() => normaliseKindName('123')).toThrow(ConfigError);
    expect(() => normaliseKindName('---')).toThrow(ConfigError);
  });

  it('honours the case-insensitive flag', () => {
    const detector = createCustomDetector({ name: 'CODE', pattern: 'abc', flags: 'i' });
    expect(values('ABC and abc', detector)).toEqual(['ABC', 'abc']);
  });

  it('rejects unsupported flags', () => {
    expect(() => createCustomDetector({ name: 'X', pattern: 'a', flags: 'y' })).toThrow(
      ConfigError,
    );
  });

  it('rejects an invalid pattern with a readable message', () => {
    expect(() => createCustomDetector({ name: 'X', pattern: '([unclosed' })).toThrow(
      /invalid pattern/u,
    );
  });

  it('does not loop forever on a pattern that can match nothing', () => {
    const detector = createCustomDetector({ name: 'X', pattern: 'a*' });
    expect(values('bab', detector)).toEqual(['a']);
  });
});
