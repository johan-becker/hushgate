/**
 * The starter configuration, and the one place its text lives.
 *
 * `init` renders it with no answers and `setup` renders it with the operator's,
 * so the commented file is the same file either way. The comments are the
 * point: a config format with nowhere to write down *why* an upstream is
 * permitted invites the reason to be left out.
 */

export interface OrganisationAnswers {
  readonly name?: string;
  readonly contact?: string;
  readonly dpo?: string;
  readonly purposes?: readonly string[];
}

export interface AllowAnswer {
  readonly endpoint: string;
  readonly jurisdiction: string;
  readonly legalBasis: string;
}

export interface SetupAnswers {
  readonly organisation?: OrganisationAnswers;
  readonly upstreams?: { readonly openai?: string; readonly anthropic?: string };
  readonly port?: number;
  readonly allow?: readonly AllowAnswer[];
}

const DEFAULT_OPENAI = 'https://api.openai.com';
const DEFAULT_ANTHROPIC = 'https://api.anthropic.com';
const DEFAULT_PORT = 8787;

/**
 * A JSON string, or `null` for an answer nobody gave.
 *
 * Everything an operator types goes through `JSON.stringify`, so a company name
 * with a quote in it produces a file that still parses rather than one that
 * fails to load an hour later.
 */
function value(answer: string | undefined): string {
  return answer === undefined || answer === '' ? 'null' : JSON.stringify(answer);
}

/** A JSON array of strings on one line. */
function list(answers: readonly string[] | undefined): string {
  if (answers === undefined || answers.length === 0) return '[]';
  return `[${answers.map((entry) => JSON.stringify(entry)).join(', ')}]`;
}

/** The `residency.allow` body: the commented example, or real entries. */
function allowBlock(entries: readonly AllowAnswer[] | undefined): string {
  if (entries === undefined || entries.length === 0) {
    return `    // An empty allowlist permits every upstream. Fill it in and hushgate
    // refuses to start against anything else.
    // {
    //   "endpoint": "https://api.mistral.ai",
    //   "jurisdiction": "FR",
    //   "legalBasis": "Art. 28 DPA of 2026-01-12, processing in France"
    // }
    "allow": []`;
  }

  const rendered = entries
    .map(
      (entry) => `      {
        "endpoint": ${JSON.stringify(entry.endpoint)},
        "jurisdiction": ${JSON.stringify(entry.jurisdiction)},
        "legalBasis": ${JSON.stringify(entry.legalBasis)}
      }`,
    )
    .join(',\n');

  return `    // Every upstream hushgate may forward to, and the basis for each.
    "allow": [
${rendered}
    ]`;
}

export function renderConfig(answers: SetupAnswers = {}): string {
  const organisation = answers.organisation ?? {};

  return `{
  // hushgate configuration. Comments are allowed and stripped on load.
  // Every key is optional; anything left out uses the documented default.
  // Environment variables (HUSHGATE_*) override this file, and command-line
  // flags override those.

  // Loopback by default. Binding anything else requires tenants, because
  // hushgate holds the mapping back to real personal data.
  "host": "127.0.0.1",
  "port": ${answers.port ?? DEFAULT_PORT},

  // Where sanitised requests are forwarded. Swap these for an EU-hosted
  // endpoint when you have one: "hushgate residency --registry" lists them.
  "upstreams": {
    "openai": ${JSON.stringify(answers.upstreams?.openai ?? DEFAULT_OPENAI)},
    "anthropic": ${JSON.stringify(answers.upstreams?.anthropic ?? DEFAULT_ANTHROPIC)}
  },

  "redaction": {
    // pseudonymize | redact | hash | allow | block
    "defaultPolicy": "pseudonymize",

    "policies": {
      // Credentials should never reach a model, yours or anyone else's.
      "SECRET": "block"
    },

    // Names, customers and codenames no detector could know about.
    "dictionary": {
      "names": [],
      "terms": []
    },

    // Your own identifiers, as named regular expressions.
    // { "name": "employee id", "pattern": "EMP-\\\\d{5}" }
    "custom": []
  },

  // What hushgate tells the model about the placeholders it is about to read.
  // Without it, a model that meets [EMAIL_1] tends to answer about the
  // placeholder, open with a paragraph about what it cannot see, or invent an
  // address to fill the gap — and an invented address is not put back.
  //   "auto"   attach it when a request actually carries a placeholder
  //   "always" attach it to every request
  //   "off"    never attach it; forward exactly what the caller wrote
  // "text" replaces the built-in wording outright, "append" adds house rules
  // after it. Run "hushgate briefing" to print what either one produces.
  "briefing": {
    "mode": "auto",
    "text": null,
    "append": null
  },

  "residency": {
    // block | sanitize | warn | allow. Start at "warn" for a staged rollout if
    // you must, but "hushgate doctor" will keep reminding you.
    "mode": "sanitize",

    // Refuse a category outright, wherever it appears.
    "categories": {},

${allowBlock(answers.allow)}
  },

  // A document in a request is turned into text, the text is pseudonymised,
  // and the file itself never reaches the provider.
  "attachments": {
    "enabled": true,

    // What to do when a document cannot be read at all — a scan with no text
    // layer, an encrypted PDF, a photograph. "block" refuses the request;
    // "withhold" drops the file and forwards the rest; "forward" sends the
    // original bytes, which is the one setting that lets a document hushgate
    // has not read reach the provider.
    "onUnreadable": "block",

    // PDF is not parsed in-process. Point this at a tool that does it properly;
    // the document is piped to its standard input and never written to disk,
    // and nothing from the request ever reaches its arguments.
    // The Docker image ships pdftotext, so this works there as written.
    "extractors": [
      {
        "mediaTypes": ["application/pdf"],
        "formats": ["pdf"],
        "command": "pdftotext",
        "args": ["-q", "-enc", "UTF-8", "-", "-"],
        "timeoutMs": 20000
      }
    ]
  },

  // Categories and counts, never values. This is the evidence.
  "audit": {
    "enabled": true,
    "path": "hushgate-audit.jsonl"
  },

  // Heads the Article 30 report. hushgate cannot know any of it.
  "organisation": {
    "name": ${value(organisation.name)},
    "contact": ${value(organisation.contact)},
    "dpo": ${value(organisation.dpo)},
    "purposes": ${list(organisation.purposes)}
  }

  // Multi-tenant operation: run "hushgate keys new <id>" and paste the snippet.
  // "tenants": []
}
`;
}
