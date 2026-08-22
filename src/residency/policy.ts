/**
 * Data residency enforcement.
 *
 * The question this answers is the one a DPO actually asks: *where does this
 * request go, on whose authority, and what happens to the personal data in it?*
 * The answer is computed from a declarative allowlist the operator writes, the
 * offline registry, and an enforcement mode that can be set globally, per route
 * or per category of personal data.
 */
import { ResidencyBlockedError, ResidencyError } from '../errors.js';
import { jurisdiction, type Jurisdiction } from './jurisdictions.js';
import { lookupEndpoint, type DataControl, type EndpointEntry, type EndpointMatch } from './registry.js';

/**
 * What to do with personal data bound for an upstream.
 *
 * - `block`    — refuse the request outright, naming the rule that refused it
 * - `sanitize` — remove the personal data, then forward (the default)
 * - `warn`     — forward unchanged, but record what went out (staged rollout)
 * - `allow`    — forward unchanged
 */
export type EnforcementMode = 'block' | 'sanitize' | 'warn' | 'allow';

export const ENFORCEMENT_MODES: readonly EnforcementMode[] = ['block', 'sanitize', 'warn', 'allow'];

export function isEnforcementMode(value: unknown): value is EnforcementMode {
  return typeof value === 'string' && (ENFORCEMENT_MODES as readonly string[]).includes(value);
}

/** Strictest first; used when several rules apply to one request. */
const STRICTNESS: Readonly<Record<EnforcementMode, number>> = {
  block: 3,
  sanitize: 2,
  warn: 1,
  allow: 0,
};

export function strictest(a: EnforcementMode, b: EnforcementMode): EnforcementMode {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/** One permitted upstream, as declared by the operator. */
export interface AllowEntry {
  /** Base URL, normalised. Matching is by origin plus path prefix. */
  readonly endpoint: string;
  /** Authoritative over the registry: the operator knows their deployment. */
  readonly jurisdiction: string | null;
  /** Why this transfer is permitted. Required — an allowlist without reasons is a wish list. */
  readonly legalBasis: string;
  readonly note: string | null;
}

export interface ResidencyConfig {
  /** Default enforcement mode. */
  readonly mode: EnforcementMode;
  /** Per-route overrides, keyed by route label. */
  readonly routes: Readonly<Record<string, EnforcementMode>>;
  /** Per-category overrides, keyed by finding kind. */
  readonly categories: Readonly<Record<string, EnforcementMode>>;
  /** Permitted upstreams. Empty means "unrestricted", and hushgate says so. */
  readonly allow: readonly AllowEntry[];
  /** Refuse to start when a permitted upstream offers no retention control. */
  readonly requireDataControls: boolean;
  /** Registry extensions and overrides. */
  readonly endpoints: readonly EndpointEntry[];
}

export function defaultResidencyConfig(): ResidencyConfig {
  return {
    mode: 'sanitize',
    routes: {},
    categories: {},
    allow: [],
    requireDataControls: false,
    endpoints: [],
  };
}

export interface ResidencyVerdict {
  readonly upstream: string;
  readonly host: string;
  /** False when hushgate must refuse to start or to forward. */
  readonly permitted: boolean;
  /** The rule that decided it, as a config path a human can go and read. */
  readonly rule: string;
  /** One sentence explaining the verdict. */
  readonly reason: string;
  readonly jurisdiction: Jurisdiction;
  readonly registry: EndpointMatch | null;
  readonly legalBasis: string | null;
  readonly dataControls: readonly DataControl[];
}

/**
 * Decide whether one upstream URL may be used at all.
 *
 * With an allowlist configured this is fail-closed: an upstream that is not on
 * it is refused, and the refusal names the rule. With no allowlist configured
 * everything is permitted — and every verdict says so out loud, because
 * "unrestricted" is a finding in its own right.
 */
export function evaluateUpstream(upstream: string, residency: ResidencyConfig): ResidencyVerdict {
  const host = hostOf(upstream);
  const registry = lookupEndpoint(host, residency.endpoints);

  const index = residency.allow.findIndex((entry) => covers(entry.endpoint, upstream));
  const entry = index === -1 ? undefined : residency.allow[index];

  if (residency.allow.length > 0 && entry === undefined) {
    return {
      upstream,
      host,
      permitted: false,
      rule: 'residency.allow',
      reason: `${upstream} is not on the residency allowlist`,
      jurisdiction: registry?.jurisdiction ?? jurisdiction('UNKNOWN'),
      registry,
      legalBasis: null,
      dataControls: registry?.entry.dataControls ?? [],
    };
  }

  const declared = entry?.jurisdiction ?? registry?.entry.jurisdiction ?? 'UNKNOWN';
  const where = jurisdiction(declared);
  const controls = registry?.entry.dataControls ?? [];

  if (entry === undefined) {
    return {
      upstream,
      host,
      permitted: true,
      rule: 'residency.allow (empty)',
      reason:
        'no allowlist is configured, so every upstream is permitted; add residency.allow to enforce one',
      jurisdiction: where,
      registry,
      legalBasis: null,
      dataControls: controls,
    };
  }

  // `block` mode implies the requirement: refusing to send personal data while
  // being indifferent to what happens to the rest of the request is not a
  // position anybody can defend to an auditor.
  const controlsRequired = residency.requireDataControls || residency.mode === 'block';

  if (controlsRequired && controls.length === 0) {
    return {
      upstream,
      host,
      permitted: false,
      rule: `residency.allow[${index}]`,
      reason: `${upstream} offers no documented retention or training control, and ${
        residency.requireDataControls ? 'residency.requireDataControls is set' : 'residency.mode is block'
      }`,
      jurisdiction: where,
      registry,
      legalBasis: entry.legalBasis,
      dataControls: controls,
    };
  }

  return {
    upstream,
    host,
    permitted: true,
    rule: `residency.allow[${index}]`,
    reason: `permitted by residency.allow[${index}]: ${entry.legalBasis}`,
    jurisdiction: where,
    registry,
    legalBasis: entry.legalBasis,
    dataControls: controls,
  };
}

/**
 * Fail closed at startup.
 *
 * @throws {ResidencyError} naming every upstream that was refused and why.
 */
export function assertUpstreamsPermitted(
  upstreams: Readonly<Record<string, string>>,
  residency: ResidencyConfig,
): ResidencyVerdict[] {
  const verdicts = Object.entries(upstreams).map(([name, url]) => ({
    name,
    verdict: evaluateUpstream(url, residency),
  }));

  const refused = verdicts.filter(({ verdict }) => !verdict.permitted);
  if (refused.length > 0) {
    const detail = refused
      .map(({ name, verdict }) => `  upstreams.${name} → ${verdict.reason} [${verdict.rule}]`)
      .join('\n');
    throw new ResidencyError(`residency policy refuses this configuration:\n${detail}`);
  }

  return verdicts.map(({ verdict }) => verdict);
}

export interface EnforcementDecision {
  readonly mode: EnforcementMode;
  /** Config path of the rule that decided, for the audit trail and the error. */
  readonly rule: string;
}

/**
 * Resolve the enforcement mode for one request.
 *
 * Precedence is by specificity: a category rule beats a route rule, which beats
 * the global mode. When several categories are present, the strictest of their
 * rules wins — one field of a request being sensitive is enough to make the
 * whole request sensitive.
 *
 * A category with no rule of its own is *not* silent: it carries the fallback
 * mode into the comparison. That is what stops a permissive rule from relaxing
 * a request it only partly describes — `categories: {IPV4: "allow"}` exempts an
 * IP address, and must not also exempt the IBAN sitting next to it. A category
 * rule can therefore only ever make one category stricter than the fallback,
 * never make the request as a whole looser.
 */
export function enforcementFor(
  residency: ResidencyConfig,
  routeLabel: string,
  kinds: readonly string[],
): EnforcementDecision {
  const routeMode = residency.routes[routeLabel];
  const fallback: EnforcementDecision =
    routeMode === undefined
      ? { mode: residency.mode, rule: 'residency.mode' }
      : { mode: routeMode, rule: `residency.routes.${routeLabel}` };

  const decisions = kinds.map((kind) => {
    const mode = residency.categories[kind];
    return mode === undefined
      ? { kind: null, decision: fallback }
      : { kind, decision: { mode, rule: `residency.categories.${kind}` } };
  });

  if (decisions.length === 0) return fallback;

  // Strictest wins. Ties go to the more specific rule, then to the kind name,
  // so the rule this reports never depends on the order the kinds arrived in.
  return decisions.toSorted((a, b) => {
    const byStrictness = STRICTNESS[b.decision.mode] - STRICTNESS[a.decision.mode];
    if (byStrictness !== 0) return byStrictness;
    if ((a.kind === null) !== (b.kind === null)) return a.kind === null ? 1 : -1;
    if (a.kind === null || b.kind === null) return 0;
    return a.kind < b.kind ? -1 : 1;
  })[0]!.decision;
}

/**
 * Refuse a request that a `block` rule applies to.
 *
 * @throws {ResidencyBlockedError} carrying counts and the rule, never values.
 */
export function assertNotBlocked(
  decision: EnforcementDecision,
  verdict: ResidencyVerdict,
  counts: Readonly<Record<string, number>>,
): void {
  if (decision.mode !== 'block') return;
  if (Object.keys(counts).length === 0) return;

  const kinds = Object.entries(counts)
    .map(([kind, count]) => `${kind} (${count})`)
    .join(', ');

  throw new ResidencyBlockedError(
    `residency policy ${decision.rule} forbids sending ${kinds} to ${verdict.host} [${verdict.jurisdiction.code}]`,
    decision.rule,
    verdict.jurisdiction.code,
    counts,
  );
}

/** Host of a base URL, without the port. */
function hostOf(upstream: string): string {
  try {
    return new URL(upstream).hostname;
  } catch {
    return upstream;
  }
}

/** Does an allowlist entry cover this upstream URL? Origin plus path prefix. */
export function covers(entry: string, upstream: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(entry);
    b = new URL(upstream);
  } catch {
    return entry === upstream;
  }

  if (a.origin !== b.origin) return false;

  const prefix = a.pathname.replace(/\/+$/u, '');
  if (prefix === '') return true;
  return b.pathname === prefix || b.pathname.startsWith(`${prefix}/`);
}
