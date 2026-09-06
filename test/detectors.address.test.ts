import { describe, expect, it } from 'vitest';
import { detect } from '../src/detectors/index.js';
import type { Span } from '../src/types.js';
import {
  createPostalAddressDetector,
  postalAddressDetector,
  POSTAL_ADDRESS_PRIORITY,
} from '../src/detectors/address.js';

const found = (text: string): string[] => postalAddressDetector.find(text).map((s) => s.value);

/** Every span must still slice back to itself out of the text it was found in. */
const assertSliceable = (text: string, spans: readonly Span[]): void => {
  for (const span of spans) expect(span.value).toBe(text.slice(span.start, span.end));
};

describe('the shapes a German address is written in', () => {
  it('finds street, house number, postcode and place', () => {
    expect(found('Kaiserstraße 12, 76133 Karlsruhe')).toEqual([
      'Kaiserstraße 12, 76133 Karlsruhe',
    ]);
  });

  it('finds the abbreviated street type', () => {
    expect(found('Kaiserstr. 12, 76133 Karlsruhe')).toEqual(['Kaiserstr. 12, 76133 Karlsruhe']);
  });

  it('finds the abbreviation written without its dot', () => {
    expect(found('Kaiserstr 12, 76133 Karlsruhe')).toEqual(['Kaiserstr 12, 76133 Karlsruhe']);
  });

  it('finds the ss spelling', () => {
    expect(found('Kaiserstrasse 12')).toEqual(['Kaiserstrasse 12']);
  });

  it('finds an address broken over two lines', () => {
    expect(found('Kaiserstraße 12\n76133 Karlsruhe')).toEqual([
      'Kaiserstraße 12\n76133 Karlsruhe',
    ]);
  });

  it('finds an address written in capitals', () => {
    expect(found('KAISERSTRASSE 12')).toEqual(['KAISERSTRASSE 12']);
  });

  it('finds a house number with a letter suffix', () => {
    expect(found('Kaiserstraße 12a')).toEqual(['Kaiserstraße 12a']);
  });

  it('finds a house number range', () => {
    expect(found('Kaiserstraße 12-14')).toEqual(['Kaiserstraße 12-14']);
    expect(found('Kaiserstraße 12 - 14')).toEqual(['Kaiserstraße 12 - 14']);
    expect(found('Kaiserstraße 12a/14b')).toEqual(['Kaiserstraße 12a/14b']);
  });

  it('finds a house number glued to the street name', () => {
    expect(found('Kaiserstraße12')).toEqual(['Kaiserstraße12']);
    expect(found('Kaiserstr.12')).toEqual(['Kaiserstr.12']);
  });

  it('finds a hyphenated street name', () => {
    expect(found('Karl-Marx-Allee 90, 10243 Berlin')).toEqual([
      'Karl-Marx-Allee 90, 10243 Berlin',
    ]);
  });

  it('keeps a multi-word place together', () => {
    expect(found('Bergerstraße 3, 60316 Frankfurt am Main')).toEqual([
      'Bergerstraße 3, 60316 Frankfurt am Main',
    ]);
    expect(found('Hauptstraße 1, 79539 Lörrach-Stetten')).toEqual([
      'Hauptstraße 1, 79539 Lörrach-Stetten',
    ]);
  });

  it('accepts the D- country prefix on the postcode', () => {
    expect(found('Kaiserstraße 12, D-76133 Karlsruhe')).toEqual([
      'Kaiserstraße 12, D-76133 Karlsruhe',
    ]);
  });

  it('stops at the sentence the address sits in', () => {
    const text = 'Unser Büro liegt in der Kaiserstraße 12, 76133 Karlsruhe. Bitte melden Sie sich.';
    expect(found(text)).toEqual(['Kaiserstraße 12, 76133 Karlsruhe']);
  });

  it('finds every address in a block', () => {
    const text =
      'Rechnungsadresse:\nKaiserstraße 12\n76133 Karlsruhe\n\nLieferadresse:\nLindenweg 5\n20457 Hamburg';
    expect(found(text)).toEqual([
      'Kaiserstraße 12\n76133 Karlsruhe',
      'Lindenweg 5\n20457 Hamburg',
    ]);
  });
});

describe('the street type alone is never enough', () => {
  it('does not fire on prose that merely names a street', () => {
    expect(found('Die Baustelle in der Kaiserstraße verzögert die Lieferung.')).toEqual([]);
    expect(found('Unsere Filiale in der Bahnhofstraße wird umgebaut.')).toEqual([]);
    expect(found('Der Umsatz der Filiale Bahnhofstraße stieg um 12 Prozent.')).toEqual([]);
  });

  it('does not fire on the bare street-type word plus a number', () => {
    expect(found('Wir haben die Straße 2019 saniert.')).toEqual([]);
    expect(found('Auf dem Weg 3 Kilometer weiter liegt das Lager.')).toEqual([]);
    expect(found('Am Platz 4 stehen die Container.')).toEqual([]);
  });

  it('does not fire when the number is not next to the street name', () => {
    expect(found('Die Kaiserstraße wurde 2019 saniert.')).toEqual([]);
    expect(found('Wir verlegen 12 Meter Kabel entlang der Hauptstraße.')).toEqual([]);
  });

  it('does not read a plural as a street type', () => {
    expect(found('Wir haben 2019 drei Hauptstraßen saniert.')).toEqual([]);
    expect(found('Die Anlage hat 12 Stellplätze.')).toEqual([]);
  });
});

describe('the street type written as its own word', () => {
  it('is read as a street only when something backs it up', () => {
    expect(found('Lange Straße 5, 12345 Musterstadt')).toEqual([
      'Lange Straße 5, 12345 Musterstadt',
    ]);
    expect(found('Lange Straße 5')).toEqual([]);
  });

  it('never lets a determiner stand in for the street name', () => {
    expect(found('Die Straße 12 wurde 2019 saniert.')).toEqual([]);
    expect(found('Diese Straße 12, 76133 Karlsruhe')).toEqual([]);
  });
});

describe('the weak street types need corroboration', () => {
  it('does not fire on an ordinary German noun that ends in one', () => {
    expect(found('Der Parkplatz 12 ist für Besucher reserviert.')).toEqual([]);
    expect(found('Bahnsteig 5 wird ab Montag gesperrt.')).toEqual([]);
    expect(found('Der Radweg 5 wird verbreitert.')).toEqual([]);
    expect(found('Speicherplatz 12 GB ist belegt.')).toEqual([]);
    expect(found('Arbeitsplatz 7 bleibt bis Freitag unbesetzt.')).toEqual([]);
  });

  it('does not fire on a plausible street name with nothing to back it up', () => {
    expect(found('Lindenweg 5')).toEqual([]);
    expect(found('Rathausplatz 1')).toEqual([]);
  });

  it('fires once a postcode backs it up', () => {
    expect(found('Lindenweg 5, 12345 Musterstadt')).toEqual(['Lindenweg 5, 12345 Musterstadt']);
    expect(found('Rathausplatz 1, 76133 Karlsruhe')).toEqual(['Rathausplatz 1, 76133 Karlsruhe']);
  });

  it('fires once an address label backs it up', () => {
    expect(found('Anschrift: Lindenweg 5')).toEqual(['Lindenweg 5']);
    expect(found('Lieferadresse Rathausplatz 1')).toEqual(['Rathausplatz 1']);
  });

  it('stays silent for a blocked noun even with a postcode next to it', () => {
    expect(found('Verkäufer 12, 76133 Karlsruhe')).toEqual([]);
  });
});

describe('what follows the house number', () => {
  it('does not read a date as a house number', () => {
    expect(found('Kaiserstraße 12.05.2024')).toEqual([]);
  });

  it('does not read an amount as a house number', () => {
    expect(found('Kaiserstraße 12,50 EUR')).toEqual([]);
    expect(found('Kaiserstraße 12%')).toEqual([]);
  });

  it('does not read a four-digit year as a house number', () => {
    expect(found('Kaiserstraße 2019 saniert')).toEqual([]);
  });

  it('does not glue a word onto the house number', () => {
    expect(found('Kaiserstraße 12abc')).toEqual([]);
  });
});

describe('the postcode has to look like a postcode', () => {
  it('rejects a five-digit run that cannot be a German postcode', () => {
    expect(found('Kaiserstraße 12, 00123 Karlsruhe')).toEqual(['Kaiserstraße 12']);
  });

  it('rejects a longer digit run standing where the postcode would', () => {
    expect(found('Kaiserstraße 12, 761330 Karlsruhe')).toEqual(['Kaiserstraße 12']);
  });

  it('can be narrowed to a known set of postcodes', () => {
    const detector = createPostalAddressDetector({ postcodes: new Set(['76133']) });
    const values = (text: string): string[] => detector.find(text).map((s) => s.value);

    expect(values('Kaiserstraße 12, 76133 Karlsruhe')).toEqual([
      'Kaiserstraße 12, 76133 Karlsruhe',
    ]);
    // The postcode is unknown, so it stops backing the address up: the strong
    // street type still fires on its own, the weak one no longer does.
    expect(values('Kaiserstraße 12, 99999 Nirgendwo')).toEqual(['Kaiserstraße 12']);
    expect(values('Lindenweg 5, 99999 Nirgendwo')).toEqual([]);
  });
});

describe('the English word order', () => {
  it('is supported when a postcode backs it up', () => {
    expect(found('12 Kaiserstrasse, 76133 Karlsruhe')).toEqual([
      '12 Kaiserstrasse, 76133 Karlsruhe',
    ]);
  });

  it('is not supported bare, because a numbered list looks the same', () => {
    expect(found('12 Kaiserstrasse')).toEqual([]);
    expect(found('1. Bahnhofstraße\n2. Kaiserstraße')).toEqual([]);
  });
});

describe('the abbreviation is not a variable name', () => {
  it('does not read camelCase code as an abbreviated street', () => {
    expect(found('const nameStr 12')).toEqual([]);
    expect(found('valueStr 3')).toEqual([]);
  });
});

describe('the detector contract', () => {
  it('never returns a span that does not slice back to itself', () => {
    const text = 'Kaiserstraße 12a-14b, D-76133 Karlsruhe\nLindenweg 5, 12345 Musterstadt';
    const spans = postalAddressDetector.find(text);
    assertSliceable(text, spans);
    expect(spans.map((s) => s.kind)).toEqual(['POSTAL_ADDRESS', 'POSTAL_ADDRESS']);
    expect(spans.every((s) => s.priority === POSTAL_ADDRESS_PRIORITY)).toBe(true);
    expect(spans.every((s) => s.detector === 'postal-address')).toBe(true);
  });

  it('does not mutate its input', () => {
    const text = 'Kaiserstraße 12, 76133 Karlsruhe';
    const before = `${text}`;
    postalAddressDetector.find(text);
    expect(text).toBe(before);
  });

  it('survives a body with no address at all', () => {
    const text = 'Sehr geehrte Damen und Herren, anbei die Rechnung über 1.234,56 EUR.';
    expect(found(text)).toEqual([]);
  });

  it('accepts extra street types and extra blocked words', () => {
    const detector = createPostalAddressDetector({
      streetSuffixes: ['pfad'],
      nonAddressWords: ['Kaiserstraße'],
    });
    const values = (text: string): string[] => detector.find(text).map((s) => s.value);

    expect(values('Waldpfad 7, 12345 Musterstadt')).toEqual(['Waldpfad 7, 12345 Musterstadt']);
    expect(values('Kaiserstraße 12, 76133 Karlsruhe')).toEqual([]);
  });
});

describe('through detect(), with the scan copies', () => {
  it('sees through an invisible character inside the street name', () => {
    const text = 'Kaiser​straße 12, 76133 Karlsruhe';
    const spans = detect(text, [postalAddressDetector]);
    assertSliceable(text, spans);
    expect(spans.map((s) => s.value)).toEqual([text]);
  });

  it('reports one address once, not once per scan copy', () => {
    const text = 'Kaiserstraße 12, 76133 Karlsruhe';
    expect(detect(text, [postalAddressDetector])).toHaveLength(1);
  });
});
