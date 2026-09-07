import { describe, expect, it } from 'vitest';
import { createCustomDetector } from '../src/detectors/custom.js';

// Patterns that must be REFUSED: nested quantifiers / ambiguous repetition
// under a quantifier — the classic catastrophic-backtracking shapes.
const MUST_REFUSE = [
  '(a+)+$',
  '([a-z]+)*',
  '(a|aa)+',
  '(a+)+',
  '((x+x+)+y)',
  '(\\w+\\s?)*$',
];

// Patterns that must be ACCEPTED: bounded or non-nested repetition typical of
// real identifier detectors.
const MUST_ACCEPT = [
  'EMP-[0-9]{4,8}',
  '[A-Z][a-z]+',
  '(?:foo|bar)baz',
  '^\\d{5}$',
  '[a-z]+@[a-z]+\\.[a-z]{2,}',
  '\\bAK-[0-9]{6}\\b',
  '[A-Z]{1,3}-[A-Z]{1,2}\\s?[0-9]{1,4}',
];

describe('ReDoS guard for custom detector patterns', () => {
  it.each(MUST_REFUSE)('refuses catastrophic pattern %s', (pattern) => {
    expect(() => createCustomDetector({ name: 'redos_probe', pattern })).toThrow();
  });

  it.each(MUST_ACCEPT)('accepts safe pattern %s', (pattern) => {
    expect(() => createCustomDetector({ name: 'safe_probe', pattern })).not.toThrow();
  });
});
