/**
 * Turning attachments into prose, before anything else looks at the body.
 *
 * This is the whole feature in one function. A request arrives carrying a
 * document; the document becomes text; the text takes the document's place in
 * the conversation. Everything downstream — every detector, every policy, the
 * placeholder table, the audit trail, the streaming rehydrator — then treats it
 * as ordinary message text and needs no knowledge that a file was ever
 * involved.
 *
 * The ordering matters and is the reason this is a separate stage rather than a
 * hook inside traversal. `redactJson` is synchronous by design. Extraction is
 * not: an operator-provided extractor is a child process. Rather than make the
 * redaction core async for the benefit of one caller, the async work happens
 * first and hands the redactor a body that is already nothing but text.
 */
import { AttachmentBlockedError } from '../errors.js';
import { selectByRules, type JsonValue, type Path, type PathRule } from '../redact/traverse.js';
import { decodeBase64, formatBytes } from './decode.js';
import { probePdf } from './pdf.js';
import { assessText } from './quality.js';
import { findAttachmentSites, type AttachmentSite } from './shapes.js';
import { mediaTypeForFormat, normaliseMediaType, sniffFormat } from './sniff.js';
import type {
  AttachmentFormat,
  AttachmentReport,
  Extractor,
  UnreadableAction,
} from './types.js';

/** The slice of configuration this module needs. */
export interface RewriteLimits {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly maxTextChars: number;
  readonly timeoutMs: number;
  readonly onUnreadable: UnreadableAction;
}

export interface RewriteOptions {
  readonly limits: RewriteLimits;
  /** Tried in order. Operator-provided extractors come first. */
  readonly extractors: readonly Extractor[];
  /**
   * The route's redaction rules.
   *
   * Not used to find attachments — that is done by shape — but to check, before
   * any extracted text is put into the body, that the place it is going is a
   * place the redactor will actually visit. See {@link rewriteAttachments}.
   */
  readonly rules: readonly PathRule[];
  /**
   * How many findings the detectors make in a piece of text, changing nothing.
   *
   * Supplied by the caller because this module must not own a detector set.
   * Drives {@link hidesIdentifiers}, the one check here that asks the question
   * that actually matters rather than a proxy for it.
   */
  readonly countFindings?: (text: string) => number;
}

export interface RewriteResult {
  readonly body: JsonValue;
  /** One entry per attachment found, in the order they appeared. */
  readonly reports: readonly AttachmentReport[];
}

/**
 * Replace every attachment in `body` with the text it contains.
 *
 * Throws {@link AttachmentBlockedError} when an attachment cannot be read and
 * `onUnreadable` is `block`. Nothing has left the machine at that point, which
 * is the entire purpose of doing this before the upstream request is built.
 */
export async function rewriteAttachments(
  body: JsonValue,
  options: RewriteOptions,
): Promise<RewriteResult> {
  if (!options.limits.enabled) return { body, reports: [] };

  const sites = findAttachmentSites(body);
  if (sites.length === 0) return { body, reports: [] };

  const reports: AttachmentReport[] = [];
  const replacements = new Map<string, JsonValue>();
  const redacts = selectByRules(options.rules);
  let spent = 0;

  for (const site of sites) {
    // Sequential on purpose. `spent` is a running total against
    // `maxTotalBytes`, which only means anything if each attachment is measured
    // against what the ones before it already cost; and extraction may spawn a
    // child process, so a request carrying twenty documents must not become
    // twenty concurrent processes.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await handleSite(site, options, spent, redacts, reports);
    spent += outcome.report.bytes;
    reports.push(outcome.report);
    if (outcome.replacement !== null) replacements.set(keyOf(site.path), outcome.replacement);
  }

  return { body: substitute(body, replacements), reports };
}

/**
 * Would the redactor visit the text we are about to write here?
 *
 * Attachments are found by shape, anywhere in the body, because a shape matcher
 * keeps working when a provider adds a content part next quarter. Redaction is
 * the opposite: it visits an explicit list of paths. The two can therefore
 * disagree, and when they do the failure is silent and total — hushgate decodes
 * a document, writes the plaintext into a corner of the body no rule reaches,
 * records the attachment as `extracted`, and forwards a name and an IBAN in
 * clear with `findings: {}` beside them in the audit trail.
 *
 * So placement is checked rather than assumed. A site the rules do not cover is
 * treated as unreadable, which means `onUnreadable` decides and the default
 * refuses the request. Finding an attachment somewhere new must fail towards
 * refusing it, never towards forwarding it.
 */
function isRedactable(redacts: (path: Path) => boolean, path: readonly (string | number)[]): boolean {
  return redacts([...path, 'text']);
}

interface SiteOutcome {
  readonly report: AttachmentReport;
  /** The content part to put in its place, or `null` to leave it untouched. */
  readonly replacement: JsonValue | null;
}

async function handleSite(
  site: AttachmentSite,
  options: RewriteOptions,
  alreadySpent: number,
  redacts: (path: Path) => boolean,
  soFar: readonly AttachmentReport[],
): Promise<SiteOutcome> {
  const { limits } = options;
  const declared = normaliseMediaType(site.declaredMediaType) ?? 'application/octet-stream';

  if (site.unresolvable !== null) {
    return refuse(site, 'unknown', declared, 0, site.unresolvable, limits.onUnreadable, soFar);
  }

  if (site.data === null) {
    return refuse(site, 'unknown', declared, 0, 'attachment carries no data', limits.onUnreadable, soFar);
  }

  const decoded = decodeBase64(site.data, limits.maxBytes);
  if (!decoded.ok) {
    return refuse(site, 'unknown', declared, 0, decoded.reason, limits.onUnreadable, soFar);
  }

  const bytes = decoded.bytes;
  if (alreadySpent + bytes.byteLength > limits.maxTotalBytes) {
    return refuse(
      site,
      'unknown',
      declared,
      bytes.byteLength,
      `attachments in this request total more than the ${formatBytes(limits.maxTotalBytes)} limit`,
      limits.onUnreadable,
      soFar,
    );
  }

  const format = sniffFormat(bytes, site.declaredMediaType, site.filename);

  // Checked before extraction, not after: there is no point decoding a document
  // we would then have to refuse to place, and refusing early keeps an
  // unplaceable attachment from spending an extractor's time.
  if (!isRedactable(redacts, site.path)) {
    return refuse(
      site,
      format,
      normaliseMediaType(site.declaredMediaType) ?? mediaTypeForFormat(format),
      bytes.byteLength,
      'this attachment sits where redaction does not reach, so its text could not be pseudonymised',
      limits.onUnreadable,
      soFar,
      false,
    );
  }

  const mediaType = normaliseMediaType(site.declaredMediaType) ?? mediaTypeForFormat(format);
  const context = {
    format,
    mediaType: site.declaredMediaType,
    // One character of headroom, so that a document which filled the budget can
    // be told apart from one that merely ended there. Without it every
    // extractor clamps to exactly the limit, `cleaned.length > maxTextChars` is
    // never true, and a document cut to a fraction of itself is recorded as
    // having been read in full.
    maxChars: limits.maxTextChars + 1,
    timeoutMs: limits.timeoutMs,
  };

  let lastReason = `no extractor handles ${format === 'unknown' ? mediaType : format}`;
  for (const extractor of options.extractors) {
    if (!extractor.supports(format, site.declaredMediaType)) continue;

    // Sequential on purpose: extractors are tried in priority order and the
    // first one that produces trustworthy text wins, so running the rest would
    // be work whose result is discarded — and for external extractors, a child
    // process spawned for nothing.
    // oxlint-disable-next-line no-await-in-loop
    const result = await extractor.extract(bytes, context);
    if (!result.ok) {
      lastReason = result.reason;
      continue;
    }

    // An external PDF extractor need not report a page count, and without one
    // the per-page floor — the check that catches a 400-page scan yielding a
    // line of text — never runs. The structural probe knows the count without
    // reading a word of the content.
    const pages = result.value.pages ?? (format === 'pdf' ? probePdf(bytes).pages : null);

    const readable = stripInvisible(result.value.text);
    const verdict = assessText(readable, pages);
    if (!verdict.ok) {
      lastReason = verdict.reason;
      continue;
    }

    if (hidesIdentifiers(readable, options.countFindings)) {
      lastReason =
        'the spacing in this document splits identifiers, so they would not be recognised';
      continue;
    }

    // Measured against what the extractor produced, not against what `tidy`
    // left: tidy strips trailing spaces and collapses blank lines, and can
    // easily spend more than the one character of headroom, which would record
    // a document cut to a quarter of itself as having been read in full.
    const truncated = readable.length > limits.maxTextChars;
    const cleaned = tidy(readable);
    const text = cleaned.length > limits.maxTextChars ? cleaned.slice(0, limits.maxTextChars) : cleaned;

    return {
      report: {
        format,
        mediaType,
        bytes: bytes.byteLength,
        chars: text.length,
        pages,
        extractor: result.value.extractor,
        outcome: truncated ? 'truncated' : 'extracted',
        reason: truncated
          ? `text was cut at the ${limits.maxTextChars} character limit`
          : null,
      },
      replacement: textPart(header(site.filename, mediaType, pages, truncated), text),
    };
  }

  return refuse(site, format, mediaType, bytes.byteLength, lastReason, limits.onUnreadable, soFar);
}

/**
 * Apply `onUnreadable`.
 *
 * `block` throws. `withhold` puts a note where the document was, so the model
 * is told a document existed and could not be read rather than silently
 * answering about a prompt with a hole in it. `forward` leaves the original
 * part in place, which is the one path where bytes hushgate has not read reach
 * the provider — it exists because an operator may knowingly want it, and it is
 * reported by `doctor` and named in every audit record it touches.
 */
function refuse(
  site: AttachmentSite,
  format: AttachmentFormat,
  mediaType: string,
  bytes: number,
  reason: string,
  action: UnreadableAction,
  soFar: readonly AttachmentReport[],
  redactable = true,
): SiteOutcome {
  if (action === 'block') {
    // The attachments already handled travel with the error. Without them the
    // audit record for a blocked request would claim the request carried one
    // attachment when it carried five, and the four that were read — and whose
    // contents hushgate decoded — would leave no trace at all.
    throw new AttachmentBlockedError(mediaType, bytes, reason, format, [
      ...soFar,
      { format, mediaType, bytes, chars: 0, pages: null, extractor: null, outcome: 'blocked', reason },
    ]);
  }

  const report = { format, mediaType, bytes, chars: 0, pages: null, extractor: null, reason };

  if (action === 'forward') {
    return { report: { ...report, outcome: 'forwarded' as const }, replacement: null };
  }

  // The note names the file, and a filename is personal data as often as the
  // contents are. That is normally safe because the note goes where the
  // redactor will pseudonymise it — but the one refusal that fires *because*
  // the redactor cannot reach this path must not then write a name into it.
  const describe = redactable ? describeFile(site.filename, mediaType) : mediaType;

  return {
    report: { ...report, outcome: 'withheld' as const },
    replacement: textPart(
      `--- attachment withheld: ${describe}, ${formatBytes(bytes)} — hushgate could not read its text (${reason}) ---`,
      '',
    ),
  };
}

/**
 * The delimiter the model sees.
 *
 * The filename is included on purpose. It is frequently the most informative
 * thing about a document, and it is frequently personal data as well
 * ("Kuendigung_Anna_Schmidt.pdf") — which is exactly why it belongs here, in
 * the text, where the detectors will pseudonymise it, rather than in the audit
 * trail, where nothing pseudonymises anything.
 */
function header(
  filename: string | null,
  mediaType: string,
  pages: number | null,
  truncated: boolean,
): string {
  const parts = [mediaType];
  if (pages !== null) parts.push(`${pages} ${pages === 1 ? 'page' : 'pages'}`);
  if (truncated) parts.push('truncated by hushgate');
  return `--- attachment: ${describeFile(filename, mediaType)} (${parts.join(', ')}) ---`;
}

function describeFile(filename: string | null, mediaType: string): string {
  return filename === null || filename.trim() === '' ? mediaType : filename;
}

/**
 * Make extracted text fit to sit in a prompt.
 *
 * Runs only after the quality check has passed, and that ordering matters: a
 * form feed is exactly what a scanned page extracts to, so `quality.ts` counts
 * it as evidence that nothing was read. Once the text has been believed, the
 * same character is just a page break, and leaving a run of them in the middle
 * of a prompt spends the model's attention on nothing.
 */
/** Characters of context per probe, and how far the probe advances each time. */
const PROBE_WINDOW = 240;
const PROBE_STEP = 120;

/**
 * Does this text's spacing hide an identifier that is really in the document?
 *
 * The ratios in `quality.ts` measure a proxy for the thing that matters — how
 * short the words are — and every proxy can be walked around. Real kerning is
 * enough to do it: a PDF whose address block carries ordinary `TJ` offsets
 * comes out of `pdftotext` as `E-M ail : a nna .sc hmi dt@ nor dli cht`, which
 * has no one- or two-letter words at all, reads as fluent to every ratio, and
 * leaves the address matching nothing.
 *
 * So this asks the question directly. Run the detectors over a window of the
 * text, then over the same window with its spacing closed up, and see whether
 * closing the gaps reveals something that was not visible before. If it does,
 * the gaps were what hid it.
 *
 * A window rather than the whole document, because closing every gap in a page
 * of prose runs the words together and destroys the boundaries the detectors
 * need — done globally the check finds nothing and quietly never fires. A
 * window also keeps the honest cases honest: a column of country codes closes
 * up into `DEATCHFRIT`, which is not an identifier and reveals nothing, so a
 * table is not mistaken for a shredded address.
 *
 * It errs towards refusing, which is the direction this product errs in
 * everywhere else, and the operator is told which document and why.
 */
function hidesIdentifiers(text: string, count: RewriteOptions['countFindings']): boolean {
  if (count === undefined) return false;

  for (let start = 0; start < text.length; start += PROBE_STEP) {
    const window = text.slice(start, start + PROBE_WINDOW);
    // Horizontal space only, and blank-line runs collapsed rather than removed:
    // a line break is a boundary a detector may legitimately rely on.
    const closed = window.replaceAll(/[^\S\n]+/gu, '').replaceAll(/\n+/gu, '\n');
    if (closed.length === window.length) continue;
    if (count(closed) > count(window)) return true;
  }

  return false;
}

/**
 * Remove the characters that are invisible to a reader and fatal to a detector.
 *
 * A zero-width space between every two letters renders as ordinary prose and
 * leaves `anna.schmidt@nordlicht.example` matching no e-mail pattern — while
 * sailing past the fragmentation check, because to that check the letters are
 * still one long run. Extractors emit these for real: soft hyphens from
 * justified text, word joiners from PDF ligature handling, byte-order marks
 * from concatenated parts. Stripping them is what makes the text mean what it
 * looks like it means.
 *
 * Done before the quality check rather than after, so that what is judged is
 * what will be scanned.
 */
function stripInvisible(text: string): string {
  // The whole Default_Ignorable_Code_Point property rather than a hand-picked
  // list: hand-picked lists of this leave gaps, and every gap is a working
  // separator. Variation selectors, the Mongolian free variation selectors,
  // Hangul filler, the tag plane and the musical controls are all in it.
  //
  // The bidi embeddings and overrides are added on top. They are not
  // default-ignorable — a renderer acts on them — but they are invisible in
  // extracted text and serve the same purpose here.
  return text.replaceAll(/\p{Default_Ignorable_Code_Point}|[\u202A-\u202E]|\u0605/gu, '');
}

function tidy(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\f', '\n')
    .replaceAll(/[ \t]+$/gmu, '')
    .replaceAll(/\n{3,}/gu, '\n\n')
    .trim();
}

function textPart(head: string, text: string): JsonValue {
  const body = text === '' ? head : `${head}\n${text}\n--- end of attachment ---`;
  return { type: 'text', text: body };
}

const keyOf = (path: Path): string => JSON.stringify(path);

/**
 * Rebuild the body with the replacements in place.
 *
 * A copy rather than a mutation, for the same reason `mapStrings` makes one:
 * the caller still holds the parsed body and may need it — the residency
 * `warn` mode forwards the original — and a proxy that mutates its input
 * cannot offer that.
 */
function substitute(body: JsonValue, replacements: ReadonlyMap<string, JsonValue>): JsonValue {
  if (replacements.size === 0) return body;

  const walk = (node: JsonValue, path: (string | number)[]): JsonValue => {
    const replacement = replacements.get(keyOf(path));
    if (replacement !== undefined) return replacement;

    if (Array.isArray(node)) {
      return node.map((item, index) => {
        path.push(index);
        const next = walk(item, path);
        path.pop();
        return next;
      });
    }

    if (node !== null && typeof node === 'object') {
      // A null prototype, for the reason given in redact/traverse.ts: a body
      // carrying the key `__proto__` must survive the round trip as data.
      const out = Object.create(null) as Record<string, JsonValue>;
      for (const [key, item] of Object.entries(node)) {
        path.push(key);
        out[key] = walk(item, path);
        path.pop();
      }
      return out;
    }

    return node;
  };

  return walk(body, []);
}
