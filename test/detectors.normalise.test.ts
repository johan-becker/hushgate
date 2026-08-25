import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';
import { normaliseForScan } from '../src/detectors/normalise.js';
import { Session } from '../src/redact/session.js';

// Every non-ASCII character in this file is written as an escape. The whole
// point of the code under test is that these spellings are indistinguishable
// on screen, so a reviewer has to be able to see which one a case means.

/** What the offset map promises: a normalised span slices the original back. */
const back = (original: string, start: number, end: number): string => {
  const { offsets } = normaliseForScan(original);
  return original.slice(offsets[start] as number, offsets[end] as number);
};

describe('normaliseForScan', () => {
  it('is a no-op on plain ASCII', () => {
    const norm = normaliseForScan('Write to johan@example.com by 01.02.1990.');
    expect(norm.changed).toBe(false);
    expect(norm.text).toBe('Write to johan@example.com by 01.02.1990.');
    // The identity map is still there for anyone who asks, sentinel included.
    expect([...norm.offsets]).toHaveLength(norm.text.length + 1);
    expect(norm.offsets[9]).toBe(9);
  });

  it('is a no-op on non-ASCII text that is already composed and visible', () => {
    expect(normaliseForScan('Zo\u00EB schrieb aus M\u00FCnchen.').changed).toBe(false);
  });

  it('drops a zero-width separator and points the map past it', () => {
    const norm = normaliseForScan('a\u200Bb');
    expect(norm.text).toBe('ab');
    expect(norm.changed).toBe(true);
    expect([...norm.offsets]).toEqual([0, 2, 3]);
  });

  it.each([
    ['\u200C', 'zero-width non-joiner'],
    ['\u200D', 'zero-width joiner'],
    ['\u2060', 'word joiner'],
    ['\uFEFF', 'byte-order mark'],
    ['\u00AD', 'soft hyphen'],
    ['\u202E', 'right-to-left override'],
    ['\uFE0F', 'variation selector'],
  ])('drops the %s (%s)', (invisible) => {
    expect(normaliseForScan(`a${invisible}b`).text).toBe('ab');
  });

  it('composes a decomposed umlaut into one unit spanning both sources', () => {
    const norm = normaliseForScan('Ma\u0308dchen');
    expect(norm.text).toBe('M\u00E4dchen');
    // 'M' at 0, then the cluster 'a' + U+0308 occupying [1,3), then 'd' at 3.
    expect([...norm.offsets]).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
    expect(back('Ma\u0308dchen', 0, 2)).toBe('Ma\u0308');
  });

  it('composes across a separator planted between base and mark', () => {
    expect(normaliseForScan('Ma\u200B\u0308dchen').text).toBe('M\u00E4dchen');
  });

  it('folds full-width letters', () => {
    const norm = normaliseForScan('\uFF41\uFF4E\uFF4E\uFF41');
    expect(norm.text).toBe('anna');
    expect([...norm.offsets]).toEqual([0, 1, 2, 3, 4]);
  });

  it('points every unit of an expansion at the one source character', () => {
    // U+FB01 is the fi ligature: one source unit, two normalised units.
    const norm = normaliseForScan('\uFB01x');
    expect(norm.text).toBe('fix');
    expect([...norm.offsets]).toEqual([0, 0, 1, 2]);
    // A span cutting the expansion in half has no original range to point at.
    expect(back('\uFB01x', 0, 1)).toBe('');
    expect(back('\uFB01x', 0, 2)).toBe('\uFB01');
  });

  it('keeps the map exact across a surrogate pair', () => {
    const original = '\u{1F600}Ma\u0308dchen';
    expect(normaliseForScan(original).text).toBe('\u{1F600}M\u00E4dchen');
    // The emoji is two units, so the composed umlaut sits at normalised index 3.
    expect(back(original, 3, 4)).toBe('a\u0308');
    expect(back(original, 0, 2)).toBe('\u{1F600}');
  });

  it('round-trips every normalised index back onto the original', () => {
    const original = 'DE89\u200B3704 Ma\u0308dchen \uFF41\uFF4E\uFF4E\uFF41';
    const norm = normaliseForScan(original);
    expect(norm.offsets).toHaveLength(norm.text.length + 1);
    // The map is monotone and never leaves the original.
    for (let i = 0; i < norm.offsets.length; i += 1) {
      expect(norm.offsets[i]).toBeGreaterThanOrEqual(norm.offsets[i - 1] ?? 0);
      expect(norm.offsets[i]).toBeLessThanOrEqual(original.length);
    }
    expect(back(original, 0, norm.text.length)).toBe(original);
  });
});

describe('detect over the normalised copy', () => {
  const detectors = createDetectors();

  it('reports a value once when both passes see it', () => {
    const spans = detect('x\u200By johan@example.com', detectors);
    expect(spans.map((s) => s.value)).toEqual(['johan@example.com']);
  });

  it('leaves ASCII results exactly as they were', () => {
    const text = 'johan@example.com and DE89370400440532013000';
    expect(detect(text, detectors).map((s) => s.kind)).toEqual(['EMAIL', 'IBAN']);
  });
});

/** One session per case, so no case sees a placeholder another one minted. */
const session = (): Session => new Session({ dictionary: { names: ['M\u00E4dchen Mueller'] } });

describe('unicode evasion through a Session', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['zero-width inside an e-mail', 'anna.s\u200Bchmidt@acme.example', 'EMAIL'],
    ['full-width letters', '\uFF41\uFF4E\uFF4E\uFF41@acme.example', 'EMAIL'],
    ['zero-width separated IBAN', 'DE89\u200B3704\u200B0044\u200B0532\u200B0130\u200B00', 'IBAN'],
    ['NFD umlaut against an NFC dictionary entry', 'Ma\u0308dchen Mueller', 'NAME'],
  ];

  it.each(cases)('finds the %s spelling', (_label, text, kind) => {
    expect(session().redact(text).findings.map((f) => f.kind)).toEqual([kind]);
  });

  it.each(cases)('does not forward the %s spelling', (_label, text) => {
    const result = session().redact(text);
    expect(result.text).not.toContain(text);
    expect(result.text).toMatch(/^\[[A-Z_]+_\d+\]$/u);
  });

  it.each(cases)('rehydrates the %s spelling byte-identically', (_label, text) => {
    const active = session();
    expect(active.restore(active.redact(text).text)).toBe(text);
  });

  it('rehydrates a body carrying all four spellings byte-identically', () => {
    const text = [
      'Von: anna.s\u200Bchmidt@acme.example',
      'CC: \uFF41\uFF4E\uFF4E\uFF41@acme.example',
      'IBAN: DE89\u200B3704\u200B0044\u200B0532\u200B0130\u200B00',
      'Kundin: Ma\u0308dchen Mueller',
    ].join('\n');

    const active = session();
    const result = active.redact(text);

    expect(result.findings.map((f) => f.kind)).toEqual(['EMAIL', 'EMAIL', 'IBAN', 'NAME']);
    // The invariant the whole mechanism rests on: a translated span's value is
    // the original substring, separators and all, not the normalised one.
    for (const finding of result.findings) {
      expect(finding.value).toBe(text.slice(finding.start, finding.end));
    }
    expect(result.text).not.toContain('acme.example');
    expect(active.restore(result.text)).toBe(text);
  });
});
