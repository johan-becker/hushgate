import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';

const detectors = createDetectors({
  dictionary: { names: ['Anna Schmidt', 'Anna'], terms: ['Projekt Nordstern'] },
  custom: [{ name: 'employee_id', pattern: String.raw`EMP-\d{6}` }],
  dobYearRange: { minYear: 1900, maxYear: 2013 },
});

const found = (text: string): { kind: string; value: string }[] =>
  detect(text, detectors).map(({ kind, value }) => ({ kind, value }));

describe('cross-detector overlap resolution', () => {
  it('lets the URL claim the address-shaped substring inside it', () => {
    // `s3cr3t@db.example.com` alone would parse as an e-mail address.
    expect(found('use postgres://admin:s3cr3t@db.example.com:5432/app now')).toEqual([
      { kind: 'URL_CREDENTIALS', value: 'postgres://admin:s3cr3t@db.example.com:5432/app' },
    ]);
  });

  it('prefers the longer dictionary entry', () => {
    expect(found('Anna Schmidt ruft an')).toEqual([{ kind: 'NAME', value: 'Anna Schmidt' }]);
    expect(found('Anna ruft an')).toEqual([{ kind: 'NAME', value: 'Anna' }]);
  });

  it('prefers a date of birth over an equally long phone match', () => {
    // Same characters, same length: detector priority decides.
    expect(found('geboren 01.02.1990')).toEqual([
      { kind: 'DATE_OF_BIRTH', value: '01.02.1990' },
    ]);
  });

  it('keeps an IBAN rather than the card-shaped digits inside it', () => {
    expect(found('IBAN DE89 3704 0044 0532 0130 00')).toEqual([
      { kind: 'IBAN', value: 'DE89 3704 0044 0532 0130 00' },
    ]);
  });

  it('resolves a dense mixed paragraph into disjoint spans', () => {
    const text = [
      'Anna Schmidt (geboren 03.07.1984) erreichen Sie unter +49 721 1234567',
      'oder anna.schmidt@example.com. IBAN DE89370400440532013000,',
      'Steuer-ID 86095742719, Karte 4111 1111 1111 1111, Server 10.0.0.42',
      'bzw. 2001:db8::1, MAC 00:1A:2B:3C:4D:5E, Ticket EMP-123456,',
      'Token sk-abcdefghijklmnopqrstuvwx, Projekt Nordstern.',
    ].join('\n');

    const spans = detect(text, detectors);

    // Nothing overlaps, and everything is in document order.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }

    expect(spans.map((s) => s.kind)).toEqual([
      'NAME',
      'DATE_OF_BIRTH',
      'PHONE',
      'EMAIL',
      'IBAN',
      'GERMAN_TAX_ID',
      'CREDIT_CARD',
      'IPV4',
      'IPV6',
      'MAC',
      'EMPLOYEE_ID',
      'SECRET',
      'TERM',
    ]);

    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it('produces identical output for identical input', () => {
    const text = 'Anna Schmidt, anna@example.com, DE89370400440532013000';
    expect(detect(text, detectors)).toEqual(detect(text, detectors));
  });

  it('does not report anything in text with no personal data', () => {
    expect(found('The build finished in 42 seconds with 0 warnings.')).toEqual([]);
  });
});
