import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';
import { resolveSpans } from './resolve.js';

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
  /** Extra validation beyond the shape, or `undefined` when the shape suffices. */
  readonly validate?: (value: string) => boolean;
}

/**
 * Decode a base64url segment and check that it really is a JWT header.
 *
 * Without this, any three dot-separated base64-ish blobs would be reported as a
 * token. With it, only something whose first segment decodes to a JSON object
 * carrying `alg` or `typ` counts.
 */
export function isJwtHeaderSegment(segment: string): boolean {
  try {
    const padded = segment.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    return 'alg' in parsed || 'typ' in parsed;
  } catch {
    return false;
  }
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  // Anthropic keys first: they are a longer, more specific form of `sk-…`, and
  // both patterns produce the same span, which de-duplication then collapses.
  { name: 'anthropic-api-key', pattern: /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{24,}/gu },
  { name: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/gu },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu },
  { name: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/gu },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/gu },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/gu,
    validate: (value) => isJwtHeaderSegment(value.slice(0, value.indexOf('.'))),
  },
  {
    name: 'pem-private-key',
    pattern:
      /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
  },
];

/**
 * API keys, tokens and private key blocks.
 *
 * Secrets carry the highest detector priority: when a token overlaps anything
 * else, keeping the secret out of the upstream request wins.
 */
export const secretDetector: Detector = {
  name: 'secret',
  priority: DEFAULT_PRIORITIES.SECRET,

  find(text: string): Span[] {
    const out: Span[] = [];

    for (const { name, pattern, validate } of SECRET_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const value = match[0];
        if (value.length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (validate !== undefined && !validate(value)) continue;

        out.push({
          start: match.index,
          end: match.index + value.length,
          kind: 'SECRET',
          value,
          detector: `secret:${name}`,
          priority: DEFAULT_PRIORITIES.SECRET,
        });
      }
    }

    // Several patterns can claim the same token — `sk-ant-…` matches both the
    // Anthropic and the generic OpenAI shape. Collapse them here so the
    // detector's own output is already disjoint.
    return resolveSpans(out);
  },
};
