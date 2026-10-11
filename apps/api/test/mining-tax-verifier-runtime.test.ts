import { randomBytes, randomUUID } from 'node:crypto';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, expect, it, vi } from 'vitest';
import { createMiningTaxVerifierRuntime } from '../src/mining/taxVerifierRuntime';
import { withMiningTaxFailureFixture as fixture } from './fixtures/miningTaxFailure';

afterEach(() => vi.unstubAllEnvs());
it.each(['claim', 'combined', 'split'] as const)('recovers original %s proofs while paused, keeping setup distinct from payment', async mode => fixture(async f => {
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false');
  const runtime = await createMiningTaxVerifierRuntime(f.url.toString(), {
    receiptSource: f.chain.connect, failureSource: f.failureOptions.connect, trust: f.chain.trust });
  try {
    const first = runtime.runOnce(); expect(runtime.runOnce()).toBe(first);
    const count = mode === 'split' ? 2 : 1;
    expect(await first).toEqual({ examined: count, receipts: count, failed: 0, held: 0 });
    const rows = await f.conn.sql`select ordinal,receipt from mining_tax_claim_receipts order by ordinal`;
    expect(rows).toHaveLength(count);
    if (mode === 'split') expect(rows[0]!.receipt).toMatchObject({ phase: 'setup', paidKeepBaseUnits: '0' });
    expect(rows.at(-1)!.receipt).toMatchObject({ phase: 'settled', paidKeepBaseUnits: f.record.artifact.intended.claimBaseUnits });
    expect(await runtime.runOnce()).toEqual({ examined: 0, receipts: 0, failed: 0, held: 0 });
    expect(await f.conn.sql`select * from mining_tax_claim_failures`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(count);
  } finally { await runtime.close(); await runtime.close(); }
}, { mode }));
it('records exact failed packet evidence independently without paying or clearing its original', async () => fixture(async f => {
  const tx = f.chain.txs[0]!, meta = tx.meta!;
  tx.meta = { ...meta, err: { InstructionError: [0, { Custom: 9 }] },
    postBalances: meta.preBalances.map((n, i) => n - (i === 0 ? meta.fee : 0)), postTokenBalances: structuredClone(meta.preTokenBalances!) };
  const runtime = await createMiningTaxVerifierRuntime(f.url.toString(), {
    receiptSource: f.chain.connect, failureSource: f.failureOptions.connect, trust: f.chain.trust });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, receipts: 0, failed: 1, held: 0 });
    const [failure] = await f.conn.sql`select receipt from mining_tax_claim_failures`;
    expect(failure!.receipt).toMatchObject({ outcome: 'failed', paymentAuthorized: false, paidKeepBaseUnits: '0' });
    expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(1);
  } finally { await runtime.close(); }
}));
it('advances past unknown original packets and wraps without starving a later valid proof', async () => fixture(async f => {
  await f.forkClaim();
  const originals = await f.conn.sql`select wallet,idempotency_key,signed_transaction from mining_tax_claim_signed_wires order by wallet,idempotency_key,ordinal`;
  const later = originals[1]!, signed = VersionedTransaction.deserialize(later.signed_transaction);
  const signature = bs58.encode(signed.signatures[0]!);
  const heldSignature = bs58.encode(VersionedTransaction.deserialize(originals[0]!.signed_transaction).signatures[0]!);
  f.chain.transactions.set(signature, { ...f.chain.txs[0]!, transaction: { message: signed.message, signatures: [signature] } });
  const getTransaction = f.chain.rpc.getTransaction.bind(f.chain.rpc);
  // Preserve authentic historical auction bodies; only this older claim is unknown.
  f.chain.rpc.getTransaction = async (key, options) => key === heldSignature ? null : getTransaction(key, options);
  const runtime = await createMiningTaxVerifierRuntime(f.url.toString(), {
    receiptSource: f.chain.connect, failureSource: f.failureOptions.connect, trust: f.chain.trust }, { batchSize: 1 });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, receipts: 0, failed: 0, held: 1 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, receipts: 1, failed: 0, held: 0 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, receipts: 0, failed: 0, held: 1 });
    expect(await f.conn.sql`select idempotency_key from mining_tax_claim_receipts`).toEqual([{ idempotency_key: later.idempotency_key }]);
  } finally { await runtime.close(); }
}));
it('holds unavailable history and wrong program identity without a success or failure guess', async () => fixture(async f => {
  const signature = f.chain.txs[0]!.transaction.signatures[0]!;
  for (const trust of [{ ...f.chain.trust, mining: { ...f.chain.trust.mining, reviewedProgramDataSha256: '0'.repeat(64) } }, f.chain.trust]) {
    if (trust === f.chain.trust) f.chain.transactions.set(signature, null);
    const runtime = await createMiningTaxVerifierRuntime(f.url.toString(), {
      receiptSource: f.chain.connect, failureSource: f.failureOptions.connect, trust });
    try { expect(await runtime.runOnce()).toEqual({ examined: 1, receipts: 0, failed: 0, held: 1 }); }
    finally { await runtime.close(); }
  }
  expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_tax_claim_failures`).toHaveLength(0);
}));
it('requires the terminal owner LOGIN even if another role has broad table grants', async () => fixture(async f => {
  const role = `tax_verify_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
  const url = new URL(f.url); url.username = role; url.password = password;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}`);
  try { await expect(createMiningTaxVerifierRuntime(url.toString(), { receiptSource: f.chain.connect,
    failureSource: f.failureOptions.connect, trust: f.chain.trust })).rejects.toThrow('private terminal owner'); }
  finally { await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
}));
it('joins shutdown cancellation and cannot begin a late write or another scan', async () => fixture(async f => {
  let entered!: () => void; const inRead = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await createMiningTaxVerifierRuntime(f.url.toString(), { trust: f.chain.trust, failureSource: f.failureOptions.connect,
    receiptSource: signal => ({ ...f.chain.connect(signal), getGenesisHash: async () => {
      entered(); return new Promise<string>((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }); });
    } }) });
  const pending = runtime.runOnce(); await inRead; await runtime.close(); await pending;
  await expect(runtime.runOnce()).rejects.toThrow('closed');
  expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_tax_claim_failures`).toHaveLength(0);
}));
