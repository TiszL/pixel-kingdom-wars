import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRealmSaleVerifierRuntime } from '../src/seeker/realmSaleVerifierRuntime';
import { withRealmSaleFailureFixture as fixture } from './fixtures/realmSaleFailure';
import { retainRealmSaleSettlementFixture } from './fixtures/realmSaleSettlement';

afterEach(() => vi.unstubAllEnvs());
it('records an original success while admission is paused, coalescing scans without a new send', async () => fixture(async f => {
  vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false');
  const source = vi.fn(() => f.chain.rpc);
  const runtime = await createRealmSaleVerifierRuntime(f.url.toString(), { receiptSource: source, trust: f.chain.trust });
  try {
    const first = runtime.runOnce(); expect(runtime.runOnce()).toBe(first);
    expect(await first).toEqual({ examined: 1, settled: 1, failed: 0, held: 0 });
    const [receipt] = await f.conn.sql`select receipt from seeker_realm_sale_receipts where wallet=${f.key.wallet}`;
    expect(receipt!.receipt).toMatchObject({ signature: f.chain.signature });
    expect(await runtime.runOnce()).toEqual({ examined: 0, settled: 0, failed: 0, held: 0 });
    expect(source).toHaveBeenCalledTimes(1);
    expect(await f.conn.sql`select * from seeker_realm_sale_failures`).toHaveLength(0);
    expect(await f.conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(1);
  } finally { await runtime.close(); await runtime.close(); }
}));
it('independently records exact failed finality while preserving the signed original', async () => fixture(async f => {
  const runtime = await createRealmSaleVerifierRuntime(f.url.toString(), { receiptSource: () => f.rpc, trust: f.chain.trust });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 1, held: 0 });
    const [failure] = await f.conn.sql`select receipt from seeker_realm_sale_failures where wallet=${f.key.wallet}`;
    expect(failure!.receipt).toMatchObject({ signature: f.chain.signature, paymentAuthorized: false });
    expect(await f.conn.sql`select * from seeker_realm_sale_receipts`).toHaveLength(0);
    expect(await f.conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(1);
  } finally { await runtime.close(); }
}));
it('advances past an unknown original so a later purchase settles, then retries the held original', async () => fixture(async f => {
  const second = await retainRealmSaleSettlementFixture(f.conn.db);
  const originals = [f, second];
  const ordered = await f.conn.sql`select wallet from seeker_realm_sale_signed_wires order by wallet,idempotency_key`;
  const later = originals.find(original => original.key.wallet === ordered[1]!.wallet)!;
  const runtime = await createRealmSaleVerifierRuntime(f.url.toString(), { trust: later.chain.trust,
    receiptSource: () => ({ ...later.chain.rpc, getTransaction: async signature => signature === later.chain.signature ? later.chain.transaction : null }) }, { batchSize: 1 });
  try {
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 1, failed: 0, held: 0 });
    expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 });
    expect(await f.conn.sql`select wallet from seeker_realm_sale_receipts`).toEqual([{ wallet: later.key.wallet }]);
    expect(await f.conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(2);
  } finally { await runtime.close(); }
}));
it('holds missing history and wrong program pins without inventing a terminal outcome', async () => fixture(async f => {
  for (const sources of [{ trust: { ...f.chain.trust, reviewedProgramDataSha256: '0'.repeat(64) }, receiptSource: () => f.chain.rpc },
    { trust: f.chain.trust, receiptSource: () => ({ ...f.chain.rpc, getTransaction: async () => null }) }]) {
    const runtime = await createRealmSaleVerifierRuntime(f.url.toString(), sources);
    try { expect(await runtime.runOnce()).toEqual({ examined: 1, settled: 0, failed: 0, held: 1 }); }
    finally { await runtime.close(); }
  }
  expect(await f.conn.sql`select * from seeker_realm_sale_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from seeker_realm_sale_failures`).toHaveLength(0);
}));
it('rejects a broad-grant nonowner LOGIN rather than accepting table permission as owner authority', async () => fixture(async f => {
  const role = `sale_verify_${randomUUID().replaceAll('-', '')}`, password = randomBytes(32).toString('hex');
  const url = new URL(f.url); url.username = role; url.password = password;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}`);
  try { await expect(createRealmSaleVerifierRuntime(url.toString(), { receiptSource: () => f.chain.rpc, trust: f.chain.trust })).rejects.toThrow('private terminal owner'); }
  finally { await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`); }
}));
it('aborts and joins a pending read on close so late RPC cannot initiate a terminal write', async () => fixture(async f => {
  let entered!: () => void; const inRead = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await createRealmSaleVerifierRuntime(f.url.toString(), { trust: f.chain.trust,
    receiptSource: signal => ({ ...f.chain.rpc, getTransaction: async () => {
      entered(); return new Promise<null>((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('stopped')), { once: true }); });
    } }) });
  const pending = runtime.runOnce(); await inRead; await runtime.close(); await pending;
  await expect(runtime.runOnce()).rejects.toThrow('closed');
  expect(await f.conn.sql`select * from seeker_realm_sale_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select * from seeker_realm_sale_failures`).toHaveLength(0);
}));
