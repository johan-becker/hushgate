/**
 * Keep the front of the repository honest.
 *
 * Two things rot silently and are embarrassing in public: a relative link in
 * the README that points at a file somebody renamed, and a banner that stopped
 * being valid SVG. Both are cheap to check and neither is caught by tsc,
 * oxlint or the test suite, so they are checked here and wired into CI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const problems = [];

/* ------------------------------------------------------------------ banner */

const bannerPath = join(root, 'docs', 'assets', 'banner.svg');

if (!existsSync(bannerPath)) {
  problems.push('docs/assets/banner.svg is missing');
} else {
  const banner = readFileSync(bannerPath, 'utf8');

  // A minimal well-formedness check: every start tag is closed, in order, and
  // nothing is left open at the end. Enough to catch a truncated or hand-broken
  // file without pulling in an XML parser we would otherwise never need.
  const stack = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/gu;
  let match;

  while ((match = tag.exec(banner)) !== null) {
    const [, closing, name, attributes] = match;
    if (attributes.trimEnd().endsWith('/')) continue;
    if (closing === '/') {
      if (stack.pop() !== name) problems.push(`banner.svg: unbalanced </${name}>`);
    } else {
      stack.push(name);
    }
  }

  if (stack.length > 0) problems.push(`banner.svg: unclosed <${stack.join('>, <')}>`);

  const required = [
    ['width="1280"', 'width must be 1280'],
    ['height="320"', 'height must be 320'],
    ['viewBox="0 0 1280 320"', 'viewBox must be "0 0 1280 320"'],
    ['role="img"', 'role="img" is required for accessibility'],
    ['aria-label="hushgate banner"', 'aria-label must be "hushgate banner"'],
  ];
  for (const [needle, why] of required) {
    if (!banner.includes(needle)) problems.push(`banner.svg: ${why}`);
  }

  // GitHub sanitises these out of an inlined SVG, so a banner that relies on
  // one renders correctly here and wrong on the page it exists for.
  const banned = ['<style', '<script', '<image', '<foreignObject', 'href', '@import'];
  for (const needle of banned) {
    if (banner.includes(needle)) problems.push(`banner.svg: must not contain "${needle}"`);
  }
}

/* ------------------------------------------------------------------- links */

/** Markdown files at the repository root, plus anything under .github/. */
function markdownFiles() {
  const found = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full);
    }
  };

  for (const entry of readdirSync(root)) {
    if (entry.endsWith('.md')) found.push(join(root, entry));
  }
  if (existsSync(join(root, '.github'))) walk(join(root, '.github'));

  return found;
}

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\w\- ]+/gu, '')
    .replaceAll(' ', '-');
}

const anchorsByFile = new Map();

function anchorsOf(path) {
  const cached = anchorsByFile.get(path);
  if (cached !== undefined) return cached;

  const anchors = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading !== null) anchors.add(slug(heading[1]));
  }

  anchorsByFile.set(path, anchors);
  return anchors;
}

// Inline links only: [text](target). Reference definitions are checked the
// same way because they are matched by the second alternative.
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|^\[[^\]]+\]:\s*(\S+)/gmu;

for (const file of markdownFiles()) {
  const source = readFileSync(file, 'utf8');
  const relative = file.slice(root.length + 1);

  for (const match of source.matchAll(LINK)) {
    const target = match[1] ?? match[2];
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;

    const [path, anchor] = target.split('#');
    const resolved = resolve(dirname(file), normalize(path));

    if (!existsSync(resolved)) {
      problems.push(`${relative}: link to "${target}" does not exist`);
      continue;
    }

    if (anchor !== undefined && anchor !== '' && resolved.endsWith('.md')) {
      if (!anchorsOf(resolved).has(anchor)) {
        problems.push(`${relative}: "${target}" points at no heading in that file`);
      }
    }
  }
}

/* ------------------------------------------------------------------ report */

if (problems.length > 0) {
  console.error('check-docs: the documentation does not hold together');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('check-docs: banner is well formed, every relative link resolves');
