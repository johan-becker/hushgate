import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

/**
 * `scheme://user:password@host[:port][/path]`.
 *
 * The whole URL is claimed, not just the credential pair: the host of a
 * connection string ("db.internal.acme.example") is itself information the
 * upstream provider has no business seeing.
 */
const URL_CREDENTIALS_PATTERN =
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]+:[^\s/?#@]*@[^\s/?#]+(?:[/?#][^\s"'<>]*)?/gu;

/** Sentence punctuation that a greedy path match tends to swallow. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'"]);

export const urlCredentialsDetector: Detector = {
  name: 'url-credentials',
  priority: DEFAULT_PRIORITIES.URL_CREDENTIALS,

  find(text: string): Span[] {
    const re = new RegExp(URL_CREDENTIALS_PATTERN.source, URL_CREDENTIALS_PATTERN.flags);
    const out: Span[] = [];
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      let value = match[0];
      while (value.length > 0 && TRAILING_PUNCTUATION.has(value.at(-1) as string)) {
        value = value.slice(0, -1);
      }
      if (!value.includes('@')) continue;

      out.push({
        start: match.index,
        end: match.index + value.length,
        kind: 'URL_CREDENTIALS',
        value,
        detector: 'url-credentials',
        priority: DEFAULT_PRIORITIES.URL_CREDENTIALS,
      });
    }

    return out;
  },
};
