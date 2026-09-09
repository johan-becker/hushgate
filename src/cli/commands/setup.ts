/**
 * `hushgate setup` — from nothing to either a working configuration or a
 * demonstration, in one command.
 *
 * The rule for what it asks: only what hushgate cannot find out for itself.
 * The jurisdiction it reads from its own registry, the extractor it looks up on
 * PATH, the port it can probe. That leaves the provider, which is a genuine
 * decision, and a handful of details that are nobody's business but the
 * operator's.
 *
 * It deliberately does not insist on a legal basis. That is the one answer an
 * operator does not have at the keyboard, and blocking on it is how a tool ends
 * up abandoned at step two. The file is written without an allowlist, and the
 * doctor run printed underneath says exactly what is missing and where it goes.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as joinPath } from 'node:path';
import { buildExtractors, sniffFormat } from '../../attach/index.js';
import { CONFIG_FILENAME, defaultConfig, loadConfig, type HushgateConfig } from '../../config.js';
import { runChecks, tally, type Severity } from '../../doctor/checks.js';
import { HushgateError } from '../../errors.js';
import { jurisdiction } from '../../residency/jurisdictions.js';
import { TrialStore, type DroppedFile, type PlaygroundEndpoint } from '../../playground/index.js';
import { createProxyServer } from '../../proxy/server.js';
import { proxyableEndpoints, type EndpointEntry } from '../../residency/registry.js';
import { boolFlag, intFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';
import type { Choice, Prompter } from '../prompt.js';
import { untilStopped } from '../stop.js';
import { renderConfig, type SetupAnswers } from '../template.js';

export const SETUP_FLAGS: FlagSpecs = {
  path: {
    type: 'string',
    alias: 'p',
    description: 'where to write the configuration',
    placeholder: '<path>',
  },
  force: { type: 'boolean', alias: 'f', description: 'overwrite an existing configuration' },
  host: {
    type: 'string',
    alias: 'H',
    description: 'address the trial binds (loopback only)',
    placeholder: '<host>',
  },
  port: { type: 'number', description: 'port the trial binds', placeholder: '<port>' },
};

export const SETUP_SUMMARY = 'answer a few questions to set hushgate up, or try it out';

const MARKS: Readonly<Record<Severity, string>> = {
  ok: 'ok  ',
  note: 'note',
  warn: 'warn',
  fail: 'FAIL',
};

export async function setup(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SETUP_FLAGS);

  const open = cli.prompt;
  if (open === undefined) {
    throw new HushgateError(
      'setup needs a terminal to ask questions; for scripts and CI use "hushgate init"',
    );
  }

  const prompter = open();
  try {
    cli.stdout('\n  hushgate setup. Nothing personal leaves this machine.\n\n');

    const mode = await prompter.choose('What would you like to do?', [
      {
        label: 'Try it',
        hint: '— see in a minute what the provider would receive',
        value: 'trial',
      },
      { label: 'Set it up', hint: '— write a configuration for real use', value: 'config' },
    ]);

    const endpoint = await chooseProvider(prompter);

    if (mode === 'trial') {
      return await runTrial(cli, prompter, parsed, endpoint);
    }

    return await writeConfiguration(cli, prompter, parsed, endpoint);
  } finally {
    prompter.close();
  }
}

/** The provider question. Endpoints inside the EEA come first. */
async function chooseProvider(prompter: Prompter): Promise<EndpointEntry> {
  const choices: Choice<EndpointEntry>[] = proxyableEndpoints().map((entry) => ({
    label: entry.label,
    hint: describeJurisdiction(entry),
    value: entry,
  }));

  return await prompter.choose('Which provider?', choices);
}

/** `FR`, or `US — third country`: the part that decides what has to be justified. */
function describeJurisdiction(entry: EndpointEntry): string {
  return jurisdiction(entry.jurisdiction).status === 'third-country'
    ? `${entry.jurisdiction} — third country`
    : entry.jurisdiction;
}

/** Loopback, and nothing else. */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * The trial: two questions, then a page showing the whole round trip.
 *
 * Nothing is written and nothing is read. The configuration is
 * `defaultConfig()` with the chosen upstream patched in, held in memory for as
 * long as the process runs, so trying hushgate out cannot leave a half-answered
 * file behind for someone to find later and trust.
 *
 * The key lives in this function's scope. It reaches the provider through the
 * playground's own request and goes nowhere else: not into the configuration,
 * not into the audit trail, not into the page, and not into anything printed.
 */
async function runTrial(
  cli: Cli,
  prompter: Prompter,
  parsed: ReturnType<typeof parseFlags>,
  entry: EndpointEntry,
): Promise<number> {
  const host = stringFlag(parsed, 'host') ?? '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new HushgateError(
      'a trial binds to loopback only: it serves a page that turns placeholders back into personal data',
    );
  }

  if (entry.baseUrl === undefined || entry.api === undefined || entry.trialModel === undefined) {
    throw new HushgateError(`${entry.label} cannot be used as an upstream`);
  }

  const apiKey = await prompter.text(
    `API key for ${entry.label} (stays in this process; written nowhere)`,
    { required: true },
  );

  if (apiKey === '') {
    throw new HushgateError('a trial needs an API key for the provider you picked');
  }

  const endpoint: PlaygroundEndpoint = {
    label: entry.label,
    baseUrl: entry.baseUrl,
    api: entry.api,
    trialModel: entry.trialModel,
  };

  const config: HushgateConfig = {
    ...defaultConfig(),
    host,
    // 0 means the OS picks, and the banner prints what it picked — a trial
    // that fails on a busy port is a trial nobody sees.
    port: intFlag(parsed, 'port', { min: 0, max: 65_535 }) ?? 0,
    upstreams: { openai: entry.baseUrl, anthropic: entry.baseUrl },
  };

  const proxy = createProxyServer({
    config,
    playground: {
      store: new TrialStore(),
      apiKey,
      endpoint,
      dictionaryIsEmpty: true,
      extract: extractorFor(config),
    },
  });

  await proxy.listen();
  const origin = proxy.origin ?? `http://${host}:${config.port}`;

  cli.stdout(
    [
      '',
      `  ${origin}/__playground`,
      '',
      `  Paste a real document. Nothing reaches ${entry.label} until you press`,
      '  Send, and what it receives is what the second box shows.',
      '',
      '  Stop with Ctrl-C. Nothing is written to disk.',
      '',
      '',
    ].join('\n'),
  );

  await untilStopped(cli.signal);
  await proxy.close();
  return EXIT.ok;
}

/**
 * Turn a dropped document into text with the extractors the configuration
 * names — the same chain the proxy uses for an attachment, including the
 * operator's own PDF tool.
 */
function extractorFor(config: HushgateConfig): (file: DroppedFile) => Promise<string> {
  const extractors = buildExtractors(config.attachments.extractors);

  return async (file) => {
    const format = sniffFormat(file.bytes, file.mediaType, file.filename);
    const extractor = extractors.find((candidate) => candidate.supports(format, file.mediaType));
    if (extractor === undefined) throw new HushgateError(`no extractor handles ${format}`);

    const result = await extractor.extract(file.bytes, {
      format,
      mediaType: file.mediaType,
      maxChars: config.attachments.maxTextChars,
      timeoutMs: config.attachments.timeoutMs,
    });

    // An extractor that explains itself is still a document hushgate could not
    // read, and the trial refuses it rather than showing the operator a page
    // with nothing in the second box.
    if (!result.ok) throw new HushgateError(result.reason);
    return result.value.text;
  };
}

async function writeConfiguration(
  cli: Cli,
  prompter: Prompter,
  parsed: ReturnType<typeof parseFlags>,
  endpoint: EndpointEntry,
): Promise<number> {
  const target = stringFlag(parsed, 'path') ?? CONFIG_FILENAME;
  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);

  if (existsSync(path) && !boolFlag(parsed, 'force')) {
    throw new HushgateError(`${path} already exists; pass --force to overwrite it`);
  }

  const name = await prompter.text('Company (optional)');
  const contact = await prompter.text('Contact for data protection questions (optional)');
  const dpo = await prompter.text('Data protection officer (optional)');
  const purpose = await prompter.text('What you will use the model for, one line (optional)');
  const legalBasis = await prompter.text(
    `Legal basis for sending data to ${endpoint.hosts[0] ?? endpoint.label} (optional)`,
  );

  const answers: SetupAnswers = {
    organisation: {
      ...(name === '' ? {} : { name }),
      ...(contact === '' ? {} : { contact }),
      ...(dpo === '' ? {} : { dpo }),
      ...(purpose === '' ? {} : { purposes: [purpose] }),
    },
    upstreams: upstreamsFor(endpoint),
    ...(legalBasis === '' || endpoint.baseUrl === undefined
      ? {}
      : {
          allow: [
            {
              endpoint: endpoint.baseUrl,
              jurisdiction: endpoint.jurisdiction,
              legalBasis,
            },
          ],
        }),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderConfig(answers), 'utf8');
  cli.stdout(
    `\n  wrote ${path}\n` +
      `  Both routes forward to ${endpoint.label}; add a second provider to\n` +
      `  residency.allow with its own legal basis when you have one.\n\n`,
  );

  reportOnIt(cli, path);
  return EXIT.ok;
}

/**
 * Point *both* routes at the chosen provider.
 *
 * Leaving the other route on its default looks tidier and does not work: the
 * residency check is fail-closed and looks at every configured upstream, not
 * only the ones a client happens to call. So a config naming a provider the
 * operator never assessed refuses to start — `hushgate will not start; fix
 * residency.allow or the upstream`, on a file the wizard just wrote.
 *
 * One provider was chosen, so everything goes there. A second provider means a
 * second allowlist entry with its own legal basis, which is an edit the
 * operator makes deliberately rather than one the wizard guesses at.
 */
export function upstreamsFor(entry: EndpointEntry): { openai?: string; anthropic?: string } {
  if (entry.baseUrl === undefined) return {};
  return { openai: entry.baseUrl, anthropic: entry.baseUrl };
}

/**
 * Run the doctor checks in place.
 *
 * Only what needs doing is printed: an operator who has just answered five
 * questions does not need eight lines confirming that the defaults are the
 * defaults. `hushgate doctor` remains the whole report.
 */
function reportOnIt(cli: Cli, configPath: string): void {
  const { config, source } = loadConfig({ path: configPath, cwd: cli.cwd, env: cli.env });
  const findings = runChecks({
    config,
    configPath: source.path,
    auditPath: isAbsolute(config.audit.path)
      ? config.audit.path
      : joinPath(cli.cwd, config.audit.path),
  });

  const lines: string[] = ['  doctor'];
  for (const finding of findings) {
    if (finding.severity === 'ok' || finding.severity === 'note') continue;
    lines.push(`    ${MARKS[finding.severity]}  ${finding.message}`);
    if (finding.remedy !== undefined) lines.push(`          → ${finding.remedy}`);
  }

  const counts = tally(findings);
  lines.push(
    counts.fail + counts.warn === 0
      ? '    nothing unsafe found'
      : '    "hushgate doctor" prints the whole report',
    '',
    '  Start it with:  hushgate serve',
    '',
  );

  cli.stdout(`${lines.join('\n')}\n`);
}
