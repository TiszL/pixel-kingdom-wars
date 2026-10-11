/**
 * One-shot maintenance: re-tier every valley's PvE camps onto the CURRENT ramp.
 *
 *   pnpm --filter @shardkeep/api db:reseed-camps
 *
 * Needed because camps are written at valley-creation time only, so valleys made
 * before MAX_CAMP_TIER widened are stuck on the old difficulty band. Idempotent
 * (upsert on (valleyId, x, y)); safe to re-run. Does not touch `respawnsAt`, so a
 * camp already cleared today stays cleared.
 */
import { loadConfig } from '../config';
import { createDb } from './client';
import { valleys } from './schema';
import { reseedValleyCamps } from '../game/world';

const cfg = loadConfig();
const { db, sql } = createDb(cfg.DATABASE_URL, { max: 1 });

try {
  const rows = await db.select({ id: valleys.id, name: valleys.name }).from(valleys);
  if (rows.length === 0) {
    console.log('no valleys — nothing to reseed');
  }
  for (const v of rows) {
    const n = await reseedValleyCamps(db, v.id);
    console.log(`reseeded ${n} camps in ${v.name} (${v.id})`);
  }
} finally {
  await sql.end();
}
