import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  externalExtractor,
  probeCommand,
  type ExternalExtractorSpec,
} from '../src/attach/external.js';
import { assessText } from '../src/attach/quality.js';
import type { ExtractionContext } from '../src/attach/types.js';

/**
 * The commands under test are Node scripts written here at run time, so the
 * suite needs neither poppler nor a binary fixture in the repository.
 */
const dir = mkdtempSync(join(tmpdir(), 'hushgate-external-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const script = (name: string, source: string): string => {
  const path = join(dir, name);
  writeFileSync(path, source, 'utf8');
  return path;
};

const ECHO = script(
  'echo.mjs',
  `const chunks = [];
   process.stdin.on('data', (chunk) => chunks.push(chunk));
   process.stdin.on('end', () => {
     process.stdout.write('read:' + Buffer.concat(chunks).toString('utf8'));
   });`,
);

const FAIL = script(
  'fail.mjs',
  `process.stderr.write("Syntax Error: Couldn't find trailer dictionary\\nsecond line\\n");
   process.exitCode = 2;`,
);

/**
 * The poppler failure mode: an extractor handed a malformed document quotes
 * the bytes it choked on. The fake IBAN below is chosen to use no digit that
 * the mechanical reason could contain on its own.
 */
const FAKE_IBAN = 'DE00370400440532000000';

const LEAKY = script(
  'leaky.mjs',
  `process.stderr.write('Syntax Error: could not parse ${FAKE_IBAN} at offset 42\\n');
   process.exitCode = 1;`,
);

const LEAKY_SILENT = script(
  'leaky-silent.mjs',
  `process.stderr.write('Syntax Error: could not parse ${FAKE_IBAN} at offset 42\\n');
   process.exitCode = 0;`,
);

const SILENT = script('silent.mjs', 'process.exitCode = 0;');

/** Never reads stdin and never exits: a big input is still in flight at kill. */
const IDLE = script('idle.mjs', 'setInterval(() => {}, 1000);');

const PAGES = script(
  'pages.mjs',
  `const ff = String.fromCharCode(12);
   process.stdout.write('Rechnung Nummer 4711' + ff + 'Seite zwei mit Text' + ff);`,
);

const SLEEPY = script(
  'sleepy.mjs',
  `process.stdin.resume();
   setTimeout(() => { process.stdout.write('too late'); }, 30000);`,
);

const STUBBORN = script(
  'stubborn.mjs',
  `process.on('SIGTERM', () => {});
   process.stdin.resume();
   setInterval(() => {}, 1000);`,
);

const FLOOD = script(
  'flood.mjs',
  `import { writeFileSync } from 'node:fs';
   const marker = process.argv[2];
   process.on('SIGTERM', () => { writeFileSync(marker, 'terminated'); process.exit(0); });
   process.stdout.on('error', () => { process.exit(0); });
   process.stdin.resume();
   const chunk = 'A'.repeat(16384);
   const pump = () => { process.stdout.write(chunk, pump); };
   pump();`,
);

const DEAF = script('deaf.mjs', "process.stdout.write('done');");

const ENVIRONMENT = script(
  'environment.mjs',
  `process.stdout.write(
     'secret=' + (process.env.HUSHGATE_TEST_SECRET || 'absent') +
     ' openai=' + (process.env.OPENAI_API_KEY || 'absent') +
     ' path=' + (process.env.PATH ? 'set' : 'unset') +
     ' locale=' + (process.env.LC_ALL || 'unset'));`,
);

const spec = (
  scriptPath: string,
  overrides: Partial<ExternalExtractorSpec> = {},
): ExternalExtractorSpec => ({
  mediaTypes: overrides.mediaTypes ?? ['application/pdf'],
  formats: overrides.formats ?? [],
  command: overrides.command ?? process.execPath,
  args: overrides.args ?? [scriptPath],
  timeoutMs: overrides.timeoutMs ?? 10_000,
});

const context = (overrides: Partial<ExtractionContext> = {}): ExtractionContext => ({
  format: 'pdf',
  mediaType: 'application/pdf',
  maxChars: 10_000,
  timeoutMs: 15_000,
  ...overrides,
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('an external extractor', () => {
  it('feeds the attachment in on stdin and returns what the command printed', async () => {
    const result = await externalExtractor(spec(ECHO)).extract(bytes('Anna Schmidt'), context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('read:Anna Schmidt');
    expect(result.value.extractor).toBe('external.node');
  });

  it('never lets the attachment reach argv', async () => {
    // argv is the configured args and nothing else, so a payload that looks
    // like a flag arrives as content: `-layout` comes back as text, not as an
    // option the child silently obeyed.
    const result = await externalExtractor(spec(ECHO)).extract(bytes('-layout'), context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('read:-layout');
  });

  it('reports a non-zero exit as the exit status alone, without the stderr', async () => {
    // The reason is written to the audit trail and returned to the caller, and
    // an extractor's stderr is not hushgate's text to repeat: poppler prints
    // the bytes it failed on.
    const result = await externalExtractor(spec(FAIL)).extract(bytes('x'), context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('exited with status 2');
    expect(result.reason).not.toContain("Couldn't find trailer dictionary");
    expect(result.reason).not.toContain('second line');
  });

  it('refuses a command that succeeds without printing anything', async () => {
    const result = await externalExtractor(spec(SILENT)).extract(bytes('x'), context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('produced no output');
  });

  it('counts form feeds as page breaks, so quality can judge the pages', async () => {
    const result = await externalExtractor(spec(PAGES)).extract(bytes('x'), context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pages).toBe(2);
  });

  it('kills a command that outruns its budget, and still settles', async () => {
    const started = Date.now();
    const result = await externalExtractor(spec(SLEEPY, { timeoutMs: 250 })).extract(
      bytes('x'),
      context(),
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not finish within 250 ms');
    expect(elapsed).toBeLessThan(5_000);
  });

  it('follows SIGTERM with SIGKILL when the child declines to die', async () => {
    const started = Date.now();
    const result = await externalExtractor(spec(STUBBORN, { timeoutMs: 200 })).extract(
      bytes('x'),
      context(),
    );
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    // SIGTERM was ignored, so only the two-second SIGKILL grace can have
    // ended this run.
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('stops reading at the byte cap and kills the child mid-flood', async () => {
    const marker = join(dir, 'flood.marker');
    const extractor = externalExtractor(spec(FLOOD, { args: [FLOOD, marker] }));

    const result = await extractor.extract(bytes('x'), context({ maxChars: 64 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('A'.repeat(64));
    expect(existsSync(marker)).toBe(true);
  });

  it('survives a child that exits before reading its stdin', async () => {
    // A megabyte written at a closed pipe: the EPIPE must not leave this
    // process, and the output the child managed to print still comes back.
    const result = await externalExtractor(spec(DEAF)).extract(
      bytes('P'.repeat(1024 * 1024)),
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('done');
  });

  it('hands the child a minimal environment, not the proxy credentials', async () => {
    process.env.HUSHGATE_TEST_SECRET = 'sk-must-not-leak';
    process.env.OPENAI_API_KEY = 'sk-also-must-not-leak';

    try {
      const result = await externalExtractor(spec(ENVIRONMENT)).extract(bytes('x'), context());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.text).not.toContain('must-not-leak');
      expect(result.value.text).toContain('secret=absent');
      expect(result.value.text).toContain('openai=absent');
      expect(result.value.text).toContain('path=set');
      expect(result.value.text).toContain('locale=C.UTF-8');
    } finally {
      delete process.env.HUSHGATE_TEST_SECRET;
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('reports a command that does not exist instead of throwing', async () => {
    const result = await externalExtractor(
      spec(ECHO, { command: join(dir, 'no-such-binary'), args: [] }),
    ).extract(bytes('x'), context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('could not start');
    expect(result.reason).toContain('ENOENT');
  });

  it('accepts the media types and formats it was configured with, and nothing else', () => {
    const extractor = externalExtractor(
      spec(ECHO, { mediaTypes: ['application/pdf'], formats: ['pdf'] }),
    );

    expect(extractor.supports('pdf', 'application/pdf')).toBe(true);
    expect(extractor.supports('pdf', 'APPLICATION/PDF; charset=binary')).toBe(true);
    expect(extractor.supports('pdf', null)).toBe(true);
    expect(extractor.supports('docx', 'application/msword')).toBe(false);
    expect(extractor.supports('unknown', null)).toBe(false);
  });
});

describe('what a failing extractor is allowed to say', () => {
  // The reason reaches AttachmentReport.reason, the audit trail and the HTTP
  // 422 body. poppler quotes the bytes it choked on, so anything copied out of
  // stderr is document content written into the evidence file.
  it('does not quote the child stderr when the command fails', async () => {
    const result = await externalExtractor(spec(LEAKY)).extract(bytes('x'), context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(FAKE_IBAN);
    expect(result.reason).not.toContain('370400440532');
    expect(result.reason).toContain('exited with status 1');
  });

  it('does not quote it when the command succeeds but prints nothing', async () => {
    const result = await externalExtractor(spec(LEAKY_SILENT)).extract(bytes('x'), context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).not.toContain(FAKE_IBAN);
    expect(result.reason).toContain('produced no output');
  });
});

const pipesNow = (): number =>
  process.getActiveResourcesInfo().filter((name) => name === 'PipeWrap').length;

describe('what a finished extraction leaves behind', () => {
  it('releases the pipes even when a grandchild keeps them open', async () => {
    // A shell wrapper that forks is the realistic case: the parent exits, the
    // grandchild inherits stdout, and a proxy that waits for `close` before
    // letting go of the handles accumulates two per request until it runs out
    // of descriptors.
    const forking = externalExtractor({
      mediaTypes: ['text/plain'],
      formats: [],
      command: '/bin/sh',
      args: ['-c', 'sleep 30 & cat'],
      timeoutMs: 2000,
    });

    await forking.extract(bytes('warm up'), context());
    const before = pipesNow();

    for (let round = 0; round < 6; round += 1) {
      // Sequential on purpose: the count only means something if the previous
      // extraction has already settled.
      // oxlint-disable-next-line no-await-in-loop
      await forking.extract(bytes('Anna Schmidt'), context());
    }

    expect(pipesNow()).toBeLessThanOrEqual(before);
  });

  it('settles once when the child never reads stdin and never exits', async () => {
    const result = await externalExtractor({ ...spec(IDLE), timeoutMs: 300 }).extract(
      bytes('x'.repeat(200_000)),
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not finish');
  });
});

describe('probeCommand', () => {
  it('finds the version of a command that is installed', async () => {
    const probe = await probeCommand(process.execPath);

    expect(probe.available).toBe(true);
    expect(probe.version).toMatch(/^\d+\.\d+/u);
  });

  it('reports a missing command as unavailable rather than throwing', async () => {
    const probe = await probeCommand(join(dir, 'no-such-binary'));

    expect(probe).toEqual({ available: false, version: null });
  });
});

describe('quality assessment', () => {
  const prose =
    'Sehr geehrte Frau Schmidt, anbei die Rechnung fuer den Monat Maerz. Mit freundlichen Gruessen.';

  it('accepts ordinary prose', () => {
    expect(assessText(prose, 1)).toEqual({ ok: true });
  });

  it('rejects the scanned PDF: one form feed across twelve pages', () => {
    const verdict = assessText('\f', 12);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe(
      'extracted only 0 characters from 12 pages, which is not a readable document',
    );
  });

  it('names the count of non-whitespace characters when the page count is unknown', () => {
    // Eleven letters and a space: padding a document with blanks must not
    // lift it over the floor.
    const verdict = assessText('Anna Schmidt', null);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('extracted only 11 characters, which is not a readable document');
  });

  it('rejects a document that clears the floor but not the floor per page', () => {
    const verdict = assessText('a'.repeat(40), 12);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('40 characters from 12 pages');
    expect(verdict.reason).toContain('3.3 per page');
    expect(verdict.reason).toContain('below the floor of 8');
  });

  it('rejects text that is mostly the replacement character', () => {
    const verdict = assessText('a'.repeat(80) + '\uFFFD'.repeat(20), null);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe(
      '20% of the extracted text is the Unicode replacement character, above the limit of 10%',
    );
  });

  it('rejects text that is mostly control characters', () => {
    const verdict = assessText('abcdefghijklmnopqrst' + '\u0001'.repeat(40), null);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('66.7% of the extracted text is control characters');
    expect(verdict.reason).toContain('above the limit of 30%');
  });

  it('does not count tabs, newlines or carriage returns as control characters', () => {
    expect(assessText('spalte\teins\r\nspalte\tzwei\r\nspalte\tdrei\r\n', null)).toEqual({
      ok: true,
    });
  });

  it('treats a page count of zero as no page count at all', () => {
    expect(assessText(prose, 0)).toEqual({ ok: true });
  });

  it('honours limits the operator overrode, and ignores ones left undefined', () => {
    expect(assessText('kurz', null, { minChars: 4 })).toEqual({ ok: true });
    expect(assessText('kurz', null, { minChars: undefined }).ok).toBe(false);
  });
});
