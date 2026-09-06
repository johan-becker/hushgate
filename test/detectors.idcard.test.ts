import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';
import type { Detector, Span } from '../src/types.js';
import {
  germanDocumentKind,
  germanIdDocumentDetector,
  icaoCheckDigit,
  labelledGermanIdDocumentDetector,
  readGermanDocumentSerial,
} from '../src/detectors/idcard.js';

const both: Detector[] = [germanIdDocumentDetector, labelledGermanIdDocumentDetector];

const values = (spans: readonly Span[]): string[] => spans.map((s) => s.value);
const kinds = (spans: readonly Span[]): string[] => spans.map((s) => s.kind);

/** Every span must still slice back to itself out of the original text. */
const assertSliceable = (text: string, spans: readonly Span[]): void => {
  for (const span of spans) expect(span.value).toBe(text.slice(span.start, span.end));
};

describe('ICAO 9303 check digit', () => {
  it('computes the published check digit for German serials', () => {
    expect(icaoCheckDigit('L01X00T47')).toBe(1);
    expect(icaoCheckDigit('C01X00T47')).toBe(8);
  });

  it('treats the MRZ filler as zero', () => {
    expect(icaoCheckDigit('<<<<<<<<<')).toBe(0);
  });

  it('rejects characters that have no ICAO value', () => {
    expect(icaoCheckDigit('L01X00T4!')).toBe(-1);
    expect(icaoCheckDigit('L01X00T4ä')).toBe(-1);
  });
});

describe('German document serial shape', () => {
  it('canonicalises case', () => {
    expect(readGermanDocumentSerial('l01x00t47')).toBe('L01X00T47');
  });

  it('reads the letter O as a zero, because O is not in the issuing alphabet', () => {
    expect(readGermanDocumentSerial('LO1XOOT47')).toBe('L01X00T47');
    expect(readGermanDocumentSerial('LOIXOOT47')).toBe('L01X00T47');
  });

  it('rejects a serial that is not nine characters', () => {
    expect(readGermanDocumentSerial('L01X00T4')).toBeNull();
    expect(readGermanDocumentSerial('L01X00T471')).toBeNull();
  });

  it('rejects a serial that does not start with an issuing letter', () => {
    expect(readGermanDocumentSerial('101X00T47')).toBeNull();
    // A, B, D, E, Q, S and U are not in the alphabet the Bundesdruckerei uses.
    expect(readGermanDocumentSerial('A01X00T47')).toBeNull();
  });

  it('rejects a serial holding a letter outside the alphabet', () => {
    expect(readGermanDocumentSerial('L01X00B47')).toBeNull();
  });

  it('classifies by series letter when nothing else says', () => {
    expect(germanDocumentKind('C01X00T47')).toBe('PASSPORT_NUMBER');
    expect(germanDocumentKind('L01X00T47')).toBe('ID_CARD_NUMBER');
  });
});

describe('check-digit-verified serials fire unaided', () => {
  it('finds an ID card number with no label anywhere', () => {
    const text = 'Die Nummer L01X00T471 wurde im Register gefunden.';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L01X00T471']);
    expect(kinds(spans)).toEqual(['ID_CARD_NUMBER']);
    assertSliceable(text, spans);
  });

  it('finds a passport number with no label anywhere', () => {
    const text = 'Referenz C01X00T478 liegt vor.';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['C01X00T478']);
    expect(kinds(spans)).toEqual(['PASSPORT_NUMBER']);
  });

  it('accepts the lower-case spelling and keeps the original characters', () => {
    const text = 'nummer l01x00t471 bitte.';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['l01x00t471']);
    assertSliceable(text, spans);
  });

  it('accepts the letter-O spelling', () => {
    const text = 'Nummer LO1XOOT471 bitte.';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['LO1XOOT471']);
    assertSliceable(text, spans);
  });

  it('rejects a serial whose check digit is wrong', () => {
    expect(detect('Die Nummer L01X00T472 wurde gefunden.', both)).toEqual([]);
    expect(detect('Referenz C01X00T479 liegt vor.', both)).toEqual([]);
  });

  it('rejects a run that continues past the check digit', () => {
    expect(detect('Token L01X00T471X hier.', both)).toEqual([]);
    expect(detect('Token XL01X00T471 hier.', both)).toEqual([]);
  });
});

describe('the bare nine-character shape needs a label', () => {
  it('is dropped without one', () => {
    expect(detect('Die Nummer L01X00T47 wurde gefunden.', both)).toEqual([]);
    expect(detect('Referenz C01X00T47 liegt vor.', both)).toEqual([]);
  });

  it('fires behind Ausweis-Nr.', () => {
    const text = 'Ausweis-Nr. L01X00T47';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L01X00T47']);
    expect(kinds(spans)).toEqual(['ID_CARD_NUMBER']);
    assertSliceable(text, spans);
  });

  it('fires behind Passnr. and reports a passport', () => {
    const text = 'Passnr.: C01X00T47';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['C01X00T47']);
    expect(kinds(spans)).toEqual(['PASSPORT_NUMBER']);
  });

  it('accepts a label that follows the value', () => {
    const spans = detect('L01X00T47 (Personalausweis)', both);
    expect(values(spans)).toEqual(['L01X00T47']);
  });

  it('accepts the grouped spelling the card itself prints', () => {
    const text = 'Ausweis-Nr. L 01 X 00 T 47';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L 01 X 00 T 47']);
    assertSliceable(text, spans);
  });

  it('accepts a grouped passport number', () => {
    const text = 'Reisepass C01 X00 T47';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['C01 X00 T47']);
    expect(kinds(spans)).toEqual(['PASSPORT_NUMBER']);
    assertSliceable(text, spans);
  });

  it('accepts the lower-case and letter-O spellings', () => {
    expect(values(detect('ausweisnr. l01x00t47', both))).toEqual(['l01x00t47']);
    expect(values(detect('Ausweis-Nr. LO1XOOT47', both))).toEqual(['LO1XOOT47']);
  });

  it('rejects eight characters even with a label', () => {
    expect(detect('Ausweis-Nr. L01X00T4', both)).toEqual([]);
  });

  it('rejects a labelled number with no issuing letter in front', () => {
    // Nine digits behind "Ausweisnr." is far more often an order number.
    expect(detect('Ausweisnr. 123456789', both)).toEqual([]);
  });

  it('does not let the label word itself become a serial', () => {
    // "Nr.L01X00T47" collects as one run from the N; only the L may anchor.
    const text = 'Ausweis-Nr.L01X00T47';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L01X00T47']);
    assertSliceable(text, spans);
  });

  it('reports the check-digit form once when both forms could read it', () => {
    const text = 'Ausweis-Nr. L01X00T471';
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L01X00T471']);
  });
});

describe('neighbouring formats are left alone', () => {
  it('ignores an IBAN', () => {
    expect(detect('Ausweis-Nr. DE89370400440532013000', both)).toEqual([]);
  });

  it('ignores a phone number', () => {
    expect(detect('Ausweis-Nr. 030 1234567', both)).toEqual([]);
  });

  it('ignores an ordinary German sentence', () => {
    const text = 'Personalausweis und Reisepass liegen dem Antrag vollstaendig bei.';
    expect(detect(text, both)).toEqual([]);
  });

  it('finds nothing in a business mail that carries every other format', () => {
    const text = [
      'Sehr geehrte Frau Müller,',
      'die Rechnung RE-2024-000841 vom 03.04.2024 über 1.234.567,89 EUR',
      'überweisen Sie bitte auf DE89 3704 0044 0532 0130 00.',
      'Rückfragen an buchhaltung@beispiel-gmbh.de oder +49 30 1234567.',
      'Kundennummer 4711000815, Auftrag 2024-000841-A.',
    ].join('\n');
    expect(detect(text, both)).toEqual([]);
  });

  it('survives a large body without stalling', () => {
    const filler = 'Die Lieferung erfolgt am Montag an das Werk in Ingolstadt. '.repeat(2000);
    const text = `${filler}Ausweis-Nr. L01X00T47 ${filler}`;
    const spans = detect(text, both);
    expect(values(spans)).toEqual(['L01X00T47']);
    assertSliceable(text, spans);
  });
});

describe('alongside the built-in detectors', () => {
  it('claims the serial without disturbing the other formats', () => {
    const text = 'Ausweis-Nr. L01X00T471, IBAN DE89370400440532013000, mail a@b.de';
    const spans = detect(text, [...createDetectors(), ...both]);
    const claimed = spans.filter((s) => s.detector.startsWith('german-id-document'));
    expect(values(claimed)).toEqual(['L01X00T471']);
    expect(kinds(spans).toSorted()).toEqual(['EMAIL', 'IBAN', 'ID_CARD_NUMBER']);
    assertSliceable(text, spans);
  });
});
