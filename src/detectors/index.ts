import type { Detector, Span } from '../types.js';
import { creditCardDetector } from './creditcard.js';
import { createCustomDetectors, type CustomRule } from './custom.js';
import {
  createDictionaryDetector,
  toDictionaryEntries,
  type DictionaryEntry,
  type DictionaryInput,
} from './dictionary.js';
import { createDobDetector, defaultDobYearRange, type DobYearRange } from './dob.js';
import { emailDetector } from './email.js';
import { ibanDetector } from './iban.js';
import { ipv4Detector, ipv6Detector, macDetector } from './network.js';
import { normaliseForScan } from './normalise.js';
import { phoneDetector } from './phone.js';
import { resolveSpans } from './resolve.js';
import { secretDetector } from './secret.js';
import { germanTaxIdDetector } from './taxid.js';
import { urlCredentialsDetector } from './urlcredentials.js';

export { resolveSpans, overlaps } from './resolve.js';
export { creditCardDetector, hasIssuerPrefix, isValidCardNumber, luhnValid } from './creditcard.js';
export { createCustomDetector, createCustomDetectors, normaliseKindName } from './custom.js';
export { createDictionaryDetector, toDictionaryEntries } from './dictionary.js';
export { createDobDetector, defaultDobYearRange, isLeapYear, isRealDate } from './dob.js';
export { emailDetector, isValidEmail } from './email.js';
export { ibanChecksum, ibanDetector, IBAN_LENGTHS, isValidIban } from './iban.js';
export { ipv4Detector, ipv6Detector, isValidIpv4, isValidIpv6, macDetector } from './network.js';
export { normaliseForScan } from './normalise.js';
export { classifyPhone, phoneDetector } from './phone.js';
export { isJwtHeaderSegment, secretDetector } from './secret.js';
export {
  germanTaxIdDetector,
  hasValidDigitFrequency,
  isValidGermanTaxId,
  mod1110CheckDigit,
} from './taxid.js';
export { urlCredentialsDetector } from './urlcredentials.js';
export type { CustomRule } from './custom.js';
export type { NormalisedText } from './normalise.js';
export type { DictionaryEntry, DictionaryInput } from './dictionary.js';
export type { DobYearRange } from './dob.js';

/** How to assemble a detector set. */
export interface DetectorSetOptions {
  /** Names, customer names and project codenames to treat as personal data. */
  readonly dictionary?: DictionaryInput | readonly DictionaryEntry[];
  /** Named regexes from the config file. */
  readonly custom?: readonly CustomRule[];
  /** Birth-year window for the date-of-birth detector. */
  readonly dobYearRange?: DobYearRange;
}

/** The detectors that need no configuration. */
export const BUILTIN_DETECTORS: readonly Detector[] = [
  secretDetector,
  urlCredentialsDetector,
  ibanDetector,
  creditCardDetector,
  germanTaxIdDetector,
  emailDetector,
  ipv6Detector,
  ipv4Detector,
  macDetector,
  phoneDetector,
];

/**
 * Build the full detector list: the built-ins, a date-of-birth detector bound
 * to the configured year window, the dictionary and any custom rules.
 */
export function createDetectors(options: DetectorSetOptions = {}): Detector[] {
  const entries = Array.isArray(options.dictionary)
    ? (options.dictionary as DictionaryEntry[])
    : toDictionaryEntries(options.dictionary as DictionaryInput | undefined);

  return [
    ...BUILTIN_DETECTORS,
    createDobDetector(options.dobYearRange ?? defaultDobYearRange()),
    createDictionaryDetector(entries),
    ...createCustomDetectors(options.custom),
  ];
}

/**
 * Run every detector over `text` and resolve the result into disjoint spans.
 *
 * This is the only entry point callers should use: individual detectors return
 * *candidates*, and candidates overlap.
 *
 * Every detector sees the text twice: once as written, and once through
 * {@link normaliseForScan}, which drops invisible characters and folds
 * full-width and decomposed spellings. Detectors match on the raw string, so
 * without the second look a zero-width space between two letters is a complete
 * bypass — and the worst kind, because the value then leaves the machine
 * verbatim while the audit record says nothing was found.
 */
export function detect(text: string, detectors: readonly Detector[]): Span[] {
  const candidates: Span[] = [];
  // Appended one at a time rather than spread: `push(...spans)` passes every
  // span as a function argument, and a dense body can carry well over the
  // hundred thousand arguments an engine will accept — a 1 MB request, a
  // quarter of the default body limit, is enough to turn a normal request into
  // a RangeError that no HushgateError maps.
  for (const detector of detectors) {
    for (const span of detector.find(text)) candidates.push(span);
  }

  // The guard is load-bearing, not an optimisation: the second pass runs every
  // detector a second time, and the overwhelmingly common body is ASCII prose
  // where normalisation cannot change anything. Paying for it there would
  // double the cost of the proxy's hot path — a single-threaded event loop
  // shared with every other tenant — to find nothing. `changed` is decided by
  // one linear scan, so the ordinary request pays for that and no more.
  const norm = normaliseForScan(text);
  if (norm.changed) {
    // Two passes can report the same finding — a value that survives
    // normalisation untouched is found in both copies. `resolveSpans` would
    // collapse the pair anyway (it de-duplicates on range and kind), but the
    // candidate list is what a caller counts, so the double never gets made.
    const seen = new Set<string>();
    for (const span of candidates) seen.add(keyOf(span));

    for (const detector of detectors) {
      for (const span of detector.find(norm.text)) {
        const original = toOriginal(span, text, norm.offsets);
        if (original === null) continue;
        const key = keyOf(original);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(original);
      }
    }
  }

  return resolveSpans(candidates);
}

const keyOf = (span: Span): string =>
  `${span.start}:${span.end}:${span.kind}:${span.detector}`;

/**
 * Move a span found in the normalised copy back onto the original text.
 *
 * The value is re-sliced from the *original* string and never carried over
 * from the normalised one. That is the invariant the whole mechanism rests on:
 * rehydration replaces a placeholder with this exact string, so a value that
 * silently lost a soft hyphen or gained a composed umlaut would hand the user
 * back a document that is not the one they sent.
 *
 * Null when the mapped range is empty — which happens when a span covers only
 * part of an expansion, where the original has no character boundary to cut
 * at — or when a detector returned offsets outside the copy it was given.
 */
function toOriginal(span: Span, text: string, offsets: readonly number[]): Span | null {
  const start = offsets[span.start];
  const end = offsets[span.end];
  if (start === undefined || end === undefined || end <= start) return null;
  return { ...span, start, end, value: text.slice(start, end) };
}
