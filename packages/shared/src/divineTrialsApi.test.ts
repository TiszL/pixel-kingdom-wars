import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import v from './testFixtures/divineTrialVectors.json';
import {divineTrialCanonicalJson,divineTrialSettlement} from './divineTrials';
import {DivineTrialEventSchema,DivineTrialEntrySchema,DivineTrialAttemptSchema,DivineTrialOrdersSchema,DivineTrialParticipantSchema} from './divineTrialsApi';
const hash=(x:unknown)=>createHash('sha256').update(divineTrialCanonicalJson(x)).digest('hex');
it('accepts every actual SIM17 plan and immutable commitment; public terminal is conserved',()=>{
 expect(DivineTrialEventSchema.parse(v.event)).toEqual(v.event);expect(DivineTrialEntrySchema.parse(v.entry)).toEqual(v.entry);
 const {inputSha256,...profile}=v.event.encounter;expect(hash(profile)).toBe(inputSha256);
 for(const p of v.plans){const a=DivineTrialAttemptSchema.parse(p.attempt);expect(hash({encounter:a.encounter,orders:a.orders})).toBe(a.result!.inputSha256);}
 expect(divineTrialSettlement(v.settlement.scores,v.settlement.budget,v.settlement.sponsorWallet)).toEqual(v.settlement.expected);
 expect(DivineTrialEventSchema.parse({...v.event,terminal:v.terminal}).terminal).toEqual(v.terminal);
});
it('refuses altered policy, unknown replay authority, nonoriginal status and partial/buffed/time-shifted plans',()=>{
 const a=v.plans[0]!.attempt;
 for(const orders of [{deploys:a.orders.deploys.slice(1)},{...a.orders,buffs:{warhorn:true}},{deploys:a.orders.deploys.map((d,i)=>i?d:{...d,tMs:1})},{deploys:a.orders.deploys.map(d=>({...d,troop:'dragon'}))}])expect(DivineTrialOrdersSchema.safeParse(orders).success).toBe(false);
 for(const changed of [{...a,status:'admitted'},{...a,result:{...a.result,scoreAuthority:true}},{...a,result:{...a.result,events:[{t:0,e:'grant',amount:1}]}}])expect(DivineTrialAttemptSchema.safeParse(changed).success).toBe(false);
 expect(DivineTrialEventSchema.safeParse({...v.event,policy:{...v.policy,seed:185}}).success).toBe(false);
 expect(DivineTrialEventSchema.safeParse({...v.event,terminal:{...v.terminal,entitlements:[]}}).success).toBe(false);
});
it('binds participant actor/event, contiguous immutable ordinals and one unfinished attempt',()=>{
 const a={...v.plans[0]!.attempt,status:'admitted',orders:null,result:null,completedAt:null};
 const p={version:1,eventId:v.event.id,wallet:v.entry.wallet,entry:v.entry,attempts:[a],prize:null};expect(DivineTrialParticipantSchema.parse(p)).toEqual(p);
 for(const changed of [{...p,wallet:v.event.domain.economyProgram},{...p,eventId:v.entry.id},{...p,attempts:[{...a,ordinal:2}]},{...p,entry:null},{...p,attempts:[a,{...a,id:v.entry.id,idempotencyKey:v.entry.id,ordinal:2}]}])expect(DivineTrialParticipantSchema.safeParse(changed).success).toBe(false);
});
