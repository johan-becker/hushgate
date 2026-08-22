import { describe, expect, it } from 'vitest';
import { Session, countByKind } from '../src/redact/index.js';
import { BlockedContentError, ConfigError } from '../src/errors.js';

const newSession = (options: ConstructorParameters<typeof Session>[0] = {}): Session =>
  new Session({ dobYearRange: { minYear: 1900, maxYear: 2013 }, ...options });

describe('placeholder allocation', () => {
  it('uses the documented [KIND_n] format', () => {
    const session = newSession();
    const { text } = session.redact('mail johan@example.com now');
    expect(text).toBe('mail [EMAIL_1] now');
  });

  it('maps the same value to the same placeholder every time', () => {
    const session = newSession();
    const first = session.redact('a@x.de and a@x.de');
    expect(first.text).toBe('[EMAIL_1] and [EMAIL_1]');

    const second = session.redact('again a@x.de');
    expect(second.text).toBe('again [EMAIL_1]');
  });

  it('never gives two different values the same placeholder', () => {
    const session = newSession();
    const { text } = session.redact('a@x.de, b@x.de, c@x.de, a@x.de');
    expect(text).toBe('[EMAIL_1], [EMAIL_2], [EMAIL_3], [EMAIL_1]');
    expect(session.size).toBe(3);
  });

  it('numbers each kind independently', () => {
    const session = newSession();
    const { text } = session.redact('a@x.de DE89370400440532013000 b@x.de');
    expect(text).toBe('[EMAIL_1] [IBAN_1] [EMAIL_2]');
  });

  it('treats differently cased spellings as different values', () => {
    // Restoring must reproduce the input byte for byte, so casing cannot be
    // collapsed: two spellings need two placeholders.
    const session = newSession({ dictionary: { names: ['Johan'] } });
    const { text } = session.redact('Johan und johan');
    expect(text).toBe('[NAME_1] und [NAME_2]');
    expect(session.restore(text)).toBe('Johan und johan');
  });
});

describe('round trip', () => {
  const samples = [
    'plain text with nothing in it',
    '',
    'johan@example.com',
    'IBAN DE89 3704 0044 0532 0130 00 und Karte 4111 1111 1111 1111',
    'Tel +49 721 1234567, IP 10.0.0.42, MAC 00:1A:2B:3C:4D:5E',
    'Steuer-ID 86095742719 geboren 03.07.1984',
    'token sk-abcdefghijklmnopqrstuvwx in postgres://u:p@db.example/app',
    'Ünicode ünal@example.de Zoë 2001:db8::1',
    'mehrzeilig\nzweite@zeile.de\n\tdritte@zeile.de',
  ];

  it.each(samples)('restore(redact(x)) === x for %j', (sample) => {
    const session = newSession({ dictionary: { names: ['Zoë'] } });
    const { text } = session.redact(sample);
    expect(session.restore(text)).toBe(sample);
  });

  it('holds across many redactions in the same session', () => {
    const session = newSession();
    for (const sample of samples) {
      expect(session.restore(session.redact(sample).text)).toBe(sample);
    }
  });

  it('leaves text without findings untouched', () => {
    const session = newSession();
    const result = session.redact('nothing to see');
    expect(result.text).toBe('nothing to see');
    expect(result.findings).toEqual([]);
  });
});

describe('placeholder injection', () => {
  it('does not let a pasted placeholder steal a mapping', () => {
    const session = newSession();
    const input = 'Please write to [EMAIL_1] about johan@example.com';
    const { text } = session.redact(input);

    // The pasted literal was escaped, so it is no longer the token for anything.
    expect(text).not.toContain('about [EMAIL_1]');
    expect(session.restore(text)).toBe(input);
  });

  it('round-trips text that is nothing but a placeholder', () => {
    const session = newSession();
    const input = '[EMAIL_1]';
    const { text } = session.redact(input);
    expect(text).toBe('[LITERAL_1]');
    expect(session.restore(text)).toBe(input);
  });

  it('round-trips a pasted LITERAL token', () => {
    const session = newSession();
    const input = 'see [LITERAL_1] and [LITERAL_2]';
    const { text } = session.redact(input);
    expect(session.restore(text)).toBe(input);
  });

  it('never issues a token that appeared verbatim in the input', () => {
    const session = newSession();
    // [EMAIL_1] and [EMAIL_2] are burned by the literals; the real addresses
    // must therefore get [EMAIL_3] and [EMAIL_4].
    const input = 'ghosts [EMAIL_1] [EMAIL_2] real a@x.de b@x.de';
    const { text } = session.redact(input);
    expect(text).toContain('[EMAIL_3]');
    expect(text).toContain('[EMAIL_4]');
    expect(session.restore(text)).toBe(input);
  });

  it('keeps working when the literal and a real value are interleaved', () => {
    const session = newSession();
    const inputs = [
      'a@x.de',
      '[EMAIL_1]',
      'b@x.de and [EMAIL_1]',
      '[NAME_1] [IBAN_1] c@x.de',
      'a@x.de again',
    ];
    for (const input of inputs) {
      const { text } = session.redact(input);
      expect(session.restore(text)).toBe(input);
    }
  });

  it('does not leave a restorable stray token in the sanitised text', () => {
    const session = newSession();
    const input = 'x [EMAIL_1] y a@x.de z [IBAN_7] w';
    const { text } = session.redact(input);
    // Every placeholder-shaped token in the output is one the session issued.
    for (const token of text.match(/\[[A-Z][A-Z0-9_]*_\d+\]/gu) ?? []) {
      expect(session.knows(token)).toBe(true);
    }
  });

  it('restores in a single pass, so an expanded literal is not rescanned', () => {
    const session = newSession();
    const input = '[EMAIL_2] johan@example.com';
    const { text } = session.redact(input);
    // [LITERAL_1] expands to the string "[EMAIL_2]"; that must stay literal
    // even though [EMAIL_2] might later become a real mapping.
    session.redact('a@x.de b@x.de');
    expect(session.restore(text)).toBe(input);
  });
});

describe('policies', () => {
  it('pseudonymises by default', () => {
    const session = newSession();
    expect(session.policyFor('EMAIL')).toBe('pseudonymize');
  });

  it('masks irreversibly under the redact policy', () => {
    const session = newSession({ policies: { EMAIL: 'redact' } });
    const { text } = session.redact('write to a@x.de');
    expect(text).toBe('write to [EMAIL_REDACTED]');
    expect(session.restore(text)).toBe(text);
  });

  it('hashes stably under the hash policy', () => {
    const session = newSession({ policies: { EMAIL: 'hash' }, hmacKey: 'test-key' });
    const first = session.redact('a@x.de').text;
    const second = session.redact('a@x.de').text;
    expect(first).toMatch(/^\[EMAIL:[0-9a-f]{12}\]$/u);
    expect(second).toBe(first);
    expect(session.redact('b@x.de').text).not.toBe(first);
  });

  it('produces different hashes for different session keys', () => {
    const a = newSession({ policies: { EMAIL: 'hash' }, hmacKey: 'key-a' });
    const b = newSession({ policies: { EMAIL: 'hash' }, hmacKey: 'key-b' });
    expect(a.redact('a@x.de').text).not.toBe(b.redact('a@x.de').text);
  });

  it('emits a hash token outside the reversible grammar', () => {
    const session = newSession({ policies: { EMAIL: 'hash' }, hmacKey: 'k' });
    const { text } = session.redact('a@x.de');
    expect(session.restore(text)).toBe(text);
  });

  it('leaves values untouched under the allow policy', () => {
    const session = newSession({ policies: { IPV4: 'allow' } });
    const { text, findings } = session.redact('host 10.0.0.42 and a@x.de');
    expect(text).toBe('host 10.0.0.42 and [EMAIL_1]');
    expect(findings.find((f) => f.kind === 'IPV4')?.placeholder).toBeNull();
  });

  it('refuses the whole request under the block policy', () => {
    const session = newSession({ policies: { SECRET: 'block' } });
    expect(() => session.redact('key sk-abcdefghijklmnopqrstuvwx here')).toThrow(
      BlockedContentError,
    );
  });

  it('reports blocked kinds and counts without leaking values', () => {
    const session = newSession({ policies: { SECRET: 'block' } });
    const secret = 'sk-abcdefghijklmnopqrstuvwx';
    try {
      session.redact(`${secret} and ${secret.replace('sk-a', 'sk-b')}`);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(BlockedContentError);
      const blocked = error as BlockedContentError;
      expect(blocked.counts).toEqual({ SECRET: 2 });
      expect(blocked.kinds).toEqual(['SECRET']);
      expect(blocked.message).not.toContain(secret);
    }
  });

  it('does not mutate session state when a request is blocked', () => {
    const session = newSession({ policies: { SECRET: 'block' } });
    expect(() =>
      session.redact('a@x.de and sk-abcdefghijklmnopqrstuvwx'),
    ).toThrow(BlockedContentError);
    expect(session.size).toBe(0);
  });

  it('applies the configured default policy to unlisted kinds', () => {
    const session = newSession({ defaultPolicy: 'redact', policies: { EMAIL: 'pseudonymize' } });
    const { text } = session.redact('a@x.de from 10.0.0.42');
    expect(text).toBe('[EMAIL_1] from [IPV4_REDACTED]');
  });

  it('rejects an unknown policy name', () => {
    expect(() => newSession({ policies: { EMAIL: 'nope' as never } })).toThrow(ConfigError);
    expect(() => newSession({ defaultPolicy: 'nope' as never })).toThrow(ConfigError);
  });
});

describe('findings', () => {
  it('reports offsets into the original text', () => {
    const session = newSession();
    const input = 'mail johan@example.com now';
    const { findings } = session.redact(input);
    expect(findings).toHaveLength(1);
    const [finding] = findings;
    expect(input.slice(finding!.start, finding!.end)).toBe('johan@example.com');
    expect(finding!.placeholder).toBe('[EMAIL_1]');
    expect(finding!.policy).toBe('pseudonymize');
  });

  it('counts findings per kind', () => {
    const session = newSession();
    const { findings } = session.redact('a@x.de b@x.de 10.0.0.1');
    expect(countByKind(findings)).toEqual({ EMAIL: 2, IPV4: 1 });
  });
});

describe('session lifecycle', () => {
  it('gives every session its own id', () => {
    expect(newSession().id).not.toBe(newSession().id);
  });

  it('accepts an explicit id', () => {
    expect(newSession({ id: 'fixed' }).id).toBe('fixed');
  });

  it('forgets everything on reset', () => {
    const session = newSession();
    const redacted = session.redact('a@x.de').text;
    session.reset();
    expect(session.size).toBe(0);
    expect(session.restore(redacted)).toBe(redacted);
  });
});
