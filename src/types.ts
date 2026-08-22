/**
 * Shared vocabulary for the whole package: what a detector can find, how spans
 * are described, and which policy applies to a given kind of finding.
 */

/** Kinds that ship with hushgate. */
export const BUILTIN_KINDS = [
  'EMAIL',
  'IBAN',
  'CREDIT_CARD',
  'PHONE',
  'IPV4',
  'IPV6',
  'MAC',
  'GERMAN_TAX_ID',
  'SECRET',
  'URL_CREDENTIALS',
  'DATE_OF_BIRTH',
  'NAME',
  'TERM',
] as const;

export type BuiltinKind = (typeof BUILTIN_KINDS)[number];

/**
 * A finding kind. Built-in kinds are suggested by the type system; custom rules
 * contribute their own upper-snake-case names (for example `EMPLOYEE_ID`).
 *
 * The `(string & {})` arm keeps editor completion for the built-ins while still
 * accepting user-defined kinds.
 */
// oxlint-disable-next-line typescript/no-empty-object-type
export type Kind = BuiltinKind | (string & {});

/** Reserved kind used to protect text that already looks like a placeholder. */
export const LITERAL_KIND = 'LITERAL';

/** A half-open range `[start, end)` of `text` that a detector claimed. */
export interface Span {
  /** Inclusive start offset, in UTF-16 code units. */
  readonly start: number;
  /** Exclusive end offset, in UTF-16 code units. */
  readonly end: number;
  /** What was found. */
  readonly kind: Kind;
  /** The exact substring `text.slice(start, end)`. */
  readonly value: string;
  /** Name of the detector that produced the span, for debugging and tie-breaks. */
  readonly detector: string;
  /** Higher wins when two equally long spans overlap. */
  readonly priority: number;
}

/** A detector turns text into candidate spans. Detectors never mutate input. */
export interface Detector {
  /** Stable identifier, unique within a detector set. */
  readonly name: string;
  /** Default tie-break weight for spans this detector produces. */
  readonly priority: number;
  /** Find every candidate span. May return overlapping spans; resolution is central. */
  find(text: string): Span[];
}

/**
 * What to do with a finding.
 *
 * - `pseudonymize` — reversible placeholder such as `[EMAIL_1]` (default)
 * - `redact`       — irreversible mask such as `[EMAIL_REDACTED]`
 * - `hash`         — irreversible but stable `[EMAIL:9f86d081ab2c]` (HMAC-SHA256)
 * - `allow`        — leave the value untouched
 * - `block`        — refuse the whole request
 */
export type Policy = 'pseudonymize' | 'redact' | 'hash' | 'allow' | 'block';

export const POLICIES: readonly Policy[] = [
  'pseudonymize',
  'redact',
  'hash',
  'allow',
  'block',
];

export function isPolicy(value: unknown): value is Policy {
  return typeof value === 'string' && (POLICIES as readonly string[]).includes(value);
}

/** A span that survived resolution and had a policy applied to it. */
export interface Finding extends Span {
  /** Policy that was applied. */
  readonly policy: Policy;
  /**
   * The text that replaced the value, or `null` when the policy was `allow`.
   * For `pseudonymize` this is the reversible token.
   */
  readonly placeholder: string | null;
}

/** Default per-detector priorities. Higher wins ties; see `resolveSpans`. */
export const DEFAULT_PRIORITIES = {
  SECRET: 100,
  URL_CREDENTIALS: 95,
  IBAN: 90,
  CREDIT_CARD: 85,
  GERMAN_TAX_ID: 80,
  EMAIL: 75,
  IPV6: 70,
  IPV4: 65,
  MAC: 62,
  DATE_OF_BIRTH: 58,
  PHONE: 55,
  CUSTOM: 45,
  DICTIONARY: 40,
} as const;
