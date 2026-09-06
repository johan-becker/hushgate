import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';

/**
 * Kerning shredding: what a PDF extractor does to a letter when it reads the
 * spacing between glyphs as spacing between words.
 *
 * `attach/quality.ts` already refuses a *document* this happened to, on the
 * grounds that its identifiers would not be recognised. This file is about the
 * other half of that sentence — making them recognised — because the same text
 * arrives as a plain request body too, where there is no extractor to refuse.
 *
 * The measurement that decides the shape of the fix: the IBAN detector reads
 * groupings of four characters and up on its own, and nothing below that. So
 * two- and three-character groups are precisely the gap, and they are precisely
 * what shredding produces.
 */
describe('kerning-shredded identifiers', () => {
  const detectors = createDetectors({
    dictionary: { names: ['Anna Schmidt'] },
  });

  const kinds = (text: string): string[] => [...new Set(detect(text, detectors).map((s) => s.kind))];

  it('finds an IBAN whose country code survived as its own group', () => {
    // `DE8` is one digit in three characters, which the half-digits rule throws
    // away — and with it the country code that makes the rest an IBAN rather
    // than a run of numbers. A short all-caps group carrying a digit is the
    // shape of a country or issuer prefix, not of a word.
    expect(kinds('DE8 937 040 044 053 201 300 0')).toContain('IBAN');
  });

  it('does not reach a grouping with no digit in the first group', () => {
    // `DE 89 37 ...` splits the country code off as two bare letters, and
    // letting a digitless group open a chain is what would start pulling
    // ordinary words into the fold. Documented as the boundary rather than
    // chased: real kerning shredding cuts by width, not on the country code.
    expect(kinds('DE 89 37 04 00 44 05 32 01 30 00')).not.toContain('IBAN');
  });

  it('finds the IBAN in a shredded letter', () => {
    const shredded =
      'Sac hbe arb eit eri n: Ann a S chm idt\n' +
      'E-M ail : a nna .sc hmi dt@ nor dli cht .ex amp le\n' +
      'IBA N: DE8 937 040 044 053 201 300 0\n';
    expect(kinds(shredded)).toContain('IBAN');
  });

  it('reports the original characters, spaces included', () => {
    const text = 'IBA N: DE8 937 040 044 053 201 300 0';
    for (const span of detect(text, detectors)) {
      expect(span.value).toBe(text.slice(span.start, span.end));
    }
  });

  // --- what must NOT change -------------------------------------------------
  //
  // The identifier fold is aimed rather than global because a copy that differs
  // from the original is a copy every detector runs over again, on an event
  // loop every tenant shares. These are the shapes that must keep costing one
  // pass, and the reason the rule counts SHORT groups rather than just any
  // short group: an IBAN in conventional four-character groups ends in a
  // two-character remainder, and that alone must not drag it onto a second pass.

  it('still reads a conventionally grouped IBAN', () => {
    expect(kinds('DE89 3704 0044 0532 0130 00')).toContain('IBAN');
  });

  it('does not turn a price into an identifier', () => {
    expect(kinds('Rechnungsbetrag 1.234.567,89 EUR')).not.toContain('IBAN');
    expect(kinds('Total 12,345,678.90 USD')).not.toContain('IBAN');
  });

  it('does not fire on ordinary German business prose', () => {
    const prose =
      'Sehr geehrte Damen und Herren, anbei die Unterlagen zu Vorgang 2026 und ' +
      'der Rechnung über 1.234,50 EUR. Seite 12 von 34. Mit freundlichen Grüßen.';
    expect(kinds(prose)).toEqual([]);
  });

  it('does not invent an IBAN out of a run of short numbers', () => {
    // Nine digits in three-character groups is the shredded shape, but nothing
    // it closes up into is a valid identifier — the checksum is what refuses it,
    // and that is the layer the refusal belongs in.
    expect(kinds('Artikel 123 456 789')).not.toContain('IBAN');
  });
});
