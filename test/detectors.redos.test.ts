import { describe, expect, it } from 'vitest';
import {
  bankAccountDetectors,
  createDetectors,
  detect,
  emailDetector,
  urlCredentialsDetector,
} from '../src/detectors/index.js';
import type { Detector } from '../src/types.js';

/**
 * Catastrophic backtracking, measured rather than reasoned about.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `ops.test.ts`. That file already asserts
 * the hot path does not degrade super-linearly, and it was passing while two
 * detectors were quadratic. Its fixtures are ordinary prose and
 * `'1.1.1.1 '.repeat(n)`, and neither can trigger the shape that was wrong: the
 * space in the dense fixture ends a greedy run after seven characters, so the
 * run never grows with the input. A hostile body does not have that space.
 *
 * So the fixtures here are chosen the other way round — each one is a single
 * enormous run of characters that some pattern accepts, followed by nothing the
 * pattern needs. That is the shape that makes a backtracking engine try every
 * split at every starting position, and it is what a body written to hurt this
 * proxy looks like. It is not a shape any real request has, which is exactly
 * why it never turned up on its own.
 *
 * WHAT WAS WRONG, so that a later reader can tell a regression from a rewrite:
 *
 *  - `email.ts` ATOM was `[…]+` with `=` and `/` among its members, followed by
 *    a required `@`. 12 500 characters of `=` cost 297 ms, 25 000 cost 1178,
 *    50 000 cost 4705. On a 4 MiB body — which `limits.maxBodyBytes` accepts —
 *    that extrapolates to about nine hours of synchronous work, with every
 *    other tenant on the shared event loop waiting behind it.
 *  - `urlcredentials.ts` the scheme `[A-Za-z0-9+.-]*` before a required `://`,
 *    on `sk-sk-sk-…` and `a.b.a.b.…`.
 *
 * The domain label chain is bounded too, and there is deliberately no test for
 * it here: taken apart on its own it is quadratic, but through the whole
 * pattern it is only ever entered behind a bounded local part, and six shapes
 * built to provoke it all measured linear. A test that passes in both states
 * would claim a guarantee this file does not have.
 *
 * Each is now bounded by a length the surrounding code already enforced one
 * step later, so the bounds refuse only candidates that were being discarded.
 */

/** Best of three: one sample at this size is mostly scheduler noise. */
function best(detector: Detector, text: string): number {
  let ms = Infinity;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    detector.find(text);
    ms = Math.min(ms, performance.now() - started);
  }
  return ms;
}

/**
 * Quadruple the input and assert the cost did not sixteenfold.
 *
 * A 4x step rather than 2x, for the reason `ops.test.ts` argues at length:
 * doubling puts linear at 2 and quadratic at 4, and ordinary jitter on a shared
 * runner covers that whole gap. Over 4x the predictions are 4 and 16, and the
 * bound of 8 sits between them with room on both sides — noise cannot reach it
 * from below and the quadratic shapes above cannot fit under it. Each of them
 * measured a clean 16.0 across this step before the bounds went in.
 */
function assertSubQuadratic(detector: Detector, make: (n: number) => string): void {
  const small = best(detector, make(12_500));
  const large = best(detector, make(50_000));
  // A floor on the denominator: at sub-millisecond timings the ratio is
  // meaningless, and a detector that fast is not the one this test is about.
  expect(large / Math.max(small, 0.5)).toBeLessThan(8);
}

describe('no detector backtracks catastrophically', () => {
  // The exact shapes that were quadratic, one test each so a failure names it.

  it('email: a run of characters the local part accepts, with no at-sign', () => {
    assertSubQuadratic(emailDetector, (n) => '='.repeat(n));
  });

  it('email: the same with a separator the local part also accepts', () => {
    assertSubQuadratic(emailDetector, (n) => '9/'.repeat(n / 2));
  });

  it('url credentials: a scheme-shaped run that never reaches ://', () => {
    assertSubQuadratic(urlCredentialsDetector, (n) => 'sk-'.repeat(n / 3));
  });

  it('url credentials: the same with dots rather than hyphens', () => {
    assertSubQuadratic(urlCredentialsDetector, (n) => 'a.b.'.repeat(n / 4));
  });

  it('bank account: a body of nothing but sort codes', () => {
    // Not backtracking — a lookup. The sort-code pass asked "is there an
    // account number just after this one?" by scanning the whole run list, so a
    // body of sort codes was quadratic in the most ordinary way there is:
    // 1 MB of `53-20-13 ` did not finish in two minutes. It is a map now.
    const [bankAccount] = bankAccountDetectors;
    assertSubQuadratic(bankAccount!, (n) => '53-20-13 '.repeat(n / 9));
  });

  it('bank account: a body of nothing but bank-code-shaped runs', () => {
    const [bankAccount] = bankAccountDetectors;
    assertSubQuadratic(bankAccount!, (n) => '37040044 '.repeat(n / 9));
  });

  it('the whole detector set survives a body of one hostile run', () => {
    // The end-to-end claim, and the one a customer would feel: every detector,
    // every scan copy, one pass. 200 KB is a twentieth of the body limit.
    const detectors = createDetectors({ dictionary: { names: ['Max Mustermann'] } });
    const started = performance.now();
    detect('='.repeat(200_000), detectors);
    // Generous, because this runs on whatever machine CI happens to give us.
    // Before the bounds this single call took over 75 seconds.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

const found = (text: string): string[] => detect(text, [emailDetector]).map((span) => span.value);

describe('the bounds refuse only what was already refused', () => {
  // `isValidEmail` has always applied RFC 5321's 64-character local part and
  // RFC 1035's 63-character label AFTER the match. Moving those limits into the
  // pattern is what stops the backtracking; these pin that it changed nothing a
  // caller can observe, so the two limits cannot drift apart later.

  it('still reads a local part at the limit', () => {
    const address = `${'a'.repeat(64)}@example.com`;
    expect(found(address)).toEqual([address]);
  });

  it('still refuses one character past it', () => {
    expect(found(`${'a'.repeat(65)}@example.com`)).toEqual([]);
  });

  it('still reads a domain label at the limit', () => {
    const address = `user@${'a'.repeat(63)}.com`;
    expect(found(address)).toEqual([address]);
  });

  it('still refuses one character past it', () => {
    expect(found(`user@${'a'.repeat(64)}.com`)).toEqual([]);
  });

  it('still reads the addresses a customer actually writes', () => {
    for (const address of [
      'max.mustermann@example.com',
      'a+b/c=d@sub.example.co.uk',
      'ünal@example.de',
      'владимир@example.com',
      'first-last@my-domain.co.uk',
      'user@a.b.c.d.e.f.example.museum',
    ]) {
      expect(found(address), address).toEqual([address]);
    }
  });

  it('still reads a connection string with an arbitrarily long password', () => {
    // The userinfo is deliberately not bounded: a password is exactly the thing
    // that may be any length, and bounding it would lose a real finding.
    const url = `postgres://admin:${'x'.repeat(500)}@db.internal:5432/prod`;
    expect(detect(url, [urlCredentialsDetector]).map((span) => span.value)).toEqual([url]);
  });

  it('still reads the longest scheme anyone has registered', () => {
    const url = 'microsoft.windows.camera.multipicker://user:pass@host';
    expect(detect(url, [urlCredentialsDetector]).map((span) => span.value)).toEqual([url]);
  });
});
