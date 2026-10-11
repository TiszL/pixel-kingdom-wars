/**
 * Ops: place/refresh (or remove) the tier-9 MAXED practice fortress next to a
 * player's base (owner 2026-08-03: everything at L20, all seven defence types —
 * a dev-spawnable target to watch every defence fire).
 *
 *   pnpm --filter @shardkeep/api db:maxed-camp                    # spawn/refresh next to the owner
 *   pnpm --filter @shardkeep/api db:maxed-camp -- --remove        # remove (or tombstone) it
 *   pnpm --filter @shardkeep/api db:maxed-camp -- --wallet <b58>  # another base instead
 *
 * Idempotent: re-running heals/refreshes the one camp instead of stacking
 * duplicates. Once placed it respawns daily like every camp; it persists until
 * --remove. Deliberately a CLI, not a route: spawning content is an operator
 * action and must never be reachable from the network (see spawnMaxedCamp).
 */
import { loadConfig } from '../config';
import { createDb } from './client';
import { removeMaxedCamp, spawnMaxedCamp } from '../game/world';

// Ops default (NOT a game number): the owner's devnet wallet. Override with --wallet.
const OWNER_WALLET = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const wi = args.indexOf('--wallet');
const wallet = wi >= 0 ? args[wi + 1] : OWNER_WALLET;
if (!wallet) {
  console.error('--wallet needs a value');
  process.exit(1);
}

const cfg = loadConfig();
const { db, sql } = createDb(cfg.DATABASE_URL, { max: 1 });

try {
  if (remove) {
    const results = await removeMaxedCamp(db, wallet);
    if (results.length === 0) console.log('no maxed camp in that valley — nothing to remove');
    for (const r of results) console.log(`${r.action} maxed camp ${r.campId} at (${r.x},${r.y})`);
  } else {
    const r = await spawnMaxedCamp(db, wallet);
    console.log(`${r.action} maxed camp ${r.campId} at (${r.x},${r.y}) in valley ${r.valleyId} — next to ${wallet}`);
  }
} finally {
  await sql.end();
}
