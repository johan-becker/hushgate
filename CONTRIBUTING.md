# Contributing to hushgate

hushgate sits on the path between an application and a cloud LLM API and
decides what is allowed to leave the machine. A bug here is not a rendering
glitch; it is personal data on someone else's infrastructure. Changes are
reviewed with that in mind.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Security-sensitive findings follow the private process in
[SECURITY.md](SECURITY.md), never a public issue.

## 1. Build, test, lint

```sh
npm install
npm run lint       # oxlint; warnings are errors
npm run build      # tsc, ESM output to dist/
npm test           # vitest
npm run typecheck  # type-checks the tests too, which the build config excludes
```

That whole chain must pass before a pull request is opened, and CI runs it on
Node 20, 22 and 24.

## 2. Rules the codebase does not bend on

**Zero runtime dependencies.** hushgate imports from `node:` and nothing else.
This is a feature people choose the tool for: the deployable artefact is Node
plus compiled output, with no transitive supply chain to audit. A pull request
that adds a runtime dependency will be declined regardless of how convenient
the library is. Development dependencies — TypeScript, vitest, oxlint — are
fine.

**No network in tests, ever.** Every proxy test runs against a fake upstream
bound to `127.0.0.1` that records exactly what hushgate sent. CI runs the suite
a second time with `HTTP_PROXY` and `HTTPS_PROXY` pointed at a closed port
specifically to catch a test that started reaching out. If your change needs an
external service, it needs an interface and a fake instead.

**No values in the audit trail.** Audit records carry categories, counts,
policy decisions and timing. They must never carry the data itself, and there
is a test asserting it. A field that could contain user content does not go in.

**Detectors validate.** A new detector for something that has a checksum, a
check digit or a structural rule must implement it and must have tests for the
inputs that look right and are not. A regex that matches the shape is not a
detector; it is a false-positive generator.

**No stubs.** Nothing lands half-finished. If a capability is documented, it
works end to end.

## 3. Changes that need extra care

| Area | Why, and what to do about it |
| --- | --- |
| Placeholder grammar | `[KIND_n]` is public contract. Changing it invalidates every mapping and every audit trail in existence. Major version only. |
| Audit record shape | Adding a field is fine, but the hash covers the record; removing or renaming breaks existing chains. Say so explicitly in the pull request. |
| Streaming re-hydration | The buffering rules are load-bearing and subtle. Any change here needs tests at every byte offset, across event boundaries, and at end of stream. |
| Residency registry | Entries record what an operator publicly documents. Add a source in the pull request description. Do not guess a jurisdiction — `UNKNOWN` is a legitimate answer and is handled. |
| Overlap resolution | Priorities interact. Changing one means re-checking the ties it participates in. |

## 4. Tests

Tests are real assertions on real behaviour. A test that only checks a function
was called is not a test.

- Detector changes: cover the valid case, the shape-valid-but-checksum-invalid
  case, and the boundary (length limits, separators, adjacency to other text).
- Redaction changes: cover the round trip, and cover input that already
  contains a placeholder-looking string.
- Proxy changes: drive them through the fake upstream and assert on what the
  upstream received, not only on what the client got back.
- Streaming changes: split the stream, and split it in the awkward place.

## 5. Commits and pull requests

Conventional commit subjects in the imperative mood — `feat:`, `fix:`,
`test:`, `docs:`, `ci:`, `refactor:`, `chore:` — with a body that says *why*
whenever the change deserves one. One logical change per commit.

A pull request should state what changed, why, and how it was verified. If it
touches anything in §3, say which and how you handled it. If it changes
observable behaviour, add a `CHANGELOG.md` entry under `Unreleased`.

If output in the README would change because of your work, re-run the command
and paste the new output. Every transcript in that file is real, and it stays
that way — [`examples/`](examples) exists so you can reproduce them offline.
