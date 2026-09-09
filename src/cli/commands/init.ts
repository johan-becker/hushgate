/**
 * `hushgate init` — write a starter configuration.
 *
 * The file it writes is commented, because a config file is where a team
 * records *why* an upstream is permitted, and a format with nowhere to put the
 * reason invites the reason to be left out. hushgate's loader strips comments.
 *
 * The text itself lives in `../template.js`, because `setup` writes the same
 * file with the operator's answers in it and two copies would drift.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as joinPath } from 'node:path';
import { CONFIG_FILENAME } from '../../config.js';
import { HushgateError } from '../../errors.js';
import { boolFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { renderConfig } from '../template.js';
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

  writeFileSync(path, renderConfig(), 'utf8');

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
