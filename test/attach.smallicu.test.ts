import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Does the attachment pipeline still read documents on a Node that cannot be
 * trusted for windows-1252?
 *
 * There are two such Nodes, and the difference between them is the whole
 * reason this file has two halves.
 *
 *  - A build with `--without-intl`, or any runtime that trims ICU to save
 *    space, has a `TextDecoder` that exists but only for the UTF labels. Ask it
 *    for `windows-1252` and the constructor throws.
 *  - Node 20 does not throw. It accepts `windows-1252` — and every other label
 *    the Encoding Standard resolves to windows-1252 — and hands back a latin-1
 *    decoder. That is the worse of the two, because a refusal is something a
 *    fallback can see, and this one succeeds while being wrong.
 *
 * `node:22-alpine`, the image hushgate ships on, carries full ICU, as the
 * official Node images have since v13, and that was checked in the container
 * rather than assumed. But `engines` says `>=20`, so the second Node is not
 * hypothetical: it is the floor of the support window, and it is what turned
 * CI red on the run that produced this file.
 *
 * Either way the call sites failed *silently*, and silence is the property that
 * makes a hazard worth a test:
 *
 *  - `plaintext.ts` fell back to latin-1, where 0x92 is the C1 control U+0092
 *    rather than a right single quote, and the control was stripped a few lines
 *    later. `Kün’s` extracted as `Küns`.
 *  - `html.ts` built its C1 table by decoding, got an empty string, failed its
 *    own length guard and dropped the reference. `Anna&#146;s` became `Annas`.
 *  - `rtf.ts` fell through both `buildTable` attempts to a latin-1 table, so
 *    every `\'92` in every Word-exported RTF lost its apostrophe too.
 *  - `eml.ts` handed the declared charset straight to `TextDecoder`, so a mail
 *    written by Outlook — `charset=windows-1252`, or `charset=iso-8859-1`,
 *    which is the same encoding under an older name — lost the same character.
 *
 * Each deletion is invisible from the outside: the document extracts, the
 * quality checks pass, the audit record says it was read, and one character is
 * gone from somebody's name. A test that only ever runs on full ICU cannot see
 * any of it, so this file takes the platform's table away and asks again.
 *
 * The modules are imported *after* the stub is in place and with the registry
 * reset, because two of them build their tables at module load.
 */

/** Every label the Encoding Standard resolves to windows-1252. */
const LABELS_1252 = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819',
  'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1',
  'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
]);

/** The first Node: the label throws. */
const UTF_ONLY = class extends TextDecoder {
  constructor(label = 'utf-8', options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    if (!String(label).toLowerCase().startsWith('utf')) {
      throw new RangeError(`unsupported encoding: ${label}`);
    }
    super(label, options);
  }
};

/**
 * The second Node: the label is accepted and answered with latin-1.
 *
 * Latin-1 is the identity on code points, which is what makes it such a
 * convincing wrong answer — every byte outside 0x80 to 0x9F decodes exactly as
 * windows-1252 would, and only the punctuation moves.
 */
const LATIN1_FOR_1252 = class extends TextDecoder {
  private readonly asLatin1: boolean;

  constructor(label = 'utf-8', options?: { fatal?: boolean; ignoreBOM?: boolean }) {
    const legacy = LABELS_1252.has(String(label).toLowerCase());
    super(legacy ? 'utf-8' : label, options);
    this.asLatin1 = legacy;
  }

  override decode(
    input?: NodeJS.ArrayBufferView | ArrayBuffer | null,
    options?: { stream?: boolean },
  ): string {
    if (!this.asLatin1) return super.decode(input, options);
    if (input === null || input === undefined) return '';
    const view = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    return Buffer.from(view).toString('latin1');
  }
};

const raw = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (source: string): Uint8Array =>
  Uint8Array.from([...source], (char) => char.codePointAt(0) ?? 0);

/**
 * The call sites, asked the same questions under either stub.
 *
 * Registered as a function rather than copied into both blocks so that a new
 * call site is added once and covered twice.
 */
const everyCallSiteHolds = (): void => {
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
    const message =
      'From: a@b.example\r\n' +
      'Subject: Test\r\n' +
      'Content-Type: text/plain; charset=windows-1252\r\n' +
      '\r\n' +
      'Anna\u0092s Angebot\r\n';
    const result = emlToText(ascii(message), 1000);
    expect(result.ok && result.value.text).toContain('Anna’s Angebot');
  });

  it('still decodes an e-mail part that calls the same encoding iso-8859-1', async () => {
    const { emlToText } = await import('../src/attach/eml.js');
    // The older name for the same bytes, and the one German mailers write.
    // Under the Encoding Standard it *is* windows-1252, so 0x92 is a right
    // single quote here too, not a control to be stripped.
    const message =
      'From: a@b.example\r\n' +
      'Content-Type: text/plain; charset=iso-8859-1\r\n' +
      '\r\n' +
      'Müller\u0092s Angebot\r\n';
    const result = emlToText(ascii(message), 1000);
    expect(result.ok && result.value.text).toContain('Müller’s Angebot');
  });

  it('reads a whole German sentence out of an RTF without losing a character', async () => {
    const { rtfToText } = await import('../src/attach/rtf.js');
    // \'fc is ü in both latin-1 and windows-1252; \'92 and \'84 differ, and are
    // exactly what the old latin-1 fallback turned into stripped controls.
    const document = String.raw`{\rtf1\ansi\ansicpg1252 M\'fcller\'92s \'84Angebot\'93}`;
    expect(rtfToText(ascii(document), 1000)).toBe('Müller’s „Angebot“');
  });
};

describe('a Node whose TextDecoder refuses windows-1252', () => {
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
    // UTF-8 still works, or nothing else in this block would mean anything.
    expect(new TextDecoder('utf-8').decode(ascii('ok'))).toBe('ok');
  });

  everyCallSiteHolds();
});

describe('a Node whose TextDecoder answers windows-1252 with latin-1', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('TextDecoder', LATIN1_FOR_1252);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('accepts the label and answers wrongly, which is the premise of this block', () => {
    // No throw, so nothing downstream can branch on failure: 0x92 comes back as
    // the C1 control rather than as U+2019, and every guard sees a decode that
    // worked.
    expect(new TextDecoder('windows-1252').decode(raw(0x92))).toBe('\u0092');
    expect(new TextDecoder('iso-8859-1').decode(raw(0x92))).toBe('\u0092');
    expect(new TextDecoder('utf-8').decode(ascii('ok'))).toBe('ok');
  });

  everyCallSiteHolds();
});
