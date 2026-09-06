import { describe, expect, it } from 'vitest';
import {
  createDictionaryDetector,
  withinEditDistanceOne,
  type DictionaryEntry,
} from '../src/detectors/dictionary.js';
import { detect } from '../src/detectors/index.js';
import type { Detector } from '../src/types.js';

/**
 * Near-miss dictionary matching.
 *
 * Everything here goes through `detect()` rather than `detector.find()`, because
 * the shapes that already work — `ProjektNordlicht`, `N o r d l i c h t` — are
 * produced by the central scan copies, not by the detector. A test that called
 * `find()` directly would silently stop covering them.
 */
const found = (text: string, detector: Detector): { kind: string; value: string }[] =>
  detect(text, [detector]).map(({ kind, value }) => ({ kind, value }));

const kinds = (text: string, detector: Detector): string[] =>
  found(text, detector).map(({ kind }) => kind);

const ENTRIES: readonly DictionaryEntry[] = [
  { value: 'Max Mustermann', kind: 'NAME' },
  { value: 'Max Müller', kind: 'NAME' },
  { value: 'Projekt Nordlicht', kind: 'TERM' },
  { value: 'Nordlicht', kind: 'TERM' },
];

const strict = createDictionaryDetector(ENTRIES);
const fuzzy = createDictionaryDetector(ENTRIES, { fuzzy: true });
const variantsOnly = createDictionaryDetector(ENTRIES, { fuzzy: true, maxEditDistance: 0 });

describe('dictionary: shapes that already worked keep working', () => {
  // These are the central scan copies' doing, not the dictionary's. They are
  // here so that a change to the fuzzy pass that shadows or double-reports them
  // fails loudly instead of quietly changing the finding count.
  const cases: readonly [string, string, string][] = [
    ['exact', 'Max Mustermann', 'NAME'],
    ['all lower', 'max mustermann', 'NAME'],
    ['all upper', 'MAX MUSTERMANN', 'NAME'],
    ['mixed case', 'MaX mUsTeRmAnN', 'NAME'],
    ['camelCase term', 'ProjektNordlicht', 'TERM'],
    ['spaced out', 'N o r d l i c h t', 'TERM'],
  ];

  it.each(cases)('%s matches with fuzzy off', (_label, text, kind) => {
    expect(found(text, strict)).toEqual([{ kind, value: text }]);
  });

  it.each(cases)('%s still matches exactly once with fuzzy on', (_label, text, kind) => {
    expect(found(text, fuzzy)).toEqual([{ kind, value: text }]);
  });

  it('still prefers the longest entry at an offset', () => {
    expect(found('Projekt Nordlicht startet', fuzzy)).toEqual([
      { kind: 'TERM', value: 'Projekt Nordlicht' },
    ]);
  });
});

describe('dictionary: near misses (opt-in)', () => {
  const cases: readonly [string, string, string][] = [
    ['a dropped letter in the surname', 'Max Musterman', 'NAME'],
    ['a doubled letter in the surname', 'Max Mustermannn', 'NAME'],
    ['a dropped letter in a one-word term', 'Nordlich', 'TERM'],
    ['a transposition', 'Max Mustermnan', 'NAME'],
    ['surname-first order', 'Mustermann, Max', 'NAME'],
    ['the given name as an initial', 'M. Mustermann', 'NAME'],
    ['surname first with an initial', 'Mustermann, M.', 'NAME'],
    ['an umlaut written as a digraph', 'Max Mueller', 'NAME'],
    ['a hyphen where the entry has a space', 'Max-Mustermann', 'NAME'],
  ];

  it.each(cases)('finds %s', (_label, text, kind) => {
    expect(kinds(text, fuzzy)).toContain(kind);
  });

  it.each(cases)('reports nothing for %s when fuzzy is off', (_label, text) => {
    expect(found(text, strict)).toEqual([]);
  });

  it('matches a digraph entry written with the umlaut, the other way round', () => {
    const detector = createDictionaryDetector([{ value: 'Max Mueller', kind: 'NAME' }], {
      fuzzy: true,
    });
    expect(kinds('Max Müller', detector)).toContain('NAME');
  });

  it('keeps the span pointing at the original characters', () => {
    const text = 'Bitte an Mustermann, Max weiterleiten, cc M. Mustermann.';
    for (const span of detect(text, [fuzzy])) {
      expect(span.value).toBe(text.slice(span.start, span.end));
    }
    expect(kinds(text, fuzzy)).toEqual(['NAME', 'NAME']);
  });
});

describe('dictionary: what the near-miss pass must NOT do', () => {
  /**
   * Real German words that sit one edit from a plausible dictionary entry.
   * Every pair here is two words a German speaker uses in the same document:
   * Leiter/leider, Rechner/rechnen, Wetter/wetten, Fahrer/fahren. If the fuzzy
   * pass fires on the right-hand side, the operator turns the detector off and
   * the dictionary protects nobody.
   */
  const noisy = createDictionaryDetector(
    [
      { value: 'Leiter', kind: 'TERM' },
      { value: 'Rechner', kind: 'TERM' },
      { value: 'Wetter', kind: 'TERM' },
      { value: 'Fahrer', kind: 'TERM' },
      { value: 'Meier', kind: 'NAME' },
    ],
    { fuzzy: true },
  );

  it.each([['leider'], ['rechnen'], ['wetten'], ['fahren']])(
    'does not fire on the ordinary German word %s',
    (word) => {
      expect(found(word, noisy)).toEqual([]);
    },
  );

  it('does not fire on those words inside a sentence either', () => {
    const text = 'Wir wollen leider nicht rechnen, sondern fahren und wetten.';
    expect(found(text, noisy)).toEqual([]);
  });

  it('still reports the entries themselves, stop list or not', () => {
    expect(found('Leiter', noisy)).toEqual([{ kind: 'TERM', value: 'Leiter' }]);
    expect(found('Das Wetter', noisy)).toEqual([{ kind: 'TERM', value: 'Wetter' }]);
  });

  it('still reports a typo that is not itself a word', () => {
    expect(kinds('Leiterr', noisy)).toContain('TERM');
    expect(kinds('Rechnerr', noisy)).toContain('TERM');
  });

  it('leaves entries shorter than six characters exact-only', () => {
    // Meier/Meyer is one edit apart and they are two different families.
    expect(found('Meyer', noisy)).toEqual([]);
    expect(found('Meier', noisy)).toEqual([{ kind: 'NAME', value: 'Meier' }]);
  });

  it('does not reach two edits', () => {
    expect(found('Nordlichter', fuzzy)).toEqual([]);
    expect(found('Max Mustrmnn', fuzzy)).toEqual([]);
  });

  it('does not match a surname on its own', () => {
    expect(found('Mustermann kommt', fuzzy)).toEqual([]);
  });

  it('does not join two tokens across a sentence boundary', () => {
    // `Max.` ends a sentence; `Mustermann` starts the next one. A dot may only
    // close an initial, never a whole given name.
    expect(found('Danke Max. Mustermann meldet sich.', fuzzy)).toEqual([]);
  });

  it('keeps whole-word matching', () => {
    expect(found('SuperMustermann', fuzzy)).toEqual([]);
  });
});

describe('dictionary: maxEditDistance 0 keeps the deterministic variants only', () => {
  it('still reorders and abbreviates names', () => {
    expect(kinds('Mustermann, Max', variantsOnly)).toContain('NAME');
    expect(kinds('M. Mustermann', variantsOnly)).toContain('NAME');
    expect(kinds('Max Mueller', variantsOnly)).toContain('NAME');
  });

  it('reports no typo at all', () => {
    expect(found('Max Musterman', variantsOnly)).toEqual([]);
    expect(found('Nordlich', variantsOnly)).toEqual([]);
  });
});

describe('withinEditDistanceOne', () => {
  it('accepts the four single-edit shapes and identity', () => {
    expect(withinEditDistanceOne('nordlicht', 'nordlicht')).toBe(true);
    expect(withinEditDistanceOne('nordlicht', 'nordlich')).toBe(true);
    expect(withinEditDistanceOne('nordlicht', 'nordlichtt')).toBe(true);
    expect(withinEditDistanceOne('nordlicht', 'nordlichr')).toBe(true);
    expect(withinEditDistanceOne('nordlicht', 'nordilcht')).toBe(true);
  });

  it('rejects two edits and any length gap above one', () => {
    expect(withinEditDistanceOne('nordlicht', 'nordlichter')).toBe(false);
    expect(withinEditDistanceOne('nordlicht', 'nrodilcht')).toBe(false);
    expect(withinEditDistanceOne('nordlicht', 'nordlucnt')).toBe(false);
    expect(withinEditDistanceOne('abc', 'xyz')).toBe(false);
  });
});
