import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../src/cli/template.js';
import { parseConfig, stripJsonComments, type HushgateConfig } from '../src/config.js';

const FIXTURE = readFileSync(new URL('./fixtures/starter-config.json', import.meta.url), 'utf8');

/** Parse a rendered file the way hushgate itself does. */
function load(text: string): HushgateConfig {
  return parseConfig(JSON.parse(stripJsonComments(text)) as unknown);
}

describe('renderConfig', () => {
  it('with no answers is byte for byte what init has always written', () => {
    expect(renderConfig()).toBe(FIXTURE);
  });

  it('renders an organisation block hushgate can load back', () => {
    const config = load(
      renderConfig({
        organisation: {
          name: 'Nordwerk Maschinenbau GmbH',
          contact: 'datenschutz@nordwerk-gmbh.de',
          dpo: 'Dr. Ole Brandt',
          purposes: ['Drafting customer replies'],
        },
      }),
    );

    expect(config.organisation.name).toBe('Nordwerk Maschinenbau GmbH');
    expect(config.organisation.contact).toBe('datenschutz@nordwerk-gmbh.de');
    expect(config.organisation.dpo).toBe('Dr. Ole Brandt');
    expect(config.organisation.purposes).toEqual(['Drafting customer replies']);
  });

  it('leaves an unanswered organisation field null, not empty', () => {
    const config = load(renderConfig({ organisation: { name: 'Nordwerk Maschinenbau GmbH' } }));
    expect(config.organisation.name).toBe('Nordwerk Maschinenbau GmbH');
    expect(config.organisation.dpo).toBeNull();
    expect(config.organisation.purposes).toEqual([]);
  });

  it('keeps the comments when it fills a value in', () => {
    const text = renderConfig({ organisation: { name: 'Nordwerk Maschinenbau GmbH' } });
    expect(text).toContain('// Heads the Article 30 report. hushgate cannot know any of it.');
    expect(text).toContain('"name": "Nordwerk Maschinenbau GmbH"');
  });

  it('renders upstreams and port', () => {
    const config = load(
      renderConfig({ port: 8790, upstreams: { openai: 'https://api.mistral.ai' } }),
    );

    expect(config.port).toBe(8790);
    expect(config.upstreams.openai).toBe('https://api.mistral.ai');
    // The protocol that was not chosen keeps its default.
    expect(config.upstreams.anthropic).toBe('https://api.anthropic.com');
  });

  it('renders an allowlist entry hushgate accepts', () => {
    const config = load(
      renderConfig({
        upstreams: { openai: 'https://api.mistral.ai' },
        allow: [
          {
            endpoint: 'https://api.mistral.ai',
            jurisdiction: 'FR',
            legalBasis: 'Art. 28 DPA of 2026-01-12, processing in France',
          },
        ],
      }),
    );

    expect(config.residency.allow).toHaveLength(1);
    expect(config.residency.allow[0]?.jurisdiction).toBe('FR');
    expect(config.residency.allow[0]?.legalBasis).toContain('Art. 28');
  });

  it('keeps the commented example when no allowlist entry was given', () => {
    const text = renderConfig();
    expect(text).toContain('// An empty allowlist permits every upstream.');
    expect(text).toContain('"allow": []');
    expect(load(text).residency.allow).toHaveLength(0);
  });

  it('escapes a quote in an answer instead of breaking the file', () => {
    const config = load(renderConfig({ organisation: { name: 'A "quoted" GmbH' } }));
    expect(config.organisation.name).toBe('A "quoted" GmbH');
  });

  it('escapes a newline in an answer instead of breaking the file', () => {
    const config = load(
      renderConfig({ organisation: { purposes: ['One line\nand another'] } }),
    );
    expect(config.organisation.purposes).toEqual(['One line\nand another']);
  });
});
