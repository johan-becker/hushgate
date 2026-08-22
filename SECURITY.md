# Security Policy

hushgate handles personal data by design. A running instance holds the mapping
from placeholder back to real value, terminates requests carrying that data,
and writes an audit trail that is meant to be trustworthy. A vulnerability here
has consequences beyond the process.

## Supported versions

| Version | Security support |
| --- | --- |
| `0.1.x` | Supported. |
| Older commits and branches | Not supported. |

Fixes are developed against the latest `main` and released as a patch version.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion** for a suspected
vulnerability.

1. Preferred: open a private report through
   [GitHub Security Advisories](https://github.com/johan-becker/hushgate/security/advisories/new).
2. Or e-mail [jo_becker@mailbox.org](mailto:jo_becker@mailbox.org) with the
   subject `SECURITY hushgate`.

Please include the version or commit, a reproduction, and the impact you
believe it has. You will get an acknowledgement within seven days and an
assessment within fourteen. If a fix is warranted I will agree a disclosure
date with you; credit is given unless you ask me not to.

**Never include real personal data in a report.** If a reproduction needs a
value, construct a synthetic one — the test suite is full of examples, and
`hushgate scan` masks values by default for exactly this reason.

## In scope

- Personal data reaching an upstream that a configured policy should have
  removed or blocked.
- Any way to recover a real value from a placeholder without access to the
  session that issued it, including across tenants.
- Forging, replaying or truncating an audit chain such that
  `hushgate audit verify` still reports it intact.
- Bypassing residency enforcement, or making a fail-closed configuration start.
- Tenant authentication bypass, quota bypass, or one tenant reading another's
  audit stream.
- Request smuggling, SSE injection, resource exhaustion via crafted bodies, and
  catastrophic backtracking in a detector pattern.

## Out of scope

- Weak detection coverage in itself. hushgate cannot recognise personal data
  that has no structure, and [README §9](README.md#9-detection-what-it-catches-and-what-it-does-not)
  says so. A *systematic* miss of something a detector claims to validate is a
  bug — report it as an ordinary issue.
- Anything requiring write access to the configuration file or the audit trail
  on the host. Both are trusted inputs.
- Reports about the upstream provider's own handling of the data it receives.

## Deployment boundary

hushgate binds `127.0.0.1` by default, does not terminate TLS, and refuses to
bind any other address until at least one tenant is configured — an unauthenticated
listener on a LAN would be a relay for the very mapping the tool exists to
protect. Put it behind TLS termination you control.

The audit trail and any tenant key hashes are secrets in the operational sense:
the trail reveals request metadata even though it never contains values. Store
them accordingly. `HUSHGATE_HMAC_KEY`, when set, is the key that makes `hash`
policy output stable across restarts, and it is what makes those hashes
correlatable — treat it as a secret and rotate it deliberately.
