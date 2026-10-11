#!/usr/bin/env bash
# Fail-closed PostgreSQL backup. The post-K-021 target cadence is hourly; the
# audited live devnet host currently invokes it daily. See
# infra/backup/crontab.example and docs/DEPLOYMENT.md.
#
# This targets postgres in docker-compose.prod.yml. The historical Mac origin
# overlay pointed the live API at another database; do not use this script for
# that retired topology.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${SHARDKEEP_ENV_FILE:-$ROOT/infra/.env.prod}"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '%s  ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "environment file is missing: $ENV_FILE"
command -v node >/dev/null 2>&1 || die "node is required for policy signer backup verification"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

OUT_DIR="${BACKUP_DIR:-/var/backups/shardkeep}"
KEEP_LOCAL_HOURS="${BACKUP_KEEP_LOCAL_HOURS:-48}"
NETWORK="${BACKUP_NETWORK:-}"
OFFSITE_REQUIRED="${BACKUP_OFFSITE_REQUIRED:-false}"
OFFSITE_ENCRYPTED="${BACKUP_OFFSITE_ENCRYPTED:-false}"
REMOTE="${BACKUP_RCLONE_REMOTE:-}"
RCLONE_CONFIG="${BACKUP_RCLONE_CONFIG:-}"

case "$OUT_DIR" in /*) ;; *) die "BACKUP_DIR must be an absolute path" ;; esac
[ "$OUT_DIR" != "/" ] || die "BACKUP_DIR must not be the filesystem root"
[[ "$KEEP_LOCAL_HOURS" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_LOCAL_HOURS must be a positive integer"
case "$NETWORK" in
  mainnet|mainnet-beta)
    [ "$OFFSITE_REQUIRED" = "true" ] || die "mainnet requires BACKUP_OFFSITE_REQUIRED=true"
    [ "$OFFSITE_ENCRYPTED" = "true" ] || die "mainnet requires an encrypted rclone crypt remote"
    ;;
  devnet|testnet|local|localnet) ;;
  *) die "BACKUP_NETWORK must be devnet, testnet, local, localnet, mainnet, or mainnet-beta" ;;
esac
case "$OFFSITE_REQUIRED" in true|false) ;; *) die "BACKUP_OFFSITE_REQUIRED must be true or false" ;; esac
case "$OFFSITE_ENCRYPTED" in true|false) ;; *) die "BACKUP_OFFSITE_ENCRYPTED must be true or false" ;; esac

OFFSITE_ENABLED=false
if [ -n "$REMOTE" ] || [ -n "$RCLONE_CONFIG" ]; then
  [ -n "$REMOTE" ] && [ -n "$RCLONE_CONFIG" ] \
    || die "BACKUP_RCLONE_REMOTE and BACKUP_RCLONE_CONFIG must be configured together"
  [ -f "$RCLONE_CONFIG" ] && [ -r "$RCLONE_CONFIG" ] || die "the configured rclone file is not readable"
  if MODE="$(stat -c '%a' "$RCLONE_CONFIG" 2>/dev/null)"; then :; else MODE="$(stat -f '%Lp' "$RCLONE_CONFIG")"; fi
  case "$MODE" in 400|600) ;; *) die "the rclone config must have mode 0400 or 0600" ;; esac
  command -v rclone >/dev/null 2>&1 || die "rclone is required for the configured off-host backup"
  if [ "$OFFSITE_ENCRYPTED" = "true" ]; then
    REMOTE_NAME="${REMOTE%%:*}"
    REMOTE_TYPE="$(rclone config dump --config "$RCLONE_CONFIG" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);process.stdout.write(c[process.argv[1]]?.type||"")})' "$REMOTE_NAME")"
    [ "$REMOTE_TYPE" = "crypt" ] || die "BACKUP_OFFSITE_ENCRYPTED=true requires BACKUP_RCLONE_REMOTE to name an rclone crypt remote"
  fi
  OFFSITE_ENABLED=true
fi
if [ "$OFFSITE_REQUIRED" = "true" ] && [ "$OFFSITE_ENABLED" != "true" ]; then
  die "off-host backups are required; configure BACKUP_RCLONE_REMOTE and BACKUP_RCLONE_CONFIG"
fi

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$ROOT/infra/docker-compose.prod.yml")
if [ -n "${SHARDKEEP_COMPOSE_EXTRA:-}" ]; then COMPOSE+=(-f "$SHARDKEEP_COMPOSE_EXTRA"); fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
find "$OUT_DIR" -maxdepth 1 -type f \
  \( -name 'shardkeep-*.dump' -o -name 'shardkeep-*.dump.sha256' \
     -o -name 'shardkeep-*.signer-state.json' -o -name 'shardkeep-*.signer-state.json.sha256' \) \
  -exec chmod 600 {} +

command -v flock >/dev/null 2>&1 || die "flock is required for exclusive backup locking"
LOCK_FILE="$OUT_DIR/.backup.lock"
LOCK_FD=9
exec 9>"$LOCK_FILE"
flock -n "$LOCK_FD" || die "another backup is running"
# The file intentionally persists. Exclusivity is the kernel lock attached to
# this process-held descriptor, so crashes release it without stale cleanup.

TMP_FILE=""
TMP_CHECKSUM=""
TMP_SIGNER_STATE=""
TMP_SIGNER_CHECKSUM=""
REMOTE_VERIFY_DIR=""
POLICY_VERIFY_DIR=""
WORKER_WAS_RUNNING=false
SIGNER_WAS_RUNNING=false
SERVICES_RESTARTED=false

service_wanted_running() {
  local container state
  container="$("${COMPOSE[@]}" ps -aq "$1" 2>/dev/null | head -n 1)"
  [ -n "$container" ] || return 1
  state="$(docker inspect --format '{{.State.Running}} {{.State.Restarting}}' "$container" 2>/dev/null)"
  case "$state" in true\ *|*\ true) return 0 ;; *) return 1 ;; esac
}

restart_runtime() {
  [ "$SERVICES_RESTARTED" = "false" ] || return 0
  local failed=false
  if [ "$SIGNER_WAS_RUNNING" = "true" ]; then
    if "${COMPOSE[@]}" start withdrawal-signer >/dev/null; then
      signer_ready=false
      for _ in $(seq 1 "${BACKUP_SIGNER_READY_ATTEMPTS:-30}"); do
        if "${COMPOSE[@]}" exec -T withdrawal-signer node -e \
          "fetch('http://127.0.0.1:3003/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
          >/dev/null 2>&1; then signer_ready=true; break; fi
        sleep 1
      done
      [ "$signer_ready" = "true" ] || failed=true
    else
      failed=true
    fi
  fi
  # The worker is the only payout / deed-sync / emission process and it fails
  # closed against an unreachable signer, so a slow signer health check must
  # never leave it stopped: `compose stop` clears its restart policy, and a later
  # cron run cannot tell a script-stopped worker from an operator-stopped one,
  # so nothing would ever start it again (review 2026-08-21). Start it
  # regardless, then still fail loud so the cron log records the slow signer.
  if [ "$WORKER_WAS_RUNNING" = "true" ]; then
    "${COMPOSE[@]}" start worker >/dev/null || failed=true
  fi
  [ "$failed" = "false" ] || return 1
  SERVICES_RESTARTED=true
}
cleanup() {
  status=$?
  set +e
  cleanup_failed=0
  if [ -n "$TMP_FILE" ] && ! rm -f -- "$TMP_FILE"; then cleanup_failed=1; fi
  if [ -n "$TMP_CHECKSUM" ] && ! rm -f -- "$TMP_CHECKSUM"; then cleanup_failed=1; fi
  if [ -n "$TMP_SIGNER_STATE" ] && ! rm -f -- "$TMP_SIGNER_STATE"; then cleanup_failed=1; fi
  if [ -n "$TMP_SIGNER_CHECKSUM" ] && ! rm -f -- "$TMP_SIGNER_CHECKSUM"; then cleanup_failed=1; fi
  if [ -n "$REMOTE_VERIFY_DIR" ] && ! rm -rf -- "$REMOTE_VERIFY_DIR"; then cleanup_failed=1; fi
  if [ -n "$POLICY_VERIFY_DIR" ] && ! rm -rf -- "$POLICY_VERIFY_DIR"; then cleanup_failed=1; fi
  if ! restart_runtime; then cleanup_failed=1; fi
  if [ "$status" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then return 1; fi
  return "$status"
}
trap cleanup EXIT

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_FILE="$OUT_DIR/shardkeep-$STAMP.dump"
FINAL_SIGNER_STATE="$OUT_DIR/shardkeep-$STAMP.signer-state.json"
TMP_FILE="$(mktemp "$OUT_DIR/.shardkeep-$STAMP.XXXXXX.dump")"
TMP_CHECKSUM="$TMP_FILE.sha256"
TMP_SIGNER_STATE="$(mktemp "$OUT_DIR/.shardkeep-$STAMP.XXXXXX.signer-state.json")"
TMP_SIGNER_CHECKSUM="$TMP_SIGNER_STATE.sha256"
chmod 600 "$TMP_FILE"

# The worker is the only signer caller. Stop it fully before the signer, then
# capture the DB followed by an equal-or-newer immutable signer ledger. This is
# the cross-resource consistency boundary that prevents a restored DB row from
# obtaining a second signature after an earlier transfer landed.
if service_wanted_running worker; then WORKER_WAS_RUNNING=true; fi
if service_wanted_running withdrawal-signer; then SIGNER_WAS_RUNNING=true; fi
log "quiescing withdrawal worker for a consistent custody backup"
# Unconditional stops are load-bearing: a restart-policy container can be in
# `restarting` rather than `running` and otherwise wake mid-snapshot.
"${COMPOSE[@]}" stop worker >/dev/null
"${COMPOSE[@]}" stop withdrawal-signer >/dev/null

log "dumping ${POSTGRES_DB:-shardkeep}"
"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc -Z6 "${POSTGRES_DB:-shardkeep}" > "$TMP_FILE"
SIZE="$(wc -c < "$TMP_FILE" | tr -d ' ')"
[ "$SIZE" -gt 5000 ] || die "dump is only $SIZE bytes; refusing to publish or prune backups"
"${COMPOSE[@]}" exec -T postgres pg_restore --list < "$TMP_FILE" >/dev/null

SIGNER_STATE="$ROOT/infra/policy-signer-state/state.json"
[ -f "$SIGNER_STATE" ] && [ ! -L "$SIGNER_STATE" ] || die "policy signer state is missing or not a regular file"
if SIGNER_MODE="$(stat -c '%a' "$SIGNER_STATE" 2>/dev/null)"; then :; else SIGNER_MODE="$(stat -f '%Lp' "$SIGNER_STATE")"; fi
[ "$SIGNER_MODE" = "600" ] || die "policy signer state must have mode 0600"
cp -- "$SIGNER_STATE" "$TMP_SIGNER_STATE"
chmod 600 "$TMP_SIGNER_STATE"
node - "$TMP_SIGNER_STATE" <<'NODE'
const fs = require('node:fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').trimEnd().split('\n');
const header = JSON.parse(lines.shift());
if (header?.version !== 2 || Object.keys(header).length !== 1) throw new Error('policy signer journal header is invalid');
for (const line of lines) JSON.parse(line);
NODE
POLICY_VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shardkeep-policy-verify.XXXXXX")"
chmod 700 "$POLICY_VERIFY_DIR"
cp -- "$TMP_SIGNER_STATE" "$POLICY_VERIFY_DIR/state.json"
chmod 600 "$POLICY_VERIFY_DIR/state.json"
"${COMPOSE[@]}" run --rm --no-deps \
  --user "$(id -u):$(id -g)" \
  -v "$POLICY_VERIFY_DIR:/var/lib/policy-verify:ro" \
  --entrypoint node api --import tsx src/policySignerVerify.ts \
  /var/lib/policy-verify/state.json >/dev/null \
  || die "policy signer journal failed cryptographic/artifact validation"
rm -rf -- "$POLICY_VERIFY_DIR"
POLICY_VERIFY_DIR=""

BASE="$(basename "$FINAL_FILE")"
CHECKSUM_FILE="$FINAL_FILE.sha256"
SIGNER_CHECKSUM_FILE="$FINAL_SIGNER_STATE.sha256"
LOCAL_SHA="$(sha256_file "$TMP_FILE")"
SIGNER_SHA="$(sha256_file "$TMP_SIGNER_STATE")"
printf '%s  %s\n' "$LOCAL_SHA" "$BASE" > "$TMP_CHECKSUM"
printf '%s  %s\n' "$SIGNER_SHA" "$(basename "$FINAL_SIGNER_STATE")" > "$TMP_SIGNER_CHECKSUM"
chmod 600 "$TMP_FILE" "$TMP_CHECKSUM" "$TMP_SIGNER_STATE" "$TMP_SIGNER_CHECKSUM"
# Publish the dump name last. A concurrent restore drill can never discover a
# completed-looking dump before its checksum sidecar exists.
mv -- "$TMP_SIGNER_CHECKSUM" "$SIGNER_CHECKSUM_FILE"
mv -- "$TMP_SIGNER_STATE" "$FINAL_SIGNER_STATE"
mv -- "$TMP_CHECKSUM" "$CHECKSUM_FILE"
mv -- "$TMP_FILE" "$FINAL_FILE"
chmod 600 "$FINAL_FILE" "$CHECKSUM_FILE" "$FINAL_SIGNER_STATE" "$SIGNER_CHECKSUM_FILE"
TMP_FILE=""; TMP_CHECKSUM=""; TMP_SIGNER_STATE=""; TMP_SIGNER_CHECKSUM=""
restart_runtime || die "backup succeeded but signer/worker restart failed"
log "wrote $BASE + matching signer state ($((SIZE / 1024)) KB DB, SHA-256 verified locally)"

if [ "$OFFSITE_ENABLED" = "true" ]; then
  REMOTE_BASE="${REMOTE%/}"
  REMOTE_FILE="$REMOTE_BASE/$BASE"
  REMOTE_CHECKSUM="$REMOTE_FILE.sha256"
  REMOTE_SIGNER_STATE="$REMOTE_BASE/$(basename "$FINAL_SIGNER_STATE")"
  log "copying paired DB + signer-state backup to the configured off-host destination"
  rclone copyto "$FINAL_SIGNER_STATE" "$REMOTE_SIGNER_STATE" --config "$RCLONE_CONFIG" --no-traverse
  rclone copyto "$SIGNER_CHECKSUM_FILE" "$REMOTE_SIGNER_STATE.sha256" --config "$RCLONE_CONFIG" --no-traverse
  rclone copyto "$CHECKSUM_FILE" "$REMOTE_CHECKSUM" --config "$RCLONE_CONFIG" --no-traverse
  # Publish the discoverable .dump object last. A restore drill that sees it can
  # therefore require every same-stamp custody companion.
  rclone copyto "$FINAL_FILE" "$REMOTE_FILE" --config "$RCLONE_CONFIG" --no-traverse

  # Read both objects back. This verifies exact content even when the provider
  # exposes only multipart ETags rather than a SHA-256 metadata hash.
  REMOTE_VERIFY_DIR="$(mktemp -d "$OUT_DIR/.remote-verify.XXXXXX")"
  chmod 700 "$REMOTE_VERIFY_DIR"
  rclone copyto "$REMOTE_FILE" "$REMOTE_VERIFY_DIR/$BASE" --config "$RCLONE_CONFIG" --no-traverse
  rclone copyto "$REMOTE_CHECKSUM" "$REMOTE_VERIFY_DIR/$BASE.sha256" --config "$RCLONE_CONFIG" --no-traverse
  rclone copyto "$REMOTE_SIGNER_STATE" "$REMOTE_VERIFY_DIR/$(basename "$FINAL_SIGNER_STATE")" --config "$RCLONE_CONFIG" --no-traverse
  rclone copyto "$REMOTE_SIGNER_STATE.sha256" "$REMOTE_VERIFY_DIR/$(basename "$SIGNER_CHECKSUM_FILE")" --config "$RCLONE_CONFIG" --no-traverse
  REMOTE_SIZE="$(wc -c < "$REMOTE_VERIFY_DIR/$BASE" | tr -d ' ')"
  REMOTE_SHA="$(sha256_file "$REMOTE_VERIFY_DIR/$BASE")"
  cmp -s -- "$CHECKSUM_FILE" "$REMOTE_VERIFY_DIR/$BASE.sha256" \
    || die "off-host checksum sidecar does not match the local sidecar"
  [ "$REMOTE_SIZE" = "$SIZE" ] || die "off-host backup size mismatch"
  [ "$REMOTE_SHA" = "$LOCAL_SHA" ] || die "off-host backup SHA-256 mismatch"
  cmp -s -- "$FINAL_SIGNER_STATE" "$REMOTE_VERIFY_DIR/$(basename "$FINAL_SIGNER_STATE")" \
    || die "off-host policy signer state does not match the local custody snapshot"
  cmp -s -- "$SIGNER_CHECKSUM_FILE" "$REMOTE_VERIFY_DIR/$(basename "$SIGNER_CHECKSUM_FILE")" \
    || die "off-host policy signer checksum does not match"
  rm -rf -- "$REMOTE_VERIFY_DIR"
  REMOTE_VERIFY_DIR=""
  log "off-host copy read back with matching size and SHA-256"
else
  log "WARNING: off-host backup explicitly optional for $NETWORK; this copy exists only on this host"
fi

# Remote retention is a bucket lifecycle rule. This host never deletes remote
# history, so a compromised server cannot shorten off-host retention.
find "$OUT_DIR" -maxdepth 1 -type f \
  \( -name 'shardkeep-*.dump' -o -name 'shardkeep-*.dump.sha256' \
     -o -name 'shardkeep-*.signer-state.json' -o -name 'shardkeep-*.signer-state.json.sha256' \) \
  -mmin "+$((KEEP_LOCAL_HOURS * 60))" -delete
COUNT="$(find "$OUT_DIR" -maxdepth 1 -type f -name 'shardkeep-*.dump' | wc -l | tr -d ' ')"
log "done ($COUNT local backups retained)"
