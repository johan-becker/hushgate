/**
 * The checks behind `hushgate doctor`.
 *
 * Separated from the command so they can be tested as data rather than as
 * terminal output. Each check answers one question an operator would otherwise
 * only discover in production, and each one says what to do about it.
 */
import { existsSync, readFileSync } from 'node:fs';
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
}

export function runChecks(input: DoctorInput): Finding[] {
  return [
    ...configuration(input),
    ...residency(input),
    ...enforcement(input),
    ...security(input),
    ...audit(input),
  ];
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
