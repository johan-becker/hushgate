/**
 * Time spent on the CPU, for tests that compare the cost of two input sizes.
 *
 * A ratio of wall-clock times measures the machine as much as the code. On a
 * busy one a 35 ms run is preempted and a 4 ms run often is not, so the ratio
 * grows by however oversubscribed the machine is: a linear detector measured
 * 7.7 idle and 33.4 with three suites running at once. CPU time does not count
 * the time spent waiting for a core.
 *
 * Vitest runs each test file in a child process of its own, so the process's
 * CPU time is this file's. Should a file ever run on a worker thread instead,
 * process-wide CPU time would include its neighbours, and wall-clock time is
 * the honest fallback.
 */
import { isMainThread } from 'node:worker_threads';

export function cpuMs(work: () => unknown): number {
  if (!isMainThread) {
    const started = performance.now();
    work();
    return performance.now() - started;
  }
  const before = process.cpuUsage();
  work();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / 1_000;
}
