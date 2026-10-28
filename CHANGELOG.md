# Changelog

All notable changes to hushgate are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Two things in hushgate are treated as public contract and will not change
without a major version: the placeholder grammar `[KIND_n]`, and the shape of
an audit record. A change to either would silently invalidate the audit chains
and the re-hydration mappings that already exist.

## [Unreleased]

### Changed

- **The trial page shows the round trip instead of describing it.** `hushgate
  setup`'s page at `/__playground` now sets the four panes side by side in the
  order the data travels. Your text is on the left, what the provider receives
  is on the right, and the reply comes back the same way below. Real values
  are marked in your text and placeholders in the provider's. Pointing at
  either one lights up the same token in all four panes, so you can see which
  value became which placeholder and what it was turned back into. A strip
  along the top follows the request out to the provider and back. The reply
  shows what hushgate is holding back while a placeholder arrives in pieces,
  and the send line reports time to the first token, the total time and how
  many values were restored. Sample documents fill the page in one click, a
  file can be opened as well as dropped, Ctrl/⌘+Enter runs the check, and an
  edit after a check holds Send back until the text is checked again.
- **Names can be tried in the trial.** The trial has no dictionary, so it never
  replaced a personal name. Names listed in the page's "Names to replace"
  field are now sent with the check and replaced as `NAME`, as
  `redaction.dictionary.names` would replace them in production. The preview
  response also carries the offset, kind and placeholder of each replaced
  value, but not the value itself.

- **The image is tagged `hushgate:local`.** `docker-compose.yml` builds it from
  the checkout and `deploy/kubernetes.yaml` runs it, and both called it
  `hushgate:0.1.0` whatever version was checked out. Retag it for your registry
  as before.

### Fixed

- **SECURITY.md names the supported release** as the latest minor, `0.7.x`; it
  still said `0.1.x`. The README's test count is the suite's current one, 3174
  tests across 87 files.

## [0.7.0] — 2026-10-28

### Added

- **`hushgate update`.** `update --check` says whether a newer release exists
  and installs nothing; `update` installs it after asking, `--yes` without
  asking, which a script needs, and `--to <version>` installs a particular one,
  older ones included. It asks npm, through whichever registry npm is configured
  to use, and updates hushgate where npm put it: globally, or in the project
  whose `package.json` names it. A copy npm did not install, run by npx, a
  clone or the Docker image, is not touched; `update` says what updates it
  instead. It is the only command that contacts anything but the configured
  upstream, and only when run. Afterwards it says that a running `serve` keeps
  the old version until restarted, and to run `doctor`. `--check --json`
  prints `installed`, `latest`, `updateAvailable`, `installedBy` and
  `location`, for monitoring.

## [0.6.0] — 2026-10-28

### Added

- **`hushgate setup` starts what it wrote.** After writing and checking the
  configuration it asks `Start hushgate now? [Y/n]`, and Enter starts the proxy
  there and then: from nothing to a running hushgate is one command. When
  Ctrl-C stops it, it says how to start it next time. A configuration that
  `doctor` fails is not offered; the wizard says to fix what failed first.

### Changed

- **The help leads with where to start.** `hushgate` with no arguments, and
  `hushgate help`, print `Start here:  npx hushgate setup` above the command
  list, or `hushgate setup` when hushgate is on PATH.

- **The npm page links back, and shows its banner.** `package.json` names the
  repository, the homepage and the issue tracker, so npm's sidebar links to
  them and the README's relative links have somewhere to resolve; the banner is
  given by its absolute URL, since `docs/` is not in the package and npm showed
  a broken image at the top of the page. `verify:package` refuses a release
  missing either. The top of the README now says how to start, and what npm's
  own install box does: `npm i hushgate` installs into the current project,
  where hushgate runs as `npx hushgate`, and puts no `hushgate` on PATH.

### Fixed

- **`setup --path` names the file it wrote** in the command it prints.
  `hushgate serve` alone looks for `hushgate.config.json` in the working
  directory, so the hint after `setup --path config/hg.json` started hushgate
  on the built-in defaults instead; it now says
  `hushgate serve -c config/hg.json`.

## [0.5.0] — 2026-10-28

The audit trail was reviewed as what it is for — evidence that a DPO or an
external auditor relies on — and most of this release is what that review
found.

**The record gained two optional fields and nothing else**, which keeps the
contract above. `dropped` is written just before `prev`, and only when the
writer lost records; `residency.endpoint` is written as the last key of
`residency`. Every existing field keeps its name, type, position and hashing,
so trails written by earlier versions verify unchanged and are continued
without a break. A 0.4.x
`hushgate audit verify` still verifies a trail written by this release: it
hashes whatever a line holds, and simply does not know to report a gap.

### Added

- **`--anchor <hash>` checks a head kept outside hushgate.** A hash chain
  proves that nothing inside it changed; it cannot prove that nothing was cut
  off the end, because a shorter chain is still a consistent one. `audit
  verify` and `audit report` take one or more anchored heads and fail unless a
  record that verifies carries each, and say where it was found and how many
  records have been appended since. The hash a chain starts from — 64 zeros,
  or the one given to `--continues-from` — is found `at the start of the
  chain`, so the head of a trail that was still empty when it was taken
  verifies too.

- **`serve` prints where each chain stands when it starts and when it stops.**
  The banner has one line per trail — `continuing chain from …`, `starting a
  new trail`, or `last record unreadable, starting a new chain` — and shutdown
  prints each trail's head in full, followed by `(no records yet)` when it is
  still genesis, and by how many records the writer lost and how many of those
  no record in the trail counts. A service log is somewhere hushgate cannot
  rewrite, so the anchor the README has always recommended now costs nothing to
  keep, and a trail deleted or replaced while hushgate was stopped no longer
  starts again from genesis without a word.

- **`--continues-from <hash>` verifies a trail whose beginning was removed.**
  Records pruned at the end of their retention period leave a first record
  that does not link to genesis, which verify could only report as a break.
  Given the hash that record links to, it verifies the rest as the
  continuation it is.

- **`--tenant <id>` and `audit verify --all`.** A tenant with its own
  `audit.path` was written by `serve` and read by nothing: `audit verify`,
  `audit report` and `doctor` all looked at the global trail only. `--tenant`
  reads one tenant's trail. `--all` verifies every distinct trail the
  configuration names, prints a block for each, and fails if any one does,
  including one that cannot be read; with `--json` it prints `{ok, trails}`. A
  plain `audit verify` still checks the global trail, and now names the tenant
  trails it left out. A report on the global trail lists them under **Not
  covered**, and in its JSON as `tenantsElsewhere`, however the global trail
  was chosen: by default, by its file name, or with the `--tenant` of a tenant
  recorded there.

- **Lost records leave a mark where they were lost.** When the writer cannot
  write a record — a full disk, a failing volume — it counts it, says so on
  stderr at most once a minute, and the next record that reaches the file
  carries `dropped: N`, if hushgate writes one before it stops. If it does not
  — stopped, restarted or killed while the disk is still full — the trail
  never shows those records; the shutdown line and
  `hushgate_audit_dropped_records_total{trail}`, which puts the count in front
  of monitoring, are where they are counted. A count that does reach the trail
  is a gap the chain links across, so it still verifies; `audit verify` lists
  the gap, `doctor` warns about it, and the report places it between the
  record before the loss and the one that counts it. A loss wholly inside the
  period is stated in bold; one whose stretch reaches past the period's edge
  is stated as **up to N audit records may be missing from this period**, with
  the stretch, and counted in the JSON as `volumes.possiblyLostRecords`;
  either makes every figure a lower bound. The **Audit chain** line names the
  gaps of the whole trail.

- **`residency.endpoint` records which allowlist entry admitted a request**, as
  configured, or `null` when no entry decided. Several entries can share a
  host — one gateway serving two providers under different paths and legal
  bases — and the report, matching by host, attributed the first entry's
  safeguard to all of them. It now matches the recorded endpoint exactly. For
  records written before the field existed it still matches by host, and where
  the entries on that host disagree it says the safeguard is ambiguous and
  lists the candidates, rather than choosing one.

- **The report says what it rests on.** It names the configuration it was
  generated from, or says that none was found and defaults were used: a report
  run from the wrong directory used to read like an operator who had recorded
  no controller and no safeguards. It names the hushgate version that
  generated it, states that safeguards are read from the configuration in
  force today rather than at the time of each request, prints the full head,
  and reports unreadable lines and lost records.

- **`hushgate doctor` checks every trail `serve` writes, and whether `serve`
  could write it.** The global trail and each tenant's, once per file, resolved
  the way `serve` resolves them. A trail `serve` could not open is a failure,
  because `serve` would refuse to start. So is one that exists and cannot be
  read, which used to be reported as "no trail yet". A gap is a warning, the
  head is printed in full, and tenants sharing a file are noted.

- **`attachments.maxCount` limits the documents one request may carry**, 256
  unless set, or `HUSHGATE_ATTACHMENT_MAX_COUNT`. A request with more is
  refused with 422 before any of them is decoded, whatever
  `attachments.onUnreadable` says, and its audit record holds a single entry
  saying why. Every document is an entry in the request's record, and without
  a limit one request of a hundred thousand tiny documents, well inside the
  body limit, writes a record longer than the 16 MiB line `audit verify`
  reads: a trail that fails verification for good, with an unreadable line and
  a break after it that nobody made.

- **Library exports** for the streaming reader, the verifier and the report
  builder: `readTrailEntries`, `parseTrailLine`, `printable`, `isHash`,
  `ChainVerifier`, `verifyTrail`, `verifyTrailFile`, `ReportBuilder`,
  `parsePeriod`, `configuredTrails`, `resolveTrailPath`, `trailFileKeys`,
  `trailWriteProblem` and `INVALID_VALUE`, with the constants and types that go
  with them. `ReportOptions` and `ProcessingReport` gain an optional
  `tenantsElsewhere`, `ProcessingReport.volumes` gains `possiblyLostRecords`
  and `possiblyLostWindows`, and `JsonlAuditLog` gains
  `droppedSinceLastRecord`.

- **`hushgate scan <folder>` walks the folder.** Every file in it and below is
  read in name order, each reported under the path as the operator would type
  it, so `scan docs` yields `docs/a.txt`; entries whose name starts with a dot
  and `node_modules` are left alone. A folder with nothing in it says so on
  stderr, rather than reporting no personal data in 0 files as if that settled
  anything. Until now a folder was an `EISDIR` error, in a command whose own
  description says it exists to sweep one.

### Changed

- **`hushgate serve` refuses to start when it cannot open an audit trail.** The
  file used to be opened only after `serve` was listening, so a directory
  hushgate could not write, a read-only volume or a path that was a directory
  surfaced once requests were already being forwarded with no record at all.
  Every trail is now opened before the port is bound, and a failure names the
  path and exits 1 with nothing listening. `doctor` makes the same check ahead
  of time.

- **Stopping hushgate waits for the requests in flight.** `close()` resolved
  once the sockets had closed, not once the handlers had finished, so a SIGTERM
  during a long model call — `docker stop`, a rolling deployment — closed the
  trail before the request's record was written, and the record of data that
  had already left the machine was lost without a trace. Requests now get five
  seconds to finish; after that their upstream calls are abandoned and they are
  recorded as `failed`. Either way the record is written before the trail is
  closed.

- **`hushgate audit verify <file>` verifies that file.** A file named after the
  subcommand was silently ignored and the configured trail verified instead: a
  confident verdict on something other than what was asked about. The file can
  now be named there or with `--file`, and every combination that would quietly
  ignore part of the command — a file named both ways, two files, `--from` on
  verify, `--tenant` with a file, a malformed hash, an unknown tenant — is a
  usage error, exit 2. A file named without `-c` is verified without loading a
  configuration at all, so a broken `hushgate.config.json` in the working
  directory, a bad `HUSHGATE_*` variable or a tenant key not exported in this
  shell no longer stops an auditor from checking a file they were handed.
  `audit report` still loads one, because the organisation and the safeguards
  come from it.

- **`audit verify --json`: `ok` is the whole verdict, and agrees with the exit
  code.** It was the chain's verdict alone, so a trail with an unreadable line
  printed `"ok": true` and exited 1. `ok` now means no breaks, every anchor
  found and every line readable; the chain's own verdict — no breaks and every
  anchor found — is the new `chainOk`. The output also gains `from`, `breaks`,
  `breakCount`, `gaps`, `gapCount`, `dropped`, `anchors` and `malformedCount`,
  `malformed` lists at most a hundred lines, and on a broken chain `head` is the
  hash stored in the last record rather than in the last one that verified.
  The exit codes are still 0, 1 and 2.

- **`audit report` exits 1 when any line of the trail is unreadable**, as it
  does for a break or a missing anchor. It exited 0 and printed figures from a
  file it had not been able to read in full, with the chain line saying
  `intact`. Lost records alone still exit 0: the document states them, and the
  trail they are missing from does verify.

- **`audit verify` lists every break, each with its line in the file.** It
  stopped at the first and said that everything from there on had been
  altered, which overstated the damage: one edited record leaves every later
  link intact. The chain is now judged afresh after each break, so one edit is
  one break, and each is listed — up to a hundred, then counted — with its
  record number and file line. Gaps, unreadable lines and anchors are listed
  beside them, and an empty trail gets a warning, since an emptied one verifies
  just as well.

- **`--from` and `--to` are UTC days, and say so** in the help, the flag
  descriptions and the report's Period line, both inclusive. A date that does
  not exist, such as `2026-02-31`, or a `--from` after the `--to` is a usage
  error. Both used to be accepted, and an inverted range produced a confident
  report of no processing at all.

- **The trail is written synchronously and read as a stream.** Each record is
  appended with one synchronous write, microseconds on a local disk, so every
  failure is known record by record; on a network filesystem the wait is far
  longer, which is one more reason to keep the trail on local disk. `audit
  verify`, `audit report` and `doctor` read the trail a megabyte at a time, so
  a trail of any size can be checked: reading it whole failed beyond 512 MiB,
  and `doctor` then reported it as not written yet. New trail files are created
  with mode `0640`; they were world-readable under the usual umask.

- **The command line answers a slip with the word meant.** `hushgate scann`
  says `unknown command "scann"; did you mean "scan"?` and points at `hushgate
  help`, instead of printing the whole command list to stderr; `audit verfiy`,
  `keys hassh` and `--upstrem` are answered the same way, the last with both
  `--upstream-openai` and `--upstream-anthropic`. Options may stand before the
  command as well as after it, so `hushgate --json residency` works;
  `hushgate --help <command>` and `hushgate help <command>` print that
  command's help, and `help` for a command that does not exist is a usage
  error, exit 2, rather than the general help with exit 0. Errors from the
  file system are said in words — `cannot read nope.txt: no such file or
  directory` — without the errno code and the path repeated behind it; `serve`
  on a port that is taken says so, and what to do about it; the `-c/--config`
  description names the default; and `doctor` with one warning says "Fix it".

### Fixed

- **A failed write no longer ends auditing for the life of the process.** The
  write stream destroyed itself on its first error — a moment's `ENOSPC`, an
  `EIO` — after which every record vanished without another error, while the
  proxy went on forwarding. Each record is now written on its own, a failure
  costs only that record and is counted, and writing resumes when the disk
  recovers. A record that did not reach the file never becomes the head, so
  the next one links to what is actually there.

- **The report no longer claims pseudonymisation for data sent in the clear.**
  Under a residency `warn` or `allow` mode the proxy forwards the original
  text, but the trail records the policy that would otherwise have applied,
  and the report printed it — `pseudonymize`, beside a paragraph saying
  personal data had been replaced before it left the machine. Those categories
  now read `sent unredacted (residency <mode>)` and are counted. The technical
  measures are built from the handling actually applied, with `allow` and
  unredacted categories in bold and a line when attachments were switched off,
  and no longer say the trail holds no personal data "by construction": tenant
  ids are the operator's choice and are recorded as configured. A period with
  no records says the document makes no statement about it, rather than that
  nothing happened. Nor does it say any longer that no document reached a
  provider unread: it says so of the documents the trail recorded, and that
  documents sent while `attachments.enabled` was false leave no row and are
  not covered.

- **A trail that ends mid-line is sealed before it is appended to.** After a
  crash mid-write the next record was glued onto the fragment and lost with
  it, and the chain broke at the following restart. A newline is now written
  first, with a warning; a complete last record that merely lacks its newline
  is kept and continued.

- **The head is found however long the last record is.** Only the last 64 KiB
  was read, so a last record longer than that — one request with a few hundred
  small attachments was enough — made hushgate start a new chain from genesis,
  and the next verify reported a break nobody had made. Writer and reader now
  also agree on the longest record there is: a record whose line would pass
  the 16 MiB `audit verify` reads is counted as lost rather than written, and a
  restart walks back past such a line, left by an older version, rather than
  continuing the chain from a record no verifier will see.

- **Tenants that write to the same file share one chain.** Each writer kept its
  own head, so two tenants, or a tenant and the global trail, naming one file
  forked the chain, and the file broke at the first switch between them: a
  false tamper alarm. `serve` now opens one writer per file, recognising a file
  however its path is spelt, and each record still names its tenant.

- **A trail moved, deleted or truncated under a running hushgate is noticed.**
  The writer went on writing to the file it had opened: after a move, to a
  file nobody would read; after a delete, to nothing. It now reopens the trail
  at its path, and warns with the old file's head so that it can be anchored.
  Copy-and-truncate is warned about as well, since it loses records; the README
  now says how to rotate instead.

- **A line that parses to a record but is not what was hashed fails
  verification.** The verifier compared parsed values, so a line with a
  duplicate key — which two JSON readers can resolve to different values — or
  with added whitespace verified as intact. A line must now be exactly the
  canonical form hushgate wrote, which is also what makes checking it with
  `sha256sum` meaningful.

- **A mistyped hash no longer crashes `audit verify`, `audit report` or
  `doctor`.** A record whose `hash` or `prev` was `null` or a number reached
  code that assumed a string, and the error took down the whole `doctor` run.
  Such lines are now unreadable lines or breaks, and a `doctor` section that
  throws for any reason becomes a failure of its own while the other sections
  still report. Likewise `audit report` no longer stops, printing nothing but a
  `TypeError`, at a record whose `attachments` or `residency.controls` is not
  a list or holds `null`: the document is printed, says BROKEN where the
  record was edited, and reads a value of the wrong shape as `invalid`.

- **verify and the report print nothing from the trail that a terminal would
  obey.** Ids, timestamps, details and paths in verify, and routes, tenant ids,
  kinds, hosts, formats and every other field the report quotes, are printed
  with control and bidirectional characters escaped as `\uXXXX`, since a field
  carrying escape sequences could erase the line that says BROKEN, and the
  reasons given for unreadable lines no longer quote fragments of the line.

- **Fields with a fixed set of values are checked when the record is built.**
  An outcome, a residency mode, a policy or an attachment outcome outside its
  set is written as `invalid` rather than copied, and building a record never
  throws, since it runs after the request has been answered and an exception
  would cost its record. Only a library caller building events by hand could
  reach either.

- **Attachment media types in the trail are ones hushgate recognises.** The
  type a caller declared was copied as sent, in the record and in the reason
  `no extractor handles …`, so a caller could write text of its own into the
  evidence. The trail now holds the declared type when hushgate knows it or a
  configured `attachments.extractors` entry claims it, otherwise the type of
  the format it detected, or `application/octet-stream`.

- **Each recipient row in the report has one jurisdiction.** The jurisdiction
  was taken from the first record for a host, so a host whose jurisdiction
  changed was reported under the old one throughout. Rows are now per host,
  endpoint and jurisdiction.

- **Configuration text cannot restructure the report.** A legal basis, the
  organisation's name or a purpose is escaped in the report's Markdown, so a
  `|` in a legal basis no longer drops a table cell, and a line break or a
  leading `#` no longer starts a block of its own. A leading number is escaped
  only where Markdown would read it as a list, so an address such as
  `127.0.0.1:9099` keeps its full stop.

## [0.4.0] — 2026-09-11

### Added

- **`setup` offers to leave hushgate where it can be run.** Reached the way the
  README says to reach it — `npx hushgate setup` — the wizard used to finish by
  telling the operator to run `hushgate serve`, a command npx had not installed
  and would not leave behind. The first thing they typed after answering five
  questions was one that could not work. Setup now offers, once and optionally,
  to install the running version into the folder beside the configuration or
  onto PATH, and says which. Nothing is installed unless it is asked for.

### Fixed

- **The trial page reports a failed request instead of waiting forever.**
  `check()` and the drop handler set a status — `checking…`, `reading X…` —
  and had no rejection path; both are invoked as `void fn()`, so a fetch that
  never arrived was swallowed and the status stayed on screen indefinitely. An
  operator reads that as work still in progress and waits. Every path now ends
  in a message, including a response stream that dies mid-answer, which used to
  leave `waiting for the first token…` up for good. The page's own script is
  now exercised as code in a vm rather than asserted as a string, which is what
  a swallowed rejection needs to be caught by a test. The proxy is unaffected:
  the trial page is mounted only by `setup`, never by `serve`.

- **`setup` says when documents will not be readable.** The closing report
  printed warnings and failures only, and a missing `pdftotext` is a note —
  correctly, since refusing PDFs is the safe direction and must not fail
  `doctor`. But it meant the one operator most likely to be missing poppler
  heard nothing, and met it later as a rejected invoice. Notes from the
  attachments section now survive the filter, with the `apt`/`brew` line the
  doctor remedy already carried.

- **`setup` and `init` name commands the caller can actually run.** Under npx
  every pointer they print — `serve`, `doctor`, `residency --registry` — is
  spelled `npx hushgate …`; installed on PATH, they are spelled as before. The
  question is skipped entirely when there is nothing to install: on PATH
  already, or already in this folder's `node_modules`, where npx resolves it
  without fetching. An install that fails says what npm said and falls back to
  the invocation that works, because a configuration was still written and the
  install is not what setup is for.

## [0.3.0] — 2026-09-10

### Added

- **A short briefing for the model, attached to sanitised requests.** A model
  that has never been told what `[EMAIL_1]` is tends to answer about the
  placeholder, open with a paragraph about the address it cannot see, or invent
  one to fill the gap — and an invented address is not in the mapping, so
  re-hydration leaves it as written. Requests that carried personal data now
  carry a paragraph saying what the placeholders are, which kinds are in this
  request, that they must be echoed back verbatim, and that inventing one is
  forbidden. It names categories only, never a value.

- **`hushgate briefing`** prints that text for a given config, tenant and set of
  kinds — `--tenant <id>`, `--kinds EMAIL,SECRET:redact`, `--json`. No key, no
  network.

- **A `briefing` section in the config**, global and per tenant. `mode` is
  `auto` (attach it when a request carries a placeholder), `always` or `off`;
  `text` replaces the wording outright and `append` adds house rules after it. A
  tenant's section merges over the global one key by key. `hushgate doctor`
  reports which state you are in, as notes rather than warnings.

### Changed

- **Requests that carried personal data now include one extra system message**
  (OpenAI) or system block (Anthropic). It goes *after* the caller's own system
  prompt, never before it: both providers cache on a prefix, so inserting at the
  head would invalidate cached tokens on every request. The caller's own system
  prompt is never edited, reordered or replaced, and a request that tripped no
  detector is still forwarded exactly as it arrived. `briefing.mode: "off"`
  restores the previous behaviour in full.

- The trial page served by `hushgate setup` sends the same briefing, so the
  demonstration matches what `serve` does.

## [0.2.0] — 2026-09-10

### Added

- **`hushgate setup`: one command from nothing to either a working
  configuration or a demonstration.** The first question decides which. Trying
  it out asks for a provider and an API key, then opens a page on loopback with
  four boxes: your text, what the provider would receive, the reply as it
  streams in, and the reply with your data put back. Nothing is written to
  disk, and the key never leaves the process that asked for it.

  Setting up asks the same provider question and makes everything after it
  optional, including the legal basis — `doctor` runs underneath and says what
  is still missing rather than blocking the path to ask for it. Only the
  provider must be answered, because it is the only thing hushgate cannot work
  out for itself.

  The trial page is mounted by `setup` alone. It turns placeholders back into
  personal data, so `serve` has no flag that switches it on.

- **`hushgate init` is unchanged**, and is now documented as the path for
  scripts and CI. Both commands render the same commented starter file from one
  template, pinned byte for byte against what 0.1.0 shipped.

- **The machine-readable zone off a passport or identity card.** New kind
  `TRAVEL_DOCUMENT_MRZ` (priority 99, directly below `SECRET`), reading ICAO
  Doc 9303 TD1, TD2 and TD3.

  A pasted passport scan is the densest personal data the proxy will ever see —
  name, date of birth, sex, nationality, expiry and document number in one
  block — and until now the only part of it hushgate recognised was whatever a
  date or dictionary detector happened to pick out of the `<` fillers, which
  meant the block was forwarded with holes punched in it rather than replaced.
  It is now one span covering every line of the block, so nothing inside can
  carve it up and re-hydration puts it back exactly as it was written.

  It needs no label to be safe, which nothing else at this priority can claim:
  an MRZ carries four or five independent ICAO 7-3-1 check digits, one of them
  a composite over the others, and ordinary text does not pass all of them. A
  44-character uppercase blob shape-matches and is rejected. That is what makes
  a lone lower line — a copy-paste that clipped the first row — safe to report
  on its own, while a lone TD1 line, whose composite spans two lines, never is.

  Deliberately generic rather than German-only: a French or Turkish MRZ pasted
  into a German prompt is exactly as much personal data and the algorithm is
  identical. Up to one blank line may sit between rows, because a PDF text
  extractor emits the block double-spaced as often as not, and refusing those
  would fail on exactly the input this exists for.

- **Legacy bank details: Kontonummer and Bankleitzahl, sort code, routing
  number.** The pair a customer writes when they are not writing an IBAN — on
  an old invoice, in a spreadsheet column, in "bitte auf Kto. 532013000,
  BLZ 37040044 überweisen" — was forwarded verbatim before, because none of the
  three formats carries a checksum over the whole string the way an IBAN does.

  The German half is now decided arithmetically rather than by shape. hushgate
  ships the Bundesbank's bank code directory (3507 institutions) and all 91
  Prüfzifferberechnungsmethoden those banks name, so `532013000 / 37040044` is
  reported because 37040044 is a real bank code *and* 532013000 satisfies that
  bank's own check-digit method. Two independent confirmations, which is what
  makes an unlabelled pair safe to report; a pair with an invented bank code, or
  one whose account number fails its bank's method, is not reported at all.

  The methods are implemented from the Bundesbank specification and pinned by
  its own 457 official test account numbers, then cross-checked against an
  independent implementation over about a million account/bank-code pairs. The
  nine methods where the two disagree are listed in `bankcheckdigit.ts` with the
  spec sentence that decides each one.

  A UK sort code is read next to its account number or its label; a US routing
  number carries its own 3-7-1 checksum. A lone account number with neither a
  bank code nor a label beside it is deliberately not reported — six to ten bare
  digits is every order number in German business correspondence.

  New kind `BANK_ACCOUNT` (priority 72), new config group
  `redaction.detectors.bankAccount` for the label lists, and
  `scripts/build-blz-methods.mjs` to refresh the directory when the Bundesbank
  republishes it quarterly. The German evasion corpus goes from 196 to 200
  of 299.
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

- **A `redaction.policies` key that names no real kind is now a load error.**
  The table checked the spelling of a key — UPPER_SNAKE_CASE, nothing else —
  and `EMIAL` passes that. So the config parsed, `doctor` printed the rule
  back, and every e-mail address left under the default policy, because no
  finding is ever reported under that name. This is the failure mode the
  residency block was already closed against (`residency.categories`), and the
  policy table is the more dangerous of the two: it is where an operator writes
  `block`.

  The key set is closed against what the profile can actually produce — the
  built-in kinds, plus every kind a custom rule or a dictionary entry
  introduces — and the error suggests the near miss (`did you mean "EMAIL"?`).
  Scope is respected in both directions: the global table is inherited by every
  tenant, so a rule defined in any one of them is enough to give a global key a
  meaning, while a tenant's own table is checked against that tenant's rules
  alone. A config that leaned on the old silence will now refuse to load, and
  the message says which key and what to write instead.

- Attachment decoding no longer depends on the platform carrying the legacy
  encoding tables. Four places asked `new TextDecoder('windows-1252')` for the
  mapping, and none of them failed loudly when the platform could not supply
  it: the plain-text decoder dropped to latin-1, where `0x92` is the C1 control
  `U+0092` rather than a right single quote and was then stripped as a control
  character; the HTML reader built its C1 table by decoding, got an empty string
  and dropped the numeric reference; the RTF reader fell through to a latin-1
  code page for every document, including the ones declaring windows-1252; and
  the e-mail reader handed the charset a message declares straight to
  `TextDecoder`, which is `charset=windows-1252` in everything Outlook writes
  and `charset=iso-8859-1` — the same encoding under an older name — in most of
  what German mailers write. `Kün’s` extracted as `Küns`, `Anna&#146;s` as
  `Annas`, a Word-exported RTF lost every apostrophe and every German quotation
  mark, and `Anna’s Angebot` arrived from a mail as `Annas Angebot` — while the
  document still counted as read, the quality checks still passed, and the audit
  record still said so.

  The thirty-two characters of the C1 range are shipped data now
  (`WINDOWS_1252_C1`) and all four call sites read them, so no build of Node can
  produce that outcome. `test/attach.smallicu.test.ts` runs the whole pipeline
  under both ways a platform can fail here, and a second test compares the
  shipped table against `TextDecoder` over all 256 bytes wherever the platform
  genuinely has one, so the literal cannot drift where CI can check it while
  still working where CI cannot reach.

  Both ways, because there turned out to be two. A build with `--without-intl`
  refuses the label, which is the failure this entry originally described and
  the one a fallback can see. **Node 20 does not refuse it.** It accepts
  `windows-1252` and answers with latin-1: the decode succeeds, every guard
  downstream sees a decode that worked, and only the punctuation is wrong. That
  was measured in CI, where 22 and 24 were green and 20 was red on the same
  commit, and it makes the e-mail path a live defect rather than defence in
  depth — Node 20 is the floor of `engines`, so `npm i -g hushgate` on a
  supported runtime deleted apostrophes out of mail bodies. The published Docker
  image was never affected: `node:22-alpine` carries full ICU, as the official
  Node images have since v13.
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

[Unreleased]: https://github.com/johan-becker/hushgate/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/johan-becker/hushgate/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/johan-becker/hushgate/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/johan-becker/hushgate/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/johan-becker/hushgate/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/johan-becker/hushgate/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/johan-becker/hushgate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/johan-becker/hushgate/releases/tag/v0.1.0
