/**
 * Whether a briefing is attached, and which words it uses.
 *
 * The operator owns this. hushgate ships a briefing that works, and an
 * operator who needs different words — a house style, a second language, a
 * standing instruction their team already relies on — can replace or extend it
 * from the config file without patching the package. That escape hatch is
 * deliberately small: a mode, a replacement, an addition. It is not a template
 * language, and nothing a caller sends can reach it.
 */
import type { Finding } from '../types.js';
import { briefingContext, builtinBriefing, hasPlaceholders } from './text.js';

/**
 * When to attach the briefing.
 *
 * - `auto` — whenever the outgoing request actually carries a placeholder.
 *   Nothing was redacted, nothing is explained, and nothing is billed.
 * - `always` — on every request the proxy forwards. For an operator who would
 *   rather the model's behaviour not depend on what a detector happened to
 *   find.
 * - `off` — never. The request goes out exactly as the caller wrote it.
 */
export type BriefingMode = 'auto' | 'always' | 'off';

const MODES: readonly BriefingMode[] = ['auto', 'always', 'off'];

export function isBriefingMode(value: string): value is BriefingMode {
  return (MODES as readonly string[]).includes(value);
}

/**
 * Longest custom briefing accepted from a config file.
 *
 * Generous for house rules, and far short of the size at which an operator has
 * quietly moved their application's prompt into the proxy.
 */
export const BRIEFING_MAX_LENGTH = 4000;

export interface BriefingConfig {
  readonly mode: BriefingMode;
  /** Replaces the built-in text outright, or `null` to keep it. */
  readonly text: string | null;
  /** House rules added after whichever text is used, or `null`. */
  readonly append: string | null;
}

/**
 * On by default, and only where it applies.
 *
 * `auto` rather than `always` because on a request nothing was found in, the
 * briefing describes tokens that are not there — inert text the operator pays
 * for on every call.
 */
export function defaultBriefingConfig(): BriefingConfig {
  return { mode: 'auto', text: null, append: null };
}

/**
 * The exact text to attach to one request, or `null` for none.
 *
 * `findings` are this request's, so the built-in text names only the kinds
 * actually in front of the model. A custom `text` gets no such treatment: an
 * operator who replaces the words has taken responsibility for all of them.
 */
export function briefingFor(config: BriefingConfig, findings: readonly Finding[]): string | null {
  if (config.mode === 'off') return null;

  const context = briefingContext(findings);
  if (config.mode === 'auto' && !hasPlaceholders(context)) return null;

  const base = config.text ?? builtinBriefing(context);
  return config.append === null ? base : `${base}\n\n${config.append}`;
}
