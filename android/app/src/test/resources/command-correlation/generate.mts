/** Run with the source checkout's tsx and an explicit source root. Writes only this fixture directory. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const source = path.resolve(process.argv[2]!);
const load = (file: string) => import(pathToFileURL(path.join(source, file)).href);
const { simulateRaid } = await load('packages/sim/src/sim.ts');
const { nativeOrders } = await load('apps/api/src/native/source.ts');
const { SIM_VERSION } = await load('packages/sim/src/version.ts');
const { UNITS_PER_TILE } = await load('packages/sim/src/fixed.ts');
const { COMBAT_TICK_MS } = await load('packages/shared/src/combatTiming.ts');
const { HERO_COMBAT, LIVE_RAID, RAID_REPLAY_LIMITS, TROOPS, isTrainableTroop } = await load('packages/shared/src/constants.ts');
if (SIM_VERSION !== 15) throw new Error('Re-review correlation for this SIM');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const raidId = '11111111-1111-4111-8111-111111111111';
const command = (sequence: number, kind: string, payload: object, serverOffsetMs = 0) => ({
  sequence, clientCommandId: `command-${sequence}`, kind, payload, serverOffsetMs, acceptedAt: '2026-09-15T00:00:00.000Z',
});
const commands = [
  command(0, 'hero', { hero: 'theodor', tx: -34, ty: -34 }),
  command(1, 'deploy', { troop: 'bowman', tx: -34, ty: -34 }),
  command(2, 'hero', { hero: 'vex', tx: -34, ty: -34 }),
  command(3, 'deploy', { troop: 'bowman', tx: -34, ty: -34 }),
  command(4, 'deploy', { troop: 'dragon', tx: -34, ty: -34 }),
  command(5, 'deploy', { troop: 'bowman', tx: 63, ty: 63 }, 1101),
  command(6, 'deploy', { troop: 'bowman', tx: -34, ty: 63 }, 1199),
  command(7, 'speed', { expectedClockRevision: 1, rate: 2 }, 2000),
  command(8, 'deploy', { troop: 'bowman', tx: -34, ty: -34 }, 12000),
];
const snapshot = { keepLevel: 20, surplusShards: 0, battlefieldVersion: 2, plotVersion: 2, claimMin: -10, claimMax: 40,
  buildings: [{ id: 'keep', type: 'keep', level: 20, tx: 14, ty: 14 }, { id: 'nest', type: 'dragonnest', level: 1, tx: 19, ty: 14 }],
  defenderHeroes: [{ hero: 'theodor', level: 1, guardTx: 13, guardTy: 13 }] };
const army = { levels: { dragon: 1, bowman: 1, hexbarrow: 1 }, heroLevels: { vex: 1, theodor: 1 } };
const cases: any[] = [];
function run(name: string, accepted: any[], base = snapshot, options = { troopLevels: army.levels }) {
  const orders = nativeOrders(accepted, army);
  const outcome = simulateRaid(base, orders, 42, options);
  // Preserve the complete canonical array; creation indices document its exact order.
  const creations = outcome.events.flatMap((event: any, index: number) => ['deploy', 'spawn', 'troopSpawn'].includes(event.e) ? [{ index, event }] : []);
  const events = outcome.events;
  cases.push({ name, orders, snapshot: base, options, seed: 42, outcomeTicks: outcome.ticks,
    canonicalEventCount: outcome.events.length, canonicalEventSha256: sha(JSON.stringify(outcome.events)), canonicalIndices: creations.map((row: any) => row.index),
    presentation: { protocolVersion: 1, transportProtocolVersion: 2, raidProtocolVersion: 2, source: 'live', status: 'pending_orders', raidId,
      simVersion: SIM_VERSION, revision: sha(name), replaceFromTick: 0, lastSequence: accepted.length - 1, commands: accepted, events } });
}
run('same-fields-and-families', commands);
run('revision-before', [command(0, 'deploy', { troop: 'bowman', tx: 8, ty: 8 })]);
run('revision-after', [command(0, 'deploy', { troop: 'bowman', tx: 8, ty: 8 }), command(1, 'deploy', { troop: 'bowman', tx: 7, ty: 8 })]);
run('early-victory-future-unemitted', [command(0, 'deploy', { troop: 'dragon', tx: 13, ty: 13 }), command(1, 'hero', { hero: 'vex', tx: -34, ty: -34 }, 89000)],
  { ...snapshot, defenderHeroes: [], buildings: [{ id: 'keep', type: 'keep', level: 1, tx: 14, ty: 14 }] }, { troopLevels: { dragon: 20 } });
run('summons-and-nest', [command(0, 'deploy', { troop: 'hexbarrow', tx: -34, ty: -34 }), command(1, 'deploy', { troop: 'bowman', tx: 63, ty: 63 }, 20000)], { ...snapshot, defenderHeroes: [] });
const sourceFiles = ['packages/sim/src/sim.ts','packages/sim/src/version.ts','packages/sim/src/fixed.ts','packages/shared/src/constants.ts','packages/shared/src/combatTiming.ts','apps/api/src/native/source.ts'];
const policy = { simVersion: SIM_VERSION, tickDurationMs: COMBAT_TICK_MS, unitsPerTile: UNITS_PER_TILE,
  heroDonors: Object.fromEntries(Object.entries(HERO_COMBAT).map(([hero, value]: any) => [hero, value.donor])),
  trainableTroops: Object.keys(TROOPS).filter(isTrainableTroop),
  maxCommands: LIVE_RAID.maxCommands, maxEvents: RAID_REPLAY_LIMITS.maxEvents };
const output = { schemaVersion: 1, policy, sourceHashes: Object.fromEntries(sourceFiles.map(file => [file,sha(readFileSync(path.join(source,file)))])), cases };
const filename = new URL('./source-reference.json', import.meta.url);
const encoded = JSON.stringify(output, null, 2)+'\n';
if (process.argv.includes('--check')) {
  if (readFileSync(filename, 'utf8') !== encoded) throw new Error('Source correlation fixture changed; review the ordering and policy before replacing it');
} else writeFileSync(filename, encoded);
console.log(JSON.stringify(cases.map(row => ({ name: row.name, ticks: row.outcomeTicks, creationKinds: row.presentation.events.filter((e: any) => ['deploy', 'spawn', 'troopSpawn'].includes(e.e)).map((e: any) => e.e), actors: row.presentation.events.filter((e: any) => e.e === 'deploy').map((e: any) => [e.id,e.t,e.troop,e.hero,e.side,e.x,e.y]) }))));
