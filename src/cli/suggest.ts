/**
 * Which candidate did a mistyped word mean?
 *
 * `hushgate scann` is a slip, not a request for the whole command list, and a
 * tool whose other half is being exact about where data goes can afford to be
 * forgiving about spelling where nothing is at stake. One edit — a letter
 * dropped, doubled, mistyped, or swapped with its neighbour — is forgiven on a
 * word of four or five letters, two on a longer one; a word of two or three
 * letters has to be the start of the candidate. The word is also held against
 * the start of each candidate, so `upstrem` reaches both `--upstream-openai`
 * and `--upstream-anthropic`.
 *
 * Every candidate as close as the closest is returned, in the order given, so
 * the caller can list them; none when nothing is close enough, because "did
 * you mean" only helps when the answer is probably yes.
 */
export function suggest(word: string, candidates: readonly string[]): string[] {
  const typed = word.toLowerCase();
  if (typed.length < 2) return [];
  const allowed = typed.length <= 3 ? 0 : typed.length <= 5 ? 1 : 2;

  const close: { candidate: string; score: number }[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const score = closeness(typed, candidate.toLowerCase());
    if (score > allowed) continue;
    close.push({ candidate, score });
    best = Math.min(best, score);
  }
  return close.filter((entry) => entry.score === best).map((entry) => entry.candidate);
}

/** `did you mean "scan"?`, `did you mean "setup" or "serve"?`, or nothing. */
export function didYouMean(
  word: string,
  candidates: readonly string[],
  spell: (candidate: string) => string = (candidate) => candidate,
): string | undefined {
  const found = suggest(word, candidates)
    .slice(0, 3)
    .map((candidate) => `"${spell(candidate)}"`);
  if (found.length === 0) return undefined;
  const last = found.pop()!;
  return `did you mean ${found.length === 0 ? last : `${found.join(', ')} or ${last}`}?`;
}

/** The usage error for a subcommand that does not exist, with the nearest one that does. */
export function noSuchSubcommand(
  command: string,
  given: string,
  known: readonly string[],
  explained: string,
): string {
  const hint = didYouMean(given, known);
  return hint === undefined
    ? `hushgate ${command} has no subcommand "${given}"; it takes ${explained}`
    : `hushgate ${command} has no subcommand "${given}"; ${hint}`;
}

/** Edits from the word to the candidate, or to a prefix of it no shorter than the word less one. */
function closeness(word: string, candidate: string): number {
  let best = distance(word, candidate);
  for (let length = Math.max(2, word.length - 1); length < candidate.length; length += 1) {
    best = Math.min(best, distance(word, candidate.slice(0, length)));
  }
  return best;
}

/** Optimal string alignment distance: Levenshtein, with a swap of neighbours as one edit. */
function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let i = 0; i < rows; i += 1) table[i]![0] = i;
  for (let j = 0; j < cols; j += 1) table[0]![j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(table[i - 1]![j]! + 1, table[i]![j - 1]! + 1, table[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, table[i - 2]![j - 2]! + 1);
      }
      table[i]![j] = value;
    }
  }
  return table[a.length]![b.length]!;
}
