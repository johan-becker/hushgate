import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

/** Inclusive range of years that count as a plausible birth year. */
export interface DobYearRange {
  readonly minYear: number;
  readonly maxYear: number;
}

/**
 * Default window. The upper bound sits well below the current year on purpose:
 * dates from the last dozen years are overwhelmingly log timestamps, invoice
 * dates or deadlines, not birth dates. Widen it via config when the data really
 * does contain children's birth dates.
 */
export function defaultDobYearRange(now: Date = new Date()): DobYearRange {
  return { minYear: 1900, maxYear: now.getUTCFullYear() - 13 };
}

/** Proleptic Gregorian calendar check, leap years included. */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const GERMAN_PATTERN = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d.])/gu;
const ISO_PATTERN = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/gu;

/**
 * Date-of-birth detector for German `DD.MM.YYYY` and ISO `YYYY-MM-DD` dates
 * that fall inside a plausible birth-year window.
 */
export function createDobDetector(range: DobYearRange = defaultDobYearRange()): Detector {
  return {
    name: 'date-of-birth',
    priority: DEFAULT_PRIORITIES.DATE_OF_BIRTH,

    find(text: string): Span[] {
      const out: Span[] = [];

      for (const [pattern, order] of [
        [GERMAN_PATTERN, 'dmy'],
        [ISO_PATTERN, 'ymd'],
      ] as const) {
        const re = new RegExp(pattern.source, pattern.flags);
        let match: RegExpExecArray | null;

        while ((match = re.exec(text)) !== null) {
          const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
          const [year, month, day] = order === 'dmy' ? [c, b, a] : [a, b, c];

          if (year < range.minYear || year > range.maxYear) continue;
          if (!isRealDate(year, month, day)) continue;

          out.push({
            start: match.index,
            end: match.index + match[0].length,
            kind: 'DATE_OF_BIRTH',
            value: match[0],
            detector: 'date-of-birth',
            priority: DEFAULT_PRIORITIES.DATE_OF_BIRTH,
          });
        }
      }

      return out;
    },
  };
}

/** Date-of-birth detector using the default year window. */
export const dobDetector: Detector = createDobDetector();
