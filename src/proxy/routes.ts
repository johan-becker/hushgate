/**
 * The routes hushgate speaks. Each one names the provider it forwards to and
 * the traversal rules that describe where user content lives in its body.
 */
import { ANTHROPIC_MESSAGES_RULES, OPENAI_CHAT_RULES } from '../redact/shapes.js';
import type { PathRule } from '../redact/traverse.js';
import { ANTHROPIC_STREAM_DELTAS, OPENAI_STREAM_DELTAS } from '../stream/shapes.js';

export type ProviderId = 'openai' | 'anthropic';

export interface Route {
  /** Path the client calls, and the path forwarded to the upstream base URL. */
  readonly path: string;
  readonly provider: ProviderId;
  /** Where user content lives in this provider's request body. */
  readonly rules: readonly PathRule[];
  /** Where the *incremental* text lives in this provider's SSE events. */
  readonly streamRules: readonly PathRule[];
  /** Stable name for audit records and metrics labels. */
  readonly label: string;
}

export const ROUTES: readonly Route[] = [
  {
    path: '/v1/chat/completions',
    provider: 'openai',
    rules: OPENAI_CHAT_RULES,
    streamRules: OPENAI_STREAM_DELTAS,
    label: 'openai.chat.completions',
  },
  {
    path: '/v1/messages',
    provider: 'anthropic',
    rules: ANTHROPIC_MESSAGES_RULES,
    streamRules: ANTHROPIC_STREAM_DELTAS,
    label: 'anthropic.messages',
  },
];

/**
 * Every label {@link ROUTES} serves, in one place because the config parser has
 * to reject a residency rule naming a route hushgate does not have. Derived
 * from ROUTES rather than written out again: two lists would drift, and the
 * drift would show up as a rule that silently enforces nothing.
 */
export const ROUTE_LABELS: readonly string[] = ROUTES.map((route) => route.label);

export function findRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route.path === pathname);
}
