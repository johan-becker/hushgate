/**
 * The ambient environment a command runs in, injected rather than reached for,
 * so every command can be exercised in-process by the tests.
 */
export type Writer = (text: string) => void;

export interface Cli {
  /** Everything after the executable and the script. */
  readonly argv: readonly string[];
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Aborting stops long-running commands such as `serve`. */
  readonly signal?: AbortSignal;
}

/** Process exit codes, fixed so scripts and CI can rely on them. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  /** `hushgate scan` found personal data. */
  findings: 3,
} as const;

/** Build a {@link Cli} bound to the real process. */
export function processCli(argv: readonly string[] = process.argv.slice(2)): Cli {
  return {
    argv,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
  };
}
