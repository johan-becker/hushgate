import { ConfigError } from '../errors.js';
import { DEFAULT_PRIORITIES, type Detector, type Kind, type Span } from '../types.js';
import { escapeRegExp } from './util.js';

/** One entry of the user-supplied dictionary. */
export interface DictionaryEntry {
  /** The literal to match, case-insensitively. */
  readonly value: string;
  /** Kind to report. Defaults to `NAME`. */
  readonly kind?: Kind;
}

/** Shorthand form accepted by the config file. */
export interface DictionaryInput {
  readonly names?: readonly string[];
  readonly terms?: readonly string[];
  readonly entries?: readonly DictionaryEntry[];
}

/** Flatten the config shorthand into a single entry list. */
export function toDictionaryEntries(input: DictionaryInput | undefined): DictionaryEntry[] {
  if (input === undefined) return [];
  return [
    ...(input.names ?? []).map((value) => ({ value, kind: 'NAME' as Kind })),
    ...(input.terms ?? []).map((value) => ({ value, kind: 'TERM' as Kind })),
    ...(input.entries ?? []),
  ];
}

/**
 * Dictionary detector for names, customer names and project codenames.
 *
 * Matching is case-insensitive and whole-word, where "word" is defined with
 * Unicode property escapes rather than `\b`. That matters: `\bZoë\b` never
 * matches, because `ë` is not a `\w` character, so there is no word boundary
 * after it.
 *
 * Alternatives are sorted longest-first so that at any given offset the longest
 * entry wins — `Anna Schmidt` beats `Anna`. Overlaps that start at *different*
 * offsets are settled later by `resolveSpans`, which applies the same rule.
 */
export function createDictionaryDetector(
  entries: readonly DictionaryEntry[],
  options: { priority?: number } = {},
): Detector {
  const priority = options.priority ?? DEFAULT_PRIORITIES.DICTIONARY;
  const byLower = new Map<string, Kind>();

  for (const entry of entries) {
    const value = entry.value.trim();
    if (value.length === 0) continue;
    if (entry.kind !== undefined && !/^[A-Z][A-Z0-9_]*$/u.test(entry.kind)) {
      throw new ConfigError(
        `dictionary entry "${value}" has kind "${entry.kind}"; kinds must be UPPER_SNAKE_CASE`,
      );
    }
    byLower.set(value.toLowerCase(), entry.kind ?? 'NAME');
  }

  if (byLower.size === 0) {
    return { name: 'dictionary', priority, find: () => [] };
  }

  const alternation = [...byLower.keys()]
    .toSorted((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((value) => escapeRegExp(value))
    .join('|');

  const source = String.raw`(?<![\p{L}\p{N}_])(?:${alternation})(?![\p{L}\p{N}_])`;

  return {
    name: 'dictionary',
    priority,

    find(text: string): Span[] {
      const re = new RegExp(source, 'giu');
      const out: Span[] = [];
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const value = match[0];
        if (value.length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const kind = byLower.get(value.toLowerCase());
        if (kind === undefined) continue;

        out.push({
          start: match.index,
          end: match.index + value.length,
          kind,
          value,
          detector: 'dictionary',
          priority,
        });
      }

      return out;
    },
  };
}
