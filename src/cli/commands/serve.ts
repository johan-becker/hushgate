/** `hushgate serve` — run the proxy in the foreground. */
import { loadConfig, type ConfigOverrides, type HushgateConfig } from '../../config.js';
import { createProxyServer } from '../../proxy/server.js';
import { ROUTES } from '../../proxy/routes.js';
import { VERSION } from '../../version.js';
import { intFlag, parseFlags, stringFlag, type FlagSpecs } from '../args.js';
import { EXIT, type Cli } from '../cli.js';

export const SERVE_FLAGS: FlagSpecs = {
  config: { type: 'string', alias: 'c', description: 'path to hushgate.config.json', placeholder: '<path>' },
  host: { type: 'string', alias: 'H', description: 'address to bind (default 127.0.0.1)', placeholder: '<host>' },
  port: { type: 'number', alias: 'p', description: 'port to bind (default 8787)', placeholder: '<port>' },
  'upstream-openai': { type: 'string', description: 'base URL for /v1/chat/completions', placeholder: '<url>' },
  'upstream-anthropic': { type: 'string', description: 'base URL for /v1/messages', placeholder: '<url>' },
};

export const SERVE_SUMMARY = 'run the redacting proxy in the foreground';

export async function serve(cli: Cli, argv: readonly string[]): Promise<number> {
  const parsed = parseFlags(argv, SERVE_FLAGS);

  const overrides: ConfigOverrides = {
    host: stringFlag(parsed, 'host'),
    port: intFlag(parsed, 'port', { min: 0, max: 65_535 }),
    upstreams: {
      openai: stringFlag(parsed, 'upstream-openai'),
      anthropic: stringFlag(parsed, 'upstream-anthropic'),
    },
  };

  const { config, source } = loadConfig({
    path: stringFlag(parsed, 'config'),
    cwd: cli.cwd,
    env: cli.env,
    overrides: pruneOverrides(overrides),
  });

  const proxy = createProxyServer({ config });
  await proxy.listen();

  cli.stdout(banner(config, proxy.origin ?? `http://${config.host}:${config.port}`, source.path));

  await untilStopped(cli.signal);
  cli.stdout('\nhushgate: shutting down\n');
  await proxy.close();

  return EXIT.ok;
}

/** Drop keys the user did not pass, so they do not overwrite file values. */
function pruneOverrides(overrides: ConfigOverrides): ConfigOverrides {
  const upstreams: Record<string, string> = {};
  if (overrides.upstreams?.openai !== undefined) upstreams['openai'] = overrides.upstreams.openai;
  if (overrides.upstreams?.anthropic !== undefined) {
    upstreams['anthropic'] = overrides.upstreams.anthropic;
  }

  const pruned: ConfigOverrides = {};
  if (overrides.host !== undefined) Object.assign(pruned, { host: overrides.host });
  if (overrides.port !== undefined) Object.assign(pruned, { port: overrides.port });
  if (Object.keys(upstreams).length > 0) Object.assign(pruned, { upstreams });
  return pruned;
}

function banner(config: HushgateConfig, origin: string, configPath: string | null): string {
  const policies = Object.entries(config.redaction.policies);
  const overrides =
    policies.length === 0
      ? 'none'
      : policies.map(([kind, policy]) => `${kind}=${policy}`).join(' ');

  const lines = [
    `hushgate ${VERSION} listening on ${origin}`,
    `  config     ${configPath ?? 'built-in defaults (no hushgate.config.json found)'}`,
    `  upstreams  openai     ${config.upstreams.openai}`,
    `             anthropic  ${config.upstreams.anthropic}`,
    `  policy     ${config.redaction.defaultPolicy} by default; overrides: ${overrides}`,
    `  routes     ${ROUTES.map((route) => `POST ${route.path}`).join(', ')}, GET /healthz`,
    '',
    '  Point your SDK at this address:',
    `    OPENAI_BASE_URL=${origin}/v1`,
    `    ANTHROPIC_BASE_URL=${origin}`,
    '',
  ];

  return `${lines.join('\n')}\n`;
}

/** Resolve on Ctrl-C, on SIGTERM, or when the caller's signal aborts. */
function untilStopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      signal?.removeEventListener('abort', stop);
      resolve();
    };

    if (signal?.aborted === true) {
      resolve();
      return;
    }

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    signal?.addEventListener('abort', stop, { once: true });
  });
}
