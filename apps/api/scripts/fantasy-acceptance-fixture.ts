/** Local acceptance scenery and progression. Never imports production data or issues NFTs. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { BASE_OWNERSHIP, BUILDING_GEOMETRY, BuildingType, CAPS, CAMPAIGN, TUTORIAL_STEPS } from '@shardkeep/shared';
import { REALM_IDS, REALM_NAMES, type RealmId } from '@shardkeep/shared/baseVisual';
import { createDb } from '../src/db/client';
import { players, bases, baseSlots, buildings, obstacles, baseArmy, baseCampaignProgress, tutorialProgress } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { ensureBasePlotAssigned } from '../src/game/world';
import { seedDevFantasyLocation } from '../src/game/fantasyLocation';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { footprintOf } from '../src/game/footprints';
import { fantasyAcceptanceWalls, fantasyFixtureId } from './fantasy-acceptance-layout';

const [mainWallet, receiptFile] = process.argv.slice(2);
const url = new URL(process.env.DATABASE_URL ?? 'about:blank');
if (!mainWallet || !receiptFile || url.hostname !== '127.0.0.1' || url.port !== '55508' || url.pathname !== '/fantasy_candidate_test'
  || process.env.NODE_ENV === 'production' || process.env.DEV_LOGIN !== 'true') throw new Error('Requires isolated fantasy candidate, authenticated test wallet and receipt path');
process.env.MULTI_BASE_ENABLED = 'true'; process.env.FANTASY_WORLD_ENABLED = 'true';
const { db, sql } = createDb(url.toString());
try {
  const [mainSlot] = await db.select({ base: bases }).from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, mainWallet), eq(baseSlots.slot, 1), eq(baseSlots.active, true), eq(bases.ownerWallet, mainWallet)));
  const main = mainSlot?.base;
  if (!main || main.deedAssetId || main.deedMintAssetId || !main.landPaidAt) throw new Error('Requires the paid, deedless development-login base');
  const receipt: Array<{ realmId: RealmId; baseId: string; wallet: string; tileId: number; walls: number; owned: boolean }> = [];
  const realms: RealmId[] = ['crownlands', ...REALM_IDS.filter(r => r !== 'crownlands' && r !== 'seeker-reach')];
  for (const [index, realmId] of realms.entries()) {
    const owned = index < BASE_OWNERSHIP.maxActive;
    const wallet = owned ? mainWallet : Keypair.fromSeed(createHash('sha256').update(`local-only-fantasy:${mainWallet}:${realmId}`).digest()).publicKey.toBase58();
    if (!owned) await db.insert(players).values({ wallet, name: `QA ${REALM_NAMES[realmId]}`, entryPaidAt: new Date() }).onConflictDoNothing();
    const baseId = index === 0 ? main.id : fantasyFixtureId(mainWallet, realmId);
    if (index !== 0) {
      await db.insert(bases).values({ id: baseId, ownerWallet: wallet, landPaidAt: new Date(), status: 'active' }).onConflictDoNothing();
      const [existing] = await db.select().from(bases).where(eq(bases.id, baseId));
      if (!existing || existing.ownerWallet !== wallet || existing.deedAssetId || existing.deedMintAssetId || !existing.landPaidAt) throw new Error('Fixture base identity changed');
      const slot = owned ? index + 1 : 1;
      await db.insert(baseSlots).values({ wallet, slot, baseId }).onConflictDoNothing();
      const [bound] = await db.select().from(baseSlots).where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.slot, slot)));
      if (!bound?.active || bound.baseId !== baseId) throw new Error('Fixture slot is occupied by a different base');
      await ensureStartingBase(db, wallet, baseId);
      await seedDevFantasyLocation(db, wallet, baseId, realmId as RealmId);
      await ensureBasePlotAssigned(db, wallet, baseId);
    }
    const tile = await seedDevFantasyLocation(db, wallet, baseId, realmId as RealmId);
    let wallCount = 0;
    await db.transaction(async tx => {
      await tx.update(bases).set({ keepLevel: 20, builders: CAPS.buildersMax, expansions: CAPS.expansionsMax }).where(eq(bases.id, baseId));
      await tx.update(buildings).set({ level: 20 }).where(and(eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Keep)));
      await tx.delete(buildings).where(and(eq(buildings.baseId, baseId), eq(buildings.type, BuildingType.Wall)));
      await tx.update(obstacles).set({ clearedAt: new Date() }).where(eq(obstacles.baseId, baseId));
      // Move the development convenience buildings clear of the wall specimen.
      const places: Record<string, [number, number]> = { mine: [24, 16], barracks: [24, 20], camp: [24, 24] };
      for (const [type, [x, y]] of Object.entries(places)) {
        const existing = await tx.select().from(buildings).where(and(eq(buildings.baseId, baseId), eq(buildings.type, type as BuildingType)));
        if (existing.length > 1) throw new Error('Duplicate convenience buildings require fixture reconciliation');
        if (existing[0]) await tx.update(buildings).set({ tx: x, ty: y, level: 20 }).where(eq(buildings.id, existing[0].id));
        else await tx.insert(buildings).values({ id: fantasyFixtureId(mainWallet, `${realmId}:${type}`),
          baseId, playerWallet: wallet, type: type as BuildingType, level: 20, tx: x, ty: y });
      }
      const fixed = await tx.select().from(buildings).where(eq(buildings.baseId, baseId));
      const cells = fantasyAcceptanceWalls(fixed.map(b => ({ tx: b.tx, ty: b.ty,
        ...footprintOf(b.type as BuildingType, BUILDING_GEOMETRY.candidateVersion) })), index === 0);
      wallCount = cells.length;
      await tx.insert(buildings).values(cells.map(c => ({ ...c, id: fantasyFixtureId(mainWallet, `${realmId}:wall:${c.tx}:${c.ty}`),
        type: BuildingType.Wall, playerWallet: wallet, baseId })));
      await rewardBaseShards(tx, baseId, 100_000_000n, 'local.fantasy.acceptance', `local-fantasy-acceptance-v1:${baseId}`, { syntheticFixture: realmId });
      for (let stage = 1; stage < CAMPAIGN.totalStages; stage++) await tx.insert(baseCampaignProgress).values({ baseId, stage, bestStars: CAMPAIGN.unlockStarsRequired }).onConflictDoNothing();
      await tx.insert(baseArmy).values({ baseId, troop: 'kegrunner', count: 20 }).onConflictDoUpdate({ target: [baseArmy.baseId, baseArmy.troop], set: { count: 20 } });
    });
    receipt.push({ realmId, baseId, wallet, tileId: tile.tileId, walls: wallCount, owned });
  }
  await db.update(players).set({ name: 'Fantasy QA' }).where(eq(players.wallet, mainWallet));
  await db.insert(tutorialProgress).values({ playerWallet: mainWallet, step: TUTORIAL_STEPS.ids.length - 1, completedAt: new Date(), guideSkippedAt: new Date() })
    .onConflictDoUpdate({ target: tutorialProgress.playerWallet, set: { completedAt: new Date(), guideSkippedAt: new Date(), step: TUTORIAL_STEPS.ids.length - 1 } });
  await fs.writeFile(receiptFile, JSON.stringify({ kind: 'synthetic QA; no NFT issued, no real payment', realms: receipt, solana: 'Reserved allocations remain untouched; validate its theme via explicit render fixture.' }, null, 2));
  console.log({ bases: receipt.length, owned: receipt.filter(r => r.owned).length, mainBaseId: main.id });
} finally { await sql.end(); }
