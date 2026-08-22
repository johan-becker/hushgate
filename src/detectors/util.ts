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
