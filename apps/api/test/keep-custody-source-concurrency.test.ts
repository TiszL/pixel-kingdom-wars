import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { creditDeposit } from '../src/money/deposits';
import { keepCustodySourceFixture, deferred, entered, leaf,
  type KeepCustodySourceFixture } from './fixtures/keepCustodySource';

let f: KeepCustodySourceFixture | undefined;
beforeEach(async () => { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); f = await keepCustodySourceFixture(); }, 60_000);
afterEach(async () => { try { await f?.dispose(); } finally { f = undefined; vi.unstubAllEnvs(); } });

describe('prospective KEEP source serializes against W/F without lock upgrades', () => {
  it('makes W fail promptly while authenticated /paid owns its canonical locks, then inventories the committed proof', async () => {
    const source = f!, ready = deferred(), release = deferred();
    source.setReadHook(async commitment => {
      if (commitment === 'confirmed') { ready.resolve(); await release.promise; }
    });
    const payment = source.paid();
    try {
      await entered(ready, payment);
      await expect(source.close().catch(leaf)).resolves.toMatchObject({ code: '55P03' });
      expect(await source.sql`select * from keep_custody_source_windows`).toHaveLength(0);
    } finally { release.resolve(); expect((await payment).statusCode).toBe(200); source.setReadHook(undefined); }
    const window = await source.close(); expect(JSON.stringify(window.inventory)).toContain(source.first.signature);
    expect(await source.sql`select commitment from keep_custody_source_observations`).toEqual([{ commitment: 'confirmed' }]);
  });

  it('refuses new /paid source retention after W and rejects a changed W original at F', async () => {
    const source = f!; await source.close(); const before = await source.snapshot();
    expect((await source.paid()).statusCode).not.toBe(200);
    expect(await source.snapshot()).toBe(before);
    await source.drain(); await expect(source.retire()).rejects.toThrow();
    expect(await source.sql`select * from keep_custody_source_observations`).toHaveLength(0);
  });

  it('lets an already-started ordinary credit win, makes F fail NOWAIT, and converts the resulting L1 once on retry', async () => {
    const source = f!; expect((await source.paid()).statusCode).toBe(200); await source.close(); await source.drain();
    const ready = deferred(), release = deferred();
    const held = source.wrap(async () => { ready.resolve(); await release.promise; })();
    const credit = creditDeposit(held.db, source.first.id, { txSignature: source.first.signature, wallet: source.wallet,
      kind: 'keep_deposit', lamports: source.first.amount, finalized: true });
    try {
      await entered(ready, credit);
      await expect(source.retire().catch(leaf)).resolves.toMatchObject({ code: '55P03' });
    } finally { release.resolve(); await credit; }
    expect(await source.retire()).toMatchObject({ measuredG8: true, totalKeepConverted: '16' });
    const before = await source.snapshot(); await expect(source.collect()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
  });

  it('rechecks a stale W inventory instead of adopting changed payloads or caller-selected source rows', async () => {
    const source = f!; expect((await source.paid()).statusCode).toBe(200); await source.close();
    // Pre-F deposit rows are still ordinary live originals. Changing one must
    // invalidate its selected observation rather than silently create a v2 source.
    await source.sql`update deposits set payload='{"changed":"after-W"}'::jsonb where id=${source.first.id}`;
    await source.drain(); const before = await source.snapshot();
    await expect(source.retire()).rejects.toThrow(); expect(await source.snapshot()).toBe(before);
  });

  it('reconciles duplicate collectors to one result and never reuses an existing cross-column signature', async () => {
    let source = f!;
    const collision = randomUUID();
    await source.sql`insert into deposits(id,player_wallet,kind,reference,status,tx_signature)
      values(${collision},${source.wallet},'entry',${Keypair.generate().publicKey.toBase58()},'credited',${source.first.signature})`;
    const before = await source.snapshot(); expect((await source.paid()).statusCode).toBe(409);
    expect(await source.snapshot()).toBe(before);
    expect(await source.sql`select signature,consumer_kind,consumer_id from payment_signature_claims where signature=${source.first.signature}`)
      .toEqual([{ signature: source.first.signature, consumer_kind: 'deposit', consumer_id: collision }]);
    // A consumed signature remains reserved permanently. Keep that collision
    // intact and exercise valid collector recovery in a fresh private fixture.
    const consumedSignature = source.first.signature;
    await source.dispose(); f = undefined;
    source = await keepCustodySourceFixture(); f = source;
    expect(source.first.signature).not.toBe(consumedSignature);
    await source.freeze();
    const ready = deferred(), release = deferred(); let firstRead = true;
    source.setReadHook(async commitment => {
      if (commitment === 'finalized' && firstRead) { firstRead = false; ready.resolve(); await release.promise; }
    });
    const first = source.collect(); let winner: Awaited<ReturnType<typeof source.collect>>;
    try { await entered(ready, first); winner = await source.collect(); }
    finally { release.resolve(); }
    expect(await first).toEqual(winner!);
    const saved = await source.snapshot(); expect(await source.collect()).toEqual(winner!); expect(await source.snapshot()).toBe(saved);
    expect(await source.sql`select * from keep_custody_source_observations where commitment='finalized'`).toHaveLength(1);
    expect(await source.sql`select * from ledger_transactions where type='gems.late_credit'`).toHaveLength(1);
  });

  it('rolls back evidence, authorization and both postings on a trailing failure or deferred receipt corruption', async () => {
    const source = f!; await source.freeze(); const before = await source.snapshot();
    await expect(source.collector().collect(source.request(), source.env, source.wrap(async () => {
      throw Error('FIXTURE_TRAILING_FAILURE');
    }))).rejects.toThrow('FIXTURE_TRAILING_FAILURE');
    expect(await source.snapshot()).toBe(before);
    // The API returned from its posting routine, but the enclosing transaction
    // must still fail if another statement appends a duplicate Gems leg.
    await expect(source.collector().collect(source.request(), source.env, source.wrap(async tx => {
      await tx.execute(sql`insert into ledger_entries(txn_id,account_id,delta,balance_after)
        select e.txn_id,e.account_id,e.delta,e.balance_after from ledger_entries e
        join ledger_transactions t on t.id=e.txn_id join accounts a on a.id=e.account_id
        where t.type='gems.late_credit' and a.kind='gems_mint'`);
    }))).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    expect(await source.collect()).toMatchObject({ keep: '5' });
  });
});
