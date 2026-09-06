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
];

// ---------------------------------------------------------------------------
// PEM / OpenSSH / PGP private key armour
//
// WHY THIS IS NOT A SINGLE REGEX ANY MORE
//
// The old rule was `-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END … -----`,
// and it was wrong in three separate ways, each of which shipped a private key
// upstream:
//
//  1. It only fired when the END armour was present. A key pasted without its
//     footer, truncated by a chat client, or cut off by the body size limit was
//     invisible — the block was then caught only incidentally, because the
//     base64 body happened to trip another rule. A short or partially redacted
//     body tripped nothing at all.
//  2. It was case- and spacing-exact. `-----begin rsa private key-----` and
//     `----- BEGIN RSA PRIVATE KEY -----` both went through untouched, and the
//     scan copies do not rescue it: the identifier fold only normalises case
//     inside identifier chains, not across a spelled-out armour line.
//  3. `[\s\S]*?` in front of a possibly-absent terminator is the classic
//     quadratic shape. Every unterminated BEGIN rescanned the whole remainder
//     of the body, and a request carrying a few thousand BEGIN lines under the
//     4 MiB limit stalled the shared event loop for minutes. Worse, when a far
//     away END *did* exist it swallowed the entire document in between and
//     redacted it.
//
// So the header is matched on its own, and the block extent is then walked
// forward line by line, which is linear and terminates on its own.
//
// SPAN BOUNDARY: THE WHOLE BLOCK, NOT THE HEADER LINE
//
// A finding covers the armour line through the matching END line (or through
// the last line that is still key material, when END never arrives). Covering
// only the header would redact the *label* and forward the key — precisely the
// bug being fixed. The trade-off accepted is over-claim: a few lines of RFC
// 1421 armour headers, or a stray blank line, may end up inside the span and be
// redacted with the key. That is the right direction to be wrong in for the one
// secret whose disclosure cannot be undone by rotating a token.
// ---------------------------------------------------------------------------

/** Both armour lines need at least this many dashes on each side. */
const MIN_ARMOUR_DASHES = 4;
/** Shortest run of base64 that counts as a body line; a real PEM line is 64. */
const MIN_BODY_LINE = 4;
/** Algorithm words tolerated between BEGIN and PRIVATE (`SSH2 ENCRYPTED …`). */
const MAX_ALGORITHM_WORDS = 4;

const HYPHEN_MINUS = 0x2d;

/**
 * Anchor on a dash run rather than on the word BEGIN.
 *
 * `-{4,}` is greedy and is the whole pattern, so it consumes a run of any
 * length in one pass and never backtracks — a body that is nothing but dashes
 * costs one match, not one per offset.
 */
const ARMOUR_ANCHOR = /-{4,}/gu;

/**
 * The rest of a BEGIN armour, matched sticky from the end of the dash run.
 *
 * Bounded on every axis: the algorithm words are capped, the separators are
 * horizontal whitespace only (an armour line never wraps), and no sub-pattern
 * is ambiguous against its neighbour, so the engine can try at most a handful
 * of splits per anchor. `BLOCK` is the OpenPGP suffix.
 */
const BEGIN_ARMOUR_TAIL = new RegExp(
  String.raw`[ \t]*BEGIN[ \t]+(?:[A-Za-z0-9]+[ \t]+){0,${MAX_ALGORITHM_WORDS}}PRIVATE[ \t]+KEY(?:[ \t]+BLOCK)?[ \t]*-{${MIN_ARMOUR_DASHES},}`,
  'iuy',
);

/** A body line: base64 (PEM) or a PGP CRC line, and nothing else. */
const BODY_LINE = new RegExp(String.raw`^[A-Za-z0-9+/=]{${MIN_BODY_LINE},}$`, 'u');

/**
 * An RFC 1421 / OpenPGP armour header such as `Proc-Type: 4,ENCRYPTED`.
 *
 * Accepted only before the first body line, which is where the RFCs put them.
 * Without that restriction any `Note: …` line in the prose following a
 * headerless key would extend the span into the surrounding text.
 */
const ARMOUR_HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]{0,32}:[ \t]?\S/u;

function leadingDashes(line: string): number {
  let count = 0;
  while (line.codePointAt(count) === HYPHEN_MINUS) count += 1;
  return count;
}

function trailingDashes(line: string): number {
  let count = 0;
  while (count < line.length && line.codePointAt(line.length - 1 - count) === HYPHEN_MINUS) {
    count += 1;
  }
  return count;
}

/**
 * True for any END armour line, whatever it names.
 *
 * Deliberately more permissive than the BEGIN matcher: an `-----END EC PRIVATE
 * KEY-----` closing a block that opened as RSA is a real thing people paste,
 * and closing a block one line too early is always safer than running on.
 * Written with explicit scans instead of a regex because a dash-run pattern
 * anchored to both ends of a line is exactly the backtracking shape this whole
 * rewrite exists to avoid.
 */
function isEndArmour(line: string): boolean {
  const lead = leadingDashes(line);
  if (lead < MIN_ARMOUR_DASHES) return false;
  const tail = trailingDashes(line);
  if (tail < MIN_ARMOUR_DASHES) return false;

  const inner = line.slice(lead, line.length - tail).trim();
  return /^END\b/iu.test(inner);
}

/**
 * Where the block that opens at `headerEnd` stops.
 *
 * One forward pass, never revisiting a character: every line either extends the
 * block or ends it. Because an armour line is itself not key material, one
 * block's scan always stops at or before the next block's header, so the total
 * cost over a whole body stays linear in its length no matter how many BEGIN
 * lines it carries.
 */
function blockEnd(text: string, headerEnd: number): number {
  const lineEndFrom = (from: number): number => {
    const newline = text.indexOf('\n', from);
    return newline === -1 ? text.length : newline;
  };

  let end = headerEnd;
  let cursor = lineEndFrom(headerEnd);
  // A header quoted inside a sentence (`see ----- BEGIN … ----- above`) opens
  // nothing; only the armour itself is the finding.
  if (text.slice(headerEnd, cursor).trim() !== '') return end;

  let sawBody = false;
  while (cursor < text.length) {
    const start = cursor + 1;
    const stop = lineEndFrom(start);
    const line = text.slice(start, stop).trim();

    if (isEndArmour(line)) return stop;
    if (line === '') {
      // A blank line separates armour headers from the body, and trailing
      // newlines are not part of the key: traverse it, but do not let it
      // extend the span on its own.
      cursor = stop;
      continue;
    }
    if (BODY_LINE.test(line)) {
      sawBody = true;
    } else if (sawBody || !ARMOUR_HEADER_LINE.test(line)) {
      return end;
    }

    end = stop;
    cursor = stop;
  }

  return end;
}

/** Every private key block in `text`, armour to armour. */
function findPrivateKeyBlocks(text: string): Span[] {
  const out: Span[] = [];
  ARMOUR_ANCHOR.lastIndex = 0;
  let anchor: RegExpExecArray | null;

  while ((anchor = ARMOUR_ANCHOR.exec(text)) !== null) {
    const start = anchor.index;
    BEGIN_ARMOUR_TAIL.lastIndex = start + anchor[0].length;
    const tail = BEGIN_ARMOUR_TAIL.exec(text);
    if (tail === null) continue;

    const end = blockEnd(text, BEGIN_ARMOUR_TAIL.lastIndex);
    out.push({
      start,
      end,
      kind: 'SECRET',
      value: text.slice(start, end),
      detector: 'secret:pem-private-key',
      priority: DEFAULT_PRIORITIES.SECRET,
    });

    // Skip the block wholesale, so the END armour's own dash runs cannot open
    // a second, nested finding.
    ARMOUR_ANCHOR.lastIndex = end;
  }

  return out;
}

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
    const out: Span[] = findPrivateKeyBlocks(text);

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
    // Anthropic and the generic OpenAI shape, and a key block's base64 body can
    // look like one on its own. Collapse them here so the detector's own output
    // is already disjoint.
    return resolveSpans(out);
  },
};
