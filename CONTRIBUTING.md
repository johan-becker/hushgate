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
npm run check:docs # banner well-formedness, and every relative link resolves
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

## 6. Contributor terms

hushgate is source-available under the [Business Source License 1.1](LICENSE),
and commercial licences are sold for the cases the licence's Additional Use
Grant does not cover (see [COMMERCIAL.md](COMMERCIAL.md)). That has two
consequences for anything you contribute, and both are stated here rather than
buried in a click-through.

**Sign off every commit.** Contributions are accepted under the
[Developer Certificate of Origin 1.1](DCO) — the Linux Foundation's DCO,
verbatim, kept in this repository as [`DCO`](DCO). There is no CLA form to
fill in. Sign off with:

```sh
git commit -s -m "fix: keep the trailing guard off a sentence-final IBAN"
```

which appends the line the DCO asks for:

```
Signed-off-by: Jane Doe <jane@example.com>
```

Use your real name and an address that reaches you. By signing off you certify
the DCO: that the work is yours to submit, or that you have the right to submit
it under this project's licence. A pull request whose commits are not signed
off cannot be merged — `git rebase --signoff` fixes an existing branch.

**Your contribution is licensed for both outbound licences.** By submitting a
contribution you agree that it is licensed under the Business Source License
1.1 on the same terms as the rest of hushgate, **and** you grant Johan Becker a
perpetual, worldwide, non-exclusive, irrevocable, royalty-free right to
license, sublicense and distribute that contribution under any commercial
licence offered for hushgate, and under the Change License (the Apache License,
Version 2.0) when the Change Date arrives. Without that grant a contributed
line could not be included in a commercial licence, which would mean it could
not be merged at all.

**You keep your copyright.** This is a licence grant, not an assignment.
Nothing here takes your work away from you or stops you using it elsewhere; it
lets hushgate ship it under the two licences hushgate ships under.

If you would rather not agree to that — a perfectly reasonable position — open
an issue describing the change instead. A precise bug report with a
reproduction is worth as much as a patch here, and it carries no paperwork at
all. Issues, reproductions, benchmarks, detector test vectors and documentation
corrections are all welcome on those terms.

The project name is a separate matter: see [TRADEMARKS.md](TRADEMARKS.md).
