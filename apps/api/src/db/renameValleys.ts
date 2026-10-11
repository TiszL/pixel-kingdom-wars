/**
 * One-shot maintenance: give every valley its deterministic name.
 *
 *   pnpm --filter @shardkeep/api db:rename-valleys
 *
 * Valleys created before MAP-SCALE-PLAN S6 are called "Valley 1", "Valley 2" …
 * and the map banner fell back to printing a UUID fragment at a human. Names are
 * derived from the valley's SITE (`valleys.site_id`), so this is idempotent and
 * stable across runs. No DDL — `valleys.name` already exists.
 */
import { asc } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { createDb } from './client';
import { valleys } from './schema';
import { valleyName } from '../game/world';

const cfg = loadConfig();
const { db, sql } = createDb(cfg.DATABASE_URL, { max: 1 });

try {
  // FROM site_id, NOT FROM CREATION ORDER (P5). The name and the place must come
  // out of the same frozen number, or this script could rename a valley the globe
  // still sites somewhere else — and creation order is exactly the thing site_id
  // exists to stop being load-bearing. `createValley` names new valleys the same
  // way, so a backfill and a fresh create agree.
  //
  // MIND THE DEED. A valley's name is the REGION half of every deed's Location
  // trait, so renaming a populated valley rewrites public, on-chain-referenced
  // documents for every base in it: the R2 sweep republishes and the chain-URI job
  // bumps ?v= on each one. Harmless (a ?v= move is not a re-point, so the
  // MAX_REPOINTS_PER_PASS breaker stays out of it) but not invisible.
  const rows = await db.select({ id: valleys.id, name: valleys.name, siteId: valleys.siteId }).from(valleys)
    .orderBy(asc(valleys.siteId));
  if (rows.length === 0) console.log('no valleys — nothing to rename');
  for (const v of rows) {
    const name = valleyName(v.siteId + 1);
    if (v.name === name) { console.log(`${v.id} already "${name}"`); continue; }
    await db.update(valleys).set({ name }).where(eq(valleys.id, v.id));
    console.log(`${v.id}: "${v.name}" → "${name}"`);
  }
} finally {
  await sql.end();
}
