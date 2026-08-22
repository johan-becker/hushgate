/**
 * Where the *incremental* text lives in a streaming response.
 *
 * These differ from the request shapes: a streaming chunk carries fragments of
 * a value rather than the value itself, so each of these paths needs a
 * re-hydrator with memory across events, while every other string in the event
 * is complete and can be substituted on the spot.
 */
import type { PathRule } from '../redact/traverse.js';

/** OpenAI `chat.completion.chunk` events. */
export const OPENAI_STREAM_DELTAS: readonly PathRule[] = [
  'choices.*.delta.content',
  'choices.*.delta.refusal',
  'choices.*.delta.tool_calls.*.function.arguments',
  'choices.*.text',
];

/** Anthropic `content_block_delta` events, text and partial JSON alike. */
export const ANTHROPIC_STREAM_DELTAS: readonly PathRule[] = [
  'delta.text',
  'delta.partial_json',
  'content_block.text',
];
