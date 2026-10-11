/** Availability is read-only advice; only the locked purchase authorizes a debit. */
import { randomUUID } from 'node:crypto';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import { FreeBasePurchaseViewSchema } from '@shardkeep/shared/freeBasePurchaseApi';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFreeBasePurchaseView } from '../src/mining/freeBasePurchaseView';
import { purchaseFreeBase } from '../src/mining/freeBasePurchase';
import { rewardBaseShards, spendBaseShards } from '../src/game/baseEconomy';
import { connectTestDb, createTestPlayer } from './helpers';
const conn = connectTestDb();
afterAll(async () => conn.sql.end());
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); });
async function fixture(funded = true) {
  const { wallet } = await createTestPlayer(conn.db), baseId = randomUUID();
  await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},${PHASE_E_FREE_BASE_POLICY.minKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
    (${wallet},${baseId},'keep',${PHASE_E_FREE_BASE_POLICY.minKeepLevel},10,10),
    (${wallet},${baseId},'workshop',${PHASE_E_FREE_BASE_POLICY.minWorkshopLevel},20,20),
    (${wallet},${baseId},'goldforge',${PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel},25,25)`;
  if (funded) await rewardBaseShards(conn.db, baseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.free_base_view', randomUUID());
  return { wallet, baseId, request: { sourceBaseId: baseId, idempotencyKey: randomUUID() } };
}
async function reason(wallet: string, baseId?: string) {
  const view = FreeBasePurchaseViewSchema.parse(await getFreeBasePurchaseView(conn.db, wallet, baseId));
  expect(view.admission.allowed).toBe(view.admission.reason === 'ready');
  return view.admission.reason;
}
describe('free base purchase availability', () => {
  it('reports exact server policy and never creates a missing balance account', async () => {
    const f = await fixture(false);
    const before = await conn.sql`select id from accounts where base_id=${f.baseId}`;
    expect(await reason(f.wallet, f.baseId)).toBe('insufficient-shards');
    expect(await conn.sql`select id from accounts where base_id=${f.baseId}`).toEqual(before);
    await rewardBaseShards(conn.db, f.baseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.ready', randomUUID());
    const view = FreeBasePurchaseViewSchema.parse(await getFreeBasePurchaseView(conn.db, f.wallet, f.baseId));
    expect(view.admission).toEqual({ allowed: true, reason: 'ready' });
    expect(view.terms).toEqual({ policyVersion: PHASE_E_FREE_BASE_POLICY.version,
      costShards: String(PHASE_E_POLICY.bases.secondFreeBaseCostShards),
      minKeepLevel: PHASE_E_FREE_BASE_POLICY.minKeepLevel, minWorkshopLevel: PHASE_E_FREE_BASE_POLICY.minWorkshopLevel,
      minGoldForgeLevel: PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel, maxFreeBases: PHASE_E_POLICY.bases.freePerWalletMax,
      maxActiveBases: PHASE_E_POLICY.bases.activePerWalletMax });
    expect(await conn.sql`select wallet from mining_free_base_purchases where wallet=${f.wallet}`).toHaveLength(0);
  });
  it('fails closed for disabled, legacy, missing, foreign, inactive or paid sources without selecting a different base', async () => {
    const f = await fixture(), other = await fixture();
    expect(await reason(f.wallet)).toBe('source-required');
    expect(await reason(f.wallet, other.baseId)).toBe('source-unavailable');
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); expect(await reason(f.wallet, f.baseId)).toBe('disabled');
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    expect(await reason(f.wallet, f.baseId)).toBe('stable-bases-required');
    vi.stubEnv('MULTI_BASE_ENABLED', 'true');
    await conn.sql`update base_slots set active=false where base_id=${f.baseId}`;
    expect(await reason(f.wallet, f.baseId)).toBe('source-unavailable');
    await conn.sql`update base_slots set active=true where base_id=${f.baseId}`;
    await conn.sql`update bases set land_paid_at=now() where id=${f.baseId}`;
    expect(await reason(f.wallet, f.baseId)).toBe('source-not-free');
  });
  it('does not count pending facilities or an occupied roster as ready', async () => {
    const f = await fixture();
    await conn.sql`update buildings set level=1 where base_id=${f.baseId} and type='keep'`;
    expect(await reason(f.wallet, f.baseId)).toBe('development-required');
    await conn.sql`update buildings set level=${PHASE_E_FREE_BASE_POLICY.minKeepLevel} where base_id=${f.baseId} and type='keep'`;
    const job = randomUUID();
    await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,finishes_at)
      select ${job},${f.wallet},${f.baseId},id,'upgrade',now() + interval '1 hour' from buildings where base_id=${f.baseId} and type='workshop'`;
    expect(await reason(f.wallet, f.baseId)).toBe('development-required');
    await conn.sql`update builder_jobs set completed_at=now() where id=${job}`;
    for (let slot = 2; slot <= PHASE_E_POLICY.bases.activePerWalletMax; slot++) {
      const base = randomUUID();
      await conn.sql`insert into bases(id,owner_wallet,land_paid_at) values(${base},${f.wallet},now())`;
      await conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},${slot},${base})`;
    }
    expect(await reason(f.wallet, f.baseId)).toBe('full-roster');
  });
  it('replays only the actor receipt after purchase, pause and custody change', async () => {
    const f = await fixture(), other = await fixture();
    const receipt = await purchaseFreeBase(conn.db, f.wallet, f.request);
    vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
    await conn.sql`update bases set owner_wallet=${other.wallet} where id=${f.baseId}`;
    const view = FreeBasePurchaseViewSchema.parse(await getFreeBasePurchaseView(conn.db, f.wallet));
    expect(view.receipt).toEqual(receipt); expect(view.admission.reason).toBe('already-purchased');
    expect((await getFreeBasePurchaseView(conn.db, other.wallet, f.baseId)).receipt).toBeNull();
  });
  it('a once-ready view cannot authorize a stale debit after the balance changes', async () => {
    const f = await fixture(); expect(await reason(f.wallet, f.baseId)).toBe('ready');
    await spendBaseShards(conn.db, f.baseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.spend', randomUUID(), {}, { progressQuests: false });
    await expect(purchaseFreeBase(conn.db, f.wallet, f.request)).rejects.toThrow();
    expect(await reason(f.wallet, f.baseId)).toBe('insufficient-shards');
    expect(await conn.sql`select wallet from mining_free_base_purchases where wallet=${f.wallet}`).toHaveLength(0);
    expect(await conn.sql`select id from bases where owner_wallet=${f.wallet}`).toHaveLength(1);
  });
});
