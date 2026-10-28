/**
 * Enough of a browser to run the trial page's own script.
 *
 * The page ships as a string of JavaScript, which until now was only ever
 * asserted *as a string*. That cannot catch the failure this harness exists
 * for: a promise that rejects and leaves the last status message on screen.
 * So the real source runs, in a vm context with the handful of globals it
 * touches, and the test drives it through the listeners it registers.
 *
 * Elements form a small tree, because the page builds its marks and chips as
 * nodes: a test can then ask what landed where, and in what order.
 */
import { runInNewContext } from 'node:vm';
import { PAGE_JS } from '../../src/playground/page.js';

/** A text node: what `append('some text')` makes. */
export interface FakeText {
  readonly nodeType: 3;
  textContent: string;
  parentNode: FakeElement | null;
}

export type FakeNode = FakeElement | FakeText;

export interface FakeElement {
  readonly nodeType: 1;
  readonly tagName: string;
  textContent: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  title: string;
  type: string;
  tabIndex: number;
  className: string;
  /** Recorded rather than parsed: the page must never write markup. */
  innerHTML: string;
  readonly htmlWrites: string[];
  files?: unknown[];
  readonly children: FakeNode[];
  parentNode: FakeElement | null;
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): boolean;
    contains(name: string): boolean;
  };
  readonly dataset: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  readonly listeners: Map<string, (event: unknown) => void>;
  addEventListener(name: string, handler: (event: unknown) => void): void;
  append(...nodes: unknown[]): void;
  replaceChildren(...nodes: unknown[]): void;
  contains(node: unknown): boolean;
  click(): void;
  focus(): void;
}

function text(value: string): FakeText {
  return { nodeType: 3, textContent: value, parentNode: null };
}

/** What the elements of one page share: which of them has focus. */
interface World {
  active: FakeElement | null;
}

function element(world: World, tagName = 'div'): FakeElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  const children: FakeNode[] = [];
  let ownText = '';
  const htmlWrites: string[] = [];

  const adopt = (parent: FakeElement, nodes: unknown[]): void => {
    for (const node of nodes) {
      const child: FakeNode =
        typeof node === 'object' && node !== null && 'nodeType' in node
          ? (node as FakeNode)
          : text(String(node));
      child.parentNode = parent;
      children.push(child);
    }
  };

  const self: FakeElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    get textContent(): string {
      return children.length === 0 ? ownText : children.map((child) => child.textContent).join('');
    },
    set textContent(value: string) {
      children.length = 0;
      ownText = String(value);
    },
    value: '',
    disabled: false,
    hidden: false,
    title: '',
    type: '',
    tabIndex: -1,
    get className(): string {
      return [...classes].join(' ');
    },
    set className(value: string) {
      classes.clear();
      for (const name of String(value).split(/\s+/u)) if (name !== '') classes.add(name);
    },
    get innerHTML(): string {
      return htmlWrites.at(-1) ?? '';
    },
    set innerHTML(value: string) {
      htmlWrites.push(String(value));
      children.length = 0;
      ownText = '';
    },
    htmlWrites,
    children,
    parentNode: null,
    classList: {
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      toggle(name, force) {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    dataset: {},
    setAttribute: (name, value) => void attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    listeners: new Map(),
    addEventListener(name, handler) {
      this.listeners.set(name, handler);
    },
    append(...nodes) {
      ownText = '';
      adopt(self, nodes);
    },
    replaceChildren(...nodes) {
      children.length = 0;
      ownText = '';
      adopt(self, nodes);
    },
    contains(node) {
      for (let at = node as FakeNode | null; at; at = at.parentNode) if (at === self) return true;
      return false;
    },
    click() {
      self.listeners.get('click')?.({ target: self });
    },
    focus() {
      world.active = self;
    },
  };
  return self;
}

/** Every id the page looks up, so a typo in either surfaces as undefined. */
const IDS = [
  'input',
  'annotated',
  'names',
  'sanitised',
  'findings',
  'summary',
  'raw',
  'hydrated',
  'model',
  'check',
  'check-key',
  'send',
  'edit',
  'open-file',
  'file',
  'samples',
  'samples-row',
  'holding',
  'copy-sanitised',
  'copy-hydrated',
  'pane-input',
  'pane-out',
  'pane-raw',
  'pane-hydrated',
  'body-input',
  'body-out',
  'summary-hint',
  'copy-status',
  'input-status',
  'send-status',
  'trip-text',
  'trip-out',
  'trip-provider',
  'trip-in',
  'trip-you',
  'leg-1',
  'leg-2',
  'leg-3',
  'leg-4',
] as const;

/** Every element under `root`, root included, depth first. */
function* walk(root: FakeElement): Generator<FakeElement> {
  yield root;
  for (const child of root.children) if (child.nodeType === 1) yield* walk(child);
}

/**
 * The three selector shapes the page uses: `.class`, `[data-x]` and
 * `[data-x="value"]`. Anything else is a test-harness gap and says so.
 */
function matcher(selector: string): (node: FakeElement) => boolean {
  const byClass = /^\.([\w-]+)$/u.exec(selector);
  if (byClass) return (node) => node.classList.contains(byClass[1]!);

  const byData = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/u.exec(selector);
  if (byData) {
    const key = byData[1]!.replaceAll(/-(\w)/gu, (_, c: string) => c.toUpperCase());
    const want = byData[2];
    return (node) => (want === undefined ? key in node.dataset : node.dataset[key] === want);
  }

  throw new Error(`the fake document cannot match ${selector}`);
}

export interface Page {
  readonly nodes: Readonly<Record<string, FakeElement>>;
  /** Fire a listener the page registered, e.g. `click` on the check button. */
  fire(id: string, event: string, payload?: unknown): void;
  /** Fire a listener the page registered on an element it created. */
  fireOn(node: FakeElement, event: string, payload?: unknown): void;
  /** Fire a listener the page registered on the window itself. */
  fireGlobal(event: string, payload?: unknown): void;
  /** Fire a listener the page registered on the document. */
  fireDocument(event: string, payload?: unknown): void;
  /** Every element in the page matching one of the selectors above. */
  find(selector: string): FakeElement[];
  /** Every element the page created, with the tag it asked for. */
  readonly created: readonly FakeElement[];
  /** The element that has focus, as `document.activeElement` reports it. */
  readonly active: FakeElement | null;
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

/**
 * `globals` adds what a browser may or may not have, such as `navigator`,
 * `requestAnimationFrame` or `getSelection`, so a test can take either path.
 */
export function mountPage(
  fetchImpl: (...args: unknown[]) => Promise<unknown>,
  globals: Readonly<Record<string, unknown>> = {},
): Page {
  const world: World = { active: null };
  const nodes: Record<string, FakeElement> = {};
  for (const id of IDS) nodes[id] = element(world, id === 'input' ? 'textarea' : 'div');
  const windowListeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const created: FakeElement[] = [];

  const find = (selector: string): FakeElement[] => {
    const matches = matcher(selector);
    const seen = new Set<FakeElement>();
    for (const root of Object.values(nodes)) {
      for (const node of walk(root)) if (matches(node)) seen.add(node);
    }
    return [...seen];
  };

  runInNewContext(PAGE_JS, {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      windowListeners.set(name, handler);
    },
    document: {
      get activeElement() {
        return world.active;
      },
      getElementById: (id: string) => nodes[id],
      createElement: (tag: string) => {
        const node = element(world, tag);
        created.push(node);
        return node;
      },
      querySelectorAll: find,
      addEventListener: (name: string, handler: (event: unknown) => void) => {
        documentListeners.set(name, handler);
      },
    },
    fetch: fetchImpl,
    TextDecoder,
    FileReader: FakeFileReader,
    setTimeout,
    console,
    ...globals,
  });

  const fireOn = (node: FakeElement | undefined, event: string, payload?: unknown): void => {
    const handler = node?.listeners.get(event);
    if (handler === undefined) throw new Error(`the page registered no ${event} there`);
    handler(payload ?? { target: node });
  };

  return {
    nodes,
    created,
    find,
    get active() {
      return world.active;
    },
    fireGlobal(event, payload) {
      const handler = windowListeners.get(event);
      if (handler === undefined) throw new Error(`the page registered no window ${event}`);
      handler(payload ?? {});
    },
    fireDocument(event, payload) {
      const handler = documentListeners.get(event);
      if (handler === undefined) throw new Error(`the page registered no document ${event}`);
      handler(payload ?? {});
    },
    fire(id, event, payload) {
      const handler = nodes[id]?.listeners.get(event);
      if (handler === undefined) throw new Error(`the page registered no ${event} on #${id}`);
      handler(payload ?? {});
    },
    fireOn,
    async settle() {
      for (let turn = 0; turn < 10; turn += 1) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
