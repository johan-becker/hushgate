import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

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

const IPV4_PATTERN = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/gu;

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

/** MAC addresses in `00:1A:2B:3C:4D:5E`, `00-1A-…` and Cisco `001a.2b3c.4d5e` form. */
export const macDetector: Detector = {
  name: 'mac',
  priority: DEFAULT_PRIORITIES.MAC,

  find(text: string): Span[] {
    const out: Span[] = [];

    for (const pattern of [MAC_COLON_PATTERN, MAC_CISCO_PATTERN]) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null) {
        const value = match[0];
        // Reject mixed separators such as `00:1A-2B:3C:4D:5E`.
        const separators = new Set(value.replaceAll(/[0-9A-Fa-f]/gu, ''));
        if (separators.size > 1) continue;

        out.push({
          start: match.index,
          end: match.index + value.length,
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
