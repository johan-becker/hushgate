/**
 * Legacy bank account details: the German Kontonummer/Bankleitzahl pair, the
 * UK sort code and the US routing number.
 *
 * These are what a customer writes when they are not writing an IBAN — on an
 * old invoice, in a spreadsheet column, in the sentence "bitte auf Kto.
 * 532013000, BLZ 37040044 überweisen" — and none of them has the property that
 * makes the IBAN easy: a checksum over the whole string. A German account
 * number carries a check digit, but which arithmetic produced it is a property
 * of the bank; a UK sort code carries nothing at all; only the US routing
 * number checks itself.
 *
 * So nothing here fires on shape. Every finding is licensed by one of three
 * things, and the file is organised around them:
 *
 *  - **The other half of the pair.** `532013000 / 37040044` is reported because
 *    37040044 is a bank code the Bundesbank publishes and 532013000 satisfies
 *    *that bank's* check-digit method — see {@link isValidGermanAccountNumber}.
 *    Two independent confirmations, and the reason an unlabelled pair is safe.
 *  - **A label.** `Kontonummer: 532013000` is reported because of the word in
 *    front of it, which is the only thing that separates it from an order
 *    number. The window is deliberately narrow.
 *  - **A checksum**, for the US routing number alone.
 *
 * WHAT IS DELIBERATELY NOT REPORTED: a lone account number with no label and no
 * bank code beside it. Six to ten digits is the shape of every reference number
 * in German business correspondence, and a detector that claims them all is one
 * the operator switches off — which costs far more than this case.
 */
import { DEFAULT_PRIORITIES, type Detector, type LabelProximity, type Span } from '../types.js';
import { bankCodeMethod, checkDigitValid } from './bankcheckdigit.js';
import { labelNear } from './normalise.js';
import { isWordChar } from './util.js';

export const BANK_ACCOUNT_KIND = 'BANK_ACCOUNT';

/** See the band explanation on {@link DEFAULT_PRIORITIES}. */
export const BANK_ACCOUNT_PRIORITY = DEFAULT_PRIORITIES.BANK_ACCOUNT;

/**
 * The shortest and longest run of digits that can be an account number.
 *
 * Ten is the German maximum and the widest of the three; four is where a run
 * stops being a plausible account and starts being a year, a quantity or a
 * house number. Anything outside the range is not considered at all, which is
 * also what keeps `Konto 12345678901` — eleven digits — from being reported
 * under a label that would otherwise license it.
 */
const ACCOUNT_MIN = 4;
const ACCOUNT_MAX = 10;

/** A German bank code is exactly eight digits. */
const BANK_CODE_LENGTH = 8;

/** Labels that name an account number. */
export const ACCOUNT_LABELS: readonly string[] = [
  'Kto',
  'Konto',
  'Kontonr',
  'Kontonummer',
  'Konto-Nr',
  'Kontoverbindung',
  'Account',
  'Account number',
  'Acct',
];

/** Labels that name a German bank code. */
export const BANK_CODE_LABELS: readonly string[] = ['BLZ', 'Bankleitzahl'];

/** Labels that name a UK sort code. */
export const SORT_CODE_LABELS: readonly string[] = ['Sort code', 'Sortcode', 'Bank sort code'];

/** Labels that name a US routing number. */
export const ROUTING_LABELS: readonly string[] = [
  'Routing',
  'Routing number',
  'ABA',
  'ABA number',
  'RTN',
];

/**
 * Twenty characters, and only ahead of the digits.
 *
 * Long enough for `Kontonummer: ` against its own value, short enough that the
 * label of one field cannot license the number of the next one — which is the
 * failure mode that matters here, because bank details are written as a run of
 * adjacent fields and the number after the account number is the bank code, the
 * amount or the date.
 */
const labelWindow = (labels: readonly string[]): LabelProximity => ({
  labels,
  window: 20,
  where: 'before',
});

/**
 * ABA routing transit number check, weights 3-7-1 over nine digits.
 *
 * The one part of this file that decides a value on its own. Nine digits
 * summing to a multiple of ten is roughly a one-in-ten filter, which is not
 * enough by itself — hence the label or the account number beside it — but it
 * is enough to keep a nine-digit order number from ever being reported as one.
 */
export function isValidAbaRouting(value: string): boolean {
  if (!/^\d{9}$/u.test(value)) return false;
  if (/^0{9}$/u.test(value)) return false;

  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (value.codePointAt(i)! - 48) * weights[i]!;
  return sum % 10 === 0;
}

/** How to build the detector. */
export interface BankAccountOptions {
  /** Defaults to {@link BANK_ACCOUNT_PRIORITY}. */
  readonly priority?: number;
  /** Added to {@link ACCOUNT_LABELS}. */
  readonly accountLabels?: readonly string[];
  /** Added to {@link BANK_CODE_LABELS}. */
  readonly bankCodeLabels?: readonly string[];
  /** Added to {@link SORT_CODE_LABELS}. */
  readonly sortCodeLabels?: readonly string[];
  /** Added to {@link ROUTING_LABELS}. */
  readonly routingLabels?: readonly string[];
  /**
   * A bank code table of the operator's own, consulted before the shipped
   * Bundesbank snapshot. Return the two-character check-digit method for a
   * code, or `undefined` to fall through to the snapshot.
   *
   * This exists because the snapshot is a snapshot: the Bundesbank republishes
   * quarterly, and an operator who needs a code added last month should not
   * have to wait for a hushgate release. `'09'` is the Bundesbank's own marker
   * for "this bank publishes no check-digit method", so returning it makes a
   * code recognised without claiming to verify its accounts.
   */
  readonly bankCodes?: (code: string) => string | undefined;
}

/** A maximal run of digits that no letter touches. */
interface Run {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
}

/**
 * Every digit run in the text, bounded to the lengths that can matter.
 *
 * One pass, and the length bound is what makes it cheap: a body full of long
 * numeric ids produces runs that are discarded on a length comparison before
 * anything else looks at them.
 */
function digitRuns(text: string, maxLength: number): Run[] {
  const out: Run[] = [];
  const pattern = /\d+/gu;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // A run a letter touches belongs to something else — an IBAN, a part
    // number, a hash — and is never a bare account number.
    if (isWordChar(text, start - 1) || isWordChar(text, end)) continue;
    if (match[0].length > maxLength) continue;
    out.push({ start, end, digits: match[0] });
  }

  return out;
}

/**
 * What may sit between the two halves of a pair.
 *
 * A slash, a comma, a semicolon, a pipe, one line break, or nothing but
 * spaces. Not a hyphen: `2024-0815` is a document number and `12-2024` is a
 * period, and admitting the hyphen here turns both into bank details.
 */
const PAIR_GAP = /^[ \t]*(?:[/,;|]|\r?\n)?[ \t]*$/u;
const PAIR_GAP_MAX = 5;

const gapJoins = (text: string, left: number, right: number): boolean =>
  right - left <= PAIR_GAP_MAX && PAIR_GAP.test(text.slice(left, right));

/**
 * The UK sort code, written the only way it is written: three pairs of digits
 * separated by hyphens.
 */
const SORT_CODE = /\d{2}-\d{2}-\d{2}/gu;

export function createBankAccountDetectors(options: BankAccountOptions = {}): Detector[] {
  const priority = options.priority ?? BANK_ACCOUNT_PRIORITY;
  const accountProximity = labelWindow([...ACCOUNT_LABELS, ...(options.accountLabels ?? [])]);
  const bankCodeProximity = labelWindow([...BANK_CODE_LABELS, ...(options.bankCodeLabels ?? [])]);
  const sortCodeProximity = labelWindow([...SORT_CODE_LABELS, ...(options.sortCodeLabels ?? [])]);
  const routingProximity = labelWindow([...ROUTING_LABELS, ...(options.routingLabels ?? [])]);
  const override = options.bankCodes;

  const methodFor = (code: string): string | undefined =>
    override?.(code) ?? bankCodeMethod(code);

  const accountFits = (account: string, code: string): boolean => {
    const method = methodFor(code);
    if (method === undefined) return false;
    if (Number(account) === 0) return false;
    return checkDigitValid(account, code, method);
  };

  const detector: Detector = {
    name: 'bank-account',
    priority,

    find(text: string): Span[] {
      // Keyed by start offset: a value can be licensed twice — by its label and
      // by the bank code next to it — and that is one finding, not two.
      const found = new Map<number, Span>();
      const claim = (start: number, end: number): void => {
        if (found.has(start)) return;
        found.set(start, {
          start,
          end,
          kind: BANK_ACCOUNT_KIND,
          value: text.slice(start, end),
          detector: 'bank-account',
          priority,
        });
      };

      const runs = digitRuns(text, ACCOUNT_MAX);
      // Keyed by start offset so the sort-code pass can ask "is there a run
      // just here?" in constant time. Scanning the run list per sort code
      // instead is quadratic, and a body of sort codes is a cheap way to hang
      // the proxy: 1 MB of them took minutes before this map existed.
      const runAt = new Map<number, Run>();
      for (const run of runs) runAt.set(run.start, run);

      /* ---------------------------------------- German account and bank code */

      for (const [index, run] of runs.entries()) {
        // The pair, in either order: one half is a bank code the Bundesbank
        // published, the other satisfies that bank's check-digit method.
        const next = runs[index + 1];
        if (next !== undefined && gapJoins(text, run.end, next.start)) {
          const forward =
            run.digits.length === BANK_CODE_LENGTH &&
            next.digits.length >= ACCOUNT_MIN &&
            accountFits(next.digits, run.digits);
          const backward =
            next.digits.length === BANK_CODE_LENGTH &&
            run.digits.length >= ACCOUNT_MIN &&
            accountFits(run.digits, next.digits);

          if (forward || backward) {
            claim(run.start, run.end);
            claim(next.start, next.end);
          }
        }

        // A label, which is what licenses a value standing on its own.
        if (
          run.digits.length === BANK_CODE_LENGTH &&
          labelNear(text, run.start, run.end, bankCodeProximity)
        ) {
          claim(run.start, run.end);
        }
        if (
          run.digits.length >= ACCOUNT_MIN &&
          labelNear(text, run.start, run.end, accountProximity)
        ) {
          claim(run.start, run.end);
        }

        /* ----------------------------------------------- US routing number */

        if (run.digits.length === 9 && isValidAbaRouting(run.digits)) {
          const account = [runs[index - 1], runs[index + 1]].find(
            (other) =>
              other !== undefined &&
              other.digits.length >= ACCOUNT_MIN &&
              (other.start > run.end
                ? gapJoins(text, run.end, other.start)
                : gapJoins(text, other.end, run.start)),
          );
          if (account !== undefined || labelNear(text, run.start, run.end, routingProximity)) {
            claim(run.start, run.end);
            if (account !== undefined) claim(account.start, account.end);
          }
        }
      }

      /* ---------------------------------------------------- UK sort code */

      const sortCode = new RegExp(SORT_CODE.source, 'gu');
      let match: RegExpExecArray | null;
      while ((match = sortCode.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (isWordChar(text, start - 1) || isWordChar(text, end)) continue;
        // A hyphen on either side means a longer run — a date, a part number.
        if (text[start - 1] === '-' || text[end] === '-') continue;

        let account: Run | undefined;
        for (let offset = end; offset <= end + PAIR_GAP_MAX; offset++) {
          const run = runAt.get(offset);
          if (run === undefined) continue;
          if (run.digits.length === BANK_CODE_LENGTH && gapJoins(text, end, run.start)) account = run;
          break;
        }
        if (account === undefined && !labelNear(text, start, end, sortCodeProximity)) continue;

        claim(start, end);
        if (account !== undefined) claim(account.start, account.end);
      }

      return [...found.values()].toSorted((a, b) => a.start - b.start);
    },
  };

  return [detector];
}

/** The detectors with the built-in label lists and the shipped bank codes. */
export const bankAccountDetectors: readonly Detector[] = createBankAccountDetectors();
