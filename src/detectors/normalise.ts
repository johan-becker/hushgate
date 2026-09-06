import { DEFAULT_LABEL_WINDOW, type LabelProximity } from '../types.js';

/**
 * The scan copy: what the detectors get to look at, and how to point back at
 * what was actually written.
 *
 * Detectors match the raw string, so a character that renders as nothing is a
 * complete bypass: put a zero-width space inside `anna.schmidt@acme.example`
 * and it still reads as an address to a human, matches no e-mail pattern, and
 * leaves the machine verbatim while the audit record for the request that
 * carried it says zero findings. Full-width letters and a decomposed umlaut do
 * the same thing by a different route: they are a different code point
 * sequence for the same glyphs.
 *
 * Normalising the *text sent upstream* is not an option — hushgate forwards
 * what the caller wrote — so this builds a second, private copy to scan, plus
 * an offset map that translates any span found in it back to the exact
 * original characters.
 */
export interface NormalisedText {
  /** The scan copy. Never sent anywhere; only fed to detectors. */
  readonly text: string;
  /**
   * offsets[i] is the index in the ORIGINAL string of the source that produced
   * text[i]; offsets[text.length] is the end sentinel. A normalised span [s,e)
   * maps back to the original range [offsets[s], offsets[e]).
   */
  readonly offsets: readonly number[];
  /** False when normalisation was a no-op, so the caller can skip the second pass. */
  readonly changed: boolean;
}

/**
 * Which folds to apply, each independently toggleable.
 *
 * Only `invisibles` and `compatibility` are on by default, because those two
 * are the folds that cannot change what a detector concludes about ordinary
 * text — everything else rewrites characters a legitimate document may well
 * contain, and is therefore something the caller opts into for one specific
 * scan copy. {@link SCAN_PROFILES} holds the combinations `detect()` uses.
 */
export interface NormaliseOptions {
  /** Drop characters that render as nothing. Default true. */
  readonly invisibles?: boolean;
  /** NFKC per combining cluster: full-width, ligatures, decomposed marks. Default true. */
  readonly compatibility?: boolean;
  /** Cyrillic and Greek look-alikes to their Latin twin. Default false. */
  readonly confusables?: boolean;
  /** Strip diacritics inside address-shaped tokens. Default false. */
  readonly diacritics?: boolean;
  /** Rewrite grouping separators inside identifier runs to a plain space. Default false. */
  readonly separators?: boolean;
  /** Upper-case identifier runs. Default false. */
  readonly caseFold?: boolean;
  /**
   * Delete the separators inside a kerning-shredded run rather than
   * normalising them. Default false; see {@link READABLE_GROUP}.
   */
  readonly closeGaps?: boolean;
  /** Collapse `N o r d l i c h t` back into one word. Default false. */
  readonly spacedOut?: boolean;
  /** Split `ProjektNordlicht` at the case boundary. Default false. */
  readonly camelCase?: boolean;
  /** Fold `N0rdlicht` back to letters. Default false. */
  readonly leet?: boolean;
}

/**
 * The scan copies `detect()` builds, and the reason they are grouped this way.
 *
 * Folds that fight each other must not share a copy. `caseFold` and `leet` are
 * the pair that proves it: on `de89 3704 0044 0532 0130 00` the case fold is
 * what makes the IBAN visible, while leetspeak folding would read the `8` after
 * `de` as a letter and destroy the same number. Kept apart, each copy is wrong
 * about at most the shapes the other copy is right about.
 */
export const SCAN_PROFILES = {
  /** What the original two-pass design scanned: invisibles and NFKC. */
  unicode: {},
  /** Look-alike letters: Cyrillic and Greek twins, diacritics inside addresses. */
  skeleton: { confusables: true, diacritics: true },
  /** Grouped identifiers: separators the detectors do not accept, and case. */
  identifier: { separators: true, caseFold: true },
  /** Words pulled apart or spelled with digits. */
  wordShape: { spacedOut: true, camelCase: true, leet: true },
  /** Identifiers a kerning extractor cut into pieces no detector reads. */
  shredded: { separators: true, caseFold: true, closeGaps: true },
} as const satisfies Record<string, NormaliseOptions>;

/**
 * Characters that render as nothing and break every pattern.
 *
 * The same class `attach/rewrite.ts` strips from extracted documents, and
 * deliberately expressed the same way: whole Unicode properties rather than a
 * hand-picked list, because hand-picked lists of this leave gaps and every gap
 * is a working separator. `Cf` carries the zero-width space, the zero-width
 * (non-)joiner, the word joiner, the byte-order mark, the soft hyphen, the
 * bidi embeddings and overrides and the tag plane;
 * `Default_Ignorable_Code_Point` adds the variation selectors, the Mongolian
 * free variation selectors and the Hangul fillers, which are not format
 * characters but are just as invisible.
 */
const INVISIBLE = /\p{Cf}|\p{Default_Ignorable_Code_Point}/u;

/** A combining mark: what binds to the base character before it. */
const COMBINING = /[\p{Mn}\p{Me}]/u;

/**
 * Nothing outside ASCII, so nothing can change.
 *
 * Every invisible above is non-ASCII, and no ASCII character has a
 * compatibility decomposition or is a combining mark, so NFKC is the identity
 * on ASCII text. Prose is overwhelmingly ASCII, and this test is what keeps
 * the cost of the whole mechanism at one linear scan for it.
 */
const NON_ASCII = /\P{ASCII}/u;

/**
 * Build the scan copy of `text` together with its offset map.
 *
 * With the default options, two transformations, in one pass:
 *
 *  1. invisible characters are dropped;
 *  2. NFKC is applied per combining cluster — a base character plus the
 *     combining marks that follow it — rather than over the whole string.
 *
 * Cluster-wise is what keeps the offset map exact. NFKC over the whole string
 * gives back a string with no way to say which original characters produced
 * which output ones; a cluster is small enough that pointing every unit it
 * produces at the cluster's own start index is still precise enough to slice
 * the original with. NFKC is also the fold that matters here: it turns
 * full-width letters into ASCII ones and composes `a` + U+0308 into a
 * precomposed umlaut, so a decomposed spelling and a dictionary entry written
 * the ordinary way meet in the middle.
 *
 * The limit of doing it per cluster: sequences that compose across a cluster
 * boundary — Hangul jamo, a halfwidth voiced sound mark following a kana — are
 * left alone, because their second element is not a combining mark and so
 * starts a cluster of its own. That is a deliberate trade: those are not the
 * shapes an evader reaches for, and an exact offset map is worth more than
 * covering them.
 *
 * Every further fold is a *stage* over the result of the one before it, with
 * its own offset map into its own input; `composeStage` folds those maps into a
 * single map back to the original. That is what keeps
 * `value === original.slice(start, end)` true no matter how many folds ran, and
 * it is the reason each fold can be reasoned about — and switched off — on its
 * own.
 */
export function normaliseForScan(text: string, options: NormaliseOptions = {}): NormalisedText {
  const invisibles = options.invisibles ?? true;
  const compatibility = options.compatibility ?? true;

  let copy = baseCopy(text, invisibles, compatibility);

  if (options.confusables === true) copy = applyStage(copy, foldConfusables);
  if (options.diacritics === true) copy = applyStage(copy, foldDiacritics);
  if (options.spacedOut === true) copy = applyStage(copy, collapseSpacedOut);
  if (options.camelCase === true) copy = applyStage(copy, splitCamelCase);
  if (options.leet === true) copy = applyStage(copy, foldLeet);
  if (options.separators === true || options.caseFold === true || options.closeGaps === true) {
    copy = applyStage(copy, (input) =>
      foldIdentifierRuns(
        input,
        options.separators === true,
        options.caseFold === true,
        options.closeGaps === true,
      ),
    );
  }

  return copy;
}

/** Invisibles and NFKC: the fold the original two-pass design was built on. */
function baseCopy(text: string, invisibles: boolean, compatibility: boolean): NormalisedText {
  if (!NON_ASCII.test(text)) return unchanged(text);
  if (!invisibles && !compatibility) return unchanged(text);

  const units: string[] = [];
  const offsets: number[] = [];
  let changed = false;

  const length = text.length;
  let index = 0;

  while (index < length) {
    const code = text.codePointAt(index) as number;
    const width = code > 0xffff ? 2 : 1;

    if (invisibles && isInvisible(code)) {
      changed = true;
      index += width;
      continue;
    }

    // Gather the cluster: this base character plus every following combining
    // mark. Invisibles found in between are dropped without ending the
    // cluster, which is the point — `a` ZWSP U+0308 is an umlaut written to
    // look like it is not one, and closing the gap is what makes it one again.
    const start = index;
    let source = String.fromCodePoint(code);
    let end = index + width;

    while (end < length) {
      const next = text.codePointAt(end) as number;
      const nextWidth = next > 0xffff ? 2 : 1;
      if (invisibles && isInvisible(next)) {
        changed = true;
        end += nextWidth;
        continue;
      }
      if (!isCombining(next)) break;
      source += String.fromCodePoint(next);
      end += nextWidth;
    }

    const folded = compatibility ? source.normalize('NFKC') : source;
    if (folded !== source) changed = true;

    units.push(folded);
    // Every unit the cluster produced points at the cluster's start. An
    // expansion (U+FB01 becoming `fi`) therefore gives two units the same
    // source index, so a span that covers only part of the expansion maps to
    // an empty range — the caller drops those rather than inventing a
    // character boundary that does not exist in the original.
    for (let produced = 0; produced < folded.length; produced += 1) offsets.push(start);

    index = end;
  }

  if (!changed) return unchanged(text);

  // The sentinel. The last cluster's units already point at its start, so the
  // end of the last span resolves through this entry to the end of the text —
  // including any invisible run that trailed it, which is what keeps a sliced
  // value byte-identical to what the caller wrote.
  offsets.push(length);

  return { text: units.join(''), offsets, changed: true };
}

/**
 * The no-op result.
 *
 * The offset map is the identity here, and building it costs an array as long
 * as the text — for the common case, ASCII prose, that array is never read,
 * because `changed === false` tells the caller to skip the second pass
 * entirely. So it is built only if someone actually asks for it.
 */
function unchanged(text: string): NormalisedText {
  let offsets: number[] | undefined;
  return {
    text,
    changed: false,
    get offsets(): readonly number[] {
      offsets ??= Array.from({ length: text.length + 1 }, (_, index) => index);
      return offsets;
    },
  };
}

function isInvisible(code: number): boolean {
  // ASCII short-circuit before the property test: the property tests need a
  // string per code point, and paying for that on every character of a mostly
  // ASCII document is the difference between a scan and a stall.
  if (code < 0x80) return false;
  return INVISIBLE.test(String.fromCodePoint(code));
}

function isCombining(code: number): boolean {
  if (code < 0x80) return false;
  return COMBINING.test(String.fromCodePoint(code));
}

/* ------------------------------------------------------------------ stages */

/**
 * One fold, expressed as the string it produced plus a map into the string it
 * was given. `map[i]` is the index in the stage's *input* of the source of
 * `text[i]`; `map[text.length]` is the end sentinel, exactly as in
 * {@link NormalisedText}.
 */
interface Stage {
  readonly text: string;
  readonly map: readonly number[];
}

/** Accumulates a stage's output and its map together, so they cannot drift. */
class Rewriter {
  private readonly parts: string[] = [];
  private readonly map: number[] = [];
  private touched = false;

  /** Copy `[from, to)` unchanged; every unit keeps its own source index. */
  keep(source: string, from: number, to: number): void {
    if (to <= from) return;
    this.parts.push(source.slice(from, to));
    for (let i = from; i < to; i += 1) this.map.push(i);
  }

  /** Emit `produced` in place of `[from, to)`; every unit points at `from`. */
  replace(produced: string, from: number, to: number, source: string): void {
    if (produced === source.slice(from, to)) {
      this.keep(source, from, to);
      return;
    }
    this.touched = true;
    this.parts.push(produced);
    for (let i = 0; i < produced.length; i += 1) this.map.push(from);
  }

  /** Emit `produced` without consuming any input; it points at `at`. */
  insert(produced: string, at: number): void {
    this.touched = true;
    this.parts.push(produced);
    for (let i = 0; i < produced.length; i += 1) this.map.push(at);
  }

  /** Drop `[from, to)` entirely. */
  drop(from: number, to: number): void {
    if (to > from) this.touched = true;
  }

  /** Null when the stage was a no-op, so the caller skips composing it. */
  finish(source: string): Stage | null {
    if (!this.touched) return null;
    this.map.push(source.length);
    return { text: this.parts.join(''), map: this.map };
  }
}

/** Fold a stage's map into the running map back to the original text. */
function applyStage(copy: NormalisedText, run: (text: string) => Stage | null): NormalisedText {
  const stage = run(copy.text);
  if (stage === null) return copy;

  const previous = copy.offsets;
  const offsets = stage.map.map((index) => previous[index] as number);

  return { text: stage.text, offsets, changed: true };
}

/* ------------------------------------------------------------ look-alikes */

/**
 * The look-alikes NFKC leaves alone.
 *
 * Cyrillic U+0430 has no compatibility decomposition to Latin `a` — the two are
 * different letters that happen to be drawn the same, which is exactly what
 * makes `ex<U+0430>mple.com` a working bypass. UTS #39 calls the fold a skeleton;
 * this is a hand-built table of the pairs that are genuinely indistinguishable
 * in the fonts a support ticket is read in, not the full confusables data. The
 * full table is large, changes between Unicode versions and would fold script
 * pairs no evader reaches for, so the trade taken here is coverage of the
 * Cyrillic and Greek twins against a table small enough to audit by eye.
 *
 * Every mapping is one code unit to one code unit, which keeps this stage
 * length-preserving and its offset map the identity.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic, lower case.
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  '\u04BB': 'h', '\u051B': 'q', '\u0501': 'd', '\u04CF': 'l',
  // Cyrillic, upper case.
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M',
  '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T',
  '\u0423': 'Y', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J',
  '\u0500': 'D', '\u04C0': 'I',
  // Greek, upper case.
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O',
  '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  // Greek and Latin small letters drawn as another script's letter.
  '\u03BF': 'o', '\u03BD': 'v', '\u03F2': 'c', '\u03F3': 'j', '\u0261': 'g',
};

function foldConfusables(text: string): Stage | null {
  const rewriter = new Rewriter();
  let changed = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    const latin = ch.codePointAt(0)! < 0x80 ? undefined : CONFUSABLES[ch];
    if (latin === undefined) {
      rewriter.keep(text, i, i + 1);
      continue;
    }
    rewriter.replace(latin, i, i + 1, text);
    changed = true;
  }

  return changed ? rewriter.finish(text) : null;
}

/** Latin letters carrying a diacritic that NFD does not take apart. */
const LATIN_SOLIDUS: Readonly<Record<string, string>> = {
  '\u00F8': 'o', '\u00D8': 'O', '\u0111': 'd', '\u0110': 'D',
  '\u0142': 'l', '\u0141': 'L', '\u0127': 'h', '\u0126': 'H',
  '\u00E6': 'ae', '\u00C6': 'AE', '\u0153': 'oe', '\u0152': 'OE',
  '\u00DF': 'ss', '\u00FE': 'th', '\u00F0': 'd',
};

/**
 * Address-shaped tokens, and nothing else.
 *
 * A diacritic only hides a finding where the pattern that would have found it
 * is ASCII-only, and the e-mail grammar is the one that is —
 * `ünal.yilmaz@example.de` is reported as `nal.yilmaz@…` or not at all.
 * Folding diacritics everywhere would instead rewrite every German body that
 * says `Grüße`, and a rewritten body is a body every detector has to
 * be run over a second time. Restricting the fold to tokens containing an `@`
 * buys the one case that matters for the cost of a regex that fires only when
 * the text carries an address at all.
 */
const ADDRESS_TOKEN = /[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+@[\p{L}\p{N}.-]+/gu;

function foldDiacritics(text: string): Stage | null {
  if (!text.includes('@') || !NON_ASCII.test(text)) return null;

  const rewriter = new Rewriter();
  const re = new RegExp(ADDRESS_TOKEN.source, ADDRESS_TOKEN.flags);
  let match: RegExpExecArray | null;
  let cursor = 0;
  let changed = false;

  while ((match = re.exec(text)) !== null) {
    rewriter.keep(text, cursor, match.index);

    const token = match[0];
    for (let i = 0; i < token.length; ) {
      const code = token.codePointAt(i) as number;
      const width = code > 0xffff ? 2 : 1;
      const source = token.slice(i, i + width);
      const at = match.index + i;

      if (code < 0x80) {
        rewriter.keep(text, at, at + width);
        i += width;
        continue;
      }

      const stripped =
        LATIN_SOLIDUS[source] ?? source.normalize('NFD').replaceAll(/\p{M}/gu, '');
      if (stripped === '' || stripped === source) {
        rewriter.keep(text, at, at + width);
      } else {
        rewriter.replace(stripped, at, at + width, text);
        changed = true;
      }
      i += width;
    }

    cursor = match.index + token.length;
  }

  rewriter.keep(text, cursor, text.length);
  return changed ? rewriter.finish(text) : null;
}

/* ------------------------------------------------------------ word shapes */

/**
 * A run of at least four single characters each separated by exactly one space.
 *
 * `N o r d l i c h t` is the shape; four is where it stops being a plausible
 * sentence. The lookarounds keep the run from starting or ending mid-word, so
 * `a b c` inside `Punkt a b c d` is taken whole or not at all.
 */
const SPACED_OUT = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;

function collapseSpacedOut(text: string): Stage | null {
  if (!text.includes(' ')) return null;

  const re = new RegExp(SPACED_OUT.source, SPACED_OUT.flags);
  const rewriter = new Rewriter();
  let match: RegExpExecArray | null;
  let cursor = 0;
  let changed = false;

  while ((match = re.exec(text)) !== null) {
    rewriter.keep(text, cursor, match.index);
    const run = match[0];
    for (let i = 0; i < run.length; i += 1) {
      const at = match.index + i;
      if (run[i] === ' ') {
        rewriter.drop(at, at + 1);
        continue;
      }
      rewriter.keep(text, at, at + 1);
    }
    cursor = match.index + run.length;
    changed = true;
  }

  rewriter.keep(text, cursor, text.length);
  return changed ? rewriter.finish(text) : null;
}

const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

/**
 * Split at a lower-to-upper boundary, so a dictionary entry glued to another
 * word is at a word boundary again.
 *
 * The inserted space points at the upper-case letter, which is where the
 * following word starts in the original — a span that begins at that letter
 * therefore maps back onto the original word exactly.
 */
function splitCamelCase(text: string): Stage | null {
  const rewriter = new Rewriter();
  let changed = false;

  for (let i = 0; i < text.length; i += 1) {
    const previous = text[i - 1];
    const current = text[i] as string;
    if (previous !== undefined && LOWER.test(previous) && UPPER.test(current)) {
      rewriter.insert(' ', i);
      changed = true;
    }
    rewriter.keep(text, i, i + 1);
  }

  return changed ? rewriter.finish(text) : null;
}

/** The substitutions that survive being read aloud. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't',
};

const WORD_RUN = /[\p{L}\p{N}]+/gu;

/**
 * Fold leetspeak digits back to letters — but only inside a token that is
 * mostly letters already.
 *
 * The condition is what protects every numeric finding in the file: `4111 1111
 * 1111 1111` and `DE89370400440532013000` are digits with at most a letter or
 * two, so nothing in them is folded, and a card number never turns into a word.
 * `N0rdlicht` is eight letters and one digit, and does.
 */
function foldLeet(text: string): Stage | null {
  const re = new RegExp(WORD_RUN.source, WORD_RUN.flags);
  const rewriter = new Rewriter();
  let match: RegExpExecArray | null;
  let cursor = 0;
  let changed = false;

  while ((match = re.exec(text)) !== null) {
    const token = match[0];
    rewriter.keep(text, cursor, match.index);
    cursor = match.index + token.length;

    let letters = 0;
    let digits = 0;
    let leet = 0;
    let hasLower = false;
    for (const ch of token) {
      if (/\p{L}/u.test(ch)) {
        letters += 1;
        if (LOWER.test(ch)) hasLower = true;
      } else {
        digits += 1;
        if (LEET[ch] !== undefined) leet += 1;
      }
    }

    if (leet === 0 || letters < 3 || digits * 2 > letters) {
      rewriter.keep(text, match.index, cursor);
      continue;
    }

    for (let i = 0; i < token.length; i += 1) {
      const at = match.index + i;
      const replacement = LEET[token[i] as string];
      if (replacement === undefined) {
        rewriter.keep(text, at, at + 1);
        continue;
      }
      rewriter.replace(hasLower ? replacement : replacement.toUpperCase(), at, at + 1, text);
      changed = true;
    }
  }

  rewriter.keep(text, cursor, text.length);
  return changed ? rewriter.finish(text) : null;
}

/* ------------------------------------------------------------- identifiers */

/**
 * Separators an evader groups an identifier with, and the detectors do not
 * accept.
 *
 * Every detector defines its own separator set, and between them they cover
 * the space and the hyphen and little else: `DE89\t3704\t…` and
 * `4111.1111.1111.1111` and `4111_1111_1111_1111` are each invisible to the
 * detector that owns them. Rewriting all of these to a plain space in the scan
 * copy fixes the whole class at once, and keeps the fix in one place rather
 * than in eleven separator predicates that will drift apart again.
 *
 * The colon is deliberately absent: it is the separator MAC addresses and IPv6
 * are *written* with, so folding it would break the copy for the two detectors
 * that need it and gain nothing that the raw pass does not already see.
 */
const FOLDABLE_SEPARATORS = new Set([
  '\t', '\n', '\r', '\f', '\v',
  '.', '_', ',', '-', '/', '|',
  // Spaces that are not the space: NBSP and the typographic widths.
  '\u00A0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004',
  '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F',
  '\u205F', '\u3000',
  // Hyphens and dashes that are not the hyphen-minus.
  '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212',
  '\uFE58', '\uFE63', '\uFF0D',
  // Middle dot and bullet, which a writer reaches for to group digits.
  '\u00B7', '\u2022', '\u2027',
]);

/**
 * True for every character the identifier fold treats as a grouping separator,
 * the plain space included.
 *
 * Exported for the detectors: a detector that widens its own `isSeparator` to
 * this set sees the grouped spellings in the raw text too, without waiting for
 * the scan copy.
 */
export function isScanSeparator(ch: string): boolean {
  return ch === ' ' || FOLDABLE_SEPARATORS.has(ch);
}

/**
 * A number written the way an invoice writes numbers.
 *
 * `1.234.567,89` is nine digits in mostly-digit groups joined by separators
 * this fold rewrites, which is to say it is indistinguishable from an
 * identifier by every test below — and it appears in a large share of the
 * German business mail this proxy sits in front of. Recognising the grouping
 * itself is what keeps that mail on the one-pass path. Both conventions are
 * covered, because a body may quote a price in either.
 */
const GROUPED_NUMBER =
  /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$|^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/u;

/** Long enough, and numeric enough, to be an identifier rather than prose. */
const MIN_RUN_ALNUM = 9;
const MIN_RUN_DIGITS = 6;

/**
 * The shortest group the detectors read on their own.
 *
 * Measured, not assumed: the IBAN detector recognises
 * `DE89370400440532013000` written in groups of four, five, six, seven and
 * eight, and does not recognise it in groups of three or two. Four is
 * therefore the boundary between a grouping a human chose and a grouping an
 * extractor inflicted — and two- and three-character groups are exactly what
 * kerning shredding produces, which `attach/quality.ts` already refuses a
 * document for. The same text arrives as a plain request body too, where there
 * is no extractor to refuse it, so it has to be read rather than rejected.
 */
const READABLE_GROUP = 4;

/**
 * The longest group that may be mostly letters and still belong to a chain.
 *
 * `DE8` is one digit in three characters, so the half-digits rule below throws
 * it away — and with it the country code that makes the rest an IBAN rather
 * than a run of numbers. A short group carrying a digit and no lower-case
 * letter is the shape of a country or issuer prefix, not of a word: `Sac`,
 * `hbe` and `arb` from a shredded letter all carry no digit and are still
 * refused.
 */
const MAX_PREFIX_GROUP = 4;

const isAsciiDigit = (ch: string): boolean => ch >= '0' && ch <= '9';
const isAsciiAlnum = (ch: string): boolean =>
  isAsciiDigit(ch) || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

/**
 * Find the stretches of text that are worth folding separators and case in.
 *
 * This is the cost argument for the whole identifier copy, so it is worth
 * stating plainly: rewriting every dot in a document to a space would produce a
 * copy that differs from the original for essentially every body hushgate ever
 * sees, and a copy that differs is a copy every detector has to be run over
 * again. So the fold is aimed instead of global.
 *
 * A chain is a run of alphanumeric groups that are each at least half digits,
 * joined by single separators, carrying at least nine alphanumerics and six
 * digits in total — the shape of an IBAN, a card number, a tax ID or a MAC, and
 * not the shape of a sentence, a date (`01.02.1990` is eight) or a price. It is
 * folded only when it actually contains something to fold: a separator the
 * detectors reject, or a lower-case letter. `DE89 3704 0044 0532 0130 00` is
 * already readable by the IBAN detector, so it produces no copy and no
 * second pass.
 */
function identifierChains(text: string): Array<readonly [number, number, boolean]> {
  const chains: Array<readonly [number, number, boolean]> = [];

  let start = -1;
  let end = -1;
  let alnum = 0;
  let digits = 0;
  let foldable = false;
  let lower = false;
  let groups = 0;
  let shortGroups = 0;

  const flush = (): void => {
    // A chain of mostly-short groups is the shredded shape, and worth a copy
    // even when every gap is a plain space that the fold would otherwise treat
    // as already readable. MOST groups, not any group: a conventionally
    // grouped IBAN ends in a two-character remainder — `DE89 3704 0044 0532
    // 0130 00` — and one trailing short group must not drag the commonest
    // shape of all onto a second pass.
    const shredded = shortGroups * 2 > groups;

    if (
      start >= 0 &&
      alnum >= MIN_RUN_ALNUM &&
      digits >= MIN_RUN_DIGITS &&
      (foldable || lower || shredded) &&
      !GROUPED_NUMBER.test(text.slice(start, end))
    ) {
      chains.push([start, end, shredded] as const);
    }
    start = -1;
    end = -1;
    alnum = 0;
    digits = 0;
    foldable = false;
    lower = false;
    groups = 0;
    shortGroups = 0;
  };

  let i = 0;
  while (i < text.length) {
    if (!isAsciiAlnum(text[i] as string)) {
      flush();
      i += 1;
      continue;
    }

    const groupStart = i;
    let groupDigits = 0;
    let groupLower = false;
    while (i < text.length && isAsciiAlnum(text[i] as string)) {
      const ch = text[i] as string;
      if (isAsciiDigit(ch)) groupDigits += 1;
      else if (ch >= 'a' && ch <= 'z') groupLower = true;
      i += 1;
    }

    const groupLength = i - groupStart;
    // Either mostly digits, or a short all-caps prefix carrying one — the
    // second arm is what keeps `DE8` attached to the IBAN it begins.
    const carriesDigits = groupDigits * 2 >= groupLength;
    const isPrefix = groupLength <= MAX_PREFIX_GROUP && groupDigits >= 1 && !groupLower;
    if (!carriesDigits && !isPrefix) {
      flush();
      continue;
    }

    if (start < 0) start = groupStart;
    end = i;
    alnum += groupLength;
    digits += groupDigits;
    groups += 1;
    if (groupLength < READABLE_GROUP) shortGroups += 1;
    if (groupLower) lower = true;

    const gap = text[i];
    const after = text[i + 1];
    if (
      gap !== undefined &&
      isScanSeparator(gap) &&
      after !== undefined &&
      isAsciiAlnum(after)
    ) {
      if (gap !== ' ') foldable = true;
      i += 1;
      continue;
    }

    flush();
  }

  flush();
  return chains;
}

function foldIdentifierRuns(
  text: string,
  separators: boolean,
  caseFold: boolean,
  closeGaps: boolean,
): Stage | null {
  const chains = identifierChains(text);
  if (chains.length === 0) return null;

  const rewriter = new Rewriter();
  let changed = false;
  let cursor = 0;

  for (const [start, end, shredded] of chains) {
    rewriter.keep(text, cursor, start);

    for (let i = start; i < end; i += 1) {
      const ch = text[i] as string;

      // Closing the gaps is a SEPARATE copy, not a variant of this one. The
      // identifier fold normalises a separator to a space and keeps the group
      // boundaries, which is what hands the detectors the conventional spelling
      // they already read; deleting instead would let two adjacent identifiers
      // run into one another. Shredding is the case where the boundaries
      // themselves are the lie — no grouping below four characters is one the
      // detectors read — so it gets its own copy where the gaps close, and both
      // readings are offered rather than one being sacrificed for the other.
      if (closeGaps && shredded && (ch === ' ' || FOLDABLE_SEPARATORS.has(ch))) {
        rewriter.drop(i, i + 1);
        changed = true;
        continue;
      }

      if (separators && ch !== ' ' && FOLDABLE_SEPARATORS.has(ch)) {
        rewriter.replace(' ', i, i + 1, text);
        changed = true;
        continue;
      }

      const upper = caseFold ? ch.toUpperCase() : ch;
      if (upper === ch) {
        rewriter.keep(text, i, i + 1);
        continue;
      }
      // `ß` upper-cases to two characters; the map handles the expansion
      // the same way the NFKC pass does, by pointing both units at the source.
      rewriter.replace(upper, i, i + 1, text);
      changed = true;
    }

    cursor = end;
  }

  rewriter.keep(text, cursor, text.length);
  return changed ? rewriter.finish(text) : null;
}

/* ------------------------------------------------------------ label lookup */

/**
 * The label side of the scan copy: the same fold, applied to a comparison
 * rather than to a copy.
 *
 * {@link LabelProximity} and {@link DEFAULT_LABEL_WINDOW} live in `types.ts`
 * because they are part of the detector contract; the matching lives here
 * because it is the same question the folds above answer — which spellings of
 * a thing are the same thing.
 */

/**
 * Reduce text to what a label comparison should care about: letters and digits.
 *
 * Case, spacing, punctuation and diacritics are exactly the things a writer
 * varies without meaning anything by it — `St.-Nr.`, `St Nr` and `StNr` are one
 * label — and exactly the things an evader varies meaning a great deal by it.
 * Folding both sides of the comparison the same way settles both at once.
 */
export function foldForCompare(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Folded labels, keyed by the array the detector declared them in.
 *
 * Detectors are built once and used for every request, so the fold is paid for
 * once per detector rather than once per candidate span.
 */
const foldedLabels = new WeakMap<readonly string[], readonly string[]>();

function labelsOf(proximity: LabelProximity): readonly string[] {
  const cached = foldedLabels.get(proximity.labels);
  if (cached !== undefined) return cached;
  const folded = proximity.labels.map(foldForCompare).filter((label) => label.length > 0);
  foldedLabels.set(proximity.labels, folded);
  return folded;
}

/**
 * True when one of `proximity.labels` sits within the window around
 * `[start, end)` of `text`.
 *
 * The two sides are folded and searched separately rather than joined, so the
 * tail of the text before the value and the head of the text after it can never
 * spell a label between them that nobody wrote.
 */
export function labelNear(
  text: string,
  start: number,
  end: number,
  proximity: LabelProximity,
): boolean {
  const labels = labelsOf(proximity);
  if (labels.length === 0) return false;

  const window = proximity.window ?? DEFAULT_LABEL_WINDOW;
  const where = proximity.where ?? 'either';

  if (where !== 'after') {
    const before = foldForCompare(text.slice(Math.max(0, start - window), start));
    if (labels.some((label) => before.includes(label))) return true;
  }

  if (where !== 'before') {
    const after = foldForCompare(text.slice(end, Math.min(text.length, end + window)));
    if (labels.some((label) => after.includes(label))) return true;
  }

  return false;
}
