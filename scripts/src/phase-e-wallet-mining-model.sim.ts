/** PROTOTYPE snapshot scenarios, not forecasts. No wall-clock or external I/O. */
import { getMiningQuota } from '@shardkeep/shared';
import { KEEP_ATOMS, WALLET_MINING_PARAMS as P, settleWalletMining,
  type MiningWallet, type MiningBase } from './phase-e-wallet-mining-model';

// Fixture population assumptions: 60% free, 20% ordinary deed, 10% Seeker+
// Genesis, 5% mixed five-base owners, 5% maxed idle. Seed changes normalized
// scores only; no claim is made about observed player distributions.
let state = 20_260_920;
function next(): number { state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0; return state; }
function base(id: string, hasDeed: boolean, genesis = false): MiningBase {
  return { id, hasDeed, genesis, ownedEntireDay: true, forgeReady: true,
    progressBps: 2_500 + next() % 7_501, committedIngots: hasDeed ? 24 : 2 };
}
function wallet(id: string, group: number): MiningWallet {
  const free = group < 60;
  const seeker = group >= 80 && group < 95;
  const bases = group >= 90 ? Array.from({ length: 5 }, (_, j) => base(`${id}-${j}`, true, j % 2 === 0))
    : [base(`${id}-0`, !free, seeker)];
  const sampledActivity = 5_000 + next() % 5_001;
  const sampledExperience = 2_500 + next() % 7_501;
  const sampledChain = free ? 0 : next() % 10_001;
  if (group >= 95) for (const b of bases) b.progressBps = 10_000;
  return { id, controller: id, seeker, ownsAnyDeed: !free, developmentEligible: true,
    freshActivity: group < 95, activityBps: group >= 95 ? 10_000 : sampledActivity,
    experienceBps: group >= 95 ? 10_000 : sampledExperience, usefulChainBps: group >= 95 ? 10_000 : sampledChain,
    hoursSinceScoreRefresh: group < 95 ? 0 : 48, bases };
}
const budget = BigInt(P.dailyCeilingKeep) * KEEP_ATOMS;
const fmt = (n: bigint): string => `${n / KEEP_ATOMS}.${(n % KEEP_ATOMS / 1_000_000n).toString().padStart(3, '0')}`;
console.log('PROTOTYPE snapshot outputs; all normalized activity/resource availability are assumptions.');
console.log('population | floor units per pool | free KEEP/wallet | deed KEEP/wallet | idle | paid total | retained | highest wallet');
for (const population of [200, 1_000, 10_000]) {
  state = 20_260_920;
  const wallets = Array.from({ length: population }, (_, i) => wallet(`w${i}`, i % 100));
  for (const floor of [0, 2_000]) {
    const r = settleWalletMining(wallets, budget, false, { free: floor, deed: floor });
    const free = wallets.filter((w) => !w.ownsAnyDeed);
    const deed = wallets.filter((w) => w.ownsAnyDeed && w.freshActivity);
    const avg = (ws: MiningWallet[]): bigint => ws.reduce((s, w) => s + r.walletAwards.get(w.id)!, 0n) / BigInt(ws.length);
    const max = [...r.walletAwards.values()].reduce((a, b) => a > b ? a : b, 0n);
    const idle = wallets.filter((w) => !w.freshActivity).reduce((s, w) => s + r.walletAwards.get(w.id)!, 0n);
    console.log(`${population} | ${floor} | ${fmt(avg(free))} | ${fmt(avg(deed))} | ${fmt(idle)} | ${fmt(r.pools.free.awarded + r.pools.deed.awarded)} | ${fmt(r.pools.free.retained + r.pools.deed.retained)} | ${fmt(max)}`);
  }
}
console.log('\nCurrent production SHARDS reference, no spending/losses, no referrals, epoch=10000:');
console.log('Keep/Mines | quota without old streak | quota with old streak | days per 10k ingot | days per 100k second base');
for (const [keep, count, mine] of [[1, 1, 1], [1, 2, 1], [4, 5, 4], [10, 8, 10], [20, 8, 20]]) {
  const quota = getMiningQuota(keep!, Array.from({ length: count! }, () => mine!), 0);
  const streakQuota = getMiningQuota(keep!, Array.from({ length: count! }, () => mine!), 7);
  // Display decimals only; all simulated settlement uses integers/bigint.
  console.log(`L${keep}/${count}xL${mine} | ${quota} | ${streakQuota} | ${(P.shardsPerIngot / quota).toFixed(2)} | ${(P.secondFreeBaseShards / quota).toFixed(2)}`);
}
console.log('\nAdversary: 1000 identical honest free wallets, plus 9000 equally qualified bot wallets, each commits 2 ingots.');
const matureFree = (id: string, controller = id): MiningWallet => ({
  id, controller, seeker: false, ownsAnyDeed: false, developmentEligible: true, freshActivity: true,
  activityBps: 10_000, experienceBps: 10_000, usefulChainBps: 10_000, hoursSinceScoreRefresh: 0,
  bases: [{ id: `${id}-free`, hasDeed: false, genesis: false, ownedEntireDay: true, forgeReady: true, progressBps: 10_000, committedIngots: 2 }],
});
const honest = Array.from({ length: 1_000 }, (_, i) => matureFree(`h${i}`));
const bots = Array.from({ length: 9_000 }, (_, i) => matureFree(`b${i}`, 'ring'));
const before = settleWalletMining(honest, budget); const after = settleWalletMining([...honest, ...bots], budget);
console.log(`Honest before=${fmt(before.walletAwards.get('h0')!)}; after=${fmt(after.walletAwards.get('h0')!)}; ring=${fmt(bots.reduce((s, w) => s + after.walletAwards.get(w.id)!, 0n))} KEEP/day`);
console.log('This proves the pool ceiling, NOT Sybil resistance. Controller identity and one-Seeker-to-one-wallet binding remain outside this model.');
