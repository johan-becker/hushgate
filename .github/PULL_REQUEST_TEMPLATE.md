## What this changes

<!-- One paragraph. What was wrong or missing, and what this does about it. -->

## Why

<!-- The reasoning. Link the issue if there is one. -->

## How it was verified

<!--
Not "tests pass" — say what you actually ran and what it showed. Paste output
where it makes the case.
-->

```
npm run lint && npm run build && npm test
```

## Checklist

- [ ] Every commit is signed off (`git commit -s`) under the
      [DCO](../DCO); see [CONTRIBUTING.md](../CONTRIBUTING.md) §6 for the
      contributor terms, including the grant that lets a contribution ship
      under both the BUSL and a commercial licence.
- [ ] `npm run lint && npm run build && npm test` passes locally.
- [ ] New behaviour has tests that assert on behaviour, not on calls.
- [ ] No runtime dependency was added. hushgate imports from `node:` only.
- [ ] No test reaches the network.
- [ ] No user value can end up in the audit trail.
- [ ] `CHANGELOG.md` has an entry under `Unreleased`, if behaviour changed.

## Contract

Tick anything this touches, and say how it was handled in the section above.

- [ ] The placeholder grammar `[KIND_n]`
- [ ] The shape of an audit record
- [ ] Streaming re-hydration buffering
- [ ] Detector priorities or overlap resolution
- [ ] The residency endpoint registry (give a source for each entry)
- [ ] README output — re-run the commands and paste the new transcripts
