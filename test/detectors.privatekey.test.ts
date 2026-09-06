import { describe, expect, it } from 'vitest';
import { secretDetector } from '../src/detectors/secret.js';
import type { Span } from '../src/types.js';

const find = (text: string): Span[] => secretDetector.find(text);
const values = (text: string): string[] => find(text).map((s) => s.value);

/** A real-shaped but entirely synthetic RSA body. */
const BODY = [
  'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu',
  'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQJAIDvkFyq3s7pQ0mQ0Uz0P',
  'KUpRKfFLfRYC9AIKjbJTWit+CqvjWYzvQwECAwEAAQ==',
];

describe('PEM private key armour', () => {
  it.each([
    '-----BEGIN RSA PRIVATE KEY-----',
    '-----BEGIN DSA PRIVATE KEY-----',
    '-----BEGIN EC PRIVATE KEY-----',
    '-----BEGIN DH PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN ENCRYPTED PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----',
    '-----BEGIN PGP PRIVATE KEY BLOCK-----',
    '-----BEGIN SSH2 ENCRYPTED PRIVATE KEY-----',
  ])('fires on a bare header with no body at all: %s', (header) => {
    const found = find(`payload:\n${header}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(header);
    expect(found[0]?.kind).toBe('SECRET');
  });

  it.each([
    ['----- BEGIN RSA PRIVATE KEY -----', 'spaces inside the armour'],
    ['-----begin rsa private key-----', 'all lowercase'],
    ['-----Begin Openssh Private Key-----', 'title case'],
    ['---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----', 'RFC 4716 four-dash armour'],
    ['--------BEGIN EC PRIVATE KEY--------', 'over-long dash runs'],
    ['-----BEGIN\tRSA\tPRIVATE\tKEY-----', 'tabs between the words'],
  ])('fires on the %s spelling (%s)', (header) => {
    expect(values(`x ${header} y`)).toEqual([header]);
  });

  it('covers the whole block, armour to armour, not just the header line', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...BODY, '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    );
    const found = find(`key:\n${pem}\ntrailing prose here`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(pem);
    // The point of the whole exercise: no key material survives outside the span.
    expect(found[0]?.value).toContain(BODY[1]);
  });

  it('covers an encrypted block including its RFC 1421 headers and blank line', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'Proc-Type: 4,ENCRYPTED',
      'DEK-Info: AES-128-CBC,7A0B1C2D3E4F5061',
      '',
      ...BODY,
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    expect(values(pem)).toEqual([pem]);
  });

  it('covers a PGP block with armour headers and its CRC line', () => {
    const pem = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'Version: GnuPG v2',
      'Comment: https://example.invalid',
      '',
      ...BODY,
      '=Ab3d',
      '-----END PGP PRIVATE KEY BLOCK-----',
    ].join('\n');
    expect(values(pem)).toEqual([pem]);
  });

  it('still covers the key material when the END armour is missing', () => {
    const truncated = ['-----BEGIN RSA PRIVATE KEY-----', ...BODY].join('\n');
    const found = find(`${truncated}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(truncated);
  });

  it('stops at the first line that is not key material when END is missing', () => {
    const truncated = ['-----BEGIN EC PRIVATE KEY-----', BODY[0]].join('\n');
    const found = find(`${truncated}\nSorry, I truncated the rest of it.`);
    expect(found).toHaveLength(1);
    expect(found[0]?.value).toBe(truncated);
  });

  it('does not run past the end of the text when the body is unterminated', () => {
    const truncated = `-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY[0]}`;
    expect(values(truncated)).toEqual([truncated]);
    // Header flush against the end of input, no newline at all.
    expect(values('-----BEGIN PRIVATE KEY-----')).toEqual(['-----BEGIN PRIVATE KEY-----']);
    expect(values('-----BEGIN PRIVATE KEY---')).toEqual([]);
  });

  it('closes the block even when the END armour names a different algorithm', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...BODY, '-----END EC PRIVATE KEY-----'].join(
      '\n',
    );
    expect(values(pem)).toEqual([pem]);
  });

  it('reports two concatenated blocks separately', () => {
    const one = ['-----BEGIN RSA PRIVATE KEY-----', BODY[0], '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    );
    const two = ['-----BEGIN EC PRIVATE KEY-----', BODY[2], '-----END EC PRIVATE KEY-----'].join(
      '\n',
    );
    expect(values(`${one}\n\n${two}`)).toEqual([one, two]);
  });

  it('keeps the load-bearing span invariant', () => {
    const text = `notes\n-----BEGIN RSA PRIVATE KEY-----\n${BODY[0]}\n-----END RSA PRIVATE KEY-----\nend`;
    for (const span of find(text)) {
      expect(span.value).toBe(text.slice(span.start, span.end));
      expect(span.priority).toBe(100);
      expect(span.detector).toBe('secret:pem-private-key');
    }
  });
});

describe('PEM armour negatives', () => {
  it.each([
    'Please send me the private key when you get a chance.',
    'The private key never leaves the HSM; only the public key is exported.',
    'BEGIN RSA PRIVATE KEY is the header a PEM file starts with.',
    'Section 4.2 — Private Key Handling',
    'privateKey = loadPrivateKey(path)',
  ])('does not fire on prose that merely mentions a private key: %s', (prose) => {
    expect(find(prose)).toEqual([]);
  });

  it.each([
    '-----BEGIN PUBLIC KEY-----',
    '-----BEGIN RSA PUBLIC KEY-----',
    '-----BEGIN CERTIFICATE-----',
    '-----BEGIN CERTIFICATE REQUEST-----',
    '-----BEGIN PGP SIGNATURE-----',
  ])('does not fire on non-private armour: %s', (header) => {
    expect(find(`${header}\n${BODY[0]}\n`)).toEqual([]);
  });

  it('does not fire on an END armour with no BEGIN before it', () => {
    expect(find('-----END RSA PRIVATE KEY-----')).toEqual([]);
  });
});

describe('PEM armour scanning cost', () => {
  it('stays linear when the terminator is absent from a large body', () => {
    // The old lazy `[\s\S]*?-----END …` shape rescanned the whole remainder for
    // every unterminated BEGIN — quadratic, and trivially reachable from a
    // request body. 20k headers is ~640 KB, far under the 4 MiB body limit.
    const text = '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(20_000);
    const started = performance.now();
    const found = find(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(found).toHaveLength(20_000);
  });

  it('stays linear when a single BEGIN is followed by a huge non-key body', () => {
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${'lorem ipsum dolor sit amet\n'.repeat(20_000)}`;
    const started = performance.now();
    const found = find(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(found[0]?.value).toBe('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('does not swallow a whole document to reach a far-away END armour', () => {
    const filler = 'Unrelated paragraph of the ticket.\n'.repeat(8000);
    const text = `-----BEGIN RSA PRIVATE KEY-----\n${filler}-----END RSA PRIVATE KEY-----`;
    const found = find(text);
    expect(found[0]?.value).toBe('-----BEGIN RSA PRIVATE KEY-----');
    expect(found[0]?.value.length).toBeLessThan(200);
  });
});
