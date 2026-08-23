/**
 * Which parts of a provider request body carry user content.
 *
 * These rule sets are the difference between "redact the JSON" and "redact the
 * conversation". Model names, tool identifiers, `stream`, `max_tokens` and the
 * dozens of other knobs a request carries are left exactly as the caller sent
 * them; the prose, the tool arguments and the tool schemas are not.
 */
import type { PathRule } from './traverse.js';

/**
 * OpenAI `POST /v1/chat/completions`.
 *
 * `messages[].content` is either a string or an array of content parts, so both
 * shapes are listed. Tool call arguments are a JSON *string*; redacting it as
 * text is safe because a placeholder contains no character that JSON escapes,
 * and the model's reply is re-hydrated the same way.
 *
 * Image parts are deliberately absent: a `data:` URL is megabytes of base64 that
 * no detector can validate anything in, and scanning it would only burn time.
 */
export const OPENAI_CHAT_RULES: readonly PathRule[] = [
  'messages.*.content',
  'messages.*.content.*.text',
  'messages.*.content.*.input_text',
  'messages.*.name',
  'messages.*.refusal',
  'messages.*.tool_calls.*.function.arguments',
  'messages.*.function_call.arguments',
  'tools.*.function.description',
  'tools.*.function.parameters.**',
  'functions.*.description',
  'functions.*.parameters.**',
];

/**
 * Anthropic `POST /v1/messages`.
 *
 * `system` is a string or an array of text blocks; `content` blocks may be text,
 * tool_use (arbitrary JSON input, hence `**`) or tool_result (whose `content` is
 * itself a string or a block array). `metadata.user_id` is included because
 * callers routinely put an e-mail address there.
 */
export const ANTHROPIC_MESSAGES_RULES: readonly PathRule[] = [
  'system',
  'system.*.text',
  'messages.*.content',
  'messages.*.content.*.text',
  // A "custom content" document carries blocks of text the caller extracted
  // themselves. Nothing else reaches inside `source`, so without these two the
  // document body is forwarded verbatim — and it is a document, so it is
  // exactly the kind of text that carries names and account numbers.
  'messages.*.content.*.source.content',
  'messages.*.content.*.source.content.*.text',
  'messages.*.content.*.content',
  'messages.*.content.*.content.*.text',
  'messages.*.content.*.input.**',
  'tools.*.description',
  'tools.*.input_schema.**',
  'metadata.user_id',
];
