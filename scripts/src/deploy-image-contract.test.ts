/** Production image build invariants learned from live deploy failures. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCKERFILE = readFileSync(path.join(ROOT, 'apps/api/Dockerfile'), 'utf8');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
const PROBE_START = 'say "verifying candidate image imports as runtime UID 1000"';
const PROBE = DEPLOY.slice(DEPLOY.indexOf(PROBE_START), DEPLOY.indexOf('# This release is the first line'));

function runProbe(exitCode: number) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'image-import-gate-'));
  const calls = path.join(directory, 'docker-args.json');
  try {
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
say() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
docker() {
  node -e 'require("node:fs").writeFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(1)))' "$@"
  return "$DOCKER_EXIT"
}
RELEASE_IMAGE=shardkeep-api:reviewed
SHA=1234567890123456789012345678901234567890
${PROBE}
printf 'later deployment steps reached\\n'
`], {
      encoding: 'utf8',
      env: { ...process.env, CALL_LOG: calls, DOCKER_EXIT: String(exitCode) },
    });
    return { ...result, args: JSON.parse(readFileSync(calls, 'utf8')) as string[] };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('production API image asset contract', () => {
  it('provides pinned workspace patches before the frozen dependency install', () => {
    // WHY: pnpm validates patch hashes even when the API filter excludes the
    // patched web dependency. Missing files must not break a production build.
    const patchCopy = DOCKERFILE.indexOf('COPY patches ./patches');
    const install = DOCKERFILE.indexOf('RUN pnpm install --frozen-lockfile');
    expect(patchCopy).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(patchCopy);
  });

  it('makes restrictive-umask atlas output readable but immutable at runtime', () => {
    // WHY: deploy.sh intentionally uses umask 077 for backup safety. Generated
    // atlas files consequently reached COPY as root:root 0600 and both API and
    // worker failed to read meta.json after dropping root. Giving runtime node
    // ownership would fix reading by also granting writes, so root normalizes
    // public assets to read-only modes before the user transition instead.
    const copy = DOCKERFILE.indexOf(
      'COPY apps/web/public/atlas ./apps/web/public/atlas',
    );
    const directoryMode = DOCKERFILE.indexOf(
      'find /app/apps/web/public/atlas -type d -exec chmod 0555 {} +',
    );
    const fileMode = DOCKERFILE.indexOf(
      'find /app/apps/web/public/atlas -type f -exec chmod 0444 {} +',
    );
    const runtimeUser = DOCKERFILE.indexOf('USER node');
    const readabilityProbe = DOCKERFILE.indexOf(
      'test -r /app/apps/web/public/atlas/meta.json',
    );
    expect(copy).toBeGreaterThan(-1);
    expect(directoryMode).toBeGreaterThan(copy);
    expect(fileMode).toBeGreaterThan(directoryMode);
    expect(runtimeUser).toBeGreaterThan(fileMode);
    expect(readabilityProbe).toBeGreaterThan(runtimeUser);
    expect(DOCKERFILE).not.toContain(
      'COPY --chown=node:node apps/web/public/atlas',
    );
    expect(DOCKERFILE).toContain('-type f ! -readable -print -quit');
    expect(DOCKERFILE).toContain('-type d ! -executable -print -quit');
    expect(DOCKERFILE).toContain('-type f -writable -print -quit');
    expect(DOCKERFILE).toContain('-type d -writable -print -quit');
    expect(DOCKERFILE).toContain('! -user root -print -quit');
    expect(DOCKERFILE).toContain('-type l -print -quit');
  });

  it('probes the actual image before any secret-bearing preflight, maintenance or drain', () => {
    // A root build succeeded with unreadable source files, but the backup
    // verifier later failed after stopping production. Test the early boundary.
    const built = DEPLOY.indexOf('docker build \\');
    const probe = DEPLOY.indexOf(PROBE_START);
    expect(built).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(built);
    for (const next of [
      'say "verifying mounted hot-wallet signer identity"',
      'say "entering maintenance',
      '$COMPOSE stop api',
    ]) expect(DEPLOY.indexOf(next)).toBeGreaterThan(probe);
  });

  it('runs guarded imports as the real non-root user without network, mounts or secrets', () => {
    const { status, args } = runProbe(0);
    expect(status).toBe(0);
    for (const flag of [
      'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--user=1000:1000',
    ]) expect(args).toContain(flag);
    expect(args.filter((arg) => arg === '--env-file' || arg === '--mount' || arg === '-v' || arg.startsWith('--env-file=') || arg.startsWith('--mount=') || arg.startsWith('--volume'))).toEqual([]);
    expect(args[args.indexOf('-e') + 1]).toBe('TSX_DISABLE_CACHE=1');
    expect(args.slice(args.indexOf('--entrypoint'), args.indexOf('--entrypoint') + 7)).toEqual([
      '--entrypoint', 'node', 'shardkeep-api:reviewed', '--import', 'tsx', '--input-type=module', '-e',
    ]);
    const code = args[args.lastIndexOf('-e') + 1]!;
    expect(code).toContain('process.getuid() !== 1000');
    expect(code).toContain('process.env.GIT_SHA !== process.argv[1]');
    expect(code).toContain('await import("/app/packages/chain/src/skr.ts")');
    expect(code).toContain('await import("/app/apps/api/src/policySignerVerify.ts")');
    expect(code).not.toMatch(/runPolicySignerStateVerify\s*\(|parseSkrLabel\s*\(|readFile|createDb|fetch\s*\(/);
    expect(args.at(-1)).toBe('1234567890123456789012345678901234567890');
  });

  it.each([1, 13])('stops deployment when runtime import/readability probe exits %i', (code) => {
    const result = runProbe(code);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('later deployment steps reached');
    expect(result.stderr).toContain('maintenance and writer drain were not started');
  });
});
