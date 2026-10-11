/**
 * CLI: KEEP mining cohort simulation — Phase E E1 numerical lane (2026-09-20).
 * Seven honest + four adversary cohorts × populations 200 / 1k / 10k wallets ×
 * 365 days × R ∈ {100, 200, 300} SHARDS per ingot, with the plan §6/§6.1
 * acceptance thresholds evaluated PASS / FAIL per run and metrics reported per
 * CONTROLLER (units per human, not per wallet). Every parameter is PROPOSED
 * (keep-mining-model.ts PROPOSED_PARAMS), not a live constant.
 *
 *   pnpm --filter @shardkeep/scripts keep-mining:sim
 *   pnpm --filter @shardkeep/scripts keep-mining:sim -- --days 90 --pops 200,1000 --r 100 --t0 2,3 --seed 7
 */
import { ECONOMY, TOKEN } from '@shardkeep/shared';
import {
  PROPOSED_PARAMS, defaultCohorts, evaluateThresholds, maxKeepPerShard, simulateKeepMining, subParityHolds,
  type KeepMiningParams, type SimResult,
} from './keep-mining-model';

function strArg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1]) : dflt;
}
const nums = (s: string): number[] => s.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
const days = Number(strArg('days', '365'));
const pops = nums(strArg('pops', '200,1000,10000'));
const rs = nums(strArg('r', '100,200,300'));
const t0s = nums(strArg('t0', '2'));
const seed = Number(strArg('seed', '20260920'));

const f = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : String(n));
const i0 = (n: number): string => Math.round(n).toLocaleString('en-US');
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function printRun(r: SimResult, p: KeepMiningParams): void {
  const last30 = r.days_.slice(-30);
  const meanU = last30.reduce((a, d) => a + d.totalUnits, 0) / Math.max(1, last30.length);
  const meanF = last30.reduce((a, d) => a + d.floorUnits, 0) / Math.max(1, last30.length);
  const meanB = last30.reduce((a, d) => a + d.budgetKeep, 0) / Math.max(1, last30.length);
  console.log(`\n=== population ${i0(r.population)} wallets · ${r.days} days · R = ${p.shardsPerIngot} SHARDS/ingot · T0 = ${p.capacityByTier[0]} · seed ${r.seed} ===`);
  console.log(`last-30-day means: U ${i0(meanU)} units · F_d ${i0(meanF)} · B_d ${i0(meanB)} KEEP · realised rate ${f(meanU > 0 ? (last30.reduce((a, d) => a + d.awardedKeep, 0) / 30) / meanU : 0)} KEEP/unit · max rate ${f(meanB / Math.max(meanF, 1))} KEEP/unit`);
  console.log(`utilisation ${f(r.utilisation)} · Gini(controllers) ${f(r.giniControllers)} · top-10% controllers ${f(r.top10PctShareControllers)} · sink ratio ${f(r.sinkRatio, 3)} · drops/deed-position/day ${f(r.dropsPerDeedPositionPerDay, 3)} · runway ${f(r.runwayYearsAtSimulatedRate, 1)} y at simulated rate (${f(r.runwayYearsAtCeiling)} y at ceiling)`);
  console.log(pad('cohort', 64) + pad('wallets', 9) + pad('ctrl', 7) + pad('KEEP/w/d', 10) + pad('KEEP/ctrl/d', 12) + pad('units/w/d', 11) + pad('units/ctrl/d', 13) + pad('cap', 6) + pad('part.', 7) + pad('refined', 9) + pad('bought', 8) + pad('consumed', 10) + pad('returned', 10) + pad('prot.SHARDS/ctrl', 17) + pad('drops/d', 9) + pad('1st claim', 10) + 'exploit(amended|if market credit) KEEP');
  for (const c of r.cohorts) {
    console.log(pad(c.name.slice(0, 63), 64) + pad(i0(c.wallets), 9) + pad(i0(c.controllers), 7) + pad(f(c.keepPerWalletPerDay, 1), 10) + pad(f(c.keepPerControllerPerDay, 1), 12)
      + pad(f(c.unitsPerWalletPerDay), 11) + pad(f(c.unitsPerControllerPerDay), 13) + pad(f(c.meanCapacityUnits, 1), 6) + pad(f(c.participationRate), 7)
      + pad(i0(c.ingotsRefined), 9) + pad(i0(c.ingotsPurchased), 8) + pad(i0(c.ingotsConsumed), 10) + pad(i0(c.ingotsReturned), 10) + pad(i0(c.protectedShardsPerControllerMax), 17)
      + pad(f(c.dropsPerDay, 3), 9) + pad(c.medianFirstClaimDay === null ? 'never' : `day ${c.medianFirstClaimDay}`, 10)
      + (c.kind === 'adversary' ? `${i0(c.exploitGainKeep)} | ${i0(c.exploitGainIfMarketCreditKeep)}` : c.legacyLootExposureRemovedPerDay ? `legacy open-Forge loot exposure removed: ${i0(c.legacyLootExposureRemovedPerDay)} SHARDS/day` : ''));
  }
  console.log('thresholds:');
  for (const t of evaluateThresholds(r, p)) {
    const verdict = t.pass === null ? 'n/a ' : t.pass ? 'PASS' : 'FAIL';
    console.log(`  ${verdict}  ${pad(t.id, 5)} ${pad(t.label, 78)} ${pad(t.value, 18)} (${t.threshold})`);
  }
}

console.log(`KEEP MINING — PROPOSED model (not constants). ceiling ${i0(PROPOSED_PARAMS.ceilingKeepPerDay)} KEEP/day (LOCKED) · F_min ${i0(PROPOSED_PARAMS.floorMinUnits)} units · tiers T0..T4 = ${PROPOSED_PARAMS.capacityByTier.join('/')} · weights 40/25/20/10/5 · normalisers res 6 / game 4 / chain 2`);
console.log(`live imports: ECONOMY.shardsPerKeep = ${ECONOMY.shardsPerKeep} · TOKEN.allocation.playPool = ${i0(TOKEN.allocation.playPool)} → runway at ceiling ${f(TOKEN.allocation.playPool / (PROPOSED_PARAMS.ceilingKeepPerDay * 365))} y`);
for (const r of rs) {
  const p: KeepMiningParams = { ...PROPOSED_PARAMS, shardsPerIngot: r };
  console.log(`sub-parity R=${r}: F_min × R = ${i0(p.floorMinUnits * r)} ${subParityHolds(p) ? '>' : '≤'} ceiling × shardsPerKeep = ${i0(p.ceilingKeepPerDay * ECONOMY.shardsPerKeep)} → ${subParityHolds(p) ? 'holds' : 'BROKEN'}; max ${f(maxKeepPerShard(p), 3)} KEEP per sunk SHARD`);
}

const summary: string[] = [];
for (const t0 of t0s) for (const r of rs) for (const pop of pops) {
  const p: KeepMiningParams = { ...PROPOSED_PARAMS, shardsPerIngot: r, capacityByTier: [t0, 12, 16, 20, 24] };
  const res = simulateKeepMining(defaultCohorts(), days, p, seed, pop);
  printRun(res, p);
  const th = evaluateThresholds(res, p);
  const fails = th.filter((t) => t.pass === false).map((t) => t.id);
  summary.push(`T0=${t0} R=${r} pop=${i0(pop)}: ${th.filter((t) => t.pass === true).length} PASS / ${fails.length} FAIL${fails.length ? ` (${fails.join(', ')})` : ''} / ${th.filter((t) => t.pass === null).length} n/a`);
}
console.log('\n=== summary ===');
for (const s of summary) console.log(s);
console.log('\nReading the FAILs: A3a/A4 fail whenever T0 free capacity × S × k < 1 unit (floor) — the owner decision M-22 (T0 vs SGT vs bond) decides them; A10a is the 13.98-year arithmetic of 500M / 98,000 / 365. Details: docs/phase-e/E1-NUMERICAL-SPEC.md §11.');
