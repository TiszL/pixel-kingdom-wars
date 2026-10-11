/** Pure release contract for the worker-first multi-base boot sequence.
 *
 * server.ts is a process entrypoint and deliberately executes on import, so a
 * source-level wiring test is the smallest non-DB test that can prove the
 * healing worker starts before the bounded readiness wait and buildApp gate. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const deploy = readFileSync(new URL('../../../infra/deploy.sh', import.meta.url), 'utf8');
const backup = readFileSync(new URL('../../../infra/backup/backup.sh', import.meta.url), 'utf8');

describe('worker-first multi-base startup', () => {
  it('waits one bounded observer SLA after starting workers and before building the app', () => {
    const startsWorkerAt = source.indexOf('await startWorkers(config, db)');
    const checksCoverageAt = source.indexOf('let coverage = await deedObserverCoverage(db)', startsWorkerAt);
    const buildsAppAt = source.indexOf('const app = await buildApp(config, db');

    expect(startsWorkerAt).toBeGreaterThan(-1);
    expect(checksCoverageAt).toBeGreaterThan(startsWorkerAt);
    expect(buildsAppAt).toBeGreaterThan(checksCoverageAt);

    const readinessGate = source.slice(startsWorkerAt, buildsAppAt);
    expect(readinessGate).toContain(
      'Date.now() + BASE_OWNERSHIP.observationHealthFreshnessMs',
    );
    expect(readinessGate).toContain(
      'Math.min(BASE_OWNERSHIP.observationPollMs, remainingMs)',
    );
    expect(readinessGate).toContain('startup ownership sweep timed out');
  });

  it('deploys the observation healer before the strict API when multi-base is enabled', () => {
    const branch = deploy.slice(
      deploy.indexOf('if [ "$MULTI_BASE_ROLLOUT" = "true" ]'),
      deploy.indexOf('else', deploy.indexOf('if [ "$MULTI_BASE_ROLLOUT" = "true" ]')),
    );
    expect(branch.indexOf('start_and_verify_worker')).toBeGreaterThan(-1);
    expect(branch.indexOf('verify_replacement_deed_observer')).toBeGreaterThan(
      branch.indexOf('start_and_verify_worker'),
    );
    expect(branch.indexOf('start_and_verify_api')).toBeGreaterThan(branch.indexOf('start_and_verify_worker'));
    expect(branch).toContain('check_por');
  });

  it('keeps traffic drained through two worker-owned deed generations and final health probes', () => {
    // WHY: a first green worker health response can be backed entirely by the
    // previous worker's observations and fail once they cross the 60s SLA.
    const observerGateAt = deploy.indexOf('verify_replacement_deed_observer()');
    const publishAt = deploy.indexOf('say "publishing verified dist');
    const caddyAt = deploy.indexOf('say "starting caddy');

    expect(observerGateAt).toBeGreaterThan(-1);
    expect(observerGateAt).toBeLessThan(publishAt);
    expect(deploy.slice(observerGateAt, publishAt)).toContain('.State.StartedAt');
    expect(deploy.slice(observerGateAt, publishAt)).toContain('checked_at >=');
    expect(deploy.slice(observerGateAt, publishAt)).toContain('first_ready_at + freshness_ms');
    expect(deploy.slice(observerGateAt, publishAt)).toContain('verify_serving_health');
    expect(publishAt).toBeLessThan(caddyAt);
  });

  it('drains first-live commands without querying a table that legacy production lacks', () => {
    // WHY: production is currently migration 0072. `raid_live_states` first
    // exists in 0074, so an unconditional pre-migration join takes Caddy down
    // and aborts the very cutover that would create the table.
    const detectsProtocolAt = deploy.indexOf("select to_regclass('");
    const legacyBranchAt = deploy.indexOf('legacy raid schema — no started live-command rows exist');
    const liveJoinAt = deploy.indexOf('join raid_live_states l');

    expect(detectsProtocolAt).toBeGreaterThan(-1);
    expect(legacyBranchAt).toBeGreaterThan(detectsProtocolAt);
    expect(liveJoinAt).toBeGreaterThan(legacyBranchAt);
    expect(deploy.slice(detectsProtocolAt, liveJoinAt)).toContain('LIVE_TABLE_EXISTS');
  });

  it('uses the schema-compatible old image before migration and the candidate afterward', () => {
    // WHY: the candidate PoR code reads tables introduced by 0078, and the
    // build retags `latest`. The preflight must never run that new binary
    // against the still-0072 database.
    const preflightAt = deploy.indexOf('check_por "$OLD_RELEASE_IMAGE"');
    const migrationAt = deploy.indexOf('say "running migrations"');
    const postflightAt = deploy.indexOf('check_por "$RELEASE_IMAGE"', migrationAt);

    expect(preflightAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeLessThan(migrationAt);
    expect(postflightAt).toBeGreaterThan(migrationAt);
    expect(deploy).toContain('OLD_RELEASE_IMAGE="$OLD_API_IMAGE"');
  });

  it('keeps the drained migration step non-interactive', () => {
    // WHY: a fresh runtime image has no Corepack package-manager cache. The
    // default pnpm shim prompts on its first download, which otherwise leaves
    // Caddy and both writers stopped indefinitely during an unattended deploy.
    expect(deploy).toContain(
      "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm db:migrate",
    );
  });

  it('creates and retains production database dumps with owner-only permissions', () => {
    // WHY: the archive contains wallet-linked balances and game state. The
    // deployment backup must not inherit a permissive host umask or preserve
    // older world-readable dumps in the same directory.
    const umaskAt = backup.indexOf('umask 077');
    const createsDirectoryAt = backup.indexOf('mkdir -p "$OUT_DIR"');
    const createsTempAt = backup.indexOf('TMP_FILE="$(mktemp');
    const dumpsAt = backup.indexOf('pg_dump -U "$POSTGRES_USER"');
    const securesTempAt = backup.indexOf('chmod 600 "$TMP_FILE"');
    const publishesDumpAt = backup.indexOf('mv -- "$TMP_FILE" "$FINAL_FILE"');
    const securesPublishedAt = backup.indexOf('chmod 600 "$FINAL_FILE" "$CHECKSUM_FILE"');

    expect(umaskAt).toBeGreaterThan(-1);
    expect(umaskAt).toBeLessThan(createsDirectoryAt);
    expect(backup).toContain('chmod 700 "$OUT_DIR"');
    expect(backup).toContain("-name 'shardkeep-*.dump' -o -name 'shardkeep-*.dump.sha256'");
    expect(backup).toContain('-exec chmod 600 {} +');
    expect(backup).toContain('exec 9>"$LOCK_FILE"');
    expect(backup).toContain('flock -n "$LOCK_FD"');
    expect(backup).not.toContain('mkdir "$LOCK_DIR"');
    expect(dumpsAt).toBeGreaterThan(-1);
    expect(securesTempAt).toBeGreaterThan(createsTempAt);
    expect(securesTempAt).toBeLessThan(dumpsAt);
    expect(securesPublishedAt).toBeGreaterThan(publishesDumpAt);
  });
});
