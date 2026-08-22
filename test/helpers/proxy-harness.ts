/**
 * Wiring shared by the proxy tests: a fake upstream, a proxy pointed at it, and
 * a tiny client. Everything binds to 127.0.0.1 on an ephemeral port.
 */
import { defaultConfig, type HushgateConfig } from '../../src/config.js';
import { createProxyServer, type ProxyOptions, type ProxyServer } from '../../src/proxy/server.js';
import { startFakeUpstream, type FakeHandler, type FakeUpstream } from './fake-upstream.js';

export interface Harness {
  readonly upstream: FakeUpstream;
  readonly proxy: ProxyServer;
  readonly origin: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly handler?: FakeHandler;
  /** Overlay on top of the default configuration. */
  readonly config?: (base: HushgateConfig, upstreamOrigin: string) => HushgateConfig;
  readonly proxy?: Omit<ProxyOptions, 'config'>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const upstream = await startFakeUpstream(options.handler);

  const base: HushgateConfig = {
    ...defaultConfig(),
    port: 0,
    upstreams: { openai: upstream.origin, anthropic: upstream.origin },
    // Retries are exercised deliberately in the retry tests; leaving them on
    // here would only make every failure case take a second longer.
    limits: { ...defaultConfig().limits, upstreamRetries: 0 },
    redaction: {
      ...defaultConfig().redaction,
      // Fix the birth-year window so the suite does not drift with the clock.
      dobYearRange: { minYear: 1900, maxYear: 2013 },
    },
  };

  const config = options.config === undefined ? base : options.config(base, upstream.origin);
  const proxy = createProxyServer({
    config,
    onInternalError: () => {
      /* the tests assert on responses; a stack trace would only be noise */
    },
    ...options.proxy,
  });
  await proxy.listen();

  const origin = proxy.origin;
  if (origin === null) throw new Error('proxy did not bind');

  return {
    upstream,
    proxy,
    origin,

    post(path, body, headers = {}): Promise<Response> {
      return fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    },

    get(path, headers = {}): Promise<Response> {
      return fetch(`${origin}${path}`, { headers });
    },

    async close(): Promise<void> {
      await proxy.close({ graceMs: 0 });
      await upstream.close();
    },
  };
}
