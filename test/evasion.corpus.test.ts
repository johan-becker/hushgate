import { describe, expect, it } from 'vitest';
import {
  createDetectors,
  detect,
  isValidGermanTaxId,
  isValidHealthInsuranceNumber,
  isValidIban,
  luhnValid,
} from '../src/detectors/index.js';

/**
 * The German evasion corpus: 299 spellings of personal data as a person who
 * does not want to be redacted would actually write them, run through the real
 * detector set.
 *
 * WHY THE TEST IS SHAPED THIS WAY. The obvious encoding — assert "195 of 299
 * caught" — is the one thing this file must not do. That number is meant to
 * rise, and a total pinned to it goes red on every improvement, which teaches
 * whoever sees the red to edit the number. A test that is routinely edited to
 * make it pass is a test that guarantees nothing.
 *
 * So the pin is the SET, not the count. {@link CAUGHT} names every case the
 * detectors find today. Each of them must stay found: that is the guarantee
 * with teeth, and it fails loudly, per case, under the German label a reader
 * would search for. A case OUTSIDE the set is unasserted, so newly closing a
 * gap can never turn this file red — it surfaces instead in the describe titles,
 * which carry the live count and the cases waiting to be pinned.
 *
 * {@link KNOWN_GAPS} is the other half, and the reason the file is worth
 * reading rather than just running: the cases hushgate cannot see yet, grouped,
 * each group with a sentence on what closing it would take. The only assertion
 * over it points one way — every uncaught case must be listed — so it stays
 * honest when a case is added and stays quiet when a case is fixed.
 *
 * The count is never written down as an expectation, only computed: the suite
 * titles report it, so `195 of 299 caught today` appears in the run without any
 * number in this file having to be maintained. It was 195 when the corpus moved
 * in; it is supposed to be higher by the time you read this.
 *
 * Non-ASCII is written as an escape throughout, as in
 * detectors.normalise.test.ts: half these cases differ from a caught sibling
 * only by an invisible code point, and a corpus of invisible attacks nobody can
 * see is not evidence of anything. The German labels are the index — they are
 * what someone scans to find out whether a gap they care about is known.
 */

/** `[group, label, text, want]`; `want === null` means any finding counts. */
type Case = readonly [string, string, string, string | null];

/**
 * The dictionary and the custom rule are configured to contain the fixtures, so
 * a miss here is always the detector failing, never an empty config.
 */
const detectors = createDetectors({
  dictionary: {
    names: ['Max Mustermann', 'Anna Schmidt'],
    terms: ['Projekt Nordlicht', 'Nordlicht', 'Musterfirma'],
  },
  custom: [{ name: 'customer id', pattern: 'CUST-\\d{6}' }],
});

const CASES: readonly Case[] = [
  ['Name', 'normal', 'Max Mustermann', 'NAME'],
  ['Name', 'komplett klein', 'max mustermann', 'NAME'],
  ['Name', 'komplett gross', 'MAX MUSTERMANN', 'NAME'],
  ['Name', 'Wechsel-Case', 'mAx MuStErMaNn', 'NAME'],
  ['Name', 'fehlender Buchstabe', 'Max Musterman', 'NAME'],
  ['Name', 'doppelter Buchstabe', 'Max Mustermannn', 'NAME'],
  ['Name', 'Luecke nach jedem Buchstaben', 'M a x  M u s t e r m a n n', 'NAME'],
  ['Name', 'NBSP', 'Max\u00A0Mustermann', 'NAME'],
  ['Name', 'Tab', 'Max\tMustermann', 'NAME'],
  ['Name', 'Zeilenumbruch', 'Max\nMustermann', 'NAME'],
  ['Name', 'umgedrehte Reihenfolge', 'Mustermann, Max', 'NAME'],
  ['Name', 'nur Initial', 'M. Mustermann', 'NAME'],
  ['Name', 'Homoglyph kyrillisch', '\u041C\u0430\u0445 \u041Custermann', 'NAME'],
  ['Name', 'Leetspeak', 'M4x Mu5t3rm4nn', 'NAME'],
  ['Name', 'Full-width', '\uFF2D\uFF41\uFF58\uFF2D\uFF55\uFF53\uFF54\uFF45\uFF52\uFF4D\uFF41\uFF4E\uFF4E', 'NAME'],
  ['Name', 'Zero-width Space', 'Max\u200BMustermann', 'NAME'],
  ['Name', 'Soft Hyphen', 'Ma\u00ADx Mustermann', 'NAME'],
  ['Name', 'NFD dekomponiert', 'Max Mu\u0308ller', 'NAME'],
  ['Name', 'Umlaut-Transliteration', 'Max Mueller', 'NAME'],

  ['DOB', 'normal DE', '03.05.1990', 'DATE_OF_BIRTH'],
  ['DOB', 'ISO', '1990-05-03', 'DATE_OF_BIRTH'],
  ['DOB', 'Slash', '03/05/1990', 'DATE_OF_BIRTH'],
  ['DOB', 'ohne fuehrende Nullen', '3.5.1990', 'DATE_OF_BIRTH'],
  ['DOB', 'Monat ausgeschrieben', '03. Mai 1990', 'DATE_OF_BIRTH'],
  ['DOB', 'komplett ausgeschrieben', 'dritter Mai neunzehnhundertneunzig', 'DATE_OF_BIRTH'],
  ['DOB', 'zweistelliges Jahr', 'geb. 03.05.90', 'DATE_OF_BIRTH'],
  ['DOB', 'Luecken um Trennzeichen', '03 . 05 . 1990', 'DATE_OF_BIRTH'],
  ['DOB', 'Full-width Ziffern', '\uFF10\uFF13.\uFF10\uFF15.\uFF11\uFF19\uFF19\uFF10', 'DATE_OF_BIRTH'],
  ['DOB', 'Homoglyph O statt 0', '03.O5.199O', 'DATE_OF_BIRTH'],

  ['Geburtsort', 'normal', 'Karlsruhe', null],
  ['Geburtsort', 'klein', 'karlsruhe', null],
  ['Geburtsort', 'im Satzkontext', 'geboren in Karlsruhe, Deutschland', null],
  ['Geburtsort', 'kyrillisches a', 'K\u0430rlsruhe', null],
  ['Geburtsort', 'Abkuerzung', 'Frankfurt a. M.', null],

  ['Nationalitaet', 'Adjektivform', 'deutsch', null],
  ['Nationalitaet', 'mit Label', 'Staatsangehoerigkeit: deutsch', null],
  ['Nationalitaet', 'nicht-deutsch', 'Staatsangehoerigkeit: tuerkisch', null],
  ['Nationalitaet', 'ISO-Code', 'DEU / DE', null],

  ['Geschlecht', 'normal', 'maennlich / weiblich / divers', null],
  ['Geschlecht', 'Kuerzel mit Label', 'Geschlecht: m', null],
  ['Geschlecht', 'NFD', 'ma\u0308nnlich', null],

  ['Steuer-ID', 'normal', '86091739453', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'amtliche Gruppierung', '860 917 394 53', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'andere Gruppierung', '86 091 739 453', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'Tab-getrennt', '860\t917\t394\t53', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'Punkt-getrennt', '860.917.394.53', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'mit Label', 'Steuer-ID: 86091739453', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'Slash', 'IdNr. 860/917/394/53', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'fuehrendes O', '86O91739453', 'GERMAN_TAX_ID'],
  ['Steuer-ID', 'Full-width', '\uFF18\uFF16\uFF10\uFF19\uFF11\uFF17\uFF13\uFF19\uFF14\uFF15\uFF13', 'GERMAN_TAX_ID'],

  ['Steuernummer', 'klassisch Slash', '27/123/45678', null],
  ['Steuernummer', 'Luecken', '27 123 45678', null],
  ['Steuernummer', 'ohne Trennzeichen', '2712345678', null],
  ['Steuernummer', 'bundeseinheitlich', '3012 0123 4567', null],
  ['Steuernummer', 'mit Label', 'St.-Nr. 27/123/45678', null],

  ['SV-Nummer', 'amtliche Gruppierung', '65 170839 J 003', null],
  ['SV-Nummer', 'ohne Luecken', '65170839J003', null],
  ['SV-Nummer', 'klein', '65170839j003', null],
  ['SV-Nummer', 'Bindestrich', '65-170839-J-003', null],
  ['SV-Nummer', 'mit Label', 'RV-Nr.: 65 170839 J 003', null],
  ['SV-Nummer', 'kyrillisches J', '65 170839 \u0408 003', null],

  ['KV-Nummer', 'normal', 'A123456780', null],
  ['KV-Nummer', 'klein', 'a123456780', null],
  ['KV-Nummer', 'Luecken', 'A 123 456 780', null],
  ['KV-Nummer', 'mit Label', 'KVNR: A123456780', null],
  ['KV-Nummer', 'kyrillisches A', '\u0410123456780', null],

  ['Personalausweis', 'normal', 'L01X00T47', null],
  ['Personalausweis', 'klein', 'l01x00t47', null],
  ['Personalausweis', 'mit Pruefziffer', 'L01X00T471', null],
  ['Personalausweis', 'mit Label', 'Ausweis-Nr. L01X00T47', null],
  ['Personalausweis', 'O statt 0', 'LO1XOOT47', null],

  ['Reisepass', 'normal', 'C01X00T47', null],
  ['Reisepass', 'mit Pruefziffer', 'C01X00T478', null],
  ['Reisepass', 'mit Label', 'Passnr.: C01X00T47', null],
  ['Reisepass', 'kyrillisches C', '\u0421 01X00T47', null],

  ['Fuehrerschein', 'normal', 'B072RRE2I55', null],
  ['Fuehrerschein', 'klein', 'b072rre2i55', null],
  ['Fuehrerschein', 'Luecken', 'B072 RRE2 I55', null],
  ['Fuehrerschein', 'mit Label', 'FS-Nr. B072RRE2I55', null],

  ['USt-IdNr', 'normal DE', 'DE123456789', null],
  ['USt-IdNr', 'Luecken', 'DE 123 456 789', null],
  ['USt-IdNr', 'klein', 'de123456789', null],
  ['USt-IdNr', 'mit Label', 'USt-IdNr.: DE123456789', null],
  ['USt-IdNr', 'AT-Format', 'ATU12345678', null],
  ['USt-IdNr', 'NL-Format', 'NL123456789B01', null],

  ['Handelsregister', 'normal', 'HRB 123456', null],
  ['Handelsregister', 'ohne Luecke', 'HRB123456', null],
  ['Handelsregister', 'mit Gerichtskontext', 'Amtsgericht Karlsruhe HRB 123456', null],
  ['Handelsregister', 'HRA', 'HRA 12345', null],

  ['Kfz-Kennzeichen', 'normal', 'KA-XY 1234', null],
  ['Kfz-Kennzeichen', 'Luecke', 'KA XY 1234', null],
  ['Kfz-Kennzeichen', 'ohne Trennzeichen', 'KAXY1234', null],
  ['Kfz-Kennzeichen', 'klein', 'ka-xy 1234', null],
  ['Kfz-Kennzeichen', 'E-Kennzeichen', 'B-AB 123E', null],
  ['Kfz-Kennzeichen', 'NB-Hyphen', 'KA\u2011XY 1234', null],

  ['Email', 'normal', 'max.mustermann@example.com', 'EMAIL'],
  ['Email', 'gemischte Schreibung', 'Max.Mustermann@Example.COM', 'EMAIL'],
  ['Email', 'Luecken um @', 'max.mustermann @ example.com', 'EMAIL'],
  ['Email', 'ausgeschriebene Obfuskation', 'max.mustermann(at)example(dot)com', 'EMAIL'],
  ['Email', 'Klammer-Variante', 'max.mustermann [at] example [dot] com', 'EMAIL'],
  ['Email', 'Luecke vor TLD', 'max.mustermann@example .com', 'EMAIL'],
  ['Email', 'Zero-width Space', 'max\u200B.mustermann@example.com', 'EMAIL'],
  ['Email', 'kyrillisches a Domain', 'max.mustermann@ex\u0430mple.com', 'EMAIL'],
  ['Email', 'Full-width', '\uFF4D\uFF41\uFF58@\uFF45\uFF58\uFF41\uFF4D\uFF50\uFF4C\uFF45.\uFF43\uFF4F\uFF4D', 'EMAIL'],
  ['Email', 'mit Schema', 'mailto:max.mustermann@example.com', 'EMAIL'],
  ['Email', 'quoted local part', '"max mustermann"@example.com', 'EMAIL'],

  ['Email non-ASCII', 'Umlaut', 'm\u00FCller@example.com', 'EMAIL'],
  ['Email non-ASCII', 'NFD', 'mu\u0308ller@example.com', 'EMAIL'],
  ['Email non-ASCII', 'Akzente', 'Jos\u00E9.Garc\u00EDa@example.com', 'EMAIL'],
  ['Email non-ASCII', 'kyrillisch', '\u0432\u043B\u0430\u0434\u0438\u043C\u0438\u0440@example.com', 'EMAIL'],
  ['Email non-ASCII', 'CJK', '\u6D4B\u8BD5@example.com', 'EMAIL'],
  ['Email non-ASCII', 'IDN beidseitig', 'm\u00FCller@m\u00FCller.de', 'EMAIL'],
  ['Email non-ASCII', 'Punycode', 'xn--mller-kva@example.com', 'EMAIL'],

  ['Phone DE', 'normal international', '+49 721 1234567', 'PHONE'],
  ['Phone DE', 'Luecke fehlt', '+49721 1234567', 'PHONE'],
  ['Phone DE', 'Bindestrich', '+49-721-1234567', 'PHONE'],
  ['Phone DE', '00-Praefix', '0049 721 1234567', 'PHONE'],
  ['Phone DE', 'national', '0721 1234567', 'PHONE'],
  ['Phone DE', 'Slash', '0721/1234567', 'PHONE'],
  ['Phone DE', 'Klammern', '(0721) 1234567', 'PHONE'],
  ['Phone DE', 'Null in Klammern', '+49 (0) 721 1234567', 'PHONE'],
  ['Phone DE', 'NBSP', '+49\u00A0721\u00A01234567', 'PHONE'],
  ['Phone DE', 'unregelmaessige Gruppierung', '+49 721 12 34 5 67', 'PHONE'],
  ['Phone DE', 'Full-width', '+\uFF14\uFF19 \uFF17\uFF12\uFF11 \uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17', 'PHONE'],
  ['Phone DE', 'ausgeschriebenes Plus', 'plus49 721 1234567', 'PHONE'],

  ['Phone US', 'normal', '(555) 123-4567', 'PHONE'],
  ['Phone US', 'Bindestrich', '555-123-4567', 'PHONE'],
  ['Phone US', 'Punkt-getrennt', '555.123.4567', 'PHONE'],
  ['Phone US', 'ohne Trennzeichen', '5551234567', 'PHONE'],
  ['Phone US', 'international', '+1 555 123 4567', 'PHONE'],
  ['Phone US', 'Vanity', '1-800-FLOWERS', 'PHONE'],

  ['Adresse', 'normal', 'Kaiserstra\u00DFe 12, 76133 Karlsruhe', null],
  ['Adresse', 'abgekuerzt', 'Kaiserstr. 12, 76133 Karlsruhe', null],
  ['Adresse', 'ss statt sz', 'Kaiserstrasse 12', null],
  ['Adresse', 'mehrzeilig', 'Kaiserstra\u00DFe 12\n76133 Karlsruhe', null],
  ['Adresse', 'Hausnummernzusatz', 'Kaiserstra\u00DFe 12a', null],
  ['Adresse', 'EN-Reihenfolge', '12 Kaiserstra\u00DFe', null],

  ['PLZ', 'normal', '76133', null],
  ['PLZ', 'Laenderpraefix', 'D-76133', null],
  ['PLZ', 'ISO-Praefix', 'DE-76133', null],
  ['PLZ', 'mit Label', 'PLZ 76133', null],

  ['IBAN', 'normal 4er-Gruppen', 'DE89 3704 0044 0532 0130 00', 'IBAN'],
  ['IBAN', 'ohne Luecken', 'DE89370400440532013000', 'IBAN'],
  ['IBAN', 'lowercase', 'de89 3704 0044 0532 0130 00', 'IBAN'],
  ['IBAN', 'gemischt', 'De89370400440532013000', 'IBAN'],
  ['IBAN', 'Tab-getrennt', 'DE89\t3704\t0044\t0532\t0130\t00', 'IBAN'],
  ['IBAN', 'Punkt-getrennt', 'DE89.3704.0044.0532.0130.00', 'IBAN'],
  ['IBAN', 'Bindestrich', 'DE89-3704-0044-0532-0130-00', 'IBAN'],
  ['IBAN', '2er-Gruppen', 'DE89 37 04 00 44 05 32 01 30 00', 'IBAN'],
  ['IBAN', 'NBSP', 'DE89\u00A03704\u00A00044\u00A00532\u00A00130\u00A000', 'IBAN'],
  ['IBAN', 'mit Label', 'IBAN: DE89 3704 0044 0532 0130 00', 'IBAN'],
  ['IBAN', 'kyrillisches E', 'D\u041589 3704 0044 0532 0130 00', 'IBAN'],
  ['IBAN', 'Full-width', '\uFF24\uFF25\uFF18\uFF19\uFF13\uFF17\uFF10\uFF14\uFF10\uFF10\uFF14\uFF14\uFF10\uFF15\uFF13\uFF12\uFF10\uFF11\uFF13\uFF10\uFF10\uFF10', 'IBAN'],
  ['IBAN', 'AT', 'AT61 1904 3002 3457 3201', 'IBAN'],
  ['IBAN', 'CH', 'CH93 0076 2011 6238 5295 7', 'IBAN'],
  ['IBAN', 'NL mit Buchstaben', 'NL91 ABNA 0417 1643 00', 'IBAN'],

  ['BIC', 'normal 11', 'COBADEFFXXX', null],
  ['BIC', '8-stellig', 'COBADEFF', null],
  ['BIC', 'klein', 'cobadeffxxx', null],
  ['BIC', 'Luecken', 'COBA DE FF XXX', null],
  ['BIC', 'mit Label', 'BIC: GENODEF1M04', null],

  ['Kreditkarte', 'normal', '4111 1111 1111 1111', 'CREDIT_CARD'],
  ['Kreditkarte', 'ohne Luecken', '4111111111111111', 'CREDIT_CARD'],
  ['Kreditkarte', 'Bindestrich', '4111-1111-1111-1111', 'CREDIT_CARD'],
  ['Kreditkarte', 'Punkt-getrennt', '4111.1111.1111.1111', 'CREDIT_CARD'],
  ['Kreditkarte', 'Tab-getrennt', '4111\t1111\t1111\t1111', 'CREDIT_CARD'],
  ['Kreditkarte', 'Underscore', '4111_1111_1111_1111', 'CREDIT_CARD'],
  ['Kreditkarte', 'mit Ablauf und CVV', '4111 1111 1111 1111 | 12/28 | 123', 'CREDIT_CARD'],
  ['Kreditkarte', 'Mastercard', '5555 5555 5555 4444', 'CREDIT_CARD'],
  ['Kreditkarte', 'Amex', '3782 822463 10005', 'CREDIT_CARD'],
  ['Kreditkarte', 'Full-width', '\uFF14\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11', 'CREDIT_CARD'],
  ['Kreditkarte', 'Zero-width', '4111\u200B1111\u200B1111\u200B1111', 'CREDIT_CARD'],
  ['Kreditkarte', '2er-Gruppen', '41 11 11 11 11 11 11 11', 'CREDIT_CARD'],

  ['Konto/BLZ', 'DE alt mit Labels', 'Kto. 532013000, BLZ 37040044', null],
  ['Konto/BLZ', 'Slash', '532013000 / 37040044', null],
  ['Konto/BLZ', 'UK Sort Code', '53-20-13 12345678', null],
  ['Konto/BLZ', 'US ABA', 'Routing 021000021, Account 1234567890', null],

  ['IPv4', 'normal', '192.0.2.1', 'IPV4'],
  ['IPv4', 'fuehrende Nullen', '192.0.2.001', 'IPV4'],
  ['IPv4', 'Luecken', '192 . 0 . 2 . 1', 'IPV4'],
  ['IPv4', 'defanged', '192[.]0[.]2[.]1', 'IPV4'],
  ['IPv4', 'ausgeschrieben', '192(dot)0(dot)2(dot)1', 'IPV4'],
  ['IPv4', 'dezimal', '3221225985', 'IPV4'],
  ['IPv4', 'hex', '0xC0000201', 'IPV4'],
  ['IPv4', 'mit Port', '192.0.2.1:8080', 'IPV4'],
  ['IPv4', 'Full-width', '\uFF11\uFF19\uFF12.\uFF10.\uFF12.\uFF11', 'IPV4'],

  ['IPv6', 'ausgeschrieben', '2001:0db8:0000:0000:0000:0000:0000:0001', 'IPV6'],
  ['IPv6', 'komprimiert', '2001:db8::1', 'IPV6'],
  ['IPv6', 'Hex gross', '2001:DB8::1', 'IPV6'],
  ['IPv6', 'mit Port', '[2001:db8::1]:8080', 'IPV6'],
  ['IPv6', 'IPv4-mapped', '2001:db8::192.0.2.1', 'IPV6'],
  ['IPv6', 'Luecken', '2001 : db8 :: 1', 'IPV6'],

  ['MAC', 'Doppelpunkt', '00:1A:2B:3C:4D:5E', 'MAC'],
  ['MAC', 'Bindestrich', '00-1A-2B-3C-4D-5E', 'MAC'],
  ['MAC', 'Cisco', '001A.2B3C.4D5E', 'MAC'],
  ['MAC', 'ohne Trennzeichen', '001A2B3C4D5E', 'MAC'],
  ['MAC', 'klein', '00:1a:2b:3c:4d:5e', 'MAC'],
  ['MAC', 'Luecken', '00 : 1A : 2B : 3C : 4D : 5E', 'MAC'],

  ['URL creds', 'normal', 'https://user:pass@example.com', 'URL_CREDENTIALS'],
  ['URL creds', 'gross', 'https://USER:PASS@example.com', 'URL_CREDENTIALS'],
  ['URL creds', 'postgres', 'postgres://admin:s3cr3t@db.internal:5432/prod', 'URL_CREDENTIALS'],
  ['URL creds', 'mongodb+srv', 'mongodb+srv://user:pw@cluster.example.net', 'URL_CREDENTIALS'],
  ['URL creds', 'ftp', 'ftp://user:pass@example.com', 'URL_CREDENTIALS'],
  ['URL creds', 'URL-encoded', 'https://user:p%40ss@example.com', 'URL_CREDENTIALS'],
  ['URL creds', 'Luecke vor @', 'https://user:pass @example.com', 'URL_CREDENTIALS'],
  ['URL creds', 'leerer User', 'redis://:passwordonly@example.com:6379', 'URL_CREDENTIALS'],

  ['Secrets', 'OpenAI-Stil', 'sk-proj-AbCdEf1234567890AbCdEf1234567890', 'SECRET'],
  ['Secrets', 'Anthropic-Stil', 'sk-ant-api03-AbCdEf1234567890', 'SECRET'],
  ['Secrets', 'GitHub PAT', 'ghp_AbCdEf1234567890AbCdEf1234567890', 'SECRET'],
  ['Secrets', 'AWS Access Key', 'AKIAIOSFODNN7EXAMPLE', 'SECRET'],
  ['Secrets', 'Slack Bot Token', 'xoxb-123456789012-abcdefghijklmno', 'SECRET'],
  ['Secrets', 'in Code-Zeile', 'API_KEY = "sk-proj-AbCdEf1234567890"', 'SECRET'],
  ['Secrets', 'ueber Zeilenumbruch', 'API_KEY: sk-proj-\n AbCdEf1234567890', 'SECRET'],
  ['Secrets', 'Luecke im Key', 'sk-proj-AbCdEf 1234567890', 'SECRET'],
  ['Secrets', 'base64-kodiert', 'c2stcHJvai1BYkNkRWY=', 'SECRET'],

  ['JWT', 'normal', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'SECRET'],
  ['JWT', 'mit Bearer', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.abc', 'SECRET'],
  ['JWT', 'im Header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.abc', 'SECRET'],
  ['JWT', 'ueber drei Zeilen', 'eyJhbGciOiJIUzI1NiJ9.\neyJzdWIiOiIxMjM0NSJ9.\nabc', 'SECRET'],
  ['JWT', 'Luecken um Punkte', 'eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiIxMjM0NSJ9 . abc', 'SECRET'],

  ['Private key', 'PEM RSA', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', 'SECRET'],
  ['Private key', 'OPENSSH', '-----BEGIN OPENSSH PRIVATE KEY-----', 'SECRET'],
  ['Private key', 'EC', '-----BEGIN EC PRIVATE KEY-----', 'SECRET'],
  ['Private key', 'ENCRYPTED', '-----BEGIN ENCRYPTED PRIVATE KEY-----', 'SECRET'],
  ['Private key', 'Luecken im Header', '----- BEGIN RSA PRIVATE KEY -----', 'SECRET'],
  ['Private key', 'klein', '-----begin rsa private key-----', 'SECRET'],

  ['Session token', 'normal', 'sessionid=abc123def456ghi789', null],
  ['Session token', 'voller Header', 'Cookie: JSESSIONID=A1B2C3D4E5F6; Path=/', null],
  ['Session token', 'Set-Cookie', 'Set-Cookie: session=xyz789; HttpOnly; Secure', null],
  ['Session token', 'PHP', 'PHPSESSID=abc123def456', null],
  ['Session token', 'CSRF', 'csrftoken=Kj8sd9Fj2kL0', null],

  ['IMEI', 'normal', '490154203237518', null],
  ['IMEI', 'amtliche Gruppierung', '49-015420-323751-8', null],
  ['IMEI', 'Luecken', '49 015420 323751 8', null],
  ['IMEI', 'mit Label', 'IMEI: 490154203237518', null],
  ['IMEI', 'UUID', '550e8400-e29b-41d4-a716-446655440000', null],
  ['IMEI', 'IDFA-Stil', 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890', null],

  ['ICD', 'normal', 'E11.9', null],
  ['ICD', 'Luecke', 'E 11.9', null],
  ['ICD', 'mit Diagnosesicherheit', 'E11.9 G', null],
  ['ICD', 'ohne Punkt', 'E119', null],
  ['ICD', 'mit Label', 'ICD-10: F32.1', null],
  ['ICD', 'Klartext', 'Diagnose: Diabetes mellitus Typ 2', null],
  ['ICD', 'Klartext unsicher', 'Verdacht auf Depression', null],

  ['Medikation', 'mit Dosierung', 'Metformin 850 mg 1-0-1', null],
  ['Medikation', 'ohne Luecken', 'Metformin850mg', null],
  ['Medikation', 'gross', 'METFORMIN', null],
  ['Medikation', 'Liste', 'Ramipril 5 mg, Sertralin 50 mg', null],
  ['Medikation', 'Wirkstoff + Handelsname', 'Metformin (Glucophage)', null],

  ['Herkunft', 'normal', 'tuerkischer Herkunft', null],
  ['Herkunft', 'mit Label', 'Migrationshintergrund: tuerkisch', null],
  ['Herkunft', 'NFD', 'tu\u0308rkischer Herkunft', null],

  ['Politik', 'Partei', 'Mitglied der SPD', null],
  ['Politik', 'Kompositum', 'SPD-Mitglied seit 2015', null],
  ['Politik', 'Wahlverhalten', 'waehlt Gruene', null],
  ['Politik', 'Punkt-getrennt', 'S.P.D.', null],
  ['Politik', 'ausgeschrieben', 'Mitglied der Sozialdemokratischen Partei', null],

  ['Religion', 'normal', 'roemisch-katholisch', null],
  ['Religion', 'Lohnsteuer-Kuerzel', 'rk / ev', null],
  ['Religion', 'mit Label', 'Konfession: evangelisch', null],
  ['Religion', 'Negativwert', 'konfessionslos', null],

  ['Gewerkschaft', 'normal', 'Mitglied bei ver.di', null],
  ['Gewerkschaft', 'ohne Punkt', 'verdi-Mitglied', null],
  ['Gewerkschaft', 'mit Nummer', 'IG Metall Mitgliedsnr. 1234567', null],
  ['Gewerkschaft', 'indirekt', 'Gewerkschaftsbeitrag: 25,00 EUR', null],

  ['Biometrie', 'base64-Template', 'Fingerabdruck-Template: base64:iVBORw0KGgoAAAANSUhEUg', null],
  ['Biometrie', 'Vektor', 'face_embedding: [0.234, -0.891, 0.445]', null],
  ['Biometrie', 'inline Bild', '<img src="data:image/jpeg;base64,/9j/4AAQ">', null],
  ['Biometrie', 'Referenz-ID', 'Iris-Scan-ID: BIO-7734-XK', null],

  ['Orientierung', 'normal', 'homosexuell', null],
  ['Orientierung', 'mit Label', 'Orientierung: bisexuell', null],
  ['Orientierung', 'Soft Hyphen', 'homo\u00ADsexuell', null],
  ['Orientierung', 'Leetspeak', 'h0m0s3xu3ll', null],
  ['Orientierung', 'indirekt', 'lebt in eingetragener Lebenspartnerschaft mit Herrn X', null],

  ['Dictionary', 'normal', 'Projekt Nordlicht', 'TERM'],
  ['Dictionary', 'klein', 'projekt nordlicht', 'TERM'],
  ['Dictionary', 'gross', 'PROJEKT NORDLICHT', 'TERM'],
  ['Dictionary', 'Bindestrich', 'Projekt-Nordlicht', 'TERM'],
  ['Dictionary', 'CamelCase', 'ProjektNordlicht', 'TERM'],
  ['Dictionary', 'nur Codename', 'Nordlicht', 'TERM'],
  ['Dictionary', 'fehlender Buchstabe', 'Nordlich', 'TERM'],
  ['Dictionary', 'gesperrt', 'N o r d l i c h t', 'TERM'],
  ['Dictionary', 'Zero-width', 'Nordlicht\u200BGmbH', 'TERM'],
  ['Dictionary', 'kyrillisches o', 'N\u043Erdlicht', 'TERM'],
  ['Dictionary', 'Rechtsform-Suffix', 'Musterfirma GmbH & Co. KG', 'TERM'],

  ['Custom regex', 'normal', 'CUST-000123', 'CUSTOMER_ID'],
  ['Custom regex', 'Luecke', 'CUST 000123', 'CUSTOMER_ID'],
  ['Custom regex', 'klein', 'cust-000123', 'CUSTOMER_ID'],
  ['Custom regex', 'ohne fuehrende Nullen', 'CUST-123', 'CUSTOMER_ID'],
  ['Custom regex', 'Underscore', 'CUST_000123', 'CUSTOMER_ID'],
  ['Custom regex', 'O statt 0', 'CUST-00O123', 'CUSTOMER_ID'],

  ['Kombination', 'lowercase + Zero-width', 'de89\u200B3704 0044 0532 0130 00', 'IBAN'],
  ['Kombination', 'Tab + Punkt + Space', '4111\t1111.1111 1111', 'CREDIT_CARD'],
  ['Kombination', 'drei kyrillische a', 'm\u0430x.musterm\u0430nn@ex\u0430mple.com', 'EMAIL'],
  ['Kombination', 'Full-width + Ideographic Space', '\uFF2D\uFF21\uFF38\u3000\uFF2D\uFF35\uFF33\uFF34\uFF25\uFF32\uFF2D\uFF21\uFF2E\uFF2E', 'NAME'],
  ['Kombination', 'NFD + Leet + umgedreht', 'Mu\u0308ller, M4x', 'NAME'],
  ['Kombination', 'Full-width + NBSP', '+\uFF14\uFF19\u00A0\uFF17\uFF12\uFF11\u00A0\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16\uFF17', 'PHONE'],
  ['Kombination', 'Soft Hyphen + lower + Tab', 'IBAN\u00AD: de89\t3704\t0044\t0532\t0130\t00', 'IBAN'],
  ['Kombination', 'Label + Zeilenumbrueche', 'Steuer-ID:\n860\n917\n394\n53', 'GERMAN_TAX_ID'],
];

/**
 * The cases hushgate finds today, as `group | label`.
 *
 * This is the pin. Every key here must still be found on every run; nothing
 * else in this file constrains the detectors at all. Adding a key is how a
 * closed gap gets locked in — and the tally at the bottom names the candidates.
 */
const CAUGHT: ReadonlySet<string> = new Set([
  'Name | normal',
  'Name | komplett klein',
  'Name | komplett gross',
  'Name | Wechsel-Case',
  'Name | NBSP',
  'Name | Homoglyph kyrillisch',
  'Name | Full-width',
  'Name | Zero-width Space',
  'Name | Soft Hyphen',
  'DOB | normal DE',
  'DOB | ISO',
  'DOB | ohne fuehrende Nullen',
  'DOB | Full-width Ziffern',
  'Steuer-ID | normal',
  'Steuer-ID | amtliche Gruppierung',
  'Steuer-ID | andere Gruppierung',
  'Steuer-ID | Tab-getrennt',
  'Steuer-ID | Punkt-getrennt',
  'Steuer-ID | mit Label',
  'Steuer-ID | Slash',
  'Steuer-ID | Full-width',
  'Steuernummer | klassisch Slash',
  'Steuernummer | mit Label',
  'SV-Nummer | amtliche Gruppierung',
  'SV-Nummer | ohne Luecken',
  'SV-Nummer | klein',
  'SV-Nummer | Bindestrich',
  'SV-Nummer | mit Label',
  'SV-Nummer | kyrillisches J',
  'KV-Nummer | normal',
  'KV-Nummer | klein',
  'KV-Nummer | Luecken',
  'KV-Nummer | mit Label',
  'KV-Nummer | kyrillisches A',
  'Personalausweis | mit Pruefziffer',
  'Personalausweis | mit Label',
  'Reisepass | mit Pruefziffer',
  'Reisepass | mit Label',
  'Fuehrerschein | mit Label',
  'USt-IdNr | normal DE',
  'USt-IdNr | Luecken',
  'USt-IdNr | klein',
  'USt-IdNr | mit Label',
  'USt-IdNr | AT-Format',
  'USt-IdNr | NL-Format',
  'Handelsregister | normal',
  'Handelsregister | ohne Luecke',
  'Handelsregister | mit Gerichtskontext',
  'Handelsregister | HRA',
  'Kfz-Kennzeichen | normal',
  'Kfz-Kennzeichen | Luecke',
  'Kfz-Kennzeichen | klein',
  'Kfz-Kennzeichen | E-Kennzeichen',
  'Kfz-Kennzeichen | NB-Hyphen',
  'Email | normal',
  'Email | gemischte Schreibung',
  'Email | Luecken um @',
  'Email | Luecke vor TLD',
  'Email | Zero-width Space',
  'Email | kyrillisches a Domain',
  'Email | Full-width',
  'Email | mit Schema',
  'Email | quoted local part',
  'Email non-ASCII | Umlaut',
  'Email non-ASCII | NFD',
  'Email non-ASCII | Akzente',
  'Email non-ASCII | kyrillisch',
  'Email non-ASCII | CJK',
  'Email non-ASCII | IDN beidseitig',
  'Email non-ASCII | Punycode',
  'Phone DE | normal international',
  'Phone DE | Luecke fehlt',
  'Phone DE | Bindestrich',
  'Phone DE | 00-Praefix',
  'Phone DE | national',
  'Phone DE | Slash',
  'Phone DE | Klammern',
  'Phone DE | Null in Klammern',
  'Phone DE | NBSP',
  'Phone DE | unregelmaessige Gruppierung',
  'Phone DE | Full-width',
  'Phone US | normal',
  'Phone US | Bindestrich',
  'Phone US | Punkt-getrennt',
  'Phone US | international',
  'Phone US | Vanity',
  'Adresse | normal',
  'Adresse | abgekuerzt',
  'Adresse | ss statt sz',
  'Adresse | mehrzeilig',
  'Adresse | Hausnummernzusatz',
  'PLZ | Laenderpraefix',
  'PLZ | ISO-Praefix',
  'PLZ | mit Label',
  'Konto/BLZ | DE alt mit Labels',
  'Konto/BLZ | Slash',
  'Konto/BLZ | UK Sort Code',
  'Konto/BLZ | US ABA',
  'IBAN | normal 4er-Gruppen',
  'IBAN | ohne Luecken',
  'IBAN | lowercase',
  'IBAN | gemischt',
  'IBAN | Tab-getrennt',
  'IBAN | Punkt-getrennt',
  'IBAN | Bindestrich',
  'IBAN | 2er-Gruppen',
  'IBAN | NBSP',
  'IBAN | mit Label',
  'IBAN | Full-width',
  'IBAN | AT',
  'IBAN | CH',
  'IBAN | NL mit Buchstaben',
  'IBAN | kyrillisches E',
  'BIC | normal 11',
  'BIC | 8-stellig',
  'BIC | klein',
  'BIC | Luecken',
  'BIC | mit Label',
  'Kreditkarte | normal',
  'Kreditkarte | ohne Luecken',
  'Kreditkarte | Bindestrich',
  'Kreditkarte | Punkt-getrennt',
  'Kreditkarte | Tab-getrennt',
  'Kreditkarte | Underscore',
  'Kreditkarte | mit Ablauf und CVV',
  'Kreditkarte | Mastercard',
  'Kreditkarte | Amex',
  'Kreditkarte | Full-width',
  'Kreditkarte | Zero-width',
  'Kreditkarte | 2er-Gruppen',
  'IPv4 | normal',
  'IPv4 | mit Port',
  'IPv4 | Full-width',
  'IPv6 | ausgeschrieben',
  'IPv6 | komprimiert',
  'IPv6 | Hex gross',
  'IPv6 | mit Port',
  'IPv6 | IPv4-mapped',
  'MAC | Doppelpunkt',
  'MAC | Bindestrich',
  'MAC | Cisco',
  'MAC | klein',
  'URL creds | normal',
  'URL creds | gross',
  'URL creds | postgres',
  'URL creds | mongodb+srv',
  'URL creds | ftp',
  'URL creds | URL-encoded',
  'Secrets | OpenAI-Stil',
  'Secrets | Anthropic-Stil',
  'Secrets | AWS Access Key',
  'Secrets | Slack Bot Token',
  'Secrets | in Code-Zeile',
  'JWT | normal',
  'JWT | mit Bearer',
  'JWT | im Header',
  'Private key | PEM RSA',
  'Private key | OPENSSH',
  'Private key | EC',
  'Private key | ENCRYPTED',
  'Private key | Luecken im Header',
  'Private key | klein',
  'Session token | normal',
  'Session token | voller Header',
  'Session token | Set-Cookie',
  'Session token | PHP',
  'Session token | CSRF',
  'IMEI | normal',
  'IMEI | amtliche Gruppierung',
  'IMEI | Luecken',
  'IMEI | mit Label',
  'IMEI | UUID',
  'IMEI | IDFA-Stil',
  'ICD | normal',
  'ICD | Luecke',
  'ICD | mit Diagnosesicherheit',
  'ICD | mit Label',
  'Medikation | mit Dosierung',
  'Medikation | ohne Luecken',
  'Medikation | gross',
  'Medikation | Liste',
  'Medikation | Wirkstoff + Handelsname',
  'Dictionary | normal',
  'Dictionary | klein',
  'Dictionary | gross',
  'Dictionary | Bindestrich',
  'Dictionary | CamelCase',
  'Dictionary | nur Codename',
  'Dictionary | gesperrt',
  'Dictionary | Zero-width',
  'Dictionary | kyrillisches o',
  'Dictionary | Rechtsform-Suffix',
  'Custom regex | normal',
  'Kombination | lowercase + Zero-width',
  'Kombination | Tab + Punkt + Space',
  'Kombination | drei kyrillische a',
  'Kombination | Full-width + Ideographic Space',
  'Kombination | Full-width + NBSP',
  'Kombination | Soft Hyphen + lower + Tab',
  'Kombination | Label + Zeilenumbrueche',
]);

/**
 * The other 104: what hushgate cannot see yet, grouped, with what closing each
 * group would cost. Nothing here is asserted to stay a gap — a case that starts
 * being found must not turn this file red — so the list is documentation with
 * exactly one obligation attached: every uncaught case has to appear in it, or
 * the completeness test says so.
 */
const KNOWN_GAPS: Readonly<Record<string, readonly string[]>> = {
  // Typos, leet, a surname written first and a bare initial all want the
  // dictionary's fuzzy pass, which is opt-in because it walks the entry list
  // per candidate token; the tab, the newline and the letter-spaced phrase want
  // the shredding collapse extended from one word to a multi-word entry. Two of
  // these ten name Max Mueller, who is not in the fixture dictionary at all:
  // unwinnable under this config, not a detector miss.
  Name: [
    'fehlender Buchstabe',
    'doppelter Buchstabe',
    'Luecke nach jedem Buchstaben',
    'Tab',
    'Zeilenumbruch',
    'umgedrehte Reihenfolge',
    'nur Initial',
    'Leetspeak',
    'NFD dekomponiert',
    'Umlaut-Transliteration',
  ],

  // Dotted German and ISO dates are read; the slash form, a two-digit year and
  // spaced separators are further surface forms of the same pattern, and cheap.
  // The written-out month and the fully spelled date need a German date parser,
  // and 'O' for zero needs the digit-shaped-letter fold described under
  // Steuer-ID.
  DOB: [
    'Slash',
    'Monat ausgeschrieben',
    'komplett ausgeschrieben',
    'zweistelliges Jahr',
    'Luecken um Trennzeichen',
    'Homoglyph O statt 0',
  ],

  // There is no place-name detector: place names only ever enter as the oracle
  // that licenses a postcode. Closing this means a gazetteer plus a birth
  // context ('geboren in'), because a bare city name in prose is not a finding
  // anybody wants.
  Geburtsort: ['normal', 'klein', 'im Satzkontext', 'kyrillisches a', 'Abkuerzung'],

  // No nationality detector. It would be a lexicon of nationality adjectives
  // and ISO country codes gated on a label, since 'deutsch' unaccompanied is an
  // ordinary German adjective and would fire on half of every document.
  Nationalitaet: ['Adjektivform', 'mit Label', 'nicht-deutsch', 'ISO-Code'],

  // No sex/gender detector. 'm' is personal data only next to its label, so
  // this is a label-gated detector of the kind the weak-format identifiers
  // already use — small, and worth doing.
  Geschlecht: ['normal', 'Kuerzel mit Label', 'NFD'],

  // The scan copy folds invisibles, compatibility forms and Cyrillic/Greek
  // look-alikes, but not Latin letters impersonating digits (O/0, l/1, S/5).
  // Closing this means that fold applied only inside runs that then have to
  // pass a checksum, so it can never corrupt ordinary prose.
  'Steuer-ID': ['fuehrendes O'],

  // The Steuernummer carries no check digit, so the slash grouping and the
  // label are the whole signal. Space-grouped, ungrouped and the 13-digit
  // bundeseinheitlich form are arithmetically indistinguishable from any other
  // number; closing this means widening the label list, not the pattern.
  Steuernummer: ['Luecken', 'ohne Trennzeichen', 'bundeseinheitlich'],

  // Reported when the check digit is present or a label stands beside them. The
  // bare nine-character serial has neither, and 'LO1XOOT47' additionally needs
  // the digit-shaped-letter fold. Closing it means reporting the bare serial
  // unaccompanied, and paying for every product code shaped like one.
  Personalausweis: ['normal', 'klein', 'O statt 0'],
  Reisepass: ['normal', 'kyrillisches C'],
  Fuehrerschein: ['normal', 'klein', 'Luecken'],

  // 'KAXY1234' is one undifferentiated run. The detector already carries the
  // district-code list it would need to segment it; what stops it is that
  // segmenting without a separator invents a boundary the writer never wrote.
  'Kfz-Kennzeichen': ['ohne Trennzeichen'],

  // The last two e-mail evasions, and both fall to one de-obfuscation fold that
  // rewrites '(at)' and '[dot]' in the scan copy. Between two address-shaped
  // tokens those spellings have no innocent reading, so the fold is safe.
  Email: ['ausgeschriebene Obfuskation', 'Klammer-Variante'],

  // 'plus49' spells the '+': the same de-obfuscation fold as the e-mail cases.
  'Phone DE': ['ausgeschriebenes Plus'],

  // Ten digits with no separator, no country code and no label look exactly
  // like an order number. The detector requires one of the three on purpose,
  // and this case is the price — the same residual the M1 regression test
  // records for US-national numbers.
  'Phone US': ['ohne Trennzeichen'],

  // The street-line reader expects the German order, street before number.
  // Accepting the English order means gating it on a postcode or a place name,
  // or every '12 Something' in a document becomes an address.
  Adresse: ['EN-Reihenfolge'],

  // Five digits alone stay unreported by design: a German postcode collides
  // with every other five-digit number, so a label, a country prefix or a place
  // name behind it is what licenses the finding. This gap is a decision.
  PLZ: ['normal'],

  // Not a detector gap. The corpus text carries check digits 49 where this
  // account number requires 89, so folding the Cyrillic E yields an IBAN that
  // fails mod-97 and must not be reported. See the fixture-validity block.

  // Dotted-quad is read; these are five other encodings of it. The defanged and
  // spelled forms fall to the de-obfuscation fold, spaced dots to separator
  // folding. The decimal and hex integers need arithmetic plus a label, or
  // every large number in a log becomes an address.
  IPv4: ['fuehrende Nullen', 'Luecken', 'defanged', 'ausgeschrieben', 'dezimal', 'hex'],

  // Separator folding inside a colon run, which the identifier detectors
  // already do for their own formats.
  IPv6: ['Luecken'],

  // Twelve bare hex digits are indistinguishable from any other hex id without
  // a label; the spaced form only wants separator folding.
  MAC: ['ohne Trennzeichen', 'Luecken'],

  // A space before the '@' wants whitespace folding inside a URL run; the empty
  // user in 'redis://:password@host' is a form the pattern does not yet accept,
  // and it is the shape a connection string in a config file actually has.
  'URL creds': ['Luecke vor @', 'leerer User'],

  // 'ghp_' is missing from the prefix seed list and is a one-line addition. The
  // key split across a newline and the key split by a space need the run
  // rejoined in the scan copy. The base64-wrapped key needs a decode pass,
  // which is a throughput decision rather than a pattern.
  Secrets: ['GitHub PAT', 'ueber Zeilenumbruch', 'Luecke im Key', 'base64-kodiert'],

  // A token broken across lines or spaced around its dots: the same rejoining
  // fold the split secrets want, applied to the three-segment shape.
  JWT: ['ueber drei Zeilen', 'Luecken um Punkte'],

  // 'E119' without its point is a plain alphanumeric token and would need the
  // label. The two Klartext cases are diagnoses written as German prose, and
  // they are the single largest gap in this file: they need a medical lexicon.
  ICD: ['ohne Punkt', 'Klartext', 'Klartext unsicher'],

  // Ethnic origin in prose. It needs a curated German term list and a
  // false-positive budget; there is no format to match.
  Herkunft: ['normal', 'mit Label', 'NFD'],

  // Party membership. A party abbreviation is also an ordinary word or an
  // ordinary acronym, so this needs the term list plus a membership context.
  Politik: ['Partei', 'Kompositum', 'Wahlverhalten', 'Punkt-getrennt', 'ausgeschrieben'],

  // Confession, including the payroll abbreviations 'rk' and 'ev' that no
  // pattern can distinguish from initials without their label.
  Religion: ['normal', 'Lohnsteuer-Kuerzel', 'mit Label', 'Negativwert'],

  // Union membership, which in practice is named indirectly — a membership
  // number or a payroll line — and so needs context, not a term list alone.
  Gewerkschaft: ['normal', 'ohne Punkt', 'mit Nummer', 'indirekt'],

  // Biometric data arrives as a blob, a float vector, an inline data: URI or a
  // reference id. None has a signature beyond the label beside it, so each
  // wants a label-gated detector over an otherwise unremarkable shape.
  Biometrie: ['base64-Template', 'Vektor', 'inline Bild', 'Referenz-ID'],

  // Sexual orientation in prose, including the evasions — soft hyphen and leet
  // — that the existing folds would already handle once a term list exists.
  // The indirect case needs inference, and is out of reach of any lexicon.
  Orientierung: ['normal', 'mit Label', 'Soft Hyphen', 'Leetspeak', 'indirekt'],

  // One letter short of an entry. DictionaryOptions.fuzzy closes exactly this
  // and is off by default because it walks the entry list per candidate token;
  // the gap is a measured throughput decision, not an oversight.
  Dictionary: ['fehlender Buchstabe'],

  // Deliberate. The operator's regex says what it says, and widening
  // 'CUST-\d{6}' to tolerate a space, lower case, an underscore, a short number
  // or an O for a zero would silently change what they asked hushgate to find.
  // Closing this belongs in the config file: write the tolerant pattern.
  'Custom regex': ['Luecke', 'klein', 'ohne fuehrende Nullen', 'Underscore', 'O statt 0'],

  // Names Mueller, who is not in the fixture dictionary — unwinnable under this
  // config, like the two Name cases above it.
  Kombination: ['NFD + Leet + umgedreht'],
};

/**
 * Values the corpus leans on, checked against the detectors' own validators so
 * the two can never drift apart.
 *
 * This block exists because the corpus has already shipped invalid fixtures: a
 * Steuer-ID that failed Mod 11,10 and a KVNR whose check digit was 9 where the
 * algorithm says 0, between them five reported misses the detectors never had.
 * A miss must always mean the detector failed, never that the test value was
 * arithmetic nonsense — so every value that carries a check digit is verified
 * here before any conclusion is drawn from a miss.
 *
 * Three such fixtures have been found so far, and the third is the reason this
 * block is not merely defensive book-keeping. `IBAN / kyrillisches E` was
 * written with check digits 49 where mod-97 makes that account 89, so the case
 * could never have been caught however well confusable folding worked — it was
 * reporting a detector failure that did not exist. Corrected, it is caught, and
 * it now tests what it was written to test: that a Cyrillic Е in the country
 * code does not hide an IBAN.
 */
const FIXTURES: readonly (readonly [string, boolean])[] = [
  ['Steuer-ID 86091739453', isValidGermanTaxId('86091739453')],
  ['KVNR A123456780', isValidHealthInsuranceNumber('A123456780')],
  ['IBAN DE89370400440532013000', isValidIban('DE89370400440532013000')],
  ['IBAN AT611904300234573201', isValidIban('AT611904300234573201')],
  ['IBAN CH9300762011623852957', isValidIban('CH9300762011623852957')],
  ['IBAN NL91ABNA0417164300', isValidIban('NL91ABNA0417164300')],
  ['Card 4111111111111111', luhnValid('4111111111111111')],
  ['Card 5555555555554444', luhnValid('5555555555554444')],
  ['Card 378282246310005', luhnValid('378282246310005')],
  ['IMEI 490154203237518', luhnValid('490154203237518')],
];

const key = (kase: Case): string => `${kase[0]} | ${kase[1]}`;

const byKey = new Map(CASES.map((kase) => [key(kase), kase]));

/** Caught means: the wanted kind was reported, or — when `want` is null — anything was. */
function isCaught(kase: Case): boolean {
  const kinds = detect(kase[2], detectors).map((span) => span.kind);
  return kase[3] === null ? kinds.length > 0 : kinds.includes(kase[3]);
}

/**
 * One pass over the whole corpus, at collection time, so the live number can go
 * into the describe titles below. That is how the tally reaches a reader who
 * runs the file rather than reads it: a console line from a passing test is
 * swallowed by the default reporter, a test name is not.
 */
const CAUGHT_NOW: ReadonlySet<string> = new Set(CASES.filter(isCaught).map(key));

/** Caught today but not yet pinned: what a reader should promote into CAUGHT. */
const PROMOTABLE = [...CAUGHT_NOW].filter((k) => !CAUGHT.has(k));

describe('evasion corpus: fixture validity', () => {
  it.each(FIXTURES)('%s validates', (label, valid) => {
    expect(valid, `${label} is not a valid value — a miss on it would be meaningless`).toBe(true);
  });

});

describe(`evasion corpus: ${CAUGHT.size} pinned cases stay caught`, () => {
  it.each([...CAUGHT])('%s', (caughtKey) => {
    expect(byKey.has(caughtKey), `${caughtKey} is pinned but names no case in the corpus`).toBe(
      true,
    );
    expect(CAUGHT_NOW.has(caughtKey), `${caughtKey} was caught when this set was taken`).toBe(true);
  });
});

describe(`evasion corpus: ${CAUGHT_NOW.size} of ${CASES.length} caught today`, () => {
  // Nothing in this block asserts the tally, only that both lists describe the
  // corpus as it actually is. A rising number is the point of keeping the
  // corpus, and a test that went red on an improvement would be edited away
  // within a week — which is the same as having no test.
  it('documents every case the detectors miss', () => {
    const undocumented = CASES.filter((kase) => !CAUGHT_NOW.has(key(kase)))
      .filter((kase) => !(KNOWN_GAPS[kase[0]] ?? []).includes(kase[1]))
      .map(key);
    expect(undocumented, 'uncaught and unexplained — add it to KNOWN_GAPS').toEqual([]);
  });

  it('lists no case that has left the corpus', () => {
    const stale = Object.entries(KNOWN_GAPS).flatMap(([group, labels]) =>
      labels
        .map((label) => `${group} | ${label}`)
        .filter((candidate) => !byKey.has(candidate)),
    );
    expect(stale, 'KNOWN_GAPS names a case that no longer exists').toEqual([]);
  });

  it('accounts for every case in one list or the other', () => {
    const orphans = CASES.filter(
      (kase) => !CAUGHT.has(key(kase)) && !(KNOWN_GAPS[kase[0]] ?? []).includes(kase[1]),
    ).map(key);
    expect(orphans, 'a case belongs in CAUGHT or in KNOWN_GAPS').toEqual([]);
  });

  it(`has ${PROMOTABLE.length} newly caught case(s) waiting to be pinned`, () => {
    // Deliberately not an assertion. Naming the cases in the title is the whole
    // job: the next person to open this file learns which gaps closed, moves
    // them into CAUGHT, and the guarantee gets stronger without anyone ever
    // having had to edit a number to make a red test go green.
    console.log(
      PROMOTABLE.length === 0
        ? `evasion corpus: ${CAUGHT_NOW.size} of ${CASES.length} caught, all pinned`
        : `evasion corpus: promote into CAUGHT —\n  ${PROMOTABLE.join('\n  ')}`,
    );
  });
});
