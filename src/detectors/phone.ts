import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { isDigit, isWordChar, memberAt } from './util.js';

/** '00' + 15 digits is the longest thing E.164 can produce. */
const MAX_DIGITS = 17;
const MIN_NATIONAL_DIGITS = 6;
const MAX_NATIONAL_DIGITS = 13;
const MIN_SUBSCRIBER_DIGITS = 8;
const MAX_SUBSCRIBER_DIGITS = 15;

/**
 * Separators German writers actually use. `.` is deliberately absent: allowing
 * it would make `01.02.1990` a phone number and steal the span from the
 * date-of-birth detector.
 */
const isSeparator = (ch: string): boolean =>
  ch === ' ' || ch === '-' || ch === '/' || ch === '(' || ch === ')';

export type PhoneForm = 'e164' | 'international-00' | 'german-national';

export interface PhoneClassification {
  readonly form: PhoneForm;
  /** Digits only, with the trunk-prefix `(0)` removed. */
  readonly digits: string;
}

/**
 * Decide whether a normalised digit string is a plausible phone number, and in
 * which notation it was written.
 */
export function classifyPhone(raw: string): PhoneClassification | null {
  const withoutTrunk = raw.replaceAll('(0)', '');
  const plus = withoutTrunk.trimStart().startsWith('+');
  const digits = withoutTrunk.replaceAll(/\D/gu, '');

  if (plus) {
    const ok =
      digits.length >= MIN_SUBSCRIBER_DIGITS &&
      digits.length <= MAX_SUBSCRIBER_DIGITS &&
      !digits.startsWith('0');
    return ok ? { form: 'e164', digits } : null;
  }

  if (digits.startsWith('00')) {
    const subscriber = digits.slice(2);
    const ok =
      subscriber.length >= MIN_SUBSCRIBER_DIGITS &&
      subscriber.length <= MAX_SUBSCRIBER_DIGITS &&
      !subscriber.startsWith('0');
    return ok ? { form: 'international-00', digits } : null;
  }

  if (digits.startsWith('0')) {
    const ok =
      digits.length >= MIN_NATIONAL_DIGITS &&
      digits.length <= MAX_NATIONAL_DIGITS &&
      digits[1] !== '0';
    return ok ? { form: 'german-national', digits } : null;
  }

  return null;
}

interface PhoneRun {
  readonly raw: string;
  readonly end: number;
  readonly digitCount: number;
}

/**
 * Collect a phone-shaped run starting at `start`.
 *
 * Single separators are allowed between digits; a two-character separator run
 * is allowed only when it contains a parenthesis, which is what makes
 * `+49 (0) 721 123456` work without also gluing two numbers separated by a
 * double space into one.
 */
function collectPhoneRun(text: string, start: number): PhoneRun {
  let i = start;
  let raw = '';
  let digitCount = 0;
  let end = start;

  if (text[i] === '+') {
    raw += '+';
    i += 1;
    end = i;
  }

  while (i < text.length && digitCount < MAX_DIGITS) {
    const ch = text[i];
    if (ch === undefined) break;

    if (isDigit(ch)) {
      raw += ch;
      digitCount += 1;
      i += 1;
      end = i;
      continue;
    }

    if (!isSeparator(ch) || digitCount === 0) break;

    let run = '';
    let j = i;
    while (j < text.length && run.length < 2 && isSeparator(text[j] as string)) {
      run += text[j];
      j += 1;
    }

    const next = text[j];
    const acceptable =
      next !== undefined &&
      isDigit(next) &&
      (run.length === 1 || run.includes('(') || run.includes(')'));

    if (!acceptable) break;

    raw += run;
    i = j;
  }

  return { raw, end, digitCount };
}

/**
 * Phone number detector: E.164 (`+49…`), the `0049…` international prefix and
 * German national notation with spaces, slashes, hyphens and `(0)`.
 */
export const phoneDetector: Detector = {
  name: 'phone',
  priority: DEFAULT_PRIORITIES.PHONE,

  find(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      const ch = text[i];
      const starts = ch === '+' || ch === '0';

      if (!starts || isWordChar(text, i - 1) || text[i - 1] === '+') {
        i += 1;
        continue;
      }

      const run = collectPhoneRun(text, i);
      // The run was truncated at MAX_DIGITS and more digits follow: not a number.
      if (run.digitCount === 0 || memberAt(text, run.end, isDigit)) {
        i += 1;
        continue;
      }

      const classification = classifyPhone(run.raw);
      if (classification === null) {
        i += 1;
        continue;
      }

      out.push({
        start: i,
        end: run.end,
        kind: 'PHONE',
        value: text.slice(i, run.end),
        detector: 'phone',
        priority: DEFAULT_PRIORITIES.PHONE,
      });
      i = run.end;
    }

    return out;
  },
};
