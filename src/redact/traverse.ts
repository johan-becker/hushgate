/**
 * Structured traversal of provider request and response bodies.
 *
 * A blind regex over the serialised JSON would be both unsafe and lossy: it
 * would rewrite model names, tool identifiers and URLs, and it would corrupt the
 * escaping of any string it touched. Instead the body is parsed and walked, and
 * only the string leaves that carry user content are handed to the redactor.
 *
 * Which leaves those are is provider knowledge; it lives in `shapes.ts` as path
 * rules. This module is the mechanism only.
 */
import { TraversalDepthError } from '../errors.js';
import type { Finding } from '../types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type PathSegment = string | number;
export type Path = readonly PathSegment[];

/** Deeper than this is not a chat request; it is someone probing the parser. */
export const DEFAULT_MAX_DEPTH = 32;

/**
 * A dotted path rule. `*` matches exactly one segment (an object key or an array
 * index); `**` matches any number of segments, including none.
 *
 * `messages.*.content.*.text` selects the text of every content part;
 * `messages.*.content.*.input.**` selects every string anywhere inside a tool
 * call's arguments, however deeply the tool schema nests them.
 */
export type PathRule = string;

export interface MapStringsOptions {
  /** Which string leaves to transform. Every leaf, when omitted. */
  readonly select?: (path: Path, value: string) => boolean;
  /** Depth guard; defaults to {@link DEFAULT_MAX_DEPTH}. */
  readonly maxDepth?: number;
}

/**
 * Return a copy of `value` with every selected string leaf replaced by
 * `transform(leaf, path)`. Input is never mutated.
 */
export function mapStrings(
  value: JsonValue,
  transform: (text: string, path: Path) => string,
  options: MapStringsOptions = {},
): JsonValue {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const select = options.select;

  const walk = (node: JsonValue, path: PathSegment[], depth: number): JsonValue => {
    if (depth > maxDepth) throw new TraversalDepthError(maxDepth);

    if (typeof node === 'string') {
      return select === undefined || select(path, node) ? transform(node, path) : node;
    }

    if (Array.isArray(node)) {
      const out: JsonValue[] = Array.from({ length: node.length });
      for (const [index, item] of node.entries()) {
        path.push(index);
        out[index] = walk(item as JsonValue, path, depth + 1);
        path.pop();
      }
      return out;
    }

    if (node !== null && typeof node === 'object') {
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(node)) {
        path.push(key);
        out[key] = walk(item, path, depth + 1);
        path.pop();
      }
      return out;
    }

    return node;
  };

  return walk(value, [], 0);
}

/** Split a rule into segments once, so matching never re-parses it. */
export function compileRule(rule: PathRule): string[] {
  return rule.split('.');
}

/** True when `path` satisfies the compiled `rule`. */
export function matchesRule(rule: readonly string[], path: Path): boolean {
  const step = (ruleIndex: number, pathIndex: number): boolean => {
    let ri = ruleIndex;
    let pi = pathIndex;

    while (ri < rule.length) {
      const segment = rule[ri];

      if (segment === '**') {
        // Try every possible length for the wildcard, shortest first.
        for (let skip = pi; skip <= path.length; skip += 1) {
          if (step(ri + 1, skip)) return true;
        }
        return false;
      }

      if (pi >= path.length) return false;
      if (segment !== '*' && segment !== String(path[pi])) return false;

      ri += 1;
      pi += 1;
    }

    return pi === path.length;
  };

  return step(0, 0);
}

/** Build a `select` predicate from a rule set. */
export function selectByRules(rules: readonly PathRule[]): (path: Path) => boolean {
  const compiled = rules.map(compileRule);
  return (path) => compiled.some((rule) => matchesRule(rule, path));
}

/** The half of a {@link Session} that traversal needs. Keeps this module testable. */
export interface Redactor {
  redact(text: string): { readonly text: string; readonly findings: readonly Finding[] };
  restore(text: string): string;
}

export interface RedactJsonResult {
  readonly body: JsonValue;
  /** Findings from every visited leaf, in traversal order. */
  readonly findings: readonly Finding[];
}

/**
 * Redact the content-bearing leaves of a request body.
 *
 * Only leaves matching `rules` are touched: rewriting a model name or a tool
 * identifier would break the request, and rewriting an opaque id would leak
 * nothing anyway.
 */
export function redactJson(
  body: JsonValue,
  redactor: Redactor,
  rules: readonly PathRule[],
  options: { readonly maxDepth?: number } = {},
): RedactJsonResult {
  const findings: Finding[] = [];
  const select = selectByRules(rules);

  const next = mapStrings(
    body,
    (text) => {
      const result = redactor.redact(text);
      // Appended, never spread: see the note in detectors/index.ts — a dense
      // leaf can hold more findings than an engine accepts as arguments.
      for (const finding of result.findings) findings.push(finding);
      return result.text;
    },
    { select, maxDepth: options.maxDepth },
  );

  return { body: next, findings };
}

/**
 * Re-hydrate every string leaf of a response body.
 *
 * Unlike redaction this is deliberately unselective. Only tokens the session
 * itself issued are ever replaced, so visiting a leaf that turns out to be a
 * model name or an id is a no-op — whereas *missing* a leaf the model echoed a
 * placeholder into would hand the caller a token instead of their own data.
 */
export function restoreJson(
  body: JsonValue,
  redactor: Redactor,
  options: { readonly maxDepth?: number } = {},
): JsonValue {
  return mapStrings(body, (text) => redactor.restore(text), { maxDepth: options.maxDepth });
}
