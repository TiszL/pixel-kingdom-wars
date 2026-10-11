/**
 * CLI: economic pool-reservoir simulation (#47). Reports the STABLE PLAYER CAP —
 * the largest active-player count whose 500M pool survives the horizon — for
 * representative player profiles, WITH and WITHOUT the #45 emission controller, so
 * you can see how much headroom the controller buys.
 *
 *   pnpm --filter @shardkeep/scripts econ:sim
 *   pnpm --filter @shardkeep/scripts econ:sim -- --days 365 --ramp 30
 *   pnpm --filter @shardkeep/scripts econ:sim -- --players 5000 --profile mature
 *
 * Behavioral inputs (base level / mine count / withdraw fraction) are ALPHA
 * placeholders — every ECONOMY number is imported from @shardkeep/shared, only the
 * player-behavior assumptions live here. Tune them as telemetry arrives.
 */
import { ECONOMY, TOKEN } from '@shardkeep/shared';
import { findStableCap, simulateEconomy, type EconParams, type EconProfile } from './econ-model';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function numArg(name: string, dflt: number): number {
  const v = arg(name);
  return v === undefined ? dflt : Number(v);
}
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Representative player profiles (ALPHA placeholders — see file header). */
const PROFILES: Record<string, EconProfile> = {
  // Mid-game base reinvesting most income → low permanent drain, many coexist.
  climbing: { keepLevel: 5, mineLevels: [4, 4], streakDays: 7, withdrawFraction: 0.15 },
  // Maxed base with nothing left to buy → cashes out almost everything, few coexist.
  mature: { keepLevel: 20, mineLevels: [20, 20, 20, 20, 20, 20, 20, 20], streakDays: 7, withdrawFraction: 0.9 },
};

function main(): void {
  const days = numArg('days', 365);
  const rampDays = numArg('ramp', 30);
  const profileArg = arg('profile');
  const playersArg = arg('players');
  const names = profileArg ? [profileArg] : Object.keys(PROFILES);

  console.log(`\nSHARDKEEP economic simulation — pool ${fmt(TOKEN.allocation.playPool)} KEEP, horizon ${days}d, ramp ${rampDays}d`);
  console.log(`starter grant ${ECONOMY.starterShards} SHARDS/player · KEEP pool drains only via withdrawals (sinks recycle)\n`);

  for (const name of names) {
    const profile = PROFILES[name];
    if (!profile) { console.error(`unknown profile '${name}' (have: ${Object.keys(PROFILES).join(', ')})`); continue; }
    const base = { days, controller: false, rampDays, profile } satisfies Omit<EconParams, 'players'>;

    if (playersArg) {
      // Single-N trajectory: show how long the pool lasts at this player count.
      const n = Number(playersArg);
      const off = simulateEconomy({ ...base, players: n, controller: false });
      const on = simulateEconomy({ ...base, players: n, controller: true });
      console.log(`profile '${name}' @ ${fmt(n)} players over ${days}d:`);
      console.log(`  controller OFF: ${off.survived ? 'SURVIVES' : `pool exhausted day ${off.deadDay}`}, final pool ${fmt(off.finalPool)}`);
      console.log(`  controller ON : ${on.survived ? 'SURVIVES' : `pool exhausted day ${on.deadDay}`}, final pool ${fmt(on.finalPool)}, min rate ${(on.minEpochBps / 100).toFixed(0)}%`);
      console.log('');
      continue;
    }

    // Stable-cap search: largest N surviving the horizon, controller off vs on.
    const capOff = findStableCap({ ...base, controller: false });
    const capOn = findStableCap({ ...base, controller: true });
    const gain = capOff > 0 ? `${(capOn / capOff).toFixed(1)}×` : (capOn > 0 ? '∞' : '—');
    const perDay = simulateEconomy({ ...base, players: 1, rampDays: 0, controller: false }).days[0]?.withdrawn ?? 0;
    console.log(`profile '${name}'  (per-player ~${fmt(perDay)} KEEP/day withdrawn):`);
    console.log(`  stable cap, controller OFF : ${fmt(capOff)} players survive ${days}d`);
    console.log(`  stable cap, controller ON  : ${fmt(capOn)} players survive ${days}d   (${gain} headroom)`);
    console.log('');
  }

  console.log('Takeaway: the pool cannot fund an unbounded population — the controller');
  console.log('extends the survivable cap by throttling per-player emission as the pool');
  console.log('drains / outflow spikes / the crowd grows, but 100k+ mature bases remain');
  console.log('structurally out of reach of a 500M KEEP pool; starter SHARDS do not drain it.\n');
}

main();
