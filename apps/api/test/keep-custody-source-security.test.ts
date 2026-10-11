import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFixtureL1Retirement } from '../src/db/keepCustodyJournal';
import { keepCustodySourceFixture, signedTransfer, SOURCE_GENESIS, SOURCE_UNIT, leaf,
  type KeepCustodySourceFixture, type SourceTransaction } from './fixtures/keepCustodySource';

let f: KeepCustodySourceFixture | undefined;
beforeEach(async () => { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); f = await keepCustodySourceFixture(); }, 60_000);
afterEach(async () => { try { await f?.dispose(); } finally { f = undefined; vi.unstubAllEnvs(); } });

const proofMutations: Record<string, (proof: SourceTransaction) => void> = {
  signature: p => { p.transaction.signatures[0] = '2'.repeat(88); },
  signer: p => { p.transaction.message.accountKeys[0] = Keypair.generate().publicKey.toBase58(); },
  'unsigned header': p => { p.transaction.message.header.numRequiredSignatures = 0; },
  reference: p => { p.transaction.message.accountKeys = p.transaction.message.accountKeys.map((key, index) =>
    index === p.transaction.message.accountKeys.length - 1 ? Keypair.generate().publicKey.toBase58() : key); },
  destination: p => { p.transaction.message.accountKeys[p.meta.postTokenBalances[0]!.accountIndex] = Keypair.generate().publicKey.toBase58(); },
  mint: p => { p.meta.postTokenBalances[0]!.mint = Keypair.generate().publicKey.toBase58(); },
  owner: p => { p.meta.postTokenBalances[0]!.owner = Keypair.generate().publicKey.toBase58(); },
  precision: p => { p.meta.postTokenBalances[0]!.uiTokenAmount.decimals += 1; },
  'noncanonical raw': p => { p.meta.postTokenBalances[0]!.uiTokenAmount.amount = '1e12'; },
  failed: p => { p.meta.err = { InstructionError: [0, 'Custom'] }; },
  zero: p => { p.meta.postTokenBalances[0]!.uiTokenAmount.amount = p.meta.preTokenBalances[0]!.uiTokenAmount.amount; },
  'dust only': p => { p.meta.postTokenBalances[0]!.uiTokenAmount.amount = String(100n * SOURCE_UNIT + 1n); },
  'changed raw delta': p => { p.meta.postTokenBalances[0]!.uiTokenAmount.amount = String(106n * SOURCE_UNIT); },
  'changed signed message': p => { p.transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58(); },
  'before creation': p => { p.blockTime -= 60; },
};

describe('retained KEEP evidence is authority, never caller declarations', () => {
  it('refuses malformed confirmed observations before persisting signature or evidence', async () => {
    const source = f!, before = await source.snapshot();
    // A changed positive amount is legitimate at confirmation; its exact value
    // is then immutable and checked against finality in the next test.
    for (const [name, mutate] of Object.entries(proofMutations).filter(([name]) =>
      !['changed raw delta', 'changed signed message'].includes(name))) {
      const transaction = structuredClone(source.first.transaction);
      if (name === 'reference') {
        const index = transaction.transaction.message.accountKeys.indexOf(source.first.reference);
        transaction.transaction.message.accountKeys[index] = Keypair.generate().publicKey.toBase58();
      } else mutate(transaction);
      source.confirmed.set(source.first.signature, transaction);
      const response = await source.paid();
      expect(response.statusCode, name).not.toBe(200);
      expect(await source.snapshot(), name).toBe(before);
    }
    source.confirmed.set(source.first.signature, source.first.transaction);
    source.setGenesis(Keypair.generate().publicKey.toBase58());
    expect((await source.paid()).statusCode).not.toBe(200); expect(await source.snapshot()).toBe(before);
    source.setGenesis(SOURCE_GENESIS);
    expect((await source.paid()).statusCode).toBe(200);
  });

  it('holds unavailable or changed finalized proofs without retaining a final observation or moving money', async () => {
    const source = f!; await source.freeze(); const before = await source.snapshot();
    source.finalized.delete(source.first.signature); await expect(source.collect()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    source.setUnavailable(true); await expect(source.collect()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before); source.setUnavailable(false);
    for (const [name, mutate] of Object.entries(proofMutations)) {
      const transaction = structuredClone(source.first.transaction); mutate(transaction);
      source.finalized.set(source.first.signature, transaction);
      await expect(source.collect(), name).rejects.toThrow(); expect(await source.snapshot(), name).toBe(before);
    }
    source.finalized.set(source.first.signature, source.first.transaction);
    source.setGenesis(Keypair.generate().publicKey.toBase58()); await expect(source.collect()).rejects.toThrow();
    expect(await source.snapshot()).toBe(before); source.setGenesis(SOURCE_GENESIS);
    expect(await source.collect()).toMatchObject({ keep: '5' });
  });

  it('retains integer amounts beyond JavaScript precision and forbids caller-supplied proof/timing/source authority', async () => {
    const source = f!, amount = BigInt(Number.MAX_SAFE_INTEGER) + 100n;
    const transaction = signedTransfer({ key: source.key, reference: source.first.reference, mint: source.mint,
      owner: source.owner, amount });
    source.first.signature = transaction.transaction.signatures[0]!; source.first.amount = amount;
    source.confirmed.set(source.first.signature, transaction); source.finalized.set(source.first.signature, structuredClone(transaction));
    await source.freeze();
    const before = await source.snapshot();
    await expect(source.collect({ ...source.request(), proof: transaction, finalizedObservedAt: '2040-01-01T00:00:00Z' } as never)).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    const result = await source.collect();
    expect(result.keep).toBe((amount / SOURCE_UNIT).toString());
    expect((await source.sql`select amount::text from deposits where id=${source.first.id}`)[0]!.amount).toBe(amount.toString());
    expect(await source.collect()).toEqual(result);
  });

  it('denies an ordinary runtime role private records, and rejects forged GUC authority even after broad grants', async () => {
    const source = f!; await source.freeze();
    const role = `source_runtime_${randomUUID().replaceAll('-', '')}`;
    await source.sql.unsafe(`create role ${role} nologin`);
    try {
      const before = await source.snapshot();
      for (const table of ['keep_custody_source_observations', 'keep_custody_source_windows']) {
        await expect(source.db.transaction(async tx => {
          await tx.execute(sql.raw(`set local role ${role}`)); await tx.execute(sql.raw(`select * from ${table}`));
        })).rejects.toThrow();
      }
      await source.sql.unsafe(`grant all on all tables in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
      await expect(source.db.transaction(async tx => {
        await tx.execute(sql.raw(`set local role ${role}`));
        await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover','late-credit',true),
          set_config('shardkeep.deed_economy_writer','v1',true)`);
        await tx.execute(sql`update deposits set amount=1,status='credited' where id=${source.first.id}::uuid`);
      })).rejects.toThrow();
      await expect(source.db.transaction(async tx => {
        await tx.execute(sql.raw(`set local role ${role}`));
        await tx.execute(sql`select shardkeep_keep_source_barrier()`);
      })).rejects.toThrow();
      expect(await source.snapshot()).toBe(before);
    } finally { await source.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
  });

  it('keeps source/window/receipt records immutable, rejects missing hooks, and preserves completed money on migration replay', async () => {
    const source = f!; expect((await source.paid()).statusCode).toBe(200);
    await source.close(); await source.drain(); const beforeF = await source.snapshot();
    // Controlled corruption in this disposable transaction removes F after
    // its otherwise valid journal/postings. The deferred journal witness must
    // prevent a committed source version from claiming a freeze that vanished.
    await expect(applyFixtureL1Retirement(await source.retirementRequest(), source.env, source.wrap(async tx => {
      await tx.execute(sql`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`);
      await tx.execute(sql`update keep_custody_cutover_state set phase='withdrawals_closed'`);
      await tx.execute(sql`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`);
    })).catch(leaf)).resolves.toMatchObject({ message: 'KEEP_SOURCE_F_UNSEALED' });
    expect(await source.snapshot()).toBe(beforeF);
    await source.retire(); const result = await source.collect(), before = await source.snapshot();
    for (const table of ['keep_custody_source_observations', 'keep_custody_source_windows']) {
      await expect(source.sql.unsafe(`delete from ${table}`)).rejects.toThrow();
      await expect(source.sql.unsafe(`truncate ${table}`)).rejects.toThrow();
    }
    await expect(source.sql`update keep_custody_source_observations set proof=proof||'{"forged":true}'::jsonb`).rejects.toThrow();
    await expect(source.sql`update keep_custody_source_windows set inventory='[]'::jsonb`).rejects.toThrow();
    expect(await source.snapshot()).toBe(before);
    const [hook] = await source.sql<{ tgname: string }[]>`select tgname from pg_trigger
      where tgrelid='keep_custody_source_observations'::regclass and not tgisinternal order by tgname limit 1`;
    expect(hook).toBeDefined();
    await source.sql.unsafe(`alter table keep_custody_source_observations disable trigger "${hook!.tgname}"`);
    await expect(source.collect()).rejects.toThrow();
    await source.sql.unsafe(`alter table keep_custody_source_observations enable trigger "${hook!.tgname}"`);
    expect(await source.snapshot()).toBe(before);
    const migration = readFileSync(new URL('../drizzle/0238_keep_custody_source.sql', import.meta.url), 'utf8');
    await source.db.transaction(async tx => {
      for (const statement of migration.split('--> statement-breakpoint').filter(s => s.trim())) await tx.execute(sql.raw(statement));
    });
    expect(await source.snapshot()).toBe(before); expect(await source.collect()).toEqual(result);
  });
});
