import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeCampaignSnapshot } from '../../apps/api/src/game/world.ts';
import { simulateRaid } from '../../packages/sim/src/sim.ts';
import { nativeBuildingHealth } from '../../apps/api/src/native/health.ts';
import { SIM_VERSION } from '../../packages/sim/src/version.ts';
import { CAMPAIGN, TROOPS, TROOP_LEVELING, HERO_LEVELING } from '../../packages/shared/src/constants.ts';
import { campaignBaseVisualForAct } from '../../packages/shared/src/baseVisual.ts';
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const snapshot = makeCampaignSnapshot(CAMPAIGN.encounters.length);
const visualContext = campaignBaseVisualForAct(Math.ceil(CAMPAIGN.encounters.length / CAMPAIGN.stagesPerAct));
const min = snapshot.claimMin!, max = snapshot.claimMax!;
const count = Math.floor(CAMPAIGN.maxArmyPointsByKeep[snapshot.keepLevel - 1]! / TROOPS.dragon.pts);
const all = Array.from({ length: count }, (_, i) => {
 const along = min + (Math.floor(i / 4) * 2 + 1) % (max - min);
 const points = [[min - 1, along], [max, along], [along, min - 1], [along, max]][i % 4]!;
 return { troop: 'dragon' as const, tx: points[0]!, ty: points[1]!, tMs: Math.floor(i / 4) * 350 };
});
const options = { troopLevels: { dragon: TROOP_LEVELING.maxLevel } };
for (const n of [2, 8, 16, count]) {
 const orders = { deploys: all.slice(0, n), heroDeploys: [
  { hero: 'vex' as const, tx: min - 1, ty: min + 2, tMs: 400, level: HERO_LEVELING.maxLevel },
  { hero: 'theodor' as const, tx: max, ty: max - 2, tMs: 800, level: HERO_LEVELING.maxLevel },
 ] };
 const started = performance.now();
 const result = simulateRaid(snapshot, orders, 42, options);
 const eventHash = createHash('sha256').update(JSON.stringify(result.events)).digest('hex');
 const fixture = { schemaVersion: 1, sourceCommit, simVersion: SIM_VERSION, id: 'fixture-stage100-dragons',
  revision: n, snapshot, visualContext, orders, seed: 42, options, armySnapshot: { levels: options.troopLevels }, buildingHealth: nativeBuildingHealth(SIM_VERSION, result), ...result };
 writeFileSync(new URL(`./stage100-dragons-${n}.json`, import.meta.url), JSON.stringify(fixture));
 console.log(JSON.stringify({ n, buildings: snapshot.buildings.length, events: result.events.length, eventHash, milliseconds: Math.round(performance.now() - started) }));
}
