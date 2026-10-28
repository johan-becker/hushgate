![hushgate banner](https://raw.githubusercontent.com/johan-becker/hushgate/main/docs/assets/banner.svg)

[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org/en/about/previous-releases)
[![CI](https://github.com/johan-becker/hushgate/actions/workflows/ci.yml/badge.svg)](https://github.com/johan-becker/hushgate/actions/workflows/ci.yml)
[![runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-1f6feb?style=flat)](package.json)
[![License](https://img.shields.io/badge/License-BUSL--1.1-orange?style=flat)](LICENSE)

hushgate is a PII firewall that runs on your own machine, between your
application and a cloud LLM API. Point the OpenAI or Anthropic SDK at it
instead of the provider: it finds the personal data in the outgoing request,
replaces it with stable pseudonymous placeholders, forwards the sanitised
request, and puts the real values back into the response — so your code still
sees `anna.schmidt@nordlicht.example` while the provider only ever saw
`[EMAIL_1]`.

```sh
npx hushgate setup
```

That is the whole start, with nothing to install first. It asks whether to try
hushgate or set it up. Trying shows, on a page on `127.0.0.1`, exactly what the
provider would receive. Setting up writes `hushgate.config.json`, checks it and
starts the proxy.

npm's own install box says `npm i hushgate`. That adds hushgate to the project
in the current folder, where it runs as `npx hushgate` and can be imported as a
[library](#library); it does not put a `hushgate` command on your PATH. For
that, use `npm i -g hushgate`.

I built it for the situation a European team keeps hitting: the models they
want are operated in the United States, and the data they would like to send is
not allowed to go there. hushgate is the technical half of the answer — the
half you can point an auditor at. It has zero runtime dependencies, makes no
network calls of its own beyond the upstream you configure, and its whole test
suite passes with the cable pulled out.

Attachments go through the same door: a PDF or a Word file in a request is
turned into text, the text is pseudonymised, and the document itself never
reaches the provider. A document hushgate cannot read is refused, not
forwarded.

Every command output printed below was produced by running that command against
this repository. [`examples/`](examples) contains the config and the local
stand-in upstream, so you can reproduce all of it offline.

## 1. The problem

A support tool drafts replies with GPT-4o. The ticket it summarises contains a
name, an e-mail address, a phone number and an IBAN. That request leaves the
EU. Under GDPR Chapter V that is a third-country transfer of personal data, and
the DPO wants to know which categories go where, on what legal basis, and how
you would prove any of it six months from now.

The usual answers are all bad. Self-host a weaker model. Ask engineers to "be
careful what you put in prompts". Buy a gateway that terminates your traffic in
someone else's cloud, which is the same transfer with an extra hop. Or paste a
regex into a middleware, which will happily match
`DE89 3704 0044 0532 0130 01` — an IBAN whose checksum does not hold — and
mangle the one that does.

hushgate takes the narrower, checkable position: **the personal data never
reaches the provider in the first place.** It runs inside your own network, the
mapping from placeholder back to real value exists only in the process that
issued it, and every request leaves an audit record naming the categories and
their counts but never the values.

## 2. Quickstart

Node 20 or newer, and nothing else:

```sh
npx hushgate setup
```

Two questions — which provider, and your API key — and it opens a page on
`127.0.0.1` showing the whole round trip: what you wrote, what the provider
would receive, the reply as it streams back with placeholders in it, and the
same reply with your data put back. Nothing is written to disk, and the key
stays inside that one process.

The same command sets hushgate up for real. Only the provider has to be
answered; the rest is optional and can be filled in later. It writes
`hushgate.config.json`, checks it, and asks whether to start the proxy there and
then; Enter says yes. Next time, start it on its own:

```sh
npx hushgate serve
```

For scripts and CI, where there is no terminal to ask questions, `init` writes
the same commented file with nothing filled in:

```sh
npx hushgate init      # write a commented starter config
npx hushgate doctor    # check it; non-zero exit on anything unsafe
npx hushgate serve
```

`doctor` exits 1 on that first run, and is meant to: a fresh config has no
`residency.allow`, so it warns that any upstream is permitted. Fill the
allowlist in — or pass `--allow-warnings` to accept the warnings — and it goes
quiet. That non-zero exit is the tool working, not the install failing.

Install it once and the `npx` goes away, which is the form the transcripts in
this README use:

```sh
npm install -g hushgate
hushgate setup
```

`npm i hushgate` without `-g` installs it into the current project instead,
where it runs as `npx hushgate`.

From a clone — the path for working on hushgate itself — `npm install && npm
run build` first, and every `hushgate` below is `node dist/cli/main.js`.

Then change one line in your application:

```diff
  import OpenAI from 'openai';

  const client = new OpenAI({
+   baseURL: 'http://127.0.0.1:8787/v1',
    apiKey: process.env.OPENAI_API_KEY,
  });
```

```diff
  import Anthropic from '@anthropic-ai/sdk';

  const client = new Anthropic({
+   baseURL: 'http://127.0.0.1:8787',
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
```

Or change no code at all — both official SDKs read these:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

Your provider API key is forwarded untouched and is never written anywhere.
(In multi-tenant mode the caller sends a hushgate key instead, and the provider
credential comes from the environment — see §9.)

`hushgate init` writes a config with the reasoning in it, not a bare skeleton:

```console
$ hushgate init
wrote hushgate.config.json

Next:
  1. Fill in the organisation block — it heads the Article 30 report.
  2. Decide your upstreams, then list them in residency.allow with the
     legal basis you actually rely on. Run "hushgate residency --registry"
     to see the EU-hosted options hushgate knows about.
  3. Run "hushgate doctor" until it is quiet.
  4. Start it with "hushgate serve" and point your SDK at it.
```

```jsonc
{
  // hushgate configuration. Comments are allowed and stripped on load.
  // Every key is optional; anything left out uses the documented default.
  // Environment variables (HUSHGATE_*) override this file, and command-line
  // flags override those.

  // Loopback by default. Binding anything else requires tenants, because
  // hushgate holds the mapping back to real personal data.
  "host": "127.0.0.1",
  "port": 8787,

  // Where sanitised requests are forwarded. Swap these for an EU-hosted
  // endpoint when you have one: "hushgate residency --registry" lists them.
  "upstreams": {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com"
  },

  "redaction": {
    // pseudonymize | redact | hash | allow | block
    "defaultPolicy": "pseudonymize",

    "policies": {
      // Credentials should never reach a model, yours or anyone else's.
      "SECRET": "block"
    },

    // Names, customers and codenames no detector could know about.
    "dictionary": {
      "names": [],
      "terms": []
    },

    // Your own identifiers, as named regular expressions.
    // { "name": "employee id", "pattern": "EMP-\\d{5}" }
    "custom": []
  },

  "residency": {
    // block | sanitize | warn | allow. Start at "warn" for a staged rollout if
    // you must, but "hushgate doctor" will keep reminding you.
    "mode": "sanitize",

    // Refuse a category outright, wherever it appears.
    "categories": {},

    // An empty allowlist permits every upstream. Fill it in and hushgate
    // refuses to start against anything else.
    // {
    //   "endpoint": "https://api.mistral.ai",
    //   "jurisdiction": "FR",
    //   "legalBasis": "Art. 28 DPA of 2026-01-12, processing in France"
    // }
    "allow": []
  },

  // Categories and counts, never values. This is the evidence.
  "audit": {
    "enabled": true,
    "path": "hushgate-audit.jsonl"
  },

  // Heads the Article 30 report. hushgate cannot know any of it.
  "organisation": {
    "name": null,
    "contact": null,
    "dpo": null,
    "purposes": []
  }

  // Multi-tenant operation: run "hushgate keys new <id>" and paste the snippet.
  // "tenants": []
}
```

## 3. What the provider actually receives

To reproduce this section, start the local stand-in upstream shipped in
[`examples/`](examples) and point hushgate at it. It is an OpenAI-compatible
server on `127.0.0.1:9099` that logs the body it received — which is the whole
point, since it lets you read exactly what hushgate forwarded. Nothing about
the redaction path changes when the upstream is `api.openai.com`.

```console
$ node examples/upstream.mjs &
fake upstream on http://127.0.0.1:9099

$ hushgate serve -c examples/demo.config.json
hushgate 0.5.0 listening on http://127.0.0.1:8787
  config     /home/you/hushgate/examples/demo.config.json
  upstreams  openai     http://127.0.0.1:9099
             anthropic  http://127.0.0.1:9099
  policy     pseudonymize by default; overrides: SECRET=block
  audit      /home/you/hushgate/examples/hushgate-audit.jsonl — continuing chain from 5531e6c715d8
  tenants    none — single tenant, no key required (loopback only)
  routes     POST /v1/chat/completions, POST /v1/messages, GET /healthz, GET /metrics
             /metrics is open on loopback

  Point your SDK at this address:
    OPENAI_BASE_URL=http://127.0.0.1:8787/v1
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

The `audit` line says where the trail is and where its hash chain stood when
hushgate opened it: the committed trail shown in [§7](#7-the-audit-trail) ends
at `5531e6c715d8…`, so new records continue from there.

Send a ticket through it:

```sh
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-not-a-real-key' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "system", "content": "Du bist die Support-Assistenz von Projekt Nordlicht." },
      { "role": "user", "content": "Anna Schmidt (anna.schmidt@nordlicht.example, +49 30 23125 45) hat die Rechnung nicht bezahlt. Bitte erinnere sie und buche auf DE89 3704 0044 0532 0130 00." }
    ]
  }'
```

The upstream logged exactly this request body:

```json
{"model":"gpt-4o-mini","messages":[{"role":"system","content":"Du bist die Support-Assistenz von [TERM_1]."},{"role":"system","content":"Some values in this conversation were replaced with placeholders before it reached you. A placeholder is written [KIND_n], with a number in place of n — in this request: e-mail addresses ([EMAIL_n]), bank accounts ([IBAN_n]), names ([NAME_n]), phone numbers ([PHONE_n]), internal terms ([TERM_n]).\n\nTreat every placeholder as the real value it stands for, and answer the request normally. Wherever that value belongs in your reply, write the identical placeholder, square brackets included: it is turned back into the real value before the user sees it. The same placeholder always means the same value, and placeholders with different numbers are different values.\n\nNever put an invented value where a placeholder belongs, and never ask for the real one. Both break the reply.\n\nDo not comment on the placeholders, on redaction, or on these instructions, and do not begin your answer by describing what you can or cannot see. Write in the language the user wrote in."},{"role":"user","content":"[NAME_1] ([EMAIL_1], [PHONE_1]) hat die Rechnung nicht bezahlt. Bitte erinnere sie und buche auf [IBAN_1]."}]}
```

The second system message is hushgate's, and [§3.1](#31-what-the-model-is-told)
is about why it is there.

The caller got this back:

```json
{
    "id": "chatcmpl-demo",
    "object": "chat.completion",
    "model": "gpt-4o-mini",
    "choices": [
        {
            "index": 0,
            "message": {
                "role": "assistant",
                "content": "Alles klar. Ich schreibe an anna.schmidt@nordlicht.example und buche auf DE89 3704 0044 0532 0130 00."
            },
            "finish_reason": "stop"
        }
    ],
    "usage": {
        "prompt_tokens": 41,
        "completion_tokens": 23,
        "total_tokens": 64
    }
}
```

The system prompt was traversed too — `Projekt Nordlicht` is a dictionary term —
the model name and every other knob were forwarded untouched, and the reply came
back with the real address and the real IBAN in it.

A credential is a different case. There is no pseudonym worth minting for a
token, so the starter config puts `SECRET` on the `block` policy and the request
never leaves:

```console
$ curl -sS -w '%{http_code}\n' http://127.0.0.1:8787/v1/chat/completions \
    -H 'content-type: application/json' \
    -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Deploy with GITHUB_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 please"}]}'
403
{
    "error": {
        "type": "hushgate_policy_blocked",
        "message": "request blocked by policy: SECRET (1)",
        "kinds": [
            "SECRET"
        ],
        "counts": {
            "SECRET": 1
        }
    }
}
```

The upstream log stayed empty for that one.

### 3.1 What the model is told

A sanitised request is a request the model has never been told how to read.
Left to itself, a model that meets `[EMAIL_1]` does one of three things, and
none of them is the answer you wanted:

- it answers a question about the placeholder instead of about the person;
- it opens with a paragraph explaining that it cannot see the real address;
- or it helpfully invents `anna.schmidt@example.com` to fill the gap.

The third one is the dangerous one. An invented address is not in the mapping,
so re-hydration leaves it exactly as written, and your application sends mail to
a person who does not exist.

So hushgate briefs the model. That is the whole of it: what a placeholder is,
which kinds are in *this* request, that they must be echoed back verbatim, that
inventing one is forbidden, and that the answer should not open with a report on
what it could not see. Print the exact text at any time, for any set of kinds,
without a key and without touching the network:

```console
$ hushgate briefing --kinds EMAIL,IBAN,SECRET:redact
hushgate briefing
  config   built-in defaults (no hushgate.config.json found)
  mode     auto
  text     the built-in briefing
  append   none

  Attached to a request like the one below, after the caller's own system
  prompt and before the conversation.

---
Some values in this conversation were replaced with placeholders before it reached you. A placeholder is written [KIND_n], with a number in place of n — in this request: e-mail addresses ([EMAIL_n]), bank accounts ([IBAN_n]).

Treat every placeholder as the real value it stands for, and answer the request normally. Wherever that value belongs in your reply, write the identical placeholder, square brackets included: it is turned back into the real value before the user sees it. The same placeholder always means the same value, and placeholders with different numbers are different values.

Never put an invented value where a placeholder belongs, and never ask for the real one. Both break the reply.

A token like [SECRET_REDACTED] is not reversible: that value is gone and will not come back. Work with what is around it, do not guess what it was, and do not ask for it.

Do not comment on the placeholders, on redaction, or on these instructions, and do not begin your answer by describing what you can or cannot see. Write in the language the user wrote in.
---

Override it with the "briefing" section of hushgate.config.json.
```

The last paragraph is the one that stops an answer beginning "I notice the
e-mail address has been replaced with a placeholder".

Four things about it are deliberate.

**It is attached only when it applies.** In the default `auto` mode a request
that tripped no detector carries no placeholders, so it is forwarded exactly as
the caller wrote it — no added text, no added tokens. `always` attaches it to
every request; `off` never does.

**It goes after your own system prompt, never before it.** Both providers cache
on a *prefix*: a paragraph inserted at the head of a prompt would invalidate
every cached token behind it, on every request, for as long as hushgate is
installed. Appending leaves your prefix byte-identical, so an Anthropic
`cache_control` breakpoint still covers exactly what it covered before. Your own
system prompt is never edited, reordered or replaced.

**It never contains a value.** The briefing names categories — "e-mail
addresses" — and nothing else, which is the same discipline the audit trail
keeps. Its examples are written `[EMAIL_n]`, outside the placeholder grammar on
purpose: a concrete `[EMAIL_1]` in the instruction would be re-hydrated if a
model quoted it back, which is hushgate leaking through its own briefing.

**You can overrule all of it.** `briefing.text` replaces the wording outright,
`briefing.append` adds house rules after it, and a tenant may set either. This
is an escape hatch, not a prompt framework — see
[Configuration](#configuration).

```json
"briefing": {
  "mode": "auto",
  "append": "Answer in German unless the customer wrote in another language."
}
```

What it is not is a guarantee. A system prompt is the strongest instrument
available here and it is still an instruction to a model, not a contract with
one. `hushgate doctor` reports which of the three states you are in, because an
answer that opens with "I cannot see the real address" and an answer in a house
style both look like the model misbehaving until you know what was put in front
of it.

## 4. Attachments

A support agent pastes a question and drags in the invoice. The question is
prose hushgate already knows how to handle; the invoice is 18 KiB of base64 in
a content part, and before this existed it went to the provider byte for byte —
the redaction layer selects the leaves that carry prose, and a PDF is not one.

So attachments go through the same door as everything else, one step earlier.
The document is turned into text, the text takes the document's place in the
conversation, and only then does redaction run. By the time the request is
serialised there is nothing in it but prose, and every detector, policy and
placeholder applies to the invoice exactly as it applies to the question.

Send this:

```json
{"model": "gpt-4o", "messages": [{"role": "user", "content": [
  {"type": "text", "text": "Worum geht es in dieser Rechnung?"},
  {"type": "file", "file": {"filename": "Rechnung Anna Schmidt.pdf",
                            "file_data": "data:application/pdf;base64,JVBERi0xLjMK..."}}
]}]}
```

and this is what the provider receives — captured from the fake upstream, not
written by hand:

```json
[
    {
        "type": "text",
        "text": "Worum geht es in dieser Rechnung?"
    },
    {
        "type": "text",
        "text": "--- attachment: Rechnung [NAME_1].pdf (application/pdf, 1 page) ---\nRechnung Nr. 2026-0815\nKundin: [NAME_1]\nE-Mail: [EMAIL_1]\nTelefon: [PHONE_1]\nIBAN: [IBAN_1]\nBetrag: 1.240,00 EUR\n--- end of attachment ---"
    }
]
```

The reply comes back with the real values restored, as it does for any other
request. The filename is pseudonymised along with everything else, and on
purpose: `Kuendigung_Anna_Schmidt.pdf` names a person and discloses an
employment event before anyone opens it.

### What it reads

| Format | Read by |
| --- | --- |
| `.docx` `.xlsx` `.pptx` `.odt` `.ods` `.odp` | built in — ZIP via `node:zlib`, then the document XML |
| `.txt` `.md` `.csv` `.tsv` `.json` `.xml` `.log` | built in — with BOM, UTF-16 and windows-1252 detection |
| `.html` | built in — including `href`, `alt` and `title`, which carry addresses |
| `.rtf` | built in |
| `.eml` | built in — headers, RFC 2047 encoded subjects, and the text parts |
| `.pdf` | an external extractor you configure. The Docker image ships `pdftotext`. |
| images, audio, scans | nothing. There is no OCR and no transcription. |

### Why PDF is not parsed in-process

A from-scratch PDF text extractor was written and measured while this was
designed, and it was rejected on its results. On ordinary documents — a Google
Docs export, a letter from a telecoms provider — it produced output that read
fluently, was the right length, and had the recipient's name, street, postcode
and customer number simply missing from it. A variant produced
`johan.beck er@klinik.de`: an address split on glyph advance widths, which no
detector matches and which would therefore reach the provider in the clear.

Those two failures are not the same. Text that is *dropped* is text hushgate
never forwards either, so nothing leaks — the model just gets less. Text that is
*shredded* is forwarded, and is a leak. hushgate refuses both, but it is the
second that decided this: a parser that silently mangles identifiers is worse
than no parser at all, in a tool whose entire claim is that identifiers do not
get through.

So PDF extraction is delegated to a tool built for it, run as a separate
process with the document on its standard input. Nothing derived from the
request reaches its arguments — a file named `-l 1` handed to `pdftotext` as an
argument truncates a 400-page document to one page and exits zero — nothing
touches the disk, and the child gets a minimal environment rather than
hushgate's, which holds your provider API key.

```jsonc
"attachments": {
  "extractors": [
    { "mediaTypes": ["application/pdf"],
      "command": "pdftotext",
      "args": ["-q", "-enc", "UTF-8", "-", "-"],
      "timeoutMs": 20000 }
  ]
}
```

`hushgate doctor` reports whether each configured command is actually on PATH,
so "PDFs are being refused" is something you find out before your users do.

### When it cannot read a document

This is the case the design turns on, because it is where personal data would
leak quietly. An extractor that fails is easy; an extractor that *succeeds* on a
scanned page is not. `pdftotext` on a scan exits 0 and prints a single form
feed, which is indistinguishable from "this document contains no text" to
anything that only checks the exit status.

So every extraction is asked a second question before it is believed: enough
characters overall, enough per page, few enough replacement characters, few
enough control characters, and words that are not overwhelmingly one and two
letters long.

Those are all measures of the wrong thing, though — they ask how the text
*looks* rather than whether anything is hidden in it, and ordinary typesetting
walks straight past them. A PDF whose address block carries normal kerning
comes out of `pdftotext` as

```
E-M ail : a nna .sc hmi dt@ nor dli cht .ex amp le
```

which has no short words at all, reads as fluent to every ratio, and matches no
detector. So the last check asks the question directly: run the detectors over a
window of the text, then over the same window with its spacing closed up, and
see whether closing the gaps reveals something that was not visible before. If
it does, the gaps were what hid it, and the document is refused. A column of
country codes closes up into `DEATCHFRIT`, which reveals nothing — so a table is
not mistaken for a shredded address.

Failing any of these makes the document unreadable, and
`attachments.onUnreadable` decides what happens:

| Setting | Behaviour |
| --- | --- |
| `block` (default) | The request is refused with **422** and nothing leaves the machine. |
| `withhold` | The file is replaced by a note saying it was withheld; the rest of the request goes on. |
| `forward` | The original bytes are sent. The one setting that lets an unread document reach the provider — `doctor` reports it as a failure, and the Article 30 report counts every document it affects. |

```console
$ curl -sS -w '%{http_code}\n' http://127.0.0.1:8787/v1/chat/completions \
    -H 'content-type: application/json' -d @scan-request.json
422
{
    "error": {
        "type": "hushgate_attachment_unreadable",
        "message": "attachment (application/pdf, 2416551 bytes) could not be pseudonymised: extracted only 1 characters from 3 pages, which is not a readable document",
        "mediaType": "application/pdf",
        "bytes": 2416551
    }
}
```

A remote `image_url`, an Anthropic `source.type: "url"`, and a provider
`file_id` are all unreadable by the same rule. hushgate will not fetch them:
making an outbound request of its own to pull in an unknown document, on a
caller's say-so, is not a thing this program does.

### Seeing it without sending anything

`hushgate extract` answers the question an auditor actually asks — show me what
you sent — offline, against a file of their choosing, with no request and no
upstream:

```console
$ hushgate extract Rechnung.pdf
Rechnung.pdf
  pdf, 17.7 KiB, 1 page, read by external.pdftotext
  162 characters, 3 findings (EMAIL 1, IBAN 1, PHONE 1)

Rechnung Nr. 2026-0815
Kundin: Anna Schmidt
E-Mail: [EMAIL_1]
Telefon: [PHONE_1]
IBAN: [IBAN_1]
Betrag: 1.240,00 EUR
```

It refuses what the proxy would refuse, so the two never disagree about a
document.

`hushgate scan` reads documents too, so a folder of contracts can be checked for
what it holds before any of it goes near a model: name the folder, and every
file in it and below is read in name order, with entries whose name starts with
a dot and `node_modules` left alone. A file it cannot read is named as
unreadable and is never counted as scanned — reporting "no personal data found"
about a file nothing ever read is the one answer a sweep must not give.

### Limits

Decoded size is checked before anything is allocated, per attachment and across
the request, and a request may carry at most `attachments.maxCount` documents,
256 unless you set it. One with more is refused with 422 before any of them is
decoded, whatever `attachments.onUnreadable` says, and its audit record holds a
single entry saying why: every document is an entry in the record, and the
limit is what keeps a record short enough for `hushgate audit` to read back.
ZIP entries are capped by count, by size and by compression ratio: a 21 KiB
crafted `.docx` has been measured driving a mature extractor to 178 MiB of
resident memory. No XML is parsed with entity resolution, so XXE is
structurally impossible rather than merely blocked. External extractors get a
wall-clock timeout, a `SIGKILL` after it, and a cap on how much they may write.

## 5. Streaming

Streaming is where a naive proxy falls apart. A model does not emit `[EMAIL_1]`
as one token; it emits `[`, then `EMAIL`, then `_1]`, in three separate SSE
events. A per-chunk find-and-replace sees none of them and hands the placeholder
straight to the user.

Here is the same conversation with `"stream": true`. First, what the upstream
put on the wire — note `[EMAIL_1` cut in half across two events:

```console
$ curl -sSN http://127.0.0.1:9099/v1/chat/completions -H 'content-type: application/json' \
    -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"[NAME_1] ([EMAIL_1]) buche auf [IBAN_1]."}]}'
data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Alles klar. "}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Ich schreibe"}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" an [EMAIL_1"}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"] und buche "}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"auf [IBAN_1]"}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"."}}]}

data: [DONE]
```

And what the client sees through hushgate, for the same generation:

```console
$ curl -sSN http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
    -H 'authorization: Bearer sk-not-a-real-key' \
    -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Anna Schmidt (anna.schmidt@nordlicht.example) hat die Rechnung nicht bezahlt. Bitte erinnere sie und buche auf DE89 3704 0044 0532 0130 00."}]}'
data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Alles klar. "}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Ich schreibe"}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" an "}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"anna.schmidt@nordlicht.example und buche "}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"auf DE89 3704 0044 0532 0130 00"}}]}

data: {"id":"chatcmpl-demo","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"."}}]}

data: [DONE]
```

The third event emitted only ` an ` and held `[EMAIL_1` back, because that run
could still grow into a placeholder. The fourth resolved it and flushed the
whole address at once. §8 explains why that can never stall.

## 6. Data residency

`hushgate residency` answers the DPO's question directly: where does each route
send data, and on whose authority. This is the command an engineer screenshots.

```console
$ hushgate residency
hushgate residency
  config       built-in defaults (no hushgate.config.json found)

  route        openai.chat.completions  (POST /v1/chat/completions)
  upstream     https://api.openai.com
  endpoint     OpenAI API — OpenAI, L.L.C.
  jurisdiction US — United States [third-country]
               Third country. The EU–US Data Privacy Framework covers certified organisations only; otherwise Article 46 safeguards apply.
  rule         residency.allow (empty)
  legal basis  none recorded
  enforcement  sanitize  (residency.mode)
  controls     zero-retention via body store=false [set per request]
               no-training (account) [arranged with the provider]
  verdict      PERMITTED — no allowlist is configured, so every upstream is permitted; add residency.allow to enforce one

  route        anthropic.messages  (POST /v1/messages)
  upstream     https://api.anthropic.com
  endpoint     Anthropic API — Anthropic PBC
  jurisdiction US — United States [third-country]
               Third country. The EU–US Data Privacy Framework covers certified organisations only; otherwise Article 46 safeguards apply.
  rule         residency.allow (empty)
  legal basis  none recorded
  enforcement  sanitize  (residency.mode)
  controls     no-training (contract) [arranged with the provider]
               zero-retention (account) [arranged with the provider]
  verdict      PERMITTED — no allowlist is configured, so every upstream is permitted; add residency.allow to enforce one

2 of 2 routes permitted.

This is a technical control, not legal advice. See the README.
```

Jurisdictions come from a curated **offline** registry — data in the repository,
no lookups, no telemetry. `hushgate residency --registry` prints all of it
(abridged here):

```console
$ hushgate residency --registry
known endpoints (offline registry — extend it with residency.endpoints)

  US       OpenAI API                                                api.openai.com
  US       Anthropic API                                             api.anthropic.com
  US       Google Gemini API                                         generativelanguage.googleapis.com
  UNKNOWN  Azure OpenAI Service                                      *.openai.azure.com, *.cognitiveservices.azure.com
  DE       AWS Bedrock (eu-central-1)                                bedrock-runtime.eu-central-1.amazonaws.com, bedrock.eu-central-1.amazonaws.com
  CH       AWS Bedrock (eu-central-2)                                bedrock-runtime.eu-central-2.amazonaws.com, bedrock.eu-central-2.amazonaws.com
  ...
  FR       Mistral AI — La Plateforme                                api.mistral.ai
  DE       Aleph Alpha                                               api.aleph-alpha.com
  DE       IONOS AI Model Hub                                        inference.de-txl.ionos.com, openai.inference.de-txl.ionos.com
  FR       OVHcloud AI Endpoints                                     *.endpoints.kepler.ai.cloud.ovh.net, *.endpoints.ai.cloud.ovh.net
  FR       Scaleway Generative APIs                                  api.scaleway.ai
  LOCAL    Local model runtime (Ollama, vLLM, LM Studio, llama.cpp)  localhost, 127.0.0.1, ::1, [::1], host.docker.internal

Jurisdictions are where the operator documents the service as running.
Confirm them against your own contract before relying on them.
```

Once `residency.allow` has an entry the list is closed, and **hushgate refuses
to start against anything else**. A typo in an upstream URL is a startup
failure, not a silent leak:

```console
$ hushgate serve -c examples/demo.config.json --upstream-openai https://api.openai.com
hushgate: configuration error
  residency policy refuses this configuration:
  upstreams.openai → https://api.openai.com is not on the residency allowlist [residency.allow]

$ echo $?
1
```

Enforcement is set globally, per route, or per category of personal data:

| Mode | Behaviour |
| --- | --- |
| `block` | Refuse the request outright; the error names the rule that refused it. |
| `sanitize` | Remove the personal data, then forward. The default. |
| `warn` | Forward unchanged, and warn on stderr. For a staged rollout only. |
| `allow` | Forward unchanged, silently. |

All four are audited identically: every request writes a record naming each
category found and its count, whatever the mode decided. `allow` differs from
`warn` only in not printing the warning.

Where a provider publishes a retention or training opt-out that can be set per
request, hushgate attaches it automatically from the same registry — for example
`store: false` on OpenAI. Controls that can only be arranged with the provider,
an account setting or a contract clause, are reported rather than faked; with
`residency.requireDataControls` set, an upstream that offers none refuses to
start.

## 7. The audit trail

Every request appends one JSONL record: when it happened, which route it came
in on, how it ended, where it went, how many findings of each category it
carried and the policy applied to each, and the residency verdict. **No
values.** That includes the requests hushgate refused — a blocked category, a
residency rule, a rejected tenant key, an exhausted quota, an oversized body —
which are recorded as `outcome: "rejected"` or `"blocked"` with the status that
says which. A brute force against tenant keys leaves a line per attempt. Each
record carries the SHA-256 of the previous one, so the file is a hash chain.

The trail below is [`examples/hushgate-audit.jsonl`](examples/hushgate-audit.jsonl),
committed to the repository so this section can be read without running
anything. It was recorded from the two requests in §3 and the stream in §5.
Re-running them writes the same kind of records with new ids and timestamps,
and therefore new hashes; a current build also writes `residency.endpoint`,
which this file predates.

```json
{"ts":"2026-08-23T10:40:09.900Z","id":"fa47a947-5723-4c1a-be43-2a9fdc10dca5","tenant":null,"route":"openai.chat.completions","outcome":"forwarded","status":200,"latencyMs":25,"stream":false,"upstream":"127.0.0.1:9099","tokens":64,"findings":{"TERM":1,"NAME":1,"EMAIL":1,"PHONE":1,"IBAN":1},"policies":{"TERM":"pseudonymize","NAME":"pseudonymize","EMAIL":"pseudonymize","PHONE":"pseudonymize","IBAN":"pseudonymize"},"residency":{"mode":"sanitize","rule":"residency.mode","jurisdiction":"LOCAL","controls":[]},"attachments":[],"prev":"0000000000000000000000000000000000000000000000000000000000000000","hash":"2db1a2b738345c5762bb12c02d1a5b514b3118015850af81035c086e2a042139"}
```

### What a record holds

Every field, in the order it is written:

| Field | Meaning |
| --- | --- |
| `ts` | When the record was written: an RFC 3339 timestamp in UTC. |
| `id` | A random UUID for this record. |
| `tenant` | The tenant the request authenticated as, or `null` in single-tenant mode. |
| `route` | The route it came in on, such as `openai.chat.completions`. |
| `outcome` | `forwarded`; `blocked` by a `block` policy or rule; `rejected` before anything left the machine (a tenant key, a quota, a malformed or oversized body); or `failed` at the upstream. |
| `status` | The HTTP status returned to the caller. |
| `latencyMs` | How long the request took, in milliseconds. |
| `stream` | Whether the response was an event stream. |
| `upstream` | The host the request was sent to, or `null` if it was never sent. |
| `tokens` | Tokens the upstream reported, or 0 when it reported none. |
| `findings` | How many findings of each category, such as `"EMAIL":1`. |
| `policies` | The policy applied to each category: `pseudonymize`, `redact`, `hash`, `allow` or `block`. |
| `residency` | The residency decision, or `null` when the request never reached one: `mode` (`block`, `sanitize`, `warn` or `allow`), `rule` (the config path that decided), `jurisdiction`, `controls` (the retention and training controls set on the outbound request) and `endpoint` (the `residency.allow` entry that admitted the request, as configured, or `null` when no entry decided; absent from records written by 0.4.0 and earlier). |
| `attachments` | One entry per document, in the order they appeared, or `[]`: `format`, `mediaType`, `bytes`, `chars` (characters of text extracted — a length, not the text), `pages`, `extractor`, `outcome` (`extracted`, `truncated`, `withheld`, `forwarded` or `blocked`) and `reason`. |
| `dropped` | Present only after the writer failed to write records: how many were lost immediately before this one. See [How it is written](#how-it-is-written). |
| `prev` | The `hash` of the record before it, or 64 zeros for the first. |
| `hash` | SHA-256 of this record's line with the `hash` field taken out. |

Filenames and document contents never reach the trail. A filename is
routinely personal data on its own — `Kuendigung_Anna_Schmidt.pdf` names a
person and an employment event — so it goes into the outbound prompt, where the
detectors pseudonymise it like any other text, and nowhere else. An
attachment's `reason` is assembled from fixed phrases, sizes and media types,
and its `mediaType` is one hushgate recognises — the declared type when
hushgate knows it or a configured extractor claims it, otherwise the type of
the format it detected — so a caller cannot write text of its own into the
trail through either. Where a field with a fixed set of values — `outcome`,
`residency.mode`, a policy, an attachment's `outcome` — is given anything
outside that set, the record says `invalid` rather than copying what it was
given.

Tenant ids are written as configured, and they are the one field where the
name you choose decides whether the trail itself holds personal data.
[Multi-tenant operation](#multi-tenant-operation) explains why they should name
teams or applications rather than people.

### Verifying it

`hushgate audit verify` walks the chain. Name the trail after the subcommand,
or with `--file`; without one it reads the global trail from the
configuration. A file named without `-c` is verified without loading any
configuration at all, so an auditor handed a copy needs nothing else:

```console
$ hushgate audit verify examples/hushgate-audit.jsonl
audit trail /home/you/hushgate/examples/hushgate-audit.jsonl
  records      3
  chain        intact
  head         5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f

Anchor the head hash outside hushgate (a ticket, a signed note, another
system) and pass it back with --anchor, so that records dropped from the
end are detected too.
```

Change a single field of a single record — here the count that says a
credential was blocked, edited from 1 to 0 — and it reports exactly where the
chain broke:

```console
$ sed 's/"SECRET":1/"SECRET":0/' examples/hushgate-audit.jsonl > examples/tampered.jsonl
$ hushgate audit verify examples/tampered.jsonl
audit trail /home/you/hushgate/examples/tampered.jsonl
  records      3
  chain        BROKEN at 1 point
  break        record 2 (altered), line 2: id fa030c32-7b27-4947-9448-8567b7ca154b, ts 2026-08-23T10:40:09.921Z
               record hash is 07b73ca315a9…, but its contents hash to 25d22e0325ab…
  head         5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f

Records outside the points listed still link correctly. At each listed
point a record was altered, or records were inserted or removed.

$ echo $?
1
```

Every break is listed, up to a hundred and then counted, with the record's
number and the line of the file it is on. A record is `altered` when it no
longer hashes to its own `hash`, and `unlinked` when its `prev` does not name
the record before it, which is what an insertion or a removal leaves behind.
The chain is judged afresh after each break, so one edited record is one
break; the records after it are not condemned with it. On a broken chain,
`head` is the hash stored in the last record.

Three more things are reported, because each would otherwise pass in silence:

- A line that is not a record — not JSON, not UTF-8, missing a field, or over
  16 MiB — is listed as `unreadable` with its line number, and fails
  verification: nothing it held is covered by the verdict. hushgate never
  writes a line that long; see [How it is written](#how-it-is-written).
- A record that carries `dropped` is reported as a gap, such as
  `2 records could not be written before record 7 (line 7)`. The writer linked
  that record to the last one that reached the disk and said what is missing,
  so the chain still verifies, with a warning that requests were served for
  which there is no evidence.
- A trail with no records verifies trivially, and so does one that was
  emptied. verify says so in a warning.

`--json` prints the same verdict for a script, with the keys `file`, `ok`,
`chainOk`, `records`, `firstBreak`, `head`, `from`, `breaks`, `breakCount`,
`gaps`, `gapCount`, `dropped`, `anchors`, `malformed` and `malformedCount`.
`ok` is the whole verdict and always agrees with the exit code: no breaks,
every anchor found, every line readable. `chainOk` is the chain's own verdict
— no breaks and every anchor found — leaving unreadable lines aside. The exit
code is 0 when the trail verifies, 1 when it does not, and 2 for a usage
error: a malformed hash, a file named twice, or a flag that does not apply,
such as `--from` on verify.

### Anchoring the head, and rotating the trail

A chain shows that nothing in it was altered, inserted or removed. It cannot
show that records were cut off the end, because a shorter chain is still a
consistent one, and anyone who can write the file can recompute every hash
after an edit. Both are answered the same way: keep the head somewhere
hushgate cannot rewrite. `serve` helps. Its banner says where each chain stood
when it was opened — `continuing chain from 5531e6c715d8` in §3, or `starting a
new trail` — and on shutdown it prints each trail's head in full, so the
service log, journald or the container log, holds one at no cost:

```console
^C
hushgate: shutting down
  audit      /home/you/hushgate/examples/hushgate-audit.jsonl head 5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f
```

Pass a head back with `--anchor` (repeatable; upper or lower case), and
verification fails unless a record that verifies carries exactly that hash.
Here the last record has been cut off a copy of the trail. The chain still
links; the anchor is gone:

```console
$ head -n 2 examples/hushgate-audit.jsonl > examples/truncated.jsonl
$ hushgate audit verify examples/truncated.jsonl --anchor 5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f
audit trail /home/you/hushgate/examples/truncated.jsonl
  records      2
  chain        intact
  head         07b73ca315a9c30abe0fe7a96c855dec7ccc45326dc2c9c04d18a13d3d830576
  anchor       5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f NOT FOUND

An anchored head that no verified record carries means records were
removed from the end of the trail, or the trail was rewritten, after the
anchor was taken.

$ echo $?
1
```

On the whole trail the same anchor reads
`found at record 3 (line 3), 0 records after it`: where it is, and how many
records were appended since it was taken. A trail that held no records when
hushgate stopped has the genesis hash, 64 zeros, as its head, and the shutdown
line says `(no records yet)` after it. That head can be kept like any other:
verify reports it `found at the start of the chain`, followed by every record
written since, and `--json` gives it `index` 0. The hash given to
`--continues-from`, below, is found there too when it is also passed as an
anchor.

To rotate the trail:

1. Stop hushgate. The lines it prints last give the head of each trail it was
   writing.
2. Move the file away: `mv hushgate-audit.jsonl hushgate-audit-2026-09.jsonl`.
3. Start hushgate. The banner says `starting a new trail`, and the new file's
   chain starts from 64 zeros.
4. Keep the old head with the archive.
   `hushgate audit verify hushgate-audit-2026-09.jsonl --anchor <head>` checks
   it, now or in five years.

Never rotate with `copytruncate`. It copies the file and then empties it in
place, so records written between the two steps are lost, and the first record
in the emptied file links to one that exists only in the copy. hushgate notices
a trail moved, deleted or truncated underneath it and says so on stderr, with
the head to anchor, but that is a warning about damage, not a way to rotate.

A trail whose beginning was removed on purpose — records past their retention
period, cut from the front — no longer starts from 64 zeros, and verify reports
its first record as `unlinked`. Note the hash of the last record you remove
when you remove it, and pass it back with `--continues-from`:

```console
$ tail -n 1 examples/hushgate-audit.jsonl > examples/pruned.jsonl
$ hushgate audit verify examples/pruned.jsonl --continues-from 07b73ca315a9c30abe0fe7a96c855dec7ccc45326dc2c9c04d18a13d3d830576
audit trail /home/you/hushgate/examples/pruned.jsonl
  records      1
  from         07b73ca315a9c30abe0fe7a96c855dec7ccc45326dc2c9c04d18a13d3d830576
  chain        intact
  head         5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f

Anchor the head hash outside hushgate (a ticket, a signed note, another
system) and pass it back with --anchor, so that records dropped from the
end are detected too.
```

### Tenants' trails

A tenant with its own `audit.path` is recorded in that file and nowhere else.
`--tenant <id>` verifies, or reports on, that tenant's trail; a tenant without
one is recorded in the global trail, which is then what is read, and a note
says so. A plain `hushgate audit verify` still checks the global trail alone,
and ends by naming the tenant trails it did not check. `--all` checks every
distinct trail the configuration names — the global one and each tenant's,
once per file however many tenants share it — prints a block for each, ends
with `All 3 trails verified.` or `1 of 3 trails did not verify.`, and fails if
any one does, including a trail that cannot be read. `--anchor` and
`--continues-from` describe a single trail, so they do not combine with
`--all`.

### Checking it without hushgate

The verifier is a convenience, not the authority. Each line is its record
serialised as JSON with no added whitespace and the fields in the order above,
and its `hash` is the SHA-256 of that line with `,"hash":"<64 hex digits>"`
taken out:

```console
$ head -n 1 examples/hushgate-audit.jsonl | sed 's/,"hash":"[0-9a-f]\{64\}"}$/}/' | tr -d '\n' | sha256sum
2db1a2b738345c5762bb12c02d1a5b514b3118015850af81035c086e2a042139  -
```

That is the `hash` at the end of the first line and the `prev` of the second.
Because the hash covers bytes, a line has to stay in exactly that form. One
that parses to the same record but is spelt differently — added whitespace, a
number written another way, a key given twice — is not what was hashed, and
`audit verify` reports it as altered. A duplicate key is the case that
matters: two JSON readers can disagree about which of its values the record
holds.

### The report

`hushgate audit report` turns the same file into an Article 30 style record of
processing activities, in Markdown or, with `--json`, as data:

```console
$ hushgate audit report -c examples/demo.config.json
# Record of processing activities

_Article 30 style summary, generated by hushgate from its own audit trail._

- **Generated**: 2026-10-27T18:27:34.342Z
- **Generator**: hushgate 0.5.0
- **Source**: /home/you/hushgate/examples/hushgate-audit.jsonl
- **Configuration**: /home/you/hushgate/examples/demo.config.json
- **Period**: beginning → end (UTC days, inclusive; records from 2026-08-23T10:40:09.900Z to 2026-08-23T10:40:09.939Z)
- **Controller**: Nordlicht GmbH
- **Contact**: datenschutz@nordlicht.example
- **Data protection officer**: A. Datenschutz
- **Audit chain**: intact over 3 records (head 5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f)

## Purposes of processing

- Drafting customer support replies

## Volumes

- Requests: **3**
- Tokens reported by providers: **128**
- Outcomes: blocked 1, forwarded 2
- Routes: openai.chat.completions 3
- Residency enforcement: n/a 1, sanitize 2
- Requests forwarded unredacted under residency warn or allow: **0**

## Categories of personal data

| Category | Findings | Requests | Handling |
| --- | ---: | ---: | --- |
| EMAIL | 2 | 2 | pseudonymize |
| IBAN | 2 | 2 | pseudonymize |
| NAME | 2 | 2 | pseudonymize |
| PHONE | 1 | 1 | pseudonymize |
| SECRET | 1 | 1 | block |
| TERM | 1 | 1 | pseudonymize |

## Recipients and transfers

| Recipient | Jurisdiction | Transfer | Requests | Tokens | Safeguard recorded |
| --- | --- | --- | ---: | ---: | --- |
| 127.0.0.1:9099 | Your own infrastructure (LOCAL) | no transfer | 2 | 128 | Processing on our own hardware; no transfer occurs. |

_Safeguards are read from the configuration in force when this report was generated, not from the time of each request: an allowlist entry added, changed or removed since then changes this column._

### Controls applied to outbound requests

- 127.0.0.1:9099 (LOCAL): none set per request

## Technical measures

- Where a category is handled by `pseudonymize` (EMAIL, IBAN, NAME, PHONE, TERM), its values were replaced with placeholders before the request left the machine, and restored in the response.
- Where a category is handled by `block` (SECRET), the request was refused and nothing in it left the machine.

The audit trail records categories and counts only; it holds no personal
data from requests. Identifiers the operator chooses, such as tenant ids,
are recorded as configured.

---

This document is generated from a technical control. It supports a record of
processing activities; it is not legal advice and does not by itself make any
transfer lawful.
```

It says what the trail supports and no more. The whole trail is verified,
whatever the period, because a break outside it still means the figures inside
cannot be trusted; the **Audit chain** line reads `intact` only when every link
holds, every anchor is found and every line can be read, and otherwise names
the first break with its line, the number of breaks, the missing anchor or the
unreadable lines. Where they apply, the document also states:

- what was sent **unredacted**. Categories forwarded under a residency `warn`
  or `allow` mode, or an `allow` policy, are counted as such and never listed
  as pseudonymised, and with attachments switched off the document says that
  documents were forwarded unread;
- a safeguard it cannot attribute. Records without `residency.endpoint` are
  matched to the allowlist by host, and where several entries share a host
  with different legal bases, the row says **ambiguous** and lists them;
- records the writer could not write, as **N audit records were lost** when the
  stretch they were lost in — from the record before the loss to the one that
  counts it — lies inside the period, and as **up to N audit records may be
  missing from this period**, with the stretch, when it reaches past the
  period's edge, since the trail cannot say on which side they fell. Either
  makes every figure a lower bound, and the **Audit chain** line names the
  gaps of the whole trail;
- the configuration it was generated with, or **none found — defaults used**,
  and the hushgate version that generated it;
- tenants whose own trails it does not include, under **Not covered**, when it
  reads the global trail, whether by default, by file name or through the
  `--tenant` of a tenant recorded there.

`--from` and `--to` take UTC days, `YYYY-MM-DD`, both inclusive; a date that
does not exist, such as `2026-02-31`, or a `--from` after the `--to`, is a
usage error. `--tenant` chooses which trail is read and does not filter
records: a tenant without a trail of its own is reported together with
everything else in the global one, and a note on stderr says so. The report
takes `--anchor` and `--continues-from` as verify does, always loads the
configuration for the organisation and its safeguards, and exits 1 when the
chain has a break, an anchor is missing or a line is unreadable. Lost records
alone do not change the exit code; the document states them.

### How it is written

Each record is appended with one synchronous write, so a request hushgate has
answered for has its record in the kernel rather than in a buffer a crash would
lose. On a local disk that takes microseconds; on a
network filesystem it can stall every request for far longer. Keep the trail on
a local disk. New trail files are created readable by their owner and group
only.

`serve` opens every trail before it binds the port, and if one cannot be
opened — a directory it may not write, a read-only volume, a path that is a
directory — it exits 1 with nothing listening, because a proxy that cannot
write its trail must not forward personal data without one. `hushgate doctor`
runs the same check ahead of time. A record that cannot be written once hushgate
is running, on a full disk say, is counted and reported on stderr. The next
record that does reach the file carries the count as `dropped`, if hushgate
writes one before it stops. If it does not, because it was stopped, restarted
or killed while the disk was still full, the trail itself never shows those
records: they are counted only in the shutdown line, as
`(3 records could not be written, 3 of them not counted in the trail)`, and in
`hushgate_audit_dropped_records_total`, which exposes the count to monitoring.
Anything above zero there is worth an alert, and worth reading the shutdown
line for. A record whose line would be longer than the 16 MiB a reader takes is
not written at all and counts as lost the same way, so that no single request
can leave a line that `audit verify` refuses and a break after it that nobody
made; `attachments.maxCount` keeps the proxy's own records far below that.

On shutdown, requests still in flight get five seconds to finish; after that
their upstream calls are abandoned and they are recorded as `failed`. Either
way their records are written before the trails are closed.

Tenants that name the same file, or the global trail's file however it is
spelt, share one writer and one chain, and each record still names its tenant.
Two hushgate processes must not share a file: each would extend a chain of its
own, and the file would break at the first switch between them.

## 8. How it works

### Structural traversal, not a regex over the blob

A request body is parsed and walked by path rules, so hushgate redacts the
*conversation* rather than the JSON. `model`, tool identifiers, `stream`,
`max_tokens` and the rest are forwarded byte for byte; the prose, the tool-call
arguments and the tool schemas are not.

| Provider | Paths that carry user content |
| --- | --- |
| OpenAI | `messages.*.content` (string form), `messages.*.content.*.text`, `messages.*.content.*.input_text`, `messages.*.name`, `messages.*.refusal`, `messages.*.tool_calls.*.function.arguments`, `messages.*.function_call.arguments`, `tools.*.function.description`, `tools.*.function.parameters.**`, `functions.*.description`, `functions.*.parameters.**` |
| Anthropic | `system`, `system.*.text`, `messages.*.content`, `messages.*.content.*.text`, `messages.*.content.*.content`, `messages.*.content.*.content.*.text`, `messages.*.content.*.input.**`, `tools.*.description`, `tools.*.input_schema.**`, `metadata.user_id` |

Tool-call arguments are a JSON *string*; redacting them as text is safe because
a placeholder contains no character that JSON escapes, and the model's reply is
re-hydrated the same way. Image content parts are deliberately excluded: a
`data:` URL is megabytes of base64 in which no detector can validate anything,
and scanning it would only burn time.

### Detectors validate, they do not pattern-match

Every detector that can check itself does. This is the difference between a tool
that flags `4111 1111 1111 1112` and one that does not.

| Kind | Validation |
| --- | --- |
| `IBAN` | ISO 13616 / ISO 7064 MOD 97-10, folded digit by digit because the number does not fit a JS `number`; length table for 76 countries. The remainder must be exactly 1. |
| `CREDIT_CARD` | Luhn plus an issuer-prefix check. A 16-digit run that fails Luhn is not a card. |
| `BANK_ACCOUNT` | The pre-IBAN pair. The Bankleitzahl is looked up in the Bundesbank directory shipped with hushgate, and the Kontonummer is then run through *that bank's* check-digit method — all 91 the directory names, implemented from the Bundesbank spec and pinned by its 457 official test account numbers. That is what makes an unlabelled `532013000 / 37040044` safe to report. UK sort codes and US routing numbers are covered too; the routing number carries its own 3-7-1 checksum. |
| `GERMAN_TAX_ID` | ISO 7064 MOD 11,10 check digit **and** the digit-frequency rule: within the first ten digits exactly one digit repeats — twice, or three times — and no more. Both must hold. |
| `SOCIAL_SECURITY_ID` | Versicherungsnummer: the birth date inside it must be a real date, the Bereichsnummer must be one the DRV allocated, and the weighted check digit must agree with the twelve digits the eleven characters expand to. All three. |
| `HEALTH_INSURANCE_ID` | Krankenversichertennummer: the leading letter expands to two digits, and the check digit is computed over the result. |
| `ID_CARD_NUMBER` / `PASSPORT_NUMBER` | ICAO 9303 check digit, weights 7-3-1 modulo 10. One detector for both: the serial does not say which document it came off, so the word next to it decides, and failing that the series letter. |
| `TRAVEL_DOCUMENT_MRZ` | The machine-readable zone off a passport or identity card, TD1, TD2 and TD3. The densest personal data hushgate will ever see — name, date of birth, sex, nationality, expiry and document number in one block — and the most completely checksummed: four or five independent ICAO 7-3-1 digits, one of them a composite over the others. A 44-character uppercase blob shape-matches and is rejected; that is the point. Reported as one span covering the whole block, so nothing inside it can carve it up. |
| `EU_VAT_ID` | Per-country length and shape for every member state. Germany's ISO 7064 MOD 11,10 check digit is available but **off by default** — a wrong VAT number on an invoice is common, and refusing to redact it is the worse mistake. `redaction.detectors.vatId.requireGermanCheckDigit` turns it on. |
| `GERMAN_TAX_NUMBER` | Steuernummer, which has no nationwide check digit. The slash-grouped form a Finanzamt prints — `27/123/45678` — is a shape almost nothing else has and stands alone; the same digits run together need a label. |
| `COMMERCIAL_REGISTER_ID` | `HRA`/`HRB` carries its own label, and neither string precedes digits in ordinary German prose. The sibling registers `VR`, `GnR` and `PR` are deliberately not read: `VR 1234` is also a version. |
| `DRIVER_LICENCE_ID` | No check digit exists outside the issuing authority, so a label is required — plus three structural rules, because `Verkehrsamt` is exactly as long as a licence number and sits next to the very words that would license one. |
| `VEHICLE_PLATE` | The closed register of Unterscheidungszeichen. The shape alone is also an article number and a norm reference; the district code is what makes a plate a plate. |
| `POSTAL_ADDRESS` / `POSTCODE` | A street-type suffix on a token plus a house number, graded: `-straße` fires alone, `-weg` needs a postcode or a label, because *Parkplatz* and *Radweg* are ordinary nouns. Five digits alone are never a postcode — a label, a country prefix or a place name licenses it. |
| `ICD_CODE` / `MEDICATION` | Article 9 data, so the recall bar is higher and the false-positive risk worse: `E11.9` is a diabetes diagnosis, a software version and a spreadsheet cell. Codes are read against a catalogue and blocked by the words around them; a labelled code needs no catalogue. |
| `BIC` | ISO 9362 shape, and the two country characters must be a real ISO 3166-1 alpha-2 code. |
| `DEVICE_ID` | IMEI by its own Luhn digit; UUID by the version and variant nibbles RFC 9562 actually issues. |
| `SESSION_TOKEN` | The cookie or header *name* plus an assignment — never the value's entropy. That was measured on this corpus and it does not separate the two populations. |
| `EMAIL` | A practical RFC 5322 grammar, then the structural checks a regex cannot express: 64-byte local part, 254-byte total, 63-byte labels, no leading, trailing or doubled dot. |
| `PHONE` | E.164, `00` international and German national forms, with subscriber-length bounds; `(0)` trunk notation tolerated. |
| `IPV4` / `IPV6` / `MAC` | Octets bounded at 255; IPv6 `::` compression handled, embedded-IPv4 form included. |
| `DATE_OF_BIRTH` | German `DD.MM.YYYY` and ISO, real calendar dates including leap years, inside a configurable birth-year window. |
| `SECRET` | Anthropic and OpenAI keys, GitHub tokens classic and fine-grained, AWS access key ids, Google API keys, Slack tokens, JWTs whose header segment actually decodes, PEM private-key blocks. |
| `URL_CREDENTIALS` | `scheme://user:pass@host`. |
| `NAME` / `TERM` | Your dictionary: case-insensitive, whole-word, longest match wins. |
| custom | Your named regexes; the name becomes the category, e.g. `EMPLOYEE_ID`. |

Detectors return *candidates*, and candidates overlap. Resolution is central and
deterministic: the longest span wins, ties broken by detector priority
(`SECRET` 100 > `TRAVEL_DOCUMENT_MRZ` 99 > `URL_CREDENTIALS` 95 > `IBAN` 90 >
`CREDIT_CARD` 85 > `GERMAN_TAX_ID` 80 > `EMAIL` 75 > `BANK_ACCOUNT` 72 > … >
dictionary 40).

### What the detectors are shown

Detectors do not run on the text the caller wrote; they run on a private scan
copy of it, and any span they find is mapped back to the exact original
characters before the value is replaced — hushgate forwards what the caller
wrote, so the copy exists only to be scanned. Two transformations build it:

- **Invisible characters are dropped** before matching: the whole `Cf` class
  (zero-width space, joiners, word joiner, byte-order mark, soft hyphen, bidi
  controls) plus every `Default_Ignorable_Code_Point` (variation selectors,
  Hangul fillers). A zero-width space inside an e-mail address renders as
  nothing, reads as an address to a human, and would otherwise match no pattern
  at all.
- **NFKC is applied per combining cluster** — a base character plus the
  combining marks that follow it — not over the whole string. That composes a
  decomposed umlaut and folds full-width letters into ASCII ones while keeping
  the offset map exact. The deliberate cost: sequences that compose only across
  a cluster boundary (Hangul jamo, a halfwidth voiced mark after a kana) are
  left alone.

Pure ASCII takes a fast path: every invisible above is non-ASCII and NFKC is
the identity on ASCII, so ASCII prose skips the whole mechanism at one linear
test.

Two residual limits follow from what this does *not* cover. A detector still
has to recognise the shape afterwards: `DATE_OF_BIRTH` matches `14.03.1987`
and ISO forms, not "fourteenth of March" written out. And the folds are
canonical, not cultural — `PHONE` matches E.164, `00` international and German
national spellings; a number written the way another culture groups it, or in
letters (`null fünf …`), is prose as far as every detector is concerned.

### Placeholders, and the injection case

Within one session the same value of the same kind always maps to the same
placeholder, and two different values never share one. The interesting part is
what happens when the caller's own text already contains something that looks
like a placeholder — otherwise a user could type `[EMAIL_1]` into a prompt and
be handed somebody else's address on the way back.

Placeholder-shaped literals in the input are themselves captured, under a
reserved `LITERAL` kind, and re-issued — so no token hushgate mints can ever
collide with one that arrived from outside:

```console
$ node examples/redact.mjs
upstream sees : [NAME_1] <[EMAIL_2]> — the template still says [LITERAL_1]. Steuer-ID [GERMAN_TAX_ID:a86f2fa599f1], host 10.14.2.7.
findings      : NAME=pseudonymize EMAIL=pseudonymize LITERAL=pseudonymize GERMAN_TAX_ID=hash IPV4=allow
restored      : Anna Schmidt <anna.schmidt@nordlicht.example> — the template still says [EMAIL_1]. Steuer-ID [GERMAN_TAX_ID:a86f2fa599f1], host 10.14.2.7.
```

The real address became `[EMAIL_2]`, not `[EMAIL_1]`, and the caller's literal
came back exactly as typed. `GERMAN_TAX_ID` was on the `hash` policy, so it is
stable but irreversible and stays hashed in the response; `IPV4` was on `allow`
and was never touched.

### Streaming: hold back only what could still become a token

Re-hydration happens in two layers.

The **byte layer** keeps a running buffer and emits everything except the
trailing run that could still grow into a placeholder. Only the last `[` can
start a viable prefix — `[` is not a character a placeholder body may contain,
so any earlier one is already ruled out. Three properties make that safe:

- a viable prefix is bounded by `MAX_PLACEHOLDER_LENGTH` (72), so the buffer is
  bounded: no deadlock, and no waiting for a byte that never comes;
- `flush()` always emits whatever is still held, so a stream that dies mid-token
  still delivers its tail verbatim;
- substitution is a single left-to-right pass, so a restored value that itself
  looks like a placeholder is never re-examined.

The **SSE layer** sits on top, because the split is usually not at the byte level
at all but between events. The stream is parsed into events; each delta field is
fed to a re-hydrator that remembers across events, keyed by path and block index
so two concurrent tool calls never mix their buffers; every other string in an
event is complete by construction and is substituted on the spot. Anything still
incomplete when a block ends is emitted as one synthetic event modelled on the
last real one — before `content_block_stop`, before `[DONE]`, and at end of
stream — so nothing is ever dropped and the client always sees a well-formed
stream.

The test suite splits a placeholder at **every byte offset**, in two- and
three-way splits, and one character at a time.

### Cost

Redaction is linear in input size. Measured on an Apple M1 Pro, Node 26, mean of
200 runs per size, on German prose carrying roughly one finding per 45 bytes:

| Input | Time |
| ---: | ---: |
| 1 KiB | 0.15 ms |
| 4 KiB | 0.51 ms |
| 16 KiB | 2.04 ms |
| 66 KiB | 8.9 ms |

Four times the input, four times the work — measured across four doublings up
to the 4 MiB body limit, and bounded on every CI run by the
`does not degrade super-linearly` test, which compares the growth factor of one
doubling against the next rather than trusting a single ratio. A typical chat
request sits in the first row of that table, against a network round trip
measured in hundreds of milliseconds.

## 9. Reference

### Commands

| Command | Purpose |
| --- | --- |
| `hushgate init [--path <p>] [--force]` | Write a commented starter `hushgate.config.json`. |
| `hushgate serve [options]` | Run the redacting proxy in the foreground. |
| `hushgate scan [--json] [--show-values] [-q] <file or folder...>` | Find personal data in files and folders, including PDFs and Office documents. Exits 3 when it finds any. |
| `hushgate extract [--raw] [--json] <file>` | Show the text a document would be sent as. |
| `hushgate check [-q]` | Redact standard input to standard output, for piping. |
| `hushgate residency [--json] [--registry]` | Where each route sends data, and on whose authority. |
| `hushgate briefing [--tenant <id>] [--kinds <list>] [--json]` | Print what hushgate tells the model about the placeholders. |
| `hushgate doctor [--json] [--allow-warnings]` | Validate config and residency, and verify every audit trail and whether `serve` could write it. For CI. |
| `hushgate audit verify [<file> \| --tenant <id> \| --all] [--anchor <hash>]... [--continues-from <hash>] [--json]` | Walk the whole hash chain: every break, gap and unreadable line, with line numbers, and every anchor. See [§7](#verifying-it). |
| `hushgate audit report [<file> \| --tenant <id>] [--from <date>] [--to <date>] [--anchor <hash>]... [--continues-from <hash>] [--json]` | Article 30 style record of processing, over UTC days. See [§7](#the-report). |
| `hushgate keys new <tenant-id>` / `hushgate keys hash` | Mint a tenant key, or hash an existing one. |
| `hushgate help [command]`, `hushgate version` | Help, and the version. |

`serve` additionally takes `-H/--host`, `-p/--port`, `--upstream-openai`,
`--upstream-anthropic`, `--audit <path>` and `--no-audit`. Every command except
`setup`, `init` and `keys` takes `-c/--config`.

Options may stand before the command as well as after it, so `hushgate --json
residency` works; `hushgate help <command>` and `hushgate <command> --help`
print the same thing. A mistyped command, subcommand or option is answered with
the nearest one that exists — `unknown command "scann"; did you mean "scan"?` —
and exits 2 like any other usage error.

| Exit code | Meaning |
| ---: | --- |
| 0 | Success. |
| 1 | Failure — a broken chain, a missing anchor, an unreadable trail line, a `doctor` finding, a refused configuration, an audit trail `serve` cannot open. |
| 2 | Usage error. |
| 3 | `hushgate scan` found personal data. |

### HTTP surface

| Method and path | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible. Redacted outbound, re-hydrated inbound, streaming or not. |
| `POST /v1/messages` | Anthropic-compatible, same treatment. |
| `GET /healthz` | `{"status":"ok","version":"…"}`. |
| `GET /metrics` | Prometheus text exposition. Needs a tenant key once tenants exist. |

`/healthz` is always open. `/metrics` is open on loopback in single-tenant mode
and requires a tenant key as soon as any tenant is configured — counts are still
telemetry. Annotation-based Prometheus scraping sends no `Authorization` header,
so a multi-tenant deployment needs a scrape config that does: a `ServiceMonitor`
with `bearerTokenSecret` pointing at the same secret the tenant key comes from,
for example.

```console
$ curl -sS http://127.0.0.1:8787/metrics
# HELP hushgate_build_info Version of the running hushgate.
# TYPE hushgate_build_info gauge
hushgate_build_info{version="0.5.0"} 1
# HELP hushgate_requests_total Requests handled, by route, outcome and tenant.
# TYPE hushgate_requests_total counter
hushgate_requests_total{outcome="blocked",route="openai.chat.completions",status="403",tenant="none"} 1
hushgate_requests_total{outcome="forwarded",route="openai.chat.completions",status="200",tenant="none"} 2
# HELP hushgate_attachments_total Attachments handled, by format, outcome and extractor.
# TYPE hushgate_attachments_total counter
# HELP hushgate_attachment_bytes_total Attachment bytes decoded, by format.
# TYPE hushgate_attachment_bytes_total counter
# HELP hushgate_findings_total Personal data found, by category and the policy applied.
# TYPE hushgate_findings_total counter
hushgate_findings_total{kind="EMAIL",policy="pseudonymize"} 2
hushgate_findings_total{kind="IBAN",policy="pseudonymize"} 2
hushgate_findings_total{kind="NAME",policy="pseudonymize"} 2
hushgate_findings_total{kind="PHONE",policy="pseudonymize"} 1
hushgate_findings_total{kind="SECRET",policy="block"} 1
hushgate_findings_total{kind="TERM",policy="pseudonymize"} 1
# HELP hushgate_blocked_total Requests refused, by what refused them.
# TYPE hushgate_blocked_total counter
hushgate_blocked_total{reason="policy",rule="redaction.policies"} 1
# HELP hushgate_audit_dropped_records_total Audit records that could not be written, by trail.
# TYPE hushgate_audit_dropped_records_total counter
hushgate_audit_dropped_records_total{trail="global"} 0
# HELP hushgate_upstream_tokens_total Tokens reported by upstream providers.
# TYPE hushgate_upstream_tokens_total counter
hushgate_upstream_tokens_total{route="openai.chat.completions",tenant="none"} 64
# HELP hushgate_request_duration_seconds Time from request received to response finished.
# TYPE hushgate_request_duration_seconds histogram
...
```

`hushgate_audit_dropped_records_total` counts the audit records that could not
be written since hushgate started, one series per trail file: `trail="global"`
for the global trail, and for a tenant's own file the ids of the tenants
writing to it, such as `trail="sales,support"`. Anything above zero means
requests were served without evidence, which makes it worth an alert;
[How it is written](#how-it-is-written) in §7 has the rest.

### Policies

| Policy | Effect | Reversible |
| --- | --- | --- |
| `pseudonymize` | `[EMAIL_1]` — stable within the session. The default. | yes |
| `redact` | `[EMAIL_REDACTED]` — the value is gone. | no |
| `hash` | `[EMAIL:9f86d081ab2c]` — HMAC-SHA256 truncated to 12 hex characters. Comparable, and stable once `hmacKey` is set. | no |
| `allow` | Left untouched. | n/a |
| `block` | The whole request is refused, HTTP 403. | n/a |

### Configuration

File, then `HUSHGATE_*` environment variables, then command-line flags — later
wins. The file is JSONC: `//` and `/* */` comments are stripped on load.

| Key | Default | Notes |
| --- | --- | --- |
| `host`, `port` | `127.0.0.1`, `8787` | Binding a non-loopback address requires tenants. |
| `upstreams.openai` / `.anthropic` | the official endpoints | Any OpenAI- or Anthropic-compatible base URL. |
| `redaction.defaultPolicy` | `pseudonymize` | Applies to kinds without an override. |
| `redaction.policies` | `{}` | Per-kind overrides. |
| `redaction.dictionary` | `{}` | `names` and `terms`. |
| `redaction.custom` | `[]` | `{ "name", "pattern" }`; the name becomes the category. |
| `redaction.hmacKey` | random per session | Set it to make `hash` output comparable across requests and restarts. |
| `redaction.dobYearRange` | 1900 → this year − 13 | Plausible birth years. |
| `briefing.mode` | `auto` | `auto` \| `always` \| `off`. When to tell the model what the placeholders are. See [§3.1](#31-what-the-model-is-told). |
| `briefing.text` | `null` | Replaces the built-in wording outright. At most 4000 characters. |
| `briefing.append` | `null` | House rules added after whichever text is used. |
| `limits.maxBodyBytes` | 16 MiB | Larger requests are refused with 413. Base64 inflates a document by a third. |
| `limits.maxResponseBytes` | 16 MiB | Larger upstream responses are refused with 502. |
| `limits.upstreamTimeoutMs` | 120000 | Upstream request timeout. |
| `limits.requestTimeoutMs` | 60000 | How long a client may take to deliver its request. |
| `limits.idleTimeoutMs` | 60000 | How long a connection may sit silent when it is *nobody's* turn to talk — between requests, or mid-stream waiting for input. While hushgate is serving, this limit does not apply: a model can think in silence for minutes, and that is what `limits.upstreamTimeoutMs` bounds. |
| `limits.upstreamRetries` | 2 | Retries for an upstream that never answered. A response is never retried. |
| `limits.retryBackoffMs` | 250 | Base delay for the full-jitter backoff, doubled each attempt. |
| `attachments.enabled` | `true` | Turn documents into text before redacting. Off means they are forwarded unread. |
| `attachments.onUnreadable` | `block` | `block` \| `withhold` \| `forward`. What to do with a document whose text hushgate could not read. |
| `attachments.maxBytes` | 10 MiB | Per attachment, decoded. |
| `attachments.maxTotalBytes` | 32 MiB | Across one request. |
| `attachments.maxCount` | 256 | Documents per request. More is refused with 422, whatever `onUnreadable` says; it also keeps each audit record short enough to read back. |
| `attachments.maxTextChars` | 200000 | Extracted text is cut here, and the cut is reported. |
| `attachments.timeoutMs` | 20000 | Budget for extracting one attachment. |
| `attachments.extractors` | `pdftotext` | Operator-provided commands, tried before the built-in ones. |
| `audit.enabled`, `audit.path` | `true`, `hushgate-audit.jsonl` | |
| `residency.mode` | `sanitize` | `block` \| `sanitize` \| `warn` \| `allow`. |
| `residency.routes`, `.categories` | `{}` | Per-route and per-category overrides. |
| `residency.allow` | `[]` | Non-empty means fail-closed. Every entry needs a `legalBasis`. |
| `residency.requireDataControls` | `false` | Refuse upstreams that offer no retention control. |
| `residency.endpoints` | `[]` | Extend or override the registry. |
| `organisation` | nulls | Heads the Article 30 report. |
| `tenants` | `[]` | See below. |

Environment overrides: `HUSHGATE_HOST`, `HUSHGATE_PORT`,
`HUSHGATE_UPSTREAM_OPENAI`, `HUSHGATE_UPSTREAM_ANTHROPIC`,
`HUSHGATE_DEFAULT_POLICY`, `HUSHGATE_HMAC_KEY`, `HUSHGATE_MAX_BODY_BYTES`,
`HUSHGATE_MAX_RESPONSE_BYTES`, `HUSHGATE_UPSTREAM_TIMEOUT_MS`,
`HUSHGATE_IDLE_TIMEOUT_MS`, `HUSHGATE_AUDIT_PATH`, `HUSHGATE_AUDIT`, `HUSHGATE_RESIDENCY_MODE`,
`HUSHGATE_ATTACHMENTS`, `HUSHGATE_ATTACHMENTS_ON_UNREADABLE`,
`HUSHGATE_ATTACHMENT_MAX_BYTES`, `HUSHGATE_ATTACHMENT_MAX_COUNT`. A full
annotated file is in [`hushgate.config.example.json`](hushgate.config.example.json).

### Multi-tenant operation

Each tenant gets its own policy profile, its own pseudonym namespace, its own
quotas, and its own audit trail if you give it one. A placeholder minted for one
tenant cannot be resolved by another, and there is a test that asserts exactly
that. hushgate refuses to bind a non-loopback address until at least one tenant
exists, so it cannot become an open relay on the LAN.

```console
$ hushgate keys new support
tenant key for "support" — copy it now, hushgate does not store it:

  hg_I-fluM42ZeEGXgVWpmA3XC2QlRtAP3h-SwlOIcBcnxU

add this to hushgate.config.json:

  {
    "tenants": [
      {
        "id": "support",
        "name": "support",
        "keyHash": "sha256:3ca843a2a0627a619965ecbfa8b96aeeb75f41402ba99342df5d99cc0a069312"
      }
    ]
  }

The caller sends the key as "Authorization: Bearer <key>" or "x-api-key: <key>".
Revoke it by removing the hash; rotate it by listing both hashes in keyHashes.
```

A tenant entry takes:

| Field | Meaning |
| --- | --- |
| `id`, `name` | Identifier used in the audit trail and the metrics labels. Name a team or an application, not a person — see below. |
| `keyHash` | `sha256:…` of the key. The key itself is never stored. |
| `keyHashes` | Several hashes, for rotating a key without downtime. |
| `keyEnv` | Name of an environment variable holding the key, so a container gets one without a secret in the config file. |
| `upstreamKeyEnv` | Where this tenant's **provider** credential is read from. Defaults to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`. |
| `quotas` | `requestsPerMinute`, `tokensPerDay`. Over-quota callers get a 429. |
| `audit.path` | A trail of this tenant's own, with its own hash chain. Without one, its requests are recorded in the global trail. |
| `redaction` | Overrides folded over the global profile — see below. |
| `briefing` | Overrides folded over the global briefing, key by key. A tenant naming only `append` keeps the house `mode` and `text`; writing `null` for a key drops a global override rather than inheriting it. |

A tenant's `redaction` block is an **override**, not a replacement: policies
merge per kind, dictionaries take the union of names and terms, custom rules
merge by name, and anything the tenant does not mention it inherits. A tenant
with no `redaction` block gets the global profile in full. The same is true of
`briefing`: `hushgate briefing --tenant <id>` prints the words any one of them
actually gets.

A tenant's `audit.path` is resolved against the working directory, like the
global one. Tenants that name the same file share one chain, and so does a
tenant that names the global trail's file, however either is spelt: hushgate
opens one writer per file, and each record still names its tenant. Only the
global trail is read by a plain `hushgate audit verify`; `--tenant <id>` and
`--all` read the others, and `hushgate doctor` checks them all; see
[§7](#tenants-trails).

Choose tenant ids for teams or applications — `support`, `crm-sync` — rather
than for people. The id is written into every record next to a timestamp, so
a per-person id such as `j.becker` turns the trail into a log of when each
employee used the model and how much personal data their requests carried.
That is personal data about employees in its own right, and in Germany it can
engage the works council's co-determination right under §87(1) Nr. 6 BetrVG,
which covers technical systems suited to monitoring employees' behaviour or
performance.

Note what changes about credentials in multi-tenant mode. The caller sends a
*hushgate* key, not a provider key, and hushgate drops the header carrying it
before forwarding — a tenant key must never reach a provider. The provider
credential comes from `upstreamKeyEnv` instead. The unqualified claim in §2 that
your provider API key is forwarded untouched holds for single-tenant operation,
which is where you start.

### Library

The proxy is one consumer of a plain library; everything is exported from the
package root.

```js
import { Session } from 'hushgate';

const session = new Session({
  policies: { GERMAN_TAX_ID: 'hash', IPV4: 'allow' },
  hmacKey: 'a fixed key, so hashes are stable across restarts',
  dictionary: { names: ['Anna Schmidt'] },
});

const { text, findings } = session.redact(input);
// … send `text` somewhere …
const back = session.restore(text);
```

Also exported: `detect`, `createDetectors` and every individual detector;
`isValidIban`, `luhnValid`, `isValidGermanTaxId` and friends; `redactJson` and
`restoreJson` for structured bodies; `StreamRehydrator` and `SseRehydrator`; the
audit writer, the streaming trail reader (`readTrailEntries`), the verifier
(`verifyTrailFile`, `ChainVerifier`) and the report builder (`ReportBuilder`);
the residency registry and policy engine; the tenant registry; the metrics
registry.

## 10. Detection: what it catches, and what it does not

hushgate is a deterministic detector, not a model. It is very good at
identifiers that carry their own proof, and structurally incapable of
recognising personal data that looks like ordinary prose.

`hushgate scan` over [`examples/ticket.txt`](examples/ticket.txt), whose last
line contains an IBAN, a card number and a tax ID that are all *shaped* right
but fail their checksums:

```console
$ hushgate scan -c examples/demo.config.json examples/ticket.txt
examples/ticket.txt
  1:8   NAME           An••••••dt  → pseudonymize
  1:27  DATE_OF_BIRTH  14••••••87  → pseudonymize
  2:8   EMAIL          an••••••le  → pseudonymize
  3:8   PHONE          03••••••45  → pseudonymize
  4:8   IBAN           DE••••••00  → pseudonymize
  5:8   CREDIT_CARD    41••••••11  → pseudonymize
  6:12  GERMAN_TAX_ID  86••••••19  → pseudonymize
  7:8   IPV4           10•••••.7  → pseudonymize
  7:24  MAC            00••••••2a  → pseudonymize
  8:8   EMPLOYEE_ID    EM•••••19  → pseudonymize
  8:44  TERM           Pr••••••ht  → pseudonymize

11 findings in 1 file: CREDIT_CARD 1, DATE_OF_BIRTH 1, EMAIL 1, EMPLOYEE_ID 1, GERMAN_TAX_ID 1, IBAN 1, IPV4 1, MAC 1, NAME 1, PHONE 1, TERM 1
```

Nothing in that file belongs to anybody. The identifiers are the published
documentation values, chosen so that they pass their checksums — which is the
whole point of the demo — without designating a real account, person or
machine: `DE89 3704 0044 0532 0130 00` is the ISO 13616 example IBAN,
`86095742719` the BZSt example Steuer-ID, `4111 1111 1111 1111` the standard
test card, `030 23125 45` a number from the block the Bundesnetzagentur
reserves for scripts and documentation, `00:00:5e:00:53:2a` from the range
RFC 7042 reserves for documentation, and `10.14.2.7` is RFC 1918 private space.

Values are masked by default (`An••••••dt`), so scan output is safe to paste
into a ticket; `--show-values` opts out. Run the invalid line on its own to see
what the checksums did:

```console
$ sed -n 9p examples/ticket.txt | hushgate check -c examples/demo.config.json
Nicht echt: DE89 3704 0044 0532 0130 01, 4111 1111 1111 1112, 86095742718
hushgate: nothing to redact
```

All three failed their check and were rejected, so all three passed through as
written. Nor does another detector claim their digits. `0044 0532 0130 01` on
its own is a well-formed international number in the `00` form, and early
versions pseudonymised it here as `PHONE`; but its groups carry on in both
directions, and a phone number is no longer cut out of the middle of a longer
run of digits.

Where a check is genuinely ambiguous, hushgate's bias is the other way: **it
prefers a false positive to a leak.** A pseudonymised phone number that was
never a phone number costs the model a little context; the opposite mistake
costs you a transfer.

What it does **not** do:

- **Names in free text.** `NAME` comes from your dictionary. hushgate will not
  work out that "Frau Özdemir from purchasing" is a person. Add the names you
  care about, or accept that free-text names go through. What it *will* do,
  once `redaction.detectors.dictionary.fuzzy` is on, is see through the spelling
  of a name you did add: a dropped letter, a swapped pair, `Mueller` for
  `Müller`, `Mustermann, Max` for `Max Mustermann`. It is off by default because
  it walks the entry list per candidate token — affordable for one tenant's
  address book, not for every request on a shared event loop.
- **A street with nothing around it.** A street detector *does* ship, and it
  reads `Kaiserstraße 12, 76133 Karlsruhe`. What it will not read is a bare
  `Lindenweg 5` with no postcode and no label: `-weg`, `-platz` and `-gasse` are
  the endings of *Radweg*, *Parkplatz* and *Sackgasse*, so the weak suffixes
  need corroboration and the strong ones (`-straße`, `-allee`, `-chaussee`) do
  not. The English word order — `12 Kaiserstraße` — needs a postcode behind it,
  because bare it is indistinguishable from a numbered list.
- **A lone account number.** `BANK_ACCOUNT` needs the bank code beside the
  Kontonummer or a label in front of it. Six to ten bare digits is the shape of
  every order number in German business correspondence, so an unaccompanied
  `532013000` goes through. `redaction.detectors.bankAccount.accountLabels`
  adds the word your own forms use.
- **Article 9 data that has no format.** Two kinds of it now do have one and
  are read: ICD-10 diagnosis codes and the names of prescribed drugs. The rest
  is prose, and prose is where a deterministic detector ends. *Mitglied der SPD*
  differs from *Mitglied der Feuerwehr* by no arithmetic — ethnic origin,
  political opinion, religion, union membership, sexual orientation and the
  biometric blob all need a curated term list and a false-positive budget, or a
  semantic layer. A dictionary or a custom rule catches the terms you name;
  nothing catches the general case.
- **Anything inside images.** There is no OCR, so a photograph or a scanned
  page has no text hushgate can read. It is refused rather than forwarded —
  see §4 — but refusing it is all hushgate can do.
- **Every way an extractor can mangle a document.** The checks in §4 catch a
  document that is fragmented throughout, and — by asking whether closing up
  the spacing reveals an identifier that was not visible before — a passage of
  shredding inside an otherwise clean page. That covers what real extractors do:
  ordinary PDF kerning, and every invisible or blank-rendering separator
  measured against it.

  Two limits are worth naming. The check can only miss what the detectors would
  have missed anyway — an identifier hushgate does not recognise in the first
  place, such as a street address, is not one it can notice the loss of. And it
  closes up *spacing*, not line breaks: an extractor that broke an address
  across a line every few characters would defeat it. Line breaks are left
  alone deliberately, because the alternative refuses invoices with a narrow
  column of figures, which is the document this is most often pointed at.
- **Re-identification by combination.** Removing the name does not stop
  "the customer in Ravensburg who ordered the ZX-40 on Tuesday" from being
  exactly one person. Pseudonymisation is not anonymisation.
- **Cross-restart placeholder stability.** Pseudonyms are per session by design,
  so `[EMAIL_1]` in yesterday's audit trail means nothing today. `hash` is the
  policy for stable, comparable, irreversible identifiers.

## 11. Is this legally sufficient?

No — and any tool that claims otherwise is selling something.

Precisely what hushgate does, in the terms the question is usually asked in:

- It is a **technical and organisational measure** in the sense of Art. 32 GDPR,
  and it implements **pseudonymisation** in the sense of Art. 4(5).
- Data it replaces with a placeholder is not transmitted to the provider. To the
  extent a request contains only pseudonymised content after hushgate has run,
  what reaches the provider is data from which the individual cannot be
  identified without the mapping — and the mapping never leaves your machine.
- It produces evidence: a hash-chained record of which categories were
  processed, in what volume, sent where, under which recorded legal basis.

What it does not do:

- Pseudonymised data remains **personal data** under Recital 26. Sending it to a
  third country is still a transfer and still needs a legal basis under
  Chapter V. hushgate reduces what is transferred; it does not remove the
  question.
- It cannot assess your provider contracts, your DPA, your SCCs, your transfer
  impact assessment, or whether the controller's purpose is lawful in the first
  place.
- Its jurisdiction registry records what operators publicly document. It is a
  starting point for a transfer impact assessment, not the conclusion of one,
  which is why every `residency.allow` entry is required to carry a
  `legalBasis` written by you.
- Detection is best-effort (§10). A control that catches most personal data is
  not a guarantee that none escaped.

hushgate is a technical control that supports compliance. It is not legal
advice, and it does not by itself make any transfer lawful. Have your DPO review
the configuration, and treat `hushgate residency` and `hushgate audit report` as
inputs to that review rather than as its conclusion.

## 12. Deployment

**Read this before the first `docker compose up`:** hushgate refuses to bind a
non-loopback address while no tenant exists — by design, so it cannot become an
open relay on the network. The Docker image binds `0.0.0.0` so the port can be
published, and a freshly `init`-ed config has its `tenants` key commented out.
The container therefore exits at startup, and `restart: unless-stopped` turns
that into a crash loop until you have run `hushgate keys new` and pasted the
tenant block into the config.

```sh
hushgate init                 # the compose file mounts ./hushgate.config.json read-only
hushgate keys new default     # paste the printed "tenants" block into that file
docker compose up --build
```

The middle step is not optional — see the warning above.

The image is multi-stage and runs as a non-root user, with a `HEALTHCHECK` on
`/healthz` that uses `fetch` rather than adding curl to the image. Because
hushgate has no runtime dependencies, the final layer is Node plus the compiled
output and nothing else — no package manager, no build toolchain, no transitive
supply chain to audit. The compose service publishes the port on loopback only,
runs read-only with all capabilities dropped and `no-new-privileges`, takes
provider credentials from the environment rather than the config file, and keeps
the audit trail in a named volume so it outlives the container.

[`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) is a Deployment, Service,
ConfigMap and Secret with resource limits, liveness and readiness probes on
`/healthz`, and a hardened `securityContext`: `runAsNonRoot`, read-only root
filesystem, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
`RuntimeDefault`.

Put `hushgate doctor` in the pipeline. It validates the configuration, resolves
the residency policy, verifies every audit trail and exits non-zero on anything
unsafe — including `warn` mode left switched on:

```console
$ hushgate doctor
hushgate doctor

configuration
  note  no hushgate.config.json found; running on built-in defaults
        → run "hushgate init" to write one
briefing
  ok    the model is briefed on the placeholders when a request carries any
residency
  warn  no residency allowlist is configured, so any upstream is permitted
        → list the endpoints you have assessed in residency.allow, each with its legal basis
  note  upstreams.openai → api.openai.com [US, third-country] via residency.allow (empty)
  note  upstreams.anthropic → api.anthropic.com [US, third-country] via residency.allow (empty)
security
  ok    bound to 127.0.0.1, so only this machine can reach it
attachments
  ok    attachment handling is on
  note  extractor pdftotext is configured but is not on PATH, so application/pdf, pdf will be refused
        → install it with "apt install poppler-utils" or "brew install poppler"
audit
  note  no trail at /home/you/hushgate/hushgate-audit.jsonl yet; it is written on the first request

1 warning. Fix it, or re-run with --allow-warnings to accept it.

$ echo $?
1
```

Once the policy is real, it goes quiet:

```console
$ hushgate doctor -c examples/demo.config.json
hushgate doctor

configuration
  ok    config file /home/you/hushgate/examples/demo.config.json
briefing
  ok    the model is briefed on the placeholders when a request carries any
residency
  ok    upstreams.openai → 127.0.0.1 [LOCAL, local] via residency.allow[0]
  ok    upstreams.anthropic → 127.0.0.1 [LOCAL, local] via residency.allow[0]
security
  ok    bound to 127.0.0.1, so only this machine can reach it
attachments
  ok    attachment handling is on
  note  extractor pdftotext is configured but is not on PATH, so application/pdf, pdf will be refused
        → install it with "apt install poppler-utils" or "brew install poppler"
audit
  ok    trail /home/you/hushgate/examples/hushgate-audit.jsonl: 3 record(s), chain intact, head 5531e6c715d8f4e7d6e5cbccd20c1e1005db9e8be9264073398ea37560c81b2f

Nothing unsafe found.
```

The `audit` section covers every trail `serve` would write — the global one
and each tenant's `audit.path`, resolved against the working directory the way
`serve` resolves them, once per file. For each it checks that `serve` could
open it for writing, and fails if it could not, since `serve` would then refuse
to start. A trail that does not exist yet is a note; one that exists and cannot
be read, a broken chain or an unreadable line is a failure; records the writer
could not write are a warning. The head is printed in full, because it is what
you anchor.

Operational behaviour: a graceful shutdown that lets requests in flight finish
and writes their records, a body-size limit, an upstream timeout, and retries
with full-jitter exponential backoff for failures that happened *before* a
response arrived. A response is never retried, whatever its status — a 429
with a `retry-after` belongs to the caller, and quietly resending a request the
provider has already seen and charged for would be worse than the error.

## 13. Development

```sh
npm install
npm run lint     # oxlint, warnings are errors
npm run build    # tsc, ESM output to dist/
npm test         # vitest
```

`npm run typecheck` also type-checks the tests, which the build config excludes.
`npm run check:docs` verifies that the banner is well-formed SVG within the
constraints GitHub's sanitiser imposes, and that every relative link in every
Markdown file here resolves — including the heading it points at.
`npm run verify:package` checks what npm would publish: that the tarball carries
the compiled output and not the sources, and that the `bin` entry actually runs.

1000 tests across 36 files, and **none of them touch the network**. Every proxy
test runs against a fake upstream bound to `127.0.0.1` that records exactly what
hushgate sent — which is the only way to assert the actual claim. CI proves the
suite is offline by running it a second time with `HTTP_PROXY` and `HTTPS_PROXY`
pointed at a closed port.

CI is a matrix over Node 20, 22 and 24: install, lint, typecheck, build, test,
then the no-network run.

Before opening a change, read [CONTRIBUTING.md](CONTRIBUTING.md). Report
vulnerabilities privately per [SECURITY.md](SECURITY.md); participation is
governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Notable changes are
recorded in [CHANGELOG.md](CHANGELOG.md).

## 14. License

hushgate is **source-available**, not open source. It is licensed under the
[Business Source License 1.1](LICENSE) — the standard, unmodified BUSL text,
the same one used by MariaDB, Terraform and Materialize, with only the
Parameters filled in.

What follows is a summary, written to be read. The [LICENSE](LICENSE) file is
the thing that governs; where this summary and the licence differ, the licence
wins.

**Copying, modifying, forking, redistributing and every non-production use are
free for everyone, at any size.** That is the BUSL grant itself, and neither of
the two production conditions below touches it. Those rights do carry the
licence's own conditions, though: every copy and derivative work remains subject
to the BUSL, and you must conspicuously display the licence on each original or
modified copy. Evaluation,
development, staging, CI, a security review, a proof of concept against real
traffic captures — none of that is production use. No licence, no registration,
nothing to phone home to.

**Production use is free when both of these hold.**

**(a) You are within the size grant** — any one of:

- your organisation has **10 or fewer** individuals; or
- you are an individual using hushgate personally, not on behalf of an
  organisation; or
- you are a **non-profit, a registered charity or an accredited educational
  institution**, whatever your headcount (still subject to (b)).

*How the 10 are counted.* One each, regardless of hours worked: every employee,
officer, independent contractor, freelancer, intern, working student,
apprentice, and every individual supplied to you by a staffing or
temporary-employment agency. Non-executive directors and shareholders who do no
work for the organisation are not counted. "Your organisation" is your legal
entity plus everything under common control with it. The count is taken **on
the first day of each calendar quarter**, and if it first goes above 10 the free
grant keeps running for a further **90 days** from that date, so you have a
quarter to buy a licence or to stop.

**(b) You are not offering hushgate to third parties** — that is, your use does
not include offering hushgate, or a product or service that includes or is
derived from it, to third parties as a **hosted, managed or embedded commercial
offering**. This one ignores headcount: a two-person company selling a managed
hushgate instance needs a licence.

**What (b) does *not* catch.** The licence says so explicitly, and it matters:

- **your own employees and independent contractors are not "third parties"** —
  running one hushgate for your own people is not an offering;
- **running hushgate for your organisation's own internal purposes** is not an
  offering;
- **using hushgate as an internal component of a product whose value to your
  customers does not consist substantially of hushgate's functionality** is not
  an offering either.

So a SaaS that puts hushgate in its own request path to sanitise its own LLM
calls is not offering hushgate to anybody, however many customers that SaaS
has — only its headcount is in question. Selling "PII filtering, powered by
hushgate" as the thing the customer is buying is the case (b) exists for.

**Needs a commercial licence:** production use by an organisation over the size
grant, and any offering under (b).
[COMMERCIAL.md](COMMERCIAL.md) works the concrete cases through one by one — a
40-person company using it internally, a small company embedding it in its own
product, a 6-person agency, a hosting provider, a university, a freelancer —
and says what to put in the mail. Or write directly: **jo_becker@mailbox.org**.

**It turns into open source by itself.** Four years after a version is
published, that version converts automatically and permanently to the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).
Nothing needs to be renegotiated for that to happen; it is in the licence.

Contributions are taken under the [DCO](DCO) — see
[CONTRIBUTING.md](CONTRIBUTING.md).

Copyright © 2026 [Johan Becker](https://johanbecker.com). The licence covers the code; "hushgate" and its
logo are trade marks and are not licensed with it — see
[TRADEMARKS.md](TRADEMARKS.md).
