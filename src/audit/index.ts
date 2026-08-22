export { JsonlAuditLog, nullAuditLog, parseAuditLines, readHead } from './log.js';
export type { AuditLogOptions, AuditSink } from './log.js';
export { GENESIS_HASH, hashBody, recomputeHash, toRecord, verifyChain } from './record.js';
export type {
  AuditEvent,
  AuditOutcome,
  AuditRecord,
  AuditResidency,
  ChainBreak,
  ChainVerification,
} from './record.js';
export { buildReport, renderMarkdown, withinPeriod } from './report.js';
export type {
  CategoryRow,
  ProcessingReport,
  RecipientRow,
  ReportOptions,
  ReportPeriod,
} from './report.js';
