/**
 * Prometheus metrics, hand-rolled because the dependency count is zero and the
 * exposition format is a page long.
 *
 * Every label here is bounded: routes and outcomes are enumerations, kinds come
 * from the detector set, and tenants come from the config file. Nothing that a
 * caller controls is ever used as a label — that is how a metrics endpoint turns
 * into an out-of-memory error, and in this case it would also turn counts of
 * personal data into a cardinality side channel.
 */
import { VERSION } from '../version.js';

/** Latency buckets in seconds. A model call is slow; the tail is what matters. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120,
];

type Labels = Readonly<Record<string, string>>;

interface Histogram {
  readonly counts: number[];
  sum: number;
  count: number;
}

export class Metrics {
  private readonly requests = new Map<string, number>();
  private readonly findings = new Map<string, number>();
  private readonly blocked = new Map<string, number>();
  private readonly tokens = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();

  constructor(private readonly buckets: readonly number[] = DEFAULT_BUCKETS) {}

  /** Record one finished request. */
  observeRequest(options: {
    readonly route: string;
    readonly outcome: string;
    readonly tenant: string | null;
    readonly status: number;
    readonly latencyMs: number;
    readonly tokens: number;
    readonly findings: Readonly<Record<string, number>>;
    readonly policies: Readonly<Record<string, string>>;
  }): void {
    const tenant = options.tenant ?? 'none';

    this.bump(this.requests, {
      route: options.route,
      outcome: options.outcome,
      status: String(options.status),
      tenant,
    });

    if (options.tokens > 0) {
      this.bump(this.tokens, { route: options.route, tenant }, options.tokens);
    }

    for (const [kind, count] of Object.entries(options.findings)) {
      this.bump(this.findings, { kind, policy: options.policies[kind] ?? 'none' }, count);
    }

    this.observeDuration({ route: options.route }, options.latencyMs / 1000);
  }

  /** Record a refusal, by the rule that refused it. */
  observeBlocked(reason: string, rule: string): void {
    this.bump(this.blocked, { reason, rule });
  }

  private observeDuration(labels: Labels, seconds: number): void {
    const key = serialise(labels);
    let histogram = this.durations.get(key);

    if (histogram === undefined) {
      histogram = { counts: Array.from({ length: this.buckets.length }, () => 0), sum: 0, count: 0 };
      this.durations.set(key, histogram);
    }

    histogram.sum += seconds;
    histogram.count += 1;
    for (const [index, bound] of this.buckets.entries()) {
      if (seconds <= bound) histogram.counts[index] = (histogram.counts[index] ?? 0) + 1;
    }
  }

  private bump(target: Map<string, number>, labels: Labels, by = 1): void {
    const key = serialise(labels);
    target.set(key, (target.get(key) ?? 0) + by);
  }

  /** Render the exposition format Prometheus scrapes. */
  render(): string {
    const lines: string[] = [];

    lines.push(
      '# HELP hushgate_build_info Version of the running hushgate.',
      '# TYPE hushgate_build_info gauge',
      `hushgate_build_info{version="${escapeValue(VERSION)}"} 1`,
    );

    lines.push(
      '# HELP hushgate_requests_total Requests handled, by route, outcome and tenant.',
      '# TYPE hushgate_requests_total counter',
      ...series('hushgate_requests_total', this.requests),
    );

    lines.push(
      '# HELP hushgate_findings_total Personal data found, by category and the policy applied.',
      '# TYPE hushgate_findings_total counter',
      ...series('hushgate_findings_total', this.findings),
    );

    lines.push(
      '# HELP hushgate_blocked_total Requests refused, by what refused them.',
      '# TYPE hushgate_blocked_total counter',
      ...series('hushgate_blocked_total', this.blocked),
    );

    lines.push(
      '# HELP hushgate_upstream_tokens_total Tokens reported by upstream providers.',
      '# TYPE hushgate_upstream_tokens_total counter',
      ...series('hushgate_upstream_tokens_total', this.tokens),
    );

    lines.push(
      '# HELP hushgate_request_duration_seconds Time from request received to response finished.',
      '# TYPE hushgate_request_duration_seconds histogram',
    );

    for (const [key, histogram] of this.durations) {
      const labels = key.length === 0 ? '' : key;
      let cumulative = 0;

      for (const [index, bound] of this.buckets.entries()) {
        cumulative = histogram.counts[index] ?? 0;
        lines.push(
          `hushgate_request_duration_seconds_bucket{${join(labels, `le="${formatNumber(bound)}"`)}} ${cumulative}`,
        );
      }

      lines.push(
        `hushgate_request_duration_seconds_bucket{${join(labels, 'le="+Inf"')}} ${histogram.count}`,
        `hushgate_request_duration_seconds_sum${wrap(labels)} ${formatNumber(histogram.sum)}`,
        `hushgate_request_duration_seconds_count${wrap(labels)} ${histogram.count}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }
}

function series(name: string, values: ReadonlyMap<string, number>): string[] {
  return [...values.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([labels, value]) => `${name}${wrap(labels)} ${value}`);
}

function serialise(labels: Labels): string {
  return Object.entries(labels)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${name}="${escapeValue(value)}"`)
    .join(',');
}

function wrap(labels: string): string {
  return labels.length === 0 ? '' : `{${labels}}`;
}

function join(labels: string, extra: string): string {
  return labels.length === 0 ? extra : `${labels},${extra}`;
}

function escapeValue(value: string): string {
  return value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`).replaceAll('\n', String.raw`\n`);
}

/**
 * A sample value in the exposition format.
 *
 * Trailing zeros are trimmed, but so is the separator they leave behind: a sum
 * of 9.999999999999831 — what a thousand 10 ms latencies actually accumulate to
 * in binary floating point — is not an integer, rounds to "10.000000" at six
 * decimals, and would otherwise be rendered as the bare "10.". Go's ParseFloat
 * tolerates that; the OpenMetrics number grammar does not.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(6).replace(/\.?0+$/u, '');
}
