/**
 * Check that what npm would publish is what we mean to publish.
 *
 * Two failure modes this catches: shipping a tarball with no compiled output
 * (or with the sources and tests along for the ride), and shipping a `bin` that
 * does not actually run. Both are the kind of thing you only notice after the
 * version is public.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = JSON.parse(
  execFileSync(npm, ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }),
);

const files = (packed[0]?.files ?? []).map((entry) => entry.path);
const problems = [];

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/main.js',
];

for (const path of required) {
  if (!files.includes(path)) problems.push(`missing from the tarball: ${path}`);
}

// Segment-wise, not prefix-wise. A stale `dist/` once carried a whole second
// tree — `dist/src/**` and the compiled test suite under `dist/test/**` — from
// a build made before `rootDir` was set. `startsWith('src/')` matched none of
// it, and the tarball was one `npm publish` away from shipping the tests.
const forbidden = files.filter((path) => {
  const segments = path.split('/');
  return (
    segments.includes('src') ||
    segments.includes('test') ||
    path.endsWith('.tsbuildinfo') ||
    /\.test\.(js|d\.ts)$/u.test(path)
  );
});
for (const path of forbidden) problems.push(`should not be published: ${path}`);

// The bin entry has to exist and has to run.
const bin = join(root, pkg.bin.hushgate);
let version = '';
try {
  version = execFileSync(process.execPath, [bin, 'version'], { encoding: 'utf8' }).trim();
} catch (error) {
  problems.push(`the CLI did not run: ${error.message}`);
}

if (version !== '' && version !== pkg.version) {
  problems.push(`the CLI reports ${version}, package.json says ${pkg.version}`);
}

if (problems.length > 0) {
  console.error('verify-package: the artefact is not publishable');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `verify-package: ${files.length} files, ${packed[0]?.size ?? 0} bytes packed, CLI reports ${version}`,
);
