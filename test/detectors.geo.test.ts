import { describe, expect, it } from 'vitest';
import { detect } from '../src/detectors/index.js';
import type { Detector } from '../src/types.js';
import {
  createVehiclePlateDetectors,
  GERMAN_PLATE_DISTRICTS,
  labelledVehiclePlateDetector,
  VEHICLE_PLATE_KIND,
  vehiclePlateDetector,
} from '../src/detectors/vehicleplate.js';
import {
  createPostcodeDetector,
  isPostcodeShaped,
  POSTCODE_KIND,
  postcodeDetector,
  SEED_PLACE_NAMES,
} from '../src/detectors/postcode.js';

const values = (text: string, detector: Detector): string[] =>
  detector.find(text).map((span) => span.value);

/** Every span a detector returns must re-slice to itself. */
const assertSliceInvariant = (text: string, detector: Detector): void => {
  for (const span of detector.find(text)) {
    expect(text.slice(span.start, span.end)).toBe(span.value);
  }
};

describe('Kfz-Kennzeichen spellings', () => {
  it('reads every separator a plate is written with', () => {
    expect(values('Das Fahrzeug KA-XY 1234 wurde gemeldet.', vehiclePlateDetector)).toEqual([
      'KA-XY 1234',
    ]);
    expect(values('KA XY 1234', vehiclePlateDetector)).toEqual(['KA XY 1234']);
    expect(values('KA-XY1234', vehiclePlateDetector)).toEqual(['KA-XY1234']);
    expect(values('KA-XY-1234', vehiclePlateDetector)).toEqual(['KA-XY-1234']);
    // U+2011 non-breaking hyphen, which a word processor inserts on its own.
    expect(values('KA‑XY 1234', vehiclePlateDetector)).toEqual(['KA‑XY 1234']);
  });

  it('reads a hyphenated plate written in lower case', () => {
    expect(values('ka-xy 1234', vehiclePlateDetector)).toEqual(['ka-xy 1234']);
  });

  it('keeps the E and H suffix inside the span', () => {
    expect(values('B-AB 123E', vehiclePlateDetector)).toEqual(['B-AB 123E']);
    expect(values('M-AB 123H', vehiclePlateDetector)).toEqual(['M-AB 123H']);
  });

  it('holds the slice invariant across the mixed spellings', () => {
    const text = 'KA-XY 1234, B-AB 123E und M‑CD 7 stehen im Hof.';
    assertSliceInvariant(text, vehiclePlateDetector);
  });
});

describe('Kfz-Kennzeichen structure', () => {
  it('rejects an Unterscheidungszeichen outside the register', () => {
    expect(values('QQ-XY 1234', vehiclePlateDetector)).toEqual([]);
    expect(values('XYZ-AB 12', vehiclePlateDetector)).toEqual([]);
  });

  it('rejects a plate longer than the eight characters a plate has', () => {
    // GAP is a real district, but GAP-XY 1234 is nine characters and is never issued.
    expect(values('GAP-XY 1234', vehiclePlateDetector)).toEqual([]);
    expect(values('GAP-XY 123', vehiclePlateDetector)).toEqual(['GAP-XY 123']);
  });

  it('rejects an Erkennungsnummer that starts with a zero or runs too long', () => {
    expect(values('KA-XY 0123', vehiclePlateDetector)).toEqual([]);
    expect(values('KA-XY 12345', vehiclePlateDetector)).toEqual([]);
  });

  it('reads the letter groups maximally, so a longer word is not a district', () => {
    expect(values('Rechnungs-Nr 1234', vehiclePlateDetector)).toEqual([]);
    expect(values('AKA-XY 1234', vehiclePlateDetector)).toEqual([]);
    expect(values('T-Shirt 20', vehiclePlateDetector)).toEqual([]);
  });

  it('does not read a lower-case space-separated pair as a plate', () => {
    // "ab ca 50" is AB + CA + 50 by shape alone; nothing but the casing and the
    // missing hyphen separates it from a plate.
    expect(values('Lieferung ab ca 50 Stueck', vehiclePlateDetector)).toEqual([]);
    expect(values('Lieferung ab ca. 50 Stueck', vehiclePlateDetector)).toEqual([]);
  });
});

describe('the run-together Kfz-Kennzeichen', () => {
  it('is not reported unaccompanied, because the split is a guess', () => {
    expect(values('KAXY1234', vehiclePlateDetector)).toEqual([]);
    expect(detect('KAXY1234', [vehiclePlateDetector, labelledVehiclePlateDetector])).toEqual([]);
    expect(detect('ABC123 ist ein Platzhalter', [labelledVehiclePlateDetector])).toEqual([]);
  });

  it('is reported once a label licenses it', () => {
    const spans = detect('Kennzeichen: KAXY1234', [
      vehiclePlateDetector,
      labelledVehiclePlateDetector,
    ]);
    expect(spans.map((span) => span.value)).toEqual(['KAXY1234']);
    expect(spans.map((span) => span.kind)).toEqual([VEHICLE_PLATE_KIND]);
  });

  it('and the separated spelling stays with the unlabelled detector', () => {
    expect(values('KAXY1234', labelledVehiclePlateDetector)).toEqual(['KAXY1234']);
    expect(values('KA-XY 1234', labelledVehiclePlateDetector)).toEqual([]);
  });
});

describe('the district seed', () => {
  it('holds the districts a German reader would name first', () => {
    for (const code of ['B', 'M', 'K', 'F', 'S', 'HH', 'HB', 'H', 'KA', 'MA', 'N', 'L', 'DD', 'E', 'DO', 'BO', 'D', 'W', 'HD', 'FR', 'UL', 'RV', 'KN', 'AA']) {
      expect(GERMAN_PLATE_DISTRICTS).toContain(code);
    }
  });

  it('is extensible, because it is a subset of the official register', () => {
    const { plate } = createVehiclePlateDetectors({ districts: ['QQ'] });
    expect(values('QQ-XY 1234', plate)).toEqual(['QQ-XY 1234']);
    // The seed is still there; the option adds to it rather than replacing it.
    expect(values('KA-XY 1234', plate)).toEqual(['KA-XY 1234']);
  });
});

describe('Postleitzahl shape', () => {
  it('accepts the allocated range and rejects what sits below it', () => {
    expect(isPostcodeShaped('76133')).toBe(true);
    expect(isPostcodeShaped('01067')).toBe(true);
    expect(isPostcodeShaped('99999')).toBe(true);
    expect(isPostcodeShaped('00999')).toBe(false);
    expect(isPostcodeShaped('7613')).toBe(false);
    expect(isPostcodeShaped('761333')).toBe(false);
  });
});

describe('Postleitzahl gating', () => {
  it('does NOT fire on a bare five-digit number in running text', () => {
    expect(values('Wir haben 76133 Teile geliefert.', postcodeDetector)).toEqual([]);
    expect(values('76133', postcodeDetector)).toEqual([]);
    expect(values('Der Betrag von 12345 Euro ist faellig.', postcodeDetector)).toEqual([]);
    expect(detect('Die Maschine lief 76133 Stunden.', [postcodeDetector])).toEqual([]);
  });

  it('fires when a label names it', () => {
    expect(values('PLZ 76133', postcodeDetector)).toEqual(['76133']);
    expect(values('Postleitzahl: 76133', postcodeDetector)).toEqual(['76133']);
  });

  it('does not let a label license the number in the next clause', () => {
    expect(
      values('Bitte tragen Sie Ihre PLZ ein. Der Betrag von 12345 Euro.', postcodeDetector),
    ).toEqual([]);
    // The label licenses what follows it, never what came before.
    expect(values('Betrag 12345, PLZ 76133', postcodeDetector)).toEqual(['76133']);
  });

  it('fires when a country prefix carries it', () => {
    expect(values('D-76133', postcodeDetector)).toEqual(['76133']);
    expect(values('DE-76133', postcodeDetector)).toEqual(['76133']);
    expect(values('D‑76133', postcodeDetector)).toEqual(['76133']);
    // A prefix that is part of a longer word is not a country prefix.
    expect(values('LOAD-76133', postcodeDetector)).toEqual([]);
  });

  it('fires when a place name follows it', () => {
    expect(values('76133 Karlsruhe', postcodeDetector)).toEqual(['76133']);
    expect(values('80331 München', postcodeDetector)).toEqual(['80331']);
    // A capitalised German noun is not a place name; only the seed decides.
    expect(values('12000 Kunden', postcodeDetector)).toEqual([]);
    expect(values('76530 Baden-Baden', postcodeDetector)).toEqual(['76530']);
  });

  it('holds the slice invariant and stops at the digits', () => {
    const text = 'Musterstrasse 1, D-76133 Karlsruhe, PLZ 76133.';
    assertSliceInvariant(text, postcodeDetector);
    for (const span of postcodeDetector.find(text)) {
      expect(span.value).toMatch(/^\d{5}$/u);
      expect(span.kind).toBe(POSTCODE_KIND);
    }
  });

  it('does not read five digits out of a longer run', () => {
    expect(values('PLZ 761330', postcodeDetector)).toEqual([]);
    expect(values('PLZ 176133', postcodeDetector)).toEqual([]);
  });
});

describe('the place seed', () => {
  it('holds the cities a German address most often names', () => {
    for (const place of ['Berlin', 'Hamburg', 'München', 'Karlsruhe', 'Stuttgart']) {
      expect(SEED_PLACE_NAMES).toContain(place);
    }
  });

  it('is extensible, and the hook can also decide consistency', () => {
    const added = createPostcodeDetector({ places: ['Kleinkleckersdorf'] });
    expect(values('12345 Kleinkleckersdorf', added)).toEqual(['12345']);

    const consistent = createPostcodeDetector({
      placeMatches: (postcode, place) => place === 'Karlsruhe' && postcode.startsWith('76'),
    });
    expect(values('76133 Karlsruhe', consistent)).toEqual(['76133']);
    expect(values('10115 Karlsruhe', consistent)).toEqual([]);
  });
});

describe('both detectors inside detect()', () => {
  it('resolve alongside the built-ins without eating each other', () => {
    const text = 'Fahrzeug KA-XY 1234, Halter in 76133 Karlsruhe, PLZ 76133.';
    const spans = detect(text, [vehiclePlateDetector, labelledVehiclePlateDetector, postcodeDetector]);
    expect(spans.map((span) => span.value)).toEqual(['KA-XY 1234', '76133', '76133']);
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.value);
  });
});
