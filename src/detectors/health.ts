/**
 * Health data: ICD-10 diagnosis codes and the names of prescribed drugs.
 *
 * Article 9 GDPR calls this a special category, and the supervisory practice
 * behind that wording is what shapes the whole module: a diagnosis that leaves
 * the building is the most expensive single finding hushgate can miss. So the
 * recall bar is higher here than anywhere else in the detector set.
 *
 * It is also the module where the opposite failure is cheapest to trigger.
 * `E11.9` is a diabetes diagnosis, a software version, a spreadsheet cell, a
 * part number and a vitamin dosage, and four of those five turn up in the mail
 * of every Mittelstand company this proxy sits in front of. An operator whose
 * invoices come back shredded switches the detector off, and a switched-off
 * detector protects nobody — so a false positive here costs *every* diagnosis,
 * not one.
 *
 * The two pressures are resolved by never letting shape alone decide:
 *
 *  - a diagnosis code fires unaccompanied only when it is *dotted* and in the
 *    catalogue ({@link SEED_ICD10_CODES}, extended by the operator). The dot is
 *    the structure and the catalogue is the vocabulary; either alone is worth
 *    nothing.
 *  - every other grammatically valid code — undotted `E119`, three-character
 *    `I10`, anything outside the catalogue — needs one of
 *    {@link ICD10_LABELS} near it, enforced centrally through `requiresLabel`.
 *  - a drug name needs neither, because an INN like `Metformin` is not a word
 *    in any other domain. The list *is* the evidence.
 *
 * WHAT THIS MODULE DELIBERATELY CANNOT DO: free-text diagnoses.
 * `Verdacht auf Depression`, `Diagnose: Diabetes mellitus Typ 2`,
 * `Patient ist seit Jahren zuckerkrank` carry exactly the same Article 9
 * content as `F32.1` and `E11.9`, and no deterministic rule reaches them —
 * they are ordinary German sentences, and the only thing separating them from
 * `Diagnose: der Motor läuft rund` is meaning. That belongs to a semantic
 * layer, not to a scanner. Recording the boundary is the point: this module
 * covers the *coded* and the *named*, and the operator has to know that the
 * narrative part of a doctor's letter is not covered by it.
 */
import type { Detector, LabelProximity, Span } from '../types.js';
import { foldForCompare } from './normalise.js';
import { isDigit, isWordChar } from './util.js';

export const ICD_CODE_KIND = 'ICD_CODE';
export const MEDICATION_KIND = 'MEDICATION';

/**
 * Priorities for the two kinds, pending entries in `DEFAULT_PRIORITIES` — this
 * module does not own `types.ts`.
 *
 * Both sit above `CUSTOM` (45) and `DICTIONARY` (40), which are the rules that
 * can plausibly claim the same characters: a customer dictionary containing a
 * clinic's name, or a custom rule for internal case numbers. Both sit below
 * every detector that proves its claim arithmetically (85 and up), because a
 * value with a valid checksum has the better argument for the same span.
 * The rank only ever settles a tie between two overlapping spans of identical
 * length, which is rare for either of these.
 */
export const ICD_CODE_PRIORITY = 83;
export const MEDICATION_PRIORITY = 82;

/* --------------------------------------------------------------- ICD-10-GM */

/**
 * The labels that license a code the catalogue cannot vouch for.
 *
 * Declared once at module level so the fold `labelNear` performs is cached
 * against this array's identity rather than repeated per candidate.
 *
 * `ICD-10` is redundant after the fold — `foldForCompare` reduces it to
 * `icd10`, which already contains `icd` — and is kept anyway, because this
 * list is read by operators deciding whether their own header spelling is
 * covered, and an entry that answers that question is worth its cost.
 */
export const ICD10_LABELS: readonly string[] = ['ICD', 'ICD-10', 'Diagnose', 'Diagnosis'];

const ICD10_PROXIMITY: LabelProximity = { labels: ICD10_LABELS };

/**
 * Codes that are reported without any label at all.
 *
 * THIS IS A SUBSET, and a small one: ICD-10-GM holds roughly 13000 codes and
 * this is under a hundred of them. It is not the catalogue and it is not
 * trying to be — reproducing 13000 codes from memory would put invented codes
 * in a product that redacts on their say-so. What it is: the diagnoses that
 * actually turn up in the mail of a German company — the chronic conditions on
 * a Betriebsarzt's report, the codes on an Arbeitsunfähigkeitsbescheinigung,
 * the ones a Krankenkasse writes in a letter.
 *
 * A code missing from here is not missed; it is *label-gated*, and reappears
 * the moment the text says `Diagnose` or `ICD` near it. Deployments that hold
 * the real catalogue hand it in through {@link Icd10Options.catalogue} and the
 * distinction disappears entirely.
 *
 * Only dotted codes belong here. A three-character code (`I10`, `N40`) is a
 * complete diagnosis, but as a string it is three characters of the sort every
 * form, hall and article number in Germany is also made of, so the catalogue
 * never licenses it — the label does.
 */
export const SEED_ICD10_CODES: readonly string[] = [
  // Endokrin und Stoffwechsel
  'E03.9', 'E04.9', 'E10.9', 'E11.9', 'E11.90', 'E11.91', 'E78.0', 'E78.5', 'E79.0',
  // Psychisch
  'F10.2', 'F17.2', 'F32.0', 'F32.1', 'F32.2', 'F32.9', 'F33.1', 'F41.0', 'F41.1',
  'F41.9', 'F43.0', 'F43.1', 'F43.2', 'F45.9',
  // Nervensystem
  'G43.0', 'G43.9', 'G47.0', 'G47.31', 'G56.0',
  // Auge
  'H25.9', 'H40.9',
  // Kreislauf
  'I10.90', 'I10.91', 'I11.90', 'I20.9', 'I21.9', 'I25.9', 'I48.0', 'I48.1', 'I50.9',
  'I63.9', 'I83.9',
  // Atemwege
  'J06.9', 'J18.9', 'J20.9', 'J45.9',
  // Verdauung
  'K21.0', 'K21.9', 'K29.7', 'K52.9',
  // Haut
  'L20.9', 'L30.9', 'L40.0',
  // Muskel und Skelett
  'M16.9', 'M17.9', 'M25.5', 'M51.1', 'M53.1', 'M54.2', 'M54.4', 'M54.5', 'M79.1',
  // Harn und Niere
  'N18.3', 'N39.0',
  // Symptome, Verletzungen, Sonderkodes
  'R10.4', 'S52.5', 'T78.4', 'U07.1',
  // Faktoren, die den Gesundheitszustand beeinflussen
  'Z00.0', 'Z76.0',
  // Neubildungen und Blut
  'C18.9', 'C34.9', 'C50.9', 'D50.9',
];

/**
 * The word in front of a code that says it is not one.
 *
 * This is the list that keeps the detector switched on. Each entry costs a
 * diagnosis only in the sentence `Version E11.9`, which no doctor writes, and
 * saves an invoice line in the sentence every supplier writes. The asymmetry
 * is the whole argument — but it is also why the list is a *seed*: the
 * vocabulary of a machine builder is not the vocabulary of a logistics firm,
 * and {@link Icd10Options.blockedPrefixWords} is how the second one adds
 * `Waggon` without touching this file.
 *
 * Matching is exact word equality after folding, never a substring: blocking
 * `art` must not block `Diagnoseart`.
 */
export const ICD10_BLOCKED_PREFIX_WORDS: readonly string[] = [
  // Software and documents
  'Version', 'Ver', 'Rev', 'Revision', 'Build', 'Firmware', 'Software', 'Release',
  'Patch', 'Hotfix', 'Formular', 'Blatt', 'Seite', 'Tabelle', 'Abb', 'Bild',
  'Kapitel', 'Abschnitt', 'Ziffer', 'Punkt', 'Anlage', 'Zeile', 'Spalte', 'Zelle',
  'Cell', 'Feld',
  // Standards
  'Norm', 'DIN', 'ISO', 'EN', 'IEC', 'VDE', 'RAL',
  // Parts, orders and places
  'Artikel', 'Art', 'ArtNr', 'Nr', 'Nummer', 'Pos', 'Position', 'Charge', 'Los',
  'Serie', 'Baureihe', 'Baugruppe', 'Bauteil', 'Bauform', 'Typ', 'Modell', 'Muster',
  'Werkzeug', 'Klasse', 'Stufe', 'Zone', 'Gewinde', 'Schraube', 'Motor', 'Pumpe',
  'Ventil', 'Sensor', 'Antrieb', 'Palette', 'Karton', 'Regal', 'Fach', 'Halle',
  'Raum', 'Zimmer', 'Reihe', 'Sitz', 'Gate', 'Flug',
  // Commerce
  'Angebot', 'Auftrag', 'Bestellung', 'Rechnung', 'Beleg', 'Vertrag', 'Projekt',
  'Kostenstelle', 'Konto',
  // The one that reads as a chapter letter all by itself
  'Vitamin',
];

/**
 * Units that turn a code back into a measurement.
 *
 * An ICD code never carries a unit, so `E 11.9 mg` is a vitamin dose and
 * `E11.9 EUR` is a price, whatever the catalogue says. This is the second,
 * independent guard on the spaced spelling — the one that still works when the
 * word in front is not in {@link ICD10_BLOCKED_PREFIX_WORDS}.
 *
 * The cost is stated rather than hidden: a code followed by a lower-case `g`
 * is refused, so a certainty letter written `E11.9 g` is lost. Uppercase is
 * the documented spelling of the Diagnosesicherheit, grams are written
 * lower-case, and there is nothing else in those two characters to go on.
 */
const ICD10_UNITS: ReadonlySet<string> = new Set([
  'mg', 'g', 'kg', 'ug', 'mcg', 'ml', 'l', 'cl', 'dl', 'ie', 'iu', 'mmol', 'mol',
  'eur', 'euro', 'usd', 'chf', 'cent', 'stk', 'stuck', 'stueck', 'prozent',
  'mm', 'cm', 'dm', 'm', 'km', 'kw', 'kwh', 'v', 'w', 'hz', 'bar', 'nm', 'ppm',
  'min', 'sek', 'std', 'kb', 'mb', 'gb', 'tb',
]);

/** Diagnosesicherheit: gesichert, Verdacht auf, Zustand nach, ausgeschlossen. */
const CERTAINTY_LETTERS: ReadonlySet<string> = new Set(['G', 'V', 'Z', 'A']);

/** Longest word still worth reducing to a comparison key. */
const MAX_KEYED_WORD = 32;

const isAsciiLetter = (ch: string): boolean =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');

/** `text[i]`, or the empty string outside the text — never `undefined`. */
const at = (text: string, index: number): string => text[index] ?? '';

const isInlineSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\u00A0' || ch === '\u202F' || ch === '\u2007';

/**
 * Case-, separator- and diacritic-insensitive key, with an ASCII fast path.
 *
 * `foldForCompare` runs four Unicode passes, and this is called once per word
 * in front of a candidate; German prose is overwhelmingly ASCII, where
 * lower-casing gives the identical answer.
 */
function wordKey(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (!isAsciiLetter(value[i]!)) return foldForCompare(value);
  }
  return value.toLowerCase();
}

/** One parsed candidate: where it sits, and what it says once canonicalised. */
interface IcdMatch {
  readonly start: number;
  readonly end: number;
  /** `E11.9` — upper case, dot restored, certainty letter dropped. */
  readonly canonical: string;
  /** Whether the dot was actually written. Undotted codes are label-gated. */
  readonly dotted: boolean;
}

/**
 * Read one code starting at `start`, or `null`.
 *
 * The grammar is ICD-10-GM's: a chapter letter, two digits, optionally a dot
 * and one or two more digits, optionally a diagnosis-certainty letter. The
 * spellings tolerated on top of it are the ones that appear in real documents —
 * one space after the chapter letter (`E 11.9`), the dot left out (`E119`),
 * lower case throughout (`e11.9`).
 *
 * The chapter letter is checked against A-Z and rejects *nothing*: every letter
 * of the alphabet opens a real ICD-10 block, `U` included since U07.1. Saying
 * so plainly matters, because it is the reason this function cannot be the
 * whole detector — the grammar is nearly free to satisfy by accident, and the
 * catalogue and the label are what actually carry the decision.
 */
function parseIcd(text: string, start: number): IcdMatch | null {
  const letter = at(text, start);
  if (!isAsciiLetter(letter)) return null;

  let i = start + 1;
  if (isInlineSpace(at(text, i))) i += 1;

  const first = at(text, i);
  const second = at(text, i + 1);
  if (!isDigit(first) || !isDigit(second)) return null;
  i += 2;

  let sub = '';
  let dotted = false;

  if (at(text, i) === '.' && isDigit(at(text, i + 1))) {
    dotted = true;
    i += 1;
    sub = at(text, i);
    i += 1;
    if (isDigit(at(text, i))) {
      sub += at(text, i);
      i += 1;
    }
    // `E11.999` is a version number or a price, never a diagnosis.
    if (isDigit(at(text, i))) return null;
  } else if (isDigit(at(text, i))) {
    sub = at(text, i);
    i += 1;
    if (isDigit(at(text, i))) {
      sub += at(text, i);
      i += 1;
    }
    if (isDigit(at(text, i))) return null;
  }

  // The certainty letter, glued or behind a single space. Only when it stands
  // alone: `F32.1 Gesichert` must yield the code and leave the word.
  let end = i;
  const spaced = isInlineSpace(at(text, i));
  const marker = at(text, spaced ? i + 1 : i);
  if (CERTAINTY_LETTERS.has(marker) && !isWordChar(text, (spaced ? i + 1 : i) + 1)) {
    end = (spaced ? i + 1 : i) + 1;
  }

  // Nothing alphanumeric may continue the run, and a further dotted group makes
  // it a version chain rather than a code: `E11.9.3`.
  const next = at(text, end);
  if (isAsciiLetter(next) || isDigit(next) || /\p{L}/u.test(next)) return null;
  if (next === '.' && (isDigit(at(text, end + 1)) || isAsciiLetter(at(text, end + 1)))) return null;

  const canonical = letter.toUpperCase() + first + second + (sub.length > 0 ? `.${sub}` : '');

  return { start, end, canonical, dotted };
}

/**
 * Canonical spelling of a written code — `E 11.9`, `e11.9` and `E119` all
 * reduce to `E11.9` — or `null` when the whole string is not one code.
 *
 * Exported because the catalogue an operator hands in is written the ordinary
 * way and has to be compared against what the scanner found.
 */
export function canonicalIcd10(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = parseIcd(trimmed, 0);
  if (match === null || match.end !== trimmed.length) return null;
  return match.canonical;
}

/** True when `value` is a well-formed ICD-10 code in any accepted spelling. */
export function isIcd10Shaped(value: string): boolean {
  return canonicalIcd10(value) !== null;
}

/** True when a unit or a currency sits directly behind the code. */
function unitFollows(text: string, end: number): boolean {
  const immediate = at(text, end);
  if (immediate === '%' || immediate === '€' || immediate === '$' || immediate === '°') {
    return true;
  }

  let i = isInlineSpace(immediate) ? end + 1 : end;
  if (at(text, i) === 'µ') i += 1;

  let j = i;
  while (j < text.length && j - i < 6 && isAsciiLetter(at(text, j))) j += 1;
  if (j === i) return false;
  // A seventh letter means an ordinary word, not a unit.
  if (isAsciiLetter(at(text, j))) return false;

  return ICD10_UNITS.has(text.slice(i, j).toLowerCase());
}

/**
 * The word in front of the code, folded, or the empty string.
 *
 * The walk back crosses the punctuation a label is written with — `Art.-Nr. `,
 * `Version: ` — so that the noun itself is what gets compared.
 */
function previousWord(text: string, start: number): string {
  let i = start - 1;
  let skipped = 0;
  while (i >= 0 && skipped < 4) {
    const ch = at(text, i);
    if (isInlineSpace(ch) || ch === ':' || ch === '.' || ch === '-' || ch === '=' || ch === '#') {
      i -= 1;
      skipped += 1;
      continue;
    }
    break;
  }

  const end = i + 1;
  while (i >= 0 && isAsciiLetter(at(text, i)) && end - i <= MAX_KEYED_WORD) i -= 1;
  const word = text.slice(i + 1, end);
  return word.length === 0 ? '' : wordKey(word);
}

/**
 * Whether the characters around a grammatically valid code still allow it to be
 * read as one.
 *
 * `previousEnd` is where the previous grammatically valid code ended, and it
 * exists for exactly one shape: `E10.9-E11.9` is a range of diagnoses, while
 * `2.1-E11.9-rc1` is a build identifier. Both put a hyphen and an alphanumeric
 * in front of the code; only in the first does the thing before the hyphen end
 * a code of its own.
 */
function contextAllows(
  text: string,
  match: IcdMatch,
  previousEnd: number,
  blocked: ReadonlySet<string>,
): boolean {
  const before = at(text, match.start - 1);
  if (before === '.') return false;
  if ((before === '-' || before === '/') && match.start - 1 !== previousEnd) {
    const earlier = at(text, match.start - 2);
    if (isAsciiLetter(earlier) || isDigit(earlier)) return false;
  }

  if (unitFollows(text, match.end)) return false;

  const previous = previousWord(text, match.start);
  return previous.length === 0 || !blocked.has(previous);
}

/** How to build the ICD-10 detectors. */
export interface Icd10Options {
  /** Further codes that fire without a label, merged over the seed. */
  readonly codes?: Iterable<string>;
  /**
   * Replaces the seeded catalogue entirely — the extension point for the real
   * ICD-10-GM table. Receives the canonical spelling (`E11.9`).
   */
  readonly catalogue?: (code: string) => boolean;
  /** Replaces {@link ICD10_LABELS} for the label-gated detector. */
  readonly labels?: readonly string[];
  /** Further words that, written in front of a code, say it is not one. */
  readonly blockedPrefixWords?: Iterable<string>;
}

interface CompiledIcd {
  readonly inCatalogue: (code: string) => boolean;
  readonly blocked: ReadonlySet<string>;
  readonly proximity: LabelProximity;
}

function compileIcd(options: Icd10Options): CompiledIcd {
  const codes = new Set<string>();
  for (const code of [...SEED_ICD10_CODES, ...(options.codes ?? [])]) {
    const canonical = canonicalIcd10(code);
    if (canonical !== null) codes.add(canonical);
  }

  return {
    inCatalogue: options.catalogue ?? ((code: string): boolean => codes.has(code)),
    blocked: new Set(
      [...ICD10_BLOCKED_PREFIX_WORDS, ...(options.blockedPrefixWords ?? [])].map(wordKey),
    ),
    proximity:
      options.labels === undefined ? ICD10_PROXIMITY : { labels: options.labels },
  };
}

/**
 * Every grammatically valid, context-plausible code in `text`, in order.
 *
 * Both detectors walk the text once each rather than sharing a pass, because a
 * `Detector` is a `find(text)` and nothing else — the duplicated walk is two
 * linear scans over a body that has already been scanned a dozen times, and
 * the alternative is a cache keyed by string identity that would have to be
 * invalidated by nothing and would hold megabytes.
 */
function* icdCandidates(text: string, cfg: CompiledIcd): Generator<IcdMatch> {
  let previousEnd = -1;
  let i = 0;

  while (i < text.length) {
    if (!isAsciiLetter(at(text, i)) || isWordChar(text, i - 1)) {
      i += 1;
      continue;
    }

    const match = parseIcd(text, i);
    if (match === null) {
      i += 1;
      continue;
    }

    const allowed = contextAllows(text, match, previousEnd, cfg.blocked);
    previousEnd = match.end;
    if (allowed) yield match;
    i = match.end;
  }
}

function icdSpan(text: string, match: IcdMatch, detector: string): Span {
  return {
    start: match.start,
    end: match.end,
    kind: ICD_CODE_KIND,
    value: text.slice(match.start, match.end),
    detector,
    priority: ICD_CODE_PRIORITY,
  };
}

/**
 * Build the pair of ICD-10 detectors: the catalogue-backed one and the
 * label-gated one.
 *
 * Two detectors rather than one, for the reason `requiresLabel` exists: it is
 * enforced centrally and per detector, so it cannot say "unless the catalogue
 * knows this code". The split is disjoint by construction — the second skips
 * exactly what the first accepts — so a labelled catalogue code is still
 * reported once.
 */
export function createIcd10Detectors(options: Icd10Options = {}): readonly [Detector, Detector] {
  const cfg = compileIcd(options);

  const catalogue: Detector = {
    name: 'icd10',
    priority: ICD_CODE_PRIORITY,

    find(text: string): Span[] {
      const out: Span[] = [];
      for (const match of icdCandidates(text, cfg)) {
        if (!match.dotted || !cfg.inCatalogue(match.canonical)) continue;
        out.push(icdSpan(text, match, 'icd10'));
      }
      return out;
    },
  };

  const labelled: Detector = {
    name: 'icd10-labelled',
    priority: ICD_CODE_PRIORITY,
    requiresLabel: cfg.proximity,

    find(text: string): Span[] {
      const out: Span[] = [];
      for (const match of icdCandidates(text, cfg)) {
        if (match.dotted && cfg.inCatalogue(match.canonical)) continue;
        out.push(icdSpan(text, match, 'icd10-labelled'));
      }
      return out;
    },
  };

  return [catalogue, labelled];
}

const [defaultIcd10Detector, defaultLabelledIcd10Detector] = createIcd10Detectors();

/** Dotted codes from the catalogue. Fires with no label at all. */
export const icd10Detector: Detector = defaultIcd10Detector;

/** Every other well-formed code, reported only near an ICD or Diagnose label. */
export const labelledIcd10Detector: Detector = defaultLabelledIcd10Detector;

/* ------------------------------------------------------------- Medikamente */

/**
 * Active ingredients, written the way a German prescription writes them.
 *
 * THIS IS A SUBSET — the Rote Liste holds thousands of preparations and the
 * ABDA article file more still. This is the long tail's head: the ingredients
 * behind the prescriptions a German company's mail actually mentions, in the
 * INN spelling used on a Medikationsplan. {@link MedicationOptions.names} takes
 * the rest, and is also where brand names belong (`Glucophage`, `Marcumar`,
 * `Novalgin`) — the brand register is national, changes with every licensing
 * decision, and is exactly the sort of list that goes stale inside a release.
 *
 * A name earns its place by being a word that means nothing else. `Lithium` is
 * therefore *not* here, deliberately: it is a mood stabiliser and it is also
 * what half the Mittelstand puts in its battery packs, and `Lithium-Ionen-Akku`
 * appearing as a health finding is precisely the false positive that gets the
 * whole detector switched off. Same reasoning keeps out `ASS`.
 */
export const SEED_MEDICATION_NAMES: readonly string[] = [
  // Diabetes
  'Metformin', 'Sitagliptin', 'Empagliflozin', 'Dapagliflozin', 'Glimepirid',
  'Insulin', 'Liraglutid', 'Semaglutid',
  // Herz, Kreislauf, Blut
  'Ramipril', 'Enalapril', 'Lisinopril', 'Candesartan', 'Valsartan', 'Losartan',
  'Amlodipin', 'Metoprolol', 'Bisoprolol', 'Nebivolol', 'Carvedilol', 'Atenolol',
  'Propranolol', 'Verapamil', 'Diltiazem', 'Torasemid', 'Furosemid',
  'Hydrochlorothiazid', 'Spironolacton', 'Digitoxin', 'Digoxin', 'Amiodaron',
  'Ivabradin', 'Phenprocoumon', 'Apixaban', 'Rivaroxaban', 'Edoxaban', 'Dabigatran',
  'Clopidogrel', 'Ticagrelor', 'Prasugrel', 'Warfarin',
  // Fettstoffwechsel
  'Simvastatin', 'Atorvastatin', 'Rosuvastatin', 'Pravastatin', 'Ezetimib',
  'Fenofibrat',
  // Magen, Darm
  'Pantoprazol', 'Omeprazol', 'Esomeprazol', 'Metoclopramid', 'Domperidon',
  'Mesalazin', 'Macrogol',
  // Schmerz und Entzündung
  'Ibuprofen', 'Diclofenac', 'Paracetamol', 'Metamizol', 'Novaminsulfon',
  'Naproxen', 'Etoricoxib', 'Celecoxib', 'Tilidin', 'Tramadol', 'Oxycodon',
  'Morphin', 'Fentanyl', 'Tapentadol', 'Buprenorphin',
  // Psyche und Nervensystem
  'Sertralin', 'Citalopram', 'Escitalopram', 'Fluoxetin', 'Paroxetin', 'Venlafaxin',
  'Duloxetin', 'Mirtazapin', 'Amitriptylin', 'Doxepin', 'Opipramol', 'Bupropion',
  'Quetiapin', 'Risperidon', 'Olanzapin', 'Aripiprazol', 'Haloperidol', 'Melperon',
  'Pipamperon', 'Lorazepam', 'Diazepam', 'Oxazepam', 'Zopiclon', 'Zolpidem',
  'Pregabalin', 'Gabapentin', 'Levetiracetam', 'Lamotrigin', 'Valproat',
  'Carbamazepin', 'Methylphenidat', 'Levodopa', 'Donepezil', 'Memantin',
  'Sumatriptan',
  // Atemwege und Allergie
  'Salbutamol', 'Formoterol', 'Budesonid', 'Tiotropium', 'Montelukast', 'Cetirizin',
  'Loratadin', 'Desloratadin', 'Fexofenadin',
  // Hormone, Immunsystem, Onkologie
  'Levothyroxin', 'Carbimazol', 'Thiamazol', 'Prednisolon', 'Kortison', 'Cortison',
  'Methotrexat', 'Azathioprin', 'Ciclosporin', 'Adalimumab', 'Etanercept',
  'Rituximab', 'Tamoxifen', 'Anastrozol', 'Bicalutamid',
  // Anti-Infektiva
  'Amoxicillin', 'Ciprofloxacin', 'Levofloxacin', 'Moxifloxacin', 'Azithromycin',
  'Clarithromycin', 'Doxycyclin', 'Cefuroxim', 'Clindamycin', 'Nitrofurantoin',
  'Fosfomycin', 'Cotrimoxazol', 'Aciclovir',
  // Urologie, Knochen, Gicht
  'Tamsulosin', 'Finasterid', 'Sildenafil', 'Tadalafil', 'Allopurinol', 'Febuxostat',
  'Alendronsäure', 'Ibandronsäure', 'Colecalciferol',
];

/**
 * How much German a compound may add to an ingredient name and still be one.
 *
 * `Metforminhydrochlorid`, `ibuprofenhaltige`, `Insulinresistenz` are all the
 * drug and all disclose it, so the whole word is claimed rather than the
 * prefix — a span that stopped at `Metformin` would leave `hydrochlorid`
 * standing, which names the drug just as well.
 *
 * The rule is safe in the direction that matters: an ordinary German word that
 * *begins* with an INN essentially cannot exist, because an INN is coined to be
 * a word no language already has.
 */
const MAX_COMPOUND_TAIL = 20;

/** Below this length a name stops being a word nothing else could be. */
const MIN_NAME_LENGTH = 5;

const LETTER = /\p{L}/u;

/** ASCII decided arithmetically; only the rest reaches the regex. */
function isLetter(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  if (code < 128) return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return LETTER.test(ch);
}

/**
 * Dosages, intake schemes and the words a prescription line is made of.
 *
 * Bounded on both sides by a window of the text, so the pattern only ever runs
 * over a few dozen characters and its alternation cannot be made to backtrack
 * over a body.
 */
const DOSAGE = new RegExp(
  [
    // 850 mg, 0,5 ml, 10 000 IE
    String.raw`\d(?:[\d.,\s]{0,6}\d)?\s?(?:mg|g|µg|mcg|ml|l|IE|I\.E\.|mmol|%)(?![\p{L}])`,
    // 1-0-1, 1-0-0-1
    String.raw`\d\s?[-–/]\s?\d\s?[-–/]\s?\d(?:\s?[-–/]\s?\d)?`,
    // N1, N2, N3
    String.raw`\bN[123]\b`,
    // the vocabulary around the number
    String.raw`(?:tablett|tabl|tbl|kapsel|kaps|dragee|tropfen|retard|ampulle|z[äa]pfchen`
      + String.raw`|supp|salbe|creme|pflaster|inhalator|spray|dosis|dosier|einnahme`
      + String.raw`|rezept|verordn|medikation|einmal|zweimal|dreimal|t[äa]glich|morgens`
      + String.raw`|mittags|abends|zur nacht|nüchtern|p\.o\.|i\.v\.|s\.c\.)`,
  ].join('|'),
  'iu',
);

/** How to build the medication detector. */
export interface MedicationOptions {
  /** Further ingredient or brand names, merged over {@link SEED_MEDICATION_NAMES}. */
  readonly names?: Iterable<string>;
  /**
   * Report a name only when a dosage, an intake scheme or a prescription word
   * sits near it. Off by default.
   *
   * THE ARGUMENT FOR OFF: `Rx: Metformin` and `Patient nimmt seit Jahren
   * Ramipril` carry the diagnosis just as plainly as the dosed line does, and
   * those are the sentences a doctor's letter is written in. Requiring a dosage
   * would drop exactly the free-prose mentions that Article 9 is about, and buy
   * precision that the name list already provides — `Sertralin` is not a word
   * that means anything else, unlike five digits.
   *
   * THE ARGUMENT FOR ON, and the reason it is an option rather than a decision:
   * for a pharmaceutical wholesaler, a contract manufacturer or a packaging
   * supplier, ingredient names are ordinary business vocabulary that appears in
   * every second sentence with no patient anywhere near it. For them the dosage
   * is what separates a prescription from a product catalogue, and without this
   * switch they would have to turn the detector off completely.
   */
  readonly requireDosage?: boolean;
  /** Characters searched each side for a dosage. Defaults to 24. */
  readonly dosageWindow?: number;
}

interface CompiledMedication {
  readonly names: ReadonlySet<string>;
  readonly minLength: number;
  readonly maxLength: number;
  readonly requireDosage: boolean;
  readonly window: number;
}

function compileMedication(options: MedicationOptions): CompiledMedication {
  const names = new Set<string>();
  let maxLength = 0;

  for (const name of [...SEED_MEDICATION_NAMES, ...(options.names ?? [])]) {
    const key = foldForCompare(name);
    if (key.length < MIN_NAME_LENGTH) continue;
    names.add(key);
    maxLength = Math.max(maxLength, key.length);
  }

  return {
    names,
    minLength: MIN_NAME_LENGTH,
    maxLength,
    requireDosage: options.requireDosage ?? false,
    window: options.dosageWindow ?? 24,
  };
}

/** True when a dosage or a prescription word sits within the window. */
function dosageNear(text: string, start: number, end: number, window: number): boolean {
  const before = text.slice(Math.max(0, start - window), start);
  const after = text.slice(end, Math.min(text.length, end + window));
  return DOSAGE.test(before) || DOSAGE.test(after);
}

/**
 * Which ingredient a word of `[start, end)` spells, or `null`.
 *
 * Whole word first, then the longest prefix that is a name — the prefix path is
 * what catches the salt (`Metforminhydrochlorid`) and the German compound
 * (`ibuprofenhaltige`), and the length cap is what keeps it from wandering.
 */
function namedIngredient(word: string, cfg: CompiledMedication): boolean {
  const key = wordKey(word);
  if (key.length < cfg.minLength) return false;
  if (cfg.names.has(key)) return true;
  if (key.length > cfg.maxLength + MAX_COMPOUND_TAIL) return false;

  for (let length = Math.min(cfg.maxLength, key.length - 1); length >= cfg.minLength; length--) {
    if (cfg.names.has(key.slice(0, length))) return true;
  }

  return false;
}

/**
 * Build the medication detector.
 *
 * The span is the name alone, never the dose behind it. `Metformin` is what
 * discloses the diabetes; `850 mg 1-0-1` discloses nothing once the name is
 * gone, and leaving it in place keeps the placeholder's slice exact and the
 * remaining text readable enough that the model still answers the question.
 */
export function createMedicationDetector(options: MedicationOptions = {}): Detector {
  const cfg = compileMedication(options);

  return {
    name: 'medication',
    priority: MEDICATION_PRIORITY,

    find(text: string): Span[] {
      const out: Span[] = [];
      let i = 0;

      while (i < text.length) {
        if (!isLetter(at(text, i))) {
          i += 1;
          continue;
        }

        const start = i;
        while (i < text.length && isLetter(at(text, i))) i += 1;

        const word = text.slice(start, i);
        if (!namedIngredient(word, cfg)) continue;
        if (cfg.requireDosage && !dosageNear(text, start, i, cfg.window)) continue;

        out.push({
          start,
          end: i,
          kind: MEDICATION_KIND,
          value: word,
          detector: 'medication',
          priority: MEDICATION_PRIORITY,
        });
      }

      return out;
    },
  };
}

/** Ingredient names from the seed, reported whether or not a dosage follows. */
export const medicationDetector: Detector = createMedicationDetector();
