# Onboarding `setup` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `hushgate setup`, that either walks an operator to a
written configuration or hands them a local page proving what a provider would
have received — replacing the current init-then-edit-JSON-then-doctor path.

**Architecture:** A `Prompter` injected through `Cli` keeps the wizard testable
in-process, exactly as every other command already is. The commented starter
config moves out of `init` into `renderConfig(answers)` so both callers emit the
same file. The trial page is a new `src/playground/` module mounted into the
existing proxy dispatch, but only when `setup` asks for it — never by `serve`.
It adds no redaction path: one `Session` serves the preview, the send and the
rehydration.

**Tech Stack:** TypeScript 7, ESM, Node ≥ 20, vitest 5, oxlint. No runtime
dependencies — `node:` built-ins only, including `node:readline/promises` for
the prompts and plain strings for the page.

**Spec:** `docs/superpowers/specs/2026-09-09-onboarding-setup-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. No prompt library, no
  web framework, no CDN in the page.
- **Node ≥ 20**, ESM, relative imports carry the `.js` extension.
- **English**, in the wizard, the page and the code comments — the whole tool is
  English and the wizard is not an exception. See the spec's "Language" section.
- **No `process.exit`** in a command; return an exit code from `EXIT`.
- **Every command is a function of `Cli`**, so tests drive it in-process via
  `run(cli)` with captured `stdout`/`stderr`. Follow `test/cli.doctor.test.ts`.
- **`npm run lint` is `oxlint --deny-warnings`** — it must pass with zero output.
- **Commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq`
- **Full check before each commit:** `npm run build && npm test && npm run lint
  && npm run typecheck && npm run check:docs`.
- Branch: `feat/onboarding-setup`, already checked out, spec committed there.

---

### Task 1: The prompt layer

**Files:**
- Create: `src/cli/prompt.ts`
- Modify: `src/cli/cli.ts` (add one optional field to `Cli`, wire `processCli`)
- Test: `test/cli.prompt.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface Choice<T> { readonly label: string; readonly hint?: string; readonly value: T }`
  - `export interface Prompter { text(question: string, options?: TextOptions): Promise<string>; choose<T>(question: string, choices: readonly Choice<T>[]): Promise<T>; confirm(question: string, fallback: boolean): Promise<boolean>; close(): void }`
  - `export interface TextOptions { readonly default?: string; readonly required?: boolean }`
  - `export function createPrompter(streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): Prompter`
  - `Cli` gains `readonly prompt?: () => Prompter`

- [ ] **Step 1: Write the failing test**

Create `test/cli.prompt.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter, type Prompter } from '../src/cli/prompt.js';

/** Drive a prompter with scripted keystrokes, collecting what it printed. */
function driven(lines: readonly string[]): { prompter: Prompter; output(): string } {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')));

  const prompter = createPrompter({ input, output });
  // readline consumes a line at a time; queueing them all up front is enough
  // because every question is asked before the next answer is read.
  for (const line of lines) input.write(`${line}\n`);

  return { prompter, output: () => chunks.join('') };
}

describe('createPrompter', () => {
  it('returns the typed answer, trimmed', async () => {
    const { prompter } = driven(['  Nordwerk GmbH  ']);
    expect(await prompter.text('Company')).toBe('Nordwerk GmbH');
    prompter.close();
  });

  it('falls back to the default when the answer is empty', async () => {
    const { prompter } = driven(['']);
    expect(await prompter.text('Port', { default: '8787' })).toBe('8787');
    prompter.close();
  });

  it('asks again when a required answer is empty', async () => {
    const { prompter, output } = driven(['', 'finally']);
    expect(await prompter.text('Provider', { required: true })).toBe('finally');
    expect(output()).toContain('an answer is required');
    prompter.close();
  });

  it('maps a chosen number to its value', async () => {
    const { prompter } = driven(['2']);
    const picked = await prompter.choose('Which provider', [
      { label: 'Mistral AI', hint: 'FR', value: 'mistral' },
      { label: 'OpenAI', hint: 'US', value: 'openai' },
    ]);
    expect(picked).toBe('openai');
    prompter.close();
  });

  it('rejects a number outside the list and asks again', async () => {
    const { prompter, output } = driven(['9', '1']);
    const picked = await prompter.choose('Which provider', [
      { label: 'Mistral AI', value: 'mistral' },
      { label: 'OpenAI', value: 'openai' },
    ]);
    expect(picked).toBe('mistral');
    expect(output()).toContain('pick a number between 1 and 2');
    prompter.close();
  });

  it('takes the fallback on an empty confirm, both ways round', async () => {
    const yes = driven(['']);
    expect(await yes.prompter.confirm('Continue', true)).toBe(true);
    expect(yes.output()).toContain('[Y/n]');
    yes.prompter.close();

    const no = driven(['']);
    expect(await no.prompter.confirm('Continue', false)).toBe(false);
    expect(no.output()).toContain('[y/N]');
    no.prompter.close();
  });

  it('reads an explicit yes or no regardless of case', async () => {
    const { prompter } = driven(['N', 'YES']);
    expect(await prompter.confirm('Continue', true)).toBe(false);
    expect(await prompter.confirm('Continue', false)).toBe(true);
    prompter.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.prompt.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cli/prompt.js"`

- [ ] **Step 3: Write the implementation**

Create `src/cli/prompt.ts`:

```ts
/**
 * The questions a command may ask, and the one implementation that asks them.
 *
 * Injected through {@link Cli} rather than reached for, so the wizard can be
 * driven from a test with scripted answers — the same reason every other
 * command takes its streams instead of touching `process` directly.
 *
 * Node's own readline is the whole dependency. A prompt library would buy
 * arrow-key selection and cost the promise that hushgate installs nothing.
 */
import { createInterface } from 'node:readline/promises';

export interface Choice<T> {
  readonly label: string;
  /** Shown dimmed after the label — a jurisdiction, a default, a warning. */
  readonly hint?: string;
  readonly value: T;
}

export interface TextOptions {
  /** Used when the answer is empty. Shown in the prompt. */
  readonly default?: string;
  /** Keep asking until something non-empty is typed. */
  readonly required?: boolean;
}

export interface Prompter {
  text(question: string, options?: TextOptions): Promise<string>;
  choose<T>(question: string, choices: readonly Choice<T>[]): Promise<T>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** Release the underlying readline interface. */
  close(): void;
}

export interface PromptStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export function createPrompter(streams: PromptStreams): Prompter {
  const rl = createInterface({ input: streams.input, output: streams.output });
  const say = (line: string): void => void streams.output.write(`${line}\n`);

  return {
    async text(question, options = {}) {
      const suffix = options.default === undefined ? '' : ` [${options.default}]`;

      for (;;) {
        const answer = (await rl.question(`  ${question}${suffix} > `)).trim();
        if (answer !== '') return answer;
        if (options.default !== undefined) return options.default;
        if (options.required !== true) return '';
        say('  an answer is required');
      }
    },

    async choose(question, choices) {
      say(`  ${question}`);
      choices.forEach((choice, index) => {
        const hint = choice.hint === undefined ? '' : `  ${choice.hint}`;
        say(`    ${index + 1} ${choice.label}${hint}`);
      });

      for (;;) {
        const answer = (await rl.question('  > ')).trim();
        const index = Number.parseInt(answer, 10);
        const choice = Number.isNaN(index) ? undefined : choices[index - 1];
        if (choice !== undefined) return choice.value;
        say(`  pick a number between 1 and ${choices.length}`);
      }
    },

    async confirm(question, fallback) {
      const hint = fallback ? '[Y/n]' : '[y/N]';

      for (;;) {
        const answer = (await rl.question(`  ${question} ${hint} > `)).trim().toLowerCase();
        if (answer === '') return fallback;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        say('  answer y or n');
      }
    },

    close() {
      rl.close();
    },
  };
}
```

- [ ] **Step 4: Wire it into `Cli`**

In `src/cli/cli.ts`, add the import and one field to the `Cli` interface, after
`stdin`:

```ts
import type { Prompter } from './prompt.js';
```

```ts
  /**
   * Opens an interactive prompt. Absent when there is no terminal, which is how
   * `setup` knows to send the caller to `init` instead.
   *
   * A factory rather than a `Prompter`, because building one attaches readline
   * to stdin — and `check` and `scan -` read stdin themselves. Nothing is
   * attached until a command actually asks a question.
   */
  readonly prompt?: () => Prompter;
```

And in `processCli`, after `stdin: process.stdin,`:

```ts
    ...(process.stdin.isTTY === true
      ? { prompt: (): Prompter => createPrompter({ input: process.stdin, output: process.stdout }) }
      : {}),
```

with `createPrompter` added to the import from `./prompt.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cli.prompt.test.ts && npm run typecheck`
Expected: 7 passed, typecheck clean. Every existing `Cli` literal in the suite
still compiles because the new field is optional.

- [ ] **Step 6: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/cli/prompt.ts src/cli/cli.ts test/cli.prompt.test.ts
git commit -m "feat(cli): ask questions through an injected prompter

Node's readline is the whole dependency, and the prompter arrives through
Cli as a factory rather than a value: building one attaches readline to
stdin, and check and scan - read stdin themselves. Nothing is attached
until a command asks a question, and a test drives the wizard by handing
in a scripted prompter instead of a terminal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 2: One template, two callers

**Files:**
- Create: `src/cli/template.ts`
- Create: `test/fixtures/starter-config.json` (captured, not written by hand)
- Modify: `src/cli/commands/init.ts` (delete `STARTER`, call `renderConfig`)
- Test: `test/cli.template.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface SetupAnswers { readonly organisation?: OrganisationAnswers; readonly upstreams?: { readonly openai?: string; readonly anthropic?: string }; readonly port?: number; readonly allow?: readonly AllowAnswer[] }`
  - `export interface OrganisationAnswers { readonly name?: string; readonly contact?: string; readonly dpo?: string; readonly purposes?: readonly string[] }`
  - `export interface AllowAnswer { readonly endpoint: string; readonly jurisdiction: string; readonly legalBasis: string }`
  - `export function renderConfig(answers?: SetupAnswers): string`

- [ ] **Step 1: Capture today's output as the fixture**

The published 0.1.0 is a frozen reference for what `init` writes. Capture it
before touching anything:

```bash
mkdir -p test/fixtures
(cd "$(mktemp -d)" && npx --yes hushgate@0.1.0 init >/dev/null && cat hushgate.config.json) \
  > test/fixtures/starter-config.json
head -3 test/fixtures/starter-config.json
```

Expected first line: `{`, second: `  // hushgate configuration. Comments are allowed and stripped on load.`

- [ ] **Step 2: Write the failing test**

Create `test/cli.template.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../src/cli/template.js';
import { parseConfig } from '../src/config.js';
import { stripJsonComments } from '../src/config.js';

const FIXTURE = readFileSync(new URL('./fixtures/starter-config.json', import.meta.url), 'utf8');

/** Parse the rendered file the way hushgate itself does. */
function load(text: string): ReturnType<typeof parseConfig> {
  return parseConfig(JSON.parse(stripJsonComments(text)) as unknown);
}

describe('renderConfig', () => {
  it('with no answers is byte for byte what init has always written', () => {
    expect(renderConfig()).toBe(FIXTURE);
  });

  it('renders an organisation block hushgate can load back', () => {
    const text = renderConfig({
      organisation: {
        name: 'Nordwerk Maschinenbau GmbH',
        contact: 'datenschutz@nordwerk-gmbh.de',
        dpo: 'Dr. Ole Brandt',
        purposes: ['Drafting customer replies'],
      },
    });

    const config = load(text);
    expect(config.organisation.name).toBe('Nordwerk Maschinenbau GmbH');
    expect(config.organisation.dpo).toBe('Dr. Ole Brandt');
    expect(config.organisation.purposes).toEqual(['Drafting customer replies']);
  });

  it('keeps the comments when it fills a value in', () => {
    const text = renderConfig({ organisation: { name: 'Nordwerk Maschinenbau GmbH' } });
    expect(text).toContain('// Heads the Article 30 report.');
    expect(text).toContain('"name": "Nordwerk Maschinenbau GmbH"');
  });

  it('renders upstreams, port and an allowlist entry', () => {
    const text = renderConfig({
      port: 8790,
      upstreams: { openai: 'https://api.mistral.ai' },
      allow: [
        {
          endpoint: 'https://api.mistral.ai',
          jurisdiction: 'FR',
          legalBasis: 'Art. 28 DPA of 2026-01-12, processing in France',
        },
      ],
    });

    const config = load(text);
    expect(config.port).toBe(8790);
    expect(config.upstreams.openai).toBe('https://api.mistral.ai');
    expect(config.residency.allow).toHaveLength(1);
    expect(config.residency.allow[0]?.legalBasis).toContain('Art. 28');
  });

  it('escapes a quote in an answer instead of breaking the file', () => {
    const text = renderConfig({ organisation: { name: 'A "quoted" GmbH' } });
    expect(load(text).organisation.name).toBe('A "quoted" GmbH');
  });
});
```

`stripJsonComments` is already exported from `src/config.ts:54` — use that one,
not a second implementation, so the test parses exactly the way the loader does.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/cli.template.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cli/template.js"`

- [ ] **Step 4: Write the implementation**

Create `src/cli/template.ts`. Move the `STARTER` string out of
`src/cli/commands/init.ts` verbatim, then cut it at the points an answer
replaces, so the comments survive between the pieces:

```ts
/**
 * The starter configuration, and the one place its text lives.
 *
 * `init` renders it with no answers and `setup` renders it with the operator's,
 * so the commented file is the same file in both cases. The comments are the
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

/** JSON string literal, or `null` for an answer nobody gave. */
function value(answer: string | undefined): string {
  return answer === undefined || answer === '' ? 'null' : JSON.stringify(answer);
}

/** A JSON array of strings, rendered on one line. */
function list(answers: readonly string[] | undefined): string {
  if (answers === undefined || answers.length === 0) return '[]';
  return `[${answers.map((entry) => JSON.stringify(entry)).join(', ')}]`;
}

/** The residency.allow body: either the commented example, or real entries. */
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

  return `    // Every upstream hushgate may forward to, and why it is permitted.
    "allow": [
${rendered}
    ]`;
}

export function renderConfig(answers: SetupAnswers = {}): string {
  const organisation = answers.organisation ?? {};

  return `{
  // hushgate configuration. Comments are allowed and stripped on load.
  ...
}
`;
}
```

The body of the returned template is the existing `STARTER` text with exactly
five substitutions — everything else stays character for character, which is
what the fixture test enforces:

| In the template | Replaced by |
|---|---|
| `"port": 8787` | `"port": ${answers.port ?? 8787}` |
| `"openai": "https://api.openai.com"` | `"openai": ${JSON.stringify(answers.upstreams?.openai ?? 'https://api.openai.com')}` |
| `"anthropic": "https://api.anthropic.com"` | `"anthropic": ${JSON.stringify(answers.upstreams?.anthropic ?? 'https://api.anthropic.com')}` |
| the whole `residency.allow` block including its comment | `${allowBlock(answers.allow)}` |
| the four `organisation` fields | `${value(organisation.name)}`, `${value(organisation.contact)}`, `${value(organisation.dpo)}`, `${list(organisation.purposes)}` |

Note the backslash escaping: inside a template literal the starter's
`"EMP-\\\\d{5}"` example becomes `"EMP-\\\\\\\\d{5}"`. The fixture test catches
it if this is wrong.

- [ ] **Step 5: Rewrite `init` to call it**

In `src/cli/commands/init.ts`, delete the `STARTER` constant entirely, import
`renderConfig` from `../template.js`, and replace the write with:

```ts
  writeFileSync(path, renderConfig(), 'utf8');
```

Nothing else in the file changes — the flags, the existing-file check and the
"Next:" block stay exactly as they are.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/cli.template.test.ts test/cli.test.ts`
Expected: all pass. The byte-for-byte case is the one that matters: it proves
`init` still writes what 0.1.0 wrote.

- [ ] **Step 7: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck && npm run check:docs
git add src/cli/template.ts src/cli/commands/init.ts test/cli.template.test.ts test/fixtures/starter-config.json
git commit -m "refactor(cli): render the starter config from one template

init and setup both have to produce the same commented file, and two
copies of that text would drift the first time someone edited one of
them. renderConfig takes the answers and fills five slots; init calls it
with none and gets what it always wrote, pinned byte for byte against a
fixture captured from the published 0.1.0.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 3: Teach the registry what can be an upstream

**Files:**
- Modify: `src/residency/registry.ts:31-88` (the `EndpointEntry` interface and entries)
- Test: `test/residency.registry.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `EndpointEntry` gains three optional readonly fields — `baseUrl?: string`, `api?: 'openai' | 'anthropic'`, `trialModel?: string`; and `export function proxyableEndpoints(): readonly EndpointEntry[]` returning only entries that carry all three.

- [ ] **Step 1: Write the failing test**

Append to `test/residency.registry.test.ts`:

```ts
import { proxyableEndpoints, BUILTIN_ENDPOINTS } from '../src/residency/registry.js';

describe('proxyableEndpoints', () => {
  it('offers only endpoints hushgate can actually forward to', () => {
    for (const entry of proxyableEndpoints()) {
      expect(entry.baseUrl, entry.id).toBeDefined();
      expect(['openai', 'anthropic']).toContain(entry.api);
      expect(entry.trialModel, entry.id).toBeDefined();
      expect(entry.baseUrl).toMatch(/^https:\/\//u);
      expect(entry.hosts.some((host) => host.includes('*')), entry.id).toBe(false);
    }
  });

  it('is the five the wizard offers, EU first', () => {
    expect(proxyableEndpoints().map((entry) => entry.id)).toEqual([
      'mistral.api',
      'alephalpha.api',
      'openai.api',
      'anthropic.api',
      'google.generativelanguage',
    ]);
  });

  it('leaves the rest in the registry for residency reporting', () => {
    const all = BUILTIN_ENDPOINTS.map((entry) => entry.id);
    expect(all).toContain('aws.bedrock.eu-central-1');
    expect(proxyableEndpoints().map((entry) => entry.id)).not.toContain('aws.bedrock.eu-central-1');
  });

  it('never marks a wildcard host as proxyable', () => {
    for (const entry of BUILTIN_ENDPOINTS) {
      if (entry.hosts.some((host) => host.startsWith('*.'))) {
        expect(entry.api, entry.id).toBeUndefined();
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/residency.registry.test.ts`
Expected: FAIL — `proxyableEndpoints is not exported`

- [ ] **Step 3: Write the implementation**

In `src/residency/registry.ts`, extend the interface:

```ts
  /**
   * Base URL to forward to, for the endpoints hushgate can actually proxy.
   * The registry stores host patterns because it answers "where does this
   * request land"; the wizard needs somewhere to send one. Absent wherever the
   * host varies per customer — an Azure resource, an OVH deployment.
   */
  readonly baseUrl?: string;
  /**
   * Which of hushgate's two routes this endpoint speaks. Absent means the
   * entry is known for residency purposes but cannot be an upstream: Bedrock
   * is a real endpoint in a real jurisdiction and speaks neither protocol.
   */
  readonly api?: 'openai' | 'anthropic';
  /** Model the trial page prefills. Editable there; defaults age. */
  readonly trialModel?: string;
```

Add the three fields to exactly five entries:

| id | baseUrl | api | trialModel |
|---|---|---|---|
| `mistral.api` | `https://api.mistral.ai` | `openai` | `mistral-small-latest` |
| `alephalpha.api` | `https://api.aleph-alpha.com` | `openai` | `luminous-base` |
| `openai.api` | `https://api.openai.com` | `openai` | `gpt-4o-mini` |
| `anthropic.api` | `https://api.anthropic.com` | `anthropic` | `claude-sonnet-4-5` |
| `google.generativelanguage` | `https://generativelanguage.googleapis.com` | `openai` | `gemini-2.0-flash` |

Then, next to `knownJurisdictions`:

```ts
/**
 * The endpoints the wizard may offer as an upstream: those that carry a URL, a
 * protocol hushgate speaks and a model to start from. EU and EEA first, because
 * that is the order in which an operator should be considering them.
 */
export function proxyableEndpoints(): readonly EndpointEntry[] {
  return BUILTIN_ENDPOINTS.filter(
    (entry) => entry.baseUrl !== undefined && entry.api !== undefined && entry.trialModel !== undefined,
  );
}
```

Order the five entries in `BUILTIN_ENDPOINTS` so Mistral and Aleph Alpha
precede the US three, or sort inside `proxyableEndpoints` by
`leavesTheEea(entry.jurisdiction)`. Prefer the sort — the array's own order
serves `residency --registry`, which is a different audience.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/residency.registry.test.ts test/cli.residency.test.ts`
Expected: all pass. `cli.residency` must be untouched — the registry listing is
unchanged, only extended.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/residency/registry.ts test/residency.registry.test.ts
git commit -m "feat(residency): mark which endpoints can be an upstream

The registry answers where a request lands, so it stores host patterns and
lists 22 endpoints. The wizard has to offer a URL, and it may only offer
what the proxy can forward: hushgate speaks two protocols, and Bedrock
speaks neither. Three optional fields say which entries qualify; everything
else stays listed for residency reporting and is never offered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 4: `hushgate setup`, the configuration branch

**Files:**
- Create: `src/cli/commands/setup.ts`
- Modify: `src/cli/run.ts` (register the command, second in the list after `init`)
- Test: `test/cli.setup.test.ts`

**Interfaces:**
- Consumes: `Prompter`, `Choice` (Task 1); `renderConfig`, `SetupAnswers` (Task 2); `proxyableEndpoints` (Task 3); `runChecks`, `tally` from `src/doctor/checks.js`.
- Produces: `export function setup(cli: Cli, argv: readonly string[]): Promise<number>`, `export const SETUP_FLAGS: FlagSpecs`, `export const SETUP_SUMMARY: string`.

- [ ] **Step 1: Write the failing test**

Create `test/cli.setup.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, type Cli } from '../src/cli/cli.js';
import type { Choice, Prompter } from '../src/cli/prompt.js';
import { run } from '../src/cli/run.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-setup-'));
  dirs.push(dir);
  return dir;
}

/** A prompter that reads from a script and records what it was asked. */
function scripted(answers: readonly string[]): { prompt: () => Prompter; asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];

  const next = (question: string): string => {
    asked.push(question);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`unscripted question: ${question}`);
    return answer;
  };

  const prompter: Prompter = {
    text: (question) => Promise.resolve(next(question)),
    choose: <T,>(question: string, choices: readonly Choice<T>[]): Promise<T> => {
      const picked = choices[Number.parseInt(next(question), 10) - 1];
      if (picked === undefined) throw new Error(`no such choice for ${question}`);
      return Promise.resolve(picked.value);
    },
    confirm: (question) => Promise.resolve(next(question) === 'y'),
    close: () => {},
  };

  return { prompt: () => prompter, asked };
}

interface Capture {
  readonly cli: Cli;
  out(): string;
  err(): string;
}

function capture(argv: string[], cwd: string, prompt?: () => Prompter): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cli: {
      argv,
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      env: {},
      cwd,
      ...(prompt === undefined ? {} : { prompt }),
    },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

describe('hushgate setup — configuration branch', () => {
  it('writes a configuration from the answers and reports on it', async () => {
    const dir = workspace();
    const script = scripted([
      '2', // set it up
      '3', // OpenAI
      'Nordwerk Maschinenbau GmbH',
      'datenschutz@nordwerk-gmbh.de',
      '', // no DPO
      '', // no purpose
      '', // no legal basis
      'n', // do not try it now
    ]);

    const c = capture(['setup'], dir, script.prompt);
    const code = await run(c.cli);

    expect(code).toBe(EXIT.ok);
    expect(existsSync(join(dir, 'hushgate.config.json'))).toBe(true);

    const written = readFileSync(join(dir, 'hushgate.config.json'), 'utf8');
    expect(written).toContain('"name": "Nordwerk Maschinenbau GmbH"');
    expect(written).toContain('"contact": "datenschutz@nordwerk-gmbh.de"');
    expect(written).toContain('"dpo": null');
    expect(written).toContain('https://api.openai.com');
  });

  it('marks every question after the provider as optional', async () => {
    const dir = workspace();
    const script = scripted(['2', '1', '', '', '', '', '', 'n']);
    await run(capture(['setup'], dir, script.prompt).cli);

    const optional = script.asked.slice(2);
    for (const question of optional) expect(question).toMatch(/optional/iu);
  });

  it('says what is still missing instead of asking for it', async () => {
    const dir = workspace();
    const script = scripted(['2', '3', '', '', '', '', '', 'n']);
    const c = capture(['setup'], dir, script.prompt);
    await run(c.cli);

    expect(c.out()).toContain('no residency allowlist is configured');
    expect(c.out()).toContain('residency.allow');
  });

  it('records a legal basis when one is given', async () => {
    const dir = workspace();
    const script = scripted([
      '2',
      '1', // Mistral
      '',
      '',
      '',
      '',
      'Art. 28 DPA of 2026-01-12',
      'n',
    ]);
    const c = capture(['setup'], dir, script.prompt);
    await run(c.cli);

    const written = readFileSync(join(dir, 'hushgate.config.json'), 'utf8');
    expect(written).toContain('Art. 28 DPA of 2026-01-12');
    expect(written).toContain('"jurisdiction": "FR"');
    expect(c.out()).not.toContain('no residency allowlist is configured');
  });

  it('refuses to overwrite an existing configuration without --force', async () => {
    const dir = workspace();
    const first = scripted(['2', '3', '', '', '', '', '', 'n']);
    await run(capture(['setup'], dir, first.prompt).cli);

    const second = scripted(['2', '3', '', '', '', '', '', 'n']);
    const c = capture(['setup'], dir, second.prompt);
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('--force');
  });

  it('sends a caller with no terminal to init', async () => {
    const dir = workspace();
    const c = capture(['setup'], dir); // no prompt factory: not a TTY
    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('hushgate init');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.setup.test.ts`
Expected: FAIL — `unknown command "setup"`

- [ ] **Step 3: Write the implementation**

Create `src/cli/commands/setup.ts`. The configuration branch only; the trial
branch is Task 9 and until then answers `1` with "not built yet" is acceptable
*within this task only* — Task 9 replaces it.

```ts
/**
 * `hushgate setup` — the one command that gets someone from nothing to either
 * a working configuration or a demonstration.
 *
 * The rule for what it asks: only what hushgate cannot find out for itself.
 * The port it can probe, the extractor it can look up on PATH, the
 * jurisdiction it reads from its own registry. That leaves the provider, which
 * is genuinely a decision, and a handful of optional details.
 *
 * It deliberately does not ask for a legal basis. That is the one answer an
 * operator does not have at the keyboard, and blocking on it is how a tool
 * ends up abandoned at step two. The file is written without an allowlist and
 * the doctor run afterwards says exactly what is missing and where it goes.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, resolve as joinPath } from 'node:path';
import { CONFIG_FILENAME, loadConfig } from '../../config.js';
import { runChecks, tally, type Finding, type Severity } from '../../doctor/checks.js';
import { HushgateError } from '../../errors.js';
import { jurisdiction } from '../../residency/jurisdictions.js';
import { proxyableEndpoints } from '../../residency/registry.js';
import type { EndpointEntry } from '../../residency/registry.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';
import type { Choice, Prompter } from '../prompt.js';
import { renderConfig, type SetupAnswers } from '../template.js';

export const SETUP_FLAGS: FlagSpecs = {
  path: { type: 'string', alias: 'p', description: 'where to write the config', placeholder: '<path>' },
  force: { type: 'boolean', alias: 'f', description: 'overwrite an existing config' },
};

export const SETUP_SUMMARY = 'set hushgate up, or try it out, by answering questions';

const MARKS: Readonly<Record<Severity, string>> = {
  ok: 'ok  ',
  note: 'note',
  warn: 'warn',
  fail: 'FAIL',
};

export async function setup(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SETUP_FLAGS);

  const open = cli.prompt;
  if (open === undefined) {
    throw new HushgateError(
      'setup needs a terminal to ask questions; for scripts and CI use "hushgate init"',
    );
  }

  const prompter = open();
  try {
    cli.stdout(`\n  hushgate setup. Nothing personal leaves this machine.\n\n`);

    const mode = await prompter.choose('What would you like to do?', [
      { label: 'Try it', hint: '— see in a minute what the provider would receive', value: 'trial' },
      { label: 'Set it up', hint: '— write a configuration for real use', value: 'config' },
    ]);

    const endpoint = await chooseProvider(prompter);

    if (mode === 'trial') {
      return await runTrial(cli, prompter, endpoint); // Task 9
    }

    return await writeConfiguration(cli, prompter, parsed, endpoint);
  } finally {
    prompter.close();
  }
}

/** The provider question, EU and EEA endpoints first. */
async function chooseProvider(prompter: Prompter): Promise<EndpointEntry> {
  const choices: Choice<EndpointEntry>[] = proxyableEndpoints().map((entry) => ({
    label: entry.label,
    hint: `${entry.jurisdiction}${jurisdiction(entry.jurisdiction).transfer === 'third-country' ? ' — third country' : ''}`,
    value: entry,
  }));

  return await prompter.choose('Which provider?', choices);
}
```

The configuration branch itself:

```ts
async function writeConfiguration(
  cli: Cli,
  prompter: Prompter,
  parsed: ReturnType<typeof parseFlags>,
  endpoint: EndpointEntry,
): Promise<number> {
  const target = stringFlag(parsed, 'path') ?? CONFIG_FILENAME;
  const path = isAbsolute(target) ? target : joinPath(cli.cwd, target);

  if (existsSync(path) && !boolFlag(parsed, 'force')) {
    throw new HushgateError(`${path} already exists; pass --force to overwrite it`);
  }

  const name = await prompter.text('Company (optional)');
  const contact = await prompter.text('Contact for data protection questions (optional)');
  const dpo = await prompter.text('Data protection officer (optional)');
  const purpose = await prompter.text('What the model is used for, in one line (optional)');
  const legalBasis = await prompter.text(
    `Legal basis for sending data to ${endpoint.hosts[0] ?? endpoint.label} (optional)`,
  );

  const answers: SetupAnswers = {
    organisation: {
      ...(name === '' ? {} : { name }),
      ...(contact === '' ? {} : { contact }),
      ...(dpo === '' ? {} : { dpo }),
      ...(purpose === '' ? {} : { purposes: [purpose] }),
    },
    upstreams: upstreamsFor(endpoint),
    ...(legalBasis === ''
      ? {}
      : {
          allow: [
            {
              endpoint: endpoint.baseUrl ?? '',
              jurisdiction: endpoint.jurisdiction,
              legalBasis,
            },
          ],
        }),
  };

  writeFileSync(path, renderConfig(answers), 'utf8');
  cli.stdout(`\n  wrote ${path}\n\n`);

  reportOnIt(cli, path);
  return EXIT.ok;
}

/** Point the chosen protocol's upstream at the endpoint; leave the other alone. */
function upstreamsFor(entry: EndpointEntry): { openai?: string; anthropic?: string } {
  if (entry.baseUrl === undefined || entry.api === undefined) return {};
  return entry.api === 'openai' ? { openai: entry.baseUrl } : { anthropic: entry.baseUrl };
}

/** Run the doctor checks in place, in doctor's own shape. */
function reportOnIt(cli: Cli, configPath: string): void {
  const { config, source } = loadConfig({ path: configPath, cwd: cli.cwd, env: cli.env });
  const findings = runChecks({
    config,
    configPath: source.path,
    auditPath: isAbsolute(config.audit.path) ? config.audit.path : joinPath(cli.cwd, config.audit.path),
  });

  const lines: string[] = ['  doctor'];
  for (const finding of findings) {
    if (finding.severity === 'ok' || finding.severity === 'note') continue;
    lines.push(`    ${MARKS[finding.severity]}  ${finding.message}`);
    if (finding.remedy !== undefined) lines.push(`          → ${finding.remedy}`);
  }

  const counts = tally(findings);
  lines.push(
    counts.fail + counts.warn === 0
      ? '    nothing unsafe found'
      : '    run "hushgate doctor" for the whole report',
    '',
    '  Start it with:  hushgate serve',
    '',
  );

  cli.stdout(`${lines.join('\n')}\n`);
}
```

- [ ] **Step 4: Register the command**

In `src/cli/run.ts`, import from `./commands/setup.js` and add the entry
directly after `init` in `COMMANDS`, so it appears second in the help:

```ts
  setup: {
    summary: SETUP_SUMMARY,
    usage: 'hushgate setup [--path <path>] [--force]',
    flags: SETUP_FLAGS,
    run: setup,
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/cli.setup.test.ts test/cli.test.ts`
Expected: all pass, including the existing help-output assertions in
`cli.test.ts` — if one pins the command list, update it to include `setup`.

- [ ] **Step 6: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck && npm run check:docs
git add src/cli/commands/setup.ts src/cli/run.ts test/cli.setup.test.ts
git commit -m "feat(cli): add setup, the configuration branch

Five questions, four of them optional and labelled as such; the provider
is the only one that has to be answered, because it is the only one
hushgate cannot work out for itself. The legal basis is asked for but
never insisted on — the doctor run printed afterwards names what is
missing and where it goes, which gets an operator to a working proxy
without stopping them at the one question their lawyer has to answer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 5: Trial sessions, bounded

**Files:**
- Create: `src/playground/session.ts`
- Test: `test/playground.session.test.ts`

**Interfaces:**
- Consumes: `Session` from `src/redact/session.js`.
- Produces:
  - `export interface TrialSession { readonly id: string; readonly session: Session; readonly model: string; readonly createdAt: number }`
  - `export interface TrialStoreOptions { readonly max?: number; readonly ttlMs?: number; readonly now?: () => number }`
  - `export class TrialStore { constructor(options?: TrialStoreOptions); create(session: Session, model: string): TrialSession; get(id: string): TrialSession | undefined; get size(): number }`

- [ ] **Step 1: Write the failing test**

Create `test/playground.session.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Session } from '../src/redact/session.js';
import { TrialStore } from '../src/playground/session.js';

const MINUTE = 60_000;

describe('TrialStore', () => {
  it('hands back the session it was given', () => {
    const store = new TrialStore();
    const created = store.create(new Session(), 'gpt-4o-mini');
    expect(store.get(created.id)?.session).toBe(created.session);
    expect(store.get(created.id)?.model).toBe('gpt-4o-mini');
  });

  it('does not know an id it never issued', () => {
    expect(new TrialStore().get('nope')).toBeUndefined();
  });

  it('issues ids that are not guessable in order', () => {
    const store = new TrialStore();
    const a = store.create(new Session(), 'm');
    const b = store.create(new Session(), 'm');
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(22);
  });

  it('drops the oldest when it is full', () => {
    const store = new TrialStore({ max: 2 });
    const first = store.create(new Session(), 'm');
    store.create(new Session(), 'm');
    store.create(new Session(), 'm');

    expect(store.size).toBe(2);
    expect(store.get(first.id)).toBeUndefined();
  });

  it('forgets a session once its time is up', () => {
    let now = 0;
    const store = new TrialStore({ ttlMs: 30 * MINUTE, now: () => now });
    const created = store.create(new Session(), 'm');

    now = 29 * MINUTE;
    expect(store.get(created.id)).toBeDefined();

    now = 31 * MINUTE;
    expect(store.get(created.id)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/playground.session.test.ts`
Expected: FAIL — `Failed to resolve import "../src/playground/session.js"`

- [ ] **Step 3: Write the implementation**

Create `src/playground/session.ts`:

```ts
/**
 * The trial page's sessions: a placeholder mapping that has to survive from the
 * preview to the reply, and no longer.
 *
 * The proxy mints a session per request and drops it, because the mapping back
 * to real personal data is a liability that should not outlive its use. The
 * trial cannot do that — the operator looks at the sanitised text, thinks, and
 * then presses Send — so the mapping is held, but bounded on both axes: a
 * count, and a clock. It never reaches disk, and it dies with the process.
 */
import { randomBytes } from 'node:crypto';
import type { Session } from '../redact/session.js';

const DEFAULT_MAX = 16;
const DEFAULT_TTL_MS = 30 * 60_000;

export interface TrialSession {
  readonly id: string;
  readonly session: Session;
  readonly model: string;
  readonly createdAt: number;
}

export interface TrialStoreOptions {
  /** Most sessions held at once. Oldest goes first. */
  readonly max?: number;
  /** How long a session stays usable. */
  readonly ttlMs?: number;
  /** Injected so the tests do not wait half an hour. */
  readonly now?: () => number;
}

export class TrialStore {
  private readonly entries = new Map<string, TrialSession>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: TrialStoreOptions = {}) {
    this.max = options.max ?? DEFAULT_MAX;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
  }

  create(session: Session, model: string): TrialSession {
    this.sweep();

    // Map iterates in insertion order, so the first key is the oldest.
    while (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }

    const entry: TrialSession = {
      id: randomBytes(16).toString('base64url'),
      session,
      model,
      createdAt: this.now(),
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): TrialSession | undefined {
    this.sweep();
    return this.entries.get(id);
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt <= cutoff) this.entries.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/playground.session.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/playground/session.ts test/playground.session.test.ts
git commit -m "feat(playground): hold a trial mapping, bounded on two axes

The proxy drops its session with the request, because a mapping back to
real personal data should not outlive its use. The trial cannot: the
operator reads the sanitised text and then decides to send. So the
mapping is held, capped at 16 and expiring after 30 minutes, never
written down, and gone when the process ends.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 6: The page, and the door it comes through

**Files:**
- Create: `src/playground/page.ts`, `src/playground/routes.ts`, `src/playground/index.ts`
- Modify: `src/proxy/server.ts` (`ProxyOptions` gains `playground`; dispatch before route lookup, beside `/healthz`)
- Test: `test/playground.page.test.ts`

**Interfaces:**
- Consumes: `TrialStore` (Task 5).
- Produces:
  - `export const PLAYGROUND_PREFIX = '/__playground'`
  - `export interface PlaygroundOptions { readonly store: TrialStore; readonly apiKey: string; readonly endpointLabel: string; readonly defaultModel: string; readonly dictionaryIsEmpty: boolean }`
  - `export function handlePlayground(request: IncomingMessage, response: ServerResponse, options: PlaygroundOptions): Promise<boolean>` — returns `true` when it answered the request
  - `ProxyOptions` gains `readonly playground?: PlaygroundOptions`

- [ ] **Step 1: Write the failing test**

Create `test/playground.page.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TrialStore } from '../src/playground/session.js';
import { startHarness } from './helpers/proxy-harness.js';

function playground(): { store: TrialStore } & Record<string, unknown> {
  return {
    store: new TrialStore(),
    apiKey: 'sk-test',
    endpointLabel: 'OpenAI API',
    defaultModel: 'gpt-4o-mini',
    dictionaryIsEmpty: true,
  };
}

describe('the trial page', () => {
  it('is not mounted by an ordinary serve', async () => {
    const harness = await startHarness();
    try {
      expect((await harness.get('/__playground')).status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('is served when setup asked for it', async () => {
    const harness = await startHarness({ proxy: { playground: playground() } });
    try {
      const response = await harness.get('/__playground');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('What the provider sees');
    } finally {
      await harness.close();
    }
  });

  it('locks the page down so it cannot reach the network', async () => {
    const harness = await startHarness({ proxy: { playground: playground() } });
    try {
      const csp = (await harness.get('/__playground')).headers.get('content-security-policy');
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect((await harness.get('/__playground')).headers.get('cache-control')).toContain('no-store');
    } finally {
      await harness.close();
    }
  });

  it('serves the script and the stylesheet separately', async () => {
    const harness = await startHarness({ proxy: { playground: playground() } });
    try {
      const js = await harness.get('/__playground/app.js');
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('text/javascript');

      const css = await harness.get('/__playground/app.css');
      expect(css.status).toBe(200);
      expect(css.headers.get('content-type')).toContain('text/css');
    } finally {
      await harness.close();
    }
  });

  it('says where names come from, because the trial dictionary is empty', async () => {
    const harness = await startHarness({ proxy: { playground: playground() } });
    try {
      expect(await (await harness.get('/__playground')).text()).toContain(
        'Personal names come only from your dictionary',
      );
    } finally {
      await harness.close();
    }
  });

  it('never carries the API key into the page', async () => {
    const harness = await startHarness({ proxy: { playground: playground() } });
    try {
      const body = await (await harness.get('/__playground')).text();
      expect(body).not.toContain('sk-test');
      expect(await (await harness.get('/__playground/app.js')).text()).not.toContain('sk-test');
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/playground.page.test.ts`
Expected: FAIL — `Failed to resolve import "../src/playground/session.js"` is
already satisfied; the failure is `playground` not accepted in `ProxyOptions`.

- [ ] **Step 3: Write the page**

Create `src/playground/page.ts` exporting three string constants: `PAGE_HTML`
(a function of the options, so the endpoint label, the model and the dictionary
notice are interpolated), `PAGE_CSS` and `PAGE_JS`.

Requirements the tests pin, plus what the spec asks for:

- four sections in order: `Your text`, `What the provider sees`,
  `Reply, as it arrives`, `Reply, rehydrated`;
- a textarea and a drop zone in section 1; a findings list, a model input
  prefilled from `defaultModel`, and a `Send` button in section 2;
- the dictionary notice under section 2 whenever `dictionaryIsEmpty`;
- no inline `<script>` or `<style>` — both are `<link>`/`<src>` to the two
  routes, so the CSP can stay at `'self'`;
- `PAGE_JS` talks to `POST /__playground/preview` and `POST /__playground/send`
  and never sees a key.

Escape the interpolated values with a local `escapeHtml` — the endpoint label
comes from the registry, but the model is typed by the operator and comes back
through `defaultModel`.

- [ ] **Step 4: Write the routes**

Create `src/playground/routes.ts` with `PLAYGROUND_PREFIX`,
`PlaygroundOptions`, and `handlePlayground`. For this task it answers only the
three GETs and returns `false` for anything else under the prefix, so Task 7
and Task 8 slot in. Every response carries:

```ts
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};
```

Create `src/playground/index.ts` re-exporting `TrialStore`, `TrialSession`,
`PlaygroundOptions`, `PLAYGROUND_PREFIX` and `handlePlayground`.

- [ ] **Step 5: Mount it**

In `src/proxy/server.ts`, add to `ProxyOptions`:

```ts
  /**
   * Mounts the trial page. Set only by `hushgate setup`: the page turns
   * placeholders back into personal data, which is exactly what a production
   * proxy must not offer, so there is deliberately no flag that enables it on
   * `serve`.
   */
  readonly playground?: PlaygroundOptions;
```

and in `handle`, immediately after `const pathname = pathOf(request);` and
before the `/healthz` branch:

```ts
    if (options.playground !== undefined && pathname.startsWith(PLAYGROUND_PREFIX)) {
      if (await handlePlayground(request, response, options.playground)) return;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/playground.page.test.ts test/proxy.test.ts`
Expected: all pass. `proxy.test.ts` must be untouched — with no `playground`
option, the prefix is not special and falls through to the existing 404.

- [ ] **Step 7: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/playground/ src/proxy/server.ts test/playground.page.test.ts
git commit -m "feat(playground): serve the trial page, and only from setup

The page turns placeholders back into personal data, so it is mounted by
an option that only setup sets — there is no serve flag for it, on
purpose. Script and stylesheet are separate routes so the policy can stay
at default-src 'none' with script-src 'self': the page cannot fetch
anything, which is the same promise the rest of hushgate makes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 7: Preview — what the provider would see

**Files:**
- Modify: `src/playground/routes.ts` (add the `POST /preview` branch)
- Test: `test/playground.preview.test.ts`

**Interfaces:**
- Consumes: `TrialStore`, `handlePlayground` (Tasks 5–6); `Session`, `countByKind` from `src/redact/session.js`.
- Produces: `POST /__playground/preview` accepting `{"text": string, "model"?: string}` and answering `{"sessionId": string, "sanitised": string, "findings": Record<string, number>}`.

- [ ] **Step 1: Write the failing test**

Create `test/playground.preview.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TrialStore } from '../src/playground/session.js';
import { startHarness } from './helpers/proxy-harness.js';

const LETTER = [
  'Unsere Mitarbeiterin schreibt an k.vogelsang@nordwerk-gmbh.de,',
  'Tel. +49 40 8823119. Bitte auf DE89 3704 0044 0532 0130 00 erstatten.',
].join('\n');

function withPlayground(): Parameters<typeof startHarness>[0] {
  return {
    proxy: {
      playground: {
        store: new TrialStore(),
        apiKey: 'sk-test',
        endpointLabel: 'OpenAI API',
        defaultModel: 'gpt-4o-mini',
        dictionaryIsEmpty: true,
      },
    },
  };
}

describe('POST /__playground/preview', () => {
  it('returns the sanitised text and the findings by kind', async () => {
    const harness = await startHarness(withPlayground());
    try {
      const response = await harness.post('/__playground/preview', { text: LETTER });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        sessionId: string;
        sanitised: string;
        findings: Record<string, number>;
      };

      expect(body.sanitised).toContain('[EMAIL_1]');
      expect(body.sanitised).toContain('[IBAN_1]');
      expect(body.sanitised).not.toContain('k.vogelsang@nordwerk-gmbh.de');
      expect(body.findings['EMAIL']).toBe(1);
      expect(body.findings['IBAN']).toBe(1);
      expect(body.sessionId).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
    } finally {
      await harness.close();
    }
  });

  it('never puts a real value in the findings', async () => {
    const harness = await startHarness(withPlayground());
    try {
      const body = await (await harness.post('/__playground/preview', { text: LETTER })).text();
      expect(body).not.toContain('vogelsang');
      expect(body).not.toContain('8823119');
    } finally {
      await harness.close();
    }
  });

  it('keeps the session so a later send can reuse it', async () => {
    const store = new TrialStore();
    const harness = await startHarness({
      proxy: {
        playground: {
          store,
          apiKey: 'sk-test',
          endpointLabel: 'OpenAI API',
          defaultModel: 'gpt-4o-mini',
          dictionaryIsEmpty: true,
        },
      },
    });
    try {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', { text: LETTER })
      ).json()) as { sessionId: string };

      const held = store.get(sessionId);
      expect(held).toBeDefined();
      expect(held?.session.restore('[EMAIL_1]')).toBe('k.vogelsang@nordwerk-gmbh.de');
    } finally {
      await harness.close();
    }
  });

  it('refuses an empty body with 400, not a stack trace', async () => {
    const harness = await startHarness(withPlayground());
    try {
      expect((await harness.post('/__playground/preview', {})).status).toBe(400);
    } finally {
      await harness.close();
    }
  });

  it('is not reachable when the playground is not mounted', async () => {
    const harness = await startHarness();
    try {
      expect((await harness.post('/__playground/preview', { text: 'x' })).status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/playground.preview.test.ts`
Expected: FAIL — the first case gets 404, because `handlePlayground` returns
`false` for POST.

- [ ] **Step 3: Write the implementation**

In `src/playground/routes.ts`, add the branch. Read the body with the server's
existing helper in `src/proxy/http.ts` rather than a second reader; cap it at
`config.limits.maxBodyBytes`. Then:

```ts
const session = new Session();
const { text: sanitised, findings } = session.redact(text);
const entry = options.store.create(session, model ?? options.defaultModel);

sendJson(response, 200, {
  sessionId: entry.id,
  sanitised,
  findings: countByKind(findings),
});
```

`countByKind` returns kinds and counts and never values — which is what makes
the second test above hold by construction, not by filtering.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/playground.preview.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/playground/routes.ts test/playground.preview.test.ts
git commit -m "feat(playground): preview what the provider would receive

The proxy pseudonymises while forwarding, but the trial has to show the
sanitised text and then send exactly that. So preview runs one Session
and keeps it: the placeholders on screen are the ones the model will get,
and the reply rehydrates from the same mapping. The response carries
kinds and counts, never values — countByKind is the only thing it reports.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 8: Send — two channels, one stream

**Files:**
- Modify: `src/playground/routes.ts` (add the `POST /send` branch)
- Test: `test/playground.send.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7; `SseRehydrator` and `OPENAI_STREAM_DELTAS` / `ANTHROPIC_STREAM_DELTAS` from `src/stream/index.js`; the upstream client from `src/proxy/upstream.js`.
- Produces: `POST /__playground/send` accepting `{"sessionId": string}` and answering `text/event-stream` with `raw` and `hydrated` events, then `done`.

- [ ] **Step 1: Write the failing test**

Create `test/playground.send.test.ts`. Use the fake upstream to emit a reply
whose placeholder is deliberately split across two chunks — that is the case
the whole two-channel design has to survive:

```ts
import { describe, expect, it } from 'vitest';
import { TrialStore } from '../src/playground/session.js';
import { startHarness } from './helpers/proxy-harness.js';

/** Collect an SSE body into its events, by name. */
async function collect(response: Response): Promise<{ raw: string; hydrated: string }> {
  const text = await response.text();
  const out = { raw: '', hydrated: '' };

  for (const block of text.split('\n\n')) {
    const name = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    if (name === undefined || data === undefined || name === 'done') continue;
    const delta = (JSON.parse(data) as { delta?: string }).delta ?? '';
    if (name === 'raw') out.raw += delta;
    if (name === 'hydrated') out.hydrated += delta;
  }

  return out;
}

describe('POST /__playground/send', () => {
  it('streams the reply raw and rehydrated, over a split placeholder', async () => {
    const store = new TrialStore();
    const harness = await startHarness({
      handler: () => ({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        // `body` is required by FakeReply; `chunks` is what actually goes on
        // the wire. "[EMAIL_1]" is cut in half on purpose, across two events.
        body: '',
        chunks: [
          'data: {"choices":[{"delta":{"content":"I will write to [EMA"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"IL_1] today."}}]}\n\n',
          'data: [DONE]\n\n',
        ],
      }),
      proxy: {
        playground: {
          store,
          apiKey: 'sk-test',
          endpointLabel: 'OpenAI API',
          defaultModel: 'gpt-4o-mini',
          dictionaryIsEmpty: true,
        },
      },
    });

    try {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', {
          text: 'Write to k.vogelsang@nordwerk-gmbh.de please.',
        })
      ).json()) as { sessionId: string };

      const response = await harness.post('/__playground/send', { sessionId });
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const { raw, hydrated } = await collect(response);
      expect(raw).toBe('I will write to [EMAIL_1] today.');
      expect(hydrated).toBe('I will write to k.vogelsang@nordwerk-gmbh.de today.');
    } finally {
      await harness.close();
    }
  });

  it('sends the sanitised text upstream, never the original', async () => {
    const store = new TrialStore();
    const harness = await startHarness({
      proxy: {
        playground: {
          store,
          apiKey: 'sk-test',
          endpointLabel: 'OpenAI API',
          defaultModel: 'gpt-4o-mini',
          dictionaryIsEmpty: true,
        },
      },
    });

    try {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', {
          text: 'Write to k.vogelsang@nordwerk-gmbh.de please.',
        })
      ).json()) as { sessionId: string };

      await harness.post('/__playground/send', { sessionId });

      const seen = harness.upstream.lastRequest?.body ?? '';
      expect(seen).toContain('[EMAIL_1]');
      expect(seen).not.toContain('vogelsang');
    } finally {
      await harness.close();
    }
  });

  it('carries the key the CLI holds, not one from the page', async () => {
    const store = new TrialStore();
    const harness = await startHarness({
      proxy: {
        playground: {
          store,
          apiKey: 'sk-from-the-terminal',
          endpointLabel: 'OpenAI API',
          defaultModel: 'gpt-4o-mini',
          dictionaryIsEmpty: true,
        },
      },
    });

    try {
      const { sessionId } = (await (
        await harness.post('/__playground/preview', { text: 'hello' })
      ).json()) as { sessionId: string };

      await harness.post('/__playground/send', {
        sessionId,
        apiKey: 'sk-injected-by-a-page',
      });

      const auth = harness.upstream.lastRequest?.headers['authorization'];
      expect(auth).toBe('Bearer sk-from-the-terminal');
    } finally {
      await harness.close();
    }
  });

  it('answers 404 for a session it never issued', async () => {
    const harness = await startHarness({
      proxy: {
        playground: {
          store: new TrialStore(),
          apiKey: 'sk-test',
          endpointLabel: 'OpenAI API',
          defaultModel: 'gpt-4o-mini',
          dictionaryIsEmpty: true,
        },
      },
    });
    try {
      expect((await harness.post('/__playground/send', { sessionId: 'nope' })).status).toBe(404);
    } finally {
      await harness.close();
    }
  });
});
```

`FakeReply` already carries `chunks` and `chunkDelayMs`
(`test/helpers/fake-upstream.ts:20-35`), so no helper change is needed — but
`body` is a required field, so a chunked reply still has to pass `body: ''`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/playground.send.test.ts`
Expected: FAIL — 404 from `/send`.

- [ ] **Step 3: Write the implementation**

In `src/playground/routes.ts`:

1. Look the session up; 404 when the store does not know it.
2. Build the request body for the endpoint's protocol from the **sanitised**
   text held on the session, and the model on the entry. Ignore any `apiKey`
   in the request body — the key comes from `options.apiKey` only. That
   is what the third test pins.
3. Forward with the upstream client, `stream: true`.
4. Feed each upstream chunk to two consumers:
   - emit it as an `event: raw` with the delta text pulled out by the same
     `streamRules` the proxy uses;
   - push it through an `SseRehydrator` built with
     `resolve: (token) => entry.session.lookup(token)` and emit the result as
     `event: hydrated`.
5. On end of stream, `flush()` the rehydrator, emit whatever it releases, then
   `event: done`.

Write the two channels through one `ServerResponse` with
`content-type: text/event-stream`, `cache-control: no-store`,
`connection: keep-alive`, flushing after each write.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/playground.send.test.ts`
Expected: 4 passed. The split-placeholder case is the one to watch: if
`hydrated` shows `[EMA` or a literal `[EMAIL_1]`, the rehydrator is being fed
per-event instead of as one stream.

- [ ] **Step 5: Commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck
git add src/playground/routes.ts test/helpers/fake-upstream.ts test/playground.send.test.ts
git commit -m "feat(playground): stream the reply raw and rehydrated at once

Two channels out of one upstream stream: raw is the delta untouched,
hydrated is the same delta through the existing SseRehydrator. A
placeholder cut across a chunk boundary is the case that matters, and the
test cuts [EMAIL_1] in half on purpose — hydrated lags a few characters
there, which is the mechanism working and is left visible.

The key is the one the CLI holds. A key in the request body is ignored,
because the page has no business carrying one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

---

### Task 9: The trial branch, and the documentation

**Files:**
- Modify: `src/cli/commands/setup.ts` (replace the Task 4 stub `runTrial`)
- Modify: `README.md` (quickstart), `CHANGELOG.md`
- Test: `test/cli.setup.test.ts` (extend)

**Interfaces:**
- Consumes: everything above.
- Produces: `hushgate setup` answering `1` starts a loopback proxy with the playground mounted and prints its URL.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.setup.test.ts`:

```ts
describe('hushgate setup — trial branch', () => {
  it('asks only for the provider and the key, then serves the page', async () => {
    const dir = workspace();
    const script = scripted(['1', '3', 'sk-test']);
    const controller = new AbortController();

    const c = capture(['setup'], dir, script.prompt);
    const running = run({ ...c.cli, signal: controller.signal });

    // Give it a moment to bind, then read the banner and stop it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const printed = c.out();
    controller.abort();
    await running;

    expect(printed).toMatch(/http:\/\/127\.0\.0\.1:\d+\/__playground/u);
    expect(script.asked).toHaveLength(3);
    expect(existsSync(join(dir, 'hushgate.config.json'))).toBe(false);
  });

  it('never prints the key it was given', async () => {
    const dir = workspace();
    const script = scripted(['1', '3', 'sk-very-secret']);
    const controller = new AbortController();

    const c = capture(['setup'], dir, script.prompt);
    const running = run({ ...c.cli, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await running;

    expect(c.out()).not.toContain('sk-very-secret');
  });

  it('refuses a trial that would not be loopback', async () => {
    const dir = workspace();
    const script = scripted(['1', '3', 'sk-test']);
    const c = capture(['setup', '--host', '0.0.0.0'], dir, script.prompt);

    expect(await run(c.cli)).toBe(EXIT.failure);
    expect(c.err()).toContain('loopback');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.setup.test.ts`
Expected: FAIL — the trial branch is the Task 4 stub.

- [ ] **Step 3: Write the implementation**

Replace `runTrial` in `src/cli/commands/setup.ts`:

```ts
/**
 * The trial: two questions, then a page that shows the whole round trip.
 *
 * Nothing is written and nothing is read — the config is `defaultConfig()`
 * with the chosen upstream patched in, held in memory for as long as the
 * process runs. The key stays in this function's scope and reaches the
 * upstream through the proxy; it is never printed, never stored, and the page
 * never sees it.
 */
async function runTrial(cli: Cli, prompter: Prompter, endpoint: EndpointEntry): Promise<number> {
  const host = stringFlag(parsed, 'host') ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new HushgateError(
      'a trial binds to loopback only; it serves a page that turns placeholders back into personal data',
    );
  }

  const apiKey = await prompter.text(
    `API key for ${endpoint.label} (stays in this process; not written anywhere)`,
    { required: true },
  );

  const config: HushgateConfig = {
    ...defaultConfig(),
    host,
    port: 0, // let the OS pick, then print what it picked
    upstreams: { ...defaultConfig().upstreams, ...upstreamsFor(endpoint) },
  };

  const proxy = createProxyServer({
    config,
    playground: {
      store: new TrialStore(),
      apiKey,
      endpointLabel: endpoint.label,
      defaultModel: endpoint.trialModel ?? '',
      dictionaryIsEmpty: true,
    },
  });

  await proxy.listen();
  const origin = proxy.origin ?? `http://${host}`;
  cli.stdout(
    [
      '',
      `  ${origin}/__playground`,
      '',
      `  Paste a real document. Nothing reaches ${endpoint.label} until you press Send,`,
      '  and what it receives is what the second box shows.',
      '',
      '  Stop with Ctrl-C.',
      '',
    ].join('\n'),
  );

  await untilStopped(cli.signal);
  await proxy.close();
  return EXIT.ok;
}
```

Move `untilStopped` from `src/cli/commands/serve.ts` into a small shared module
— `src/cli/stop.ts` — and import it in both, rather than copying it. Add
`host` to `SETUP_FLAGS` so `--host` parses, and pass `parsed` into `runTrial`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/cli.setup.test.ts`
Expected: all pass, both branches.

- [ ] **Step 5: Update the README**

In `README.md` section 2, put `setup` first — it is now the shortest path from
nothing to a working proxy:

```sh
npx hushgate setup     # answer two questions, see it work
```

Keep the `init` / `doctor` / `serve` block below it as the explicit path, and
say in one sentence that `init` is what scripts and CI use.

- [ ] **Step 6: Update the CHANGELOG**

Add an `## Unreleased` section describing `setup` and the trial page, in the
voice of the existing entries.

- [ ] **Step 7: Full verification and commit**

```bash
npm run build && npm test && npm run lint && npm run typecheck && npm run check:docs
git add src/cli/ src/playground/ README.md CHANGELOG.md test/
git commit -m "feat(cli): finish setup with the trial page

Two questions and a page: paste a document, see what the provider would
receive, press Send, watch the reply arrive with placeholders and then
with the real values back in place. No file is written and none is read —
defaultConfig with one upstream patched in, held in memory.

The key is asked for at the terminal and stays in that scope: not in the
config, not in the audit trail, not in the page, and not in anything the
command prints.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01CFDSUShs7GRBccPZPzzjMq"
```

- [ ] **Step 8: Verify the whole path by hand**

```bash
cd "$(mktemp -d)"
node /Users/johan/Projects/hushgate/dist/cli/main.js setup
```

Walk the configuration branch, then run it again and walk the trial branch with
a real key. Confirm: the four boxes fill in order, a split placeholder does not
appear broken in box 4, and Ctrl-C leaves nothing behind.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| What it does — two branches, provider mandatory | 4, 9 |
| The trial page — four boxes, two channels, name notice | 6, 8 |
| Language — English throughout | Global Constraints |
| Why a preview route exists | 7 |
| Architecture — `src/playground/`, prompt, template, registry | 1, 2, 3, 5, 6 |
| Security 1 — mounted only by setup | 6 |
| Security 2 — loopback only | 9 |
| Security 3 — CSP, no-store | 6 |
| Security 4 — key stays in the CLI process | 8, 9 |
| Security 5 — sessions bounded and process-lived | 5 |
| Skipping the legal basis | 4 |
| Distribution — 0.2.0 | after Task 9, published by the maintainer |
| Testing — every bullet | 1, 2, 4, 6, 7, 8, 9 |

**Placeholders:** none. Task 6's page markup is specified by requirement rather
than transcribed line by line — the four headings, the two asset routes and the
notice are pinned by the tests in that task, which is what makes it checkable
without dictating markup.

**Type consistency:** `Prompter`, `Choice`, `SetupAnswers`, `TrialStore`,
`TrialSession`, `PlaygroundOptions`, `PLAYGROUND_PREFIX`, `proxyableEndpoints`
and `renderConfig` are each defined in exactly one task and referenced by the
same name afterwards. `upstreamsFor` and `untilStopped` are shared within
`setup.ts` and `src/cli/stop.ts` respectively.

**Out of scope, from the spec:** the `redaction.policies` unknown-kind check,
the JSON schema file, `keys new --write`, and dictionary import. Each is a
separate change and none of them blocks this one.
