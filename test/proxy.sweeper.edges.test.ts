/**
 * Edge cases around the connection sweeper in src/proxy/server.ts.
 *
 * The main timeouts suite covers the happy reaper paths; this file pins the
 * corners: the phase transitions themselves (the prepended `request` listener
 * and settle-on-close), the serving-phase exemption, the bound a hung upstream
 * really has, keep-alive reuse of one Map slot, and degenerate interval math
 * when a budget is set absurdly low.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HushgateConfig } from '../src/config.js';
import { startHarness, type Harness } from './helpers/proxy-harness.js';
import type { FakeReply, FakeHandler } from './helpers/fake-upstream.js';

let harness: Harness | undefined;
const sockets: Socket[] = [];

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.destroy();
  await harness?.close();
  harness = undefined;
});

const impatient = (idleTimeoutMs: number, requestTimeoutMs: number) =>
  (base: HushgateConfig): HushgateConfig => ({
    ...base,
    limits: { ...base.limits, idleTimeoutMs, requestTimeoutMs },
  });

async function rawSocket(origin: string): Promise<Socket> {
  const { port, hostname } = new URL(origin);
  const socket = connect({ port: Number(port), host: hostname });
  sockets.push(socket);
  socket.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

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

/** Send one complete HTTP/1.1 request over a raw socket and read the reply. */
function roundTrip(socket: Socket, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    const done = (): void => {
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      resolve(raw);
    };
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
      // /healthz answers with a content-length; that is all we wait for here.
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? 0);
      if (raw.length >= headerEnd + 4 + length) done();
    };
    const fail = (cause: Error): void => {
      socket.removeListener('data', onData);
      reject(cause);
    };
    socket.on('data', onData);
    socket.on('error', fail);
    socket.write(`${target} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n`);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('sweeper edge cases', () => {
  it('keeps a socket in serving past both budgets until the upstream answers', async () => {
    // Pins two claims at once: the prepended request listener sets `receiving`
    // before the handler runs and `end` moves it to `serving` — so a slow
    // upstream is exempt from both budgets. Were the phase still `idle` or
    // `receiving` here, the sweeper would cut the connection long before the
    // handler's own delay elapsed.
    const replyDelayMs = 900;
    const handler: FakeHandler = async (): Promise<FakeReply> => {
      await sleep(replyDelayMs);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
    };
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...impatient(150, 150)(base),
        limits: { ...impatient(150, 150)(base).limits, upstreamTimeoutMs: 5_000 },
      }),
      handler,
    });

    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Antwort bitte' }],
    });
    expect(response.status).toBe(200);
  }, 10_000);

  it('bounds a hung upstream via upstreamTimeoutMs even though serving is exempt', async () => {
    // `hang: true` never answers. The sweeper will not reap the socket while
    // it serves, so the only thing standing between the client and a forever
    // wait is limits.upstreamTimeoutMs — assert that it fires well inside the
    // test window.
    harness = await startHarness({
      config: (base): HushgateConfig => ({
        ...base,
        limits: { ...base.limits, upstreamTimeoutMs: 300 },
      }),
      handler: (): FakeReply => ({ body: '', hang: true }),
    });

    const started = Date.now();
    const response = await harness.post('/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Antwort bitte' }],
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it('settles back to idle after finish, so the idle budget applies again', async () => {
    // Regression for settle-on-close/finish: once a response completes on a
    // keep-alive socket, its slot must be restamped to `idle`, or the socket
    // would sit outside every budget forever after its first request.
    harness = await startHarness({ config: impatient(400, 30_000) });
    const socket = await rawSocket(harness.origin);

    const first = await roundTrip(socket, 'GET /healthz');
    expect(first).toContain('200');

    // Well past the idle budget with no further traffic: the sweeper — not
    // Node, whose own poll is thirty seconds — must close it.
    await expect(closedWithin(socket, 2_500)).resolves.toBeGreaterThan(0);
  }, 10_000);

  it('does not reap a keep-alive socket between requests that reuse one Map slot', async () => {
    // Every request on one connection reuses the same entry; a leak or a
    // stale phase would show up as the connection dying mid-sequence.
    harness = await startHarness({ config: impatient(600, 5_000) });

    // Sequential is the assertion, not an oversight: the point is that the
    // same socket survives one request after another with an idle gap between
    // them. Running them in parallel would test a different thing entirely.
    for (let i = 0; i < 8; i += 1) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await harness.get('/healthz');
      expect(response.status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop
      await sleep(120);
    }
  }, 15_000);

  it('still sweeps when idleTimeoutMs is 1ms despite the clamped sweep interval', async () => {
    // sweepMs is floored at 25ms so a tiny budget cannot busy-loop the timer;
    // the budget check itself (`now - since >= budget`) must still reap —
    // just one sweep later, not never.
    harness = await startHarness({ config: impatient(1, 5_000) });
    const socket = await rawSocket(harness.origin);

    await expect(closedWithin(socket, 1_000)).resolves.toBeGreaterThan(0);
  }, 10_000);
});
