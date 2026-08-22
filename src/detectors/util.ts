/**
 * Small helpers shared by the detectors. Kept free of any regex state so
 * detectors stay re-entrant: every detector compiles its patterns once at
 * module load and clones `lastIndex` handling per call.
 */
import type { Detector, Kind, Span } from '../types.js';

/**
 * Run a sticky-free global regex over `text` and hand each match to `validate`.
 *
 * `validate` returns `null` to reject the candidate, or a `{ start, end, value }`
 * refinement — this is how checksum-backed detectors (IBAN, Luhn, MOD 11,10)
 * reject strings that merely look right.
 */
export function scan(
  text: string,
  pattern: RegExp,
  handle: (match: RegExpExecArray) => Omit<Span, 'kind' | 'detector' | 'priority'> | null,
  meta: { kind: Kind; detector: string; priority: number },
): Span[] {
  const re = new RegExp(pattern.source, ensureGlobal(pattern.flags));
  const out: Span[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    // A zero-length match would spin forever; nudge and continue.
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const refined = handle(match);
    if (refined !== null) {
      out.push({ ...refined, kind: meta.kind, detector: meta.detector, priority: meta.priority });
    }
  }

  return out;
}

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : `${flags}g`;
}

/** Build a detector from a pattern plus a validator. */
export function makeDetector(options: {
  name: string;
  kind: Kind;
  priority: number;
  pattern: RegExp;
  /** Return the accepted span, or `null` to reject the candidate. */
  accept(match: RegExpExecArray, text: string): { start: number; end: number; value: string } | null;
}): Detector {
  const { name, kind, priority, pattern, accept } = options;
  return {
    name,
    priority,
    find(text: string): Span[] {
      return scan(text, pattern, (match) => accept(match, text), { kind, detector: name, priority });
    },
  };
}

/** Escape a literal string for safe inclusion in a regular expression. */
export function escapeRegExp(literal: string): string {
  return literal.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** True when the character at `index` would continue a word (Unicode aware). */
export function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  const ch = text[index];
  if (ch === undefined) return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** Digits only, with spaces, hyphens, dots, slashes and parentheses removed. */
export function stripSeparators(value: string): string {
  return value.replaceAll(/[\s\-./()]/g, '');
}

/** A run of "member" characters with optional single separators between them. */
export interface RunScan {
  /** The member characters, separators removed. */
  readonly chars: string;
  /** `offsets[i]` is the index in the source text of `chars[i]`. */
  readonly offsets: readonly number[];
}

/**
 * Walk forward from `start`, collecting member characters and tolerating a
 * single separator between them.
 *
 * This is what lets `DE89 3704 0044 0532 0130 00` and `4111-1111-1111-1111` be
 * recognised without a regex that also happily swallows the rest of the
 * sentence. Collection stops at `maxChars`, at a non-member/non-separator
 * character, or at a separator that is not followed by another member.
 */
export function collectRun(
  text: string,
  start: number,
  isMember: (ch: string) => boolean,
  isSeparator: (ch: string) => boolean,
  maxChars: number,
): RunScan {
  const chars: string[] = [];
  const offsets: number[] = [];
  let i = start;

  while (i < text.length && chars.length < maxChars) {
    const ch = text[i];
    if (ch === undefined) break;

    if (isMember(ch)) {
      chars.push(ch);
      offsets.push(i);
      i += 1;
      continue;
    }

    if (isSeparator(ch) && chars.length > 0) {
      const next = text[i + 1];
      if (next !== undefined && isMember(next)) {
        i += 1;
        continue;
      }
    }

    break;
  }

  return { chars: chars.join(''), offsets };
}

/** True when `text[index]` exists and satisfies `isMember`. */
export function memberAt(text: string, index: number, isMember: (ch: string) => boolean): boolean {
  const ch = text[index];
  return ch !== undefined && isMember(ch);
}

export const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
export const isUpperAlnum = (ch: string): boolean =>
  isDigit(ch) || (ch >= 'A' && ch <= 'Z');
