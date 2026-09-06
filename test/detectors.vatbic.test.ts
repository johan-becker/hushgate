import { describe, expect, it } from 'vitest';
import {
  bicDetector,
  createBicDetector,
  isBicShaped,
  ISO_3166_ALPHA2,
} from '../src/detectors/bic.js';
import { detect } from '../src/detectors/index.js';
import {
  createVatIdDetector,
  isValidGermanVatId,
  vatIdDetector,
  VAT_ID_RULES,
} from '../src/detectors/vatid.js';
import type { Detector } from '../src/types.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((span) => span.value);

/** The invariant the whole package rests on, asserted for every span. */
const assertExactSlices = (text: string, detector: Detector): void => {
  for (const span of detector.find(text)) {
    expect(span.value).toBe(text.slice(span.start, span.end));
  }
};

describe('German VAT check digit', () => {
  it.each([
    ['DE811907980', '811907980'],
    ['DE136695976', '136695976'],
    ['DE123456788', '123456788'],
  ])('accepts %s, whose ISO 7064 MOD 11,10 digit is right', (_id, body) => {
    expect(isValidGermanVatId(body)).toBe(true);
  });

  it('rejects the example number every specimen invoice prints', () => {
    // DE123456789 is structurally perfect and arithmetically wrong: the chain
    // over 12345678 ends at 8, not 9. This is why the detector does not require
    // the check digit by default.
    expect(isValidGermanVatId('123456789')).toBe(false);
  });

  it('rejects anything that is not nine digits', () => {
    expect(isValidGermanVatId('12345678')).toBe(false);
    expect(isValidGermanVatId('1234567890')).toBe(false);
    expect(isValidGermanVatId('81190798O')).toBe(false);
  });
});

describe('EU VAT ID detector', () => {
  it.each([
    ['bare', 'DE123456789', 'DE123456789'],
    ['grouped', 'Rechnung an DE 123 456 789 vom Montag', 'DE 123 456 789'],
    ['lower case', 'ust-id de123456789 bitte prüfen', 'de123456789'],
    ['hyphenated', 'DE-123456789', 'DE-123456789'],
    ['labelled', 'USt-IdNr.: DE123456789', 'DE123456789'],
  ])('finds a German VAT ID written %s', (_label, text, expected) => {
    expect(values(text, vatIdDetector)).toEqual([expected]);
    assertExactSlices(text, vatIdDetector);
  });

  it.each([
    ['AT', 'ATU12345678'],
    ['FR', 'FR12345678901'],
    ['NL', 'NL123456789B01'],
    ['IE', 'IE1234567FA'],
  ])('finds a %s VAT ID structurally', (_country, id) => {
    const text = `USt-IdNr. ${id} laut Rechnung`;
    expect(values(text, vatIdDetector)).toEqual([id]);
  });

  it('accepts both Irish body lengths', () => {
    expect(values('IE1234567T', vatIdDetector)).toEqual(['IE1234567T']);
    expect(values('IE1234567FA', vatIdDetector)).toEqual(['IE1234567FA']);
  });

  it('rejects a German VAT ID that is one digit short', () => {
    expect(values('USt-IdNr.: DE12345678', vatIdDetector)).toEqual([]);
  });

  it('rejects a number that runs on past the format', () => {
    expect(values('DE1234567890', vatIdDetector)).toEqual([]);
    expect(values('DE 123 456 789 012', vatIdDetector)).toEqual([]);
  });

  it.each([
    ['unknown country', 'ZZ123456789'],
    ['Austrian without the U', 'AT123456789'],
    ['Dutch without the B', 'NL123456789A01'],
    ['French with a letter in the digits', 'FR1234567890X'],
  ])('rejects %s', (_label, text) => {
    expect(values(text, vatIdDetector)).toEqual([]);
  });

  it('does not claim an IBAN of the same country', () => {
    expect(values('DE89370400440532013000', vatIdDetector)).toEqual([]);
    expect(values('IBAN DE89 3704 0044 0532 0130 00', vatIdDetector)).toEqual([]);
    expect(values('AT611904300234573201', vatIdDetector)).toEqual([]);
  });

  it('does not anchor inside a word', () => {
    expect(values('WIDERRUF123456789', vatIdDetector)).toEqual([]);
    expect(values('Ordnungsziffer ADE123456789', vatIdDetector)).toEqual([]);
  });

  it('does not read a top-level domain as a country prefix', () => {
    expect(values('Details unter https://example.de/123456789 nachlesen.', vatIdDetector)).toEqual(
      [],
    );
    // The separator itself stays legal, because an evader reaches for it.
    expect(values('DE/123456789', vatIdDetector)).toEqual(['DE/123456789']);
  });

  it('can be built to insist on the German check digit', () => {
    const strict = createVatIdDetector({ requireGermanCheckDigit: true });
    expect(values('USt-IdNr.: DE123456789', strict)).toEqual([]);
    expect(values('USt-IdNr.: DE811907980', strict)).toEqual(['DE811907980']);
    // Only Germany has a verified check digit, so the others are unaffected.
    expect(values('ATU12345678', strict)).toEqual(['ATU12345678']);
  });

  it('takes further member states through its options', () => {
    const withSpain = createVatIdDetector({
      rules: { ES: { lengths: [9], body: /^[A-Z0-9]\d{7}[A-Z0-9]$/u } },
    });
    expect(values('ESX1234567X', withSpain)).toEqual(['ESX1234567X']);
    // The shipped set is unchanged by the extension.
    expect(VAT_ID_RULES.ES).toBeUndefined();
    expect(values('ESX1234567X', vatIdDetector)).toEqual([]);
  });

  it('survives the scan copies with exact original offsets', () => {
    const text = 'USt‑IdNr.: de 123 456 789';
    const spans = detect(text, [vatIdDetector]);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.value).toBe(text.slice(spans[0]!.start, spans[0]!.end));
    expect(spans[0]?.kind).toBe('EU_VAT_ID');
  });
});

describe('ISO 3166-1 alpha-2 table', () => {
  it('holds every assigned code plus the one SWIFT addition', () => {
    expect(ISO_3166_ALPHA2.size).toBe(250);
  });

  it.each(['DE', 'AT', 'CH', 'GB', 'US', 'XK', 'AX', 'BQ', 'SS', 'SX', 'CW', 'MF', 'BL', 'TL'])(
    'contains %s',
    (code) => {
      expect(ISO_3166_ALPHA2.has(code)).toBe(true);
    },
  );

  it.each(['UK', 'AN', 'EU', 'CS', 'YU', 'ZZ', 'de'])('does not contain %s', (code) => {
    expect(ISO_3166_ALPHA2.has(code)).toBe(false);
  });

  it('holds nothing but two upper-case letters', () => {
    for (const code of ISO_3166_ALPHA2) expect(code).toMatch(/^[A-Z]{2}$/u);
  });
});

describe('BIC shape', () => {
  it.each(['COBADEFFXXX', 'COBADEFF', 'GENODEF1M04', 'DEUTDEFF500', 'MARKDEF1100'])(
    'accepts %s',
    (bic) => {
      expect(isBicShaped(bic)).toBe(true);
    },
  );

  it('rejects a zero standing in for the letter O', () => {
    expect(isBicShaped('C0BADEFFXXX')).toBe(false);
  });

  it('rejects the lengths ISO 9362 does not have', () => {
    expect(isBicShaped('COBADEFFXX')).toBe(false);
    expect(isBicShaped('COBADEFFX')).toBe(false);
    expect(isBicShaped('COBADEFFXXXX')).toBe(false);
    expect(isBicShaped('COBADEF')).toBe(false);
  });

  it('rejects an unassigned country code', () => {
    expect(isBicShaped('COBAZZFFXXX')).toBe(false);
    expect(isBicShaped('COBAUKFF')).toBe(false);
  });

  it('rejects the location characters ISO 9362 excludes', () => {
    expect(isBicShaped('COBADE0F')).toBe(false);
    expect(isBicShaped('COBADE1F')).toBe(false);
    expect(isBicShaped('COBADEFO')).toBe(false);
  });
});

describe('BIC detector', () => {
  it.each([
    ['canonical eleven', 'COBADEFFXXX', 'COBADEFFXXX'],
    ['canonical eight', 'COBADEFF', 'COBADEFF'],
    ['lower case', 'cobadeffxxx', 'cobadeffxxx'],
    ['grouped', 'COBA DE FF XXX', 'COBA DE FF XXX'],
    ['labelled', 'BIC: GENODEF1M04', 'GENODEF1M04'],
  ])('finds a BIC written %s', (_label, text, expected) => {
    expect(values(text, bicDetector)).toEqual([expected]);
    assertExactSlices(text, bicDetector);
  });

  it.each([
    ['a digit zero in the bank code', 'C0BADEFFXXX'],
    ['ten characters', 'COBADEFFXX'],
    ['twelve characters', 'COBADEFFXXXX'],
    ['an unassigned country', 'COBAZZFFXXX'],
  ])('rejects %s', (_label, text) => {
    expect(values(text, bicDetector)).toEqual([]);
  });

  it('does not swallow the word after a BIC', () => {
    const text = 'COBADEFF ist die Commerzbank.';
    expect(values(text, bicDetector)).toEqual(['COBADEFF']);
  });

  it('leaves lower-case prose alone', () => {
    // Every one of these is eight or eleven letters with an assigned country
    // code in position five and six; only the writing tells them apart.
    for (const word of ['rechnung', 'arbeitgeber', 'engineering', 'requirement', 'database']) {
      expect(values(`Die ${word} liegt bei.`, bicDetector)).toEqual([]);
    }
  });

  it('leaves capitalised prose from countries nobody here banks in alone', () => {
    const text = 'ACHTUNG: RECHNUNG DER DATABASE MIGRATION AN JEDEN CUSTOMER SENDEN.';
    expect(values(text, bicDetector)).toEqual([]);
  });

  it('does not let a label two words away license a word', () => {
    // `consectetur` is bank CONS, country EC, location TE, branch TUR.
    const text = 'Lorem ipsum dolor consectetur adipiscing elit. BIC COBADEFFXXX';
    expect(values(text, bicDetector)).toEqual(['COBADEFFXXX']);
  });

  it('takes a lower-case BIC when something says it is one', () => {
    expect(values('BIC cobadeff', bicDetector)).toEqual(['cobadeff']);
    expect(values('genodef1m04', bicDetector)).toEqual(['genodef1m04']);
  });

  it('takes a foreign BIC on its label and not without one', () => {
    expect(values('Zahlung an BIC BNPAFRPP', bicDetector)).toEqual(['BNPAFRPP']);
    expect(values('Zahlung an BNPAFRPP', bicDetector)).toEqual([]);
  });

  it('lets a business that banks abroad widen the home set', () => {
    const french = createBicDetector({ homeCountries: ['DE', 'FR'] });
    expect(values('Zahlung an BNPAFRPP', french)).toEqual(['BNPAFRPP']);
    expect(values('Zahlung an COBADEFFXXX', french)).toEqual(['COBADEFFXXX']);
  });

  it('does not take a half-separated token as one BIC', () => {
    expect(values('COBADEFF XXX', bicDetector)).toEqual(['COBADEFF']);
  });

  it('does not anchor inside a longer token', () => {
    expect(values('XCOBADEFFXXX', bicDetector)).toEqual([]);
    expect(values('COBADEFFXXX1', bicDetector)).toEqual([]);
  });

  it('finds the BIC that follows an IBAN in a payment block', () => {
    const text = 'IBAN DE89 3704 0044 0532 0130 00\nBIC COBADEFFXXX\nKontoinhaber: M. Meier';
    expect(values(text, bicDetector)).toEqual(['COBADEFFXXX']);
    assertExactSlices(text, bicDetector);
  });

  it('reports the kind under the priority it exports', () => {
    const [span] = bicDetector.find('COBADEFFXXX');
    expect(span?.kind).toBe('BIC');
    expect(span?.priority).toBe(bicDetector.priority);
  });
});
