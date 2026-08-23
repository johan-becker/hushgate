/**
 * Attachment handling: bytes in a request body become text a detector can read,
 * or the request does not go out.
 */
export { decodeBase64, formatBytes, parseDataUrl } from './decode.js';
export { emlToText } from './eml.js';
export { externalExtractor, probeCommand } from './external.js';
export { htmlToText } from './html.js';
export { extractOoxml } from './ooxml.js';
export { probePdf, type PdfProbe } from './pdf.js';
export { decodeText } from './plaintext.js';
export {
  assessText,
  DEFAULT_QUALITY_LIMITS,
  hidesIdentifiers,
  type QualityVerdict,
} from './quality.js';
export { BUILTIN_EXTRACTORS, buildExtractors } from './registry.js';
export {
  rewriteAttachments,
  type RewriteLimits,
  type RewriteOptions,
  type RewriteResult,
} from './rewrite.js';
export { rtfToText } from './rtf.js';
export { findAttachmentSites, type AttachmentSite } from './shapes.js';
export { mediaTypeForFormat, normaliseMediaType, sniffFormat } from './sniff.js';
export { readZip, type ZipEntry } from './zip.js';
export type {
  Attachment,
  AttachmentFormat,
  AttachmentOutcome,
  AttachmentReport,
  ExternalExtractorSpec,
  ExtractedText,
  ExtractionContext,
  ExtractionResult,
  Extractor,
  UnreadableAction,
} from './types.js';
