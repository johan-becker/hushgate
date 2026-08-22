# hushgate

**Nothing personal leaves the machine.**

hushgate is a local-first PII firewall that sits between your application and a
cloud LLM API. Point your existing OpenAI or Anthropic SDK at hushgate instead
of the real endpoint: it detects personal data in the outgoing request, swaps it
for stable pseudonymous placeholders, forwards the sanitised request upstream,
and re-hydrates the placeholders in the response so your application sees the
real values back. The provider never receives the personal data.

- Zero runtime dependencies. Node 20+, TypeScript, ESM.
- Deterministic detection with real checksums — no model, no network, no
  telemetry.
- Streaming-safe: placeholders are restored even when they arrive split across
  SSE chunks or across separate events.
- Data residency enforcement: a declarative allowlist of permitted upstreams,
  fail-closed at startup, with an offline registry of EU-hosted alternatives.
- Multi-tenant: per-team keys, policy profiles, pseudonym namespaces, audit
  streams and quotas.
- A tamper-evident append-only audit trail that records categories and counts,
  never values, and an Article 30 style report generated from it.
- Ships to run: hardened Docker and Kubernetes manifests, Prometheus metrics,
  and a `doctor` command that fails your pipeline on an unsafe configuration.

## The migration is one line

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

Or without touching the code at all:

```sh
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

Your API key is passed through untouched; hushgate never stores it.

## Quick start

```sh
npm install -g hushgate
hushgate serve
```

```text
hushgate 0.1.0 listening on http://127.0.0.1:8787
  config     built-in defaults (no hushgate.config.json found)
  upstreams  openai     https://api.openai.com
             anthropic  https://api.anthropic.com
  policy     pseudonymize by default; overrides: none
  audit      hushgate-audit.jsonl
  routes     POST /v1/chat/completions, POST /v1/messages, GET /healthz
```

What the provider receives:

```jsonc
// your application sent
{ "messages": [{ "role": "user", "content": "Schreib an johan@example.com, IBAN DE89 3704 0044 0532 0130 00" }] }

// api.openai.com received
{ "messages": [{ "role": "user", "content": "Schreib an [EMAIL_1], IBAN [IBAN_1]" }] }

// your application got back
{ "choices": [{ "message": { "content": "Ich habe johan@example.com zur IBAN DE89 3704 0044 0532 0130 00 geschrieben." } }] }
```

## How it works

```text
your app ──▶ hushgate ──▶ provider
             │  detect      sees only
             │  redact      [EMAIL_1]
             ▼
          audit.jsonl (counts, never values)

provider ──▶ hushgate ──▶ your app
                restore     sees
                            johan@example.com
```

1. **Traverse.** The request body is parsed and walked, not regex-scanned.
   Chat messages in both content shapes, system prompts, tool-call arguments and
   tool schemas are visited; model names, tool ids and parameters are not.
2. **Detect.** Every detector validates rather than pattern-matches: IBANs by
   mod-97, cards by Luhn, German tax IDs by ISO 7064 MOD 11,10 *and* the
   digit-frequency rule. Overlaps resolve deterministically — longest match
   wins, ties by detector priority.
3. **Apply policy.** Per kind: `pseudonymize`, `redact`, `hash`, `allow`,
   `block`.
4. **Forward.** Only known headers travel upstream. Your API key does; your
   cookies do not.
5. **Re-hydrate.** Responses are restored structurally, and event streams are
   restored incrementally without buffering.

### Detectors

| Kind | Validated by |
| --- | --- |
| `EMAIL` | structural validation of local and domain parts |
| `IBAN` | mod-97 checksum plus per-country length (DE, AT, CH, FR, NL, ES, IT and more) |
| `CREDIT_CARD` | Luhn checksum plus issuer prefix |
| `PHONE` | E.164 and German formats (`+49…`, `0049…`, `0721/…`, spaced, slashed, hyphenated) |
| `IPV4`, `IPV6`, `MAC` | octet ranges, `::` compression, MAC separators |
| `GERMAN_TAX_ID` | ISO 7064 MOD 11,10 check digit and the digit-frequency rule |
| `SECRET` | `sk-`, `sk-ant-`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, AWS `AKIA`/`ASIA`, Google `AIza`, Slack `xox[baprs]-`, JWTs, PEM private keys |
| `URL_CREDENTIALS` | `scheme://user:pass@host` |
| `DATE_OF_BIRTH` | real calendar dates in a plausible birth-year window |
| `NAME`, `TERM` | your dictionary: case-insensitive, whole-word, longest match wins |
| *your own* | named regexes from the config file |

A digit run that looks like an IBAN but fails its checksum is not an IBAN, and
hushgate says so rather than redacting it — false positives cost the model the
context it needs to be useful.

### Policies

| Policy | Effect | Reversible |
| --- | --- | --- |
| `pseudonymize` | `[EMAIL_1]` — stable within the request | yes |
| `redact` | `[EMAIL_REDACTED]` | no |
| `hash` | `[EMAIL:9f86d081ab2c]` — HMAC-SHA256, stable across requests with a fixed key | no |
| `allow` | left untouched | — |
| `block` | the whole request is refused with 403 before anything is sent | — |

Placeholders are stable within a request: the same value always gets the same
token, two different values never share one, and a token hushgate issues can
never collide with placeholder-shaped text that was already in your input.

### Streaming

A model does not emit `[EMAIL_1]` in one piece. It arrives as `[`, `EMAIL`,
`_1`, `]` in four separate SSE events, and each of those can be cut in half by
the network. hushgate holds back only the trailing bytes that could still become
a placeholder — never more than one token's worth — and releases them the
instant they resolve or are ruled out. If a stream ends mid-token, the partial
text is still delivered. Comments, event names and ids pass through unchanged.

## Configuration

`hushgate.config.json` in the working directory, or `--config <path>`. Every key
is optional; unknown keys are an error rather than a shrug.

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "upstreams": {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com"
  },
  "redaction": {
    "defaultPolicy": "pseudonymize",
    "policies": {
      "SECRET": "block",
      "IPV4": "allow",
      "GERMAN_TAX_ID": "hash"
    },
    "dictionary": {
      "names": ["Anna Schmidt", "Johan Becker"],
      "terms": ["Projekt Nordlicht"]
    },
    "custom": [
      { "name": "employee id", "pattern": "EMP-\\d{5}" }
    ],
    "dobYearRange": { "minYear": 1900, "maxYear": 2012 }
  },
  "limits": {
    "maxBodyBytes": 4194304,
    "upstreamTimeoutMs": 120000,
    "requestTimeoutMs": 60000,
    "upstreamRetries": 2,
    "retryBackoffMs": 250
  },
  "audit": {
    "enabled": true,
    "path": "hushgate-audit.jsonl"
  },
  "organisation": {
    "name": "Acme GmbH",
    "contact": "datenschutz@acme.example",
    "purposes": ["Drafting customer support replies"]
  }
}
```

Two more blocks have chapters of their own: [`residency`](#data-residency) and
[`tenants`](#multi-tenant-operation). Comments are allowed — `hushgate init`
writes a fully commented starter file.

Environment variables override the file, and command-line flags override both:

| Variable | Effect |
| --- | --- |
| `HUSHGATE_HOST`, `HUSHGATE_PORT` | bind address and port |
| `HUSHGATE_UPSTREAM_OPENAI`, `HUSHGATE_UPSTREAM_ANTHROPIC` | upstream base URLs |
| `HUSHGATE_DEFAULT_POLICY` | policy for kinds without an entry |
| `HUSHGATE_HMAC_KEY` | key for the `hash` policy (prefer this over the file) |
| `HUSHGATE_MAX_BODY_BYTES`, `HUSHGATE_UPSTREAM_TIMEOUT_MS` | limits |
| `HUSHGATE_AUDIT`, `HUSHGATE_AUDIT_PATH` | audit trail on/off and location |
| `HUSHGATE_RESIDENCY_MODE` | enforcement mode: `block`, `sanitize`, `warn`, `allow` |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | upstream credentials, used once a tenant has authenticated |

hushgate binds to `127.0.0.1` by default. It holds the mapping from placeholders
back to real personal data, so an accidental `0.0.0.0` is an incident, not a
convenience.

## CLI

```sh
hushgate serve [--config <path>] [--port <n>] [--host <h>]
               [--upstream-openai <url>] [--upstream-anthropic <url>]
               [--audit <path>] [--no-audit]

hushgate scan [--json] [--show-values] [--quiet] <file...>
hushgate check [--quiet] < input > output
hushgate residency [--json] [--registry]
hushgate keys new <tenant-id> | hushgate keys hash < key
hushgate audit verify [--file <path>] [--json]
hushgate audit report [--from <date>] [--to <date>] [--json]
hushgate init [--path <path>] [--force]
hushgate doctor [--json] [--allow-warnings]
```

`scan` is built for CI — it exits **3** when it finds personal data:

```console
$ hushgate scan fixtures/*.json
fixtures/customer.json
  12:14  EMAIL  jo••••••om  → pseudonymize
  18:3   IBAN   DE••••••00  → pseudonymize

2 findings in 1 file: EMAIL 1, IBAN 1
```

Previews are masked because CI logs are not a place to publish an IBAN; pass
`--show-values` when you are looking at your own terminal.

`check` is the Unix half:

```sh
cat notes.md | hushgate check > safe.md
```

Exit codes: `0` success, `1` failure, `2` usage, `3` `scan` found personal data.

## Data residency

The reason this project exists. You declare which upstreams are permitted, why,
and what should happen to personal data bound for each of them — and hushgate
refuses to start if the configuration does not match.

```json
{
  "upstreams": {
    "openai": "https://api.mistral.ai",
    "anthropic": "https://api.aleph-alpha.com"
  },
  "residency": {
    "mode": "sanitize",
    "routes": { "anthropic.messages": "warn" },
    "categories": { "GERMAN_TAX_ID": "block", "SECRET": "block" },
    "requireDataControls": true,
    "allow": [
      {
        "endpoint": "https://api.mistral.ai",
        "jurisdiction": "FR",
        "legalBasis": "Art. 28 DPA signed 2026-01-12; processing in France"
      },
      {
        "endpoint": "https://api.aleph-alpha.com",
        "jurisdiction": "DE",
        "legalBasis": "Art. 28 DPA signed 2025-11-03; processing in Germany"
      }
    ]
  }
}
```

**Fail-closed.** If an upstream is not on the allowlist, hushgate does not start
and tells you which rule refused it:

```console
$ hushgate serve
hushgate: configuration error
  residency policy refuses this configuration:
    upstreams.openai → https://api.openai.com is not on the residency allowlist [residency.allow]
```

An empty `residency.allow` means "unrestricted", and every report says so out
loud, because unrestricted is a finding in its own right.

**Enforcement modes**, resolved by specificity — a category rule beats a route
rule beats the global mode, and the strictest category wins when several apply:

| Mode | Effect |
| --- | --- |
| `block` | refuse the request, naming the rule; nothing is sent |
| `sanitize` | remove the personal data, then forward (default) |
| `warn` | forward unchanged and record what went out — for staged rollout |
| `allow` | forward unchanged |

**The registry.** An offline index of well-known endpoints and where they run:
the US defaults, Azure, every Bedrock region, and the EU-hosted alternatives —
Mistral (FR), Aleph Alpha (DE), IONOS (DE), OVHcloud (FR), Scaleway (FR) — plus
local runtimes such as Ollama and vLLM. Data only: no lookups, no network.
Extend or override it with `residency.endpoints`.

```console
$ hushgate residency --registry
```

Azure resolves to `UNKNOWN` on purpose: a custom subdomain does not reveal the
resource region, and guessing would be worse than asking. Declare it in
`residency.allow`, which is authoritative over the registry anyway.

**Retention and training controls.** Where a provider exposes an opt-out as a
header or a body field, hushgate sets it on every request — `store: false` for
OpenAI — overriding a caller who set it otherwise. Where it is an account
setting or a contract clause it is reported rather than pretended, and
`requireDataControls` (implied by `block` mode) refuses to start against an
endpoint that documents nothing at all.

**The report for your DPO.**

```console
$ hushgate residency
hushgate residency
  config       /srv/hushgate/hushgate.config.json

  route        openai.chat.completions  (POST /v1/chat/completions)
  upstream     https://api.mistral.ai
  endpoint     Mistral AI — La Plateforme — Mistral AI SAS
  jurisdiction FR — France [eea]
               Inside the EU/EEA: no third-country transfer under GDPR Chapter V.
  rule         residency.allow[0]
  legal basis  Art. 28 DPA signed 2026-01-12; processing in France
  enforcement  sanitize  (residency.mode)
  controls     no-training (contract) [arranged with the provider]
  verdict      PERMITTED — permitted by residency.allow[0]: Art. 28 DPA signed 2026-01-12; processing in France

2 of 2 routes permitted.
```

It exits non-zero when a route is refused, so it doubles as a CI check.
`--json` gives the same content for machines.

## Multi-tenant operation

One hushgate can serve several teams, departments or applications, each with its
own key, its own policy profile, its own pseudonym namespace, its own audit
stream and its own allowance.

```console
$ hushgate keys new support
tenant key for "support" — copy it now, hushgate does not store it:

  hg_Yz1r0Q8yv3fW7pC2sJhV5nT4kM6xB9dE0aL1uS3gQ7o

add this to hushgate.config.json:

  {
    "tenants": [
      {
        "id": "support",
        "name": "support",
        "keyHash": "sha256:5f2b…"
      }
    ]
  }
```

```json
{
  "tenants": [
    {
      "id": "support",
      "name": "Support desk",
      "keyHash": "sha256:5f2b…",
      "quotas": { "requestsPerMinute": 120, "tokensPerDay": 2000000 },
      "audit": { "path": "audit/support.jsonl" },
      "redaction": { "policies": { "SECRET": "block", "IBAN": "hash" } }
    },
    {
      "id": "research",
      "keyEnv": "HUSHGATE_KEY_RESEARCH",
      "upstreamKeyEnv": "OPENAI_API_KEY_RESEARCH",
      "quotas": { "requestsPerMinute": 30 }
    }
  ]
}
```

Callers send the key exactly where their SDK already sends one —
`Authorization: Bearer <key>` or `x-api-key: <key>`.

- **Only hashes are stored.** A config file ends up in a wiki, a ticket and a
  screenshot. List several in `keyHashes` to rotate without downtime; delete one
  to revoke it.
- **The tenant key never reaches the provider.** Once it has authenticated
  someone, the header carrying it is dropped and replaced with the upstream
  credential hushgate holds (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`, or the
  tenant's own `upstreamKeyEnv`).
- **Namespaces are separate.** Placeholder mappings never outlive a request, and
  each tenant's `hash` policy is keyed by a digest derived from the tenant id —
  a shared digest would let one tenant confirm another's data by guessing it.
- **Quotas return a real 429**, with a `retry-after` computed from the sliding
  minute window or from midnight UTC. Token counts come from the provider's own
  usage report, so the daily limit takes effect on the request after the one
  that crossed it. Counters are in-memory and per process.
- **hushgate refuses to be an open relay.** With no tenants defined it will only
  bind loopback; ask it to bind anything else and it stops with an explanation.
  `/healthz` stays open, because probes cannot authenticate.

## Audit trail

Append-only JSONL, one object per request, each linked to the one before it by
a SHA-256 hash chain:

```json
{"ts":"2026-03-04T09:12:44.117Z","id":"6b1c…","tenant":"support","route":"openai.chat.completions","outcome":"forwarded","status":200,"latencyMs":812,"stream":true,"tokens":1841,"upstream":"api.mistral.ai","findings":{"EMAIL":2,"IBAN":1},"policies":{"EMAIL":"pseudonymize","IBAN":"pseudonymize"},"residency":{"mode":"sanitize","rule":"residency.mode","jurisdiction":"FR","controls":["zero-retention via body store=false"]},"prev":"4f3a…","hash":"9c21…"}
```

Categories and counts, never values — the record is assembled from a fixed field
list precisely so it cannot grow one, and a test drives real personal data of
five kinds through the proxy to prove none of it lands in the file. Blocked and
rejected requests are recorded too: "nothing was sent" is exactly the fact worth
writing down.

### Verifying it

```console
$ hushgate audit verify
audit trail /srv/hushgate/hushgate-audit.jsonl
  records      12481
  chain        intact
  head         9c21f0a4…

Anchor the head hash outside hushgate (a ticket, a signed note, another
system) if you also need to detect records being dropped from the end.
```

A break is reported with the record it starts at and what kind it is — `altered`
when a record's contents no longer match its own hash, `unlinked` when something
was inserted or removed at that point. Everything before the break still
verifies. The command exits non-zero, so it works as a scheduled check.

What a self-contained chain cannot detect is truncation of the tail: dropping
the last records leaves a shorter but consistent chain. That is why the head
hash is printed.

### Reporting on it

```console
$ hushgate audit report --from 2026-03-01 --to 2026-03-31 > march.md
```

An Article 30 style record of processing: categories of personal data with the
handling each received, recipients with their jurisdiction and transfer status,
the safeguard recorded for each, and volumes by outcome, route, enforcement mode
and tenant. `--json` for a pipeline.

The parts hushgate cannot know, it does not invent. Purposes come from
`organisation.purposes`; a recipient with no legal basis on the allowlist is
printed as **none recorded**. Each report carries its own chain verification,
because a summary that cannot be checked against its source is a claim rather
than evidence.

```json
{
  "organisation": {
    "name": "Acme GmbH",
    "contact": "datenschutz@acme.example",
    "dpo": "A. Datenschutz",
    "purposes": ["Drafting customer support replies", "Summarising internal documents"]
  }
}
```

## Deployment

```console
$ docker compose up --build
```

The image is multi-stage and carries Node plus the compiled output — no package
manager, no build toolchain, and no runtime dependencies to audit. It runs as
`node`, with a read-only root filesystem, no capabilities and a healthcheck that
needs nothing the image does not already have.

```console
$ kubectl apply -f deploy/kubernetes.yaml
```

Deployment, Service, ConfigMap, Secret and a PVC for the audit trail, with
resource limits, probes on `/healthz`, `runAsNonRoot`, `readOnlyRootFilesystem`,
`allowPrivilegeEscalation: false`, all capabilities dropped and the service
account token left unmounted. Every value you must replace says `REPLACE ME`,
and a test parses the embedded config with hushgate's own parser, because a
manifest that ships a configuration the tool rejects is worse than no manifest.

One replica on purpose: each instance keeps its own hash-chained trail and its
own in-memory quota counters. Scaling out means one volume and one trail per
pod, or an aggregator — a decision to take deliberately rather than by editing a
number.

In a container hushgate binds `0.0.0.0`, which means it insists on tenants. That
refusal is the feature.

## Operations

```console
$ hushgate init      # a commented starter config
$ hushgate doctor    # everything that is unsafe about it
```

`doctor` is built to be a CI step. It resolves both upstreams against the
residency policy, looks for enforcement left loose after a rollout, notices a
hash policy with no stable key, an open relay, tenants without quotas, auditing
switched off and a broken audit chain — and every line says what to do about it.
It exits non-zero on warnings as well as failures; `--allow-warnings` is the
deliberate opt-out.

```console
$ hushgate doctor
hushgate doctor

configuration
  ok    config file /srv/hushgate/hushgate.config.json
residency
  ok    upstreams.openai → api.mistral.ai [FR, eea] via residency.allow[0]
  note  upstreams.anthropic → api.anthropic.com [US, third-country] via residency.allow[1]
enforcement
  warn  residency.mode is "warn": personal data is forwarded unchanged
        → set residency.mode to sanitize once the rollout is finished
security
  ok    2 tenant(s) defined; a key is required
audit
  ok    /srv/hushgate/hushgate-audit.jsonl: 12481 record(s), chain intact, head 9c21f0a4e1b2…

1 warning. Fix them, or re-run with --allow-warnings to accept the warnings.
```

**Metrics.** `GET /metrics` in Prometheus text format: requests by route,
outcome, status and tenant; findings by category and the policy applied;
refusals by the rule that refused them; upstream tokens; and a latency
histogram. Open on loopback, authenticated once tenants exist — point your
scraper at it with a tenant key.

```text
hushgate_requests_total{outcome="forwarded",route="openai.chat.completions",status="200",tenant="support"} 1841
hushgate_findings_total{kind="EMAIL",policy="pseudonymize"} 5122
hushgate_blocked_total{reason="residency",rule="residency.categories.GERMAN_TAX_ID"} 3
hushgate_request_duration_seconds_bucket{route="openai.chat.completions",le="2.5"} 1802
```

**Resilience.** Upstream failures that never produced a response are retried
with exponential backoff and full jitter. A response is never retried, whatever
its status: a 429 with a `retry-after` belongs to the caller, and resending a
request the provider has already seen and charged for would be worse than the
error. Request and upstream timeouts, the body-size limit and the retry budget
are all configurable under `limits`.

**Shutdown** is graceful. `SIGINT` and `SIGTERM` stop the listener, let in-flight
requests finish, and close the audit trail before the process exits.

**Configuration files may contain comments.** `hushgate init` writes them, and
the loader strips them, because the config file is where a team records *why* an
upstream is permitted.

## Is this legally sufficient?

No tool can answer that for you, and any tool that claims otherwise should be
treated with suspicion.

What hushgate does is technical and specific: it removes categories of personal
data it can detect from the payloads you send to a third-party API, it records
what it removed, and it refuses the request outright when you tell it to. Used
carefully, that is a meaningful technical measure in the sense of GDPR
Article 32, and it materially reduces what a third-country transfer under
Chapter V actually contains.

What it is not:

- It is **not legal advice**, and it does not by itself make a transfer lawful.
- It is **not a guarantee of anonymisation**. Pseudonymisation is explicitly
  still personal data under Article 4(5). Free text can identify a person
  without containing a single detectable identifier — "the deputy head of our
  Karlsruhe office who resigned last Tuesday" survives every detector here.
- It is **not a substitute** for a lawful basis, a transfer mechanism, a DPA
  with your provider, a record of processing, or a DPIA where one is required.

Treat it as one control among several, evidence it with the audit trail, and let
your DPO decide what it is worth in your specific processing context.

## Development

```sh
npm install
npm run lint
npm run build
npm test
```

Useful extras: `npm run typecheck` (the build config excludes the tests),
`npm run verify:package` (checks what npm would actually publish, and runs the
built CLI).

The test suite never touches the network: every proxy test runs against a fake
upstream bound to `127.0.0.1` on an ephemeral port.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Johan Becker.
