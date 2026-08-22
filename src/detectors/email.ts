import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

const LOCAL_MAX = 64;
const TOTAL_MAX = 254;
const LABEL_MAX = 63;

/**
 * Practical address grammar: the RFC 5322 local part minus quoted strings and
 * comments, which no real user pastes into a chat prompt. The leading lookbehind
 * keeps `ünal@example.de` from being reported as `nal@example.de`.
 */
const EMAIL_PATTERN =
  /(?<![\p{L}\p{N}._%+-])[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9-])/gu;

/** Structural checks the pattern cannot express: length limits and label sizes. */
export function isValidEmail(candidate: string): boolean {
  if (candidate.length > TOTAL_MAX) return false;

  const at = candidate.lastIndexOf('@');
  if (at <= 0) return false;

  const local = candidate.slice(0, at);
  const domain = candidate.slice(at + 1);

  if (local.length === 0 || local.length > LOCAL_MAX) return false;
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false;

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= LABEL_MAX &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

export const emailDetector: Detector = {
  name: 'email',
  priority: DEFAULT_PRIORITIES.EMAIL,

  find(text: string): Span[] {
    const re = new RegExp(EMAIL_PATTERN.source, EMAIL_PATTERN.flags);
    const out: Span[] = [];
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      if (!isValidEmail(value)) continue;
      out.push({
        start: match.index,
        end: match.index + value.length,
        kind: 'EMAIL',
        value,
        detector: 'email',
        priority: DEFAULT_PRIORITIES.EMAIL,
      });
    }

    return out;
  },
};
