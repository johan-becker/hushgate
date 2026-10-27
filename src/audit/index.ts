export { JsonlAuditLog, nullAuditLog, readHead } from './log.js';
export type { AuditFileStat, AuditFileSystem, AuditLogOptions, AuditSink, AuditStart } from './log.js';
export { GENESIS_HASH, hashBody, INVALID_VALUE, recomputeHash, toRecord } from './record.js';
export type {
  AuditAttachment,
  AuditEvent,
  AuditOutcome,
  AuditRecord,
  AuditResidency,
} from './record.js';
export {
  isHash,
  MAX_LINE_BYTES,
  parseAuditLines,
  parseTrailLine,
  printable,
  readTrailEntries,
  TRAIL_CHUNK_BYTES,
} from './trail.js';
export type {
  MalformedEntry,
  MalformedLine,
  TrailEntry,
  TrailReadOptions,
  TrailRecord,
} from './trail.js';
export {
  ChainVerifier,
  REPORTED_LIMIT,
  verifyChain,
  verifyTrail,
  verifyTrailFile,
} from './verify.js';
export type {
  AnchorCheck,
  ChainBreak,
  ChainGap,
  ChainVerification,
  TrailVerification,
  VerifyOptions,
} from './verify.js';
export {
  buildReport,
  parsePeriod,
  renderMarkdown,
  ReportBuilder,
  withinPeriod,
} from './report.js';
export type {
  AttachmentRow,
  CategoryRow,
  MalformedLines,
  ProcessingReport,
  RecipientRow,
  ReportBuilderOptions,
  ReportEvidence,
  ReportOptions,
  ReportPeriod,
  UnreadableLines,
} from './report.js';
export {
  configuredTrails,
  resolveTrailPath,
  trailFileKeys,
  trailWriteProblem,
} from './paths.js';
export type { ConfiguredTrail, TrailWriteProblem } from './paths.js';
