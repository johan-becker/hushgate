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
import type { JsonValue, Path } from '../redact/traverse.js';
import { decodeBase64, formatBytes } from './decode.js';
import { assessText } from './quality.js';
import { findAttachmentSites, type AttachmentSite } from './shapes.js';
import { sniffFormat } from './sniff.js';
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
  let spent = 0;

  for (const site of sites) {
    // Sequential on purpose. `spent` is a running total against
    // `maxTotalBytes`, which only means anything if each attachment is measured
    // against what the ones before it already cost; and extraction may spawn a
    // child process, so a request carrying twenty documents must not become
    // twenty concurrent processes.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await handleSite(site, options, spent);
    spent += outcome.report.bytes;
    reports.push(outcome.report);
    if (outcome.replacement !== null) replacements.set(keyOf(site.path), outcome.replacement);
  }

  return { body: substitute(body, replacements), reports };
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
): Promise<SiteOutcome> {
  const { limits } = options;
  const declared = site.declaredMediaType ?? 'application/octet-stream';

  if (site.unresolvable !== null) {
    return refuse(site, 'unknown', declared, 0, site.unresolvable, limits.onUnreadable);
  }

  if (site.data === null) {
    return refuse(site, 'unknown', declared, 0, 'attachment carries no data', limits.onUnreadable);
  }

  const decoded = decodeBase64(site.data, limits.maxBytes);
  if (!decoded.ok) {
    return refuse(site, 'unknown', declared, 0, decoded.reason, limits.onUnreadable);
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
    );
  }

  const format = sniffFormat(bytes, site.declaredMediaType, site.filename);
  const mediaType = site.declaredMediaType ?? mediaTypeFor(format);
  const context = {
    format,
    mediaType: site.declaredMediaType,
    maxChars: limits.maxTextChars,
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

    const verdict = assessText(result.value.text, result.value.pages);
    if (!verdict.ok) {
      lastReason = verdict.reason;
      continue;
    }

    const truncated = result.value.text.length > limits.maxTextChars;
    const text = truncated ? result.value.text.slice(0, limits.maxTextChars) : result.value.text;

    return {
      report: {
        format,
        mediaType,
        bytes: bytes.byteLength,
        chars: text.length,
        pages: result.value.pages,
        extractor: result.value.extractor,
        outcome: truncated ? 'truncated' : 'extracted',
        reason: truncated
          ? `text was cut at the ${limits.maxTextChars} character limit`
          : null,
      },
      replacement: textPart(header(site.filename, mediaType, result.value.pages, truncated), text),
    };
  }

  return refuse(site, format, mediaType, bytes.byteLength, lastReason, limits.onUnreadable);
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
): SiteOutcome {
  if (action === 'block') throw new AttachmentBlockedError(mediaType, bytes, reason);

  const report = { format, mediaType, bytes, chars: 0, pages: null, extractor: null, reason };

  if (action === 'forward') {
    return { report: { ...report, outcome: 'forwarded' as const }, replacement: null };
  }

  return {
    report: { ...report, outcome: 'withheld' as const },
    replacement: textPart(
      `--- attachment withheld: ${describeFile(site.filename, mediaType)}, ${formatBytes(bytes)} — hushgate could not read its text (${reason}) ---`,
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

function textPart(head: string, text: string): JsonValue {
  const body = text === '' ? head : `${head}\n${text}\n--- end of attachment ---`;
  return { type: 'text', text: body };
}

function mediaTypeFor(format: AttachmentFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf';
    case 'html':
      return 'text/html';
    case 'csv':
      return 'text/csv';
    case 'json':
      return 'application/json';
    case 'xml':
      return 'application/xml';
    case 'text':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
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
