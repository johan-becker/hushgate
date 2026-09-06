/**
 * Handelsregisternummer — `HRB 123456`.
 *
 * The one German identifier in this batch that needs no label, because it
 * carries its own: `HRA` and `HRB` are the two sections of the Handelsregister
 * (A for Personengesellschaften, B for Kapitalgesellschaften), and a company
 * writes them in front of the number every time. The prefix at a word boundary
 * followed by a register-sized number is the whole signal, and it is a strong
 * one — neither string occurs before digits in ordinary German prose.
 *
 * Only those two sections are recognised. The sibling registers — `VR`, `GnR`,
 * `PR` — share the shape but not the strength: `VR 1234` is also a version, a
 * variant and a room number, and a detector that reports those is one the
 * customer switches off, taking the Handelsregister with it.
 */
import type { Detector, Span } from '../types.js';
import { isScanSeparator } from './normalise.js';
import { isDigit, isWordChar, memberAt } from './util.js';

/**
 * Priority for `COMMERCIAL_REGISTER_ID`, pending an entry in
 * `DEFAULT_PRIORITIES`.
 *
 * Nothing else claims a run that opens with `HRA`/`HRB`, so this rank only ever
 * settles a tie that does not arise in practice; it sits below the identifiers
 * that verify a check digit for the same reason they outrank each other.
 */
export const COMMERCIAL_REGISTER_PRIORITY = 76;

/**
 * The longest register number an Amtsgericht issues.
 *
 * Six digits covers every court including Berlin-Charlottenburg, which holds
 * the largest register in the country. Seven digits in a row is therefore not a
 * register number that has been mis-parsed, it is a different number that
 * happens to sit behind the prefix — and reporting it would put the wrong
 * characters in the placeholder.
 */
const MAX_DIGITS = 6;

const REGISTER_PREFIX = /hr[ab]/giu;
const PREFIX_LENGTH = 3;

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

/**
 * Handelsregister detector.
 *
 * The number is collected as a *contiguous* digit run rather than across
 * separators: register numbers are never printed in groups, so tolerating a
 * separator inside would only ever glue the next number in the sentence on and
 * push the result past `MAX_DIGITS`.
 */
export const commercialRegisterDetector: Detector = {
  name: 'commercial-register',
  priority: COMMERCIAL_REGISTER_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    const anchor = new RegExp(REGISTER_PREFIX.source, REGISTER_PREFIX.flags);
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(text)) !== null) {
      const start = match.index;
      if (isWordChar(text, start - 1)) continue;

      let i = start + PREFIX_LENGTH;
      // `HRB 123456` and `HRB-123456` put one separator between the section and
      // the number; `HRB123456` puts none.
      if (memberAt(text, i, isScanSeparator) && memberAt(text, i + 1, isDigit)) i += 1;
      if (!memberAt(text, i, isDigit)) continue;

      const digitsFrom = i;
      while (memberAt(text, i, isDigit) && i - digitsFrom < MAX_DIGITS) i += 1;
      if (memberAt(text, i, isDigit)) continue;

      const end = withBranchLetter(text, i);
      out.push({
        start,
        end,
        kind: 'COMMERCIAL_REGISTER_ID',
        value: text.slice(start, end),
        detector: 'commercial-register',
        priority: COMMERCIAL_REGISTER_PRIORITY,
      });

      anchor.lastIndex = end;
    }

    return out;
  },
};

/**
 * Extend the span over a trailing Zweigstellen letter, if there is one.
 *
 * `HRB 123456 B` is how Berlin distinguishes its two registers, and the letter
 * is part of the identifier — dropping it would rehydrate a placeholder into a
 * number that points at the wrong register. It is only taken when it stands
 * alone, so `HRB 123456 Berlin` keeps the city out of the span: a single letter
 * against a word boundary is a Zweigstelle, the first letter of a word is not.
 */
function withBranchLetter(text: string, end: number): number {
  const at = memberAt(text, end, isScanSeparator) ? end + 1 : end;
  if (!memberAt(text, at, isAsciiLetter) || isWordChar(text, at + 1)) return end;
  return at + 1;
}
