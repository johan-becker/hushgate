# Changelog

All notable changes to hushgate are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things in hushgate are treated as public contract and will not change
without a major version: the placeholder grammar `[KIND_n]`, and the shape of
an audit record. A change to either would silently invalidate the audit chains
and the re-hydration mappings that already exist.

## [Unreleased]

### Fixed

- A tenant's `redaction` block now merges over the global profile instead of
  replacing it. Every tenant silently lost the organisation's per-kind
  policies, name dictionary, custom rules and birth-year window — including a
  tenant with no `redaction` key at all, which is what `hushgate keys new`
  prints and what `deploy/kubernetes.yaml` ships.
- A permissive `residency.categories` rule can no longer relax a whole request.
  A kind with no rule of its own now carries the route or global mode into the
  strictness comparison, so `categories: {IPV4: "allow"}` exempts an IP address
  without also exempting the IBAN beside it.
- IPv4 addresses and German `DD.MM.YYYY` birth dates at the end of a sentence
  are found. Their trailing guards rejected a following full stop, which lost
  the value entirely rather than partially.
- Phone numbers written with the spaced German separator (`0721 / 123 456`) are
  found.
- Maestro, Dankort and the remaining Diners ranges are recognised, at the
  lengths those brands are actually issued at.
- A rejected tenant key (401) and an exhausted quota (429) now write an audit
  record and increment `hushgate_requests_total`. They previously left no trace
  anywhere.
- `resolveSpans` is linear in the input rather than quadratic in the number of
  findings; a body at the 4 MiB limit went from 217 s of blocked event loop to
  under half a second.
- Span arrays are no longer spread into `push()`, which threw `RangeError` on a
  body with more than ~124k findings.
- `QuotaTracker` prunes its sliding window for a tenant with no per-minute
  limit, which previously retained one timestamp per request forever.
- `__proto__` survives a body rewrite instead of being silently dropped.
- Metric values no longer render with a trailing decimal point.
- The EEA and adequacy jurisdiction table is complete; AT, DK, PT and 17 other
  EEA members were reported as undeclared third countries.
- `deploy/kubernetes.yaml` starts: its ConfigMap configured an upstream that
  its own residency allowlist refused.
- Usage errors exit 2 rather than 1, as the README documents.

### Added

- `limits.maxResponseBytes` (default 16 MiB, `HUSHGATE_MAX_RESPONSE_BYTES`),
  bounding the upstream response the way `maxBodyBytes` bounds the request.
  The streamed path caps a single unterminated event the same way.

## [0.1.0] — 2026-08-22

First release. The proxy, the detectors, the residency policy, the audit chain
and the CLI are complete and exercised end to end by 739 tests, none of which
touch the network.

### Added

#### Detection

- Validating detectors for `EMAIL`, `IBAN`, `CREDIT_CARD`, `PHONE`, `IPV4`,
  `IPV6`, `MAC`, `GERMAN_TAX_ID`, `SECRET`, `URL_CREDENTIALS` and
  `DATE_OF_BIRTH`. Where a value carries its own proof, it is checked: IBAN by
  ISO 7064 MOD 97-10 against a 76-country length table, cards by Luhn plus an
  issuer prefix, the German tax ID by MOD 11,10 *and* the digit-frequency rule,
  dates against the real calendar.
- Dictionary detector for `NAME` and `TERM` — case-insensitive, whole-word,
  longest match wins — and user-defined named regexes that contribute their own
  category.
- Deterministic overlap resolution: longest span wins, ties broken by detector
  priority.

#### Redaction

- `Session` with a two-way mapping, per-kind policies (`pseudonymize`,
  `redact`, `hash`, `allow`, `block`) and a `restore(redact(x)) === x`
  round-trip invariant for the reversible ones.
- Placeholder-shaped strings arriving in the input are escaped under a reserved
  `LITERAL` kind, so a caller who types `[EMAIL_1]` into a prompt can never be
  handed somebody else's value on the way back.
- Structural traversal of provider request bodies by path rules: both OpenAI
  content shapes, Anthropic `system` and content blocks, tool-call arguments
  and tool schemas. Model names and other knobs are forwarded untouched.

#### Proxy

- OpenAI-compatible `POST /v1/chat/completions`, Anthropic-compatible
  `POST /v1/messages`, `GET /healthz` and `GET /metrics` on `node:http`, with
  API-key passthrough.
- Two-layer SSE re-hydration: a byte-level re-hydrator that holds back only the
  trailing run that could still become a placeholder, and an SSE-aware layer
  that reassembles a token spread over several events, keyed per choice and per
  content block, flushing partials before `content_block_stop`, before `[DONE]`
  and at end of stream. Tested at every byte offset of a placeholder, in two-
  and three-way splits, and one character at a time.
- Graceful shutdown, body-size limit, upstream timeout, and full-jitter
  exponential backoff for failures that happened before a response arrived.
- A refusal hushgate itself decided on — a blocked category, a residency rule,
  a rejected key, an exhausted quota, an oversized body — is logged as one line
  rather than a stack trace. Only a failure nothing mapped, or an upstream one
  whose cause is the point, gets the full object.

#### Compliance

- Declarative residency policy with an allowlist that fails closed at startup
  and names the rule that refused the configuration.
- Offline registry of well-known LLM endpoints and their operating
  jurisdictions, with the retention and training controls each provider
  publishes. Data only — no lookups, user-extensible.
- Enforcement modes `block`, `sanitize`, `warn` and `allow`, globally, per
  route and per category.
- Automatic attachment of provider zero-retention and no-training controls
  where they can be set per request.
- Multi-tenant operation: per-tenant keys, policy profiles, pseudonym
  namespaces, audit streams, and request and token quotas.
- SHA-256 hash-chained append-only JSONL audit trail recording categories and
  counts, never values.

#### Tooling

- CLI with hand-rolled argument parsing: `init`, `serve`, `scan`, `check`,
  `residency`, `doctor`, `audit verify`, `audit report`, `keys`, `help` and
  `version`.
- Prometheus metrics: requests, findings by category and policy, blocks by the
  rule that refused them, upstream tokens, and a request-duration histogram.
- Multi-stage non-root Dockerfile with a `HEALTHCHECK`, a `docker-compose.yml`,
  and `deploy/kubernetes.yaml` with resource limits, probes and a hardened
  `securityContext`.
- Matrix CI over Node 20, 22 and 24 — lint, typecheck, build, test — plus a
  second test run behind a closed proxy that proves the suite needs no network,
  and a workflow that verifies the publishable artefact.

[Unreleased]: https://github.com/johan-becker/hushgate/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/johan-becker/hushgate/releases/tag/v0.1.0
