import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { custodyLeagueFixture, deferred, leaf, WEEKS, type CustodyLeagueFixture } from './fixtures/custodyLeague';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';

let f: CustodyLeagueFixture;
beforeEach(async () => { f = await custodyLeagueFixture(); }, 60_000);
afterEach(async () => { await f?.dispose(); });

describe('complete original pre0095 league bridge', () => {
  it('preserves the whole original week, including paid and zero rows, before stock0095 can proceed', async () => {
    await expect(f.migrateAll().catch(leaf)).resolves.toMatchObject({
      code: 'P0001',
      message: 'legacy positive KEEP league entitlements require an explicit operator audit before the SHARDS/items-only migration',
    });
    expect(await f.capture()).toEqual({
      fixtureOnly: true, retirementAuthorized: false, fixtureId: f.bridgeId,
      sourceVersion: 'stable-league-pre0095-v1', weeks: 2, rows: 4,
      zeroRows: 2, paidPositiveRows: 1, unpaidPositiveRows: 1, unpaidKeep: '240',
    });
    expect(await f.sql`select week::text,original_rows from keep_custody_league_weeks order by week`)
      .toEqual(f.originalWeeks);
    expect(await f.sql`select keep_amount::text from base_league_entitlements order by week`)
      .toEqual([{ keep_amount: '0' }, { keep_amount: '0' }]);
    expect(await f.historicalGraph()).toBe(f.originalGraph);
    expect(await f.balance('league_entitlement_escrow')).toBe(240n);
    expect(await f.balance('league_pool')).toBe(160n);
    await f.migrateAll();
    expect(await f.sql`select week::text,original_rows from keep_custody_league_weeks order by week`)
      .toEqual(f.originalWeeks);
    // The archive owns this identity permanently; even a modern zero row must
    // not replace the original positive obligation or paid history.
    await expect(f.sql`insert into base_league_entitlements(week,base_id,tier,trophies,keep_amount)
      values(${WEEKS[0]},${f.baseId},'sol',1300,0)`.catch(leaf))
      .resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_FROZEN' });
    expect(await f.historicalGraph()).toBe(f.originalGraph);
  }, FRESH_DB_CASE_MS);

  it('rejects a source writer with an RR snapshot taken before the sealed bridge existed', async () => {
    const ready = deferred(), release = deferred();
    let mutate = false;
    const oldWriter = f.sql.begin('isolation level repeatable read', async tx => {
      // Establish the actual old snapshot without holding ACCESS SHARE on a
      // source table, which would correctly make the bridge NOWAIT-refuse.
      await tx`select txid_current_snapshot()`;
      ready.resolve(); await release.promise;
      if (mutate) await tx`update base_league_entitlements set trophies=trophies+1
        where week=${WEEKS[0]} and base_id=${f.zeroBaseId}`;
    }).then(() => ({ ok: true }), error => ({ ok: false, error: leaf(error) }));
    await ready.promise;
    try {
      await f.capture();
      mutate = true; release.resolve();
      expect(await oldWriter).toMatchObject({ ok: false, error: {
        code: 'P0001', message: 'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED',
      } });
      expect(await f.sql`select week::text,original_rows from keep_custody_league_weeks order by week`)
        .toEqual(f.originalWeeks);
    } finally { release.resolve(); await oldWriter; }
  });

  it('fences an old payer that selected the unpaid entitlement before capture, through migration', async () => {
    // Historical social.ts selects pending rows outside its later payout
    // transaction. This autocommit read reproduces that real interleaving.
    const selected = await f.sql`select week::text,base_id,keep_amount::text from base_league_entitlements
      where paid_at is null and keep_amount>0`;
    expect(selected).toEqual([{ week: WEEKS[1], base_id: f.baseId, keep_amount: '240' }]);
    await f.capture();
    const originalMoney = await f.money();
    await expect(f.payPreviouslySelected().catch(leaf))
      .resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_FROZEN' });
    expect(await f.money()).toBe(originalMoney);
    await f.migrateAll();
    const migratedMoney = await f.money();
    await expect(f.payPreviouslySelected().catch(leaf))
      .resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_FROZEN' });
    expect(await f.money()).toBe(migratedMoney);
    expect(await f.sql`select id from ledger_transactions
      where idempotency_key=${`league:${WEEKS[1]}:${f.baseId}`}`).toHaveLength(0);
    expect(await f.balance('league_entitlement_escrow')).toBe(240n);
    expect(await f.historicalGraph()).toBe(f.originalGraph);
  }, FRESH_DB_CASE_MS);

  it('keeps sealed evidence and guards intact when normal0224 and the exact DDL repeat', async () => {
    const first = await f.capture();
    await f.migrateAll();
    const snapshot = async () => JSON.stringify(await f.sql`select
      (select jsonb_agg(to_jsonb(b)) from keep_custody_league_bridge b) bridge,
      (select jsonb_agg(to_jsonb(w) order by week) from keep_custody_league_weeks w) weeks`);
    const original = await snapshot();
    await f.installBridge();
    expect(await f.capture()).toEqual(first);
    expect(await snapshot()).toBe(original);
    await expect(f.sql`update base_league_entitlements set trophies=trophies+1
      where week=${WEEKS[0]} and base_id=${f.zeroBaseId}`.catch(leaf))
      .resolves.toMatchObject({ code: 'P0001', message: 'CUSTODY_LEAGUE_SOURCE_FROZEN' });
    expect(await f.historicalGraph()).toBe(f.originalGraph);
  }, FRESH_DB_CASE_MS);
});
