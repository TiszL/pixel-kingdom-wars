/**
 * M45 §3 — the production Caddyfile reverse-proxies /native/releases/* to
 * {$R2_PUBLIC_BASE_URL}. Caddy refuses to START when an upstream URL carries
 * any path, even a trailing slash, while the API strips that slash and runs
 * fine. deploy.sh must refuse such a value BEFORE caddy is recreated or the
 * maintenance window opens; otherwise the final `caddy validate` dies with the
 * whole public origin dark, and a later caddy restart takes the site down.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
const COMPOSE = readFileSync(path.join(ROOT, 'infra/docker-compose.prod.yml'), 'utf8');

function at(marker: string): number {
  const index = DEPLOY.indexOf(marker);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

const PREFLIGHT_START = 'R2_PUBLIC_BASE_URL_CHECK="$(sed -n';
// The next pre-flight (installed native builds: store code 32, header-less code 25, the SIM-18 floor) has its own
// test: deploy-native-store-compat.test.ts.
const PREFLIGHT_END = '# --- pre-flight: the installed store build keeps working (M45 D1)';

function runPreflight(envFile: string): { status: number | null; stdout: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'r2-origin-preflight-'));
  try {
    writeFileSync(path.join(directory, 'env'), envFile);
    const block = DEPLOY.slice(at(PREFLIGHT_START), at(PREFLIGHT_END));
    const result = spawnSync('bash', ['-c', `set -euo pipefail
ENV_FILE=env
die() { echo "FAIL: $*"; exit 1; }
${block}
echo PASSED`], { cwd: directory, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('deploy.sh refuses an R2_PUBLIC_BASE_URL Caddy cannot start on (M45 §3)', () => {
  it('runs before caddy is recreated, started or swapped to maintenance', () => {
    // A refusal after any of these leaves players on a dark origin.
    const preflight = at(PREFLIGHT_START);
    expect(preflight).toBeLessThan(at('--force-recreate caddy'));
    expect(preflight).toBeLessThan(at('say "entering maintenance'));
    expect(preflight).toBeLessThan(at('$COMPOSE up -d caddy'));
    expect(preflight).toBeLessThan(at('caddy validate --config /etc/caddy/Caddyfile'));
  });

  it.each([
    'R2_PUBLIC_BASE_URL=https://pub-abc.r2.dev\n',
    'R2_PUBLIC_BASE_URL="https://pub-abc.r2.dev"\n',
    'R2_PUBLIC_BASE_URL=https://cdn.example.com:8443\n',
    // Unset or empty: compose substitutes https://invalid.invalid, which Caddy accepts.
    'R2_PUBLIC_BASE_URL=\n',
    'OTHER=1\n',
  ])('accepts a scheme://host value or an unset one: %j', (envFile) => {
    expect(runPreflight(envFile)).toMatchObject({ status: 0, stdout: 'PASSED\n' });
  });

  it.each([
    // The exact shape the API tolerates (server.ts/deedR2.ts strip it) but Caddy refuses.
    'R2_PUBLIC_BASE_URL=https://pub-abc.r2.dev/\n',
    'R2_PUBLIC_BASE_URL=https://cdn.example.com/deeds\n',
    'R2_PUBLIC_BASE_URL=https://cdn.example.com?x=1\n',
    'R2_PUBLIC_BASE_URL=http://pub-abc.r2.dev\n',
    'R2_PUBLIC_BASE_URL=pub-abc.r2.dev\n',
    'R2_PUBLIC_BASE_URL=https://\n',
    // Two lines: compose would take one of them, the check cannot know which.
    'R2_PUBLIC_BASE_URL=https://a.r2.dev\nR2_PUBLIC_BASE_URL=https://b.r2.dev\n',
  ])('refuses a value with a path, slash, query, other scheme or duplicate: %j', (envFile) => {
    const result = runPreflight(envFile);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: R2_PUBLIC_BASE_URL must appear at most once');
    expect(result.stdout).not.toContain('PASSED');
  });

  it('keeps the compose fallback a value that passes the same rule', () => {
    // An unset variable must never make Caddy refuse to start either.
    expect(COMPOSE).toContain('R2_PUBLIC_BASE_URL: ${R2_PUBLIC_BASE_URL:-https://invalid.invalid}');
  });
});
