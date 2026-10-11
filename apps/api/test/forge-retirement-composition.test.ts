/** The final Forge liability must come from actual contribution/settlement,
 * never a fixture-authored settled position or a fabricated allocation receipt.
 * Opening stock/reserve and finalized deed ownership are explicit local fixtures;
 * this does not authenticate a historical production census or authorize F. */
import { randomUUID } from 'node:crypto';
import { FORGE, GEMS } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../src/db/keepCustodyJournal';
import { census } from '../src/db/keepCustodyRetire';
import { baseForgePositions, baseRaidLocks, bases, baseSlots, buildings, deedOwnershipObservations, raids } from '../src/db/schema';
import { computeBaseForgeDrops, contributeToForge, forgeDayOf, settleForgeDay, type ForgeStableBaseContext } from '../src/game/forge';
import { releaseDeedRaidLoot, reserveDeedRaidLoot } from '../src/game/raidLoot';
import { spendGems } from '../src/game/spend';
import { getOrCreateBaseAccount, postTransaction } from '../src/ledger';
import { getProofOfReserves } from '../src/money/snapshot';
import { createTestPlayer } from './helpers';
import { custodyWithdrawalDrainFixture, DRAIN_GROSS, leaf, type CustodyWithdrawalDrainFixture } from './fixtures/custodyWithdrawalDrain';

let active: CustodyWithdrawalDrainFixture | undefined;
beforeEach(async () => {
  vi.stubEnv('WITHDRAWALS_ENABLED', 'true');
  vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  active = await custodyWithdrawalDrainFixture();
}, 90_000);
afterEach(async () => {
  const owned = active; active = undefined;
  try { await owned?.dispose(); } finally { vi.unstubAllEnvs(); }
}, 90_000);
function fixture(): CustodyWithdrawalDrainFixture {
  if (!active) throw Error('Forge retirement fixture is unavailable');
  return active;
}

async function opening() {
  const f = fixture(), wallet = f.first.wallet, deed = Keypair.generate().publicKey.toBase58();
  // An injected completed UTC day avoids a real-time waiting requirement.
  const contributedAt = new Date(Date.now() - 86_400_000), day = forgeDayOf(contributedAt);
  // Select an opening identity with a real deterministic drop, so preservation
  // cannot pass vacuously. Settlement still creates every item itself.
  const baseId = Array.from({ length: 256 }, (_, index) =>
    `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`)
    .find(id => computeBaseForgeDrops(day, id).length > 0);
  if (!baseId) throw Error('No positive Forge drop fixture identity found');
  const [base] = await f.db.insert(bases).values({ id: baseId, ownerWallet: wallet, status: 'active',
    deedAssetId: deed, deedMintAssetId: deed, landPaidAt: contributedAt, keepLevel: 1 }).returning();
  if (!base) throw Error('Fixture base was not created');
  await f.db.insert(baseSlots).values({ wallet, slot: 1, baseId: base.id });
  await f.db.insert(buildings).values({ playerWallet: wallet, baseId: base.id,
    type: 'goldforge', level: 1, tx: 20, ty: 20 });
  const stock = await getOrCreateBaseAccount(f.db, base.id, 'base_shards');
  const stake = BigInt(FORGE.contributionCapByLevel[1]!);
  const reserve = BigInt(FORGE.dailyEmissionKeep);
  await postTransaction(f.db, { idempotencyKey: randomUUID(), type: 'fixture.forge-retirement.opening',
    metadata: { purpose: 'local opening stock and finite emission reserve; no historical production source' }, entries: [
      { account: f.sys.shard_genesis, delta: -2n * stake }, { account: stock.id, delta: 2n * stake },
      { account: f.sys.keep_genesis, delta: -reserve }, { account: f.sys.emission_pool, delta: reserve },
    ] });
  const authority: ForgeStableBaseContext = { baseId: base.id,
    assertActiveAuthority: async (tx, actor) => tx.select({ id: bases.id, landPaidAt: bases.landPaidAt })
      .from(bases).where(and(eq(bases.id, base.id), eq(bases.ownerWallet, actor),
        eq(bases.deedAssetId, deed), eq(bases.status, 'active'))).for('update'),
  };
  const contributionKey = randomUUID();
  const contribute = (key = contributionKey, at = contributedAt, amount = stake) =>
    contributeToForge(f.db, wallet, amount, key, at, base.id, authority);
  await contribute();
  const position = async () => {
    const [row] = await f.db.select().from(baseForgePositions)
      .where(and(eq(baseForgePositions.baseId, base.id), eq(baseForgePositions.day, day)));
    if (!row) throw Error('Actual contribution position missing'); return row;
  };
  // Independent D035 arithmetic for this single-deed day, not a copied after-state.
  const denominator = stake > BigInt(FORGE.softCapShards) ? stake : BigInt(FORGE.softCapShards);
  const payout = reserve * stake / denominator;
  expect(payout).toBeGreaterThan(0n);
  return { f, wallet, baseId: base.id, deed, day, stake, reserve, payout, contribute, position };
}
type Opening = Awaited<ReturnType<typeof opening>>;

async function snapshot(f: CustodyWithdrawalDrainFixture) {
  return JSON.stringify({ money: await f.snapshot(), state: await f.sql`select
    (select jsonb_agg(to_jsonb(p) order by id) from base_forge_positions p) positions,
    (select jsonb_agg(to_jsonb(i) order by id) from base_items i) items,
    (select jsonb_agg(to_jsonb(r) order by raid_id) from raid_loot_reservations r) reservations,
    (select jsonb_agg(to_jsonb(l) order by base_id) from base_raid_locks l) locks,
    (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_journal j) journals` });
}
async function retirementRequest(o: Opening): Promise<FixtureRetirementRequest> {
  const position = await o.position(), asOf = new Date().toISOString();
  if (position.keepPaid === null) throw Error('Actual Forge settlement is required');
  await o.f.db.insert(deedOwnershipObservations).values({ baseId: o.baseId, assetId: o.deed,
    owner: o.wallet, slot: 100n, checkedAt: new Date(asOf), source: 'fixture-finalized',
    status: 'owned', auditHash: 'fixture-final-forge-observation' });
  return { fixtureId: randomUUID(), asOf,
    players: [{ wallet: o.wallet, keep: DRAIN_GROSS.toString(), internal: false }],
    forge: [{ positionId: position.id, baseId: o.baseId, day: o.day,
      wallet: o.wallet, keep: position.keepPaid.toString(), internal: false }],
  };
}
async function assertSettled(o: Opening) {
  const position = await o.position();
  expect(position).toMatchObject({ contributedShards: o.stake, raidDebitedShards: 0n,
    countedShards: o.stake, shardsRefunded: 0n, keepPaid: o.payout,
    settlementOwnerWallet: o.wallet, itemsDropped: computeBaseForgeDrops(o.day, o.baseId),
    claimedAt: null, claimTxnId: null, expiredAt: null });
  expect(position.keepEscrowTxnId).not.toBeNull(); expect(position.shardSettlementTxnId).not.toBeNull();
  expect(await o.f.balance('emission_pool')).toBe(o.reserve - o.payout);
  expect(await o.f.balance('forge_payout_escrow')).toBe(o.payout);
  expect(await o.f.balance('base_forge_escrow')).toBe(0n);
  expect(await o.f.balance('base_shards')).toBe(o.stake);
  expect(await o.f.balance('shard_burn')).toBe(o.stake);
  return position;
}

describe('actual final Forge settlement into custody retirement', () => {
  it('retires the actual final allocation and drained withdrawal exactly once, preserving source receipts and items', async () => {
    const o = await opening(), { f } = o;
    const contributed = await snapshot(f); await o.contribute();
    expect(await snapshot(f)).toBe(contributed);
    expect(await o.position()).toMatchObject({ settledAt: null, keepEscrowTxnId: null });
    await f.fence(); const drained = await f.apply();
    expect(drained.totalKeepReturned).toBe(DRAIN_GROSS.toString());
    const beforeSettle = await snapshot(f);
    await expect(f.retire()).rejects.toThrow('CUSTODY_UNSUPPORTED_STATE');
    expect(await snapshot(f)).toBe(beforeSettle);

    await settleForgeDay(f.db, o.day, new Date());
    const position = await assertSettled(o), settled = await snapshot(f);
    await settleForgeDay(f.db, o.day, new Date());
    expect(await snapshot(f)).toBe(settled);
    const keepReceipt = await f.receipt(position.keepEscrowTxnId!);
    const shardReceipt = await f.receipt(position.shardSettlementTxnId!);
    const items = await f.sql`select * from base_items order by id`;
    expect(items.length).toBeGreaterThan(0);
    const request = await retirementRequest(o), total = DRAIN_GROSS + o.payout;
    const result = await applyFixtureL1Retirement(request, f.env);
    expect(result).toMatchObject({ fixtureOnly: true, retirementAuthorized: false,
      measuredG8: true, totalKeepConverted: total.toString(), sweptInternalKeep: '0' });
    expect(result.releaseEvidence.every(e => e.status === 'unverified')).toBe(true);
    expect(await f.balance('player_gems', o.wallet)).toBe(total * BigInt(GEMS.gemsPerKeep));
    expect(await f.balance('emission_pool')).toBe(o.reserve + DRAIN_GROSS);
    for (const kind of ['player_keep', 'withdrawal_escrow', 'forge_payout_escrow', 'mail_keep_escrow', 'league_entitlement_escrow']) {
      expect(await f.balance(kind, kind === 'player_keep' ? o.wallet : null)).toBe(0n);
    }
    expect(await f.receipt(position.keepEscrowTxnId!)).toEqual(keepReceipt);
    expect(await f.receipt(position.shardSettlementTxnId!)).toEqual(shardReceipt);
    expect(await f.sql`select * from base_items order by id`).toEqual(items);
    expect(await f.sql`select a.currency from ledger_entries e join accounts a on a.id=e.account_id
      group by a.currency having sum(e.delta)<>0`).toHaveLength(0);
    expect((await getProofOfReserves(f.db)).custodyTransition).toMatchObject({ phase: 'frozen', reserveAttested: false });

    await spendGems(f.db, o.wallet, 1n, 'test.forge-retirement.spend', randomUUID());
    const retired = await snapshot(f);
    expect(await applyFixtureL1Retirement(request, f.env)).toEqual(result);
    expect(await f.apply()).toEqual(drained);
    await settleForgeDay(f.db, o.day, new Date());
    expect(await snapshot(f)).toBe(retired);
    await expect(o.contribute(randomUUID(), new Date(), 1n).catch(leaf))
      .resolves.toMatchObject({ message: 'KEEP_CUSTODY_FROZEN' });
    expect(await snapshot(f)).toBe(retired);
  }, 90_000);

  it('holds final settlement and F while real Forge raid stock is reserved, then releases and settles without losing backing', async () => {
    const o = await opening(), { f } = o, attacker = await createTestPlayer(f.db);
    const [attackerBase] = await f.db.insert(bases).values({ ownerWallet: attacker.wallet, status: 'active', keepLevel: 1 }).returning();
    if (!attackerBase) throw Error('Fixture attacker base missing');
    const now = new Date();
    const [raid] = await f.db.insert(raids).values({ idempotencyKey: randomUUID(),
      attackerWallet: attacker.wallet, attackerBaseId: attackerBase.id,
      defenderWallet: o.wallet, defenderBaseId: o.baseId, seed: 1n, snapshot: {}, armySnapshot: {},
      simVersion: 9, ordersDeadlineAt: new Date(+now + 60_000) }).returning();
    if (!raid) throw Error('Fixture raid missing');
    await f.db.insert(baseRaidLocks).values({ baseId: o.baseId, raidId: raid.id, expiresAt: new Date(+now + 120_000) });
    await reserveDeedRaidLoot(f.db, { raidId: raid.id, attackerBaseId: attackerBase.id, defenderBaseId: o.baseId, now });
    const [reservation] = await f.sql`select forge_reserved_shards::text amount from raid_loot_reservations where raid_id=${raid.id}`;
    expect(BigInt(reservation!.amount)).toBeGreaterThan(0n);
    expect(await f.balance('base_forge_escrow') + BigInt(reservation!.amount)).toBe(o.stake);
    await f.fence(); await f.apply();
    const held = await snapshot(f);
    await settleForgeDay(f.db, o.day, new Date());
    expect(await snapshot(f)).toBe(held);
    expect(await o.position()).toMatchObject({ settledAt: null, keepPaid: null });
    const report = await f.db.transaction(tx => census(tx, new Date(), []));
    expect(report.blockers).toContain('FORGE_RAID_RESERVATIONS_OPEN');
    await expect(f.retire()).rejects.toThrow('CUSTODY_UNSUPPORTED_STATE');
    expect(await snapshot(f)).toBe(held);

    expect(await releaseDeedRaidLoot(f.db, raid.id, new Date())).toBe(true);
    expect(await f.balance('base_forge_escrow')).toBe(o.stake);
    expect(await f.balance('raid_loot_escrow')).toBe(0n);
    const released = await snapshot(f);
    expect(await releaseDeedRaidLoot(f.db, raid.id, new Date())).toBe(true);
    expect(await snapshot(f)).toBe(released);
    await settleForgeDay(f.db, o.day, new Date()); await assertSettled(o);
    const request = await retirementRequest(o);
    expect(await applyFixtureL1Retirement(request, f.env)).toMatchObject({ measuredG8: true,
      totalKeepConverted: (DRAIN_GROSS + o.payout).toString() });
    expect(await f.balance('emission_pool')).toBe(o.reserve + DRAIN_GROSS);
    expect(await f.sql`select state from raid_loot_reservations where raid_id=${raid.id}`).toEqual([{ state: 'released' }]);
    expect(await f.sql`select * from base_raid_locks where raid_id=${raid.id}`).toHaveLength(0);
  }, 90_000);
});
