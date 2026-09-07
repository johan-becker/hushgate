/**
 * Postleitzahl.
 *
 * Five digits are not a finding. They are an order quantity, a part number, a
 * price in cents and a year in a range of years, and a detector that reports
 * them all is a detector the customer switches off within the hour. So nothing
 * here fires on shape: a PLZ is reported only when something *else* in the text
 * says it is one — a label, a country prefix, or a place name behind it.
 */
import { DEFAULT_PRIORITIES, type Detector, type LabelProximity, type Span } from '../types.js';
import { foldForCompare, labelNear } from './normalise.js';
import { isDigit, isWordChar, memberAt } from './util.js';

export const POSTCODE_KIND = 'POSTCODE';

/**
 * Priority for a postcode.
 *
 * 48 in `DEFAULT_PRIORITIES` keeps it under every detector that can prove its
 * claim arithmetically and above a dictionary hit, which is the right order for
 * a value whose whole case rests on the words around it.
 */
export const POSTCODE_PRIORITY = DEFAULT_PRIORITIES.POSTCODE;

const POSTCODE_LENGTH = 5;

/**
 * Five digits in 01000-99999.
 *
 * The Deutsche Post never allocated the 00000 block, so a leading double zero
 * is the one shape that can be refused outright. Everything above that is
 * accepted: the allocated set has holes, but they are holes in the same
 * ~8200-entry table that {@link PostcodeOptions.placeMatches} exists for, and
 * guessing them from the leading digits would reject real addresses.
 */
export function isPostcodeShaped(value: string): boolean {
  if (value.length !== POSTCODE_LENGTH) return false;
  if (!/^\d{5}$/u.test(value)) return false;
  return !value.startsWith('00');
}

/**
 * Labels that name the field.
 *
 * Declared once at module level: the fold that turns these into comparison
 * keys is cached against this array's identity, so a fresh array per call
 * would repay it on every request.
 */
export const POSTCODE_LABELS: readonly string[] = ['PLZ', 'Postleitzahl', 'Postcode'];

/**
 * A much tighter window than the 64-character default, and only ahead of the
 * digits. Both numbers were set by the sentences they let through.
 *
 * `Bitte tragen Sie Ihre PLZ ein. Der Betrag von 12345 Euro` licenses the
 * amount at any window over about twenty, and `Betrag 12345, PLZ 76133`
 * licenses the amount from *behind* at any window at all. Sixteen characters
 * ahead is enough for `Postleitzahl: ` against the field, which is where a
 * form writes it, and not enough for the previous clause.
 *
 * What it gives up is the table whose header row says `PLZ` two lines above
 * the value. Those tables name the Ort in the next column anyway, and the
 * place-name path picks them up.
 */
const POSTCODE_PROXIMITY: LabelProximity = {
  labels: POSTCODE_LABELS,
  window: 16,
  where: 'before',
};

/** Country prefixes written in front of a German postcode. */
export const DEFAULT_POSTCODE_PREFIXES: readonly string[] = ['D', 'DE'];

/**
 * The place-name seed.
 *
 * THIS IS A SUBSET. The authoritative table is the Deutsche Post PLZ-
 * Verzeichnis, roughly 8200 postcode-to-Ort pairs, and it is not something to
 * reproduce from memory: this is the list of German cities an address is most
 * likely to name, and nothing more.
 *
 * A place missing from here costs a finding only when the postcode also has no
 * label and no country prefix. {@link PostcodeOptions.places} closes the gap
 * without touching this file.
 *
 * Only single-word names are seeded, because that is what the token reader
 * behind {@link PostcodeOptions.placeMatches} compares; `Frankfurt am Main`
 * matches on `Frankfurt`.
 */
export const SEED_PLACE_NAMES: readonly string[] = [
  'Aachen', 'Aschaffenburg', 'Augsburg', 'Bamberg', 'Baden-Baden', 'Bayreuth',
  'Berlin', 'Bielefeld', 'Bocholt', 'Bochum', 'Bonn', 'Bottrop', 'Brandenburg',
  'Braunschweig', 'Bremen', 'Bremerhaven', 'Celle', 'Chemnitz', 'Cottbus',
  'Darmstadt', 'Delmenhorst', 'Dessau', 'Detmold', 'Dortmund', 'Dresden',
  'Duisburg', 'Düren', 'Düsseldorf', 'Eisenach', 'Emden', 'Erfurt', 'Erlangen',
  'Essen', 'Esslingen', 'Flensburg', 'Frankfurt', 'Freiburg', 'Friedrichshafen',
  'Fulda', 'Fürth', 'Gelsenkirchen', 'Gera', 'Gießen', 'Görlitz', 'Göttingen',
  'Greifswald', 'Gütersloh', 'Hagen', 'Halle', 'Hamburg', 'Hameln', 'Hamm',
  'Hanau', 'Hannover', 'Heidelberg', 'Heilbronn', 'Herne', 'Hildesheim',
  'Ingolstadt', 'Iserlohn', 'Jena', 'Kaiserslautern', 'Karlsruhe', 'Kassel',
  'Kempten', 'Kiel', 'Koblenz', 'Konstanz', 'Krefeld', 'Köln', 'Landshut',
  'Leipzig', 'Leverkusen', 'Lippstadt', 'Ludwigsburg', 'Ludwigshafen', 'Lübeck',
  'Lüneburg', 'Magdeburg', 'Mainz', 'Mannheim', 'Marburg', 'Minden',
  'Mönchengladbach', 'Mülheim', 'München', 'Münster', 'Neubrandenburg', 'Neuss',
  'Nürnberg', 'Oberhausen', 'Offenbach', 'Offenburg', 'Oldenburg', 'Osnabrück',
  'Paderborn', 'Passau', 'Pforzheim', 'Potsdam', 'Ratingen', 'Ravensburg',
  'Regensburg', 'Remscheid', 'Reutlingen', 'Rosenheim', 'Rostock',
  'Saarbrücken', 'Salzgitter', 'Schwerin', 'Siegen', 'Sindelfingen', 'Solingen',
  'Speyer', 'Stralsund', 'Stuttgart', 'Suhl', 'Trier', 'Tübingen', 'Ulm',
  'Villingen-Schwenningen', 'Weimar', 'Wiesbaden', 'Wilhelmshaven', 'Witten',
  'Wolfsburg', 'Worms', 'Wuppertal', 'Würzburg', 'Zwickau',
];

/** How to build the detector. */
export interface PostcodeOptions {
  /**
   * Country prefixes accepted in front of the digits, hyphen included:
   * `D-76133`, `DE-76133`. Defaults to {@link DEFAULT_POSTCODE_PREFIXES};
   * compared upper-cased.
   */
  readonly countryPrefixes?: Iterable<string>;
  /** Further place names, merged over {@link SEED_PLACE_NAMES}. */
  readonly places?: Iterable<string>;
  /**
   * Replaces the seeded place lookup entirely.
   *
   * THE EXTENSION POINT FOR THE OFFICIAL TABLE, and for the check this
   * detector deliberately does not make: given the full PLZ-Verzeichnis, a
   * deployment can answer not only "is this a place" but "is this place in
   * that postcode", so that `76133 Hamburg` — the shape a template leaves
   * behind when someone edits half an address — stops being a finding. Doing
   * that here would mean shipping 8200 pairs from memory, which is how a
   * detector ends up confidently wrong about somebody's home town.
   *
   * Receives the five digits and the place token as written.
   */
  readonly placeMatches?: (postcode: string, place: string) => boolean;
}

const HYPHENS = new Set([
  '-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212',
  '\uFE58', '\uFE63', '\uFF0D',
]);

const GAP = new Set([' ', '\u00A0', '\u202F', '\u2007', ',']);

const isPlaceLetter = (ch: string): boolean => /[\p{L}]/u.test(ch);

/** True when `D-` or `DE-` sits directly in front of the digits. */
function hasCountryPrefix(text: string, start: number, prefixes: ReadonlySet<string>): boolean {
  const hyphen = text[start - 1];
  if (hyphen === undefined || !HYPHENS.has(hyphen)) return false;

  let i = start - 1;
  while (i > 0 && isPlaceLetter(text[i - 1]!)) i -= 1;

  const prefix = text.slice(i, start - 1);
  if (prefix.length === 0 || isWordChar(text, i - 1)) return false;
  return prefixes.has(prefix.toUpperCase());
}

/**
 * The place token behind the digits, or null.
 *
 * At most two characters of gap, and only a space or a comma: the place in a
 * German address is written against its postcode, and anything looser lets the
 * next sentence supply the evidence. Hyphenated names are read whole, so
 * `Baden-Baden` is one token rather than a town called `Baden` twice.
 */
function placeAfter(text: string, end: number): string | null {
  let i = end;
  let gap = 0;
  while (i < text.length && GAP.has(text[i]!)) {
    gap += 1;
    if (gap > 2) return null;
    i += 1;
  }
  if (gap === 0) return null;

  const start = i;
  while (i < text.length) {
    if (isPlaceLetter(text[i]!)) {
      i += 1;
      continue;
    }
    // A hyphen only continues the name when a letter follows it.
    if (HYPHENS.has(text[i]!) && i > start && memberAt(text, i + 1, isPlaceLetter)) {
      i += 1;
      continue;
    }
    break;
  }

  const place = text.slice(start, i);
  return place.length >= 3 ? place : null;
}

/**
 * Postleitzahl detector.
 *
 * One detector rather than two, because the three ways in are alternatives for
 * the same span rather than two different formats: `requiresLabel` would gate
 * the country prefix and the place name away too, so the label is asked for
 * inline — against a module-level {@link LabelProximity} so the fold cache
 * still holds.
 */
export function createPostcodeDetector(options: PostcodeOptions = {}): Detector {
  const prefixes = new Set(
    [...(options.countryPrefixes ?? DEFAULT_POSTCODE_PREFIXES)].map((code) => code.toUpperCase()),
  );
  const places = new Set(
    [...SEED_PLACE_NAMES, ...(options.places ?? [])].map((place) => foldForCompare(place)),
  );
  const placeMatches =
    options.placeMatches ?? ((_postcode: string, place: string) => places.has(foldForCompare(place)));

  return {
    name: 'postcode',
    priority: POSTCODE_PRIORITY,

    find(text: string): Span[] {
      const out: Span[] = [];
      let i = 0;

      while (i < text.length) {
        if (!memberAt(text, i, isDigit)) {
          i += 1;
          continue;
        }

        let end = i;
        while (memberAt(text, end, isDigit)) end += 1;
        const digits = text.slice(i, end);
        // The whole digit run is consumed either way: five digits taken out of
        // six are not a postcode, and re-entering the run would find them.
        const from = i;
        i = end;

        if (isWordChar(text, from - 1) || isWordChar(text, end)) continue;
        if (!isPostcodeShaped(digits)) continue;

        const place = placeAfter(text, end);
        const licensed =
          hasCountryPrefix(text, from, prefixes) ||
          (place !== null && placeMatches(digits, place)) ||
          labelNear(text, from, end, POSTCODE_PROXIMITY);
        if (!licensed) continue;

        out.push({
          start: from,
          end,
          kind: POSTCODE_KIND,
          value: digits,
          detector: 'postcode',
          priority: POSTCODE_PRIORITY,
        });
      }

      return out;
    },
  };
}

/** The detector as registered: German prefixes, the seeded places, the labels. */
export const postcodeDetector: Detector = createPostcodeDetector();
