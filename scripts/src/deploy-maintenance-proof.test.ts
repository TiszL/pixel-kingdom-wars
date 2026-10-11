/**
 * K-071 — the maintenance window is PROVEN, never assumed.
 *
 * The M27 and M28 windows served Chrome's bare "HTTP ERROR 503": the caddy
 * container held an orphaned bind-mount inode for infra/maintenance, so
 * `caddy reload` exited 0 while /srv/maintenance read empty. These tests read
 * infra/deploy.sh as text and pin the ORDER of its guards, because a guard that
 * runs after the drain begins (or a proof that is skipped when the reload
 * "succeeds") reproduces exactly that silent failure.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
const MAINTENANCE_CADDYFILE = readFileSync(path.join(ROOT, 'infra/Caddyfile.maintenance'), 'utf8');
const COMPOSE = readFileSync(path.join(ROOT, 'infra/docker-compose.prod.yml'), 'utf8');
const START = readFileSync(path.join(ROOT, 'infra/caddy-start.sh'), 'utf8');

function at(marker: string): number {
  const index = DEPLOY.indexOf(marker);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

describe('deploy.sh proves the maintenance page (K-071)', () => {
  it('checks every caddy bind mount from both sides before the window opens', () => {
    // A bind mount pins the host inode at container creation; a recreated host
    // path is invisible to the running container. Both sides must agree BEFORE
    // traffic is drained, while a recreation is still cheap and safe.
    const preflight = at('caddy_bind_mounts_fresh() {');
    for (const mount of [
      'infra/maintenance:/srv/maintenance',
      'infra/Caddyfile.maintenance:/etc/caddy/Caddyfile.maintenance',
      'infra/Caddyfile.vps:/etc/caddy/Caddyfile',
      'infra/caddy-start.sh:/etc/caddy/start.sh',
      'infra/dist:/srv/www',
    ]) expect(DEPLOY.indexOf(mount)).toBeGreaterThan(preflight);
    expect(DEPLOY).toContain('stat -c %i "$host_path"');
    expect(DEPLOY).toContain('exec -T caddy stat -c %i "$container_path"');
    expect(DEPLOY).toContain('exec -T caddy test -s /srv/maintenance/index.html');
    expect(at('--force-recreate caddy')).toBeLessThan(at('say "entering maintenance'));
  });

  it('proves the page from the public origin and only then trusts it', () => {
    // `caddy reload` exits 0 with an empty page directory. The only honest
    // evidence is what a player would receive: 503 WITH the html body on `/`
    // and the coded MAINTENANCE envelope on /api/version.
    const reload = at('caddy reload --config /etc/caddy/Caddyfile.maintenance');
    const proof = at('if maintenance_page_proven; then');
    const drain = at('say "draining started live raids');
    expect(reload).toBeLessThan(proof);
    expect(proof).toBeLessThan(drain);
    // MAINTENANCE_PAGE="up" is set exactly once, inside the proven branch.
    const upMarks = DEPLOY.split('MAINTENANCE_PAGE="up"').length - 1;
    expect(upMarks).toBe(1);
    expect(DEPLOY.indexOf('MAINTENANCE_PAGE="up"')).toBeGreaterThan(proof);
    const body = DEPLOY.slice(at('maintenance_page_proven() {'), at('traffic_returned_proven() {'));
    expect(body).toContain("page.status === 503");
    expect(body).toContain("startsWith('text/html')");
    expect(body).toContain('<title>Pixel Kingdom Wars — Maintenance</title>');
    expect(body).toContain("json?.error?.code === 'MAINTENANCE'");
    // A failed proof falls back to the hard stop, never to a blind window.
    const fallback = DEPLOY.slice(proof, drain);
    expect(fallback).toContain('$COMPOSE stop caddy');
  });

  it('proves the return to traffic against this exact release', () => {
    // The mirror image: a normal-config reload that exits 0 while players still
    // see the maintenance page, or an old bundle from a stale /srv/www mount,
    // is the same silent failure on the way out.
    const normalReload = at('caddy reload --config /etc/caddy/Caddyfile \\');
    const returnProof = DEPLOY.indexOf('traffic_returned_proven;', normalReload);
    expect(returnProof).toBeGreaterThan(normalReload);
    const body = DEPLOY.slice(at('traffic_returned_proven() {'), at('[ -s infra/maintenance/index.html ]'));
    expect(body).toContain('page.status === 200');
    expect(body).toContain('json?.gitSha === sha');
  });

  it('drains API before counting committed raids and retains the compatible worker until zero', () => {
    // Maintenance rejects NEW requests, but a request already accepted by API
    // can still arm/deploy. Sampling before API finishes shutdown leaves a
    // zero-count race and can hand spent troops to an incompatible worker.
    const maintenance = at('if maintenance_page_proven; then');
    const stopApi = at('$COMPOSE stop api');
    const drain = at('say "draining started live raids');
    const drained = at('[ "$LIVE_DRAIN_OK" = "true" ] || die');
    const stopWorker = at('$COMPOSE stop worker');
    const stopSigner = at('$COMPOSE stop withdrawal-signer');
    const backup = at('say "quiescent pre-migration backup"');
    expect(maintenance).toBeLessThan(stopApi);
    expect(stopApi).toBeLessThan(drain);
    expect(drain).toBeLessThan(drained);
    expect(drained).toBeLessThan(stopWorker);
    expect(stopWorker).toBeLessThan(stopSigner);
    expect(stopSigner).toBeLessThan(backup);
    expect(DEPLOY.split('$COMPOSE stop api')).toHaveLength(2);
  });

  it('counts v2 armed armies without requiring the new column on a pre-0102 database', () => {
    // V2 batch armies spend their commitment before ATTACK starts the clock.
    // Count those alongside every started protocol, but leave never-started
    // v1/legacy rows alone. JSON lookup returns NULL on an old composite row;
    // directly referencing l.armed_at would abort the first M33→M34 deploy.
    const query = DEPLOY.match(/select count\(\*\) from raids r[\s\S]*?;/)?.[0];
    expect(query).toBeDefined();
    const normalized = query!.replaceAll(`'"'"'`, "'").replace(/\s+/g, ' ').trim();
    expect(normalized).toBe(
      "select count(*) from raids r join raid_live_states l on l.raid_id = r.id "
      + "where r.status::text in ('pending_orders', 'resolving') "
      + 'and (l.started_at is not null or (l.command_protocol_version = 2 '
      + "and to_jsonb(l)->>'armed_at' is not null));",
    );
  });

  it('keeps the maintenance config and the page contract deploy.sh proves', () => {
    // The proof greps these exact strings; if the page or the envelope changes,
    // the proof must change with it or every deploy falls back to hard-down.
    const page = readFileSync(path.join(ROOT, 'infra/maintenance/index.html'), 'utf8');
    expect(page).toContain('<title>Pixel Kingdom Wars — Maintenance</title>');
    expect(MAINTENANCE_CADDYFILE).toContain('"code":"MAINTENANCE"');
    expect(MAINTENANCE_CADDYFILE).toMatch(/respond `[^`]*` 503/);
    expect(MAINTENANCE_CADDYFILE).toContain('error 503');
  });

  it('pins the caddy image so a recreation cannot silently upgrade the edge', () => {
    // A floating tag turns the K-071 remedy (force-recreate caddy) into an
    // unreviewed upgrade of the TLS terminator in front of a live game.
    expect(COMPOSE).toMatch(/image: caddy:\d+\.\d+\.\d+-alpine/);
    expect(COMPOSE).not.toContain('image: caddy:2-alpine');
  });

  it.each(['absent', 'present', 'dangling'])('selects safe startup mode with an %s persistent marker', (state) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'caddy-start-'));
    try {
      const marker = path.join(dir, 'shardkeep-maintenance');
      if (state === 'present') writeFileSync(marker, 'approved-release');
      if (state === 'dangling') symlinkSync(path.join(dir, 'missing'), marker);
      // Only remap the persistent directory; execute the actual wrapper with a
      // recording caddy binary so this test never starts a server or binds ports.
      writeFileSync(path.join(dir, 'caddy'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
      const result = spawnSync('sh', ['-c', START.replaceAll('/config/', `${dir}/`)], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual([
        'run', '--config', state === 'absent' ? '/etc/caddy/Caddyfile' : '/etc/caddy/Caddyfile.maintenance', '--adapter', 'caddyfile',
      ]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists maintenance before writers drain and preserves every release gate before staged success', () => {
    expect(COMPOSE).toContain("command: ['sh', '/etc/caddy/start.sh']");
    expect(COMPOSE).toContain('./caddy-start.sh:/etc/caddy/start.sh:ro');
    expect(COMPOSE).toContain('caddyconfig:/config');
    const persist = at('mv -f "$marker" /config/shardkeep-maintenance');
    const failedPersist = at('could not persist maintenance marker');
    expect(persist).toBeLessThan(failedPersist);
    expect(failedPersist).toBeLessThan(at('$COMPOSE stop api'));
    expect(DEPLOY.slice(persist, failedPersist)).toContain('$COMPOSE stop caddy');
    const terminal = at('if [ "$KEEP_MAINTENANCE" = 1 ]; then');
    for (const gate of ['quiescent pre-migration backup', 'running migrations', 'final proof-of-reserves gate',
      'verify_serving_health\n', 'Served same-origin RPC relay genesis verified', 'publishing verified dist']) {
      expect(at(gate)).toBeLessThan(terminal);
    }
    const end = DEPLOY.slice(at('say "starting caddy — verifying durable maintenance"'), at('SIM="$($COMPOSE'));
    const startup = DEPLOY.slice(at('caddy_startup_contract_proven() {'), at('maintenance_page_proven() {'));
    expect(startup).toContain("'{{json .Config.Cmd}}'");
    expect(startup).toContain('sha256sum "$container_path"');
    expect(end).toContain('caddy_startup_contract_proven');
    expect(end.indexOf('maintenance_page_proven')).toBeLessThan(end.indexOf('if [ "$KEEP_MAINTENANCE"'));
    expect(end.indexOf('caddy validate --config /etc/caddy/Caddyfile')).toBeLessThan(end.indexOf('traffic_returned_proven'));
    expect(end.indexOf('traffic_returned_proven')).toBeLessThan(end.indexOf('rm -f /config/shardkeep-maintenance'));
  });

  it.each([
    ['staged', '1', 'ok', 'ok', 'ok'],
    ['normal', '0', 'ok', 'ok', 'ok'],
    ['failed public proof', '0', 'ok', 'fail', 'ok'],
    ['failed maintenance proof', '1', 'fail', 'ok', 'ok'],
    ['incompatible normal release', '0', 'ok', 'ok', 'fail'],
    ['incompatible staged release', '1', 'ok', 'ok', 'fail'],
  ])('runs the terminal %s path without exposing an unverified restart', (_name, keep, maintenance, publicProof, market) => {
    const terminal = DEPLOY.slice(at('say "starting caddy — verifying durable maintenance"'), at('SIM="$($COMPOSE'));
    const directory = mkdtempSync(path.join(os.tmpdir(), 'deploy-terminal-'));
    mkdirSync(path.join(directory, 'infra/ops'), { recursive: true });
    writeFileSync(path.join(directory, 'infra/ops/assert-item-market-compatible.sh'),
      '#!/bin/sh\necho MARKET_CONTRACT_PROOF >&2\n[ "$MARKET_RESULT" = ok ]\n', { mode: 0o700 });
    const harness = `
set -euo pipefail
COMPOSE=compose; RELEASE_IMAGE=approved; SHORT=approved; SHA=approved; ENV_FILE=fixture
say() { :; }; die() { echo "FAIL: $*"; exit 1; }
compose() {
  echo "COMPOSE $*" >&2
  case "$*" in
    'ps --status running --services') echo caddy;;
    'ps -q caddy') echo container;;
    *sha256sum*) echo 'samehash file';;
  esac
}
docker() { echo '["sh","/etc/caddy/start.sh"]'; }
sha256sum() { echo 'samehash file'; }
caddy_startup_contract_proven() { return 0; }
maintenance_page_proven() { echo MAINTENANCE_PROOF >&2; [ "$MAINTENANCE_RESULT" = ok ]; }
traffic_returned_proven() { echo PUBLIC_PROOF >&2; [ "$PUBLIC_RESULT" = ok ]; }
${terminal}`;
    try {
      const result = spawnSync('bash', ['-c', harness], {
        cwd: directory,
        env: { ...process.env, KEEP_MAINTENANCE: keep, MAINTENANCE_RESULT: maintenance, PUBLIC_RESULT: publicProof, MARKET_RESULT: market }, encoding: 'utf8',
      });
      expect(result.status).toBe(maintenance === 'ok' && publicProof === 'ok' && market === 'ok' ? 0 : 1);
      const cleared = result.stderr.includes('rm -f /config/shardkeep-maintenance');
      expect(cleared).toBe(keep === '0' && maintenance === 'ok' && publicProof === 'ok' && market === 'ok');
      if (keep === '1') expect(result.stderr).not.toContain('PUBLIC_PROOF');
      if (maintenance !== 'ok') expect(result.stderr).toContain('COMPOSE stop caddy');
      if (publicProof !== 'ok') expect(result.stderr).toContain('caddy reload --config /etc/caddy/Caddyfile.maintenance');
      if (market !== 'ok') {
        expect(result.stderr).toContain('MARKET_CONTRACT_PROOF');
        expect(result.stderr).not.toContain('PUBLIC_PROOF');
        expect(result.stderr).not.toContain('caddy reload --config /etc/caddy/Caddyfile');
        expect(result.stdout).not.toContain('staged approved');
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['restarting', 'old command', 'failed recreation'])('proves maintenance startup before drain for %s Caddy', (initial) => {
    const preflight = DEPLOY.slice(at('if ! $COMPOSE ps --status running --services 2>/dev/null'), at('say "entering maintenance'));
    expect(at('mv -f "$marker" /config/shardkeep-maintenance')).toBeLessThan(at('if ! $COMPOSE ps --status running --services 2>/dev/null'));
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
COMPOSE=compose; RELEASE_IMAGE=approved; recreated=0
say() { :; }; die() { exit 1; }
compose() {
  echo "COMPOSE $*" >&2
  case "$*" in
    'ps --status running --services') [ "$INITIAL" = restarting ] || echo caddy;;
    'up -d --no-deps --force-recreate caddy') recreated=1;;
  esac
}
caddy_bind_mounts_fresh() { return 0; }
caddy_startup_contract_proven() { [ "$recreated" = 1 ] && [ "$INITIAL" != 'failed recreation' ]; }
${preflight}
echo WRITERS_MAY_DRAIN >&2
`], { env: { ...process.env, INITIAL: initial }, encoding: 'utf8' });
    expect(result.stderr).toContain('up -d --no-deps --force-recreate caddy');
    expect(result.status).toBe(initial === 'failed recreation' ? 1 : 0);
    expect(result.stderr.includes('WRITERS_MAY_DRAIN')).toBe(initial !== 'failed recreation');
    if (initial === 'failed recreation') expect(result.stderr).toContain('COMPOSE stop caddy');
  });
});
