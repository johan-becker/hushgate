import { DEFAULT_PRIORITIES, type Detector, type LabelProximity, type Span } from '../types.js';
import { labelNear } from './normalise.js';

/** IPv4 in dotted-quad notation. Octets are validated, not just counted. */
export function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  return parts.every((part) => {
    if (!/^\d{1,3}$/u.test(part)) return false;
    // Leading zeros are ambiguous (octal in some parsers) and never canonical.
    if (part.length > 1 && part.startsWith('0')) return false;
    return Number(part) <= 255;
  });
}

/**
 * The trailing guard rejects a dot only when a digit follows it, so
 * `1.2.3.4.5` is still refused as a fragment of a longer dotted run while
 * `Der Server 10.0.0.42.` — an address at the end of a sentence, which is where
 * most of them sit in prose — is found. Excluding every following dot would
 * silently drop the whole address, because the lookbehind then blocks any
 * shorter re-match too.
 */
const IPV4_PATTERN = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/gu;

export const ipv4Detector: Detector = {
  name: 'ipv4',
  priority: DEFAULT_PRIORITIES.IPV4,

  find(text: string): Span[] {
    const re = new RegExp(IPV4_PATTERN.source, IPV4_PATTERN.flags);
    const out: Span[] = [];
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      if (!isValidIpv4(match[0])) continue;
      out.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: 'IPV4',
        value: match[0],
        detector: 'ipv4',
        priority: DEFAULT_PRIORITIES.IPV4,
      });
    }

    return out;
  },
};

/**
 * IPv6, including `::` compression and the IPv4-mapped tail form
 * (`::ffff:192.0.2.128`).
 *
 * The bare unspecified address `::` is deliberately *not* accepted: it appears
 * far more often as a C++ scope operator in pasted code than as an address.
 */
export function isValidIpv6(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;
  if (!/^[0-9A-Fa-f:.]+$/u.test(value)) return false;
  if (!value.includes(':')) return false;

  const halves = value.split('::');
  if (halves.length > 2) return false;

  const compressed = halves.length === 2;
  const head = splitGroups(halves[0] ?? '');
  const tail = compressed ? splitGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) return false;

  const groups = [...head, ...tail];
  if (groups.length === 0) return false;

  let words = 0;
  for (const [index, group] of groups.entries()) {
    const isLast = index === groups.length - 1;
    if (/^[0-9A-Fa-f]{1,4}$/u.test(group)) {
      words += 1;
      continue;
    }
    // Only the final group may be a dotted IPv4 tail, and it is worth two words.
    if (isLast && isValidIpv4(group)) {
      words += 2;
      continue;
    }
    return false;
  }

  return compressed ? words <= 7 : words === 8;
}

/** Split a colon-separated half; `null` when it contains an empty group. */
function splitGroups(half: string): string[] | null {
  if (half === '') return [];
  const groups = half.split(':');
  return groups.some((group) => group === '') ? null : groups;
}

const IPV6_PATTERN = /(?<![\p{L}\p{N}:.])[0-9A-Fa-f:.]{2,45}(?![0-9A-Fa-f:.])/gu;

export const ipv6Detector: Detector = {
  name: 'ipv6',
  priority: DEFAULT_PRIORITIES.IPV6,

  find(text: string): Span[] {
    const re = new RegExp(IPV6_PATTERN.source, IPV6_PATTERN.flags);
    const out: Span[] = [];
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const candidate = match[0];
      // Trailing sentence punctuation gets swallowed by the character class;
      // trim it back before giving up on the candidate.
      for (let trimmed = candidate.length; trimmed >= 2; trimmed--) {
        const slice = candidate.slice(0, trimmed);
        if (trimmed < candidate.length && !'.:'.includes(candidate[trimmed] ?? '')) break;
        if (!isValidIpv6(slice)) continue;
        out.push({
          start: match.index,
          end: match.index + trimmed,
          kind: 'IPV6',
          value: slice,
          detector: 'ipv6',
          priority: DEFAULT_PRIORITIES.IPV6,
        });
        break;
      }
    }

    return out;
  },
};

const MAC_COLON_PATTERN =
  /(?<![0-9A-Fa-f:-])[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2}){5}(?![0-9A-Fa-f:-])/gu;
const MAC_CISCO_PATTERN =
  /(?<![0-9A-Fa-f.])[0-9A-Fa-f]{4}(?:\.[0-9A-Fa-f]{4}){2}(?![0-9A-Fa-f.])/gu;

/**
 * The undelimited spelling, `001A2B3C4D5E`.
 *
 * No scan copy can reach this one: it holds no separator to fold and no case
 * change to normalise, so a MAC written the way `ip link` and every Windows
 * inventory export write it survived every fold phase 1 added. It has to be
 * matched here or not at all.
 *
 * The guards exclude the neighbours that would make the twelve characters part
 * of something longer — a hex digit either side, a word character either side,
 * or a MAC separator with another hex digit behind it, which is what keeps the
 * twelve-hex tail of `…-a716-446655440000` from being read as an address. The
 * trailing full stop of a sentence is deliberately still allowed.
 */
const MAC_BARE_PATTERN =
  /(?<![0-9A-Za-z_:.-])[0-9A-Fa-f]{12}(?![0-9A-Za-z_])(?![:.-][0-9A-Fa-f])/gu;

/**
 * The words that license the undelimited form.
 *
 * THE CHOICE, and it is a deliberate one: twelve bare hex characters is also
 * the shape of a truncated git hash, half a Mongo ObjectId, a session id, a
 * colour table and any number of internal part numbers. Accepting them
 * unaccompanied would buy one evasion — an attacker deleting five colons — at
 * the price of a detector that fires somewhere in most log files, and a
 * detector the customer switches off protects nothing. So the bare form is
 * gated on context and the three delimited forms stay unconditional, because
 * those carry their own evidence in the separators.
 *
 * Only the labels that are not substrings of one another are listed: the
 * comparison folds punctuation away and asks for containment, so `MAC` already
 * matches `MAC-Adresse`, `MAC address` and `MAC-ID`. It also matches inside
 * `machen`, which is the cost of a three-letter label — bounded, because the
 * value must still be exactly twelve hex characters at a token boundary.
 *
 * Declared once at module level, never inside `find`: `labelNear` caches the
 * folded forms against this array's identity.
 */
export const MAC_LABELS: readonly string[] = [
  'MAC',
  'BSSID',
  'hwaddr',
  'Hardware-Adresse',
  'Netzwerkadresse',
  'physical address',
  'Ethernet',
];

const MAC_LABEL_PROXIMITY: LabelProximity = { labels: MAC_LABELS };

/**
 * MAC addresses in `00:1A:2B:3C:4D:5E`, `00-1A-…`, Cisco `001a.2b3c.4d5e` and
 * undelimited `001A2B3C4D5E` form.
 *
 * The label check is inline rather than a `requiresLabel` declaration because
 * that field is all-or-nothing per detector, and gating the delimited forms on
 * a nearby word would be a straight regression.
 */
export const macDetector: Detector = {
  name: 'mac',
  priority: DEFAULT_PRIORITIES.MAC,

  find(text: string): Span[] {
    const out: Span[] = [];

    for (const pattern of [MAC_COLON_PATTERN, MAC_CISCO_PATTERN, MAC_BARE_PATTERN]) {
      const re = new RegExp(pattern.source, pattern.flags);
      const bare = pattern === MAC_BARE_PATTERN;
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const value = match[0];
        // Reject mixed separators such as `00:1A-2B:3C:4D:5E`.
        const separators = new Set(value.replaceAll(/[0-9A-Fa-f]/gu, ''));
        if (separators.size > 1) continue;

        const end = match.index + value.length;
        if (bare && !labelNear(text, match.index, end, MAC_LABEL_PROXIMITY)) continue;

        out.push({
          start: match.index,
          end,
          kind: 'MAC',
          value,
          detector: 'mac',
          priority: DEFAULT_PRIORITIES.MAC,
        });
      }
    }

    return out;
  },
};
