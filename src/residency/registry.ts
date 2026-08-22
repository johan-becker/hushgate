/**
 * An offline index of well-known LLM endpoints and where they are operated.
 *
 * Data only: no lookups, no network, no telemetry — the whole point of hushgate
 * is that it works on a machine with the cable pulled out. Entries record what
 * the operator publicly documents; they are a starting point for a transfer
 * assessment, not the conclusion of one. Anything you rely on belongs in your
 * own `residency.allow` list, where you also record the legal basis.
 */
import { jurisdiction, type Jurisdiction } from './jurisdictions.js';

/**
 * How a provider lets you switch off retention or training.
 *
 * `header` and `body` controls are applied automatically to every outbound
 * request. `account` and `contract` controls cannot be — they are settings or
 * clauses you arrange once with the provider — but they are recorded so that
 * `hushgate residency` can tell you what is available and `doctor` can tell you
 * when nothing is.
 */
export interface DataControl {
  readonly kind: 'zero-retention' | 'no-training';
  readonly mechanism: 'header' | 'body' | 'account' | 'contract' | 'inherent';
  /** Header to set on every outbound request. */
  readonly header?: { readonly name: string; readonly value: string };
  /** Body field to set on every outbound request, as a dotted path. */
  readonly body?: { readonly path: string; readonly value: boolean | string | number };
  readonly note: string;
}

export interface EndpointEntry {
  readonly id: string;
  readonly label: string;
  readonly operator: string;
  /** Hosts this entry covers. A leading `*.` matches any subdomain. */
  readonly hosts: readonly string[];
  /** ISO country code, or `UNKNOWN` when the host does not reveal it. */
  readonly jurisdiction: string;
  readonly dataControls: readonly DataControl[];
  readonly note: string;
}

const OPENAI_STORE_OFF: DataControl = {
  kind: 'zero-retention',
  mechanism: 'body',
  body: { path: 'store', value: false },
  note: 'store=false keeps the request and completion out of the dashboard and out of stored-completions retention.',
};

const OPENAI_NO_TRAINING: DataControl = {
  kind: 'no-training',
  mechanism: 'account',
  note: 'API traffic is not used for training by default; confirm the setting for your organisation.',
};

/** AWS Bedrock regional endpoints, by region code. */
const BEDROCK_REGIONS: Readonly<Record<string, string>> = {
  'eu-central-1': 'DE',
  'eu-central-2': 'CH',
  'eu-west-1': 'IE',
  'eu-west-2': 'GB',
  'eu-west-3': 'FR',
  'eu-north-1': 'SE',
  'eu-south-1': 'IT',
  'eu-south-2': 'ES',
  'us-east-1': 'US',
  'us-east-2': 'US',
  'us-west-2': 'US',
};

const BEDROCK_ENTRIES: EndpointEntry[] = Object.entries(BEDROCK_REGIONS).map(
  ([region, code]): EndpointEntry => ({
    id: `aws.bedrock.${region}`,
    label: `AWS Bedrock (${region})`,
    operator: 'Amazon Web Services',
    hosts: [`bedrock-runtime.${region}.amazonaws.com`, `bedrock.${region}.amazonaws.com`],
    jurisdiction: code,
    dataControls: [
      {
        kind: 'no-training',
        mechanism: 'contract',
        note: 'Bedrock does not use inputs or outputs to train models; the region determines where they are processed.',
      },
    ],
    note: 'Regional endpoint: the region in the host name is where the request is processed.',
  }),
);

export const BUILTIN_ENDPOINTS: readonly EndpointEntry[] = [
  {
    id: 'openai.api',
    label: 'OpenAI API',
    operator: 'OpenAI, L.L.C.',
    hosts: ['api.openai.com'],
    jurisdiction: 'US',
    dataControls: [OPENAI_STORE_OFF, OPENAI_NO_TRAINING],
    note: 'Default OpenAI endpoint. US-operated; personal data sent here is a third-country transfer.',
  },
  {
    id: 'anthropic.api',
    label: 'Anthropic API',
    operator: 'Anthropic PBC',
    hosts: ['api.anthropic.com'],
    jurisdiction: 'US',
    dataControls: [
      {
        kind: 'no-training',
        mechanism: 'contract',
        note: 'Commercial API traffic is not used to train models by default.',
      },
      {
        kind: 'zero-retention',
        mechanism: 'account',
        note: 'Zero data retention is arranged with Anthropic for the organisation, not per request.',
      },
    ],
    note: 'Default Anthropic endpoint. US-operated; personal data sent here is a third-country transfer.',
  },
  {
    id: 'google.generativelanguage',
    label: 'Google Gemini API',
    operator: 'Google LLC',
    hosts: ['generativelanguage.googleapis.com'],
    jurisdiction: 'US',
    dataControls: [
      {
        kind: 'no-training',
        mechanism: 'contract',
        note: 'Paid tiers are not used for training; the free tier is.',
      },
    ],
    note: 'Global endpoint. Use a regional Vertex AI endpoint when processing location matters.',
  },
  {
    id: 'azure.openai',
    label: 'Azure OpenAI Service',
    operator: 'Microsoft',
    hosts: ['*.openai.azure.com', '*.cognitiveservices.azure.com'],
    jurisdiction: 'UNKNOWN',
    dataControls: [
      {
        kind: 'no-training',
        mechanism: 'contract',
        note: 'Azure OpenAI does not use customer data to train models.',
      },
      {
        kind: 'zero-retention',
        mechanism: 'account',
        note: 'Abuse-monitoring storage can be switched off by approved subscriptions.',
      },
    ],
    note: 'The resource region is not derivable from the host name. Declare the jurisdiction of your deployment in residency.allow.',
  },
  ...BEDROCK_ENTRIES,
  {
    id: 'mistral.api',
    label: 'Mistral AI — La Plateforme',
    operator: 'Mistral AI SAS',
    hosts: ['api.mistral.ai'],
    jurisdiction: 'FR',
    dataControls: [
      {
        kind: 'no-training',
        mechanism: 'contract',
        note: 'Paid API traffic is not used for training.',
      },
    ],
    note: 'French operator, EU-hosted.',
  },
  {
    id: 'alephalpha.api',
    label: 'Aleph Alpha',
    operator: 'Aleph Alpha GmbH',
    hosts: ['api.aleph-alpha.com'],
    jurisdiction: 'DE',
    dataControls: [
      { kind: 'no-training', mechanism: 'contract', note: 'German operator, contractual terms apply.' },
    ],
    note: 'German operator, EU-hosted.',
  },
  {
    id: 'ionos.inference',
    label: 'IONOS AI Model Hub',
    operator: 'IONOS SE',
    hosts: ['inference.de-txl.ionos.com', 'openai.inference.de-txl.ionos.com'],
    jurisdiction: 'DE',
    dataControls: [
      { kind: 'no-training', mechanism: 'contract', note: 'German data centres, German operator.' },
    ],
    note: 'German data centre (Berlin/Frankfurt), OpenAI-compatible API.',
  },
  {
    id: 'ovh.endpoints',
    label: 'OVHcloud AI Endpoints',
    operator: 'OVH Groupe SAS',
    hosts: ['*.endpoints.kepler.ai.cloud.ovh.net', '*.endpoints.ai.cloud.ovh.net'],
    jurisdiction: 'FR',
    dataControls: [
      { kind: 'no-training', mechanism: 'contract', note: 'French operator, EU data centres.' },
    ],
    note: 'French operator, EU-hosted, OpenAI-compatible API.',
  },
  {
    id: 'scaleway.generative',
    label: 'Scaleway Generative APIs',
    operator: 'Scaleway SAS',
    hosts: ['api.scaleway.ai'],
    jurisdiction: 'FR',
    dataControls: [
      { kind: 'no-training', mechanism: 'contract', note: 'French operator, EU data centres.' },
    ],
    note: 'French operator, EU-hosted, OpenAI-compatible API.',
  },
  {
    id: 'local.runtime',
    label: 'Local model runtime (Ollama, vLLM, LM Studio, llama.cpp)',
    operator: 'you',
    hosts: ['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'],
    jurisdiction: 'LOCAL',
    dataControls: [
      {
        kind: 'zero-retention',
        mechanism: 'inherent',
        note: 'The request never leaves the machine, so there is nothing to retain elsewhere.',
      },
      { kind: 'no-training', mechanism: 'inherent', note: 'No third party sees the request.' },
    ],
    note: 'Nothing leaves your infrastructure. The strongest available answer to a transfer question.',
  },
];

/** An endpoint entry, resolved together with its jurisdiction record. */
export interface EndpointMatch {
  readonly entry: EndpointEntry;
  readonly jurisdiction: Jurisdiction;
  /** The host that matched. */
  readonly host: string;
}

/** Does `pattern` cover `host`? `*.example.com` matches any subdomain of it. */
export function hostMatches(pattern: string, host: string): boolean {
  const target = host.toLowerCase();
  const rule = pattern.toLowerCase();

  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return target.endsWith(suffix) && target.length > suffix.length;
  }
  return target === rule;
}

/**
 * Look up a host in the registry.
 *
 * The most specific match wins, so an explicit host always beats a wildcard —
 * `bedrock-runtime.eu-central-1.amazonaws.com` must not be answered by a
 * `*.amazonaws.com` entry someone adds later.
 */
export function lookupEndpoint(
  host: string,
  extra: readonly EndpointEntry[] = [],
): EndpointMatch | null {
  const bare = host.toLowerCase().replace(/:\d+$/u, '');
  let best: { entry: EndpointEntry; pattern: string } | null = null;

  // User entries are consulted first so an operator can override a built-in.
  for (const entry of [...extra, ...BUILTIN_ENDPOINTS]) {
    for (const pattern of entry.hosts) {
      if (!hostMatches(pattern, bare)) continue;
      if (best === null || specificity(pattern) > specificity(best.pattern)) {
        best = { entry, pattern };
      }
    }
  }

  if (best === null) return null;
  return { entry: best.entry, jurisdiction: jurisdiction(best.entry.jurisdiction), host: bare };
}

/** Exact hosts beat wildcards; longer wildcards beat shorter ones. */
function specificity(pattern: string): number {
  return pattern.startsWith('*.') ? pattern.length : 1000 + pattern.length;
}

/** Every jurisdiction the built-in registry knows about, for `residency --list`. */
export function knownJurisdictions(extra: readonly EndpointEntry[] = []): string[] {
  const codes = new Set([...extra, ...BUILTIN_ENDPOINTS].map((entry) => entry.jurisdiction));
  return [...codes].toSorted();
}
