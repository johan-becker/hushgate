/**
 * Enough of a browser to run the trial page's own script.
 *
 * The page ships as a string of JavaScript, which until now was only ever
 * asserted *as a string*. That cannot catch the failure this harness exists
 * for: a promise that rejects and leaves the last status message on screen.
 * So the real source runs, in a vm context with the handful of globals it
 * touches, and the test drives it through the listeners it registers.
 */
import { runInNewContext } from 'node:vm';
import { PAGE_JS } from '../../src/playground/page.js';

export interface FakeElement {
  textContent: string;
  value: string;
  disabled: boolean;
  innerHTML: string;
  readonly classList: { add(name: string): void; remove(name: string): void };
  readonly listeners: Map<string, (event: unknown) => void>;
  addEventListener(name: string, handler: (event: unknown) => void): void;
  append(...nodes: unknown[]): void;
}

function element(): FakeElement {
  return {
    textContent: '',
    value: '',
    disabled: false,
    innerHTML: '',
    classList: { add: () => {}, remove: () => {} },
    listeners: new Map(),
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    },
    append: () => {},
  };
}

/** Every id the page looks up, so a typo in either surfaces as undefined. */
const IDS = [
  'input',
  'sanitised',
  'findings',
  'raw',
  'hydrated',
  'model',
  'check',
  'send',
  'input-status',
  'send-status',
] as const;

export interface Page {
  readonly nodes: Readonly<Record<string, FakeElement>>;
  /** Fire a listener the page registered, e.g. `click` on the check button. */
  fire(id: string, event: string, payload?: unknown): void;
  /** Fire a listener the page registered on the window itself. */
  fireGlobal(event: string, payload?: unknown): void;
  /** Let the page's promises run to completion. */
  settle(): Promise<void>;
}

/** Reads any file as the same short data URL, on the next turn. */
class FakeFileReader {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result = '';

  readAsDataURL(_file: unknown): void {
    setTimeout(() => {
      this.result = 'data:application/pdf;base64,JVBERi0=';
      this.onload?.();
    }, 0);
  }
}

export function mountPage(fetchImpl: (...args: unknown[]) => Promise<unknown>): Page {
  const nodes: Record<string, FakeElement> = {};
  for (const id of IDS) nodes[id] = element();
  const globals = new Map<string, (event: unknown) => void>();

  runInNewContext(PAGE_JS, {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      globals.set(name, handler);
    },
    document: {
      getElementById: (id: string) => nodes[id],
      createElement: () => element(),
    },
    fetch: fetchImpl,
    TextDecoder,
    FileReader: FakeFileReader,
    console,
  });

  return {
    nodes,
    fireGlobal(event, payload) {
      const handler = globals.get(event);
      if (handler === undefined) throw new Error(`the page registered no window ${event}`);
      handler(payload ?? {});
    },
    fire(id, event, payload) {
      const handler = nodes[id]?.listeners.get(event);
      if (handler === undefined) throw new Error(`the page registered no ${event} on #${id}`);
      handler(payload ?? {});
    },
    async settle() {
      for (let turn = 0; turn < 10; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
