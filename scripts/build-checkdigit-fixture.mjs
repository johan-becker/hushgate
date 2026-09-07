/**
 * Regenerate `test/fixtures/bundesbank-checkdigits.ts`.
 *
 * The fixture is the Bundesbank's own Testkontonummern, and this script is the
 * record of how they got out of a PDF and into TypeScript. It is expected to be
 * run about as often as the Bundesbank rewrites the specification, which since
 * 2018 is never — but a fixture whose provenance nobody can reproduce is a
 * fixture nobody can correct.
 *
 * WHAT IT NEEDS, and why each one:
 *
 *   1. The specification as text. Download "Prüfzifferberechnungsmethoden zur
 *      Prüfung von Kontonummern auf ihre Richtigkeit" from
 *      https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/pruefzifferberechnung/pruefzifferberechnung-fuer-kontonummern-603282
 *      and run `pdftotext -layout pruefzifferberechnungsmethoden.pdf spec.txt`.
 *      The `-layout` matters: the test numbers sit in a column, and without it
 *      they interleave with the worked examples beside them.
 *
 *   2. The bank code file, as `scripts/build-blz-methods.mjs` describes. Two
 *      methods (52 and 53, and B6 and C0 through them) read the bank code, so a
 *      case for those is only meaningful bound to a real one; and the fixture
 *      covers the methods a live bank code names, not all ~150.
 *
 *   3. An independent implementation of the same specification, to reconcile
 *      against. The spec labels its test numbers PER VARIANT — a number that is
 *      `falsch` under method 51's variant B is `richtig` under its variant C —
 *      and the aggregate verdict is what a validator has to return. A case is
 *      kept only where both sources agree, which drops exactly those per-variant
 *      labels and leaves every expectation with two sources behind it.
 *
 *      ibantools-germany (MIT OR MPL-2.0, no runtime dependencies) is what this
 *      was built against. It is NOT a dependency of hushgate and is not shipped;
 *      fetch it into a scratch directory for the run:
 *
 *        mkdir -p /tmp/pzref && cd /tmp/pzref && npm pack ibantools-germany
 *        tar xzf ibantools-germany-*.tgz
 *
 * Usage:
 *
 *   node scripts/build-checkdigit-fixture.mjs \
 *     spec.txt blz-aktuell.txt /tmp/pzref/package/dist/cjs/lib/method-dispatch.js
 *
 * The script prints what it kept and what it dropped. A dropped case is not a
 * failure — it is the per-variant labelling being filtered out — but a sudden
 * change in the count is worth reading before committing the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [specPath, blzPath, referencePath] = process.argv.slice(2);
if (!specPath || !blzPath || !referencePath) {
  console.error('usage: build-checkdigit-fixture.mjs <spec.txt> <blz.txt> <method-dispatch.js>');
  console.error('See the header of this file for where each one comes from.');
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { methodDispatch } = require(resolve(referencePath));

/* ------------------------------------------- which method each bank names */

const blzText = new TextDecoder('windows-1252').decode(readFileSync(blzPath));
const blzForMethod = new Map();
const liveMethods = new Set();
for (const line of blzText.split(/\r?\n/)) {
  if (line.length < 152 || line[8] !== '1') continue;
  const method = line.slice(150, 152);
  liveMethods.add(method);
  if (!blzForMethod.has(method)) blzForMethod.set(method, line.slice(0, 8));
}

/* ----------------------------------- the Testkontonummern, out of the PDF */

const lines = readFileSync(specPath, 'utf8').split('\n');
/** A section heading: the two-character method code in the left column. */
const HEADING = /^ {0,20}([0-9][0-9]|[A-E][0-9])(?: {2,}|\t)/;
/** A `noch 51` continuation page carries the code on a line of its own. */
const BARE_CODE = /^ {0,20}([0-9][0-9]|[A-E][0-9]) *$/;
const NUMBERS = /\b\d{4,12}\b/g;

const vectors = new Map();
const slot = (method) => {
  let entry = vectors.get(method);
  if (!entry) vectors.set(method, (entry = { richtig: new Set(), falsch: new Set() }));
  return entry;
};

let method = null;
let list = null;

for (const raw of lines) {
  const line = raw.replace(/\s+$/, '');
  if (!line || /^\s*(Seite \d+|Kennzeichen\b|DEUTSCHE BUNDESBANK)/.test(line)) {
    list = null;
    continue;
  }

  const heading = HEADING.exec(line) ?? BARE_CODE.exec(line);
  if (heading) {
    method = heading[1];
    list = null;
  }
  if (!method) continue;

  const lower = line.toLowerCase();
  const opensList = lower.includes('testkontonummer') || /^\s*(richtig|falsch)\s*:/.test(lower);

  if (opensList) {
    list = /richtig/.test(lower) ? 'richtig' : /falsch/.test(lower) ? 'falsch' : 'richtig';
    if (!line.includes(':')) continue; // `Testkontonummern` alone opens the list
  } else if (list) {
    // A continuation line is numbers and separators only. Anything else ends
    // the list, or the next paragraph's digits get swallowed.
    if (!/^[\s\d,.;)(-]+$/.test(line)) {
      list = null;
      continue;
    }
  } else {
    continue;
  }

  const tail = opensList ? line.slice(line.indexOf(':') + 1) : line;
  for (const number of tail.match(NUMBERS) ?? []) slot(method)[list].add(number);
}

/* ------------------------------------------------------------- reconcile */

/**
 * The two places the spec pins a test number to a bank code, because the method
 * reads it: C0 variant 1 and B6 variant 2, both ESER.
 */
const BOUND = {
  C0: { 43001500: '13051172', 48726458: '13051172', 82335729: '13051172', 29837521: '13051172' },
  B6: { 487310018: '80053782', 467310018: '80053762', 477310018: '80053772' },
};

const ACCEPT = new Set(['VALID', 'NO_CHECK_DIGIT_CALCULATION']);
const NO_OPINION = 'METHOD_NOT_IMPLEMENTED_NOT_IN_USE';

const official = {};
const dropped = [];
let officialCases = 0;

for (const [code, { richtig, falsch }] of [...vectors].toSorted()) {
  if (!blzForMethod.has(code)) continue; // not in live use: nothing to verify against
  const seen = new Set();
  const rows = [];

  const consider = (account, expected) => {
    if (seen.has(account)) return;
    seen.add(account);
    const blz = BOUND[code]?.[account] ?? blzForMethod.get(code);
    const status = methodDispatch(account, blz, code);
    if (status === NO_OPINION) return;
    if (ACCEPT.has(status) !== expected) {
      dropped.push({ code, account, spec: expected });
      return;
    }
    rows.push([account, blz, expected]);
    officialCases++;
  };

  for (const account of richtig) consider(account, true);
  for (const account of falsch) consider(account, false);
  if (rows.length > 0) official[code] = rows;
}

/* ------------------- one-sourced cases for the methods the spec is silent on */

// A fixed seed: the fixture must not change between runs of this script.
let seed = 20_260_907;
const next = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff) / 0x7f_ff_ff_ff);

const crossChecked = {};
for (const code of [...liveMethods].toSorted()) {
  if (official[code]) continue;
  const blz = blzForMethod.get(code);
  const valid = [];
  const invalid = [];
  for (let attempt = 0; attempt < 400_000 && (valid.length < 4 || invalid.length < 3); attempt++) {
    const length = 6 + Math.floor(next() * 5);
    let account = '';
    for (let digit = 0; digit < length; digit++) account += Math.floor(next() * 10);
    if (account.startsWith('0')) continue;
    const status = methodDispatch(account, blz, code);
    if (status === NO_OPINION) break;
    if (ACCEPT.has(status)) {
      if (valid.length < 4) valid.push(account);
    } else if (invalid.length < 3) invalid.push(account);
  }
  crossChecked[code] = [
    ...valid.map((account) => [account, blz, true]),
    ...invalid.map((account) => [account, blz, false]),
  ];
}

/* ------------------------------------------------------------------ write */

const block = (table) =>
  Object.keys(table)
    .toSorted()
    .map((code) => {
      const rows = table[code].map(([a, b, ok]) => `    ['${a}', '${b}', ${ok}],`).join('\n');
      return `  '${code}': [\n${rows}\n  ],`;
    })
    .join('\n');

const file = `/**
 * Official Bundesbank test account numbers, per check-digit method.
 *
 * GENERATED — see scripts/build-checkdigit-fixture.mjs. Do not hand-edit.
 *
 * Source: Deutsche Bundesbank, "Prüfzifferberechnungsmethoden zur Prüfung von
 * Kontonummern auf ihre Richtigkeit". Every case below is one the spec names
 * and an independent implementation of the same spec agrees on, so an
 * expectation here has two sources behind it, not one.
 *
 * \`[account, blz, valid]\`. The bank code matters for the ESER methods (52,
 * 53, B6 variant 2, C0 variant 1), which read it; for every other method it is
 * simply a live bank code that uses the method.
 */
export const BUNDESBANK_CHECK_DIGIT_CASES: Readonly<
  Record<string, readonly (readonly [string, string, boolean])[]>
> = {
${block(official)}
};

/**
 * Cases for the live methods the spec prints no test numbers for.
 *
 * ONE SOURCE, not two: these are accounts an independent implementation of the
 * same spec accepts or rejects, recorded so a change of behaviour shows up as
 * a red test. They pin the implementation; they do not prove the algorithm.
 * The bank code is a live one that uses the method.
 */
export const CROSS_CHECKED_CHECK_DIGIT_CASES: Readonly<
  Record<string, readonly (readonly [string, string, boolean])[]>
> = {
${block(crossChecked)}
};
`;

const target = join(root, 'test', 'fixtures', 'bundesbank-checkdigits.ts');
writeFileSync(target, file);

console.log(
  `${Object.keys(official).length} methods with official cases (${officialCases} cases), ` +
    `${Object.keys(crossChecked).length} methods cross-checked only`,
);
console.log(`${dropped.length} case(s) dropped where the two sources disagree:`);
for (const entry of dropped) {
  console.log(`  ${entry.code} ${entry.account} — spec says ${entry.spec ? 'richtig' : 'falsch'}`);
}
console.log(`wrote ${target}`);
