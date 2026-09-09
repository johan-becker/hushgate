import { describe, expect, it } from 'vitest';
import type { PlaygroundOptions } from '../src/playground/index.js';
import { TrialStore } from '../src/playground/session.js';
import { startHarness, type Harness, type HarnessOptions } from './helpers/proxy-harness.js';

const LETTER = [
  'Unsere Mitarbeiterin schreibt an k.vogelsang@nordwerk-gmbh.de,',
  'Tel. +49 40 8823119. Bitte auf DE89 3704 0044 0532 0130 00 erstatten.',
].join('\n');

function playground(over: Partial<PlaygroundOptions> = {}): PlaygroundOptions {
  return {
    store: new TrialStore(),
    apiKey: 'sk-test',
    endpoint: {
      label: 'OpenAI API',
      baseUrl: 'https://api.openai.com',
      api: 'openai',
      trialModel: 'gpt-4o-mini',
    },
    dictionaryIsEmpty: true,
    ...over,
  };
}

function mounted(over: Partial<PlaygroundOptions> = {}): HarnessOptions {
  return { proxy: { playground: playground(over) } };
}

async function withHarness(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await startHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.close();
  }
}

/** Stand-ins for the extractor the CLI wires in from the configuration. */
const extractsText = (): Promise<string> => Promise.resolve(`Rechnung an ${LETTER}`);
const failsToExtract = (): Promise<string> => Promise.reject(new Error('no text layer'));

interface PreviewBody {
  readonly sessionId: string;
  readonly sanitised: string;
  readonly findings: Record<string, number>;
  readonly extracted?: string;
}

describe('POST /__playground/preview', () => {
  it('returns the sanitised text and the findings by kind', async () => {
    await withHarness(mounted(), async (harness) => {
      const response = await harness.post('/__playground/preview', { text: LETTER });
      expect(response.status).toBe(200);

      const body = (await response.json()) as PreviewBody;
      expect(body.sanitised).toContain('[EMAIL_1]');
      expect(body.sanitised).toContain('[IBAN_1]');
      expect(body.sanitised).not.toContain('k.vogelsang@nordwerk-gmbh.de');
      expect(body.findings['EMAIL']).toBe(1);
      expect(body.findings['IBAN']).toBe(1);
      expect(body.sessionId).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    });
  });

  it('never puts a real value in what it answers', async () => {
    await withHarness(mounted(), async (harness) => {
      const body = await (await harness.post('/__playground/preview', { text: LETTER })).text();
      expect(body).not.toContain('vogelsang');
      expect(body).not.toContain('8823119');
      expect(body).not.toContain('0532 0130 00');
    });
  });

  it('keeps the session so a later send can reuse the same mapping', async () => {
    const store = new TrialStore();
    await withHarness({ proxy: { playground: playground({ store }) } }, async (harness) => {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', { text: LETTER })
      ).json()) as PreviewBody;

      const held = store.get(sessionId);
      expect(held).toBeDefined();
      expect(held?.session.lookup('[EMAIL_1]')).toBe('k.vogelsang@nordwerk-gmbh.de');
    });
  });

  it('remembers the model the page asked for', async () => {
    const store = new TrialStore();
    await withHarness({ proxy: { playground: playground({ store }) } }, async (harness) => {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', { text: 'hello', model: 'gpt-4o' })
      ).json()) as PreviewBody;

      expect(store.get(sessionId)?.model).toBe('gpt-4o');
    });
  });

  it('falls back to the endpoint model when the page sends none', async () => {
    const store = new TrialStore();
    await withHarness({ proxy: { playground: playground({ store }) } }, async (harness) => {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', { text: 'hello' })
      ).json()) as PreviewBody;

      expect(store.get(sessionId)?.model).toBe('gpt-4o-mini');
    });
  });

  it('refuses an empty body with 400, not a stack trace', async () => {
    await withHarness(mounted(), async (harness) => {
      expect((await harness.post('/__playground/preview', {})).status).toBe(400);
      expect((await harness.post('/__playground/preview', { text: '   ' })).status).toBe(400);
    });
  });

  it('reads a dropped document through the extractor', async () => {
    await withHarness(
      { proxy: { playground: playground({ extract: extractsText }) } },
      async (harness) => {
        const response = await harness.post('/__playground/preview', {
          file: {
            name: 'rechnung.pdf',
            mediaType: 'application/pdf',
            data: Buffer.from('%PDF-1.4 pretend').toString('base64'),
          },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as PreviewBody;
        expect(body.extracted).toContain('Rechnung an');
        expect(body.sanitised).toContain('[EMAIL_1]');
        expect(body.sanitised).not.toContain('vogelsang');
      },
    );
  });

  it('says so when a document cannot be read, rather than sending it on', async () => {
    await withHarness(
      { proxy: { playground: playground({ extract: failsToExtract }) } },
      async (harness) => {
        const response = await harness.post('/__playground/preview', {
          file: {
            name: 'scan.pdf',
            mediaType: 'application/pdf',
            data: Buffer.from('%PDF-1.4 pretend').toString('base64'),
          },
        });

        expect(response.status).toBe(422);
        expect(await response.text()).toContain('could not be read');
      },
    );
  });

  it('is not reachable when the playground is not mounted', async () => {
    await withHarness({}, async (harness) => {
      expect((await harness.post('/__playground/preview', { text: 'x' })).status).toBe(404);
    });
  });

  it('rejects a method it does not serve', async () => {
    await withHarness(mounted(), async (harness) => {
      expect((await harness.get('/__playground/preview')).status).toBe(404);
    });
  });
});
