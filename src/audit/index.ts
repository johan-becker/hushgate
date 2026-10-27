export { JsonlAuditLog, nullAuditLog, readHead } from './log.js';
export type { AuditLogOptions, AuditSink } from './log.js';
export { GENESIS_HASH, hashBody, recomputeHash, toRecord } from './record.js';
export type { AuditEvent, AuditOutcome, AuditRecord, AuditResidency } from './record.js';
export { parseAuditLines } from './trail.js';
export { verifyChain } from './verify.js';
export type { ChainBreak, ChainVerification } from './verify.js';
export { buildReport, renderMarkdown, withinPeriod } from './report.js';
export type {
  CategoryRow,
  ProcessingReport,
  RecipientRow,
  ReportOptions,
  ReportPeriod,
} from './report.js';
