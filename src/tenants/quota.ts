/**
 * Per-tenant allowances.
 *
 * Two limits, because they answer different questions: requests per minute
 * keeps one runaway loop from starving everyone else, and tokens per day keeps
 * a team's spend inside what was budgeted for it. Both are enforced in memory
 * and per process, which is the honest scope of a local-first proxy — say so in
 * the documentation rather than implying a distributed counter.
 */
import { QuotaExceededError } from '../errors.js';
import type { Tenant } from './tenant.js';

const MINUTE_MS = 60_000;

export interface QuotaUsage {
  readonly requestsInWindow: number;
  readonly tokensToday: number;
  /** UTC day the token counter belongs to, as `YYYY-MM-DD`. */
  readonly day: string;
}

interface Counters {
  /** Timestamps of the requests still inside the sliding window. */
  requests: number[];
  tokens: number;
  day: string;
}

export class QuotaTracker {
  private readonly counters = new Map<string, Counters>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Admit one request, or refuse it.
   *
   * @throws {QuotaExceededError} with the seconds to wait before retrying.
   */
  admit(tenant: Tenant): void {
    const at = this.now();
    const counters = this.countersFor(tenant.id, at);

    const daily = tenant.quotas.tokensPerDay;
    if (daily !== null && counters.tokens >= daily) {
      throw new QuotaExceededError(
        `tenant "${tenant.id}" has used its daily allowance of ${daily} tokens`,
        tenant.id,
        'tokens',
        daily,
        secondsUntilNextUtcDay(at),
      );
    }

    // Pruned unconditionally, before the unlimited case returns. A tenant with
    // no per-minute limit is the default — it is what parseQuotas returns for
    // a tenant with no quotas block, which is what "hushgate keys new" prints —
    // and retaining one timestamp per request for the life of the process
    // would grow the heap without bound in exactly the deployment that runs
    // longest.
    counters.requests = counters.requests.filter((stamp) => at - stamp < MINUTE_MS);

    const perMinute = tenant.quotas.requestsPerMinute;
    if (perMinute === null) {
      counters.requests.push(at);
      return;
    }

    if (counters.requests.length >= perMinute) {
      const oldest = counters.requests[0] ?? at;
      const waitMs = MINUTE_MS - (at - oldest);
      throw new QuotaExceededError(
        `tenant "${tenant.id}" is over its limit of ${perMinute} requests per minute`,
        tenant.id,
        'requests',
        perMinute,
        Math.max(1, Math.ceil(waitMs / 1000)),
      );
    }

    counters.requests.push(at);
  }

  /**
   * Record tokens the upstream reported.
   *
   * The count only exists once the response does, so the daily limit is
   * enforced on the request *after* the one that crossed it. That is a
   * deliberate trade: refusing to start a request costs a caller nothing,
   * whereas guessing token counts in advance would refuse work that was well
   * inside the budget.
   */
  recordTokens(tenantId: string, tokens: number): void {
    if (tokens <= 0) return;
    const counters = this.countersFor(tenantId, this.now());
    counters.tokens += tokens;
  }

  usage(tenantId: string): QuotaUsage {
    const at = this.now();
    const counters = this.countersFor(tenantId, at);
    return {
      requestsInWindow: counters.requests.filter((stamp) => at - stamp < MINUTE_MS).length,
      tokensToday: counters.tokens,
      day: counters.day,
    };
  }

  /** Forget everything. Used by tests and by a long-running process on reload. */
  reset(): void {
    this.counters.clear();
  }

  private countersFor(tenantId: string, at: number): Counters {
    const day = utcDay(at);
    let counters = this.counters.get(tenantId);

    if (counters === undefined) {
      counters = { requests: [], tokens: 0, day };
      this.counters.set(tenantId, counters);
    }

    if (counters.day !== day) {
      counters.tokens = 0;
      counters.day = day;
    }

    return counters;
  }
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function secondsUntilNextUtcDay(at: number): number {
  const next = Date.UTC(
    new Date(at).getUTCFullYear(),
    new Date(at).getUTCMonth(),
    new Date(at).getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - at) / 1000));
}
