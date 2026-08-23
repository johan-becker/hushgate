/**
 * `hushgate extract` — show exactly what a document becomes.
 *
 * The question an auditor asks about this feature is not "does it work", it is
 * "show me what you actually sent". This command answers it offline, on a file
 * of their choosing, without a request and without an upstream: the text that
 * would be inlined into the prompt, and then the same text with the redaction
 * profile applied, which is the version a provider would see.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve as joinPath } from 'node:path';
import { buildExtractors } from '../../attach/registry.js';
import { assessText } from '../../attach/quality.js';
import { mediaTypeForFormat, sniffFormat } from '../../attach/sniff.js';
import { formatBytes } from '../../attach/decode.js';
import { loadConfig, redactionOptions } from '../../config.js';
import { HushgateError, UsageError } from '../../errors.js';
import { Session } from '../../redact/session.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const EXTRACT_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  raw: { type: 'boolean', description: 'print the extracted text without pseudonymising it' },
  json: { type: 'boolean', description: 'machine-readable output' },
};

export const EXTRACT_SUMMARY = 'show the text a document would be sent as';

export async function extract(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, EXTRACT_FLAGS);
  const [target, ...rest] = parsed.positionals;

  if (target === undefined) throw new UsageError('hushgate extract needs a file');
  if (rest.length > 0) throw new UsageError('hushgate extract takes one file at a time');

  const { config } = loadConfig({ path: stringFlag(parsed, 'config'), cwd: cli.cwd, env: cli.env });
  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);

  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new HushgateError(`cannot read ${target}: ${(cause as Error).message}`, { cause });
  }

  const format = sniffFormat(bytes, null, target);
  const extractors = buildExtractors(config.attachments.extractors);
  const context = {
    format,
    // No caller declared anything here, so the type sniffing inferred stands in
    // for one — otherwise an extractor configured by media type, which is the
    // usual way, would never match a file named on the command line.
    mediaType: mediaTypeForFormat(format),
    maxChars: config.attachments.maxTextChars,
    timeoutMs: config.attachments.timeoutMs,
  };

  let reason = `no extractor handles ${format}`;
  for (const extractor of extractors) {
    if (!extractor.supports(format, null)) continue;
    // Sequential on purpose: the first extractor that produces trustworthy text
    // is the one the proxy would have used, so the rest must not run.
    // oxlint-disable-next-line no-await-in-loop
    const result = await extractor.extract(bytes, context);
    if (!result.ok) {
      reason = result.reason;
      continue;
    }

    const verdict = assessText(result.value.text, result.value.pages);
    if (!verdict.ok) {
      reason = verdict.reason;
      continue;
    }

    const raw = result.value.text;
    const session = new Session(redactionOptions(config));
    const { text, findings } = session.redact(raw);
    const shown = boolFlag(parsed, 'raw') ? raw : text;

    if (boolFlag(parsed, 'json')) {
      cli.stdout(
        `${JSON.stringify(
          {
            file: target,
            format,
            bytes: bytes.byteLength,
            pages: result.value.pages,
            extractor: result.value.extractor,
            chars: raw.length,
            findings: countKinds(findings.map((finding) => finding.kind)),
            text: shown,
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.ok;
    }

    const count = result.value.pages;
    const pages = count === null ? '' : `, ${count} ${count === 1 ? 'page' : 'pages'}`;
    cli.stdout(
      `${target}\n  ${format}, ${formatBytes(bytes.byteLength)}${pages}, read by ${result.value.extractor}\n` +
        `  ${raw.length} characters, ${describe(findings.map((finding) => finding.kind))}\n\n${shown}\n`,
    );
    return EXIT.ok;
  }

  // Fail closed here too: `extract` must report exactly what the proxy would
  // do, and the proxy would refuse this file.
  cli.stderr(`hushgate: cannot extract ${target}: ${reason}\n`);
  return EXIT.failure;
}

function countKinds(kinds: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

function describe(kinds: readonly string[]): string {
  if (kinds.length === 0) return 'no personal data found';
  const counts = countKinds(kinds);
  const parts = Object.keys(counts)
    .toSorted()
    .map((kind) => `${kind} ${counts[kind]}`);
  return `${kinds.length} ${kinds.length === 1 ? 'finding' : 'findings'} (${parts.join(', ')})`;
}
