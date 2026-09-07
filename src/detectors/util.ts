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
  /**
   * Index just past the last member character, which is the end of the span a
   * caller would claim. Equal to `start` when nothing was collected.
   */
  readonly end: number;
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
 *
 * THE COST ARGUMENT, because this is the single hottest function in the
 * package. Seven detectors call it at every group head in the body, and almost
 * every one of those calls is about to be rejected — the run is the wrong
 * length, or the characters fail a check digit. So the call has to be cheap
 * when it is thrown away, and the two things that made it expensive were both
 * allocations the rejecting caller never read: an array of single-character
 * strings that was then joined, and an array of offsets. Measured on the
 * `dense` fixture in `test/ops.test.ts` — a body where every eighth character
 * starts a candidate — building the string directly instead of joining an array
 * took the walk from 86 ms to 51 ms per 512 KiB, per detector.
 *
 * `offsets` is therefore built on first read rather than during the walk, by
 * walking again. That is only ever paid by the four callers that need to know
 * where the separators fell, and only for a run they have already accepted;
 * everyone else reads {@link RunScan.end} and pays nothing. The predicates are
 * pure, so the second walk sees exactly what the first one saw.
 */
export function collectRun(
  text: string,
  start: number,
  isMember: (ch: string) => boolean,
  isSeparator: (ch: string) => boolean,
  maxChars: number,
): RunScan {
  let chars = '';
  let end = start;
  let i = start;

  while (i < text.length && chars.length < maxChars) {
    const ch = text[i];
    if (ch === undefined) break;

    if (isMember(ch)) {
      chars += ch;
      i += 1;
      end = i;
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

  return new CollectedRun(text, start, isMember, isSeparator, maxChars, chars, end);
}

/**
 * The result of {@link collectRun}, with `offsets` materialised on demand.
 *
 * A class rather than an object literal with a getter: the literal would build
 * a fresh accessor on every one of the millions of calls a large body makes,
 * while a prototype getter is installed once.
 */
class CollectedRun implements RunScan {
  readonly chars: string;
  readonly end: number;

  readonly #text: string;
  readonly #start: number;
  readonly #isMember: (ch: string) => boolean;
  readonly #isSeparator: (ch: string) => boolean;
  readonly #maxChars: number;
  #offsets: readonly number[] | null = null;

  constructor(
    text: string,
    start: number,
    isMember: (ch: string) => boolean,
    isSeparator: (ch: string) => boolean,
    maxChars: number,
    chars: string,
    end: number,
  ) {
    this.#text = text;
    this.#start = start;
    this.#isMember = isMember;
    this.#isSeparator = isSeparator;
    this.#maxChars = maxChars;
    this.chars = chars;
    this.end = end;
  }

  get offsets(): readonly number[] {
    if (this.#offsets !== null) return this.#offsets;

    const text = this.#text;
    const isMember = this.#isMember;
    const isSeparator = this.#isSeparator;
    const offsets: number[] = [];
    let i = this.#start;

    while (i < text.length && offsets.length < this.#maxChars) {
      const ch = text[i];
      if (ch === undefined) break;

      if (isMember(ch)) {
        offsets.push(i);
        i += 1;
        continue;
      }

      if (isSeparator(ch) && offsets.length > 0) {
        const next = text[i + 1];
        if (next !== undefined && isMember(next)) {
          i += 1;
          continue;
        }
      }

      break;
    }

    this.#offsets = offsets;
    return offsets;
  }
}

/** True when `text[index]` exists and satisfies `isMember`. */
export function memberAt(text: string, index: number, isMember: (ch: string) => boolean): boolean {
  const ch = text[index];
  return ch !== undefined && isMember(ch);
}

export const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
export const isUpperAlnum = (ch: string): boolean =>
  isDigit(ch) || (ch >= 'A' && ch <= 'Z');
