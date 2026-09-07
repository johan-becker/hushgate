/**
 * A two-pane window onto the gate.
 *
 * Left: what you type. Right: the same text after hushgate has run over it —
 * exactly the bytes that would leave the machine.
 *
 * There is no model here and no upstream. Nothing is forwarded anywhere, so
 * nothing can answer you with something it made up. The right pane is the
 * output of `Session.redact`, which is the same call the proxy makes on the
 * request path, built from the same config file:
 *
 *     node examples/chat.mjs
 *     open http://127.0.0.1:8080
 *
 * Config comes from examples/demo.config.json unless HUSHGATE_CONFIG says
 * otherwise, so the dictionary and custom rules you see are the ones on disk.
 */
import { createServer } from 'node:http';
import { loadConfig, redactionOptions, Session } from '../dist/index.js';

const PORT = Number(process.env.PORT ?? 8080);
const CONFIG = process.env.HUSHGATE_CONFIG ?? 'examples/demo.config.json';

const { config, source } = loadConfig({ path: CONFIG });
const profile = redactionOptions(config);

/** Any placeholder token the gate writes, including the `hash` policy's form. */
const PLACEHOLDER = /\[[A-Z0-9_]+(?::[0-9a-f]+)?\]/g;

/** The configured policy for a kind, falling back to the default. */
function policyFor(kind) {
  return config.redaction.policies[kind] ?? config.redaction.defaultPolicy;
}

/**
 * In the proxy, a `block` kind aborts the whole request — correct there,
 * useless here: one API key in the box and the pane goes blank, so you cannot
 * see what else was found. This window swaps `block` for `pseudonymize` and
 * marks those findings `(blocked)` in place instead, which shows both what was
 * detected and what the policy would have done to the request.
 */
const testProfile = {
  ...profile,
  defaultPolicy: profile.defaultPolicy === 'block' ? 'pseudonymize' : profile.defaultPolicy,
  policies: Object.fromEntries(
    Object.entries(profile.policies ?? {}).map(([kind, policy]) => [
      kind,
      policy === 'block' ? 'pseudonymize' : policy,
    ]),
  ),
};

/**
 * A fresh session per keystroke.
 *
 * Placeholder numbering is per-session and monotonic, so reusing one session
 * across every request would walk [EMAIL_1] up to [EMAIL_200] as you type and
 * make the right pane look like it was doing something it is not.
 */
function runGate(text) {
  const { text: redacted, findings } = new Session(testProfile).redact(text);

  // Mark by placeholder rather than by scanning for the value: the value is
  // already gone from the output, and the placeholder is the token that stands
  // in its place. One pass over the text, so nothing is marked twice.
  const marked = new Set(
    findings.filter((f) => policyFor(f.kind) === 'block').map((f) => f.placeholder),
  );
  const text_ =
    marked.size === 0
      ? redacted
      : redacted.replace(PLACEHOLDER, (token) => (marked.has(token) ? `${token} (blocked)` : token));

  return { text: text_ };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/gate') {
    try {
      const parsed = JSON.parse(await readBody(req));
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      json(res, 200, runGate(text));
    } catch (error) {
      json(res, 200, { error: String(error?.message ?? error) });
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`hushgate chat window   http://127.0.0.1:${PORT}`);
  console.log(`config                 ${source.path ?? 'defaults (no file)'}`);
  console.log('no model, no upstream — the right pane is the gate output');
});

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hushgate</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --panel: #fff; --ink: #1a1a1a; --muted: #6b6b6b;
    --line: #e3e3e0; --accent: #b45309; --accent-bg: #fef3c7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a1c; --panel: #232326; --ink: #e8e8e6; --muted: #9a9a97;
      --line: #34343a; --accent: #fbbf24; --accent-bg: #422006;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    height: 100vh; display: flex; flex-direction: column;
  }
  header {
    padding: 14px 20px; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: 12px; flex: none;
  }
  header h1 { margin: 0; font-size: 15px; font-weight: 620; letter-spacing: -0.01em; }
  header span { color: var(--muted); font-size: 12.5px; }
  main {
    flex: 1; display: grid; grid-template-columns: 1fr 1fr;
    gap: 1px; background: var(--line); min-height: 0;
  }
  @media (max-width: 720px) { main { grid-template-columns: 1fr; } }
  section { background: var(--panel); display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .label {
    padding: 9px 16px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--line); flex: none;
  }
  textarea, .out {
    flex: 1; margin: 0; padding: 16px; border: 0; outline: 0; resize: none;
    background: transparent; color: var(--ink); min-height: 0;
    font: 13.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; word-break: break-word; overflow-y: auto;
  }
  textarea::placeholder { color: var(--muted); }
  mark { background: var(--accent-bg); color: var(--accent); border-radius: 3px; padding: 0 2px; font-weight: 600; }
  .blocked { color: #dc2626; font-weight: 700; }
</style>
</head>
<body>
  <header>
    <h1>hushgate</h1>
    <span>your text on the left &middot; what leaves the machine on the right</span>
  </header>
  <main>
    <section>
      <div class="label">You type</div>
      <textarea id="in" spellcheck="false" autofocus
        placeholder="Anna Schmidt from Projekt Nordlicht, EMP-12345, anna@nordlicht.example, IBAN DE89 3704 0044 0532 0130 00"></textarea>
    </section>
    <section>
      <div class="label">After the gate</div>
      <div class="out" id="out"></div>
    </section>
  </main>

<script>
const inEl = document.getElementById('in');
const outEl = document.getElementById('out');

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function render(data) {
  if (data.error) {
    outEl.innerHTML = '<span class="blocked">' + esc(data.error) + '</span>';
    return;
  }
  // Highlight the placeholders the gate wrote in, so the swap is visible, and
  // the (blocked) markers that follow the ones policy would have refused.
  outEl.innerHTML = esc(data.text)
    .replace(/\\[[A-Z0-9_]+(?::[0-9a-f]+)?\\]/g, (m) => '<mark>' + m + '</mark>')
    .replace(/\\(blocked\\)/g, '<span class="blocked">(blocked)</span>');
}

let timer, seq = 0;
async function send() {
  const mine = ++seq;
  const text = inEl.value;
  if (text === '') {
    outEl.textContent = '';
    return;
  }
  const res = await fetch('/api/gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const data = await res.json();
  if (mine === seq) render(data);   // ignore a reply overtaken by a newer keystroke
}

inEl.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(send, 120);
});
</script>
</body>
</html>`;
