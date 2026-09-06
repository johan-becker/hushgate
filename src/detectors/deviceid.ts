/**
 * Hardware and installation identifiers: the IMEI a phone burns into its
 * baseband, and the UUID an application writes into its own storage the first
 * time it runs.
 *
 * One module because they answer the same question — *which device is this* —
 * and they are personal data for the same reason: neither is a name, and both
 * follow one person across every request the proxy will ever see. Under the
 * GDPR that is enough (Erwägungsgrund 30 says so about online identifiers in
 * as many words), which is why they are redacted rather than merely logged.
 */
import type { Detector, LabelProximity, Span } from '../types.js';
import { isValidCardNumber, luhnValid } from './creditcard.js';
import { isScanSeparator } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/**
 * Priority for `DEVICE_ID`, pending an entry in `DEFAULT_PRIORITIES` — this
 * module does not own `types.ts`.
 *
 * One below `CREDIT_CARD` (85), and the rank is the *second* line of defence,
 * not the first: {@link imeiDetector} refuses every run the card detector
 * accepts, so the two are disjoint by construction and the tie-break never has
 * to run. It is set below the card anyway because if some later change ever
 * did let them overlap, the reading that must win is the card — a PAN leaving
 * the building is a reportable incident, a mislabelled placeholder is not.
 */
export const DEVICE_ID_PRIORITY = 84;

/** Fourteen digits of TAC and serial, plus a Luhn check digit. */
const IMEI_LENGTH = 15;

/** An IMEI is exactly fifteen digits that agree with their own Luhn digit. */
export function isValidImei(digits: string): boolean {
  return digits.length === IMEI_LENGTH && luhnValid(digits);
}

/**
 * IMEI detector.
 *
 * Luhn is the whole evidence here, and Luhn alone accepts one fifteen-digit run
 * in ten. That is the cost this detector deliberately pays: the alternative is
 * the GSMA's Reporting Body Identifier table, which is not public in a form
 * this repository could ship without inventing it, and a half-remembered
 * subset of it would silently drop every device outside the guess. An operator
 * for whom the false positives cost more than the leak sets the `DEVICE_ID`
 * policy to `allow`; an operator for whom they do not gets every IMEI.
 *
 * Card numbers are excluded rather than out-ranked. A fifteen-digit Luhn-valid
 * run beginning 34 or 37 is an American Express PAN by every test the card
 * detector applies, and there is nothing in fifteen digits that could tell the
 * two apart — so this detector declines the whole class, the card detector
 * claims it, and the value is redacted exactly once either way.
 */
export const imeiDetector: Detector = {
  name: 'imei',
  priority: DEVICE_ID_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      if (!memberAt(text, i, isDigit) || isWordChar(text, i - 1)) {
        i += 1;
        continue;
      }

      // One more digit than an IMEI is collected, so that a sixteenth — even
      // one sitting behind a separator, as in `49 015420 323751 81` — makes the
      // run the wrong length instead of quietly truncating to a valid fifteen.
      const run = collectRun(text, i, isDigit, isScanSeparator, IMEI_LENGTH + 1);
      if (run.chars.length !== IMEI_LENGTH) {
        i += 1;
        continue;
      }

      const end = run.offsets.at(-1)! + 1;
      if (isWordChar(text, end) || !isValidImei(run.chars) || isValidCardNumber(run.chars)) {
        i += 1;
        continue;
      }

      out.push({
        start: i,
        end,
        kind: 'DEVICE_ID',
        value: text.slice(i, end),
        detector: 'imei',
        priority: DEVICE_ID_PRIORITY,
      });
      i = end;
    }

    return out;
  },
};

/**
 * The 8-4-4-4-12 shape, with the neighbours excluded that would make it part of
 * something longer.
 *
 * The dash is in both guards on purpose: without it the twelve-hex tail of a
 * UUID reads as a bare MAC address, and the eight-hex head as half of one.
 */
const UUID_PATTERN =
  /(?<![0-9A-Za-z_-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Za-z_-])/gu;

/**
 * The version and variant nibbles RFC 9562 actually issues.
 *
 * Two of the thirty-two hex characters in a UUID are not payload: the third
 * group opens with the version (1 through 8 — 4 for the random ones almost
 * everything emits, 7 for the time-ordered ones replacing them) and the fourth
 * with the variant, which for every UUID an RFC describes is 8, 9, a or b.
 * Those two positions are what separate a real identifier from thirty-two
 * arbitrary hex characters somebody hyphenated, and they are the reason
 * {@link uuidDetector} may fire with no label at all: the shape alone would
 * accept one hex blob in every eight.
 */
const RFC_UUID_PATTERN =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/u;

/** True when the version and variant nibbles are ones an RFC issues. */
export function isRfcUuid(value: string): boolean {
  return RFC_UUID_PATTERN.test(value);
}

/**
 * Every 8-4-4-4-12 run in `text`. Shared by both detectors below so the two can
 * never disagree about where a candidate starts and ends.
 */
function* candidates(text: string): Generator<{ start: number; end: number; value: string }> {
  const re = new RegExp(UUID_PATTERN.source, UUID_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    yield { start: match.index, end: match.index + match[0].length, value: match[0] };
  }
}

const spanAt = (
  candidate: { start: number; end: number; value: string },
  detector: string,
): Span => ({
  start: candidate.start,
  end: candidate.end,
  kind: 'DEVICE_ID',
  value: candidate.value,
  detector,
  priority: DEVICE_ID_PRIORITY,
});

/**
 * The words that license a hex blob whose version and variant say nothing.
 *
 * Declared once at module level, never rebuilt inside `find`: `labelNear`
 * caches the folded forms against this array's identity, so a fresh array per
 * call would repay the fold on every request.
 *
 * `GUID` is the uncomfortable one — folding drops the punctuation, so it also
 * matches inside `Guide` and `Guideline`. It is kept because the Microsoft
 * stacks that write non-RFC variants are exactly the ones that call them
 * GUIDs, and the cost is bounded: the value must still be thirty-two hex
 * characters grouped 8-4-4-4-12 at a token boundary.
 */
export const DEVICE_ID_LABELS: readonly string[] = [
  'UUID',
  'GUID',
  'Geräte-ID',
  'Gerätekennung',
  'Device ID',
  'Advertising ID',
  'IDFA',
  'IDFV',
  'Installations-ID',
  'Instanz-ID',
];

const LABEL_PROXIMITY: LabelProximity = { labels: DEVICE_ID_LABELS };

/**
 * UUIDs whose version and variant nibbles are ones an RFC issues.
 *
 * Reports unaccompanied, because those two nibbles are evidence the shape alone
 * is not — see {@link RFC_UUID_PATTERN}.
 */
export const uuidDetector: Detector = {
  name: 'uuid',
  priority: DEVICE_ID_PRIORITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (!isRfcUuid(candidate.value)) continue;
      out.push(spanAt(candidate, 'uuid'));
    }
    return out;
  },
};

/**
 * The same shape with a version or variant no RFC issues, gated on a label.
 *
 * Two detectors rather than one, because `requiresLabel` is enforced centrally
 * and per detector: it cannot say "unless the nibbles check out". The split is
 * disjoint by construction — this one skips exactly what the strict one
 * accepts — so a labelled, RFC-shaped UUID is still reported once.
 *
 * What it buys: the nil UUID that fills half the test fixtures in a support
 * ticket, the Microsoft GUIDs that carry variant c through f, and the hand-typed
 * ones whose nibbles were never right. Those are still identifiers, and the
 * writer's own label is what says so.
 */
export const labelledUuidDetector: Detector = {
  name: 'uuid-labelled',
  priority: DEVICE_ID_PRIORITY,
  requiresLabel: LABEL_PROXIMITY,

  find(text: string): Span[] {
    const out: Span[] = [];
    for (const candidate of candidates(text)) {
      if (isRfcUuid(candidate.value)) continue;
      out.push(spanAt(candidate, 'uuid-labelled'));
    }
    return out;
  },
};
