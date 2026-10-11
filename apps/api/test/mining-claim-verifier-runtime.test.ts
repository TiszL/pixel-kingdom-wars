import { randomBytes, randomUUID } from 'node:crypto';
import { Keypair, VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import { afterEach, expect, it, vi } from 'vitest';
import { createMiningClaimVerifierRuntime } from '../src/mining/claimVerifierRuntime';
import { acceptMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withMiningClaimSettlementFixture as fixture } from './fixtures/miningClaimSettlement';

afterEach(() => vi.unstubAllEnvs());
it('verifies actual saved success while paused and coalesces concurrent scans without another terminal', async () => fixture(async f => {
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  const source = vi.fn(() => f.receiptReader);
  const runtime = await createMiningClaimVerifierRuntime(f.url.toString(), { receiptSource: source, trust: f.trust });
  try {
    const first = runtime.runOnce(), concurrent = runtime.runOnce(); expect(concurrent).toBe(first);
    expect(await first).toEqual({ examined: 1, settled: 1, failed: 0, held: 0 });
    const [receipt] = await f.conn.sql`select receipt from mining_claim_receipts where claim_id=${f.preparedClaim.claimId}`;
    expect(receipt!.receipt).toMatchObject({ signature: f.signed.signature, paidKeepBaseUnits: String(f.payment) });
    expect(await runtime.runOnce()).toEqual({ examined: 0, settled: 0, failed: 0, held: 0 });
    expect(source).toHaveBeenCalledTimes(1);
    expect(await f.conn.sql`select * from mining_claim_failures`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_claim_signed_wires`).toHaveLength(1);
  } finally { await runtime.close(); await runtime.close(); }
}));
it('independently verifies exact finalized failure after success rejects it, preserving the signed original', async () => fixture(async f => {
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  const meta = f.tx.meta!, tx = { ...f.tx, meta: { ...meta,
    err: { InstructionError: [f.tx.transaction.message.compiledInstructions.length - 1, { Custom: 6000 }] },
    postBalances: meta.preBalances.map((n, i) => i === 0 ? n - meta.fee : n), postTokenBalances: structuredClone(meta.preTokenBalances!) } };
  const runtime = await createMiningClaimVerifierRuntime(f.url.toString(), {
    receiptSource: () => ({ ...f.receiptReader, getTransaction: async () => tx }), trust: f.trust });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 1, held: 0 });
    const [failure] = await f.conn.sql`select receipt from mining_claim_failures where claim_id=${f.preparedClaim.claimId}`;
    expect(failure!.receipt).toMatchObject({ signature: f.signed.signature, paymentAuthorized: false });
    expect(await f.conn.sql`select * from mining_claim_receipts`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_claim_signed_wires`).toHaveLength(1);
  } finally { await runtime.close(); }
}));
it('does not let an unknown oldest original starve a later verifiable claim, and wraps to retry held work', async () => fixture(async f => {
  const hash = Keypair.generate().publicKey.toBase58();
  f.quote.reader.getLatestBlockhashAndContext = async () => ({ context: { slot: 3003 }, value: { blockhash: hash, lastValidBlockHeight: 250 } });
  f.quote.reader.getFeeForMessage = async () => ({ context: { slot: 3003 }, value: 5000 }); f.quote.reader.getSlot = async () => 3003;
  const second = await f.claimService.prepare(f.wallet, { idempotencyKey: randomUUID() });
  const transaction = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(second.transactions[0]!.messageHex, 'hex')));
  transaction.sign([f.claimantSigner]);
  const saved = await acceptMiningClaimSigned(f.conn.db, { wallet: f.wallet, claimId: second.claimId, signedTransaction: transaction.serialize() });
  const originals = [{ id: f.preparedClaim.claimId, signature: f.signed.signature, tx: f.tx },
    { id: second.claimId, signature: saved.signature, tx: { ...f.tx, transaction: { message: transaction.message, signatures: [saved.signature] } } }].sort((a, b) => a.id.localeCompare(b.id));
  const later = originals[1]!;
  const runtime = await createMiningClaimVerifierRuntime(f.url.toString(), { trust: f.trust,
    receiptSource: () => ({ ...f.receiptReader, getTransaction: async signature => signature === later.signature ? later.tx : null }) }, { batchSize: 1 });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 1, failed: 0, held: 0 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 });
    expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toEqual([{ claim_id: later.id }]);
    expect(await f.conn.sql`select * from mining_claim_signed_wires`).toHaveLength(2);
  } finally { await runtime.close(); }
}));
it('holds wrong pinned identity and unavailable history without inferring a terminal', async () => fixture(async f => {
  for (const sources of [{ trust: { ...f.trust, reviewedProgramDataSha256: '0'.repeat(64) }, receiptSource: () => f.receiptReader },
    { trust: f.trust, receiptSource: () => ({ ...f.receiptReader, getTransaction: async () => null }) }]) {
    const runtime = await createMiningClaimVerifierRuntime(f.url.toString(), sources);
    try { expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 }); }
    finally { await runtime.close(); }
  }
  expect(await f.conn.sql`select * from mining_claim_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_claim_failures`).toHaveLength(0);
}));
it('rejects a nonowner LOGIN even when it has all table rights', async () => fixture(async f => {
  const role = `claim_verify_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
  const url = new URL(f.url); url.username = role; url.password = password;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}`);
  try { await expect(createMiningClaimVerifierRuntime(url.toString(), { receiptSource: () => f.receiptReader, trust: f.trust })).rejects.toThrow('private terminal owner'); }
  finally { await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
}));
it('joins an aborted read on shutdown, cannot begin a late write or another scan', async () => fixture(async f => {
  let entered!: () => void; const inRead = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await createMiningClaimVerifierRuntime(f.url.toString(), { trust: f.trust,
    receiptSource: signal => ({ ...f.receiptReader, getTransaction: async () => {
      entered(); return new Promise<null>((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }); });
    } }) });
  const pending = runtime.runOnce(); await inRead; await runtime.close(); await pending;
  await expect(runtime.runOnce()).rejects.toThrow('closed');
  expect(await f.conn.sql`select * from mining_claim_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_claim_failures`).toHaveLength(0);
}));
