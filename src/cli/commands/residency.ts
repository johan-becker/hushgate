/**
 * `hushgate residency` — where does this actually send our data?
 *
 * This is the command an engineer runs and pastes into a ticket when their DPO
 * asks. It resolves every route against the configuration and the registry and
 * prints the upstream, the operator, the jurisdiction, the rule that permitted
 * it, the legal basis recorded for it and the retention controls in force. It
 * exits non-zero when any route is refused, so it also works in CI.
 */
import { loadConfig } from '../../config.js';
import { ROUTES } from '../../proxy/routes.js';
import { applyDataControls } from '../../residency/controls.js';
import { enforcementFor, evaluateUpstream, type ResidencyVerdict } from '../../residency/policy.js';
import { BUILTIN_ENDPOINTS } from '../../residency/registry.js';
import { jurisdiction } from '../../residency/jurisdictions.js';
import type { HushgateConfig } from '../../config.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const RESIDENCY_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  json: { type: 'boolean', description: 'machine-readable output' },
  registry: { type: 'boolean', description: 'list the known endpoints and their jurisdictions' },
};

export const RESIDENCY_SUMMARY = 'show where each route sends data, and on whose authority';

export function residency(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, RESIDENCY_FLAGS);

  if (boolFlag(parsed, 'registry')) {
    cli.stdout(boolFlag(parsed, 'json') ? `${JSON.stringify(registryReport(), null, 2)}\n` : registryTable());
    return Promise.resolve(EXIT.ok);
  }

  const { config, source } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
  });

  const rows = ROUTES.map((route) => {
    const upstream =
      route.provider === 'openai' ? config.upstreams.openai : config.upstreams.anthropic;
    const verdict = evaluateUpstream(upstream, config.residency);
    const decision = enforcementFor(config.residency, route.label, []);
    const controls = applyDataControls(verdict.dataControls, {});

    return { route, verdict, decision, controls };
  });

  const refused = rows.filter((row) => !row.verdict.permitted).length;

  if (boolFlag(parsed, 'json')) {
    cli.stdout(`${JSON.stringify(jsonReport(config, source.path, rows), null, 2)}\n`);
  } else {
    cli.stdout(textReport(source.path, rows, refused));
  }

  return Promise.resolve(refused === 0 ? EXIT.ok : EXIT.failure);
}

type Row = {
  route: (typeof ROUTES)[number];
  verdict: ResidencyVerdict;
  decision: { mode: string; rule: string };
  controls: { applied: readonly string[]; manual: readonly string[] };
};

function textReport(configPath: string | null, rows: readonly Row[], refused: number): string {
  const lines: string[] = [
    'hushgate residency',
    `  config       ${configPath ?? 'built-in defaults (no hushgate.config.json found)'}`,
    '',
  ];

  for (const { route, verdict, decision, controls } of rows) {
    const where = verdict.jurisdiction;
    const registry = verdict.registry;

    lines.push(
      `  route        ${route.label}  (POST ${route.path})`,
      `  upstream     ${verdict.upstream}`,
      `  endpoint     ${registry === null ? 'not in the registry' : `${registry.entry.label} — ${registry.entry.operator}`}`,
      `  jurisdiction ${where.code} — ${where.name} [${where.status}]`,
      `               ${where.note}`,
      `  rule         ${verdict.rule}`,
      `  legal basis  ${verdict.legalBasis ?? 'none recorded'}`,
      `  enforcement  ${decision.mode}  (${decision.rule})`,
      `  controls     ${describeControls(controls)}`,
      `  verdict      ${verdict.permitted ? 'PERMITTED' : 'REFUSED'} — ${verdict.reason}`,
      '',
    );
  }

  lines.push(
    refused === 0
      ? `${rows.length} of ${rows.length} routes permitted.`
      : `${refused} of ${rows.length} routes REFUSED — hushgate will not start with this configuration.`,
    '',
    'This is a technical control, not legal advice. See the README.',
    '',
  );

  return lines.join('\n');
}

function describeControls(controls: {
  applied: readonly string[];
  manual: readonly string[];
}): string {
  const parts = [
    ...controls.applied.map((entry) => `${entry} [set per request]`),
    ...controls.manual.map((entry) => `${entry} [arranged with the provider]`),
  ];
  return parts.length === 0 ? 'none documented' : parts.join('\n               ');
}

function jsonReport(
  config: HushgateConfig,
  configPath: string | null,
  rows: readonly Row[],
): unknown {
  return {
    config: configPath,
    mode: config.residency.mode,
    routes: rows.map(({ route, verdict, decision, controls }) => ({
      route: route.label,
      path: route.path,
      upstream: verdict.upstream,
      endpoint: verdict.registry?.entry.id ?? null,
      operator: verdict.registry?.entry.operator ?? null,
      jurisdiction: {
        code: verdict.jurisdiction.code,
        name: verdict.jurisdiction.name,
        status: verdict.jurisdiction.status,
      },
      rule: verdict.rule,
      legalBasis: verdict.legalBasis,
      enforcement: decision,
      controls: { applied: controls.applied, manual: controls.manual },
      permitted: verdict.permitted,
      reason: verdict.reason,
    })),
    permitted: rows.every((row) => row.verdict.permitted),
  };
}

function registryReport(): unknown {
  return {
    endpoints: BUILTIN_ENDPOINTS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      operator: entry.operator,
      hosts: entry.hosts,
      jurisdiction: entry.jurisdiction,
      status: jurisdiction(entry.jurisdiction).status,
      dataControls: entry.dataControls.map((control) => `${control.kind} (${control.mechanism})`),
      note: entry.note,
    })),
  };
}

function registryTable(): string {
  const rows = BUILTIN_ENDPOINTS.map((entry) => {
    const where = jurisdiction(entry.jurisdiction);
    return [`${where.code}`, `${entry.label}`, entry.hosts.join(', ')] as const;
  });

  const codeWidth = Math.max(...rows.map(([code]) => code.length));
  const labelWidth = Math.max(...rows.map(([, label]) => label.length));

  const lines = [
    'known endpoints (offline registry — extend it with residency.endpoints)',
    '',
    ...rows.map(
      ([code, label, hosts]) => `  ${code.padEnd(codeWidth)}  ${label.padEnd(labelWidth)}  ${hosts}`,
    ),
    '',
    'Jurisdictions are where the operator documents the service as running.',
    'Confirm them against your own contract before relying on them.',
    '',
  ];

  return lines.join('\n');
}
