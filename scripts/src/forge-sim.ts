/**
 * CLI: Gold Forge simulation — OWNER RULES (daily 5-year emission, soft cap,
 * 30% per-player cap with shard refunds). The modeling gate for the
 * dual-currency re-split (ITEMS-LOOTBOX-MARKETPLACE-PLAN §5).
 *
 *   pnpm --filter @shardkeep/scripts forge:sim
 *   pnpm --filter @shardkeep/scripts forge:sim -- --players 20000 --days 730 --whales 50000
 */
import { FORGE } from '@shardkeep/shared';
import { simulateForge, type ForgeParams } from './forge-model';

function numArg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : dflt;
}
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

const base: ForgeParams = {
  players: numArg('players', 20_000),
  days: numArg('days', 730),
  profile: { keepLevel: 5, mineLevels: [4, 4], streakDays: 7 },
  forgeFraction: 0.5,
  withdrawFraction: 0.3,
  whaleDepositKeepPerDay: numArg('whales', 50_000),
};

console.log(`GOLD FORGE — daily ${fmt(FORGE.dailyEmissionKeep)} KEEP over ${FORGE.emissionYears}y · softCap ${fmt(FORGE.softCapShards)} shards · per-player cap ${FORGE.maxDailyShareBps / 100}%`);
console.log(`max possible rate = ${(FORGE.dailyEmissionKeep / FORGE.softCapShards).toFixed(3)} KEEP/shard (sub-parity ✓)\n`);

for (const scenario of [
  { label: 'baseline (whale active)', p: base },
  { label: 'launch week: 5 players only', p: { ...base, players: 5, whaleDepositKeepPerDay: 0, days: 7 } },
  { label: 'no whales', p: { ...base, whaleDepositKeepPerDay: 0 } },
  { label: 'UNDERSIZED soft cap (exploit demo)', p: { ...base, players: 0, whaleDepositKeepPerDay: 10_000, softCapShards: 20_000, days: 30 } },
  { label: 'heavy cash-out (0.9 withdraw)', p: { ...base, withdrawFraction: 0.9 } },
]) {
  const r = simulateForge(scenario.p);
  const mid = r.days[Math.floor(r.days.length / 2)]!;
  console.log(`— ${scenario.label}`);
  console.log(`   pool end: ${fmt(r.poolEnd)} KEEP (${r.depletedDay ? `DEPLETED day ${r.depletedDay}` : 'survives'}) · emission used ${(r.emissionUtilization * 100).toFixed(1)}%`);
  console.log(`   max rate: ${r.maxRate.toFixed(3)} KEEP/shard · printer leak: ${fmt(r.printerLeak)} KEEP`);
  console.log(`   mid-horizon day: distributed ${fmt(mid.distributed)} · burned ${fmt(mid.totalShards)} shards · whale got ${fmt(mid.whalePayout)} (refund ${fmt(mid.whaleRefund)} shards)\n`);
}
console.log('Implementation gates: (1) rate = emission/max(total, softCap) — softCap');
console.log('MUST exceed dailyEmissionKeep (tested); (2) 30% cap refunds shards, never');
console.log('redistributes; (3) integer bigint math server-side; (4) deposits recycle first.');
