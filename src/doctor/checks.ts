/**
 * The checks behind `hushgate doctor`.
 *
 * Separated from the command so they can be tested as data rather than as
 * terminal output. Each check answers one question an operator would otherwise
 * only discover in production, and each one says what to do about it.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute as isAbsolutePath, join } from 'node:path';
import {
  configuredTrails,
  trailWriteProblem,
  type ConfiguredTrail,
  type TrailWriteProblem,
} from '../audit/paths.js';
import { parseAuditLines, printable } from '../audit/trail.js';
import { verifyTrail, verifyTrailFile, type TrailVerification } from '../audit/verify.js';
import type { HushgateConfig } from '../config.js';
import { leavesTheEea } from '../residency/jurisdictions.js';
import { evaluateUpstream } from '../residency/policy.js';
import { isLoopback } from '../tenants/tenant.js';

export type Severity = 'ok' | 'note' | 'warn' | 'fail';

export interface Finding {
  readonly section: string;
  readonly severity: Severity;
  readonly message: string;
  /** What to do about it, when there is something to do. */
  readonly remedy?: string;
}

export interface DoctorInput {
  readonly config: HushgateConfig;
  /** Absolute path of the config file that was read, or `null`. */
  readonly configPath: string | null;
  /**
   * The directory relative audit paths resolve against, as `serve` resolves
   * them. Defaults to the process's working directory.
   */
  readonly cwd?: string;
  /**
   * Absolute path of the global audit trail, when it is not `audit.path`
   * resolved against {@link cwd}. Tenant trails are always taken from the config.
   */
  readonly auditPath?: string;
  /**
   * Injected so the tests do not need a file on disk: the trail's text, or
   * `null` when there is none yet. It may throw, as reading the file would.
   */
  readonly readTrail?: (path: string) => string | null;
  /** Injected so the tests do not depend on the machine's file permissions. */
  readonly writeProblem?: (path: string) => TrailWriteProblem | null;
  /** Injected so the tests do not depend on what is installed on the machine. */
  readonly onPath?: (command: string) => boolean;
}

/** The sections, in the order they are reported. */
const SECTIONS: readonly (readonly [string, (input: DoctorInput) => Finding[]])[] = [
  ['configuration', configuration],
  ['briefing', briefing],
  ['residency', residency],
  ['enforcement', enforcement],
  ['security', security],
  ['attachments', attachments],
  ['audit', audit],
];

/**
 * Run every section, each on its own.
 *
 * A section that throws becomes a failure of that section rather than the end
 * of the run. doctor is the CI gate, and one check tripping over something
 * nobody anticipated — a trail in a shape no reader expected, a file system
 * that answers strangely — must not hide what every other section had to say,
 * nor turn the report into a stack trace.
 */
export function runChecks(input: DoctorInput): Finding[] {
  return SECTIONS.flatMap(([section, check]) => {
    try {
      return check(input);
    } catch (error) {
      return [
        {
          section,
          severity: 'fail' as const,
          message: `the ${section} checks could not finish: ${printable(messageOf(error))}`,
          remedy: 'fix what the message names and run doctor again; if it makes no sense, report it as a bug',
        },
      ];
    }
  });
}

/**
 * Whether documents are actually being read.
 *
 * The failure this section exists to catch is a quiet one. An operator enables
 * hushgate, points their application at it, and their users start attaching
 * PDFs. If no extractor can read a PDF, every one of those requests is refused
 * — which is safe, and which the operator will experience as "hushgate is
 * broken" rather than "hushgate has nothing to read PDFs with". So the state is
 * reported before it is discovered.
 */
function attachments({ config, onPath }: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const section = 'attachments';
  const { attachments: settings } = config;

  if (!settings.enabled) {
    out.push({
      section,
      severity: 'warn',
      message: 'attachment handling is off, so a document in a request is forwarded unread',
      remedy: 'set attachments.enabled to true unless you have another control in front of hushgate',
    });
    return out;
  }

  out.push({ section, severity: 'ok', message: 'attachment handling is on' });

  if (settings.onUnreadable === 'forward') {
    out.push({
      section,
      severity: 'fail',
      message:
        'attachments.onUnreadable is "forward", so a document hushgate cannot read is sent to the provider as it arrived',
      remedy: 'set it to "block" to refuse, or "withhold" to drop the file and forward the rest',
    });
  } else if (settings.onUnreadable === 'withhold') {
    out.push({
      section,
      severity: 'note',
      message: 'unreadable attachments are dropped from the request rather than refusing it',
    });
  }

  const handled = new Set(
    settings.extractors.flatMap((spec) => [...spec.mediaTypes, ...spec.formats]),
  );
  if (!handled.has('application/pdf') && !handled.has('pdf')) {
    out.push({
      section,
      severity: 'note',
      message: 'no extractor claims PDF, so PDF attachments will be refused rather than read',
      remedy:
        'add { "mediaTypes": ["application/pdf"], "command": "pdftotext", "args": ["-q", "-enc", "UTF-8", "-", "-"] } to attachments.extractors',
    });
  }

  // Whether the configured commands actually exist. A spec naming a command
  // that is not installed behaves correctly — the attachment is refused — but
  // the operator meant to have PDF support and should hear about it here
  // rather than from a user whose invoice was rejected.
  const lookup = onPath ?? isOnPath;
  for (const spec of settings.extractors) {
    if (lookup(spec.command)) {
      out.push({ section, severity: 'ok', message: `extractor ${spec.command} found on PATH` });
      continue;
    }
    // A note, not a warning: an extractor that is not installed makes hushgate
    // refuse those attachments, which is the safe direction. Nothing here is
    // unsafe — it is a capability the operator may or may not have meant to
    // have — so it must not make `doctor` exit non-zero.
    out.push({
      section,
      severity: 'note',
      message: `extractor ${spec.command} is configured but is not on PATH, so ${describeClaim(spec)} will be refused`,
      remedy:
        spec.command === 'pdftotext'
          ? 'install it with "apt install poppler-utils" or "brew install poppler"'
          : `install ${spec.command}, or remove it from attachments.extractors`,
    });
  }

  if (config.limits.maxBodyBytes < settings.maxBytes) {
    out.push({
      section,
      severity: 'warn',
      message: `limits.maxBodyBytes (${config.limits.maxBodyBytes}) is below attachments.maxBytes (${settings.maxBytes}), so the largest allowed attachment could never arrive`,
      remedy: 'raise limits.maxBodyBytes to at least attachments.maxBytes plus room for the prompt',
    });
  }

  return out;
}

/**
 * What the model is being told, and by whom.
 *
 * Every state here is a legitimate choice, so none of them fails or warns —
 * `doctor` exits non-zero on a warning and an operator who turned the briefing
 * off meant to. What the section is for is that all three states are
 * *invisible* at runtime: an answer that opens with "I cannot see the real
 * address" and an answer written to a house style both look like the model
 * misbehaving until you know which words hushgate put in front of it.
 */
function briefing({ config }: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const { mode, text, append } = config.briefing;

  out.push(
    mode === 'off'
      ? {
          section: 'briefing',
          severity: 'note',
          message:
            'no briefing is attached, so the model is never told what the placeholders are',
          remedy: 'set briefing.mode to "auto" if answers mention placeholders or invent values',
        }
      : {
          section: 'briefing',
          severity: 'ok',
          message:
            mode === 'auto'
              ? 'the model is briefed on the placeholders when a request carries any'
              : 'the model is briefed on the placeholders on every request',
        },
  );

  if (text !== null) {
    out.push({
      section: 'briefing',
      severity: 'note',
      message: `the built-in briefing is replaced by briefing.text (${text.length} characters)`,
      remedy: 'run "hushgate briefing" to see exactly what the model is told',
    });
  }

  if (append !== null) {
    out.push({
      section: 'briefing',
      severity: 'note',
      message: `briefing.append adds ${append.length} characters of house rules`,
      remedy: 'run "hushgate briefing" to see exactly what the model is told',
    });
  }

  const custom = config.tenants.filter(
    (tenant) =>
      tenant.briefing.mode !== mode ||
      tenant.briefing.text !== text ||
      tenant.briefing.append !== append,
  );
  if (custom.length > 0) {
    out.push({
      section: 'briefing',
      severity: 'note',
      message: `${custom.length} tenant(s) override the briefing: ${custom.map((tenant) => tenant.id).join(', ')}`,
      remedy: 'run "hushgate briefing --tenant <id>" to see each one',
    });
  }

  return out;
}

function configuration({ config, configPath }: DoctorInput): Finding[] {
  const out: Finding[] = [];

  out.push(
    configPath === null
      ? {
          section: 'configuration',
          severity: 'note',
          message: 'no hushgate.config.json found; running on built-in defaults',
          remedy: 'run "hushgate init" to write one',
        }
      : { section: 'configuration', severity: 'ok', message: `config file ${configPath}` },
  );

  if (config.redaction.defaultPolicy === 'allow') {
    out.push({
      section: 'configuration',
      severity: 'fail',
      message: 'the default policy is "allow", so nothing without an explicit policy is redacted',
      remedy: 'set redaction.defaultPolicy to pseudonymize',
    });
  }

  const hashed = Object.entries(config.redaction.policies).filter(([, policy]) => policy === 'hash');
  if (hashed.length > 0 && config.redaction.hmacKey === null) {
    out.push({
      section: 'configuration',
      severity: 'warn',
      message: `${hashed.length} kind(s) use the hash policy but no HMAC key is configured, so digests change on every restart`,
      remedy: 'set HUSHGATE_HMAC_KEY, or redaction.hmacKey',
    });
  }

  return out;
}

function residency({ config }: DoctorInput): Finding[] {
  const out: Finding[] = [];

  if (config.residency.allow.length === 0) {
    out.push({
      section: 'residency',
      severity: 'warn',
      message: 'no residency allowlist is configured, so any upstream is permitted',
      remedy: 'list the endpoints you have assessed in residency.allow, each with its legal basis',
    });
  }

  for (const [name, url] of Object.entries({
    openai: config.upstreams.openai,
    anthropic: config.upstreams.anthropic,
  })) {
    const verdict = evaluateUpstream(url, config.residency);

    if (!verdict.permitted) {
      out.push({
        section: 'residency',
        severity: 'fail',
        message: `upstreams.${name} → ${verdict.reason}`,
        remedy: `hushgate will not start; fix ${verdict.rule} or the upstream`,
      });
      continue;
    }

    const where = verdict.jurisdiction;
    if (where.status === 'unknown') {
      out.push({
        section: 'residency',
        severity: 'warn',
        message: `upstreams.${name} → ${verdict.host} has no declared jurisdiction`,
        remedy: 'add the endpoint to residency.allow with an explicit jurisdiction',
      });
      continue;
    }

    const severity: Severity = leavesTheEea(where.code) ? 'note' : 'ok';
    out.push({
      section: 'residency',
      severity,
      message: `upstreams.${name} → ${verdict.host} [${where.code}, ${where.status}] via ${verdict.rule}`,
      ...(verdict.legalBasis === null && verdict.rule.startsWith('residency.allow[')
        ? { remedy: 'record the legal basis for this transfer' }
        : {}),
    });

    if (where.status === 'third-country' && verdict.dataControls.length === 0) {
      out.push({
        section: 'residency',
        severity: 'warn',
        message: `${verdict.host} is in a third country and documents no retention or training control`,
        remedy: 'set residency.requireDataControls, or move to an endpoint that offers one',
      });
    }
  }

  return out;
}

function enforcement({ config }: DoctorInput): Finding[] {
  const out: Finding[] = [];
  const loose = new Set(['warn', 'allow']);

  if (loose.has(config.residency.mode)) {
    out.push({
      section: 'enforcement',
      severity: 'warn',
      message: `residency.mode is "${config.residency.mode}": personal data is forwarded unchanged`,
      remedy: 'set residency.mode to sanitize once the rollout is finished',
    });
  }

  for (const [route, mode] of Object.entries(config.residency.routes)) {
    if (!loose.has(mode)) continue;
    out.push({
      section: 'enforcement',
      severity: 'warn',
      message: `residency.routes.${route} is "${mode}": personal data on that route is forwarded unchanged`,
      remedy: 'set it to sanitize once the rollout is finished',
    });
  }

  for (const [kind, mode] of Object.entries(config.residency.categories)) {
    if (!loose.has(mode)) continue;
    out.push({
      section: 'enforcement',
      severity: 'warn',
      message: `residency.categories.${kind} is "${mode}": that category is forwarded unchanged`,
      remedy: 'set it to sanitize or block',
    });
  }

  const allowed = Object.entries(config.redaction.policies).filter(
    ([, policy]) => policy === 'allow',
  );
  for (const [kind] of allowed) {
    out.push({
      section: 'enforcement',
      severity: 'warn',
      message: `redaction.policies.${kind} is "allow": that category is sent verbatim`,
      remedy: 'remove the override unless the category is genuinely not personal data here',
    });
  }

  return out;
}

function security({ config }: DoctorInput): Finding[] {
  const out: Finding[] = [];

  if (config.tenants.length === 0) {
    out.push(
      isLoopback(config.host)
        ? {
            section: 'security',
            severity: 'ok',
            message: `bound to ${config.host}, so only this machine can reach it`,
          }
        : {
            section: 'security',
            severity: 'fail',
            message: `bound to ${config.host} with no tenants: that would be an open relay`,
            remedy: 'run "hushgate keys new <id>" and define tenants, or bind 127.0.0.1',
          },
    );
    return out;
  }

  out.push({
    section: 'security',
    severity: 'ok',
    message: `${config.tenants.length} tenant(s) defined; a key is required`,
  });

  const unlimited = config.tenants.filter(
    (tenant) => tenant.quotas.requestsPerMinute === null && tenant.quotas.tokensPerDay === null,
  );
  if (unlimited.length > 0) {
    out.push({
      section: 'security',
      severity: 'note',
      message: `${unlimited.length} tenant(s) have no quota: ${unlimited.map((t) => t.id).join(', ')}`,
      remedy: 'set quotas.requestsPerMinute or quotas.tokensPerDay to bound the spend',
    });
  }

  return out;
}

/**
 * Every audit trail the config names, checked the way `serve` and an auditor
 * will meet it.
 *
 * `serve` records a tenant with its own `audit.path` in that file only, so the
 * global trail alone says nothing about those tenants: each distinct file is
 * checked, and tenants that share one are named together. Of each, doctor asks
 * whether `serve` could open it — a trail it cannot write stops the proxy from
 * starting — and whether what is already in it verifies.
 */
function audit(input: DoctorInput): Finding[] {
  const { config } = input;

  if (!config.audit.enabled) {
    return [
      {
        section: 'audit',
        severity: 'fail',
        message: 'auditing is disabled, so nothing can be evidenced',
        remedy: 'set audit.enabled to true',
      },
    ];
  }

  const cwd = input.cwd ?? process.cwd();
  const global = input.auditPath ?? config.audit.path;
  const trails = configuredTrails({ ...config, audit: { ...config.audit, path: global } }, cwd);
  // With one trail that nobody but the global traffic writes, there is
  // nothing to tell apart, and "trail" says it all.
  const named = trails.length > 1 || trails.some((trail) => trail.tenants.length > 0);
  const out: Finding[] = [];

  for (const trail of trails) {
    const label = named ? labelOf(trail) : 'trail';
    const shared = describeSharing(trail);
    if (shared !== null) out.push({ section: 'audit', severity: 'note', message: shared });
    out.push(...writable(trail, label, input), ...verified(trail, label, input));
  }

  return out;
}

/** Whether `serve` could open the trail, as a failure when it could not. */
function writable(trail: ConfiguredTrail, label: string, input: DoctorInput): Finding[] {
  const problem = (input.writeProblem ?? trailWriteProblem)(trail.path);
  if (problem === null) return [];
  const where = problem.path === trail.path ? '' : ` at ${printable(problem.path)}`;
  return [
    {
      section: 'audit',
      severity: 'fail',
      message: `${label} ${printable(trail.path)} cannot be written (${problem.code}${where}), so "hushgate serve" would refuse to start`,
      remedy: 'give the user hushgate runs as write access there, or point the audit path somewhere it has it',
    },
  ];
}

/** Whether what is in the trail verifies. */
function verified(trail: ConfiguredTrail, label: string, input: DoctorInput): Finding[] {
  const path = printable(trail.path);

  let result: TrailVerification | null;
  try {
    result = readAndVerify(trail.path, input.readTrail);
  } catch (error) {
    // Only a trail that does not exist yet is waiting for its first request.
    // One that exists and cannot be read — a directory, a file this user may
    // not open — cannot be verified, and that is a failure, not news.
    if (codeOf(error) !== 'ENOENT') {
      return [
        {
          section: 'audit',
          severity: 'fail',
          message: `${label} ${path} cannot be read (${codeOf(error) ?? printable(messageOf(error))}), so it cannot be verified`,
          remedy: 'make it a file that the users running doctor and serve can read',
        },
      ];
    }
    result = null;
  }

  if (result === null) {
    return [
      {
        section: 'audit',
        severity: 'note',
        message: `no ${label} at ${path} yet; it is written on the first request`,
      },
    ];
  }

  return [...unreadable(result, label, path), chainFinding(result, label, path), ...gaps(result, label, path)];
}

function unreadable(result: TrailVerification, label: string, path: string): Finding[] {
  if (result.malformedCount === 0) return [];
  return [
    {
      section: 'audit',
      severity: 'fail',
      message: `${result.malformedCount} unreadable line(s) in ${label} ${path}, first at line ${result.malformed[0]!.line}`,
      remedy: 'the trail is append-only; investigate whatever rewrote it',
    },
  ];
}

/** The chain's verdict. The head is given in full, because it is what gets anchored. */
function chainFinding(result: TrailVerification, label: string, path: string): Finding {
  const chain = result.verification;
  const first = chain.firstBreak;
  if (first === null) {
    return {
      section: 'audit',
      severity: 'ok',
      message: `${label} ${path}: ${chain.records} record(s), chain intact, head ${chain.head}`,
    };
  }

  const line = first.line === undefined ? '' : `, line ${first.line}`;
  const more = chain.breakCount === 1 ? '' : `; ${chain.breakCount} breaks in all`;
  return {
    section: 'audit',
    severity: 'fail',
    message: `${label} ${path}: chain broken at record ${first.index}${line} (${first.reason}) — ${printable(first.detail)}${more}`,
    remedy: `run "hushgate audit verify ${path}" and investigate each point it lists`,
  };
}

/**
 * Records the writer could not write. Not a break — the chain links across
 * each gap — but requests were served for which there is no evidence, so it
 * is a warning rather than a note.
 */
function gaps(result: TrailVerification, label: string, path: string): Finding[] {
  const chain = result.verification;
  const first = chain.gaps[0];
  if (first === undefined) return [];
  const line = first.line === undefined ? '' : `, line ${first.line}`;
  return [
    {
      section: 'audit',
      severity: 'warn',
      message: `${label} ${path}: ${chain.dropped} record${chain.dropped === 1 ? '' : 's'} could not be written (first gap before record ${first.index}${line}), so requests were served without evidence`,
      remedy: 'look at the disk and the service log from that time; the chain links across the gap and still verifies',
    },
  ];
}

/**
 * Verify one trail: from the injected text when a test supplies it, otherwise
 * streamed from the file. Errors reading it are thrown unchanged.
 */
function readAndVerify(path: string, readTrail: DoctorInput['readTrail']): TrailVerification | null {
  if (readTrail === undefined) return verifyTrailFile(path);
  const text = readTrail(path);
  return text === null ? null : verifyTrail(parseAuditLines(text).entries);
}

/** How a finding names a trail: by whose records it holds. */
function labelOf(trail: ConfiguredTrail): string {
  const tenants = trail.tenants.join(', ');
  const plural = trail.tenants.length === 1 ? '' : 's';
  if (trail.global) {
    return trail.tenants.length === 0 ? 'global trail' : `global trail (also tenant${plural} ${tenants})`;
  }
  return `trail of tenant${plural} ${tenants}`;
}

/**
 * A note when several tenants, or a tenant and the global trail, write one
 * file. `serve` gives them one sink and one chain, and every record names its
 * tenant, so nothing is wrong — but an operator who meant to keep them apart
 * should hear that the config does not.
 */
function describeSharing(trail: ConfiguredTrail): string | null {
  const tenants = trail.tenants.join(', ');
  const one = trail.tenants.length === 1;
  if (trail.global && trail.tenants.length > 0) {
    return `tenant${one ? '' : 's'} ${tenants} ${one ? 'names' : 'name'} the global trail ${printable(trail.path)} as ${one ? 'its' : 'their'} own, so ${one ? 'its' : 'their'} records share that chain`;
  }
  if (trail.tenants.length > 1) {
    return `tenants ${tenants} share one trail, ${printable(trail.path)}, and one chain`;
  }
  return null;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** How many findings of each severity. */
export function tally(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { ok: 0, note: 0, warn: 0, fail: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** What an extractor spec claims, for a message an operator can act on. */
function describeClaim(spec: {
  readonly mediaTypes: readonly string[];
  readonly formats: readonly string[];
}): string {
  const claims = [...spec.mediaTypes, ...spec.formats];
  return claims.length === 0 ? 'the attachments it handles' : claims.join(', ');
}

/**
 * Whether a command could be executed.
 *
 * Deliberately a PATH walk rather than spawning the command with `--version`:
 * doctor runs on an operator's terminal against their real config, and running
 * every configured extractor to find out whether it exists would execute
 * arbitrary configured programs as a side effect of asking for a health check.
 */
function isOnPath(command: string): boolean {
  if (command.includes('/') || isAbsolutePath(command)) return executable(command);

  const path = process.env['PATH'] ?? '';
  return path
    .split(delimiter)
    .filter((entry) => entry !== '')
    .some((entry) => executable(join(entry, command)));
}

function executable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    // A directory satisfies X_OK, so the access check alone would report a
    // directory named `pdftotext` on the PATH as an installed extractor while
    // every PDF was in fact being refused. `statSync` follows symlinks, so a
    // symlinked binary still counts.
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}
