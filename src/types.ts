/**
 * Shared vocabulary for the whole package: what a detector can find, how spans
 * are described, and which policy applies to a given kind of finding.
 */

/** Kinds that ship with hushgate. */
export const BUILTIN_KINDS = [
  // Contact and identity
  'EMAIL',
  'PHONE',
  'NAME',
  'DATE_OF_BIRTH',
  'POSTAL_ADDRESS',
  'POSTCODE',
  // Money
  'IBAN',
  'BIC',
  'CREDIT_CARD',
  // German administrative identifiers
  'GERMAN_TAX_ID',
  'GERMAN_TAX_NUMBER',
  'EU_VAT_ID',
  'SOCIAL_SECURITY_ID',
  'HEALTH_INSURANCE_ID',
  'ID_CARD_NUMBER',
  'PASSPORT_NUMBER',
  'DRIVER_LICENCE_ID',
  'COMMERCIAL_REGISTER_ID',
  'VEHICLE_PLATE',
  // Health — GDPR Art. 9 special category
  'ICD_CODE',
  'MEDICATION',
  // Machines and credentials
  'IPV4',
  'IPV6',
  'MAC',
  'DEVICE_ID',
  'SECRET',
  'SESSION_TOKEN',
  'URL_CREDENTIALS',
  // Configured by the operator
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
  /**
   * Optional. This span alone is only reported when one of these labels is
   * within reach, whatever the detector as a whole declared.
   *
   * The reason it exists is a sentence that {@link Detector.requiresLabel}
   * cannot say: *unless it is slash-grouped*. A Steuernummer written
   * `27/123/45678` is a shape almost nothing else has and is safe
   * unaccompanied; the same digits written `2712345678` are a customer number
   * until a label says otherwise. Before this field the only way to express
   * that was two detectors over one format — and two detectors walk the text
   * twice, discarding each other's half of the candidates. Five formats were
   * paying that, and on a 4 MiB body it was seconds.
   */
  readonly requiresLabel?: LabelProximity;
}

/**
 * How far from a value a label may sit and still license it, in characters.
 *
 * Wide enough for `Steuer-ID:` at the head of a short table row and for a
 * label on the line above, narrow enough that the label of one field cannot
 * license the number of the field after next.
 */
export const DEFAULT_LABEL_WINDOW = 64;

/**
 * A detector's declaration that its format is too weak to report unaccompanied.
 *
 * Eleven digits are a Steuer-ID, an order number or nothing at all; what
 * decides is the word in front of them. A detector that says so here keeps its
 * `find` free of the question — `detect()` applies this to every span the
 * detector returns, in whichever scan copy the span was found in, so the label
 * is looked for in the same folded spelling the value was found in.
 */
export interface LabelProximity {
  /**
   * The labels, written the ordinary way. The comparison ignores case,
   * separators and diacritics, so `Steuer-ID` also matches `steuer id`,
   * `STEUERID` and `Steuer_ID`.
   */
  readonly labels: readonly string[];
  /**
   * How many characters on each side of the span are searched. Defaults to
   * {@link DEFAULT_LABEL_WINDOW}.
   */
  readonly window?: number;
  /** Which side of the span to search. Defaults to `either`. */
  readonly where?: 'before' | 'after' | 'either';
}

/** A detector turns text into candidate spans. Detectors never mutate input. */
export interface Detector {
  /** Stable identifier, unique within a detector set. */
  readonly name: string;
  /** Default tie-break weight for spans this detector produces. */
  readonly priority: number;
  /** Find every candidate span. May return overlapping spans; resolution is central. */
  find(text: string): Span[];
  /**
   * Optional. When present, `detect()` drops every span this detector returns
   * that has no declared label within reach. Detectors that omit it are
   * unaffected — nothing is filtered and nothing is searched for.
   */
  readonly requiresLabel?: LabelProximity;
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

/**
 * A span that survived resolution and had a policy applied to it.
 *
 * `requiresLabel` is deliberately not part of it: the gate was satisfied before
 * the finding existed, so a record carrying it would describe a decision that
 * has already been made.
 */
export interface Finding extends Omit<Span, 'requiresLabel'> {
  /** Policy that was applied. */
  readonly policy: Policy;
  /**
   * The text that replaced the value, or `null` when the policy was `allow`.
   * For `pseudonymize` this is the reversible token.
   */
  readonly placeholder: string | null;
}

/**
 * Default per-detector priorities. Higher wins ties; see `resolveSpans`.
 *
 * Priority only decides between two spans of *equal length* that overlap —
 * longest match wins first — so this table is not a ranking of how sensitive a
 * kind is. It is a ranking of how much a format proves about itself:
 *
 *  - **95 and up** are formats that announce what they are. A PEM header, a
 *    `Bearer` cookie name, a `user:pass@` in a URL: there is no second reading.
 *  - **73–90** are the check-digit identifiers. An IBAN, a Steuer-ID, an ICAO
 *    passport serial and a Sozialversicherungsnummer each refuse roughly ninety
 *    per cent of the numbers that could be mistaken for them, so when one of
 *    them claims a range it is nearly always right. Within the band the order
 *    follows how much the digits carry: an IBAN encodes a bank, an SVNR encodes
 *    a birth date, a Handelsregisternummer encodes almost nothing.
 *  - **48–70** are shape-and-context formats — a BIC, a plate, a postcode, an
 *    address. Each is decided by a word next to it or a list it appears in
 *    rather than by arithmetic, so it yields to anything that verified itself.
 *  - **40–45** are the operator's own lists. They lose every tie by design: a
 *    customer name that happens to sit inside an IBAN is the IBAN.
 *
 * The one deliberate equality is `ID_CARD_NUMBER` and `PASSPORT_NUMBER`. They
 * come from one detector that decides which of the two a serial is, so no two
 * spans of those kinds can ever overlap and there is no tie to break.
 */
export const DEFAULT_PRIORITIES = {
  SECRET: 100,
  SESSION_TOKEN: 98,
  URL_CREDENTIALS: 95,
  IBAN: 90,
  EU_VAT_ID: 88,
  CREDIT_CARD: 85,
  DEVICE_ID: 84,
  ICD_CODE: 83,
  MEDICATION: 82,
  GERMAN_TAX_ID: 80,
  SOCIAL_SECURITY_ID: 79,
  ID_CARD_NUMBER: 78,
  PASSPORT_NUMBER: 78,
  HEALTH_INSURANCE_ID: 77,
  GERMAN_TAX_NUMBER: 76,
  EMAIL: 75,
  COMMERCIAL_REGISTER_ID: 74,
  DRIVER_LICENCE_ID: 73,
  IPV6: 70,
  IPV4: 65,
  MAC: 62,
  BIC: 60,
  POSTAL_ADDRESS: 59,
  DATE_OF_BIRTH: 58,
  PHONE: 55,
  VEHICLE_PLATE: 52,
  POSTCODE: 48,
  CUSTOM: 45,
  DICTIONARY: 40,
} as const;
