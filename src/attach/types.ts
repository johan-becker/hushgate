/**
 * Shared vocabulary for attachment handling.
 *
 * An attachment enters as bytes and leaves as text, or it does not leave at
 * all. Everything in this file describes one of those two outcomes; there is
 * deliberately no third state where bytes are forwarded because extraction
 * "mostly worked". A document hushgate cannot read is a document hushgate
 * cannot pseudonymise, and the whole product rests on not guessing about that.
 */

/** Formats the built-in tier recognises. `unknown` is a refusal, not a default. */
export const ATTACHMENT_FORMATS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'html',
  'rtf',
  'eml',
  'csv',
  'text',
  'json',
  'xml',
  'image',
  'unknown',
] as const;

export type AttachmentFormat = (typeof ATTACHMENT_FORMATS)[number];

/**
 * What happened to one attachment. These names appear verbatim in the audit
 * trail and in metrics labels, so they are part of the operator-facing
 * contract and must not be renamed casually.
 */
export type AttachmentOutcome =
  /** Text was extracted and inlined into the prompt. */
  | 'extracted'
  /** Text was extracted, then cut at `maxTextChars`. Still forwarded. */
  | 'truncated'
  /** No tier could produce trustworthy text. The `onUnreadable` policy decided. */
  | 'unreadable'
  /** Removed from the request; the rest of the request went on. */
  | 'withheld'
  /** Larger than the configured cap; never decoded. */
  | 'oversize'
  /** Forwarded as it arrived, because the operator configured `forward`. */
  | 'forwarded';

/** What to do with an attachment whose text hushgate could not read. */
export type UnreadableAction =
  /** Refuse the whole request. Nothing leaves the machine. The default. */
  | 'block'
  /** Drop the attachment, note it in the prompt, forward the rest. */
  | 'withhold'
  /** Send the original bytes upstream. Unsafe, and reported as such. */
  | 'forward';

/** A decoded attachment, before any extractor has looked at it. */
export interface Attachment {
  /** Where in the request body it was found, for rewriting it back. */
  readonly path: readonly (string | number)[];
  /** Raw bytes as they will be handed to an extractor. */
  readonly bytes: Uint8Array;
  /** Media type the caller declared, lowercased, parameters stripped. */
  readonly declaredMediaType: string | null;
  /**
   * Filename the caller declared. Reaches the prompt (where the detectors
   * pseudonymise it) but never the audit trail: `Kuendigung_Anna_Schmidt.pdf`
   * is personal data.
   */
  readonly filename: string | null;
}

/** A reference hushgate cannot resolve: a remote URL, or a provider file id. */
export interface UnresolvableAttachment {
  readonly path: readonly (string | number)[];
  /** Why it cannot be read, in words fit for an error message. */
  readonly reason: string;
  readonly declaredMediaType: string | null;
}

/** Text an extractor produced, with what is known about how good it is. */
export interface ExtractedText {
  readonly text: string;
  /** Page count, when the format has pages and the extractor reported one. */
  readonly pages: number | null;
  /** Identifier of the extractor, e.g. `builtin.ooxml` or `external.pdftotext`. */
  readonly extractor: string;
}

/** Extraction either produced text, or explained itself. */
export type ExtractionResult =
  | { readonly ok: true; readonly value: ExtractedText }
  | { readonly ok: false; readonly reason: string };

/**
 * A source of text for some set of formats.
 *
 * Built-in extractors are synchronous but declared async so the registry has
 * one shape to dispatch to; an external extractor is a child process and could
 * not be synchronous even if we wanted it to be.
 */
export interface Extractor {
  readonly name: string;
  /** True when this extractor is willing to try this format and media type. */
  supports(format: AttachmentFormat, mediaType: string | null): boolean;
  extract(bytes: Uint8Array, context: ExtractionContext): Promise<ExtractionResult>;
}

/** Everything an extractor is allowed to know about the request around it. */
export interface ExtractionContext {
  readonly format: AttachmentFormat;
  readonly mediaType: string | null;
  /** Hard cap on returned characters. Extractors may stop early at this. */
  readonly maxChars: number;
  /** Wall-clock budget for this one attachment. */
  readonly timeoutMs: number;
}

/** One line of the audit trail's attachment list. Counts only, never content. */
export interface AttachmentReport {
  readonly format: AttachmentFormat;
  /** Media type as detected, falling back to what the caller declared. */
  readonly mediaType: string;
  readonly bytes: number;
  /** Characters of text extracted. A length, not the text. */
  readonly chars: number;
  readonly pages: number | null;
  /** Which extractor answered, or `null` when none could. */
  readonly extractor: string | null;
  readonly outcome: AttachmentOutcome;
}
