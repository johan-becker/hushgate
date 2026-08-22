/** Poll until a condition holds, or fail loudly. Keeps the tests free of sleeps. */
export async function waitFor(
  condition: () => boolean,
  { timeoutMs = 5_000, intervalMs = 5, what = 'condition' } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
