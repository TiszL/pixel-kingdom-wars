import { randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { CAPS, STRUCTURES } from '@shardkeep/shared';
import type { BasePurchaseNetwork, BasePurchaseRequest } from '@shardkeep/shared/basePurchases';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bases, baseSlots, deposits, players } from '../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { claimRect, insideClaim } from '../src/game/footprints';
import { getBasePurchase, quoteBasePurchase } from '../src/money/basePurchases';
import { creditDeposit, type VerifiedPayment } from '../src/money/deposits';
import { expansionOffer } from '../src/money/expansion';
import { connectTestDb, createTestPlayer, randomWallet } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const original = { expansionsMax: CAPS.expansionsMax, claimTilesByExpansion: CAPS.claimTilesByExpansion,
  expansionReqKeepLevel: CAPS.expansionReqKeepLevel, expansionPriceSolByIndex: CAPS.expansionPriceSolByIndex };
const enabled = process.env['BASE_PURCHASE_V1_ENABLED'];
beforeEach(() => { process.env['BASE_PURCHASE_V1_ENABLED'] = 'true'; });
afterEach(() => {
  Object.assign(CAPS, original);
  if (enabled === undefined) delete process.env['BASE_PURCHASE_V1_ENABLED']; else process.env['BASE_PURCHASE_V1_ENABLED'] = enabled;
});
afterAll(async () => { await conn.sql.end(); });
const now = new Date('2034-09-15T00:00:00.000Z');
const network: BasePurchaseNetwork = { cluster: 'devnet', coreProgram: randomWallet(), configPda: randomWallet(),
  treasuryLiquidity: randomWallet(), treasuryDev: randomWallet(), treasuryOps: randomWallet(), systemProgram: '11111111111111111111111111111111' };
async function fixture() {
  const { wallet } = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', landPaidAt: now, keepLevel: STRUCTURES.keep.maxLevel }).returning();
  const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  const request = (expectedExpansions = 0): BasePurchaseRequest => ({ kind: 'expansion', baseId, expectedExpansions, idempotencyKey: randomUUID() });
  const prepare = async (id: string) => ({ baseId: id,
    assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], actor: string, target: string) => {
      await assertFreshLockedBaseAuthority(tx, actor, target);
    },
  });
  const quote = (r = request()) => quoteBasePurchase(db, wallet, r, network, now, prepare);
  const read = async () => ({ base: (await db.select().from(bases).where(eq(bases.id, baseId)))[0]!,
    player: (await db.select().from(players).where(eq(players.wallet, wallet)))[0]! });
  return { wallet, baseId, request, quote, read };
}
function payment(status: Awaited<ReturnType<typeof getBasePurchase>>): VerifiedPayment {
  const quote = status.purchase!.quote;
  return { wallet: quote.wallet, kind: 'expansion', finalized: true, txSignature: bs58.encode(randomBytes(64)),
    lamports: BigInt(quote.amountLamports), basePurchaseV1: quote };
}

describe.sequential('canonical expansion offers and locked grants', () => {
  it('keeps every approved step, price and Keep gate authoritative', () => {
    for (let index = 0; index < CAPS.expansionsMax; index++) {
      const gate = CAPS.expansionReqKeepLevel[index]!;
      expect(expansionOffer(index, gate)).toEqual({ expectedExpansions: index,
        fromClaimTiles: CAPS.claimTilesByExpansion[index], toClaimTiles: CAPS.claimTilesByExpansion[index + 1],
        requiredKeepLevel: gate, amountLamports: Math.round(CAPS.expansionPriceSolByIndex[index]! * 1_000_000_000) });
      expect(() => expansionOffer(index, gate - 1)).toThrow(`requires Keep level ${gate}`);
    }
    expect(() => expansionOffer(CAPS.expansionsMax, STRUCTURES.keep.maxLevel)).toThrow('max land expansions');
  });
  for (const [name, patch] of [
    ['missing price', () => ({ expansionPriceSolByIndex: original.expansionPriceSolByIndex.slice(0, -1) })],
    ['missing Keep gate', () => ({ expansionReqKeepLevel: original.expansionReqKeepLevel.slice(0, -1) })],
    ['missing claim', () => ({ claimTilesByExpansion: original.claimTilesByExpansion.slice(0, -1) })],
    ['absent price table', () => ({ expansionPriceSolByIndex: undefined })],
    ['absent gate table', () => ({ expansionReqKeepLevel: undefined })],
    ['sparse price', () => ({ expansionPriceSolByIndex: Array(original.expansionsMax) })],
    ['sparse gate', () => ({ expansionReqKeepLevel: Array(original.expansionsMax) })],
    ['zero price', () => ({ expansionPriceSolByIndex: original.expansionPriceSolByIndex.map((v, i) => i ? v : 0) })],
    ['nonfinite price', () => ({ expansionPriceSolByIndex: original.expansionPriceSolByIndex.map((v, i) => i ? v : NaN) })],
    ['fractional lamport', () => ({ expansionPriceSolByIndex: original.expansionPriceSolByIndex.map((v, i) => i ? v : 0.0000000001) })],
    ['unsupported Keep gate', () => ({ expansionReqKeepLevel: original.expansionReqKeepLevel.map((v, i) => i ? v : STRUCTURES.keep.maxLevel + 1) })],
    ['odd claim', () => ({ claimTilesByExpansion: original.claimTilesByExpansion.map((v, i) => i ? v : v + 1) })],
    ['shrinking claim', () => ({ claimTilesByExpansion: original.claimTilesByExpansion.map((v, i) => i === 1 ? original.claimTilesByExpansion[0] : v) })],
  ] as const) it(`${name} refuses new quotes rather than inventing defaults`, async () => {
    const f = await fixture(); Object.assign(CAPS, patch());
    expect(() => expansionOffer(0, STRUCTURES.keep.maxLevel)).toThrow('Land expansion rules are unavailable');
    await expect(f.quote()).rejects.toMatchObject({ statusCode: 503, code: 'EXPANSION_RULES_UNAVAILABLE' });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
  });
  it('applies all twelve expansions immediately once, preserving the centre and sole-base shadow', async () => {
    const f = await fixture();
    for (let index = 0; index < CAPS.expansionsMax; index++) {
      const status = await f.quote(f.request(index)); const pay = payment(status); const q = status.purchase!.quote;
      expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(true);
      expect((await creditDeposit(db, q.depositId, pay, now)).credited).toBe(false);
      expect(await f.read()).toMatchObject({ base: { expansions: index + 1 }, player: { expansions: index + 1 } });
      const { min, max } = claimRect(index + 1);
      expect(min + max).toBe(30);
      expect(max - min).toBe(CAPS.claimTilesByExpansion[index + 1]);
      for (const tx of [min, max - 1]) for (const ty of [min, max - 1]) {
        expect(insideClaim({ tx, ty, fw: 1, fh: 1 }, index + 1)).toBe(true);
      }
      expect((await getBasePurchase(db, f.wallet, q.request.idempotencyKey)).purchase).toMatchObject({
        quote: q, status: 'credited', receipt: { amountLamports: q.amountLamports, txSignature: pay.txSignature },
      });
    }
    expect(claimRect(CAPS.expansionsMax)).toEqual({ min: -10, max: 40 });
  });
  for (const index of [6, 7, 8, 9, 10, 11]) it(`enforces the Keep gate and original sequential slot for new purchase ${index + 1}`, async () => {
    const f = await fixture(); const gate = CAPS.expansionReqKeepLevel[index]!;
    await db.update(bases).set({ expansions: index, keepLevel: gate - 1 }).where(eq(bases.id, f.baseId));
    await expect(f.quote(f.request(index))).rejects.toMatchObject({ statusCode: 422 });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
    await db.update(bases).set({ keepLevel: gate }).where(eq(bases.id, f.baseId));
    await expect(f.quote(f.request(index - 1))).rejects.toMatchObject({ code: 'BASE_PURCHASE_CHANGED' });
    expect(await db.select().from(deposits).where(eq(deposits.playerWallet, f.wallet))).toHaveLength(0);
    const status = await f.quote(f.request(index));
    expect(status.purchase!.quote.amountLamports).toBe(String(CAPS.expansionPriceSolByIndex[index]! * 1_000_000_000));
    await creditDeposit(db, status.purchase!.quote.depositId, payment(status), now);
    expect((await f.read()).base).toMatchObject({ expansions: index + 1, keepLevel: gate, builders: 1 });
  });
  it('settles a quote frozen under the original six-step rules after the append, without changing its amount or identity', async () => {
    const f = await fixture();
    await db.update(bases).set({ expansions: 5 }).where(eq(bases.id, f.baseId));
    Object.assign(CAPS, { expansionsMax: 6, claimTilesByExpansion: original.claimTilesByExpansion.slice(0, 7),
      expansionPriceSolByIndex: original.expansionPriceSolByIndex.slice(0, 6), expansionReqKeepLevel: original.expansionReqKeepLevel.slice(0, 6) });
    const status = await f.quote(f.request(5)); const q = status.purchase!.quote; const pay = payment(status);
    expect(q.amountLamports).toBe('1500000000');
    Object.assign(CAPS, original);
    await creditDeposit(db, q.depositId, pay, now);
    expect((await f.read()).base.expansions).toBe(6);
    expect((await getBasePurchase(db, f.wallet, q.request.idempotencyKey)).purchase).toMatchObject({
      quote: q, status: 'credited', receipt: { amountLamports: q.amountLamports, txSignature: pay.txSignature },
    });
    expect((await f.quote(f.request(6))).purchase!.quote.amountLamports).toBe('1750000000');
  });
  for (const mode of ['changed', 'missing'] as const) it(`settles a frozen quote when today's price is ${mode}, without repricing its receipt`, async () => {
    const f = await fixture(); const status = await f.quote(); const q = status.purchase!.quote; const pay = payment(status);
    Object.assign(CAPS, { expansionPriceSolByIndex: mode === 'missing' ? [] : original.expansionPriceSolByIndex.map(price => price + 1) });
    await creditDeposit(db, q.depositId, pay, now);
    expect((await f.read()).base.expansions).toBe(1);
    expect((await getBasePurchase(db, f.wallet, q.request.idempotencyKey)).purchase).toMatchObject({
      quote: q, amount: q.amountLamports, receipt: { amountLamports: q.amountLamports, txSignature: pay.txSignature },
    });
  });
  for (const problem of ['amount', 'gate', 'slot', 'epoch'] as const) it(`${problem} mismatch rolls back both the grant and credited payment`, async () => {
    const f = await fixture(); const status = await f.quote(); const q = status.purchase!.quote; const pay = payment(status);
    if (problem === 'amount') pay.lamports += 1n;
    if (problem === 'gate') Object.assign(CAPS, { expansionReqKeepLevel: [] });
    if (problem === 'slot') await db.update(bases).set({ expansions: 1 }).where(eq(bases.id, f.baseId));
    if (problem === 'epoch') await db.update(bases).set({ landPaidAt: new Date(now.getTime() + 1) }).where(eq(bases.id, f.baseId));
    await expect(creditDeposit(db, q.depositId, pay, now)).rejects.toBeDefined();
    expect((await f.read()).base.expansions).toBe(problem === 'slot' ? 1 : 0);
    expect((await getBasePurchase(db, f.wallet, q.request.idempotencyKey)).purchase).toMatchObject({ status: 'pending', receipt: null, txSignature: null });
  });
  it('does not copy a deed-specific expansion into a multi-base wallet shadow', async () => {
    const f = await fixture(); await db.insert(bases).values({ ownerWallet: f.wallet, status: 'inactive', landPaidAt: now });
    const status = await f.quote(); await creditDeposit(db, status.purchase!.quote.depositId, payment(status), now);
    expect(await f.read()).toMatchObject({ base: { expansions: 1 }, player: { expansions: 0 } });
  });
  it('serializes simultaneous settlement retries into exactly one sequential grant', async () => {
    const f = await fixture(); const status = await f.quote(); const pay = payment(status);
    const results = await Promise.all(Array.from({ length: 3 }, () => creditDeposit(db, status.purchase!.quote.depositId, pay, now)));
    expect(results.filter(result => result.credited)).toHaveLength(1);
    expect(await f.read()).toMatchObject({ base: { expansions: 1 }, player: { expansions: 1 } });
  });
});
