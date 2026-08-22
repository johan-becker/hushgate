/**
 * hushgate — a local-first PII firewall for cloud LLM APIs.
 *
 * Everything here is a plain library; the HTTP proxy is only one consumer of it.
 */
export { VERSION } from './version.js';
export * from './types.js';
export * from './errors.js';
export * from './detectors/index.js';
export * from './redact/index.js';
export * from './stream/index.js';
export * from './audit/index.js';
export * from './residency/index.js';
export * from './tenants/index.js';
export * from './proxy/index.js';
export * from './config.js';
