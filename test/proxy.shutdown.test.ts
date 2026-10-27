/**
 * Shutting the proxy down without losing audit records.
 *
 * `serve` closes the audit sinks as soon as `proxy.close()` resolves, so every
 * request still being handled at that moment has to have written its record
 * by then — including one whose client has gone, and one whose provider has
 * not answered. These tests use a real trail on disk, closed straight after
 * the proxy exactly as `serve` closes it, because a record handed to a closed
 * trail is the failure being guarded against.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditLog } from '../src/audit/log.js';
import type { AuditRecord } from '../src/audit/record.js';
import { parseAuditLines } from '../src/audit/trail.js';
import { UpstreamError } from '../src/errors.js';
import { withRetry } from '../src/proxy/retry.js';
import { collect, nodeUpstreamClient, type UpstreamClient, type UpstreamRequest } from '../src/proxy/upstream.js';
import { startFakeUpstream, type FakeReply, type FakeUpstream } from './helpers/fake-upstream.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import { waitFor } from './helpers/wait.js';

const dirs: string[] = [];
let harness: Harness | undefined;
let upstream: FakeUpstream | undefined;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hushgate-shutdown-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await upstream?.close();
  upstream = undefined;
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function readRecords(path: string): AuditRecord[] {
  const { records, malformed } = parseAuditLines(readFileSync(path, 'utf8'));
  expect(malformed).toEqual([]);
  return records;
}

const chat = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'mail anna@example.de' }],
};

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('closing the proxy while requests are in flight', () => {
  it('records a request whose upstream never answers as failed before close resolves', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const audit = new JsonlAuditLog({ path });
    harness = await startHarness({
      handler: (): FakeReply => ({ body: '', hang: true }),
      proxy: { audit },
    });

    const reply = harness.post('/v1/chat/completions', chat).catch(() => null);
    await waitFor(() => harness!.upstream.requests.length === 1, { what: 'the upstream call' });

    await harness.proxy.close({ graceMs: 50 });
    await audit.close();
    await reply;

    const records = readRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: 'failed',
      status: 502,
      upstream: new URL(harness.upstream.origin).host,
      findings: { EMAIL: 1 },
    });
  });

  it('waits for a handler whose client has already hung up', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const audit = new JsonlAuditLog({ path });
    harness = await startHarness({
      handler: async (): Promise<FakeReply> => {
        await sleep(200);
        return { headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
      },
      proxy: { audit },
    });

    // The client gives up first. With its socket gone the server has no
    // connections left, which is what used to let close() resolve while the
    // handler was still waiting on the provider.
    const client = new AbortController();
    const reply = fetch(`${harness.origin}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chat),
      signal: client.signal,
    }).catch(() => null);
    await waitFor(() => harness!.upstream.requests.length === 1, { what: 'the upstream call' });
    client.abort();
    await reply;

    const started = Date.now();
    await harness.proxy.close({ graceMs: 5_000 });
    await audit.close();

    // It finished on its own, well inside the grace period: nothing had to be
    // abandoned, so it is recorded as forwarded — which it was.
    expect(Date.now() - started).toBeLessThan(2_000);
    const records = readRecords(path);
    expect(records.map((record) => record.outcome)).toEqual(['forwarded']);
  });

  it('abandons a stream the provider stopped in the middle of, and records it as failed', async () => {
    const path = join(workspace(), 'audit.jsonl');
    const audit = new JsonlAuditLog({ path });
    const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hallo' } }] })}\n\n`;
    harness = await startHarness({
      handler: (): FakeReply => ({ headers: SSE_HEADERS, body: '', chunks: [first], stall: true }),
      proxy: { audit },
    });

    const response = await harness.post('/v1/chat/completions', { ...chat, stream: true });
    const reader = response.body!.getReader();
    await reader.read();

    await harness.proxy.close({ graceMs: 50 });
    await audit.close();
    await reader.read().catch(() => null);

    const records = readRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'failed', stream: true });
  });

  it('returns the same promise when closed twice', async () => {
    harness = await startHarness();
    const once = harness.proxy.close({ graceMs: 0 });
    expect(harness.proxy.close({ graceMs: 0 })).toBe(once);
    await once;
  });
});

const outbound = (origin: string, signal?: AbortSignal): UpstreamRequest => ({
  url: `${origin}/v1/chat/completions`,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  timeoutMs: 60_000,
  ...(signal === undefined ? {} : { signal }),
});

describe('abandoning an upstream call', () => {
  it('sends nothing when the signal has already aborted', async () => {
    upstream = await startFakeUpstream();

    await expect(nodeUpstreamClient(outbound(upstream.origin, AbortSignal.abort()))).rejects.toThrow(
      UpstreamError,
    );
    expect(upstream.requests).toHaveLength(0);
  });

  it('fails a call still waiting for its headers', async () => {
    upstream = await startFakeUpstream((): FakeReply => ({ body: '', hang: true }));
    const abandon = new AbortController();

    const call = nodeUpstreamClient(outbound(upstream.origin, abandon.signal));
    await waitFor(() => upstream!.requests.length === 1, { what: 'the upstream call' });
    abandon.abort();

    await expect(call).rejects.toThrow(/abandoned/u);
  });

  it('ends a body that is still streaming with an upstream error', async () => {
    upstream = await startFakeUpstream(
      (): FakeReply => ({ headers: SSE_HEADERS, body: '', chunks: ['data: {}\n\n'], stall: true }),
    );
    const abandon = new AbortController();

    const response = await nodeUpstreamClient(outbound(upstream.origin, abandon.signal));
    const body = collect(response.body);
    abandon.abort();

    // An UpstreamError rather than the socket's bare `aborted`: that is what
    // makes the proxy record the request as failed for the right reason.
    await expect(body).rejects.toThrow(UpstreamError);
  });

  it('leaves no listener behind on the signal once a call is over', async () => {
    upstream = await startFakeUpstream();
    const abandon = new AbortController();

    const response = await nodeUpstreamClient(outbound(upstream.origin, abandon.signal));
    await collect(response.body);
    await waitFor(() => getEventListeners(abandon.signal, 'abort').length === 0, {
      what: 'the abort listener to be removed',
    });
  });
});

describe('retrying an abandoned call', () => {
  const request: UpstreamRequest = {
    url: 'http://127.0.0.1/v1/chat/completions',
    method: 'POST',
    headers: {},
    body: '{}',
    timeoutMs: 1_000,
  };

  it('does not retry once the signal has aborted', async () => {
    const abandon = new AbortController();
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      abandon.abort();
      return Promise.reject(new UpstreamError('request to upstream was abandoned', 'network'));
    };

    await expect(
      withRetry(client, { retries: 3, backoffMs: 10, sleep: () => Promise.resolve() })({
        ...request,
        signal: abandon.signal,
      }),
    ).rejects.toThrow(/abandoned/u);
    expect(calls).toBe(1);
  });

  it('wakes from a backoff when the signal aborts, and does not try again', async () => {
    const abandon = new AbortController();
    let calls = 0;
    const client: UpstreamClient = () => {
      calls += 1;
      return Promise.reject(new UpstreamError('connection refused', 'network'));
    };

    // A minute of backoff: only the abort can end this inside the test timeout.
    const retrying = withRetry(client, { retries: 3, backoffMs: 60_000 })({
      ...request,
      signal: abandon.signal,
    });
    await waitFor(() => calls === 1, { what: 'the first attempt' });
    abandon.abort();

    await expect(retrying).rejects.toThrow(/connection refused/u);
    expect(calls).toBe(1);
  });
});
