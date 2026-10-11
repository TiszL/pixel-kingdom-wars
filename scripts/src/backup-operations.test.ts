import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const BACKUP = path.join(ROOT, 'infra/backup/backup.sh');
const RESTORE = path.join(ROOT, 'infra/backup/verify-restore.sh');
const DEVNET = JSON.parse(
  readFileSync(path.join(ROOT, 'infra/devnet.addresses.json'), 'utf8'),
) as { keepMint: string; treasuries: { liquidity: string } };

const fixtures: string[] = [];
afterEach(() => {
  for (const fixtureRoot of fixtures.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function executable(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o700 });
  chmodSync(file, 0o700);
}

function fixture(options: { network?: string; required?: boolean; remote?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'shardkeep-backup-test-'));
  fixtures.push(root);
  const bin = path.join(root, 'bin');
  const backups = path.join(root, 'backups');
  const remoteStore = path.join(root, 'remote');
  const backupScripts = path.join(root, 'infra', 'backup');
  const signerStateDirectory = path.join(root, 'infra', 'policy-signer-state');
  mkdirSync(bin); mkdirSync(backups); mkdirSync(remoteStore);
  mkdirSync(backupScripts, { recursive: true });
  mkdirSync(signerStateDirectory, { recursive: true, mode: 0o700 });
  const backup = path.join(backupScripts, 'backup.sh');
  const restore = path.join(backupScripts, 'verify-restore.sh');
  copyFileSync(BACKUP, backup);
  copyFileSync(RESTORE, restore);
  chmodSync(backup, 0o700);
  chmodSync(restore, 0o700);
  writeFileSync(path.join(signerStateDirectory, 'state.json'), '{"version":2}\n', { mode: 0o600 });
  const rcloneConfig = path.join(root, 'rclone.conf');
  writeFileSync(rcloneConfig, '[fake]\ntype = local\n', { mode: 0o600 });
  const envFile = path.join(root, 'env');
  writeFileSync(envFile, [
    'POSTGRES_USER=shardkeep',
    'POSTGRES_DB=shardkeep',
    `BACKUP_DIR=${backups}`,
    'BACKUP_KEEP_LOCAL_HOURS=48',
    `BACKUP_NETWORK=${options.network ?? 'local'}`,
    `BACKUP_OFFSITE_REQUIRED=${options.required ? 'true' : 'false'}`,
    `BACKUP_VERIFY_SOURCE=${options.remote ? 'remote' : 'local'}`,
    `BACKUP_RCLONE_REMOTE=${options.remote ? 'fake:bucket' : ''}`,
    `BACKUP_RCLONE_CONFIG=${options.remote ? rcloneConfig : ''}`,
    `HOT_WALLET_PUBKEY=${DEVNET.treasuries.liquidity}`,
    `WITHDRAWAL_POLICY_KEEP_MINT=${DEVNET.keepMint}`,
    // Explicit off-host restores compare the dump to a census independently
    // captured from the stopped production source, never the blank recovery DB.
    'BACKUP_EXPECTED_PLAYER_ROWS=1',
  ].join('\n') + '\n');

  executable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case " $* " in
  *" ps -aq worker "*|*" ps -aq withdrawal-signer "*)
    [ "\${FAKE_RUNTIME_RUNNING:-0}" != 1 ] || echo fakecontainer
    ;;
  *" inspect "*)
    echo "true false"
    ;;
  *" exec -T withdrawal-signer node -e "*)
    [ "\${FAKE_SIGNER_HEALTH_FAIL:-0}" != 1 ]
    ;;
  *" stop worker "*|*" stop withdrawal-signer "*|*" start worker "*|*" start withdrawal-signer "*)
    ;;
  *" src/policySignerVerify.ts "*)
    ;;
  *" pg_dump "*)
    [ "\${FAKE_DUMP_FAIL:-0}" != 1 ] || exit 41
    head -c 6001 /dev/zero | tr '\\000' x
    ;;
  *" pg_restore --list "*)
    cat >/dev/null
    [ "\${FAKE_CATALOG_FAIL:-0}" != 1 ] || exit 42
    ;;
  *" pg_restore "*)
    cat >/dev/null
    [ "\${FAKE_RESTORE_FAIL:-0}" != 1 ] || exit 43
    ;;
  *" psql "*)
    case "$*" in
      *"to_regclass"*) echo 5 ;;
      *"having a.balance"*) echo 0 ;;
      *"group by e.txn_id, a.currency"*) echo "\${FAKE_BAD_CURRENCY_TXNS:-\${FAKE_BAD_TXNS:-0}}" ;;
      *"from ledger_transactions"*) echo "\${FAKE_BAD_TXNS:-0}" ;;
      *"coalesce(sum(delta)"*) echo 0 ;;
      *"left join accounts"*) echo 0 ;;
      *"count(*) from players"*)
        if [[ "$*" == *" -d shardkeep_restore_"* ]]; then
          echo "\${FAKE_RESTORED_PLAYERS:-1}"
        else
          [ "\${FAKE_LIVE_PLAYERS_TABLE_MISSING:-0}" != 1 ] || exit 44
          echo "\${FAKE_LIVE_PLAYERS:-1}"
        fi
        ;;
      *"count(*) from accounts"*) echo 2 ;;
      *"count(*) from withdrawals"*) echo 0 ;;
    esac
    ;;
  *) exit 90 ;;
esac
`);

  executable(path.join(bin, 'rclone'), `#!/usr/bin/env bash
set -euo pipefail
map_remote() { printf '%s/%s' "$FAKE_RCLONE_STORE" "\${1#*:}"; }
case "$1" in
  copyto)
    src="$2"; dst="$3"
    if [[ "$src" == *:* ]]; then
      cp "$(map_remote "$src")" "$dst"
    else
      target="$(map_remote "$dst")"
      mkdir -p "$(dirname "$target")"
      cp "$src" "$target"
      if [ "\${FAKE_RCLONE_CORRUPT:-0}" = 1 ] && [[ "$dst" == *.dump ]]; then printf z >> "$target"; fi
    fi
    ;;
  lsf)
    dir="$(map_remote "$2")"
    for file in "$dir"/shardkeep-*.dump; do [ -f "$file" ] && basename "$file"; done
    ;;
  *) exit 91 ;;
esac
`);

  executable(path.join(bin, 'flock'), `#!/usr/bin/env bash
set -euo pipefail
[ "\${FAKE_FLOCK_FAIL:-0}" != 1 ]
`);

  const dockerLog = path.join(root, 'docker.log');
  writeFileSync(dockerLog, '');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    SHARDKEEP_ENV_FILE: envFile,
    FAKE_RCLONE_STORE: remoteStore,
    FAKE_DOCKER_LOG: dockerLog,
  };
  return { root, backups, remoteStore, dockerLog, envFile, env, backup, restore };
}

function run(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync('bash', [script, ...args], { cwd: ROOT, env, encoding: 'utf8' });
}

function writeDump(dir: string): string {
  const file = path.join(dir, 'shardkeep-20260818T010203Z.dump');
  const bytes = Buffer.alloc(6001, 120);
  writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
  const signerState = `${file.slice(0, -'.dump'.length)}.signer-state.json`;
  const signerBytes = Buffer.from('{"version":2}\n');
  writeFileSync(signerState, signerBytes, { mode: 0o600 });
  const signerSha = createHash('sha256').update(signerBytes).digest('hex');
  writeFileSync(
    `${signerState}.sha256`,
    `${signerSha}  ${path.basename(signerState)}\n`,
    { mode: 0o600 },
  );
  return file;
}

describe('backup operations', () => {
  it('refuses a mainnet local-only backup before contacting PostgreSQL', () => {
    const fx = fixture({ network: 'mainnet-beta', required: false });
    const result = run(fx.backup, fx.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('mainnet requires BACKUP_OFFSITE_REQUIRED=true');
    expect(readFileSync(fx.dockerLog, 'utf8')).toBe('');
  });

  it('restarts the worker even when the signer health wait times out, and still fails loud', () => {
    // WHY: backup.sh stops worker+signer for a consistent custody snapshot. The
    // worker is the only payout/deed/emission process and `compose stop` clears
    // its restart policy; a later cron run sees a stopped worker as "not
    // wanted running" and never starts it. A slow signer boot must therefore
    // never skip `start worker` — but the run must still exit non-zero so the
    // cron log records the degraded restart (review 2026-08-21).
    const fx = fixture();
    const result = run(fx.backup, {
      ...fx.env, FAKE_RUNTIME_RUNNING: '1', FAKE_SIGNER_HEALTH_FAIL: '1',
      BACKUP_SIGNER_READY_ATTEMPTS: '1',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/signer\/worker restart failed/);
    const log = readFileSync(fx.dockerLog, 'utf8');
    expect(log).toMatch(/ stop worker/);
    expect(log).toMatch(/ start withdrawal-signer/);
    expect(log).toMatch(/ start worker/);
    // The successful dump is still published: the restart failure must not
    // make the operator believe there is no backup.
    expect(readdirSync(fx.backups).filter((f) => f.endsWith('.dump'))).toHaveLength(1);
  });

  it('fails loud on pg_dump failure and publishes no completed artifact', () => {
    const fx = fixture();
    const result = run(fx.backup, { ...fx.env, FAKE_DUMP_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(readdirSync(fx.backups).filter((name) => name.endsWith('.dump'))).toEqual([]);
  });

  it('fails before PostgreSQL when the process-lifetime lock cannot be acquired', () => {
    const fx = fixture();
    const result = run(fx.backup, { ...fx.env, FAKE_FLOCK_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('another backup is running');
    expect(readFileSync(fx.dockerLog, 'utf8')).toBe('');
  });

  it('rejects a non-restorable dump catalog before publishing it', () => {
    const fx = fixture();
    const result = run(fx.backup, { ...fx.env, FAKE_CATALOG_FAIL: '1' });
    expect(result.status).not.toBe(0);
    expect(readdirSync(fx.backups).filter((name) => name.endsWith('.dump'))).toEqual([]);
  });

  it('round-trips the off-host object and restores that remote copy', () => {
    const fx = fixture({ network: 'devnet', required: true, remote: true });
    const backedUp = run(fx.backup, fx.env);
    expect(backedUp.status, backedUp.stderr).toBe(0);
    expect(backedUp.stdout).toContain('matching size and SHA-256');
    const localNames = readdirSync(fx.backups);
    expect(localNames.filter((name) => name.endsWith('.dump'))).toHaveLength(1);
    expect(localNames.filter((name) => name.endsWith('.signer-state.json'))).toHaveLength(1);
    expect(localNames.filter((name) => name.endsWith('.signer-state.json.sha256'))).toHaveLength(1);
    const remoteNames = readdirSync(path.join(fx.remoteStore, 'bucket'));
    expect(remoteNames.filter((name) => name.endsWith('.dump'))).toHaveLength(1);
    expect(remoteNames.filter((name) => name.endsWith('.signer-state.json'))).toHaveLength(1);
    const restored = run(fx.restore, fx.env);
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('Backup is restorable and its money ledger reconciles');
  });

  it('exposes only a dedicated signer-journal scratch directory to verification containers', () => {
    // WHY: the verifier needs one public-artifact journal, not every retained
    // database dump sitting beside it in the backup directory.
    const fx = fixture();
    const backedUp = run(fx.backup, fx.env);
    expect(backedUp.status, backedUp.stderr).toBe(0);
    const file = path.join(
      fx.backups,
      readdirSync(fx.backups).find((name) => name.endsWith('.dump'))!,
    );
    const restored = run(fx.restore, fx.env, [file]);
    expect(restored.status, restored.stderr).toBe(0);
    const verifierCalls = readFileSync(fx.dockerLog, 'utf8').split('\n')
      .filter((line) => line.includes('/var/lib/policy-verify:ro'));
    expect(verifierCalls).toHaveLength(2);
    for (const call of verifierCalls) {
      expect(call).not.toContain(`${fx.backups}:/var/lib/policy-verify:ro`);
      expect(call).toContain('/shardkeep-policy-verify.');
      expect(call).toContain('/var/lib/policy-verify/state.json');
    }
  });

  it('injects custody identity from the selected recovery env into the verifier container', () => {
    // WHY: Compose's --env-file supplies interpolation, but the api service has
    // a fixed .env.prod env_file. An off-host recovery.env must remain the
    // authoritative source for the two public values that authenticate the
    // same-stamp signer journal.
    const fx = fixture();
    const file = writeDump(fx.backups);
    const restored = run(fx.restore, fx.env, [file]);
    expect(restored.status, restored.stderr).toBe(0);
    const verifier = readFileSync(fx.dockerLog, 'utf8').split('\n')
      .find((line) => line.includes('src/policySignerVerify.ts'));
    expect(verifier).toContain(`--env HOT_WALLET_PUBKEY=${DEVNET.treasuries.liquidity}`);
    expect(verifier).toContain(`--env WITHDRAWAL_POLICY_KEEP_MINT=${DEVNET.keepMint}`);
  });

  it('does not treat a fresh off-host Postgres as the live comparison database', () => {
    // WHY: the explicit-path release gate runs against an isolated recovery
    // stack whose base database may have no application schema yet. The dump's
    // scratch restore is authoritative; querying `players` in that empty base
    // turns a valid recovery proof into a false failure.
    const fx = fixture();
    const file = writeDump(fx.backups);
    const restored = run(
      fx.restore,
      { ...fx.env, FAKE_LIVE_PLAYERS_TABLE_MISSING: '1' },
      [file],
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('post-drain source census: 1');
    const log = readFileSync(fx.dockerLog, 'utf8');
    expect(log).not.toContain(' -d shardkeep -c select count(*) from players;');
  });

  it('prefers the caller census over a stale value in the recovery env file', () => {
    // WHY: the documented release gate supplies the exact post-drain census on
    // the command line. A long-lived recovery.env must not override that one-
    // shot trust input when the file is sourced.
    const fx = fixture(); // fixture env deliberately says 1
    const file = writeDump(fx.backups);
    const restored = run(
      fx.restore,
      { ...fx.env, BACKUP_EXPECTED_PLAYER_ROWS: '2', FAKE_RESTORED_PLAYERS: '2' },
      [file],
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('post-drain source census: 2');
  });

  it('rejects an empty explicit artifact against the independent source census', () => {
    // WHY: schema and ledger checks are vacuously green on an empty database.
    // The migration release gate must not bless a schema-only dump simply
    // because its isolated recovery stack has no live database to compare.
    const fx = fixture();
    const file = writeDump(fx.backups);
    const restored = run(
      fx.restore,
      { ...fx.env, FAKE_RESTORED_PLAYERS: '0' },
      [file],
    );
    expect(restored.status).not.toBe(0);
    expect(restored.stderr).toContain(
      'restored backup has 0 player rows; post-drain source census expected 1',
    );
  });

  it('fails closed when an explicit artifact has no independent source census', () => {
    // WHY: without a trusted source count, an isolated verifier cannot
    // distinguish the intended production dump from an empty valid archive.
    const fx = fixture();
    const file = writeDump(fx.backups);
    writeFileSync(
      fx.envFile,
      readFileSync(fx.envFile, 'utf8').replace('BACKUP_EXPECTED_PLAYER_ROWS=1\n', ''),
    );
    const restored = run(fx.restore, fx.env, [file]);
    expect(restored.status).not.toBe(0);
    expect(restored.stderr).toContain(
      'explicit backup path requires BACKUP_EXPECTED_PLAYER_ROWS',
    );
    expect(readFileSync(fx.dockerLog, 'utf8')).toBe('');
  });

  it('retains the live-player comparison for no-argument scheduled drills', () => {
    // WHY: only explicit off-host artifacts skip the comparison. A scheduled
    // same-host drill must still fail if its live database cannot be queried.
    const fx = fixture();
    writeDump(fx.backups);
    const restored = run(
      fx.restore,
      { ...fx.env, FAKE_LIVE_PLAYERS_TABLE_MISSING: '1' },
    );
    expect(restored.status).not.toBe(0);
    expect(readFileSync(fx.dockerLog, 'utf8'))
      .toContain(' -d shardkeep -c select count(*) from players;');
  });

  it('fails when the bytes read back from off-host storage differ', () => {
    const fx = fixture({ network: 'devnet', required: true, remote: true });
    const result = run(fx.backup, { ...fx.env, FAKE_RCLONE_CORRUPT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/off-host backup (size|SHA-256) mismatch/);
  });

  it('rejects a bad checksum before creating a scratch database', () => {
    const fx = fixture();
    const file = writeDump(fx.backups);
    writeFileSync(`${file}.sha256`, `${'0'.repeat(64)}  ${path.basename(file)}\n`);
    const result = run(fx.restore, fx.env, [file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('backup SHA-256 does not match');
    expect(readFileSync(fx.dockerLog, 'utf8')).toBe('');
  });

  it('rejects a dump without its same-backup-id policy signer journal', () => {
    // WHY: restoring database entitlement without the signer history can
    // authorize a second signature for a transfer that already landed.
    const fx = fixture();
    const file = writeDump(fx.backups);
    const signerState = `${file.slice(0, -'.dump'.length)}.signer-state.json`;
    rmSync(signerState);
    rmSync(`${signerState}.sha256`);
    const result = run(fx.restore, fx.env, [file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing same-backup-id policy signer state');
    expect(readFileSync(fx.dockerLog, 'utf8')).toBe('');
  });

  it('propagates pg_restore failure instead of accepting a partial restore', () => {
    const fx = fixture();
    const file = writeDump(fx.backups);
    const result = run(fx.restore, { ...fx.env, FAKE_RESTORE_FAIL: '1' }, [file]);
    expect(result.status).not.toBe(0);
    expect(readFileSync(fx.dockerLog, 'utf8')).toContain('pg_restore -U shardkeep');
  });

  it('rejects a restored ledger with a malformed transaction', () => {
    const fx = fixture();
    const file = writeDump(fx.backups);
    const result = run(fx.restore, { ...fx.env, FAKE_BAD_TXNS: '1' }, [file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('1 malformed transactions');
  });

  it('rejects cross-currency cancellation inside one ledger transaction', () => {
    // WHY: +KEEP and -SHARDS can sum to zero numerically while moving value
    // between currencies. Reconciliation must balance each txn+currency pair.
    const fx = fixture();
    const file = writeDump(fx.backups);
    const result = run(fx.restore, { ...fx.env, FAKE_BAD_CURRENCY_TXNS: '1' }, [file]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('1 malformed transactions');
    expect(readFileSync(fx.dockerLog, 'utf8')).toContain('group by e.txn_id, a.currency');
  });
});
