/**
 * The briefing: what hushgate tells the model about the placeholders it is
 * about to read, so that a sanitised request still gets a usable answer.
 */
export {
  briefingContext,
  builtinBriefing,
  hasPlaceholders,
  type BriefingContext,
} from './text.js';
export {
  BRIEFING_MAX_LENGTH,
  briefingFor,
  defaultBriefingConfig,
  isBriefingMode,
  type BriefingConfig,
  type BriefingMode,
} from './policy.js';
export { attachBriefing } from './compose.js';
