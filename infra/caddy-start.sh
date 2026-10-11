#!/bin/sh
# Keep a staged release private across container/host restarts. /config is the
# existing persistent caddyconfig volume; the configs and this script are read-only.
set -eu
config=/etc/caddy/Caddyfile
if [ -e /config/shardkeep-maintenance ] || [ -L /config/shardkeep-maintenance ]; then
  config=/etc/caddy/Caddyfile.maintenance
fi
exec caddy run --config "$config" --adapter caddyfile
