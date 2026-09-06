import { describe, expect, it } from 'vitest';
import {
  createIcd10Detectors,
  createMedicationDetector,
  ICD_CODE_KIND,
  ICD_CODE_PRIORITY,
  icd10Detector,
  labelledIcd10Detector,
  MEDICATION_KIND,
  MEDICATION_PRIORITY,
  medicationDetector,
  canonicalIcd10,
  isIcd10Shaped,
  SEED_ICD10_CODES,
  SEED_MEDICATION_NAMES,
} from '../src/detectors/health.js';
import { detect } from '../src/detectors/index.js';
import type { Detector, Span } from '../src/types.js';

const ICD_SET: readonly Detector[] = [icd10Detector, labelledIcd10Detector];
const ALL: readonly Detector[] = [icd10Detector, labelledIcd10Detector, medicationDetector];

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((s) => s.value);

const found = (text: string, detectors: readonly Detector[] = ALL): string[] =>
  detect(text, detectors).map((s) => s.value);

const kinds = (spans: readonly Span[]): string[] => spans.map((s) => s.kind);

/** The load-bearing invariant: every span still slices back to itself. */
const assertSliceable = (text: string, spans: readonly Span[]): void => {
  for (const span of spans) expect(span.value).toBe(text.slice(span.start, span.end));
};

describe('ICD-10 grammar', () => {
  it.each([
    ['E11.9', 'E11.9'],
    ['E 11.9', 'E11.9'],
    ['e11.9', 'E11.9'],
    ['E119', 'E11.9'],
    ['E11.90', 'E11.90'],
    ['U07.1', 'U07.1'],
    ['I10', 'I10'],
  ])('reads %s as %s', (written, canonical) => {
    expect(canonicalIcd10(written)).toBe(canonical);
  });

  it.each(['E1.9', '11.9', 'EE11.9', 'E11.999', 'E11.', 'Ä11.9'])('refuses %s', (written) => {
    expect(canonicalIcd10(written)).toBeNull();
  });

  it('accepts every chapter letter, U included', () => {
    expect(isIcd10Shaped('U07.1')).toBe(true);
    expect(isIcd10Shaped('Z76.0')).toBe(true);
    expect(isIcd10Shaped('E11.9')).toBe(true);
  });

  it('ships a seed of real codes, all of them well formed', () => {
    expect(SEED_ICD10_CODES.length).toBeGreaterThan(30);
    for (const code of SEED_ICD10_CODES) {
      expect(isIcd10Shaped(code)).toBe(true);
      // The seed licenses the *dotted* spelling only; a three-character entry
      // would be a code the catalogue can never license.
      expect(code).toContain('.');
    }
  });
});

describe('ICD-10 codes in medical prose', () => {
  it('finds a catalogue code with no label at all', () => {
    const text = 'Hauptdiagnose E11.9, Patient weiterhin stabil.';
    const spans = icd10Detector.find(text);
    expect(values(text, icd10Detector)).toEqual(['E11.9']);
    expect(kinds(spans)).toEqual([ICD_CODE_KIND]);
    assertSliceable(text, spans);
  });

  it('finds the spaced spelling', () => {
    const text = 'Befund: E 11.9 seit 2019 bekannt.';
    expect(values(text, icd10Detector)).toEqual(['E 11.9']);
    assertSliceable(text, icd10Detector.find(text));
  });

  it('finds the lower-case spelling', () => {
    expect(values('abgerechnet nach e11.9 und f32.1', icd10Detector)).toEqual(['e11.9', 'f32.1']);
  });

  it('takes the diagnosis-certainty letter with the code', () => {
    const text = 'E11.9 G und F32.1 V';
    expect(values(text, icd10Detector)).toEqual(['E11.9 G', 'F32.1 V']);
    assertSliceable(text, icd10Detector.find(text));
  });

  it('leaves a following word alone', () => {
    expect(values('F32.1 Gesichert laut Vorbefund', icd10Detector)).toEqual(['F32.1']);
  });

  it('reads a range as two codes', () => {
    expect(values('Bereich E10.9-E11.9 im Katalog', icd10Detector)).toEqual(['E10.9', 'E11.9']);
  });

  it('finds the undotted form behind its label', () => {
    expect(found('ICD-10: E119', ICD_SET)).toEqual(['E119']);
    expect(kinds(detect('ICD-10: E119', ICD_SET))).toEqual([ICD_CODE_KIND]);
  });

  it('finds a code outside the seed behind its label', () => {
    expect(found('Diagnose: Q87.2', ICD_SET)).toEqual(['Q87.2']);
    expect(found('Q87.2', ICD_SET)).toEqual([]);
  });

  it('finds a three-character code behind its label and never without one', () => {
    expect(found('Diagnose I10, medikamentös eingestellt', ICD_SET)).toEqual(['I10']);
    expect(found('Formular I10 liegt bei', ICD_SET)).toEqual([]);
  });

  it('reports a labelled catalogue code exactly once', () => {
    const text = 'ICD-10: E11.9';
    expect(found(text, ICD_SET)).toEqual(['E11.9']);
    assertSliceable(text, detect(text, ICD_SET));
  });
});

describe('ICD-10 stays silent in German business prose', () => {
  it.each([
    'Die Firmware wurde von Version E11.9 auf E12.0 gehoben.',
    'Vitamin E 11.9 mg je Kapsel, laut Datenblatt.',
    'Bitte tragen Sie den Betrag in Zelle E11 ein.',
    'Artikel-Nr. E11.9 wurde am Montag geliefert.',
    'Wir liefern die Baugruppe M25.5 an das Werk in Ulm.',
    'Build E11.9.3 ist auf dem Testsystem.',
    'Der Umsatz stieg im dritten Quartal um 11,9 %.',
    'Angebot A09 vom 12.03.2024 ist noch gültig.',
    'Norm DIN E11.9 gilt für die Prüfung.',
    'Der Preis beträgt E11.9 EUR netto.',
    'Serie F32.1 der Pumpen ist ausverkauft.',
  ])('says nothing about %s', (text) => {
    expect(found(text, ICD_SET)).toEqual([]);
  });

  it('does not license a code from the second half of a version chain', () => {
    expect(found('Release 2.1-E11.9-rc1 gebaut', ICD_SET)).toEqual([]);
  });

  it('takes further false-positive vocabulary from the caller', () => {
    const text = 'Lieferschein L20.9 vom Montag liegt bei.';
    const [strict] = createIcd10Detectors({ blockedPrefixWords: ['Lieferschein'] });
    expect(values(text, icd10Detector)).toEqual(['L20.9']);
    expect(values(text, strict)).toEqual([]);
  });

  it('takes further catalogue codes from the caller', () => {
    const [wider] = createIcd10Detectors({ codes: ['Q87.2'] });
    expect(values('Q87.2 dokumentiert', icd10Detector)).toEqual([]);
    expect(values('Q87.2 dokumentiert', wider)).toEqual(['Q87.2']);
  });
});

describe('medication names', () => {
  it.each([
    ['Metformin 850 mg 1-0-1', ['Metformin']],
    ['Metformin850mg', ['Metformin']],
    ['METFORMIN', ['METFORMIN']],
    ['Ramipril 5 mg, Sertralin 50 mg', ['Ramipril', 'Sertralin']],
    ['Rx: Metformin', ['Metformin']],
    ['Metformin (Glucophage)', ['Metformin']],
    ['Metforminhydrochlorid 850 mg', ['Metforminhydrochlorid']],
    ['ibuprofenhaltige Salbe', ['ibuprofenhaltige']],
  ])('finds the ingredient in %s', (text, expected) => {
    const spans = medicationDetector.find(text);
    expect(values(text, medicationDetector)).toEqual(expected);
    assertSliceable(text, spans);
    for (const span of spans) expect(span.kind).toBe(MEDICATION_KIND);
  });

  it('ships a usable seed', () => {
    expect(SEED_MEDICATION_NAMES.length).toBeGreaterThan(40);
    for (const name of SEED_MEDICATION_NAMES) expect(name.length).toBeGreaterThan(4);
  });

  it.each([
    'Wir bestätigen den Auftrag über 12 Paletten Schrauben M8.',
    'Der Lieferant hat die Metallformen termingerecht geliefert.',
    'Wir verbauen Lithium-Ionen-Akkus in Serie.',
    'Die Simulation lief über 850 mg Probenmasse.',
  ])('says nothing about %s', (text) => {
    expect(medicationDetector.find(text)).toEqual([]);
  });

  it('takes further names from the caller', () => {
    const wider = createMedicationDetector({ names: ['Xylocain'] });
    expect(medicationDetector.find('Xylocain 2 %')).toEqual([]);
    expect(values('Xylocain 2 %', wider)).toEqual(['Xylocain']);
  });

  it('can be tightened to names that carry a dosage', () => {
    const strict = createMedicationDetector({ requireDosage: true });
    const catalogue = 'Unser Sortiment umfasst Ibuprofen und Paracetamol als Wirkstoffe.';
    expect(values(catalogue, medicationDetector)).toEqual(['Ibuprofen', 'Paracetamol']);
    expect(strict.find(catalogue)).toEqual([]);
    expect(values('Ibuprofen 400 mg 1-1-1', strict)).toEqual(['Ibuprofen']);
    expect(values('2 Tabletten Ibuprofen täglich', strict)).toEqual(['Ibuprofen']);
  });
});

describe('the whole health set', () => {
  it('reports a prescription line as one code and one drug', () => {
    const text = 'ICD-10: E11.9 G, Medikation: Metformin 850 mg 1-0-1.';
    const spans = detect(text, ALL);
    expect(kinds(spans)).toEqual([ICD_CODE_KIND, MEDICATION_KIND]);
    expect(spans.map((s) => s.value)).toEqual(['E11.9 G', 'Metformin']);
    assertSliceable(text, spans);
  });

  it('sees through an invisible character in a drug name', () => {
    const text = 'Patient nimmt Met​formin ein.';
    const spans = detect(text, ALL);
    expect(kinds(spans)).toEqual([MEDICATION_KIND]);
    assertSliceable(text, spans);
  });

  it('outranks the rules that could claim the same words', () => {
    expect(ICD_CODE_PRIORITY).toBeGreaterThan(45);
    expect(MEDICATION_PRIORITY).toBeGreaterThan(45);
  });

  it('leaves an invoice untouched', () => {
    const text = [
      'Sehr geehrte Damen und Herren,',
      'anbei die Rechnung 2024-1187 über die Baugruppe M25.5 sowie',
      'Version E11.9 der Steuerungssoftware. Zahlbar binnen 14 Tagen.',
      'Mit freundlichen Grüßen',
    ].join('\n');
    expect(found(text)).toEqual([]);
  });
});
