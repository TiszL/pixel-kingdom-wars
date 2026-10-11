import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { GEMS } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spendGems } from '../src/game/spend';
import { keepCustodySourceFixture, type KeepCustodySourceFixture } from './fixtures/keepCustodySource';

let f: KeepCustodySourceFixture | undefined;
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('WITHDRAWALS_ENABLED', 'true');
  f = await keepCustodySourceFixture();
}, 60_000);
afterEach(async () => { try { await f?.dispose(); } finally { f = undefined; vi.unstubAllEnvs(); } });

describe('prospective KEEP source → complete W → actual drain → F → backed Gems', () => {
  it('preserves authenticated payment facts and issues two exact tax-free postings after the actual withdrawal drain', async () => {
    const source = f!, withdrawal = await source.addWithdrawal();
    expect((await source.paid()).statusCode).toBe(200);
    const original = (await source.sql`select to_jsonb(d) row from deposits d where id=${source.first.id}`)[0]!.row;
    const confirmed = (await source.sql`select to_jsonb(s) row from keep_custody_source_observations s
      where deposit_id=${source.first.id} and commitment='confirmed'`)[0]!.row;
    expect(confirmed.original).toEqual(original);
    expect(confirmed.signature).toBe(source.first.signature);
    const window = await source.close();
    expect(window.windowId).toBe(source.windowId);
    const beforeReplay = await source.snapshot();
    expect(await source.close()).toEqual(window); expect(await source.snapshot()).toBe(beforeReplay);
    expect(await withdrawal.drain()).toMatchObject({ phase: 'withdrawals_closed', totalKeepReturned: withdrawal.gross.toString() });
    const retirement = await source.retire();
    expect(retirement).toMatchObject({ measuredG8: true, totalKeepConverted: String(11n + withdrawal.gross) });
    const result = await source.collect();
    expect(result).toMatchObject({ fixtureOnly: true, retirementAuthorized: false, keep: '5', gems: String(5 * GEMS.gemsPerKeep) });
    const [deposit] = await source.sql`select payment_signature,tx_signature,amount::text,status from deposits where id=${source.first.id}`;
    expect(deposit).toEqual({ payment_signature: source.first.signature, tx_signature: source.first.signature,
      amount: source.first.amount.toString(), status: 'credited' });
    const legs = await source.sql`select t.type,t.metadata,a.kind::text,a.currency::text,a.owner_wallet,e.delta::text
      from ledger_transactions t join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id
      where t.idempotency_key in (${'deposit:' + source.first.id + ':credit'},${'late-credit:deposit:' + source.first.id + ':convert'})
      order by t.type,a.kind::text`;
    expect(legs.map(r => [r.type, r.kind, r.currency, r.owner_wallet, r.delta])).toEqual([
      ['deposit.keep', 'onchain_inflow', 'KEEP', null, '-5'], ['deposit.keep', 'player_keep', 'KEEP', source.wallet, '5'],
      ['gems.late_credit', 'emission_pool', 'KEEP', null, '5'],
      ['gems.late_credit', 'gems_mint', 'GEMS', null, String(-5 * GEMS.gemsPerKeep)],
      ['gems.late_credit', 'player_gems', 'GEMS', source.wallet, String(5 * GEMS.gemsPerKeep)],
      ['gems.late_credit', 'player_keep', 'KEEP', source.wallet, '-5'],
    ]);
    expect(legs.filter(r => r.type === 'gems.late_credit').every(r => r.metadata.reason === 'keep_conversion')).toBe(true);
    expect(await source.balance('player_keep', source.wallet)).toBe(0n);
    expect(await source.balance('player_gems', source.wallet)).toBe((16n + withdrawal.gross) * BigInt(GEMS.gemsPerKeep));
    expect(await source.sql`select commitment from keep_custody_source_observations order by commitment`)
      .toEqual([{ commitment: 'confirmed' }, { commitment: 'finalized' }]);
    expect(source.calls).toEqual([
      { signature: source.first.signature, commitment: 'confirmed' },
      { signature: source.first.signature, commitment: 'finalized' },
    ]);
  });

  it('recovers a lost response with a restarted collector and unavailable RPC after Gems spending, without changing G8', async () => {
    const source = f!; await source.freeze();
    const g8 = JSON.stringify(await source.sql`select before_state,after_state,receipts from keep_custody_journal where id=${source.retirementJournalId}`);
    const original = await source.collect(); // Result deliberately dropped by the caller until restart.
    await spendGems(source.db, source.wallet, 3n, 'test.custody-source.spend', randomUUID());
    source.restartCollector(); source.setUnavailable(true); source.setNow(new Date('2040-01-01T00:00:00Z'));
    const before = await source.snapshot(), count = source.calls.length;
    expect(await source.collect()).toEqual(original);
    expect(await source.snapshot()).toBe(before); expect(source.calls).toHaveLength(count);
    expect(JSON.stringify(await source.sql`select before_state,after_state,receipts from keep_custody_journal where id=${source.retirementJournalId}`)).toBe(g8);
    await expect(source.collect({ ...source.request(), fixtureId: randomUUID() })).rejects.toThrow();
    await expect(source.collect({ ...source.request(), retirementJournalId: randomUUID() })).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
  });

  it('lets ordinary credit between W and F enter L1 exactly once and refuses late adoption of that credited original', async () => {
    const source = f!; expect((await source.paid()).statusCode).toBe(200);
    // An unused expired original with no payment facts remains an unchanged
    // v1-compatible row, not a fabricated new liability or a v2 late source.
    const unused = randomUUID();
    await source.sql`insert into deposits(id,player_wallet,kind,reference,status)
      values(${unused},${source.wallet},'keep_deposit',${Keypair.generate().publicKey.toBase58()},'expired')`;
    await source.close();
    expect(await source.credit()).toMatchObject({ credited: true });
    await source.drain();
    expect(await source.retire()).toMatchObject({ totalKeepConverted: '16', measuredG8: true });
    const before = await source.snapshot(); await expect(source.collect()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    expect(await source.credit()).toMatchObject({ credited: false });
    expect(await source.balance('player_gems', source.wallet)).toBe(16n * BigInt(GEMS.gemsPerKeep));
    expect(await source.sql`select id from ledger_transactions where type='gems.late_credit'`).toHaveLength(0);
    expect(await source.sql`select id from ledger_transactions where idempotency_key=${'deposit:' + source.first.id + ':credit'}`).toHaveLength(1);
  });
});
