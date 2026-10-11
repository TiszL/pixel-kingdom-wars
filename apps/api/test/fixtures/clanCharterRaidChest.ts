/** B6p DB adapter fixture. Admissions and clan operations use real services;
 * settlement uses real ledger/posting/terminal statements with synthetic gross
 * loot. It does not run the protected submitOrders integration or a simulator. */
import { randomUUID } from 'node:crypto';
import { CLANS, STRUCTURES } from '@shardkeep/shared';
import { eq, sql } from 'drizzle-orm';
import { vi } from 'vitest';
import type { DbTx } from '../../src/db/client';
import { clans } from '../../src/db/schema';
import { completeDueTraining } from '../../src/game/army';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../../src/game/base';
import { createClan } from '../../src/game/clans';
import { createClanCharterRaidChest, resolveOriginalClanRaidChest,
  assertOriginalClanRaidChestPosting } from '../../src/game/clanCharterRaidChest';
import { batchOrdersSubmitDeadlineAt, createRaid, getRaidEnergy } from '../../src/game/raids';
import { rewardShards } from '../../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../../src/ledger';
import { createTestPlayer, fundTestKeep } from '../helpers';
import { trainTroop } from '../training-consent';
import { resourceClaimsDatabase } from './resourceClaimsDatabase';

export const raidChestKey = () => randomUUID();
const future = (minutes: number) => new Date(Date.now() + minutes * 60_000);
export function raidChestFixture() {
  const f = resourceClaimsDatabase();
  const service = () => createClanCharterRaidChest(f.db);
  async function funded() {
    const p = await createTestPlayer(f.db);
    await rewardShards(f.db, p.wallet, BigInt(CLANS.createCostShards) * 20n,
      'test.raid-chest.opening', raidChestKey());
    return p;
  }
  async function clan(wallet: string) {
    return createClan(f.db, wallet, { name: 'Clan ' + raidChestKey().slice(0, 8),
      tag: raidChestKey().slice(0, CLANS.tagMaxLen).toUpperCase() }, raidChestKey());
  }
  async function attacker(troop: 'highlander' | 'turrider' = 'highlander') {
    const p = await funded();
    await fundTestKeep(f.db, p.wallet, 1_000_000n, 'test.raid-chest.keep', raidChestKey());
    await ensureStartingBase(f.db, p.wallet);
    await placeBuilding(f.db, p.wallet, 'barracks' as never, 17, 17, raidChestKey());
    await completeDueJobs(f.db, p.wallet, future(120));
    await placeBuilding(f.db, p.wallet, 'camp' as never, 19, 19, raidChestKey());
    await completeDueJobs(f.db, p.wallet, future(240));
    for (let i = 0; i < (troop === 'turrider' ? 4 : 1); i++) {
      await trainTroop(f.db, p.wallet, troop, raidChestKey(), future(300 + i * 10));
      await completeDueTraining(f.db, p.wallet, future(310 + i * 10));
    }
    return p;
  }
  async function defender() {
    const p = await createTestPlayer(f.db);
    await ensureStartingBase(f.db, p.wallet);
    await rewardShards(f.db, p.wallet, BigInt(STRUCTURES.vault.capacity[0]!) + 50_000n,
      'test.raid-chest.defender', raidChestKey());
    await completeDueJobs(f.db, p.wallet, future(120));
    return p;
  }
  async function initialize() {
    vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
    try { return await service().initializeRule(); }
    finally { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false'); }
  }
  const admit = (wallet: string, target: string) => createRaid(f.db, wallet,
    { defenderWallet: target, idempotencyKey: raidChestKey() });
  async function settlement(tx: DbTx, raidId: string, gross: bigint) {
    const [r] = await tx.execute<{ attacker_wallet: string; defender_wallet: string; status: string }>(sql`
      select attacker_wallet,defender_wallet,status from raids where id=${raidId} for update`);
    if (!r || r.status !== 'pending_orders') throw Error('Fixture expects an unsettled legacy raid');
    await tx.execute(sql`update raids set status='resolving' where id=${raidId}`);
    const sys = await bootstrapSystemAccounts(tx);
    const a = await getOrCreatePlayerAccount(tx, r.attacker_wallet, 'player_shards');
    const d = await getOrCreatePlayerAccount(tx, r.defender_wallet, 'player_shards');
    // The real caller already holds sorted money locks before resolving clan.
    await tx.execute(sql`select id from accounts where id in (${a.id},${d.id},${sys.clan_chest}) order by id for update`);
    const route = await resolveOriginalClanRaidChest(tx, raidId, r.attacker_wallet, gross);
    let ledgerId: string | null = null;
    if (gross > 0n) {
      const p = await postTransaction(tx, { idempotencyKey: `raid:${raidId}:loot`, type: 'raid.loot',
        entries: [{ account: d.id, delta: -gross }, { account: a.id, delta: gross - route.chestCut },
          ...(route.chestCut > 0n ? [{ account: sys.clan_chest, delta: route.chestCut }] : [])],
        metadata: { raidId, attacker: r.attacker_wallet, defender: r.defender_wallet, clanChest: String(route.chestCut) } });
      ledgerId = p.transaction.id;
      if (route.chestCut > 0n && route.clanId !== null && !p.duplicate) {
        const changed = await tx.update(clans).set({ chestShards: sql`${clans.chestShards}+${route.chestCut}` })
          .where(eq(clans.id, route.clanId)).returning({ id: clans.id });
        if (changed.length !== 1) throw Error('Fixture attribution lost its locked clan');
      }
      await assertOriginalClanRaidChestPosting(tx, raidId, ledgerId);
    }
    await tx.execute(sql`update raids set status='resolved',resolved_at=now(),
      result=jsonb_build_object('lootShards',${String(gross - route.chestCut)}::numeric) where id=${raidId}`);
    return { ...route, ledgerId };
  }
  const settle = (raidId: string, gross: bigint) => f.db.transaction(tx => settlement(tx, raidId, gross),
    { isolationLevel: 'read committed' });
  async function expire(raid: Awaited<ReturnType<typeof admit>>, wallet: string) {
    await getRaidEnergy(f.db, wallet, new Date(batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt).getTime() + 1));
  }
  const entries = (raidId: string) => f.sql`select e.id::text,e.delta::text,a.id account_id,a.kind::text,a.owner_wallet
    from ledger_entries e join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id
    where t.idempotency_key=${'raid:' + raidId + ':loot'} order by e.id`;
  const money = () => f.sql`select id,balance::text from accounts order by id`;
  return { ...f, service, funded, clan, attacker, defender, initialize, admit, settlement, settle, expire, entries, money };
}
export type RaidChestFixture = ReturnType<typeof raidChestFixture>;

/** Inspect PostgreSQL itself; Drizzle's query text can contain fixture labels. */
export function raidChestPg(error: unknown): { code: string; message: string } | null {
  let e: unknown = error;
  for (let i = 0; i < 12 && e && typeof e === 'object'; i++) {
    const r = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof r.code === 'string' && /^[0-9A-Z]{5}$/.test(r.code) && typeof r.message === 'string')
      return { code: r.code, message: r.message };
    e = r.cause;
  }
  return null;
}
