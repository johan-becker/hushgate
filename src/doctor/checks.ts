/**
 * The checks behind `hushgate doctor`.
 *
 * Separated from the command so they can be tested as data rather than as
 * terminal output. Each check answers one question an operator would otherwise
 * only discover in production, and each one says what to do about it.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute as isAbsolutePath, join } from 'node:path';
import { parseAuditLines } from '../audit/log.js';
import { verifyChain } from '../audit/record.js';
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
  /** Absolute path of the audit trail. */
  readonly auditPath: string;
  /** Injected so the tests do not need a file on disk. */
  readonly readTrail?: (path: string) => string | null;
  /** Injected so the tests do not depend on what is installed on the machine. */
  readonly onPath?: (command: string) => boolean;
}

export function runChecks(input: DoctorInput): Finding[] {
  return [
    ...configuration(input),
    ...briefing(input),
    ...residency(input),
    ...enforcement(input),
    ...security(input),
    ...attachments(input),
    ...audit(input),
  ];
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

function audit(input: DoctorInput): Finding[] {
  const { config, auditPath } = input;

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

  const read = input.readTrail ?? defaultReadTrail;
  const text = read(auditPath);

  if (text === null) {
    return [
      {
        section: 'audit',
        severity: 'note',
        message: `no trail at ${auditPath} yet; it is written on the first request`,
      },
    ];
  }

  const { records, malformed } = parseAuditLines(text);
  const chain = verifyChain(records);
  const out: Finding[] = [];

  if (malformed.length > 0) {
    out.push({
      section: 'audit',
      severity: 'fail',
      message: `${malformed.length} unreadable line(s) in ${auditPath}, first at line ${malformed[0]!.line}`,
      remedy: 'the trail is append-only; investigate whatever rewrote it',
    });
  }

  out.push(
    chain.ok
      ? {
          section: 'audit',
          severity: 'ok',
          message: `${auditPath}: ${chain.records} record(s), chain intact, head ${chain.head.slice(0, 12)}…`,
        }
      : {
          section: 'audit',
          severity: 'fail',
          message: `${auditPath}: chain broken at record ${chain.firstBreak!.index} (${chain.firstBreak!.reason}) — ${chain.firstBreak!.detail}`,
          remedy: 'run "hushgate audit verify" and investigate; records from there on cannot be trusted',
        },
  );

  return out;
}

function defaultReadTrail(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
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
