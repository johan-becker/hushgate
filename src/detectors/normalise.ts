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
 * Two transformations, in one pass:
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
 */
export function normaliseForScan(text: string): NormalisedText {
  if (!NON_ASCII.test(text)) return unchanged(text);

  const units: string[] = [];
  const offsets: number[] = [];
  let changed = false;

  const length = text.length;
  let index = 0;

  while (index < length) {
    const code = text.codePointAt(index) as number;
    const width = code > 0xffff ? 2 : 1;

    if (isInvisible(code)) {
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
      if (isInvisible(next)) {
        changed = true;
        end += nextWidth;
        continue;
      }
      if (!isCombining(next)) break;
      source += String.fromCodePoint(next);
      end += nextWidth;
    }

    const folded = source.normalize('NFKC');
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
