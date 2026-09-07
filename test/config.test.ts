import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyEnv,
  applyOverrides,
  CONFIG_FILENAME,
  defaultConfig,
  loadConfig,
  normaliseUrl,
  parseConfig,
  redactionOptions,
  stripJsonComments,
} from '../src/config.js';
import { ConfigError } from '../src/errors.js';
import { Session } from '../src/redact/index.js';

const dirs: string[] = [];

function workspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-config-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('defaults', () => {
  it('binds to loopback', () => {
    // Anything else would expose the placeholder mapping to the network.
    expect(defaultConfig().host).toBe('127.0.0.1');
  });

  it('pseudonymises by default', () => {
    expect(defaultConfig().redaction.defaultPolicy).toBe('pseudonymize');
  });
});

describe('parseConfig', () => {
  it('overlays a partial file on the defaults', () => {
    const config = parseConfig({ port: 9000, redaction: { policies: { SECRET: 'block' } } });
    expect(config.port).toBe(9000);
    expect(config.host).toBe(defaultConfig().host);
    expect(config.redaction.policies).toEqual({ SECRET: 'block' });
  });

  it('reads dictionary, custom rules and the birth-year window', () => {
    const config = parseConfig({
      redaction: {
        dictionary: { names: ['Anna Schmidt'], entries: [{ value: 'Projekt Nord', kind: 'TERM' }] },
        custom: [{ name: 'employee id', pattern: 'EMP-\\d{5}', flags: 'i' }],
        dobYearRange: { minYear: 1920, maxYear: 2010 },
      },
    });
    expect(config.redaction.dictionary.names).toEqual(['Anna Schmidt']);
    expect(config.redaction.dictionary.entries).toEqual([{ value: 'Projekt Nord', kind: 'TERM' }]);
    expect(config.redaction.custom[0]).toEqual({
      name: 'employee id',
      pattern: 'EMP-\\d{5}',
      flags: 'i',
    });
    expect(config.redaction.dobYearRange).toEqual({ minYear: 1920, maxYear: 2010 });
  });

  it('rejects an unknown top-level key and says which keys exist', () => {
    expect(() => parseConfig({ prot: 1234 })).toThrow(/unknown key "prot"/u);
    expect(() => parseConfig({ prot: 1234 })).toThrow(/known keys are/u);
  });

  it('rejects an unknown nested key', () => {
    expect(() => parseConfig({ redaction: { polices: {} } })).toThrow(ConfigError);
  });

  it('rejects a misspelled policy rather than degrading quietly', () => {
    expect(() => parseConfig({ redaction: { policies: { EMAIL: 'pseudonymise' } } })).toThrow(
      /is not a policy/u,
    );
  });

  it('rejects a lowercase kind', () => {
    expect(() => parseConfig({ redaction: { policies: { email: 'redact' } } })).toThrow(
      /UPPER_SNAKE_CASE/u,
    );
  });

  it('rejects an out-of-range port but allows the ephemeral 0', () => {
    expect(parseConfig({ port: 0 }).port).toBe(0);
    expect(() => parseConfig({ port: -1 })).toThrow(/between 0 and 65535/u);
    expect(() => parseConfig({ port: 70_000 })).toThrow(ConfigError);
    expect(() => parseConfig({ port: '8080' })).toThrow(ConfigError);
  });

  it('rejects a birth-year window that runs backwards', () => {
    expect(() =>
      parseConfig({ redaction: { dobYearRange: { minYear: 2010, maxYear: 1990 } } }),
    ).toThrow(/is after maxYear/u);
  });

  it('names the offending path in the message', () => {
    expect(() => parseConfig({ redaction: { custom: [{ pattern: 'x' }] } }, 'my.json')).toThrow(
      /my\.json: "redaction"\.custom\[0\]\.name/u,
    );
  });
});

describe('comments in the config file', () => {
  it('strips line and block comments', () => {
    expect(
      JSON.parse(
        stripJsonComments(`{
          // a line comment
          "port": 9000, /* and a block one */
          "host": "127.0.0.1"
        }`),
      ),
    ).toEqual({ port: 9000, host: '127.0.0.1' });
  });

  it('leaves comment-looking text inside strings alone', () => {
    const text = '{"host":"http://example.com/*not a comment*/","port":1}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      host: 'http://example.com/*not a comment*/',
      port: 1,
    });
  });

  it('handles escaped quotes before a comment', () => {
    // The string ends at the last quote, not the escaped one in the middle.
    const text = '{"host":"say \\"hi\\"" // done\n}';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ host: 'say "hi"' });
  });

  it('keeps line numbers, so a parse error still points at the right line', () => {
    const stripped = stripJsonComments('{\n// one\n// two\n"port": 1\n}');
    expect(stripped.split('\n')).toHaveLength(5);
  });

  it('loads a commented file end to end', () => {
    const dir = workspace({
      [CONFIG_FILENAME]: `{
        // the port we agreed on
        "port": 4242
      }`,
    });
    expect(loadConfig({ cwd: dir, env: {} }).config.port).toBe(4242);
  });
});

describe('the shipped example config', () => {
  it('is valid — the file people copy must not be the file that fails', () => {
    const example = readFileSync(join(import.meta.dirname, '..', 'hushgate.config.example.json'), 'utf8');
    const config = parseConfig(JSON.parse(example), 'hushgate.config.example.json');
    expect(config.redaction.policies['SECRET']).toBe('block');
    expect(config.audit.enabled).toBe(true);
  });

  it('ignores a $schema key', () => {
    expect(() => parseConfig({ $schema: 'https://example/schema.json' })).not.toThrow();
  });
});

describe('normaliseUrl', () => {
  it('drops trailing slashes so path joining stays simple', () => {
    expect(normaliseUrl('https://api.openai.com/', 'x')).toBe('https://api.openai.com');
    expect(normaliseUrl('https://eu.example/v1/', 'x')).toBe('https://eu.example/v1');
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    expect(() => normaliseUrl('api.openai.com', 'x')).toThrow(ConfigError);
    expect(() => normaliseUrl('ftp://example.com', 'x')).toThrow(/http or https/u);
    expect(() => normaliseUrl('https://example.com/?k=v', 'x')).toThrow(/query string/u);
  });
});

describe('applyEnv', () => {
  it('overlays every knob a container needs', () => {
    const config = applyEnv(defaultConfig(), {
      HUSHGATE_HOST: '0.0.0.0',
      HUSHGATE_PORT: '9999',
      HUSHGATE_UPSTREAM_OPENAI: 'https://eu.example/openai/',
      HUSHGATE_UPSTREAM_ANTHROPIC: 'https://eu.example/anthropic',
      HUSHGATE_DEFAULT_POLICY: 'redact',
      HUSHGATE_HMAC_KEY: 'k',
      HUSHGATE_MAX_BODY_BYTES: '1024',
      HUSHGATE_UPSTREAM_TIMEOUT_MS: '5000',
    });

    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(9999);
    expect(config.upstreams.openai).toBe('https://eu.example/openai');
    expect(config.redaction.defaultPolicy).toBe('redact');
    expect(config.redaction.hmacKey).toBe('k');
    expect(config.limits.maxBodyBytes).toBe(1024);
    expect(config.limits.upstreamTimeoutMs).toBe(5000);
  });

  it('leaves the config alone when nothing is set', () => {
    expect(applyEnv(defaultConfig(), {})).toEqual(defaultConfig());
  });

  it('treats an empty variable as unset, not as a value', () => {
    // A compose file or Kubernetes manifest with HUSHGATE_PORT=${PORT} and PORT
    // unset passes "", not nothing. Number("") is 0, which used to slip past
    // envPort and bind a random ephemeral port while the proxy looked healthy.
    const empty = applyEnv(defaultConfig(), {
      HUSHGATE_HOST: '',
      HUSHGATE_PORT: '',
      HUSHGATE_UPSTREAM_OPENAI: '',
      HUSHGATE_DEFAULT_POLICY: '',
      HUSHGATE_HMAC_KEY: '',
      HUSHGATE_MAX_BODY_BYTES: '',
      HUSHGATE_AUDIT: '',
      HUSHGATE_AUDIT_PATH: '',
      HUSHGATE_RESIDENCY_MODE: '',
    });

    expect(empty).toEqual(defaultConfig());
    expect(empty.port).toBe(defaultConfig().port);
    expect(empty.host).toBe(defaultConfig().host);
  });

  it('treats a whitespace-only variable as unset too', () => {
    expect(applyEnv(defaultConfig(), { HUSHGATE_PORT: '   ', HUSHGATE_HOST: '\t' })).toEqual(
      defaultConfig(),
    );
  });

  it('rejects a malformed environment value', () => {
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_PORT: 'eighty' })).toThrow(ConfigError);
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_DEFAULT_POLICY: 'nope' })).toThrow(
      ConfigError,
    );
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_UPSTREAM_OPENAI: 'nope' })).toThrow(
      ConfigError,
    );
  });
});

describe('loadConfig', () => {
  it('reads the config file from the working directory', () => {
    const dir = workspace({ [CONFIG_FILENAME]: JSON.stringify({ port: 4242 }) });
    const { config, source } = loadConfig({ cwd: dir, env: {} });
    expect(config.port).toBe(4242);
    expect(source.path).toBe(join(dir, CONFIG_FILENAME));
  });

  it('falls back to the defaults when there is no file', () => {
    const dir = workspace();
    const { config, source } = loadConfig({ cwd: dir, env: {} });
    expect(config).toEqual(defaultConfig());
    expect(source.path).toBeNull();
  });

  it('fails loudly when an explicitly named file is missing', () => {
    const dir = workspace();
    expect(() => loadConfig({ cwd: dir, path: 'nope.json', env: {} })).toThrow(
      /cannot read config file/u,
    );
  });

  it('reports invalid JSON with the file name', () => {
    const dir = workspace({ [CONFIG_FILENAME]: '{ "port": }' });
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/is not valid JSON/u);
  });

  it('applies file, then environment, then overrides', () => {
    const dir = workspace({ [CONFIG_FILENAME]: JSON.stringify({ port: 1111, host: 'file' }) });
    const { config } = loadConfig({
      cwd: dir,
      env: { HUSHGATE_PORT: '2222', HUSHGATE_HOST: 'env' },
      overrides: { port: 3333 },
    });
    expect(config.port).toBe(3333);
    expect(config.host).toBe('env');
  });
});

describe('applyOverrides', () => {
  it('merges nested sections instead of replacing them', () => {
    const config = applyOverrides(defaultConfig(), { upstreams: { openai: 'https://eu.example' } });
    expect(config.upstreams.openai).toBe('https://eu.example');
    expect(config.upstreams.anthropic).toBe(defaultConfig().upstreams.anthropic);
  });
});

describe('attachment configuration', () => {
  it('is on by default, and refuses what it cannot read', () => {
    const config = defaultConfig();
    expect(config.attachments.enabled).toBe(true);
    expect(config.attachments.onUnreadable).toBe('block');
  });

  it('ships an extractor for PDF, because nothing built in reads one', () => {
    const [spec] = defaultConfig().attachments.extractors;
    expect(spec?.command).toBe('pdftotext');
    // Nothing from a request may reach argv, so the arguments are fixed and
    // the document goes on stdin: "-" as both input and output.
    expect(spec?.args).toEqual(['-q', '-enc', 'UTF-8', '-', '-']);
  });

  it('refuses a total budget smaller than a single attachment', () => {
    expect(() =>
      parseConfig({ attachments: { maxBytes: 1_000_000, maxTotalBytes: 1000 } }),
    ).toThrow(/maxTotalBytes/u);
  });

  it('refuses an unknown onUnreadable action', () => {
    expect(() => parseConfig({ attachments: { onUnreadable: 'ignore' } })).toThrow(
      /block, withhold, forward/u,
    );
  });

  it('refuses an extractor that claims nothing, since it could never run', () => {
    expect(() =>
      parseConfig({ attachments: { extractors: [{ command: 'x', args: [] }] } }),
    ).toThrow(/mediaTypes or formats/u);
  });

  it('refuses an extractor with no command', () => {
    expect(() =>
      parseConfig({ attachments: { extractors: [{ mediaTypes: ['application/pdf'], command: '  ' }] } }),
    ).toThrow(/command/u);
  });

  it('refuses a format that is not a format', () => {
    expect(() =>
      parseConfig({ attachments: { extractors: [{ formats: ['powerpoint'], command: 'x' }] } }),
    ).toThrow(/not a known format/u);
  });

  it('rejects unknown keys, as every other section does', () => {
    expect(() => parseConfig({ attachments: { ocr: true } })).toThrow(/ocr/u);
  });

  it('takes the environment overrides a container deployment needs', () => {
    const config = applyEnv(defaultConfig(), {
      HUSHGATE_ATTACHMENTS: 'true',
      HUSHGATE_ATTACHMENTS_ON_UNREADABLE: 'withhold',
      HUSHGATE_ATTACHMENT_MAX_BYTES: '2048',
    });
    expect(config.attachments.onUnreadable).toBe('withhold');
    expect(config.attachments.maxBytes).toBe(2048);
  });

  it('refuses an unreadable action from the environment too', () => {
    expect(() =>
      applyEnv(defaultConfig(), { HUSHGATE_ATTACHMENTS_ON_UNREADABLE: 'whatever' }),
    ).toThrow(/HUSHGATE_ATTACHMENTS_ON_UNREADABLE/u);
  });
});

describe('residency rule keys', () => {
  it('refuses a route the proxy does not serve, naming the ones it does', () => {
    // The singular/plural slip that started this: "openai.chat.completion"
    // parsed, enforced nothing, and looked exactly like protection.
    expect(() =>
      parseConfig({ residency: { routes: { 'openai.chat.completion': 'block' } } }),
    ).toThrow(/openai\.chat\.completions, anthropic\.messages/u);
  });

  it('accepts the labels hushgate actually serves', () => {
    const config = parseConfig({
      residency: {
        routes: { 'openai.chat.completions': 'block', 'anthropic.messages': 'warn' },
      },
    });
    expect(config.residency.routes['openai.chat.completions']).toBe('block');
    expect(config.residency.routes['anthropic.messages']).toBe('warn');
  });

  it('refuses a lowercase category and says what to write instead', () => {
    // A rule spelled "phone" let a phone number through with a 200.
    expect(() => parseConfig({ residency: { categories: { phone: 'block' } } })).toThrow(
      /did you mean "PHONE"/u,
    );
  });

  it('accepts built-in kinds and the kinds custom rules report', () => {
    const config = parseConfig({
      residency: { categories: { PHONE: 'block', EMPLOYEE_ID: 'warn' } },
    });
    expect(config.residency.categories['PHONE']).toBe('block');
    // Custom rules contribute their own names, so the key set cannot be closed
    // — only the spelling can.
    expect(config.residency.categories['EMPLOYEE_ID']).toBe('warn');
  });

  it('refuses a category whose spelling no detector could ever report', () => {
    expect(() => parseConfig({ residency: { categories: { 'employee id': 'block' } } })).toThrow(
      ConfigError,
    );
    expect(() => parseConfig({ residency: { categories: { EMPLOYEE_ID_: 'block' } } })).toThrow(
      ConfigError,
    );
  });
});

describe('limits.idleTimeoutMs', () => {
  it('defaults to a minute, above what a pooled client keeps a socket for', () => {
    expect(defaultConfig().limits.idleTimeoutMs).toBe(60_000);
  });

  it('is settable from the file and from the environment', () => {
    expect(parseConfig({ limits: { idleTimeoutMs: 5_000 } }).limits.idleTimeoutMs).toBe(5_000);
    expect(
      applyEnv(defaultConfig(), { HUSHGATE_IDLE_TIMEOUT_MS: '7000' }).limits.idleTimeoutMs,
    ).toBe(7_000);
  });

  it('refuses a value that would disable the reaper', () => {
    expect(() => parseConfig({ limits: { idleTimeoutMs: 0 } })).toThrow(ConfigError);
    expect(() => applyEnv(defaultConfig(), { HUSHGATE_IDLE_TIMEOUT_MS: 'soon' })).toThrow(
      /HUSHGATE_IDLE_TIMEOUT_MS/u,
    );
  });
});

/** One tenant's detector block folded over the organisation's, as loaded. */
function mergedDetectors(
  organisation: Record<string, unknown>,
  tenant: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const config = parseConfig({
    redaction: { detectors: organisation },
    tenants: [{ id: 'nord', keyHash: 'a'.repeat(64), redaction: { detectors: tenant } }],
  });
  return config.tenants[0]!.redaction.detectors as unknown as Record<
    string,
    Record<string, unknown>
  >;
}

/**
 * `redaction.detectors`.
 *
 * The block is worth this much test because of what its failure mode looks
 * like: a detector that is quietly not narrowed reports nothing unusual, so an
 * operator who mistyped a key finds out from a leak rather than from a load
 * error. Every case below is therefore either "the value arrived where the
 * detector reads it" or "the file was refused, loudly, with the path in the
 * message".
 */
describe('redaction.detectors', () => {
  /** All nine groups, every reachable key, deliberately non-default values. */
  const FULL_BLOCK = {
    dictionary: { fuzzy: true, maxEditDistance: 1 },
    vatId: { requireGermanCheckDigit: false },
    bic: { homeCountries: ['DE', 'AT'] },
    postcode: { countryPrefixes: ['D'], places: ['Kempten'] },
    vehiclePlate: { districts: ['GAP'] },
    sessionToken: { names: ['sid'], prefixes: ['hg_'] },
    postalAddress: {
      streetSuffixes: ['pfad'],
      weakStreetSuffixes: ['ring'],
      nonAddressWords: ['Rechnung'],
      labels: ['Lieferadresse'],
    },
    icd10: { codes: ['F32.1'], labels: ['Diagnose'], blockedPrefixWords: ['Raum'] },
    medication: { names: ['Ibuprofen'], requireDosage: false, dosageWindow: 40 },
  };

  /** The nine group names as `redactionOptions` spells them downstream. */
  const OPTION_KEYS = [
    'dictionaryMatching',
    'vatId',
    'bic',
    'postcode',
    'vehiclePlate',
    'sessionToken',
    'postalAddress',
    'icd10',
    'medication',
  ] as const;

  it('carries every group from a file on disk into the session options', () => {
    // Through loadConfig rather than parseConfig: the block has to survive the
    // path an operator actually uses, not just a literal handed to the parser.
    const dir = workspace({
      [CONFIG_FILENAME]: JSON.stringify({ redaction: { detectors: FULL_BLOCK } }),
    });
    const options = redactionOptions(loadConfig({ cwd: dir, env: {} }).config);

    // `redaction.detectors.dictionary` narrows how the dictionary matches and
    // is renamed on the way through; the other eight keep their names.
    expect(options.dictionaryMatching).toEqual(FULL_BLOCK.dictionary);
    expect(options.vatId).toEqual(FULL_BLOCK.vatId);
    expect(options.bic).toEqual(FULL_BLOCK.bic);
    expect(options.postcode).toEqual(FULL_BLOCK.postcode);
    expect(options.vehiclePlate).toEqual(FULL_BLOCK.vehiclePlate);
    expect(options.sessionToken).toEqual(FULL_BLOCK.sessionToken);
    expect(options.postalAddress).toEqual(FULL_BLOCK.postalAddress);
    expect(options.icd10).toEqual(FULL_BLOCK.icd10);
    expect(options.medication).toEqual(FULL_BLOCK.medication);

    // And nothing was renamed into the slot that holds what the dictionary
    // matches *against*, which is a different thing with the same word on it.
    expect(options.dictionary).toEqual({ names: [], terms: [], entries: [] });
  });

  it('leaves every group empty when nobody wrote one, with no key merely undefined', () => {
    const options = redactionOptions(parseConfig({}));
    for (const key of OPTION_KEYS) {
      const group = options[key];
      expect(group, key).toBeDefined();
      // `toEqual({})` would pass for `{ fuzzy: undefined }` too, and that shape
      // is the bug: the detector factories read a present key as a decision, so
      // an undefined list means "match nothing" where absent means "use the
      // seeds". Count the keys, don't compare the object.
      expect(Object.keys(group as object), key).toHaveLength(0);
    }
  });

  describe('a tenant may only widen what is detected', () => {
    it('unions a list rather than replacing it', () => {
      // The organisation listed AT; a tenant that only cares about DE must not
      // be able to stop AT BICs being found.
      const merged = mergedDetectors(
        { bic: { homeCountries: ['AT'] } },
        { bic: { homeCountries: ['DE'] } },
      );
      expect(merged['bic']!['homeCountries']).toEqual(['AT', 'DE']);
    });

    it('will not let a tenant turn fuzzy matching back off', () => {
      const merged = mergedDetectors(
        { dictionary: { fuzzy: true, maxEditDistance: 1 } },
        { dictionary: { fuzzy: false, maxEditDistance: 0 } },
      );
      expect(merged['dictionary']!['fuzzy']).toBe(true);
      // Same rule one field along: the more generous distance survives.
      expect(merged['dictionary']!['maxEditDistance']).toBe(1);
    });

    it('will not let a tenant raise requireDosage once the organisation lowered it', () => {
      // requireDosage is a demand on a candidate, so it narrows as it rises:
      // false anywhere wins, whichever side said it.
      const lowered = mergedDetectors(
        { medication: { requireDosage: false } },
        { medication: { requireDosage: true } },
      );
      expect(lowered['medication']!['requireDosage']).toBe(false);
      // And the same the other way round: it is the false that survives, not
      // the side that wrote it.
      const raised = mergedDetectors(
        { medication: { requireDosage: true } },
        { medication: { requireDosage: false } },
      );
      expect(raised['medication']!['requireDosage']).toBe(false);
    });

    it('takes the wider dosage window, from whichever side wrote it', () => {
      const widened = mergedDetectors(
        { medication: { dosageWindow: 20 } },
        { medication: { dosageWindow: 60 } },
      );
      expect(widened['medication']!['dosageWindow']).toBe(60);
      const narrowed = mergedDetectors(
        { medication: { dosageWindow: 60 } },
        { medication: { dosageWindow: 20 } },
      );
      expect(narrowed['medication']!['dosageWindow']).toBe(60);
    });

    it('keeps the organisation block for a tenant that never mentioned detectors', () => {
      const config = parseConfig({
        redaction: { detectors: { bic: { homeCountries: ['AT'] } } },
        tenants: [{ id: 'nord', keyHash: 'a'.repeat(64) }],
      });
      expect(config.tenants[0]!.redaction.detectors.bic.homeCountries).toEqual(['AT']);
    });
  });

  it('rejects a group nobody has heard of, naming the path', () => {
    expect(() => parseConfig({ redaction: { detectors: { phone: {} } } }, 'my.json')).toThrow(
      /my\.json: "redaction"\.detectors: unknown key "phone"/u,
    );
    expect(() => parseConfig({ redaction: { detectors: { phone: {} } } })).toThrow(ConfigError);
  });

  it('rejects a typo INSIDE a group, which would otherwise load silently', () => {
    // The whole reason the inner key set is closed. `homeCountrys` would parse,
    // narrow nothing, and leave the operator believing the BIC detector was
    // restricted to the countries they listed.
    const typo = { redaction: { detectors: { bic: { homeCountrys: ['DE'] } } } };
    expect(() => parseConfig(typo, 'my.json')).toThrow(
      /my\.json: "redaction"\.detectors\.bic: unknown key "homeCountrys"/u,
    );
    // And the message has to carry the spelling that would have worked.
    expect(() => parseConfig(typo)).toThrow(/"homeCountries"/u);
  });

  it('names the exact index of a non-string element in a list', () => {
    // A list is long and hand-written; "must be a non-empty string" without the
    // index sends the operator hunting through forty postcodes.
    expect(() =>
      parseConfig(
        { redaction: { detectors: { bic: { homeCountries: ['DE', 7, 'AT'] } } } },
        'my.json',
      ),
    ).toThrow(
      /my\.json: "redaction"\.detectors\.bic\.homeCountries\[1\] must be a non-empty string/u,
    );
  });

  it('rejects a maxEditDistance of 2', () => {
    // Two edits from a short German surname is another surname, so the option
    // is a closed pair rather than a number.
    expect(() =>
      parseConfig({ redaction: { detectors: { dictionary: { maxEditDistance: 2 } } } }),
    ).toThrow(/maxEditDistance must be 0 or 1/u);
    expect(
      parseConfig({ redaction: { detectors: { dictionary: { maxEditDistance: 0 } } } }).redaction
        .detectors.dictionary.maxEditDistance,
    ).toBe(0);
  });

  it('reaches the detector: fuzzy from the file finds a one-typo name', () => {
    // The end-to-end claim the parse tests cannot make. Everything above proves
    // the value arrived in SessionOptions; this proves SessionOptions is wired
    // to the detector that reads it.
    const dictionary = { names: ['Max Mustermann'] };
    const text = 'Ticket von Max Musterman';

    const strict = new Session(redactionOptions(parseConfig({ redaction: { dictionary } })));
    expect(strict.redact(text).findings).toEqual([]);

    const fuzzy = new Session(
      redactionOptions(
        parseConfig({ redaction: { dictionary, detectors: { dictionary: { fuzzy: true } } } }),
      ),
    );
    const { findings } = fuzzy.redact(text);
    expect(findings.map(({ kind, value }) => ({ kind, value }))).toEqual([
      { kind: 'NAME', value: 'Max Musterman' },
    ]);
  });
});
