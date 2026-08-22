/**
 * hushgate — a local-first PII firewall for cloud LLM APIs.
 *
 * Everything here is a plain library; the HTTP proxy is only one consumer of it.
 */
export const VERSION = '0.1.0';

export * from './types.js';
export * from './errors.js';
export * from './detectors/index.js';
export * from './redact/index.js';
