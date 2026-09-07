import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';

// Regression tests for the audit's M1 evasion table: spellings written to slip
// past the raw-string patterns must still be found once the second pass runs
// over the normalised scan copy — and every reported span's value must be the
// ORIGINAL substring, exactly as written, never the normalised one.
//
// Known residual gaps deliberately NOT covered here: US-national phone
// 415-555-2671 and written-out dates.
//
// As in detectors.normalise.test.ts, every non-ASCII character is an escape so
// a reviewer can see which code point a case means.

const detectors = createDetectors();

/** The dictionary needs a name to find, written the ordinary composed way. */
const withDictionary = createDetectors({
  dictionary: { names: ['Mädchen Mueller'] },
});

interface Case {
  readonly label: string;
  readonly text: string;
  readonly kind: string;
}

const cases: readonly Case[] = [
  // U+FF41 U+FF4E U+FF4E U+FF41 = full-width 'anna'.
  {
    label: 'full-width local part e-mail',
    text: 'ａｎｎａ@acme.example',
    kind: 'EMAIL',
  },
  {
    label: 'non-ASCII local part e-mail',
    text: 'ünal.yilmaz@example.de',
    kind: 'EMAIL',
  },
  {
    label: 'zero-width space inside a phone number',
    text: '+49 151​23456789',
    kind: 'PHONE',
  },
  {
    label: 'lowercase IBAN',
    text: 'de89370400440532013000',
    kind: 'IBAN',
  },
  {
    label: 'tab-separated IBAN',
    text: 'DE89\t3704\t0044\t0532\t0130\t00',
    kind: 'IBAN',
  },
  {
    label: 'dot-separated credit card',
    text: '4111.1111.1111.1111',
    kind: 'CREDIT_CARD',
  },
];

describe('M1 evasion table regression', () => {
  it.each(cases)('finds the $label', ({ label, text, kind }) => {
    const spans = detect(text, detectors);
    expect(spans.some((span) => span.kind === kind), `no ${kind} finding for the ${label}`).toBe(
      true,
    );

    // The invariant: a span's value is the original substring, separators and
    // invisible characters included — never the normalised copy.
    for (const span of spans) {
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeLessThanOrEqual(text.length);
      expect(span.value).toBe(text.slice(span.start, span.end));
    }
  });

  it.each(cases)('reports exactly one finding for the $label', ({ text, kind }) => {
    expect(detect(text, detectors).filter((span) => span.kind === kind)).toHaveLength(1);
  });
});

describe('M1 evasion table: NFC/NFD dictionary matching', () => {
  // The entry is composed (NFC); the text carries the decomposed umlaut:
  // 'a' + combining diaeresis U+0308 instead of U+00E4.
  const decomposed = 'Ma\u0308dchen Mueller';
  const composed = 'Mädchen Mueller';

  it('matches the NFD spelling against the NFC dictionary entry', () => {
    const spans = detect(decomposed, withDictionary);
    expect(spans.some((span) => span.kind === 'NAME')).toBe(true);

    const name = spans.find((span) => span.kind === 'NAME')!;
    expect(name.value).toBe(decomposed.slice(name.start, name.end));
    expect(name.value).toBe(decomposed);
  });

  it('never reports the composed form as the value', () => {
    for (const span of detect(decomposed, withDictionary)) {
      expect(span.value).not.toBe(composed);
    }
  });
});
