#!/usr/bin/env bash
# One-time, source-based bootstrap. This works before the first signer image
# exists and refuses to overwrite any prior state.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ "${1:-}" = "--confirm-empty-state" ] && [ "$#" -eq 1 ] || {
  echo "usage: $0 --confirm-empty-state" >&2
  exit 2
}
STATE_DIR="$ROOT/infra/policy-signer-state"
STATE_FILE="$STATE_DIR/state.json"
SIGNER_UID="${WITHDRAWAL_POLICY_SIGNER_UID:-1000}"
SIGNER_GID="${WITHDRAWAL_POLICY_SIGNER_GID:-1000}"
case "$SIGNER_UID" in ''|0*|*[!0-9]*) echo "signer UID must be a positive decimal integer" >&2; exit 1 ;; esac
case "$SIGNER_GID" in ''|0*|*[!0-9]*) echo "signer GID must be a positive decimal integer" >&2; exit 1 ;; esac
if [ "$(id -u)" != "0" ] && { [ "$(id -u)" != "$SIGNER_UID" ] || [ "$(id -g)" != "$SIGNER_GID" ]; }; then
  echo "run this ceremony as the configured signer owner $SIGNER_UID:$SIGNER_GID (or root)" >&2
  exit 1
fi
if [ -L "$STATE_DIR" ] || { [ -e "$STATE_DIR" ] && [ ! -d "$STATE_DIR" ]; }; then
  echo "refusing unsafe policy signer state directory: $STATE_DIR" >&2
  exit 1
fi
if [ -e "$STATE_FILE" ] || [ -L "$STATE_FILE" ]; then
  echo "refusing to replace existing policy signer state: $STATE_FILE" >&2
  exit 1
fi
install -d -m 700 -o "$SIGNER_UID" -g "$SIGNER_GID" "$STATE_DIR"
chmod 700 "$STATE_DIR"
WITHDRAWAL_POLICY_SIGNER_STATE_FILE="$STATE_FILE" \
  pnpm --filter @shardkeep/api run policy-signer:init --confirm-empty-state
chown "$SIGNER_UID:$SIGNER_GID" "$STATE_FILE"
chmod 600 "$STATE_FILE"
echo "initialized empty policy signer state at $STATE_FILE"
