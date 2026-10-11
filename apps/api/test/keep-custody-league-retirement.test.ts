import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { custodyLeagueFixture, WEEKS, type CustodyLeagueFixture } from './fixtures/custodyLeague';

let f: CustodyLeagueFixture;
beforeEach(async () => { f = await custodyLeagueFixture(); }, 60_000);
afterEach(async () => { vi.unstubAllEnvs(); await f?.dispose(); });

describe('retirement of backed original league entitlements', () => {
  it('converts only unpaid L5 to the current owner, preserves paid history and L7, and replays without another credit', async () => {
    await f.capture();
    await f.migrateAll();
    const at = new Date().toISOString();
    await f.authorizeBuyer(at);
    const request = f.retirementRequest(at);
    const emissionBefore = await f.balance('emission_pool');
    const poolBefore = await f.balance('league_pool');
    await f.closeCustody();
    const result = await f.apply(request);
    expect(result).toMatchObject({ fixtureOnly: true, retirementAuthorized: false,
      measuredG8: true, totalKeepConverted: '840', sweptInternalKeep: '0' });
    expect(await f.balance('player_gems', f.buyer)).toBe(240n);
    // The old paid award is now the seller's L1 balance. It is converted once
    // as L1, never again as a paid league award or as the buyer's entitlement.
    expect(await f.balance('player_gems', f.seller)).toBe(600n);
    expect(await f.balance('player_gems', f.bronze)).toBe(0n);
    expect(await f.balance('player_keep', f.seller)).toBe(0n);
    expect(await f.balance('league_entitlement_escrow')).toBe(0n);
    expect(await f.balance('league_pool')).toBe(poolBefore);
    expect(poolBefore).toBe(160n);
    expect(await f.balance('emission_pool')).toBe(emissionBefore + 840n);
    const key = `league:retire:${f.baseId}:${WEEKS[1]}`;
    const [posting] = await f.sql<{ id: string; type: string; metadata: Record<string, unknown> }[]>`
      select id,type,metadata from ledger_transactions where idempotency_key=${key}`;
    expect(posting).toMatchObject({ type: 'gems.retirement', metadata: {
      wallet: f.buyer, class: 'L5', keep: '240', gems: '240', reason: 'retirement',
      fixtureId: request.fixtureId, week: WEEKS[1], baseId: f.baseId,
    } });
    expect(await f.sql`select a.kind::text,a.currency::text,a.owner_wallet,e.delta::text
      from ledger_entries e join accounts a on a.id=e.account_id
      where e.txn_id=${posting!.id} order by a.kind::text`).toEqual([
      { kind: 'emission_pool', currency: 'KEEP', owner_wallet: null, delta: '240' },
      { kind: 'gems_mint', currency: 'GEMS', owner_wallet: null, delta: '-240' },
      { kind: 'league_entitlement_escrow', currency: 'KEEP', owner_wallet: null, delta: '-240' },
      { kind: 'player_gems', currency: 'GEMS', owner_wallet: f.buyer, delta: '240' },
    ]);
    expect(await f.sql`select id from ledger_transactions where idempotency_key=${`league:retire:${f.baseId}:${WEEKS[0]}`}`)
      .toHaveLength(0);
    expect(await f.sql`select week::text,base_id from keep_custody_league_retirements`)
      .toEqual([{ week: WEEKS[1], base_id: f.baseId }]);
    expect((await f.sql`select phase from keep_custody_cutover_state`)[0]!.phase).toBe('frozen');
    expect(await f.historicalGraph()).toBe(f.originalGraph);
    expect(await f.sql`select week::text,original_rows from keep_custody_league_weeks order by week`)
      .toEqual(f.originalWeeks);
    await f.sql`update bases set owner_wallet=${f.bronze} where id=${f.baseId}`;
    await f.sql`update deed_ownership_observations set status='unavailable' where base_id=${f.baseId}`;
    vi.stubEnv('GEMS_ENABLED', 'false');
    const finalMoney = await f.money();
    expect(await f.apply(request)).toEqual(result);
    expect(await f.money()).toBe(finalMoney);
    expect(await f.balance('player_gems', f.buyer)).toBe(240n);
    expect(await f.balance('player_gems', f.bronze)).toBe(0n);
  }, 60_000);
});
