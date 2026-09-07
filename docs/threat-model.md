# Threat model

This document states what hushgate defends against, what it has already been
attacked with, and — just as deliberately — what it does not cover. It is
written to be pointed at: every claim in the first two sections was exercised
during an external audit (52 individual attacks across seven adversarial
batteries against live proxy instances), and the third section lists the limits
the same audit measured rather than guessed at.

hushgate's position is narrow on purpose: **the personal data never reaches the
provider in the first place.** Everything below follows from that one sentence.

## What hushgate defends

These were verified by attack, not by reading the code and hoping.

### Session and placeholder integrity

The mapping from placeholder back to real value is the crown jewel; it exists
only inside the process that issued it. Twelve attacks aimed at it, twelve came
back defended:

- An attacker-planted `[EMAIL_1]` literal in model output cannot capture a real
  placeholder's substitution.
- Placeholders the session never issued stream through verbatim — an attacker
  cannot mint substitutions by inventing placeholder shapes.
- Placeholder-shaped JSON object keys are never rewritten.
- The hash policy is stable within a session but salted per session, so tokens
  cannot be correlated across sessions without a key.
- A 5000-deep nested-array traversal bomb raises `TraversalDepthError` instead
  of exhausting the stack; 2000 findings in a single leaf resolve in about a
  second.

### The HTTP layer

- Credential smuggling fails closed: `cookie`, a second `x-api-key`,
  `proxy-authorization`, and unknown auth headers are all stripped before
  forwarding. Only the environment-sourced upstream key reaches the provider.
- Path tricks — `//`, `%2f`, `/../`, case changes, trailing slashes, query
  strings — bypass neither routing nor redaction.
- Oversized bodies are refused with 413; malformed ones are refused without
  echoing body content.
- A gzipped request body gets a 400, not a silent forward past the detectors.
- `/metrics` requires a key in multi-tenant mode and contains no PII values.

### Streaming (SSE)

Seven attacks, seven handled. A placeholder split across SSE events — even mid-
token — rehydrates correctly. A UTF-8 emoji split mid-codepoint across TCP
chunks arrives intact. An unterminated event larger than 256 KiB aborts with
`UpstreamError` rather than buffering forever. A stream that ends without
`[DONE]` still flushes its held bytes. And a client aborting mid-stream tears
down the upstream connection too, so an abandoned request does not keep burning
paid tokens.

### Tenant isolation

In multi-tenant mode, verified under concurrency: twelve simultaneous requests
against a limit of three admit exactly three — no TOCTOU window, nine clean
429s with a numeric `Retry-After`. Hash-policy tokens are stable for the same
tenant and value, and *different* across tenants — there is no cross-tenant
linkability. Tenant audit files receive only their own tenant's records, and no
audit file anywhere holds raw PII. Duplicate `Authorization` headers resolve
first-wins, so there is no second header for an attacker to ride.

### Residency enforcement

Under `block` mode the upstream sees zero bytes when PII is present — measured
on a fake upstream whose hit counter stayed at 0. Refusals name the deciding
rule and never echo the personal data itself. Category-scoped rules block only
their category; route-scoped modes apply per route; and block mode refuses PII
even toward an allow-listed endpoint that declares controls. Startup fails
closed if an allow-listed upstream declares no data controls where the config
requires them.

### Metrics label injection

Even injecting a hostile tenant id containing quotes and newlines through the
programmatic API — bypassing the config-file charset check entirely — cannot
forge a new line in the Prometheus exposition. `escapeValue` neutralises quote,
backslash and newline.

## What is now fixed

The audit found real gaps. They are closed:

| Gap | Was | Now |
| --- | --- | --- |
| Slow-connection DoS (H1) | `requestTimeoutMs` did not reap slow-drip or idle sockets on current Node — a handful of curl one-liners could exhaust file descriptors and take down every tenant behind the proxy | an idle-socket sweeper destroys connections that go quiet, regardless of header/body progress |
| ReDoS in custom detectors (H2) | an operator-supplied `(a+)+$` pattern froze the event loop 37.7 s on a **28-character** body — one config line, every tenant down | patterns are validated at config load; catastrophic constructions are rejected before they can run |
| JSON snippet leak (M2) | V8's parse-error message embedded ~10 characters of the *unredacted* request body into 400 responses and server stderr — logs being a processing system under GDPR | parse failures respond and log a fixed message with position only; no source snippet leaves the parser |
| Residency key validation (M3) | a typo'd key like `categories: {phone: …}` parsed fine and silently disabled the rule — silent no-op is the worst failure mode a security setting has | unknown category kinds and route labels are rejected at config load |
| Unicode normalisation (M1) | NFC/NFD mismatches meant a configured name missed decomposed text and vice versa — in both directions | detectors run over a normalised scan copy of the text, with findings mapped back onto original offsets so rehydration stays exact |

## Honest residual limits

A threat model that only lists wins is marketing. These limits are measured,
not hypothetical:

- **Audit trail tail truncation.** The sha256-chained JSONL trail detects any
  in-place edit. Deleting the last N lines is invisible to it — there is
  nothing after the cut to disagree with. If tamper-evidence against the
  operator matters to you, anchor the chain head externally (a timestamping
  service, or a daily signed head emitted by `audit verify`). hushgate alone
  cannot prove its own trail is complete.
- **`tokensPerDay` overshoot.** The daily token quota is enforced on the request
  *after* the one that crosses it, so the worst case per tenant is budget plus
  one full upstream response — measured: budget 20/day, replies claiming 8
  tokens each spent 24 before the refusal. Concurrent in-flight requests admit
  together before any of their counts land, multiplying the overshoot further.
  Treat the quota as a circuit breaker, not a metering system.
- **Gzip from upstream (L2).** hushgate requests `accept-encoding: identity`.
  A provider responding gzip anyway would have the header stripped but the
  compressed bytes forwarded — corrupt data downstream, not a PII event. Real
  providers do not do this; magic-byte detection returning 502 is the planned
  hardening.
- **Written-out dates and culture-specific phone formats.** `born on March 12,
  1985`, `12.03.85`, US national-format phone numbers — these pass the
  detectors untouched. Detection is shaped around the formats European teams
  actually exchange; coverage is not universal and never will be claimed to be.
- **Backreference-bearing regexes are refused, not analysed.** Custom patterns
  are validated for catastrophic behaviour at load; a pattern using constructs
  the analyser cannot reason about is rejected outright rather than admitted
  with a shrug. That is fail-closed, which is correct, but it means some
  legitimate patterns need rewriting before hushgate accepts them.

## Threat actors considered

- **Curious cloud provider ops.** The primary adversary. hushgate's answer is
  structural: the provider receives `[EMAIL_1]`, and the mapping exists only in
  your process on your machine. There is nothing in the outgoing bytes to be
  curious about.
- **Malicious co-tenant.** Another holder of a hushgate key in multi-tenant
  mode. Cannot read other tenants' traffic, correlate their hash tokens across
  tenants, ride a second auth header, or forge metrics lines. Their quotas
  bound them; their audit records stay in their own file, valueless.
- **Network attacker.** Between caller and proxy or between proxy and provider.
  Credential smuggling, path traversal, chunked-encoding tricks, slowloris,
  oversized bodies — all refused or bounded, most verified under live attack.
  Transport encryption between you and the provider is the provider's TLS;
  loopback callers need none.
- **Hostile client.** A buggy or malicious SDK sending garbage, planted
  placeholders, unicode tricks, or documents designed to shred. Garbage is
  refused without echoing it back; planted placeholders are inert; unreadable
  documents are withheld or refused rather than forwarded; shredded text is
  detected by closing the spacing and refusing when that reveals more than the
  gaps did. What remains open against this actor is detector evasion via exotic
  spellings — see the residual limits above.
