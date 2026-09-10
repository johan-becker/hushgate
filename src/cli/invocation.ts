/**
 * How to spell a hushgate command back to whoever invoked this one.
 *
 * Under `npx` there is no `hushgate` on PATH: npm fetches the package into a
 * cache, runs it, and leaves nothing behind. Printing `hushgate serve` to that
 * operator sends them to `command not found` on the very next line they type,
 * with nothing to blame but the tool that just told them to type it.
 *
 * `npm_command` is set by npm itself for everything it runs, and is `exec`
 * exactly under `npx`. It comes through {@link Cli.env} rather than
 * `process.env` so the wizard can be driven from a test either way.
 */
export const NPX = 'npx hushgate';

export function invokedAs(env: NodeJS.ProcessEnv): string {
  return env.npm_command === 'exec' ? NPX : 'hushgate';
}
