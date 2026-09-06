import { describe, expect, it } from 'vitest';
import { decodeCopies } from '../src/detectors/decode.js';
import { createDetectors, detect } from '../src/detectors/index.js';
import { labelNear, normaliseForScan, SCAN_PROFILES } from '../src/detectors/normalise.js';
import type { Detector, Span } from '../src/types.js';

// Every non-ASCII character is written as an escape: the whole point of the
// code under test is that these spellings are indistinguishable on screen.

/** What the offset map promises, for any option set. */
const back = (
  original: string,
  copy: ReturnType<typeof normaliseForScan>,
  start: number,
  end: number,
): string => original.slice(copy.offsets[start] as number, copy.offsets[end] as number);

/** The map is monotone, stays inside the original, and covers the whole copy. */
const assertExactMap = (original: string, copy: ReturnType<typeof normaliseForScan>): void => {
  expect(copy.offsets).toHaveLength(copy.text.length + 1);
  for (let i = 0; i < copy.offsets.length; i += 1) {
    expect(copy.offsets[i]).toBeGreaterThanOrEqual(copy.offsets[i - 1] ?? 0);
    expect(copy.offsets[i]).toBeLessThanOrEqual(original.length);
  }
  expect(back(original, copy, 0, copy.text.length)).toBe(original);
};

describe('normaliseForScan: separator and case folding', () => {
  it('leaves the default profile exactly as it was', () => {
    expect(normaliseForScan('DE89\t3704\t0044\t0532\t0130\t00').changed).toBe(false);
    expect(normaliseForScan('de89370400440532013000').changed).toBe(false);
  });

  it.each([
    ['tab', 'DE89\t3704\t0044\t0532\t0130\t00', 'DE89 3704 0044 0532 0130 00'],
    ['dot', 'DE89.3704.0044.0532.0130.00', 'DE89 3704 0044 0532 0130 00'],
    ['underscore', '4111_1111_1111_1111', '4111 1111 1111 1111'],
    ['newline', '860\n917\n394\n53', '860 917 394 53'],
    ['NBSP', '4111\u00A01111\u00A01111\u00A01111', '4111 1111 1111 1111'],
    ['hyphen', 'DE89\u20103704\u20100044\u20100532\u20100130\u201000', 'DE89 3704 0044 0532 0130 00'],
  ])('folds the %s separator inside a digit-dominant run', (_label, original, expected) => {
    const copy = normaliseForScan(original, SCAN_PROFILES.identifier);
    expect(copy.text).toBe(expected);
    assertExactMap(original, copy);
  });

  it('upper-cases a lowercase identifier run', () => {
    const original = 'de89 3704 0044 0532 0130 00';
    const copy = normaliseForScan(original, SCAN_PROFILES.identifier);
    expect(copy.text).toBe('DE89 3704 0044 0532 0130 00');
    assertExactMap(original, copy);
  });

  it('leaves prose, dates and money alone', () => {
    for (const prose of [
      'Sehr geehrte Frau Schmidt, wir melden uns am 01.02.1990 wieder.',
      'Der Betrag von 1.234.567 Euro ist am 3. Mai faellig.',
      'Die Rechnung ueber 1.234.567,89 Euro ist beglichen.',
      'Der Umsatz stieg auf 12,345,678.90 Dollar.',
      'Bitte antworten Sie an johan@example.com.',
      'Rufen Sie uns unter 0721 1234567 an.',
    ]) {
      expect(normaliseForScan(prose, SCAN_PROFILES.identifier).changed).toBe(false);
    }
  });

  it('costs an ordinary body no scan copy at all', () => {
    // The cost guard, stated as a test: a prose body must produce nothing for
    // the detectors to run over a second time. Every copy that reports
    // `changed` is one more full detector pass on the proxy's event loop.
    const body = [
      'Sehr geehrte Frau M\u00FCller,',
      '',
      'vielen Dank f\u00FCr Ihre Nachricht vom 01.02.2024. Der Betrag von',
      '1.234.567,89 Euro wurde am 3. Mai \u00FCberwiesen. Bitte antworten Sie',
      'an johan@example.com oder rufen Sie unter 0721 1234567 an.',
      'Unsere IBAN lautet DE89 3704 0044 0532 0130 00.',
    ].join('\n');

    for (const profile of Object.values(SCAN_PROFILES)) {
      expect(normaliseForScan(body, profile).changed).toBe(false);
    }
    expect([...decodeCopies(body)]).toHaveLength(0);
  });
});

describe('normaliseForScan: confusables and diacritics', () => {
  it('folds a Cyrillic look-alike to Latin', () => {
    // U+043E is Cyrillic small o.
    const original = 'N\u043Erdlicht';
    const copy = normaliseForScan(original, SCAN_PROFILES.skeleton);
    expect(copy.text).toBe('Nordlicht');
    assertExactMap(original, copy);
  });

  it('folds a diacritic inside an address-shaped token', () => {
    const original = 'max.m\u00FCller@example.de';
    const copy = normaliseForScan(original, SCAN_PROFILES.skeleton);
    expect(copy.text).toBe('max.muller@example.de');
    assertExactMap(original, copy);
  });

  it('leaves accented prose alone, so German bodies pay for no extra pass', () => {
    expect(normaliseForScan('Gr\u00FC\u00DFe aus M\u00FCnchen', SCAN_PROFILES.skeleton).changed).toBe(
      false,
    );
  });
});

describe('normaliseForScan: word shapes', () => {
  it('collapses spaced-out text', () => {
    const original = 'N o r d l i c h t heute';
    const copy = normaliseForScan(original, SCAN_PROFILES.wordShape);
    expect(copy.text).toBe('Nordlicht heute');
    assertExactMap(original, copy);
  });

  it('splits camelCase', () => {
    const original = 'ProjektNordlicht';
    const copy = normaliseForScan(original, SCAN_PROFILES.wordShape);
    expect(copy.text).toBe('Projekt Nordlicht');
    assertExactMap(original, copy);
  });

  it('folds leetspeak inside a letter-dominant token', () => {
    const original = 'N0rdlicht';
    const copy = normaliseForScan(original, SCAN_PROFILES.wordShape);
    expect(copy.text).toBe('Nordlicht');
    assertExactMap(original, copy);
  });

  it('never touches a digit run, so card and IBAN digits survive', () => {
    expect(normaliseForScan('4111111111111111', SCAN_PROFILES.wordShape).changed).toBe(false);
    expect(normaliseForScan('DE89370400440532013000', SCAN_PROFILES.wordShape).changed).toBe(false);
  });
});

const textOf = (input: string): string[] => [...decodeCopies(input)].map((copy) => copy.text);

describe('decodeCopies', () => {

  it('decodes a base64 blob back into the value it hides', () => {
    expect(textOf('REU4OTM3MDQwMDQ0MDUzMjAxMzAwMA==')).toContain('DE89370400440532013000');
  });

  it('keeps the surrounding text so labels stay in reach', () => {
    expect(textOf('IBAN: REU4OTM3MDQwMDQ0MDUzMjAxMzAwMA==')).toContain(
      'IBAN: DE89370400440532013000',
    );
  });

  it.each([
    ['too short', 'REU4OTM3'],
    ['not a multiple of four', 'REU4OTM3MDQwMDQ0MDUzMjAxMzAwMAo'],
    ['decodes to binary', 'AAECAwQFBgcICQoLDA0ODw=='],
    ['ordinary prose', 'Sehr geehrte Damen und Herren, wir melden uns morgen'],
  ])('refuses %s', (_label, input) => {
    expect(textOf(input).some((text) => text !== input)).toBe(false);
  });

  it('decodes percent escapes', () => {
    expect(textOf('anna%40acme.example')).toContain('anna@acme.example');
  });

  it('decodes HTML entities', () => {
    expect(textOf('anna&#64;acme&period;example')).toContain('anna@acme.example');
  });
});

describe('detect over the scan copies', () => {
  const detectors = createDetectors();

  const kinds = (text: string): string[] => detect(text, detectors).map((span) => span.kind);
  const values = (text: string): string[] => detect(text, detectors).map((span) => span.value);

  it.each([
    ['tab-separated IBAN', 'DE89\t3704\t0044\t0532\t0130\t00', 'IBAN'],
    ['dot-separated IBAN', 'DE89.3704.0044.0532.0130.00', 'IBAN'],
    ['lowercase IBAN', 'de89370400440532013000', 'IBAN'],
    ['mixed-case IBAN', 'De89370400440532013000', 'IBAN'],
    ['dot-separated card', '4111.1111.1111.1111', 'CREDIT_CARD'],
    ['underscore-separated card', '4111_1111_1111_1111', 'CREDIT_CARD'],
    ['tab-separated tax ID', '860\t917\t394\t53', 'GERMAN_TAX_ID'],
    ['newline-separated tax ID', 'Steuer-ID:\n860\n917\n394\n53', 'GERMAN_TAX_ID'],
    ['homoglyph e-mail', 'max.mustermann@ex\u0430mple.com', 'EMAIL'],
    ['accented local part', '\u00FCnal.yilmaz@example.de', 'EMAIL'],
    ['base64 IBAN', 'REU4OTM3MDQwMDQ0MDUzMjAxMzAwMA==', 'IBAN'],
    ['percent-encoded e-mail', 'anna%40acme.example', 'EMAIL'],
  ])('finds the %s', (_label, text, kind) => {
    expect(kinds(text)).toContain(kind);
    for (const span of detect(text, detectors)) {
      expect(span.value).toBe(text.slice(span.start, span.end));
    }
  });

  it('claims the whole lowercase spaced IBAN instead of leaking its head', () => {
    // The partial-redaction bug: PHONE used to take the tail and leave
    // `de89 3704` in plain text while the audit record said "1 finding".
    const text = 'de89 3704 0044 0532 0130 00';
    expect(kinds(text)).toEqual(['IBAN']);
    expect(values(text)).toEqual([text]);
  });

  it('reports a value once even when several copies see it', () => {
    expect(kinds('DE89\t3704\t0044\t0532\t0130\t00')).toEqual(['IBAN']);
  });

  it('leaves ASCII prose results exactly as they were', () => {
    const text = 'johan@example.com and DE89370400440532013000 on 01.02.1990';
    expect(kinds(text)).toEqual(['EMAIL', 'IBAN', 'DATE_OF_BIRTH']);
  });
});

/** A candidate from the fake weak-format detector below. */
const kvnrSpan = (start: number, end: number, text: string): Span => ({
  start,
  end,
  kind: 'KVNR',
  value: text.slice(start, end),
  detector: 'kvnr',
  priority: 50,
});

describe('label proximity', () => {

  /** A weak numeric format that is only safe to report next to its label. */
  const kvnr: Detector = {
    name: 'kvnr',
    priority: 50,
    requiresLabel: { labels: ['KVNR', 'Versichertennummer'] },
    find(text: string): Span[] {
      const out: Span[] = [];
      const re = /\d{9}/gu;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        out.push(kvnrSpan(match.index, match.index + 9, text));
      }
      return out;
    },
  };

  it('fires when the label is in reach', () => {
    expect(detect('KVNR: 123456789', [kvnr]).map((s) => s.value)).toEqual(['123456789']);
  });

  it('tolerates the separators a label is written with', () => {
    expect(detect('kv-nr.: 123456789', [kvnr])).toHaveLength(1);
    expect(detect('Versicherten-Nummer 123456789', [kvnr])).toHaveLength(1);
    expect(detect('Versicherten Nummer 123456789', [kvnr])).toHaveLength(1);
    expect(detect('Versichertennummer 123456789', [kvnr])).toHaveLength(1);
  });

  it('stays silent when no label is near', () => {
    expect(detect('Bestellung 123456789 ist unterwegs', [kvnr])).toHaveLength(0);
  });

  it('honours the window', () => {
    const near = `KVNR${' '.repeat(50)}123456789`;
    const far = `KVNR${' '.repeat(90)}123456789`;
    expect(detect(near, [kvnr])).toHaveLength(1);
    expect(detect(far, [kvnr])).toHaveLength(0);
  });

  it('accepts a label after the value when the detector allows it', () => {
    const either: Detector = { ...kvnr, requiresLabel: { labels: ['KVNR'], where: 'either' } };
    const before: Detector = { ...kvnr, requiresLabel: { labels: ['KVNR'], where: 'before' } };
    expect(detect('123456789 (KVNR)', [either])).toHaveLength(1);
    expect(detect('123456789 (KVNR)', [before])).toHaveLength(0);
  });

  it('finds the label through a scan copy the value was found in', () => {
    // The label sits next to a value only the word-shape copy can see, and the
    // span maps back onto the spaced-out spelling as it was written.
    expect(detect('KVNR: 1 2 3 4 5 6 7 8 9', [kvnr]).map((s) => s.value)).toEqual([
      '1 2 3 4 5 6 7 8 9',
    ]);
  });

  it('leaves detectors that declare no label untouched', () => {
    const plain: Detector = { name: 'kvnr', priority: 50, find: kvnr.find };
    expect(detect('Bestellung 123456789', [plain])).toHaveLength(1);
  });

  it('exposes the check for detectors that need it directly', () => {
    expect(labelNear('Steuer-ID: 12345678901', 11, 22, { labels: ['Steuer-ID'] })).toBe(true);
    expect(labelNear('Bestellnr 12345678901', 10, 21, { labels: ['Steuer-ID'] })).toBe(false);
  });
});
