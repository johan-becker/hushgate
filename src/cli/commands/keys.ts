/**
 * `hushgate keys` — mint and hash tenant keys.
 *
 * hushgate issues its own keys rather than reusing the provider's: a tenant key
 * identifies a team, carries that team's policy profile and quota, and can be
 * revoked without touching anyone else. Only the hash is ever written down.
 */
import { HushgateError, UsageError } from '../../errors.js';
import { hashKey, issueKey, KEY_PREFIX } from '../../tenants/tenant.js';
import { boolFlag, parseFlags, type FlagSpecs } from '../args.js';
import { EXIT, readAll, type Cli } from '../cli.js';

export const KEYS_FLAGS: FlagSpecs = {
  json: { type: 'boolean', description: 'machine-readable output' },
};

export const KEYS_SUMMARY = 'mint a tenant key, or hash an existing one';

export async function keys(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, KEYS_FLAGS);
  const [subcommand, ...rest] = parsed.positionals;

  switch (subcommand) {
    case 'new': {
      return mint(cli, rest[0], boolFlag(parsed, 'json'));
    }
    case 'hash': {
      return hashFromStdin(cli, boolFlag(parsed, 'json'));
    }
    default: {
      throw new UsageError(
        `hushgate keys needs a subcommand: "new <tenant-id>" to mint a key, or "hash" to hash one from standard input`,
      );
    }
  }
}

function mint(cli: Cli, tenantId: string | undefined, json: boolean): number {
  if (tenantId === undefined) {
    throw new UsageError('hushgate keys new needs a tenant id, for example: hushgate keys new support');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(tenantId)) {
    throw new UsageError(
      `"${tenantId}" is not a usable tenant id; use letters, digits, dots, dashes or underscores`,
    );
  }

  const { key, hash } = issueKey();

  if (json) {
    cli.stdout(`${JSON.stringify({ tenant: tenantId, key, keyHash: `sha256:${hash}` }, null, 2)}\n`);
    return EXIT.ok;
  }

  const snippet = JSON.stringify(
    { tenants: [{ id: tenantId, name: tenantId, keyHash: `sha256:${hash}` }] },
    null,
    2,
  )
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');

  cli.stdout(
    [
      `tenant key for "${tenantId}" — copy it now, hushgate does not store it:`,
      '',
      `  ${key}`,
      '',
      'add this to hushgate.config.json:',
      '',
      snippet,
      '',
      'The caller sends the key as "Authorization: Bearer <key>" or "x-api-key: <key>".',
      'Revoke it by removing the hash; rotate it by listing both hashes in keyHashes.',
      '',
    ].join('\n'),
  );

  return EXIT.ok;
}

async function hashFromStdin(cli: Cli, json: boolean): Promise<number> {
  if (cli.stdin === undefined) throw new HushgateError('no standard input to read');

  const key = (await readAll(cli.stdin)).trim();
  if (key.length === 0) throw new HushgateError('no key on standard input');

  const hash = hashKey(key);
  if (json) {
    cli.stdout(`${JSON.stringify({ keyHash: `sha256:${hash}` }, null, 2)}\n`);
    return EXIT.ok;
  }

  cli.stdout(`sha256:${hash}\n`);
  if (!key.startsWith(KEY_PREFIX)) {
    cli.stderr(
      `hushgate: that key does not look like one hushgate issued (no "${KEY_PREFIX}" prefix); hashing it anyway\n`,
    );
  }
  return EXIT.ok;
}
