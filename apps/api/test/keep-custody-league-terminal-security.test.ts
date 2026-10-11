import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFixtureL1Retirement } from '../src/db/keepCustodyJournal';
import { getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { custodyLeagueFixture, leaf, WEEKS, type CustodyLeagueFixture } from './fixtures/custodyLeague';

let f: CustodyLeagueFixture;
beforeEach(async () => { f = await custodyLeagueFixture(); }, 60_000);
afterEach(async () => { await f?.dispose(); });

async function ready() {
  await f.capture(); await f.migrateAll();
  const at = new Date().toISOString(); await f.authorizeBuyer(at); await f.closeCustody();
  return f.retirementRequest(at);
}
async function snapshot() {
  return JSON.stringify({ money: await f.money(), state: await f.sql`select
    (select jsonb_agg(to_jsonb(z) order by week,base_id) from keep_custody_league_retirements z) retirements,
    (select jsonb_agg(to_jsonb(j)) from keep_custody_journal j) journal,
    (select phase from keep_custody_cutover_state) phase` });
}

// The real retirement's source/ledger barrier is required even for these raw
// owner attacks. A missing barrier must not disguise an orphan-pairing failure.
const barrier = sql`lock table ledger_transactions,accounts,ledger_entries,players,bases,base_slots,
  deed_ownership_observations,base_forge_positions,forge_contributions,raid_loot_reservations,base_raid_locks,
  mail_messages,mail_attachments,base_league_entitlements,withdrawals,withdrawal_attempts,withdrawal_payout_reservations,
  deposits,player_items,item_listings,keep_custody_journal,mail_keep_retirements,
  keep_custody_league_bridge,keep_custody_league_weeks,keep_custody_league_retirements in access exclusive mode nowait`;

describe('atomic original league retirement', () => {
  it('sweeps an internal current owner entitlement without minting or taxing Gems', async () => {
    const request = await ready(); request.league![0]!.internal = true;
    const result = await applyFixtureL1Retirement(request, { ...f.env, ALPHA_WALLETS: f.buyer });
    expect(result).toMatchObject({ measuredG8: true, totalKeepConverted: '600', sweptInternalKeep: '240' });
    expect(await f.balance('player_gems', f.buyer)).toBe(0n);
    expect(await f.balance('player_gems', f.seller)).toBe(600n);
    expect(await f.balance('league_entitlement_escrow')).toBe(0n);
    expect(await f.balance('league_pool')).toBe(160n);
    const rows = await f.sql`select t.type,t.metadata,a.kind::text,a.currency::text,e.delta::text
      from ledger_transactions t join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id
      where t.idempotency_key=${`league:retire:${f.baseId}:${WEEKS[1]}`} order by a.kind::text`;
    expect(rows).toEqual([
      { type: 'gems.retirement.sweep', metadata: { wallet: f.buyer, keep: '240', reason: 'internal-wallet', fixtureId: request.fixtureId, week: WEEKS[1], baseId: f.baseId }, kind: 'emission_pool', currency: 'KEEP', delta: '240' },
      { type: 'gems.retirement.sweep', metadata: { wallet: f.buyer, keep: '240', reason: 'internal-wallet', fixtureId: request.fixtureId, week: WEEKS[1], baseId: f.baseId }, kind: 'league_entitlement_escrow', currency: 'KEEP', delta: '-240' },
    ]);
    const before = await snapshot();
    expect(await applyFixtureL1Retirement(request, { ...f.env, ALPHA_WALLETS: f.buyer })).toEqual(result);
    expect(await snapshot()).toBe(before);
  }, 60_000);

  it('holds stale or adverse current evidence, including deferred loss, but permits a fresh inactive owned base', async () => {
    await ready();
    for (const defect of ['stale', 'ineligible', 'unavailable', 'asset', 'slot', 'deferred-loss'] as const) {
      const at = new Date().toISOString();
      await f.sql`delete from deed_ownership_observations where base_id=${f.baseId}`;
      await f.authorizeBuyer(at);
      if (defect === 'stale') await f.sql`update deed_ownership_observations set checked_at=${new Date(Date.parse(at) - BASE_OWNERSHIP.mutationFreshnessMs - 1).toISOString()} where base_id=${f.baseId}`;
      if (defect === 'ineligible' || defect === 'unavailable') await f.sql`update deed_ownership_observations set status=${defect} where base_id=${f.baseId}`;
      if (defect === 'deferred-loss') await f.sql`update deed_ownership_observations set owner=${f.bronze} where base_id=${f.baseId}`;
      if (defect === 'asset') await f.sql`update deed_ownership_observations set asset_id=${f.bronze} where base_id=${f.baseId}`;
      if (defect === 'slot') await f.sql`update deed_ownership_observations set slot=null where base_id=${f.baseId}`;
      // Deferred reconciliation can leave bases.owner_wallet unchanged even
      // though the authoritative observation already proves another owner.
      expect((await f.sql`select owner_wallet from bases where id=${f.baseId}`)[0]!.owner_wallet).toBe(f.buyer);
      const before = await snapshot();
      await expect(f.apply(f.retirementRequest(at))).rejects.toThrow('CUSTODY_UNSUPPORTED_STATE');
      expect(await snapshot()).toBe(before);
    }
    await f.sql`delete from deed_ownership_observations where base_id=${f.baseId}`;
    const at = new Date().toISOString(); await f.authorizeBuyer(at);
    await f.sql`update bases set status='inactive' where id=${f.baseId}`;
    expect((await f.apply(f.retirementRequest(at))).measuredG8).toBe(true);
    expect(await f.balance('player_gems', f.buyer)).toBe(240n);
    expect(await f.balance('league_pool')).toBe(160n);
  }, 60_000);

  it('serializes duplicate retirement attempts and lets the losing attempt recover exactly once', async () => {
    const request = await ready();
    const results = await Promise.allSettled([f.apply(request), f.apply(request)]);
    const success = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof f.apply>>> => result.status === 'fulfilled');
    expect(success.length).toBeGreaterThanOrEqual(1);
    for (const result of results) if (result.status === 'rejected') expect(leaf(result.reason)).toMatchObject({ code: '55P03' });
    const before = await snapshot();
    expect(await f.apply(request)).toEqual(success[0]!.value);
    expect(await snapshot()).toBe(before);
    expect(await f.balance('player_gems', f.buyer)).toBe(240n);
    expect(await f.sql`select * from keep_custody_league_retirements`).toHaveLength(1);
  }, 60_000);

  it('refuses both orphan prepare and complete balanced money without final journal/latch pairing', async () => {
    const request = await ready();
    for (const post of [false, true]) {
      request.asOf = new Date().toISOString(); await f.authorizeBuyer(request.asOf);
      const before = await snapshot(); let reached = false;
      const attempt = f.db.transaction(async tx => {
        await tx.execute(barrier);
        await getOrCreatePlayerAccount(tx, f.buyer, 'player_gems');
        const prepared = await tx.execute<{ posting_key: string; posting_type: string; metadata: Record<string, unknown>; entries: { account: string; delta: string }[] }>(sql`
          select * from shardkeep_prepare_fixture_league_retirement(${WEEKS[1]}::date,${f.baseId}::uuid,${request.fixtureId}::uuid,${request.asOf}::timestamptz,false)`);
        const plan = prepared[0]!;
        if (post) {
          const actual = await postTransaction(tx, { idempotencyKey: plan.posting_key, type: plan.posting_type,
            metadata: plan.metadata, entries: plan.entries.map(e => ({ account: e.account, delta: BigInt(e.delta) })) });
          expect(actual.duplicate).toBe(false); expect(actual.entries).toHaveLength(4);
          const effects = await tx.execute<{ escrow: string; gems: string }>(sql`select
            (select balance::text from accounts where kind='league_entitlement_escrow') escrow,
            (select balance::text from accounts where kind='player_gems' and owner_wallet=${f.buyer}) gems`);
          expect(effects[0]).toEqual({ escrow: '0', gems: '240' });
        }
        reached = true;
      });
      // Without money, the pending plan first contradicts the archive's exact
      // remaining-escrow total. With real money, the final journal/latch pair
      // is the missing evidence. Both failures happen after this body returns.
      await expect(attempt.catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: post ? 'CUSTODY_LEAGUE_JOURNAL_REQUIRED' : 'CUSTODY_LEAGUE_SOURCE_CONFLICT' });
      expect(reached).toBe(true); expect(await snapshot()).toBe(before);
    }
    request.asOf = new Date().toISOString(); await f.authorizeBuyer(request.asOf);
    expect((await f.apply(request)).measuredG8).toBe(true);
  }, 60_000);

  it('rejects missing request/receipt evidence after actual money and frozen-latch effects were reached', async () => {
    const request = await ready();
    await f.sql`create sequence league_malformed_reached`;
    await f.sql.unsafe(`create function league_terminal_reached() returns trigger language plpgsql as $$ begin
      if NEW.phase='frozen' then perform nextval('league_malformed_reached'); end if; return NEW; end $$;
      create trigger zzz_league_terminal_reached after update on keep_custody_cutover_state for each row execute function league_terminal_reached()`);
    for (const defect of ['fixtureId', 'asOf', 'league', 'type', 'metadata', 'entries', 'createdAt'] as const) {
      request.asOf = new Date().toISOString(); await f.authorizeBuyer(request.asOf);
      // This fault changes the actual stored journal, not a provider return or
      // boolean. The deferred source checker must reject missing evidence.
      const mutation = ['fixtureId', 'asOf', 'league'].includes(defect)
        ? `NEW.request := NEW.request - '${defect}';`
        : `NEW.receipts := (select jsonb_agg(case when r->'metadata'->>'class'='L5' then r-'${defect}' else r end order by ord)
            from jsonb_array_elements(NEW.receipts) with ordinality q(r,ord));`;
      await f.sql.unsafe(`create or replace function league_malformed_journal() returns trigger language plpgsql as $$ begin ${mutation} return NEW; end $$;
        create trigger zzz_league_malformed_journal before insert on keep_custody_journal for each row execute function league_malformed_journal()`);
      const before = await snapshot();
      const [sequenceBefore] = await f.sql<{ last_value: string; is_called: boolean }[]>`select last_value::text,is_called from league_malformed_reached`;
      await expect(f.apply(request).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_JOURNAL_REQUIRED' });
      const [sequenceAfter] = await f.sql<{ last_value: string; is_called: boolean }[]>`select last_value::text,is_called from league_malformed_reached`;
      expect(sequenceAfter!.is_called).toBe(true);
      expect(BigInt(sequenceAfter!.last_value)).toBe(BigInt(sequenceBefore!.last_value) + (sequenceBefore!.is_called ? 1n : 0n));
      expect(await snapshot()).toBe(before);
      await f.sql`drop trigger zzz_league_malformed_journal on keep_custody_journal`;
    }
    request.asOf = new Date().toISOString(); await f.authorizeBuyer(request.asOf);
    expect((await f.apply(request)).measuredG8).toBe(true);
  }, 60_000);

  it('rolls back money, entitlement consumption, journal and F on a trailing failure, then retries once', async () => {
    const request = await ready();
    await f.sql`create sequence league_rollback_reached`;
    await f.sql.unsafe(`create function league_abort_frozen() returns trigger language plpgsql as $$ begin
      if NEW.phase='frozen' then
        if (select balance from accounts where kind='league_entitlement_escrow')<>0
          or (select count(*) from keep_custody_league_retirements)<>1
          or (select count(*) from keep_custody_journal)<>1 then raise exception 'LEAGUE_EFFECTS_NOT_REACHED'; end if;
        perform nextval('league_rollback_reached'); raise exception 'LEAGUE_TRAILING_FAILURE';
      end if; return NEW; end $$;
      create trigger zzz_league_abort_frozen after update on keep_custody_cutover_state for each row execute function league_abort_frozen()`);
    const before = await snapshot();
    await expect(f.apply(request).catch(leaf)).resolves.toMatchObject({ code: 'P0001', message: 'LEAGUE_TRAILING_FAILURE' });
    expect((await f.sql`select is_called from league_rollback_reached`)[0]!.is_called).toBe(true);
    expect(await snapshot()).toBe(before);
    await f.sql`drop trigger zzz_league_abort_frozen on keep_custody_cutover_state`;
    request.asOf = new Date().toISOString(); await f.authorizeBuyer(request.asOf);
    const result = await f.apply(request); const settled = await snapshot();
    expect(await f.apply(request)).toEqual(result); expect(await snapshot()).toBe(settled);
    expect(await f.balance('player_gems', f.buyer)).toBe(240n);
  }, 60_000);
});
