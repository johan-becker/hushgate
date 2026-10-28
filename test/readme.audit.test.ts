/**
 * README §7 against the trail it is transcribed from.
 *
 * The section quotes `examples/hushgate-audit.jsonl` and what hushgate prints
 * about it: the head, the record count, a tampered copy, a truncated one, a
 * pruned one, the report's totals. Those transcripts once went on showing a
 * head and ids from a trail that had since been regenerated, and nothing
 * noticed. Each figure is therefore recomputed here from the committed file, so
 * the fixture and the README can only change together.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAuditLines } from '../src/audit/trail.js';
import { verifyTrail, verifyTrailFile } from '../src/audit/verify.js';

const root = join(import.meta.dirname, '..');
const fixture = join(root, 'examples', 'hushgate-audit.jsonl');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const trail = readFileSync(fixture, 'utf8');
const lines = trail.split('\n').filter((line) => line !== '');
const { records } = parseAuditLines(trail);

/** Section 7 alone, so a figure quoted elsewhere cannot satisfy it by accident. */
function sectionSeven(): string {
  const start = readme.indexOf('\n## 7. The audit trail\n');
  const end = readme.indexOf('\n## 8. ', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return readme.slice(start, end);
}

/** Verify a variant of the trail held in memory, as the README's shell edits make it. */
function verifyText(text: string, options: Parameters<typeof verifyTrail>[1] = {}) {
  return verifyTrail(parseAuditLines(text).entries, options);
}

describe('the audit trail README §7 is transcribed from', () => {
  const section = sectionSeven();
  const result = verifyTrailFile(fixture);
  const { head, records: count } = result.verification;

  it('verifies cleanly, so the transcripts show a trail that does', () => {
    expect(result.ok).toBe(true);
    expect(count).toBe(lines.length);
    expect(count).toBeGreaterThan(2);
    expect(result.verification.gapCount).toBe(0);
    expect(result.malformedCount).toBe(0);
  });

  it('has its full head and record count printed wherever section 7 verifies it', () => {
    expect(section).toContain(
      `  records      ${count}\n  chain        intact\n  head         ${head}\n`,
    );
    expect(section).toContain(`intact over ${count} records (head ${head})`);
    expect(section).toContain(`found at record ${count} (line ${count}), 0 records after it`);
  });

  it('has the same head in the serve banner, the shutdown line and the doctor transcript', () => {
    expect(readme).toContain(`hushgate-audit.jsonl — continuing chain from ${head.slice(0, 12)}`);
    expect(section).toContain(`/home/you/hushgate/examples/hushgate-audit.jsonl head ${head}`);
    expect(readme).toContain(
      `trail /home/you/hushgate/examples/hushgate-audit.jsonl: ${count} record(s), chain intact, head ${head}`,
    );
  });

  it('is quoted record for record in the example at the top of the section', () => {
    expect(section).toContain(`\`\`\`json\n${lines[0]}\n\`\`\``);
  });

  it('breaks exactly where the tampering transcript says when the documented edit is made', () => {
    const tampered = trail.replaceAll('"SECRET":1', '"SECRET":0');
    expect(tampered).not.toBe(trail);

    const broken = verifyText(tampered).verification;
    expect(broken.breakCount).toBe(1);
    const at = broken.breaks[0]!;
    expect(section).toContain(
      `  break        record ${at.index} (${at.reason}), line ${at.line}: id ${at.id}, ts ${at.ts}\n` +
        `               ${at.detail}\n`,
    );
    expect(section).toContain(`  chain        BROKEN at 1 point\n`);
  });

  it('misses the anchor the truncation transcript shows once its last record is cut', () => {
    const truncated = `${lines.slice(0, -1).join('\n')}\n`;
    const verdict = verifyText(truncated, { anchors: [head] }).verification;

    expect(verdict.breakCount).toBe(0);
    expect(verdict.anchors[0]?.found).toBe(false);
    expect(section).toContain(
      `  records      ${count - 1}\n  chain        intact\n  head         ${verdict.head}\n` +
        `  anchor       ${head} NOT FOUND\n`,
    );
  });

  it('verifies from the hash the pruning transcript passes once its first records are cut', () => {
    const from = records.at(-2)!.hash;
    const pruned = `${lines.at(-1)}\n`;

    expect(verifyText(pruned).ok).toBe(false);
    expect(verifyText(pruned, { from }).ok).toBe(true);
    expect(section).toContain(`--continues-from ${from}\n`);
    expect(section).toContain(`  from         ${from}\n`);
  });

  it('adds up to the totals the report transcript prints', () => {
    const tokens = records.reduce((sum, record) => sum + record.tokens, 0);
    expect(section).toContain(`- Requests: **${count}**`);
    expect(section).toContain(`- Tokens reported by providers: **${tokens}**`);
  });

  it('hashes its first line to the value the independent check prints, without hushgate', () => {
    const body = lines[0]!.replace(/,"hash":"[0-9a-f]{64}"\}$/u, '}');
    const digest = createHash('sha256').update(body, 'utf8').digest('hex');

    expect(digest).toBe(records[0]!.hash);
    expect(section).toContain(`\n${digest}  -\n`);
  });
});
