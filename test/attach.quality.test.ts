import { describe, expect, it } from 'vitest';
import { assessText } from '../src/attach/quality.js';

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
