import { describe, expect, it } from 'vitest';
import { createDetectors, detect } from '../src/detectors/index.js';
import {
  findMrzBlocks,
  isValidMrzBlock,
  isValidTd1,
  isValidTd2Lower,
  isValidTd3Lower,
  mrzDetector,
} from '../src/detectors/mrz.js';
import { DEFAULT_PRIORITIES, type Span } from '../src/types.js';

/**
 * Every vector here is either an ICAO Doc 9303 Appendix A specimen or built
 * from the published Erika Mustermann specimen serial and the standard Muster
 * dates. No value belongs to a real person.
 */

/** ICAO Doc 9303-3 Appendix A Example 3 — official TD3 lower line. */
const TD3_LOWER = 'HA672242<6YTO5802254M9601086<<<<<<<<<<<<<<08';
/** ICAO Doc 9303-3 Appendix A Example 5 — official TD2 lower line. */
const TD2_LOWER = 'HA672242<6YTO5802254M9601086<<<<<<<8';
/** ICAO Doc 9303-3 Appendix A Example 4 — official TD1 upper + middle lines. */
const TD1_UPPER = 'I<YTOD231458907<<<<<<<<<<<<<<<';
const TD1_MIDDLE = '3407127M9507122YTO<<<<<<<<<<<2';

/** Synthetic German TD1 (Personalausweis layout). */
const DE_TD1 = [
  'IDD<<T220001293<<<<<<<<<<<<<<<',
  '6408125F3103315D<<2108<<<<<<<5',
  'MUSTERMANN<<ERIKA<<<<<<<<<<<<<',
] as const;

/** Synthetic German TD3 (Reisepass layout). */
const DE_TD3 = [
  'P<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<',
  'C01X00T478D<<6408125F31033152108<<<<<<<<<<38',
] as const;

const values = (text: string): string[] => mrzDetector.find(text).map((span: Span) => span.value);

describe('ICAO check-digit chain', () => {
  it('accepts the official TD3 lower line', () => {
    expect(isValidTd3Lower(TD3_LOWER)).toBe(true);
  });

  it('accepts the official TD2 lower line', () => {
    expect(isValidTd2Lower(TD2_LOWER)).toBe(true);
  });

  it('accepts the official TD1 upper + middle pair', () => {
    expect(isValidTd1(TD1_UPPER, TD1_MIDDLE)).toBe(true);
  });

  it('accepts the synthetic German TD1 and TD3', () => {
    expect(isValidTd1(DE_TD1[0], DE_TD1[1])).toBe(true);
    expect(isValidTd3Lower(DE_TD3[1])).toBe(true);
  });

  const rejected = [
    [
      'HA672242<6YTO5803254M9601086<<<<<<<<<<<<<<08',
      'one character corrupted (5802 -> 5803): the birth digit AND the composite fail',
    ],
    [
      'ZXKQ7RM4TP2WNVCJ5HGB8YDFA3SLE6UZXKQ7RM4TQQQQ',
      '44-character blob — shape matches, every check digit fails',
    ],
    [
      'HA672242<6YTO5802254M9601086<<<<<<<<<<<<<<0',
      '43 characters: a truncated line is rejected, never padded',
    ],
    [
      'XX672242<6YTO5802254M9601086<<<<<<<<<<<<<<08',
      'XX is not a document number that checks out against digit 6',
    ],
    [
      'HA672242<6YTO5802254M9601086<<<<<<<<<<<<<<07',
      'every field digit passes, only the composite is wrong — the forged case',
    ],
    ['ha672242<6yto5802254m9601086<<<<<<<<<<<<<<08', 'lowercase is not the MRZ alphabet'],
  ] as const;

  it.each(rejected)('rejects %s (%s)', (line) => {
    expect(isValidTd3Lower(line)).toBe(false);
    expect(isValidMrzBlock(line)).toBe(false);
    expect(findMrzBlocks(line)).toEqual([]);
  });

  it('rejects a TD1 whose composite alone is wrong', () => {
    // Optional data 2 is covered by the composite and by nothing else, so a
    // change there leaves every field digit intact. That is exactly the
    // garbled-or-forged block the composite exists to catch.
    const middle = '6408125F3103315D<<2109<<<<<<<5';
    expect(isValidTd1(DE_TD1[0], middle)).toBe(false);
    // The individual digits it does not disturb still pass, which is the point.
    expect(isValidTd1(DE_TD1[0], DE_TD1[1])).toBe(true);
  });

  it('accepts filler in place of the TD3 optional-data check digit', () => {
    // ICAO permits '<' or '0' at position 43 when the field is all filler.
    const filler = 'HA672242<6YTO5802254M9601086<<<<<<<<<<<<<<<8';
    expect(isValidTd3Lower(filler)).toBe(true);
  });

  it('accepts a TD1 whose document number overflows into optional data 1', () => {
    // Position 15 is the filler '<', so the number and its check digit live in
    // optional data 1. The document-number check is skipped; birth, expiry and
    // the composite still run and still gate acceptance.
    const upper = 'I<UTOD23145890<7349<<<<<<<<<<<';
    const middle = '3407127M9507122UTO<<<<<<<<<<<2';
    expect(upper[14]).toBe('<');
    expect(isValidTd1(upper, middle)).toBe(true);
  });

  const plausibility = [
    ['HA672242<6YTO5813254M9601086<<<<<<<<<<<<<<08', 'month 13 in the date of birth'],
    ['HA672242<6YT05802254M9601086<<<<<<<<<<<<<<08', 'a digit inside the issuing-state code'],
    ['HA672242<6YTO5802254X9601086<<<<<<<<<<<<<<08', 'sex field outside {M, F, <}'],
  ] as const;

  it.each(plausibility)('rejects %s (%s)', (line) => {
    expect(isValidTd3Lower(line)).toBe(false);
  });
});

describe('isValidMrzBlock', () => {
  it('accepts a lone lower line of either two-line format', () => {
    expect(isValidMrzBlock(TD3_LOWER)).toBe(true);
    expect(isValidMrzBlock(TD2_LOWER)).toBe(true);
  });

  it('accepts the multi-line blocks', () => {
    expect(isValidMrzBlock(`${TD1_UPPER}\n${TD1_MIDDLE}`)).toBe(true);
    expect(isValidMrzBlock(DE_TD1.join('\n'))).toBe(true);
    expect(isValidMrzBlock(DE_TD3.join('\n'))).toBe(true);
  });

  it('accepts CRLF, indentation, trailing spaces and one blank line between rows', () => {
    expect(isValidMrzBlock(`${DE_TD3[0]}\r\n${DE_TD3[1]}`)).toBe(true);
    expect(isValidMrzBlock(`\n  ${DE_TD3[0]}   \n\n\t${DE_TD3[1]}  \n\n`)).toBe(true);
  });

  it('rejects two blank lines between rows', () => {
    expect(isValidMrzBlock(`${DE_TD3[0]}\n\n\n${DE_TD3[1]}`)).toBe(false);
  });

  it('never accepts a lone TD1 line — its composite spans two lines', () => {
    expect(isValidMrzBlock(TD1_UPPER)).toBe(false);
    expect(isValidMrzBlock(TD1_MIDDLE)).toBe(false);
    expect(isValidMrzBlock(DE_TD1[0])).toBe(false);
    expect(isValidMrzBlock(DE_TD1[1])).toBe(false);
  });

  it('rejects a two-line form whose upper line is not a document code', () => {
    // The lower line is the official Example 3; only the name line is wrong.
    const upper = 'Z<D<<MUSTERMANN<<ERIKA<<<<<<<<<<<<<<<<<<<<<<';
    expect(isValidMrzBlock(`${upper}\n${TD3_LOWER}`)).toBe(false);
  });

  it('rejects mixed widths and a fourth line', () => {
    expect(isValidMrzBlock(`${TD1_UPPER}\n${TD3_LOWER}`)).toBe(false);
    expect(isValidMrzBlock(`${DE_TD1.join('\n')}\n${DE_TD1[2]}`)).toBe(false);
  });

  it('rejects empty and non-MRZ input', () => {
    expect(isValidMrzBlock('')).toBe(false);
    expect(isValidMrzBlock('   \n  \n')).toBe(false);
    expect(isValidMrzBlock('Bitte prüfen Sie den Reisepass.')).toBe(false);
  });
});

describe('findMrzBlocks span extent', () => {
  it('emits the whole block, newlines included, as one span', () => {
    const text = `Scan:\n${DE_TD1.join('\n')}\nDanke.`;
    const blocks = findMrzBlocks(text);
    expect(blocks[0]).toMatchObject({ format: 'TD1', lineCount: 3 });
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe(DE_TD1.join('\n'));
  });

  it('keeps the CRLF inside the span but the trailing CR out of the end', () => {
    const block = `${DE_TD3[0]}\r\n${DE_TD3[1]}`;
    const text = `Anbei:\r\n${block}\r\nMfG`;
    const [span] = mrzDetector.find(text);
    expect(span!.value).toBe(block);
    expect(span!.value.endsWith('\r')).toBe(false);
    expect(span!.value).toContain('\r\n');
  });

  it('excludes indentation and trailing whitespace from the span', () => {
    const text = `    ${DE_TD3[0]}  \n    ${DE_TD3[1]}   \n`;
    const [span] = mrzDetector.find(text);
    expect(span!.start).toBe(4);
    expect(span!.value).toBe(`${DE_TD3[0]}  \n    ${DE_TD3[1]}`);
    expect(span!.value.endsWith('8')).toBe(true);
  });

  it('spans one blank line between rows, as a text extractor produces', () => {
    const text = `${DE_TD1[0]}\n\n${DE_TD1[1]}\n\n${DE_TD1[2]}`;
    const blocks = findMrzBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ format: 'TD1', lineCount: 3 });
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe(text);
  });

  it('breaks the block at two blank lines', () => {
    // TD1 is lost entirely: nothing in one of its lines is verifiable alone.
    expect(findMrzBlocks(`${DE_TD1[0]}\n\n\n${DE_TD1[1]}`)).toEqual([]);
    // The two-line forms degrade to their lower line, which carries all its own
    // check digits — a leak avoided at the cost of the name line.
    expect(values(`${DE_TD3[0]}\n\n\n${DE_TD3[1]}`)).toEqual([DE_TD3[1]]);
  });

  it('breaks the block at an intervening line of prose', () => {
    expect(findMrzBlocks(`${DE_TD1[0]}\nSeite 2\n${DE_TD1[1]}`)).toEqual([]);
  });

  it('returns the containing block and the lone lower line as two candidates', () => {
    // Detectors return candidates; resolution is central. The redundant
    // lone-line candidate is what makes a clipped paste degrade gracefully.
    const text = DE_TD3.join('\n');
    expect(values(text)).toEqual([text, DE_TD3[1]]);
    expect(detect(text, [mrzDetector]).map((span) => span.value)).toEqual([text]);
  });

  it('reports two documents pasted back to back separately', () => {
    const text = `${DE_TD1.join('\n')}\n${DE_TD1.join('\n')}`;
    const blocks = findMrzBlocks(text);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.lineCount)).toEqual([3, 3]);
  });

  it('does not swallow the next card as a name line when the first was clipped', () => {
    const text = `${TD1_UPPER}\n${TD1_MIDDLE}\n${DE_TD1[0]}\n${DE_TD1[1]}\n${DE_TD1[2]}`;
    const blocks = findMrzBlocks(text);
    expect(blocks.map((block) => block.lineCount)).toEqual([2, 3]);
  });

  it('finds a block that starts one line after a shape-matching decoy', () => {
    const decoy = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ<<<<';
    const text = `${decoy}\n${DE_TD1.join('\n')}`;
    const blocks = findMrzBlocks(text);
    expect(blocks).toHaveLength(1);
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe(DE_TD1.join('\n'));
  });
});

describe('mrzDetector', () => {
  it('is registered as travel-document-mrz directly below SECRET', () => {
    expect(mrzDetector.name).toBe('travel-document-mrz');
    // Written against the table rather than the literal: what the detector
    // needs is to outrank everything but SECRET, and a renumbering that keeps
    // that true should not have to touch this file.
    expect(mrzDetector.priority).toBe(DEFAULT_PRIORITIES.TRAVEL_DOCUMENT_MRZ);
    expect(mrzDetector.priority).toBeLessThan(DEFAULT_PRIORITIES.SECRET);
    const others = Object.entries(DEFAULT_PRIORITIES).filter(
      ([kind]) => kind !== 'SECRET' && kind !== 'TRAVEL_DOCUMENT_MRZ',
    );
    for (const [, priority] of others) {
      expect(priority).toBeLessThan(mrzDetector.priority);
    }
  });

  it('reports TRAVEL_DOCUMENT_MRZ with value === text.slice(start, end)', () => {
    const text = `Reisepass:\n${TD3_LOWER}\n`;
    const [span] = mrzDetector.find(text);
    expect(span!.kind).toBe('TRAVEL_DOCUMENT_MRZ');
    expect(span!.detector).toBe('travel-document-mrz');
    expect(span!.value).toBe(text.slice(span!.start, span!.end));
    expect(span!.value).toBe(TD3_LOWER);
  });

  it('finds a block embedded in ordinary German prose', () => {
    const text = [
      'Guten Tag,',
      'anbei der Scan des Ausweises meiner Kollegin:',
      '',
      ...DE_TD1,
      '',
      'Bitte um Prüfung.',
    ].join('\n');
    expect(values(text)).toEqual([DE_TD1.join('\n')]);
  });

  it('reports nothing for text with no MRZ in it', () => {
    expect(values('')).toEqual([]);
    expect(values('Kein Ausweis, nur Text.')).toEqual([]);
    expect(values('ZXKQ7RM4TP2WNVCJ5HGB8YDFA3SLE6UZXKQ7RM4TQQQQ')).toEqual([]);
    expect(values('SGVsbG8gV29ybGQgdGhpcyBpcyBub3QgYW4gTVJaIGF0IGFsbA==')).toEqual([]);
  });

  it('outranks every candidate that would otherwise carve up the block', () => {
    const block = DE_TD3.join('\n');
    const detectors = [mrzDetector, ...createDetectors({ dictionary: { names: ['Mustermann'] } })];
    const found = detect(`Scan:\n${block}\n`, detectors);
    expect(found.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'TRAVEL_DOCUMENT_MRZ', value: block },
    ]);
  });

  it('stays cheap over a body at the proxy limit', () => {
    // The width test rejects almost every line with one integer comparison,
    // which is the only reason this is affordable on every outbound request.
    const filler = `${'Sehr geehrte Damen und Herren, hier steht ganz normaler Text.'}\n`;
    const body = filler.repeat(Math.ceil((4 * 1024 * 1024) / filler.length));
    const text = `${body}${DE_TD3.join('\n')}\n${body}`;
    const started = performance.now();
    const blocks = findMrzBlocks(text);
    const elapsed = performance.now() - started;
    expect(blocks).toHaveLength(2);
    expect(elapsed).toBeLessThan(2000);
  });
});
