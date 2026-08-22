/**
 * `hushgate init` — write a starter configuration.
 *
 * The file it writes is commented, because a config file is where a team
 * records *why* an upstream is permitted, and a format with nowhere to put the
 * reason invites the reason to be left out. hushgate's loader strips comments.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as joinPath } from 'node:path';
import { CONFIG_FILENAME } from '../../config.js';
import { HushgateError } from '../../errors.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const INIT_FLAGS: FlagSpecs = {
  path: { type: 'string', alias: 'p', description: 'where to write it', placeholder: '<path>' },
  force: { type: 'boolean', alias: 'f', description: 'overwrite an existing file' },
};

export const INIT_SUMMARY = 'write a commented starter hushgate.config.json';

export function init(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, INIT_FLAGS);
  const target = stringFlag(parsed, 'path') ?? CONFIG_FILENAME;
  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);

  if (existsSync(path) && !boolFlag(parsed, 'force')) {
    throw new HushgateError(`${path} already exists; pass --force to overwrite it`);
  }

  writeFileSync(path, STARTER, 'utf8');

  cli.stdout(
    [
      `wrote ${relative(cli.cwd, path) || path}`,
      '',
      'Next:',
      '  1. Fill in the organisation block — it heads the Article 30 report.',
      '  2. Decide your upstreams, then list them in residency.allow with the',
      '     legal basis you actually rely on. Run "hushgate residency --registry"',
      '     to see the EU-hosted options hushgate knows about.',
      '  3. Run "hushgate doctor" until it is quiet.',
      '  4. Start it with "hushgate serve" and point your SDK at it.',
      '',
    ].join('\n'),
  );

  return Promise.resolve(EXIT.ok);
}

const STARTER = `{
  // hushgate configuration. Comments are allowed and stripped on load.
  // Every key is optional; anything left out uses the documented default.
  // Environment variables (HUSHGATE_*) override this file, and command-line
  // flags override those.

  // Loopback by default. Binding anything else requires tenants, because
  // hushgate holds the mapping back to real personal data.
  "host": "127.0.0.1",
  "port": 8787,

  // Where sanitised requests are forwarded. Swap these for an EU-hosted
  // endpoint when you have one: "hushgate residency --registry" lists them.
  "upstreams": {
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com"
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

  "residency": {
    // block | sanitize | warn | allow. Start at "warn" for a staged rollout if
    // you must, but "hushgate doctor" will keep reminding you.
    "mode": "sanitize",

    // Refuse a category outright, wherever it appears.
    "categories": {},

    // An empty allowlist permits every upstream. Fill it in and hushgate
    // refuses to start against anything else.
    // {
    //   "endpoint": "https://api.mistral.ai",
    //   "jurisdiction": "FR",
    //   "legalBasis": "Art. 28 DPA of 2026-01-12, processing in France"
    // }
    "allow": []
  },

  // Categories and counts, never values. This is the evidence.
  "audit": {
    "enabled": true,
    "path": "hushgate-audit.jsonl"
  },

  // Heads the Article 30 report. hushgate cannot know any of it.
  "organisation": {
    "name": null,
    "contact": null,
    "dpo": null,
    "purposes": []
  }

  // Multi-tenant operation: run "hushgate keys new <id>" and paste the snippet.
  // "tenants": []
}
`;
