import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';
import { phoneDetector } from '../src/detectors/phone.js';

const values = (text: string): string[] => phoneDetector.find(text).map((s) => s.value);
const detectors = createDetectors();
const kinds = (text: string): string[] => detect(text, detectors).map((s) => s.kind);

/**
 * The audit's PHONE over-claim table. Every one of these used to yield a span
 * that covered only the TAIL of a longer run, so the head travelled upstream in
 * the clear while the audit record reported one finding redacted.
 */
describe('PHONE over-claim', () => {
  it.each([
    ['49-015420-323751-8', 'an IMEI whose "49-" head would have leaked'],
    ['3012 0123 4567', 'a Steuernummer whose "3012" head would have leaked'],
    ['02476291358', 'a bare eleven-digit run that is a Steuer-ID shape'],
    ['Routing 021000021, Account 1234567890', 'a bank routing number'],
    ['03/05/1990', 'a slashed date'],
  ])('reports nothing in %j (%s)', (text) => {
    expect(phoneDetector.find(text)).toEqual([]);
  });

  it.each([
    '49-015420-323751-8',
    '3012 0123 4567',
    '02476291358',
    'Routing 021000021, Account 1234567890',
    '03/05/1990',
  ])('reports no PHONE through the full pipeline for %j', (text) => {
    expect(kinds(text)).not.toContain('PHONE');
  });

  it('does not start one character into a hyphenated identifier', () => {
    // The head is what makes this dangerous: `49-` in front of a redacted tail
    // is a complete IMEI to anyone holding the other half.
    expect(values('IMEI 49-015420-323751-8')).toEqual([]);
  });
});

describe('PHONE parentheses', () => {
  it('claims the opening parenthesis rather than orphaning it', () => {
    expect(values('(0721) 1234567')).toEqual(['(0721) 1234567']);
    expect(values('Tel (0721) 1234567')).toEqual(['(0721) 1234567']);
  });

  it('claims the closing parenthesis of a trailing extension', () => {
    expect(values('0721 (123456)')).toEqual(['0721 (123456)']);
  });

  it('never returns a span holding half a pair', () => {
    for (const text of ['(0721) 1234567', 'Tel (0721) 1234567', '0721 (123456)', '(0721 123456)']) {
      for (const span of phoneDetector.find(text)) {
        const opens = [...span.value].filter((ch) => ch === '(').length;
        const closes = [...span.value].filter((ch) => ch === ')').length;
        expect(opens).toBe(closes);
      }
    }
  });
});

describe('PHONE must not regress', () => {
  it.each([
    '+49 721 1234567',
    '+49721 1234567',
    '+49-721-1234567',
    '0049 721 1234567',
    '0721 1234567',
    '0721/1234567',
    '(0721) 1234567',
    '+49 (0) 721 1234567',
    '+49 721 12 34 5 67',
    '+49 721 123456',
  ])('still finds %j exactly', (text) => {
    expect(values(text)).toEqual([text]);
  });

  it('still finds a full-width number through the scan copies', () => {
    // U+FF0B is absent on purpose: the plus is ASCII, the digits are U+FF10…19.
    expect(kinds('+４９ ７２１ １２３４５６７')).toContain(
      'PHONE',
    );
  });

  it('still keeps two numbers separated by a double space apart', () => {
    expect(values('0721 1234567  0721 7654321')).toEqual(['0721 1234567', '0721 7654321']);
  });

  it('does not let a preceding digit run swallow an E.164 number', () => {
    // A `+` cannot be the interior of a digit run, so the boundary rule must
    // not apply to it — the audit log test depends on this exact shape.
    expect(values('4111111111111111 +49 721 1234567')).toEqual(['+49 721 1234567']);
  });
});

describe('PHONE bare national runs need a label', () => {
  it('finds an undecorated national number when a label licenses it', () => {
    expect(values('Tel: 01711234567')).toEqual(['01711234567']);
    expect(values('Mobil 02476291358')).toEqual(['02476291358']);
  });

  it('leaves the same digits alone with no label in sight', () => {
    expect(phoneDetector.find('01711234567')).toEqual([]);
  });
});

describe('PHONE: North American numbering plan', () => {
  it.each([
    '(555) 123-4567',
    '(555)123-4567',
    '555-123-4567',
    '555.123.4567',
    '555 123 4567',
    '+1 555 123 4567',
    '1-800-555-1234',
  ])('finds %j exactly', (text) => {
    expect(values(text)).toEqual([text]);
  });

  it('leaves ten undecorated digits alone until a label licenses them', () => {
    expect(phoneDetector.find('5551234567')).toEqual([]);
    expect(values('Phone: 5551234567')).toEqual(['5551234567']);
  });

  it('refuses an area code that starts with 0 or 1', () => {
    expect(phoneDetector.find('155-123-4567')).toEqual([]);
    expect(phoneDetector.find('105-123-4567')).toEqual([]);
  });

  it('refuses a match that is the tail or head of a longer digit run', () => {
    expect(phoneDetector.find('555-123-4567890')).toEqual([]);
    expect(phoneDetector.find('9995551234567')).toEqual([]);
  });

  it('finds a vanity toll-free number', () => {
    expect(values('1-800-FLOWERS')).toEqual(['1-800-FLOWERS']);
    expect(values('Call 1-800-GOT-JUNK today')).toEqual(['1-800-GOT-JUNK']);
  });

  it('does not read a hex-shaped token as a vanity number', () => {
    expect(phoneDetector.find('1234abcdef0')).toEqual([]);
    expect(phoneDetector.find('1-234-abcdef0')).toEqual([]);
  });

  it('reports a +1 number once, not twice', () => {
    expect(phoneDetector.find('+1 555 123 4567')).toHaveLength(1);
  });
});

describe('PHONE span invariants', () => {
  const corpus = [
    '(0721) 1234567',
    'Tel (0721) 1234567',
    '0721 (123456)',
    '+49 (0) 721 1234567',
    '1-800-FLOWERS',
    '(555) 123-4567',
    'Tel: 01711234567 und Phone: 5551234567',
    '0721 1234567  0721 7654321',
  ];

  it.each(corpus)('value equals the source slice in %j', (text) => {
    const spans = phoneDetector.find(text);
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.value).toBe(text.slice(span.start, span.end));
    }
  });

  it.each(corpus)('spans are ordered and disjoint in %j', (text) => {
    const spans = phoneDetector.find(text);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });
});
