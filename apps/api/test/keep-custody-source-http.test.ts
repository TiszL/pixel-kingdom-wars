import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { DEPOSIT_VERIFICATION } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitDepositPayment } from '../src/money/deposits';
import { census } from '../src/db/keepCustodyRetire';
import { applyFixtureL1Retirement } from '../src/db/keepCustodyJournal';
import { keepCustodySourceFixture, type KeepCustodySourceFixture } from './fixtures/keepCustodySource';

let f: KeepCustodySourceFixture | undefined;
beforeEach(async () => { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); f = await keepCustodySourceFixture(); }, 60_000);
afterEach(async () => { try { await f?.dispose(); } finally { f = undefined; vi.unstubAllEnvs(); } });

describe('existing authenticated /paid retains prospective confirmed KEEP only', () => {
  it('reports permanent signature conflicts without losing verification capacity or changing the original claim', async () => {
    const source = f!, consumed = randomUUID();
    await source.sql`insert into deposits(id,player_wallet,kind,reference,status,tx_signature)
      values(${consumed},${source.wallet},'entry',${Keypair.generate().publicKey.toBase58()},'credited',${source.first.signature})`;
    // Deliberate fixture removal exposes the permanent claim independently of
    // the live-deposit union check; deleting a consumer never releases payment.
    await source.sql`delete from deposits where id=${consumed}`;
    const claims = await source.sql`select * from payment_signature_claims where signature=${source.first.signature}`;
    expect(claims).toMatchObject([{ consumer_kind: 'deposit', consumer_id: consumed }]);
    const before = await source.snapshot();
    for (let n = 0; n <= DEPOSIT_VERIFICATION.concurrency; n++) {
      const response = await source.paid();
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { message: 'payment signature is already bound to another payment' } });
    }
    expect(await source.snapshot()).toBe(before);
    expect(await source.sql`select * from payment_signature_claims where signature=${source.first.signature}`).toEqual(claims);
    // More conflicts than the permit pool must not starve an unrelated valid
    // payment. Its original same-consumer replay still needs no second proof.
    const next = await source.intent();
    expect((await source.paid(next)).statusCode).toBe(200);
    const accepted = await source.snapshot(), reads = source.calls.length;
    expect((await source.paid(next)).statusCode).toBe(200);
    expect(source.calls).toHaveLength(reads); expect(await source.snapshot()).toBe(accepted);
  });

  it.each([
    ['23505', 'UNRELATED_FIXTURE_CONSTRAINT'],
    ['23514', 'PAYMENT_SIGNATURE_ALREADY_CLAIMED'],
  ])('preserves an unrelated PostgreSQL failure %s/%s instead of misreporting a payment conflict', async (code, message) => {
    const source = f!;
    await source.sql.unsafe(`create function fixture_unrelated_payment_error() returns trigger language plpgsql as $$begin
      raise exception using errcode='${code}',message='${message}'; end$$;
      create trigger fixture_unrelated_payment_error before update on deposits
      for each row execute function fixture_unrelated_payment_error()`);
    const before = await source.snapshot();
    expect((await source.paid()).statusCode).toBe(500);
    expect(await source.snapshot()).toBe(before);
    expect(await source.sql`select * from payment_signature_claims`).toHaveLength(0);
  });

  it('requires the owning session and exact canonical signature, reads once, and never backfills the same-signature early return', async () => {
    const source = f!, before = await source.snapshot();
    expect((await source.paid(source.first, {})).statusCode).toBe(401);
    expect((await source.post(`/deposits/${source.first.id}/paid`, { signature: 'not-a-signature' })).statusCode).toBe(400);
    await expect(submitDepositPayment(source.db, source.collector().verifyCommit, Keypair.generate().publicKey.toBase58(),
      source.first.id, source.first.signature)).rejects.toThrow('deposit not found');
    expect(await source.snapshot()).toBe(before); expect(source.calls).toHaveLength(0);
    expect((await source.paid()).statusCode).toBe(200);
    const saved = await source.snapshot(); source.setUnavailable(true);
    expect((await source.paid()).statusCode).toBe(200); expect(await source.snapshot()).toBe(saved);
    expect(source.calls).toHaveLength(1);
  });

  it('rolls payment_signature back when retaining the proof fails and preserves the unconfigured/delegated rails', async () => {
    const source = f!;
    await source.sql.unsafe(`create function fixture_reject_source() returns trigger language plpgsql as $$begin
      raise exception 'FIXTURE_SOURCE_WRITE_FAILED'; end$$;
      create trigger z_fixture_reject_source before insert on keep_custody_source_observations
      for each row execute function fixture_reject_source()`);
    const before = await source.snapshot(); expect((await source.paid()).statusCode).not.toBe(200);
    expect(await source.snapshot()).toBe(before);
    await source.sql.unsafe('drop trigger z_fixture_reject_source on keep_custody_source_observations');
    // Existing users of the dependency remain supported without inventing a
    // retrospective source receipt after the configured collector is enabled.
    await source.restart(async candidate => ({ txSignature: candidate.paymentSignature }));
    expect((await source.paid()).statusCode).toBe(200);
    expect(await source.sql`select * from keep_custody_source_observations`).toHaveLength(0);
    await source.restart(); expect((await source.paid()).statusCode).toBe(200);
    expect(await source.sql`select * from keep_custody_source_observations`).toHaveLength(0);
    const other = vi.fn(async (candidate: { paymentSignature: string }) => ({ txSignature: candidate.paymentSignature }));
    const collector = source.factory(other);
    const candidate = { id: randomUUID(), playerWallet: source.wallet, kind: 'entry' as const,
      reference: Keypair.generate().publicKey.toBase58(), createdAt: new Date(), paymentSignature: source.first.signature };
    expect(await collector.verifyCommit(candidate)).toEqual({ txSignature: source.first.signature });
    expect(other).toHaveBeenCalledOnce(); expect(source.calls).toHaveLength(1);
  });

  it('holds old paid signatures and new post-W observations instead of reconstructing historical authority', async () => {
    const source = f!;
    await source.sql`update deposits set payment_signature=${source.first.signature} where id=${source.first.id}`;
    expect((await source.paid()).statusCode).toBe(200);
    expect(await source.sql`select * from keep_custody_source_observations`).toHaveLength(0);
    await source.close(); await source.drain();
    const before = await source.snapshot(); await expect(source.retire()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    const { custodyWindowId: _window, ...legacy } = await source.retirementRequest();
    await expect(applyFixtureL1Retirement(legacy, source.env)).rejects.toThrow();
  });

  it('inventories paid-failed KEEP, expired SOL vends and pending KEEP completely and keeps census/F held', async () => {
    const source = f!, vend = randomUUID(), failed = randomUUID(), unused = randomUUID();
    await source.sql`insert into deposits(id,player_wallet,kind,reference,status,payment_signature)
      values(${vend},${source.wallet},'keep_vend',${Keypair.generate().publicKey.toBase58()},'expired',${'2'.repeat(88)}),
      (${failed},${source.wallet},'keep_deposit',${Keypair.generate().publicKey.toBase58()},'failed',${'3'.repeat(88)}),
      (${unused},${source.wallet},'keep_deposit',${Keypair.generate().publicKey.toBase58()},'expired',null)`;
    expect((await source.paid()).statusCode).toBe(200);
    const window = await source.close();
    const serialized = JSON.stringify(window.inventory);
    for (const id of [source.first.id, vend, failed, unused]) expect(serialized).toContain(id);
    await source.drain();
    const report = await source.db.transaction(tx => census(tx, new Date(), [], source.windowId));
    expect(report.blockers).toContain('KEEP_DEPOSITS_NOT_DRAINED');
    expect(report.counts['deposits']).toBe(2);
    expect(report.counts['deposits_originals']).toBe(4);
    expect(report.counts['deposits_late_admitted']).toBe(1);
    const l6 = report.p6.metrics.find(metric => metric.id === 'L6_OPEN_KEEP_INTENTS');
    expect(Number(l6?.value)).toBeGreaterThanOrEqual(2);
    const before = await source.snapshot(); await expect(source.retire()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
  });
});
