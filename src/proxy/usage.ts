/**
 * Token accounting from what the provider reports.
 *
 * hushgate does not tokenise anything itself — it has no tokeniser, and
 * guessing would be worse than counting. Both providers report usage; this
 * reads whichever shape turned up, including the pieces an event stream
 * delivers separately (`message_start` carries the input tokens, `message_delta`
 * the output ones).
 */
import type { JsonValue } from '../redact/traverse.js';

/** Total tokens described by one JSON payload, or 0 when it describes none. */
export function tokensFrom(json: JsonValue): number {
  const usage = findUsage(json);
  if (usage === null) return 0;

  const total = numberAt(usage, 'total_tokens');
  if (total > 0) return total;

  return (
    numberAt(usage, 'prompt_tokens') +
    numberAt(usage, 'completion_tokens') +
    numberAt(usage, 'input_tokens') +
    numberAt(usage, 'output_tokens')
  );
}

/** `usage` at the top level, or one level down inside `message`. */
function findUsage(json: JsonValue): Record<string, JsonValue> | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;

  const direct = json['usage'];
  if (isObject(direct)) return direct;

  const message = json['message'];
  if (isObject(message) && isObject(message['usage'])) return message['usage'];

  return null;
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberAt(node: Record<string, JsonValue>, key: string): number {
  const value = node[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
