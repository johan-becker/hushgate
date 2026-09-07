import { describe, expect, it } from 'vitest';
import { createDetectors, detect, labelNear, phoneDetector } from '../src/detectors/index.js';

/**
 * The three ways the phone detector claimed a German business number, and the
 * one rule underneath two of them.
 *
 * HOW THESE WERE FOUND, because it decides what the file has to contain: not by
 * reading the detector, but by running forty-three sentences of ordinary German
 * business correspondence — an offer, an order, a delivery note, a quality
 * report — through the whole detector set with no dictionary and no custom
 * rules. Four findings came back and three of them were this detector. So the
 * fixtures below are that prose, not shapes invented to fail.
 *
 * Each false positive had its own cause, and they are tested separately because
 * a single one of them coming back must name itself:
 *
 *  1. `Bestellnummer 4500123456` — the label. `labelNear` folded punctuation
 *     away and asked for containment, and `tel` sits inside `bes-tel-lnummer`.
 *     So did `Bestellung`, `bestellt`, `Stelle` and `Kostenstelle`.
 *  2. `Sendung 00 340 434 000 123 456 78` — nineteen digits cut to seventeen at
 *     MAX_DIGITS, landing on a space rather than a digit, which the guard that
 *     followed read as the end of a number.
 *  3. `Buchungsperiode 03/2026` — six digits behind a separator is the German
 *     national shape, and `03` is not a Vorwahl.
 */

const detectors = createDetectors();
const kinds = (text: string): string[] => detect(text, detectors).map((span) => span.kind);
const values = (text: string): string[] => phoneDetector.find(text).map((span) => span.value);

describe('the phone detector does not claim German business numbers', () => {
  it('leaves an order number alone', () => {
    expect(kinds('Bestellnummer 4500123456 wurde am Montag im System angelegt.')).toEqual([]);
  });

  it('leaves a consignment number alone', () => {
    expect(kinds('Sendung 00 340 434 000 123 456 78 wurde am Dienstag avisiert.')).toEqual([]);
  });

  it('leaves an accounting period alone', () => {
    expect(kinds('Kostenstelle 4711, Kostentraeger 100 200, Buchungsperiode 03/2026.')).toEqual([]);
  });

  it('leaves the rest of the same correspondence alone', () => {
    // The other sentences from the same probe. They were already quiet; they
    // are here so that a later loosening cannot trade one of these back.
    for (const line of [
      'Unser Angebot Nr. 2026-0042 gilt bis zum 30.09.2026, freibleibend.',
      'Materialnummer 100 234 567, Charge 2026-0311, Mindesthaltbarkeit 24 Monate.',
      'Der Pruefbericht 2026 0311 0042 liegt der Lieferung bei.',
      'Werkzeug W-4471 wurde nach 120 000 Hueben zur Wartung ausgebaut.',
      'Die Rueckstellung betraegt 1.234.567,89 EUR zum 31.12.2025.',
      'Reklamation R-2026-0117 betrifft Charge 2026-0288, Menge 40 Stueck.',
    ]) {
      expect(kinds(line), line).toEqual([]);
    }
  });
});

describe('and still reads the numbers a customer writes', () => {
  // Every notation from the evasion corpus that this change could have touched.
  // The corpus measures the same thing in bulk; these name them one by one so a
  // failure says which notation broke.
  it.each([
    ['international', '+49 721 1234567'],
    ['no space after the country code', '+49721 1234567'],
    ['hyphenated', '+49-721-1234567'],
    ['00 instead of +', '0049 721 1234567'],
    ['national', '0721 1234567'],
    ['slash, the common German form', '0721/1234567'],
    ['parenthesised area code', '(0721) 1234567'],
    ['the trunk zero in brackets', '+49 (0) 721 1234567'],
    ['irregular grouping', '+49 721 12 34 5 67'],
    ['three-digit Vorwahl', '030/12345678'],
    ['Munich', '089/1234567'],
  ])('%s', (_name, number) => {
    expect(values(number)).toEqual([number]);
  });

  it('reads a bare national number behind its label', () => {
    expect(values('Tel. 07211234567')).toEqual(['07211234567']);
    expect(values('Telefon 07211234567')).toEqual(['07211234567']);
    expect(values('Diensttelefon 07211234567')).toEqual(['07211234567']);
    expect(values('Mobil 01711234567')).toEqual(['01711234567']);
  });

  it('reads US numbers', () => {
    for (const number of ['(555) 123-4567', '555-123-4567', '555.123.4567', '+1 555 123 4567']) {
      expect(values(number), number).toEqual([number]);
    }
  });
});

/** `#` marks where the value would sit; the label is looked for around it. */
const near = (text: string, labels: readonly string[]): boolean => {
  const at = text.indexOf('#');
  return labelNear(text.replace('#', ''), at, at, { labels });
};

describe('a label has to touch a word edge', () => {
  // The rule lives in `labelNear`, so it is tested there rather than only
  // through its consequences: every detector that declares `requiresLabel`
  // depends on it, and a change here reaches all of them at once.

  it('accepts a label that is the whole word', () => {
    expect(near('Tel. #', ['Tel'])).toBe(true);
  });

  it('accepts a label that starts a compound', () => {
    // German puts the qualifier first and the head last, so both ends matter.
    expect(near('Telefonnummer #', ['Tel'])).toBe(true);
    expect(near('Führerscheinnummer #', ['Führerschein'])).toBe(true);
  });

  it('does not transliterate an umlaut away, which is why lists carry both', () => {
    // The fold strips the diacritic — `Führerschein` becomes `fuhrerschein` —
    // but `ue` is a different letter pair and stays two characters. So the
    // transliterated compound is reached by the transliterated label, not by
    // the accented one, which is exactly why DRIVER_LICENCE_LABELS lists both.
    // Pinned because it looks like a bug in the edge rule and is not one.
    expect(near('Fuehrerscheinnummer #', ['Führerschein'])).toBe(false);
    expect(near('Fuehrerscheinnummer #', ['Fuehrerschein'])).toBe(true);
  });

  it('accepts a label that ends a compound', () => {
    expect(near('Diensttelefon #', ['Telefon'])).toBe(true);
    expect(near('Personalausweis #', ['Ausweis'])).toBe(true);
    expect(near('Krankenversichertennummer #', ['Versichertennummer'])).toBe(true);
  });

  it('refuses a label buried in the middle of a word', () => {
    for (const word of ['Bestellnummer', 'Bestellung', 'bestellt', 'Stelle', 'Kostenstelle']) {
      expect(near(`${word} #`, ['Tel']), word).toBe(false);
    }
  });

  it('still folds punctuation and case inside the label itself', () => {
    // The reason folding exists at all, and the thing the edge rule must not
    // have broken: one label, many spellings.
    for (const spelling of ['Steuer-ID: #', 'steuer id #', 'STEUERID #', 'Steuer_ID #']) {
      expect(near(spelling, ['Steuer-ID']), spelling).toBe(true);
    }
  });

  it('still refuses a label spelled across the value', () => {
    // The two sides are searched separately, so a label cannot be assembled
    // from the tail before the value and the head after it.
    const text = 'Steu 12345678901 er-ID';
    expect(labelNear(text, 5, 16, { labels: ['Steuer-ID'] })).toBe(false);
  });

  it('accepts the residue it is documented to accept', () => {
    // A word that ENDS in a three-letter label still licenses. Pinned so that
    // the cost stays visible rather than being discovered again later.
    expect(near('Hotel #', ['Tel'])).toBe(true);
  });
});
