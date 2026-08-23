/**
 * A structural probe of a PDF, deliberately not a text extractor.
 *
 * There was a from-scratch PDF extractor here during design. It read the files
 * it was written against and then failed *silently* on ordinary ones: a font
 * with a custom encoding yields plausible words that are not the words on the
 * page, and a scanned contract yields nothing at all while reporting success.
 * Either way the model receives a document no detector could read, and the
 * audit trail says the attachment was pseudonymised. That is the one failure
 * this product cannot have, so hushgate refuses PDFs it cannot hand to the
 * external tier instead of half-reading them.
 *
 * What survives is the part that can be done honestly without a parser: enough
 * structure for a truthful error message and a truthful audit record. Every
 * field below is evidence about the file, never its contents, and every scan
 * is bounded — the probe must stay cheap on a file whose only purpose is to be
 * expensive.
 */

/** What can be said about a PDF without reading it. */
export interface PdfProbe {
  readonly isPdf: boolean;
  /** The version in the header, e.g. `1.7`. */
  readonly version: string | null;
  /** Page count, best effort; `null` when the structure did not say. */
  readonly pages: number | null;
  readonly encrypted: boolean;
  /**
   * True when the file contains at least one font resource, i.e. it plausibly
   * has a text layer rather than being a pure scan.
   */
  readonly hasTextLayer: boolean;
}

/** The window a `%PDF-` header may hide in; `sniff.ts` looks in the same one. */
const PDF_HEADER_WINDOW = 1024;

/**
 * Bytes read from each end of the file.
 *
 * The trailer and its `/Encrypt` reference live at the end, the catalogue and
 * the page tree usually near the start, and a hundred megabytes in between are
 * image data that answers none of the questions asked here.
 */
const SCAN_WINDOW_BYTES = 2 * 1024 * 1024;

/** Page-tree nodes examined per window. A document has one root, not thousands. */
const MAX_PAGE_NODES = 2048;

/** Characters either side of a `/Type /Pages` a matching `/Count` may sit in. */
const COUNT_RADIUS = 512;

/** Ceiling on counted page objects, so a crafted file cannot spin here. */
const MAX_PAGE_OBJECTS = 100_000;

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

const NOT_A_PDF: PdfProbe = {
  isPdf: false,
  version: null,
  pages: null,
  encrypted: false,
  hasTextLayer: false,
};

const hasPrefix = (bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean => {
  if (offset + prefix.length > bytes.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
};

const findHeader = (bytes: Uint8Array): number | null => {
  const limit = Math.min(bytes.length, PDF_HEADER_WINDOW);
  for (let index = 0; index + PDF_HEADER.length <= limit; index += 1) {
    if (hasPrefix(bytes, index, PDF_HEADER)) return index;
  }
  return null;
};

/**
 * One byte per character.
 *
 * A PDF's structure is ASCII wrapped around binary streams, and latin-1 is the
 * decoding that leaves those streams as harmless characters instead of
 * replacement marks that could merge two neighbouring bytes into one.
 */
const latin1 = (bytes: Uint8Array, start: number, end: number): string =>
  start >= end ? '' : Buffer.from(bytes.subarray(start, end)).toString('latin1');

const readVersion = (head: string, header: number): string | null => {
  const match = /^%PDF-(\d\.\d)/u.exec(head.slice(header, header + 16));
  return match?.[1] ?? null;
};

/**
 * The `/Count` the page tree declares.
 *
 * Preferred over counting page objects because it is one number the producer
 * wrote deliberately, and because it stays right when the objects themselves
 * are spread beyond the scanned windows. `/Count` also appears in outline
 * dictionaries, so only occurrences near a `/Type /Pages` are believed.
 *
 * Which of them to believe is the interesting part. The root of the tree is the
 * `/Pages` node with no `/Parent`, and a well-formed file has exactly one, so
 * the usual case is unambiguous. A file that has been edited by appending an
 * incremental update, or spliced together, carries the previous revision's root
 * as well, and then there is no way to tell from bytes alone which is live.
 *
 * Where it cannot tell, it takes the **smallest** count, and that choice is
 * deliberate. The two errors are not equal. Over-counting divides the extracted
 * text by pages that are not there and refuses a perfectly readable document —
 * a one-page letter spliced onto an old ninety-six-page draft would be rejected
 * outright. Under-counting only makes the per-page floor lenient, and a
 * document with no text left to find still fails the overall character floor,
 * which does not depend on this number at all. So the failure that stays is the
 * recoverable one.
 *
 * This is a heuristic over bytes, not a parse of the cross-reference table. It
 * decides only whether a document has too little text for its length, and the
 * honest answer when it cannot tell is `0`, which turns the floor off.
 */
const pageTreeCount = (text: string): number => {
  const nodes = /\/Type\s*\/Pages\b/gu;
  const roots: number[] = [];
  const others: number[] = [];
  let seen = 0;
  let match: RegExpExecArray | null;

  while ((match = nodes.exec(text)) !== null && seen < MAX_PAGE_NODES) {
    seen += 1;
    const window = text.slice(Math.max(0, match.index - COUNT_RADIUS), match.index + COUNT_RADIUS);
    const count = /\/Count\s+(\d{1,9})/u.exec(window);
    if (count === null) continue;

    const value = Number(count[1] ?? 0);
    if (value <= 0) continue;
    if (/\/Parent\b/u.test(window)) others.push(value);
    else roots.push(value);
  }

  const candidates = roots.length > 0 ? roots : others;
  return candidates.length === 0 ? 0 : Math.min(...candidates);
};

/** Page objects, for files whose page tree says nothing. */
const countPageObjects = (text: string): number => {
  const pages = /\/Type\s*\/Page(?![A-Za-z])/gu;
  let count = 0;
  while (count < MAX_PAGE_OBJECTS && pages.exec(text) !== null) count += 1;
  return count;
};

const readPageCount = (head: string, tail: string, complete: boolean): number | null => {
  const fromHead = pageTreeCount(head);
  const fromTail = pageTreeCount(tail);
  // Same reasoning as within a window: where the two halves disagree, the
  // smaller number is the one whose error is recoverable.
  const declared =
    fromHead > 0 && fromTail > 0 ? Math.min(fromHead, fromTail) : Math.max(fromHead, fromTail);
  if (declared > 0) return declared;
  // Counting objects in the part of a file we chose not to read would produce a
  // number that looks authoritative and is not. `null` is the honest answer.
  if (!complete) return null;

  const counted = countPageObjects(head) + countPageObjects(tail);
  return counted > 0 ? counted : null;
};

/**
 * Read what a PDF says about itself.
 *
 * Every signal is a substring search over two windows, which over-reports
 * rather than under-reports: a content stream may contain the literal
 * `/Encrypt`, and the answer is then a more cautious refusal message than the
 * file deserved — never a less cautious one.
 */
export function probePdf(bytes: Uint8Array): PdfProbe {
  const header = findHeader(bytes);
  if (header === null) return NOT_A_PDF;

  const headEnd = Math.min(bytes.length, SCAN_WINDOW_BYTES);
  const tailStart = Math.max(headEnd, bytes.length - SCAN_WINDOW_BYTES);
  const head = latin1(bytes, 0, headEnd);
  const tail = latin1(bytes, tailStart, bytes.length);

  return {
    isPdf: true,
    version: readVersion(head, header),
    pages: readPageCount(head, tail, tailStart <= headEnd),
    encrypted: /\/Encrypt\b/u.test(head) || /\/Encrypt\b/u.test(tail),
    // Weak evidence in one direction only. A font resource that lives inside a
    // compressed object stream — the normal arrangement since PDF 1.5 — is
    // invisible to a substring search, so `false` means "no font was visible",
    // not "this is a scan". `true` is the reliable half.
    hasTextLayer: /\/(?:BaseFont|Font)/u.test(head) || /\/(?:BaseFont|Font)/u.test(tail),
  };
}
