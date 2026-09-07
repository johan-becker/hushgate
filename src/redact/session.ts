import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDetectors, detect, resolveSpans, type DetectorSetOptions } from '../detectors/index.js';
import { BlockedContentError, ConfigError } from '../errors.js';
import {
  isPolicy,
  LITERAL_KIND,
  type Detector,
  type Finding,
  type Kind,
  type Policy,
  type Span,
} from '../types.js';
import {
  findPlaceholders,
  makeHashToken,
  makePlaceholder,
  makeRedactedMask,
  PLACEHOLDER_PATTERN,
} from './placeholder.js';

/** Literal escaping must beat every real detector, whatever they claim. */
const LITERAL_PRIORITY = 1000;

/** Digest length of the `hash` policy token, in hex characters. */
const HASH_LENGTH = 12;

/**
 * Separator used when keying a value by its kind. NUL cannot occur in a kind
 * name, so `KIND + NUL + value` is an injective key.
 */
const KEY_SEPARATOR = '\u0000';

export interface SessionOptions extends DetectorSetOptions {
  /** Replace the detector set entirely. Overrides the dictionary/custom options. */
  readonly detectors?: readonly Detector[];
  /** Per-kind policy overrides. */
  readonly policies?: Readonly<Record<string, Policy>>;
  /** Policy for kinds without an explicit entry. Defaults to `pseudonymize`. */
  readonly defaultPolicy?: Policy;
  /**
   * Key for the `hash` policy. A random per-session key is generated when this
   * is omitted, which keeps hashes stable inside one session but not across
   * restarts — supply a fixed key when you need cross-session stability.
   */
  readonly hmacKey?: string | Uint8Array;
  /** Session identifier; generated when omitted. */
  readonly id?: string;
}

export interface RedactionResult {
  /** The sanitised text, safe to send upstream. */
  readonly text: string;
  /** Everything that was found, in document order. */
  readonly findings: readonly Finding[];
}

/**
 * A redaction session: the detector set, the policy table, and the two-way
 * mapping between real values and placeholders.
 *
 * Stability guarantees inside one session:
 *
 *  - the same value of the same kind always maps to the same placeholder;
 *  - two different values never share a placeholder;
 *  - a token hushgate issues is never equal to a placeholder-shaped string
 *    that appeared verbatim in any redacted input.
 */
export class Session {
  readonly id: string;

  private readonly detectors: readonly Detector[];
  private readonly policies: Readonly<Record<string, Policy>>;
  private readonly defaultPolicy: Policy;
  private readonly hmacKey: Uint8Array;

  /** `kind + NUL + value` → placeholder. */
  private readonly byValue = new Map<string, string>();
  /** placeholder → original value. */
  private readonly byPlaceholder = new Map<string, string>();
  /** Per-kind ordinal counter. */
  private readonly counters = new Map<string, number>();
  /** Every token this session has issued. */
  private readonly issued = new Set<string>();
  /** Placeholder-shaped strings that appeared verbatim in some input. */
  private readonly literals = new Set<string>();

  constructor(options: SessionOptions = {}) {
    this.id = options.id ?? randomUUID();
    this.detectors = options.detectors ?? createDetectors(options);
    this.defaultPolicy = options.defaultPolicy ?? 'pseudonymize';

    if (!isPolicy(this.defaultPolicy)) {
      throw new ConfigError(`unknown default policy "${String(options.defaultPolicy)}"`);
    }

    const policies: Record<string, Policy> = {};
    for (const [kind, policy] of Object.entries(options.policies ?? {})) {
      if (!isPolicy(policy)) {
        throw new ConfigError(`unknown policy "${String(policy)}" for kind "${kind}"`);
      }
      policies[kind] = policy;
    }
    this.policies = policies;

    this.hmacKey = toKeyBytes(options.hmacKey);
  }

  /** The policy that applies to a kind. */
  policyFor(kind: Kind): Policy {
    // Escaped literals are always reversible: they are not personal data, they
    // are protection for the mapping itself.
    if (kind === LITERAL_KIND) return 'pseudonymize';
    return this.policies[kind] ?? this.defaultPolicy;
  }

  /**
   * Redact `text`, returning the sanitised text and every finding.
   *
   * @throws {BlockedContentError} when a finding matched a `block` policy.
   */
  redact(text: string): RedactionResult {
    if (text.length === 0) return { text, findings: [] };

    const spans = this.resolveWithLiterals(text);
    if (spans.length === 0) return { text, findings: [] };

    this.rejectBlocked(spans);

    // Register every literal *before* allocating, so no token we mint can
    // collide with one that already appeared in the input.
    for (const span of spans) {
      if (span.kind === LITERAL_KIND) this.literals.add(span.value);
    }

    const findings: Finding[] = [];
    const pieces: string[] = [];
    let cursor = 0;

    for (const span of spans) {
      const policy = this.policyFor(span.kind);
      const replacement = this.apply(span, policy);

      pieces.push(text.slice(cursor, span.start), replacement ?? span.value);
      cursor = span.end;

      // Built field by field rather than spread from the span, so that
      // `requiresLabel` cannot ride along. It is a question `detect()` has
      // already answered by the time a finding exists, and a record that
      // carries a satisfied gate invites a reader to think it still means
      // something. The explicit shape is also monomorphic, which the hot path
      // on a body carrying half a million findings notices.
      findings.push({
        start: span.start,
        end: span.end,
        kind: span.kind,
        value: span.value,
        detector: span.detector,
        priority: span.priority,
        policy,
        placeholder: replacement,
      });
    }

    pieces.push(text.slice(cursor));
    return { text: pieces.join(''), findings };
  }

  /**
   * Replace every placeholder this session issued with its original value.
   *
   * The replacement is a single left-to-right pass: text inserted by one
   * replacement is never rescanned. That is what makes it safe for an escaped
   * literal to expand back into something that itself looks like a placeholder.
   */
  restore(text: string): string {
    if (text.length === 0 || this.byPlaceholder.size === 0) return text;
    const re = new RegExp(PLACEHOLDER_PATTERN.source, PLACEHOLDER_PATTERN.flags);
    return text.replaceAll(re, (token) => this.byPlaceholder.get(token) ?? token);
  }

  /** Look up one placeholder, or `undefined` when this session did not issue it. */
  lookup(token: string): string | undefined {
    return this.byPlaceholder.get(token);
  }

  /** True when `token` is a placeholder this session issued. */
  knows(token: string): boolean {
    return this.byPlaceholder.has(token);
  }

  /** Number of distinct values currently mapped. */
  get size(): number {
    return this.byPlaceholder.size;
  }

  /** Forget every mapping. The detector set and policies are kept. */
  reset(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.counters.clear();
    this.issued.clear();
    this.literals.clear();
  }

  /**
   * How many findings this session's detectors make in `text`, changing
   * nothing and allocating no placeholders.
   *
   * A question about the text rather than a decision about it. The attachment
   * stage uses it to compare what the detectors can see in a document as
   * extracted against what they can see once its spacing is closed up.
   */
  countFindings(text: string): number {
    return resolveSpans(detect(text, this.detectors)).length;
  }

  /** Detect, then merge in placeholder-shaped literals, then resolve overlaps. */
  private resolveWithLiterals(text: string): Span[] {
    const detected = detect(text, this.detectors);
    const literals = findPlaceholders(text).map(
      (hit): Span => ({
        start: hit.start,
        end: hit.end,
        kind: LITERAL_KIND,
        value: hit.value,
        detector: 'literal-placeholder',
        priority: LITERAL_PRIORITY,
      }),
    );

    if (literals.length === 0) return detected;

    // Re-resolve the union. A literal outranks every detector at equal length.
    // A genuinely longer finding that *contains* it swallows it whole, which is
    // equally safe: the literal then travels inside that finding's value and
    // comes back verbatim on restore.
    return resolveSpans([...detected, ...literals]);
  }

  /** Throw before touching any state if a `block` policy applies. */
  private rejectBlocked(spans: readonly Span[]): void {
    const counts: Record<string, number> = {};
    for (const span of spans) {
      if (this.policyFor(span.kind) !== 'block') continue;
      counts[span.kind] = (counts[span.kind] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) throw new BlockedContentError(counts);
  }

  /** Compute the replacement for a span, or `null` when the policy is `allow`. */
  private apply(span: Span, policy: Policy): string | null {
    switch (policy) {
      case 'allow': {
        return null;
      }
      case 'redact': {
        return makeRedactedMask(span.kind);
      }
      case 'hash': {
        return makeHashToken(span.kind, this.digest(span.kind, span.value));
      }
      case 'pseudonymize': {
        return this.allocate(span.kind, span.value);
      }
      case 'block': {
        // Unreachable: rejectBlocked() runs first. Kept so the switch is total.
        throw new BlockedContentError({ [span.kind]: 1 });
      }
    }
  }

  private digest(kind: Kind, value: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(`${kind}${KEY_SEPARATOR}${value}`)
      .digest('hex')
      .slice(0, HASH_LENGTH);
  }

  /** Get or mint the stable placeholder for a value. */
  private allocate(kind: Kind, value: string): string {
    const key = `${kind}${KEY_SEPARATOR}${value}`;
    const existing = this.byValue.get(key);
    if (existing !== undefined) return existing;

    let ordinal = this.counters.get(kind) ?? 0;
    let token: string;
    do {
      ordinal += 1;
      token = makePlaceholder(kind, ordinal);
    } while (this.issued.has(token) || this.literals.has(token));

    this.counters.set(kind, ordinal);
    this.byValue.set(key, token);
    this.byPlaceholder.set(token, value);
    this.issued.add(token);
    return token;
  }
}

function toKeyBytes(key: string | Uint8Array | undefined): Uint8Array {
  if (key === undefined) return randomBytes(32);
  return typeof key === 'string' ? new TextEncoder().encode(key) : key;
}

/** Count findings per kind. This is what the audit log records — never values. */
export function countByKind(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
  }
  return counts;
}
