import { describe, expect, it } from 'vitest';
import { ibanChecksum, ibanDetector, isValidIban } from '../src/detectors/iban.js';
import {
  creditCardDetector,
  hasIssuerPrefix,
  isValidCardNumber,
  luhnValid,
} from '../src/detectors/creditcard.js';
import {
  germanTaxIdDetector,
  hasValidDigitFrequency,
  isValidGermanTaxId,
  mod1110CheckDigit,
} from '../src/detectors/taxid.js';

const values = (text: string, detector: { find(t: string): { value: string }[] }): string[] =>
  detector.find(text).map((s) => s.value);

describe('IBAN', () => {
  const valid = [
    ['DE89370400440532013000', 'DE'],
    ['AT611904300234573201', 'AT'],
    ['CH9300762011623852957', 'CH'],
    ['FR1420041010050500013M02606', 'FR'],
    ['NL91ABNA0417164300', 'NL'],
    ['ES9121000418450200051332', 'ES'],
    ['IT60X0542811101000000123456', 'IT'],
  ] as const;

  it.each(valid)('accepts %s (%s)', (iban) => {
    expect(isValidIban(iban)).toBe(true);
    expect(ibanChecksum(iban)).toBe(1);
  });

  it('rejects IBANs that pattern-match but fail the mod-97 checksum', () => {
    // Same shape, same country, last digit bumped by one.
    expect(isValidIban('DE89370400440532013001')).toBe(false);
    expect(isValidIban('NL91ABNA0417164301')).toBe(false);
    expect(isValidIban('AT611904300234573202')).toBe(false);
    expect(ibanChecksum('DE89370400440532013001')).not.toBe(1);
  });

  it('rejects a checksum-valid string of the wrong length for its country', () => {
    // DE must be exactly 22 characters; a 20-character "DE" IBAN is impossible.
    expect(isValidIban('DE611904300234573201')).toBe(false);
  });

  it('rejects unknown country codes', () => {
    expect(isValidIban('ZZ89370400440532013000')).toBe(false);
  });

  it('finds an IBAN written in four-character groups', () => {
    const text = 'Bitte überweisen Sie auf DE89 3704 0044 0532 0130 00 bis Freitag.';
    expect(values(text, ibanDetector)).toEqual(['DE89 3704 0044 0532 0130 00']);
  });

  it('does not swallow the words after a grouped IBAN', () => {
    const text = 'IBAN DE89 3704 0044 0532 0130 00 und mehr Text hier';
    const found = ibanDetector.find(text);
    expect(found).toHaveLength(1);
    expect(text.slice(found[0]!.end)).toBe(' und mehr Text hier');
  });

  it('rejects an IBAN glued to more alphanumerics', () => {
    expect(ibanDetector.find('DE89370400440532013000X')).toEqual([]);
    expect(ibanDetector.find('XDE89370400440532013000')).toEqual([]);
  });

  it('rejects a double space inside the grouping', () => {
    expect(ibanDetector.find('DE89 3704  0044 0532 0130 00')).toEqual([]);
  });

  it('finds several IBANs in one text', () => {
    const text = 'alt: NL91ABNA0417164300, neu: AT611904300234573201.';
    expect(values(text, ibanDetector)).toEqual(['NL91ABNA0417164300', 'AT611904300234573201']);
  });

  it('reports offsets that slice back to the value', () => {
    const text = 'x DE89370400440532013000 y';
    const [span] = ibanDetector.find(text);
    expect(text.slice(span!.start, span!.end)).toBe(span!.value);
    expect(span!.kind).toBe('IBAN');
  });
});

describe('credit card', () => {
  const cards = [
    '4111111111111111',
    '4242424242424242',
    '5555555555554444',
    '5105105105105100',
    '378282246310005',
    '6011111111111117',
    '3530111333300000',
    '30569309025904',
  ];

  it.each(cards)('accepts %s', (card) => {
    expect(luhnValid(card)).toBe(true);
    expect(isValidCardNumber(card)).toBe(true);
  });

  it('rejects digit runs that fail Luhn', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(isValidCardNumber('4111111111111112')).toBe(false);
    expect(creditCardDetector.find('Karte 4111111111111112 abgelehnt')).toEqual([]);
  });

  it('rejects Luhn-valid runs without a real issuer prefix', () => {
    // Luhn passes, but 9... is not an issued IIN and 16 digits is wrong for it.
    expect(luhnValid('9111111111111110')).toBe(true);
    expect(hasIssuerPrefix('9111111111111110')).toBe(false);
    expect(isValidCardNumber('9111111111111110')).toBe(false);
  });

  it('rejects a valid prefix at the wrong length', () => {
    // Amex is 15 digits; the same digits padded to 16 are not a card.
    expect(hasIssuerPrefix('378282246310005')).toBe(true);
    expect(hasIssuerPrefix('3782822463100050')).toBe(false);
  });

  it.each([
    ['4111 1111 1111 1111', '4111 1111 1111 1111'],
    ['4111-1111-1111-1111', '4111-1111-1111-1111'],
    ['3782 822463 10005', '3782 822463 10005'],
  ])('finds grouped card %s', (text, expected) => {
    expect(values(text, creditCardDetector)).toEqual([expected]);
  });

  it('does not report a 16-digit prefix of a 17-digit run', () => {
    expect(creditCardDetector.find('41111111111111110')).toEqual([]);
  });

  it('finds a card followed by an unrelated number', () => {
    expect(values('4111 1111 1111 1111 2024', creditCardDetector)).toEqual(['4111 1111 1111 1111']);
  });

  it('finds a card that starts partway into a longer digit sequence', () => {
    expect(values('ref 99 4111 1111 1111 1111', creditCardDetector)).toEqual([
      '4111 1111 1111 1111',
    ]);
  });

  it('ignores an alphanumeric token that merely contains digits', () => {
    expect(creditCardDetector.find('ORDER4111111111111111')).toEqual([]);
  });
});

describe('German tax ID', () => {
  it('computes the documented MOD 11,10 check digit', () => {
    expect(mod1110CheckDigit('8609574271')).toBe(9);
    expect(mod1110CheckDigit('4703689281')).toBe(6);
    expect(mod1110CheckDigit('1234567890')).toBe(3);
  });

  it.each(['86095742719', '47036892816', '65929970489', '12345678995'])(
    'accepts %s',
    (id) => {
      expect(isValidGermanTaxId(id)).toBe(true);
    },
  );

  it('rejects a number whose check digit is wrong', () => {
    expect(hasValidDigitFrequency('8609574271')).toBe(true);
    expect(isValidGermanTaxId('86095742711')).toBe(false);
  });

  it('rejects a check-digit-valid number that breaks the frequency rule', () => {
    // 1234567890 has ten distinct digits, so no digit repeats at all.
    expect(mod1110CheckDigit('1234567890')).toBe(3);
    expect(hasValidDigitFrequency('1234567890')).toBe(false);
    expect(isValidGermanTaxId('12345678903')).toBe(false);
  });

  it('rejects more than one repeated digit', () => {
    expect(hasValidDigitFrequency('1122334567')).toBe(false);
  });

  it('rejects a digit repeated more than three times', () => {
    expect(hasValidDigitFrequency('1111111111')).toBe(false);
    expect(isValidGermanTaxId('11111111119')).toBe(false);
  });

  it('accepts a digit appearing three times at non-consecutive positions', () => {
    expect(hasValidDigitFrequency('1213145678')).toBe(true);
  });

  it('rejects three identical digits in a row', () => {
    expect(hasValidDigitFrequency('1112456789')).toBe(false);
  });

  it('rejects a leading zero', () => {
    expect(isValidGermanTaxId('02345678910')).toBe(false);
  });

  it('finds a tax ID in prose and in grouped form', () => {
    expect(values('Steuer-ID: 86095742719.', germanTaxIdDetector)).toEqual(['86095742719']);
    expect(values('IdNr 86 095 742 719 (BZSt)', germanTaxIdDetector)).toEqual([
      '86 095 742 719',
    ]);
  });

  it('ignores an eleven-digit run that is glued to more digits', () => {
    expect(germanTaxIdDetector.find('860957427190')).toEqual([]);
  });

  it('ignores random eleven-digit numbers', () => {
    expect(germanTaxIdDetector.find('Beleg 20240102345 gebucht')).toEqual([]);
  });
});
