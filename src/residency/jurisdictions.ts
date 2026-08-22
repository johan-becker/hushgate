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

const ADEQUATE = (code: string, name: string, detail = ''): Jurisdiction => ({
  code,
  name,
  status: 'adequate',
  note: `Outside the EEA, covered by an adequacy decision.${detail === '' ? '' : ` ${detail}`}`,
});

export const JURISDICTIONS: Readonly<Record<string, Jurisdiction>> = {
  // The EU 27. Listing only some of them made the rest resolve as "unknown",
  // which told an operator who had correctly declared an Austrian or Danish
  // endpoint that it was undeclared — and printed an intra-EEA transfer as
  // **undeclared** in the Article 30 report, which is the wrong legal
  // characterisation in the one document the tool is sold on.
  AT: EEA('AT', 'Austria'),
  BE: EEA('BE', 'Belgium'),
  BG: EEA('BG', 'Bulgaria'),
  HR: EEA('HR', 'Croatia'),
  CY: EEA('CY', 'Cyprus'),
  CZ: EEA('CZ', 'Czechia'),
  DK: EEA('DK', 'Denmark'),
  EE: EEA('EE', 'Estonia'),
  FI: EEA('FI', 'Finland'),
  FR: EEA('FR', 'France'),
  DE: EEA('DE', 'Germany'),
  GR: EEA('GR', 'Greece'),
  HU: EEA('HU', 'Hungary'),
  IE: EEA('IE', 'Ireland'),
  IT: EEA('IT', 'Italy'),
  LV: EEA('LV', 'Latvia'),
  LT: EEA('LT', 'Lithuania'),
  LU: EEA('LU', 'Luxembourg'),
  MT: EEA('MT', 'Malta'),
  NL: EEA('NL', 'Netherlands'),
  PL: EEA('PL', 'Poland'),
  PT: EEA('PT', 'Portugal'),
  RO: EEA('RO', 'Romania'),
  SK: EEA('SK', 'Slovakia'),
  SI: EEA('SI', 'Slovenia'),
  ES: EEA('ES', 'Spain'),
  SE: EEA('SE', 'Sweden'),
  // The three EEA-EFTA states. The GDPR applies to them by the EEA Agreement,
  // so a transfer here is not a Chapter V transfer either.
  IS: EEA('IS', 'Iceland'),
  LI: EEA('LI', 'Liechtenstein'),
  NO: EEA('NO', 'Norway'),
  // Adequacy decisions in force under Article 45.
  AD: ADEQUATE('AD', 'Andorra'),
  AR: ADEQUATE('AR', 'Argentina'),
  CA: ADEQUATE('CA', 'Canada', 'Commercial organisations subject to PIPEDA only.'),
  CH: ADEQUATE('CH', 'Switzerland'),
  FO: ADEQUATE('FO', 'Faroe Islands'),
  GB: ADEQUATE('GB', 'United Kingdom'),
  GG: ADEQUATE('GG', 'Guernsey'),
  IL: ADEQUATE('IL', 'Israel'),
  IM: ADEQUATE('IM', 'Isle of Man'),
  JE: ADEQUATE('JE', 'Jersey'),
  JP: ADEQUATE('JP', 'Japan'),
  KR: ADEQUATE('KR', 'Republic of Korea'),
  NZ: ADEQUATE('NZ', 'New Zealand'),
  UY: ADEQUATE('UY', 'Uruguay'),
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
