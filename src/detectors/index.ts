import type { Detector, Span } from '../types.js';
import { creditCardDetector } from './creditcard.js';
import { createCustomDetectors, type CustomRule } from './custom.js';
import {
  createDictionaryDetector,
  toDictionaryEntries,
  type DictionaryEntry,
  type DictionaryInput,
} from './dictionary.js';
import { decodeCopies } from './decode.js';
import { createDobDetector, defaultDobYearRange, type DobYearRange } from './dob.js';
import { emailDetector } from './email.js';
import { ibanDetector } from './iban.js';
import { ipv4Detector, ipv6Detector, macDetector } from './network.js';
import {
  labelNear,
  normaliseForScan,
  SCAN_PROFILES,
  type NormalisedText,
} from './normalise.js';
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
export {
  foldForCompare,
  isScanSeparator,
  labelNear,
  normaliseForScan,
  SCAN_PROFILES,
} from './normalise.js';
export {
  decodeBase64Text,
  decodeBase64Runs,
  decodeCopies,
  decodeHtmlEntities,
  decodePercentRuns,
  isBase64Shaped,
} from './decode.js';
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
export type { NormalisedText, NormaliseOptions } from './normalise.js';
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
 * Detectors match the raw string, so any rewriting of a value that a reader
 * still recognises is a complete bypass — and the worst kind, because the value
 * then leaves the machine verbatim while the audit record says nothing was
 * found. So every detector sees the text as written, and then again through
 * each *scan copy* that applies: one fold family per copy, each with an offset
 * map that puts a span found in it back onto the exact original characters.
 *
 * THE COST ARGUMENT, which is the reason this is written the way it is: a copy
 * only costs anything if its detectors run, and its detectors only run if the
 * fold actually changed the text. Every fold is therefore *aimed*, and the aim
 * is chosen so that ordinary prose changes nothing:
 *
 *  - invisibles and NFKC change nothing in ASCII, which is decided by one
 *    linear scan (`\P{ASCII}`);
 *  - the look-alike copy folds Cyrillic and Greek twins, which German prose
 *    does not contain, and diacritics only inside tokens holding an `@`, so
 *    `Grüße aus München` still produces no copy;
 *  - the identifier copy folds separators and case only inside runs that are at
 *    least nine alphanumerics and six digits of mostly-digit groups, so a date,
 *    a price and a sentence produce nothing;
 *  - the word-shape copy folds leetspeak only inside mostly-letter tokens, and
 *    splits or collapses only at shapes prose does not have;
 *  - the decode copies do nothing unless the text carries a base64 blob of the
 *    right length and alphabet, a `%XX` escape or a character reference.
 *
 * An ASCII prose body therefore pays exactly what it paid before this existed:
 * one detector pass plus a handful of linear scans. A body written to evade
 * pays one extra pass per fold family it actually triggers — at most seven, and
 * only for text that already looks like an attack. A copy whose text a previous
 * copy already produced is skipped outright, which is what keeps two folds that
 * happen to agree from costing two passes.
 */
export function detect(text: string, detectors: readonly Detector[]): Span[] {
  const candidates: Span[] = [];
  // Two copies can report the same finding — a value that survives a fold
  // untouched is found in both. `resolveSpans` would collapse the pair anyway
  // (it de-duplicates on range and kind), but the candidate list is what a
  // caller counts, so the double never gets made.
  const seen = new Set<string>();

  // Appended one at a time rather than spread: `push(...spans)` passes every
  // span as a function argument, and a dense body can carry well over the
  // hundred thousand arguments an engine will accept — a 1 MB request, a
  // quarter of the default body limit, is enough to turn a normal request into
  // a RangeError that no HushgateError maps.
  for (const detector of detectors) {
    for (const span of detector.find(text)) {
      if (!labelSatisfied(detector, text, span)) continue;
      const key = keyOf(span);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(span);
    }
  }

  const scanned = new Set<string>([text]);
  for (const copy of scanCopies(text)) {
    if (!copy.changed || scanned.has(copy.text)) continue;
    scanned.add(copy.text);

    for (const detector of detectors) {
      for (const span of detector.find(copy.text)) {
        // The label is looked for in the copy, not in the original: a span the
        // identifier copy found is a span whose label may only be legible
        // there too.
        if (!labelSatisfied(detector, copy.text, span)) continue;
        const original = toOriginal(span, text, copy.offsets);
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

/**
 * The scan copies, in the order they are tried.
 *
 * A generator rather than an array: a copy that is never reached is never
 * built, and the ones that are built are dropped again as soon as their pass is
 * over rather than all being held at once for a body that may be megabytes.
 */
function* scanCopies(text: string): Generator<NormalisedText> {
  yield normaliseForScan(text, SCAN_PROFILES.unicode);
  yield normaliseForScan(text, SCAN_PROFILES.skeleton);
  yield normaliseForScan(text, SCAN_PROFILES.identifier);
  yield normaliseForScan(text, SCAN_PROFILES.wordShape);
  yield* decodeCopies(text);
}

/**
 * Central enforcement of {@link Detector.requiresLabel}.
 *
 * Weak numeric formats — the eleven digits of a Steuer-ID, the ten of a KVNR,
 * the fifteen of an IMEI — are only safe to report when their label is next to
 * them, and a detector that has to remember to check that itself is a detector
 * that will one day forget. Detectors that declare nothing are not touched, and
 * pay one property read.
 */
function labelSatisfied(detector: Detector, text: string, span: Span): boolean {
  const proximity = detector.requiresLabel;
  if (proximity === undefined) return true;
  return labelNear(text, span.start, span.end, proximity);
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
