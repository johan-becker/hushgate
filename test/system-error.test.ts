import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeSystemError } from '../src/errors.js';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('did not throw');
}

describe('describeSystemError', () => {
  it('says what went wrong, without the code or the system call', () => {
    const error = caught(() => readFileSync('/nonexistent-hushgate-dir/x.txt'));
    expect(describeSystemError(error)).toBe('no such file or directory');
  });

  it('names a directory as one', () => {
    expect(describeSystemError(caught(() => readFileSync('/')))).toBe('is a directory');
  });

  it('keeps the message of anything that is not a system error', () => {
    expect(describeSystemError(new Error('boom'))).toBe('boom');
    expect(describeSystemError('odd')).toBe('odd');
  });
});
