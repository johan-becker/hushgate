import { describe, expect, it } from 'vitest';
import { detect } from '../src/detectors/index.js';
import { resolveSpans } from '../src/detectors/resolve.js';
import { germanTaxIdDetector } from '../src/detectors/taxid.js';
import type { Detector, Span } from '../src/types.js';
import {
  isSteuernummerLayout,
  labelledSteuernummerDetector,
  steuernummerDetector,
} from '../src/detectors/steuernummer.js';
import { commercialRegisterDetector } from '../src/detectors/commercialregister.js';
import { driverLicenceDetector } from '../src/detectors/driverlicence.js';

const steuernummer: Detector[] = [steuernummerDetector, labelledSteuernummerDetector];
const register: Detector[] = [commercialRegisterDetector];
const licence: Detector[] = [driverLicenceDetector];

const values = (spans: readonly Span[]): string[] => spans.map((s) => s.value);
const kinds = (spans: readonly Span[]): string[] => spans.map((s) => s.kind);

/** Every span must still slice back to itself out of the original text. */
const assertSliceable = (text: string, spans: readonly Span[]): void => {
  for (const span of spans) expect(span.value).toBe(text.slice(span.start, span.end));
};

const scan = (text: string, detectors: Detector[]): Span[] => {
  const spans = detect(text, detectors);
  assertSliceable(text, spans);
  return spans;
};

describe('Steuernummer group layout', () => {
  it('accepts the layouts the Länder actually print', () => {
    expect(isSteuernummerLayout([2, 3, 5])).toBe(true);
    expect(isSteuernummerLayout([3, 3, 5])).toBe(true);
    expect(isSteuernummerLayout([3, 4, 4])).toBe(true);
    expect(isSteuernummerLayout([5, 5])).toBe(true);
  });

  it('rejects anything else, dates included', () => {
    expect(isSteuernummerLayout([2, 2, 4])).toBe(false);
    expect(isSteuernummerLayout([2, 4])).toBe(false);
    expect(isSteuernummerLayout([2, 3, 6])).toBe(false);
    expect(isSteuernummerLayout([10])).toBe(false);
  });
});

describe('the slash-grouped Steuernummer stands on its own', () => {
  it('fires with no label in sight', () => {
    const text = 'Bitte 27/123/45678 auf der Rechnung angeben.';
    const spans = scan(text, steuernummer);
    expect(values(spans)).toEqual(['27/123/45678']);
    expect(kinds(spans)).toEqual(['GERMAN_TAX_NUMBER']);
  });

  it.each(['27/123/45678', '181/815/08155', '133/8150/8155', '93815/08152'])(
    'reads the Land layout %s',
    (value) => {
      expect(values(scan(`Rechnung ${value} vom 3.4.`, steuernummer))).toEqual([value]);
    },
  );

  it('keeps the label out of the span', () => {
    expect(values(scan('St.-Nr. 27/123/45678', steuernummer))).toEqual(['27/123/45678']);
  });

  it('leaves dates and file references alone', () => {
    expect(scan('Rechnung vom 01/02/2024', steuernummer)).toEqual([]);
    expect(scan('Az. 5/2019 liegt vor', steuernummer)).toEqual([]);
    expect(scan('Vertrag 27/123/456789', steuernummer)).toEqual([]);
  });

  it('still finds the number after a slash group it had to reject', () => {
    const spans = scan('Az. 5/2019, 27/123/45678', steuernummer);
    expect(values(spans)).toEqual(['27/123/45678']);
  });
});

describe('every other Steuernummer spelling waits for its label', () => {
  it.each(['2712345678', '27 123 45678', '27-123-45678', '3012 0123 4567'])(
    'says nothing about a bare %s',
    (value) => {
      expect(scan(`Der Betrag ${value} ist gebucht.`, steuernummer)).toEqual([]);
    },
  );

  it.each([
    ['Steuernummer: 2712345678', '2712345678'],
    ['St.-Nr. 27 123 45678', '27 123 45678'],
    ['StNr 27-123-45678', '27-123-45678'],
    ['Steuer-Nr 3012 0123 4567', '3012 0123 4567'],
    ['Steuernummer 3012 0123 4567 der Firma', '3012 0123 4567'],
  ])('reports %s once a label licenses it', (text, value) => {
    const spans = scan(text, steuernummer);
    expect(values(spans)).toEqual([value]);
    expect(kinds(spans)).toEqual(['GERMAN_TAX_NUMBER']);
  });

  it('does not swallow a number that is far too long', () => {
    expect(scan('Steuernummer 271234567890123456', steuernummer)).toEqual([]);
  });

  it('yields the eleven digits to the Steuer-ID, which can prove them', () => {
    const text = 'Steuernummer 86095742719';
    const spans = resolveSpans(detect(text, [germanTaxIdDetector, ...steuernummer]));
    expect(kinds(spans)).toEqual(['GERMAN_TAX_ID']);
  });
});

describe('Handelsregister numbers carry their own signal', () => {
  it.each([
    ['HRB 123456', 'HRB 123456'],
    ['HRB123456', 'HRB123456'],
    ['hrb 123456', 'hrb 123456'],
    ['HRB-123456', 'HRB-123456'],
    ['HRA 12345', 'HRA 12345'],
    ['HRB 123456 B', 'HRB 123456 B'],
    ['Amtsgericht Karlsruhe HRB 123456', 'HRB 123456'],
  ])('reads %s with no label needed', (text, value) => {
    const spans = scan(text, register);
    expect(values(spans)).toEqual([value]);
    expect(kinds(spans)).toEqual(['COMMERCIAL_REGISTER_ID']);
  });

  it('takes a Zweigstelle letter only when it stands alone', () => {
    expect(values(scan('eingetragen im HRB 123456 Berlin', register))).toEqual(['HRB 123456']);
  });

  it('refuses what is not a register number', () => {
    expect(scan('Das HRB kennt die Nummer', register)).toEqual([]);
    expect(scan('Bestellung THRB 123456', register)).toEqual([]);
    expect(scan('Vorgang HRB 1234567', register)).toEqual([]);
  });
});

describe('Führerschein numbers wait for their label', () => {
  it.each([
    ['Führerschein B072RRE2I55', 'B072RRE2I55'],
    ['fuehrerschein b072rre2i55', 'b072rre2i55'],
    ['FS-Nr. B072 RRE2 I55', 'B072 RRE2 I55'],
    ['Führerscheinnummer B072-RRE2-I55', 'B072-RRE2-I55'],
    ['Fahrerlaubnis B072RRE2I55 entzogen', 'B072RRE2I55'],
  ])('reports %s', (text, value) => {
    const spans = scan(text, licence);
    expect(values(spans)).toEqual([value]);
    expect(kinds(spans)).toEqual(['DRIVER_LICENCE_ID']);
  });

  it('says nothing about the same eleven characters unaccompanied', () => {
    expect(scan('Der Code B072RRE2I55 gehoert zur Bestellung.', licence)).toEqual([]);
  });

  it('does not mistake an eleven-letter German word next to the label for a number', () => {
    expect(scan('Fahrerlaubnis beim Verkehrsamt beantragt', licence)).toEqual([]);
  });

  it('does not report ten or twelve characters', () => {
    expect(scan('Führerschein B072RRE2I5', licence)).toEqual([]);
    expect(scan('Führerschein B072RRE2I556', licence)).toEqual([]);
  });
});

describe('the scan copies phase 1 built still reach these shapes', () => {
  it('finds a Steuernummer written with an invisible character in it', () => {
    const text = 'Steuernummer 27/123/45​678';
    const spans = scan(text, steuernummer);
    expect(values(spans)).toEqual(['27/123/45​678']);
  });

  it('finds a licence number spelled out one character at a time', () => {
    const text = 'Führerschein B 0 7 2 R R E 2 I 5 5';
    const spans = scan(text, licence);
    expect(values(spans)).toEqual(['B 0 7 2 R R E 2 I 5 5']);
  });

  it('does not read a date next to the label as a licence number', () => {
    expect(scan('Die Fahrerlaubnis wurde Ende Mai 2019 erteilt.', licence)).toEqual([]);
  });

  it('does not read a sentence next to the label as a licence number', () => {
    expect(scan('Fahrerlaubnis Klasse B seit 2019 gueltig', licence)).toEqual([]);
  });
});

describe('a slash chain that is a path is not a Steuernummer', () => {
  it('leaves a URL path alone', () => {
    expect(scan('https://example.com/2024/12/123/45678/page', steuernummer)).toEqual([]);
  });

  it('still reads the same digits when a label licenses them', () => {
    const text = 'Steuernummer /12/123/45678/';
    expect(values(scan(text, steuernummer))).toEqual(['12/123/45678']);
  });
});

describe('a whole invoice header', () => {
  const invoice = [
    'Rechnung 2024-0815 vom 12.03.2024',
    'Muster GmbH, Amtsgericht Karlsruhe HRB 123456',
    'Steuernummer 27/123/45678, USt-IdNr. DE123456789',
    'Betrag 1.234,56 EUR, faellig am 15.04.2024',
  ].join('\n');

  it('takes the Steuernummer and nothing else that is numeric', () => {
    expect(values(scan(invoice, steuernummer))).toEqual(['27/123/45678']);
  });

  it('takes the register number and leaves the court name out of it', () => {
    expect(values(scan(invoice, register))).toEqual(['HRB 123456']);
  });

  it('reports no licence number where no label licenses one', () => {
    expect(scan(invoice, licence)).toEqual([]);
  });

  it.each([
    ['Steuernummer 27/123/4567', steuernummer],
    ['HRB', register],
    ['Führerschein B072RRE2I5', licence],
  ])('runs off the end of %s without a span or a crash', (text, detectors) => {
    expect(scan(text, detectors)).toEqual([]);
  });
});
