import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { spendGems } from '../src/game/spend';
import { createGemsFinalizedOriginReader } from '../src/mining/gemsFinalizedOrigins';
import { withFinalizedGems } from './fixtures/gemsFinalizedOrigins';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';

const code = (code: string) => expect.objectContaining({ code });
describe('exact finalized wallet conversion origin, independent of useful use', { timeout: FRESH_DB_CASE_MS }, () => {
 it('joins a real original wallet credit to its exact finalized inflow and FIFO consumed/remaining lots while paused', async () => withFinalizedGems(async f => {
  const original = await f.credit(); await spendGems(f.conn.db, f.wallet, 40n, 'build.speedup', randomUUID(), { jobId: randomUUID() }); await f.close(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); vi.stubEnv('GEMS_ENABLED', 'false');
  const before = await f.conn.sql`select count(*)::text count from ledger_transactions`; const result = await f.read(f.request);
  expect(result.origins).toHaveLength(1); expect(result.origins[0]).toMatchObject({ signature: original.signature, depositId: original.depositId, rawKeepBaseUnits: original.raw.toString(), convertedGems: '100', trust: 'trusted-finalized-rpc', finalityScope: 'finalized-at-evaluation', historicalFinalizationTime: 'unavailable' });
  expect(result.attribution.currentLots).toMatchObject([{ amount: '60', requiresDepositVerification: false }]); expect(result.attribution.debits[0]?.consumed).toMatchObject([{ amount: '40', requiresDepositVerification: false }]);
  expect(result.attribution.debits[0]?.pendingIrreversibleUseEvidence).toBe(true); expect(result.usefulChainCreditAuthorized).toBe(false); expect(result.allocationReady).toBe(false); expect(result.publicationAuthorized).toBe(false);
  expect(f.calls).toEqual([{ signature: original.signature, commitment: 'finalized' }]); expect(await f.conn.sql`select count(*)::text count from ledger_transactions`).toEqual(before);
 }));
 it('uses copied original metadata even after mutable deposit status/amount/payload changes or deletion', async () => withFinalizedGems(async f => {
  const original = await f.credit(); await f.close(); const before = await f.read(f.request);
  await f.conn.sql`update deposits set status='failed',amount=1,payload='{}' where id=${original.depositId}`; expect(await f.read(f.request)).toEqual(before);
  await f.conn.sql`delete from deposits where id=${original.depositId}`; expect(await f.read(f.request)).toEqual(before);
 }));
 it('refuses currently unavailable/confirmed-only evidence, then recovers when exact finality is available', async () => withFinalizedGems(async f => {
  const original = await f.credit(); await f.close(); f.transactions.delete(original.signature); await expect(f.read(f.request)).rejects.toEqual(code('CHAIN_UNAVAILABLE'));
  f.transactions.set(original.signature, original.tx); expect((await f.read(f.request)).origins[0]?.signature).toBe(original.signature);
 }));
 it.each(['signature', 'payer', 'mint', 'reserve', 'rawAmount', 'decimals', 'program', 'failure', 'missingMeta', 'duplicateBalance', 'missingSignature', 'missingHeader'] as const)('refuses %s chain evidence rather than clearing a lot', async field => withFinalizedGems(async f => {
  const p = await f.credit(); await f.close(); const meta = p.tx.meta!;
  if (field === 'signature') p.tx.transaction.signatures[0] = f.transfer().signature;
  if (field === 'payer') p.tx.transaction.message.staticAccountKeys[0] = Keypair.generate().publicKey;
  if (field === 'mint') meta.postTokenBalances![0]!.mint = Keypair.generate().publicKey.toBase58();
  if (field === 'reserve') p.tx.transaction.message.staticAccountKeys[meta.postTokenBalances![0]!.accountIndex] = Keypair.generate().publicKey;
  if (field === 'rawAmount') meta.postTokenBalances![0]!.uiTokenAmount.amount = '100000000624';
  if (field === 'decimals') meta.postTokenBalances![0]!.uiTokenAmount.decimals = 8;
  if (field === 'program') meta.postTokenBalances![0]!.programId = Keypair.generate().publicKey.toBase58();
  if (field === 'failure') meta.err = { InstructionError: [0, 'Custom'] };
  if (field === 'missingMeta') p.tx.meta = null;
  if (field === 'duplicateBalance') meta.postTokenBalances!.push({ ...meta.postTokenBalances![0]! });
  if (field === 'missingSignature') p.tx.transaction.signatures.length = 0;
  if (field === 'missingHeader') Object.defineProperty(p.tx.transaction.message, 'header', { value: undefined });
  await expect(f.read(f.request)).rejects.toEqual(code(field === 'missingMeta' ? 'CHAIN_UNAVAILABLE' : 'CHAIN_MISMATCH'));
 }));
 it.each(['beforeCoverage', 'afterCredit', 'afterDay', 'missingTime'] as const)('refuses %s without inventing historical finalization time', async field => withFinalizedGems(async f => {
  const p = await f.credit(); await f.close(); p.tx.blockTime = field === 'missingTime' ? null : Date.parse(field === 'beforeCoverage' ? '2034-12-31T23:59:59Z' : field === 'afterCredit' ? '2035-01-01T02:00:01Z' : '2035-01-02T00:00:00Z') / 1000;
  await expect(f.read(f.request)).rejects.toEqual(code('ORIGIN_TIME_UNAVAILABLE'));
 }));
 it('rejects a source at exact fractional coverage rather than rounding coverage down', async () => withFinalizedGems(async f => {
  const p = await f.credit(); await f.close(); p.tx.blockTime = Date.parse('2035-01-01T00:00:00Z') / 1000;
  await expect(f.read(f.request)).rejects.toEqual(code('ORIGIN_TIME_UNAVAILABLE'));
 }, '2035-01-01T00:00:00.000001Z'));
 it('refuses legacy credits missing mint/destination and never derives them from current configuration', async () => withFinalizedGems(async f => {
  await f.credit(undefined, { direct: true, omitModern: true }); await f.close(); await expect(f.read(f.request)).rejects.toEqual(code('SOURCE_UNAVAILABLE')); expect(f.calls).toHaveLength(0);
 }));
 it.each(['sameWallet', 'otherWallet'] as const)('rejects copied signature reuse in %s even when mutable deposit uniqueness is bypassed', async scope => withFinalizedGems(async f => {
  const p = await f.credit(); const actor = scope === 'sameWallet' ? f.wallet : Keypair.generate().publicKey.toBase58();
  if (actor !== f.wallet) await f.conn.sql`insert into players(wallet,created_at) values(${actor},'2035-01-01T02:00:00Z')`;
  await f.credit(p, { direct: true, actor }); await f.close(); await expect(f.read(f.request)).rejects.toEqual(code('DUPLICATE_ORIGIN'));
 }));
 it('refuses a mismatched selected DB identity, changing genesis and impossible finalized slot', async () => withFinalizedGems(async f => {
  await f.credit(); await f.close();
  const wrong = createGemsFinalizedOriginReader(f.conn.db, { ...f.wiring, trust: { ...f.wiring.trust, cluster: 'mainnet-beta' } }); await expect(wrong(f.request)).rejects.toEqual(code('IDENTITY'));
  f.reader.getGenesisHash = async () => Keypair.generate().publicKey.toBase58(); await expect(f.read(f.request)).rejects.toEqual(code('IDENTITY'));
  f.reader.getGenesisHash = async () => f.genesis; f.reader.getSlot = async () => 99; await expect(f.read(f.request)).rejects.toEqual(code('CHAIN_MISMATCH'));
 }));
 it('binds v0 transaction keys and keeps provider disagreement unavailable', async () => withFinalizedGems(async f => {
  const original = await f.credit(f.transfer(undefined, undefined, 0)); await f.close(); expect((await f.read(f.request)).origins).toHaveLength(1);
  const priorKeys = [...original.tx.meta!.loadedAddresses!.writable]; original.tx.meta!.loadedAddresses!.writable = priorKeys.map(() => Keypair.generate().publicKey);
  await expect(f.read(f.request)).rejects.toEqual(code('CHAIN_MISMATCH')); original.tx.meta!.loadedAddresses!.writable = priorKeys;
  const other = { ...f.reader, getTransaction: async () => null }; const read = createGemsFinalizedOriginReader(f.conn.db, { ...f.wiring, connect: () => [f.reader, other] }); await expect(read(f.request)).rejects.toEqual(code('CHAIN_UNAVAILABLE'));
 }));

 it('bounds decoded RPC bytes before interpreting a huge balance or log', async () => withFinalizedGems(async f => {
  const p = await f.credit(); await f.close(); p.tx.meta!.logMessages = ['x'.repeat(1_048_577)];
  await expect(f.read(f.request)).rejects.toEqual(code('TOO_LARGE'));
  p.tx.meta!.logMessages = []; p.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount = '1'.repeat(1_048_577);
  await expect(f.read(f.request)).rejects.toEqual(code('TOO_LARGE'));
 }));
 it('bounds total decoded evidence across many distinct original payments', async () => withFinalizedGems(async f => {
  for (let i = 0; i < 17; i++) { const p = await f.credit(); p.tx.meta!.logMessages = ['x'.repeat(1_000_000)]; }
  await f.close(); await expect(f.read(f.request)).rejects.toEqual(code('TOO_LARGE'));
 }));
 it('bounds source origin count before any RPC request', async () => withFinalizedGems(async f => {
  for (let i = 0; i < 129; i++) await f.credit(undefined, { direct: true });
  await f.close(); await expect(f.read(f.request)).rejects.toEqual(code('TOO_LARGE')); expect(f.calls).toHaveLength(0);
 }));

 it('aborts bounded RPC waiting and cannot turn a hung provider into an empty origin set', async () => withFinalizedGems(async f => {
  await f.credit(); await f.close(); let enter!: () => void; const started = new Promise<void>(resolve => { enter = resolve; }); let signal: AbortSignal | undefined;
  f.reader.getTransaction = async () => { enter(); return new Promise(() => {}); };
  const read = createGemsFinalizedOriginReader(f.conn.db, { ...f.wiring, connect: value => { signal = value; return [f.reader]; } });
  const originalTimeout = globalThis.setTimeout;
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: Parameters<typeof setTimeout>[0], delay?: number, ...args: unknown[]) => originalTimeout(callback, delay === 10_000 ? 10 : delay, ...args)) as typeof setTimeout);
  try { const waiting = read(f.request).catch(error => error); await started; expect(await waiting).toEqual(code('CHAIN_UNAVAILABLE')); expect(signal?.aborted).toBe(true); }
  finally { timer.mockRestore(); }
 }));

 it('requires two distinct configured mainnet reader objects and accepts matching finalized providers', async () => withFinalizedGems(async f => {
  await f.credit(); await f.close(); await expect(f.read(f.request)).rejects.toEqual(code('IDENTITY'));
  const duplicate = createGemsFinalizedOriginReader(f.conn.db, { ...f.wiring, connect: () => [f.reader, f.reader] }); await expect(duplicate(f.request)).rejects.toEqual(code('IDENTITY'));
  const matching = createGemsFinalizedOriginReader(f.conn.db, { ...f.wiring, connect: () => [f.reader, { ...f.reader }] }); expect((await matching(f.request)).origins[0]?.finalizedContextSlots).toEqual([200, 200]);
 }, '2035-01-01T00:00:00Z', 'mainnet-beta'));
 it('bounds the complete signed packet and refuses oversized returned signature strings before decoding', async () => withFinalizedGems(async f => {
  const p = await f.credit(); await f.close(); const original = p.tx.transaction.signatures[0]!;
  p.tx.transaction.signatures[0] = '1'.repeat(1_048_577); await expect(f.read(f.request)).rejects.toEqual(code('CHAIN_MISMATCH'));
  p.tx.transaction.signatures = Array(20).fill(original); p.tx.transaction.message.header.numRequiredSignatures = 20;
  while (p.tx.transaction.message.staticAccountKeys.length < 20) p.tx.transaction.message.staticAccountKeys.push(Keypair.generate().publicKey);
  await expect(f.read(f.request)).rejects.toEqual(code('TOO_LARGE'));
 }));
 it('refuses unknown caller authority and open days before doing RPC work', async () => withFinalizedGems(async f => {
  await f.credit(); await expect(f.read({ ...f.request, finalized: true })).rejects.toEqual(code('INVALID_INPUT')); await expect(f.read(f.request)).rejects.toEqual(code('DAY_OPEN')); expect(f.calls).toHaveLength(0);
 }));
});
