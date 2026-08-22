/**
 * The routes hushgate speaks. Each one names the provider it forwards to and
 * the traversal rules that describe where user content lives in its body.
 */
import { ANTHROPIC_MESSAGES_RULES, OPENAI_CHAT_RULES } from '../redact/shapes.js';
import type { PathRule } from '../redact/traverse.js';

export type ProviderId = 'openai' | 'anthropic';

export interface Route {
  /** Path the client calls, and the path forwarded to the upstream base URL. */
  readonly path: string;
  readonly provider: ProviderId;
  /** Where user content lives in this provider's request body. */
  readonly rules: readonly PathRule[];
  /** Stable name for audit records and metrics labels. */
  readonly label: string;
}

export const ROUTES: readonly Route[] = [
  {
    path: '/v1/chat/completions',
    provider: 'openai',
    rules: OPENAI_CHAT_RULES,
    label: 'openai.chat.completions',
  },
  {
    path: '/v1/messages',
    provider: 'anthropic',
    rules: ANTHROPIC_MESSAGES_RULES,
    label: 'anthropic.messages',
  },
];

export function findRoute(pathname: string): Route | undefined {
  return ROUTES.find((route) => route.path === pathname);
}
