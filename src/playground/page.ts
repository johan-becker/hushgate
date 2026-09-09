/**
 * The trial page: four boxes, top to bottom, and the small amount of script
 * that fills them.
 *
 * Written as plain strings because the whole product installs nothing. There is
 * no framework here and no build step, and the script and the stylesheet are
 * served as their own routes rather than inlined, so the page can be delivered
 * under `default-src 'none'` with `script-src 'self'` — a page that cannot
 * fetch anything is the same promise the rest of hushgate makes.
 */

export interface PlaygroundEndpoint {
  readonly label: string;
  readonly baseUrl: string;
  readonly api: 'openai' | 'anthropic';
  readonly trialModel: string;
}

/** Nothing interpolated into the document is trusted, including our own labels. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface PageInputs {
  readonly endpoint: PlaygroundEndpoint;
  readonly dictionaryIsEmpty: boolean;
}

export function renderPage(inputs: PageInputs): string {
  const provider = escapeHtml(inputs.endpoint.label);
  const model = escapeHtml(inputs.endpoint.trialModel);

  // Shown while the dictionary is empty, which in a trial it always is. The
  // condition is the configuration, not the text: nothing inspects the input
  // for name-shaped candidates, so this neither over- nor under-claims.
  const dictionaryNotice = inputs.dictionaryIsEmpty
    ? `<p class="notice">Personal names come only from your dictionary. Add yours under
       <code>redaction.dictionary.names</code> and they will be replaced too.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hushgate — trial</title>
<link rel="stylesheet" href="/__playground/app.css">
</head>
<body>
<main>
  <header>
    <h1>hushgate</h1>
    <p>Nothing reaches ${provider} until you press Send, and what it receives is
       what the second box shows.</p>
  </header>

  <section>
    <h2>1 &middot; Your text</h2>
    <textarea id="input" rows="10" placeholder="Paste a real document, or drop a PDF here."></textarea>
    <p class="row">
      <button id="check" type="button">Check it</button>
      <span id="input-status" class="status"></span>
    </p>
  </section>

  <section>
    <h2>2 &middot; What the provider sees</h2>
    <pre id="sanitised" class="box">&nbsp;</pre>
    <p id="findings" class="findings"></p>
    ${dictionaryNotice}
    <p class="row">
      <label for="model">Model</label>
      <input id="model" type="text" value="${model}" spellcheck="false">
      <button id="send" type="button" disabled>Send</button>
      <span id="send-status" class="status"></span>
    </p>
  </section>

  <section>
    <h2>3 &middot; Reply, as it arrives</h2>
    <pre id="raw" class="box">&nbsp;</pre>
  </section>

  <section>
    <h2>4 &middot; Reply, rehydrated</h2>
    <pre id="hydrated" class="box">&nbsp;</pre>
    <p class="notice">Box 4 lags box 3 whenever a placeholder falls across a
       chunk boundary: the characters are held back until the token is whole.</p>
  </section>
</main>
<script src="/__playground/app.js"></script>
</body>
</html>
`;
}

export const PAGE_CSS = `:root {
  color-scheme: light dark;
  --ink: #14171a;
  --paper: #fbfbfa;
  --edge: #d9d6d0;
  --quiet: #6b7076;
  --mark: #1f6feb;
}

@media (prefers-color-scheme: dark) {
  :root { --ink: #e8e6e3; --paper: #16181a; --edge: #2f3336; --quiet: #9aa0a6; --mark: #58a6ff; }
}

* { box-sizing: border-box; }

body {
  margin: 0;
  padding: 2rem 1rem 4rem;
  background: var(--paper);
  color: var(--ink);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}

main { max-width: 46rem; margin: 0 auto; }

header { margin-bottom: 2rem; }
h1 { margin: 0 0 .25rem; font-size: 1.4rem; letter-spacing: -.01em; }
header p { margin: 0; color: var(--quiet); max-width: 34rem; }

section { margin-bottom: 1.75rem; }
h2 { margin: 0 0 .5rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--quiet); font-weight: 600; }

textarea, .box, input {
  width: 100%;
  border: 1px solid var(--edge);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  padding: .7rem .8rem;
  font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
}

textarea { resize: vertical; }
textarea:focus, input:focus { outline: 2px solid var(--mark); outline-offset: -1px; }
textarea.dropping { outline: 2px dashed var(--mark); outline-offset: -1px; }

.box { margin: 0; min-height: 3.2rem; white-space: pre-wrap; word-break: break-word; }

.row { display: flex; align-items: center; gap: .6rem; margin: .6rem 0 0; }
.row label { font-size: .8rem; color: var(--quiet); }
.row input { width: 14rem; }

button {
  border: 1px solid var(--edge);
  border-radius: 6px;
  background: var(--ink);
  color: var(--paper);
  padding: .45rem .9rem;
  font: inherit;
  font-size: .85rem;
  cursor: pointer;
}

button:disabled { opacity: .4; cursor: default; }

.status { font-size: .8rem; color: var(--quiet); }

.findings { margin: .5rem 0 0; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--quiet); }
.findings span { display: inline-block; margin-right: .8rem; }
.findings b { color: var(--ink); font-weight: 600; }

.notice { margin: .6rem 0 0; font-size: .8rem; color: var(--quiet); max-width: 34rem; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

export const PAGE_JS = `(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const sanitised = $('sanitised');
  const findings = $('findings');
  const raw = $('raw');
  const hydrated = $('hydrated');
  const model = $('model');
  const checkButton = $('check');
  const sendButton = $('send');
  const inputStatus = $('input-status');
  const sendStatus = $('send-status');

  let sessionId = null;

  const say = (node, text) => { node.textContent = text; };

  /** Ask what the provider would see, and hold the session it opens. */
  async function check() {
    const text = input.value;
    if (text.trim() === '') { say(inputStatus, 'nothing to check yet'); return; }

    checkButton.disabled = true;
    say(inputStatus, 'checking…');

    try {
      const response = await fetch('/__playground/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model: model.value }),
      });

      if (!response.ok) {
        say(inputStatus, 'could not read that: ' + response.status);
        return;
      }

      const body = await response.json();
      sessionId = body.sessionId;
      sanitised.textContent = body.sanitised;
      renderFindings(body.findings);
      sendButton.disabled = false;
      say(inputStatus, '');
      say(sendStatus, '');
      raw.textContent = '';
      hydrated.textContent = '';
    } finally {
      checkButton.disabled = false;
    }
  }

  function renderFindings(counts) {
    const kinds = Object.keys(counts || {}).sort();
    if (kinds.length === 0) {
      findings.textContent = 'nothing personal found in that text';
      return;
    }
    findings.innerHTML = '';
    for (const kind of kinds) {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = kind;
      span.append(b, ' ' + counts[kind]);
      findings.append(span);
    }
  }

  /** Send it, and fill boxes 3 and 4 from the two channels of one stream. */
  async function send() {
    if (sessionId === null) return;

    sendButton.disabled = true;
    say(sendStatus, 'waiting for the first token…');
    raw.textContent = '';
    hydrated.textContent = '';

    let response;
    try {
      response = await fetch('/__playground/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch (error) {
      say(sendStatus, 'the request did not go out');
      sendButton.disabled = false;
      return;
    }

    if (!response.ok || response.body === null) {
      say(sendStatus, 'the provider refused: ' + response.status);
      sendButton.disabled = false;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let cut = buffer.indexOf('\\n\\n');
      while (cut !== -1) {
        apply(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf('\\n\\n');
      }
    }

    say(sendStatus, 'done');
    sendButton.disabled = false;
  }

  /** One SSE block: an event name and its data. */
  function apply(block) {
    let name = '';
    let data = '';

    for (const line of block.split('\\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }

    if (name === '' || data === '') return;
    if (name === 'done') { say(sendStatus, 'done'); return; }
    if (name === 'error') { say(sendStatus, 'the provider returned an error'); return; }

    let parsed;
    try { parsed = JSON.parse(data); } catch (error) { return; }
    const delta = parsed && typeof parsed.delta === 'string' ? parsed.delta : '';
    if (delta === '') return;

    if (name === 'raw') raw.textContent += delta;
    if (name === 'hydrated') hydrated.textContent += delta;
  }

  /** A dropped document goes through the same door as pasted text. */
  async function dropped(event) {
    event.preventDefault();
    input.classList.remove('dropping');

    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (!file) return;

    say(inputStatus, 'reading ' + file.name + '…');

    // Base64 in a JSON body, so the server needs no multipart parser and the
    // bytes take the same door as everything else.
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('unreadable'));
      reader.onload = () => {
        const url = String(reader.result);
        resolve(url.slice(url.indexOf(',') + 1));
      };
      reader.readAsDataURL(file);
    });

    const response = await fetch('/__playground/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: { name: file.name, mediaType: file.type || null, data },
        model: model.value,
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const message = detail && detail.error && detail.error.message;
      say(inputStatus, message || 'that file could not be read');
      return;
    }

    const parsed = await response.json();
    sessionId = parsed.sessionId;
    input.value = parsed.extracted || '';
    sanitised.textContent = parsed.sanitised;
    renderFindings(parsed.findings);
    sendButton.disabled = false;
    say(inputStatus, file.name + ' — read as text, the file itself stays here');
  }

  checkButton.addEventListener('click', () => { void check(); });
  sendButton.addEventListener('click', () => { void send(); });
  input.addEventListener('dragover', (event) => {
    event.preventDefault();
    input.classList.add('dropping');
  });
  input.addEventListener('dragleave', () => input.classList.remove('dropping'));
  input.addEventListener('drop', (event) => { void dropped(event); });
})();
`;
