import { describe, expect, it } from 'vitest';
import {
  findPlaceholders,
  isViablePlaceholderPrefix,
  makeHashToken,
  makePlaceholder,
  makeRedactedMask,
  MAX_PLACEHOLDER_LENGTH,
  PLACEHOLDER_EXACT,
} from '../src/redact/placeholder.js';

describe('token shapes', () => {
  it('builds the documented reversible token', () => {
    expect(makePlaceholder('EMAIL', 1)).toBe('[EMAIL_1]');
    expect(makePlaceholder('GERMAN_TAX_ID', 42)).toBe('[GERMAN_TAX_ID_42]');
  });

  it('accepts every reversible token it builds', () => {
    for (const kind of ['EMAIL', 'IBAN', 'GERMAN_TAX_ID', 'EMPLOYEE_ID3']) {
      expect(PLACEHOLDER_EXACT.test(makePlaceholder(kind, 7))).toBe(true);
    }
  });

  it('keeps the irreversible tokens outside the reversible grammar', () => {
    // The restorer and the streaming re-hydrator both key off PLACEHOLDER_EXACT;
    // if a mask or a hash matched it they would be looked up and passed through
    // as unknown tokens, which is noise at best and confusing at worst.
    expect(PLACEHOLDER_EXACT.test(makeRedactedMask('EMAIL'))).toBe(false);
    expect(PLACEHOLDER_EXACT.test(makeHashToken('EMAIL', '9f86d081ab2c'))).toBe(false);
  });
});

describe('findPlaceholders', () => {
  it('finds every complete token with its offsets', () => {
    const text = 'a [EMAIL_1] b [IBAN_12] c';
    expect(findPlaceholders(text)).toEqual([
      { start: 2, end: 11, value: '[EMAIL_1]' },
      { start: 14, end: 23, value: '[IBAN_12]' },
    ]);
  });

  it('ignores shapes that are not tokens', () => {
    expect(findPlaceholders('[email_1] [1_EMAIL] [EMAIL] [EMAIL_] plain')).toEqual([]);
  });

  it('is restartable — the shared pattern carries no lastIndex between calls', () => {
    const text = '[EMAIL_1] [EMAIL_2]';
    expect(findPlaceholders(text)).toHaveLength(2);
    expect(findPlaceholders(text)).toHaveLength(2);
  });
});

describe('isViablePlaceholderPrefix', () => {
  it('accepts every proper prefix of a real token', () => {
    const token = '[GERMAN_TAX_ID_12]';
    for (let cut = 1; cut < token.length; cut += 1) {
      const prefix = token.slice(0, cut);
      // A prefix ending in the ordinal digits is viable too.
      expect(isViablePlaceholderPrefix(prefix)).toBe(true);
    }
  });

  it('rejects text that can no longer become a token', () => {
    for (const candidate of ['', 'x', '[email', '[1', '[ ', '[EMAIL_1]', '[EMAIL_1]x', 'EMAIL_1]']) {
      expect(isViablePlaceholderPrefix(candidate)).toBe(false);
    }
  });

  it('refuses to hold back more than the maximum token length', () => {
    const runaway = `[${'A'.repeat(MAX_PLACEHOLDER_LENGTH)}`;
    expect(runaway.length).toBeGreaterThan(MAX_PLACEHOLDER_LENGTH);
    expect(isViablePlaceholderPrefix(runaway)).toBe(false);
  });
});
