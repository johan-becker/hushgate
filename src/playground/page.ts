/**
 * The trial page: four panes in the order the data travels, and the script
 * that fills them.
 *
 * Written as plain strings because the whole product installs nothing. There is
 * no framework here and no build step, and the script and the stylesheet are
 * served as their own routes rather than inlined, so the page can be delivered
 * under `default-src 'none'` with `script-src 'self'` — a page that cannot
 * fetch anything is the same promise the rest of hushgate makes.
 */
import { SAMPLES } from './samples.js';

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
    ? `<p class="notice">In production, names come only from
       <code>redaction.dictionary.names</code>.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hushgate — trial</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/__playground/app.css">
</head>
<body>
<div class="shell">
  <header class="top">
    <div class="brand">
      <h1 class="wordmark">hushgate</h1>
      <span class="mode">trial</span>
    </div>
    <p class="lede">Nothing reaches ${provider} until you press Send.</p>
    <div class="endpoint">
      <span class="provider">${provider}</span>
      <label for="model">Model</label>
      <input id="model" type="text" value="${model}" spellcheck="false" autocomplete="off">
    </div>
  </header>

  <div class="trip" aria-hidden="true">
    <span id="trip-text" class="stop"><span class="dot"></span>Your text</span>
    <span id="leg-1" class="leg leg-pii"></span>
    <span id="trip-out" class="stop"><span class="dot"></span>hushgate</span>
    <span id="leg-2" class="leg leg-token"></span>
    <span id="trip-provider" class="stop"><span class="dot"></span><span class="stop-name">${provider}</span></span>
    <span id="leg-3" class="leg leg-token"></span>
    <span id="trip-in" class="stop"><span class="dot"></span>hushgate</span>
    <span id="leg-4" class="leg leg-pii"></span>
    <span id="trip-you" class="stop"><span class="dot"></span>You</span>
  </div>

  <main class="grid">
    <section id="pane-input" class="pane" aria-labelledby="h-input">
      <div class="pane-head">
        <h2 id="h-input">Your text</h2>
        <div class="tools">
          <button id="edit" class="ghost" type="button" hidden>Edit</button>
          <button id="open-file" class="ghost" type="button">Open a file…</button>
          <input id="file" class="sr-only" type="file" tabindex="-1" aria-hidden="true">
        </div>
      </div>
      <div id="samples-row" class="samples">
        <span id="samples-label" class="samples-label">Try a sample</span>
        <div id="samples" class="sample-list" role="group" aria-labelledby="samples-label"></div>
      </div>
      <div id="body-input" class="pane-body">
        <textarea id="input" aria-labelledby="h-input" spellcheck="false"
          placeholder="Paste a document, drop a file on this pane, or pick a sample."></textarea>
        <div id="annotated" class="text annotated" hidden></div>
      </div>
      <div class="names">
        <label for="names">Names to replace</label>
        <input id="names" type="text" spellcheck="false" autocomplete="off"
          placeholder="Comma-separated, e.g. Anna Schmidt, Jonas Brandt">
        ${dictionaryNotice}
      </div>
      <div class="pane-foot">
        <button id="check" class="primary" type="button" aria-keyshortcuts="Control+Enter Meta+Enter">Check <kbd id="check-key">Ctrl ↵</kbd></button>
        <span id="input-status" class="status" aria-live="polite"></span>
      </div>
    </section>

    <section id="pane-out" class="pane" aria-labelledby="h-out">
      <div class="pane-head">
        <h2 id="h-out">What ${provider} receives</h2>
        <div class="tools">
          <button id="copy-sanitised" class="ghost" type="button" disabled>Copy</button>
        </div>
      </div>
      <div class="summary">
        <span id="summary">Nothing checked yet.</span>
        <span id="summary-hint" class="hint" hidden>Point at or tab to a placeholder to find its value.</span>
        <span id="chip-keys" class="sr-only">The arrow keys move between placeholders.</span>
      </div>
      <div id="body-out" class="pane-body">
        <pre id="sanitised" class="text"><span class="empty">After a check, the text exactly as ${provider} will receive it.</span></pre>
      </div>
      <div id="findings" class="legend"><span class="empty">Each kind found gets a chip here, with its count.</span></div>
      <div class="pane-foot">
        <button id="send" class="primary" type="button" disabled>Send</button>
        <span id="send-status" class="status" aria-live="polite"></span>
      </div>
    </section>

    <section id="pane-raw" class="pane" aria-labelledby="h-raw">
      <div class="pane-head">
        <h2 id="h-raw">Reply as ${provider} wrote it</h2>
      </div>
      <div class="pane-body">
        <pre id="raw" class="text"><span class="empty">The reply streams in here as it arrives, placeholders and all.</span></pre>
      </div>
      <p class="pane-note">Exactly as it arrived, before hushgate touches it.</p>
    </section>

    <section id="pane-hydrated" class="pane" aria-labelledby="h-hydrated">
      <div class="pane-head">
        <h2 id="h-hydrated">Reply as you read it</h2>
        <div class="tools">
          <span id="holding" class="holding" hidden></span>
          <button id="copy-hydrated" class="ghost" type="button" disabled>Copy</button>
        </div>
      </div>
      <div class="pane-body">
        <pre id="hydrated" class="text"><span class="empty">The same reply, with your values put back on this machine.</span></pre>
      </div>
      <p class="pane-note">A placeholder cut across two chunks is held back until it is whole, so this
         side can trail the other by a few characters.</p>
    </section>
  </main>
  <span id="copy-status" class="sr-only" aria-live="polite"></span>
</div>
<script src="/__playground/app.js"></script>
</body>
</html>
`;
}

export const PAGE_CSS = `:root {
  color-scheme: light;
  --background: oklch(0.972 0.005 250);
  --foreground: oklch(0.235 0.045 262);
  --card: oklch(1 0 0);
  --muted: oklch(0.945 0.007 250);
  --muted-foreground: oklch(0.47 0.028 258);
  --border: oklch(0.885 0.011 252);
  --brand: oklch(0.235 0.045 262);
  --brand-foreground: oklch(0.985 0.003 250);
  --destructive: oklch(0.53 0.2 25);
  --pii: oklch(0.55 0.19 18);
  --token: oklch(0.48 0.14 234);
  --ok: oklch(0.46 0.1 182);
  --warn: oklch(0.5 0.14 62);

  --sans: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

/* Colour means data. The interface is ink on paper; the only hues are a real
   value (warm), the placeholder that replaced it (cool), and status words. */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --background: oklch(0.17 0.032 262);
    --foreground: oklch(0.935 0.008 252);
    --card: oklch(0.205 0.034 262);
    --muted: oklch(0.235 0.034 262);
    --muted-foreground: oklch(0.72 0.022 256);
    --border: oklch(1 0 0 / 10%);
    --brand: oklch(0.935 0.008 252);
    --brand-foreground: oklch(0.17 0.032 262);
    --destructive: oklch(0.72 0.17 25);
    --pii: oklch(0.75 0.15 18);
    --token: oklch(0.79 0.12 232);
    --ok: oklch(0.79 0.1 182);
    --warn: oklch(0.81 0.13 70);
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font: 14px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}

/* Selection is interface, not data, so it takes ink rather than a data hue. */
::selection { background: color-mix(in oklch, var(--foreground) 16%, transparent); }

:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.shell { max-width: 1280px; margin: 0 auto; padding: 24px 32px 56px; }

/* Top bar */

.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 20px; }
.brand { display: flex; align-items: baseline; gap: 8px; }
.wordmark { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.015em; }
.mode {
  position: relative;
  top: -1px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font: 11px/17px var(--mono);
  color: var(--muted-foreground);
}
.lede { margin: 0; font-size: 13px; color: var(--muted-foreground); }
.endpoint { display: flex; align-items: center; gap: 10px; margin-left: auto; font-size: 13px; }
.provider { font-weight: 550; }
.endpoint label { color: var(--muted-foreground); }

input[type="text"] {
  height: 30px;
  padding: 0 10px;
  border: 1px solid color-mix(in oklch, var(--foreground) 22%, transparent);
  border-radius: 6px;
  background: var(--background);
  color: inherit;
  font: 12.5px var(--mono);
}
input[type="text"]:focus-visible { outline-offset: -1px; }
input::placeholder, textarea::placeholder { color: var(--muted-foreground); opacity: 1; }
#model { width: 13rem; }

/* Round-trip strip: a hairline with five stops. The legs carry the data's
   colour once they are travelled: warm where real values move, cool where
   only placeholders do. */

.trip {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0 20px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--muted-foreground);
}
.stop { display: inline-flex; align-items: center; gap: 7px; min-width: 0; white-space: nowrap; transition: color .2s; }
.stop-name { overflow: hidden; text-overflow: ellipsis; max-width: 14rem; }
.dot {
  flex: none;
  width: 9px;
  height: 9px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  background: var(--background);
  transition: background-color .2s, border-color .2s, box-shadow .2s;
}
.leg { flex: 1 1 0; min-width: 10px; border-top: 1px solid var(--border); }

.stop.is-done, .stop.is-active { color: var(--foreground); }
.stop.is-done .dot { background: var(--foreground); border-color: var(--foreground); }
.stop.is-active .dot {
  border-color: var(--foreground);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--foreground) 14%, transparent);
  animation: pulse 1.4s ease-in-out infinite;
}
.stop.is-error { color: var(--destructive); }
.stop.is-error .dot { background: var(--destructive); border-color: var(--destructive); }
/* The error hue sits close to the warm data hue, so a failed stop says so in words. */
.stop.is-error::after { content: "failed"; margin-left: 2px; font-size: 11px; }

.leg-pii.is-done { border-top-color: var(--pii); }
.leg-token.is-done { border-top-color: var(--token); }
.leg-pii.is-active { border-top: 1px dashed var(--pii); }
.leg-token.is-active { border-top: 1px dashed var(--token); }
.leg.is-error { border-top: 1px dashed var(--destructive); }

@keyframes pulse {
  50% { box-shadow: 0 0 0 5px color-mix(in oklch, var(--foreground) 6%, transparent); }
}

/* Panes. Two columns follow the data across the gate: out on the top row,
   back in on the bottom one. The dashed rule between them is the gate. */

.grid {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 20px 48px;
}
.grid::before {
  content: "";
  position: absolute;
  top: 8px;
  bottom: 8px;
  left: 50%;
  border-left: 1px dashed var(--border);
}

.pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--card);
}
.pane.is-dropping { outline: 2px dashed var(--foreground); outline-offset: -1px; }

.pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 7px 12px 7px 16px;
  border-bottom: 1px solid var(--border);
}
h2 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted-foreground);
}
.tools { display: flex; flex: none; align-items: center; gap: 8px; }

.pane-body { display: flex; flex: 1; flex-direction: column; min-height: 0; }

.text, textarea {
  margin: 0;
  padding: 14px 16px 16px;
  font: 13px/1.7 var(--mono);
  color: var(--foreground);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Grow to fill the row, never shrink below the text: when the row is capped,
   the pane body scrolls rather than the text inside it. */
.text { flex: 1 0 auto; min-height: 132px; }
textarea {
  flex: 1 0 auto;
  width: 100%;
  min-height: 300px;
  field-sizing: content;
  border: 0;
  border-radius: 0;
  background: transparent;
  resize: vertical;
}
textarea:focus-visible { outline-offset: -2px; }
.annotated { min-height: 300px; cursor: text; }

.empty {
  font: 13px/1.55 var(--sans);
  color: var(--muted-foreground);
  white-space: normal;
}

.pane-note {
  margin: 0;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted-foreground);
}

.pane-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 56px;
  padding: 11px 16px;
  border-top: 1px solid var(--border);
}

/* Marks: a real value is warm, the placeholder that replaced it is cool. */

.value, .chip {
  border-radius: 3px;
  -webkit-box-decoration-break: clone;
  box-decoration-break: clone;
  transition: background-color .12s, color .12s;
}
.value { padding: 0 2px; color: var(--pii); background: color-mix(in oklch, var(--pii) 10%, transparent); }
.chip { padding: 0 3px; color: var(--token); background: color-mix(in oklch, var(--token) 14%, transparent); }
.chip.is-pending { background: transparent; outline: 1px dashed var(--token); outline-offset: -1px; }

/* The chain you are pointing at turns solid, so its partners stand out from
   every other mark of the same colour, and the text on it stays legible. */
.value.is-linked { background: var(--pii); color: var(--card); }
.chip.is-linked { background: var(--token); color: var(--card); }
/* Focus also links, so the focused chip needs a ring its partner lacks. */
.chip:focus-visible, .chip.is-linked:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
.is-kind { box-shadow: inset 0 -2px 0 currentColor; }

.caret {
  display: inline-block;
  width: 2px;
  height: 1.15em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--foreground);
  animation: blink 1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

/* Controls */

button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { cursor: default; }

.primary {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--brand);
  border-radius: 6px;
  background: var(--brand);
  color: var(--brand-foreground);
  font-size: 13px;
  font-weight: 550;
}
.primary:hover:not(:disabled) { background: color-mix(in oklch, var(--brand) 86%, var(--background)); }
.primary:disabled { opacity: .32; }
/* Once a check stands, the next step is Send, so Check steps back. */
.primary.is-quiet { background: transparent; color: var(--foreground); border-color: var(--border); }
.primary.is-quiet:hover:not(:disabled) {
  background: transparent;
  border-color: color-mix(in oklch, var(--foreground) 35%, transparent);
}
kbd {
  padding-left: 8px;
  border-left: 1px solid color-mix(in oklch, currentColor 30%, transparent);
  font: 12px/1 var(--mono);
  opacity: .8;
}

.ghost, .sample, .kind {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border);
  background: transparent;
  transition: border-color .15s, color .15s, background-color .15s;
}
.ghost {
  height: 26px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: 12.5px;
  color: var(--muted-foreground);
}
.ghost:hover:not(:disabled), .sample:hover, .kind:hover {
  border-color: color-mix(in oklch, var(--foreground) 35%, transparent);
  color: var(--foreground);
}
.ghost:disabled { opacity: .45; }

.samples {
  display: flex;
  min-height: 47px;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.samples-label { font-size: 12px; color: var(--muted-foreground); }
.sample-list { display: flex; flex-wrap: wrap; gap: 6px; }
.sample {
  height: 26px;
  padding: 0 9px;
  border-radius: 5px;
  font-size: 12.5px;
  color: var(--foreground);
}
.sample[aria-pressed="true"] { border-color: var(--foreground); background: var(--muted); }

.names {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 6px 12px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.names label { font-size: 12.5px; font-weight: 550; }
.notice { grid-column: 2; margin: 0; font-size: 12px; color: var(--muted-foreground); }
code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--muted);
  font: 11.5px var(--mono);
}

.status {
  min-width: 0;
  font-size: 12.5px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.status.is-error { color: var(--destructive); }
.status.is-warn { color: var(--warn); }

/* Findings: one neutral chip per kind. A kind is told apart by its label. */

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 16px;
  min-height: 47px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
}
.summary .hint { color: var(--muted-foreground); }
.kind {
  gap: 7px;
  height: 24px;
  padding: 0 7px;
  border-radius: 4px;
  font: 11.5px var(--mono);
  letter-spacing: .02em;
  color: var(--foreground);
}
.kind .count { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.kind[aria-pressed="true"] { border-color: var(--foreground); background: var(--muted); }

.holding { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
.holding .chip { font: 11.5px/18px var(--mono); }

/* Stale: the right side no longer describes the text on the left. */
.pane.is-stale .pane-body, .pane.is-stale .legend, .pane.is-stale .summary { opacity: .4; transition: opacity .2s; }

/* Side by side, the panes share their rows, so the checked text and what the
   provider receives start on the same line and can be read across. */
@media (min-width: 960px) {
  .grid { grid-template-rows: repeat(8, auto); row-gap: 0; }
  .pane { display: grid; grid-template-rows: subgrid; grid-row: span 5; }
  #pane-raw, #pane-hydrated { grid-row: span 3; margin-top: 20px; }
  /* Capped, so Send and the start of the reply fit a laptop screen. The two
     bodies scroll together, which keeps the lines facing each other. */
  #body-input, #body-out {
    max-height: min(46vh, 520px);
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklch, var(--foreground) 22%, transparent) transparent;
  }
  /* With more below, the bottom edge fades out rather than cutting a line,
     and the value marked on it, in half. */
  #body-input.has-more, #body-out.has-more {
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 32px), transparent);
  }
}

@media (max-width: 959px) {
  .grid { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .grid::before { display: none; }
  textarea, .annotated { min-height: 220px; }
}

@media (max-width: 599px) {
  .shell { padding: 16px 16px 40px; }
  .endpoint { width: 100%; margin-left: 0; }
  #model { flex: 1; width: auto; min-width: 0; }
  .provider { display: none; }
  /* Labels go under the dots, so five stops fit across a phone. */
  .trip { align-items: flex-start; gap: 0; font-size: 11px; }
  .stop { flex-direction: column; gap: 5px; }
  .leg { min-width: 8px; margin: 4px 4px 0; }
  .stop-name { max-width: 5.5rem; }
  .summary .hint { display: none; }
  .names { grid-template-columns: minmax(0, 1fr); }
  .notice { grid-column: 1; }
  .pane-head { padding-left: 14px; }
  .text, textarea { padding-left: 14px; padding-right: 14px; }
  .ghost, .sample { height: 32px; }
  .kind { height: 28px; }
}

@media (prefers-reduced-motion: reduce) {
  .caret, .stop.is-active .dot { animation: none; }
  * { transition: none !important; }
}
`;

/**
 * The samples ride inside the script as data. Built at module load from a
 * constant, so the page needs no extra route and nothing about them can fail
 * at runtime.
 */
const SAMPLES_JSON = JSON.stringify(
  SAMPLES.map(({ id, label, blurb, names, text }) => ({ id, label, blurb, names, text })),
);

// String.raw, so the regular expressions below read as they run. The only
// interpolation is the sample data.
export const PAGE_JS = String.raw`(() => {
  'use strict';

  const SAMPLES = ${SAMPLES_JSON};

  const $ = (id) => document.getElementById(id);
  const input = $('input');
  const annotated = $('annotated');
  const names = $('names');
  const sanitised = $('sanitised');
  const findings = $('findings');
  const summary = $('summary');
  const raw = $('raw');
  const hydrated = $('hydrated');
  const model = $('model');
  const checkButton = $('check');
  const sendButton = $('send');
  const editButton = $('edit');
  const openButton = $('open-file');
  const fileInput = $('file');
  const samples = $('samples');
  const samplesRow = $('samples-row');
  const holding = $('holding');
  const copySanitised = $('copy-sanitised');
  const copyHydrated = $('copy-hydrated');
  const paneInput = $('pane-input');
  const paneOut = $('pane-out');
  const paneRaw = $('pane-raw');
  const paneHydrated = $('pane-hydrated');
  const bodyInput = $('body-input');
  const bodyOut = $('body-out');
  const hint = $('summary-hint');
  const copyStatus = $('copy-status');
  const inputStatus = $('input-status');
  const sendStatus = $('send-status');
  const stops = ['text', 'out', 'provider', 'in', 'you'].map((name) => $('trip-' + name));
  const legs = [1, 2, 3, 4].map((n) => $('leg-' + n));

  /** A placeholder a session can issue, and so the only token that links to a value. */
  const PLACEHOLDER = /\[[A-Z][A-Z0-9_]*_\d+\]/g;
  const IS_PLACEHOLDER = /^\[[A-Z][A-Z0-9_]*_\d+\]$/;
  /** Anything a policy can put in a value's place: placeholders, masks and hashes. */
  const TOKEN = /\[[A-Z][A-Z0-9_]*(?:_\d+|_REDACTED|:[0-9a-f]+)\]/g;
  /** The start of a placeholder that has not finished arriving. */
  const PARTIAL = /\[(?:[A-Z][A-Z0-9_]*)?$/;
  const PARTIAL_MAX = 72;

  const now = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

  let sessionId = null;
  /**
   * The text the last check ran on, and what the browser can work out from it:
   * which placeholder stands for which value. The server sends offsets, not
   * values; the values are read off text this page already holds, and the map
   * never leaves the page.
   */
  let checked = null;
  /** Set when the text or the names change after a check, until the next one. */
  let stale = false;
  let reply = emptyReply();
  let framePending = false;
  let linkedToken = null;
  let hoverKind = null;
  let pinnedKind = null;
  /** The placeholders in what the provider receives that take keyboard focus, in order. */
  let sanitisedChips = [];
  const sampleButtons = [];

  /**
   * Checks and file reads can overlap, through the keyboard, the samples or a
   * drop. Each takes a number, and only the latest may land: an older answer
   * would describe text that is no longer on screen.
   */
  let checkSeq = 0;
  let checking = false;
  /**
   * Bumped by every send and by every check that lands. A stream from an
   * earlier one stops writing, so it cannot fill the panes of the next.
   */
  let replyGen = 0;
  let replyReader = null;

  function emptyReply() {
    return { raw: '', hydrated: '', streaming: false, started: 0, first: null, ended: null, restored: 0 };
  }

  const say = (node, text, tone) => {
    node.textContent = text;
    node.classList.toggle('is-error', tone === 'error');
    node.classList.toggle('is-warn', tone === 'warn');
  };

  /**
   * End a failed path.
   *
   * Every handler on this page sets a status before it does anything slow, so
   * a path that returns without clearing it leaves the operator reading
   * "checking…" at a page that stopped working minutes ago. Failing goes
   * through here so that a message and a usable control always travel
   * together.
   */
  const fail = (node, message, button) => {
    say(node, message, 'error');
    if (button === sendButton) restoreSend();
    else if (button) button.disabled = false;
  };

  /** Send is usable only for a fresh check that is not being replaced or answered. */
  function restoreSend() {
    sendButton.disabled = sessionId === null || stale || checking || reply.streaming;
  }

  /** replaceChildren without the spread: a long document would pass more arguments than an engine takes. */
  function fill(node, nodes) {
    node.replaceChildren();
    for (let at = 0; at < nodes.length; at += 4096) node.append(...nodes.slice(at, at + 4096));
  }

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const duration = (ms) =>
    ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  /**
   * The round-trip strip. Stops are your text, hushgate, the provider,
   * hushgate, you; "done" counts the stops passed, "active" is the one at work.
   */
  const TRIP = {
    idle: { done: 0, active: -1 },
    checked: { done: 2, active: -1 },
    sending: { done: 2, active: 2 },
    streaming: { done: 3, active: 3 },
    done: { done: 5, active: -1 },
  };

  function trip(state, failing) {
    const at = state === 'error' ? { done: failing, active: -1 } : TRIP[state];
    stops.forEach((stop, i) => {
      stop.classList.toggle('is-done', i < at.done);
      stop.classList.toggle('is-active', i === at.active);
      stop.classList.toggle('is-error', state === 'error' && i === failing);
    });
    // Leg i runs from stop i to stop i + 1, and takes the state of where it leads.
    legs.forEach((leg, i) => {
      leg.classList.toggle('is-done', i + 1 < at.done);
      leg.classList.toggle('is-active', i + 1 === at.active);
      leg.classList.toggle('is-error', state === 'error' && i + 1 === failing);
    });
    // Restored text is already reaching you while the reply streams.
    if (state === 'streaming') legs[3].classList.add('is-active');
  }

  // ---- Marks and chips -----------------------------------------------------

  function valueNode(text, token, kind) {
    const node = el('span', 'value', text);
    node.dataset.token = token;
    node.dataset.kind = kind;
    node.title = kind + ' → ' + token;
    if (token === linkedToken) node.classList.add('is-linked');
    return node;
  }

  /** stops, when given, collects the chips that take keyboard focus. */
  function chipNode(token, stops) {
    const node = el('span', 'chip', token);
    if (!IS_PLACEHOLDER.test(token)) {
      node.title = 'One-way: this one is never restored.';
      return node;
    }
    node.dataset.token = token;
    const kind = checked && checked.kinds.get(token);
    if (kind) {
      node.dataset.kind = kind;
      node.title = kind + ' → ' + token;
      if (stops) {
        node.tabIndex = -1;
        node.setAttribute('aria-describedby', 'chip-keys');
        stops.push(node);
      }
    } else {
      node.title = 'Not a placeholder this check issued, so it stays as written.';
    }
    if (token === linkedToken) node.classList.add('is-linked');
    return node;
  }

  /** Plain runs and token chips, in order. */
  function tokenNodes(text, stops) {
    const nodes = [];
    let cursor = 0;
    for (const match of text.matchAll(TOKEN)) {
      if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
      nodes.push(chipNode(match[0], stops));
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    return nodes;
  }

  const emptyLine = (text) => el('span', 'empty', text);

  /** Only marks that sit inside the text, in order and without overlap. */
  function cleanMarks(marks, text) {
    if (!Array.isArray(marks)) return [];
    const out = [];
    let cursor = 0;
    for (const mark of marks) {
      if (!mark || typeof mark.kind !== 'string') continue;
      // The placeholder ends up in an attribute selector, so it must be one.
      if (typeof mark.placeholder !== 'string' || !IS_PLACEHOLDER.test(mark.placeholder)) continue;
      const { start, end } = mark;
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      if (start < cursor || end <= start || end > text.length) continue;
      out.push({ start, end, kind: mark.kind, placeholder: mark.placeholder });
      cursor = end;
    }
    return out;
  }

  // ---- Checking ------------------------------------------------------------

  function nameList() {
    return names.value.split(',').map((name) => name.trim()).filter((name) => name !== '');
  }

  /** Take in a preview: hold its session and draw the left and right of the top row. */
  function accept(body, text) {
    sessionId = body.sessionId;
    const marks = cleanMarks(body.marks, text);
    const values = new Map();
    const kinds = new Map();
    for (const mark of marks) {
      values.set(mark.placeholder, text.slice(mark.start, mark.end));
      kinds.set(mark.placeholder, mark.kind);
    }
    checked = { text, marks, values, kinds, sanitised: typeof body.sanitised === 'string' ? body.sanitised : '' };

    // A reply still streaming answers the check this one replaces.
    abandonReply();
    stale = false;
    for (const pane of [paneOut, paneRaw, paneHydrated]) pane.classList.remove('is-stale');
    pinnedKind = null;
    hoverKind = null;
    link(null);

    renderAnnotated();
    showAnnotated(true);
    renderSanitised();
    renderFindings(body.findings);
    hint.hidden = marks.length === 0;

    reply = emptyReply();
    renderReply();

    checking = false;
    restoreSend();
    checkButton.classList.add('is-quiet');
    copySanitised.disabled = false;
    copyHydrated.disabled = true;
    say(sendStatus, '');
    trip('checked');
  }

  function renderAnnotated() {
    const text = checked.text;
    const nodes = [];
    let cursor = 0;
    for (const mark of checked.marks) {
      if (mark.start > cursor) nodes.push(text.slice(cursor, mark.start));
      nodes.push(valueNode(text.slice(mark.start, mark.end), mark.placeholder, mark.kind));
      cursor = mark.end;
    }
    if (cursor < text.length) nodes.push(text.slice(cursor));
    fill(annotated, nodes);
    markFold(bodyInput);
  }

  /** One tab stop for all the placeholders; the arrow keys move between them. */
  function renderSanitised() {
    sanitisedChips = [];
    fill(sanitised, tokenNodes(checked.sanitised, sanitisedChips));
    if (sanitisedChips.length > 0) sanitisedChips[0].tabIndex = 0;
    markFold(bodyOut);
  }

  /** Whether a capped body has text below its fold; see \`.has-more\`. */
  function markFold(body) {
    body.classList.toggle('has-more', body.scrollHeight - body.scrollTop - body.clientHeight > 1);
  }

  function rove(chip) {
    if (sanitisedChips.indexOf(chip) === -1) return;
    for (const other of sanitisedChips) other.tabIndex = other === chip ? 0 : -1;
  }

  const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

  function walkChips(event) {
    const at = sanitisedChips.indexOf(event.target);
    if (at === -1) return;
    const last = sanitisedChips.length - 1;
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (STEPS[event.key]) next = Math.min(last, Math.max(0, at + STEPS[event.key]));
    else return;
    event.preventDefault();
    rove(sanitisedChips[next]);
    sanitisedChips[next].focus();
  }

  /** After a check the left pane reads back the checked text with its values marked. */
  function showAnnotated(on) {
    // Hiding the textarea under the caret (Ctrl+Enter) would drop focus to
    // the top of the page; Edit is where the keyboard picks up again.
    const hadFocus = on && document.activeElement === input;
    annotated.hidden = !on;
    input.hidden = on;
    editButton.hidden = !on;
    if (hadFocus && typeof editButton.focus === 'function') editButton.focus();
    markFold(bodyInput);
  }

  /**
   * Back to the textarea, where the reading left off. Without this the caret
   * lands at the end and the capped pane jumps to the bottom of the text.
   */
  function edit() {
    const top = bodyInput.scrollTop;
    showAnnotated(false);
    if (typeof input.setSelectionRange === 'function') input.setSelectionRange(0, 0);
    if (typeof input.focus === 'function') input.focus({ preventScroll: true });
    bodyInput.scrollTop = top;
  }

  function renderFindings(counts) {
    const kinds = Object.keys(counts || {}).sort();
    if (kinds.length === 0) {
      say(summary, 'Goes out as written.');
      findings.textContent = 'nothing personal found in that text';
      return;
    }
    let total = 0;
    const chips = kinds.map((kind) => {
      total += counts[kind];
      const button = el('button', 'kind');
      button.type = 'button';
      button.dataset.legend = kind;
      button.setAttribute('aria-pressed', 'false');
      button.title = 'Show every ' + kind;
      button.append(el('span', '', kind), el('span', 'count', String(counts[kind])));
      return button;
    });
    say(summary, plural(total, 'value', 'values') + ' replaced, ' + plural(kinds.length, 'kind', 'kinds'));
    fill(findings, chips);
  }

  /** The settings a check is asked with, besides the text. */
  const settings = () => names.value + '\u0000' + model.value;

  /** Start a check or a file read: it takes a number, and holds Send until it lands. */
  function beginCheck() {
    checkSeq += 1;
    checking = true;
    sendButton.disabled = true;
    return checkSeq;
  }

  /** The latest check or read is over, however it ended. */
  function endCheck(seq) {
    if (seq !== checkSeq) return;
    checking = false;
    checkButton.disabled = false;
    restoreSend();
  }

  function checkFailed() {
    trip('error', 1);
    checkButton.classList.remove('is-quiet');
  }

  /** Ask what the provider would see, and hold the session it opens. */
  async function check() {
    const text = input.value;
    if (text.trim() === '') { say(inputStatus, 'nothing to check yet'); return; }

    const seq = beginCheck();
    const asked = text + '\u0000' + settings();
    checkButton.disabled = true;
    say(inputStatus, 'checking…');
    const started = now();

    try {
      const response = await fetch('/__playground/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model: model.value, names: nameList() }),
      });
      if (seq !== checkSeq) return;

      if (!response.ok) {
        checkFailed();
        fail(inputStatus, 'could not read that: ' + response.status);
        return;
      }

      const body = await response.json();
      if (seq !== checkSeq) return;
      // Typed into while it was out: this answer is for text no longer there.
      if (input.value + '\u0000' + settings() !== asked) {
        say(inputStatus, 'changed while checking; check again', 'warn');
        return;
      }
      accept(body, text);
      say(inputStatus, 'checked in ' + duration(now() - started));
    } catch (error) {
      if (seq !== checkSeq) return;
      // Without this the status line keeps saying "checking…" and the failure
      // reads as work still in progress — for as long as the operator waits.
      checkFailed();
      fail(inputStatus, 'the check did not go out — is the trial still running?');
    } finally {
      endCheck(seq);
    }
  }

  /**
   * The right side no longer describes what is on the left, or no longer can
   * be sent. Sending it anyway would send something the operator is not
   * looking at. Returns whether this changed anything.
   */
  function goStale(message, tone) {
    if (sessionId === null || stale) return false;
    stale = true;
    for (const pane of [paneOut, paneRaw, paneHydrated]) pane.classList.add('is-stale');
    restoreSend();
    checkButton.classList.remove('is-quiet');
    hint.hidden = true;
    link(null);
    say(sendStatus, message, tone);
    trip('idle');
    return true;
  }

  /** Any edit after a check: the text, the names, or the model it was checked for. */
  function edited(message, status) {
    if (goStale(message, 'warn')) say(inputStatus, status);
  }

  function pickSample(chosen) {
    for (const button of sampleButtons) button.setAttribute('aria-pressed', String(button === chosen));
  }

  /** The send line and the strip belong to the stale warning while it stands. */
  function sayReply(text, tone) {
    if (!stale) say(sendStatus, text, tone);
  }

  function tripReply(state, failing) {
    if (!stale) trip(state, failing);
  }

  /** Stop listening to the reply in flight, if there is one. */
  function abandonReply() {
    replyGen += 1;
    const reader = replyReader;
    replyReader = null;
    if (reader === null || typeof reader.cancel !== 'function') return;
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch (error) {
      // Already closed: nothing left to stop.
    }
  }

  /** Bring the reply into view when Send sits at the bottom of a short screen. */
  function revealReply() {
    if (typeof paneRaw.scrollIntoView !== 'function' || typeof paneRaw.getBoundingClientRect !== 'function') return;
    if (typeof innerHeight !== 'number' || paneRaw.getBoundingClientRect().top <= innerHeight - 160) return;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    paneRaw.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }

  // ---- Sending -------------------------------------------------------------

  /** Send it, and fill the bottom row from the two channels of one stream. */
  async function send() {
    if (sessionId === null || stale || checking || reply.streaming) return;

    abandonReply();
    const gen = replyGen;
    sendButton.disabled = true;
    copyHydrated.disabled = true;
    say(sendStatus, 'waiting for the first token…');
    reply = emptyReply();
    reply.streaming = true;
    reply.started = now();
    renderReply();
    trip('sending');
    revealReply();

    let response;
    try {
      response = await fetch('/__playground/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
    } catch (error) {
      if (gen !== replyGen) return;
      stopReply(1);
      failReply('the request did not go out');
      return;
    }
    if (gen !== replyGen) return;

    if (!response.ok || response.body === null) {
      const detail = typeof response.json === 'function' ? await response.json().catch(() => null) : null;
      if (gen !== replyGen) return;
      const error = detail && detail.error;
      if (error && error.type === 'no_such_session') {
        // Sessions time out and make way for newer ones. Sending again cannot
        // help; only a fresh check can.
        stopReply(1);
        const message = typeof error.message === 'string' ? error.message : 'that preview has expired; check the text again';
        goStale(message, 'error');
        sessionId = null;
        restoreSend();
        trip('error', 1);
        return;
      }
      stopReply(2);
      failReply('the provider refused: ' + response.status);
      return;
    }

    const reader = response.body.getReader();
    replyReader = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (gen !== replyGen) return;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          apply(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (gen !== replyGen) return;
      // A stream that dies mid-answer must not leave the status on "waiting
      // for the first token…"; whatever arrived stays in the panes.
      stopReply(2);
      failReply('the answer stopped partway');
      return;
    }

    finish();
  }

  /** A failed send, unless an edit since has made the stale warning the news. */
  function failReply(message) {
    if (stale) restoreSend();
    else fail(sendStatus, message, sendButton);
  }

  /** One SSE block: an event name and its data. */
  function apply(block) {
    let name = '';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }

    if (name === '' || data === '') return;
    if (name === 'done') { finish(); return; }
    if (name === 'error') {
      stopReply(2);
      sayReply('the provider returned an error', 'error');
      return;
    }

    let parsed;
    try { parsed = JSON.parse(data); } catch (error) { return; }
    const delta = parsed && typeof parsed.delta === 'string' ? parsed.delta : '';
    if (delta === '') return;

    if (name === 'raw') {
      if (reply.first === null) {
        reply.first = now();
        tripReply('streaming');
        sayReply('streaming · first token ' + duration(reply.first - reply.started));
      }
      reply.raw += delta;
    }
    if (name === 'hydrated') reply.hydrated += delta;
    schedule();
  }

  /** A failed send: keep what arrived, stop the caret, mark where it broke. */
  function stopReply(failing) {
    reply.streaming = false;
    replyReader = null;
    renderReply();
    tripReply('error', failing);
    restoreSend();
  }

  function finish() {
    if (!reply.streaming) return;
    reply.streaming = false;
    reply.ended = now();
    replyReader = null;
    renderReply();
    tripReply('done');
    restoreSend();
    copyHydrated.disabled = reply.hydrated === '';
    if (stale) return;

    const parts = [];
    if (reply.first !== null) parts.push('first token ' + duration(reply.first - reply.started));
    parts.push('done in ' + duration(reply.ended - reply.started));
    parts.push(plural(reply.restored, 'value', 'values') + ' restored');
    say(sendStatus, parts.join(' · '));
  }

  /** Re-render the reply at most once a frame, however fast the chunks arrive. */
  function schedule() {
    if (typeof requestAnimationFrame !== 'function') { renderReply(); return; }
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      renderReply();
    });
  }

  /** The tail of the raw reply that is a placeholder still arriving, or ''. */
  function partialTail(text) {
    const match = PARTIAL.exec(text);
    return match !== null && match[0].length <= PARTIAL_MAX ? match[0] : '';
  }

  /**
   * The hydrated text, with each restored value marked and linked to its
   * placeholder.
   *
   * Rebuilt from the raw reply and the page's own map, then checked against
   * what the server actually restored: the text shown is always the server's,
   * and when the two disagree it is shown unmarked rather than guessed at.
   */
  function restoredNodes(rawText, shown) {
    const pieces = [];
    let cursor = 0;
    for (const match of rawText.matchAll(PLACEHOLDER)) {
      const value = checked && checked.values.get(match[0]);
      if (value === undefined) continue;
      pieces.push({ text: rawText.slice(cursor, match.index) });
      pieces.push({ text: value, token: match[0] });
      cursor = match.index + match[0].length;
    }
    pieces.push({ text: rawText.slice(cursor) });

    const nodes = [];
    let at = 0;
    let count = 0;
    for (const piece of pieces) {
      if (at >= shown.length) break;
      const part = piece.text.slice(0, shown.length - at);
      if (part === '') continue;
      if (shown.slice(at, at + part.length) !== part) return { nodes: [shown], count: 0 };
      if (piece.token) {
        nodes.push(valueNode(part, piece.token, checked.kinds.get(piece.token)));
        count += 1;
      } else {
        nodes.push(part);
      }
      at += part.length;
    }
    if (at !== shown.length) return { nodes: [shown], count: 0 };
    return { nodes, count };
  }

  function renderReply() {
    const tail = reply.streaming ? partialTail(reply.raw) : '';

    if (reply.raw === '') {
      raw.replaceChildren(emptyLine(reply.streaming
        ? 'Waiting for the first token…'
        : 'The reply streams in here as it arrives, placeholders and all.'));
    } else {
      const nodes = tokenNodes(reply.raw.slice(0, reply.raw.length - tail.length), false);
      if (tail !== '') nodes.push(el('span', 'chip is-pending', tail));
      fill(raw, nodes);
    }

    if (reply.hydrated === '' && !reply.streaming) {
      hydrated.replaceChildren(emptyLine('The same reply, with your values put back on this machine.'));
      reply.restored = 0;
    } else {
      const { nodes, count } = restoredNodes(reply.raw, reply.hydrated);
      reply.restored = count;
      if (reply.streaming) nodes.push(el('span', 'caret'));
      fill(hydrated, nodes);
    }

    holding.hidden = tail === '';
    holding.title = tail === '' ? '' : 'A placeholder cut across two chunks is held back until it is whole.';
    if (tail !== '') holding.replaceChildren('holding back', el('span', 'chip is-pending', tail));
  }

  // ---- Linked highlight ----------------------------------------------------

  /**
   * Every element carrying the same token lights up together, in all four
   * panes: the value, the chip the provider received, the chip it sent back,
   * and the value restored from it.
   */
  function link(token) {
    if (token === linkedToken) return;
    for (const node of document.querySelectorAll('.is-linked')) node.classList.remove('is-linked');
    linkedToken = token;
    if (token === null) return;
    for (const node of document.querySelectorAll('[data-token="' + token + '"]')) {
      node.classList.add('is-linked');
    }
  }

  function showKind() {
    const kind = hoverKind || pinnedKind;
    for (const node of document.querySelectorAll('.is-kind')) node.classList.remove('is-kind');
    if (kind === null || !/^[A-Za-z0-9_-]+$/.test(kind)) return;
    for (const node of document.querySelectorAll('[data-kind="' + kind + '"]')) {
      node.classList.add('is-kind');
    }
  }

  /** The nearest element, from node upwards, with this key in its dataset. */
  function datasetUp(node, key) {
    for (let at = node; at && at.dataset !== undefined; at = at.parentNode) {
      if (at.dataset[key]) return at;
    }
    return null;
  }

  const tokenAt = (node) => {
    const found = datasetUp(node, 'token');
    return found ? found.dataset.token : null;
  };

  const legendAt = (node) => {
    const found = datasetUp(node, 'legend');
    return found ? found.dataset.legend : null;
  };

  function hovered(event) {
    // A stale right side no longer belongs to the text on the left.
    link(stale ? null : tokenAt(event.target));
    const kind = legendAt(event.target);
    if (kind !== hoverKind) { hoverKind = kind; showKind(); }
  }

  function pin(event) {
    const kind = legendAt(event.target);
    if (kind === null) return;
    pinnedKind = pinnedKind === kind ? null : kind;
    for (const node of document.querySelectorAll('[data-legend]')) {
      node.setAttribute('aria-pressed', String(node.dataset.legend === pinnedKind));
    }
    showKind();
  }

  // ---- Files ---------------------------------------------------------------

  /** A dropped document goes through the same door as pasted text. */
  async function dropped(event) {
    event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    paneInput.classList.remove('is-dropping');

    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (!file) return;
    await open(file);
  }

  async function open(file) {
    pickSample(null);
    say(inputStatus, 'reading ' + file.name + '…');
    const seq = beginCheck();

    try {
      await read(file, seq);
    } catch (error) {
      if (seq !== checkSeq) return;
      // The status line is the only thing the operator can see. Leaving it on
      // "reading…" turns any failure into an unbounded wait.
      checkFailed();
      fail(inputStatus, 'that file could not be read');
    } finally {
      endCheck(seq);
    }
  }

  /** The part that can fail: bytes off disk, then the preview round trip. */
  async function read(file, seq) {
    const asked = settings();

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
        names: nameList(),
      }),
    });
    if (seq !== checkSeq) return;

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      if (seq !== checkSeq) return;
      const message = detail && detail.error && detail.error.message;
      checkFailed();
      fail(inputStatus, message || 'that file could not be read');
      return;
    }

    const parsed = await response.json();
    if (seq !== checkSeq) return;
    if (settings() !== asked) {
      say(inputStatus, 'the names or the model changed while reading; open the file again', 'warn');
      return;
    }
    const text = parsed.extracted || '';
    input.value = text;
    accept(parsed, text);
    say(inputStatus, file.name + ' — read as text, the file itself stays here');
  }

  // ---- Copy ----------------------------------------------------------------

  const clipboard =
    typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard
      : null;

  function copier(button, text) {
    if (clipboard === null) { button.hidden = true; return; }
    const flash = (label) => {
      button.textContent = label;
      copyStatus.textContent = label;
      setTimeout(() => { button.textContent = 'Copy'; }, 1400);
    };
    button.addEventListener('click', () => {
      clipboard.writeText(text()).then(() => flash('Copied'), () => flash('Not copied'));
    });
  }

  // ---- Wiring --------------------------------------------------------------

  // Every path above reports its own failure. This is the floor under them:
  // a rejection that escapes one — including from code added to this page
  // later — says so instead of leaving the last status up forever.
  addEventListener('unhandledrejection', (event) => {
    fail(inputStatus, 'something went wrong on this page; the trial is still running');
    checkButton.disabled = false;
  });

  for (const sample of SAMPLES) {
    const button = el('button', 'sample', sample.label);
    button.type = 'button';
    button.title = sample.blurb;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      input.value = sample.text;
      names.value = sample.names.join(', ');
      pickSample(button);
      void check();
    });
    sampleButtons.push(button);
    samples.append(button);
  }
  samplesRow.hidden = SAMPLES.length === 0;

  if (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) {
    $('check-key').textContent = '⌘↵';
  }

  copier(copySanitised, () => (checked ? checked.sanitised : ''));
  copier(copyHydrated, () => reply.hydrated);

  checkButton.addEventListener('click', () => { void check(); });
  sendButton.addEventListener('click', () => { void send(); });
  editButton.addEventListener('click', edit);
  annotated.addEventListener('click', () => {
    // Selecting text to copy it is not asking to edit it.
    if (typeof getSelection === 'function' && String(getSelection()) !== '') return;
    edit();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void check();
    }
  });
  names.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void check();
    }
  });
  const textEdited = () => {
    pickSample(null);
    edited('Text changed. Check again before sending.', 'edited since the last check');
  };
  input.addEventListener('input', textEdited);
  names.addEventListener('input', textEdited);
  model.addEventListener('input', () => {
    edited('Model changed. Check again before sending.', 'model changed since the last check');
  });

  openButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) void open(file);
  });

  for (const target of [input, paneInput]) {
    target.addEventListener('dragover', (event) => {
      event.preventDefault();
      paneInput.classList.add('is-dropping');
    });
    target.addEventListener('drop', (event) => { void dropped(event); });
  }
  paneInput.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget || !paneInput.contains(event.relatedTarget)) {
      paneInput.classList.remove('is-dropping');
    }
  });

  document.addEventListener('mouseover', hovered);
  document.addEventListener('focusin', hovered);
  document.addEventListener('focusout', () => { link(null); if (hoverKind !== null) { hoverKind = null; showKind(); } });
  findings.addEventListener('click', pin);
  sanitised.addEventListener('keydown', walkChips);
  sanitised.addEventListener('focusin', (event) => rove(event.target));

  // Side by side, the two capped bodies scroll as one, so the line under the
  // eye on the left still faces its sanitised line on the right. "led" marks
  // the body whose scroll moved the other, so the echo does not move it back.
  let led = null;
  const follow = (from, to) => {
    from.addEventListener('scroll', () => {
      markFold(from);
      if (led === to) { led = null; return; }
      const before = to.scrollTop;
      to.scrollTop = from.scrollTop;
      if (to.scrollTop !== before) led = from;
    });
  };
  follow(bodyInput, bodyOut);
  follow(bodyOut, bodyInput);
  addEventListener('resize', () => { markFold(bodyInput); markFold(bodyOut); });

  trip('idle');
})();
`;
