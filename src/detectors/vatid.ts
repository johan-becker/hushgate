import type { Detector, Span } from '../types.js';
import { isScanSeparator } from './normalise.js';
import { mod1110CheckDigit } from './taxid.js';
import { collectRun, isDigit, isWordChar, memberAt } from './util.js';

/**
 * Kind and priority for the Umsatzsteuer-Identifikationsnummer.
 *
 * `DEFAULT_PRIORITIES` has no entry for this kind, so the weight lives here and
 * is exported for whoever registers the detector. It sits just under the IBAN:
 * both are country-prefixed identifiers that can start on the same two letters,
 * and when two equally long spans disagree the IBAN's mod-97 is the stronger
 * evidence of the two.
 */
export const EU_VAT_ID_KIND = 'EU_VAT_ID';
export const EU_VAT_ID_PRIORITY = 88;

/** The body of a VAT number for one member state: its lengths and its shape. */
export interface VatIdRule {
  /** Permitted body lengths in alphanumerics, prefix excluded. */
  readonly lengths: readonly number[];
  /** Tested against the upper-cased body with separators removed. */
  readonly body: RegExp;
}

/**
 * The member states this detector ships with, and nothing else.
 *
 * Each of the twenty-seven states has its own body format *and* its own check
 * digit, so "EU VAT ID" is twenty-seven formats wearing one name. Shipping five
 * that are genuinely right is worth more than shipping twenty-seven of which
 * twenty-two are guesses — an unknown two-letter prefix in front of digits is
 * an order number far more often than it is a VAT ID, and each wrong format is
 * a permanent false positive. The remaining states go in through
 * {@link VatIdOptions.rules}; the authoritative formats are published by the
 * Commission with the VIES service.
 *
 * Two traps worth naming, because they are why this table is not the ISO 3166
 * one from `bic.ts`: Greece files under `EL`, not `GR`, and Northern Ireland
 * under `XI`.
 */
export const VAT_ID_RULES: Readonly<Record<string, VatIdRule>> = {
  /** Nine digits, the only one of the five with a verified check digit here. */
  DE: { lengths: [9], body: /^\d{9}$/u },
  /** `U` then eight digits — the letter is what keeps this off an AT IBAN. */
  AT: { lengths: [9], body: /^U\d{8}$/u },
  /** Two check characters then the nine-digit SIREN; `I` and `O` never occur. */
  FR: { lengths: [11], body: /^[A-HJ-NP-Z0-9]{2}\d{9}$/u },
  /** Nine digits, a literal `B`, then the two-digit sub-number. */
  NL: { lengths: [12], body: /^\d{9}B\d{2}$/u },
  /**
   * Seven digits and one or two check letters, or the pre-2013 form with a
   * letter in second position. That older form also allowed `+` and `*` there;
   * they are not accepted, because widening the character set every candidate
   * is collected with, for a spelling the Revenue stopped issuing in 2013, buys
   * less than it costs.
   */
  IE: { lengths: [9, 8], body: /^(?:\d{7}[A-W][A-IW]?|\d[A-Z]\d{5}[A-W])$/u },
};

/**
 * The check digit of a German USt-IdNr.
 *
 * The same ISO 7064 MOD 11,10 chain the Steuer-ID uses, run over eight digits
 * instead of ten. Reused rather than copied: a second implementation of a
 * checksum is a second thing to get wrong, and the two would drift.
 */
export function isValidGermanVatId(body: string): boolean {
  if (!/^\d{9}$/u.test(body)) return false;
  return mod1110CheckDigit(body.slice(0, 8)) === body.codePointAt(8)! - 48;
}

/** How to build the detector. */
export interface VatIdOptions {
  /**
   * Report a German number only when its check digit is right. Off by default,
   * and the reason is worth stating plainly: `DE123456789` — the number printed
   * in every template, every specimen invoice and every test fixture — fails
   * the check digit. Requiring it drops roughly nine in ten strings of this
   * shape, which is most of the false positives *and* every fixture. A
   * deployment that would rather miss a real VAT ID than pseudonymise a French
   * sentence that groups a nine-digit amount after the word "de" turns this on.
   */
  readonly requireGermanCheckDigit?: boolean;
  /** Further member states, merged over {@link VAT_ID_RULES}. */
  readonly rules?: Readonly<Record<string, VatIdRule>>;
}

interface CompiledRule {
  readonly code: string;
  /** Longest first, so the two Irish forms are tried in the right order. */
  readonly lengths: readonly number[];
  readonly body: RegExp;
}

const isAsciiAlnum = (ch: string): boolean =>
  isDigit(ch) || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');

/**
 * True when the run does not stop where the format does.
 *
 * An alphanumeric directly after the last character always means a longer
 * token. A group separator is only treated as a continuation when the body was
 * itself written in groups and more digits follow: `DE 123 456 789 012` is one
 * twelve-digit number, while `DE123456789 2024` is a VAT ID and then a year.
 */
function continuesAfter(text: string, end: number, grouped: boolean): boolean {
  if (memberAt(text, end, isAsciiAlnum)) return true;
  if (!grouped) return false;
  const next = text[end];
  return next !== undefined && isScanSeparator(next) && memberAt(text, end + 1, isDigit);
}

/**
 * EU VAT / USt-IdNr detector.
 *
 * Anchors on a known country prefix at a word boundary and collects the body
 * through the separators the identifier fold knows about, so `DE-123456789`,
 * `DE 123 456 789` and `de123456789` all arrive at the same eleven characters.
 * Structure alone licenses the finding; see
 * {@link VatIdOptions.requireGermanCheckDigit} for the trade that decision is.
 */
export function createVatIdDetector(options: VatIdOptions = {}): Detector {
  const merged = { ...VAT_ID_RULES, ...options.rules };
  const requireCheckDigit = options.requireGermanCheckDigit ?? false;

  const rules = new Map<string, CompiledRule>(
    Object.entries(merged).map(([code, rule]) => [
      code.toUpperCase(),
      {
        code: code.toUpperCase(),
        lengths: rule.lengths.toSorted((a, b) => b - a),
        body: rule.body,
      },
    ]),
  );

  // Built once: the country set is fixed when the detector is, and rebuilding
  // the alternation per call would repay it on every request.
  const anchorSource = `(?:${[...rules.keys()].toSorted().join('|')})`;

  return {
    name: 'eu-vat-id',
    priority: EU_VAT_ID_PRIORITY,

    find(text: string): Span[] {
      const out: Span[] = [];
      // Fresh per call so the detector stays re-entrant.
      const anchor = new RegExp(anchorSource, 'giu');
      let match: RegExpExecArray | null;

      while ((match = anchor.exec(text)) !== null) {
        const start = match.index;
        if (isWordChar(text, start - 1)) continue;
        // A country code between a dot and a slash is a top-level domain, and
        // what follows it is a path: `example.de/123456789` is not a VAT ID.
        // Worth the two character reads, because no scan copy folds this shape
        // — the host is not an identifier chain — so the raw pass is the only
        // place it can be refused.
        if (text[start - 1] === '.' && text[start + 2] === '/') continue;

        const rule = rules.get(match[0].toUpperCase());
        if (rule === undefined) continue;

        const longest = rule.lengths[0]!;
        const run = collectRun(text, start, isAsciiAlnum, isScanSeparator, 2 + longest);
        const first = run.offsets[0];
        const last = run.offsets.at(-1);
        if (first === undefined || last === undefined) continue;

        const grouped = last - first + 1 !== run.chars.length;

        for (const length of rule.lengths) {
          // Exact equality, not "at least": a run that carries more than the
          // format holds is a longer identifier, not a VAT ID with a tail.
          if (run.chars.length !== 2 + length) continue;

          const body = run.chars.slice(2).toUpperCase();
          if (!rule.body.test(body)) continue;
          if (requireCheckDigit && rule.code === 'DE' && !isValidGermanVatId(body)) continue;

          const end = last + 1;
          if (continuesAfter(text, end, grouped)) continue;

          out.push({
            start,
            end,
            kind: EU_VAT_ID_KIND,
            value: text.slice(start, end),
            detector: 'eu-vat-id',
            priority: EU_VAT_ID_PRIORITY,
          });
          anchor.lastIndex = end;
          break;
        }
      }

      return out;
    },
  };
}

/** The detector as registered: every shipped member state, structure only. */
export const vatIdDetector: Detector = createVatIdDetector();
