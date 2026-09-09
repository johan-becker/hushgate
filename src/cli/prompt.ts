/**
 * The questions a command may ask, and the one implementation that asks them.
 *
 * Injected through {@link Cli} rather than reached for, so a wizard can be
 * driven from a test with scripted answers — the same reason every other
 * command takes its streams instead of touching `process` directly.
 *
 * Node's own readline is the whole dependency. A prompt library would buy
 * arrow-key selection and cost the promise that hushgate installs nothing.
 */
import { createInterface } from 'node:readline/promises';

export interface Choice<T> {
  readonly label: string;
  /** Shown after the label — a jurisdiction, a default, a caveat. */
  readonly hint?: string;
  readonly value: T;
}

export interface TextOptions {
  /** Used when the answer is empty, and shown in the prompt. */
  readonly default?: string;
  /** Keep asking until something non-empty is typed. */
  readonly required?: boolean;
}

export interface Prompter {
  /** Ask for a line. Returns `''` when the question was optional and skipped. */
  text(question: string, options?: TextOptions): Promise<string>;
  /** Ask for one of `choices` by number. */
  choose<T>(question: string, choices: readonly Choice<T>[]): Promise<T>;
  /** Ask a yes/no question. An empty answer takes `fallback`. */
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** Release the underlying readline interface. */
  close(): void;
}

export interface PromptStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export function createPrompter(streams: PromptStreams): Prompter {
  const rl = createInterface({ input: streams.input, output: streams.output });
  const say = (line: string): void => {
    streams.output.write(`${line}\n`);
  };

  return {
    async text(question, options = {}) {
      const suffix = options.default === undefined ? '' : ` [${options.default}]`;

      // Sequential on purpose, here and below: a question cannot be asked
      // before the previous one is answered, which is what the loop is for.
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = (await rl.question(`  ${question}${suffix} > `)).trim();
        if (answer !== '') return answer;
        if (options.default !== undefined) return options.default;
        if (options.required !== true) return '';
        say('  an answer is required');
      }
    },

    async choose(question, choices) {
      say(`  ${question}`);
      for (const [index, choice] of choices.entries()) {
        const hint = choice.hint === undefined ? '' : `  ${choice.hint}`;
        say(`    ${index + 1} ${choice.label}${hint}`);
      }

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = (await rl.question('  > ')).trim();
        // parseInt would accept "2nd" and "2 or 3"; a number that is not a
        // clean index is a typo, and answering the typo is worse than asking.
        const index = /^\d+$/u.test(answer) ? Number.parseInt(answer, 10) : Number.NaN;
        const choice = Number.isNaN(index) ? undefined : choices[index - 1];
        if (choice !== undefined) return choice.value;
        say(`  pick a number between 1 and ${choices.length}`);
      }
    },

    async confirm(question, fallback) {
      const hint = fallback ? '[Y/n]' : '[y/N]';

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const answer = (await rl.question(`  ${question} ${hint} > `)).trim().toLowerCase();
        if (answer === '') return fallback;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        say('  answer y or n');
      }
    },

    close() {
      rl.close();
    },
  };
}
