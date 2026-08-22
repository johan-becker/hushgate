![hushgate banner](docs/assets/banner.svg)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
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

I built it for the situation a European team keeps hitting: the models they
want are operated in the United States, and the data they would like to send is
not allowed to go there. hushgate is the technical half of the answer — the
half you can point an auditor at. It has zero runtime dependencies, makes no
network calls of its own beyond the upstream you configure, and its 613 tests
pass with the cable pulled out.

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

```sh
npm install -g hushgate
hushgate init          # write a commented starter config
hushgate doctor        # check it; non-zero exit on anything unsafe
hushgate serve
```

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
hushgate 0.1.0 listening on http://127.0.0.1:8787
  config     /Users/johan/Projects/hushgate/examples/demo.config.json
  upstreams  openai     http://127.0.0.1:9099
             anthropic  http://127.0.0.1:9099
  policy     pseudonymize by default; overrides: SECRET=block
  audit      examples/hushgate-audit.jsonl
  tenants    none — single tenant, no key required (loopback only)
  routes     POST /v1/chat/completions, POST /v1/messages, GET /healthz

  Point your SDK at this address:
    OPENAI_BASE_URL=http://127.0.0.1:8787/v1
    ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

Send a ticket through it:

```sh
curl -sS http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer sk-not-a-real-key' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [
      { "role": "system", "content": "Du bist die Support-Assistenz von Projekt Nordlicht." },
      { "role": "user", "content": "Anna Schmidt (anna.schmidt@nordlicht.example, +49 721 9876543) hat die Rechnung nicht bezahlt. Bitte erinnere sie und buche auf DE89 3704 0044 0532 0130 00." }
    ]
  }'
```

The upstream logged exactly this request body:

```json
{"model":"gpt-4o-mini","messages":[{"role":"system","content":"Du bist die Support-Assistenz von [TERM_1]."},{"role":"user","content":"[NAME_1] ([EMAIL_1], [PHONE_1]) hat die Rechnung nicht bezahlt. Bitte erinnere sie und buche auf [IBAN_1]."}]}
```

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

## 4. Streaming

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
whole address at once. §7 explains why that can never stall.

## 5. Data residency

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
| `warn` | Forward unchanged, record what went out. For a staged rollout only. |
| `allow` | Forward unchanged, nothing recorded. |

Where a provider publishes a retention or training opt-out that can be set per
request, hushgate attaches it automatically from the same registry — for example
`store: false` on OpenAI. Controls that can only be arranged with the provider,
an account setting or a contract clause, are reported rather than faked; with
`residency.requireDataControls` set, an upstream that offers none refuses to
start.

## 6. The audit trail

Every request appends one JSONL record: timestamp, route, outcome, latency,
upstream, the count of findings per category, the policy applied to each, and
the residency verdict. **No values.** Each record carries the SHA-256 of the
previous one, so the file is a hash chain.

```json
{"ts":"2026-08-22T13:38:08.770Z","id":"762ad117-0b70-44aa-94e5-eac925bcc186","tenant":null,"route":"openai.chat.completions","outcome":"forwarded","status":200,"latencyMs":11,"stream":false,"upstream":"127.0.0.1:9099","tokens":64,"findings":{"TERM":1,"NAME":1,"EMAIL":1,"PHONE":1,"IBAN":1},"policies":{"TERM":"pseudonymize","NAME":"pseudonymize","EMAIL":"pseudonymize","PHONE":"pseudonymize","IBAN":"pseudonymize"},"residency":{"mode":"sanitize","rule":"residency.mode","jurisdiction":"LOCAL","controls":[]},"prev":"0000000000000000000000000000000000000000000000000000000000000000","hash":"2312b6fa2e68bb599f047cebc085b9fdfce24515c95a4ca87cadca75d7090e97"}
```

`hushgate audit verify` walks the chain:

```console
$ hushgate audit verify -c examples/demo.config.json
audit trail /Users/johan/Projects/hushgate/examples/hushgate-audit.jsonl
  records      3
  chain        intact
  head         4c993591f4aafb94a78c17916e7ec9597dcad2994f0bbd789591e582ace94ba3

Anchor the head hash outside hushgate (a ticket, a signed note, another
system) if you also need to detect records being dropped from the end.
```

Change a single field of a single record — here `latencyMs` from 1 to 9 — and it
reports exactly where the chain broke:

```console
$ sed 's/"latencyMs":1,/"latencyMs":9,/' examples/hushgate-audit.jsonl > examples/tampered.jsonl
$ hushgate audit verify --file examples/tampered.jsonl
audit trail /Users/johan/Projects/hushgate/examples/tampered.jsonl
  records      3
  chain        BROKEN
  first break  record 2 (altered)
  id           40b0475c-5249-46b6-a377-c4d3b887782a
  timestamp    2026-08-22T13:38:18.568Z
  detail       record hash is 928dbdd71a24…, but its contents hash to e4b57c228f1b…

Everything before that record still verifies. Everything from it onwards
has been altered, or had records inserted or removed.

$ echo $?
1
```

`hushgate audit report` turns the same file into an Article 30 style record of
processing activities, in Markdown or JSON:

```console
$ hushgate audit report -c examples/demo.config.json
# Record of processing activities

_Article 30 style summary, generated by hushgate from its own audit trail._

- **Generated**: 2026-08-22T13:38:36.679Z
- **Source**: /Users/johan/Projects/hushgate/examples/hushgate-audit.jsonl
- **Period**: beginning → end (records from 2026-08-22T13:38:08.770Z to 2026-08-22T13:38:18.622Z)
- **Controller**: Nordlicht GmbH
- **Contact**: datenschutz@nordlicht.example
- **Data protection officer**: A. Datenschutz
- **Audit chain**: intact over 3 records (head 4c993591f4aa…)

## Purposes of processing

- Drafting customer support replies

## Volumes

- Requests: **3**
- Tokens reported by providers: **64**
- Outcomes: blocked 1, forwarded 2
- Routes: openai.chat.completions 3
- Residency enforcement: n/a 1, sanitize 2

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
| 127.0.0.1:9099 | Your own infrastructure (LOCAL) | no transfer | 2 | 64 | Processing on our own hardware; no transfer occurs. |

### Controls applied to outbound requests

- 127.0.0.1:9099: none set per request

## Technical measures

Personal data detected in outbound requests is replaced with pseudonymous
placeholders before the request leaves the machine, and restored in the
response. The audit trail records categories and counts only; it contains no
personal data itself, by construction.

---

This document is generated from a technical control. It supports a record of
processing activities; it is not legal advice and does not by itself make any
transfer lawful.
```

## 7. How it works

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
| `GERMAN_TAX_ID` | ISO 7064 MOD 11,10 check digit **and** the digit-frequency rule: within the first ten digits exactly one digit repeats — twice, or three times — and no more. Both must hold. |
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
(`SECRET` 100 > `URL_CREDENTIALS` 95 > `IBAN` 90 > `CREDIT_CARD` 85 >
`GERMAN_TAX_ID` 80 > `EMAIL` 75 > … > dictionary 40).

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
findings      : NAME=pseudonymize EMAIL=pseudonymize LITERAL=pseudonymize GERMAN_TAX_ID=hash
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

Four times the input, four times the work — which is what the
`does not degrade super-linearly` test guards on every CI run. A typical chat
request sits in the first row of that table, against a network round trip
measured in hundreds of milliseconds.

## 8. Reference

### Commands

| Command | Purpose |
| --- | --- |
| `hushgate init [--path <p>] [--force]` | Write a commented starter `hushgate.config.json`. |
| `hushgate serve [options]` | Run the redacting proxy in the foreground. |
| `hushgate scan [--json] [--show-values] [-q] <file...>` | Find personal data in files. Exits 3 when it finds any. |
| `hushgate check [-q]` | Redact standard input to standard output, for piping. |
| `hushgate residency [--json] [--registry]` | Where each route sends data, and on whose authority. |
| `hushgate doctor [--json] [--allow-warnings]` | Validate config, residency and audit chain. For CI. |
| `hushgate audit verify [--file <p>] [--json]` | Walk the hash chain, report the first break. |
| `hushgate audit report [--from <d>] [--to <d>] [--json]` | Article 30 style record of processing. |
| `hushgate keys new <tenant-id>` / `hushgate keys hash` | Mint a tenant key, or hash an existing one. |
| `hushgate help [command]`, `hushgate version` | Help, and the version. |

`serve` additionally takes `-H/--host`, `-p/--port`, `--upstream-openai`,
`--upstream-anthropic`, `--audit <path>` and `--no-audit`. Every command except
`init` and `keys` takes `-c/--config`.

| Exit code | Meaning |
| ---: | --- |
| 0 | Success. |
| 1 | Failure — a broken chain, a `doctor` finding, a refused configuration. |
| 2 | Usage error. |
| 3 | `hushgate scan` found personal data. |

### HTTP surface

| Method and path | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible. Redacted outbound, re-hydrated inbound, streaming or not. |
| `POST /v1/messages` | Anthropic-compatible, same treatment. |
| `GET /healthz` | `{"status":"ok","version":"…"}`. |
| `GET /metrics` | Prometheus text exposition. |

```console
$ curl -sS http://127.0.0.1:8787/metrics
# HELP hushgate_build_info Version of the running hushgate.
# TYPE hushgate_build_info gauge
hushgate_build_info{version="0.1.0"} 1
# HELP hushgate_requests_total Requests handled, by route, outcome and tenant.
# TYPE hushgate_requests_total counter
hushgate_requests_total{outcome="blocked",route="openai.chat.completions",status="403",tenant="none"} 1
hushgate_requests_total{outcome="forwarded",route="openai.chat.completions",status="200",tenant="none"} 2
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
# HELP hushgate_upstream_tokens_total Tokens reported by upstream providers.
# TYPE hushgate_upstream_tokens_total counter
hushgate_upstream_tokens_total{route="openai.chat.completions",tenant="none"} 64
# HELP hushgate_request_duration_seconds Time from request received to response finished.
# TYPE hushgate_request_duration_seconds histogram
...
```

### Policies

| Policy | Effect | Reversible |
| --- | --- | --- |
| `pseudonymize` | `[EMAIL_1]` — stable within the session. The default. | yes |
| `redact` | `[EMAIL_REDACTED]` — the value is gone. | no |
| `hash` | `[EMAIL:9f86d081ab2c]` — HMAC-SHA256, stable, comparable. | no |
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
| `redaction.hmacKey` | random per process | Fix it to make `hash` stable across restarts. |
| `redaction.dobYearRange` | 1900 → this year − 13 | Plausible birth years. |
| `limits.maxBodyBytes` | 4 MiB | Larger requests are refused. |
| `limits.upstreamTimeoutMs` | 120000 | Upstream request timeout. |
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
`HUSHGATE_UPSTREAM_TIMEOUT_MS`, `HUSHGATE_AUDIT_PATH`, `HUSHGATE_AUDIT`,
`HUSHGATE_RESIDENCY_MODE`. A full annotated file is in
[`hushgate.config.example.json`](hushgate.config.example.json).

### Multi-tenant operation

Each tenant gets its own policy profile, its own pseudonym namespace, its own
audit stream and its own quotas. A placeholder minted for one tenant cannot be
resolved by another, and there is a test that asserts exactly that. hushgate
refuses to bind a non-loopback address until at least one tenant exists, so it
cannot become an open relay on the LAN.

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

Add `quotas` (`requestsPerMinute`, `tokensPerDay`), `audit.path` and a
`redaction` block to the tenant entry to give it its own limits, stream and
policy profile. Over-quota callers get a 429.

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
audit log and chain verifier; the residency registry and policy engine; the
tenant registry; the metrics registry.

## 9. Detection: what it catches, and what it does not

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
  3:8   PHONE          07••••••43  → pseudonymize
  4:8   IBAN           DE••••••00  → pseudonymize
  5:8   CREDIT_CARD    41••••••11  → pseudonymize
  6:12  GERMAN_TAX_ID  86••••••19  → pseudonymize
  7:8   IPV4           10•••••.7  → pseudonymize
  7:24  MAC            3c••••••04  → pseudonymize
  8:8   EMPLOYEE_ID    EM•••••19  → pseudonymize
  8:44  TERM           Pr••••••ht  → pseudonymize
  9:23  PHONE          00••••••01  → pseudonymize

12 findings in 1 file: CREDIT_CARD 1, DATE_OF_BIRTH 1, EMAIL 1, EMPLOYEE_ID 1, GERMAN_TAX_ID 1, IBAN 1, IPV4 1, MAC 1, NAME 1, PHONE 2, TERM 1
```

Values are masked by default (`An••••••dt`), so scan output is safe to paste
into a ticket; `--show-values` opts out. Run the invalid line on its own to see
what the checksums did:

```console
$ echo 'Ungueltig: DE89 3704 0044 0532 0130 01, 4111 1111 1111 1112, 86095742718' | hushgate check -c examples/demo.config.json
Ungueltig: DE89 3704 [PHONE_1], 4111 1111 1111 1112, 86095742718
hushgate: redacted 1 finding (PHONE 1)
```

The card and the tax ID were rejected outright and passed through untouched, and
so was the IBAN — but part of its digits were then claimed by a different
detector. `0044 0532 0130 01` really is a well-formed international number in the
`00` form: country code 44, thirteen subscriber digits. That is a false positive,
and it is the honest illustration of hushgate's bias: **it prefers a false
positive to a leak.** A pseudonymised phone number that was never a phone number
costs the model a little context; the opposite mistake costs you a transfer.

What it does **not** do:

- **Names in free text.** `NAME` comes from your dictionary. hushgate will not
  work out that "Frau Özdemir from purchasing" is a person. Add the names you
  care about, or accept that free-text names go through.
- **Addresses.** No street or postcode detector ships. Use `redaction.custom`
  if your data has a regular shape.
- **Health, religion, union membership and the other Article 9 special
  categories.** They are prose. A dictionary or a custom rule can catch known
  terms; nothing catches the general case.
- **Anything inside images.** Image content parts are skipped by design.
- **Re-identification by combination.** Removing the name does not stop
  "the customer in Ravensburg who ordered the ZX-40 on Tuesday" from being
  exactly one person. Pseudonymisation is not anonymisation.
- **Cross-restart placeholder stability.** Pseudonyms are per session by design,
  so `[EMAIL_1]` in yesterday's audit trail means nothing today. `hash` is the
  policy for stable, comparable, irreversible identifiers.

## 10. Is this legally sufficient?

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
- Detection is best-effort (§9). A control that catches most personal data is
  not a guarantee that none escaped.

hushgate is a technical control that supports compliance. It is not legal
advice, and it does not by itself make any transfer lawful. Have your DPO review
the configuration, and treat `hushgate residency` and `hushgate audit report` as
inputs to that review rather than as its conclusion.

## 11. Deployment

```sh
docker compose up
```

The image is multi-stage and runs as a non-root user, with a `HEALTHCHECK` on
`/healthz` that uses `fetch` rather than adding curl to the image. Because
hushgate has no runtime dependencies, the final layer is Node plus the compiled
output and nothing else — no package manager, no build toolchain, no transitive
supply chain to audit.

[`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) is a Deployment, Service,
ConfigMap and Secret with resource limits, liveness and readiness probes on
`/healthz`, and a hardened `securityContext`: `runAsNonRoot`, read-only root
filesystem, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp
`RuntimeDefault`.

Put `hushgate doctor` in the pipeline. It validates the configuration, resolves
the residency policy, verifies the audit chain and exits non-zero on anything
unsafe — including `warn` mode left switched on:

```console
$ hushgate doctor
hushgate doctor

configuration
  note  no hushgate.config.json found; running on built-in defaults
        → run "hushgate init" to write one
residency
  warn  no residency allowlist is configured, so any upstream is permitted
        → list the endpoints you have assessed in residency.allow, each with its legal basis
  note  upstreams.openai → api.openai.com [US, third-country] via residency.allow (empty)
  note  upstreams.anthropic → api.anthropic.com [US, third-country] via residency.allow (empty)
security
  ok    bound to 127.0.0.1, so only this machine can reach it
audit
  note  no trail at /Users/johan/Projects/hushgate/hushgate-audit.jsonl yet; it is written on the first request

1 warning. Fix them, or re-run with --allow-warnings to accept the warnings.

$ echo $?
1
```

Once the policy is real, it goes quiet:

```console
$ hushgate doctor -c examples/demo.config.json
hushgate doctor

configuration
  ok    config file /Users/johan/Projects/hushgate/examples/demo.config.json
residency
  ok    upstreams.openai → 127.0.0.1 [LOCAL, local] via residency.allow[0]
  ok    upstreams.anthropic → 127.0.0.1 [LOCAL, local] via residency.allow[0]
security
  ok    bound to 127.0.0.1, so only this machine can reach it
audit
  ok    /Users/johan/Projects/hushgate/examples/hushgate-audit.jsonl: 3 record(s), chain intact, head 4c993591f4aa…

Nothing unsafe found.
```

Operational behaviour: graceful shutdown, a body-size limit, an upstream
timeout, and retries with full-jitter exponential backoff for failures that
happened *before* a response arrived. A response is never retried, whatever its
status — a 429 with a `retry-after` belongs to the caller, and quietly resending
a request the provider has already seen and charged for would be worse than the
error.

## 12. Development

```sh
npm install
npm run lint     # oxlint, warnings are errors
npm run build    # tsc, ESM output to dist/
npm test         # vitest
```

`npm run typecheck` also type-checks the tests, which the build config excludes.
`npm run verify:package` checks what npm would publish: that the tarball carries
the compiled output and not the sources, and that the `bin` entry actually runs.

613 tests across 29 files, and **none of them touch the network**. Every proxy
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

## 13. License


hushgate is **source-available**, not open source.

It is licensed under the [Business Source License 1.1](LICENSE) — the same
unmodified licence text used by MariaDB, Terraform and Materialize.

**Free, no licence needed:**

- any non-production use, at any company size — evaluation, development, testing, CI;
- production use by an organisation of **10 or fewer** people (employees and
  contractors, counted across affiliates);
- production use by an individual, personally;
- production use by non-profits, registered charities and accredited educational
  institutions.

**Needs a commercial licence:** production use by a larger organisation, and any
offering of hushgate to third parties on a hosted, managed, embedded or resold
basis. See [COMMERCIAL.md](COMMERCIAL.md) or mail **jo_becker@mailbox.org**.

**It becomes open source on its own.** Four years after each version is
published, that version converts automatically to the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).

Copyright © 2026 Johan Becker. "hushgate" is a trade mark — see
[TRADEMARKS.md](TRADEMARKS.md).
