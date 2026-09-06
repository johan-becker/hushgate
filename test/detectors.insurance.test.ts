import { describe, expect, it } from 'vitest';
import { detect } from '../src/detectors/index.js';
import {
  isValidSocialSecurityNumber,
  socialSecurityCheckDigit,
  socialSecurityDetector,
} from '../src/detectors/socialsecurity.js';
import {
  healthInsuranceCheckDigit,
  healthInsuranceDetector,
  healthInsuranceLabelDetector,
  isValidHealthInsuranceNumber,
} from '../src/detectors/healthinsurance.js';
import type { Detector } from '../src/types.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((span) => span.value);

/** Every span a detector returns must re-slice to itself. */
const assertSliceInvariant = (text: string, detector: Detector): void => {
  for (const span of detector.find(text)) {
    expect(text.slice(span.start, span.end)).toBe(span.value);
  }
};

describe('Sozialversicherungsnummer check digit', () => {
  it('reproduces the Deutsche Rentenversicherung worked example', () => {
    // 65 | 170839 | J | 00 | 3 — the example the DRV prints in its own
    // documentation of the procedure.
    expect(socialSecurityCheckDigit('65170839J00')).toBe(3);
    expect(isValidSocialSecurityNumber('65170839J003')).toBe(true);
  });

  it('applies the documented weights, which the worked example alone does not pin', () => {
    // 65170839J003 also comes out to 3 under a naive alternating 1/2 table, so
    // the DRV example on its own cannot tell a correct implementation from a
    // Luhn-shaped one. This recovers the weight at each probeable position
    // instead: raising one digit from 0 to 1 moves the total by exactly that
    // position's weight, every weight here being a single digit.
    const base = '00000000A00';
    const withOne = (charPos: number): string =>
      `${base.slice(0, charPos)}1${base.slice(charPos + 1)}`;
    const zero = socialSecurityCheckDigit(base)!;

    // Character position -> weight of the digit it becomes. Positions 8 and 9
    // of the digit sequence belong to the letter and are covered separately.
    const expected: readonly (readonly [number, number])[] = [
      [0, 2], [1, 1], [2, 2], [3, 5], [4, 7], [5, 1], [6, 2], [7, 1], [9, 2], [10, 1],
    ];

    for (const [charPos, weight] of expected) {
      expect((socialSecurityCheckDigit(withOne(charPos))! - zero + 10) % 10).toBe(weight);
    }
  });

  it('expands the letter to its two-digit alphabet position', () => {
    // A = 01: the leading zero is part of the sequence, so a low letter is not
    // silently one digit shorter than a high one.
    expect(socialSecurityCheckDigit('15010180A00')).toBe(1);
    // Z = 26.
    expect(socialSecurityCheckDigit('42290277Z49')).toBe(4);
    expect(isValidSocialSecurityNumber('15010180A001')).toBe(true);
    expect(isValidSocialSecurityNumber('42290277Z494')).toBe(true);
  });

  it('accepts a lower-case letter', () => {
    expect(isValidSocialSecurityNumber('65170839j003')).toBe(true);
  });

  it('rejects every other check digit for a real number', () => {
    for (const digit of '012456789') {
      expect(isValidSocialSecurityNumber(`65170839J00${digit}`)).toBe(false);
    }
  });

  it('rejects impossible birth dates', () => {
    // 32.08. and 17.13. are not dates; the check digit is recomputed for each
    // so that the date, not the checksum, is what does the rejecting.
    expect(isValidSocialSecurityNumber(`65320839J00${socialSecurityCheckDigit('65320839J00')}`))
      .toBe(false);
    expect(isValidSocialSecurityNumber(`65171339J00${socialSecurityCheckDigit('65171339J00')}`))
      .toBe(false);
    expect(isValidSocialSecurityNumber(`65310439J00${socialSecurityCheckDigit('65310439J00')}`))
      .toBe(false);
  });

  it('accepts 29 February, whose century it cannot know', () => {
    expect(isValidSocialSecurityNumber('42290277Z494')).toBe(true);
  });

  it('rejects Bereichsnummern that are never issued', () => {
    for (const area of ['00', '01', '90', '99']) {
      const body = `${area}170839J00`;
      expect(isValidSocialSecurityNumber(`${body}${socialSecurityCheckDigit(body)}`)).toBe(false);
    }
  });

  it('rejects the wrong length and the wrong shape', () => {
    expect(isValidSocialSecurityNumber('65170839J03')).toBe(false);
    expect(isValidSocialSecurityNumber('65170839J0033')).toBe(false);
    // Digit where the birth-name initial belongs.
    expect(isValidSocialSecurityNumber('651708391003')).toBe(false);
    expect(socialSecurityCheckDigit('65170839JJ0')).toBe(null);
  });
});

describe('Sozialversicherungsnummer detector', () => {
  const forms = [
    '65 170839 J 003',
    '65170839J003',
    '65170839j003',
    '65-170839-J-003',
  ];

  it.each(forms)('finds %s', (form) => {
    expect(values(form, socialSecurityDetector)).toEqual([form]);
    assertSliceInvariant(form, socialSecurityDetector);
  });

  it('finds the number behind its label and claims only the number', () => {
    const text = 'RV-Nr.: 65 170839 J 003';
    expect(values(text, socialSecurityDetector)).toEqual(['65 170839 J 003']);
    assertSliceInvariant(text, socialSecurityDetector);
  });

  it('finds it inside a sentence', () => {
    const text = 'Die Versicherungsnummer 65170839J003 gehört zum Vorgang.';
    expect(values(text, socialSecurityDetector)).toEqual(['65170839J003']);
    assertSliceInvariant(text, socialSecurityDetector);
  });

  it('reports nothing when the check digit is wrong', () => {
    expect(values('65 170839 J 004', socialSecurityDetector)).toEqual([]);
    expect(values('Auftrag 65170839J004 ist offen.', socialSecurityDetector)).toEqual([]);
  });

  it('does not cut a valid number out of a longer run', () => {
    expect(values('X65170839J003', socialSecurityDetector)).toEqual([]);
    expect(values('65170839J0037', socialSecurityDetector)).toEqual([]);
  });

  it('leaves ordinary numeric prose alone', () => {
    const text = 'Rechnung 1.234.567,89 EUR vom 17.08.2039, Auftrag 4711.';
    expect(values(text, socialSecurityDetector)).toEqual([]);
  });

  it('surfaces through detect() without a label', () => {
    const spans = detect('65170839J003', [socialSecurityDetector]);
    expect(spans.map((s) => s.kind)).toEqual(['SOCIAL_SECURITY_ID']);
  });
});

describe('Krankenversichertennummer check digit', () => {
  it('reproduces the gematik test-card numbers', () => {
    // Two published eGK test KVNRs, both external to this codebase — which is
    // the point: they check the routine against something not derived from it.
    // The pair is needed, not one of them: X110403565 also comes out right
    // under the reversed 2/1 parity, and X110485291 is what rejects it.
    expect(healthInsuranceCheckDigit('X11040356')).toBe(5);
    expect(healthInsuranceCheckDigit('X11048529')).toBe(1);
    expect(isValidHealthInsuranceNumber('X110403565')).toBe(true);
    expect(isValidHealthInsuranceNumber('X110485291')).toBe(true);
  });

  it('accepts a lower-case letter', () => {
    expect(isValidHealthInsuranceNumber('x110403565')).toBe(true);
  });

  it('rejects the well-known placeholder A123456789', () => {
    // Its check digit is 0, not 9 — which is exactly why the shape alone may
    // not be reported.
    expect(healthInsuranceCheckDigit('A12345678')).toBe(0);
    expect(isValidHealthInsuranceNumber('A123456789')).toBe(false);
    expect(isValidHealthInsuranceNumber('A123456780')).toBe(true);
  });

  it('rejects every other check digit for a real number', () => {
    for (const digit of '012346789') {
      expect(isValidHealthInsuranceNumber(`X11040356${digit}`)).toBe(false);
    }
  });

  it('rejects the wrong length and the wrong shape', () => {
    expect(isValidHealthInsuranceNumber('A12345678')).toBe(false);
    expect(isValidHealthInsuranceNumber('A1234567800')).toBe(false);
    expect(isValidHealthInsuranceNumber('1123456780')).toBe(false);
    expect(healthInsuranceCheckDigit('AB1234567')).toBe(null);
  });
});

describe('Krankenversichertennummer detector', () => {
  const forms = ['X110403565', 'x110403565', 'X 110 403 565', 'X-110403565'];

  it.each(forms)('finds the checksum-valid %s unaccompanied', (form) => {
    expect(values(form, healthInsuranceDetector)).toEqual([form]);
    assertSliceInvariant(form, healthInsuranceDetector);
  });

  it('finds it behind a label and claims only the number', () => {
    const text = 'KVNR: X110403565';
    expect(values(text, healthInsuranceDetector)).toEqual(['X110403565']);
    assertSliceInvariant(text, healthInsuranceDetector);
  });

  it('rejects nine digits without the leading letter, and eight with it', () => {
    expect(values('110403565', healthInsuranceDetector)).toEqual([]);
    expect(values('A12345678', healthInsuranceDetector)).toEqual([]);
    expect(values('A12345678', healthInsuranceLabelDetector)).toEqual([]);
  });

  it('does not cut a number out of a longer run', () => {
    expect(values('QX110403565', healthInsuranceDetector)).toEqual([]);
    expect(values('X1104035650', healthInsuranceDetector)).toEqual([]);
  });

  it('leaves the checksum-valid number to the strict detector', () => {
    // The two detectors partition the shape between them, so a labelled and
    // checksum-valid number is never reported twice.
    expect(values('KVNR: X110403565', healthInsuranceLabelDetector)).toEqual([]);
  });
});

describe('Krankenversichertennummer label gate', () => {
  const both = [healthInsuranceDetector, healthInsuranceLabelDetector];

  const labelled = [
    'KVNR: A123456789',
    'Versichertennr. A123456789',
    'Versichertennummer: A 123 456 789',
    'eGK A-123456789',
    'Krankenversichertennummer a123456789',
    'Vers.-Nr: A123456789',
  ];

  it.each(labelled)('reports %s', (text) => {
    const spans = detect(text, both);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.kind).toBe('HEALTH_INSURANCE_ID');
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(spans[0]!.value);
    expect(spans[0]!.value.startsWith('A') || spans[0]!.value.startsWith('a')).toBe(true);
  });

  it('drops the same shape when nothing labels it', () => {
    expect(detect('A123456789', both)).toEqual([]);
    expect(detect('Bestellung A123456789 wurde versandt.', both)).toEqual([]);
  });

  it('still needs the shape, not just the label', () => {
    expect(detect('KVNR: A12345678', both)).toEqual([]);
  });

  it('declares its labels once so the fold is cached', () => {
    // The WeakMap that caches folded labels is keyed on array identity, so a
    // fresh array per call would repay the fold on every request.
    expect(healthInsuranceLabelDetector.requiresLabel?.labels).toBe(
      healthInsuranceLabelDetector.requiresLabel?.labels,
    );
    expect(healthInsuranceDetector.requiresLabel).toBeUndefined();
  });
});
