import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

const LOCAL_MAX = 64;
const TOTAL_MAX = 254;
const LABEL_MAX = 63;

/**
 * The grammar is RFC 6531, not RFC 5321: `\p{L}` and `\p{N}` rather than
 * `A-Za-z0-9`.
 *
 * Internationalised addresses are not an exotic case for this product. A German
 * Mittelstand address book holds Turkish, Polish and Greek names, and an ASCII
 * local part silently misses `ünal.yilmaz@`, `владимир@` and `测试@` — the worst
 * possible failure here, because the address then leaves the machine verbatim
 * while the audit record says nothing was found. The look-alike scan copy
 * catches the *accented* spellings by folding the diacritic away, but it folds
 * nothing in a script that has no ASCII twin, so Cyrillic, Greek and CJK local
 * parts have to be matched here or not at all.
 *
 * The trade-off the Unicode top-level domain accepts: in a script that does not
 * space its words — CJK, Thai — a `\p{L}{2,24}` label after the final dot can
 * run past the end of the address into the sentence. The trailing lookahead
 * bounds that to nothing at all rather than to a wrong 24 characters (a longer
 * run fails the whole match instead of truncating), and refusing `.рф` while
 * accepting `владимир@` would be incoherent.
 */
const ATOM = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const DOT_ATOM = `${ATOM}(?:\\.${ATOM})*`;

/**
 * The RFC 5322 quoted local part, which the old grammar excluded on the theory
 * that nobody pastes one into a prompt.
 *
 * They do, and the cost of excluding it was not a miss but a *mislabel*:
 * `"max mustermann"@example.com` produced no EMAIL candidate at all, so the
 * dictionary's NAME span on the two words inside the quotes was the only
 * candidate left and won by default. Priority never entered into it — EMAIL
 * (75) beats DICTIONARY (40) only among spans that exist. Now the address is a
 * candidate, and `resolveSpans` prefers it because it is the longer match.
 *
 * Content is capped at the local-part limit and excludes control characters, so
 * an unterminated quote cannot scan to the end of a megabyte body.
 */
const QUOTED = String.raw`"(?:[^"\\\p{Cc}]|\\[^\p{Cc}]){1,64}"`;

/**
 * A domain label, written as `alnum (hyphen* alnum)*` rather than the more
 * usual `alnum (alnum|hyphen)* alnum`.
 *
 * The two accept exactly the same strings, but this one is unambiguous: there
 * is only one way to split a given label across the quantifiers, so a long
 * hostile run of letters with no dot after it fails in one pass instead of
 * being re-split every way the engine can think of.
 */
const LABEL = String.raw`[\p{L}\p{N}](?:-*[\p{L}\p{N}])*`;

/** Keeps `ünal@example.de` from being reported as the truncated `nal@example.de`. */
const LEAD = String.raw`(?<![\p{L}\p{N}._%+-])`;
/** Refuses a match that stops in the middle of a longer run. */
const TAIL = String.raw`(?![\p{L}\p{N}-])`;

const EMAIL_PATTERN = new RegExp(
  `${LEAD}(?:${DOT_ATOM}|${QUOTED})@(?:${LABEL}\\.)+\\p{L}{2,24}${TAIL}`,
  'gu',
);

/**
 * The layout-broken address: `max.mustermann @ example.com`.
 *
 * These are not a spelling anyone chooses. They come out of the attachment
 * path, where a table cell, a two-column letterhead or PDF kerning puts a space
 * where the writer put none — so the customer's own signature block arrives
 * shredded and, without this, unredacted.
 *
 * Tolerating a space next to `@` is also the easiest way to build a detector
 * that fires on ordinary mail, and an operator who sees that switches the
 * detector off, which costs the customer far more than a miss. So the spaced
 * form is a *separate, narrower grammar* rather than an optional space in the
 * one above, and it carries three guards, each aimed at a sentence that would
 * otherwise match:
 *
 *  1. **The local part must be a dotted chain**, `vorname.nachname`. This is
 *     what refuses `Das Kickoff findet @ zoom.us statt` — a bare word before
 *     the at-sign is the German "at a place" idiom, not a mailbox.
 *  2. **It must hold three consecutive letters**, so `Release 3.4 @ ci.firma.de`
 *     and `Doku v2.1 @ wiki.firma.de` are version numbers again rather than
 *     mailboxes with a dot in them.
 *  3. **The top-level domain must be lower case.** A capitalised word after a
 *     dot is a sentence starting, not a TLD: `…@firma .Die Rechnung folgt` is
 *     prose with a missing space, and `Example.COM` still matches through the
 *     canonical grammar above, which this one never overrides.
 *
 * The accepted miss is `info @ example.com`: `info` and `Kickoff` are the same
 * shape, and only one of them is an address. A single-word local part next to a
 * space is refused, and the test that pins it says so.
 *
 * Only single ASCII spaces, never a newline or a tab: a break across lines is a
 * different phenomenon with a much worse false-positive profile — every list of
 * words ending in a dotted token would join across it.
 */
const SPACED_PATTERN = new RegExp(
  `${LEAD}(${ATOM}(?:\\.${ATOM})+) ?@ ?(?:${LABEL} ?\\.)+\\p{Ll}{2,24}${TAIL}`,
  'gu',
);

/** Guard 2 above: a local part with no word in it is a number, not a mailbox. */
const WORD_LIKE = /\p{L}{3}/u;

/**
 * Cheap gate on the second pass. The canonical grammar carries the whole cost
 * of ordinary ASCII prose; the spaced grammar only runs when the text actually
 * holds a space next to an at-sign or before a dot, which three `indexOf` scans
 * decide far more cheaply than a second regex pass over the body.
 */
const hasSpacedBreak = (text: string): boolean =>
  text.includes(' @') || text.includes('@ ') || text.includes(' .');

/** Structural checks the pattern cannot express: length limits and label sizes. */
export function isValidEmail(candidate: string): boolean {
  if (candidate.length > TOTAL_MAX) return false;

  const at = candidate.lastIndexOf('@');
  if (at <= 0) return false;

  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);

  // Counted in UTF-16 units where RFC 6531 counts octets, so a non-ASCII local
  // part is held to a stricter limit than the RFC allows. Erring towards the
  // shorter bound only ever rejects an address longer than any real mailbox.
  if (local.length === 0 || local.length > LOCAL_MAX) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= LABEL_MAX &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

interface Candidate {
  readonly span: Span;
  readonly spaced: boolean;
}

export const emailDetector: Detector = {
  name: 'email',
  priority: DEFAULT_PRIORITIES.EMAIL,

  find(text: string): Span[] {
    const candidates: Candidate[] = [];
    collect(text, EMAIL_PATTERN, false, candidates);
    if (hasSpacedBreak(text)) collect(text, SPACED_PATTERN, true, candidates);
    return leftmostLongest(candidates);
  },
};

/** Run one pattern over the text, appending every candidate that validates. */
function collect(text: string, pattern: RegExp, spaced: boolean, into: Candidate[]): void {
  // Cloned rather than used directly: `lastIndex` is per-RegExp state, and a
  // module-level pattern shared between concurrent requests would resume each
  // scan wherever the last one happened to stop.
  const re = new RegExp(pattern.source, pattern.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const value = match[0];
    // The spaces only ever sit between the parts, never inside an atom, so
    // removing them recovers the address the writer meant — which is what the
    // length and label checks have to see. The span keeps the raw text.
    const canonical = spaced ? value.replaceAll(' ', '') : value;
    if (spaced && !WORD_LIKE.test(match[1] ?? '')) continue;
    if (!isValidEmail(canonical)) continue;

    into.push({
      spaced,
      span: {
        start: match.index,
        end: match.index + value.length,
        kind: 'EMAIL',
        value,
        detector: 'email',
        priority: DEFAULT_PRIORITIES.EMAIL,
      },
    });
  }
}

/**
 * Merge the two passes the way a single regex would have resolved them:
 * leftmost first, and at one offset the longest.
 *
 * The one deviation is deliberate — at the same offset the canonical grammar
 * beats the spaced one even when the spaced match is longer. That is what stops
 * `…@firma.de .Die Rechnung` from being extended across the sentence boundary:
 * a complete address is never re-read as a broken one.
 */
function leftmostLongest(candidates: Candidate[]): Span[] {
  const ordered = candidates.toSorted(
    (a, b) =>
      a.span.start - b.span.start ||
      Number(a.spaced) - Number(b.spaced) ||
      b.span.end - a.span.end,
  );

  const out: Span[] = [];
  let end = -1;
  for (const candidate of ordered) {
    if (candidate.span.start < end) continue;
    out.push(candidate.span);
    end = candidate.span.end;
  }

  return out;
}
