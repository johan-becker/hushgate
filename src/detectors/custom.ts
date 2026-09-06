import { ConfigError } from '../errors.js';
import { DEFAULT_PRIORITIES, type Detector, type Span } from '../types.js';

/** A user-supplied named pattern from the config file. */
export interface CustomRule {
  /** Reported kind; normalised to UPPER_SNAKE_CASE, e.g. `EMPLOYEE_ID`. */
  readonly name: string;
  /** Regular expression source. `g` is always added. */
  readonly pattern: string;
  /** Extra flags. Only `i`, `m`, `s` and `u` are accepted. */
  readonly flags?: string;
  /** Tie-break weight; defaults to sitting just above the dictionary. */
  readonly priority?: number;
}

const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u']);
/** Guard against a pathological pattern producing an unbounded finding list. */
const MAX_MATCHES = 10_000;

// ---------------------------------------------------------------------------
// ReDoS analysis
//
// A custom pattern runs on the event loop every request shares, so a
// catastrophic one is not a per-tenant problem: `(a+)+$` against 28 bytes of
// `aaaa…!` froze the process for 37 seconds in the audit's PoC, and every
// tenant behind the proxy freezes with it. A synchronous `RegExp.exec` cannot
// be deadlined from outside, and pulling in an engine that can (re2) would end
// the zero-runtime-dependency rule — so the guard runs where the pattern is
// born: at config load, before it ever sees traffic.
//
// The analysis is structural, not exhaustive. It rejects the shape every
// published catastrophic-backtracking blowup shares: a quantifier applied to
// something that is itself ambiguous — able to split the same run of input
// into its parts in more than one way. Concretely, a quantified atom whose
// subpattern contains another quantifier over overlapping first-characters,
// or an alternation whose branches overlap and sits under a quantifier. That
// covers `(a+)+`, `([a-z]+)*`, `(a|a)+`, `(a+)+$` and their nestings. The
// analysis deliberately over-approximates and will refuse some patterns that
// would never actually blow up; over-refusal is the correct bias, because the
// refused operator gets an error naming the group while the accepted one gets
// an outage with no name at all.
//
// Escapes this parser does not model (`\d` inside a group is fine — classes of
// known breadth — but anything exotic), possessive quantifiers beyond their
// marker, and above all backreferences are refused outright rather than
// guessed safe. Backreferences are the classic exponential primitive; no
// detector rule needs them.
// ---------------------------------------------------------------------------

/** How many distinct characters a node can begin a match with (capped). */
const BREADTH_CAP = 16;
/** Refuse absurdly large patterns before walking them at all. */
const MAX_PATTERN_LENGTH = 1_000;

interface Node {
  /** Minimum characters this node can consume in one pass. */
  readonly min: number;
  /** Maximum characters this node can consume (`Infinity` allowed). */
  readonly max: number;
  /** Distinct starting characters possible, capped at BREADTH_CAP. */
  readonly startBreadth: number;
  readonly children: readonly Node[];
  /** True when this node is `*`, `+`, `{n,}` or `{n,m}`-quantified. */
  readonly quantified: boolean;
  /** True when this node is a multi-branch alternation `a|b|…`. */
  readonly alternation: boolean;
}

const EMPTY: Node = { min: 0, max: 0, startBreadth: 0, children: [], quantified: false, alternation: false };

function node(partial: Partial<Node> & { min: number; max: number }): Node {
  return {
    startBreadth: partial.startBreadth ?? 1,
    children: partial.children ?? [],
    quantified: partial.quantified ?? false,
    alternation: partial.alternation ?? false,
    ...partial,
  };
}

/**
 * Parse the source into nodes, or return `null` for any construct the safety
 * argument does not cover. `null` means "refuse the pattern", never "accept".
 */
class PatternParser {
  private pos = 0;

  constructor(private readonly source: string) {}

  static parse(source: string): Node | null {
    if (source.length > MAX_PATTERN_LENGTH) return null;
    const parser = new PatternParser(source);
    const top = parser.alternation();
    if (parser.pos !== source.length) return null;
    return top;
  }

  private peek(): string {
    return this.source[this.pos] ?? '';
  }

  private alternation(): Node | null {
    const branches: Node[] = [];
    let seq = this.sequence();
    if (seq === null) return null;
    branches.push(seq);
    while (this.peek() === '|') {
      this.pos += 1;
      seq = this.sequence();
      if (seq === null) return null;
      branches.push(seq);
    }
    if (branches.length === 1) return branches[0] as Node;
    return node({
      min: Math.min(...branches.map((branch) => branch.min)),
      max: Math.max(...branches.map((branch) => branch.max)),
      // Overlapping branches share starting characters; summing would hide
      // ambiguity, capping keeps it visible to the checker below.
      startBreadth: Math.min(
        BREADTH_CAP,
        branches.reduce((sum, branch) => sum + branch.startBreadth, 0),
      ),
      children: branches,
      alternation: true,
    });
  }

  private sequence(): Node | null {
    const items: Node[] = [];
    while (this.pos < this.source.length && this.peek() !== '|' && this.peek() !== ')') {
      const item = this.quantified();
      if (item === null) return null;
      items.push(item);
    }
    if (items.length === 0) return EMPTY;
    if (items.length === 1) return items[0] as Node;
    return node({
      min: items.reduce((sum, item) => sum + item.min, 0),
      max: items.reduce((sum, item) => sum + item.max, 0),
      startBreadth: items[0]?.startBreadth ?? 1,
      children: items,
    });
  }

  private quantified(): Node | null {
    let atom = this.atom();
    if (atom === null) return null;
    while (this.pos < this.source.length) {
      const c = this.peek();
      if (c === '*') {
        this.pos += 1;
        this.skipModifiers();
        atom = node({
          min: 0,
          max: Infinity,
          startBreadth: atom.startBreadth,
          children: [atom],
          quantified: true,
        });
      } else if (c === '+') {
        this.pos += 1;
        this.skipModifiers();
        atom = node({
          min: atom.min,
          max: Infinity,
          startBreadth: atom.startBreadth,
          children: [atom],
          quantified: true,
        });
      } else if (c === '?') {
        this.pos += 1;
        this.skipModifiers();
        atom = node({
          min: 0,
          max: atom.max,
          startBreadth: atom.startBreadth,
          children: [atom],
          quantified: false,
        });
      } else if (c === '{') {
        const range = this.braceRange();
        if (range === null) break; // literal `{`
        const [lo, hi, bounded] = range;
        this.skipModifiers();
        atom = node({
          min: lo,
          max: bounded ? hi : Infinity,
          startBreadth: atom.startBreadth,
          children: [atom],
          quantified: hi > 1 || !bounded,
        });
      } else {
        break;
      }
    }
    return atom;
  }

  private skipModifiers(): void {
    // Lazy (?) and possessive (+) markers do not change the ambiguity shape
    // enough to matter here; consume at most one.
    if (this.peek() === '?' || this.peek() === '+') this.pos += 1;
  }

  private braceRange(): [number, number, boolean] | null {
    const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(this.source.slice(this.pos));
    if (match === null) return null;
    this.pos += match[0].length;
    const lo = Number(match[1]);
    const hi = match[2] === undefined ? lo : match[2] === '' ? Infinity : Number(match[2]);
    if (!Number.isSafeInteger(lo)) return null;
    return [lo, hi, match[2] !== ''];
  }

  private atom(): Node | null {
    const c = this.peek();
    if (c === '(') return this.group();
    if (c === '[') return this.charClass();
    if (c === '.') {
      this.pos += 1;
      return node({ min: 1, max: 1, startBreadth: BREADTH_CAP });
    }
    if (c === '^' || c === '$') {
      this.pos += 1;
      return EMPTY;
    }
    if (c === '\\') return this.escape();
    if ('*+?)]{}'.includes(c)) return null; // misplaced metacharacter: refuse
    this.pos += c.length;
    return node({ min: 1, max: 1, startBreadth: 1 });
  }

  private group(): Node | null {
    this.pos += 1; // consume `(`
    // Non-capturing, named, atomic — all parsed as their contents. Lookarounds
    // are refused: they change what "consume" means and the analysis below
    // reasons about consumption.
    if (this.peek() === '?') {
      const next = this.source[this.pos + 1];
      if (next === '=' || next === '!') return null; // lookahead
      if (next === '<' && (this.source[this.pos + 2] === '=' || this.source[this.pos + 2] === '!')) {
        return null; // lookbehind
      }
      // (?= / (?< / (?<= / (?<! handled above; (? : name > ) and (?: pass.
      this.pos += 2;
    }
    const inner = this.alternation();
    if (inner === null) return null;
    if (this.peek() !== ')') return null;
    this.pos += 1;
    return inner;
  }

  private charClass(): Node | null {
    // Classes are consumed wholesale: any `[...]` is a fixed set of starting
    // characters with no internal ambiguity. Negation does not change breadth.
    this.pos += 1; // `[`
    if (this.peek() === '^') this.pos += 1;
    if (this.peek() === ']') {
      this.pos += 1; // leading `]` is a literal inside a class
    }
    while (this.pos < this.source.length && this.peek() !== ']') {
      if (this.peek() === '\\') {
        this.pos += 2;
        continue;
      }
      this.pos += 1;
    }
    if (this.peek() !== ']') return null; // unterminated class
    this.pos += 1;
    return node({ min: 1, max: 1, startBreadth: BREADTH_CAP });
  }

  private escape(): Node | null {
    const next = this.source[this.pos + 1];
    if (next === undefined) return null;
    this.pos += 2;
    if (next === 'b' || next === 'B') return EMPTY; // word boundary: consumes nothing
    // Backreference (\1..\9): the classic exponential primitive — refuse.
    if (next >= '1' && next <= '9') return null;
    // Character-class escapes have known breadth; everything else (\p{..},
    // \k<name>, \Q…\E, \cX, octal) is refused rather than guessed safe.
    if ('dDwWsS'.includes(next)) {
      return node({ min: 1, max: 1, startBreadth: BREADTH_CAP });
    }
    if ('nrtfv0'.includes(next)) {
      return node({ min: 1, max: 1, startBreadth: 1 });
    }
    if (/[\x20-\x7e]/u.test(next)) {
      // Punctuated escapes like \. \+ \\ — single literals.
      return node({ min: 1, max: 1, startBreadth: 1 });
    }
    return null; // \p{...}, \u{...}, \k<name>, exotic: refuse
  }
}

/**
 * Walk the tree looking for the catastrophic shape: something ambiguous —
 * able to split the same run of input into its parts in more than one way —
 * sitting anywhere inside a quantifier's subtree. Two shapes qualify:
 *
 *   1. a quantifier applied to another quantifier whose spans overlap (the
 *      inner one can hand back a non-empty stretch the outer one could also
 *      have consumed itself), e.g. `(a+)+`, `([a-z]+)*`, `(\w+\s?)*`;
 *   2. an alternation with overlapping branches under a quantifier, e.g.
 *      `(a|aa)+` — the same run can be partitioned as |a|a| or |aa|.
 *
 * The old version only compared a child against its immediate parent's flag,
 * which missed direct nestings like `(a+)+` once quantifiers became explicit
 * wrapper nodes. Here `insideQuantified` tracks whether ANY ancestor is a
 * quantifier, and each quantified node's entire subtree is checked, so
 * nesting at any depth is caught.
 *
 * Returns the offending fragment for the error message, or `null` when the
 * pattern is structurally safe by this analysis.
 */
function findAmbiguity(root: Node): string | null {
  const stack: Array<{ n: Node; insideQuantified: boolean }> = [
    { n: root, insideQuantified: false },
  ];

  while (stack.length > 0) {
    const { n, insideQuantified } = stack.pop() as {
      n: Node;
      insideQuantified: boolean;
    };
    // A quantifier makes its whole subtree suspect: anything below it that
    // can repeat ambiguously lets backtracking branch exponentially.
    const q = insideQuantified || n.quantified;
    for (let i = 0; i < n.children.length; i += 1) {
      const child = n.children[i] as Node;
      if (!q) {
        stack.push({ n: child, insideQuantified: false });
        continue;
      }
      // Inner quantifier whose consumption overlaps the outer one's: the
      // same input can be partitioned both ways.
      if (
        child.quantified &&
        child.startBreadth > 0 &&
        child.max > child.min &&
        child.startBreadth <= BREADTH_CAP
      ) {
        return describe(child);
      }
      // Overlapping alternation branches under a quantifier.
      if (child.alternation && child.startBreadth > 0 && child.max > child.min) {
        return describe(child);
      }
      stack.push({ n: child, insideQuantified: true });
    }
  }
  return null;
}

/** Render a node's source-ish shape for the error message. */
function describe(n: Node): string {
  if (n.children.length === 1) {
    const only = n.children[0] as Node;
    if (only.quantified || only.children.length > 0) return '(…)  — a quantified group under a quantifier';
  }
  return 'a quantified expression whose body is itself ambiguous';
}

/**
 * Refuse patterns this analysis cannot vouch for.
 *
 * Fail-closed on purpose: the cost of refusing an operator's unusual-but-safe
 * regex is one config error naming the rule, while the cost of accepting a
 * catastrophic one is every tenant's requests freezing behind a spun event
 * loop. Patterns that are refused and genuinely needed can almost always be
 * rewritten without nesting quantifiers; the error says to.
 */
function assertPatternSafe(name: string, pattern: string): void {
  const tree = PatternParser.parse(pattern);
  if (tree === null) {
    throw new ConfigError(
      `custom rule "${name}" uses a pattern construct hushgate cannot analyse for ReDoS safety ` +
        `(backreferences, lookaround, exotic escapes, or a malformed pattern). ` +
        `Rewrite the pattern with plain literals, character classes and quantifiers.`,
    );
  }
  const bad = findAmbiguity(tree);
  if (bad !== null) {
    throw new ConfigError(
      `custom rule "${name}" has a nested quantifier (${bad}), which can make matching time explode exponentially ` +
        `(ReDoS). Rewrite it so no quantified group appears inside another quantifier — ` +
        `e.g. "(a+)+" should be "a+", "([a-z]+)*" should be "[a-z]*".`,
    );
  }
}

/** Normalise an arbitrary rule name into a usable kind. */
export function normaliseKindName(name: string): string {
  const normalised = name
    .trim()
    .replaceAll(/[^A-Za-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .toUpperCase();

  if (normalised.length === 0 || /^\d/u.test(normalised)) {
    throw new ConfigError(
      `custom rule name "${name}" cannot be turned into a kind; use letters, digits and underscores and start with a letter`,
    );
  }

  return normalised;
}

/** Compile one custom rule into a detector, failing loudly on a bad pattern. */
export function createCustomDetector(rule: CustomRule): Detector {
  const kind = normaliseKindName(rule.name);
  const priority = rule.priority ?? DEFAULT_PRIORITIES.CUSTOM;

  for (const flag of rule.flags ?? '') {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new ConfigError(
        `custom rule "${rule.name}" uses unsupported regex flag "${flag}"; allowed flags are i, m, s, u`,
      );
    }
  }

  // Compile FIRST, analyse second. The ReDoS analysis is a claim about a
  // pattern the engine accepts; running it on one the engine would reject turns
  // a missing bracket into a lecture about nested quantifiers, and the operator
  // rewrites a pattern that was never ambiguous instead of closing the bracket.
  // The parser refuses everything it cannot model, so a syntax error reaches it
  // as "hushgate cannot analyse this" — true, and useless.
  const flags = `${rule.flags ?? ''}g`;
  let compiled: RegExp;
  try {
    compiled = new RegExp(rule.pattern, flags);
  } catch (cause) {
    throw new ConfigError(
      `custom rule "${rule.name}" has an invalid pattern: ${(cause as Error).message}`,
      { cause },
    );
  }

  assertPatternSafe(rule.name, rule.pattern);

  return {
    name: `custom:${kind}`,
    priority,

    find(text: string): Span[] {
      const re = new RegExp(compiled.source, compiled.flags);
      const out: Span[] = [];
      let match: RegExpExecArray | null;

      while ((match = re.exec(text)) !== null && out.length < MAX_MATCHES) {
        const value = match[0];
        // A pattern that can match nothing would spin forever otherwise.
        if (value.length === 0) {
          re.lastIndex += 1;
          continue;
        }

        out.push({
          start: match.index,
          end: match.index + value.length,
          kind,
          value,
          detector: `custom:${kind}`,
          priority,
        });
      }

      return out;
    },
  };
}

export function createCustomDetectors(rules: readonly CustomRule[] = []): Detector[] {
  const seen = new Set<string>();
  return rules.map((rule) => {
    const detector = createCustomDetector(rule);
    if (seen.has(detector.name)) {
      throw new ConfigError(`duplicate custom rule name "${rule.name}"`);
    }
    seen.add(detector.name);
    return detector;
  });
}
