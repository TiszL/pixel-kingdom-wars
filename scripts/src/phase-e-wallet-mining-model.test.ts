import { describe, expect, it } from 'vitest';
import {
  KEEP_ATOMS, WALLET_MINING_PARAMS as P, baseBonusBps, baseScoreBps,
  refineWalletIngots, retainedScoreBps, settleWalletMining,
  type MiningBase, type MiningWallet,
} from './phase-e-wallet-mining-model';

const budget = BigInt(P.dailyCeilingKeep) * KEEP_ATOMS;
const base = (id: string, changes: Partial<MiningBase> = {}): MiningBase => ({
  id, hasDeed: true, genesis: false, ownedEntireDay: true, forgeReady: true,
  progressBps: 10_000, committedIngots: 24, ...changes,
});
const wallet = (id: string, changes: Partial<MiningWallet> = {}): MiningWallet => ({
  id, controller: id, seeker: false, ownsAnyDeed: true, developmentEligible: true,
  freshActivity: true, activityBps: 10_000, experienceBps: 10_000,
  usefulChainBps: 10_000, hoursSinceScoreRefresh: 0, bases: [base(`${id}-base`)], ...changes,
});
const free = (id: string, changes: Partial<MiningWallet> = {}): MiningWallet => wallet(id, {
  ownsAnyDeed: false, bases: [base(`${id}-free`, { hasDeed: false, committedIngots: 2 })], ...changes,
});
const total = (result: ReturnType<typeof settleWalletMining>): bigint =>
  [...result.walletAwards.values()].reduce((a, b) => a + b, 0n);

describe('owner-revised mining PROTOTYPE: intent and limits', () => {
  it('an unfunded pool releases inputs instead of burning resources for guaranteed zero payout', () => {
    const empty = settleWalletMining([wallet('d'), free('f')], 0n);
    expect(empty.entries.every((e) => e.consumed === 0 && e.returned > 0)).toBe(true);
    const dustFunding = settleWalletMining([wallet('d'), free('f')], 1n);
    expect(dustFunding.entries.find((e) => e.pool === 'free')?.consumed).toBe(0);
  });
  it('without a proposed floor a sole eligible deed wallet receives the entire deed pool', () => {
    const result = settleWalletMining([wallet('sole')], budget, false, { free: 0, deed: 0 });
    expect(result.walletAwards.get('sole')).toBe(93_100n * KEEP_ATOMS);
    expect(settleWalletMining([wallet('idle', { freshActivity: false })], budget, false, { free: 0, deed: 0 }).walletAwards.get('idle')).toBe(0n);
  });
  it('never issues more than either funded pool, including integer dust', () => {
    for (const population of [0, 1, 200, 1_000, 10_000]) {
      const wallets = Array.from({ length: population }, (_, i) => i % 4 === 0
        ? wallet(`d${i}`, { seeker: i % 8 === 0 }) : free(`f${i}`));
      for (const funding of [0n, 123_456n, budget / 7n, budget, budget * 2n]) {
        const result = settleWalletMining(wallets, funding);
        const f = result.pools.free; const d = result.pools.deed;
        expect(f.budget + d.budget).toBe(result.budget);
        expect(f.awarded + f.retained).toBe(f.budget);
        expect(d.awarded + d.retained).toBe(d.budget);
        expect(total(result) + f.retained + d.retained).toBe(result.budget);
        expect(f.retained >= 0n && d.retained >= 0n && result.budget <= funding).toBe(true);
        expect(result.budget <= budget).toBe(true);
      }
    }
  });
  it('an empty pool is retained rather than donated to the other pool', () => {
    const deeds = Array.from({ length: 200 }, (_, i) => wallet(`d${i}`));
    const result = settleWalletMining(deeds, budget);
    expect(result.pools.free.retained).toBe(4_900n * KEEP_ATOMS);
    expect(result.pools.deed.awarded <= 93_100n * KEEP_ATOMS).toBe(true);
  });
  it('two free bases share exactly two units; Seeker cannot promote them into the deed pool', () => {
    const w = free('free', { seeker: true, bases: [
      base('f1', { hasDeed: false }), base('f2', { hasDeed: false }),
    ] });
    const result = settleWalletMining([w], budget);
    expect(result.entries.reduce((sum, e) => sum + e.consumed, 0)).toBe(2);
    expect(result.entries.every((e) => e.pool === 'free' && e.bonusBps === 11_000)).toBe(true);
  });
  it('provisionally keeps deed-wallet free bases out of the deedless pool', () => {
    const result = settleWalletMining([wallet('mixed', { bases: [base('d'), base('f', { hasDeed: false })] })], budget);
    expect(result.entries.find((e) => e.baseId === 'f')?.award).toBe(0n);
    expect(result.pools.free.totalWeight).toBe(0n);
  });
  it('allows proportional accrual above the withdrawn 1000 cap; five Genesis bases each get only 30% weight bonus', () => {
    const w = wallet('max', { seeker: true, bases: Array.from({ length: 5 }, (_, i) => base(`g${i}`, { genesis: true })) });
    const result = settleWalletMining([w], budget);
    expect(result.walletAwards.get('max')).toBe(7_261_800_000_000n);
    expect(result.entries.every((e) => e.bonusBps === 13_000)).toBe(true);
  });
  it('never compounds Genesis across bases; mixed roster gets each base entitlement only', () => {
    const w = wallet('mixed', { seeker: true });
    expect(baseBonusBps(w, base('ordinary'))).toBe(11_000);
    expect(baseBonusBps(w, base('genesis', { genesis: true }))).toBe(13_000);
    expect(baseBonusBps(wallet('other'), base('genesis', { genesis: true }))).toBe(12_000);
  });
  it('a 30% weight boost does not promise 30% actual payout when every competitor gets it', () => {
    const original = Array.from({ length: 200 }, (_, i) => wallet(`w${i}`));
    const boosted = original.map((w) => ({ ...w, seeker: true, bases: w.bases.map((b) => ({ ...b, genesis: true })) }));
    const before = settleWalletMining(original, budget); const after = settleWalletMining(boosted, budget);
    expect(after.entries[0]!.weight * 10n).toBe(before.entries[0]!.weight * 13n);
    expect(after.walletAwards.get('w0')).toBe(before.walletAwards.get('w0'));
  });
  it.each(['freshActivity', 'developmentEligible'] as const)('%s cannot be replaced by old progress or bought ingots', (gate) => {
    const result = settleWalletMining([wallet('idle', { [gate]: false })], budget);
    expect(result.walletAwards.get('idle')).toBe(0n);
    expect(result.entries[0]!.returned).toBe(24);
  });
  it('retains score at 48 hours but a missed day still earns nothing', () => {
    const w = wallet('idle', { freshActivity: false, hoursSinceScoreRefresh: 48 });
    expect(baseScoreBps(w, w.bases[0]!)).toBe(10_000);
    expect(settleWalletMining([w], budget).walletAwards.get('idle')).toBe(0n);
  });
  it('keeps the exact 48-hour grace and reaches non-mineable score at the proposed 7-day boundary', () => {
    expect(retainedScoreBps(47)).toBe(10_000); expect(retainedScoreBps(48)).toBe(10_000);
    expect(retainedScoreBps(49)).toBe(9_916); expect(retainedScoreBps(108)).toBe(5_000);
    expect(retainedScoreBps(167)).toBe(83); expect(retainedScoreBps(168)).toBe(0);
    const w = wallet('zero', { hoursSinceScoreRefresh: 168 });
    expect(settleWalletMining([w], budget).walletAwards.get('zero')).toBe(0n);
  });
  it('no daily resource contribution means no reward despite full score', () => {
    const w = wallet('no-resource', { bases: [base('empty', { committedIngots: 0 })] });
    expect(settleWalletMining([w], budget).walletAwards.get(w.id)).toBe(0n);
  });
  it('ownership changes invalidate that base without consuming its commitment', () => {
    const w = wallet('transferred', { bases: [base('gone', { ownedEntireDay: false })] });
    const result = settleWalletMining([w], budget);
    expect(result.entries[0]!.consumed).toBe(0); expect(result.entries[0]!.returned).toBe(24);
  });
  it('aborting releases every commitment and emits zero in either pool', () => {
    const result = settleWalletMining([wallet('deed'), free('free')], budget, true);
    expect(total(result)).toBe(0n);
    expect(result.entries.every((e) => e.consumed === 0 && e.returned > 0)).toBe(true);
    expect(result.pools.deed.retained + result.pools.free.retained).toBe(budget);
  });
  it('the 5% bound limits a bot ring collectively but does not prevent it diluting honest users', () => {
    const honest = Array.from({ length: 1_000 }, (_, i) => free(`h${i}`));
    const bots = Array.from({ length: 9_000 }, (_, i) => free(`b${i}`, { controller: 'one-controller' }));
    const before = settleWalletMining(honest, budget); const after = settleWalletMining([...honest, ...bots], budget);
    const ring = bots.reduce((sum, b) => sum + after.walletAwards.get(b.id)!, 0n);
    expect(ring).toBe(4_410n * KEEP_ATOMS);
    expect(after.walletAwards.get('h0')! * 10n).toBe(before.walletAwards.get('h0'));
  });
  it('splitting an identical paid roster across wallets cannot create a gain from the removed wallet payout cap', () => {
    const together = wallet('one', { seeker: true, bases: Array.from({ length: 5 }, (_, i) => base(`b${i}`, { genesis: true })) });
    const split = together.bases.map((b, i) => wallet(`split${i}`, { controller: 'one-controller', seeker: true, bases: [b] }));
    expect(total(settleWalletMining([together], budget))).toBe(total(settleWalletMining(split, budget)));
    expect(total(settleWalletMining(split, budget))).toBe(7_261_800_000_000n);
  });
  it('rejects duplicate wallet/base rows instead of paying twice', () => {
    expect(() => settleWalletMining([wallet('a'), wallet('a')], budget)).toThrow('duplicate wallet');
    expect(() => settleWalletMining([wallet('a'), wallet('b', { bases: [base('a-base')] })], budget)).toThrow('duplicate base');
  });
  it('enforces roster and free-base count separately', () => {
    expect(() => settleWalletMining([wallet('six', { bases: Array.from({ length: 6 }, (_, i) => base(`b${i}`)) })], budget)).toThrow('too many active');
    expect(() => settleWalletMining([free('three', { bases: Array.from({ length: 3 }, (_, i) => base(`b${i}`, { hasDeed: false })) })], budget)).toThrow('too many free');
  });
  it('refining requires Workshop and the full 10000-SHARDS recipe', () => {
    const input = { workshopReady: true, shards: 19_999, requested: 2, capacity: 2, refinedToday: 0, held: 0, listed: 0, reserved: 0, inProgress: 0 };
    expect(refineWalletIngots(input)).toEqual({ ingots: 1, shardsSunk: 10_000 });
    expect(refineWalletIngots({ ...input, workshopReady: false })).toEqual({ ingots: 0, shardsSunk: 0 });
  });
  it('listed/reserved/in-progress inventory cannot evade the refining or storage limits', () => {
    const input = { workshopReady: true, shards: 100_000, requested: 10, capacity: 2, refinedToday: 5, held: 0, listed: 0, reserved: 0, inProgress: 0 };
    expect(refineWalletIngots(input).ingots).toBe(1);
    expect(refineWalletIngots({ ...input, refinedToday: 0, held: 3, listed: 4, reserved: 3, inProgress: 3 }).ingots).toBe(1);
    expect(refineWalletIngots({ ...input, held: 14 }).ingots).toBe(0);
  });
  it('rejects malformed negative funding or noninteger scores rather than producing invalid balances', () => {
    expect(() => settleWalletMining([], -1n)).toThrow('negative funding');
    expect(() => settleWalletMining([wallet('bad', { activityBps: 1.2 })], budget)).toThrow('safe integer');
    expect(() => settleWalletMining([wallet('bad', { usefulChainBps: 10_001 })], budget)).toThrow('exceeds BPS');
  });
});
