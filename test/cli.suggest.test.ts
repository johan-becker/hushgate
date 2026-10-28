import { describe, expect, it } from 'vitest';
import { suggest } from '../src/cli/suggest.js';

const COMMANDS = [
  'init', 'setup', 'serve', 'scan', 'extract', 'residency', 'briefing', 'doctor', 'audit', 'keys', 'check',
  'help', 'version',
];

const SERVE_OPTIONS = ['config', 'host', 'port', 'upstream-openai', 'upstream-anthropic', 'audit', 'no-audit'];

describe('suggest', () => {
  it('finds the candidate one slip away', () => {
    expect(suggest('scann', COMMANDS)).toEqual(['scan']);
    expect(suggest('docter', COMMANDS)).toEqual(['doctor']);
    expect(suggest('porrt', SERVE_OPTIONS)).toEqual(['port']);
  });

  it('counts two letters swapped as one slip', () => {
    expect(suggest('sevre', COMMANDS)).toEqual(['serve']);
    expect(suggest('verfiy', ['verify', 'report'])).toEqual(['verify']);
  });

  it('completes a word that is the start of one candidate', () => {
    expect(suggest('resid', COMMANDS)).toEqual(['residency']);
    expect(suggest('ver', COMMANDS)).toEqual(['version']);
  });

  it('lists every candidate that is equally close, in the order given', () => {
    expect(suggest('se', COMMANDS)).toEqual(['setup', 'serve']);
    expect(suggest('upstrem', SERVE_OPTIONS)).toEqual(['upstream-openai', 'upstream-anthropic']);
  });

  it('offers nothing for a word that is nothing like any candidate', () => {
    expect(suggest('frobnicate', COMMANDS)).toEqual([]);
    expect(suggest('x', COMMANDS)).toEqual([]);
    expect(suggest('', COMMANDS)).toEqual([]);
  });

  it('ignores case', () => {
    expect(suggest('Scan', COMMANDS)).toEqual(['scan']);
  });
});
