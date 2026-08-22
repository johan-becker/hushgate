// Make the compiled CLI entry point executable. tsc preserves the shebang but
// not the file mode, and npm only sets the executable bit at install time for
// files that already have it in the package tarball.
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'dist', 'cli', 'main.js');

if (!existsSync(cli)) {
  console.error(`postbuild: expected CLI entry point at ${cli}`);
  process.exit(1);
}

chmodSync(cli, 0o755);
console.log(`postbuild: chmod 0755 ${cli}`);
