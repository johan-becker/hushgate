/**
 * Kfz-Kennzeichen.
 *
 * The shape alone — a few letters, a few digits — is worth almost nothing: it
 * is also an article number, a room number and a norm reference. What makes a
 * plate a plate is the Unterscheidungszeichen, the closed register of district
 * codes in {@link GERMAN_PLATE_DISTRICTS}, and everything here is built to lean
 * on that list rather than on the pattern around it.
 */
import type { Detector, LabelProximity, Span } from '../types.js';
import { isDigit, isWordChar, memberAt } from './util.js';

export const VEHICLE_PLATE_KIND = 'VEHICLE_PLATE';

/**
 * Priority for a plate.
 *
 * `DEFAULT_PRIORITIES` has no entry for it and this module does not own
 * `types.ts`. 52 puts a plate under the phone number, whose leading `+49` is a
 * harder claim on the same digits, and over a custom rule, which by definition
 * knows less about German vehicle registration than this file does.
 */
export const VEHICLE_PLATE_PRIORITY = 52;

/**
 * The Unterscheidungszeichen seed.
 *
 * THIS IS A SUBSET: about 310 codes. The authoritative list is Anlage 1 zur
 * Fahrzeug-Zulassungsverordnung (FZV), which the Kraftfahrt-Bundesamt
 * publishes and amends as districts merge; it holds roughly 700, including the
 * historical codes (Altkennzeichen) that the Kennzeichenliberalisierung
 * brought back in 2012.
 *
 * A code missing from here is a missed plate, never a wrong one, and the gap is
 * closed by {@link VehiclePlateOptions.districts} without touching this file —
 * which is the only honest way to ship a list this long without inventing the
 * half of it nobody can check.
 *
 * Codes are stored as written on the plate, umlauts included: `TÜ` is Tübingen
 * and `TU` is nothing at all, so folding the umlaut away here would invent
 * three hundred codes that were never issued.
 */
export const GERMAN_PLATE_DISTRICTS: readonly string[] = [
  // One letter — the largest cities, plus V for the Vogtlandkreis.
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'R', 'S', 'V', 'W', 'Z',
  // Two letters.
  'AA', 'AB', 'AC', 'AK', 'AN', 'AS', 'AW', 'AZ',
  'BA', 'BB', 'BC', 'BI', 'BL', 'BM', 'BN', 'BO', 'BS', 'BT', 'BZ',
  'CB', 'CE', 'CO', 'CW',
  'DA', 'DD', 'DE', 'DH', 'DN', 'DO', 'DU',
  'EA', 'ED', 'EE', 'EF', 'EI', 'EL', 'EM', 'EN', 'ER', 'ES', 'EU',
  'FD', 'FF', 'FG', 'FL', 'FN', 'FO', 'FR', 'FS', 'FT', 'FÜ',
  'GE', 'GG', 'GI', 'GL', 'GM', 'GP', 'GR', 'GS', 'GT', 'GZ', 'GÖ',
  'HA', 'HB', 'HD', 'HE', 'HF', 'HG', 'HH', 'HI', 'HL', 'HM', 'HN', 'HO',
  'HP', 'HR', 'HS', 'HU', 'HX',
  'IN', 'IZ',
  'KA', 'KB', 'KC', 'KE', 'KF', 'KG', 'KH', 'KI', 'KL', 'KN', 'KO', 'KR',
  'KS', 'KT', 'KU',
  'LA', 'LB', 'LD', 'LG', 'LL', 'LM', 'LU', 'LÖ',
  'MA', 'MB', 'MD', 'ME', 'MG', 'MH', 'MI', 'MK', 'MN', 'MR', 'MS', 'MZ', 'MÜ',
  'NB', 'NE', 'NF', 'NI', 'NK', 'NM', 'NR', 'NU', 'NW',
  'OA', 'OD', 'OE', 'OF', 'OG', 'OH', 'OL', 'OS',
  'PA', 'PB', 'PE', 'PF', 'PI', 'PM', 'PS',
  'RA', 'RD', 'RE', 'RH', 'RO', 'RS', 'RT', 'RV', 'RW', 'RZ',
  'SB', 'SC', 'SE', 'SG', 'SI', 'SL', 'SN', 'SO', 'SP', 'SR', 'ST', 'SU',
  'SW', 'SZ',
  'TF', 'TR', 'TS', 'TÜ',
  'UL', 'UM', 'UN',
  'VB', 'VS',
  'WE', 'WF', 'WI', 'WL', 'WM', 'WN', 'WO', 'WT', 'WW', 'WÜ',
  'ZW',
  // Three letters.
  'AIC', 'ANA', 'AUR',
  'BAD', 'BAR', 'BGL', 'BIR', 'BIT', 'BLK', 'BOR', 'BOT', 'BRA', 'BRB',
  'CHA', 'CLP', 'COC', 'COE', 'CUX',
  'DAH', 'DAU', 'DEG', 'DEL', 'DLG', 'DON',
  'EBE', 'EMD', 'ERB', 'ERH', 'ERZ', 'ESW',
  'FDS', 'FFB', 'FRI',
  'GAP', 'GER', 'GTH',
  'HAL', 'HAM', 'HAS', 'HDH', 'HEF', 'HEI', 'HGW', 'HOL', 'HOM', 'HRO',
  'HSK', 'HST', 'HVL', 'HWI',
  'IGB',
  'KEH', 'KIB', 'KLE', 'KUS',
  'LAU', 'LDS', 'LER', 'LEV', 'LIF', 'LIP',
  'MIL', 'MOL', 'MSP', 'MTK', 'MYK', 'MZG',
  'NDH', 'NEA', 'NES', 'NEW', 'NMS', 'NOM',
  'OHV', 'OHZ', 'OPR', 'OSL',
  'PAF', 'PIR',
  'RÜD',
  'SAD', 'SHA', 'SHG', 'SHL', 'SIG', 'SIM', 'SLS', 'SPN', 'STA', 'STD', 'SÜW',
  'TBB', 'TIR', 'TUT',
  'VEC', 'VER', 'VIE',
  'WAF', 'WEN', 'WES', 'WHV', 'WIL', 'WND', 'WOB', 'WST', 'WUG', 'WUN',
];

/**
 * The whole plate, Unterscheidungszeichen included, is at most eight
 * characters (§ 8 FZV). It is the cheapest structural check there is and it
 * costs nothing real: `GAP-XY 1234` is nine, so no such plate exists.
 *
 * The E of an Elektrofahrzeug and the H of a historic vehicle sit outside that
 * count, which is why {@link readPlate} adds them after the check.
 */
const MAX_PLATE_CHARS = 8;

const MAX_DISTRICT_LETTERS = 3;
const MAX_SERIES_LETTERS = 2;
const MAX_PLATE_DIGITS = 4;

/**
 * Umlauts are plate letters: `TÜ`, `GÖ` and `MÜ` are districts, and `SÜW` and
 * `RÜD` are as well. `ß` is not — no plate carries one.
 */
const UMLAUTS = 'ÄÖÜäöü';

const isPlateLetter = (ch: string): boolean =>
  (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || UMLAUTS.includes(ch);

/**
 * The separators a plate is *written* with, which is deliberately narrower than
 * `isScanSeparator`.
 *
 * The dot is the one that matters: `ab ca. 50` is `AB` + `CA` + `50` by shape,
 * and folding the dot away would turn a delivery note into a vehicle. A plate
 * is written with a hyphen or a space and nothing else, so nothing is lost by
 * saying so here.
 */
const PLATE_HYPHENS = new Set([
  '-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212',
  '\uFE58', '\uFE63', '\uFF0D',
]);

const PLATE_SPACES = new Set([
  ' ', '\u00A0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004',
  '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F',
  '\u205F', '\u3000',
]);

/** How to build the detectors. */
export interface VehiclePlateOptions {
  /**
   * Further Unterscheidungszeichen, merged over {@link GERMAN_PLATE_DISTRICTS}
   * rather than replacing it. This is the extension point for the full FZV
   * register; codes are compared upper-cased.
   */
  readonly districts?: Iterable<string>;
}

interface Run {
  /** The characters as written. */
  readonly text: string;
  /** Index just past the run. */
  readonly end: number;
}

interface SeparatorRun {
  readonly end: number;
  readonly hyphen: boolean;
}

interface PlateReading {
  readonly end: number;
  /**
   * True when the Erkennungsnummer's letters were written as their own group,
   * so the split into district and series is the writer's and not ours.
   */
  readonly separated: boolean;
  readonly hyphenated: boolean;
  readonly upperCase: boolean;
}

function readLetters(text: string, start: number): Run {
  let i = start;
  while (memberAt(text, i, isPlateLetter)) i += 1;
  return { text: text.slice(start, i), end: i };
}

/**
 * A separator run between two plate groups.
 *
 * Up to three characters so that `KA - XY` reads, but a run longer than one
 * has to hold a hyphen: three spaces between two words are two words, and the
 * hyphen is what says a human meant one token.
 */
function readSeparators(text: string, start: number): SeparatorRun | null {
  let i = start;
  let hyphen = false;

  while (i < text.length) {
    const ch = text[i]!;
    if (PLATE_HYPHENS.has(ch)) hyphen = true;
    else if (!PLATE_SPACES.has(ch)) break;
    i += 1;
  }

  const length = i - start;
  if (length > 3) return null;
  if (length > 1 && !hyphen) return null;
  return { end: i, hyphen };
}

/** The digit group: one to four digits, never opening with a zero. */
function readDigits(text: string, start: number): Run | null {
  let i = start;
  while (memberAt(text, i, isDigit)) i += 1;
  const length = i - start;
  if (length === 0 || length > MAX_PLATE_DIGITS) return null;
  if (text[start] === '0') return null;
  return { text: text.slice(start, i), end: i };
}

const isUpper = (value: string): boolean => value === value.toUpperCase();

/**
 * Read a plate starting at `start`, or reject the position.
 *
 * Each letter group is read *maximally*, which is the rule that keeps
 * `Rechnungs-Nr 1234` out: the first group is nine letters, and no district
 * has nine letters. Reading a three-letter prefix out of a longer word would
 * find a district in half the German nouns there are.
 */
function readPlate(text: string, start: number, districts: ReadonlySet<string>): PlateReading | null {
  const first = readLetters(text, start);
  if (first.text.length === 0) return null;

  const sep1 = readSeparators(text, first.end);
  if (sep1 === null) return null;

  let second: Run | null = null;
  let hyphenated = sep1.hyphen;
  let cursor = sep1.end;

  if (memberAt(text, cursor, isPlateLetter)) {
    second = readLetters(text, cursor);
    const sep2 = readSeparators(text, second.end);
    if (sep2 === null) return null;
    hyphenated ||= sep2.hyphen;
    cursor = sep2.end;
  }

  const digits = readDigits(text, cursor);
  if (digits === null) return null;

  let end = digits.end;
  // The E of an Elektrofahrzeug and the H of a historic vehicle, written
  // against the digits. Nothing else may follow.
  const suffix = text[end];
  if (suffix === 'E' || suffix === 'H' || suffix === 'e' || suffix === 'h') end += 1;
  if (isWordChar(text, end)) return null;

  const letters = first.text + (second?.text ?? '');
  if (letters.length + digits.text.length > MAX_PLATE_CHARS) return null;

  const accepted =
    second === null
      ? splits(first.text, districts)
      : first.text.length <= MAX_DISTRICT_LETTERS &&
        second.text.length <= MAX_SERIES_LETTERS &&
        districts.has(first.text.toUpperCase());

  if (!accepted) return null;

  return { end, separated: second !== null, hyphenated, upperCase: isUpper(letters) };
}

/**
 * Is there any way to cut a run-together letter group into district and series?
 *
 * `KAXY` is `KA` + `XY`, and it is also `KAX` + `Y` if `KAX` were a district.
 * Which reading is right does not matter: every reading claims exactly the same
 * characters, so the span is the same either way.
 */
function splits(letters: string, districts: ReadonlySet<string>): boolean {
  const upper = letters.toUpperCase();
  for (let cut = Math.min(MAX_DISTRICT_LETTERS, upper.length - 1); cut >= 1; cut--) {
    const series = upper.length - cut;
    if (series >= 1 && series <= MAX_SERIES_LETTERS && districts.has(upper.slice(0, cut))) {
      return true;
    }
  }
  return false;
}

/**
 * The labels that license a run-together plate.
 *
 * Deliberately only the two words that mean a plate and nothing else. `Kfz`
 * and `Fahrzeug` were tried and dropped: a mail about `Kfz-Versicherung` that
 * also says `Rechnung Nr 1234` puts a label within reach of something that is
 * not a plate, and `Kennzeichen` never appears next to an invoice number.
 *
 * Declared once at module level so the fold cache keyed on this array's
 * identity survives between requests.
 */
export const VEHICLE_PLATE_LABELS: readonly string[] = ['Kennzeichen', 'Nummernschild'];

const PLATE_PROXIMITY: LabelProximity = { labels: VEHICLE_PLATE_LABELS, window: 32 };

/** The pair this module registers. */
export interface VehiclePlateDetectors {
  /** Plates written the way a plate is written. Reported unaccompanied. */
  readonly plate: Detector;
  /** The run-together and lower-case-spaced spellings, licensed by a label. */
  readonly labelled: Detector;
}

/**
 * Build both plate detectors over one candidate generator.
 *
 * They are disjoint by construction, which they have to be: `requiresLabel` is
 * all-or-nothing per detector, and exactly one of the two spellings can be
 * reported on its own.
 *
 * What separates them is how much of the reading the writer did. A plate whose
 * groups are separated, and which either carries a hyphen or is written in the
 * plate's own capitals, is the writer telling us where the district ends —
 * `KA-XY 1234`, `KA XY 1234`, `ka-xy 1234`. Everything else is us guessing:
 * `KAXY1234` has to be cut somewhere, and `ab ca 50` is a district, a series
 * and a quantity in a delivery note. Those want a label, and the trade is
 * plainly worse recall on a database field that stores plates run together —
 * paid to keep German prose out.
 */
export function createVehiclePlateDetectors(
  options: VehiclePlateOptions = {},
): VehiclePlateDetectors {
  const districts = new Set(
    [...GERMAN_PLATE_DISTRICTS, ...(options.districts ?? [])].map((code) => code.toUpperCase()),
  );

  const find = (text: string, name: string, wantSelfEvident: boolean): Span[] => {
    const out: Span[] = [];
    let i = 0;

    while (i < text.length) {
      if (!memberAt(text, i, isPlateLetter) || isWordChar(text, i - 1)) {
        i += 1;
        continue;
      }

      const reading = readPlate(text, i, districts);
      if (reading === null) {
        i += 1;
        continue;
      }

      const selfEvident = reading.separated && (reading.hyphenated || reading.upperCase);
      if (selfEvident !== wantSelfEvident) {
        i += 1;
        continue;
      }

      out.push({
        start: i,
        end: reading.end,
        kind: VEHICLE_PLATE_KIND,
        value: text.slice(i, reading.end),
        detector: name,
        priority: VEHICLE_PLATE_PRIORITY,
      });
      i = reading.end;
    }

    return out;
  };

  return {
    plate: {
      name: 'vehicle-plate',
      priority: VEHICLE_PLATE_PRIORITY,
      find: (text) => find(text, 'vehicle-plate', true),
    },
    labelled: {
      name: 'vehicle-plate-labelled',
      priority: VEHICLE_PLATE_PRIORITY,
      requiresLabel: PLATE_PROXIMITY,
      find: (text) => find(text, 'vehicle-plate-labelled', false),
    },
  };
}

const DEFAULT_PLATE_DETECTORS = createVehiclePlateDetectors();

/** Plates written with their separators, on the seed register. */
export const vehiclePlateDetector: Detector = DEFAULT_PLATE_DETECTORS.plate;

/** The run-together spelling, which `detect()` drops unless a label is near. */
export const labelledVehiclePlateDetector: Detector = DEFAULT_PLATE_DETECTORS.labelled;
