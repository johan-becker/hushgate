/**
 * The trial page's sessions: a placeholder mapping that has to survive from the
 * preview to the reply, and no longer.
 *
 * The proxy mints a session per request and drops it, because a mapping back to
 * real personal data is a liability that should not outlive its use. The trial
 * cannot do that — the operator reads the sanitised text, thinks about it, and
 * only then presses Send — so the mapping is held, bounded on both axes: a
 * count and a clock. It never reaches disk, and it dies with the process.
 */
import { randomBytes } from 'node:crypto';
import type { Session } from '../redact/session.js';

const DEFAULT_MAX = 16;
const DEFAULT_TTL_MS = 30 * 60_000;
/** 16 bytes of base64url: long enough that guessing one is not a strategy. */
const ID_BYTES = 16;

export interface TrialSession {
  readonly id: string;
  readonly session: Session;
  readonly model: string;
  readonly createdAt: number;
}

export interface TrialStoreOptions {
  /** Most sessions held at once. The oldest goes first. */
  readonly max?: number;
  /** How long a session stays usable. */
  readonly ttlMs?: number;
  /** Injected so the tests do not wait half an hour. */
  readonly now?: () => number;
}

export class TrialStore {
  private readonly entries = new Map<string, TrialSession>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: TrialStoreOptions = {}) {
    this.max = options.max ?? DEFAULT_MAX;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.now ?? ((): number => Date.now());
  }

  create(session: Session, model: string): TrialSession {
    this.sweep();

    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }

    const entry: TrialSession = {
      id: randomBytes(ID_BYTES).toString('base64url'),
      session,
      model,
      createdAt: this.clock(),
    };

    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): TrialSession | undefined {
    this.sweep();
    return this.entries.get(id);
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.clock() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(id);
    }
  }
}
