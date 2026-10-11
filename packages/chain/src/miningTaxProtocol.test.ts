import { describe, it, expect } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { seekerAuctionPda, seekerTermPda } from './seekerAuctionProtocol';
import { miningEpochPda } from './miningProgramProtocol';
import { miningTermTaxPoolPda, miningTaxSpotCursorPda, miningTaxEpochReceiptPda } from './miningTaxCommitment';
import { decodeMiningTaxPool, decodeMiningTaxAccrual, decodeMiningTaxSpot, MINING_TAX_ACCOUNT_BYTES,
 buildOpenMiningTaxPoolInstruction, buildOpenMiningTaxSpotInstruction, buildAccrueMiningTaxInstruction, buildClaimMiningTaxInstruction, MiningTaxProtocolError } from './miningTaxProtocol';
import { createMiningTaxFixture, taxKey, taxFixtureCoder } from './testFixtures/miningTaxProtocol';

describe('original-term unsigned mining tax SDK', () => {
 it('decodes exact account bytes and independent cumulative counters without inferring finality or authority', async () => {
  const f = await createMiningTaxFixture();
  const pool = decodeMiningTaxPool(await f.raw('pool'), await f.context());
  expect(pool).toMatchObject({ version: 2, distributionVersion: 1, winnerCount: 3, accrued: 10n, paid: 3n,
   termIdentity: '6f6996699ff67fca924362b300b054fbcc7d3e5d8b63c798c10b7ff1a415edf8', finalityVerified: false, paymentAuthorized: false });
  expect(Object.isFrozen(pool)).toBe(true);
  expect(decodeMiningTaxAccrual(await f.raw('accrual'), await f.accrualContext())).toMatchObject({ amount: 10n, epoch: f.addresses.epoch.toBase58(), accruedAt: f.models.accrual.accrued_at, finalityVerified: false });
  expect(decodeMiningTaxSpot(await f.raw('cursor'), await f.cursorContext())).toMatchObject({ wallet: f.winner.toBase58(), spot: f.spot, claimedTotal: 3n, paymentAuthorized: false });
  expect(MINING_TAX_ACCOUNT_BYTES).toEqual({ MiningTaxPool: 125, MiningTaxAccrual: 123, MiningTaxSpot: 116 });
 });

 it.each(['pool', 'accrual', 'cursor'] as const)('rejects altered owner/address/size/discriminator/version/bump of %s', async which => {
  const f = await createMiningTaxFixture();
  const context = which === 'pool' ? await f.context() : which === 'accrual' ? await f.accrualContext() : await f.cursorContext();
  const decode = (raw: Awaited<ReturnType<typeof f.raw>>) => which === 'pool' ? decodeMiningTaxPool(raw, context as Awaited<ReturnType<typeof f.context>>) : which === 'accrual' ? decodeMiningTaxAccrual(raw, context as Awaited<ReturnType<typeof f.accrualContext>>) : decodeMiningTaxSpot(raw, context as Awaited<ReturnType<typeof f.cursorContext>>);
  for (const mutate of [
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.owner = taxKey(8); },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.address = taxKey(8); },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.executable = true; },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.data = a.data.subarray(0, -1); },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.data = Buffer.concat([a.data, Buffer.of(0)]); },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.data[0] = a.data[0]! ^ 1; },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.data.writeUInt16LE(1, 8); },
   (a: Awaited<ReturnType<typeof f.raw>>) => { a.data[a.data.length - 1] = a.data[a.data.length - 1]! ^ 1; },
  ]) { const raw = await f.raw(which); mutate(raw); expect(() => decode(raw)).toThrow(MiningTaxProtocolError); }
 });

 it('revalidates related config identity and canonical boolean bytes rather than accepting decoded caller counters', async () => {
  const f = await createMiningTaxFixture(), pool = await f.raw('pool');
  for (const change of ['boolean', 'vault', 'mint', 'reserve', 'claimed', 'taxPaid', 'overflow'] as const) {
   const g = await createMiningTaxFixture();
   if (change === 'vault') g.models.config.mining_vault = taxKey(8);
   if (change === 'mint') g.models.config.keep_mint = taxKey(8);
   if (change === 'reserve') g.models.config.emission_reserve_owner = taxKey(8);
   if (change === 'claimed') g.models.config.total_claimed = 801n;
   if (change === 'taxPaid') g.models.config.tax_paid = 101n;
   if (change === 'overflow') { g.models.config.total_published_highwater = (1n << 64n) - 1n; g.models.config.total_claimed = 0n; }
   const context = await g.context(); if (change === 'boolean') context.config.data[context.config.data.length - 2] = 2;
   expect(() => decodeMiningTaxPool(pool, context)).toThrow(MiningTaxProtocolError);
  }
 });

 it.each(['config', 'term', 'hash', 'winners', 'distribution', 'paid', 'highwater', 'globalPaid'] as const)('refuses pool identity/counter substitution: %s', async change => {
  const f = await createMiningTaxFixture();
  if (change === 'config') f.models.pool.config = taxKey(8);
  if (change === 'term') f.models.pool.term = taxKey(8);
  if (change === 'hash') f.models.pool.term_identity = new Uint8Array(32).fill(8);
  if (change === 'winners') f.models.pool.winner_count = 4;
  if (change === 'distribution') f.models.pool.distribution_version = 2;
  if (change === 'paid') f.models.pool.paid = 11n;
  if (change === 'highwater') f.models.pool.accrued = 101n;
  if (change === 'globalPaid') f.models.pool.paid = 4n;
  const raw = await f.raw('pool'), context = await f.context(); expect(() => decodeMiningTaxPool(raw, context)).toThrow(MiningTaxProtocolError);
 });

 it.each(['config', 'pool', 'epoch', 'amount', 'total', 'time', 'negativeTime', 'legacy', 'commitment', 'source', 'genesis', 'latest', 'unclosed'] as const)('binds accrual to its exact closed-day v2 epoch: %s', async change => {
  const f = await createMiningTaxFixture();
  if (change === 'config') f.models.accrual.config = taxKey(8);
  if (change === 'pool') f.models.accrual.pool = taxKey(8);
  if (change === 'epoch') f.models.accrual.epoch = taxKey(8);
  if (change === 'amount') f.models.accrual.amount = 9n;
  if (change === 'total') f.models.pool.accrued = 9n;
  if (change === 'time') f.models.accrual.accrued_at--;
  if (change === 'negativeTime') f.models.accrual.accrued_at = -1n;
  if (change === 'legacy') f.models.epoch.tax_version = 1;
  if (change === 'commitment') f.models.epoch.tax_commitment = new Uint8Array(32).fill(8);
  if (change === 'source') f.models.epoch.source_hash.fill(0);
  if (change === 'genesis') f.models.config.genesis_day = f.day + 1n;
  if (change === 'latest') f.models.config.latest_day = f.day - 1n;
  if (change === 'unclosed') f.models.epoch.funded_at--;
  const raw = await f.raw('accrual'), context = await f.accrualContext(); expect(() => decodeMiningTaxAccrual(raw, context)).toThrow(MiningTaxProtocolError);
 });

 it.each(['pool', 'auction', 'wallet', 'spot', 'entitlement', 'totalPaid', 'expectedWinner'] as const)('keeps each cursor on the original winning spot: %s', async change => {
  const f = await createMiningTaxFixture();
  if (change === 'pool') f.models.cursor.pool = taxKey(8);
  if (change === 'auction') f.models.cursor.auction = seekerAuctionPda(f.identity.programId, f.term.auctionConfig, f.spot, f.term.round + 1n);
  if (change === 'wallet') f.models.cursor.wallet = taxKey(8);
  if (change === 'spot') f.models.cursor.spot++;
  if (change === 'entitlement') { f.models.cursor.claimed_total = 4n; f.models.pool.paid = 4n; f.models.config.tax_paid = 4n; }
  if (change === 'totalPaid') f.models.pool.paid = 2n;
  const raw = await f.raw('cursor'), context = await f.cursorContext(); if (change === 'expectedWinner') context.winner = taxKey(8);
  expect(() => decodeMiningTaxSpot(raw, context)).toThrow(MiningTaxProtocolError);
 });

 it('allows cumulative equal shares and retained dust, zero accrual and already fully claimed records', async () => {
  const f = await createMiningTaxFixture();
  expect(decodeMiningTaxSpot(await f.raw('cursor'), await f.cursorContext()).claimedTotal).toBe(3n); // 10 / 3 leaves one in the term.
  f.models.pool.accrued = 12n; f.models.pool.paid = 4n; f.models.config.tax_paid = 4n; f.models.cursor.claimed_total = 4n;
  expect(decodeMiningTaxSpot(await f.raw('cursor'), await f.cursorContext()).claimedTotal).toBe(4n);
  f.models.pool.accrued = 0n; f.models.pool.paid = 0n; f.models.config.tax_paid = 0n; f.models.cursor.claimed_total = 0n;
  expect(decodeMiningTaxSpot(await f.raw('cursor'), await f.cursorContext()).claimedTotal).toBe(0n);
  f.models.accrual.amount = 0n; f.models.epoch.tax = 0n;
  expect(decodeMiningTaxAccrual(await f.raw('accrual'), await f.accrualContext()).amount).toBe(0n);
 });

 it('constructs all four exact no-argument instructions with IDL signer/writable flags and original-term accounts', async () => {
  const f = await createMiningTaxFixture(), t = f.term, a = f.addresses;
  const auction = seekerAuctionPda(t.programId, t.auctionConfig, f.spot, t.round);
  const cases = [
   { name: 'open_mining_tax_pool', ix: buildOpenMiningTaxPoolInstruction(t, { payer: f.payer }), keys: [f.payer, t.config, t.auctionConfig, t.registry, t.term, a.pool, SystemProgram.programId] },
   { name: 'open_mining_tax_spot', ix: buildOpenMiningTaxSpotInstruction(t, { payer: f.payer, spot: f.spot }), keys: [f.payer, t.config, t.auctionConfig, t.registry, t.term, a.pool, auction, a.cursor, SystemProgram.programId] },
   { name: 'accrue_mining_tax', ix: buildAccrueMiningTaxInstruction(t, { payer: f.payer, day: f.day }), keys: [f.payer, t.config, t.auctionConfig, t.registry, t.term, a.pool, a.epoch, a.accrual, SystemProgram.programId] },
   { name: 'claim_mining_tax', ix: buildClaimMiningTaxInstruction(t, { claimant: f.winner, spot: f.spot }), keys: [f.winner, t.config, t.auctionConfig, t.registry, t.term, a.pool, auction, a.cursor, getAssociatedTokenAddressSync(t.keepMint, t.config, true), getAssociatedTokenAddressSync(t.keepMint, f.winner, true), t.keepMint, TOKEN_PROGRAM_ID] },
  ];
  for (const { name, ix, keys } of cases) {
   expect(ix.programId.equals(t.programId)).toBe(true); expect(ix.data).toEqual(taxFixtureCoder.instruction.encode(name, {})); expect(ix.data.length).toBe(8);
   expect(ix.keys.map(k => k.pubkey.toBase58())).toEqual(keys.map(k => k.toBase58()));
   const entry = idl.instructions.find(i => i.name === name)!;
   expect(ix.keys.map(k => [k.isSigner, k.isWritable])).toEqual(entry.accounts.map(k => ['signer' in k && k.signer === true, 'writable' in k && k.writable === true]));
  }
  expect(cases[3]!.ix.keys[0]).toMatchObject({ isSigner: true, isWritable: false });
 });

 it('keeps old-term rights after a later lease exists and pins day/round PDA vectors', async () => {
  const f = await createMiningTaxFixture(), t = f.term;
  const later = { ...t, round: t.round + 1n, term: seekerTermPda(t.programId, t.auctionConfig, t.round + 1n),
   auctionStart: t.auctionStart + 604800n, auctionEnd: t.auctionEnd + 604800n, operatingStart: t.operatingStart + 604800n, operatingEnd: t.operatingEnd + 604800n };
  const old = buildClaimMiningTaxInstruction(t, { claimant: f.winner, spot: f.spot }), current = buildClaimMiningTaxInstruction(later, { claimant: f.winner, spot: f.spot });
  expect(old.keys[5]!.pubkey.equals(miningTermTaxPoolPda(t.programId, t.term))).toBe(true);
  expect(current.keys[5]!.pubkey.equals(old.keys[5]!.pubkey)).toBe(false);
  expect(old.keys[7]!.pubkey.equals(miningTaxSpotCursorPda(t.programId, f.addresses.pool, f.spot))).toBe(true);
  const next = buildAccrueMiningTaxInstruction(t, { payer: f.payer, day: f.day + 1n });
  expect(next.keys[7]!.pubkey.equals(miningTaxEpochReceiptPda(t.programId, miningEpochPda(t.programId, f.day + 1n)))).toBe(true);
  expect(next.keys[7]!.pubkey.equals(f.addresses.accrual)).toBe(false);
 });

 it('refuses caller payout/destination/current-lease fields and malformed uint/key/term inputs', async () => {
  const f = await createMiningTaxFixture(), t = f.term;
  for (const extra of [{ amount: 1n }, { destination: taxKey(8) }, { currentLease: t.term }]) {
   expect(() => buildClaimMiningTaxInstruction(t, { claimant: f.winner, spot: f.spot, ...extra })).toThrow(MiningTaxProtocolError);
  }
  for (const spot of [-1, 100, 1.5, NaN]) expect(() => buildOpenMiningTaxSpotInstruction(t, { payer: f.payer, spot })).toThrow(MiningTaxProtocolError);
  for (const day of [0n, -1n, 22n, 30n, 1n << 64n, 24 as unknown as bigint]) expect(() => buildAccrueMiningTaxInstruction(t, { payer: f.payer, day })).toThrow(MiningTaxProtocolError);
  for (const term of [{ ...t, round: -1n }, { ...t, round: 1n << 64n }, { ...t, winnerCount: 0 }, { ...t, winnerCount: 101 },
   { ...t, operatingEnd: t.operatingEnd + 1n }, { ...t, programId: taxKey(8) }, { ...t, keepMint: PublicKey.default },
   { ...t, config: taxKey(8) }, { ...t, extra: true }]) expect(() => buildOpenMiningTaxPoolInstruction(term, { payer: f.payer })).toThrow(MiningTaxProtocolError);
  expect(() => buildClaimMiningTaxInstruction(t, { claimant: PublicKey.default, spot: f.spot })).toThrow(MiningTaxProtocolError);
  expect(() => buildOpenMiningTaxPoolInstruction(t, { payer: { toBytes: () => new Uint8Array(33), toBase58: () => f.payer.toBase58() } as PublicKey })).toThrow(MiningTaxProtocolError);
 });

 it('refuses unknown decoder expectation/identity fields and mismatched program or KEEP identity', async () => {
  const f = await createMiningTaxFixture(), raw = await f.raw('pool'), context = await f.context();
  for (const c of [{ ...context, authorized: true }, { ...context, identity: { ...context.identity, keepMint: taxKey(8) } },
   { ...context, identity: { ...context.identity, extra: true } }]) expect(() => decodeMiningTaxPool(raw, c)).toThrow(MiningTaxProtocolError);
 });
 it('preserves full-width tax counters without number coercion or inferred payment authority', async () => {
  const f = await createMiningTaxFixture(), max = (1n << 64n) - 1n;
  f.models.config.total_published_highwater = f.models.config.total_claimed;
  f.models.config.tax_highwater = max; f.models.config.tax_paid = max - 1n;
  f.models.pool.accrued = max; f.models.pool.paid = max - 1n;
  const decoded = decodeMiningTaxPool(await f.raw('pool'), await f.context());
  expect(decoded).toMatchObject({ accrued: max, paid: max - 1n, finalityVerified: false, paymentAuthorized: false });
  expect(typeof decoded.accrued).toBe('bigint'); expect(Object.isFrozen(decoded)).toBe(true);
 });
});
