# Changelog

All notable changes to hushgate are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things in hushgate are treated as public contract and will not change
without a major version: the placeholder grammar `[KIND_n]`, and the shape of
an audit record. A change to either would silently invalidate the audit chains
and the re-hydration mappings that already exist.

## [Unreleased]

### Added

- **Attachment pseudonymisation.** A PDF, Word file, spreadsheet, presentation,
  e-mail or HTML document in a request is turned into text, the text is
  pseudonymised by the existing detector pipeline, and the document itself
  never reaches the provider. This closes a gap rather than only adding a
  feature: `messages[].content[]` attachments were forwarded byte for byte
  before, because the redaction layer selects the leaves that carry prose and a
  base64 document is not one.
- `attachments.onUnreadable` decides what happens to a document whose text
  hushgate could not read — a scan with no text layer, an encrypted file, a
  photograph, a remote URL it will not fetch. The default is `block`: the
  request is refused with **422** and nothing leaves the machine. `withhold`
  drops the file and forwards the rest; `forward` sends the original bytes and
  is reported as unsafe by `hushgate doctor`.
- Extraction is trusted only after it is checked. An extractor that "succeeds"
  on a scanned page — `pdftotext` exits 0 and prints one form feed — is caught
  by floors on characters overall and per page, on replacement characters, on
  control characters, and on the share of one- and two-letter words. That last
  check guards the failure that actually leaks: text shredded into
  `johan.beck er@klinik.de` is forwarded and matches no detector, whereas text
  merely dropped is text hushgate never forwards either.
- PDF is extracted by an operator-configured external command rather than
  in-process. The document is piped to its standard input, nothing derived from
  the request reaches its arguments, no temporary file is written, and the child
  runs with a minimal environment rather than hushgate's — which holds the
  provider API key. The Docker image now installs `poppler-utils`, so PDFs work
  there with no configuration.
- `hushgate extract <file>` prints the text a document would be sent as, with
  and without pseudonymisation, offline and without an upstream.
- `hushgate scan` reads documents, so a folder of contracts can be checked for
  what it holds before any of it goes near a model.
- Audit records carry one entry per attachment: format, media type, size,
  characters extracted, pages, which extractor answered, the outcome, and the
  reason. Never the filename — `Kuendigung_Anna_Schmidt.pdf` is personal data,
  and the trail is the one place hushgate must not write it down. The Article 30
  report gains an **Attachments** section that counts, in particular, any
  document forwarded without being read.
- `hushgate_attachments_total` and `hushgate_attachment_bytes_total` metrics,
  labelled by format, outcome and extractor.

### Changed

- `limits.maxBodyBytes` now defaults to **16 MiB**, up from 4 MiB. Base64
  inflates a document by a third, and the old cap refused most real attachments
  before an extractor could look at them. Set it back explicitly if the old
  ceiling was load-bearing for you.
- The Docker runtime image installs one distribution package, `poppler-utils`.
  The npm package still has zero runtime dependencies.

### Fixed

- A slowloris connection is now reaped. Node's own `requestTimeout` and
  `headersTimeout` do not close a socket that drips a header byte every few
  seconds or one that simply goes idle after connecting — verified against a
  bare-Node control — so a handful of such connections could hold the proxy's
  sockets open indefinitely (**H1**, denial of service). A phase-tracking
  sweeper, one unref'd interval for the whole server that is never restamped
  by incoming bytes, now bounds how long a connection may stay idle or in its
  receiving phase. The serving phase stays unbounded, because cutting off a
  request while its model thinks is worse than waiting for it. New
  `limits.idleTimeoutMs` (default 60 s) and `HUSHGATE_IDLE_TIMEOUT_MS` set the
  bound.
- A malformed JSON body no longer leaks into logs. `JSON.parse` error messages
  quote the offending input verbatim, so a 400 response — and stderr via the
  error handler — echoed whatever bytes the caller had sent, personal data
  included (**M2**, log leakage). The 400 body and the log line now carry only
  the parse position.
- A typo'd residency rule can no longer be silently unenforced. Keys in
  `residency.routes` and `residency.categories` are validated at config load
  against the routes hushgate serves and the finding kinds it detects; an
  unknown key is a startup error with the nearest known key suggested rather
  than a rule that matches nothing and protects nothing (**M3**, silent no-op).
- Detection runs over a normalised copy of the text as well as the original.
  A zero-width space inside an e-mail address, a full-width letter, a
  decomposed umlaut: each previously matched no detector, left the machine
  verbatim, and produced an audit record saying nothing was found (**M1**,
  complete detector bypass by invisible or decomposed Unicode). Every detector
  now takes a second pass over a copy with invisible characters dropped and
  NFKC applied per combining cluster, with findings mapped back onto exact
  original offsets so rehydration hands back the bytes the caller wrote.
  Pure-ASCII input skips the second pass behind a one-scan guard, leaving the
  hot path at its old cost.
- Custom detector patterns are analysed for catastrophic backtracking before
  they are accepted. A custom regex runs synchronously on the event loop every
  request shares, so `(a+)+$` against 28 bytes froze the whole proxy — every
  tenant with it — for 37 seconds in the audit's proof of concept (**H2**,
  ReDoS). Config load now rejects quantifiers over ambiguous subpatterns,
  overlapping alternations under quantifiers, backreferences, and constructs
  the analysis does not model, naming the offending group. The analysis
  deliberately over-refuses: a refused pattern gets an error at startup, an
  accepted one would get an outage with no name at all.

- Anthropic **custom content documents** were never redacted. A
  `{"type":"document","source":{"type":"content","content":[…]}}` block — the
  shape the Messages API documents for citations — carries its text at
  `messages[].content[].source.content[].text`, and no rule in
  `ANTHROPIC_MESSAGES_RULES` reached it, so the whole document body was
  forwarded to the provider byte for byte while the audit record showed
  `findings: {}`. This predates the attachment work and applies to any caller
  using citations. Two rules now cover it, and the attachment stage extracts
  such a document rather than walking past it.
- `hushgate scan` now exits 1, not 0, when a file it was asked to scan could
  not be read. Reporting "no personal data found" about a file nothing ever
  read is the wrong answer, and in a CI gate it is the dangerous one.

- The plain-language licence summaries in [`README.md`](README.md) §13,
  [`COMMERCIAL.md`](COMMERCIAL.md) and this file described a licence stricter
  than the one in [`LICENSE`](LICENSE). They said production use was forbidden
  on a "resold" basis, which the Additional Use Grant does not say and could
  not say without restricting a right the BUSL Terms grant outright; and they
  omitted the grant's carve-out that your own employees and contractors are not
  third parties and that internal use — including hushgate as an internal
  component of a product whose value is not substantially hushgate's
  functionality — is not an offering to third parties. They also omitted the
  90-day grace period, the headcount rules and the quarterly counting date.
  If you read those summaries and concluded you needed a commercial licence,
  read them again: the licence itself never changed.
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

Released under the [Business Source License 1.1](LICENSE). This is the licence
hushgate has carried from its first published version; there is no earlier
version under different terms.

### Added

#### Licensing

- [`LICENSE`](LICENSE) — the standard, unmodified BUSL 1.1 text with only the
  Parameters filled in. Copying, modifying, redistributing and non-production
  use are free at any size and are not limited by the Additional Use Grant's
  conditions. Production use is free for organisations of 10 or fewer
  individuals (counted on the first day of each calendar quarter, with a
  90-day grace period on first exceeding 10), for individuals personally, and
  for non-profits, registered charities and accredited educational institutions
  regardless of headcount — in every case provided the work is not offered to
  third parties as a hosted, managed or embedded commercial offering. Your own
  employees and contractors are not third parties, and internal use — including
  hushgate as an internal component of a product whose value is not
  substantially hushgate's functionality — is not such an offering. Anything
  beyond that needs a commercial licence. Each published version converts
  automatically to the Apache License, Version 2.0 four years after it is
  published.
- [`COMMERCIAL.md`](COMMERCIAL.md) — who needs a commercial licence, with
  worked examples, what to send to jo_becker@mailbox.org, and the statement
  that evaluation is always free.
- [`TRADEMARKS.md`](TRADEMARKS.md) — the name and logo are unregistered trade
  marks of Johan Becker and are not licensed by the code licence. Nominative
  use ("uses hushgate", "a fork of hushgate") is fine; shipping something
  *under* the name is not.
- [`DCO`](DCO) — the Developer Certificate of Origin 1.1, verbatim.
  [`CONTRIBUTING.md`](CONTRIBUTING.md) §6 requires a `Signed-off-by` line and
  states the grant that lets a contribution be licensed under both the BUSL and
  a commercial licence. Contributors keep their copyright.

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
