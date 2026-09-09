import { describe, expect, it } from 'vitest';
import type { PlaygroundOptions } from '../src/playground/index.js';
import { TrialStore } from '../src/playground/session.js';
import { startHarness, type Harness, type HarnessOptions } from './helpers/proxy-harness.js';

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

/** Run `body` against a harness and always close it. */
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

describe('the trial page', () => {
  it('is not mounted by an ordinary serve', async () => {
    await withHarness({}, async (harness) => {
      expect((await harness.get('/__playground')).status).toBe(404);
      expect((await harness.get('/__playground/app.js')).status).toBe(404);
    });
  });

  it('is served when setup asked for it', async () => {
    await withHarness(mounted(), async (harness) => {
      const response = await harness.get('/__playground');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');

      const body = await response.text();
      expect(body).toContain('Your text');
      expect(body).toContain('What the provider sees');
      expect(body).toContain('Reply, as it arrives');
      expect(body).toContain('Reply, rehydrated');
    });
  });

  it('locks the page down so it cannot reach anything', async () => {
    await withHarness(mounted(), async (harness) => {
      const response = await harness.get('/__playground');
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  it('keeps script and style out of the document, so the policy can stay strict', async () => {
    await withHarness(mounted(), async (harness) => {
      const body = await (await harness.get('/__playground')).text();
      expect(body).not.toMatch(/<script(?![^>]*\bsrc=)/u);
      expect(body).not.toContain('<style');
      expect(body).toContain('/__playground/app.js');
      expect(body).toContain('/__playground/app.css');
    });
  });

  it('serves the script and the stylesheet as their own routes', async () => {
    await withHarness(mounted(), async (harness) => {
      const js = await harness.get('/__playground/app.js');
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('javascript');

      const css = await harness.get('/__playground/app.css');
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');
    });
  });

  it('prefills the model from the endpoint, and lets it be edited', async () => {
    await withHarness(mounted(), async (harness) => {
      const body = await (await harness.get('/__playground')).text();
      expect(body).toContain('gpt-4o-mini');
      expect(body).toMatch(/<input[^>]*id="model"/u);
    });
  });

  it('says where names come from while the dictionary is empty', async () => {
    await withHarness(mounted(), async (harness) => {
      expect(await (await harness.get('/__playground')).text()).toContain(
        'Personal names come only from your dictionary',
      );
    });
  });

  it('drops that line when a dictionary is configured', async () => {
    await withHarness(mounted({ dictionaryIsEmpty: false }), async (harness) => {
      expect(await (await harness.get('/__playground')).text()).not.toContain(
        'Personal names come only from your dictionary',
      );
    });
  });

  it('never carries the API key into anything it serves', async () => {
    await withHarness(mounted({ apiKey: 'sk-very-secret' }), async (harness) => {
      expect(await (await harness.get('/__playground')).text()).not.toContain('sk-very-secret');
      expect(await (await harness.get('/__playground/app.js')).text()).not.toContain(
        'sk-very-secret',
      );
      expect(await (await harness.get('/__playground/app.css')).text()).not.toContain(
        'sk-very-secret',
      );
    });
  });

  it('escapes what it interpolates instead of trusting it', async () => {
    await withHarness(
      mounted({
        endpoint: {
          label: '<script>alert(1)</script>',
          baseUrl: 'https://api.openai.com',
          api: 'openai',
          trialModel: '"><script>alert(2)</script>',
        },
      }),
      async (harness) => {
        const body = await (await harness.get('/__playground')).text();
        expect(body).not.toContain('<script>alert(1)</script>');
        expect(body).not.toContain('<script>alert(2)</script>');
        expect(body).toContain('&lt;script&gt;');
      },
    );
  });

  it('answers an unknown path under the prefix with 404, not the page', async () => {
    await withHarness(mounted(), async (harness) => {
      expect((await harness.get('/__playground/nope')).status).toBe(404);
    });
  });
});
