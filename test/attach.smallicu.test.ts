import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Does the attachment pipeline still read documents on a Node without the
 * legacy encoding tables?
 *
 * A build with `--without-intl`, or any runtime that trims ICU to save space,
 * has a `TextDecoder` that exists but only for the UTF labels. Ask it for
 * `windows-1252` and the constructor throws.
 *
 * The images hushgate ships on are NOT such a build — `node:22-alpine` carries
 * full ICU, as the official Node images have since v13, and this was checked in
 * the container rather than assumed. So this file guards a hazard rather than
 * reproducing a released defect. It earns its place anyway, because all three
 * call sites failed *silently* when the table was missing, and silence is the
 * property that makes a hazard worth a test:
 *
 *  - `plaintext.ts` fell back to latin-1, where 0x92 is the C1 control U+0092
 *    rather than a right single quote, and the control was stripped a few lines
 *    later. `Kün’s` extracted as `Küns`.
 *  - `html.ts` built its C1 table by decoding, got an empty string, failed its
 *    own length guard and dropped the reference. `Anna&#146;s` became `Annas`.
 *  - `rtf.ts` fell through both `buildTable` attempts to a latin-1 table, so
 *    every `\'92` in every Word-exported RTF lost its apostrophe too.
 *
 * Each deletion is invisible from the outside: the document extracts, the
 * quality checks pass, the audit record says it was read, and one character is
 * gone from somebody's name. A test that only ever runs on full ICU cannot see
 * any of it, so this file removes the platform's table and asks again.
 *
 * The modules are imported *after* the stub is in place and with the registry
 * reset, because two of them build their tables at module load.
 */
const UTF_ONLY = class extends TextDecoder {
  constructor(label = 'utf-8', options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    if (!String(label).toLowerCase().startsWith('utf')) {
      throw new RangeError(`unsupported encoding: ${label}`);
    }
    super(label, options);
  }
};

const raw = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (source: string): Uint8Array =>
  Uint8Array.from([...source], (char) => char.codePointAt(0) ?? 0);

describe('a Node without the legacy encoding tables', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('TextDecoder', UTF_ONLY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('refuses windows-1252, which is the premise of every case here', () => {
    expect(() => new TextDecoder('windows-1252')).toThrow();
    // UTF-8 still works, or nothing else in this file would mean anything.
    expect(new TextDecoder('utf-8').decode(ascii('ok'))).toBe('ok');
  });

  it('still decodes a windows-1252 apostrophe in plain text', async () => {
    const { decodeText } = await import('../src/attach/plaintext.js');
    expect(decodeText(raw(0x4b, 0xfc, 0x6e, 0x92, 0x73)).text).toBe('Kün’s');
  });

  it('still maps a C1 numeric reference in HTML', async () => {
    const { htmlToText } = await import('../src/attach/html.js');
    expect(htmlToText('<p>Anna&#146;s</p>', 1000)).toBe('Anna’s');
  });

  it('still decodes a windows-1252 escape in RTF', async () => {
    const { rtfToText } = await import('../src/attach/rtf.js');
    // What Word writes for an apostrophe in an ANSI RTF.
    const document = String.raw`{\rtf1\ansi\ansicpg1252 Anna\'92s}`;
    expect(rtfToText(ascii(document), 1000)).toBe('Anna’s');
  });

  it('still decodes an e-mail part that declares a windows-1252 charset', async () => {
    const { emlToText } = await import('../src/attach/eml.js');
    // eml.ts asks TextDecoder for the declared charset and falls through to the
    // byte sniff when the label is refused, so it is fixed by plaintext.ts
    // rather than by anything of its own. Pinned here because that is not
    // obvious from reading eml.ts, and a change there could quietly undo it.
    const message =
      'From: a@b.example\r\n' +
      'Subject: Test\r\n' +
      'Content-Type: text/plain; charset=windows-1252\r\n' +
      '\r\n' +
      'Anna\u0092s Angebot\r\n';
    const result = emlToText(ascii(message), 1000);
    expect(result.ok && result.value.text).toContain('Anna’s Angebot');
  });

  it('reads a whole German sentence out of an RTF without losing a character', async () => {
    const { rtfToText } = await import('../src/attach/rtf.js');
    // \'fc is ü in both latin-1 and windows-1252; \'92 and \'84 differ, and are
    // exactly what the old latin-1 fallback turned into stripped controls.
    const document = String.raw`{\rtf1\ansi\ansicpg1252 M\'fcller\'92s \'84Angebot\'93}`;
    expect(rtfToText(ascii(document), 1000)).toBe('Müller’s „Angebot“');
  });
});
