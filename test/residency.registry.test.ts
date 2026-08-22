import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ENDPOINTS,
  hostMatches,
  knownJurisdictions,
  lookupEndpoint,
  type EndpointEntry,
} from '../src/residency/registry.js';
import { jurisdiction, leavesTheEea } from '../src/residency/jurisdictions.js';

describe('hostMatches', () => {
  it('matches exact hosts', () => {
    expect(hostMatches('api.openai.com', 'api.openai.com')).toBe(true);
    expect(hostMatches('api.openai.com', 'api.openai.com.evil.test')).toBe(false);
  });

  it('matches subdomains for a leading wildcard, but not the bare domain', () => {
    expect(hostMatches('*.openai.azure.com', 'contoso.openai.azure.com')).toBe(true);
    expect(hostMatches('*.openai.azure.com', 'openai.azure.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostMatches('API.OpenAI.com', 'api.openai.com')).toBe(true);
  });
});

describe('lookupEndpoint', () => {
  it('knows the two default US endpoints', () => {
    expect(lookupEndpoint('api.openai.com')!.jurisdiction.code).toBe('US');
    expect(lookupEndpoint('api.anthropic.com')!.jurisdiction.code).toBe('US');
  });

  it('knows EU-hosted alternatives', () => {
    expect(lookupEndpoint('api.mistral.ai')!.jurisdiction.code).toBe('FR');
    expect(lookupEndpoint('api.aleph-alpha.com')!.jurisdiction.code).toBe('DE');
    expect(lookupEndpoint('inference.de-txl.ionos.com')!.jurisdiction.code).toBe('DE');
    expect(lookupEndpoint('api.scaleway.ai')!.jurisdiction.code).toBe('FR');
  });

  it('resolves Bedrock regions to the country they run in', () => {
    expect(lookupEndpoint('bedrock-runtime.eu-central-1.amazonaws.com')!.jurisdiction.code).toBe('DE');
    expect(lookupEndpoint('bedrock-runtime.eu-west-3.amazonaws.com')!.jurisdiction.code).toBe('FR');
    expect(lookupEndpoint('bedrock-runtime.us-east-1.amazonaws.com')!.jurisdiction.code).toBe('US');
  });

  it('treats a local runtime as never leaving the building', () => {
    for (const host of ['localhost', '127.0.0.1', 'host.docker.internal']) {
      const match = lookupEndpoint(host)!;
      expect(match.jurisdiction.status).toBe('local');
      expect(leavesTheEea(match.entry.jurisdiction)).toBe(false);
    }
  });

  it('ignores a port', () => {
    expect(lookupEndpoint('localhost:11434')!.entry.id).toBe('local.runtime');
  });

  it('refuses to guess the region of an Azure deployment', () => {
    const match = lookupEndpoint('contoso.openai.azure.com')!;
    expect(match.jurisdiction.code).toBe('UNKNOWN');
    expect(match.entry.note).toMatch(/declare the jurisdiction/iu);
  });

  it('returns null for a host it has never heard of', () => {
    expect(lookupEndpoint('llm.internal.example')).toBeNull();
  });

  it('lets an operator extend the registry', () => {
    const own: EndpointEntry = {
      id: 'acme.internal',
      label: 'Acme internal vLLM',
      operator: 'Acme GmbH',
      hosts: ['llm.internal.example'],
      jurisdiction: 'DE',
      dataControls: [],
      note: 'On premise in Karlsruhe.',
    };
    expect(lookupEndpoint('llm.internal.example', [own])!.entry.id).toBe('acme.internal');
  });

  it('lets an operator override a built-in entry', () => {
    const override: EndpointEntry = {
      id: 'azure.contoso',
      label: 'Azure OpenAI (Sweden Central)',
      operator: 'Microsoft',
      hosts: ['contoso.openai.azure.com'],
      jurisdiction: 'SE',
      dataControls: [],
      note: 'Deployed in swedencentral.',
    };
    const match = lookupEndpoint('contoso.openai.azure.com', [override])!;
    expect(match.jurisdiction.code).toBe('SE');
  });

  it('prefers the most specific pattern', () => {
    const broad: EndpointEntry = {
      id: 'aws.any',
      label: 'Any AWS',
      operator: 'AWS',
      hosts: ['*.amazonaws.com'],
      jurisdiction: 'US',
      dataControls: [],
      note: 'catch-all',
    };
    const match = lookupEndpoint('bedrock-runtime.eu-central-1.amazonaws.com', [broad])!;
    expect(match.entry.id).toBe('aws.bedrock.eu-central-1');
  });
});

describe('the registry as data', () => {
  it('gives every entry a unique id and at least one host', () => {
    const ids = BUILTIN_ENDPOINTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of BUILTIN_ENDPOINTS) {
      expect(entry.hosts.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('uses only jurisdiction codes it can explain', () => {
    for (const code of knownJurisdictions()) {
      expect(jurisdiction(code).note.length).toBeGreaterThan(0);
    }
  });

  it('describes every data control it declares', () => {
    for (const entry of BUILTIN_ENDPOINTS) {
      for (const control of entry.dataControls) {
        expect(control.note.length).toBeGreaterThan(0);
        if (control.mechanism === 'header') expect(control.header).toBeDefined();
        if (control.mechanism === 'body') expect(control.body).toBeDefined();
      }
    }
  });

  it('offers an EU-hosted option for every EU country it names', () => {
    const eu = BUILTIN_ENDPOINTS.filter((entry) => jurisdiction(entry.jurisdiction).status === 'eea');
    expect(eu.length).toBeGreaterThan(3);
  });
});

describe('the jurisdiction table', () => {
  // The EU 27 plus the three EEA-EFTA states. An operator who correctly
  // declares any of these must not be told their endpoint is undeclared.
  const EEA_MEMBERS = [
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
    'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
    'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO',
  ];

  it.each(EEA_MEMBERS)('resolves %s as an EEA member', (code) => {
    expect(jurisdiction(code).status).toBe('eea');
    expect(leavesTheEea(code)).toBe(false);
    expect(jurisdiction(code).name).not.toBe(code);
  });

  it('has all thirty of them', () => {
    expect(EEA_MEMBERS).toHaveLength(30);
    expect(new Set(EEA_MEMBERS).size).toBe(30);
  });

  it.each(['CH', 'GB', 'JP', 'KR', 'NZ', 'IL', 'UY', 'AR', 'CA', 'AD', 'FO', 'GG', 'IM', 'JE'])(
    'resolves %s as an adequacy country outside the EEA',
    (code) => {
      expect(jurisdiction(code).status).toBe('adequate');
      expect(leavesTheEea(code)).toBe(true);
    },
  );

  it('still treats the United States as a third country', () => {
    expect(jurisdiction('US').status).toBe('third-country');
    expect(leavesTheEea('US')).toBe(true);
  });

  it('still reports a code it does not know as undeclared', () => {
    expect(jurisdiction('ZZ').status).toBe('unknown');
    expect(leavesTheEea('ZZ')).toBe(true);
  });

  it('knows every jurisdiction the built-in registry refers to', () => {
    for (const entry of BUILTIN_ENDPOINTS) {
      // UNKNOWN is the registry's own sentinel for "the host name does not
      // reveal the region"; every real code must resolve to a real status.
      if (entry.jurisdiction === 'UNKNOWN') continue;
      expect(jurisdiction(entry.jurisdiction).status).not.toBe('unknown');
    }
  });

  it('is case-insensitive, as ISO codes are written both ways', () => {
    expect(jurisdiction('at').code).toBe('AT');
    expect(leavesTheEea('at')).toBe(false);
  });
});
