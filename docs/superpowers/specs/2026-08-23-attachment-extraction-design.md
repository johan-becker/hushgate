# Attachment extraction and pseudonymisation

Status: accepted, 2026-08-23.

## The gap this closes

`src/redact/shapes.ts:21` says image content parts are skipped by design, and
they are. So are Anthropic `document` blocks and OpenAI `file` parts. Today a
caller can attach a base64 PDF full of patient names to a request and hushgate
forwards it to the provider **untouched**. That contradicts the product's
central claim — "the personal data never reaches the provider in the first
place" — for the one attachment format business users send most.

## What it does

An attachment is turned into text, the text is pseudonymised by the existing
detector pipeline, and the request that leaves carries the pseudonymised text
instead of the file. The binary never reaches the provider.

    {"type":"document","source":{"type":"base64",
     "media_type":"application/pdf","data":"JVBERi0xLjQ..."}}

becomes

    {"type":"text","text":
     "[attachment: Rechnung.pdf — application/pdf, 2 pages]\n
      Rechnung an [NAME_1], [EMAIL_1]\nIBAN [IBAN_1]\n[end of attachment]"}

## Architecture

A **pre-pass**, not a change to the redactor. `rewriteAttachments` walks the
parsed body before `redactJson` runs and replaces each attachment part with a
text part. The extracted text is then an ordinary `messages.*.content.*.text`
leaf, so every detector, policy, placeholder and audit path already applies to
it with no change. The detector layer is untouched.

    readBody → parseJsonObject → rewriteAttachments → redactJson → upstream
                                 ^^^^^^^^^^^^^^^^^^ new

`redactJson` is synchronous. Extraction is not (an external extractor is a
child process), so the pre-pass is `async` and sits outside it. This is why it
is a separate stage rather than a hook inside traversal.

## Three tiers, fail-closed

**Tier 1 — built in, pure Node, zero dependencies, always available.**

| Format | Method |
|---|---|
| `.docx` `.xlsx` `.pptx` `.odt` `.ods` `.odp` | ZIP central directory + `node:zlib.inflateRawSync` + XML text pull |
| `.txt` `.md` `.csv` `.tsv` `.json` `.xml` `.log` | charset sniff (BOM, UTF-16, UTF-8 validity, latin-1 fallback) via `TextDecoder` |
| `.html` | tag stripper; `<script>`/`<style>` dropped, block elements to newlines, entities decoded |
| `.rtf` | control-word state machine |
| `.eml` | RFC 822 headers plus text parts, quoted-printable and base64 transfer encodings |

**Tier 2 — optional external extractor, operator-configured.**

PDF is deliberately *not* hand-rolled. A from-scratch extractor was built and
measured during design: it fails silently and completely on common real-world
PDFs (Google Docs exports), producing empty output with no error. Shipping that
behind a compliance claim is worse than shipping nothing. Bundling a JS PDF
engine was also rejected — the smallest credible option ships a 1.67 MB
minified Apache-2.0 blob under an MIT-only licence file, which is both
unauditable and a licence defect to inherit.

Instead the operator declares extractors in config. hushgate pipes the bytes to
the command's stdin and reads text from stdout. The Docker image installs
`poppler-utils`, so `pdftotext` is present in the deployment that matters and
PDF works out of the box there; the npm package stays at zero dependencies and
refuses PDFs until an extractor is configured.

Guards, all mandatory:
- content on **stdin**, never a path; **no attacker-controlled string ever
  reaches argv** (a file named `-layout` is otherwise consumed as a flag and
  silently truncates output to nothing, exit code 0);
- wall-clock timeout with `SIGKILL` escalation, implemented in Node;
- stdout byte cap, enforced while reading;
- no temporary files at any point;
- the resolved command version is recorded in the audit trail.

**Tier 3 — fail-closed.** If no tier produced trustworthy text, the
`onUnreadable` policy decides. Default `block`.

## Trustworthy text

Empty output is the dangerous case: `pdftotext` on a scanned PDF exits 0 with a
single form feed, which is indistinguishable from "this document has no text".
`quality.ts` rejects extraction when any of these hold:

- fewer than 16 non-whitespace characters overall;
- for a paged format, fewer than 8 non-whitespace characters per page;
- more than 10% U+FFFD replacement characters;
- more than 30% non-printable characters.

A rejected extraction is `unreadable`, never "clean".

## Configuration

```jsonc
"attachments": {
  "enabled": true,
  "maxBytes": 10485760,
  "maxTotalBytes": 33554432,
  "maxTextChars": 200000,
  "onUnreadable": "block",     // "block" | "withhold" | "forward"
  "onOversize": "block",
  "extractors": [
    { "mediaTypes": ["application/pdf"],
      "command": "pdftotext",
      "args": ["-q", "-enc", "UTF-8", "-", "-"],
      "timeoutMs": 20000 }
  ]
}
```

`enabled` defaults to **true**: leaving it off would preserve a live leak, and
the safe default is the one that matches what the README already claims.
`forward` exists for the operator who knowingly wants images through; `hushgate
doctor` reports it as unsafe.

`limits.maxBodyBytes` rises from 4 MiB to 16 MiB, because base64 inflates a
document by a third and 4 MiB rejected most real attachments before extraction
could even see them.

## Audit

`AuditEvent` gains `attachments: readonly AuditAttachment[]`:

```ts
{ format, mediaType, bytes, chars, pages, extractor, outcome }
```

Counts and categories only — **never the filename**, which is itself often
personal data (`Kündigung_Anna_Schmidt.pdf`). The filename does reach the
prompt, inside the delimiter, where the detectors pseudonymise it like any
other text.

## Security

- Decoded size capped before allocation; base64 length checked first.
- ZIP: entry count cap, per-entry and total uncompressed caps, compression
  ratio cap — a 21 KB crafted DOCX drove a mature extractor to 178 MB RSS,
  ~8200× amplification.
- XML: no entity resolution at all, so XXE is structurally impossible.
- Remote sources (`source.type: "url"`, `file_id`) are never fetched; hushgate
  makes no network calls of its own. They are unreadable, and the policy
  applies.

## Testing

Fixtures are generated by `test/helpers/make-fixtures.ts` at test time rather
than committed as binaries, so the suite stays reviewable in a diff and no
opaque blob enters the repo. External-extractor tests use a Node script as the
command, so they run without poppler installed.
