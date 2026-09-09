/**
 * The trial page `hushgate setup` serves: a local demonstration of the whole
 * round trip, mounted nowhere else.
 */
export { PLAYGROUND_PREFIX, handlePlayground } from './routes.js';
export type { PlaygroundOptions } from './routes.js';
export { renderPage, PAGE_CSS, PAGE_JS } from './page.js';
export type { PlaygroundEndpoint, PageInputs } from './page.js';
export { TrialStore } from './session.js';
export type { TrialSession, TrialStoreOptions } from './session.js';
