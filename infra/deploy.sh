#!/usr/bin/env bash
#
# Deploy SHARDKEEP to this box: web dist + api image + migrations + verify.
#
#     ./infra/deploy.sh
#
# Build matching artifacts → custody preflight → backup/drain → migrate/rewrap →
# verify API → verify worker → publish/return traffic. Verification is the point:
# it is the difference between "the deploy command exited 0" and "the thing I
# intended to deploy is the thing now answering requests".
#
# SIM_VERSION ordering (docs/DEPLOYMENT.md §5) is satisfied INSIDE this script:
# Caddy is drained while the matching web dist and api/worker are changed, then
# traffic returns only after both server processes verify the release sha/health.
# A release that moves SIM_VERSION therefore never exposes a mismatched pair.
#
# Disk hygiene (K-082): the build is refused up front when the box is short of
# space, and ONLY after a publicly verified release are release images beyond
# the rollback window and stale BuildKit cache removed. Housekeeping can never
# fail a deploy that already succeeded. Skip it for one run with:
#
#     DEPLOY_SKIP_PRUNE=1 ./infra/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="infra/.env.prod"
COMPOSE="docker compose --env-file $ENV_FILE -f infra/docker-compose.prod.yml"
# Where Caddy serves the web from (bind-mounted read-only in
# docker-compose.prod.yml). A SEPARATE dir from apps/web/dist so a build that
# dies halfway can never leave the live site half-empty; rsync publishes it
# only after the build and its tripwire pass. Covered by the `dist/` gitignore.
WEB_ROOT="infra/dist"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m  deploy: %s\033[0m\n\n' "$*" >&2; exit 1; }

# A staged rollout still runs every artifact, custody and serving gate, but
# deliberately leaves the public origin on durable maintenance afterward.
KEEP_MAINTENANCE="${KEEP_MAINTENANCE:-0}"
case "$KEEP_MAINTENANCE" in 0|1) ;; *) die 'KEEP_MAINTENANCE must be 0 or 1.' ;; esac

# --- disk hygiene (K-082) -----------------------------------------------------
# Every run builds a ~2 GB shardkeep-api:<sha> image and leaves its BuildKit
# cache. Nothing ever removed either: 86 releases put the 75 GB root disk at 91 % on
# 2026-09-04, and 37 images + 34.6 GB of cache filled it on 2026-09-18, where
# the deploy died at the proof-of-reserves preflight with ENOSPC. Postgres
# shares that disk, so a full disk is a database incident, not only a failed
# build.
#
# Release images kept after a verified deploy, INCLUDING the live one: the
# running release, the release it replaced, and the newest other builds up to
# this many in total (both manual prunes kept four). The replaced release is
# kept by identity, not by age: it is the only other image PROVEN to serve
# production, so `docker compose ... up -d api` with
# API_IMAGE=shardkeep-api:<previous-sha> (docs/DEPLOYMENT.md rollback) stays
# immediate. The remaining slots go by build time, and a candidate that built
# but failed a later gate holds one of them like any other build.
KEEP_RELEASE_IMAGES=4
# Cache records no build has touched for this long are dropped. Housekeeping
# runs right after this release's build, so every layer that build reused (base
# image, apt, pnpm install) was touched minutes ago and survives: the next build
# stays warm. What ages out is the per-release source/atlas layers of earlier
# deploys. An age bound is understood by every BuildKit-era Docker; the byte
# bounds (keep-storage / reserved-space) were renamed across releases.
BUILD_CACHE_KEEP_WINDOW=24h
# One deploy was measured at ~4 % of the 75 GB disk (~3 GB: image + cache), and
# it also writes the web dist, a retained web generation and the pre-migration
# dump. 8 GB is that with better than 2x margin, so a box below it stops HERE,
# before anything is built, drained or migrated.
MIN_FREE_GB_BEFORE_BUILD=8
DISK_WARN_PERCENT=80
# Must match the repository of RELEASE_IMAGE below. Only <repository>:<git sha>
# tags are ever removed — never :latest, never another project's images.
RELEASE_REPOSITORY="shardkeep-api"
DEPLOY_SKIP_PRUNE="${DEPLOY_SKIP_PRUNE:-0}"
case "$DEPLOY_SKIP_PRUNE" in 0|1) ;; *) die 'DEPLOY_SKIP_PRUNE must be 0 or 1.' ;; esac

is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; }

docker_data_root() {
  local dir
  dir="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then dir=/; fi
  printf '%s\n' "$dir"
}

# "<free GB, rounded down> <used %>" for the filesystem holding $1.
disk_usage_of() {
  df -Pk "$1" 2>/dev/null \
    | awk 'NR == 2 { sub(/%$/, "", $5); printf "%d %d\n", $4 / 1048576, $5 }'
}

disk_space_preflight() {
  local path free_gb used_pct
  for path in "$(docker_data_root)" "$ROOT"; do
    read -r free_gb used_pct <<EOF
$(disk_usage_of "$path")
EOF
    is_uint "$free_gb" && is_uint "$used_pct" \
      || die "could not measure free disk space at $path; refusing to build blind. Nothing was changed."
    printf '  %s: %s GB free (%s %% used)\n' "$path" "$free_gb" "$used_pct"
    [ "$free_gb" -ge "$MIN_FREE_GB_BEFORE_BUILD" ] || die "only $free_gb GB free at $path; a deploy needs $MIN_FREE_GB_BEFORE_BUILD GB.
  Nothing was built, drained or migrated. Free space, then rerun:
    docker builder prune -af
    docker image ls $RELEASE_REPOSITORY
    docker image rm $RELEASE_REPOSITORY:<old-sha> [...]   (unforced; keep the running release + the three before it)
    df -h $path
  Player data lives in Docker volumes: never run a system-wide prune and never pass a volume flag."
  done
}

# stdin: one image per line, "<created RFC 3339>\t<image id>\t<tag,tag,...>".
# $1 keep count including the live image, $2 live image id, $3 image ids of
# every container on the box, whitespace-separated, $4 id of the release this
# deploy replaced (may be empty). stdout: removable tags.
# Newest first by BUILD time, never by name: a sha sorts randomly. The replaced
# release is kept wherever it sorts and takes one of the slots, so three failed
# candidates built after it cannot push out the only proven rollback.
select_release_tags_to_remove() {
  LC_ALL=C sort -r | awk -F '\t' -v keep="$1" -v live="$2" -v in_use="$3" \
    -v previous="${4:-}" -v repo="$RELEASE_REPOSITORY" '
    BEGIN {
      n = split(in_use, ids, " ")
      for (i = 1; i <= n; i++) used[ids[i]] = 1
      spare = keep - 1
    }
    {
      list = ""
      m = split($3, tags, ",")
      for (i = 1; i <= m; i++) {
        if (tags[i] ~ ("^" repo ":[0-9a-f]+$") && length(tags[i]) - length(repo) > 7) {
          list = list tags[i] "\n"
        }
      }
      if (list == "" || $2 == live) next
      if ($2 == previous) { spare--; next }
      image[++rows] = $2
      release[rows] = list
    }
    END {
      for (r = 1; r <= rows; r++) {
        if (spare > 0) { spare--; continue }
        if (image[r] in used) continue
        printf "%s", release[r]
      }
    }'
}

prune_old_release_images() {
  say "removing release images beyond the last $KEEP_RELEASE_IMAGES"
  local live_container live_id previous_id containers in_use="" ids listing doomed tag failed=0
  live_container="$($COMPOSE ps -q api 2>/dev/null | head -n 1)"
  [ -n "$live_container" ] || { echo "  live api container not found; no image was removed."; return 1; }
  live_id="$(docker container inspect --format '{{.Image}}' "$live_container" 2>/dev/null)"
  [[ "$live_id" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || { echo "  live image id could not be resolved; no image was removed."; return 1; }
  # Captured before the build; empty on a first boot. A value that is not the
  # id of a listed image matches no row: the plain newest-first window applies.
  previous_id="${OLD_RELEASE_IMAGE_ID:-}"
  # Running AND stopped, every compose project: an image any container still
  # names is never untagged, whatever its age.
  containers="$(docker ps --all --quiet --no-trunc)" \
    || { echo "  could not list containers; no image was removed."; return 1; }
  if [ -n "$containers" ]; then
    # shellcheck disable=SC2086 # container ids are bare hex words
    in_use="$(docker container inspect --format '{{.Image}}' $containers | tr '\n' ' ')" \
      || { echo "  could not resolve container images; no image was removed."; return 1; }
  fi
  ids="$(docker image ls --quiet --no-trunc "$RELEASE_REPOSITORY" | sort -u)" \
    || { echo "  could not list $RELEASE_REPOSITORY images; no image was removed."; return 1; }
  [ -n "$ids" ] || { echo "  no $RELEASE_REPOSITORY images found; nothing to remove."; return 0; }
  # `range`, not `join`: Docker 27's inspect template sees RepoTags as untyped
  # JSON and `join` refuses it. The trailing comma is harmless to the selector.
  # shellcheck disable=SC2086 # image ids are bare sha256:<hex> words
  listing="$(docker image inspect \
    --format '{{.Created}}{{"\t"}}{{.Id}}{{"\t"}}{{range .RepoTags}}{{.}},{{end}}' $ids)" \
    || { echo "  could not inspect $RELEASE_REPOSITORY images; no image was removed."; return 1; }
  case "$listing" in
    *"$live_id"*) ;;
    *) echo "  the live image is not a listed $RELEASE_REPOSITORY image; no image was removed."; return 1 ;;
  esac
  doomed="$(printf '%s\n' "$listing" \
    | select_release_tags_to_remove "$KEEP_RELEASE_IMAGES" "$live_id" "$in_use" "$previous_id")" \
    || { echo "  could not select removable release tags; no image was removed."; return 1; }
  [ -n "$doomed" ] || { echo "  nothing beyond the rollback window."; return 0; }
  # By tag and unforced: Docker itself refuses an image a container still uses.
  while IFS= read -r tag; do
    if docker image rm "$tag" >/dev/null; then
      echo "  removed $tag"
    else
      echo "  could not remove $tag; left in place."
      failed=1
    fi
  done <<EOF
$doomed
EOF
  return "$failed"
}

prune_build_cache() {
  say "trimming BuildKit cache unused for $BUILD_CACHE_KEEP_WINDOW"
  local out
  out="$(docker builder prune --force --filter "until=$BUILD_CACHE_KEEP_WINDOW" 2>&1)" \
    || { printf '%s\n' "$out" | tail -n 3; return 1; }
  printf '  %s\n' "$(printf '%s\n' "$out" | tail -n 1)"
}

report_disk_usage() {
  local path free_gb used_pct
  path="$(docker_data_root)"
  read -r free_gb used_pct <<EOF
$(disk_usage_of "$path")
EOF
  is_uint "$free_gb" && is_uint "$used_pct" \
    || { echo "  could not measure disk usage at $path."; return 1; }
  printf '  disk after deploy: %s %% used, %s GB free (%s)\n' "$used_pct" "$free_gb" "$path"
  if [ "$used_pct" -gt "$DISK_WARN_PERCENT" ]; then
    printf '\n\033[33m  WARNING — DISK IS %s %% FULL (over %s %%). The next deploy may be refused.\033[0m\n' \
      "$used_pct" "$DISK_WARN_PERCENT"
    printf '  Postgres shares this disk. See what grew:  docker system df ; df -h\n\n'
  fi
}

# Runs ONLY after the release is publicly verified. Every step reports and
# returns; nothing in here may call die.
post_deploy_housekeeping() {
  local clean=0
  if [ "$DEPLOY_SKIP_PRUNE" = 1 ]; then
    say "DEPLOY_SKIP_PRUNE=1 — old release images and the build cache were left in place"
  else
    prune_old_release_images || clean=1
    prune_build_cache || clean=1
  fi
  report_disk_usage || clean=1
  return "$clean"
}
# --- end disk hygiene ---------------------------------------------------------

# --- public release record (M47 §5) -------------------------------------------
# The public changelog (pixelkingdomwars.com/changelog) is written HERE, by the
# ordinary deploy, from the release-notes/ fragments present at $SHA
# (release-notes/README.md). It runs ONLY after the release is publicly verified
# and the maintenance marker is cleared, in its own subshell: like housekeeping it
# can never fail or undo a deploy that already succeeded, so nothing in here may
# call die. The host builds the JSON with node and pipes it into the NEW api
# container's recorder, which stamps the row with that image's own sha/version/
# SIM; no fragment text ever passes through this shell. A release without a new
# fragment is still recorded (one generic line) and warned about loudly.
RELEASE_INDEXNOW_PING="landing/indexnow-ping.mjs"
record_public_release() {
  say "recording $SHORT in the public changelog"
  local result
  if ! result="$(pnpm --filter @shardkeep/scripts run --silent release-notes:collect \
      --sha "$SHA" --root "$ROOT" --env-file "$ROOT/$ENV_FILE" \
    | $COMPOSE exec -T api node --import tsx src/releases/cli.ts record --manifest - --recorded-by deploy.sh)"; then
    echo "  the public changelog was NOT updated (details above). Once the cause is fixed, rerun from $ROOT:"
    echo "    pnpm --filter @shardkeep/scripts run --silent release-notes:collect --sha $SHA --root $ROOT --env-file $ROOT/$ENV_FILE \\"
    echo "      | $COMPOSE exec -T api node --import tsx src/releases/cli.ts record --manifest - --recorded-by deploy.sh"
    return 1
  fi
  printf '  %s\n' "$result"
  case "$result" in
    *'"generic":true'*)
      printf '\n\033[33m  WARNING — %s shipped NO new release-notes fragment: the changelog shows it only as "Stability and maintenance".\033[0m\n' "$SHORT"
      printf '  Every player-visible change ships release-notes/unreleased/<date>-<slug>.md (release-notes/README.md).\n\n' ;;
    *'"deferred":["'*)
      printf '\n\033[33m  NOTE — %s carried more new fragments than one changelog row holds: the ids under "deferred" above stay unclaimed and the next deploy publishes them.\033[0m\n\n' "$SHORT" ;;
  esac
  # Search engines learn about a new changelog entry at once (IndexNow; the ping
  # script and its key file belong to the website). Optional and bounded by the
  # script itself; a failed ping is reported, never fatal.
  case "$result" in
    *'"status":"inserted"'*)
      if [ -f "$RELEASE_INDEXNOW_PING" ]; then
        node "$RELEASE_INDEXNOW_PING" https://pixelkingdomwars.com/changelog \
          || echo "  search-engine ping failed; the changelog itself is updated."
      fi ;;
  esac
  return 0
}
# --- end public release record ------------------------------------------------

# Idempotent and password-silent. In legacy devnet mode this is a documented
# no-op; mainnet-beta fails inside the provisioner unless isolated roles exist.
provision_runtime_roles() {
  $COMPOSE run --rm --no-deps db-roles \
    || die "runtime database-role provisioning failed."
}

[ -f "$ENV_FILE" ] || die "no $ENV_FILE — copy infra/.env.prod.example and fill it in."
command -v pnpm  >/dev/null || die "pnpm is required (corepack enable)."
command -v node  >/dev/null || die "node is required."
command -v rsync >/dev/null || die "rsync is required."

# --- pre-flight: no devnet TEST profile on production -------------------------
# The QA chain lane runs a devnet TEST profile. PKW_DEVNET_TEST_* points the
# economy money paths at the TEST programs (packages/chain/src/devnetTestProfile.ts),
# LEAGUE_SEASON_TEST_POT_ENABLED=true shows and pays a TEST league pot
# (apps/api/src/game/leagueSeason.ts), and DEVNET_SKR_FAUCET_DEEDLESS_OK lets a
# deedless wallet claim faucet SKR (D153.290). Production also runs devnet with
# NODE_ENV=production, so the API refuses only the last one at boot: absence
# from this file is the guard. Refuse before anything is built, drained or
# migrated. compose's env_file reader takes more than KEY=value: it also takes
# 'KEY: value', a bare 'KEY' (passes the deploying shell's value through),
# 'export ...' of each, and a second assignment after a closing quote on the
# same line, even on a '#' line that closes a multi-line quoted value (all
# checked against docker compose v2.29 'config'). So any line that names a TEST
# key is refused, whatever its form; the test-pot flag passes only as an
# explicit empty or false assignment (the example carries it). A line starting
# with '#' is skipped as a comment only when it carries no quote character.
# Prints line numbers and names only, never a value.
DEVNET_TEST_PROFILE_LINES="$(awk -v q="'" '
  BEGIN {
    pot = "^(export[ \t]+)?LEAGUE_SEASON_TEST_POT_ENABLED[ \t]*[=:][ \t]*"
    pot_empty = pot "$"
    pot_false = pot "(false|\"false\"|" q "false" q "|\"\"|" q q ")( +#.*)?[ \t]*$"
  }
  { line = $0; sub(/\r$/, "", line); sub(/^[ \t]+/, "", line) }
  line == "" || (line ~ /^#/ && index(line, "\"") == 0 && index(line, q) == 0) { next }
  { rest = " " line
    while (match(rest, /[^A-Za-z0-9_](PKW_DEVNET_TEST_[A-Za-z0-9_]*|DEVNET_SKR_FAUCET_DEEDLESS_OK|LEAGUE_SEASON_TEST_POT_ENABLED)/)) {
      name = substr(rest, RSTART + 1, RLENGTH - 1)
      next_char = substr(rest, RSTART + RLENGTH, 1)
      rest = substr(rest, RSTART + RLENGTH)
      if (next_char ~ /[A-Za-z0-9_]/) continue
      if (name == "LEAGUE_SEASON_TEST_POT_ENABLED" && (line ~ pot_empty || line ~ pot_false)) continue
      printf "    line %d: %s\n", NR, name
    } }
' "$ENV_FILE")" || die "could not read $ENV_FILE for the devnet TEST profile check. Nothing was changed."
[ -z "$DEVNET_TEST_PROFILE_LINES" ] || die "$ENV_FILE carries the devnet TEST profile:
$DEVNET_TEST_PROFILE_LINES
  These belong to the QA chain lane only and would point production money paths
  at the TEST programs or TEST pots. Remove them in every form (KEY=value,
  KEY: value, a bare KEY, export ...): no PKW_DEVNET_TEST_* line, no
  DEVNET_SKR_FAUCET_DEEDLESS_OK line, LEAGUE_SEASON_TEST_POT_ENABLED unset or
  assigned empty or false), then rerun. Nothing was built, drained or migrated."

# --- pre-flight: required custody/account-security configuration ------------
# This rollout deliberately keeps devnet withdrawals ON. Parse the file without
# sourcing it (EMAIL_FROM may contain shell metacharacters), validate the TOTP
# keyring exactly as the API does, and never print any secret value.
if ! node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function valueOf(name) {
  const matches = lines.filter((line) => line.startsWith(`${name}=`));
  if (matches.length !== 1) throw new Error(`${name} must appear exactly once`);
  let value = matches[0].slice(name.length + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

for (const name of [
  'HOT_WALLET_KEYPAIR_PATH', 'HOT_WALLET_PUBKEY',
  'WITHDRAWAL_SIGNER_MODE', 'WITHDRAWAL_POLICY_CUSTODY_BACKEND',
  'WITHDRAWAL_POLICY_SIGNER_URL',
  'WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE', 'WITHDRAWAL_POLICY_KEEP_MINT',
  'WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP',
  'WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP',
  'WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP',
  'TWOFA_ENCRYPTION_KEYS', 'RESEND_API_KEY', 'EMAIL_FROM',
]) valueOf(name);
const cluster = valueOf('SOLANA_CLUSTER');
if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
  throw new Error('SOLANA_CLUSTER must be devnet or mainnet-beta');
}
if (!['true', 'false'].includes(valueOf('MAIL_DELIVERY_ENABLED'))) {
  throw new Error('MAIL_DELIVERY_ENABLED must be the exact literal true or false');
}
if (!['true', 'false'].includes(valueOf('TOTP_RECOVERY_ENABLED'))) {
  throw new Error('TOTP_RECOVERY_ENABLED must be the exact literal true or false');
}
const pushEnabled = valueOf('PUSH_NOTIFICATIONS_ENABLED');
if (!['true', 'false'].includes(pushEnabled)) {
  throw new Error('PUSH_NOTIFICATIONS_ENABLED must be the exact literal true or false');
}
if (pushEnabled === 'true') {
  // Validate presence before maintenance without ever echoing key material.
  // The API schema repeats this shape check and web-push validates the point.
  const vapidKey = (name, bytes, publicPoint = false) => {
    const raw = valueOf(name);
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error(`${name} is not canonical base64url`);
    const decoded = Buffer.from(raw, 'base64url');
    if (decoded.length !== bytes || decoded.toString('base64url') !== raw
        || (publicPoint && decoded[0] !== 0x04)) {
      throw new Error(`${name} has the wrong VAPID key shape`);
    }
    return decoded;
  };
  const publicKey = vapidKey('VAPID_PUBLIC_KEY', 65, true);
  const privateKey = vapidKey('VAPID_PRIVATE_KEY', 32);
  const ecdh = require('node:crypto').createECDH('prime256v1');
  try { ecdh.setPrivateKey(privateKey); } catch {
    throw new Error('VAPID_PRIVATE_KEY is not a valid P-256 scalar');
  }
  if (!ecdh.getPublicKey().equals(publicKey)) {
    throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not one matching pair');
  }
  const subject = valueOf('VAPID_SUBJECT');
  if (!/^(mailto:.+|https:\/\/.+)$/.test(subject)) {
    throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  }
}
const mineFullEnabled = valueOf('MINE_FULL_NOTIFICATIONS_ENABLED');
if (!['true', 'false'].includes(mineFullEnabled)) {
  throw new Error('MINE_FULL_NOTIFICATIONS_ENABLED must be the exact literal true or false');
}
if (mineFullEnabled === 'true' && pushEnabled !== 'true') {
  throw new Error('MINE_FULL_NOTIFICATIONS_ENABLED=true requires PUSH_NOTIFICATIONS_ENABLED=true');
}
if (!['true', 'false'].includes(valueOf('LIVE_RAID_V2_ENABLED'))) {
  throw new Error('LIVE_RAID_V2_ENABLED must be the exact literal true or false');
}
const withdrawalsEnabled = valueOf('WITHDRAWALS_ENABLED');
if (!['true', 'false'].includes(withdrawalsEnabled)) {
  throw new Error('WITHDRAWALS_ENABLED must be the exact literal true or false');
}
if (cluster === 'devnet' && withdrawalsEnabled !== 'true') {
  throw new Error('WITHDRAWALS_ENABLED must remain true for the current devnet rollout');
}
if (valueOf('WITHDRAWAL_SIGNER_MODE') !== 'remote') {
  throw new Error('production compose requires WITHDRAWAL_SIGNER_MODE=remote');
}
const policyMint = valueOf('WITHDRAWAL_POLICY_KEEP_MINT');
const registryFile = `infra/${cluster === 'devnet' ? 'devnet' : 'mainnet'}.addresses.json`;
const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
if (registry.keepMint !== policyMint) {
  throw new Error(`WITHDRAWAL_POLICY_KEEP_MINT does not match ${registryFile}`);
}
const limits = [
  'WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP',
  'WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP',
  'WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP',
].map((name) => valueOf(name));
if (!limits.every((value) => /^[1-9][0-9]*$/.test(value))) {
  throw new Error('withdrawal policy limits must be positive decimal KEEP amounts');
}
const [transferLimit, walletLimit, aggregateLimit] = limits.map(BigInt);
if (transferLimit > walletLimit || walletLimit > aggregateLimit) {
  throw new Error('withdrawal policy limits must satisfy transfer <= wallet <= aggregate');
}
const coverageOverride = lines
  .filter((line) => line.startsWith('PAYOUT_COVERAGE_OVERRIDE='));
if (coverageOverride.length > 1) {
  throw new Error('PAYOUT_COVERAGE_OVERRIDE must appear at most once');
}
let coverageOverrideValue = coverageOverride[0]
  ?.slice('PAYOUT_COVERAGE_OVERRIDE='.length).trim() || '';
if ((coverageOverrideValue.startsWith('"') && coverageOverrideValue.endsWith('"'))
  || (coverageOverrideValue.startsWith("'") && coverageOverrideValue.endsWith("'"))) {
  coverageOverrideValue = coverageOverrideValue.slice(1, -1);
}
if (cluster === 'mainnet-beta' && coverageOverrideValue === 'true') {
  throw new Error('PAYOUT_COVERAGE_OVERRIDE=true is forbidden on mainnet-beta');
}
const custodyBackend = valueOf('WITHDRAWAL_POLICY_CUSTODY_BACKEND');
if (custodyBackend !== 'file') {
  throw new Error(
    'WITHDRAWAL_POLICY_CUSTODY_BACKEND supports only file; no HSM or enclave backend is implemented',
  );
}
if (cluster === 'mainnet-beta') {
  throw new Error(
    'mainnet-beta forbids file-backed withdrawal custody; no reviewed HSM or enclave backend is implemented',
  );
}

const seen = new Set();
const entries = valueOf('TWOFA_ENCRYPTION_KEYS').split(',');
if (entries.length === 0 || !entries.every((entry) => {
  const colon = entry.indexOf(':');
  const id = entry.slice(0, colon);
  const encoded = entry.slice(colon + 1);
  if (colon < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || seen.has(id)
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  seen.add(id);
  return Buffer.from(encoded, 'base64').length === 32;
})) throw new Error('TWOFA_ENCRYPTION_KEYS has invalid key-id/base64-32-byte-key syntax');

console.log(`configuration syntax verified (${entries.length} TOTP keyring entr${entries.length === 1 ? 'y' : 'ies'})`);
NODE
then
  die "production custody/account-security configuration is invalid (details above)."
fi

# Runtime never initializes these: losing the state and silently starting from
# zero would reset both rolling circuit breakers. A missing/corrupt/insecure
# file therefore blocks deploy before maintenance begins.
if ! node - "$ENV_FILE" <<'NODE'
const fs = require('node:fs');
const envFile = process.argv[2];
const envLines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
const optionalDecimal = (name, fallback) => {
  const matches = envLines.filter((line) => line.startsWith(`${name}=`));
  if (matches.length > 1) throw new Error(`${name} must appear at most once`);
  let value = matches[0]?.slice(name.length + 1).trim() || fallback;
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive decimal UID/GID`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
};
const signerUid = optionalDecimal('WITHDRAWAL_POLICY_SIGNER_UID', '1000');
const signerGid = optionalDecimal('WITHDRAWAL_POLICY_SIGNER_GID', '1000');
const stateDirectory = fs.lstatSync('infra/policy-signer-state');
if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink()
    || (stateDirectory.mode & 0o077) !== 0) {
  throw new Error('policy signer state directory permissions must be 0700');
}
if (stateDirectory.uid !== signerUid || stateDirectory.gid !== signerGid) {
  throw new Error(`policy signer state directory must be owned by ${signerUid}:${signerGid}`);
}
for (const [file, label] of [
  ['infra/keys/admin.keypair.json', 'admin keypair'],
  ['infra/keys/deed-ops.keypair.json', 'deed-ops keypair'],
  ['infra/keys/hot-wallet.keypair.json', 'hot-wallet keypair'],
  ['infra/keys/withdrawal-policy-signer.token', 'policy signer token'],
  ['infra/policy-signer-state/state.json', 'policy signer state'],
]) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600`);
  if (stat.uid !== signerUid || stat.gid !== signerGid) {
    throw new Error(`${label} must be owned by ${signerUid}:${signerGid}`);
  }
}
// DEVNET PLAYTEST ONLY: when the in-game faucet is on, the worker mounts its
// treasury key. The compose bind mount would otherwise create a DIRECTORY at
// that path on a box where devnet-faucet:init never ran, so require the regular
// file up front (the worker itself also degrades gracefully — see jobs.ts).
const flagOf = (name) => {
  const matches = envLines.filter((line) => line.startsWith(`${name}=`));
  let value = matches[matches.length - 1]?.slice(name.length + 1).trim() ?? '';
  if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  return value;
};
if (flagOf('DEVNET_FAUCET_ENABLED') === 'true') {
  const file = 'infra/keys/devnet-faucet.keypair.json';
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    throw new Error(`${file} is missing — run: pnpm --filter @shardkeep/api devnet-faucet:init (then fund the printed address), or set DEVNET_FAUCET_ENABLED=false`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('devnet faucet keypair must be a regular file (remove a stray directory created by an earlier compose run)');
  if ((stat.mode & 0o077) !== 0) throw new Error('devnet faucet keypair permissions must be 0600');
  if (stat.uid !== signerUid || stat.gid !== signerGid) {
    throw new Error(`devnet faucet keypair must be owned by ${signerUid}:${signerGid}`);
  }
}
// DEVNET ONLY (D153.275): the in-app SKR faucet. The worker mounts its dedicated
// authority key read-only at /run/secrets/devnet-skr-faucet.json. A missing,
// misnamed or unreadable key does not fail the worker: it logs one warning and
// starts no faucet, while the api keeps accepting claims nobody pays. So the
// path must be that mount, and the host file must be ready before maintenance
// begins. compose's env_file reader delivers a variable from more than a plain
// KEY=value line (the devnet TEST profile pre-flight above lists the forms):
// 'KEY: value', a bare 'KEY', 'export ...', leading whitespace, and a second
// assignment after a closing quote on the same line, even on a '#' line that
// closes a multi-line quoted value. So, like that pre-flight, every line naming
// the variable after any character that cannot be part of a name counts, and a
// line starting with '#' is skipped as a comment only when it has no quote
// character. Each counted line must be exactly the plain form, so the value
// read here is the value compose hands the worker.
const linesNaming = (name) => {
  const named = new RegExp(`(?:^|[^A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
  return envLines.filter((line) => {
    const start = line.replace(/^[ \t]+/, '');
    if (start.startsWith('#') && !/["']/.test(start)) return false;
    return named.test(line);
  });
};
const skrFlag = linesNaming('DEVNET_SKR_FAUCET_ENABLED');
if (skrFlag.length > 1 || (skrFlag.length === 1 && !/^DEVNET_SKR_FAUCET_ENABLED=(?:true|false)$/.test(skrFlag[0]))) {
  throw new Error('DEVNET_SKR_FAUCET_ENABLED must appear at most once, as exactly DEVNET_SKR_FAUCET_ENABLED=true or =false');
}
if (skrFlag[0] === 'DEVNET_SKR_FAUCET_ENABLED=true') {
  const skrPath = linesNaming('DEVNET_SKR_FAUCET_KEYPAIR_PATH');
  if (skrPath.length !== 1 || skrPath[0] !== 'DEVNET_SKR_FAUCET_KEYPAIR_PATH=/run/secrets/devnet-skr-faucet.json') {
    throw new Error('DEVNET_SKR_FAUCET_KEYPAIR_PATH must appear once, as exactly DEVNET_SKR_FAUCET_KEYPAIR_PATH=/run/secrets/devnet-skr-faucet.json (the read-only worker mount in infra/docker-compose.prod.yml)');
  }
  const file = 'infra/keys/devnet-skr-faucet.keypair.json';
  let stat;
  try { stat = fs.lstatSync(file); } catch {
    throw new Error(`${file} is missing — copy the SKR faucet keypair there (docs/deploy/SKR-FAUCET-WORKER-KEY.md), or remove the DEVNET_SKR_FAUCET_* group`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('devnet SKR faucet keypair must be a regular file (remove a stray directory created by an earlier compose run)');
  // Exactly 0600, what the owner doc's chmod sets. The worker opens the key as its
  // owner, read-only: without the owner-read bit (0000, 0200) it gets EACCES and
  // silently starts no faucet, and a group/other bit exposes the key.
  if ((stat.mode & 0o7777) !== 0o600) throw new Error('devnet SKR faucet keypair permissions must be 0600');
  if (stat.uid !== signerUid || stat.gid !== signerGid) {
    throw new Error(`devnet SKR faucet keypair must be owned by ${signerUid}:${signerGid}`);
  }
}
const token = fs.readFileSync('infra/keys/withdrawal-policy-signer.token', 'utf8').trim();
if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('policy signer token is malformed');
const text = fs.readFileSync('infra/policy-signer-state/state.json', 'utf8');
if (!text.endsWith('\n')) throw new Error('policy signer journal has a partial trailing entry');
const lines = text.slice(0, -1).split('\n');
const header = JSON.parse(lines.shift());
if (header?.version !== 2 || Object.keys(header).length !== 1) throw new Error('policy signer journal header is invalid');
for (const line of lines) JSON.parse(line);
console.log(`policy signer secret/state files verified (${lines.length} durable signed artifact(s))`);
NODE
then
  die "policy signer secret/state preflight failed. Initialize state only for a genuinely new signer; never reset a used state."
fi

# Multi-base readiness is healed by the signer-owning worker. Read this one
# non-secret flag without sourcing the env file so rollout order can put that
# healer ahead of the strict public API gate when the feature is active.
MULTI_BASE_ROLLOUT="$(sed -n 's/^MULTI_BASE_ENABLED=//p' "$ENV_FILE")"
case "$MULTI_BASE_ROLLOUT" in
  '') MULTI_BASE_ROLLOUT='false' ;;
  true|false) ;;
  *) die "MULTI_BASE_ENABLED must appear at most once as the exact literal true/false." ;;
esac

# The public origin, read the same way, so the maintenance page can be proven
# from the player's side (below) instead of trusting `caddy reload`'s exit code.
API_DOMAIN="$(sed -n 's/^API_DOMAIN=//p' "$ENV_FILE")"
API_DOMAIN="${API_DOMAIN%\"}"; API_DOMAIN="${API_DOMAIN#\"}"
case "$API_DOMAIN" in
  ''|*[[:space:]]*|*'/'*) die "API_DOMAIN must appear exactly once in $ENV_FILE as a bare hostname." ;;
esac

# M45 §3: Caddy reverse-proxies /native/releases/* to R2_PUBLIC_BASE_URL and
# refuses to START on an upstream URL with any path, even a trailing slash the
# API itself tolerates. Refuse here, before caddy is recreated or maintenance
# begins, rather than at the final validate with the origin already dark.
R2_PUBLIC_BASE_URL_CHECK="$(sed -n 's/^R2_PUBLIC_BASE_URL=//p' "$ENV_FILE")"
R2_PUBLIC_BASE_URL_CHECK="${R2_PUBLIC_BASE_URL_CHECK%\"}"; R2_PUBLIC_BASE_URL_CHECK="${R2_PUBLIC_BASE_URL_CHECK#\"}"
# Empty is allowed: compose then defaults it to https://invalid.invalid (APK 502 only).
R2_PUBLIC_BASE_URL_OK=0
case "$R2_PUBLIC_BASE_URL_CHECK" in
  https://*/*|https://*[?#]*|*[[:space:]]*) ;;
  ''|https://?*) R2_PUBLIC_BASE_URL_OK=1 ;;
esac
[ "$R2_PUBLIC_BASE_URL_OK" = 1 ] \
  || die "R2_PUBLIC_BASE_URL must appear at most once in $ENV_FILE as https://host with no path or trailing slash."

# --- pre-flight: the installed store build keeps working (M45 D1) ------------
# The dApp Store's LIVE build is code 32 (0.6.6, published 28 Sep 2026): owner's
# screenshot of publish.solanamobile.com/dapp/gg.pixelkingdomwars.twa/releases,
# 2026-10-10, where 0.5.8 / code 25 and everything below are Deprecated. Every
# build from code 26 on carries the M45 in-app updater; code 25 has none. The API
# only echoes these values from $ENV_FILE, so three facts about installed builds
# are refused here, before anything is built, drained or migrated, and
# native_capabilities_proven repeats them on the new api container before
# traffic returns:
#  1. A build compiles ONE SIM and compares it by strict equality (capabilities,
#     raids, content packs). Codes 25-32 compile SIM 17; code 33 is the first
#     SIM-18 build. A SIM-18 tree therefore ships only with
#     NATIVE_MIN_VERSION_CODE >= 33, so every SIM-17 build is told to update
#     instead of failing each fight and order on a server it cannot play
#     (owner D1, 2026-10-10, G6 Path A: docs/deploy/G6-PATH-A.md). No flag
#     overrides it.
#  2. A build stops ALL orders once the floor is above its own code. A floor
#     above the store's live code needs DEPLOY_ALLOW_FLOOR_RAISE=1.
#  3. Code 25, the newest build that sends no X-PKW-Renderer-Contract, is served
#     NATIVE_CONTENT_MANIFEST_URL_LEGACY (else the main URL). It refuses any pack
#     above renderer contract 14 and any pack on a SIM other than its own 17, so
#     that manifest stays a SIM-17 pack whatever SIM this tree compiles: a SIM-18
#     legacy manifest keeps no SIM-17 build playing.
#   DEPLOY_ALLOW_FLOOR_RAISE=1   owner decision only: a floor above the store's live
#                                code. Installed code 32 must then take the mandatory
#                                update before it can order (D1, 2026-10-10: floor 33
#                                with SIM 18, until code 33 is live on the store and
#                                STORE_NATIVE_VERSION_CODE follows it).
#   DEPLOY_SKIP_CONTENT_PROBE=1  BREAK-GLASS ONLY (the content host itself is down
#                                while an unrelated fix must ship): skips fetching
#                                the manifests; the in-container check still runs.
#                                It is NOT the way to rerun after a failed gate: a
#                                stopped caddy or the maintenance page defers the
#                                fetch to the in-container gate by itself.
# The dApp Store's live version code (owner screenshot 2026-10-10: 0.6.6 / code 32,
# 28 Sep 2026). Move it only when the store publishes a newer build.
STORE_NATIVE_VERSION_CODE=32
# Code 25 (0.5.8) is the newest build without a renderer-contract header and
# without an updater; it compiles SIM 17 and pins content generation 794a074d.
LEGACY_NATIVE_VERSION_CODE=25
LEGACY_NATIVE_SIM_VERSION=17
TREE_SIM_VERSION="$(sed -n 's/^export const SIM_VERSION = \([0-9][0-9]*\);.*$/\1/p' packages/sim/src/version.ts)"
case "$TREE_SIM_VERSION" in
  ''|*[!0-9]*) die "could not read SIM_VERSION from packages/sim/src/version.ts." ;;
esac
# Rule 1: the first Android version code that compiles each SIM a tree may carry.
case "$TREE_SIM_VERSION" in
  17) NATIVE_SIM_FIRST_CODE=0 ;;  # codes 25-32 compile SIM 17 (no floor recorded: production's 24 predates this gate)
  18) NATIVE_SIM_FIRST_CODE=33 ;; # code 33 is the first SIM-18 build (owner D1, 2026-10-10)
  *) die "this tree compiles SIM $TREE_SIM_VERSION, and infra/deploy.sh records no first Android version code for it.
  Every installed build compares SIM by strict equality, so the floor that keeps older
  builds from ordering cannot be checked. Record the first code that compiles SIM
  $TREE_SIM_VERSION (an owner decision, like D1 for SIM 18) before deploying. Nothing was changed." ;;
esac
NATIVE_REALM_KIT_CONTRACT="$(sed -n 's/^export const NATIVE_REALM_KIT_RENDERER_CONTRACT = \([0-9][0-9]*\);.*$/\1/p' apps/api/src/native/contracts.ts)"
case "$NATIVE_REALM_KIT_CONTRACT" in
  ''|*[!0-9]*) die "could not read NATIVE_REALM_KIT_RENDERER_CONTRACT from apps/api/src/native/contracts.ts." ;;
esac
# Installed code 25 refuses any pack at or above the realm-kit contract; derive the
# cap from the tree so it cannot drift if that contract ever moves (K-184).
LEGACY_NATIVE_MAX_RENDERER_CONTRACT=$((NATIVE_REALM_KIT_CONTRACT - 1))
DEPLOY_ALLOW_FLOOR_RAISE="${DEPLOY_ALLOW_FLOOR_RAISE:-0}"
case "$DEPLOY_ALLOW_FLOOR_RAISE" in 0|1) ;; *) die 'DEPLOY_ALLOW_FLOOR_RAISE must be 0 or 1.' ;; esac
DEPLOY_SKIP_CONTENT_PROBE="${DEPLOY_SKIP_CONTENT_PROBE:-0}"
case "$DEPLOY_SKIP_CONTENT_PROBE" in 0|1) ;; *) die 'DEPLOY_SKIP_CONTENT_PROBE must be 0 or 1.' ;; esac
# One non-secret value, read like R2_PUBLIC_BASE_URL above: never by sourcing.
# A duplicated line comes back multi-line and fails every check below.
env_value() {
  local value
  value="$(sed -n "s/^$1=//p" "$ENV_FILE")"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}
NATIVE_FLOOR="$(env_value NATIVE_MIN_VERSION_CODE)"
case "$NATIVE_FLOOR" in
  '') NATIVE_FLOOR=0 ;; # unset or empty: the API advertises 0
  *[!0-9]*|??????????*) die "NATIVE_MIN_VERSION_CODE must appear at most once in $ENV_FILE as a decimal version code." ;;
esac
NATIVE_FLOOR=$((10#$NATIVE_FLOOR))
if [ "$NATIVE_FLOOR" -lt "$NATIVE_SIM_FIRST_CODE" ]; then
  die "this tree compiles SIM $TREE_SIM_VERSION, but NATIVE_MIN_VERSION_CODE=$NATIVE_FLOOR still admits builds below code $NATIVE_SIM_FIRST_CODE.
  Code $NATIVE_SIM_FIRST_CODE is the first Android build on SIM $TREE_SIM_VERSION; every build below it compares an
  older SIM by strict equality, so it would keep ordering against a server it cannot
  fight on. Set NATIVE_MIN_VERSION_CODE=$NATIVE_SIM_FIRST_CODE in $ENV_FILE (owner D1, 2026-10-10;
  docs/deploy/G6-PATH-A.md). No flag overrides this, and a SIM-$TREE_SIM_VERSION legacy content
  manifest does not make an older build compatible. Nothing was changed."
fi
NATIVE_FLOOR_LIMIT="$STORE_NATIVE_VERSION_CODE"
if [ "$NATIVE_FLOOR" -gt "$STORE_NATIVE_VERSION_CODE" ]; then
  [ "$DEPLOY_ALLOW_FLOOR_RAISE" = 1 ] || die "NATIVE_MIN_VERSION_CODE=$NATIVE_FLOOR is above $STORE_NATIVE_VERSION_CODE, the dApp Store's live build.
  Every installed build below $NATIVE_FLOOR stops ALL orders once this deploy lands:
  installed code $STORE_NATIVE_VERSION_CODE must take the mandatory update before it can order. The floor
  rises above the store's live code only by explicit owner decision (D1, 2026-10-10:
  floor 33 with SIM 18), with the code-$NATIVE_FLOOR stable row published mandatory right
  after the deploy (docs/deploy/G6-PATH-A.md). Nothing was changed. With that
  decision, rerun with DEPLOY_ALLOW_FLOOR_RAISE=1."
  say "DEPLOY_ALLOW_FLOOR_RAISE=1 — native floor $NATIVE_FLOOR is above store code $STORE_NATIVE_VERSION_CODE: installed code $STORE_NATIVE_VERSION_CODE must take the mandatory update before it can order"
  NATIVE_FLOOR_LIMIT="$NATIVE_FLOOR"
fi
NATIVE_CONTENT_MAIN="$(env_value NATIVE_CONTENT_MANIFEST_URL)"
NATIVE_CONTENT_LEGACY="$(env_value NATIVE_CONTENT_MANIFEST_URL_LEGACY)"
for NATIVE_CONTENT_NAME in NATIVE_CONTENT_MANIFEST_URL NATIVE_CONTENT_MANIFEST_URL_LEGACY; do
  case "$(env_value "$NATIVE_CONTENT_NAME")" in
    *[[:space:]]*) die "$NATIVE_CONTENT_NAME must appear at most once in $ENV_FILE as one https URL." ;;
    ''|https://?*) ;;
    *) die "$NATIVE_CONTENT_NAME must appear at most once in $ENV_FILE as one https URL." ;;
  esac
done
# What the API serves every renderer below contract 15, code 25 included (routes.ts).
NATIVE_CONTENT_SERVED_LEGACY="${NATIVE_CONTENT_LEGACY:-$NATIVE_CONTENT_MAIN}"
if [ "$DEPLOY_SKIP_CONTENT_PROBE" = 1 ]; then
  say "DEPLOY_SKIP_CONTENT_PROBE=1 — BREAK-GLASS: native content manifests were NOT fetched"
elif [ -n "$NATIVE_CONTENT_SERVED_LEGACY" ]; then
  # The manifests are served by the public origin. A previous run that died at a
  # late gate leaves caddy stopped or the maintenance page up (every path outside
  # /api/* answers 503 there), and the rerun of this script is what restores
  # traffic, so it must not die here: the in-container gate re-checks what the new
  # api serves before traffic returns.
  # (Written as a substitution on purpose: scripts/src/deploy-maintenance-proof.test.ts
  # anchors on the later `if ! $COMPOSE ps --status running` form.)
  if [ -z "$($COMPOSE ps --status running --services 2>/dev/null | grep -x caddy || true)" ]; then
    say "caddy is not running (a previous run left traffic stopped): manifest contents are checked by the in-container gate instead"
  elif ! node - "$NATIVE_CONTENT_SERVED_LEGACY" "$NATIVE_CONTENT_MAIN" "$TREE_SIM_VERSION" \
    "$LEGACY_NATIVE_MAX_RENDERER_CONTRACT" "$LEGACY_NATIVE_VERSION_CODE" "$API_DOMAIN" "$LEGACY_NATIVE_SIM_VERSION" <<'NODE'
const [legacyUrl, mainUrl, sim, maxContract, legacyCode, apiDomain, legacySim] = process.argv.slice(2);
class Deferred extends Error {}
async function maintenancePageUp() {
  try {
    const response = await fetch(`https://${apiDomain}/api/version`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => null);
    return response.status === 503 && body?.error?.code === 'MAINTENANCE';
  } catch { return false; }
}
async function manifest(role, url) {
  let response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(10_000) }); }
  catch (error) { throw new Error(`${role} content manifest ${url} could not be fetched (${error.message})`); }
  if (response.status === 503 && await maintenancePageUp()) {
    throw new Deferred('the public origin serves the maintenance page (a previous run left it up): manifest contents are checked by the in-container gate instead');
  }
  if (response.status !== 200) throw new Error(`${role} content manifest ${url} returned HTTP ${response.status}, not 200`);
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`${role} content manifest ${url} is not a JSON object`);
  return body;
}
(async () => {
  const role = `code-${legacyCode}`;
  const legacy = await manifest(role, legacyUrl);
  const contract = legacy.rendererContractVersion;
  if (contract !== undefined && !(Number.isInteger(contract) && contract <= Number(maxContract))) {
    throw new Error(`${role} content manifest ${legacyUrl} has rendererContractVersion ${JSON.stringify(contract)}; installed code ${legacyCode} refuses any pack above ${maxContract}`);
  }
  // Code 25 refuses a pack on any SIM but its own, whatever SIM this tree compiles:
  // a SIM-18 legacy manifest would only cost it its base view, never let it fight.
  if (legacy.simVersion !== Number(legacySim)) {
    throw new Error(`${role} content manifest ${legacyUrl} has simVersion ${JSON.stringify(legacy.simVersion)}, but installed code ${legacyCode} compiles SIM_VERSION ${legacySim} and requires strict equality (this tree compiles SIM ${sim})`);
  }
  if (mainUrl && mainUrl !== legacyUrl) await manifest('main', mainUrl);
  console.log(`native content manifests verified (code ${legacyCode}: SIM ${legacySim}, renderer contract ${contract ?? 'unset'}; tree SIM ${sim})`);
})().catch((error) => {
  if (error instanceof Deferred) { console.log(error.message); process.exit(0); }
  console.error(error.message); process.exit(1);
});
NODE
  then
    die "a native content manifest cannot serve installed code $LEGACY_NATIVE_VERSION_CODE (details above). Nothing was changed."
  fi
fi

# A deploy must be reproducible from a commit. If the tree is dirty, the sha
# stamped into the image is a lie, and the lie is only discovered later when
# /version points at a commit that never contained the running code.
if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty. The image is tagged with the git sha, so an
  uncommitted change would ship under a sha that does not contain it.
  Commit or stash first."
fi

SHA="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
VERSION="$(node -p "require('./package.json').version")"
# A failed later gate may leave this SHA's verified static snapshot in place.
# Reuse its original timestamp before rebuilding so an unchanged retry produces
# the same immutable bytes; changed config/art still fails retention validation.
if ! BUILT_AT="$(node infra/retain-web-assets.mjs --build-time "$WEB_ROOT" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"; then
  die "could not verify the retained build timestamp; public release is unchanged."
fi

# Capture the exact currently-running release BEFORE `docker build` retags
# `shardkeep-api:latest`. The pre-migration PoR implementation must come from
# the binary that understands the old schema; the candidate's liability query
# legitimately names tables/enums created later in this same release. First
# boot has no old containers and skips the non-empty-database preflight.
OLD_API_CONTAINER="$($COMPOSE ps -q api 2>/dev/null | head -n 1 || true)"
OLD_WORKER_CONTAINER="$($COMPOSE ps -q worker 2>/dev/null | head -n 1 || true)"
OLD_API_IMAGE=""
OLD_WORKER_IMAGE=""
[ -z "$OLD_API_CONTAINER" ] || OLD_API_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$OLD_API_CONTAINER")"
[ -z "$OLD_WORKER_CONTAINER" ] || OLD_WORKER_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$OLD_WORKER_CONTAINER")"
if [ -n "$OLD_API_IMAGE" ] || [ -n "$OLD_WORKER_IMAGE" ]; then
  [ -n "$OLD_API_IMAGE" ] && [ "$OLD_API_IMAGE" = "$OLD_WORKER_IMAGE" ] \
    || die "the running api/worker are not one matching release; refusing a migration deploy."
fi
OLD_RELEASE_IMAGE="$OLD_API_IMAGE"
# The same release as an immutable image id, for post-deploy retention (K-082).
# By then the build has re-pointed :latest and compose has recreated this
# container, so neither a tag nor the container can name it. Best effort: an
# empty value only means housekeeping keeps the plain newest-first window.
OLD_RELEASE_IMAGE_ID=""
[ -z "$OLD_API_CONTAINER" ] \
  || OLD_RELEASE_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$OLD_API_CONTAINER" 2>/dev/null || true)"

# --- pre-flight: room for one build (K-082) ----------------------------------
# Last check that costs nothing: from here on the script installs, builds and
# then drains production. ENOSPC must never be discovered halfway through that.
say "checking free disk space before the build"
disk_space_preflight

# --- web dist, built ON this box --------------------------------------------
# The atlases are GENERATED output (gitignored): a fresh clone has neither
# apps/web/public/atlas (which apps/api/Dockerfile COPYs — the image build
# fails loudly without it) nor a dist for Caddy. `pnpm assets` rebuilds both
# inputs from the checked-in masters; resvg + sharp ship prebuilt linux-x64
# binaries, so this needs nothing from apt beyond node itself.
#
# vite reads VITE_* from the REPO-ROOT .env (envDir — apps/web/vite.config.ts).
# That file is gitignored, so a fresh clone silently builds a client with Privy
# social login MISSING. Fail loudly instead; explicit exports below still win
# over .env values, which is how VITE_API_URL is forced relative.
if ! grep -qsE '^VITE_PRIVY_APP_ID=..*' .env && [ -z "${VITE_PRIVY_APP_ID:-}" ]; then
  die "VITE_PRIVY_APP_ID is missing (repo-root .env or exported).
  The client builds without it, but every social-login path is silently absent.
  Copy the VITE_* lines from the ops machine's root .env."
fi

# The API cluster is selected from infra/.env.prod, while Vite normally reads a
# separate repo-root .env and historically defaulted to devnet. Derive the
# browser cluster and every economic address from the SAME selected registry;
# only the browser-safe RPC comes from the public VITE_ setting. This prevents a
# valid mainnet API release from publishing a client that signs devnet or sends
# SOL to an independently configured treasury. Never fall back to the server RPC
# here: a credential in SOLANA_RPC_URL must not be embedded in public JavaScript.
if ! IFS=$'\t' read -r \
  WEB_SOLANA_CLUSTER WEB_SOLANA_RPC_URL WEB_CORE_PROGRAM WEB_CORE_CONFIG \
  WEB_KEEP_MINT WEB_TREASURY_LIQUIDITY WEB_TREASURY_DEV WEB_TREASURY_OPS \
  WEB_CHAIN_BINDING_SENTINEL \
  < <(node - "$ENV_FILE" .env <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [prodFile, webFile] = process.argv.slice(2);

function lines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
}
function valueOf(source, name, required = true) {
  const matches = source.filter((line) => line.startsWith(`${name}=`));
  if (matches.length > 1) throw new Error(`${name} must appear at most once`);
  let value = matches.length === 1 ? matches[0].slice(name.length + 1).trim() : '';
  if ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (required && !value) throw new Error(`${name} is not set`);
  return value;
}

async function main() {
  const prod = lines(prodFile);
  const web = lines(webFile);
  const cluster = valueOf(prod, 'SOLANA_CLUSTER');
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error('SOLANA_CLUSTER must be devnet or mainnet-beta');
  }
  const publicRpc = (process.env.VITE_SOLANA_RPC_URL || valueOf(web, 'VITE_SOLANA_RPC_URL')).trim();
  if (/\s/.test(publicRpc)) throw new Error('public VITE_SOLANA_RPC_URL cannot contain whitespace');
  let parsedRpc;
  try { parsedRpc = new URL(publicRpc); } catch { throw new Error('public VITE_SOLANA_RPC_URL is invalid'); }
  if (parsedRpc.protocol !== 'https:') throw new Error('public VITE_SOLANA_RPC_URL must use https');
  if (parsedRpc.username || parsedRpc.password) {
    throw new Error('public VITE_SOLANA_RPC_URL cannot contain URL credentials');
  }
  const webOrigin = valueOf(prod, 'WEB_ORIGIN').split(',')[0].trim();
  if (parsedRpc.origin !== webOrigin || parsedRpc.pathname !== `/api/rpc/solana/${cluster}`
      || parsedRpc.search || parsedRpc.hash) {
    throw new Error('public VITE_SOLANA_RPC_URL must select the credential-free game-origin relay');
  }
  if (valueOf(prod, 'RPC_RELAY_ENABLED') !== 'true') {
    throw new Error('RPC_RELAY_ENABLED must be true before publishing a relay client');
  }
  const upstreamRpc = valueOf(prod, 'SOLANA_RPC_URL');
  let upstream;
  try { upstream = new URL(upstreamRpc); } catch { throw new Error('server RPC URL is invalid'); }
  if (upstream.protocol !== 'https:' || upstream.username || upstream.password
      || ['api.devnet.solana.com', 'api.mainnet-beta.solana.com', 'api.testnet.solana.com']
        .includes(upstream.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new Error('server RPC must be a private TLS provider');
  }

  const registryFile = path.join('infra', cluster === 'mainnet-beta'
    ? 'mainnet.addresses.json' : 'devnet.addresses.json');
  if (!fs.existsSync(registryFile)) throw new Error(`reviewed registry is missing: ${registryFile}`);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (registry.cluster !== cluster) {
    throw new Error(`${registryFile} declares ${String(registry.cluster)}, expected ${cluster}`);
  }
  const values = [
    registry.coreProgram, registry.config, registry.keepMint,
    registry.treasuries?.liquidity, registry.treasuries?.dev, registry.treasuries?.ops,
  ];
  if (!values.every((value) => typeof value === 'string'
      && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))) {
    throw new Error(`${registryFile} has a missing or invalid public address`);
  }
  if (cluster === 'mainnet-beta') {
    const policy = registry.keepMintAuthorities;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new Error(`${registryFile} is missing the reviewed KEEP authority policy`);
    }
    for (const key of ['mintAuthority', 'freezeAuthority']) {
      if (!Object.prototype.hasOwnProperty.call(policy, key)
          || (policy[key] !== null && (typeof policy[key] !== 'string'
            || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(policy[key])))) {
        throw new Error(`${registryFile} has an invalid KEEP ${key} policy`);
      }
    }
    const deployments = registry.programDeployments;
    if (!deployments || typeof deployments !== 'object' || Array.isArray(deployments)) {
      throw new Error(`${registryFile} is missing reviewed Anchor ProgramData policies`);
    }
    const validateDeployment = (label, deployment) => {
      if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)
          || typeof deployment.programDataAddress !== 'string'
          || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(deployment.programDataAddress)
          || typeof deployment.programDataSha256 !== 'string'
          || !/^[0-9a-f]{64}$/.test(deployment.programDataSha256)
          || !Object.prototype.hasOwnProperty.call(deployment, 'upgradeAuthority')
          || (deployment.upgradeAuthority !== null
            && (typeof deployment.upgradeAuthority !== 'string'
              || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(deployment.upgradeAuthority)))) {
        throw new Error(`${registryFile} has an invalid reviewed ${label} ProgramData policy`);
      }
    };
    validateDeployment('core', deployments.core);
    if (registry.distributorProgram !== undefined) {
      if (typeof registry.distributorProgram !== 'string'
          || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(registry.distributorProgram)) {
        throw new Error(`${registryFile} has an invalid distributor program address`);
      }
      validateDeployment('distributor', deployments.distributor);
      if (deployments.core.programDataAddress === deployments.distributor.programDataAddress) {
        throw new Error(`${registryFile} core and distributor cannot share ProgramData`);
      }
    } else if (deployments.distributor !== undefined) {
      throw new Error(`${registryFile} has distributor ProgramData without a distributor program`);
    }
  }

  const expectedGenesis = cluster === 'mainnet-beta'
    ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d52'
    : 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
  // The new relay may not exist on the previous API. Attest its fixed upstream
  // before building, then verify the actual route after API boot, before traffic.
  const response = await fetch(upstreamRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }),
    signal: AbortSignal.timeout(8_000),
    redirect: 'error',
  }).catch(() => { throw new Error('server RPC verification request failed'); });
  if (!response.ok) throw new Error(`server RPC returned HTTP ${response.status}`);
  const body = await response.json().catch(() => { throw new Error('server RPC returned an invalid response'); });
  if (!body || body.error || body.result !== expectedGenesis) {
    throw new Error(`server RPC does not serve ${cluster}`);
  }
  // The last field is an explicit success sentinel. Bash cannot observe the
  // process-substitution exit status directly, so a partial stdout write from
  // a failed resolver must never be accepted as a valid release binding.
  process.stdout.write([cluster, publicRpc, ...values, 'chain-binding-ok'].join('\t') + '\n');
}
main().catch((error) => { console.error(error.message); process.exit(1); });
NODE
  )
then
  die "web Solana build configuration is invalid (details above)."
fi
[ "$WEB_CHAIN_BINDING_SENTINEL" = 'chain-binding-ok' ] \
  || die "web Solana build configuration did not complete successfully."

say "building assets + web dist ($SHORT)"
pnpm install --frozen-lockfile
pnpm assets
# The API reads the pinned layered-ground manifests from apps/web/public at
# runtime inside its image (apps/api/src/game/kitObstacles.ts, deed renderer);
# a publish miss would 500 every base of that realm once its revision flips
# (seen on the QA candidate 2026-09-25). Refuse to build such an image.
say "verifying pinned layered-ground manifests were published"
pnpm --filter @shardkeep/scripts run --silent verify:published-ground \
  || die "pinned layered-ground manifests are missing or altered under apps/web/public; the api image would 500 those realms' bases. Nothing was changed."
# GIT_SHA must be the FULL sha and must equal the api image's. It drives the
# update prompt + service-worker cache name (compareVersions in lib/version.ts)
# — NOT the 426 raid gate: x-sim-version carries SIM_VERSION, compiled into
# both halves from @shardkeep/sim, and building web + api from the SAME commit
# (this script's whole job) is what keeps those equal.
# VITE_PKW_CANDIDATE_ORIGIN is set only by scripts/candidate/build-web.mjs: its
# mere presence swaps the paid expansion screen for the zero-charge candidate
# screen (apps/web/src/ui/screens/candidateExpansion.tsx). It must never reach a
# production build, so fail before Vite can read it from the environment or .env.
[ -z "${VITE_PKW_CANDIDATE_ORIGIN:-}" ] || die "VITE_PKW_CANDIDATE_ORIGIN is exported; it is the candidate builder's flag and must be unset for production."
if grep -qsE '^VITE_PKW_CANDIDATE_ORIGIN=' .env; then
  die "VITE_PKW_CANDIDATE_ORIGIN is set in the repo-root .env; remove it — it is the candidate builder's flag."
fi
# Override the repo-root .env explicitly: NODE_ENV=development makes Vite build
# a development client even under `vite build`, compiling out SW/offline gates.
NODE_ENV=production \
VITE_API_URL=/api \
VITE_SOLANA_CLUSTER="$WEB_SOLANA_CLUSTER" \
VITE_SOLANA_RPC_URL="$WEB_SOLANA_RPC_URL" \
VITE_CORE_PROGRAM_ID="$WEB_CORE_PROGRAM" \
VITE_CORE_CONFIG_PDA="$WEB_CORE_CONFIG" \
VITE_KEEP_MINT="$WEB_KEEP_MINT" \
VITE_TREASURY_LIQUIDITY="$WEB_TREASURY_LIQUIDITY" \
VITE_TREASURY_DEV="$WEB_TREASURY_DEV" \
VITE_TREASURY_OPS="$WEB_TREASURY_OPS" \
APP_VERSION="$VERSION" GIT_SHA="$SHA" BUILD_TIME="$BUILT_AT" \
  pnpm --filter @shardkeep/web build

# Tripwire from serve-single-origin.sh: the absence of the fallback origin is
# the proof VITE_API_URL applied. If this string survives, every API call in
# the shipped client points at a developer's laptop.
if grep -rql 'localhost:8787' apps/web/dist/assets 2>/dev/null; then
  die "the built client still contains localhost:8787 — VITE_API_URL did not apply."
fi
for expected in \
  "$WEB_SOLANA_RPC_URL" "$WEB_CORE_PROGRAM" "$WEB_CORE_CONFIG" "$WEB_KEEP_MINT" \
  "$WEB_TREASURY_LIQUIDITY" "$WEB_TREASURY_DEV" "$WEB_TREASURY_OPS"
do
  grep -rFql -- "$expected" apps/web/dist/assets 2>/dev/null \
    || die "the built client is missing a selected Solana binding."
done

# Hash-check both complete public packs before draining or changing the database.
# Retained generations live under the existing read-only Caddy bind mount;
# publication below excludes them from --delete. Never merge retired art into
# the candidate's own manifest or silently overwrite bytes for a published SHA.
say "preserving immutable web generations"
node infra/retain-web-assets.mjs "$WEB_ROOT" apps/web/dist "$WEB_ROOT" \
  || die "web asset retention failed; current public release is unchanged."
say "web client bound to $WEB_SOLANA_CLUSTER registry and verified public RPC"

# --- api image ---------------------------------------------------------------
RELEASE_IMAGE="shardkeep-api:$SHORT"
say "building $RELEASE_IMAGE  (v$VERSION)"
docker build \
  -f apps/api/Dockerfile \
  -t "$RELEASE_IMAGE" \
  -t "shardkeep-api:latest" \
  --build-arg "APP_VERSION=$VERSION" \
  --build-arg "GIT_SHA=$SHA" \
  --build-arg "BUILD_TIME=$BUILT_AT" \
  .

# A successful root-owned COPY does not prove UID 1000 can resolve the runtime
# sources. Catch restrictive checkout modes before maintenance or writer drain.
# This probe has no secrets, mounts or network and only imports guarded modules.
say "verifying candidate image imports as runtime UID 1000"
docker run --rm --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --user=1000:1000 \
  -e TSX_DISABLE_CACHE=1 --entrypoint node "$RELEASE_IMAGE" \
  --import tsx --input-type=module -e '
if (process.getuid() !== 1000 || process.env.GIT_SHA !== process.argv[1]) {
  throw new Error("candidate runtime UID or build identity mismatch");
}
const skr = await import("/app/packages/chain/src/skr.ts");
const verifier = await import("/app/apps/api/src/policySignerVerify.ts");
if (typeof skr.parseSkrLabel !== "function" || typeof verifier.runPolicySignerStateVerify !== "function") {
  throw new Error("candidate runtime exports are missing");
}
console.log("candidate runtime imports verified as UID 1000");
' "$SHA" || die "candidate image runtime imports failed; maintenance and writer drain were not started."

# This release is the first line allowed to read/write AES-GCM TOTP envelopes.
# Refuse to enter maintenance if its three custody migrations are not actually
# in the source commit; a partial cherry-pick is not a deployable unit.
for migration in \
  apps/api/drizzle/0059_new_blazing_skull.sql \
  apps/api/drizzle/0060_sturdy_epoch.sql \
  apps/api/drizzle/0061_high_pandemic.sql
do
  [ -f "$migration" ] || die "required account-security migration is missing: $migration"
done

# M22 currency rewards create liabilities older binaries do not count. The
# ordinary candidate must therefore carry 0083; an intentional rollback across
# this boundary follows the separate quiescent assertion in DEPLOYMENT.md.
[ -f apps/api/drizzle/0083_last_kylun.sql ] \
  || die "migration 0083 mail-custody compatibility fence is missing; use an M22-compatible image."

# Verify the public identity against the key mounted only into the private signer
# BEFORE touching the database or live dist. The worker has no hot-key mount.
say "verifying mounted hot-wallet signer identity"
API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint node withdrawal-signer -e '
const fs = require("node:fs");
const { Keypair, PublicKey } = require("@solana/web3.js");
const signerPath = process.env.HOT_WALLET_KEYPAIR_PATH;
const configured = process.env.HOT_WALLET_PUBKEY;
if (!signerPath || !configured) throw new Error("hot-wallet path/public key missing");
const secret = JSON.parse(fs.readFileSync(signerPath, "utf8"));
const actual = Keypair.fromSecretKey(Uint8Array.from(secret)).publicKey.toBase58();
const expected = new PublicKey(configured).toBase58();
if (actual !== expected) throw new Error("mounted hot-wallet keypair does not match HOT_WALLET_PUBKEY");
console.log("mounted hot-wallet signer identity verified");
' || die "mounted hot-wallet signer verification failed — no production state was changed."

# Dependencies first, so migrations have a database to talk to.
say "starting postgres + redis"
$COMPOSE up -d postgres redis

# WAIT for postgres to actually accept connections before anything talks to it.
# On a VIRGIN volume the container reports Started while initdb is still
# running, and both the empty-schema probe and backup.sh then hit a socket
# that does not exist yet — the probe errors to '?', which correctly demands a
# backup, which fails for the same reason, and the very first deploy dies
# (observed on the production host first boot, 2026-08-06). The compose healthcheck
# covers dependent CONTAINERS; this covers dependent HOST-SIDE steps.
say "waiting for postgres to accept connections"
for i in $(seq 1 30); do
  if $COMPOSE exec -T postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    break
  fi
  [ "$i" = 30 ] && die "postgres did not become ready within 60s"
  sleep 2
done

say "checking item-market candidate compatibility before maintenance"
# Pin subsequent migrations/runtime starts to the immutable image just checked.
RELEASE_IMAGE="$(ENV_FILE="$ENV_FILE" ./infra/ops/assert-item-market-compatible.sh "$RELEASE_IMAGE")" \
  || die "item-market candidate is incompatible; maintenance and writer drain were not started."

say "provisioning runtime database roles (preflight schema)"
provision_runtime_roles

# Read-only custody preflight before the maintenance window. Print aggregate due
# queue state and the exact reserve/liability comparison used by the payout
# brake; never start a withdrawal-enabled worker when coverage is unknown/short.
check_por() {
  local image="${1:-$RELEASE_IMAGE}"
  local result
  if ! result="$(API_IMAGE="$image" $COMPOSE run --rm --no-deps --entrypoint node api \
    --import tsx --input-type=module -e '
import { loadConfig } from "./src/config.ts";
import { createDb } from "./src/db/client.ts";
import { hotKeepReserveReader } from "./src/jobs.ts";
import { checkReserves } from "./src/money/snapshot.ts";
const config = loadConfig();
const { db, sql } = createDb(config.DATABASE_URL, { max: 2 });
try {
  const reader = hotKeepReserveReader(config);
  if (!reader) throw new Error("public hot-wallet reserve reader is unavailable");
  const check = await checkReserves(db, reader);
  console.log(JSON.stringify({
    reserveKeep: check.reserveKeep.toString(),
    liabilityKeep: check.liabilityKeep.toString(),
    covered: check.covered,
    deficit: check.deficit.toString(),
  }));
  if (!check.covered) process.exitCode = 2;
} finally {
  await sql.end();
}
')"; then
    die "proof-of-reserves preflight failed or custody is under-reserved — refusing to enable payouts."
  fi
  printf '  PoR %s\n' "$result"
}

# Determine whether there is state to back up, then inspect custody while the
# old release is still available. The authoritative dump itself is taken only
# after every writer has drained below.
# EXCEPT on a first boot against an EMPTY database: an empty schema dumps to
# ~800 bytes and backup.sh's small-dump guard (correct for cron, where a tiny
# dump means data VANISHED) refuses it — so without this probe a fresh-database
# first deploy could never get past this point (verified 2026-08). An empty
# schema is provably nothing-to-protect; any other outcome, including a failed
# probe, still requires the backup.
TABLES="$($COMPOSE exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tA -c \"select count(*) from pg_tables where schemaname = 'public'\"" \
  2>/dev/null || echo '?')"
if [ "$TABLES" = "0" ]; then
  say "empty database — no queued withdrawals or liabilities to inspect"
else
  say "read-only withdrawal queue preflight"
  $COMPOSE exec -T postgres sh -c \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "
      select json_build_object(
        '\''dueCount'\'', count(*) filter (where status = '\''unbonding'\'' and unbonds_at <= now()),
        '\''dueAmountKeep'\'', coalesce(sum(amount) filter (where status = '\''unbonding'\'' and unbonds_at <= now()), 0),
        '\''processingCount'\'', count(*) filter (where status = '\''processing'\''),
        '\''failedCount'\'', count(*) filter (where status = '\''failed'\'')
      ) from withdrawals;"' \
    || die "could not inspect the withdrawal queue read-only."
  [ -n "$OLD_RELEASE_IMAGE" ] \
    || die "non-empty production database has no running schema-compatible release for PoR preflight."
  check_por "$OLD_RELEASE_IMAGE"
fi

# Stop public traffic first. Before stopping the old worker, let that exact
# simulator finish every live battle that crossed first deploy. A new SIM image
# cannot safely re-simulate or compensate those rows (D-036); the worker's 5s
# recovery sweep owns their canonical command stream. The 90s battle clock plus
# 120s recovery grace bounds this maintenance wait. Only then stop every writer
# and install the one-way deed-economy database fence.
# --- maintenance page preflight (K-071) --------------------------------------
# A bind mount pins the host INODE at container creation. When the host path is
# later deleted and recreated — infra/maintenance was, on 2026-08-31, under a
# caddy container created 2026-08-15 — the container keeps the orphaned inode:
# /srv/maintenance reads EMPTY, `caddy reload` still exits 0, `error 503` finds
# no index.html, and every player gets Chrome's bare "HTTP ERROR 503" instead of
# the page (the M27 and M28 windows). The two bind-mounted Caddyfiles have the
# same failure: git replaces a file by rename, so an edited config is invisible
# to a running container until it is recreated. Compare inodes from both sides
# and recreate under the persistent maintenance marker before draining writers.
caddy_bind_mounts_fresh() {
  local pair host_path container_path host_inode container_inode
  for pair in \
    'infra/maintenance:/srv/maintenance' \
    'infra/Caddyfile.maintenance:/etc/caddy/Caddyfile.maintenance' \
    'infra/Caddyfile.vps:/etc/caddy/Caddyfile' \
    'infra/caddy-start.sh:/etc/caddy/start.sh' \
    'infra/dist:/srv/www'; do
    host_path="${pair%%:*}"; container_path="${pair#*:}"
    # infra/dist does not exist before the first publish on a fresh box.
    [ -e "$host_path" ] || continue
    host_inode="$(stat -c %i "$host_path")"
    container_inode="$($COMPOSE exec -T caddy stat -c %i "$container_path" 2>/dev/null || echo none)"
    if [ "$host_inode" != "$container_inode" ]; then
      say "caddy bind mount is stale: $host_path (host inode $host_inode, container sees $container_inode)"
      return 1
    fi
  done
  if ! $COMPOSE exec -T caddy test -s /srv/maintenance/index.html; then
    say "caddy cannot see a non-empty /srv/maintenance/index.html"
    return 1
  fi
}
# Prove restart behavior before draining writers, and again before traffic returns.
caddy_startup_contract_proven() {
  local caddy_id pair host_path container_path host_hash container_hash
  caddy_id="$($COMPOSE ps -q caddy)" || return 1
  [ -n "$caddy_id" ] && [ "$(docker inspect --format '{{json .Config.Cmd}}' "$caddy_id")" = '["sh","/etc/caddy/start.sh"]' ] || return 1
  for pair in 'infra/caddy-start.sh:/etc/caddy/start.sh' \
    'infra/Caddyfile.vps:/etc/caddy/Caddyfile' \
    'infra/Caddyfile.maintenance:/etc/caddy/Caddyfile.maintenance'; do
    host_path="${pair%%:*}"; container_path="${pair#*:}"
    host_hash="$(sha256sum "$host_path" | cut -d ' ' -f 1)" || return 1
    container_hash="$($COMPOSE exec -T caddy sha256sum "$container_path" | cut -d ' ' -f 1)" || return 1
    [ "$host_hash" = "$container_hash" ] || return 1
  done
  $COMPOSE exec -T caddy sh -c '[ "$(cat /config/shardkeep-maintenance)" = "$1" ]' sh "$SHA"
}
# Prove the page the way a player sees it: the public origin must answer `/`
# with 503 AND the page body, and /api/version with the coded MAINTENANCE
# envelope that the game client turns into its hold screen.
maintenance_page_proven() {
  node - "$API_DOMAIN" <<'NODE'
const domain = process.argv[2];
(async () => {
  const signal = AbortSignal.timeout(10_000);
  const page = await fetch(`https://${domain}/`, { redirect: 'manual', signal });
  const html = await page.text();
  const api = await fetch(`https://${domain}/api/version`, { signal });
  const json = await api.json().catch(() => null);
  const ok = page.status === 503
    && (page.headers.get('content-type') ?? '').startsWith('text/html')
    && html.includes('<title>Pixel Kingdom Wars — Maintenance</title>')
    && api.status === 503 && json?.error?.code === 'MAINTENANCE';
  console.log(ok ? 'maintenance page proven from the public origin'
    : `maintenance proof failed: / -> ${page.status} (${html.length} bytes, ${page.headers.get('content-type') ?? 'no content-type'}), /api/version -> ${api.status} (${json?.error?.code ?? 'no code'})`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log(`maintenance proof failed: ${e}`); process.exit(1); });
NODE
}
# The mirror image for leaving the window: the public origin must serve the
# client (200 text/html) and /api/version must name THIS release's sha.
traffic_returned_proven() {
  node - "$API_DOMAIN" "$SHA" <<'NODE'
const [domain, sha] = process.argv.slice(2);
(async () => {
  const signal = AbortSignal.timeout(10_000);
  const page = await fetch(`https://${domain}/`, { redirect: 'manual', signal });
  const html = await page.text();
  const api = await fetch(`https://${domain}/api/version`, { signal });
  const json = await api.json().catch(() => null);
  const ok = page.status === 200
    && (page.headers.get('content-type') ?? '').startsWith('text/html')
    && html.includes('<script') && api.status === 200 && json?.gitSha === sha;
  console.log(ok ? 'traffic returned: public origin serves the client and this release'
    : `return proof failed: / -> ${page.status} (${html.length} bytes), /api/version -> ${api.status} (gitSha ${json?.gitSha ?? 'none'}, expected ${sha})`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.log(`return proof failed: ${e}`); process.exit(1); });
NODE
}
[ -s infra/maintenance/index.html ] || die "infra/maintenance/index.html is missing or empty on this box."
# Persist BEFORE draining any writer. A missing marker must never allow a
# restarted Caddy to publish the staged client while fantasy reads are disabled.
# A keyless one-shot also works when the serving Caddy is currently stopped.
if ! API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps -T --entrypoint sh caddy -c '
  set -eu; umask 077
  marker=$(mktemp /config/.shardkeep-maintenance.XXXXXX)
  trap '\''rm -f "$marker"'\'' EXIT
  printf "%s\n" "$1" > "$marker"
  mv -f "$marker" /config/shardkeep-maintenance
  [ "$(cat /config/shardkeep-maintenance)" = "$1" ]
' sh "$SHA"; then
  $COMPOSE stop caddy
  die "could not persist maintenance marker; public traffic stopped and writers were not drained."
fi
if ! $COMPOSE ps --status running --services 2>/dev/null | grep -qx caddy \
  || ! caddy_bind_mounts_fresh || ! caddy_startup_contract_proven; then
  say "recreating caddy with verified maintenance startup and current bind mounts"
  # Pull the pinned image first so the recreation gap is the container swap
  # alone, never a registry round-trip with the old container already gone.
  if ! $COMPOSE pull -q caddy \
    || ! API_IMAGE="$RELEASE_IMAGE" $COMPOSE up -d --no-deps --force-recreate caddy; then
    $COMPOSE stop caddy
    die "caddy recreation failed; public traffic stopped and writers were not drained."
  fi
  caddy_bind_mounts_fresh && caddy_startup_contract_proven \
    || { $COMPOSE stop caddy; die "caddy startup/config/marker contract failed after recreation; writers were not drained."; }
fi

say "entering maintenance — swapping caddy to the maintenance page"
# M23 a18: prefer an honest "back in minutes" page over a dead socket. The
# maintenance config proxies NOTHING and never reads the mid-publish /srv/www,
# so the drain window keeps the exact writer-free guarantees of a stopped
# caddy. The page is a courtesy — on ANY doubt, fall back to the hard stop,
# which is always safe.
MAINTENANCE_PAGE=""
if $COMPOSE ps --status running --services 2>/dev/null | grep -qx caddy \
  && $COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile.maintenance; then
  if maintenance_page_proven; then
    MAINTENANCE_PAGE="up"
    say "maintenance page is serving; api/worker drain begins"
  else
    say "maintenance page did not prove out from the public origin — stopping caddy (hard-down fallback)"
    $COMPOSE stop caddy
  fi
else
  say "maintenance page unavailable — stopping caddy (hard-down fallback)"
  $COMPOSE stop caddy
fi

# Public maintenance blocks new requests, but a request accepted before the
# Caddy reload can still arm/start a raid. Finish API shutdown before sampling
# the drain; keep the compatible worker alive to settle those accepted orders.
say "draining api before the compatible live-raid worker"
$COMPOSE stop api
say "draining started live raids and armed v2 raids on the compatible worker"
LIVE_DRAIN_OK=""
LIVE_TABLE_EXISTS="$($COMPOSE exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c \
    "select to_regclass('"'"'public.raid_live_states'"'"') is not null;"' \
  2>/dev/null || echo '?')"
case "$LIVE_TABLE_EXISTS" in
  f)
    # The accepted-command live protocol first appears in migration 0074. A
    # 0072-or-older database structurally cannot contain a battle that crossed
    # first deploy, so there is nothing for the compatible SIM8 worker to drain.
    say "legacy raid schema — no started live-command rows exist"
    LIVE_DRAIN_OK="true"
    ;;
  t)
    for i in $(seq 1 72); do
      LIVE_STARTED="$($COMPOSE exec -T postgres sh -c \
        'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "
          select count(*) from raids r
          join raid_live_states l on l.raid_id = r.id
          where r.status::text in ('"'"'pending_orders'"'"', '"'"'resolving'"'"')
            and (l.started_at is not null
              or (l.command_protocol_version = 2
                and to_jsonb(l)->>'"'"'armed_at'"'"' is not null));"' 2>/dev/null || echo '?')"
      if [ "$LIVE_STARTED" = "0" ]; then LIVE_DRAIN_OK="true"; break; fi
      [ "$LIVE_STARTED" = "?" ] && die "could not inspect started live raids; migration was NOT run."
      sleep 5
    done
    ;;
  *) die "could not determine whether the live-raid protocol exists; migration was NOT run." ;;
esac
[ "$LIVE_DRAIN_OK" = "true" ] || die "started or armed live raids did not drain on the compatible worker within 6 minutes; migration was NOT run."

say "draining worker after live raids"
$COMPOSE stop worker
# The worker is the signer's only caller. Stop the private signer only after
# the worker's 120-second payout grace has fully completed, so no durable write
# can be interrupted or omitted from the paired recovery snapshot below.
$COMPOSE stop withdrawal-signer

# Back up only after the worker's long payout grace period has completed. A dump
# taken while it could still broadcast would omit the resulting settlement and
# could pay the same row twice after a restore.
if [ "$TABLES" = "0" ]; then
  say "empty database — skipping pre-migration backup (nothing to protect yet)"
else
  [ -x "$ROOT/infra/backup/backup.sh" ] \
    || die "infra/backup/backup.sh is missing or not executable — refusing to migrate without a backup."
  say "quiescent pre-migration backup"
  API_IMAGE="$RELEASE_IMAGE" "$ROOT/infra/backup/backup.sh" || die "pre-migration backup FAILED — refusing to migrate.
  Fix the backup first; migrating without one is how a bad migration becomes permanent."
fi

# K-021 manual off-host interlock, made structural (2026-08-15): with
# HOLD_BEFORE_MIGRATE=1 the deploy waits HERE — after the quiescent backup,
# before the first migration — until the operator (from a second shell) has
# copied the dump off-host, matched its SHA-256 and finished a scratch
# restore, then signals with:  touch /tmp/shardkeep-release-migration
# Without the env the flow is unchanged. The wait is bounded so an abandoned
# deploy cannot hold the maintenance page up forever.
if [ "${HOLD_BEFORE_MIGRATE:-0}" = "1" ]; then
  GATE=/tmp/shardkeep-release-migration
  rm -f "$GATE"
  say "HOLDING before migrations (K-021 interlock) — verify the off-host backup copy, then: touch $GATE"
  HELD=0
  while [ ! -f "$GATE" ]; do
    HELD=$((HELD + 15))
    [ "$HELD" -ge 3600 ] && die "interlock gate never confirmed within 60 min — aborting before any migration (site is in maintenance; rerun or roll back)."
    sleep 15
  done
  rm -f "$GATE"
  say "interlock confirmed — proceeding to migrations"
fi

say "running migrations"
API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint sh migrate \
  -c 'cd /app/apps/api && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm db:migrate'

# Migrations may add tables. Reapply the explicit grants and withdrawal trigger
# before either runtime process can reconnect.
say "re-provisioning runtime database roles (post-migration schema)"
provision_runtime_roles

say "checking item-market compatibility after migrations"
ENV_FILE="$ENV_FILE" ./infra/ops/assert-item-market-compatible.sh "$RELEASE_IMAGE" >/dev/null \
  || die "item-market candidate cannot serve the migrated database; traffic and writers remain stopped."

# Rewrap while every serving process is stopped. The tool prints aggregate
# counts only. Its CAS race guard should be impossible in this drained window;
# any race/nonzero final dry-run is still fatal.
say "verifying and rewrapping TOTP envelopes"
API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint node migrate \
  --import tsx src/db/rewrapTwofa.ts
API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint node migrate \
  --import tsx src/db/rewrapTwofa.ts --apply
REWRAP_FINAL="$(API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint node migrate \
  --import tsx src/db/rewrapTwofa.ts)" \
  || die "final TOTP envelope verification failed."
printf '  %s\n' "$REWRAP_FINAL"
case "$REWRAP_FINAL" in
  *'"needsRewrap":0'*) ;;
  *) die "TOTP envelope verification still reports rows needing rewrap — traffic remains stopped." ;;
esac

start_and_verify_api() {
  say "starting api (traffic still stopped)"
  API_IMAGE="$RELEASE_IMAGE" $COMPOSE up -d api
  say "verifying api sha + health"
  local got health api_ok=""
  for i in $(seq 1 30); do
    got="$($COMPOSE exec -T api node -e \
      "fetch('http://localhost:3001/version').then(r=>r.json()).then(v=>console.log(v.gitSha)).catch(()=>{})" 2>/dev/null || true)"
    health="$($COMPOSE exec -T api node -e \
      "fetch('http://localhost:3001/health').then(r=>r.json()).then(v=>console.log(v.ok)).catch(()=>{})" 2>/dev/null || true)"
    if [ "$got" = "$SHA" ] && [ "$health" = "true" ]; then api_ok="true"; break; fi
    sleep 2
  done
  [ "$api_ok" = "true" ] || {
    $COMPOSE logs --tail=40 api
    die "api did not verify release $SHORT. Traffic remains stopped.
    Recovery must pin BOTH services to an AES-envelope-capable image, never a
    pre-0059 image: API_IMAGE=$RELEASE_IMAGE $COMPOSE up -d api worker"
  }
}

start_and_verify_worker() {
  say "starting private withdrawal policy signer (traffic still stopped)"
  API_IMAGE="$RELEASE_IMAGE" $COMPOSE up -d withdrawal-signer
  local signer_ok=""
  for i in $(seq 1 30); do
    signer_ok="$($COMPOSE exec -T withdrawal-signer node -e \
      "fetch('http://127.0.0.1:3003/health').then(r=>r.json()).then(v=>console.log(v.ok)).catch(()=>{})" 2>/dev/null || true)"
    [ "$signer_ok" = "true" ] && break
    sleep 2
  done
  if [ "$signer_ok" != "true" ]; then
    $COMPOSE logs --tail=40 withdrawal-signer
    die "private withdrawal policy signer is not healthy. Traffic remains stopped; never reset its state to make this pass."
  fi
  say "starting worker (traffic still stopped)"
  API_IMAGE="$RELEASE_IMAGE" $COMPOSE up -d worker
  say "verifying worker health (payout + deed sync owner)"
  local worker_ok=""
  for i in $(seq 1 45); do
    worker_ok="$($COMPOSE exec -T worker node -e \
      "fetch('http://127.0.0.1:3002/health').then(r=>r.json()).then(v=>console.log(v.ok)).catch(()=>{})" 2>/dev/null || true)"
    [ "$worker_ok" = "true" ] && break
    sleep 2
  done
  if [ "$worker_ok" != "true" ]; then
    $COMPOSE exec -T worker node -e \
      "fetch('http://127.0.0.1:3002/health').then(r=>r.text()).then(t=>console.log(t)).catch(e=>console.log(String(e)))" 2>/dev/null || true
    $COMPOSE logs --tail=40 worker
    die "worker /health is not ok. Traffic remains stopped. Recovery must pin
    BOTH services to an AES-envelope-capable image:
    API_IMAGE=$RELEASE_IMAGE $COMPOSE up -d api worker"
  fi
}

# A green worker /health immediately after replacement can still be backed by
# the previous process's observations. Prove this worker completed a full
# generation, then wait beyond the normal freshness horizon and prove a later
# generation kept the same active-deed count fully covered. Caddy remains stopped
# throughout; any query/parse/timeout failure is deliberately fatal (K-022).
verify_replacement_deed_observer() {
  local worker_container worker_started freshness_ms
  worker_container="$($COMPOSE ps -q worker 2>/dev/null | head -n 1 || true)"
  [ -n "$worker_container" ] || die "replacement worker container is missing; traffic remains stopped."
  worker_started="$(docker inspect --format '{{.State.StartedAt}}' "$worker_container" 2>/dev/null || true)"
  [[ "$worker_started" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] \
    || die "could not resolve replacement worker StartedAt; traffic remains stopped."

  freshness_ms="$(API_IMAGE="$RELEASE_IMAGE" $COMPOSE run --rm --no-deps --entrypoint node worker \
    --import tsx --input-type=module -e \
    'import { BASE_OWNERSHIP } from "@shardkeep/shared"; console.log(BASE_OWNERSHIP.observationHealthFreshnessMs)' \
    2>/dev/null || true)"
  case "$freshness_ms" in
    ''|*[!0-9]*) die "could not resolve deed-observer freshness horizon; traffic remains stopped." ;;
  esac
  [ "$freshness_ms" -gt 0 ] || die "deed-observer freshness horizon must be positive."

  deed_gate_state() {
    $COMPOSE exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "
      WITH active_deeds AS (
        SELECT b.id, b.deed_asset_id, b.deed_mint_asset_id
        FROM base_slots s
        JOIN bases b ON b.id = s.base_id
        WHERE s.active = true AND b.status = '\''active'\''
          AND (b.deed_asset_id IS NOT NULL OR b.deed_mint_asset_id IS NOT NULL
            OR b.deed_minting_at IS NOT NULL)
      ), evaluated AS (
        SELECT a.id,
          ((a.deed_asset_id IS NULL AND a.deed_mint_asset_id IS NULL)
            OR (a.deed_asset_id IS NOT NULL
              AND o.base_id IS NOT NULL AND o.asset_id = a.deed_asset_id
              AND o.owner IS NOT DISTINCT FROM b.owner_wallet
              AND o.status = '\''owned'\'' AND o.slot IS NOT NULL)) AS covered,
          (a.deed_asset_id IS NULL AND a.deed_mint_asset_id IS NULL) AS minting_without_asset,
          o.checked_at
        FROM active_deeds a
        JOIN bases b ON b.id = a.id
        LEFT JOIN LATERAL (
          SELECT d.base_id, d.asset_id, d.owner, d.status, d.slot, d.checked_at
          FROM deed_ownership_observations d
          WHERE d.base_id = a.id
          ORDER BY d.checked_at DESC, d.id DESC
          LIMIT 1
        ) o ON true
      )
      SELECT count(*)::int || '\''|'\''
        || count(*) FILTER (WHERE covered AND (minting_without_asset
          OR checked_at >= '\''$1'\''::timestamptz))::int || '\''|'\''
        || count(*) FILTER (WHERE covered IS NOT TRUE OR (NOT minting_without_asset
          AND (checked_at IS NULL OR checked_at < now()
            - ($2 || '\'' milliseconds'\'')::interval)))::int || '\''|'\''
        || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
      FROM evaluated;"' sh "$worker_started" "$freshness_ms" 2>/dev/null
  }

  say "proving replacement-worker deed observation generation"
  local deadline state active post_start uncovered db_now first_ready_at=""
  deadline=$(( $(date +%s) + 360 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state="$(deed_gate_state || true)"
    IFS='|' read -r active post_start uncovered db_now <<EOF
$state
EOF
    if [[ "$active" =~ ^[0-9]+$ && "$post_start" =~ ^[0-9]+$ \
      && "$uncovered" =~ ^[0-9]+$ && "$db_now" =~ ^[0-9]+$ \
      && "$active" -eq "$post_start" && "$uncovered" -eq 0 ]]; then
      first_ready_at="$db_now"
      break
    fi
    sleep 5
  done
  [ -n "$first_ready_at" ] || die "replacement worker did not freshly cover every active deed within 6 minutes; traffic remains stopped."
  local expected_active="$active"
  printf '  replacement generation covered %s active deed(s)\n' "$expected_active"

  say "proving deed coverage beyond the freshness horizon"
  local stable_after=$(( first_ready_at + freshness_ms + 5000 ))
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    state="$(deed_gate_state || true)"
    IFS='|' read -r active post_start uncovered db_now <<EOF
$state
EOF
    if [[ "$active" =~ ^[0-9]+$ && "$post_start" =~ ^[0-9]+$ \
      && "$uncovered" =~ ^[0-9]+$ && "$db_now" =~ ^[0-9]+$ \
      && "$db_now" -ge "$stable_after" && "$active" -eq "$expected_active" \
      && "$active" -eq "$post_start" && "$uncovered" -eq 0 ]]; then
      printf '  sustained coverage verified: %s active / 0 uncovered\n' "$active"
      return 0
    fi
    sleep 5
  done
  die "deed coverage did not remain fresh and stable beyond its freshness horizon; traffic remains stopped."
}

verify_serving_health() {
  say "verifying sustained api + worker health after observer gate"
  local api_ok worker_ok
  for i in 1 2 3; do
    api_ok="$($COMPOSE exec -T api node -e \
      "fetch('http://127.0.0.1:3001/health').then(r=>console.log(r.status === 200)).catch(()=>{})" \
      2>/dev/null || true)"
    worker_ok="$($COMPOSE exec -T worker node -e \
      "fetch('http://127.0.0.1:3002/health').then(r=>console.log(r.status === 200)).catch(()=>{})" \
      2>/dev/null || true)"
    [ "$api_ok" = "true" ] && [ "$worker_ok" = "true" ] \
      || die "post-observer api/worker health probe failed; traffic remains stopped."
    [ "$i" = 3 ] || sleep 2
  done
}

if [ "$MULTI_BASE_ROLLOUT" = "true" ]; then
  # The public API deliberately refuses stale/missing deed observations. The
  # worker is the only process able to heal them, so it must complete its
  # immediate sweep before API boot on activation and after ordinary downtime.
  say "multi-base rollout — healing deed observations worker-first"
  start_and_verify_worker
  verify_replacement_deed_observer
  say "final proof-of-reserves gate (post-worker bootstrap)"
  check_por "$RELEASE_IMAGE"
  start_and_verify_api
else
  # Legacy order keeps a signer-owning worker stopped until the request binary
  # has booted and its idempotent ledger allocations exist.
  start_and_verify_api
  say "final proof-of-reserves gate (post-api bootstrap)"
  check_por "$RELEASE_IMAGE"
  start_and_verify_worker
fi

verify_serving_health

say "verifying the served browser RPC relay before traffic returns"
$COMPOSE exec -T api node --import tsx --input-type=module -e '
import { loadConfig } from "./src/config.ts";
const config = loadConfig();
try {
  if (config.RPC_RELAY_ENABLED !== "true" || !config.WEB_ORIGIN[0]) throw new Error();
  const response = await fetch(`http://127.0.0.1:3001/rpc/solana/${config.SOLANA_CLUSTER}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", origin: config.WEB_ORIGIN[0] },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
  });
  const expected = config.SOLANA_CLUSTER === "devnet"
    ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
    : "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d52";
  if (!response.ok || (await response.json()).result !== expected) throw new Error();
  console.log("Served same-origin RPC relay genesis verified");
} catch {
  console.error("Served browser RPC relay verification failed; traffic remains stopped");
  process.exit(1);
}' || die "browser RPC relay did not pass the serving gate."

# The pre-flight above checked infra/.env.prod; this proves what the new api
# container actually SERVES to installed code 25 (no renderer header) and to a
# realm-kit renderer (codes 26 on), before any player can reach it: the tree SIM,
# a floor no higher than the pre-flight allowed and never below the first build
# on this SIM (G6 Path A: SIM 18 needs floor 33), and the two content URLs.
# Values come from the pre-flight: tree SIM, floor limit, served legacy URL, main
# URL, contract, first code on the tree SIM, legacy (header-less) code.
native_capabilities_proven() {
  $COMPOSE exec -T api node - "$@" <<'NODE'
const [sim, floorLimit, legacyUrl, mainUrl, modernContract, simFirstCode, legacyCode] = process.argv.slice(2);
(async () => {
  const problems = [];
  const capabilities = async (label, headers) => {
    const response = await fetch('http://127.0.0.1:3001/native/capabilities', {
      headers: { 'X-PKW-Client': 'android-native', ...headers }, signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || !body) throw new Error(`${label}: /native/capabilities returned HTTP ${response.status}`);
    return body;
  };
  const same = (label, field, actual, expected) => {
    if (actual !== expected) problems.push(`${label}: ${field} ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };
  const store = await capabilities('no renderer header (code 25)', {});
  same('no renderer header (code 25)', 'simVersion', store.simVersion, Number(sim));
  if (!Number.isInteger(store.minimumVersionCode) || store.minimumVersionCode > Number(floorLimit)) {
    problems.push(`no renderer header (code 25): minimumVersionCode ${JSON.stringify(store.minimumVersionCode)}, expected <= ${floorLimit}`);
  } else if (store.minimumVersionCode < Number(simFirstCode)) {
    problems.push(`no renderer header (code 25): minimumVersionCode ${store.minimumVersionCode} admits builds below code ${simFirstCode}, the first on SIM ${sim}`);
  }
  same('no renderer header (code 25)', 'contentManifestUrl', store.contentManifestUrl, legacyUrl || null);
  const label = `renderer contract ${modernContract}`;
  const modern = await capabilities(label, { 'X-PKW-Renderer-Contract': modernContract });
  same(label, 'contentManifestUrl', modern.contentManifestUrl, mainUrl || null);
  for (const problem of problems) console.error(`  ${problem}`);
  if (problems.length) process.exit(1);
  console.log(store.minimumVersionCode <= Number(legacyCode)
    ? 'served native capabilities keep installed code 25 working'
    : `served native capabilities: SIM ${sim}, every build below code ${store.minimumVersionCode} must take the update before it can order`);
})().catch((error) => { console.error(`native capabilities probe failed: ${error.message}`); process.exit(1); });
NODE
}
say "verifying served native capabilities (SIM $TREE_SIM_VERSION, floor $NATIVE_FLOOR, store code $STORE_NATIVE_VERSION_CODE) before traffic returns"
native_capabilities_proven "$TREE_SIM_VERSION" "$NATIVE_FLOOR_LIMIT" "$NATIVE_CONTENT_SERVED_LEGACY" \
  "$NATIVE_CONTENT_MAIN" "$NATIVE_REALM_KIT_CONTRACT" "$NATIVE_SIM_FIRST_CODE" "$LEGACY_NATIVE_VERSION_CODE" \
  || die "the new api does not serve installed native builds what $ENV_FILE and this tree require (details above); traffic remains stopped."

# The sha can be right while an optional integration silently disabled itself.
# Match the strings the current binary actually emits: notably
# "[hot-wallet] public config unavailable", not the stale "unavailable" needle.
DISABLED="$($COMPOSE logs api worker 2>&1 | grep -iE \
  '\[hot-wallet\] public config unavailable|\[deed\] minting DISABLED|\[deed-r2\] metadata sync disabled|\[deed-r2\] MISCONFIGURED' || true)"
if [ -n "$DISABLED" ]; then
  printf '\n\033[33m  WARNING — money/deed paths are DISABLED in this deploy:\033[0m\n'
  printf '%s\n' "$DISABLED" | sed 's/^/    /'
  printf '\n  Check the public wallet identity and R2_* values in %s.\n\n' "$ENV_FILE"
  [ "${DEPLOY_ALLOW_DEGRADED:-}" = "1" ] || die "refusing a silently degraded deploy; traffic remains stopped."
fi

# Publish only while no traffic reads /srv/www — either Caddy is stopped, or
# it is serving the maintenance config, which never touches the web root.
# This is the only mutation of the live web root.
say "publishing verified dist → $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete --exclude '/_releases/' --exclude '/_assets/' apps/web/dist/ "$WEB_ROOT/"

say "starting caddy — verifying durable maintenance"
API_IMAGE="$RELEASE_IMAGE" $COMPOSE up -d caddy
for i in $(seq 1 15); do
  if $COMPOSE ps --status running --services | grep -qx caddy; then break; fi
  [ "$i" = 15 ] && die "caddy did not stay running; api + worker are verified but traffic is down."
  sleep 2
done
# The marker stays present through every proof, including the normal public one.
caddy_startup_contract_proven \
  || { $COMPOSE stop caddy; die "caddy startup/config/marker contract changed; traffic stopped."; }
maintenance_page_proven \
  || { $COMPOSE stop caddy; die "durable maintenance did not prove from the public origin; traffic stopped."; }
say "checking item-market compatibility before traffic return"
ENV_FILE="$ENV_FILE" ./infra/ops/assert-item-market-compatible.sh "$RELEASE_IMAGE" >/dev/null \
  || die "item-market candidate is incompatible; durable maintenance remains active."
if [ "$KEEP_MAINTENANCE" = 1 ]; then
  say "staged $SHORT: internal API/worker and artifact gates passed; public origin remains in durable maintenance"
  echo "  The new web client has NOT been verified through the public origin."
  echo "  Complete the staged operation, then run a normal guarded deploy to return traffic."
  exit 0
fi

$COMPOSE exec -T caddy caddy validate --config /etc/caddy/Caddyfile \
  || die "normal caddy startup config failed validation; durable maintenance remains active."
if ! $COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile \
  || ! traffic_returned_proven; then
  # The durable marker already protects restarts. Restore the live process as
  # well; failure to prove its maintenance page falls back to a hard stop.
  $COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile.maintenance \
    && maintenance_page_proven || $COMPOSE stop caddy
  die "normal public release proof failed; traffic returned to maintenance or stopped."
fi
$COMPOSE exec -T caddy rm -f /config/shardkeep-maintenance \
  || die "release is publicly verified but maintenance marker could not be cleared; a restart will remain in maintenance."

SIM="$($COMPOSE exec -T api node -e \
  "fetch('http://localhost:3001/version').then(r=>r.json()).then(v=>console.log(v.simVersion))" 2>/dev/null || echo '?')"
printf '\n\033[32m  deployed v%s (%s), sim v%s\033[0m\n\n' "$VERSION" "$SHORT" "$SIM"
echo "  API and worker are pinned to $RELEASE_IMAGE; the matching web dist is live."
echo "  Withdrawals are enabled and the worker passed signer + PoR preflight."
echo

# --- public release record call (M47 §5) --------------------------------------
# After the public release proof and the maintenance-marker clear, before
# housekeeping. A staged (KEEP_MAINTENANCE=1) or failed run exited above and never
# records; the subshell keeps even an unset variable from failing this deploy.
( record_public_release ) \
  || printf '\n\033[33m  WARNING — the public changelog was not updated (details above). The deploy itself SUCCEEDED.\033[0m\n\n'

# --- post-deploy housekeeping (K-082) ----------------------------------------
# The release above is final: traffic is back and publicly proven. Housekeeping
# runs in a subshell so that not even an unset variable can turn a verified
# deploy into a non-zero exit. A staged (KEEP_MAINTENANCE=1) or failed run never
# reaches this line, so the image it would roll back to is never touched.
( post_deploy_housekeeping ) \
  || printf '\n\033[33m  housekeeping was incomplete (details above). The deploy itself SUCCEEDED; rerun is not needed.\033[0m\n\n'
