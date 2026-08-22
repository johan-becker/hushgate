import { ConfigError } from '../errors.js';
import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

/** A user-supplied named pattern from the config file. */
export interface CustomRule {
  /** Reported kind; normalised to UPPER_SNAKE_CASE, e.g. `EMPLOYEE_ID`. */
  readonly name: string;
  /** Regular expression source. `g` is always added. */
  readonly pattern: string;
  /** Extra flags. Only `i`, `m`, `s` and `u` are accepted. */
  readonly flags?: string;
  /** Tie-break weight; defaults to sitting just above the dictionary. */
  readonly priority?: number;
}

const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u']);
/** Guard against a pathological pattern producing an unbounded finding list. */
const MAX_MATCHES = 10_000;

/** Normalise an arbitrary rule name into a usable kind. */
export function normaliseKindName(name: string): string {
  const normalised = name
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase();

  if (normalised.length === 0 || /^\d/u.test(normalised)) {
    throw new ConfigError(
      `custom rule name "${name}" cannot be turned into a kind; use letters, digits and underscores and start with a letter`,
    );
  }

  return normalised;
}

/** Compile one custom rule into a detector, failing loudly on a bad pattern. */
export function createCustomDetector(rule: CustomRule): Detector {
  const kind = normaliseKindName(rule.name);
  const priority = rule.priority ?? DEFAULT_PRIORITIES.CUSTOM;

  for (const flag of rule.flags ?? '') {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new ConfigError(
        `custom rule "${rule.name}" uses unsupported regex flag "${flag}"; allowed flags are i, m, s, u`,
      );
    }
  }

  const flags = `${rule.flags ?? ''}g`;
  let compiled: RegExp;
  try {
    compiled = new RegExp(rule.pattern, flags);
  } catch (cause) {
    throw new ConfigError(
      `custom rule "${rule.name}" has an invalid pattern: ${(cause as Error).message}`,
      { cause },
    );
  }

  return {
    name: `custom:${kind}`,
    priority,

    find(text: string): Span[] {
      const re = new RegExp(compiled.source, compiled.flags);
      const out: Span[] = [];
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null && out.length < MAX_MATCHES) {
        const value = match[0];
        // A pattern that can match nothing would spin forever otherwise.
        if (value.length === 0) {
          re.lastIndex += 1;
          continue;
        }

        out.push({
          start: match.index,
          end: match.index + value.length,
          kind,
          value,
          detector: `custom:${kind}`,
          priority,
        });
      }

      return out;
    },
  };
}

export function createCustomDetectors(rules: readonly CustomRule[] = []): Detector[] {
  const seen = new Set<string>();
  return rules.map((rule) => {
    const detector = createCustomDetector(rule);
    if (seen.has(detector.name)) {
      throw new ConfigError(`duplicate custom rule name "${rule.name}"`);
    }
    seen.add(detector.name);
    return detector;
  });
}
