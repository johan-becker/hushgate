import { describe, expect, it } from 'vitest';
import {
  bankAccountDetectors,
  createBankAccountDetectors,
  isValidAbaRouting,
} from '../src/detectors/bankaccount.js';
import { createDetectors, detect } from '../src/detectors/index.js';
import { resolveSpans } from '../src/detectors/resolve.js';
import type { Span } from '../src/types.js';

/**
 * Legacy account details — the pre-IBAN Kontonummer/Bankleitzahl pair, the UK
 * sort code and the US routing number.
 *
 * None of the three has the property an IBAN has: a checksum over the whole
 * string that decides the question on its own. What decides here is either a
 * label beside the value or the *other half of the pair*, and the German half
 * is decided arithmetically — the bank code is looked up in the Bundesbank
 * directory and the account number is run through that bank's own check-digit
 * method. That is why an unlabelled `532013000 / 37040044` can be reported at
 * all, and why an unlabelled pair with a made-up bank code cannot.
 */
const find = (detectors: readonly { find(text: string): Span[] }[], text: string): Span[] =>
  detectors.flatMap((detector) => detector.find(text));

const values = (spans: readonly Span[]): string[] => spans.map((span) => span.value).toSorted();

describe('German account number and bank code', () => {
  it('finds a labelled pair', () => {
    const spans = find(bankAccountDetectors, 'Kto. 532013000, BLZ 37040044');
    expect(values(spans)).toEqual(['37040044', '532013000']);
    expect(spans.every((span) => span.kind === 'BANK_ACCOUNT')).toBe(true);
  });

  it('finds an unlabelled pair, on the strength of the check digit alone', () => {
    const spans = find(bankAccountDetectors, '532013000 / 37040044');
    expect(values(spans)).toEqual(['37040044', '532013000']);
  });

  it('finds the pair written bank code first', () => {
    const spans = find(bankAccountDetectors, '37040044 / 532013000');
    expect(values(spans)).toEqual(['37040044', '532013000']);
  });

  it('finds a pair separated by a comma or a line break', () => {
    expect(values(find(bankAccountDetectors, '532013000, 37040044'))).toEqual([
      '37040044',
      '532013000',
    ]);
    expect(values(find(bankAccountDetectors, '532013000\n37040044'))).toEqual([
      '37040044',
      '532013000',
    ]);
  });

  it('finds an account number that only a label identifies', () => {
    expect(values(find(bankAccountDetectors, 'Kontonummer: 532013000'))).toEqual(['532013000']);
    expect(values(find(bankAccountDetectors, 'Konto-Nr. 4711123'))).toEqual(['4711123']);
  });

  it('finds a bank code that only a label identifies', () => {
    expect(values(find(bankAccountDetectors, 'BLZ 37040044'))).toEqual(['37040044']);
    expect(values(find(bankAccountDetectors, 'Bankleitzahl 50010517'))).toEqual(['50010517']);
  });

  describe('what it refuses', () => {
    it('refuses an unlabelled pair whose bank code is not a German bank', () => {
      expect(find(bankAccountDetectors, '532013000 / 99999999')).toEqual([]);
    });

    it('refuses an unlabelled pair whose account fails the bank’s check digit', () => {
      // 37040044 is Commerzbank Köln, Verfahren 13; Stelle 8 must be 0 here.
      expect(find(bankAccountDetectors, '532013100 / 37040044')).toEqual([]);
    });

    it('refuses a lone number, however plausible', () => {
      expect(find(bankAccountDetectors, 'Rechnung 532013000 vom Montag')).toEqual([]);
      expect(find(bankAccountDetectors, 'Auftrag 37040044')).toEqual([]);
    });

    it('refuses two ordinary numbers side by side', () => {
      expect(find(bankAccountDetectors, 'Positionen 123456 / 87654321')).toEqual([]);
      expect(find(bankAccountDetectors, 'Zeitraum 2024 / 2025')).toEqual([]);
    });

    it('refuses a bank code that is part of a longer run', () => {
      expect(find(bankAccountDetectors, 'X37040044 / 532013000')).toEqual([]);
      expect(find(bankAccountDetectors, 'DE89370400440532013000')).toEqual([]);
    });

    it('refuses a label with nothing account-shaped behind it', () => {
      expect(find(bankAccountDetectors, 'Bitte die BLZ nachreichen.')).toEqual([]);
      expect(find(bankAccountDetectors, 'Kontonummer folgt separat')).toEqual([]);
    });

    it('refuses a labelled number that is too short or too long to be an account', () => {
      expect(find(bankAccountDetectors, 'Konto 12')).toEqual([]);
      expect(find(bankAccountDetectors, 'Konto 12345678901')).toEqual([]);
    });
  });
});

describe('UK sort code and account number', () => {
  it('finds the bare pair', () => {
    expect(values(find(bankAccountDetectors, '53-20-13 12345678'))).toEqual([
      '12345678',
      '53-20-13',
    ]);
  });

  it('finds the labelled pair', () => {
    const spans = find(bankAccountDetectors, 'Sort code 53-20-13, account 12345678');
    expect(values(spans)).toEqual(['12345678', '53-20-13']);
  });

  it('refuses a sort code with no account number and no label', () => {
    expect(find(bankAccountDetectors, 'Position 53-20-13 folgt')).toEqual([]);
  });

  it('refuses a run that is not six digits in three pairs', () => {
    expect(find(bankAccountDetectors, '5-20-13 12345678')).toEqual([]);
    expect(find(bankAccountDetectors, '53-20-134 12345678')).toEqual([]);
  });
});

describe('US routing number and account number', () => {
  it('accepts a routing number that satisfies the ABA checksum', () => {
    expect(isValidAbaRouting('021000021')).toBe(true);
    expect(isValidAbaRouting('021000022')).toBe(false);
    expect(isValidAbaRouting('12345678')).toBe(false);
  });

  it('finds the labelled pair', () => {
    const spans = find(bankAccountDetectors, 'Routing 021000021, Account 1234567890');
    expect(values(spans)).toEqual(['021000021', '1234567890']);
  });

  it('finds the bare pair', () => {
    expect(values(find(bankAccountDetectors, '021000021 1234567890'))).toEqual([
      '021000021',
      '1234567890',
    ]);
  });

  it('refuses nine digits that fail the checksum, label or not', () => {
    // The account number beside it is still licensed by its own label — the
    // point of the case is that the routing number is not reported.
    const spans = find(bankAccountDetectors, 'Routing 021000022, Account 1234567890');
    expect(values(spans)).toEqual(['1234567890']);
  });

  it('refuses a lone routing number', () => {
    expect(find(bankAccountDetectors, 'Referenz 021000021 im Bericht')).toEqual([]);
  });
});

describe('configuration', () => {
  it('takes extra labels without losing the built-in ones', () => {
    const detectors = createBankAccountDetectors({ accountLabels: ['Kontoverbindung Nr'] });
    expect(values(find(detectors, 'Kontoverbindung Nr 532013000'))).toEqual(['532013000']);
    expect(values(find(detectors, 'Kontonummer: 532013000'))).toEqual(['532013000']);
  });

  it('takes an operator bank-code table for codes the snapshot does not have', () => {
    const detectors = createBankAccountDetectors({
      bankCodes: (code) => (code === '99999999' ? '09' : undefined),
    });
    expect(values(find(detectors, '532013000 / 99999999'))).toEqual(['532013000', '99999999']);
  });
});

describe('inside the full detector set', () => {
  const detectors = createDetectors();

  it('leaves an IBAN to the IBAN detector', () => {
    const spans = resolveSpans(detect('IBAN DE89 3704 0044 0532 0130 00', detectors));
    expect(spans.map((span) => span.kind)).toEqual(['IBAN']);
  });

  it('reports both halves of a legacy pair', () => {
    const spans = resolveSpans(detect('Kto. 532013000, BLZ 37040044', detectors));
    expect(spans.map((span) => span.kind)).toEqual(['BANK_ACCOUNT', 'BANK_ACCOUNT']);
    expect(values(spans)).toEqual(['37040044', '532013000']);
  });

  it('does not fire on German business prose', () => {
    const prose = [
      'Die Rechnung 2024-0815 über 1.234,56 EUR ist am 15.03.2024 fällig.',
      'Unsere Auftragsnummer lautet 87654321, Ihre Bestellung 4711.',
      'Telefon 0221 1234567, Telefax 0221 1234568.',
      'Der Artikel 532013000 wurde am 12.05.2024 geliefert.',
    ].join('\n');
    expect(find(bankAccountDetectors, prose)).toEqual([]);
  });
});
