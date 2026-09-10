/**
 * Putting the briefing into a request body, without disturbing the caller's.
 *
 * Two rules govern everything here.
 *
 * The first is that the caller's own system prompt is untouchable. hushgate
 * adds a paragraph; it never replaces, reorders or edits a word of what the
 * application sent. An application whose persona quietly changed because a
 * proxy was installed in front of it would be a worse bug than the one this
 * module exists to fix.
 *
 * The second is about money, and it decides the position. Both providers cache
 * on a *prefix*: insert a paragraph at the head of a prompt and every cached
 * token behind it is invalidated, on every request, for as long as hushgate is
 * installed. So the briefing goes *after* the caller's system content — their
 * prefix stays byte-identical and stays cached, and an Anthropic caller's
 * `cache_control` breakpoint keeps covering exactly what it covered before.
 * Last position also happens to be where an instruction is followed best, so
 * the cheap choice and the effective one are the same choice.
 */
import type { ProviderId } from '../proxy/routes.js';
import type { JsonValue } from '../redact/traverse.js';

/**
 * Return `body` with `text` added as system guidance for `provider`.
 *
 * A body whose shape is not the one this provider documents is returned
 * untouched. hushgate is in the path of somebody's production traffic: a
 * request it does not fully understand is one it forwards unchanged, never one
 * it guesses at.
 */
export function attachBriefing(body: JsonValue, provider: ProviderId, text: string): JsonValue {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  return provider === 'anthropic' ? forAnthropic(body, text) : forOpenAi(body, text);
}

/**
 * OpenAI carries system guidance as a message, so the briefing becomes one and
 * is spliced in after the run of `system`/`developer` messages at the head of
 * the conversation — index 0 when there is none.
 */
function forOpenAi(body: { readonly [key: string]: JsonValue }, text: string): JsonValue {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return body;

  const messagesAfter = [...messages];
  messagesAfter.splice(leadingSystemMessages(messages), 0, { role: 'system', content: text });
  return { ...body, messages: messagesAfter };
}

/** How many messages at the head of the conversation are system guidance. */
function leadingSystemMessages(messages: readonly JsonValue[]): number {
  let index = 0;
  while (index < messages.length) {
    const role = roleOf(messages[index]);
    if (role !== 'system' && role !== 'developer') break;
    index += 1;
  }
  return index;
}

function roleOf(message: JsonValue | undefined): string | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const role = message['role'];
  return typeof role === 'string' ? role : null;
}

/**
 * Anthropic carries system guidance in a top-level field that is either a
 * string or a list of text blocks. Both shapes are preserved: a string request
 * stays a string request, a block request gains one block at the end.
 */
function forAnthropic(body: { readonly [key: string]: JsonValue }, text: string): JsonValue {
  const system = body['system'];

  if (system === undefined || system === null) return { ...body, system: text };
  if (typeof system === 'string') {
    return { ...body, system: system === '' ? text : `${system}\n\n${text}` };
  }
  if (Array.isArray(system)) return { ...body, system: [...system, { type: 'text', text }] };

  // Neither shape the API documents. Forward it exactly as it came in.
  return body;
}
