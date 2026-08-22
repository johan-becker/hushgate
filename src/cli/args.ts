/**
 * A very small, hand-rolled option parser — no dependency, and no surprises.
 *
 * Supported forms: `--name value`, `--name=value`, `-n value`, `-n=value`,
 * boolean `--name` and `--no-name`, and `--` to end option parsing. Anything
 * else is a positional argument. Unknown options are an error rather than being
 * ignored: silently dropping `--upstrem` would be exactly the wrong behaviour
 * for a tool whose job is to be sure about where data goes.
 */
import { UsageError } from '../errors.js';

export type FlagType = 'string' | 'number' | 'boolean';

export interface FlagSpec {
  readonly type: FlagType;
  /** Single-letter alias, without the dash. */
  readonly alias?: string;
  /** Shown in `--help`. */
  readonly description: string;
  /** Value name shown in `--help`, e.g. `<path>`. */
  readonly placeholder?: string;
}

export type FlagSpecs = Readonly<Record<string, FlagSpec>>;

export interface ParsedFlags {
  readonly values: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly positionals: readonly string[];
}

export function parseFlags(argv: readonly string[], specs: FlagSpecs): ParsedFlags {
  const byAlias = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias !== undefined) byAlias.set(spec.alias, name);
  }

  const values: Record<string, string | number | boolean | undefined> = {};
  const positionals: string[] = [];
  let onlyPositionals = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (onlyPositionals || argument === '-' || !argument.startsWith('-')) {
      positionals.push(argument);
      continue;
    }

    if (argument === '--') {
      onlyPositionals = true;
      continue;
    }

    const isLong = argument.startsWith('--');
    const withoutDashes = isLong ? argument.slice(2) : argument.slice(1);
    const equals = withoutDashes.indexOf('=');
    const rawName = equals === -1 ? withoutDashes : withoutDashes.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : withoutDashes.slice(equals + 1);

    let name = isLong ? rawName : (byAlias.get(rawName) ?? rawName);
    let negated = false;

    if (specs[name] === undefined && isLong && name.startsWith('no-')) {
      const positive = name.slice(3);
      if (specs[positive]?.type === 'boolean') {
        name = positive;
        negated = true;
      }
    }

    const spec = specs[name];
    if (spec === undefined) {
      throw new UsageError(`unknown option "${argument}"; try --help`);
    }

    if (spec.type === 'boolean') {
      if (inlineValue !== undefined) {
        throw new UsageError(`option "--${name}" is a flag and takes no value`);
      }
      values[name] = !negated;
      continue;
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined) {
      throw new UsageError(`option "--${name}" needs a value`);
    }

    if (spec.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new UsageError(`option "--${name}" needs a number, got "${value}"`);
      }
      values[name] = parsed;
      continue;
    }

    values[name] = value;
  }

  return { values, positionals };
}

/** Render a flag table for `--help`, aligned and stable. */
export function formatFlags(specs: FlagSpecs, indent = '  '): string {
  const rows = Object.entries(specs).map(([name, spec]) => {
    const alias = spec.alias === undefined ? '    ' : `-${spec.alias}, `;
    const placeholder =
      spec.type === 'boolean' ? '' : ` ${spec.placeholder ?? `<${spec.type}>`}`;
    return [`${alias}--${name}${placeholder}`, spec.description] as const;
  });

  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}`).join('\n');
}

/** Read a string option, rejecting an empty value. */
export function stringFlag(parsed: ParsedFlags, name: string): string | undefined {
  const value = parsed.values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new UsageError(`option "--${name}" needs a non-empty value`);
  }
  return value;
}

/** Read an integer option within an inclusive range. */
export function intFlag(
  parsed: ParsedFlags,
  name: string,
  range: { min: number; max: number },
): number | undefined {
  const value = parsed.values[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
    throw new UsageError(
      `option "--${name}" needs an integer between ${range.min} and ${range.max}, got "${String(value)}"`,
    );
  }
  return value;
}

/** Read a boolean flag; absent means `false`. */
export function boolFlag(parsed: ParsedFlags, name: string): boolean {
  return parsed.values[name] === true;
}
