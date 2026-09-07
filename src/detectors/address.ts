/**
 * German postal addresses.
 *
 * This is the detector with the worst precision problem in the whole set, and
 * the design is shaped by that rather than by recall. A German business letter
 * is *full* of the words this detector keys on — `Parkplatz`, `Bahnsteig`,
 * `Radweg`, `Sackgasse`, `Verkäufer` — and an operator whose outbound mail
 * comes back shredded switches the detector off, which leaves every real
 * address unprotected. A miss costs one address; a false positive costs all of
 * them. Every rule below is chosen with that asymmetry in mind, and the ones
 * that cost recall are marked as such.
 *
 * The signal is the street *type*, never the name: `-straße`, `-weg`,
 * `-platz`. On its own it is worth nothing, because those are ordinary German
 * word endings. What makes an address is the pair — a street type and a house
 * number directly against it — and the pair is graded:
 *
 *  - {@link STRONG_STREET_SUFFIXES} are endings no German common noun has, so
 *    street plus number is enough on its own.
 *  - {@link WEAK_STREET_SUFFIXES} are endings dozens of common nouns have, so
 *    street plus number is *not* enough: a postcode or an address label has to
 *    back it up as well. This is why `Der Parkplatz 12 ist frei` stays silent
 *    while `Rathausplatz 1, 76133 Karlsruhe` does not.
 *
 * The label check is done inline with {@link labelNear} rather than through
 * `requiresLabel`, because `requiresLabel` is all-or-nothing per detector and
 * the strong suffixes must keep firing unaccompanied.
 */
import { DEFAULT_PRIORITIES, type Detector, type LabelProximity, type Span } from '../types.js';
import { foldForCompare, labelNear } from './normalise.js';
import { isDigit } from './util.js';

/**
 * Priority for `POSTAL_ADDRESS`.
 *
 * The rank lives in `DEFAULT_PRIORITIES` and only ever settles a tie between two
 * overlapping spans of *identical* length, which an address — several words
 * long, and the longest claimant on any text it covers — essentially never
 * enters. 59 places it above the date of birth (58) and the phone number (55),
 * whose digit runs are the only plausible neighbours, and below the BIC (60)
 * and the MAC address (62), whose formats are the stronger claim wherever any
 * of them could somehow collide.
 */
export const POSTAL_ADDRESS_PRIORITY = DEFAULT_PRIORITIES.POSTAL_ADDRESS;

/**
 * Street types that no ordinary German noun ends in.
 *
 * `-straße` and `-chaussee` and `-allee` close a word only when that word is a
 * street; `-str` closes no German word at all. So a house number directly
 * against one of these is enough on its own.
 *
 * Both spellings of `-straße` are listed rather than folded, because the fold
 * `ß` → `ss` changes the *length* of the match and the length is what maps the
 * suffix back onto the characters actually written.
 */
export const STRONG_STREET_SUFFIXES: readonly string[] = [
  'straße',
  'strasse',
  'str',
  'chaussee',
  'allee',
];

/**
 * Street types that are also ordinary German word endings.
 *
 * `Parkplatz`, `Bahnsteig`, `Radweg`, `Sackgasse`, `Staudamm`, `Verkäufer` —
 * every one of these ends in a street type and every one of them turns up in
 * business prose followed by a number. A detector that reported the pair would
 * fire several times per invoice, so these need a postcode or an address label
 * as well. The cost is real and deliberate: a bare `Lindenweg 5` is missed.
 */
export const WEAK_STREET_SUFFIXES: readonly string[] = [
  'weg',
  'platz',
  'gasse',
  'ring',
  'damm',
  'ufer',
  'steig',
];

/**
 * The abbreviation that may carry a trailing dot.
 *
 * Only `Kaiserstr.` is written that way. Allowing the dot everywhere would
 * make a sentence boundary look like an address: `Wir ziehen in die
 * Kaiserstraße. 12 Kollegen kommen mit.` would read as house number 12.
 */
const ABBREVIATED_SUFFIXES: ReadonlySet<string> = new Set(['str']);

/**
 * German words that end in a street type but are not street names.
 *
 * A seed, not a closed list — there is no authoritative register of German
 * common nouns, and there could not be one, because the same word is a noun in
 * one sentence and a street name in the next (`Feldweg` and `Waldweg` are both,
 * which is why they are deliberately *absent* here). Extend it through
 * {@link PostalAddressOptions.nonAddressWords} for the vocabulary a particular
 * customer's mail actually contains.
 *
 * Comparison goes through {@link foldForCompare} plus a `ß` → `ss` fold, so
 * case, hyphens and umlauts are all already handled; `VERKÄUFER`, `Verkäufer`
 * and `Verkaeufer`'s NFC twin all reduce to the same key.
 */
export const NON_ADDRESS_WORDS: readonly string[] = [
  // -platz
  'Parkplatz', 'Stellplatz', 'Abstellplatz', 'Arbeitsplatz', 'Sitzplatz',
  'Lagerplatz', 'Bauplatz', 'Speicherplatz', 'Spielplatz', 'Messeplatz',
  'Liegeplatz', 'Standplatz', 'Ausstellungsplatz',
  // -steig
  'Bahnsteig',
  // -weg
  'Radweg', 'Fußweg', 'Gehweg', 'Umweg', 'Ausweg', 'Hinweg', 'Rückweg',
  'Heimweg', 'Dienstweg', 'Rechtsweg', 'Postweg', 'Lösungsweg',
  'Vertriebsweg', 'Wanderweg', 'Lieferweg', 'Instanzenweg',
  // -gasse
  'Sackgasse',
  // -ring
  'Hering', 'Ohrring', 'Dichtring', 'Kolbenring', 'Rettungsring',
  'Schlüsselring', 'Jahresring', 'Sicherungsring',
  // -damm
  'Staudamm',
  // -ufer
  'Verkäufer', 'Käufer', 'Einkäufer', 'Aufkäufer', 'Läufer', 'Vorläufer',
  'Mitläufer', 'Nachläufer',
];

/**
 * Determiners and possessives, which are the words that would otherwise stand
 * in for a street name in the separated spelling.
 *
 * `Berger Straße 5` and `Die Straße 5` have the same shape; only the vocabulary
 * separates them. Adjectives that really do open street names — `Lange`,
 * `Neue`, `Alte`, `Breite`, `Große` — are pointedly not here.
 */
const DETERMINERS: readonly string[] = [
  'die', 'der', 'das', 'dem', 'den', 'des',
  'ein', 'eine', 'einer', 'einem', 'einen', 'eines',
  'diese', 'dieser', 'diesem', 'diesen', 'dieses',
  'jede', 'jeder', 'jedem', 'jeden', 'jedes',
  'kein', 'keine', 'keiner', 'keinem', 'keinen',
  'unser', 'unsere', 'unserer', 'unseren',
  'ihre', 'ihrer', 'ihren', 'ihrem',
  'sein', 'seine', 'seiner', 'seinen',
  'welche', 'welcher', 'welchen', 'jene', 'jener', 'jenen',
  'alle', 'aller', 'allen', 'beide', 'beiden',
  'mein', 'meine', 'meiner', 'solche', 'solcher',
  'andere', 'anderer', 'anderen', 'deren', 'dessen',
];

/**
 * The words that license a weak street type without a postcode.
 *
 * Declared once at module level so the fold `labelNear` performs is cached
 * against this array's identity rather than repeated per candidate. A detector
 * built through {@link createPostalAddressDetector} gets one array per
 * instance, which is still once per process.
 */
export const POSTAL_ADDRESS_LABELS: readonly string[] = [
  'Anschrift',
  'Adresse',
  'Postanschrift',
  'Hausanschrift',
  'Lieferanschrift',
  'Rechnungsanschrift',
  'wohnhaft',
  'Wohnort',
  'Firmensitz',
  'Geschäftssitz',
  'Standort',
];

/**
 * Words that end the place name.
 *
 * A footer writes `76133 Karlsruhe Tel. 0721 …` on one line, and without this
 * the place would swallow the label of the next field. A seed list, extended in
 * practice by whatever a customer's letterhead puts there.
 */
const PLACE_STOP_WORDS: readonly string[] = [
  'Tel', 'Telefon', 'Fax', 'Mobil', 'Mail', 'E-Mail', 'Handy', 'Web', 'www',
  'Herr', 'Frau', 'Firma', 'Postfach', 'USt', 'UStIdNr', 'HRB', 'HRA',
  'Amtsgericht', 'Geschäftsführer', 'Telefax',
];

/** Lower-case words that may sit inside a place name. */
const PLACE_CONNECTORS: ReadonlySet<string> = new Set([
  'am', 'an', 'im', 'ob', 'der', 'den', 'a', 'd', 'i',
]);

/**
 * German house numbers run to three digits with a couple of exceptions nobody
 * can name. A fourth digit is a year, an amount or an article number far more
 * often than it is a door, so the cap is the cheapest false-positive control in
 * the module: it is what keeps `Kaiserstraße 2019 saniert` silent.
 */
const MAX_HOUSE_NUMBER_DIGITS = 3;

/** How many letters the street name itself must carry, suffix excluded. */
const MIN_NAME_LETTERS = 2;

/** Whitespace tolerated inside an address, in characters, per gap. */
const MAX_GAP = 4;

/** Words of place name kept after the postcode. */
const MAX_PLACE_TOKENS = 4;

/** Longest token still worth reducing to a comparison key. */
const MAX_KEYED_WORD = 64;

/** How to build a postal address detector. */
export interface PostalAddressOptions {
  /** Extra street types strong enough to fire on street plus house number. */
  readonly streetSuffixes?: readonly string[];
  /** Extra street types that need a postcode or a label as well. */
  readonly weakStreetSuffixes?: readonly string[];
  /** Extra words that end in a street type but are not street names. */
  readonly nonAddressWords?: readonly string[];
  /** Replace the labels that license a weak street type. */
  readonly labels?: readonly string[];
  /**
   * The authoritative postcode list, when the deployment has one.
   *
   * Germany has roughly 8200 postcodes and the register belongs to Deutsche
   * Post (Postleitzahlenverzeichnis); shipping a guessed copy would reject real
   * addresses, so the default check is structural only — five digits that do
   * not start `00`. Hand the real list in here and the check becomes exact.
   */
  readonly postcodes?: ReadonlySet<string> | ((postcode: string) => boolean);
}

interface SuffixEntry {
  readonly text: string;
  readonly strong: boolean;
  readonly abbreviation: boolean;
}

interface Compiled {
  /** Suffixes bucketed by their last character; the pre-filter for every token. */
  readonly byLastChar: ReadonlyMap<string, readonly SuffixEntry[]>;
  readonly longestSuffix: number;
  readonly blocked: ReadonlySet<string>;
  readonly determiners: ReadonlySet<string>;
  readonly stopWords: ReadonlySet<string>;
  readonly proximity: LabelProximity;
  readonly knownPostcode: ((postcode: string) => boolean) | null;
}

/** Case-, separator- and diacritic-insensitive key, with `ß` folded to `ss`. */
function wordKey(value: string): string {
  return foldForCompare(value).replaceAll('ß', 'ss');
}

const LETTER = /\p{L}/u;

/**
 * ASCII is decided arithmetically and only the rest reaches the regex.
 *
 * This predicate runs once per character of every request body, so the
 * difference between a property test and a range check is the difference
 * between a few milliseconds and a few hundred on a large document.
 */
function isLetter(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  if (code < 128) return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return LETTER.test(ch);
}

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

const HYPHENS: ReadonlySet<string> = new Set([
  '-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212',
]);
const APOSTROPHES: ReadonlySet<string> = new Set(["'", '\u2019', '\u02BC']);

/** Characters that hold a street or place name together. */
const isNameChar = (ch: string): boolean =>
  isLetter(ch) || HYPHENS.has(ch) || APOSTROPHES.has(ch);

const INLINE_SPACES: ReadonlySet<string> = new Set([
  ' ', '\t', '\u00A0', '\u1680', '\u202F', '\u205F', '\u3000',
]);

/**
 * Whitespace that does not end a line.
 *
 * The line break is treated separately and only one is ever crossed, because
 * the break between `Kaiserstraße 12` and `76133 Karlsruhe` is the one piece of
 * an address's layout that is load-bearing — and a blank line between two
 * paragraphs must not glue them into one address.
 */
const isInlineSpace = (ch: string): boolean =>
  INLINE_SPACES.has(ch) || (ch >= '\u2000' && ch <= '\u200A');

/** Marks that join two house numbers into a range. */
const RANGE_MARKS: ReadonlySet<string> = new Set([
  '-', '\u2010', '\u2011', '\u2013', '\u2212', '/',
]);

/** `text[i]`, or the empty string outside the text — never `undefined`. */
const at = (text: string, index: number): string => text[index] ?? '';

const isUpperLetter = (ch: string): boolean => isLetter(ch) && ch.toLowerCase() !== ch;
const isLowerLetter = (ch: string): boolean => isLetter(ch) && ch.toUpperCase() !== ch;

function compile(options: PostalAddressOptions): Compiled {
  const entries: SuffixEntry[] = [];
  const add = (list: readonly string[], strong: boolean): void => {
    for (const raw of list) {
      const text = raw.toLowerCase();
      if (text.length === 0) continue;
      entries.push({ text, strong, abbreviation: ABBREVIATED_SUFFIXES.has(text) });
    }
  };

  add(STRONG_STREET_SUFFIXES, true);
  add(options.streetSuffixes ?? [], true);
  add(WEAK_STREET_SUFFIXES, false);
  add(options.weakStreetSuffixes ?? [], false);

  const byLastChar = new Map<string, SuffixEntry[]>();
  for (const entry of entries) {
    const last = entry.text[entry.text.length - 1] ?? '';
    const bucket = byLastChar.get(last);
    if (bucket === undefined) byLastChar.set(last, [entry]);
    else bucket.push(entry);
  }
  // Longest first, so `-strasse` is never read as the shorter `-str` would be.
  for (const bucket of byLastChar.values()) bucket.sort((a, b) => b.text.length - a.text.length);

  const postcodes = options.postcodes;
  const knownPostcode =
    postcodes === undefined
      ? null
      : typeof postcodes === 'function'
        ? postcodes
        : (postcode: string): boolean => postcodes.has(postcode);

  return {
    byLastChar,
    longestSuffix: entries.reduce((max, entry) => Math.max(max, entry.text.length), 0),
    blocked: new Set([...NON_ADDRESS_WORDS, ...(options.nonAddressWords ?? [])].map(wordKey)),
    determiners: new Set(DETERMINERS.map(wordKey)),
    stopWords: new Set(PLACE_STOP_WORDS.map(wordKey)),
    proximity: { labels: options.labels ?? POSTAL_ADDRESS_LABELS },
    knownPostcode,
  };
}

interface SuffixMatch {
  readonly length: number;
  readonly strong: boolean;
  readonly abbreviation: boolean;
}

/**
 * Which street type a token ends in, if any.
 *
 * Bucketing by last character is what keeps this affordable: a German word
 * ending in a letter no street type ends in — the overwhelming majority — costs
 * one map lookup and nothing else.
 */
function matchSuffix(text: string, start: number, end: number, cfg: Compiled): SuffixMatch | null {
  const width = Math.min(end - start, cfg.longestSuffix);
  if (width === 0) return null;

  const tail = text.slice(end - width, end).toLowerCase();
  // Lower-casing changes length for a handful of code points (`İ` is the one
  // that turns up). When it does, the suffix length no longer maps back onto
  // the characters written, so the token is dropped rather than mis-sliced.
  if (tail.length !== width) return null;

  const bucket = cfg.byLastChar.get(tail[tail.length - 1] ?? '');
  if (bucket === undefined) return null;

  for (const entry of bucket) {
    if (entry.text.length <= width && tail.endsWith(entry.text)) {
      return { length: entry.text.length, strong: entry.strong, abbreviation: entry.abbreviation };
    }
  }

  return null;
}

function countLetters(text: string, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (isLetter(at(text, i))) count += 1;
  }
  return count;
}

/** True when a lower-case letter is directly followed by an upper-case one. */
function hasCaseBoundary(text: string, start: number, end: number): boolean {
  for (let i = start; i + 1 < end; i++) {
    if (isLowerLetter(at(text, i)) && isUpperLetter(at(text, i + 1))) return true;
  }
  return false;
}

function skipInlineSpaces(text: string, from: number, max: number): number {
  let i = from;
  let seen = 0;
  while (seen < max && isInlineSpace(at(text, i))) {
    i += 1;
    seen += 1;
  }
  return i;
}

/** End of a run of name characters, trimmed back to the last letter. */
function readWord(text: string, from: number): number {
  let i = from;
  while (i < text.length && isNameChar(at(text, i))) i += 1;
  while (i > from && !isLetter(at(text, i - 1))) i -= 1;
  return i;
}

/**
 * A house number: up to three digits, plus the letter German addresses glue
 * onto them.
 *
 * The letter is only ever taken when it is glued (`12a`). A space in front of
 * it (`12 a`) is far more often a unit — `5 m`, `12 x` — than a house number
 * suffix, and that spelling is given up rather than paid for.
 */
function readHouseNumber(text: string, from: number): number | null {
  let i = from;
  while (i < text.length && isDigit(at(text, i))) i += 1;

  const digits = i - from;
  if (digits < 1 || digits > MAX_HOUSE_NUMBER_DIGITS) return null;

  const letter = at(text, i);
  if (isAsciiLetter(letter) && !isLetter(at(text, i + 1)) && !isDigit(at(text, i + 1))) i += 1;

  return i;
}

/** `12-14`, `12 - 14`, `12a/14b`. */
function readNumberRange(text: string, from: number): number | null {
  const mark = skipInlineSpaces(text, from, 1);
  if (!RANGE_MARKS.has(at(text, mark))) return null;
  return readHouseNumber(text, skipInlineSpaces(text, mark + 1, 1));
}

/**
 * What may sit directly behind a house number that no postcode follows.
 *
 * This is where dates and money are turned away. `12.05.2024` and `12,50 EUR`
 * both open with something that reads as a house number, and both are ordinary
 * content of the mail this proxy sits in front of — so a digit behind a dot,
 * comma or range mark disqualifies the whole reading rather than merely
 * shortening it.
 */
function numberEndsCleanly(text: string, end: number): boolean {
  const ch = at(text, end);
  if (ch === '') return true;
  if (isDigit(ch) || isLetter(ch)) return false;
  if ((ch === '.' || ch === ',' || RANGE_MARKS.has(ch)) && isDigit(at(text, end + 1))) return false;
  return ch !== ':' && ch !== '%' && ch !== '€' && ch !== '$' && ch !== '°';
}

/** `D-`, `DE-` in front of the postcode. */
function skipCountryPrefix(text: string, from: number): number {
  const first = at(text, from);
  if (first !== 'D' && first !== 'd') return from;
  if (isLetter(at(text, from - 1))) return from;

  if (HYPHENS.has(at(text, from + 1))) return from + 2;
  const second = at(text, from + 1);
  if ((second === 'E' || second === 'e') && HYPHENS.has(at(text, from + 2))) return from + 3;
  return from;
}

function isPlausiblePostcode(postcode: string, cfg: Compiled): boolean {
  if (cfg.knownPostcode !== null) return cfg.knownPostcode(postcode);
  // Structural only: the 0 Leitzone exists but `00xxx` is not issued.
  return !postcode.startsWith('00');
}

/**
 * The postcode line, when there is one: `, 76133 Karlsruhe`, `\n76133
 * Karlsruhe`, `D-76133 Karlsruhe`.
 *
 * Returns the end of everything consumed, or `null` when no postcode follows.
 * A postcode with no place after it still counts — it is the postcode that
 * corroborates, and a truncated address block is still an address block.
 */
function readPostcodeAndPlace(text: string, from: number, cfg: Compiled): number | null {
  let i = skipInlineSpaces(text, from, MAX_GAP);
  if (at(text, i) === ',') i = skipInlineSpaces(text, i + 1, MAX_GAP);
  if (at(text, i) === '\r') i += 1;
  if (at(text, i) === '\n') i = skipInlineSpaces(text, i + 1, MAX_GAP);

  i = skipCountryPrefix(text, i);

  if (isDigit(at(text, i - 1))) return null;
  const postcode = text.slice(i, i + 5);
  if (postcode.length !== 5) return null;
  for (const ch of postcode) {
    if (!isDigit(ch)) return null;
  }
  if (isDigit(at(text, i + 5))) return null;
  if (!isPlausiblePostcode(postcode, cfg)) return null;

  return readPlace(text, i + 5, cfg);
}

/**
 * The place name after the postcode, on the postcode's own line.
 *
 * Bounded three ways — token count, the line, and a stop-word list — because
 * over-reaching here redacts ordinary prose that happens to follow an address,
 * which is the same failure as a false positive, only quieter.
 */
function readPlace(text: string, from: number, cfg: Compiled): number {
  let end = from;
  let i = from;
  let taken = 0;

  while (taken < MAX_PLACE_TOKENS) {
    const wordStart = skipInlineSpaces(text, i, MAX_GAP);
    if (wordStart === i) break;

    const wordEnd = readWord(text, wordStart);
    if (wordEnd === wordStart) break;

    const word = text.slice(wordStart, wordEnd);
    if (word.length <= MAX_KEYED_WORD && cfg.stopWords.has(wordKey(word))) break;

    if (isUpperLetter(at(text, wordStart))) {
      end = wordEnd;
      i = wordEnd;
      taken += 1;
      continue;
    }

    // `Frankfurt am Main`: a lower-case connector counts only when the place
    // name actually continues after it.
    if (!PLACE_CONNECTORS.has(word.toLowerCase())) break;
    const nextStart = skipInlineSpaces(text, wordEnd, MAX_GAP);
    if (nextStart === wordEnd) break;
    const nextEnd = readWord(text, nextStart);
    if (nextEnd === nextStart || !isUpperLetter(at(text, nextStart))) break;

    end = nextEnd;
    i = nextEnd;
    taken += 2;
  }

  return end;
}

/**
 * The street name written as its own word: `Berger Straße 5`, `Lange Straße 5`.
 *
 * Returns the start of the preceding word, or `null` when there is nothing
 * usable in front. `Die Straße 12` has exactly this shape, so the word has to
 * clear the determiner list — and the caller demands corroboration on top,
 * because the separated spelling is the one an ordinary sentence can imitate.
 */
function readSeparateName(text: string, tokenStart: number, cfg: Compiled): number | null {
  if (!isInlineSpace(at(text, tokenStart - 1))) return null;

  const last = tokenStart - 2;
  if (!isLetter(at(text, last))) return null;

  let start = last;
  while (start - 1 >= 0 && isNameChar(at(text, start - 1))) start -= 1;
  while (start < last && !isLetter(at(text, start))) start += 1;

  if (!isUpperLetter(at(text, start))) return null;
  if (countLetters(text, start, last + 1) < MIN_NAME_LETTERS) return null;

  const word = text.slice(start, last + 1);
  if (word.length <= MAX_KEYED_WORD && cfg.determiners.has(wordKey(word))) return null;
  if (word.length <= MAX_KEYED_WORD && cfg.blocked.has(wordKey(word))) return null;

  return start;
}

interface AddressMatch {
  readonly start: number;
  readonly end: number;
}

/**
 * Read one address anchored on the street-type token `[tokenStart, tokenEnd)`.
 */
function readAddress(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  cfg: Compiled,
): AddressMatch | null {
  const suffix = matchSuffix(text, tokenStart, tokenEnd, cfg);
  if (suffix === null) return null;

  const token = text.slice(tokenStart, tokenEnd);
  if (token.length <= MAX_KEYED_WORD && cfg.blocked.has(wordKey(token))) return null;

  // The abbreviation without its dot is also how a great deal of code spells a
  // string variable. No German street name has an internal case boundary and
  // `nameStr` has nothing else, so that is what separates them.
  const dotted = suffix.abbreviation && at(text, tokenEnd) === '.';
  if (suffix.abbreviation && !dotted && hasCaseBoundary(text, tokenStart, tokenEnd)) return null;

  let start = tokenStart;
  let needsSupport = !suffix.strong;

  if (countLetters(text, tokenStart, tokenEnd - suffix.length) < MIN_NAME_LETTERS) {
    if (!suffix.strong) return null;
    const separate = readSeparateName(text, tokenStart, cfg);
    if (separate === null) return null;
    start = separate;
    needsSupport = true;
  }

  const afterStreet = dotted ? tokenEnd + 1 : tokenEnd;
  const numberStart = skipInlineSpaces(text, afterStreet, MAX_GAP);
  let numberEnd = readHouseNumber(text, numberStart);

  if (numberEnd === null) {
    return readEnglishOrder(text, start, tokenStart, afterStreet, suffix, cfg);
  }

  const ranged = readNumberRange(text, numberEnd);
  if (ranged !== null) numberEnd = ranged;

  const place = readPostcodeAndPlace(text, numberEnd, cfg);
  if (place === null && !numberEndsCleanly(text, numberEnd)) return null;

  const end = place ?? numberEnd;
  if (needsSupport && place === null && !labelNear(text, start, end, cfg.proximity)) return null;

  return { start, end };
}

/**
 * `12 Kaiserstrasse, 76133 Karlsruhe` — the order an English-language system
 * writes a German address in.
 *
 * Supported, but only for a strong street type and only with a postcode or an
 * address label behind it. Unaccompanied it is indistinguishable from a
 * numbered list of street names, which is a shape that turns up in minutes and
 * route plans far more often than an English-ordered address turns up in German
 * business mail. The list marker's dot is refused outright for the same reason.
 */
function readEnglishOrder(
  text: string,
  start: number,
  tokenStart: number,
  afterStreet: number,
  suffix: SuffixMatch,
  cfg: Compiled,
): AddressMatch | null {
  if (!suffix.strong) return null;
  if (start !== tokenStart) return null;
  if (!isInlineSpace(at(text, tokenStart - 1))) return null;

  let last = tokenStart - 2;
  if (isAsciiLetter(at(text, last)) && isDigit(at(text, last - 1))) last -= 1;
  if (!isDigit(at(text, last))) return null;

  let numberStart = last;
  while (numberStart - 1 >= 0 && isDigit(at(text, numberStart - 1))) numberStart -= 1;
  if (last - numberStart + 1 > MAX_HOUSE_NUMBER_DIGITS) return null;

  const before = at(text, numberStart - 1);
  if (isLetter(before) || isDigit(before) || before === '.' || before === ',') return null;
  if (HYPHENS.has(before)) return null;

  const place = readPostcodeAndPlace(text, afterStreet, cfg);
  const end = place ?? afterStreet;
  if (place === null && !labelNear(text, numberStart, end, cfg.proximity)) return null;

  return { start: numberStart, end };
}

function findAddresses(text: string, cfg: Compiled): Span[] {
  const out: Span[] = [];
  let i = 0;

  while (i < text.length) {
    if (!isLetter(at(text, i))) {
      i += 1;
      continue;
    }

    // One token, hyphenated compounds included: `Karl-Marx-Allee` is one name.
    let tokenEnd = i;
    while (tokenEnd < text.length && isNameChar(at(text, tokenEnd))) tokenEnd += 1;
    const scanned = tokenEnd;
    while (tokenEnd > i && !isLetter(at(text, tokenEnd - 1))) tokenEnd -= 1;

    const address = readAddress(text, i, tokenEnd, cfg);
    if (address !== null) {
      out.push({
        start: address.start,
        end: address.end,
        kind: 'POSTAL_ADDRESS',
        value: text.slice(address.start, address.end),
        detector: 'postal-address',
        priority: POSTAL_ADDRESS_PRIORITY,
      });
      i = Math.max(scanned, address.end);
      continue;
    }

    i = scanned;
  }

  return out;
}

/**
 * Build a postal address detector.
 *
 * Everything a deployment might need to tune — the street types, the words that
 * are not street names, the labels, the authoritative postcode list — is an
 * option here rather than a constant, because the false-positive vocabulary is
 * the part that differs between a Steuerberater's mail and a logistics
 * company's.
 */
export function createPostalAddressDetector(options: PostalAddressOptions = {}): Detector {
  const cfg = compile(options);

  return {
    name: 'postal-address',
    priority: POSTAL_ADDRESS_PRIORITY,

    find(text: string): Span[] {
      return findAddresses(text, cfg);
    },
  };
}

/** German postal addresses, with the built-in street types and word lists. */
export const postalAddressDetector: Detector = createPostalAddressDetector();
