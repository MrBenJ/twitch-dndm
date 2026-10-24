import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

describe('deploy files', () => {
  const fly = read('fly.toml');
  const docker = read('Dockerfile');
  const runbook = read('docs/deploy.md');

  it('fly.toml keeps one always-on machine, rolling deploys, migrations and the health check', () => {
    for (const line of [
      'strategy = "rolling"',
      'auto_stop_machines = "off"',
      'min_machines_running = 1',
      'path = "/health"',
      'kill_timeout = 30',
      'kill_signal = "SIGTERM"',
      'server migrate',
    ])
      expect(fly).toContain(line);
    expect(fly).not.toMatch(/bluegreen|canary/);
  });

  it('the Dockerfile builds on node:24-slim, runs as non-root and starts on 0.0.0.0:8080', () => {
    expect(docker.match(/FROM node:24-slim/g)).toHaveLength(2);
    expect(docker).toContain('pnpm install --frozen-lockfile');
    expect(docker).toContain('USER node');
    expect(docker).toContain('"--host", "0.0.0.0", "--port", "8080"');
  });

  it('the runbook says it is not a self-hosting guide', () => {
    expect(runbook).toContain("It isn't a self-hosting guide.");
  });

  it('the runbook deploys a single machine the first time', () => {
    expect(runbook).toContain('fly deploy --ha=false');
    expect(runbook).toContain('fly scale count 1');
  });

  it('.dockerignore keeps env files and logs out of the build context', () => {
    const lines = read('.dockerignore').split('\n').map((l) => l.trim());
    expect(lines).toContain('.env*');
    expect(lines).toContain('*.log');
  });
});
