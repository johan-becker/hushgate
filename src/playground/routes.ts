/**
 * The routes the trial page is made of.
 *
 * Mounted only by `hushgate setup`. The page turns placeholders back into
 * personal data, which is precisely what a production proxy must not offer, so
 * `serve` has no flag that switches this on.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PAGE_CSS, PAGE_JS, renderPage, type PlaygroundEndpoint } from './page.js';
import type { TrialStore } from './session.js';

export const PLAYGROUND_PREFIX = '/__playground';

export interface PlaygroundOptions {
  /** Where the placeholder mappings live between preview and send. */
  readonly store: TrialStore;
  /**
   * The key typed at the terminal. It reaches the provider from here and
   * nowhere else: it is never rendered into the page, never sent to the
   * browser, and never written to a file.
   */
  readonly apiKey: string;
  readonly endpoint: PlaygroundEndpoint;
  /** Whether to say out loud that names come only from the dictionary. */
  readonly dictionaryIsEmpty: boolean;
}

/**
 * Headers on everything this module serves.
 *
 * `default-src 'none'` with `script-src 'self'` is why the script and the
 * stylesheet are separate routes rather than inline blocks: the page can then
 * load exactly two things, both from this server, and reach nothing else.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/** Like `sendText`, but carrying the page's headers. */
function sendAsset(response: ServerResponse, body: string, contentType: string): void {
  if (response.writableEnded) return;
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(bytes.length),
    ...SECURITY_HEADERS,
  });
  response.end(bytes);
}

/**
 * Answer a request under {@link PLAYGROUND_PREFIX}.
 *
 * Returns `false` when this module has nothing to say about it, so the caller
 * falls through to its ordinary handling — including its ordinary 404.
 */
export function handlePlayground(
  request: IncomingMessage,
  response: ServerResponse,
  options: PlaygroundOptions,
  pathname: string,
): Promise<boolean> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (pathname === PLAYGROUND_PREFIX || pathname === `${PLAYGROUND_PREFIX}/`) {
      sendAsset(
        response,
        renderPage({ endpoint: options.endpoint, dictionaryIsEmpty: options.dictionaryIsEmpty }),
        'text/html; charset=utf-8',
      );
      return Promise.resolve(true);
    }

    if (pathname === `${PLAYGROUND_PREFIX}/app.css`) {
      sendAsset(response, PAGE_CSS, 'text/css; charset=utf-8');
      return Promise.resolve(true);
    }

    if (pathname === `${PLAYGROUND_PREFIX}/app.js`) {
      sendAsset(response, PAGE_JS, 'text/javascript; charset=utf-8');
      return Promise.resolve(true);
    }
  }

  return Promise.resolve(false);
}
