/**
 * The trial page is the first thing a prospective operator touches, and it is
 * the one surface where a swallowed rejection is invisible: the status line
 * keeps saying what it was doing, so a failure reads as work still in progress.
 */
import { describe, expect, it } from 'vitest';
import { mountPage } from './helpers/page-dom.js';

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
