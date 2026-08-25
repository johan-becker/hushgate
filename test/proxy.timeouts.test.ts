/**
 * A connection that never finishes a request is the cheapest attack there is:
 * a handful of curl one-liners against a proxy that binds 0.0.0.0 exhausts the
 * file-descriptor budget and takes every tenant down with it. Node's own
 * `requestTimeout` and `headersTimeout` do not catch it — one is re-checked at
 * request boundaries, the other is pushed forward by every arriving byte — so
 * these tests drive real sockets and assert that hushgate's sweeper does.
 *
 * The budgets here are a few hundred milliseconds so the suite stays fast; a
 * closure inside a second is the sweeper's doing, since Node polls its own
 * timeouts on a thirty-second interval and could not have acted that quickly.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HushgateConfig } from '../src/config.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import type { FakeReply } from './helpers/fake-upstream.js';

let harness: Harness | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.destroy();
  await harness?.close();
  harness = undefined;
});

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' };

const openAiChunk = (content: string): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;

/** A proxy whose reaper fires in the time a test can afford to wait. */
function impatient(idleTimeoutMs: number, requestTimeoutMs: number) {
  return (base: HushgateConfig): HushgateConfig => ({
    ...base,
    limits: { ...base.limits, idleTimeoutMs, requestTimeoutMs },
  });
}

/** Open a raw connection to the proxy, bypassing fetch and its own timeouts. */
async function rawSocket(origin: string): Promise<Socket> {
  const { port, hostname } = new URL(origin);
  const socket = connect({ port: Number(port), host: hostname });
  sockets.push(socket);
  // A reaped socket arrives as ECONNRESET, which is the expected outcome here
  // and must not surface as an unhandled error event.
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Resolve with how long the socket stayed open, or reject if it outlives the wait. */
function closedWithin(socket: Socket, ms: number): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const gaveUp = setTimeout(() => {
      reject(new Error(`socket was still open after ${Date.now() - started} ms`));
    }, ms);
    gaveUp.unref();
    socket.once('close', () => {
      clearTimeout(gaveUp);
      resolve(Date.now() - started);
    });
  });
}

/** Write one byte every `everyMs` until the socket goes away. */
function drip(socket: Socket, everyMs: number): void {
  const timer = setInterval(() => {
    if (socket.destroyed || socket.writableEnded) {
      clearInterval(timer);
      return;
    }
    socket.write('x');
  }, everyMs);
  timer.unref();
  socket.once('close', () => clearInterval(timer));
}

describe('slow and stalled connections', () => {
  it('reaps a socket that connects and never says anything', async () => {
    harness = await startHarness({ config: impatient(300, 5_000) });
    const socket = await rawSocket(harness.origin);

    await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThan(0);
  });

  it('reaps a header slowloris, which stays "active" by dripping', async () => {
    // One byte every 60 ms keeps any inactivity timer alive forever. The
    // ceiling is measured from when the connection was accepted and is never
    // restamped by incoming data, which is the whole reason it works.
    harness = await startHarness({ config: impatient(300, 5_000) });
    const socket = await rawSocket(harness.origin);
    socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nX-Pad: ');
    drip(socket, 60);

    await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThan(0);
  });

  it('reaps a body that is dripped in under the announced content-length', async () => {
    // Headers are complete here, so the request has reached the handler and it
    // is `requestTimeoutMs` — how long a client may take to deliver a request —
    // that bounds it, not the idle budget.
    harness = await startHarness({ config: impatient(30_000, 300) });
    const socket = await rawSocket(harness.origin);
    socket.write(
      'POST /v1/chat/completions HTTP/1.1\r\n' +
        'Host: localhost\r\n' +
        'Content-Type: application/json\r\n' +
        'Content-Length: 100000\r\n\r\n' +
        '{"messages":[{"role":"user","content":"',
    );
    drip(socket, 60);

    await expect(closedWithin(socket, 3_000)).resolves.toBeGreaterThan(0);
  });

  it('does not reap a keep-alive socket that is being used', async () => {
    // The budget is restamped when a request completes, so a client that comes
    // back inside the window keeps its connection — which is the only reason a
    // pool is worth having.
    harness = await startHarness({ config: impatient(600, 5_000) });

    const first = await harness.get('/healthz');
    expect(first.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await harness.get('/healthz');
    expect(second.status).toBe(200);
  });

  it('does not reap a stream that is silent while the model thinks', async () => {
    // The regression that matters most: a legitimate SSE response can produce
    // nothing for far longer than any idle budget, and killing it would break
    // streaming outright.
    harness = await startHarness({
      config: impatient(200, 200),
      handler: (): FakeReply => ({
        headers: SSE_HEADERS,
        body: '',
        chunks: [openAiChunk('Schreib an '), openAiChunk('johan@example.com'), 'data: [DONE]\n\n'],
        // Three gaps, each several times the idle budget.
        chunkDelayMs: 700,
      }),
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      stream: true,
      messages: [{ role: 'user', content: 'Antwort bitte' }],
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data: [DONE]');
    expect(body).toContain('Schreib an ');
  });
});
