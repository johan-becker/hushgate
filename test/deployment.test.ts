import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { createProxyServer } from '../src/proxy/server.js';
import { assertUpstreamsPermitted } from '../src/residency/policy.js';

const root = join(import.meta.dirname, '..');
const read = (name: string): string => readFileSync(join(root, name), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const manifest = read('deploy/kubernetes.yaml');

/**
 * Pull the embedded config out of the ConfigMap block without a YAML parser
 * (there are no runtime dependencies here either).
 */
function embeddedConfig(): string {
  const lines = manifest.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'hushgate.config.json: |');
  expect(start).toBeGreaterThan(-1);

  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length > 0 && !line.startsWith('    ')) break;
    block.push(line.slice(4));
  }
  return block.join('\n');
}

describe('the Dockerfile', () => {
  it('builds in one stage and ships another', () => {
    expect(dockerfile).toContain('AS build');
    expect(dockerfile).toContain('AS runtime');
    // The runtime image carries the compiled output, not the sources.
    expect(dockerfile).toContain('COPY --from=build /src/dist ./dist');
  });

  it('runs as a non-root user', () => {
    expect(dockerfile).toContain('USER node');
  });

  it('has a healthcheck that needs nothing the image does not already have', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/healthz');
    expect(dockerfile).toMatch(/HEALTHCHECK[^\n]*\n\s+CMD node -e/u);
    // Nothing is installed into the runtime stage; the probe runs on Node.
    expect(dockerfile).not.toContain('apk add');
  });

  it('keeps the audit trail outside the image layers', () => {
    expect(dockerfile).toContain('HUSHGATE_AUDIT_PATH=/var/lib/hushgate/');
  });
});

describe('the compose file', () => {
  it('publishes on loopback only', () => {
    expect(compose).toContain("- '127.0.0.1:8787:8787'");
  });

  it('runs with a read-only root filesystem and no capabilities', () => {
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('no-new-privileges:true');
  });

  it('mounts the config read-only and the audit trail on a volume', () => {
    expect(compose).toContain('/app/hushgate.config.json:ro');
    expect(compose).toContain('hushgate-audit:/var/lib/hushgate');
  });

  it('takes credentials from the environment, not the file', () => {
    expect(compose).toContain('OPENAI_API_KEY: ${OPENAI_API_KEY:-}');
    expect(compose).toContain('HUSHGATE_HMAC_KEY: ${HUSHGATE_HMAC_KEY:-}');
  });
});

describe('the Kubernetes manifest', () => {
  it('ships the four objects it needs, plus storage for the trail', () => {
    for (const kind of [
      'kind: ConfigMap',
      'kind: Secret',
      'kind: Deployment',
      'kind: Service',
      'kind: PersistentVolumeClaim',
    ]) {
      expect(manifest).toContain(kind);
    }
  });

  it('hardens the pod and the container', () => {
    for (const directive of [
      'runAsNonRoot: true',
      'readOnlyRootFilesystem: true',
      'allowPrivilegeEscalation: false',
      'seccompProfile:',
      'automountServiceAccountToken: false',
    ]) {
      expect(manifest).toContain(directive);
    }
    expect(manifest).toContain('drop:\n                - ALL');
  });

  it('probes /healthz for liveness and readiness', () => {
    expect(manifest.match(/path: \/healthz/gu)).toHaveLength(2);
    expect(manifest).toContain('livenessProbe:');
    expect(manifest).toContain('readinessProbe:');
  });

  it('sets resource requests and limits', () => {
    expect(manifest).toContain('requests:\n              cpu: 100m');
    expect(manifest).toContain('limits:\n              cpu:');
  });

  it('exposes metrics to a scraper', () => {
    expect(manifest).toContain('prometheus.io/scrape');
    expect(manifest).toContain('prometheus.io/path: /metrics');
  });

  it('runs a single replica, because the chain and the quotas are per process', () => {
    expect(manifest).toContain('replicas: 1');
  });

  it('embeds a configuration hushgate can actually parse', () => {
    // A manifest that ships a config the tool rejects is worse than no manifest.
    process.env['HUSHGATE_TENANT_KEY'] = 'hg_placeholder_for_the_test';
    try {
      const config = parseConfig(JSON.parse(embeddedConfig()), 'deploy/kubernetes.yaml');
      expect(config.host).toBe('0.0.0.0');
      expect(config.audit.path).toBe('/var/lib/hushgate/hushgate-audit.jsonl');
      expect(config.tenants).toHaveLength(1);
      // Binding 0.0.0.0 is only allowed because a tenant is defined.
      expect(config.tenants[0]!.keyHashes).toHaveLength(1);
      expect(config.residency.allow[0]!.jurisdiction).toBe('FR');
    } finally {
      delete process.env['HUSHGATE_TENANT_KEY'];
    }
  });

  it('embeds a configuration hushgate can actually start on', () => {
    // parseConfig alone is not enough: the residency allowlist is fail-closed
    // and is checked against every configured upstream at construction time,
    // which is what "kubectl apply" hits on the first pod. A manifest that
    // parses but CrashLoopBackOffs is exactly as unusable as one that does not
    // parse.
    process.env['HUSHGATE_TENANT_KEY'] = 'hg_placeholder_for_the_test';
    try {
      const config = parseConfig(JSON.parse(embeddedConfig()), 'deploy/kubernetes.yaml');
      const proxy = createProxyServer({ config });
      expect(proxy.origin).toBeNull();
    } finally {
      delete process.env['HUSHGATE_TENANT_KEY'];
    }
  });

  it('declares every configured upstream on the allowlist', () => {
    process.env['HUSHGATE_TENANT_KEY'] = 'hg_placeholder_for_the_test';
    try {
      const config = parseConfig(JSON.parse(embeddedConfig()), 'deploy/kubernetes.yaml');
      // Both upstreams are always configured, defaulted when the file omits
      // them, and assertUpstreamsPermitted checks both — so both need an entry
      // with a legal basis whether or not the operator uses both routes.
      expect(() =>
        assertUpstreamsPermitted(
          { openai: config.upstreams.openai, anthropic: config.upstreams.anthropic },
          config.residency,
        ),
      ).not.toThrow();

      for (const entry of config.residency.allow) {
        expect(entry.legalBasis.length).toBeGreaterThan(0);
      }
    } finally {
      delete process.env['HUSHGATE_TENANT_KEY'];
    }
  });

  it('marks every value the operator must replace', () => {
    expect(manifest).toContain('REPLACE ME');
  });
});
