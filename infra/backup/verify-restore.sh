#!/usr/bin/env bash
# Restore a verified backup into a uniquely named scratch database and prove
# the money ledger is coherent. With no file argument, production should use
# BACKUP_VERIFY_SOURCE=remote so the drill exercises the off-host copy.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${SHARDKEEP_ENV_FILE:-$ROOT/infra/.env.prod}"
CALLER_EXPECTED_PLAYER_ROWS_SET="${BACKUP_EXPECTED_PLAYER_ROWS+x}"
CALLER_EXPECTED_PLAYER_ROWS="${BACKUP_EXPECTED_PLAYER_ROWS-}"
say() { printf '\n▸ %s\n' "$*"; }
die() { printf '\nERROR: %s\n\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "environment file is missing: $ENV_FILE"
command -v node >/dev/null 2>&1 || die "node is required for policy signer restore verification"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

OUT_DIR="${BACKUP_DIR:-/var/backups/shardkeep}"
NETWORK="${BACKUP_NETWORK:-}"
OFFSITE_REQUIRED="${BACKUP_OFFSITE_REQUIRED:-false}"
OFFSITE_ENCRYPTED="${BACKUP_OFFSITE_ENCRYPTED:-false}"
VERIFY_SOURCE="${BACKUP_VERIFY_SOURCE:-auto}"
if [ "$CALLER_EXPECTED_PLAYER_ROWS_SET" = "x" ]; then
  EXPECTED_PLAYER_ROWS="$CALLER_EXPECTED_PLAYER_ROWS"
else
  EXPECTED_PLAYER_ROWS="${BACKUP_EXPECTED_PLAYER_ROWS:-}"
fi
REMOTE="${BACKUP_RCLONE_REMOTE:-}"
RCLONE_CONFIG="${BACKUP_RCLONE_CONFIG:-}"

case "$NETWORK" in
  mainnet|mainnet-beta)
    [ "$OFFSITE_REQUIRED" = "true" ] || die "mainnet requires BACKUP_OFFSITE_REQUIRED=true"
    [ "$OFFSITE_ENCRYPTED" = "true" ] || die "mainnet requires an encrypted rclone crypt remote"
    ;;
  devnet|testnet|local|localnet) ;;
  *) die "invalid BACKUP_NETWORK" ;;
esac
case "$OFFSITE_REQUIRED" in true|false) ;; *) die "BACKUP_OFFSITE_REQUIRED must be true or false" ;; esac
case "$OFFSITE_ENCRYPTED" in true|false) ;; *) die "BACKUP_OFFSITE_ENCRYPTED must be true or false" ;; esac
case "$VERIFY_SOURCE" in auto|local|remote) ;; *) die "BACKUP_VERIFY_SOURCE must be auto, local, or remote" ;; esac
if { [ "$NETWORK" = "mainnet" ] || [ "$NETWORK" = "mainnet-beta" ]; } && [ "$VERIFY_SOURCE" = "local" ] && [ "$#" -eq 0 ]; then
  die "mainnet's scheduled restore drill must use BACKUP_VERIFY_SOURCE=remote"
fi

OFFSITE_ENABLED=false
if [ -n "$REMOTE" ] || [ -n "$RCLONE_CONFIG" ]; then
  [ -n "$REMOTE" ] && [ -n "$RCLONE_CONFIG" ] \
    || die "BACKUP_RCLONE_REMOTE and BACKUP_RCLONE_CONFIG must be configured together"
  [ -f "$RCLONE_CONFIG" ] && [ -r "$RCLONE_CONFIG" ] || die "the configured rclone file is not readable"
  if MODE="$(stat -c '%a' "$RCLONE_CONFIG" 2>/dev/null)"; then :; else MODE="$(stat -f '%Lp' "$RCLONE_CONFIG")"; fi
  case "$MODE" in 400|600) ;; *) die "the rclone config must have mode 0400 or 0600" ;; esac
  command -v rclone >/dev/null 2>&1 || die "rclone is required for remote restore verification"
  if [ "$OFFSITE_ENCRYPTED" = "true" ]; then
    REMOTE_NAME="${REMOTE%%:*}"
    REMOTE_TYPE="$(rclone config dump --config "$RCLONE_CONFIG" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);process.stdout.write(c[process.argv[1]]?.type||"")})' "$REMOTE_NAME")"
    [ "$REMOTE_TYPE" = "crypt" ] || die "BACKUP_OFFSITE_ENCRYPTED=true requires an rclone crypt remote"
  fi
  OFFSITE_ENABLED=true
fi
if [ "$OFFSITE_REQUIRED" = "true" ] && [ "$OFFSITE_ENABLED" != "true" ]; then
  die "off-host backups are required but rclone is not fully configured"
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/infra/docker-compose.prod.yml")
if [ -n "${SHARDKEEP_COMPOSE_EXTRA:-}" ]; then COMPOSE+=(-f "$SHARDKEEP_COMPOSE_EXTRA"); fi
psql_db() { "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 "$@"; }
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

REMOTE_TMP_DIR=""
POLICY_VERIFY_DIR=""
SCRATCH="shardkeep_restore_$$_${RANDOM}"
SCRATCH_CREATED=false
cleanup() {
  status=$?
  set +e
  cleanup_failed=0
  if [ "$SCRATCH_CREATED" = "true" ]; then
    if ! psql_db -d postgres -c "drop database if exists \"$SCRATCH\" with (force)" >/dev/null 2>&1; then
      printf 'ERROR: could not remove scratch database %s\n' "$SCRATCH" >&2
      cleanup_failed=1
    fi
  fi
  if [ -n "$REMOTE_TMP_DIR" ] && ! rm -rf -- "$REMOTE_TMP_DIR"; then cleanup_failed=1; fi
  if [ -n "$POLICY_VERIFY_DIR" ] && ! rm -rf -- "$POLICY_VERIFY_DIR"; then cleanup_failed=1; fi
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then return 1; fi
  return "$status"
}
trap cleanup EXIT

FILE=""
EXPLICIT_FILE=false
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 1 ] || die "usage: verify-restore.sh [path/to/shardkeep-*.dump]"
  FILE="$1"
  EXPLICIT_FILE=true
  # An explicit-path drill deliberately runs beside a blank recovery database,
  # so it cannot compare the restored dump to that database. Require instead
  # the independently captured, post-drain source census from the production
  # host. Positive + exact is intentional: SHARDKEEP production already has
  # players, and accepting zero would make a schema-only dump look recoverable.
  [[ "$EXPECTED_PLAYER_ROWS" =~ ^[1-9][0-9]*$ ]] \
    || die "an explicit backup path requires BACKUP_EXPECTED_PLAYER_ROWS from the post-drain source census"
else
  if [ "$VERIFY_SOURCE" = "remote" ] || { [ "$VERIFY_SOURCE" = "auto" ] && [ "$OFFSITE_ENABLED" = "true" ]; }; then
    [ "$OFFSITE_ENABLED" = "true" ] || die "remote verification requested but rclone is not configured"
    REMOTE_BASE="${REMOTE%/}"
    LATEST="$(rclone lsf "$REMOTE_BASE" --config "$RCLONE_CONFIG" --files-only --include 'shardkeep-*.dump' \
      | LC_ALL=C sort | tail -n 1)"
    [[ "$LATEST" =~ ^shardkeep-[0-9]{8}T[0-9]{6}Z\.dump$ ]] \
      || die "no canonical backup dump found at the configured off-host destination"
    REMOTE_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shardkeep-restore.XXXXXX")"
    chmod 700 "$REMOTE_TMP_DIR"
    FILE="$REMOTE_TMP_DIR/$LATEST"
    STATE_NAME="${LATEST%.dump}.signer-state.json"
    say "downloading the newest off-host backup for the restore drill"
    rclone copyto "$REMOTE_BASE/$LATEST" "$FILE" --config "$RCLONE_CONFIG" --no-traverse
    rclone copyto "$REMOTE_BASE/$LATEST.sha256" "$FILE.sha256" --config "$RCLONE_CONFIG" --no-traverse
    rclone copyto "$REMOTE_BASE/$STATE_NAME" "$REMOTE_TMP_DIR/$STATE_NAME" --config "$RCLONE_CONFIG" --no-traverse
    rclone copyto "$REMOTE_BASE/$STATE_NAME.sha256" "$REMOTE_TMP_DIR/$STATE_NAME.sha256" --config "$RCLONE_CONFIG" --no-traverse
  else
    FILE="$(find "$OUT_DIR" -maxdepth 1 -type f -name 'shardkeep-*.dump' | LC_ALL=C sort | tail -n 1)"
  fi
fi

[ -n "$FILE" ] && [ -f "$FILE" ] || die "no backup file found"
CHECKSUM_FILE="$FILE.sha256"
[ -f "$CHECKSUM_FILE" ] || die "missing checksum sidecar for $(basename "$FILE")"
[ "$(wc -l < "$CHECKSUM_FILE" | tr -d ' ')" = "1" ] || die "checksum sidecar must contain exactly one line"
read -r EXPECTED_SHA RECORDED_NAME EXTRA < "$CHECKSUM_FILE"
[[ "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || die "checksum sidecar has an invalid SHA-256"
[ "$RECORDED_NAME" = "$(basename "$FILE")" ] || die "checksum sidecar names a different artifact"
[ -z "${EXTRA:-}" ] || die "checksum sidecar contains unexpected fields"
ACTUAL_SHA="$(sha256_file "$FILE")"
EXPECTED_SHA_LOWER="$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')"
[ "$EXPECTED_SHA_LOWER" = "$ACTUAL_SHA" ] || die "backup SHA-256 does not match its checksum sidecar"

SIGNER_STATE="${FILE%.dump}.signer-state.json"
SIGNER_CHECKSUM="$SIGNER_STATE.sha256"
[ -f "$SIGNER_STATE" ] || die "missing same-backup-id policy signer state"
[ -f "$SIGNER_CHECKSUM" ] || die "missing policy signer state checksum"
[ "$(wc -l < "$SIGNER_CHECKSUM" | tr -d ' ')" = "1" ] \
  || die "policy signer checksum must contain exactly one line"
read -r SIGNER_EXPECTED SIGNER_RECORDED SIGNER_EXTRA < "$SIGNER_CHECKSUM"
[[ "$SIGNER_EXPECTED" =~ ^[0-9a-fA-F]{64}$ ]] || die "policy signer checksum is invalid"
[ "$SIGNER_RECORDED" = "$(basename "$SIGNER_STATE")" ] || die "policy signer checksum names another artifact"
[ -z "${SIGNER_EXTRA:-}" ] || die "policy signer checksum contains unexpected fields"
[ "$(printf '%s' "$SIGNER_EXPECTED" | tr 'A-F' 'a-f')" = "$(sha256_file "$SIGNER_STATE")" ] \
  || die "policy signer state SHA-256 mismatch"
node - "$SIGNER_STATE" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trimEnd().split('\n');
const header = JSON.parse(lines.shift());
if (header?.version !== 2 || Object.keys(header).length !== 1) throw new Error('policy signer journal header is invalid');
for (const line of lines) JSON.parse(line);
console.log(`  policy signer artifacts: ${lines.length}`);
NODE
POLICY_VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shardkeep-policy-verify.XXXXXX")"
chmod 700 "$POLICY_VERIFY_DIR"
cp -- "$SIGNER_STATE" "$POLICY_VERIFY_DIR/state.json"
chmod 600 "$POLICY_VERIFY_DIR/state.json"
# `compose --env-file` controls interpolation; it does not replace a service's
# own env_file. Pass these public custody identities explicitly so the selected
# recovery env remains authoritative on a host with no infra/.env.prod.
"${COMPOSE[@]}" run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  -v "$POLICY_VERIFY_DIR:/var/lib/policy-verify:ro" \
  --env "HOT_WALLET_PUBKEY=$HOT_WALLET_PUBKEY" \
  --env "WITHDRAWAL_POLICY_KEEP_MINT=$WITHDRAWAL_POLICY_KEEP_MINT" \
  --entrypoint node api --import tsx src/policySignerVerify.ts \
  /var/lib/policy-verify/state.json >/dev/null \
  || die "restored policy signer journal failed cryptographic/artifact validation"
rm -rf -- "$POLICY_VERIFY_DIR"
POLICY_VERIFY_DIR=""
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$FILE" >/dev/null

say "restoring $(basename "$FILE") into an isolated scratch database"
psql_db -d postgres -c "create database \"$SCRATCH\"" >/dev/null
SCRATCH_CREATED=true
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$SCRATCH" \
  --exit-on-error --single-transaction --no-owner --no-privileges < "$FILE" >/dev/null

say "checking schema and ledger invariants"
TABLES="$(psql_db -tA -d "$SCRATCH" -c "
  select count(*) from (values
    (to_regclass('public.accounts')),
    (to_regclass('public.ledger_transactions')),
    (to_regclass('public.ledger_entries')),
    (to_regclass('public.players')),
    (to_regclass('public.withdrawals'))
  ) required(table_name) where table_name is not null;")"
[ "$TABLES" = "5" ] || die "restored database is missing required application tables"

DRIFT="$(psql_db -tA -d "$SCRATCH" -c "
  select count(*) from (
    select a.id from accounts a
    left join ledger_entries e on e.account_id = a.id
    group by a.id, a.balance
    having a.balance <> coalesce(sum(e.delta), 0)
  ) drifted;")"
NET="$(psql_db -tA -d "$SCRATCH" -c 'select coalesce(sum(delta), 0) from ledger_entries;')"
BAD_TXNS="$(psql_db -tA -d "$SCRATCH" -c '
  select count(distinct malformed.id) from (
    select t.id from ledger_transactions t
    left join ledger_entries e on e.txn_id = t.id
    group by t.id
    having count(e.id) < 2
    union all
    select e.txn_id as id from ledger_entries e
    join accounts a on a.id = e.account_id
    group by e.txn_id, a.currency
    having coalesce(sum(e.delta), 0) <> 0
  ) malformed;')"
ORPHANS="$(psql_db -tA -d "$SCRATCH" -c '
  select count(*) from ledger_entries e left join accounts a on a.id = e.account_id where a.id is null;')"
# Self-describing counts: a players row is created on the
# FIRST sign-in with no land required, so a bare "players" figure reads as
# paying players to a human and gets copied into handoffs that way (M28 said
# "162 players" for 44 land owners). Label the table AND the predicate.
PLAYERS="$(psql_db -tA -d "$SCRATCH" -c 'select count(*) from players;')"
LIVE_PLAYERS=0
LIVE_CONTEXT=''
if [ "$EXPLICIT_FILE" = "true" ]; then
  [ "$PLAYERS" = "$EXPECTED_PLAYER_ROWS" ] \
    || die "restored backup has $PLAYERS player rows; post-drain source census expected $EXPECTED_PLAYER_ROWS"
  LIVE_CONTEXT=" (post-drain source census: $EXPECTED_PLAYER_ROWS)"
else
  # No-argument drills run beside the live database. Keep comparing against it
  # so an empty-but-structurally-valid dump cannot pass. An explicit path is the
  # documented off-host ceremony and uses the independent census above.
  LIVE_PLAYERS="$(psql_db -tA -d "${POSTGRES_DB:-shardkeep}" -c 'select count(*) from players;')"
  LIVE_CONTEXT=" (live: $LIVE_PLAYERS)"
fi
LIVE_DEEDS="$(psql_db -tA -d "$SCRATCH" -c "select count(*) from bases where status = 'active' and land_paid_at is not null;")"
LAND_OWNERS="$(psql_db -tA -d "$SCRATCH" -c "select count(distinct b.owner_wallet) from base_slots bs join bases b on b.id = bs.base_id where bs.active and bs.wallet = b.owner_wallet and b.status = 'active' and b.land_paid_at is not null;")"
ACCOUNTS="$(psql_db -tA -d "$SCRATCH" -c 'select count(*) from accounts;')"
WD="$(psql_db -tA -d "$SCRATCH" -c "select count(*) from withdrawals where status in ('unbonding','processing');")"

[ "$DRIFT" = "0" ] || die "ledger cache drifted in $DRIFT restored accounts"
[ "$NET" = "0" ] || die "restored ledger is not double-entry balanced (net delta $NET)"
[ "$BAD_TXNS" = "0" ] || die "restored ledger contains $BAD_TXNS malformed transactions"
[ "$ORPHANS" = "0" ] || die "restored ledger contains $ORPHANS orphan entries"
if [ "$EXPLICIT_FILE" = "false" ] && [ "$LIVE_PLAYERS" -gt 0 ] && [ "$PLAYERS" -eq 0 ]; then
  die "live has $LIVE_PLAYERS players but the restored backup has none"
fi

printf '  player rows (all sign-ins, incl. free): %s%s\n  live deeds (active paid bases): %s\n  land owners (wallets with an active paid base): %s\n  ledger account rows (several per wallet): %s\n  ledger drift: %s\n  ledger net: %s\n  malformed transactions: %s\n  orphan entries: %s\n  withdrawals in flight: %s\n' \
  "$PLAYERS" "$LIVE_CONTEXT" "$LIVE_DEEDS" "$LAND_OWNERS" "$ACCOUNTS" "$DRIFT" "$NET" "$BAD_TXNS" "$ORPHANS" "$WD"

cat <<EOF

Backup is restorable and its money ledger reconciles.

Before any real restore, keep WITHDRAWALS_ENABLED=false. Restore this exact
same-stamp signer state (never initialize an empty replacement), then reconcile
every on-chain payout and deposit after this recovery point before enabling the
signer/worker. This backup contained $WD withdrawal(s) in
unbonding/processing state; replaying one can double-pay.
EOF
