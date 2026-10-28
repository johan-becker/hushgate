import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/playground/samples.js';
import { Session } from '../src/redact/session.js';

describe('playground samples', () => {
  it('offers two German and two English documents with unique ids', () => {
    expect(SAMPLES).toHaveLength(4);
    expect(new Set(SAMPLES.map((s) => s.id)).size).toBe(SAMPLES.length);
  });

  it.each(SAMPLES.map((s) => [s.id, s] as const))('%s is well formed', (_id, sample) => {
    expect(sample.label.length).toBeGreaterThan(0);
    expect(sample.label.length).toBeLessThanOrEqual(20);
    expect(sample.blurb.length).toBeGreaterThan(0);
    expect(sample.names.length).toBeGreaterThan(0);
  });

  it.each(SAMPLES.map((s) => [s.id, s] as const))(
    '%s yields at least six kinds and loses every listed name',
    (_id, sample) => {
      const result = new Session({ dictionary: { names: [...sample.names] } }).redact(sample.text);
      const kinds = new Set(result.findings.map((f) => f.kind));
      expect(kinds.size).toBeGreaterThanOrEqual(6);
      for (const name of sample.names) {
        expect(sample.text).toContain(name);
        expect(result.text).not.toContain(name);
      }
    },
  );
});
