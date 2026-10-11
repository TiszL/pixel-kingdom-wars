/** Real newly settled proofs and immutable captures. Only the legacy SQL-NULL
 * reader mapping is mocked; its original pre-migration proof is accepted prior evidence. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BoundCosmeticWakePreferenceResponseSchema } from '@shardkeep/shared/boundCosmeticWake';
import { matchFleetJourneyEventBatch } from '@shardkeep/shared/fleetJourneyPresentation';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DbTx } from '../src/db/client';
import { readNewStarterReturnJourneyEvents, readNewAdvancedReturnJourneyEvents } from '../src/game/fleetJourneyPresentation';
import * as wake from '../src/game/boundCosmeticWakePresentation';
import { settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { dispatchStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { settleDueAdvancedExpeditions } from '../src/game/advancedExpeditionReturns';
import { createAdvancedExpeditionWorkflow } from '../src/game/advancedExpeditionWorkflow';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { boundCosmeticFixture, earnBoundBlueprint, cosmeticMaterials, cosmeticInsert } from './fixtures/boundCosmetics';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { vehicleServiceExpeditions } from './fixtures/vehicleService';

const conn = resourceClaimsDatabase(), db = conn.db;
const off = { state: 'available', visual: { version: 1, wake: null } };
beforeAll(() => conn.setup(), 180_000);
afterAll(() => conn.close());
beforeEach(() => {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_CATALOG_ENABLED',
    'ORDINARY_CRAFTING_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'STARTER_EXPEDITIONS_ENABLED']) vi.stubEnv(flag, 'true');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
const clock = (at: Date) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); };
async function locked<T>(wallet: string, baseId: string, run: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
    await tx.execute(sql`select id from bases where id=${baseId} for update`);
    await tx.execute(sql`select base_id from base_slots where base_id=${baseId} for update`);
    return run(tx);
  });
}
async function starter(wallet?: string, at = new Date(Date.now() - 86_400_000)) {
  clock(at);
  return createStarterExpeditionFixture(db, { now: at, ...(wallet ? { wallet } : {}) });
}
async function advanced() {
  const f = await vehicleBurnDatabase('survey_balloon', 1, {}, { connection: conn, completedAt: new Date(Date.now() - 7 * 86_400_000) });
  f.finalizeBurn();
  await createVehicleInstallations(db, { verifyBurn: f.reader.verify }).recover(f.actor, f.reservation.id);
  return { ...f, trips: await vehicleServiceExpeditions(f) };
}

it('projects only this starter settlement and preserves captured Off without publishing private receipt facts', async () => {
  const f = await starter(), trip = await f.dispatch();
  const events = await locked(f.wallet, f.baseId, async tx => {
    const proofs = await settleDueStarterExpeditions(tx, f.baseId, trip.returnsAt);
    expect(proofs).toHaveLength(1);
    return readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId, proofs);
  });
  expect(events).toEqual([{ version: 1, kind: 'return', baseId: f.baseId, berthId: f.berthId,
    installationId: f.installationId, expeditionId: trip.id, returnId: expect.any(String),
    at: trip.returnsAt.toISOString(), vehicle: { family: 'starter' }, wake: off }]);
  expect(matchFleetJourneyEventBatch({ version: 1, events }, f.baseId).events).toEqual(events);
  for (const hidden of [f.wallet, trip.termId, trip.termHash, 'actorWallet', 'entries', 'custodyWallet', 'net', 'routeSnapshot'])
    expect(JSON.stringify(events)).not.toContain(hidden);
  expect(await locked(f.wallet, f.baseId, async tx => readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId,
    await settleDueStarterExpeditions(tx, f.baseId, trip.returnsAt)))).toEqual([]);
});

it('binds an actual selected original Wake after preference changes and current-owner transfer without seller disclosure', async () => {
  const ornament = await boundCosmeticFixture(db, { slot: 2 });
  ornament.now = new Date(Date.now() - 3 * 86_400_000);
  await conn.sql`update builder_jobs set started_at=started_at-interval '20 years',finishes_at=finishes_at-interval '20 years',completed_at=completed_at-interval '20 years' where base_id=${ornament.baseId}`;
  await earnBoundBlueprint(ornament); await cosmeticMaterials(ornament, 'craft_aurora_wake_v1');
  const job = await cosmeticInsert(ornament, 'craft_aurora_wake_v1');
  await conn.sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()})`;
  const [preference] = await conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${ornament.wallet},true,0,${job.readyAt.toISOString()}::timestamptz) response`;
  const selected = BoundCosmeticWakePreferenceResponseSchema.parse(preference!.response);
  const f = await starter(ornament.wallet, new Date(+job.readyAt + 1000)), trip = await f.dispatch();
  await conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${f.wallet},false,1,${new Date(+f.now + 1).toISOString()}::timestamptz)`;
  const buyer = Keypair.generate().publicKey.toBase58();
  await conn.sql`insert into players(wallet) values(${buyer})`;
  await conn.sql.begin(async tx => {
    await tx`select wallet from players where wallet in(${f.wallet},${buyer}) order by wallet for update`;
    await tx`select id from bases where id=${f.baseId} for update`;
    await tx`delete from base_slots where base_id=${f.baseId}`;
    await tx`update bases set owner_wallet=${buyer} where id=${f.baseId}`;
    await tx`insert into base_slots(wallet,slot,base_id) values(${buyer},1,${f.baseId})`;
  });
  const events = await locked(buyer, f.baseId, async tx => {
    const proofs = await settleDueStarterExpeditions(tx, f.baseId, trip.returnsAt);
    await expect(readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId, proofs)).rejects.toThrow('currently owned');
    return readNewStarterReturnJourneyEvents(tx, buyer, f.baseId, proofs);
  });
  expect(events[0]!.wake).toEqual(selected.visual);
  for (const hidden of [f.wallet, buyer, job.id, trip.termId, trip.termHash]) expect(JSON.stringify(events)).not.toContain(hidden);
});

it('keeps actual unavailable capture distinct from the accepted legacy-reader mapper case', async () => {
  const f = await starter();
  const trip = await db.transaction(async tx => {
    await tx.execute(sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`);
    const row = await dispatchStarterExpedition(tx, f.wallet, f.command, f.authority, { reader: f.reader, clock: () => f.now });
    await tx.execute(sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`);
    return row;
  });
  const held = await locked(f.wallet, f.baseId, async tx => readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId,
    await settleDueStarterExpeditions(tx, f.baseId, trip.returnsAt)));
  expect(held[0]!.wake).toEqual({ state: 'unavailable', visual: null });
  // Mapping-only: accepted legacy source evidence predates this package. Do not
  // mutate an immutable modern capture or claim a historical migration replay.
  const legacy = await starter(), original = await legacy.dispatch();
  const reader = vi.spyOn(wake, 'boundCosmeticWakeFields').mockResolvedValue({});
  const mapped = await locked(legacy.wallet, legacy.baseId, async tx => readNewStarterReturnJourneyEvents(tx, legacy.wallet, legacy.baseId,
    await settleDueStarterExpeditions(tx, legacy.baseId, original.returnsAt)));
  expect(mapped[0]!.wake).toEqual({ state: 'legacy', visual: null });
  expect(reader).toHaveBeenCalledOnce();
});

it('refuses mismatched base, source and installation, and never publishes a return from a rejected outer transaction', async () => {
  const f = await starter(), trip = await f.dispatch();
  await expect(readNewStarterReturnJourneyEvents(db as unknown as DbTx, f.wallet, f.baseId, [])).rejects.toThrow('existing transaction');
  await expect(locked(f.wallet, f.baseId, async tx => {
    const proofs = await settleDueStarterExpeditions(tx, f.baseId, trip.returnsAt), proof = proofs[0]!;
    await expect(readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId,
      [{ ...proof, expedition: { ...proof.expedition, baseId: randomUUID() } }])).rejects.toThrow('new source proof');
    await expect(readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId,
      [{ ...proof, expedition: { ...proof.expedition, installationId: randomUUID() } }])).rejects.toThrow('settled original');
    await expect(readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId,
      [{ ...proof, receipt: { ...proof.receipt, id: randomUUID() } }])).rejects.toThrow('settled original');
    expect(await readNewStarterReturnJourneyEvents(tx, f.wallet, f.baseId, proofs)).toHaveLength(1);
    throw Error('Synthetic outer read failure');
  })).rejects.toThrow('Synthetic outer read failure');
  expect(await conn.sql`select id from starter_expedition_returns where expedition_id=${trip.id}`).toEqual([]);
  expect(await conn.sql`select expedition_id from starter_expedition_inflight where expedition_id=${trip.id}`).toHaveLength(1);
});

it('commits the advanced collection and its original-Wake events together, with no event on repeated collection', async () => {
  const f = await advanced(), trip = await f.trips.depart(); clock(trip.returnsAt);
  const service = createAdvancedExpeditionWorkflow(db);
  const result = await service.collectWithPresentation(f.actor, f.baseId);
  expect(result.collection).toEqual({ baseId: f.baseId, serverNow: trip.returnsAt.toISOString(), returned: 1 });
  expect(result.events).toEqual([{ version: 1, kind: 'return', baseId: f.baseId, berthId: f.berthId,
    installationId: f.reservation.id, expeditionId: trip.id, returnId: expect.any(String),
    at: trip.returnsAt.toISOString(), vehicle: { family: 'survey_balloon', tier: 1 }, wake: off }]);
  for (const hidden of [f.actor, trip.termId, trip.termHash, 'completedTotal', 'entries', 'net', 'custodyWallet'])
    expect(JSON.stringify(result.events)).not.toContain(hidden);
  expect(await service.collectWithPresentation(f.actor, f.baseId)).toEqual({
    collection: { baseId: f.baseId, serverNow: trip.returnsAt.toISOString(), returned: 0 }, events: [],
  });
  expect(await locked(f.actor, f.baseId, async tx => readNewAdvancedReturnJourneyEvents(tx, f.actor, f.baseId,
    await settleDueAdvancedExpeditions(tx, f.baseId, trip.returnsAt)))).toEqual([]);
});

it('leaves legacy advanced collection independent of presentation and rolls optional collector failures back', async () => {
  const f = await advanced(), trip = await f.trips.depart(); clock(trip.returnsAt);
  const source = vi.spyOn(wake, 'boundCosmeticWakeFields').mockRejectedValue(Error('Synthetic mandatory reader error'));
  const service = createAdvancedExpeditionWorkflow(db);
  await expect(service.collectWithPresentation(f.actor, f.baseId)).rejects.toThrow('Synthetic mandatory reader error');
  expect(await conn.sql`select id from advanced_expedition_returns where expedition_id=${trip.id}`).toEqual([]);
  source.mockClear();
  expect(await service.collect(f.actor, f.baseId)).toEqual({ baseId: f.baseId, serverNow: trip.returnsAt.toISOString(), returned: 1 });
  expect(source).not.toHaveBeenCalled();
});
