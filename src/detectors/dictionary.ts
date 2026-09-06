import { ConfigError } from '../errors.js';
import { DEFAULT_PRIORITIES, type Detector, type Kind, type Span } from '../types.js';
import { escapeRegExp, isWordChar } from './util.js';

/** One entry of the user-supplied dictionary. */
export interface DictionaryEntry {
  /** The literal to match, case-insensitively. */
  readonly value: string;
  /** Kind to report. Defaults to `NAME`. */
  readonly kind?: Kind;
}

/** Shorthand form accepted by the config file. */
export interface DictionaryInput {
  readonly names?: readonly string[];
  readonly terms?: readonly string[];
  readonly entries?: readonly DictionaryEntry[];
}

/** How to build the dictionary detector. */
export interface DictionaryOptions {
  /** Tie-break weight. Defaults to {@link DEFAULT_PRIORITIES.DICTIONARY}. */
  readonly priority?: number;
  /**
   * Run the near-miss pass as well. Default false — see the cost and noise
   * arguments on {@link createDictionaryDetector}. Turning it on buys the
   * name-order variants, the umlaut/digraph equivalence and, unless
   * {@link maxEditDistance} says otherwise, single-typo matching.
   */
  readonly fuzzy?: boolean;
  /**
   * How far a near miss may be from an entry. Default 1 when `fuzzy` is on.
   *
   * `0` is the quiet subset: the deterministic rewrites of an entry — surname
   * first, given name as an initial, `ue` for `ü` — and nothing that guesses.
   * An operator who wants `Mustermann, Max` covered but will not accept a
   * single wrong letter deciding what gets redacted sets this.
   */
  readonly maxEditDistance?: 0 | 1;
}

/** Flatten the config shorthand into a single entry list. */
export function toDictionaryEntries(input: DictionaryInput | undefined): DictionaryEntry[] {
  if (input === undefined) return [];
  return [
    ...(input.names ?? []).map((value) => ({ value, kind: 'NAME' as Kind })),
    ...(input.terms ?? []).map((value) => ({ value, kind: 'TERM' as Kind })),
    ...(input.entries ?? []),
  ];
}

/**
 * Shortest entry that may be reached by an edit-distance match.
 *
 * Six is not a tuning constant, it is a noise floor. At five characters the
 * distance-1 neighbourhood of a German word contains dozens of other German
 * words — `Meier`/`Meyer`/`Maier`/`Meile`/`weiter` — and a dictionary that
 * fires on all of them is a dictionary the operator switches off. Below this
 * length an entry is matched literally and only literally.
 */
export const FUZZY_MIN_LENGTH = 6;

/**
 * How many characters may sit between two tokens that still count as one name.
 *
 * Three covers `, `, ` - `, a line wrap and a double space; four would start
 * joining across ` und ` fragments and short markup.
 */
const MAX_TOKEN_GAP = 3;

/** Hard ceiling on tokens per candidate, so one long entry cannot widen every window. */
const MAX_FORM_TOKENS = 5;

const UMLAUT = /[äöüß]/gu;
const HAS_UMLAUT = /[äöüß]/u;
const UMLAUT_EXPANSION: Readonly<Record<string, string>> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;
const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * Fold a token to the form both sides of a comparison are written in.
 *
 * Umlauts expand rather than contract, and that direction is the whole trick:
 * `Müller` and `Mueller` both become `mueller`, so the two spellings compare
 * equal without either one having to be guessed from the other. Contracting
 * instead — rewriting `ue` back to `ü` — is not available, because the digraph
 * is ambiguous in ordinary German: it would turn `Bauer` into `Baür`.
 */
const foldToken = (token: string): string => {
  const lower = token.toLowerCase();
  // Tested before rewriting: every token of a 100 KB body passes through here,
  // and the overwhelming majority of them carry no umlaut at all.
  return HAS_UMLAUT.test(lower)
    ? lower.replaceAll(UMLAUT, (ch) => UMLAUT_EXPANSION[ch] ?? ch)
    : lower;
};

/** Fold a whole phrase: {@link foldToken} plus every separator run to one space. */
const canonicalise = (value: string): string =>
  foldToken(value).replaceAll(NON_WORD_RUN, ' ').trim();

/**
 * Damerau-Levenshtein distance of at most one, including zero.
 *
 * Written as four explicit cases rather than a DP matrix because the answer is
 * only ever "yes" or "no": the matrix would allocate `n*m` cells to compute a
 * number this discards. Every case is a single forward scan to the first
 * mismatch plus one slice comparison, so the cost is linear in the length of
 * the shorter string and there is nothing to allocate.
 */
export function withinEditDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;

  const lengthGap = a.length - b.length;
  if (lengthGap > 1 || lengthGap < -1) return false;

  if (lengthGap === 0) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i += 1;
    // One substitution, or the transposition that makes this Damerau rather
    // than plain Levenshtein — `Mustermnan` is one slip of two fingers, and
    // treating it as two edits would miss the most common typo there is.
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }

  const short = lengthGap < 0 ? a : b;
  const long = lengthGap < 0 ? b : a;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  return short.slice(i) === long.slice(i + 1);
}

/**
 * Ordinary words that must never be reached by a near miss.
 *
 * This is the counterweight to the whole feature. `Leiter` is a plausible room
 * or project codename and `leider` is a word in every second German e-mail;
 * they are one substitution apart, and nothing about their *shape* tells them
 * apart. Only frequency does — so frequency is what is encoded here.
 *
 * It is a frequency list, not a lexicon, and the difference is the trade-off it
 * accepts: rare German words one edit from an entry still fire. Making it a
 * full lexicon would trade those false positives for false negatives on real
 * surnames, which in a PII firewall is the worse direction, and would cost a
 * megabyte of wordlist this package has no way to ship. Nothing under five
 * characters is listed, because {@link FUZZY_MIN_LENGTH} already puts every
 * shorter word out of reach of a six-character entry.
 */
const COMMON_WORD_SOURCE = `
allein allem allen aller alles allerdings andere anderem anderen anderer anderes anders
anfang angebot angst anruf ansicht antrag antwort anzahl arbeit arbeiten arbeitet artikel
aufgabe aufgaben aufgrund augen augenblick ausgabe auskunft ausland aussage außen außer
außerdem auswahl automatisch bedarf bedeutet bedeutung befinden beginn beginnen begriff
behalten behörde beide beiden beispiel bekannt bekommen benutzer bereich bereits bericht
beruf besser bessere bestellt bestellung besuch betrag betreff betrieb bevor bezahlen
bezug bieten bilder billig binnen bisher bitte bitten bleiben bleibt briefe bringen bringt
buchen bücher chance computer dabei dadurch dafür dagegen daher dahin damals damit danach
daneben danke danken daran darauf daraus darin darüber darum darunter datei dateien daten
dauer dauern davon davor deiner denen denken dennoch deren derzeit deshalb dessen deswegen
deutsch deutsche deutschen deutschland diese diesem diesen dieser dieses dinge direkt
doppelt dorthin dritte drucken dürfen durch ebenso echte eigen eigene eigenen eigentlich
einfach einige einigen einmal einzeln einzelne einzige endlich energie entweder erfolg
ergebnis erhalten erklären erste ersten erster erstes erwarten essen etwas euren
fahren fahrer fahrt fallen falls falsch familie farbe fehlen fehler fenster ferien fertig
feste feuer filme finden findet finger firma folgen folgende folgt formular forschung
frage fragen frauen freude freuen freund freunde frieden frisch früher führen führt
funktion ganze ganzen garten geben gebiet gebracht gedanke gedanken gefahr gefallen gefühl
gegen gegeben gegenüber gehalt gehen gehören gehört gelassen gelesen gelten gemacht
gemeinde genau genauso genug gerade gerät gerne gesagt geschäft geschichte gesehen
gesellschaft gespräch gestern gesund gewesen gewinn gewisse glauben gleich gleiche glück
grenze große großen größer grund gründe gruppe guten haben halben halten hallo handel
handeln hatte hatten hause heißen heißt heute hierbei hilfe himmel hinaus hinein hinter
hinweis hoffen hoffentlich höher holen hören ideen immer indem innen innerhalb insgesamt
interesse international inzwischen irgend ihnen ihrem ihren ihrer ihres jahre jahren
jahres jeder jedem jeden jedenfalls jedoch jemand jener jetzt jugend junge jungen kannst
kaufen keine keinem keinen keiner keines kennen kennt kinder kirche klasse kleine kleinen
kommen kommt können könnte könnten kontakt kopie kosten kraft krank kreis kunde kunden
kurze lange langen lassen lässt laufen läuft leben lebens legen lehrer leicht leider
leiten leiter lernen lesen letzte letzten leute licht liebe lieben lieber liegen liegt
links listen lösung machen macht mädchen mangel männer markt mehrere meinem meinen meiner
meist meiste meisten melden meldung mensch menschen mieten minute minuten mitarbeiter
mitte mittel mittwoch möchte möchten mögen möglich möglichkeit monat monate monaten montag
morgen müssen musste mutter nachdem nachher nachricht nachrichten nachts nächste nächsten
namen natürlich neben nehmen nennen neuen neuer neues nicht nichts niemals niemand norden
normal notwendig nummer nutzen obwohl offen offenbar öffnen online ordnung osten person
personen planen platz politik preis preise presse privat problem produkt projekt prozent
prüfen punkt qualität quartal rahmen rasch raten rechnen rechner rechnung recht rechte
rechts reden regel regeln region reise reisen richtig richtung risiko rufen ruhig sache
sachen sagen sagte sammlung samstag schaffen schauen scheinen schicken schlecht schluss
schnell schöne schreiben schrift schritt schule schutz schwer sehen seinem seinen seiner
seite seiten seitdem selber selbst senden service setzen sicher sicherheit sieht sinne
sitzen sofort sogar solche solchen sollen sollte sollten sommer sondern sonntag sonst
sorgen sowie sowohl später spiel spielen sprache sprechen staat stadt stand stark starten
statt stehen steht stelle stellen stellung sterben steuer stimmen stunde stunden suchen
süden system tagen teile teilen telefon termin teuer texte thema tiere tisch tochter
tragen trotz trotzdem über überall überhaupt umgebung unser unsere unseren unserer unten
unter urlaub ursache vater verband verbindung vergessen vergleich verkauf verlag verlassen
verlieren verloren vermutlich verstehen versuch versuchen vertrag verwenden viele vielen
vieles vielleicht vollständig vorbei vorher vorne vorstellen wachsen wagen während
wahrscheinlich warten warum wasser wechsel wegen weiter weitere weiteren welche welchen
welcher welches wenig wenige weniger wenigstens werden werte wesentlich westen wetten
wetter wichtig wieder willst wirklich wirtschaft wissen wochen wohnen wohnung wollen
wollte wollten worden worte worten wunsch würde würden zahlen zahlung zeigen zeigt zeile
zeiten zeitung ziehen ziele zimmer zufall zugleich zuletzt zunächst zurück zusammen
zustand zweite zweiten zwischen
about after again against another because before being between business called change
could customer different during every first following found given going great group
information large later letter level little might message never night number often order
other others place point price problem process project provide public question really
right second service should since small something sound state still story study support
system table thank their there these thing think third those though three through today
together under until using value water where which while world would write years young
`;

const COMMON_WORDS: ReadonlySet<string> = new Set(
  COMMON_WORD_SOURCE.split(/\s+/u)
    .filter((word) => word.length > 0)
    .map((word) => canonicalise(word)),
);

/** One spelling of one entry that a candidate may be compared against. */
interface Form {
  /** The folded text to compare with. */
  readonly canon: string;
  readonly kind: Kind;
  /** Whether an edit-distance match may reach this spelling; see {@link buildForms}. */
  readonly reachableByEdit: boolean;
}

/**
 * Forms bucketed so that a candidate only ever meets a handful of them.
 *
 * THE COST ARGUMENT, and it is the reason this is an index rather than a loop:
 * the near-miss pass runs on the single-threaded event loop that every tenant
 * shares, once per scan copy, on bodies up to the request limit. Comparing
 * every window against every entry would be O(tokens x entries) — with 200
 * entries and a 100 KB body that is millions of string comparisons per request,
 * and one tenant's large paste becomes every tenant's latency.
 *
 * So candidates are bucketed on two facts that a distance-1 match cannot
 * change. Length: one edit moves a length by at most one, so only three
 * buckets can hold a match. First and last character: an edit lands somewhere,
 * and wherever it lands it leaves the other end alone — for any string of two
 * characters or more, a distance-1 neighbour keeps the first character or the
 * last one (a transposition of the first two keeps the last, and vice versa).
 * Six map lookups on single-character keys therefore settle almost every
 * window, and the folded string is only built once one of them is non-empty.
 */
interface FormIndex {
  readonly byFirst: Map<string, Map<number, Form[]>>;
  readonly byLast: Map<string, Map<number, Form[]>>;
  readonly maxTokens: number;
  readonly minLength: number;
  readonly maxLength: number;
}

/**
 * Every spelling of one entry worth carrying, and which of them may be guessed at.
 *
 * The name-order forms exist because a dictionary is written the way a person
 * introduces themselves and a document is written the way a system exported it:
 * `Mustermann, Max` in a CSV column, `M. Mustermann` in a signature block. Both
 * are the same person and neither shares a substring boundary with the entry.
 *
 * The initial forms are marked unreachable by edit distance deliberately. They
 * are already one character away from being nothing at all, so allowing a
 * further edit would let `A. Mustermann` match an entry for Max — a different
 * person, reported under his name.
 */
function buildForms(value: string, kind: Kind): Form[] {
  const nfc = value.normalize('NFC').trim();
  const primary = canonicalise(nfc);
  if (primary.length === 0) return [];

  const spellable = (canon: string): Form => ({
    canon,
    kind,
    reachableByEdit: canon.length >= FUZZY_MIN_LENGTH,
  });

  const forms: Form[] = [spellable(primary)];

  const words = nfc.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length !== 2) return forms;

  const [given, surname] = words as [string, string];
  const initial = [...given][0] ?? '';

  forms.push(spellable(canonicalise(`${surname} ${given}`)));
  for (const canon of [
    canonicalise(`${initial} ${surname}`),
    canonicalise(`${surname} ${initial}`),
  ]) {
    // Guard against a one-word given name folding to nothing, and against the
    // degenerate case where the initial form equals the primary one.
    if (canon.length > 0 && canon !== primary) {
      forms.push({ canon, kind, reachableByEdit: false });
    }
  }

  return forms;
}

function indexForms(forms: readonly Form[]): FormIndex {
  const byFirst = new Map<string, Map<number, Form[]>>();
  const byLast = new Map<string, Map<number, Form[]>>();
  let maxTokens = 1;
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;

  const put = (index: Map<string, Map<number, Form[]>>, key: string, form: Form): void => {
    const byLength = index.get(key) ?? new Map<number, Form[]>();
    index.set(key, byLength);
    const bucket = byLength.get(form.canon.length) ?? [];
    byLength.set(form.canon.length, bucket);
    bucket.push(form);
  };

  for (const form of forms) {
    put(byFirst, form.canon[0] ?? '', form);
    put(byLast, form.canon.at(-1) ?? '', form);
    const tokens = form.canon.split(' ').length;
    if (tokens > maxTokens) maxTokens = Math.min(tokens, MAX_FORM_TOKENS);
    if (form.canon.length < minLength) minLength = form.canon.length;
    if (form.canon.length > maxLength) maxLength = form.canon.length;
  }

  return { byFirst, byLast, maxTokens, minLength, maxLength };
}

/** Is any bucket that could hold a match non-empty? Six single-character lookups. */
function couldHit(index: FormIndex, first: string, last: string, length: number): boolean {
  const byFirst = index.byFirst.get(first);
  const byLast = index.byLast.get(last);
  if (byFirst === undefined && byLast === undefined) return false;
  for (let n = length - 1; n <= length + 1; n += 1) {
    if (byFirst?.has(n) === true || byLast?.has(n) === true) return true;
  }
  return false;
}

interface Hit {
  readonly form: Form;
  /** True when the candidate folded to exactly this spelling; no guessing involved. */
  readonly exact: boolean;
}

function probe(
  index: FormIndex,
  candidate: string,
  first: string,
  last: string,
  maxEditDistance: 0 | 1,
): Hit | null {
  let guess: Form | null = null;

  for (const byLength of [index.byFirst.get(first), index.byLast.get(last)]) {
    if (byLength === undefined) continue;
    for (let n = candidate.length - 1; n <= candidate.length + 1; n += 1) {
      for (const form of byLength.get(n) ?? []) {
        // An exact fold beats any near miss anywhere in the index, so it can
        // return immediately rather than finishing the sweep.
        if (form.canon === candidate) return { form, exact: true };
        if (maxEditDistance === 0 || !form.reachableByEdit || guess !== null) continue;
        if (withinEditDistanceOne(form.canon, candidate)) guess = form;
      }
    }
  }

  return guess === null ? null : { form: guess, exact: false };
}

interface Token {
  readonly start: number;
  readonly end: number;
  readonly canon: string;
}

function tokenise(text: string): Token[] {
  const re = new RegExp(TOKEN.source, TOKEN.flags);
  const out: Token[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      canon: foldToken(match[0]),
    });
  }

  return out;
}

/**
 * May two adjacent tokens be read as one name?
 *
 * A full stop is allowed only after a single character, which is what separates
 * `M. Mustermann` from `Danke Max. Mustermann meldet sich` — the second is two
 * sentences, and joining them would report a name nobody wrote.
 */
function joinable(text: string, from: number, to: number, previousLength: number): boolean {
  const gap = to - from;
  if (gap <= 0 || gap > MAX_TOKEN_GAP) return false;
  if (previousLength === 1) return true;
  // Read out of the source rather than slicing it: this runs once per window,
  // and a slice here is one throwaway string per token pair in the body.
  for (let i = from; i < to; i += 1) {
    if (text[i] === '.') return false;
  }
  return true;
}

/**
 * Dictionary detector for names, customer names and project codenames.
 *
 * Matching is case-insensitive and whole-word, where "word" is defined with
 * Unicode property escapes rather than `\b`. That matters: `\bZoë\b` never
 * matches, because `ë` is not a `\w` character, so there is no word boundary
 * after it.
 *
 * Alternatives are sorted longest-first so that at any given offset the longest
 * entry wins — `Anna Schmidt` beats `Anna`. Overlaps that start at *different*
 * offsets are settled later by `resolveSpans`, which applies the same rule.
 *
 * With {@link DictionaryOptions.fuzzy} a second, opt-in pass looks for near
 * misses: a typo, a reordered name, an initial, an umlaut written as a digraph.
 * It is off by default for two separate reasons, and both are worth stating
 * because they pull the same way.
 *
 * The first is noise. Fuzzy matching cuts both ways in a security product: a
 * distance-1 match on a short entry turns a dictionary into a noise generator,
 * and the operator's response to noise is not to tune it, it is to switch the
 * detector off — at which point the dictionary protects nothing at all. The
 * length floor and the common-word list above are what keep the rate survivable
 * for entries that look like ordinary words, and neither is free of residue.
 *
 * The second is cost, and it is worse than it looks. The literal pass is one
 * regex over the text; the near-miss pass tokenises the body and walks a window
 * over every token run, once per scan copy that fires. Measured on a 100 KB
 * German prose body against a 200-entry dictionary: the literal pass takes
 * 0.3 ms, the near-miss pass 20 ms — sixty times the literal pass it is bolted
 * onto, and that is per scan copy, so a body written to trigger several of them
 * pays it several times over. It is linear in body size, not worse, but it is
 * 20 ms of an event loop that every tenant shares.
 *
 * That surcharge is invisible next to the ~47 ms `detect()` already spends
 * building scan copies for such a body, which is exactly why it must not be
 * default-on: it is cheap enough to hide in a benchmark and expensive enough to
 * matter under load. So the operator asks for it, and gets it on the entries
 * they chose rather than on every request.
 */
export function createDictionaryDetector(
  entries: readonly DictionaryEntry[],
  options: DictionaryOptions = {},
): Detector {
  const priority = options.priority ?? DEFAULT_PRIORITIES.DICTIONARY;
  const maxEditDistance = options.maxEditDistance ?? 1;
  const byLower = new Map<string, Kind>();
  const forms: Form[] = [];

  for (const entry of entries) {
    const value = entry.value.trim();
    if (value.length === 0) continue;
    if (entry.kind !== undefined && !/^[A-Z][A-Z0-9_]*$/u.test(entry.kind)) {
      throw new ConfigError(
        `dictionary entry "${value}" has kind "${entry.kind}"; kinds must be UPPER_SNAKE_CASE`,
      );
    }
    const kind = entry.kind ?? 'NAME';
    byLower.set(value.toLowerCase(), kind);
    if (options.fuzzy === true) forms.push(...buildForms(value, kind));
  }

  if (byLower.size === 0) {
    return { name: 'dictionary', priority, find: () => [] };
  }

  const alternation = [...byLower.keys()]
    .toSorted((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((value) => escapeRegExp(value))
    .join('|');

  const source = String.raw`(?<![\p{L}\p{N}_])(?:${alternation})(?![\p{L}\p{N}_])`;
  const index = forms.length > 0 ? indexForms(forms) : null;

  return {
    name: 'dictionary',
    priority,

    find(text: string): Span[] {
      const re = new RegExp(source, 'giu');
      const out: Span[] = [];
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const value = match[0];
        if (value.length === 0) {
          re.lastIndex += 1;
          continue;
        }
        const kind = byLower.get(value.toLowerCase());
        if (kind === undefined) continue;

        out.push({
          start: match.index,
          end: match.index + value.length,
          kind,
          value,
          detector: 'dictionary',
          priority,
        });
      }

      if (index === null) return out;
      return [...out, ...findNearMisses(text, index, out, maxEditDistance, priority)];
    },
  };
}

/**
 * The near-miss pass.
 *
 * `literal` is the output of the pass above, in ascending, non-overlapping
 * order — which is what lets a single advancing cursor decide whether a window
 * is already spoken for. A literal match always wins over a guess covering the
 * same characters, so those windows are skipped rather than reported and left
 * to `resolveSpans`: it would reach the same answer, but only after both spans
 * had been carried through the whole pipeline.
 */
function findNearMisses(
  text: string,
  index: FormIndex,
  literal: readonly Span[],
  maxEditDistance: 0 | 1,
  priority: number,
): Span[] {
  const tokens = tokenise(text);
  const out: Span[] = [];
  const parts: string[] = [];
  let claimed = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const head = tokens[i]!;
    const first = head.canon[0] ?? '';
    parts.length = 0;
    let length = 0;

    // Windows start at non-decreasing offsets, so the cursor never rewinds.
    while (claimed < literal.length && literal[claimed]!.end <= head.start) claimed += 1;

    for (let n = 0; n < index.maxTokens && i + n < tokens.length; n += 1) {
      const tail = tokens[i + n]!;

      if (n > 0) {
        const previous = tokens[i + n - 1]!;
        if (!joinable(text, previous.end, tail.start, previous.canon.length)) break;
        length += 1;
      }
      parts.push(tail.canon);
      length += tail.canon.length;

      // Windows only grow, so once past the longest form there is nothing left
      // for this starting token.
      if (length > index.maxLength + 1) break;
      if (length + 1 < index.minLength) continue;
      if (literal[claimed] !== undefined && literal[claimed]!.start < tail.end) continue;
      // Underscore is the one word character a token cannot contain, so it is
      // the one way a window can still be glued to a longer word.
      if (isWordChar(text, head.start - 1) || isWordChar(text, tail.end)) continue;

      const last = tail.canon.at(-1) ?? '';
      if (!couldHit(index, first, last, length)) continue;

      const candidate = n === 0 ? tail.canon : parts.join(' ');
      const hit = probe(index, candidate, first, last, maxEditDistance);
      if (hit === null) continue;
      // A guess whose every token is an ordinary word is not a typo of the
      // entry, it is that phrase. Only guesses are held to this: an exact fold
      // of `Leiter` is the entry however common the word.
      if (!hit.exact && parts.every((part) => COMMON_WORDS.has(part))) continue;

      out.push({
        start: head.start,
        end: tail.end,
        kind: hit.form.kind,
        value: text.slice(head.start, tail.end),
        detector: 'dictionary',
        priority,
      });
    }
  }

  return out;
}
