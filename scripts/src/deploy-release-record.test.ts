/**
 * M47 §5 — the ordinary deploy records the public changelog, and can never be
 * failed or delayed into a broken state by doing so.
 *
 * WHY each pin matters:
 * - AFTER the public release proof and the maintenance-marker clear: a changelog
 *   row for a release that then rolled back to maintenance would announce changes
 *   players never got. A staged (KEEP_MAINTENANCE=1) or failed run must exit first.
 * - Inside a `( … ) ||` subshell with no `die`: the release is already final.
 *   Recording is a side effect; an unset variable, a missing CLI or a database
 *   hiccup must print a warning and let the deploy report success.
 * - Fragment text only ever travels as bytes on a pipe (collector stdout → recorder
 *   stdin): a title such as `$(touch pwned)` must reach the API verbatim and run
 *   nothing on the production host.
 * - A release with no new fragment is loud: the operator sees a WARNING that a
 *   player-visible change may have shipped without a note.
 *
 * The real shell from infra/deploy.sh runs against stub `pnpm`, `docker` and `node`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');

function at(marker: string, from = 0): number {
  const index = DEPLOY.indexOf(marker, from);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

const FUNCTION_BLOCK = DEPLOY.slice(at('# --- public release record (M47 §5)'), at('# --- end public release record'));
const CALL_BLOCK = DEPLOY.slice(at('# --- public release record call (M47 §5)'), at('# --- post-deploy housekeeping (K-082)'));
const SHA = 'a1'.repeat(20);
const HOSTILE_MANIFEST = JSON.stringify({ gitSha: SHA, fragments: [{ id: '2026-09-27-x', category: 'new', platforms: 'all',
  title: 'Walls $(touch pwned) `id` "q" \'s\' ; & | > < $HOME', body: 'Text $(touch pwned2) stays text.' }], skipped: [], history: [] });

const STUBS = `
set -euo pipefail
say() { printf '> %s\\n' "$*"; }
die() { printf 'DIE: %s\\n' "$*" >&2; exit 1; }
ENV_FILE="infra/.env.prod"
COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.prod.yml"
SHA="${SHA}"
SHORT="a1a1a1a"
pnpm() {
  printf 'pnpm %s\\n' "$*" >> "$CALL_LOG"
  [ "\${COLLECT_FAIL:-0}" = 1 ] && { echo 'collector exploded' >&2; return 3; }
  cat "$MANIFEST"
}
docker() {
  printf 'docker %s\\n' "$*" >> "$CALL_LOG"
  cat > "$STDIN_CAPTURE"
  [ "\${RECORD_FAIL:-0}" = 1 ] && { echo 'IDENTITY_MISMATCH: release history: manifest names another sha' >&2; return 1; }
  printf '%s\\n' "$RECORD_RESULT"
}
node() { printf 'node %s\\n' "$*" >> "$CALL_LOG"; return "\${PING_EXIT:-0}"; }
`;

interface Scenario { env?: Record<string, string>; ping?: boolean; prelude?: string }

function run({ env = {}, ping = false, prelude = '' }: Scenario = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'deploy-release-record-'));
  const callLog = path.join(directory, 'calls.log');
  const manifest = path.join(directory, 'manifest.json');
  const capture = path.join(directory, 'stdin.json');
  writeFileSync(manifest, HOSTILE_MANIFEST);
  writeFileSync(callLog, '');
  if (ping) {
    mkdirSync(path.join(directory, 'landing'), { recursive: true });
    writeFileSync(path.join(directory, 'landing', 'indexnow-ping.mjs'), '// stub');
  }
  try {
    const result = spawnSync('bash', ['-c', `${STUBS}\nROOT='${directory}'\n${prelude}\n${FUNCTION_BLOCK}\n${CALL_BLOCK}\necho AFTER-CALL`], {
      cwd: directory, encoding: 'utf8',
      env: {
        ...process.env, CALL_LOG: callLog, MANIFEST: manifest, STDIN_CAPTURE: capture,
        RECORD_RESULT: '{"gitSha":"x","status":"inserted","claimed":["2026-09-27-x"],"generic":false,"waiting":[],"backfilled":[]}',
        ...env,
      },
    });
    return {
      ...result, directory,
      calls: readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean),
      stdin: existsSync(capture) ? readFileSync(capture, 'utf8') : null,
      pwned: existsSync(path.join(directory, 'pwned')) || existsSync(path.join(directory, 'pwned2')),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('record_public_release placement (static)', () => {
  it('runs once, after the public proof, the marker clear and the staged exit, before housekeeping', () => {
    expect(DEPLOY.match(/\brecord_public_release\b/g)).toHaveLength(2); // definition + one call
    const call = at('( record_public_release )');
    const stagedExit = at('exit 0', at('if [ "$KEEP_MAINTENANCE" = 1 ]; then'));
    for (const earlier of [
      stagedExit,
      at('|| ! traffic_returned_proven; then'),
      at('$COMPOSE exec -T caddy rm -f /config/shardkeep-maintenance'),
      at('deployed v%s (%s), sim v%s'),
    ]) expect(earlier).toBeLessThan(call);
    expect(call).toBeLessThan(at('( post_deploy_housekeeping )'));
  });

  it('is non-fatal: a subshell with an || warning, and no die or exit anywhere on its path', () => {
    const call = at('( record_public_release )');
    expect(DEPLOY.slice(call)).toMatch(/^\( record_public_release \) \\\n {2}\|\| printf '[^\n]*deploy itself SUCCEEDED/);
    expect(DEPLOY.slice(call)).not.toMatch(/\bdie\s+["']/);
    expect(FUNCTION_BLOCK).not.toMatch(/\bdie\s+["']|\bexit\b/);
    // pipefail is what lets a failed collector fail the pipeline instead of
    // recording an empty manifest as "no new notes".
    expect(DEPLOY).toMatch(/^set -euo pipefail$/m);
  });

  it('records inside the NEW api container, from the deployed sha, with the production env flags', () => {
    expect(FUNCTION_BLOCK).toContain('release-notes:collect \\\n      --sha "$SHA" --root "$ROOT" --env-file "$ROOT/$ENV_FILE"');
    expect(FUNCTION_BLOCK).toContain('| $COMPOSE exec -T api node --import tsx src/releases/cli.ts record --manifest - --recorded-by deploy.sh');
  });

  it('the recorder CLI ships in the api image at the path deploy.sh execs', () => {
    // WHY: `exec -T api node --import tsx src/releases/cli.ts` resolves against the
    // image's WORKDIR; a Dockerfile that stopped copying apps/api (or moved the
    // workdir) would silently turn every changelog record into a warning.
    const dockerfile = readFileSync(path.join(ROOT, 'apps/api/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^COPY apps\/api \.\/apps\/api$/m);
    expect(dockerfile.match(/^WORKDIR .+$/gm)?.at(-1)).toBe('WORKDIR /app/apps/api');
    expect(existsSync(path.join(ROOT, 'apps/api/src/releases/cli.ts'))).toBe(true);
  });
});

describe('record_public_release behaviour (real shell, stub tools)', () => {
  it('pipes the collector output byte for byte to the recorder and runs none of it', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdin).toBe(HOSTILE_MANIFEST);
    expect(result.pwned).toBe(false);
    // Both sides of a pipe start together, so their log lines may land in either order.
    expect([...result.calls].sort()).toEqual([
      `pnpm --filter @shardkeep/scripts run --silent release-notes:collect --sha ${SHA} --root ${result.directory} --env-file ${result.directory}/infra/.env.prod`,
      'docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml exec -T api node --import tsx src/releases/cli.ts record --manifest - --recorded-by deploy.sh',
    ].sort());
    expect(result.stdout).toContain('"status":"inserted"');
    expect(result.stdout).not.toContain('WARNING');
    expect(result.stdout).toContain('AFTER-CALL');
  });

  it('warns loudly when the release carried no new fragment, and still succeeds', () => {
    const result = run({ env: { RECORD_RESULT: '{"gitSha":"x","status":"inserted","claimed":[],"generic":true,"waiting":[],"backfilled":[]}' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('WARNING — a1a1a1a shipped NO new release-notes fragment');
    expect(result.stdout).toContain('release-notes/README.md');
    expect(result.stdout).toContain('AFTER-CALL');
  });

  it('says when fragments over the per-release cap were deferred to the next deploy (K-night-C2)', () => {
    // WHY: on 2026-10-11 deploy e1876c0c0 carried 45 fresh fragments; the recorder now
    // publishes 40 and defers the rest, and the operator must see that notes are waiting.
    const result = run({ env: { RECORD_RESULT: '{"gitSha":"x","status":"inserted","claimed":["2026-09-27-x"],"generic":false,"deferred":["2026-10-11-late"],"waiting":[],"backfilled":[]}' } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('"deferred":["2026-10-11-late"]');
    expect(result.stdout).toContain('NOTE — a1a1a1a carried more new fragments than one changelog row holds');
    expect(result.stdout).not.toContain('WARNING');
    const none = run({ env: { RECORD_RESULT: '{"gitSha":"x","status":"inserted","claimed":["2026-09-27-x"],"generic":false,"deferred":[],"waiting":[],"backfilled":[]}' } });
    expect(none.stdout).not.toContain('NOTE —');
  });

  it.each([
    ['the recorder refuses', { RECORD_FAIL: '1' }],
    ['the collector fails', { COLLECT_FAIL: '1' }],
  ])('%s: the changelog warning prints and the deploy carries on', (_label, env) => {
    const result = run({ env });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('the public changelog was NOT updated');
    expect(result.stdout).toContain('rerun from');
    expect(result.stdout).toContain('The deploy itself SUCCEEDED');
    expect(result.stdout).toContain('AFTER-CALL');
    expect(result.stdout).not.toContain('DIE');
  });

  it('an unset variable inside the step cannot turn a verified deploy into a failure', () => {
    const result = run({ prelude: 'unset SHA' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('The deploy itself SUCCEEDED');
    expect(result.stdout).toContain('AFTER-CALL');
  });

  it('pings search engines only for a newly inserted release, and a failed ping is harmless', () => {
    const inserted = run({ ping: true });
    expect(inserted.calls).toContain('node landing/indexnow-ping.mjs https://pixelkingdomwars.com/changelog');
    const repeat = run({ ping: true, env: { RECORD_RESULT: '{"gitSha":"x","status":"exists","claimed":[],"generic":false,"waiting":[],"backfilled":[]}' } });
    expect(repeat.calls.some((call) => call.startsWith('node '))).toBe(false);
    const failed = run({ ping: true, env: { PING_EXIT: '1' } });
    expect(failed.status).toBe(0);
    expect(failed.stdout).toContain('search-engine ping failed; the changelog itself is updated.');
    expect(failed.stdout).not.toContain('WARNING — the public changelog');
    const absent = run();
    expect(absent.calls.some((call) => call.startsWith('node '))).toBe(false);
  });
});
