/**
 * Jurisdictions, as they matter for a Chapter V transfer assessment.
 *
 * This is a convenience index, not legal advice, and it is deliberately coarse:
 * it records where an endpoint is operated and how that place stands in
 * relation to the EEA. Whether *your* transfer is lawful depends on your
 * contract, your purpose and your DPO — not on this table.
 */

export type TransferStatus =
  /** Inside the EU/EEA: no Chapter V transfer at all. */
  | 'eea'
  /** Outside the EEA, covered by an adequacy decision. */
  | 'adequate'
  /** Outside the EEA, no adequacy: needs safeguards under Article 46. */
  | 'third-country'
  /** Never leaves the operator's own infrastructure. */
  | 'local'
  /** Cannot be determined from the endpoint alone; the operator must declare it. */
  | 'unknown';

export interface Jurisdiction {
  readonly code: string;
  readonly name: string;
  readonly status: TransferStatus;
  /** One line an engineer can paste into a ticket for their DPO. */
  readonly note: string;
}

const EEA = (code: string, name: string): Jurisdiction => ({
  code,
  name,
  status: 'eea',
  note: 'Inside the EU/EEA: no third-country transfer under GDPR Chapter V.',
});

export const JURISDICTIONS: Readonly<Record<string, Jurisdiction>> = {
  DE: EEA('DE', 'Germany'),
  FR: EEA('FR', 'France'),
  IE: EEA('IE', 'Ireland'),
  NL: EEA('NL', 'Netherlands'),
  SE: EEA('SE', 'Sweden'),
  IT: EEA('IT', 'Italy'),
  ES: EEA('ES', 'Spain'),
  BE: EEA('BE', 'Belgium'),
  FI: EEA('FI', 'Finland'),
  PL: EEA('PL', 'Poland'),
  CH: {
    code: 'CH',
    name: 'Switzerland',
    status: 'adequate',
    note: 'Outside the EEA, covered by an adequacy decision.',
  },
  GB: {
    code: 'GB',
    name: 'United Kingdom',
    status: 'adequate',
    note: 'Outside the EEA, covered by an adequacy decision.',
  },
  US: {
    code: 'US',
    name: 'United States',
    status: 'third-country',
    note: 'Third country. The EU–US Data Privacy Framework covers certified organisations only; otherwise Article 46 safeguards apply.',
  },
  LOCAL: {
    code: 'LOCAL',
    name: 'Your own infrastructure',
    status: 'local',
    note: 'The request never leaves infrastructure you operate.',
  },
  UNKNOWN: {
    code: 'UNKNOWN',
    name: 'Undeclared',
    status: 'unknown',
    note: 'The hosting location cannot be derived from the endpoint; declare it in residency.allow.',
  },
};

export function jurisdiction(code: string): Jurisdiction {
  return JURISDICTIONS[code.toUpperCase()] ?? {
    code: code.toUpperCase(),
    name: code.toUpperCase(),
    status: 'unknown',
    note: 'Not in the built-in jurisdiction table; treated as undeclared.',
  };
}

/** True when a transfer to this jurisdiction leaves the EEA. */
export function leavesTheEea(code: string): boolean {
  const status = jurisdiction(code).status;
  return status !== 'eea' && status !== 'local';
}
