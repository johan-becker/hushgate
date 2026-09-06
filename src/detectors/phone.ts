import { DEFAULT_PRIORITIES, type Detector, type LabelProximity, type Span } from '../types.js';
import { labelNear } from './normalise.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/** '00' + 15 digits is the longest thing E.164 can produce. */
const MAX_DIGITS = 17;
const MIN_NATIONAL_DIGITS = 6;
const MAX_NATIONAL_DIGITS = 13;
const MIN_SUBSCRIBER_DIGITS = 8;
const MAX_SUBSCRIBER_DIGITS = 15;

/**
 * Separators German writers actually use. `.` is deliberately absent: allowing
 * it would make `01.02.1990` a phone number and steal the span from the
 * date-of-birth detector.
 */
const isSeparator = (ch: string): boolean =>
  ch === ' ' || ch === '-' || ch === '/' || ch === '(' || ch === ')';

export type PhoneForm = 'e164' | 'international-00' | 'german-national';

export interface PhoneClassification {
  readonly form: PhoneForm;
  /** Digits only, with the trunk-prefix `(0)` removed. */
  readonly digits: string;
}

/**
 * Decide whether a normalised digit string is a plausible phone number, and in
 * which notation it was written.
 */
export function classifyPhone(raw: string): PhoneClassification | null {
  const withoutTrunk = raw.replaceAll('(0)', '');
  const plus = withoutTrunk.trimStart().startsWith('+');
  const digits = withoutTrunk.replaceAll(/\D/gu, '');

  if (plus) {
    const ok =
      digits.length >= MIN_SUBSCRIBER_DIGITS &&
      digits.length <= MAX_SUBSCRIBER_DIGITS &&
      !digits.startsWith('0');
    return ok ? { form: 'e164', digits } : null;
  }

  if (digits.startsWith('00')) {
    const subscriber = digits.slice(2);
    const ok =
      subscriber.length >= MIN_SUBSCRIBER_DIGITS &&
      subscriber.length <= MAX_SUBSCRIBER_DIGITS &&
      !subscriber.startsWith('0');
    return ok ? { form: 'international-00', digits } : null;
  }

  if (digits.startsWith('0')) {
    const ok =
      digits.length >= MIN_NATIONAL_DIGITS &&
      digits.length <= MAX_NATIONAL_DIGITS &&
      digits[1] !== '0';
    return ok ? { form: 'german-national', digits } : null;
  }

  return null;
}

/**
 * Words that license a number carrying no notation of its own.
 *
 * An undecorated run of digits is the weakest evidence in the whole detector
 * set: `02476291358` is equally a mobile number, a Steuer-ID with a broken
 * check digit, a customer number and an order reference, and `5551234567` is
 * equally a Los Angeles number and a ten-digit SKU. What decides is the word in
 * front of it, so the bare forms are gated on one of these while every form
 * that carries its own evidence — a `+`, a `00`, parentheses, an internal
 * separator — still fires unaccompanied.
 *
 * Only labels that are not substrings of one another are listed: the comparison
 * folds punctuation away and asks for containment, so `Tel` already covers
 * `Tel.`, `Telefon`, `Telefonnummer` and `telephone`. The cost of a
 * three-letter label is that `Tel` also matches inside `Hotel` and `Stelle`;
 * that is bounded, because the most a false label can do is admit a run that
 * already had to be six to thirteen digits at a token boundary.
 *
 * Declared once at module level, never inside `find`: `labelNear` caches the
 * folded forms against this array's identity.
 */
export const PHONE_LABELS: readonly string[] = [
  'Tel',
  'Mobil',
  'Handy',
  'Fax',
  'Festnetz',
  'Rufnummer',
  'Durchwahl',
  'anruf',
  'erreichbar',
  'phone',
  'cell',
  'call',
  'hotline',
  'toll free',
  'Kontakt',
  'contact',
];

const PHONE_PROXIMITY: LabelProximity = { labels: PHONE_LABELS };

interface PhoneRun {
  readonly raw: string;
  readonly end: number;
  readonly digitCount: number;
  /** True when a `(` sitting before the run was closed inside it. */
  readonly consumedOpenParen: boolean;
}

/**
 * Is this run of separator characters one separator, or the gap between two
 * different numbers?
 *
 * A single character always separates. Longer runs separate only when they
 * carry exactly one piece of punctuation — `(0)` and the spaced ` / ` and ` - `
 * forms German writers use — never when they are nothing but whitespace, which
 * is what keeps `0721 1234567  0721 7654321` two numbers rather than one.
 */
function isSeparatorRun(run: string): boolean {
  if (run.length === 1) return true;
  if (run.includes('(') || run.includes(')')) return true;
  return run.replaceAll(' ', '').length === 1;
}

/** Longest separator run that can still be one separator: `' / '`. */
const MAX_SEPARATOR_RUN = 3;

/**
 * True when a scan beginning one character earlier would have swallowed this
 * position, i.e. the candidate is the interior of a longer digit-and-separator
 * sequence rather than its start.
 *
 * This is the whole answer to the over-claim. Without it the detector starts at
 * the `0` of `49-015420-323751-8` and reports the tail, so `49-` — the head of
 * an IMEI — goes upstream in the clear while the audit record says one finding
 * was redacted. Partial redaction that reports success is strictly worse than a
 * clean miss: nobody goes looking for the half that leaked. Same for the `0123`
 * inside `3012 0123 4567` and the `023` inside `555-023-4567`.
 *
 * The backward test is the mirror image of {@link isSeparatorRun}, so a gap the
 * forward scan treats as the end of a number is a gap here too — which is what
 * keeps the second half of `0721 1234567  0721 7654321` a number of its own.
 *
 * It deliberately does not apply to a `+`-initial candidate: `+` is never the
 * interior of a digit run, so `4111111111111111 +49 721 1234567` is a card
 * followed by a phone number, not one sequence.
 */
function startsMidRun(text: string, start: number): boolean {
  let run = '';
  let j = start - 1;
  while (j >= 0 && run.length < MAX_SEPARATOR_RUN && isSeparator(text[j] as string)) {
    run = (text[j] as string) + run;
    j -= 1;
  }
  if (j < 0 || !isDigit(text[j] as string)) return false;
  return run.length === 0 || isSeparatorRun(run);
}

/**
 * Apply a separator run's parentheses to the current nesting depth, or `null`
 * when the run closes one that was never opened — the point at which the number
 * being read has plainly ended and the `)` belongs to the sentence around it.
 */
function parenDepthAfter(depth: number, run: string): number | null {
  let out = depth;
  for (const ch of run) {
    if (ch === '(') out += 1;
    else if (ch === ')') {
      if (out === 0) return null;
      out -= 1;
    }
  }
  return out;
}

/**
 * Collect a phone-shaped run starting at `start`.
 *
 * Single separators are allowed between digits; a longer separator run is
 * allowed only when {@link isSeparatorRun} accepts it, which is what makes
 * `+49 (0) 721 123456` and `0721 / 123 456` work without also gluing two
 * numbers separated by a double space into one.
 *
 * Parentheses are tracked rather than treated as ordinary punctuation, and the
 * run is rewound to the last point at which every one of them was matched. The
 * alternative is the bug this replaced: `(0721) 1234567` was reported as
 * `0721) 1234567`, leaving a `(` behind that reads as the start of a number the
 * reader can no longer see. `openParenBefore` seeds the depth so a `(` the
 * caller is willing to adopt counts as already open.
 */
function collectPhoneRun(text: string, start: number, openParenBefore: boolean): PhoneRun {
  let i = start;
  let raw = '';
  let digitCount = 0;
  let end = start;
  let depth = openParenBefore ? 1 : 0;
  let balanced: PhoneRun | null = null;

  if (text[i] === '+') {
    raw += '+';
    i += 1;
    end = i;
  }

  while (i < text.length && digitCount < MAX_DIGITS) {
    const ch = text[i];
    if (ch === undefined) break;

    if (isDigit(ch)) {
      raw += ch;
      digitCount += 1;
      i += 1;
      end = i;
      if (depth === 0) balanced = { raw, end, digitCount, consumedOpenParen: openParenBefore };
      continue;
    }

    if (!isSeparator(ch) || digitCount === 0) break;

    let run = '';
    let j = i;
    while (j < text.length && run.length < MAX_SEPARATOR_RUN && isSeparator(text[j] as string)) {
      run += text[j];
      j += 1;
    }

    const next = text[j];
    if (next === undefined || !isDigit(next) || !isSeparatorRun(run)) break;

    const nextDepth = parenDepthAfter(depth, run);
    if (nextDepth === null) break;

    depth = nextDepth;
    raw += run;
    i = j;
  }

  // A `(` opened inside the run and still open: `0721 (123456)` is one number
  // with a bracketed extension, so take the `)` the writer put right after the
  // digits rather than rewinding to `0721` and reporting nothing.
  if (depth === 1 && !openParenBefore && text[end] === ')') {
    raw += ')';
    end += 1;
    depth = 0;
    balanced = { raw, end, digitCount, consumedOpenParen: false };
  }

  if (depth === 0) return { raw, end, digitCount, consumedOpenParen: openParenBefore };
  return balanced ?? { raw: '', end: start, digitCount: 0, consumedOpenParen: false };
}

/**
 * `03/05/1990` and `05-03-90`: a written date, not a dialling plan.
 *
 * The German `01.02.1990` form is kept out by leaving `.` off the separator
 * list, but the US and British forms are written with the very characters a
 * German number uses. Two groups of one or two digits followed by a two- or
 * four-digit group, all three joined by the same character, is a date wherever
 * it appears and a phone number nowhere — no numbering plan opens with a
 * one-digit group. Reporting it as PHONE is worse than reporting nothing: the
 * audit record then names the wrong category for a subject-access request.
 */
const DATE_SHAPED = /^\d{1,2}([/-])\d{1,2}\1\d{2}(?:\d{2})?$/u;

/**
 * German and international notation: E.164 (`+49…`), the `0049…` prefix and
 * national numbers with spaces, slashes, hyphens and `(0)`.
 */
function findGermanSpans(text: string, out: Span[]): void {
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const starts = ch === '+' || ch === '0';

    if (!starts || isWordChar(text, i - 1) || text[i - 1] === '+') {
      i += 1;
      continue;
    }
    if (ch === '0' && startsMidRun(text, i)) {
      i += 1;
      continue;
    }

    const openParenBefore = text[i - 1] === '(';
    let run = collectPhoneRun(text, i, openParenBefore);
    // The `(` was never closed, so it is the writer's bracket and not part of
    // the number: read the run again without adopting it.
    if (openParenBefore && !run.consumedOpenParen) run = collectPhoneRun(text, i, false);

    // The run was truncated at MAX_DIGITS and more digits follow: not a number.
    if (run.digitCount === 0 || memberAt(text, run.end, isDigit)) {
      i += 1;
      continue;
    }
    if (DATE_SHAPED.test(run.raw)) {
      i += 1;
      continue;
    }

    const classification = classifyPhone(run.raw);
    if (classification === null) {
      i += 1;
      continue;
    }

    const start = run.consumedOpenParen ? i - 1 : i;
    const undecorated = !/\D/u.test(run.raw);
    if (
      classification.form === 'german-national' &&
      undecorated &&
      !labelNear(text, start, run.end, PHONE_PROXIMITY)
    ) {
      i += 1;
      continue;
    }

    out.push({
      start,
      end: run.end,
      kind: 'PHONE',
      value: text.slice(start, run.end),
      detector: 'phone',
      priority: DEFAULT_PRIORITIES.PHONE,
    });
    i = run.end;
  }
}

// ---------------------------------------------------------------------------
// North American numbering plan
//
// A German firm's LLM traffic carries US numbers as soon as it has one US
// customer, and none of the German notations above match any of them: no
// leading `0`, no `+49`, and a dotted `555.123.4567` form written with the one
// separator the German pass must refuse.
//
// The area code carries the validation: it is NXX, so a leading `0` or `1` is
// not a number, and that is what keeps the pass off the leading-zero runs the
// German side owns and off `1234567890`. The exchange code is NXX in the real
// plan too, but it is left as three free digits here on purpose — every
// fictional number in circulation, `555-123-4567` included, uses an exchange
// the plan forbids, and a detector that refuses the example everyone writes
// their tests with will be switched off. The looser shape costs nothing on its
// own: what a candidate still has to clear is the boundary test and the
// decoration-or-label gate below.
//
// `.` is admitted here and nowhere else. It is safe in this shape and only this
// shape: a 3-3-4 split can be neither a German date (which ends in a
// four-digit year behind two short groups) nor an IPv4 address (four groups,
// none longer than three digits).
// ---------------------------------------------------------------------------

const NANP_PATTERN =
  /(?:(?<cc>\+?1)(?<ccSep>[ .-]?))?(?<open>\()?(?<area>[2-9]\d{2})(?<close>\))?(?<sep1>[ .-]?)(?<exchange>\d{3})(?<sep2>[ .-]?)(?<line>\d{4})/gu;

/** As the German set, plus the American dotted form. */
const isNanpSeparator = (ch: string): boolean => ch === '.' || isSeparator(ch);

/** The NANP mirror of {@link startsMidRun}; its separators are single characters. */
function nanpStartsMidRun(text: string, start: number): boolean {
  const prev = text[start - 1];
  if (prev === undefined) return false;
  if (isDigit(prev)) return true;
  if (!isNanpSeparator(prev)) return false;
  return memberAt(text, start - 2, isDigit);
}

function overlapsAny(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((span) => span.start < end && start < span.end);
}

/**
 * True when the number carries evidence of being a number in its own writing.
 *
 * Ten undecorated digits are the risky case and the reason this exists:
 * `5551234567` is as much an order number, an account reference or a timestamp
 * in milliseconds as it is a Los Angeles number, and a detector that claims all
 * of them teaches its operator to ignore the category. A written `+1`, a
 * parenthesised area code or a consistent internal separator all mean a human
 * wrote a telephone number down; a solid digit run means nothing at all, and is
 * sent to the label gate instead — the same gate the bare German national form
 * goes through, so the two rules are one rule.
 */
function nanpIsDecorated(groups: Record<string, string | undefined>): boolean {
  const cc = groups['cc'];
  if (cc !== undefined && cc.startsWith('+')) return true;
  if (cc !== undefined && groups['ccSep'] !== '') return true;
  if (groups['open'] !== undefined) return true;
  const sep1 = groups['sep1'] ?? '';
  return sep1 !== '' && sep1 === groups['sep2'];
}

function findNanpSpans(text: string, taken: readonly Span[], out: Span[]): void {
  const re = new RegExp(NANP_PATTERN.source, NANP_PATTERN.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const groups = (match.groups ?? {}) as Record<string, string | undefined>;
    // Rewind before deciding: rejecting a candidate must not skip the text it
    // covered, because a later start inside it can still be the real number.
    // Interior positions cost almost nothing — the word-boundary test below
    // rejects them on their first character.
    re.lastIndex = start + 1;

    if (isWordChar(text, start - 1) || text[start - 1] === '+') continue;
    if (isDigit(text[start] as string) && nanpStartsMidRun(text, start)) continue;
    if (isWordChar(text, end)) continue;
    // Half a pair is the orphaned-parenthesis bug in miniature.
    if ((groups['open'] === undefined) !== (groups['close'] === undefined)) continue;
    if (overlapsAny(taken, start, end) || overlapsAny(out, start, end)) continue;
    if (!nanpIsDecorated(groups) && !labelNear(text, start, end, PHONE_PROXIMITY)) continue;

    out.push({
      start,
      end,
      kind: 'PHONE',
      value: text.slice(start, end),
      detector: 'phone',
      priority: DEFAULT_PRIORITIES.PHONE,
    });
    re.lastIndex = end;
  }
}

// ---------------------------------------------------------------------------
// Vanity numbers
//
// `1-800-FLOWERS` is a phone number in every sense that matters to a
// redaction: it dials, it identifies, and a customer record holding it is
// personal data. It is also seven characters of alphabet, which is what a hex
// digest looks like — so the shape alone is not enough and three further
// conditions carry the weight: an explicit `1` country code, at least one
// separator before the letters, and letters written the way vanity numbers are
// always written, in capitals. `1234abcdef0` fails all three.
// ---------------------------------------------------------------------------

/** Exchange plus line number: seven keypad characters. */
const VANITY_LENGTH = 7;
const MIN_VANITY_LETTERS = 3;

const VANITY_ANCHOR = /(?<cc>\+?1)(?<ccSep>[ .-]?)(?<area>[2-9]\d{2})(?<sep>[ .-])/gu;

const isVanityChar = (ch: string): boolean => isDigit(ch) || (ch >= 'A' && ch <= 'Z');
const isVanitySeparator = (ch: string): boolean => ch === ' ' || ch === '-' || ch === '.';

function findVanitySpans(text: string, taken: readonly Span[], out: Span[]): void {
  const re = new RegExp(VANITY_ANCHOR.source, VANITY_ANCHOR.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    re.lastIndex = start + 1;

    if (isWordChar(text, start - 1) || text[start - 1] === '+') continue;

    const from = start + match[0].length;
    const run = collectRun(text, from, isVanityChar, isVanitySeparator, VANITY_LENGTH);
    if (run.chars.length !== VANITY_LENGTH) continue;

    const letters = [...run.chars].filter((ch) => !isDigit(ch)).length;
    if (letters < MIN_VANITY_LETTERS) continue;

    const end = (run.offsets.at(-1) ?? from) + 1;
    if (isWordChar(text, end)) continue;
    if (overlapsAny(taken, start, end) || overlapsAny(out, start, end)) continue;

    out.push({
      start,
      end,
      kind: 'PHONE',
      value: text.slice(start, end),
      detector: 'phone',
      priority: DEFAULT_PRIORITIES.PHONE,
    });
    re.lastIndex = end;
  }
}

/**
 * Phone number detector: German national and international notation, the North
 * American numbering plan, and vanity spellings of the latter.
 *
 * The three passes share one rule rather than competing: a number that carries
 * its own evidence — a `+`, a `00`, parentheses, a consistent separator — is
 * reported unaccompanied, and a bare run of digits is reported only when a word
 * nearby says it is a telephone number. They also share one boundary test, so
 * none of them can claim the tail of a longer identifier.
 */
export const phoneDetector: Detector = {
  name: 'phone',
  priority: DEFAULT_PRIORITIES.PHONE,

  find(text: string): Span[] {
    const out: Span[] = [];
    findGermanSpans(text, out);

    const german = [...out];
    findNanpSpans(text, german, out);
    findVanitySpans(text, german, out);

    return out.toSorted((a, b) => a.start - b.start);
  },
};
