/**
 * Extraction by an operator-configured child process.
 *
 * The built-in tier reads only what hushgate can parse with zero dependencies,
 * which leaves PDF and the long tail to tools the operator already trusts on
 * their own machine. Handing an attachment to `pdftotext` is, however, the
 * moment this proxy stops being a pure function: it becomes a second process
 * holding hushgate's environment, hushgate's memory and no clock of its own.
 * Everything here exists to take those three back — a built-up environment
 * rather than an inherited one, a byte budget enforced while the child writes
 * instead of after it has finished, and a wall clock that ends in SIGKILL.
 *
 * The rule that outranks the rest: nothing derived from the request ever
 * reaches argv. Command and arguments come from configuration only. `pdftotext`
 * reads a leading `-` as a flag, so an attachment named `-layout` spliced into
 * the argument list is consumed as an option and the extraction returns empty
 * output at exit code 0 — an attacker-chosen truncation that looks exactly like
 * a document with nothing in it. Content goes on stdin, always, only.
 */
import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { basename, extname } from 'node:path';
import type { AttachmentFormat, ExternalExtractorSpec, ExtractionContext, ExtractionResult, Extractor } from './types.js';

/** How long a child that ignored SIGTERM gets before it is not asked again. */
const SIGKILL_GRACE_MS = 2_000;

/** Enough stderr to name a misconfiguration, not enough to be a side channel. */
const STDERR_LIMIT_BYTES = 4 * 1024;

/** Ceiling on any configured budget; a `timeoutMs` of `Infinity` is a typo. */
const MAX_TIMEOUT_MS = 10 * 60_000;

/**
 * How long to wait for the stdio pipes after the child itself is gone. `close`
 * fires only once every pipe is closed, and a grandchild that inherited stdout
 * can hold one open indefinitely — which would leave the promise pending and
 * the request hanging, the one outcome this module may never produce.
 */
const FLUSH_GRACE_MS = 1_000;

/** `hushgate doctor` runs on an operator's terminal, not in a request. */
const PROBE_TIMEOUT_MS = 2_000;
const PROBE_STDOUT_LIMIT_BYTES = 64 * 1024;

// The spec itself lives in ./types.js: the config layer validates it, and must
// be able to do so without importing node:child_process.
export type { ExternalExtractorSpec };

/**
 * The child's entire environment.
 *
 * hushgate's own process holds provider credentials — `OPENAI_API_KEY` is the
 * whole point of the product — and a text extractor has no business seeing
 * them. So the environment is built up rather than filtered down: whatever
 * secret an operator adds to their systemd unit next year is excluded already.
 */
const childEnvironment = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  // Extractors pick their output encoding from the locale, and everything
  // below assumes UTF-8; the operator's own locale is not consulted.
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

// Non-fatal on purpose. Invalid bytes become U+FFFD instead of an exception,
// and quality.ts counts them: a wrongly guessed encoding is then reported as
// unreadable rather than raised as a crash in the middle of a request.
const decoder = new TextDecoder('utf-8', { fatal: false });
const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    if ('code' in error && typeof error.code === 'string') return error.code;
    return error.message;
  }
  return 'unknown error';
};

interface RunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: Uint8Array;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

interface RunOutcome {
  readonly stdout: Uint8Array;
  /** True when the byte cap ended the output, rather than the child. */
  readonly truncated: boolean;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** Set when the process never started; every other field is then empty. */
  readonly startError: string | null;
}

/**
 * Run one child to completion, or to the end of its budget.
 *
 * Resolves exactly once and never rejects: a failed extraction is an answer,
 * not an exception, and the caller turns this into a reason string.
 */
/** Drop a pipe, whether or not it was ever opened or is already gone. */
const release = (stream: { destroy: () => void } | null): void => {
  stream?.destroy();
};

const runChild = async (request: RunRequest): Promise<RunOutcome> => {
  let child: ChildProcess;

  try {
    // argv is `request.args` and nothing else — see the note at the top of the
    // file. `shell: false` is the default and is stated anyway, because the
    // day someone adds an option object without it is the day a filename
    // becomes a command line.
    child = spawn(request.command, request.args, {
      shell: false,
      env: childEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return {
      stdout: new Uint8Array(0),
      truncated: false,
      stderr: '',
      code: null,
      signal: null,
      timedOut: false,
      startError: errorText(error),
    };
  }

  return await new Promise<RunOutcome>((resolve) => {
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let startError: string | null = null;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;

    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const terminate = (): void => {
      if (settled || killTimer !== null) return;
      child.kill('SIGTERM');
      // SIGTERM is a request. macOS has no `timeout(1)` to fall back on, so the
      // guarantee is made here: a child that installs a handler and declines to
      // die would otherwise hold a request open for as long as it liked.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.min(request.timeoutMs, MAX_TIMEOUT_MS));

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer !== null) clearTimeout(killTimer);
      if (flushTimer !== null) clearTimeout(flushTimer);
      // Closing the pipes is what actually returns the descriptors. Waiting
      // for `close` does not: a grandchild that inherited stdout holds it
      // open, so the flush grace settles the request while two handles stay in
      // this process for as long as the grandchild lives. Every buffered chunk
      // has already been read into `stdoutChunks`/`stderrChunks`, so there is
      // nothing left to lose, and `destroy()` on an already-destroyed stream is
      // a no-op.
      release(child.stdout);
      release(child.stderr);
      release(child.stdin);
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        truncated,
        stderr: decodeUtf8(Buffer.concat(stderrChunks)),
        code: exitCode,
        signal: exitSignal,
        timedOut,
        startError,
      });
    };

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = request.maxStdoutBytes - stdoutBytes;
        if (chunk.length > room) {
          if (room > 0) {
            stdoutChunks.push(chunk.subarray(0, room));
            stdoutBytes += room;
          }
          truncated = true;
          // Capping after the fact is no cap at all: a child that writes for
          // ever fills this process's heap long before it exits.
          terminate();
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      });
      child.stdout.on('error', () => {
        // A pipe torn down by our own kill. There is nothing left to read.
      });
    }

    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer) => {
        const room = STDERR_LIMIT_BYTES - stderrBytes;
        if (room <= 0) return;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      });
      child.stderr.on('error', () => {
        // As above: diagnostics are best effort, never a failure of their own.
      });
    }

    if (child.stdin !== null) {
      // A child that exits before reading its input closes this pipe, and the
      // EPIPE that follows arrives as an 'error' event. Unhandled, it is an
      // uncaught exception — the proxy dies because an extractor was quick.
      child.stdin.on('error', () => {
        // Swallowed deliberately; the child's own exit is the real signal.
      });
      child.stdin.end(request.input);
    }

    child.on('error', (error: Error) => {
      startError = errorText(error);
      finish();
    });

    child.on('exit', (code: number | null, signal: string | null) => {
      exitCode = code;
      exitSignal = signal;
      flushTimer = setTimeout(finish, FLUSH_GRACE_MS);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;
      finish();
    });
  });
};

/** `/usr/local/bin/pdftotext` reads better as `pdftotext` in an audit line. */
const commandLabel = (command: string): string => {
  const base = basename(command);
  const extension = extname(base);
  const label = extension.length > 0 ? base.slice(0, -extension.length) : base;
  return label.length > 0 ? label : 'command';
};

const normaliseMediaType = (mediaType: string): string => {
  const [type = ''] = mediaType.split(';', 1);
  return type.trim().toLowerCase();
};

/**
 * Cut to the character budget without ending on a lone surrogate: half a pair
 * decodes to U+FFFD everywhere downstream, which quality.ts would then read as
 * a botched encoding rather than as our own scissors.
 */
const clampChars = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * Page count from page breaks.
 *
 * The text tier of every PDF and PostScript tool separates pages with U+000C,
 * and this is the only page signal a pipe carries. It matters more than it
 * looks: without a page count, quality.ts cannot tell twelve scanned pages
 * apart from one thin one, and the scanned document goes through.
 */
const countPages = (text: string): number | null => {
  let feeds = 0;
  for (let index = text.indexOf('\f'); index !== -1; index = text.indexOf('\f', index + 1)) {
    feeds += 1;
  }
  if (feeds === 0) return null;
  return text.endsWith('\f') ? feeds : feeds + 1;
};

/**
 * Build an extractor that shells out to `spec.command`.
 *
 * The returned extractor is stateless; every attachment gets its own process,
 * its own budget and its own environment.
 */
export function externalExtractor(spec: ExternalExtractorSpec): Extractor {
  const label = commandLabel(spec.command);
  const name = `external.${label}`;
  const mediaTypes = new Set(spec.mediaTypes.map((type) => normaliseMediaType(type)));
  const formats = new Set<AttachmentFormat>(spec.formats ?? []);

  return {
    name,

    supports(format: AttachmentFormat, mediaType: string | null): boolean {
      // Media type first because it is what the caller actually declared; the
      // format list is the fallback for `application/octet-stream` and friends,
      // where sniffing knows more than the header does.
      if (mediaType !== null && mediaTypes.has(normaliseMediaType(mediaType))) return true;
      return formats.has(format);
    },

    async extract(bytes: Uint8Array, context: ExtractionContext): Promise<ExtractionResult> {
      // Both budgets bind: the operator's for this tool, the request's for this
      // attachment. Whichever is tighter is the one that means anything.
      const budget = Math.max(1, Math.min(spec.timeoutMs, context.timeoutMs));
      const maxChars = Math.max(1, Math.trunc(context.maxChars));

      const outcome = await runChild({
        command: spec.command,
        args: spec.args,
        input: bytes,
        timeoutMs: budget,
        // Four bytes per character is the worst UTF-8 can do, so anything past
        // this cannot contribute a character we would keep.
        maxStdoutBytes: maxChars * 4,
      });

      // Every reason below is the mechanical fact and nothing else. The child's
      // stderr is deliberately not quoted: poppler echoes the bytes it choked
      // on, so a malformed document would write its own contents into the
      // audit record and into the 422 body that goes back over the wire.
      // `outcome.stderr` is bounded and then dropped on purpose.
      if (outcome.startError !== null) {
        return { ok: false, reason: `could not start ${label}: ${outcome.startError}` };
      }

      // A child killed at the byte cap died by our hand, so its exit status
      // describes our decision rather than its own — and the text it managed
      // to write before that is exactly the text we asked for.
      if (!outcome.truncated) {
        if (outcome.timedOut) {
          return { ok: false, reason: `${label} did not finish within ${budget} ms and was killed` };
        }
        if (outcome.signal !== null) {
          return { ok: false, reason: `${label} was killed by ${outcome.signal}` };
        }
        if (outcome.code !== 0) {
          return { ok: false, reason: `${label} exited with status ${outcome.code ?? 'unknown'}` };
        }
      }

      if (outcome.stdout.length === 0) {
        return { ok: false, reason: `${label} produced no output` };
      }

      const text = clampChars(decodeUtf8(outcome.stdout), maxChars);

      // The scanned-PDF signature: exit 0, one form feed per page, no words.
      // quality.ts is the deeper net for text that is present but not prose.
      if (text.trim().length === 0) {
        return { ok: false, reason: `${label} produced only whitespace, so nothing was read` };
      }

      return { ok: true, value: { text, pages: countPages(text), extractor: name } };
    },
  };
}

/** A version anywhere in a banner: `pdftotext version 24.02.0`, `v22.14.0`. */
const VERSION_PATTERN = /\b\d+(?:\.\d+){1,3}\b/u;

/**
 * Ask whether a configured command is actually installed.
 *
 * For `hushgate doctor`, where a missing extractor must be reported as a
 * finding on the operator's terminal and never as a stack trace: a config that
 * names a tool nobody installed is the single most common way for attachment
 * handling to be silently absent in production.
 */
export async function probeCommand(
  command: string,
  args: readonly string[] = ['-v'],
): Promise<{ available: boolean; version: string | null }> {
  const outcome = await runChild({
    command,
    args,
    input: new Uint8Array(0),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxStdoutBytes: PROBE_STDOUT_LIMIT_BYTES,
  });

  if (outcome.startError !== null) return { available: false, version: null };

  // Tools disagree about where a version banner belongs; poppler prints it to
  // stderr, most others to stdout. Availability does not depend on the exit
  // status: a command that ran at all is installed, whatever it thought of the
  // arguments we gave it.
  const banner = `${decodeUtf8(outcome.stdout)}\n${outcome.stderr}`.slice(0, 4096);
  const match = VERSION_PATTERN.exec(banner);

  return { available: true, version: match?.[0] ?? null };
}
