import type { Detector, Span } from '../types.js';
import { createPostalAddressDetector, type PostalAddressOptions } from './address.js';
import { createBankAccountDetectors, type BankAccountOptions } from './bankaccount.js';
import { createBicDetector, type BicOptions } from './bic.js';
import { commercialRegisterDetector } from './commercialregister.js';
import { creditCardDetector } from './creditcard.js';
import { createCustomDetectors, type CustomRule } from './custom.js';
import { imeiDetector, labelledUuidDetector, uuidDetector } from './deviceid.js';
import {
  createDictionaryDetector,
  toDictionaryEntries,
  type DictionaryEntry,
  type DictionaryInput,
  type DictionaryOptions,
} from './dictionary.js';
import { decodeCopies } from './decode.js';
import { createDobDetector, defaultDobYearRange, type DobYearRange } from './dob.js';
import { driverLicenceDetector } from './driverlicence.js';
import { emailDetector } from './email.js';
import {
  createIcd10Detectors,
  createMedicationDetector,
  type Icd10Options,
  type MedicationOptions,
} from './health.js';
import { healthInsuranceDetector, healthInsuranceLabelDetector } from './healthinsurance.js';
import { ibanDetector } from './iban.js';
import { germanIdDocumentDetector } from './idcard.js';
import { ipv4Detector, ipv6Detector, macDetector } from './network.js';
import {
  labelNear,
  normaliseForScan,
  SCAN_PROFILES,
  type NormalisedText,
} from './normalise.js';
import { phoneDetector } from './phone.js';
import { createPostcodeDetector, type PostcodeOptions } from './postcode.js';
import { resolveSpans } from './resolve.js';
import { secretDetector } from './secret.js';
import { createSessionTokenDetector, type SessionTokenOptions } from './sessiontoken.js';
import { socialSecurityDetector } from './socialsecurity.js';
import { steuernummerDetector } from './steuernummer.js';
import { germanTaxIdDetector } from './taxid.js';
import { urlCredentialsDetector } from './urlcredentials.js';
import { createVatIdDetector, type VatIdOptions } from './vatid.js';
import { createVehiclePlateDetectors, type VehiclePlateOptions } from './vehicleplate.js';

export { resolveSpans, overlaps } from './resolve.js';
export {
  createPostalAddressDetector,
  postalAddressDetector,
  NON_ADDRESS_WORDS,
  POSTAL_ADDRESS_LABELS,
  POSTAL_ADDRESS_PRIORITY,
  STRONG_STREET_SUFFIXES,
  WEAK_STREET_SUFFIXES,
} from './address.js';
export {
  bicDetector,
  createBicDetector,
  isBicShaped,
  BIC_KIND,
  BIC_PRIORITY,
  DEFAULT_BIC_HOME_COUNTRIES,
  ISO_3166_ALPHA2,
} from './bic.js';
export {
  ACCOUNT_LABELS,
  BANK_ACCOUNT_KIND,
  BANK_ACCOUNT_PRIORITY,
  BANK_CODE_LABELS,
  bankAccountDetectors,
  createBankAccountDetectors,
  isValidAbaRouting,
  ROUTING_LABELS,
  SORT_CODE_LABELS,
  type BankAccountOptions,
} from './bankaccount.js';
export {
  bankCodeMethod,
  checkDigitValid,
  isKnownBankCode,
  isValidGermanAccountNumber,
  IMPLEMENTED_CHECK_DIGIT_METHODS,
  LIVE_CHECK_DIGIT_METHODS,
} from './bankcheckdigit.js';
export { commercialRegisterDetector, COMMERCIAL_REGISTER_PRIORITY } from './commercialregister.js';
export { creditCardDetector, hasIssuerPrefix, isValidCardNumber, luhnValid } from './creditcard.js';
export { createCustomDetector, createCustomDetectors, normaliseKindName } from './custom.js';
export {
  imeiDetector,
  isRfcUuid,
  isValidImei,
  labelledUuidDetector,
  uuidDetector,
  DEVICE_ID_LABELS,
  DEVICE_ID_PRIORITY,
} from './deviceid.js';
export { createDictionaryDetector, toDictionaryEntries, withinEditDistanceOne, FUZZY_MIN_LENGTH } from './dictionary.js';
export { createDobDetector, defaultDobYearRange, isLeapYear, isRealDate } from './dob.js';
export {
  driverLicenceDetector,
  isDriverLicenceShape,
  DRIVER_LICENCE_LABELS,
  DRIVER_LICENCE_PRIORITY,
} from './driverlicence.js';
export { emailDetector, isValidEmail } from './email.js';
export {
  createIcd10Detectors,
  createMedicationDetector,
  canonicalIcd10,
  icd10Detector,
  isIcd10Shaped,
  labelledIcd10Detector,
  medicationDetector,
  ICD10_BLOCKED_PREFIX_WORDS,
  ICD10_LABELS,
  ICD_CODE_KIND,
  ICD_CODE_PRIORITY,
  MEDICATION_KIND,
  MEDICATION_PRIORITY,
  SEED_ICD10_CODES,
  SEED_MEDICATION_NAMES,
} from './health.js';
export {
  healthInsuranceCheckDigit,
  healthInsuranceDetector,
  healthInsuranceLabelDetector,
  isValidHealthInsuranceNumber,
  HEALTH_INSURANCE_LABELS,
  HEALTH_INSURANCE_PRIORITY,
} from './healthinsurance.js';
export { ibanChecksum, ibanDetector, IBAN_LENGTHS, isValidIban } from './iban.js';
export {
  germanDocumentKind,
  germanIdDocumentDetector,
  icaoCheckDigit,
  readGermanDocumentSerial,
  GERMAN_DOCUMENT_LETTERS,
  GERMAN_ID_DOCUMENT_LABELS,
  ID_DOCUMENT_PRIORITY,
} from './idcard.js';
export { ipv4Detector, ipv6Detector, isValidIpv4, isValidIpv6, macDetector, MAC_LABELS } from './network.js';
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
export {
  createPostcodeDetector,
  isPostcodeShaped,
  postcodeDetector,
  DEFAULT_POSTCODE_PREFIXES,
  POSTCODE_KIND,
  POSTCODE_LABELS,
  POSTCODE_PRIORITY,
  SEED_PLACE_NAMES,
} from './postcode.js';
export { isJwtHeaderSegment, secretDetector } from './secret.js';
export {
  createSessionTokenDetector,
  sessionTokenDetector,
  SESSION_COOKIE_NAMES,
  SESSION_COOKIE_PREFIXES,
  SESSION_TOKEN_PRIORITY,
} from './sessiontoken.js';
export {
  isValidSocialSecurityNumber,
  socialSecurityCheckDigit,
  socialSecurityDetector,
  SOCIAL_SECURITY_PRIORITY,
} from './socialsecurity.js';
export {
  isSteuernummerLayout,
  steuernummerDetector,
  GERMAN_TAX_NUMBER_PRIORITY,
  STEUERNUMMER_LABELS,
  STEUERNUMMER_LAYOUTS,
} from './steuernummer.js';
export {
  germanTaxIdDetector,
  hasValidDigitFrequency,
  isValidGermanTaxId,
  mod1110CheckDigit,
} from './taxid.js';
export { urlCredentialsDetector } from './urlcredentials.js';
export {
  createVatIdDetector,
  isValidGermanVatId,
  vatIdDetector,
  EU_VAT_ID_KIND,
  EU_VAT_ID_PRIORITY,
  VAT_ID_RULES,
} from './vatid.js';
export {
  createVehiclePlateDetectors,
  labelledVehiclePlateDetector,
  vehiclePlateDetector,
  GERMAN_PLATE_DISTRICTS,
  VEHICLE_PLATE_KIND,
  VEHICLE_PLATE_LABELS,
  VEHICLE_PLATE_PRIORITY,
} from './vehicleplate.js';
export type { CustomRule } from './custom.js';
export type { NormalisedText, NormaliseOptions } from './normalise.js';
export type { DictionaryEntry, DictionaryInput, DictionaryOptions } from './dictionary.js';
export type { DobYearRange } from './dob.js';
export type { PostalAddressOptions } from './address.js';
export type { BicOptions } from './bic.js';
export type { Icd10Options, MedicationOptions } from './health.js';
export type { PostcodeOptions } from './postcode.js';
export type { SessionTokenOptions } from './sessiontoken.js';
export type { VatIdOptions } from './vatid.js';
export type { VehiclePlateDetectors, VehiclePlateOptions } from './vehicleplate.js';

/**
 * How to assemble a detector set.
 *
 * Every field is a *narrowing* of something hushgate already knows: the seed
 * lists in the detector files are what a German company sees without being
 * asked, and an option here is how an operator says what their own company
 * sees. None of them has to be set for the detector to run — an unset group
 * means the seeded behaviour, not a disabled detector — because a customer who
 * never opens the config file must still be protected.
 */
export interface DetectorSetOptions {
  /** Names, customer names and project codenames to treat as personal data. */
  readonly dictionary?: DictionaryInput | readonly DictionaryEntry[];
  /**
   * How the dictionary matches. `fuzzy` is off by default and deliberately so:
   * it walks the entry list per candidate token, which is affordable for one
   * tenant's address book and not for every request on a shared event loop.
   */
  readonly dictionaryMatching?: DictionaryOptions;
  /** Named regexes from the config file. */
  readonly custom?: readonly CustomRule[];
  /** Birth-year window for the date-of-birth detector. */
  readonly dobYearRange?: DobYearRange;
  /** Which countries' VAT identifiers to read, and whether to demand DE's check digit. */
  readonly vatId?: VatIdOptions;
  /** Which countries a bare BIC may name. */
  readonly bic?: BicOptions;
  /** Country prefixes and place names that license a postcode. */
  readonly postcode?: PostcodeOptions;
  /** Labels, and a bank code table newer than the shipped Bundesbank snapshot. */
  readonly bankAccount?: BankAccountOptions;
  /** District codes a plate may open with. */
  readonly vehiclePlate?: VehiclePlateOptions;
  /** Cookie and header names whose value is a session token. */
  readonly sessionToken?: SessionTokenOptions;
  /** Street suffixes, labels and the postcode oracle a street line is read against. */
  readonly postalAddress?: PostalAddressOptions;
  /** The ICD-10 catalogue to accept, and the words that block a code. */
  readonly icd10?: Icd10Options;
  /** Medication names, and whether a dosage has to stand next to them. */
  readonly medication?: MedicationOptions;
}

/**
 * The detectors that need no configuration, in descending priority.
 *
 * "Needs no configuration" is the only criterion for being in this list — not
 * "is safe", not "is cheap". Everything hushgate can find, it finds by default:
 * a customer who installs the proxy and sends a request has already told us
 * everything we need to know about their intent, and a detector that is off
 * until someone edits a YAML file is a detector that is off on the day it
 * mattered. The configurable ones in {@link createDetectors} run by default
 * too, on their seed lists; their options narrow them, never enable them.
 *
 * The paired entries — a strict detector and a `requiresLabel` one over the
 * same format — are two detectors rather than one because `requiresLabel` is
 * all-or-nothing per detector: the strong spelling is reported unaccompanied,
 * the weak spelling only next to its label.
 */
export const BUILTIN_DETECTORS: readonly Detector[] = [
  secretDetector,
  urlCredentialsDetector,
  ibanDetector,
  creditCardDetector,
  imeiDetector,
  uuidDetector,
  labelledUuidDetector,
  germanTaxIdDetector,
  socialSecurityDetector,
  germanIdDocumentDetector,
  healthInsuranceDetector,
  healthInsuranceLabelDetector,
  steuernummerDetector,
  emailDetector,
  commercialRegisterDetector,
  driverLicenceDetector,
  ipv6Detector,
  ipv4Detector,
  macDetector,
  phoneDetector,
];

/**
 * Build the full detector list: the built-ins, the configurable detectors bound
 * to whatever the operator narrowed them to, the dictionary and any custom
 * rules.
 *
 * Detector order does not decide anything — `resolveSpans` is total and
 * order-independent by construction — so the list is written in descending
 * priority purely so that a reader can check it against `DEFAULT_PRIORITIES`.
 */
export function createDetectors(options: DetectorSetOptions = {}): Detector[] {
  const entries = Array.isArray(options.dictionary)
    ? (options.dictionary as DictionaryEntry[])
    : toDictionaryEntries(options.dictionary as DictionaryInput | undefined);

  const [icd10Detector, labelledIcd10Detector] = createIcd10Detectors(options.icd10);
  const plates = createVehiclePlateDetectors(options.vehiclePlate);

  return [
    ...BUILTIN_DETECTORS,
    createSessionTokenDetector(options.sessionToken),
    createVatIdDetector(options.vatId),
    icd10Detector,
    labelledIcd10Detector,
    createMedicationDetector(options.medication),
    createBicDetector(options.bic),
    createPostalAddressDetector(options.postalAddress),
    createDobDetector(options.dobYearRange ?? defaultDobYearRange()),
    plates.plate,
    plates.labelled,
    createPostcodeDetector(options.postcode),
    ...createBankAccountDetectors(options.bankAccount),
    ...createCustomDetectors(options.custom),
    createDictionaryDetector(entries, options.dictionaryMatching),
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

  // A span that reaches here has passed its gate — `labelSatisfied` is the only
  // way into `candidates`. Carrying the gate out of the front door would tell a
  // caller that a question is still open when it has been answered, which is
  // the same kind of misleading record as an audit line that under-reports.
  // Rebuilt only for the spans that actually carry one, so the common body pays
  // a property read per finding and nothing else.
  const resolved = resolveSpans(candidates);
  for (let i = 0; i < resolved.length; i++) {
    const span = resolved[i]!;
    if (span.requiresLabel === undefined) continue;
    const { requiresLabel: _satisfied, ...rest } = span;
    resolved[i] = rest;
  }
  return resolved;
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
  yield normaliseForScan(text, SCAN_PROFILES.shredded);
  yield* decodeCopies(text);
}

/**
 * Central enforcement of {@link Detector.requiresLabel} and
 * {@link Span.requiresLabel}.
 *
 * Weak numeric formats — the eleven digits of a Steuer-ID, the ten of a KVNR,
 * the fifteen of an IMEI — are only safe to report when their label is next to
 * them, and a detector that has to remember to check that itself is a detector
 * that will one day forget. Detectors that declare nothing are not touched, and
 * pay one property read.
 *
 * The span's own declaration wins, which is what lets one detector emit a
 * strong spelling and a weak one from a single pass over the text rather than
 * one pass each.
 */
function labelSatisfied(detector: Detector, text: string, span: Span): boolean {
  const proximity = span.requiresLabel ?? detector.requiresLabel;
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
