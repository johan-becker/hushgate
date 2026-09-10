/**
 * `hushgate briefing` — show, exactly, what hushgate tells the model.
 *
 * hushgate adds a paragraph to somebody else's request. That is a defensible
 * thing to do and an indefensible thing to do quietly, so the text is printable
 * on demand: this is the command an engineer runs when an answer looks wrong,
 * and the command whose output goes into the ticket when a DPO asks what else
 * left the machine besides the pseudonymised prompt.
 *
 * It reads the configuration and nothing else. No request is made, no key is
 * needed, and it works with the cable pulled out.
 */
import { briefingFor, type BriefingConfig } from '../../briefing/index.js';
import { loadConfig, type HushgateConfig } from '../../config.js';
import { UsageError } from '../../errors.js';
import { normaliseKindName } from '../../detectors/custom.js';
import type { Finding, Policy } from '../../types.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const BRIEFING_FLAGS: FlagSpecs = {
  config: {
    type: 'string',
    alias: 'c',
    description: 'path to hushgate.config.json',
    placeholder: '<path>',
  },
  tenant: {
    type: 'string',
    description: 'render the briefing this tenant would get',
    placeholder: '<id>',
  },
  kinds: {
    type: 'string',
    description: 'kinds to render it for, e.g. EMAIL,IBAN,SECRET:redact',
    placeholder: '<list>',
  },
  json: { type: 'boolean', description: 'machine-readable output' },
};

export const BRIEFING_SUMMARY = 'print what hushgate tells the model about the placeholders';

/** `EMAIL` or `SECRET:redact` — the kind, and how its value was replaced. */
const POLICIES: Readonly<Record<string, Policy>> = {
  pseudonymize: 'pseudonymize',
  redact: 'redact',
  hash: 'hash',
};

export function briefing(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, BRIEFING_FLAGS);
  const { config, source } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const profile = profileFor(config, stringFlag(parsed, 'tenant'));
  const findings = findingsFrom(stringFlag(parsed, 'kinds'));

  // `always`, so that `--kinds` with nothing in it still shows the words rather
  // than the empty string `auto` would correctly produce for a clean request.
  const text = briefingFor({ ...profile, mode: 'always' }, findings);
  const attached = briefingFor(profile, findings);

  if (boolFlag(parsed, 'json')) {
    cli.stdout(
      `${JSON.stringify(
        {
          config: source.path,
          tenant: stringFlag(parsed, 'tenant') ?? null,
          mode: profile.mode,
          origin: profile.text === null ? 'built-in' : 'custom',
          appended: profile.append !== null,
          attached: attached !== null,
          text,
        },
        null,
        2,
      )}\n`,
    );
    return Promise.resolve(EXIT.ok);
  }

  cli.stdout(report(profile, source.path, stringFlag(parsed, 'tenant'), attached, text ?? ''));
  return Promise.resolve(EXIT.ok);
}

function report(
  profile: BriefingConfig,
  configPath: string | null,
  tenant: string | undefined,
  attached: string | null,
  text: string,
): string {
  const lines = [
    'hushgate briefing',
    `  config   ${configPath ?? 'built-in defaults (no hushgate.config.json found)'}`,
    ...(tenant === undefined ? [] : [`  tenant   ${tenant}`]),
    `  mode     ${profile.mode}${profile.mode === 'off' ? '  — nothing is added to any request' : ''}`,
    `  text     ${profile.text === null ? 'the built-in briefing' : 'replaced by briefing.text'}`,
    `  append   ${profile.append === null ? 'none' : `${profile.append.length} characters of house rules`}`,
    '',
    attached === null
      ? '  Not attached to the request rendered below — in "auto" mode a request'
      : '  Attached to a request like the one below, after the caller\'s own system',
    attached === null
      ? '  with no placeholders in it is forwarded exactly as the caller wrote it.'
      : '  prompt and before the conversation.',
    '',
    '---',
    text,
    '---',
    '',
    'Override it with the "briefing" section of hushgate.config.json.',
    '',
  ];

  return lines.join('\n');
}

/** The briefing profile in force: the tenant's, or the global one. */
function profileFor(config: HushgateConfig, tenantId: string | undefined): BriefingConfig {
  if (tenantId === undefined) return config.briefing;

  const tenant = config.tenants.find((candidate) => candidate.id === tenantId);
  if (tenant === undefined) {
    const known = config.tenants.map((candidate) => candidate.id).join(', ');
    throw new UsageError(
      known === ''
        ? `no tenant "${tenantId}": this configuration has no tenants`
        : `no tenant "${tenantId}": known tenants are ${known}`,
    );
  }

  return tenant.briefing;
}

/**
 * Stand-in findings for `--kinds`.
 *
 * Only `kind` and `policy` are read when the briefing is composed, so the rest
 * of a {@link Finding} is filled with something obviously inert. Nothing here
 * ever touches a real value — the point of the command is that it needs none.
 */
function findingsFrom(list: string | undefined): Finding[] {
  if (list === undefined || list.trim() === '') return [];

  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const [name, policy = 'pseudonymize'] = entry.split(':');
      const resolved = POLICIES[policy];
      if (resolved === undefined) {
        throw new UsageError(
          `--kinds: "${policy}" is not a policy that produces a placeholder; use pseudonymize, redact or hash`,
        );
      }

      return {
        kind: normaliseKindName(name ?? ''),
        policy: resolved,
        placeholder: null,
        start: 0,
        end: 0,
        value: '',
        detector: 'briefing',
        priority: 0,
      } satisfies Finding;
    });
}
