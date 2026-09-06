/**
 * Session, CSRF and cookie tokens.
 *
 * A session cookie is a bearer credential: whoever holds it *is* the user until
 * it expires, so pasting a support ticket's `Cookie:` header into a chat window
 * hands over the account, not a description of it. That is a different failure
 * from leaking a name, and it is the one this detector exists for.
 *
 * WHAT THIS KEYS ON, AND WHAT IT DELIBERATELY DOES NOT. The trigger is the
 * well-known cookie *name* plus an assignment — never the shape of the value.
 * Entropy was measured on this corpus and it does not separate the two
 * populations: the session values here run 3.42-4.17 bits per character and
 * German prose runs 3.72-3.88, so any threshold that catches `xyz789` also
 * catches half the sentences around it. The name is the only signal that
 * actually discriminates, and it happens to be the one an evader cannot remove
 * without breaking the thing they pasted.
 *
 * The span covers the value alone. Leaving `JSESSIONID=` visible is what lets
 * the recipient of the redacted text still understand what was in the header,
 * and it costs nothing: the name is the same for every user of the framework.
 */
import type { Detector, Span } from '../types.js';
import { escapeRegExp } from './util.js';

/**
 * Priority for `SESSION_TOKEN`, pending an entry in `DEFAULT_PRIORITIES` —
 * this module does not own `types.ts`.
 *
 * Below `SECRET` (100) and above everything else. Below the secret detector
 * because a cookie value that is *also* a recognised API key or a JWT is
 * better reported as the more specific thing, and that detector's patterns
 * make a stronger claim about the same characters than "it sat behind an
 * equals sign". Above `URL_CREDENTIALS` (95) and the rest because everything
 * ranked lower — an IBAN, a card, a phone number — describes a person, while
 * this one *is* the person as far as the far end is concerned.
 */
export const SESSION_TOKEN_PRIORITY = 98;

/**
 * A short value is a flag, not a token: `session=1`, `csrftoken=on`. Six
 * characters is the shortest thing in the corpus that is genuinely a session
 * id (`xyz789`), so it is where the line goes.
 */
const MIN_VALUE_LENGTH = 6;

/** How much of a value is looked at, so a pathological line stays linear. */
const MAX_VALUE_LENGTH = 4096;

/**
 * Well-known session, CSRF and auth cookie names.
 *
 * This is a curated subset, not a closed list — there is no registry of cookie
 * names to be authoritative about, only each framework's own documentation and
 * defaults, which is where these came from (PHP, Servlet/Tomcat, ASP.NET,
 * Django, Rails, Laravel, CodeIgniter, Express/`connect`, Angular's XSRF
 * convention). Anything a customer runs in-house is added through
 * {@link createSessionTokenDetector}'s `names` rather than by editing this.
 */
export const SESSION_COOKIE_NAMES: readonly string[] = [
  'sessionid',
  'session_id',
  'session-id',
  'sessionkey',
  'session_key',
  'session',
  'sessid',
  'sess',
  '_session',
  '_session_id',
  'sid',
  'PHPSESSID',
  'JSESSIONID',
  'ASP.NET_SessionId',
  'connect.sid',
  'express.sid',
  'laravel_session',
  'ci_session',
  'symfony_session',
  'csrftoken',
  'csrf_token',
  'csrfmiddlewaretoken',
  '_csrf',
  'XSRF-TOKEN',
  'auth_token',
  'authtoken',
  'auth_session',
  'access_token',
  'refresh_token',
  'id_token',
  'remember_token',
];

/**
 * Names that carry a per-site suffix rather than being written whole:
 * `ASPSESSIONIDQGGQGQLR`, Drupal's `SSESS<hash>`, WordPress's
 * `wordpress_logged_in_<hash>`. Matched as a prefix plus whatever follows.
 */
export const SESSION_COOKIE_PREFIXES: readonly string[] = [
  'ASPSESSIONID',
  'SSESS',
  'wordpress_logged_in',
  'wordpress_sec',
];

/**
 * The assignments a server writes to *remove* a cookie.
 *
 * `Set-Cookie: session=deleted; Max-Age=0` carries no credential at all, and
 * redacting it would turn the one line that proves a logout worked into
 * `session=[SESSION_TOKEN_1]`.
 */
const CLEARING_VALUES = new Set([
  'deleted',
  'expired',
  'invalid',
  'none',
  'null',
  'nil',
  'true',
  'false',
  'undefined',
]);

/** Extra names to recognise on top of the built-in list. */
export interface SessionTokenOptions {
  /** Cookie names written whole, for example `hushgate_sess`. */
  readonly names?: readonly string[];
  /** Cookie name prefixes that carry a per-site suffix. */
  readonly prefixes?: readonly string[];
}

/**
 * Build the pattern.
 *
 * Longest name first, so the alternation settles on `sessionid` rather than
 * committing to `session` and then backtracking — the result would be the same
 * either way, but only because the assignment has to follow immediately, and
 * relying on that is the kind of thing that stops being true when a name is
 * added.
 *
 * `[ \t]*` rather than `\s*` around the equals sign: a name at the end of one
 * line and an assignment at the start of the next are two different things,
 * and joining them across the newline is how a detector starts reporting
 * findings nobody wrote.
 */
function buildPattern(options: SessionTokenOptions): RegExp {
  const names = [...SESSION_COOKIE_NAMES, ...(options.names ?? [])]
    .toSorted((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const prefixes = [...SESSION_COOKIE_PREFIXES, ...(options.prefixes ?? [])]
    .toSorted((a, b) => b.length - a.length)
    .map((prefix) => `${escapeRegExp(prefix)}[A-Za-z0-9_]*`);

  const name = [...prefixes, ...names].join('|');
  // The leading guard is what keeps `mysessionid=` and `x-csrftoken_extra=` out:
  // a known name has to start the cookie name, not merely appear inside one.
  // The trailing value class stops at whatever ends a cookie — whitespace, the
  // `;` before the next attribute, a comma between Set-Cookie values — and its
  // last character may not be a full stop, so a token at the end of a German
  // sentence does not swallow the punctuation.
  const source =
    String.raw`(?<![A-Za-z0-9_.-])(?:${name})[ \t]*=[ \t]*` +
    String.raw`(?:"([^"\r\n]{0,${MAX_VALUE_LENGTH}})"|([^\s;,"'\\]{0,${MAX_VALUE_LENGTH}}[^\s;,"'\\.]))`;

  return new RegExp(source, 'giu');
}

/**
 * A session-token detector recognising the built-in cookie names plus any the
 * caller adds.
 */
export function createSessionTokenDetector(options: SessionTokenOptions = {}): Detector {
  const pattern = buildPattern(options);

  return {
    name: 'session-token',
    priority: SESSION_TOKEN_PRIORITY,

    find(text: string): Span[] {
      const re = new RegExp(pattern.source, pattern.flags);
      const out: Span[] = [];
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const quoted = match[1] !== undefined;
        const value = quoted ? match[1]! : match[2]!;
        if (value.length < MIN_VALUE_LENGTH) continue;
        if (CLEARING_VALUES.has(value.toLowerCase())) continue;

        // The value is the tail of the match, so its offsets follow from the
        // match's end rather than needing the `d` flag: one closing quote back
        // when it was quoted, then its own length.
        const end = match.index + match[0].length - (quoted ? 1 : 0);

        out.push({
          start: end - value.length,
          end,
          kind: 'SESSION_TOKEN',
          value,
          detector: 'session-token',
          priority: SESSION_TOKEN_PRIORITY,
        });
      }

      return out;
    },
  };
}

/** Session and CSRF cookie values, keyed on the well-known cookie names. */
export const sessionTokenDetector: Detector = createSessionTokenDetector();
