/**
 * The German account check digit.
 *
 * A German account number carries a check digit, but *which* arithmetic
 * produced it is a property of the bank, not of the number. The Bundesbank
 * publishes about a hundred and fifty Prüfzifferberechnungsmethoden and names
 * one per bank code, so an account number on its own cannot be checked at all:
 * every one of the ten billion ten-digit strings is a valid account somewhere.
 * The pair is what carries information, and that is what this module checks.
 *
 * WHY IT IS WORTH THE CODE. Without it a legacy Kontonummer/BLZ pair can only
 * be reported when a label sits next to it, and half of them are written
 * `532013000 / 37040044` with no label at all. With it the bank code is looked
 * up and the account number is verified against that bank's own method: two
 * independent confirmations, which is what makes it safe to report an
 * unlabelled pair without drowning the operator in order numbers.
 *
 * SCOPE. Every method any live bank code names is implemented — 91 of them,
 * plus the eight more they delegate to. The ~50 methods the Bundesbank defines
 * but no bank currently uses are deliberately absent: they cannot be reached
 * through {@link isValidGermanAccountNumber}, and an implementation nothing can
 * call is an implementation nothing tests. {@link IMPLEMENTED_CHECK_DIGIT_METHODS}
 * names what is here, and a test fails if a live bank code ever names something
 * outside it.
 *
 * Sources: Deutsche Bundesbank, "Prüfzifferberechnungsmethoden zur Prüfung von
 * Kontonummern auf ihre Richtigkeit" (the algorithms) and the
 * Bankleitzahlendatei (which bank uses which). Every method carries its
 * Bundesbank test account numbers in test/fixtures/bundesbank-checkdigits.ts.
 *
 * HOW THIS WAS VERIFIED, and where it knowingly differs. Beyond the 457
 * official test numbers, every method here was compared against an independent
 * MIT-licensed implementation of the same spec (ibantools-germany) over roughly
 * a million account/bank-code pairs. Ninety-two of the hundred and one methods
 * agree on every pair. The nine that do not are listed here so the next reader
 * does not have to rediscover them; in each the spec sentence is quoted, and in
 * each this file follows the spec:
 *
 *  - **29, 65, and B8/C5/D2 through them** — "Ist das Ergebnis = 10, ist die
 *    Prüfziffer = 0". The other implementation computes `10 - Einerstelle` and
 *    stops, so an account whose check digit is 0 is rejected there.
 *  - **93, and A4 through it** — "Verbleibt nach der Division durch 7 kein
 *    Rest, lautet die Prüfziffer 0". The other implementation yields 7.
 *  - **24** — both exceptions are written "eine ggf. in Stelle 1 vorhandene
 *    Ziffer". The other implementation re-applies the second exception to what
 *    became Stelle 1 after the first had already removed a digit.
 *  - **C0** — "Kontonummern mit weniger oder mehr als zwei führenden Nullen
 *    sind ausschließlich nach der Variante 2 zu prüfen", so exactly two leading
 *    zeros open variant 1, not at least two.
 *  - **D2** — variant 1 is "die Berechnung, *Ausnahmen* und möglichen
 *    Ergebnisse der Methode 95", so an account in one of 95's exempt ranges is
 *    right at variant 1 rather than falling through to variants 2 and 3.
 *
 * Every one of these makes this file accept an account the other rejects. That
 * direction is the safe one here: the cost of a wrong accept is one more span
 * offered to the resolver, and the cost of a wrong reject is personal data
 * leaving the machine.
 */
import { BLZ_CHECK_DIGIT_METHODS } from './blzmethods.js';

/** The ten digits of an account number, index 0 = Stelle 1. */
type Digits = readonly number[];

/**
 * What a method needs to decide. Most read only {@link Account.digits}; the
 * handful of ESER methods (52, 53, and B6/C0 through them) read the bank code,
 * and a few switch on how long the number was before it was padded.
 */
interface Account {
  /** Exactly ten digits, left-padded with zeros. */
  readonly digits: Digits;
  /** How many digits the account had as written, leading zeros stripped. */
  readonly length: number;
  /** The bank code, eight digits. */
  readonly blz: string;
  /** The padded account as a number, for the range rules some methods use. */
  readonly value: number;
}

/** No check digit can satisfy the method: the account number is unusable. */
const NO_CHECK_DIGIT = -1;

/* -------------------------------------------------------------- primitives */

/** Digit sum of a product, as in "Produkt 16 = Quersumme 7". */
const crossSum = (n: number): number => (n < 10 ? n : (n % 10) + Math.floor(n / 10));

/**
 * Weighted sum over `digits[from..to]`, weights applied right to left starting
 * at `to` and cycling when the spec writes "2, 3, 4, 5 ff.".
 */
function weightedRight(
  d: Digits,
  from: number,
  to: number,
  weights: readonly number[],
  fold = false,
): number {
  let sum = 0;
  for (let i = to, w = 0; i >= from; i--, w++) {
    const product = d[i]! * weights[w % weights.length]!;
    sum += fold ? crossSum(product) : product;
  }
  return sum;
}

/** The same, weights applied left to right starting at `from`. */
function weightedLeft(
  d: Digits,
  from: number,
  to: number,
  weights: readonly number[],
  fold = false,
): number {
  let sum = 0;
  for (let i = from, w = 0; i <= to; i++, w++) {
    const product = d[i]! * weights[w % weights.length]!;
    sum += fold ? crossSum(product) : product;
  }
  return sum;
}

/** Verfahren 00 and 01: the units digit taken from ten, a ten becoming zero. */
const mod10 = (sum: number): number => (10 - (sum % 10)) % 10;

/**
 * Verfahren 02: remainder subtracted from eleven. A remainder of one would
 * need a two-digit check digit, so the account number cannot exist.
 */
function mod11Strict(sum: number): number {
  const rest = sum % 11;
  if (rest === 0) return 0;
  if (rest === 1) return NO_CHECK_DIGIT;
  return 11 - rest;
}

/**
 * Verfahren 06: as 02, except that the two-digit result 10 contributes only its
 * units digit, so a remainder of one yields the check digit zero rather than an
 * unusable number.
 */
function mod11Lenient(sum: number): number {
  const rest = sum % 11;
  if (rest === 0 || rest === 1) return 0;
  return 11 - rest;
}

/** Verfahren 51 variant D and 93 variant 2: the same shape over modulus seven. */
function mod7(sum: number): number {
  const rest = sum % 7;
  return rest === 0 ? 0 : 7 - rest;
}

/**
 * The transformation table behind the "iterierte Transformation" methods
 * (27 above account 999 999 999, 29, 69 variant 2 and B8 variant 2). The row
 * is chosen by the digit's position from the right, cycling 1-2-3-4.
 */
const TRANSFORM: readonly (readonly number[])[] = [
  [0, 1, 5, 9, 3, 7, 4, 8, 2, 6],
  [0, 1, 7, 6, 9, 8, 3, 2, 5, 4],
  [0, 1, 8, 4, 6, 2, 9, 5, 7, 3],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
];

/** Sum the transformed digits of `digits[from..to]`, rows cycling from `to`. */
function transformed(d: Digits, from: number, to: number): number {
  let sum = 0;
  for (let i = to, row = 0; i >= from; i--, row++) {
    sum += TRANSFORM[row % 4]![d[i]!]!;
  }
  return sum;
}

/** Shift a ten-digit account `n` places left, filling with zeros on the right. */
const shiftLeft = (d: Digits, n: number): Digits => [...d.slice(n), ...Array(n).fill(0)];

/* ----------------------------------------------------------------- kernels */

/** A method: does this account satisfy its bank's check digit? */
type Method = (account: Account) => boolean;

/**
 * The shape almost every method has: weight a range, fold the sum into an
 * expected check digit, compare it with the digit at `check`.
 */
function rule(options: {
  readonly from: number;
  readonly to: number;
  readonly check: number;
  readonly weights: readonly number[];
  /** Weights run right to left from `to` unless this says otherwise. */
  readonly leftToRight?: boolean;
  /** Take the digit sum of each product, as Verfahren 00 does. */
  readonly fold?: boolean;
  readonly finish: (sum: number) => number;
}): (d: Digits) => boolean {
  const { from, to, check, weights, leftToRight = false, fold = false, finish } = options;
  return (d) => {
    const sum = leftToRight
      ? weightedLeft(d, from, to, weights, fold)
      : weightedRight(d, from, to, weights, fold);
    const expected = finish(sum);
    return expected !== NO_CHECK_DIGIT && expected === d[check];
  };
}

/** Lift a digits-only rule into a {@link Method}. */
const digitsOnly =
  (check: (d: Digits) => boolean): Method =>
  (account) =>
    check(account.digits);

/** Weights that recur often enough to name. */
const W_2_1 = [2, 1] as const;
const W_2_TO_7 = [2, 3, 4, 5, 6, 7] as const;
const W_2_TO_10 = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const W_04 = [2, 3, 4, 5, 6, 7, 2, 3, 4] as const;
const W_ESER = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1, 2, 4] as const;

/* ------------------------------------------------------------- the methods */

/** Verfahren 00 — Modulus 10, Gewichtung 2, 1, mit Quersumme. */
const m00 = rule({ from: 0, to: 8, check: 9, weights: W_2_1, fold: true, finish: mod10 });

/** Verfahren 01 — Modulus 10, Gewichtung 3, 7, 1, ohne Quersumme. */
const m01 = rule({ from: 0, to: 8, check: 9, weights: [3, 7, 1], finish: mod10 });

/** Verfahren 02 — Modulus 11, Gewichtung 2 bis 9 und 2. */
const m02 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8, 9, 2],
  finish: mod11Strict,
});

/** Verfahren 03 — wie 01, Gewichtung 2, 1. */
const m03 = rule({ from: 0, to: 8, check: 9, weights: W_2_1, finish: mod10 });

/** Verfahren 04 — wie 02, Gewichtung 2 bis 7 und 2, 3, 4. */
const m04 = rule({ from: 0, to: 8, check: 9, weights: W_04, finish: mod11Strict });

/** Verfahren 05 — wie 01, Gewichtung 7, 3, 1. */
const m05 = rule({ from: 0, to: 8, check: 9, weights: [7, 3, 1], finish: mod10 });

/** Verfahren 06 — Modulus 11, Gewichtung 2 bis 7, modifiziert. */
const m06 = rule({ from: 0, to: 8, check: 9, weights: W_2_TO_7, finish: mod11Lenient });

/** Verfahren 07 — wie 02, Gewichtung 2 bis 10. */
const m07 = rule({ from: 0, to: 8, check: 9, weights: W_2_TO_10, finish: mod11Strict });

/** Verfahren 10 — wie 06, Gewichtung 2 bis 10. */
const m10 = rule({ from: 0, to: 8, check: 9, weights: W_2_TO_10, finish: mod11Lenient });

/**
 * Verfahren 11 — wie 10, aber das Rechenergebnis 10 wird zur 9 statt zur 0.
 */
const m11 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: W_2_TO_10,
  finish: (sum) => {
    const rest = sum % 11;
    if (rest === 0) return 0;
    if (rest === 1) return 9;
    return 11 - rest;
  },
});

/** Verfahren 20 — wie 06, Gewichtung 2 bis 9 und 3. */
const m20 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8, 9, 3],
  finish: mod11Lenient,
});

/**
 * Verfahren 21 — wie 00, aber die Produktsumme wird bis zur Einstelligkeit
 * quergesummt, bevor sie von zehn abgezogen wird.
 */
const m21 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: W_2_1,
  fold: true,
  finish: (sum) => {
    let value = sum;
    while (value > 9) value = crossSum(value);
    return (10 - value) % 10;
  },
});

/**
 * Verfahren 22 — Modulus 10, Gewichtung 3, 1: von den Produkten bleibt die
 * Zehnerstelle unberücksichtigt, was etwas anderes ist als eine Quersumme.
 */
const m22Sum = (d: Digits): number => {
  let sum = 0;
  for (let i = 8, w = 0; i >= 0; i--, w++) sum += (d[i]! * [3, 1][w % 2]!) % 10;
  return sum;
};
const method22 = digitsOnly((d) => mod10(m22Sum(d)) === d[9]);

/** Verfahren 25 — wie 02 über Stelle 2 bis 9; Rest 1 nur für Arbeitsziffer 8/9. */
const method25 = digitsOnly((d) => {
  const sum = weightedRight(d, 1, 8, [2, 3, 4, 5, 6, 7, 8, 9]);
  const rest = sum % 11;
  if (rest === 1) return d[9] === 0 && (d[1] === 8 || d[1] === 9);
  const expected = rest === 0 ? 0 : 11 - rest;
  return expected === d[9];
});

/** Verfahren 28 — wie 06 über Stelle 1 bis 7, Prüfziffer in Stelle 8. */
const m28 = rule({ from: 0, to: 6, check: 7, weights: [2, 3, 4, 5, 6, 7, 8], finish: mod11Lenient });

/** Verfahren 29 — Modulus 10, iterierte Transformation. */
const m29 = (d: Digits): boolean => mod10(transformed(d, 0, 8)) === d[9];

/** Verfahren 32 — wie 06 über Stelle 4 bis 9. */
const m32 = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: mod11Lenient });

/** Verfahren 33 — wie 06 über Stelle 5 bis 9. */
const m33 = rule({ from: 4, to: 8, check: 9, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });

/** Verfahren 58 — wie 02 über Stelle 5 bis 9. */
const m58 = rule({ from: 4, to: 8, check: 9, weights: [2, 3, 4, 5, 6], finish: mod11Strict });

/** Verfahren 63 — Grundnummer in Stelle 2 bis 7, Prüfziffer in Stelle 8. */
const m63Main = rule({ from: 1, to: 6, check: 7, weights: W_2_1, fold: true, finish: mod10 });
/** Dieselbe Rechnung, wenn die Unterkontonummer »00« weggelassen wurde. */
const m63Shifted = rule({ from: 3, to: 8, check: 9, weights: W_2_1, fold: true, finish: mod10 });
const method63: Method = ({ digits: d, length }) => {
  // Stelle 1 gehört nicht zur Kontonummer und muss 0 sein.
  if (d[0] !== 0) return false;
  // After the shift the old Stelle 3 becomes Stelle 1, which must be 0 too.
  return m63Main(d) || (length <= 8 && d[2] === 0 && m63Shifted(d));
};

/**
 * Verfahren 68 — die Gewichte hängen an der Stelle *von rechts*, und welche
 * Stellen überhaupt zählen, hängt an der ungepolsterten Länge.
 */
function m68Sum(d: Digits, from: number, to: number, skipRight: readonly number[] = []): number {
  let sum = 0;
  for (let i = to; i >= from; i--) {
    const fromRight = 10 - i;
    if (skipRight.includes(fromRight)) continue;
    sum += crossSum(d[i]! * (fromRight % 2 === 0 ? 2 : 1));
  }
  return sum;
}
const method68: Method = ({ digits: d, length, value }) => {
  if (length === 10) {
    // Stelle 7 von rechts muss eine 9 sein; gerechnet wird über Stelle 2 bis 7.
    return d[3] === 9 && mod10(m68Sum(d, 3, 8)) === d[9];
  }
  if (length < 6) return false;
  // Neunstellige Nummern von 400 000 000 bis 499 999 999 tragen keine Prüfziffer.
  if (length === 9 && value >= 400_000_000 && value <= 499_999_999) return true;
  const start = 10 - length;
  if (mod10(m68Sum(d, start, 8)) === d[9]) return true;
  return mod10(m68Sum(d, start, 8, [7, 8])) === d[9];
};

/** Verfahren 93 — Kundennummer entweder in Stelle 1 bis 5 oder in Stelle 5 bis 9. */
const m93A11 = rule({ from: 0, to: 4, check: 5, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });
const m93B11 = rule({ from: 4, to: 8, check: 9, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });
const m93A7 = rule({ from: 0, to: 4, check: 5, weights: [2, 3, 4, 5, 6], finish: mod7 });
const m93B7 = rule({ from: 4, to: 8, check: 9, weights: [2, 3, 4, 5, 6], finish: mod7 });
const method93 = digitsOnly((d) => {
  const caseB = d[0] === 0 && d[1] === 0 && d[2] === 0 && d[3] === 0;
  return caseB ? m93B11(d) || m93B7(d) : m93A11(d) || m93A7(d);
});

/** Verfahren 75 — fünfstellige Stammnummer, deren Lage an der Länge hängt. */
const m75_6or7 = rule({
  from: 4,
  to: 8,
  check: 9,
  weights: [2, 1, 2, 1, 2],
  leftToRight: true,
  fold: true,
  finish: mod10,
});
const m75_9plain = rule({
  from: 1,
  to: 5,
  check: 6,
  weights: [2, 1, 2, 1, 2],
  leftToRight: true,
  fold: true,
  finish: mod10,
});
const m75_9nine = rule({
  from: 2,
  to: 6,
  check: 7,
  weights: [2, 1, 2, 1, 2],
  leftToRight: true,
  fold: true,
  finish: mod10,
});
const method75 = digitsOnly((d) => {
  if (d[0] === 0 && d[1] === 0 && d[2] === 0) return m75_6or7(d);
  if (d[0] === 0 && d[1] === 9) return m75_9nine(d);
  return m75_9plain(d);
});

/**
 * Verfahren 52 und 53 — ESER-Altsystem.
 *
 * The only methods that read the bank code. The bank's old mainframe account
 * number is rebuilt from four digits of the bank code and the account number,
 * with the account's own leading zeros dropped, and the check digit is the
 * factor that drives the weighted remainder to exactly ten.
 */
function eserValid(oldNumber: readonly number[], checkIndex: number, actual: number): boolean {
  const length = oldNumber.length;
  let sum = 0;
  for (let i = length - 1, w = 0; i >= 0; i--, w++) {
    if (i === checkIndex) continue;
    sum += oldNumber[i]! * W_ESER[w % W_ESER.length]!;
  }
  const weightOverCheck = W_ESER[(length - 1 - checkIndex) % W_ESER.length]!;
  const rest = sum % 11;
  for (let candidate = 0; candidate <= 9; candidate++) {
    if ((rest + candidate * weightOverCheck) % 11 === 10) return candidate === actual;
  }
  return false;
}

const stripLeading = (digits: readonly number[]): readonly number[] => {
  let i = 0;
  while (i < digits.length - 1 && digits[i] === 0) i++;
  return digits.slice(i);
};

const isEserBankCode = (blz: string): boolean => /^\d{3}5\d{4}$/u.test(blz);

const method52: Method = ({ digits: d, blz, length }) => {
  // Zehnstellige Nummern, die mit 9 beginnen, rechnen nach Verfahren 20.
  if (length === 10 && d[0] === 9) return m20(d);
  if (!isEserBankCode(blz) || length > 8) return false;
  const bank = [...blz].map(Number);
  const account = d.slice(2); // die achtstellige Kontonummer
  const tail = stripLeading(account.slice(2));
  const old = [...bank.slice(4), account[0]!, account[1]!, ...tail];
  return eserValid(old, 5, account[1]!);
};

const method53: Method = ({ digits: d, blz, length }) => {
  if (length === 10 && d[0] === 9) return m20(d);
  if (!isEserBankCode(blz) || length < 9) return false;
  const bank = [...blz].map(Number);
  const account = d.slice(1); // die neunstellige Kontonummer
  const tail = stripLeading(account.slice(3));
  const old = [bank[4]!, bank[5]!, account[1]!, bank[7]!, account[0]!, account[2]!, ...tail];
  return eserValid(old, 5, account[2]!);
};

/**
 * Verfahren 51's Sachkonto exception, which is all that survives of 51 here:
 * no live bank code names 51 itself, but A8 dispatches into this branch.
 */
const m51Exception1 = rule({
  from: 2,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8],
  finish: mod11Lenient,
});
const m51Exception2 = rule({ from: 0, to: 8, check: 9, weights: W_2_TO_10, finish: mod11Lenient });
const m51Sachkonto = (d: Digits): boolean => m51Exception1(d) || m51Exception2(d);

/** Verfahren 13 — Grundnummer in Stelle 2 bis 7; die Unterkontonummer darf fehlen. */
const m13 = rule({ from: 1, to: 6, check: 7, weights: W_2_1, fold: true, finish: mod10 });
const method13: Method = ({ digits: d, length }) =>
  m13(d) || (length <= 8 && m13(shiftLeft(d, 2)));

/** Verfahren 50 — Grundnummer in Stelle 1 bis 6; die Unternummer darf fehlen. */
const m50 = rule({
  from: 0,
  to: 5,
  check: 6,
  weights: [7, 6, 5, 4, 3, 2],
  leftToRight: true,
  finish: mod11Lenient,
});
const method50: Method = ({ digits: d, length }) =>
  m50(d) || (length <= 7 && m50(shiftLeft(d, 3)));

/** Verfahren 17 — Stammnummer in Stelle 2 bis 7, Quersumme nur auf den Zweiern. */
const method17 = digitsOnly((d) => {
  let sum = 0;
  for (let i = 1, w = 0; i <= 6; i++, w++) {
    const weight = w % 2 === 0 ? 1 : 2;
    sum += weight === 2 ? crossSum(d[i]! * 2) : d[i]!;
  }
  const rest = (sum - 1) % 11;
  return (rest === 0 ? 0 : 10 - rest) === d[7];
});

/** Verfahren C1 Variante 2 — dieselbe Idee wie 17, über neun Stellen. */
const c1Variant2 = (d: Digits): boolean => {
  let sum = 0;
  for (let i = 0; i <= 8; i++) {
    const weight = i % 2 === 0 ? 1 : 2;
    sum += weight === 2 ? crossSum(d[i]! * 2) : d[i]!;
  }
  const rest = (sum - 1) % 11;
  return (rest === 0 ? 0 : 10 - rest) === d[9];
};

/** Verfahren 24 — Reste einer Division je Stelle, aufsummiert. */
const method24 = digitsOnly((d) => {
  const working = [...d];
  if (working[0]! >= 3 && working[0]! <= 6) working[0] = 0;
  if (working[0] === 9) working[0] = working[1] = working[2] = 0;
  let start = 0;
  while (start < 9 && working[start] === 0) start++;
  let sum = 0;
  for (let i = start, w = 0; i <= 8; i++, w++) {
    const weight = (w % 3) + 1;
    sum += (working[i]! * weight + weight) % 11;
  }
  return sum % 10 === d[9];
});

/** Verfahren 16 und 23 — Rest 1 macht die Nummer richtig, wenn zwei Stellen gleich sind. */
const m16Sum = (d: Digits): number => weightedRight(d, 0, 8, W_04);
const method16 = digitsOnly((d) => {
  const sum = m16Sum(d);
  // "unabhängig vom eigentlichen Berechnungsergebnis richtig" — the identity of
  // the last two digits is a second way to be right, not a replacement for the
  // first, which for Rest 1 still yields the check digit 0.
  if (sum % 11 === 1 && d[9] === d[8]) return true;
  return mod11Lenient(sum) === d[9];
});
/** Verfahren 26 — bei zwei führenden Nullen rückt die Nummer zwei Stellen nach links. */
const m26 = rule({
  from: 0,
  to: 6,
  check: 7,
  weights: [2, 3, 4, 5, 6, 7, 2],
  finish: mod11Lenient,
});
const method26 = digitsOnly((d) => m26(d[0] === 0 && d[1] === 0 ? shiftLeft(d, 2) : d));

/** Verfahren 27 — bis 999 999 999 wie 00, darüber die iterierte Transformation. */
const method27: Method = ({ digits: d, value }) =>
  value <= 999_999_999 ? m00(d) : mod10(transformed(d, 0, 8)) === d[9];

/** Verfahren 30 — Gewichte von links, ohne Quersumme. */
const m30 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [2, 0, 0, 0, 0, 1, 2, 1, 2],
  leftToRight: true,
  finish: mod10,
});

/** Verfahren 31 — der Rest selbst ist die Prüfziffer; Rest 10 macht sie unbrauchbar. */
const m31 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  leftToRight: true,
  finish: (sum) => {
    const rest = sum % 11;
    return rest === 10 ? NO_CHECK_DIGIT : rest;
  },
});

/** Verfahren 34 bis 44 — wie 28 beziehungsweise 06 mit anderen Gewichten. */
const m34 = rule({
  from: 0,
  to: 6,
  check: 7,
  weights: [2, 4, 8, 5, 10, 9, 7],
  finish: mod11Lenient,
});
const m38 = rule({ from: 3, to: 8, check: 9, weights: [2, 4, 8, 5, 10, 9], finish: mod11Lenient });
const m40 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [2, 4, 8, 5, 10, 9, 7, 3, 6],
  finish: mod11Lenient,
});
const m42 = rule({
  from: 1,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8, 9],
  finish: mod11Lenient,
});
const m43 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  finish: mod10,
});
const m44 = rule({ from: 4, to: 8, check: 9, weights: [2, 4, 8, 5, 10], finish: mod11Lenient });

/** Verfahren 41 — eine 9 in Stelle 4 nimmt die ersten drei Stellen aus der Rechnung. */
const m41Short = rule({ from: 3, to: 8, check: 9, weights: W_2_1, fold: true, finish: mod10 });
const method41 = digitsOnly((d) => (d[3] === 9 ? m41Short(d) : m00(d)));

/** Verfahren 46 bis 48 — wie 06 über verschobene Bereiche. */
const m46 = rule({ from: 2, to: 6, check: 7, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });
const m47 = rule({ from: 3, to: 7, check: 8, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });
const m48 = rule({ from: 2, to: 7, check: 8, weights: W_2_TO_7, finish: mod11Lenient });

/** Verfahren 56 — zweistellige Ergebnisse sind nur bei führender 9 brauchbar. */
const method56 = digitsOnly((d) => {
  const rest = weightedRight(d, 0, 8, W_04) % 11;
  const raw = 11 - rest;
  if (raw === 10) return d[0] === 9 && d[9] === 7;
  if (raw === 11) return d[0] === 9 && d[9] === 8;
  return raw === d[9];
});

/** Verfahren 57 — vier Varianten, ausgewählt an den ersten beiden Stellen. */
const m57Variant1 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [1, 2, 1, 2, 1, 2, 1, 2, 1],
  leftToRight: true,
  fold: true,
  finish: mod10,
});
const m57Variant2 = (d: Digits): boolean => {
  // Die Prüfziffer sitzt in Stelle 3; gewichtet werden die übrigen neun Stellen.
  const positions = [0, 1, 3, 4, 5, 6, 7, 8, 9];
  const weights = [1, 2, 1, 2, 1, 2, 1, 2, 1];
  let sum = 0;
  for (const [index, position] of positions.entries()) {
    sum += crossSum(d[position]! * weights[index]!);
  }
  return mod10(sum) === d[2];
};
const method57 = digitsOnly((d) => {
  const lead = d[0]! * 10 + d[1]!;
  if (lead === 0) return false;
  const first6 = d.slice(0, 6).join('');
  if (first6 === '777777' || first6 === '888888') return true;
  const V1 = new Set([51, 55, 61, 64, 65, 66, 70, 88, 94, 95, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82]);
  const V3 = new Set([40, 50, 91, 99]);
  if (V1.has(lead)) return m57Variant1(d);
  if (V3.has(lead)) return true;
  if (lead >= 1 && lead <= 31) {
    if (d.join('') === '0185125434') return true;
    const month = d[2]! * 10 + d[3]!;
    const tail = d[6]! * 100 + d[7]! * 10 + d[8]!;
    return month >= 1 && month <= 12 && tail < 500;
  }
  return m57Variant2(d);
});

/** Verfahren 59 — kürzere Nummern als neun Stellen tragen keine Prüfziffer. */
const method59: Method = ({ digits: d, length }) => (length < 9 ? true : m00(d));

/** Verfahren 60 — Grundnummer in Stelle 3 bis 9. */
const m60 = rule({ from: 2, to: 8, check: 9, weights: W_2_1, fold: true, finish: mod10 });

/**
 * Verfahren 61 und 65 — eine bestimmte Artziffer zieht die letzten beiden
 * Stellen in die Rechnung, mit den Gewichten von links durchgezählt.
 */
function artziffer(d: Digits, extended: boolean): boolean {
  const positions = extended ? [0, 1, 2, 3, 4, 5, 6, 8, 9] : [0, 1, 2, 3, 4, 5, 6];
  const weights = [2, 1, 2, 1, 2, 1, 2, 1, 2];
  let sum = 0;
  for (const [index, position] of positions.entries()) sum += crossSum(d[position]! * weights[index]!);
  return mod10(sum) === d[7];
}
const method61 = digitsOnly((d) => artziffer(d, d[8] === 8));
const method65 = digitsOnly((d) => artziffer(d, d[8] === 9));

/** Verfahren 64 — Gewichte von links über Stelle 1 bis 6. */
const m64 = rule({
  from: 0,
  to: 5,
  check: 6,
  weights: [9, 10, 5, 8, 4, 2],
  leftToRight: true,
  finish: mod11Lenient,
});

/** Verfahren 67 — Stammnummer in Stelle 1 bis 7. */
const m67 = rule({ from: 0, to: 6, check: 7, weights: W_2_1, fold: true, finish: mod10 });

/** Verfahren 70 — eine 5 oder eine 69 in Stelle 4 kürzt den Bereich. */
/** Verfahren 71 — Rest 1 lässt die Zehnerstelle als Prüfziffer stehen. */
const m71 = rule({
  from: 1,
  to: 6,
  check: 9,
  weights: [6, 5, 4, 3, 2, 1],
  leftToRight: true,
  finish: (sum) => {
    const rest = sum % 11;
    if (rest === 0) return 0;
    if (rest === 1) return 1;
    return 11 - rest;
  },
});

/** Verfahren 74 — bei sechsstelligen Nummern zählt auch die nächste Halbdekade. */
const method74: Method = ({ digits: d, length }) => {
  const sum = weightedRight(d, 0, 8, W_2_1, true);
  if (mod10(sum) === d[9]) return true;
  if (length === 6) {
    const units = sum % 10;
    const halfDecade = units <= 5 ? 5 - units : 15 - units;
    if (halfDecade === d[9]) return true;
  }
  return m04(d);
};

/** Verfahren 76 — Stammnummer und Prüfziffer wandern mit der Kontoart. */
const KONTOART = new Set([0, 4, 6, 7, 8, 9]);
const m76Main = rule({ from: 1, to: 6, check: 7, weights: W_2_TO_7, finish: (sum) => {
  const rest = sum % 11;
  return rest === 10 ? NO_CHECK_DIGIT : rest;
} });
const m76Shifted = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: (sum) => {
  const rest = sum % 11;
  return rest === 10 ? NO_CHECK_DIGIT : rest;
} });
const method76: Method = ({ digits: d, length }) => {
  if (!KONTOART.has(d[0]!)) return false;
  return m76Main(d) || (length <= 8 && m76Shifted(d));
};

/** Verfahren 78 — achtstellige Nummern tragen keine Prüfziffer. */
const method78: Method = ({ digits: d, length }) => (length === 8 ? true : m00(d));

/** Verfahren 88 — eine 9 in Stelle 3 verlängert den Bereich. */
const m88Main = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: mod11Lenient });
const m88Nine = rule({
  from: 2,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8],
  finish: mod11Lenient,
});
const method88 = digitsOnly((d) => (d[2] === 9 ? m88Nine(d) : m88Main(d)));

/** Verfahren 91 — vier Gewichtungen über dieselbe Kundennummer. */
const m91V1 = rule({
  from: 0,
  to: 5,
  check: 6,
  weights: [7, 6, 5, 4, 3, 2],
  leftToRight: true,
  finish: mod11Lenient,
});
const m91V2 = rule({
  from: 0,
  to: 5,
  check: 6,
  weights: W_2_TO_7,
  leftToRight: true,
  finish: mod11Lenient,
});
const m91V3 = rule({
  from: 0,
  to: 9,
  check: 6,
  weights: [10, 9, 8, 7, 6, 5, 0, 4, 3, 2],
  leftToRight: true,
  finish: mod11Lenient,
});
const m91V4 = rule({
  from: 0,
  to: 5,
  check: 6,
  weights: [9, 10, 5, 8, 4, 2],
  leftToRight: true,
  finish: mod11Lenient,
});
const method91 = digitsOnly((d) => m91V1(d) || m91V2(d) || m91V3(d) || m91V4(d));

/** Verfahren 92 — wie 01 über Stelle 4 bis 9. */
const m92 = rule({ from: 3, to: 8, check: 9, weights: [3, 7, 1], finish: mod10 });

/** Verfahren 94 — Gewichte 1, 2 von rechts, mit Quersumme. */
const m94 = rule({ from: 0, to: 8, check: 9, weights: [1, 2], fold: true, finish: mod10 });

/** Verfahren 95 und 99 — mehrere Nummernkreise tragen keine Prüfziffer. */
const m95Core = rule({ from: 0, to: 8, check: 9, weights: W_04, finish: mod11Lenient });
const method95: Method = ({ digits: d, value }) => {
  if (
    (value >= 1 && value <= 1_999_999) ||
    (value >= 9_000_000 && value <= 25_999_999) ||
    (value >= 396_000_000 && value <= 499_999_999) ||
    (value >= 700_000_000 && value <= 799_999_999) ||
    (value >= 910_000_000 && value <= 989_999_999)
  ) {
    return true;
  }
  return m95Core(d);
};
const method99: Method = ({ digits: d, value }) =>
  value >= 396_000_000 && value <= 499_999_999 ? true : m95Core(d);

/** Verfahren 96 — zwei Rechnungen und ein Nummernkreis, der immer gilt. */
const m19 = rule({
  from: 0,
  to: 8,
  check: 9,
  weights: [2, 3, 4, 5, 6, 7, 8, 9, 1],
  finish: mod11Lenient,
});
const method96: Method = ({ digits: d, value }) => {
  if (m19(d) || m00(d)) return true;
  return value >= 1_300_000 && value <= 99_399_999;
};

/** Verfahren 98 — wie 01 über Stelle 3 bis 9, sonst wie 32. */
const m98Core = rule({ from: 2, to: 8, check: 9, weights: [3, 1, 7], finish: mod10 });
const method98 = digitsOnly((d) => m98Core(d) || m32(d));

/** Verfahren A4 — die Ziffernfolge 99 in Stelle 3 und 4 wählt einen anderen Weg. */
const mA4V1 = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: mod11Lenient });
const mA4V2 = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: mod7 });
const mA4V3 = rule({ from: 4, to: 8, check: 9, weights: [2, 3, 4, 5, 6], finish: mod11Lenient });
const methodA4 = digitsOnly((d) => {
  if (d[2] === 9 && d[3] === 9) return mA4V3(d) || method93({ digits: d } as Account);
  return mA4V1(d) || mA4V2(d) || method93({ digits: d } as Account);
});

/** Verfahren A5 — nach einem Fehler in Variante 1 sind führende Neunen falsch. */
const methodA5: Method = ({ digits: d, length }) => {
  if (m00(d)) return true;
  if (length === 10 && d[0] === 9) return false;
  return m10(d);
};

/** Verfahren A6 — eine 8 in Stelle 2 entscheidet zwischen 00 und 01. */
const methodA6 = digitsOnly((d) => (d[1] === 8 ? m00(d) : m01(d)));

/** Verfahren A8 — wie 51, wenn Stelle 3 eine 9 ist. */
const mA8V1 = rule({ from: 3, to: 8, check: 9, weights: W_2_TO_7, finish: mod11Lenient });
const mA8V2 = rule({ from: 3, to: 8, check: 9, weights: W_2_1, fold: true, finish: mod10 });
const methodA8 = digitsOnly((d) => (d[2] === 9 ? m51Sachkonto(d) : mA8V1(d) || mA8V2(d)));

/** Verfahren B5 — nach einem Fehler sind führende 8 und 9 falsch. */
const methodB5: Method = ({ digits: d }) => {
  const variant1 = rule({ from: 0, to: 8, check: 9, weights: [7, 3, 1], finish: mod10 });
  if (variant1(d)) return true;
  if (d[0] === 8 || d[0] === 9) return false;
  return m00(d);
};

/** Verfahren B6 — führende Ziffern oder ein Nummernkreis wählen Methode 20. */
const methodB6: Method = (account) => {
  const d = account.digits;
  const first5 = Number(d.slice(0, 5).join(''));
  if (d[0] !== 0 || (first5 >= 2691 && first5 <= 2699)) return m20(d);
  return method53(account);
};

/** Verfahren B7 — nur zwei Nummernkreise sind überhaupt prüfziffergesichert. */
const methodB7: Method = ({ digits: d, value }) => {
  const inRange =
    (value >= 1_000_000 && value <= 5_999_999) ||
    (value >= 700_000_000 && value <= 899_999_999);
  return inRange ? m01(d) : true;
};

/** Verfahren B8 — zwei Rechnungen und zwei freie Nummernkreise. */
const methodB8: Method = ({ digits: d, value }) => {
  if (m20(d)) return true;
  if (mod10(transformed(d, 0, 8)) === d[9]) return true;
  return (
    (value >= 5_100_000_000 && value <= 5_999_999_999) ||
    (value >= 9_010_000_000 && value <= 9_109_999_999)
  );
};

/** Verfahren C0 — zwei führende Nullen erlauben zuerst das ESER-Verfahren. */
const methodC0: Method = (account) => {
  const d = account.digits;
  const twoLeadingZeros = d[0] === 0 && d[1] === 0 && d[2] !== 0;
  if (twoLeadingZeros && method52(account)) return true;
  return m20(d);
};

/** Verfahren C1 — eine 5 in Stelle 1 wählt die zweite Variante. */
const methodC1 = digitsOnly((d) => (d[0] === 5 ? c1Variant2(d) : method17({ digits: d } as Account)));

/** Verfahren C3 — eine 9 in Stelle 1 wählt Verfahren 58. */
const methodC3 = digitsOnly((d) => (d[0] === 9 ? m58(d) : m00(d)));

/** Verfahren C5 — jede Variante gilt nur für ihren Nummernkreis. */
const methodC5: Method = (account) => {
  const { digits: d, value } = account;
  if (value >= 100_000 && value <= 899_999) return method75(account);
  if (value >= 100_000_000 && value <= 899_999_999) return method75(account);
  if (
    (value >= 1_000_000_000 && value <= 1_999_999_999) ||
    (value >= 4_000_000_000 && value <= 6_999_999_999) ||
    (value >= 9_000_000_000 && value <= 9_999_999_999)
  ) {
    return mod10(transformed(d, 0, 8)) === d[9];
  }
  if (value >= 3_000_000_000 && value <= 3_999_999_999) return m00(d);
  if (value >= 30_000_000 && value <= 59_999_999) return true;
  if (value >= 7_000_000_000 && value <= 7_099_999_999) return true;
  if (value >= 8_500_000_000 && value <= 8_599_999_999) return true;
  return false;
};

/** Verfahren C7 — erst 63, dann 06. */
const methodC7: Method = (account) => method63(account) || m06(account.digits);

/** Verfahren D0 — der Nummernkreis 57 ist frei. */
const methodD0 = digitsOnly((d) => (d[0] === 5 && d[1] === 7 ? true : m20(d)));

/** Verfahren D2 — 95, dann 00, dann 68. */
const methodD2: Method = (account) =>
  method95(account) || m00(account.digits) || method68(account);

/** Verfahren D6 — 07, dann 03, dann 00. */
const methodD6 = digitsOnly((d) => m07(d) || m03(d) || m00(d));

/** Verfahren D7 — die Einerstelle selbst ist die Prüfziffer. */
const methodD7 = digitsOnly((d) => weightedRight(d, 0, 8, W_2_1, true) % 10 === d[9]);

/** Verfahren D8 — ein Nummernkreis rechnet, einer ist frei, der Rest ist falsch. */
const methodD8: Method = ({ digits: d, value }) => {
  if (value >= 1_000_000_000) return m00(d);
  if (value >= 10_000_000 && value <= 99_999_999) return true;
  return false;
};

/** Verfahren E0 — wie 00, aber die Summe wird vor der Einerstelle um 7 erhöht. */
const methodE0 = digitsOnly(
  (d) => mod10(weightedRight(d, 0, 8, W_2_1, true) + 7) === d[9],
);

/* --------------------------------------------------------------- the table */

/**
 * Every method a live bank code names, plus the ones those delegate to.
 *
 * The order is the Bundesbank's own. A method that is simply another method
 * under a different name says so by sharing its function.
 */
const METHODS: Readonly<Record<string, Method>> = {
  '00': digitsOnly(m00),
  '01': digitsOnly(m01),
  '02': digitsOnly(m02),
  '03': digitsOnly(m03),
  '04': digitsOnly(m04),
  '05': digitsOnly(m05),
  '06': digitsOnly(m06),
  '07': digitsOnly(m07),
  // Verfahren 08 rechnet wie 00, "jedoch erst ab der Kontonummer 60 000":
  // darunter trägt die Nummer keine Prüfziffer, ist also nicht zu widerlegen.
  '08': ({ digits: d, value }) => (value < 60_000 ? true : m00(d)),
  '09': () => true,
  '10': digitsOnly(m10),
  '11': digitsOnly(m11),
  '13': method13,
  '16': method16,
  '17': method17,
  // Verfahren 18 rechnet wie 01 mit der Gewichtung 3, 9, 7, 1.
  '18': digitsOnly(rule({ from: 0, to: 8, check: 9, weights: [3, 9, 7, 1], finish: mod10 })),
  '19': digitsOnly(m19),
  '20': digitsOnly(m20),
  '21': digitsOnly(m21),
  '22': method22,
  '24': method24,
  '25': method25,
  '26': method26,
  '27': method27,
  '28': digitsOnly(m28),
  '29': digitsOnly(m29),
  '30': digitsOnly(m30),
  '31': digitsOnly(m31),
  '32': digitsOnly(m32),
  '33': digitsOnly(m33),
  '34': digitsOnly(m34),
  '38': digitsOnly(m38),
  '40': digitsOnly(m40),
  '41': method41,
  '42': digitsOnly(m42),
  '43': digitsOnly(m43),
  '44': digitsOnly(m44),
  '46': digitsOnly(m46),
  '47': digitsOnly(m47),
  '48': digitsOnly(m48),
  '49': digitsOnly((d) => m00(d) || m01(d)),
  '50': method50,
  '52': method52,
  '53': method53,
  '56': method56,
  '57': method57,
  '58': digitsOnly(m58),
  '59': method59,
  '60': digitsOnly(m60),
  '61': method61,
  '63': method63,
  '64': digitsOnly(m64),
  '65': method65,
  '67': digitsOnly(m67),
  '68': method68,
  '71': digitsOnly(m71),
  '74': method74,
  '75': method75,
  '76': method76,
  '78': method78,
  '88': method88,
  '91': method91,
  '92': digitsOnly(m92),
  '93': method93,
  '94': digitsOnly(m94),
  '95': method95,
  '96': method96,
  '98': method98,
  '99': method99,
  A2: digitsOnly((d) => m00(d) || m04(d)),
  A3: digitsOnly((d) => m00(d) || m10(d)),
  A4: methodA4,
  A5: methodA5,
  A6: methodA6,
  A7: digitsOnly((d) => m00(d) || m03(d)),
  A8: methodA8,
  B1: digitsOnly((d) => m05(d) || m01(d) || m00(d)),
  B2: digitsOnly((d) => (d[0]! <= 7 ? m02(d) : m00(d))),
  B3: digitsOnly((d) => (d[0] === 9 ? m06(d) : m32(d))),
  B5: methodB5,
  B6: methodB6,
  B7: methodB7,
  B8: methodB8,
  C0: methodC0,
  C1: methodC1,
  C2: (account) => method22(account) || m00(account.digits) || m04(account.digits),
  C3: methodC3,
  C5: methodC5,
  C7: methodC7,
  C8: digitsOnly((d) => m00(d) || m04(d) || m07(d)),
  C9: digitsOnly((d) => m00(d) || m07(d)),
  D0: methodD0,
  D2: methodD2,
  D6: methodD6,
  D7: methodD7,
  D8: methodD8,
  E0: methodE0,
  E3: digitsOnly((d) => m00(d) || m21(d)),
  E4: digitsOnly((d) => m02(d) || m00(d)),
};

/** The methods this module can decide. */
export const IMPLEMENTED_CHECK_DIGIT_METHODS: ReadonlySet<string> = new Set(Object.keys(METHODS));

/* ---------------------------------------------------------------- lookup */

let blzToMethod: Map<string, string> | undefined;

/** Build the flat map once, on first use, from the grouped table. */
function methodMap(): Map<string, string> {
  if (blzToMethod) return blzToMethod;
  const map = new Map<string, string>();
  for (const [method, codes] of Object.entries(BLZ_CHECK_DIGIT_METHODS)) {
    for (const code of codes.split(' ')) map.set(code, method);
  }
  blzToMethod = map;
  return map;
}

/** Every method a bank code in the shipped table actually names. */
export const LIVE_CHECK_DIGIT_METHODS: ReadonlySet<string> = new Set(
  Object.keys(BLZ_CHECK_DIGIT_METHODS),
);

/**
 * The check-digit method the Bundesbank assigned to a bank code, or
 * `undefined` when the code is not a German bank code in the shipped table.
 */
export function bankCodeMethod(blz: string): string | undefined {
  if (!/^[1-9]\d{7}$/u.test(blz)) return undefined;
  return methodMap().get(blz);
}

/** Whether the bank code appears in the Bundesbank directory. */
export const isKnownBankCode = (blz: string): boolean => bankCodeMethod(blz) !== undefined;

/**
 * Run one named method over an account number.
 *
 * Exported because the Bundesbank publishes its test numbers per *method*, not
 * per bank, and a test that had to find a bank for every method would be
 * testing the directory rather than the arithmetic.
 */
export function checkDigitValid(account: string, blz: string, method: string): boolean {
  const run = METHODS[method];
  if (!run) return false;
  if (!/^\d{1,10}$/u.test(account)) return false;

  const padded = account.padStart(10, '0');
  const digits = [...padded].map((c) => c.codePointAt(0)! - 48);
  const stripped = padded.replace(/^0+/u, '');

  return run({
    digits,
    length: stripped.length,
    blz,
    value: Number(padded),
  });
}

/**
 * Whether an account number and a bank code are arithmetically consistent.
 *
 * A `false` here is not proof that the pair is fake — an unknown bank code
 * returns `false` too, and the shipped directory is a snapshot. It is the
 * corroboration that licenses reporting an *unlabelled* pair, nothing more.
 */
export function isValidGermanAccountNumber(account: string, blz: string): boolean {
  if (!/^\d{1,10}$/u.test(account)) return false;
  // An all-zero account is a placeholder in every form that has one.
  if (Number(account) === 0) return false;

  const method = bankCodeMethod(blz);
  if (method === undefined) return false;

  return checkDigitValid(account, blz, method);
}
