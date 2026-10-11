/** Local owner-acceptance fixtures only. No route, NFT, payment or production writer.
 * Run after signing a test wallet into the isolated candidate once. */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { CAPS, CAMPAIGN, TROOPS, STRUCTURES, BuildingType, wallCapForKeepLevel } from '@shardkeep/shared';
import { createDb } from '../src/db/client';
import { bases, buildings, obstacles, baseArmy, baseCampaignProgress } from '../src/db/schema';
import { rewardBaseShards } from '../src/game/baseEconomy';

const [wallet, mode = 'connections'] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL ?? 'about:blank');
if (url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/wall_five_candidate'
    || !wallet || !['connections', 'maximum', 'upgrades', 'campaign'].includes(mode)) {
  throw Error('Use the isolated wall_five_candidate on 127.0.0.1:55433 with an authenticated test wallet and connections|maximum|upgrades|campaign');
}
const { db, sql } = createDb(url.toString());
try {
  const [base] = await db.select().from(bases).where(eq(bases.ownerWallet, wallet));
  if (!base || base.deedAssetId || base.landPaidAt) throw Error('Fixture requires an existing free test base without a deed');
  const cells = new Map<string, { tx: number; ty: number; level: number }>();
  const put = (tx: number, ty: number, level: number) => cells.set(`${tx},${ty}`, { tx, ty, level });
  if (mode === 'upgrades') {
    [4, 8, 12, 16].forEach((level, i) => put(7 + i, 7, level));
    [4, 8, 12, 16].forEach((level, i) => put(7 + i * 3, 10, level));
    for (let x = 7; x < 17; x++) put(x, 11, 20);
  } else if (mode === 'maximum') {
    for (let y = 3; y < 27 && cells.size < wallCapForKeepLevel(20); y++)
      for (let x = 3; x < 27 && cells.size < wallCapForKeepLevel(20); x++) {
        if (x >= 12 && x <= 17 && y >= 12 && y <= 17) continue;
        put(x, y, 1 + ((x + y * 3) % STRUCTURES.wall.maxTier));
      }
  } else {
    // One long all-level run; mixed nested enclosures; dense wood/stone squares.
    for (let x = 0; x < STRUCTURES.wall.maxTier; x++) put(4 + x, 4, x + 1);
    for (const [min, max] of [[6, 23], [9, 20]]) {
      for (let x = min!; x <= max!; x++) { put(x, min!, 1 + (x % 5) * 4); put(x, max!, 1 + ((x + 2) % 5) * 4); }
      for (let y = min! + 1; y < max!; y++) { put(min!, y, 1 + (y % 5) * 4); put(max!, y, 1 + ((y + 3) % 5) * 4); }
    }
    for (let y = 11; y < 14; y++) for (let x = 10; x < 13; x++) put(x, y, x === 10 ? 1 : 17);
    for (let y = 17; y < 20; y++) for (let x = 17; x < 20; x++) put(x, y, 1 + ((x + y) % 5) * 4);
  }
  if (cells.size > wallCapForKeepLevel(20)) throw Error('Fixture exceeds legal wall cap');
  await db.transaction(async tx => {
    await tx.update(bases).set({ keepLevel: 20, expansions: CAPS.expansionsMax }).where(eq(bases.id, base.id));
    await tx.update(buildings).set({ level: 20 }).where(and(eq(buildings.baseId, base.id), eq(buildings.type, BuildingType.Keep)));
    await tx.delete(buildings).where(and(eq(buildings.baseId, base.id), eq(buildings.type, BuildingType.Wall)));
    await tx.update(obstacles).set({ clearedAt: new Date() }).where(eq(obstacles.baseId, base.id));
    await tx.insert(buildings).values([...cells.values()].map(c => ({ ...c, type: BuildingType.Wall, playerWallet: wallet, baseId: base.id })));
    if (mode === 'campaign') {
      const [camp] = await tx.select({ id: buildings.id }).from(buildings)
        .where(and(eq(buildings.baseId, base.id), eq(buildings.type, BuildingType.Camp)));
      if (!camp) await tx.insert(buildings).values({ baseId: base.id, playerWallet: wallet,
        type: BuildingType.Camp, level: 1, tx: 24, ty: 24 });
      // Synthetic prerequisite history only: no campaign settlement or rewards.
      for (let stage = 1; stage < CAMPAIGN.totalStages; stage++) {
        await tx.insert(baseCampaignProgress).values({ baseId: base.id, stage,
          bestStars: CAMPAIGN.unlockStarsRequired }).onConflictDoNothing();
      }
      await tx.insert(baseArmy).values({ baseId: base.id, troop: 'kegrunner',
        count: Math.floor(CAMPAIGN.maxArmyPointsByKeep[0]! / TROOPS.kegrunner.pts),
      }).onConflictDoUpdate({ target: [baseArmy.baseId, baseArmy.troop],
        set: { count: Math.floor(CAMPAIGN.maxArmyPointsByKeep[0]! / TROOPS.kegrunner.pts) } });
    }
    await rewardBaseShards(tx, base.id, 100_000_000n, 'local.wall.acceptance', randomUUID(), { syntheticFixture: mode });
  });
  console.log(JSON.stringify({ baseId: base.id, wallet, mode, walls: cells.size, allocation: 'synthetic free base; no NFT issued' }));
} finally { await sql.end(); }
