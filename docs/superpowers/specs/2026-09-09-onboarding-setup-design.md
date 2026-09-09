# Onboarding: one interactive command

Status: proposed, 2026-09-09.

## The gap this closes

Setting hushgate up for a company was walked through end to end on 2026-09-09,
in a clean directory, as a first-time operator would. It works, and it takes
too long to find that out.

`init` writes a commented file and prints four instructions. `doctor` then
exits 1 by design, because `residency.allow` is empty. Closing that warning
means hand-writing an endpoint URL, a jurisdiction and a legal basis into JSON
— `residency.allow[].legalBasis` is required on purpose (`src/config.ts:696`:
*"an allowlist without reasons is a wish list"*). Nothing in the tool writes
that entry for you, and `residency --registry` prints hostnames, not URLs.

So the first ten minutes are spent editing JSON, and the moment that actually
sells the product — seeing what the provider would have received — comes last,
if at all. This design inverts that order.

A second measured fact shapes the trial branch. On a realistic German business
letter, the out-of-the-box configuration found 4 of 9 identifiers: e-mail,
phone, IBAN, VAT-ID. It missed both people, the customer company, the project
codename and the internal personnel number, because `NAME` and `TERM` come only
from `redaction.dictionary`. Anything that shows a prospect what hushgate does
must show that too, in the same breath, or it teaches something false.

## What it does

One command, two branches, chosen by the first question.

    $ npx hushgate setup

      What would you like to do?
        1 Try it     — see in a minute what the provider would receive
        2 Set it up  — write a configuration for real use

**Trial** asks two questions — which provider, and the API key — then starts a
loopback server and opens `http://127.0.0.1:8787/__playground` in the browser.
No configuration file is written or read. The trial runs on `defaultConfig()`
with one field changed: the chosen entry's `baseUrl` becomes the upstream for
the protocol its `api` field names, and the page calls the matching route. If
8787 is taken, the next free port is used and printed.

**Setup** asks the same provider question, then walks the rest of the
configuration with every remaining question optional and marked as such. It
writes `hushgate.config.json`, runs the existing doctor checks inline, and
offers the trial page at the end.

Only the provider question is mandatory in either branch.

## Language

The wizard speaks English, like every other command, the README and the config
comments. The product's first buyers are German, and the vocabulary it asks
about — Article 30, legal basis, data protection officer — is German law in
English words; that is what the rest of the tool already does. A German build
is a later decision, not a mixed-language tool today.

## The trial page

Four boxes on one page at `http://127.0.0.1:8787/__playground`, top to bottom:

1. **Your text** — a textarea, or a PDF dropped onto it.
2. **What the provider sees** — the pseudonymised text, with the findings listed
   by kind, a model field, and a **Send** button. The model is prefilled from
   the chosen registry entry's `trialModel` and stays editable, because a
   default model name ages faster than this document.
3. **Reply, as it arrives** — the provider's reply, placeholders intact.
4. **Reply, rehydrated** — the same reply with the real values put back.

Boxes 3 and 4 stream at once from a single SSE response carrying two event
kinds:

    event: raw       data: {"delta":"I will write to [EMAIL_1]"}
    event: hydrated  data: {"delta":"I will write to k.vogelsang@nordwerk.de"}

`raw` is the upstream delta unchanged. `hydrated` comes from the existing
`SseRehydrator`, which withholds characters when a placeholder straddles a
chunk boundary (`holdBackFrom`, `src/stream/rehydrate.ts:77`). Box 4 therefore
lags box 3 by a few characters at times. That lag is left visible rather than
smoothed away: it is the mechanism doing its work.

Below box 2, one line of standing text, shown whenever the dictionary is empty
— which in the trial it always is:

> Personal names come only from your dictionary. Add yours under
> `redaction.dictionary.names`.

The condition is the configuration, not the text. Nothing inspects the input
for name-shaped candidates: no guessing, no false confidence in either
direction. The sentence sits where the absence of a `NAME` finding would
otherwise be misread as coverage.

## Why a preview route exists

The proxy pseudonymises as part of forwarding. The trial has to show the
sanitised text *before* anything is sent, and then send exactly that.

So `POST /__playground/preview` runs a `Session` (`src/redact/session.ts`) over
the input and keeps it in memory against a session id. `POST /__playground/send`
takes that id and reuses the same `Session`, so the placeholders shown in box 2
are literally the ones the model receives, and box 4 rehydrates from the same
mapping. One `Session`, four boxes, no second redaction path.

## Architecture

New module `src/playground/`:

| File | Purpose |
|---|---|
| `page.ts` | the HTML, CSS and JS as string constants; no framework, no build step, no CDN |
| `session.ts` | in-memory trial sessions: id → `Session` + timestamp, capped at 16, 30-minute TTL |
| `routes.ts` | the routes below, mounted into the existing server dispatch |
| `index.ts` | the module's surface |

Routes, under a prefix that cannot collide with a provider path:

    GET  /__playground                 the page
    GET  /__playground/app.css|app.js  served separately so the CSP stays strict
    POST /__playground/preview         text or PDF in → sanitised + findings
    POST /__playground/send            SSE, two channels

New CLI pieces:

| File | Purpose |
|---|---|
| `src/cli/prompt.ts` | `Prompter` over `node:readline/promises`: `text`, `choose`, `confirm` |
| `src/cli/commands/setup.ts` | the question flow and both branches; no checking logic of its own |
| `src/cli/template.ts` | `renderConfig(answers)`, the commented starter with named slots |

`Cli` (`src/cli/cli.ts`) gains `readonly prompter?: Prompter`. `processCli()`
builds a real one only when `process.stdin.isTTY`; tests inject a scripted one.
The field is optional, so every existing `Cli` literal in the test suite
compiles unchanged.

`init` keeps its behaviour exactly, by calling `renderConfig` with no answers.
A test pins its output against the current file so the two callers cannot
drift.

`src/residency/registry.ts` gains three optional fields per entry: `baseUrl`
(the registry stores hostnames and wildcards, the wizard needs a URL), `api:
'openai' | 'anthropic'`, and a `trialModel` the page prefills. The proxy speaks
exactly two protocols (`src/proxy/routes.ts`), so entries without `api` —
Bedrock, and anything with a wildcard host — stay listed by
`residency --registry` but are not offered as upstreams. The offered list is
Mistral (FR), Aleph Alpha (DE), OpenAI (US), Anthropic (US), Google Gemini
(US).

PDF in the trial reuses the existing attachment extractor. If no extractor is
on `PATH`, the drop zone says so instead of failing quietly.

## Security

1. **The playground is mounted only by `setup`.** A production `serve` must not
   carry a route that turns placeholders back into personal data. There is no
   flag that mounts it in `serve`.
2. **Loopback only.** A trial started against a non-loopback host is refused,
   not warned about.
3. **The page cannot reach the network.** `default-src 'none'`, `script-src
   'self'`, `style-src 'self'`, `connect-src 'self'`, `Cache-Control:
   no-store`. It works with the cable pulled, like the rest of the product.
4. **The API key stays in the CLI process.** It is typed at the terminal, never
   written to `hushgate.config.json`, never sent to the page, never recorded in
   the audit trail. The page sends a session id; the process adds the
   `Authorization` header. Ctrl-C and it is gone.
5. **Sessions die with the process**, and before that at 16 entries or 30
   minutes, whichever comes first.

## Skipping the legal basis

`residency.allow[].legalBasis` stays required by the config parser. The wizard
does not ask for it up front, because it is the one answer an operator does not
have at the keyboard. It writes the file without an allowlist, and the inline
doctor run then says so:

    warn  no residency allowlist is configured, so any upstream is permitted
          → list the endpoints you have assessed in residency.allow, each with
            its legal basis

The operator reaches a working proxy, and the open question stays visible
instead of blocking the path or disappearing.

## Distribution

**0.1.0 is published**, on 2026-09-09, and verified from the registry with
`npx hushgate@0.1.0 init && doctor` in an empty directory. The README's
quickstart is npm-first, and the clone is now described as the path for working
on hushgate itself.

Getting there surfaced two packaging faults that would otherwise have shipped,
both now guarded in `scripts/verify-package.mjs`: a stale `dist/` carrying a
second source tree and the compiled test suite, and a `bin` value whose leading
`./` made npm strip the entry from the registry manifest — which would have
left the package with no `hushgate` command at all.

**0.2.0 ships this design**, so that `npx hushgate setup` is real and the
README's opening becomes one line. Publishing is the maintainer's step; the
release is prepared and verified here, then handed over.

## Testing

Along the existing in-process CLI patterns (`test/cli.doctor.test.ts`):

- the wizard drives to completion from a scripted `Prompter`, in both branches;
- `setup` without a TTY exits with the message pointing at `init`;
- `renderConfig` with no answers equals today's `init` output, byte for byte;
- `renderConfig` with answers produces a file `loadConfig` accepts;
- the page and its assets are served with the documented CSP headers;
- `preview` pseudonymises and reports findings by kind;
- `send` streams both channels, and a placeholder deliberately split across a
  chunk boundary arrives intact in the `hydrated` channel;
- `serve` does not mount any `/__playground` route;
- a trial against a non-loopback host is refused.

## Out of scope

Found during the same walkthrough, worth fixing, deliberately not part of this
design:

- ~~`redaction.policies` accepts any UPPER_SNAKE_CASE key without checking it
  names a real kind (`src/config.ts:1167`), so a typo silently enforces
  nothing. `residency` already rejects unknown keys for exactly this reason
  (`src/config.ts:629`); the fix is to copy that.~~ Fixed separately, after
  this design shipped — see `assertPolicyKinds` in `src/config.ts`.
- `$schema` is accepted and ignored (`src/config.ts:298`) but no schema file
  ships, so editors cannot complete or validate the config.
- `keys new` prints a JSON snippet to paste by hand; no `--write`.
- Dictionary onboarding — importing names from an HR export, or proposing
  candidates from a sample document — stays manual by decision.
