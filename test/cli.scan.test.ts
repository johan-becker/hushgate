import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import { mask, position } from '../src/cli/commands/scan.js';
import { run } from '../src/cli/run.js';

const dirs: string[] = [];

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-scan-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function capture(argv: string[], overrides: Partial<Cli> = {}): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      env: {},
      cwd: process.cwd(),
      ...overrides,
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

const stdinOf = (text: string): NodeJS.ReadableStream => Readable.from([text]);

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('position', () => {
  it('reports 1-based line and column', () => {
    const text = 'one\ntwo\nthree';
    expect(position(text, 0)).toEqual({ line: 1, column: 1 });
    expect(position(text, 4)).toEqual({ line: 2, column: 1 });
    expect(position(text, 9)).toEqual({ line: 3, column: 2 });
  });
});

describe('mask', () => {
  it('identifies a value without reproducing it', () => {
    expect(mask('johan@example.com')).toBe('jo••••••om');
    expect(mask('abcd')).toBe('••••');
  });

  it('collapses whitespace so a preview stays on one line', () => {
    expect(mask('DE89 3704\n0044')).not.toContain('\n');
  });
});

describe('hushgate scan', () => {
  const notes = [
    'Kundennotiz',
    'Mail: johan@example.com',
    'IBAN DE89 3704 0044 0532 0130 00',
    'nichts weiter',
  ].join('\n');

  it('reports what it found, where, and how it would be handled', async () => {
    const dir = workspace({ 'notes.txt': notes });
    const c = capture(['scan', 'notes.txt'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).toContain('notes.txt');
    expect(c.out()).toMatch(/2:7\s+EMAIL/u);
    expect(c.out()).toContain('→ pseudonymize');
    expect(c.out()).toContain('2 findings in 1 file: EMAIL 1, IBAN 1');
  });

  it('masks the values so CI logs do not publish them', async () => {
    const dir = workspace({ 'notes.txt': notes });
    const c = capture(['scan', 'notes.txt'], { cwd: dir });
    await run(c.cli);
    expect(c.out()).not.toContain('johan@example.com');
    expect(c.out()).not.toContain('DE89 3704 0044 0532 0130 00');
  });

  it('prints the values when asked to', async () => {
    const dir = workspace({ 'notes.txt': notes });
    const c = capture(['scan', '--show-values', 'notes.txt'], { cwd: dir });
    await run(c.cli);
    expect(c.out()).toContain('johan@example.com');
  });

  it('exits 0 on a clean file', async () => {
    const dir = workspace({ 'clean.txt': 'nothing to see here' });
    const c = capture(['scan', 'clean.txt'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('no personal data found in 1 file');
  });

  it('scans several files and sums them up', async () => {
    const dir = workspace({ 'a.txt': 'a@x.de', 'b.txt': 'b@x.de and 10.0.0.9' });
    const c = capture(['scan', 'a.txt', 'b.txt'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).toContain('3 findings in 2 files: EMAIL 2, IPV4 1');
  });

  it('reads standard input for -', async () => {
    const dir = workspace();
    const c = capture(['scan', '-'], { cwd: dir, stdin: stdinOf('mail a@x.de') });
    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).toContain('<stdin>');
  });

  it('emits machine-readable output for CI', async () => {
    const dir = workspace({ 'notes.txt': notes });
    const c = capture(['scan', '--json', 'notes.txt'], { cwd: dir });
    await run(c.cli);

    const report = JSON.parse(c.out()) as {
      findings: number;
      counts: Record<string, number>;
      files: { path: string; findings: { kind: string; line: number; policy: string }[] }[];
    };
    expect(report.findings).toBe(2);
    expect(report.counts).toEqual({ EMAIL: 1, IBAN: 1 });
    expect(report.files[0]!.findings[0]).toMatchObject({ kind: 'EMAIL', line: 2, policy: 'pseudonymize' });
  });

  it('honours the policies in the config file', async () => {
    const dir = workspace({
      'notes.txt': 'key sk-abcdefghijklmnopqrstuvwx',
      'hushgate.config.json': JSON.stringify({ redaction: { policies: { SECRET: 'block' } } }),
    });
    const c = capture(['scan', 'notes.txt'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).toContain('→ block');
  });

  it('finds the dictionary names from the config file', async () => {
    const dir = workspace({
      'notes.txt': 'Ansprechpartnerin ist Anna Schmidt',
      'hushgate.config.json': JSON.stringify({
        redaction: { dictionary: { names: ['Anna Schmidt'] } },
      }),
    });
    const c = capture(['scan', '--json', 'notes.txt'], { cwd: dir });
    await run(c.cli);
    expect(JSON.parse(c.out()).counts).toEqual({ NAME: 1 });
  });

  it('fails with a readable message when the file is missing', async () => {
    const dir = workspace();
    const c = capture(['scan', 'nope.txt'], { cwd: dir });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('cannot read nope.txt');
  });

  it('needs at least one file', async () => {
    const c = capture(['scan']);
    // A missing operand is a usage error (exit 2), not a failure (exit 1).
    expect(await run(c.cli)).toBe(EXIT.usage);
    expect(c.err()).toContain('at least one file');
  });
});

describe('hushgate check', () => {
  it('redacts standard input to standard output', async () => {
    const c = capture(['check'], { stdin: stdinOf('Mail an johan@example.com bitte') });
    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toBe('Mail an [EMAIL_1] bitte');
  });

  it('summarises on stderr so stdout stays pipeable', async () => {
    const c = capture(['check'], { stdin: stdinOf('a@x.de and b@x.de and 10.0.0.1') });
    await run(c.cli);
    expect(c.err()).toBe('hushgate: redacted 3 findings (EMAIL 2, IPV4 1)\n');
    expect(c.out()).not.toContain('hushgate:');
  });

  it('says so when there is nothing to redact', async () => {
    const c = capture(['check'], { stdin: stdinOf('nothing here') });
    await run(c.cli);
    expect(c.out()).toBe('nothing here');
    expect(c.err()).toContain('nothing to redact');
  });

  it('stays silent with --quiet', async () => {
    const c = capture(['check', '--quiet'], { stdin: stdinOf('a@x.de') });
    await run(c.cli);
    expect(c.out()).toBe('[EMAIL_1]');
    expect(c.err()).toBe('');
  });

  it('writes nothing at all when a block policy triggers', async () => {
    const dir = workspace({
      'hushgate.config.json': JSON.stringify({ redaction: { policies: { SECRET: 'block' } } }),
    });
    const c = capture(['check'], {
      cwd: dir,
      stdin: stdinOf('deploy key sk-abcdefghijklmnopqrstuvwx now'),
    });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toBe('');
    expect(c.err()).toContain('blocked by policy');
    expect(c.err()).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('refuses file arguments and points at scan', async () => {
    const c = capture(['check', 'notes.txt'], { stdin: stdinOf('') });
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('hushgate scan');
  });
});

describe('scanning a folder that is not all text', () => {
  /** A 1x1 PNG: real bytes, no text layer, nothing can read it. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==',
    'base64',
  );

  const folder = (): string => {
    const dir = workspace({
      'a.txt': 'Mail an anna.schmidt@nordlicht.example\n',
      'c.txt': 'IBAN DE89370400440532013000\n',
    });
    writeFileSync(join(dir, 'b.png'), PNG);
    return dir;
  };

  it('keeps going past a file it cannot read, and still reports the rest', async () => {
    // The whole point of reading documents is sweeping a folder. One logo among
    // two hundred contracts must not turn the run into silence.
    const dir = folder();
    const c = capture(['scan', 'a.txt', 'b.png', 'c.txt'], { cwd: dir });
    const code = await run(c.cli);

    expect(code).toBe(EXIT.findings);
    expect(c.out()).toContain('EMAIL');
    expect(c.out()).toContain('IBAN');
  });

  it('says which file it could not read rather than implying it was clean', async () => {
    const dir = folder();
    const c = capture(['scan', 'a.txt', 'b.png', 'c.txt'], { cwd: dir });
    await run(c.cli);

    expect(c.out()).toContain('unreadable');
    expect(c.out()).toContain('b.png');
    expect(c.err()).toContain('b.png');
  });

  it('does not exit 0 when the only file was never scanned', async () => {
    const dir = folder();
    const c = capture(['scan', 'b.png'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).not.toContain('no personal data found in 1 file');
  });

  it('names the unreadable files in the JSON report', async () => {
    const dir = folder();
    const c = capture(['scan', '--json', 'a.txt', 'b.png'], { cwd: dir });
    await run(c.cli);

    const report = JSON.parse(c.out()) as {
      unreadable: number;
      files: { path: string; unreadable?: string }[];
    };
    expect(report.unreadable).toBe(1);
    expect(report.files.find((file) => file.path === 'b.png')?.unreadable).toBeTruthy();
    expect(report.files.find((file) => file.path === 'a.txt')?.unreadable).toBeUndefined();
  });
});

const configFor = (dir: string): string => {
  const path = join(dir, 'hushgate.config.json');
  writeFileSync(
    path,
    JSON.stringify({
      attachments: {
        extractors: [
          {
            mediaTypes: ['application/pdf'],
            command: process.execPath,
            args: ['-e', 'process.stdout.write("Kundin Anna Schmidt, IBAN DE89370400440532013000")'],
            timeoutMs: 5000,
          },
        ],
      },
    }),
  );
  return path;
};

const pdfIn = (dir: string): string => {
  const path = join(dir, 'rechnung.pdf');
  writeFileSync(path, '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%%EOF\n');
  return path;
};

describe('an extractor configured the way the README documents it', () => {
  // `{"mediaTypes": ["application/pdf"], "command": ...}` with no `formats`.
  // Through the proxy the caller declares a media type; on the command line
  // nobody does, so the type inferred from the bytes has to stand in for one.
  it('is used by scan', async () => {
    const dir = workspace();
    const c = capture(['scan', '-c', configFor(dir), pdfIn(dir)], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).toContain('IBAN');
  });

  it('is used by extract', async () => {
    const dir = workspace();
    const c = capture(['extract', '-c', configFor(dir), pdfIn(dir)], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.ok);
    expect(c.out()).toContain('[IBAN_1]');
    expect(c.out()).not.toContain('no extractor handles');
  });
});

describe('the command line and the proxy give the same answer', () => {
  /**
   * What ordinary PDF kerning does to an address block: three-character groups
   * with no short words at all. The proxy refuses this, and `extract` exists to
   * show what the proxy would send — so printing it as though it were readable
   * would make the command lie about the thing it is for.
   */
  const shredded =
    'Sac hbe arb eit eri n: Ann a S chm idt\n' +
    'E-M ail : a nna .sc hmi dt@ nor dli cht .ex amp le\n' +
    'IBA N: DE8 937 040 044 053 201 300 0\n';

  it('extract refuses a document whose spacing splits its identifiers', async () => {
    const dir = workspace({ 'brief.txt': shredded });
    const c = capture(['extract', 'brief.txt'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('splits identifiers');
    expect(c.out()).not.toContain('nordlicht');
  });

  it('scan refuses it when it came out of an extractor', async () => {
    // Through an extractor the spacing is hushgate's own doing, so the file is
    // reported as unreadable rather than as scanned.
    const dir = workspace();
    const path = join(dir, 'brief.pdf');
    writeFileSync(path, `%PDF-1.7\n${shredded}\ntrailer\n<< >>\n%%EOF\n`);
    writeFileSync(
      join(dir, 'hushgate.config.json'),
      JSON.stringify({
        attachments: {
          extractors: [
            {
              formats: ['pdf'],
              command: process.execPath,
              args: ['-e', `process.stdout.write(${JSON.stringify(shredded)})`],
              timeoutMs: 5000,
            },
          ],
        },
      }),
    );

    const c = capture(['scan', '-c', 'hushgate.config.json', 'brief.pdf'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.out()).toContain('unreadable');
  });

  it('but reads a plain text file as the file it is', async () => {
    // Not an extraction failure: nothing of hushgate's mangled this, the
    // spacing is what the file says. scan reports what it can find, as it does
    // for any text, and §10 of the README is where its detection limits live.
    const dir = workspace({ 'brief.txt': shredded });
    const c = capture(['scan', 'brief.txt'], { cwd: dir });

    expect(await run(c.cli)).toBe(EXIT.findings);
    expect(c.out()).not.toContain('unreadable');
  });

  it('and both still read the same letter set properly', async () => {
    const clean =
      'Sachbearbeiterin: Anna Schmidt\n' +
      'E-Mail: anna.schmidt@nordlicht.example\n' +
      'IBAN: DE89370400440532013000\n';
    const dir = workspace({ 'brief.txt': clean });

    const extracted = capture(['extract', 'brief.txt'], { cwd: dir });
    expect(await run(extracted.cli)).toBe(EXIT.ok);
    expect(extracted.out()).toContain('[EMAIL_1]');

    const scanned = capture(['scan', 'brief.txt'], { cwd: dir });
    expect(await run(scanned.cli)).toBe(EXIT.findings);
    expect(scanned.out()).toContain('EMAIL');
  });
});
