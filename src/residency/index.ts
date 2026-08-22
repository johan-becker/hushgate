export { jurisdiction, JURISDICTIONS, leavesTheEea } from './jurisdictions.js';
export type { Jurisdiction, TransferStatus } from './jurisdictions.js';
export {
  BUILTIN_ENDPOINTS,
  hostMatches,
  knownJurisdictions,
  lookupEndpoint,
} from './registry.js';
export type { DataControl, EndpointEntry, EndpointMatch } from './registry.js';
export {
  assertNotBlocked,
  assertUpstreamsPermitted,
  covers,
  defaultResidencyConfig,
  ENFORCEMENT_MODES,
  enforcementFor,
  evaluateUpstream,
  isEnforcementMode,
  strictest,
} from './policy.js';
export type {
  AllowEntry,
  EnforcementDecision,
  EnforcementMode,
  ResidencyConfig,
  ResidencyVerdict,
} from './policy.js';
