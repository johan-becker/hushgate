import { describe, expect, it } from 'vitest';
import { assessText, hidesIdentifiers } from '../src/attach/quality.js';

describe('trusting extracted text', () => {
  it('accepts ordinary prose', () => {
    expect(assessText('Rechnung an Anna Schmidt, Hauptstrasse 4, 88214 Ravensburg.', 1).ok).toBe(true);
  });

  it('rejects the scanned page, which extracts to a form feed and exit code zero', () => {
    const verdict = assessText('\f', 12);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('not a readable document');
  });

  it('rejects a paged document that yielded almost nothing per page', () => {
    const verdict = assessText('Seite 1'.repeat(4), 400);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('per page');
  });

  it('rejects text that was decoded with the wrong encoding', () => {
    const verdict = assessText('�'.repeat(60) + 'Rechnung an Anna Schmidt', 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('replacement character');
  });

  it('rejects fragmented text, because a shredded e-mail address matches nothing', () => {
    // The failure this guards: an extractor that splits on glyph advance
    // widths produces fluent-looking output of the right length whose
    // identifiers no detector can see.
    const shredded = Array.from({ length: 80 }, (_, index) => (index % 3 === 0 ? 'ab' : 'c')).join(' ');
    const verdict = assessText(shredded, 1);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('fragmented');
  });

  it('does not call short prose fragmented, because the sample is too small to tell', () => {
    // Plenty of two-letter words, but far too few runs for the ratio to mean
    // anything. German prose is full of "es", "so", "im", "an".
    expect(assessText('Es ist so, wie es im Brief an sie steht: ja.', 1).ok).toBe(true);
  });

  it('survives a page count an extractor invented', () => {
    expect(() => assessText('Rechnung an Anna Schmidt und Kollegen.', 0)).not.toThrow();
    expect(assessText('Rechnung an Anna Schmidt und Kollegen.', 0).ok).toBe(true);
  });
});

describe('fragmentation across a whole document', () => {
  const prose =
    'Sehr geehrte Damen und Herren, hiermit bestaetigen wir den Eingang Ihrer ' +
    'Unterlagen und melden uns nach Pruefung des Vorgangs erneut bei Ihnen. ' +
    'Mit freundlichen Gruessen, die Sachbearbeitung des Hauses Nordlicht. ';

  it('rejects a document that is shredded throughout', () => {
    expect(assessText([...prose].join(' '), 1).ok).toBe(false);
  });

  it('still accepts a document that is simply prose', () => {
    expect(assessText(prose.repeat(3), 1).ok).toBe(true);
  });

  it('accepts a letter containing a table of short codes', () => {
    // The reason this check is document-wide. A window small enough to catch a
    // shredded address block sits entirely inside this table, and a country
    // code list is an ordinary thing for a business document to contain.
    const table = 'Umsatz nach Land\nDE AT CH FR IT ES NL BE PL CZ\nDK SE NO FI PT IE GR HU RO BG\n';
    expect(assessText(prose + table + prose, 1).ok).toBe(true);
  });

  it('accepts a bibliography, which is mostly initials and abbreviations', () => {
    const bib = 'Meyer, H. u. a. (2019), S. 4 f.\na. a. O., Bd. 3, Nr. 7, S. 12 ff.\n';
    expect(assessText(prose + bib + prose, 1).ok).toBe(true);
  });
});

/** A stand-in detector: the real ones are exercised through the proxy tests. */
const findings = (text: string): number =>
  (text.match(/anna\.schmidt@nordlicht\.example/gu) ?? []).length;

describe('separators that are not whitespace and not invisible', () => {
  it('sees through a braille blank, which is a printing character that renders as a gap', () => {
    // Neither whitespace to a regex nor default-ignorable to Unicode, so
    // nothing upstream strips it — it was the last separator that worked.
    const hidden = [...'anna.schmidt@nordlicht.example'].join('⠀');
    expect(hidesIdentifiers(hidden, findings)).toBe(true);
  });

  it('sees through a Hangul filler', () => {
    const hidden = [...'anna.schmidt@nordlicht.example'].join('ㅤ');
    expect(hidesIdentifiers(hidden, findings)).toBe(true);
  });

  it('leaves a document alone when closing its spacing reveals nothing', () => {
    expect(hidesIdentifiers('DE AT CH FR IT ES NL BE PL CZ', findings)).toBe(false);
  });
});
