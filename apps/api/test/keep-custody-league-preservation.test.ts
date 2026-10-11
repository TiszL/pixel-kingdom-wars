/** Zero-KEEP league rights belong to the deed and survive custody retirement. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { LEAGUES } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../src/db/keepCustodyJournal';
import { bases, baseLeagueEntitlements, deedOwnershipObservations, leagueWeekBaseSnapshots, leagueWeekClosures } from '../src/db/schema';
import { leagueWeeklyRewards, reconcilePendingLeagueRewards } from '../src/game/leagues';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createTestPlayer, fundTestKeep } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

describe('custody retirement preserves zero-KEEP deed league rewards', () => {
  it('preserves frozen reward evidence and pays the current deed once across concurrent retries', async () => {
    const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${database}`);
    const conn = createDb(url.toString(), { max: 5 });
    vi.stubEnv('MULTI_BASE_ENABLED', 'true');
    try {
      await runMigrations(conn.db);
      const seller = await createTestPlayer(conn.db), buyer = await createTestPlayer(conn.db);
      await bootstrapSystemAccounts(conn.db);
      await fundTestKeep(conn.db, buyer.wallet, 11n, 'test.fund', randomUUID());
      const closesAt = new Date('2035-01-01T00:00:00.000Z'), week = '2034-12-25';
      const at = new Date(closesAt.getTime() + LEAGUES.settlementDelayMs);
      const tier = 'sol', keepLevel = 10, trophies = LEAGUES.thresholds[3]!;
      const rewards = leagueWeeklyRewards(tier, keepLevel);
      expect(rewards.cacheShards).toBeGreaterThan(0n);
      expect(rewards.items).toHaveLength(2);
      const [base] = await conn.db.insert(bases).values({
        ownerWallet: seller.wallet, deedAssetId: seller.wallet, status: 'active', keepLevel, landPaidAt: closesAt,
      }).returning();
      await conn.db.insert(leagueWeekClosures).values({
        week, closesAt, effectiveStartWeek: LEAGUES.rewardStartWeek,
        featureEnabledAtClose: true, rewardsEnabled: true, participantCount: 1, rewardedCount: 1,
      });
      await conn.db.insert(leagueWeekBaseSnapshots).values({
        week, baseId: base!.id, ownerWalletAtClose: seller.wallet, deedAssetId: seller.wallet,
        deedObservationSlot: 100n, deedObservationHash: 'fixture-at-close', deedObservedAt: closesAt,
        trophies, keepLevel, ratedAttacks: LEAGUES.rewardMinAttackerRaids, tier, rewardEligible: true,
      });
      await conn.db.insert(baseLeagueEntitlements).values({
        week, baseId: base!.id, tier, trophies, keepAmount: 0n, keepLevelGranted: keepLevel,
        cacheShardsGranted: rewards.cacheShards, itemsGranted: rewards.items,
      });
      // The existing 0095 rule remains authoritative; this fixture never admits
      // a legacy positive-KEEP league entitlement to make retirement pass.
      await expect(conn.sql`update base_league_entitlements set keep_amount=1 where base_id=${base!.id}`)
        .rejects.toThrow('league settlement receipts cannot grant KEEP');
      await conn.db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, base!.id));
      await conn.db.insert(deedOwnershipObservations).values({
        baseId: base!.id, assetId: seller.wallet, owner: buyer.wallet, slot: 101n,
        checkedAt: at, source: 'fixture-finalized', status: 'owned', auditHash: 'fixture-current-owner',
      });
      const [unpaid] = await conn.db.select().from(baseLeagueEntitlements);
      const earningEvidence = JSON.stringify(await conn.sql`select
        (select jsonb_agg(to_jsonb(c)) from league_week_closures c) closures,
        (select jsonb_agg(to_jsonb(s)) from league_week_base_snapshots s) snapshots`);
      const request: FixtureRetirementRequest = {
        fixtureId: randomUUID(), asOf: at.toISOString(), players: [{ wallet: buyer.wallet, keep: '11', internal: false }],
      };
      const env = { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() };
      await conn.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
      await conn.sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
      const retired = await applyFixtureL1Retirement(request, env);
      expect(retired).toMatchObject({ totalKeepConverted: '11', retirementAuthorized: false, measuredG8: true });
      expect((await conn.sql`select phase from keep_custody_cutover_state`)[0]!.phase).toBe('frozen');
      expect(await conn.db.select().from(baseLeagueEntitlements)).toEqual([unpaid]);
      expect(await conn.sql`select * from league_item_grants`).toHaveLength(0);
      expect(await conn.sql`select * from base_items`).toHaveLength(0);
      const money = async () => JSON.stringify(await conn.sql`select
        (select jsonb_agg(to_jsonb(a) order by id) from accounts a where currency in ('KEEP','GEMS')) accounts,
        (select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e join accounts a on a.id=e.account_id where a.currency in ('KEEP','GEMS')) entries,
        (select jsonb_agg(to_jsonb(t) order by t.id) from ledger_transactions t where exists
          (select 1 from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=t.id and a.currency in ('KEEP','GEMS'))) transactions`);
      const retiredMoney = await money();
      const policy = { enabled: true, startWeek: LEAGUES.rewardStartWeek };
      // Hold both workers after selecting the same unpaid row, so the second
      // attempt must exercise row-lock/receipt recovery rather than an empty scan.
      let arrivals = 0, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const hooks = { beforeGrant: async () => { if (++arrivals === 2) release(); await gate; } };
      const attempts = await Promise.all([
        reconcilePendingLeagueRewards(conn.db, at, policy, hooks),
        reconcilePendingLeagueRewards(conn.db, at, policy, hooks),
      ]);
      expect(attempts.map(r => r.failed)).toEqual([0, 0]);
      expect(attempts.reduce((n, r) => n + r.settled, 0)).toBe(1);
      expect(attempts.reduce((n, r) => n + r.replayed, 0)).toBe(1);
      const key = `league-cache:${week}:${base!.id}`;
      const receipts = await conn.sql`select * from ledger_transactions where idempotency_key=${key}`;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ type: 'league.weekly_cache', metadata: { baseId: base!.id, week, tier, keepLevel } });
      const entries = await conn.sql`select a.kind,a.currency,a.base_id,a.owner_wallet,e.delta::text
        from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${receipts[0]!.id} order by a.kind::text`;
      expect(entries).toEqual([
        { kind: 'base_shards', currency: 'SHARDS', base_id: base!.id, owner_wallet: null, delta: rewards.cacheShards.toString() },
        { kind: 'shard_genesis', currency: 'SHARDS', base_id: null, owner_wallet: null, delta: (-rewards.cacheShards).toString() },
      ]);
      expect(await conn.sql`select a.balance::text,b.owner_wallet from accounts a join bases b on b.id=a.base_id where a.kind='base_shards'`)
        .toEqual([{ balance: rewards.cacheShards.toString(), owner_wallet: buyer.wallet }]);
      const expectedItems = [...rewards.items].sort((a, b) => a.itemId < b.itemId ? -1 : 1);
      expect(await conn.sql`select item_id as "itemId",qty from base_items where base_id=${base!.id} order by item_id`).toEqual(expectedItems);
      const grants = await conn.sql`select week::text,base_id,item_id,qty,granted_at from league_item_grants order by item_id`;
      expect(grants.map(grant => ({ ...grant, granted_at: new Date(String(grant.granted_at)) }))).toEqual(expectedItems.map(item => ({
        week, base_id: base!.id, item_id: item.itemId, qty: item.qty, granted_at: at,
      })));
      const [paid] = await conn.db.select().from(baseLeagueEntitlements);
      expect(paid).toEqual({ ...unpaid, lastAttemptAt: at, paidAt: at });
      expect(JSON.stringify(await conn.sql`select
        (select jsonb_agg(to_jsonb(c)) from league_week_closures c) closures,
        (select jsonb_agg(to_jsonb(s)) from league_week_base_snapshots s) snapshots`)).toBe(earningEvidence);
      expect(await money()).toBe(retiredMoney);
      const settledState = async () => JSON.stringify(await conn.sql`select
        (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
        (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
        (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
        (select jsonb_agg(to_jsonb(i) order by item_id) from base_items i) items,
        (select jsonb_agg(to_jsonb(g) order by item_id) from league_item_grants g) grants,
        (select jsonb_agg(to_jsonb(r)) from base_league_entitlements r) entitlements,
        (select jsonb_agg(to_jsonb(j)) from keep_custody_journal j) retirement`);
      const settled = await settledState();
      expect(await reconcilePendingLeagueRewards(conn.db, new Date(at.getTime() + 1), policy))
        .toMatchObject({ settled: 0, failed: 0, cacheShards: 0n, items: 0 });
      expect(await applyFixtureL1Retirement(request, env)).toEqual(retired);
      expect(await settledState()).toBe(settled);
    } finally {
      vi.unstubAllEnvs();
      await conn.sql.end();
      await admin.unsafe(`drop database if exists ${database} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
