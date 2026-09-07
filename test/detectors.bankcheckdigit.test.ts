import { describe, expect, it } from 'vitest';
import {
  bankCodeMethod,
  checkDigitValid,
  IMPLEMENTED_CHECK_DIGIT_METHODS,
  isKnownBankCode,
  isValidGermanAccountNumber,
  LIVE_CHECK_DIGIT_METHODS,
} from '../src/detectors/bankcheckdigit.js';
import {
  BUNDESBANK_CHECK_DIGIT_CASES,
  CROSS_CHECKED_CHECK_DIGIT_CASES,
} from './fixtures/bundesbank-checkdigits.js';

/**
 * The German account check digit.
 *
 * A German account number carries a check digit, but which arithmetic produced
 * it is a property of the *bank*, not of the number: the Bundesbank publishes
 * about a hundred and fifty methods and names one per bank code. So nothing
 * here can be tested against a shape. Every case is a pair.
 *
 * The fixtures are the Bundesbank's own Testkontonummern, filtered to the ones
 * an independent implementation of the same spec also agrees on — see
 * test/fixtures/bundesbank-checkdigits.ts for what that filter throws away and
 * why. The second block covers the live methods the spec prints no test numbers
 * for; it is one-sourced and pins behaviour rather than proving it.
 */
describe('bank code to check digit method', () => {
  it('reads the method the Bundesbank assigned to a bank', () => {
    // Commerzbank Köln, the bank in the canonical German example IBAN.
    expect(bankCodeMethod('37040044')).toBe('13');
  });

  it('knows a bank code that is in the directory', () => {
    expect(isKnownBankCode('37040044')).toBe(true);
  });

  it('does not invent a method for a bank code that is not in the directory', () => {
    expect(bankCodeMethod('99999999')).toBeUndefined();
    expect(isKnownBankCode('99999999')).toBe(false);
  });

  it('refuses anything that is not eight digits', () => {
    expect(bankCodeMethod('3704004')).toBeUndefined();
    expect(bankCodeMethod('370400440')).toBeUndefined();
    expect(bankCodeMethod('3704004a')).toBeUndefined();
    expect(bankCodeMethod('')).toBeUndefined();
  });

  it('refuses a bank code starting with zero', () => {
    // No German bank code begins with 0; the leading digit is the clearing area.
    expect(bankCodeMethod('07040044')).toBeUndefined();
  });
});

describe('official Bundesbank test account numbers', () => {
  const methods = Object.keys(BUNDESBANK_CHECK_DIGIT_CASES).toSorted();

  it(`covers ${methods.length} methods with ${Object.values(BUNDESBANK_CHECK_DIGIT_CASES).flat().length} official cases`, () => {
    expect(methods.length).toBeGreaterThan(55);
  });

  for (const method of methods) {
    describe(`Verfahren ${method}`, () => {
      for (const [account, blz, valid] of BUNDESBANK_CHECK_DIGIT_CASES[method]!) {
        it(`${valid ? 'accepts' : 'rejects'} ${account}`, () => {
          expect(checkDigitValid(account, blz, method)).toBe(valid);
        });
      }
    });
  }
});

describe('methods the spec prints no test numbers for', () => {
  for (const method of Object.keys(CROSS_CHECKED_CHECK_DIGIT_CASES).toSorted()) {
    describe(`Verfahren ${method}`, () => {
      for (const [account, blz, valid] of CROSS_CHECKED_CHECK_DIGIT_CASES[method]!) {
        it(`${valid ? 'accepts' : 'rejects'} ${account}`, () => {
          expect(checkDigitValid(account, blz, method)).toBe(valid);
        });
      }
    });
  }
});

describe('every method a live bank code names is implemented', () => {
  it('leaves no live method unimplemented', () => {
    const missing = [...LIVE_CHECK_DIGIT_METHODS].filter(
      (method) => !IMPLEMENTED_CHECK_DIGIT_METHODS.has(method),
    );
    expect(missing).toEqual([]);
  });
});

describe('account number and bank code together', () => {
  it('accepts the account from the canonical German example IBAN', () => {
    // DE89 3704 0044 0532 0130 00 — the Bundesbank's own example.
    expect(isValidGermanAccountNumber('0532013000', '37040044')).toBe(true);
  });

  it('accepts it without the leading zero, as a customer writes it', () => {
    expect(isValidGermanAccountNumber('532013000', '37040044')).toBe(true);
  });

  it('rejects the same account with a wrong check digit', () => {
    // Stelle 8 is the check digit under Verfahren 13; 0 is right, 1 is not.
    expect(isValidGermanAccountNumber('532013100', '37040044')).toBe(false);
  });

  it('does not claim to check the two-digit sub-account', () => {
    // Verfahren 13 checks Stellen 2 to 7 only, so the last two digits are
    // outside the arithmetic. Worth pinning: it is the reason a "neighbouring"
    // account number can still pass, and a reader will otherwise assume the
    // check covers the whole number.
    expect(isValidGermanAccountNumber('532013000', '37040044')).toBe(true);
    expect(isValidGermanAccountNumber('532013001', '37040044')).toBe(true);
  });

  it('refuses an account number that is too long', () => {
    expect(isValidGermanAccountNumber('05320130000', '37040044')).toBe(false);
  });

  it('refuses an empty or non-numeric account number', () => {
    expect(isValidGermanAccountNumber('', '37040044')).toBe(false);
    expect(isValidGermanAccountNumber('53201300x', '37040044')).toBe(false);
  });

  it('refuses an all-zero account number', () => {
    expect(isValidGermanAccountNumber('0000000000', '37040044')).toBe(false);
  });

  it('says nothing about a bank code it does not know', () => {
    expect(isValidGermanAccountNumber('0532013000', '99999999')).toBe(false);
  });

  it('accepts every account at a bank that publishes no method', () => {
    // Method 09 is the Bundesbank's marker for "no check digit calculation".
    const noCheck = [...LIVE_CHECK_DIGIT_METHODS].includes('09');
    expect(noCheck).toBe(true);
    expect(checkDigitValid('1234567890', '10000000', '09')).toBe(true);
  });
});
