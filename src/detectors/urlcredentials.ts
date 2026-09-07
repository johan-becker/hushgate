import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

/**
 * The longest scheme name this will read.
 *
 * RFC 3986 sets no limit, so this is not a standard's number — it is a bound on
 * a greedy run, and the run needs one. `[A-Za-z0-9+.-]*` followed by a required
 * `://` is the quadratic backtracking shape: `.` and `-` are members, so
 * `sk-sk-sk-…` and `a.b.a.b.…` are each one enormous scheme candidate that the
 * engine matches whole, fails to follow with `://`, then gives back one
 * character at a time — and then starts again one position along. Measured on
 * this pattern: 20 000 characters of `sk-` took 250 ms and 40 000 took 1001,
 * four times the work for twice the input. Bounded, the same 40 000 cost 3.4 ms.
 *
 * 63 is chosen against reality rather than a specification: the longest scheme
 * IANA has ever registered is 36 characters
 * (`microsoft.windows.camera.multipicker`), so nothing that exists comes close.
 * The userinfo either side of the colon is deliberately left UNBOUNDED — a
 * password is exactly the thing that may be arbitrarily long, and it is
 * measured as linear inside the whole pattern because the required `://` in
 * front of it has already failed on any body that could make it backtrack.
 */
const SCHEME_MAX = 63;

/**
 * `scheme://user:password@host[:port][/path]`.
 *
 * The whole URL is claimed, not just the credential pair: the host of a
 * connection string ("db.internal.acme.example") is itself information the
 * upstream provider has no business seeing.
 */
const URL_CREDENTIALS_PATTERN = new RegExp(
  String.raw`\b[A-Za-z][A-Za-z0-9+.-]{0,${SCHEME_MAX - 1}}:\/\/[^\s/?#@:]+:[^\s/?#@]*@[^\s/?#]+(?:[/?#][^\s"'<>]*)?`,
  'gu',
);

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
