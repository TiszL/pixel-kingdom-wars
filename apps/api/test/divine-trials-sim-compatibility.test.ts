/** The protocol label may advance only while every immutable Divine17 event
 * still reproduces its original result; this is not general old-raid admission. */
import {createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {simulateRaid} from '@shardkeep/sim';
import {divineTrialCanonicalJson} from '@shardkeep/shared/divineTrials';
import {DivineTrialAttemptSchema} from '@shardkeep/shared/divineTrialsApi';
import vectors from '../../../packages/shared/src/testFixtures/divineTrialVectors.json' with {type:'json'};
import {divineTrialEncounter,supportsDivineTrialSimulator} from '../src/game/divineTrials';

const runtime=vi.hoisted(()=>({version:18}));
vi.mock('@shardkeep/sim',async original=>({
 ...await original<typeof import('@shardkeep/sim')>(),
 get SIM_VERSION(){return runtime.version;},
}));
afterEach(()=>{runtime.version=18;});

it.each([[17,17,true],[17,18,true],[17,19,false],[18,18,false],[18,19,false],[16,18,false]])(
 'admits only the proven immutable encounter/engine pair %i/%i (%s)',(encounter,engine,allowed)=>{
  expect(supportsDivineTrialSimulator(Number(encounter),Number(engine))).toBe(allowed);
 });

it('keeps the canonical encounter and hash exactly17 on engine18, while a future engine refuses funding input',()=>{
 expect(divineTrialEncounter()).toEqual(vectors.event.encounter);
 runtime.version=19;
 expect(()=>divineTrialEncounter()).toThrow('DIVINE_TRIAL_SIM_VERSION');
});

it.each(vectors.plans)('reproduces every original $name event and result without relabelling its encounter',plan=>{
 const a=DivineTrialAttemptSchema.parse(plan.attempt),e=a.encounter;
 expect(e.simVersion).toBe(17);
 const out=simulateRaid(e.snapshot,a.orders!,e.seed,{troopLevels:e.levels});
 const inputSha256=createHash('sha256').update(divineTrialCanonicalJson({encounter:e,orders:a.orders})).digest('hex');
 expect({stars:out.stars,destruction:out.destructionPct,events:out.events,inputSha256}).toEqual(a.result);
});
