/**
 * Reading a trail back.
 *
 * The writer in `log.ts` only ever appends; everything that reads a trail —
 * `hushgate audit`, `hushgate doctor`, the report — starts here.
 */
import type { AuditRecord } from './record.js';

/** Parse a JSONL audit file into records, reporting the lines that were not. */
export function parseAuditLines(text: string): {
  records: AuditRecord[];
  malformed: { line: number; reason: string }[];
} {
  const records: AuditRecord[] = [];
  const malformed: { line: number; reason: string }[] = [];

  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      const parsed = JSON.parse(line) as AuditRecord;
      if (typeof parsed.ts !== 'string' || typeof parsed.route !== 'string') {
        malformed.push({ line: index + 1, reason: 'missing ts or route' });
        return;
      }
      records.push(parsed);
    } catch (cause) {
      malformed.push({ line: index + 1, reason: (cause as Error).message });
    }
  });

  return { records, malformed };
}
