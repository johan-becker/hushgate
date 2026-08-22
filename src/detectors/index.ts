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
 */
export function detect(text: string, detectors: readonly Detector[]): Span[] {
  const candidates: Span[] = [];
  for (const detector of detectors) candidates.push(...detector.find(text));
  return resolveSpans(candidates);
}
