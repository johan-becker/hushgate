/**
 * Regenerate `src/detectors/blzmethods.ts` from the Bundesbank bank code file.
 *
 * The Bundesbank publishes the Bankleitzahlendatei quarterly, free of charge,
 * and field 9 of every record names the check-digit method that bank applies to
 * its account numbers. That field is the whole reason this script exists: an
 * account number cannot be checked without knowing which of the ~150 methods
 * its bank uses, and there is no way to derive that from the digits.
 *
 * Usage:
 *
 *   curl -o blz.txt "$(node scripts/build-blz-methods.mjs --url)"
 *   node scripts/build-blz-methods.mjs blz.txt
 *
 * The download link changes with every quarterly release. The stable page is
 * https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/bankleitzahlen/download-bankleitzahlen-602592
 * and the file wanted there is the uncompressed TXT ("Bankleitzahlendateien
 * ungepackt, Textformat").
 *
 * RECORD LAYOUT (Merkblatt Bankleitzahlendatei, appendix), 1-based:
 *
 *   1-8     Bankleitzahl
 *   9       Merkmal: 1 = payment service provider, 2 = branch of one
 *   10-67   Bezeichnung
 *   68-72   PLZ
 *   73-107  Ort
 *   108-134 Kurzbezeichnung
 *   135-139 Institutsnummer für PAN
 *   140-150 BIC
 *   151-152 Prüfzifferberechnungsmethode      <- the field this script wants
 *   153-158 Datensatznummer
 *   159     Änderungskennzeichen
 *   160     Bankleitzahllöschung
 *   161-168 Nachfolge-Bankleitzahl
 *
 * Only Merkmal 1 records carry a method; the branch records repeat their
 * institution's bank code. Bank codes flagged for deletion are KEPT: a code
 * retired last quarter still appears on invoices, contracts and archived mail,
 * and a detector that forgets it stops redacting exactly the documents a
 * customer is most likely to feed a model.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOWNLOAD_PAGE =
  'https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/serviceangebot/bankleitzahlen/download-bankleitzahlen-602592';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2];

if (process.argv.includes('--url') || !source) {
  console.error(`Pass the Bundesbank bank code file (TXT). Download page:\n${DOWNLOAD_PAGE}`);
  process.exit(source ? 0 : 1);
}

// The file is Windows-1252: German institution names carry umlauts, and reading
// it as UTF-8 turns them into replacement characters. Nothing this script keeps
// is affected, but a mis-decoded file is a sign the wrong download was taken.
const text = new TextDecoder('windows-1252').decode(readFileSync(source));

const byMethod = new Map();
let records = 0;
let institutions = 0;

for (const line of text.split(/\r?\n/)) {
  if (line.length < 152) continue;
  records++;
  if (line[8] !== '1') continue;

  const blz = line.slice(0, 8);
  const method = line.slice(150, 152);

  if (!/^\d{8}$/u.test(blz)) throw new Error(`bank code is not eight digits: ${blz}`);
  if (!/^[0-9A-E]\d$/u.test(method)) throw new Error(`method is not a method code: ${method}`);

  institutions++;
  let codes = byMethod.get(method);
  if (!codes) byMethod.set(method, (codes = []));
  codes.push(blz);
}

if (institutions < 3000) {
  throw new Error(`only ${institutions} institutions found — is this the right file?`);
}

const methods = [...byMethod.keys()].toSorted();
const entries = methods
  .map((method) => {
    const codes = byMethod.get(method).toSorted();
    const unique = [...new Set(codes)];
    if (unique.length !== codes.length) {
      throw new Error(`bank code listed twice under method ${method}`);
    }
    // Eight lines of codes per row keeps the generated file diffable: a quarter
    // that moves one bank changes one line, not the whole block.
    const rows = [];
    for (let i = 0; i < unique.length; i += 8) rows.push(unique.slice(i, i + 8).join(' '));
    return `  '${method}':\n${rows.map((r) => `    '${r}'`).join(' +\n')},`;
  })
  .join('\n');

const generated = `/**
 * Which check-digit method each German bank applies to its account numbers.
 *
 * GENERATED FROM THE BUNDESBANK BANK CODE FILE — do not hand-edit.
 * Regenerate with \`node scripts/build-blz-methods.mjs <blz-aktuell.txt>\`;
 * the Bundesbank republishes the file quarterly.
 *
 * Source: Deutsche Bundesbank, Bankleitzahlendatei, field 9
 * (Prüfzifferberechnungsmethode). Published free of charge at
 * ${DOWNLOAD_PAGE}
 *
 * Snapshot: ${institutions} institutions, ${methods.length} distinct methods.
 *
 * WHAT A STALE TABLE COSTS, since it will go stale: a bank code added after
 * this snapshot is not recognised, so an unlabelled account/bank-code pair from
 * that bank is not reported — a miss, never a false finding. A bank that
 * changed method makes its accounts fail the check digit, which is the same
 * miss. Both are recall, not precision, and both are fixed by rerunning the
 * script. Operators who cannot wait for a release pass their own table to
 * \`createBankAccountDetectors\`.
 *
 * Stored grouped by method rather than as a flat map: it is a third of the
 * size, it makes the file readable — every bank on one method sits together —
 * and the map that {@link bankCodeMethod} needs is built once, on first use.
 */
export const BLZ_CHECK_DIGIT_METHODS: Readonly<Record<string, string>> = {
${entries}
};
`;

const target = join(root, 'src', 'detectors', 'blzmethods.ts');
writeFileSync(target, generated);

console.log(`${records} records read, ${institutions} institutions kept, ${methods.length} methods`);
console.log(`wrote ${target}`);
