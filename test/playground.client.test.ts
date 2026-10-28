/**
 * The trial page is the first thing a prospective operator touches, and it is
 * the one surface where a swallowed rejection is invisible: the status line
 * keeps saying what it was doing, so a failure reads as work still in progress.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLES } from '../src/playground/samples.js';
import { mountPage, type FakeElement, type Page } from './helpers/page-dom.js';

describe('the trial page in a browser', () => {
  it('says a check failed rather than leaving "checking…" on screen', async () => {
    const page = mountPage(() => Promise.reject(new Error('connection refused')));
    page.nodes['input']!.value = 'Anna Müller, DE89370400440532013000';

    page.fire('check', 'click');
    await page.settle();

    // Whatever it says, it must not still be claiming to be working.
    expect(page.nodes['input-status']!.textContent).not.toBe('checking…');
    expect(page.nodes['input-status']!.textContent).not.toBe('');
  });
});

const DROPPED_PDF = {
  preventDefault: () => {},
  dataTransfer: { files: [{ name: 'rechnung.pdf', type: 'application/pdf' }] },
};

describe('the trial page when a document is dropped', () => {
  it('says the drop failed rather than leaving "reading…" on screen', async () => {
    const page = mountPage(() => Promise.reject(new Error('connection refused')));

    page.fire('input', 'drop', DROPPED_PDF);
    await page.settle();

    expect(page.nodes['input-status']!.textContent).not.toBe('reading rechnung.pdf…');
    expect(page.nodes['input-status']!.textContent).not.toBe('');
  });
});

/** A good preview, then a send whose stream dies partway. */
const brokenStream = (url: unknown): Promise<unknown> =>
  String(url).endsWith('/preview')
    ? Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessionId: 's1', sanitised: '[NAME_1]', findings: {} }),
      })
    : Promise.resolve({
        ok: true,
        body: { getReader: () => ({ read: () => Promise.reject(new Error('stream died')) }) },
      });

describe('the trial page while the answer streams', () => {
  it('says the stream broke rather than waiting for a token forever', async () => {
    const page = mountPage(brokenStream);
    page.nodes['input']!.value = 'Anna Müller';

    page.fire('check', 'click');
    await page.settle();
    page.fire('send', 'click');
    await page.settle();

    expect(page.nodes['send-status']!.textContent).not.toBe('waiting for the first token…');
    // And the operator can try again.
    expect(page.nodes['send']!.disabled).toBe(false);
  });
});

describe('the trial page when a path forgets to catch', () => {
  it('surfaces a rejection nothing handled, rather than freezing the status', () => {
    const page = mountPage(() => Promise.resolve({ ok: true }));

    // The backstop, not a path: whatever is added to this page later, a
    // rejection that escapes it must still reach the operator's eyes.
    page.fireGlobal('unhandledrejection', { reason: new Error('boom') });

    expect(page.nodes['input-status']!.textContent).not.toBe('');
  });
});

/** The preview the server would answer for LETTER, as the page receives it. */
const LETTER = 'Bitte an k.vogelsang@nordwerk-gmbh.de, IBAN DE89 3704 0044 0532 0130 00.';
const LETTER_PREVIEW = {
  sessionId: 's1',
  sanitised: 'Bitte an [EMAIL_1], IBAN [IBAN_1].',
  findings: { EMAIL: 1, IBAN: 1 },
  marks: [
    { start: 9, end: 37, kind: 'EMAIL', placeholder: '[EMAIL_1]' },
    { start: 44, end: 71, kind: 'IBAN', placeholder: '[IBAN_1]' },
  ],
};

/** A send whose SSE events the test hands over one at a time. */
function controlledStream(): {
  push(event: string, delta: string): void;
  end(): void;
  body: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }> } };
} {
  const queued: { value?: Uint8Array; done: boolean }[] = [];
  let waiting: ((result: { value?: Uint8Array; done: boolean }) => void) | null = null;
  const deliver = (result: { value?: Uint8Array; done: boolean }): void => {
    if (waiting === null) {
      queued.push(result);
      return;
    }
    const resolve = waiting;
    waiting = null;
    resolve(result);
  };

  return {
    push(event, delta) {
      const block = `event: ${event}\ndata: ${JSON.stringify({ delta })}\n\n`;
      deliver({ value: new TextEncoder().encode(block), done: false });
    },
    end() {
      deliver({ value: new TextEncoder().encode('event: done\ndata: {}\n\n'), done: false });
      deliver({ done: true });
    },
    body: {
      getReader: () => ({
        read: () => {
          const next = queued.shift();
          if (next !== undefined) return Promise.resolve(next);
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      }),
    },
  };
}

/** A page whose preview answers `preview`, and whose send streams from `stream`. */
function trialPage(stream = controlledStream(), preview: unknown = LETTER_PREVIEW) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const page = mountPage((url, init) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')) as Record<
        string,
        unknown
      >,
    });
    return String(url).endsWith('/preview')
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(preview) })
      : Promise.resolve({ ok: true, body: stream.body });
  });
  return { page, calls, stream };
}

async function checked(page: Page, text = LETTER): Promise<void> {
  page.nodes['input']!.value = text;
  page.fire('check', 'click');
  await page.settle();
}

describe('the trial page samples', () => {
  it('fills the editor and the names from a sample, and checks it with those names', async () => {
    const { page, calls } = trialPage();
    const sample = SAMPLES[0]!;

    const button = page.nodes['samples']!.children[0] as FakeElement;
    expect(button.textContent).toBe(sample.label);
    expect(button.title).toBe(sample.blurb);

    page.fireOn(button, 'click');
    await page.settle();

    expect(page.nodes['input']!.value).toBe(sample.text);
    expect(page.nodes['names']!.value).toBe(sample.names.join(', '));
    expect(calls[0]?.url).toContain('/__playground/preview');
    expect(calls[0]?.body['text']).toBe(sample.text);
    expect(calls[0]?.body['names']).toEqual([...sample.names]);
  });

  it('sends the names typed into the field with a check', async () => {
    const { page, calls } = trialPage();
    page.nodes['names']!.value = ' Katrin Vogelsang, , Jonas Brandt ';
    await checked(page);

    expect(calls[0]?.body['names']).toEqual(['Katrin Vogelsang', 'Jonas Brandt']);
  });
});

describe('the trial page after a check', () => {
  it('marks each value in the checked text, linked to its placeholder', async () => {
    const { page } = trialPage();
    await checked(page);

    expect(page.nodes['annotated']!.hidden).toBe(false);
    expect(page.nodes['input']!.hidden).toBe(true);
    expect(page.nodes['annotated']!.textContent).toBe(LETTER);

    const email = page.find('[data-token="[EMAIL_1]"]');
    const value = email.find((node) => node.classList.contains('value'))!;
    expect(value.textContent).toBe('k.vogelsang@nordwerk-gmbh.de');
    expect(value.title).toBe('EMAIL → [EMAIL_1]');
    expect(page.nodes['annotated']!.contains(value)).toBe(true);
  });

  it('shows the placeholders as chips in what the provider receives', async () => {
    const { page } = trialPage();
    await checked(page);

    expect(page.nodes['sanitised']!.textContent).toBe(LETTER_PREVIEW.sanitised);
    const chips = page.find('.chip').filter((node) => page.nodes['sanitised']!.contains(node));
    expect(chips.map((chip) => chip.dataset['token'])).toEqual(['[EMAIL_1]', '[IBAN_1]']);
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('counts the findings by kind, with a total', async () => {
    const { page } = trialPage();
    await checked(page);

    expect(page.nodes['summary']!.textContent).toBe('2 values replaced, 2 kinds');
    expect(page.find('[data-legend]').map((node) => node.dataset['legend'])).toEqual([
      'EMAIL',
      'IBAN',
    ]);
  });

  it('lights up every element carrying a token when one is hovered', async () => {
    const { page } = trialPage();
    await checked(page);

    const [first] = page.find('[data-token="[IBAN_1]"]');
    page.fireDocument('mouseover', { target: first });

    const lit = page.find('.is-linked');
    expect(lit.length).toBe(2);
    expect(lit.every((node) => node.dataset['token'] === '[IBAN_1]')).toBe(true);
  });

  it('holds Send back once the text changes, until it is checked again', async () => {
    const { page } = trialPage();
    await checked(page);
    expect(page.nodes['send']!.disabled).toBe(false);

    page.fire('input', 'input');

    expect(page.nodes['send']!.disabled).toBe(true);
    expect(page.nodes['send-status']!.textContent).toBe('Text changed. Check again before sending.');
    expect(page.nodes['pane-out']!.classList.contains('is-stale')).toBe(true);

    await checked(page);
    expect(page.nodes['send']!.disabled).toBe(false);
    expect(page.nodes['pane-out']!.classList.contains('is-stale')).toBe(false);
  });

  it('treats a change to the names as a change to the text', async () => {
    const { page } = trialPage();
    await checked(page);

    page.fire('names', 'input');
    expect(page.nodes['send']!.disabled).toBe(true);
  });
});

describe('the trial page while the reply streams', () => {
  it('shows what hushgate is holding back, and clears it once the placeholder is whole', async () => {
    const { page, stream } = trialPage();
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    stream.push('raw', 'I will write to [EMA');
    stream.push('hydrated', 'I will write to ');
    await page.settle();

    expect(page.nodes['holding']!.hidden).toBe(false);
    expect(page.nodes['holding']!.textContent).toContain('[EMA');
    expect(page.find('.is-pending').some((node) => page.nodes['raw']!.contains(node))).toBe(true);

    stream.push('raw', 'IL_1] today.');
    stream.push('hydrated', 'k.vogelsang@nordwerk-gmbh.de today.');
    await page.settle();

    expect(page.nodes['holding']!.hidden).toBe(true);
    expect(page.nodes['raw']!.textContent).toBe('I will write to [EMAIL_1] today.');
    const restored = page
      .find('[data-token="[EMAIL_1]"]')
      .filter((node) => page.nodes['hydrated']!.contains(node));
    expect(restored.map((node) => node.textContent)).toEqual(['k.vogelsang@nordwerk-gmbh.de']);

    stream.end();
    await page.settle();
    expect(page.nodes['hydrated']!.textContent).toBe(
      'I will write to k.vogelsang@nordwerk-gmbh.de today.',
    );
    expect(page.nodes['send-status']!.textContent).toMatch(/done in .* · 1 value restored$/u);
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('renders provider text as text, never as markup', async () => {
    const { page, stream } = trialPage();
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    const hostile = '<img src=x onerror=alert(1)> and <script>alert(2)</script>';
    stream.push('raw', hostile);
    stream.push('hydrated', hostile);
    stream.end();
    await page.settle();

    expect(page.nodes['raw']!.textContent).toBe(hostile);
    expect(page.nodes['hydrated']!.textContent).toBe(hostile);
    const everything = [...Object.values(page.nodes), ...page.created];
    expect(everything.flatMap((node) => node.htmlWrites)).toEqual([]);
    expect(page.created.map((node) => node.tagName)).not.toContain('IMG');
    expect(page.created.map((node) => node.tagName)).not.toContain('SCRIPT');
  });
});

// ---- Everything else the page promises ------------------------------------

type Respond = (url: string, body: Record<string, unknown>) => Promise<unknown>;

/** A page whose every request goes to `respond`, with the calls it made. */
function scriptedPage(respond: Respond, globals: Record<string, unknown> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const page = mountPage((url, init) => {
    const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    calls.push({ url: String(url), body });
    return respond(String(url), body);
  }, globals);
  return { page, calls };
}

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

const refused = (status: number, type: string, message: string) =>
  Promise.resolve({
    ok: false,
    status,
    body: null,
    json: () => Promise.resolve({ error: { type, message } }),
  });

/** A promise the test settles when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Previews from LETTER_PREVIEW, sends from `stream`. */
function letterPage(stream = controlledStream(), globals: Record<string, unknown> = {}) {
  return scriptedPage(
    (url) =>
      url.endsWith('/preview')
        ? ok(LETTER_PREVIEW)
        : Promise.resolve({ ok: true, body: stream.body }),
    globals,
  );
}

const classed = (page: Page, id: string, name: string): boolean =>
  page.nodes[id]!.classList.contains(name);

const STOPS = ['trip-text', 'trip-out', 'trip-provider', 'trip-in', 'trip-you'];
const done = (page: Page): string[] => STOPS.filter((id) => classed(page, id, 'is-done'));

const key = (name: string, extra: Record<string, unknown> = {}) => ({
  key: name,
  preventDefault: () => {},
  ...extra,
});

describe('the round-trip strip', () => {
  it('follows the text out and the reply back, and times it', async () => {
    const { page } = letterPage(controlledStream());
    expect(done(page)).toEqual([]);

    await checked(page);
    expect(done(page)).toEqual(['trip-text', 'trip-out']);
    expect(classed(page, 'check', 'is-quiet')).toBe(true);

    const stream = controlledStream();
    const sending = letterPage(stream);
    await checked(sending.page);
    sending.page.fire('send', 'click');
    await sending.page.settle();
    expect(classed(sending.page, 'trip-provider', 'is-active')).toBe(true);

    stream.push('raw', 'Antwort an [EMAIL_1].');
    stream.push('hydrated', 'Antwort an k.vogelsang@nordwerk-gmbh.de.');
    await sending.page.settle();
    expect(classed(sending.page, 'trip-in', 'is-active')).toBe(true);
    expect(classed(sending.page, 'leg-4', 'is-active')).toBe(true);
    expect(sending.page.nodes['send-status']!.textContent).toMatch(/^streaming · first token \d+ ms$/u);

    stream.end();
    await sending.page.settle();
    expect(done(sending.page)).toEqual(STOPS);
    expect(sending.page.nodes['send-status']!.textContent).toMatch(
      /^first token \d+ ms · done in \d+ ms · 1 value restored$/u,
    );
  });

  it('marks hushgate as the failing stop when a check cannot go out', async () => {
    const { page } = scriptedPage(() => Promise.reject(new Error('connection refused')));
    await checked(page);

    expect(classed(page, 'trip-out', 'is-error')).toBe(true);
    expect(classed(page, 'leg-1', 'is-error')).toBe(true);
    expect(page.nodes['check']!.disabled).toBe(false);
  });

  it('marks the provider when it refuses, and leaves Send usable', async () => {
    const { page } = scriptedPage((url) =>
      url.endsWith('/preview') ? ok(LETTER_PREVIEW) : refused(502, 'upstream_error', 'bad gateway'),
    );
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    expect(classed(page, 'trip-provider', 'is-error')).toBe(true);
    expect(page.nodes['send-status']!.textContent).toBe('the provider refused: 502');
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('says when the provider sends an error event mid-stream', async () => {
    const stream = controlledStream();
    const { page } = letterPage(stream);
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    stream.push('raw', 'Ant');
    stream.push('error', 'rate limited');
    await page.settle();

    expect(page.nodes['send-status']!.textContent).toBe('the provider returned an error');
    expect(classed(page, 'trip-provider', 'is-error')).toBe(true);
    expect(page.nodes['send']!.disabled).toBe(false);
  });
});

describe('the trial page from the keyboard', () => {
  it('checks on Ctrl+Enter or Cmd+Enter, and hands focus to Edit', async () => {
    const { page, calls } = letterPage();
    page.nodes['input']!.value = LETTER;
    page.nodes['input']!.focus();

    page.fire('input', 'keydown', key('Enter'));
    await page.settle();
    expect(calls).toHaveLength(0);

    page.fire('input', 'keydown', key('Enter', { ctrlKey: true }));
    await page.settle();
    expect(calls).toHaveLength(1);
    expect(page.nodes['input']!.hidden).toBe(true);
    expect(page.active).toBe(page.nodes['edit']);

    page.fire('edit', 'click');
    page.fire('input', 'keydown', key('Enter', { metaKey: true }));
    await page.settle();
    expect(calls).toHaveLength(2);
  });

  it('checks on Enter in the names field', async () => {
    const { page, calls } = letterPage();
    page.nodes['input']!.value = LETTER;
    page.fire('names', 'keydown', key('Enter'));
    await page.settle();
    expect(calls).toHaveLength(1);
  });

  it('gives the placeholders one tab stop, and moves between them with the arrows', async () => {
    const { page } = letterPage();
    await checked(page);
    const sanitised = page.nodes['sanitised']!;
    const chips = page.find('.chip').filter((node) => sanitised.contains(node));
    expect(chips.map((chip) => chip.tabIndex)).toEqual([0, -1]);

    page.fire('sanitised', 'keydown', key('ArrowRight', { target: chips[0] }));
    expect(chips.map((chip) => chip.tabIndex)).toEqual([-1, 0]);
    expect(page.active).toBe(chips[1]);

    page.fire('sanitised', 'keydown', key('ArrowRight', { target: chips[1] }));
    expect(page.active).toBe(chips[1]);
    page.fire('sanitised', 'keydown', key('Home', { target: chips[1] }));
    expect(page.active).toBe(chips[0]);
  });
});

describe('the trial page between reading and editing', () => {
  it('returns to the editor from Edit, or from a click that selects nothing', async () => {
    let selection = '';
    const { page } = letterPage(controlledStream(), { getSelection: () => selection });
    await checked(page);

    page.fire('edit', 'click');
    expect(page.nodes['input']!.hidden).toBe(false);
    expect(page.nodes['annotated']!.hidden).toBe(true);
    expect(page.active).toBe(page.nodes['input']);

    await checked(page);
    selection = 'nordwerk';
    page.fire('annotated', 'click');
    expect(page.nodes['annotated']!.hidden).toBe(false);

    selection = '';
    page.fire('annotated', 'click');
    expect(page.nodes['input']!.hidden).toBe(false);
  });

  it('shows which sample is loaded until the text is edited', async () => {
    const { page } = letterPage();
    const [first, second] = page.nodes['samples']!.children as FakeElement[];

    page.fireOn(first!, 'click');
    await page.settle();
    expect(first!.getAttribute('aria-pressed')).toBe('true');
    expect(second!.getAttribute('aria-pressed')).toBe('false');

    page.fire('input', 'input');
    expect(first!.getAttribute('aria-pressed')).toBe('false');
  });
});

/** A dropped or opened file, read by the server into NAMED-style text. */
const EXTRACTED = 'Rechnung an Katrin Vogelsang, k.vogelsang@nordwerk-gmbh.de';
const EXTRACTED_PREVIEW = {
  sessionId: 's-file',
  extracted: EXTRACTED,
  sanitised: 'Rechnung an [NAME_1], [EMAIL_1]',
  findings: { NAME: 1, EMAIL: 1 },
  marks: [
    { start: 12, end: 28, kind: 'NAME', placeholder: '[NAME_1]' },
    { start: 30, end: 58, kind: 'EMAIL', placeholder: '[EMAIL_1]' },
  ],
};

describe('the trial page with a file', () => {
  it('opens one from the picker, shows the extracted text, and sends the names', async () => {
    const { page, calls } = scriptedPage(() => ok(EXTRACTED_PREVIEW));
    page.nodes['names']!.value = 'Katrin Vogelsang';
    page.nodes['file']!.files = [{ name: 'rechnung.pdf', type: 'application/pdf' }];

    page.fire('file', 'change');
    await page.settle();

    expect(calls[0]?.body['file']).toMatchObject({ name: 'rechnung.pdf', mediaType: 'application/pdf' });
    expect(calls[0]?.body['names']).toEqual(['Katrin Vogelsang']);
    expect(page.nodes['input']!.value).toBe(EXTRACTED);
    expect(page.nodes['annotated']!.textContent).toBe(EXTRACTED);
    expect(page.find('.value').map((node) => node.textContent)).toEqual([
      'Katrin Vogelsang',
      'k.vogelsang@nordwerk-gmbh.de',
    ]);
    expect(page.nodes['input-status']!.textContent).toBe(
      'rechnung.pdf — read as text, the file itself stays here',
    );
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('takes a drop anywhere on the left pane', async () => {
    const { page, calls } = scriptedPage(() => ok(EXTRACTED_PREVIEW));
    page.fire('pane-input', 'dragover', { preventDefault: () => {} });
    expect(classed(page, 'pane-input', 'is-dropping')).toBe(true);

    page.fire('pane-input', 'drop', { ...DROPPED_PDF, stopPropagation: () => {} });
    await page.settle();

    expect(calls).toHaveLength(1);
    expect(classed(page, 'pane-input', 'is-dropping')).toBe(false);
    expect(page.nodes['annotated']!.textContent).toBe(EXTRACTED);
  });
});

describe('the findings legend', () => {
  it('shows every mark of a kind on hover, and pins it on click', async () => {
    const { page } = letterPage();
    await checked(page);
    const [email] = page.find('[data-legend="EMAIL"]');
    const marked = (): string[] =>
      page.find('.is-kind').map((node) => node.dataset['token'] ?? '');

    page.fireDocument('mouseover', { target: email });
    expect(marked()).toEqual(['[EMAIL_1]', '[EMAIL_1]']);
    page.fireDocument('mouseover', { target: page.nodes['summary'] });
    expect(marked()).toEqual([]);

    page.fire('findings', 'click', { target: email });
    expect(email!.getAttribute('aria-pressed')).toBe('true');
    expect(marked()).toEqual(['[EMAIL_1]', '[EMAIL_1]']);
    page.fire('findings', 'click', { target: email });
    expect(email!.getAttribute('aria-pressed')).toBe('false');
    expect(marked()).toEqual([]);
  });

  it('says nothing personal was found, and offers nothing to point at', async () => {
    const text = 'Bitte bis Freitag zurückmelden.';
    const { page } = scriptedPage(() =>
      ok({ sessionId: 's0', sanitised: text, findings: {}, marks: [] }),
    );
    await checked(page, text);

    expect(page.nodes['findings']!.textContent).toBe('nothing personal found in that text');
    expect(page.nodes['summary']!.textContent).toBe('Goes out as written.');
    expect(page.nodes['summary-hint']!.hidden).toBe(true);
  });

  it('offers the hint once there are placeholders to point at', async () => {
    const { page } = letterPage();
    await checked(page);
    expect(page.nodes['summary-hint']!.hidden).toBe(false);
  });
});

describe('the trial page tokens', () => {
  const TEXT = 'Mail k@x.de';
  const PREVIEW = {
    sessionId: 's2',
    sanitised: 'Mail [EMAIL_1], [IBAN_REDACTED], [EMAIL:3fa9], [PHONE_9]',
    findings: { EMAIL: 1 },
    marks: [
      { start: 5, end: 11, kind: 'EMAIL', placeholder: '[EMAIL_1]' },
      { start: 0, end: 4, kind: 'EMAIL', placeholder: '"] *' },
    ],
  };

  it('links only the placeholders this check issued', async () => {
    const { page } = scriptedPage(() => ok(PREVIEW));
    await checked(page, TEXT);
    const chips = page.find('.chip').filter((node) => page.nodes['sanitised']!.contains(node));

    expect(chips.map((chip) => chip.textContent)).toEqual([
      '[EMAIL_1]',
      '[IBAN_REDACTED]',
      '[EMAIL:3fa9]',
      '[PHONE_9]',
    ]);
    expect(chips.map((chip) => chip.dataset['token'])).toEqual([
      '[EMAIL_1]',
      undefined,
      undefined,
      '[PHONE_9]',
    ]);
    expect(chips[1]!.title).toBe('One-way: this one is never restored.');
    expect(chips[3]!.dataset['kind']).toBeUndefined();
    expect(chips[3]!.title).toBe('Not a placeholder this check issued, so it stays as written.');
    expect(chips.map((chip) => chip.tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('drops a mark whose placeholder is not one', async () => {
    const { page } = scriptedPage(() => ok(PREVIEW));
    await checked(page, TEXT);
    expect(page.find('.value').map((node) => node.dataset['token'])).toEqual(['[EMAIL_1]']);
  });
});

describe('the trial page empty states', () => {
  it('says in each reply pane what will appear there, and what it is waiting for', async () => {
    const { page } = letterPage();
    await checked(page);
    expect(page.nodes['raw']!.textContent).toBe(
      'The reply streams in here as it arrives, placeholders and all.',
    );
    expect(page.nodes['hydrated']!.textContent).toBe(
      'The same reply, with your values put back on this machine.',
    );

    page.fire('send', 'click');
    expect(page.nodes['raw']!.textContent).toBe('Waiting for the first token…');
  });
});

describe('the trial page copy buttons', () => {
  it('copies what the provider receives, and says so', async () => {
    const written: string[] = [];
    const clipboard = {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    };
    const { page } = letterPage(controlledStream(), { navigator: { clipboard, platform: 'MacIntel' } });
    expect(page.nodes['check-key']!.textContent).toBe('⌘↵');
    await checked(page);

    page.fire('copy-sanitised', 'click');
    await page.settle();
    expect(written).toEqual([LETTER_PREVIEW.sanitised]);
    expect(page.nodes['copy-sanitised']!.textContent).toBe('Copied');
    expect(page.nodes['copy-status']!.textContent).toBe('Copied');
  });

  it('hides them where there is no clipboard to write to', () => {
    const { page } = letterPage();
    expect(page.nodes['copy-sanitised']!.hidden).toBe(true);
    expect(page.nodes['copy-hydrated']!.hidden).toBe(true);
  });
});

describe('the trial page under a fast stream', () => {
  it('draws the reply at most once a frame', async () => {
    const frames: (() => void)[] = [];
    const stream = controlledStream();
    const { page } = letterPage(stream, {
      requestAnimationFrame: (callback: () => void) => {
        frames.push(callback);
      },
    });
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    stream.push('raw', 'Eins, ');
    stream.push('raw', 'zwei, ');
    stream.push('raw', 'drei.');
    await page.settle();
    expect(frames).toHaveLength(1);
    expect(page.nodes['raw']!.textContent).not.toContain('drei');

    frames.shift()!();
    expect(page.nodes['raw']!.textContent).toBe('Eins, zwei, drei.');
  });
});

describe('the trial page when things overlap', () => {
  it('drops a reply still streaming when a new check lands', async () => {
    const stream = controlledStream();
    const { page } = letterPage(stream);
    await checked(page);
    page.fire('send', 'click');
    await page.settle();
    stream.push('raw', 'Alte Antwort');
    await page.settle();

    await checked(page);
    expect(page.nodes['raw']!.textContent).not.toContain('Alte');
    expect(page.nodes['send']!.disabled).toBe(false);

    stream.push('raw', ' geht weiter');
    stream.end();
    await page.settle();
    expect(page.nodes['raw']!.textContent).not.toContain('weiter');
    expect(page.nodes['send-status']!.textContent).toBe('');
  });

  it('lets only the latest of two checks land, whatever order they answer in', async () => {
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let next = 0;
    const { page } = scriptedPage(() => answers[next++]!.promise);
    const older = { ...LETTER_PREVIEW, sessionId: 'old', sanitised: 'old [EMAIL_1] [IBAN_1].' };
    const newer = { ...LETTER_PREVIEW, sessionId: 'new' };

    page.nodes['input']!.value = 'not quite ' + LETTER;
    page.fire('input', 'keydown', key('Enter', { ctrlKey: true }));
    page.nodes['input']!.value = LETTER;
    page.fire('input', 'input');
    page.fire('input', 'keydown', key('Enter', { ctrlKey: true }));

    answers[1]!.resolve({ ok: true, json: () => Promise.resolve(newer) });
    await page.settle();
    answers[0]!.resolve({ ok: true, json: () => Promise.resolve(older) });
    await page.settle();

    expect(page.nodes['annotated']!.textContent).toBe(LETTER);
    expect(page.nodes['sanitised']!.textContent).toBe(LETTER_PREVIEW.sanitised);
    expect(page.nodes['send']!.disabled).toBe(false);
    expect(page.nodes['check']!.disabled).toBe(false);
  });

  it('discards a check the text changed under', async () => {
    const answer = deferred<unknown>();
    const { page } = scriptedPage(() => answer.promise);
    page.nodes['input']!.value = LETTER;
    page.fire('check', 'click');
    page.nodes['input']!.value = LETTER + ' Danke.';
    page.fire('input', 'input');

    answer.resolve({ ok: true, json: () => Promise.resolve(LETTER_PREVIEW) });
    await page.settle();

    expect(page.nodes['input-status']!.textContent).toBe('changed while checking; check again');
    expect(page.nodes['input']!.hidden).toBe(false);
    expect(page.nodes['send']!.disabled).toBe(true);
    expect(page.nodes['check']!.disabled).toBe(false);
  });

  it('keeps the stale warning when the text changes during a send', async () => {
    const stream = controlledStream();
    const { page } = letterPage(stream);
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    page.fire('input', 'input');
    stream.push('raw', 'Antwort');
    stream.push('hydrated', 'Antwort');
    stream.end();
    await page.settle();

    expect(page.nodes['send-status']!.textContent).toBe('Text changed. Check again before sending.');
    expect(page.nodes['input-status']!.textContent).toBe('edited since the last check');
    expect(page.nodes['send']!.disabled).toBe(true);
    expect(done(page)).toEqual([]);
    for (const id of ['pane-out', 'pane-raw', 'pane-hydrated']) {
      expect(classed(page, id, 'is-stale')).toBe(true);
    }
    expect(classed(page, 'check', 'is-quiet')).toBe(false);

    const [restored] = page.find('[data-token="[EMAIL_1]"]');
    page.fireDocument('mouseover', { target: restored });
    expect(page.find('.is-linked')).toEqual([]);
  });

  it('treats a change of model as a change, since Send would use the old one', async () => {
    const { page } = letterPage();
    await checked(page);
    page.fire('model', 'input');

    expect(page.nodes['send']!.disabled).toBe(true);
    expect(page.nodes['send-status']!.textContent).toBe('Model changed. Check again before sending.');
  });

  it('says an expired preview has expired, and asks for a new check', async () => {
    const message = 'that preview has expired; check the text again';
    const { page } = scriptedPage((url) =>
      url.endsWith('/preview') ? ok(LETTER_PREVIEW) : refused(404, 'no_such_session', message),
    );
    await checked(page);
    page.fire('send', 'click');
    await page.settle();

    expect(page.nodes['send-status']!.textContent).toBe(message);
    expect(page.nodes['send']!.disabled).toBe(true);
    expect(classed(page, 'pane-out', 'is-stale')).toBe(true);
    expect(classed(page, 'trip-out', 'is-error')).toBe(true);

    await checked(page);
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('lets a file dropped during a check win, when it is the later of the two', async () => {
    const answers = [deferred<unknown>(), deferred<unknown>()];
    let next = 0;
    const { page } = scriptedPage(() => answers[next++]!.promise);
    page.nodes['input']!.value = LETTER;
    page.fire('check', 'click');
    page.fire('input', 'drop', DROPPED_PDF);
    await page.settle();

    answers[1]!.resolve({ ok: true, json: () => Promise.resolve(EXTRACTED_PREVIEW) });
    await page.settle();
    answers[0]!.resolve({ ok: true, json: () => Promise.resolve(LETTER_PREVIEW) });
    await page.settle();

    expect(page.nodes['annotated']!.textContent).toBe(EXTRACTED);
    expect(page.nodes['check']!.disabled).toBe(false);
    expect(page.nodes['send']!.disabled).toBe(false);
  });

  it('says a non-ok check failed, and keeps Check usable', async () => {
    const { page } = scriptedPage(() => Promise.resolve({ ok: false, status: 500 }));
    await checked(page);
    expect(page.nodes['input-status']!.textContent).toBe('could not read that: 500');
    expect(page.nodes['check']!.disabled).toBe(false);
    expect(page.nodes['send']!.disabled).toBe(true);
  });
});
