/** Strict bounded D184 public originals. DTO parsing is never gameplay authority. */
import {z} from 'zod';
import {CAMPAIGN,GRID,PHASE_E_DIVINE_TRIALS as P,RAID_RULES,RAID_REPLAY_LIMITS} from './constants';
import {BuildingType} from './types';
import {DIVINE_TRIAL_POLICY,DivineTrialAmountsSchema,DivineTrialBudgetSchema,DivineTrialIdSchema as Id,DivineTrialWalletSchema as Wallet,DivineTrialScoreSchema,divineTrialCanonicalJson,divineTrialSchedule,divineTrialSettlement} from './divineTrials';
const same=(a:unknown,b:unknown)=>divineTrialCanonicalJson(a)===divineTrialCanonicalJson(b);
const Hash=z.string().length(64).regex(/^[0-9a-f]+$/),Count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),Signed=z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const Time=z.string().length(24).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const U64=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<(1n<<64n));
const array=<T extends z.ZodType>(schema:T,max:number)=>z.preprocess(v=>Array.isArray(v)&&v.length<=max?v:null,z.array(schema).max(max));
const exact=<T>(expected:T)=>z.unknown().refine(v=>{try{return same(v,expected);}catch{return false;}}).transform(()=>structuredClone(expected));
const Troop=z.enum(['highlander','bowman']),Name=z.string().min(1).max(P.maxStringLength),Tick=Count.max(RAID_RULES.battleDurationSec*10+RAID_REPLAY_LIMITS.postBattleDrainTicks);
export const DivineTrialSnapshotSchema=z.object({keepLevel:z.literal(CAMPAIGN.encounters[P.campaignStage-1]!.keepLevel),surplusShards:z.literal(0),claimMin:Count.max(GRID.plotTiles),claimMax:Count.max(GRID.plotTiles),buildings:array(z.object({id:Name,type:z.enum(BuildingType),level:Count.min(1).max(CAMPAIGN.encounters[P.campaignStage-1]!.keepLevel),tx:Count.max(GRID.plotTiles-1),ty:Count.max(GRID.plotTiles-1)}).strict(),P.maxSnapshotBuildings)}).strict().refine(v=>v.claimMax>v.claimMin&&v.buildings.length>0&&new Set(v.buildings.map(b=>b.id)).size===v.buildings.length&&v.buildings.filter(b=>b.type===BuildingType.Keep).length===1);
export const DivineTrialEncounterSchema=z.object({simVersion:z.literal(P.simVersion),seed:z.literal(P.seed),snapshot:DivineTrialSnapshotSchema,army:exact(P.army),levels:exact(P.levels),inputSha256:Hash}).strict();
export type DivineTrialEncounter=z.infer<typeof DivineTrialEncounterSchema>;
export const DivineTrialOrdersSchema=z.object({deploys:array(z.object({troop:Troop,tx:Signed,ty:Signed,tMs:z.literal(P.deployTimeMs)}).strict(),P.maxDeploys).refine(v=>v.length===P.maxDeploys&&Object.entries(P.army).every(([troop,n])=>v.filter(d=>d.troop===troop).length===n))}).strict();
export type DivineTrialOrders=z.infer<typeof DivineTrialOrdersSchema>;
const target=z.union([Count,Name]),point={x:Signed,y:Signed};
// The fixed v1 roster/stage emits only these SIM17 event families. Unknown
// protocols or hero/gear/summon payloads hold rather than widening this decoder.
const ReplayEvent=z.discriminatedUnion('e',[
 z.object({t:Tick,e:z.literal('deploy'),id:Count,troop:Troop,...point}).strict(),
 z.object({t:Tick,e:z.literal('pos'),id:Count,...point}).strict(),
 z.object({t:Tick,e:z.literal('attackRun'),id:Count,side:z.literal('attacker'),troop:Troop,targetKind:z.literal('building'),target:Name,ix:Signed,iy:Signed,mode:z.enum(['melee','projectile']),technique:z.enum(['strike','arrow']),cycleMs:Count,releaseOffsetMs:Count,cycleTicks:Count,releaseOffsetTicks:Count,impactOffsetsTicks:array(Count,RAID_REPLAY_LIMITS.maxAttackContactsPerCycle),cadenceTicks:Count,count:Count.min(1).max(RAID_REPLAY_LIMITS.maxAttackRunCycles)}).strict(),
 z.object({t:Tick,e:z.literal('fire'),id:Name,target:Count,proj:z.enum(['cannonball','arrow']),ix:Signed,iy:Signed,releaseOffsetMs:Count,flightMs:Count,impactOffsetTicks:Count}).strict(),
 z.object({t:Tick,e:z.literal('hit'),target,dmg:Count}).strict(),
 z.object({t:Tick,e:z.literal('destroyed'),id:Name}).strict(),
 z.object({t:Tick,e:z.literal('troopDeath'),id:Count}).strict(),
 z.object({t:Tick,e:z.literal('star'),n:Count.min(1).max(P.maxStars)}).strict(),
 z.object({t:Tick,e:z.literal('trap'),id:Name,victim:Count,kind:z.enum(['spiketrap','powdermine']),victims:array(Count,P.maxDeploys),stunUntil:Tick.optional()}).strict(),
]);
export const DivineTrialResultSchema=z.object({stars:Count.max(P.maxStars),destruction:Count.max(P.maxDestruction),events:array(ReplayEvent,P.maxReplayEvents),inputSha256:Hash}).strict().refine(v=>v.events.every((e,i)=>!i||e.t>=v.events[i-1]!.t));
export const DivineTrialClaimSchema=z.object({eventId:Id,wallet:Wallet,baseId:Id,amounts:DivineTrialAmountsSchema,claimedAt:Time}).strict();
export type DivineTrialClaim=z.infer<typeof DivineTrialClaimSchema>;
const Ranking=DivineTrialScoreSchema.refine(v=>v.stars>=P.minWinningStars);
const Site=z.string().regex(/^divine-individual-[0-9]{3}$/).refine(v=>Number(v.slice(-3))>=1&&Number(v.slice(-3))<=P.divineSites);
export const DivineTrialTerminalSchema=z.object({version:z.literal(1),eventId:Id,completedAt:Time,rankings:array(Ranking,P.divineSites),occupations:array(z.object({site:Site,wallet:Wallet}).strict(),P.divineSites),entitlements:array(z.object({wallet:Wallet,amounts:DivineTrialAmountsSchema}).strict(),P.divineSites+1)}).strict().refine(v=>new Set(v.rankings.map(r=>r.wallet)).size===v.rankings.length&&new Set(v.rankings.map(r=>r.attemptId)).size===v.rankings.length&&new Set(v.entitlements.map(r=>r.wallet)).size===v.entitlements.length&&v.occupations.length===v.rankings.length&&v.occupations.every((o,i)=>o.wallet===v.rankings[i]!.wallet&&o.site===`divine-individual-${String(i+1).padStart(3,'0')}`));
export type DivineTrialTerminal=z.infer<typeof DivineTrialTerminalSchema>;
export const DivineTrialEventSchema=z.object({version:z.literal(1),id:Id,domain:z.object({genesisHash:Wallet,economyProgram:Wallet}).strict(),sponsorWallet:Wallet,entryStartsAt:Time,playStartsAt:Time,playEndsAt:Time,occupationEndsAt:Time,policy:exact(DIVINE_TRIAL_POLICY),budget:DivineTrialBudgetSchema,encounter:DivineTrialEncounterSchema,terminal:DivineTrialTerminalSchema.nullable()}).strict().superRefine((v,c)=>{
 try{if(!same(divineTrialSchedule(v.entryStartsAt),{entryStartsAt:v.entryStartsAt,playStartsAt:v.playStartsAt,playEndsAt:v.playEndsAt,occupationEndsAt:v.occupationEndsAt}))throw Error();
  if(v.terminal){const t=v.terminal,s=divineTrialSettlement(t.rankings,v.budget,v.sponsorWallet);if(t.eventId!==v.id||t.completedAt<v.playEndsAt||!same(s,{rankings:t.rankings,occupations:t.occupations,entitlements:t.entitlements}))throw Error();}
 }catch{c.addIssue({code:'custom',message:'Divine event schedule or funded terminal differs'});}
});
export type DivineTrialEvent=z.infer<typeof DivineTrialEventSchema>;
export const DivineTrialEventsSchema=z.object({version:z.literal(1),events:array(DivineTrialEventSchema,P.discoveryPageSize),nextCursor:z.string().min(1).max(P.maxStringLength).regex(/^[A-Za-z0-9_-]+$/).nullable()}).strict().refine(v=>new Set(v.events.map(e=>e.id)).size===v.events.length);
export type DivineTrialEvents=z.infer<typeof DivineTrialEventsSchema>;
export const DivineTrialEntrySchema=z.object({version:z.literal(1),id:Id,eventId:Id,wallet:Wallet,baseId:Id,idempotencyKey:Id,enteredAt:Time,qualification:z.object({sequence:U64,day:Count,renown:U64.refine(v=>BigInt(v)>=BigInt(P.minRenown)),daysAttested:U64.refine(v=>BigInt(v)>=BigInt(P.minDaysAttested)),sourceSha256:Hash}).strict()}).strict();
export type DivineTrialEntry=z.infer<typeof DivineTrialEntrySchema>;
export const DivineTrialAttemptSchema=z.object({version:z.literal(1),id:Id,eventId:Id,wallet:Wallet,baseId:Id,idempotencyKey:Id,ordinal:Count.min(1).max(P.attemptsPerWallet),status:z.enum(['admitted','committed','completed','abandoned','expired']),admittedAt:Time,encounter:DivineTrialEncounterSchema,orders:DivineTrialOrdersSchema.nullable(),result:DivineTrialResultSchema.nullable(),completedAt:Time.nullable()}).strict().refine(v=>{
 const submitted=v.status==='committed'||v.status==='completed',terminal=['completed','abandoned','expired'].includes(v.status);
 return submitted===(v.orders!==null)&&(v.status==='completed')===(v.result!==null)&&terminal===(v.completedAt!==null)&&(!v.completedAt||v.completedAt>=v.admittedAt);
});
export type DivineTrialAttempt=z.infer<typeof DivineTrialAttemptSchema>;
export const DivineTrialParticipantSchema=z.object({version:z.literal(1),eventId:Id,wallet:Wallet,entry:DivineTrialEntrySchema.nullable(),attempts:array(DivineTrialAttemptSchema,P.attemptsPerWallet),prize:z.object({amounts:DivineTrialAmountsSchema,claim:DivineTrialClaimSchema.nullable()}).strict().nullable()}).strict().refine(v=>(!v.entry||v.entry.eventId===v.eventId&&v.entry.wallet===v.wallet)&&(!v.attempts.length||v.entry!==null)&&v.attempts.every((a,i)=>a.eventId===v.eventId&&a.wallet===v.wallet&&a.ordinal===i+1)&&new Set(v.attempts.map(a=>a.id)).size===v.attempts.length&&new Set(v.attempts.map(a=>a.idempotencyKey)).size===v.attempts.length&&v.attempts.filter(a=>a.status==='admitted'||a.status==='committed').length<=P.maxUnfinishedAttempts&&(!v.prize?.claim||v.prize.claim.eventId===v.eventId&&v.prize.claim.wallet===v.wallet&&same(v.prize.claim.amounts,v.prize.amounts)));
export type DivineTrialParticipant=z.infer<typeof DivineTrialParticipantSchema>;
export const DivineTrialEntryRequestSchema=z.object({idempotencyKey:Id,baseId:Id}).strict();
export const DivineTrialAttemptRequestSchema=DivineTrialEntryRequestSchema;
export const DivineTrialSubmitRequestSchema=z.object({orders:DivineTrialOrdersSchema}).strict();
export const DivineTrialPrizeRequestSchema=z.object({baseId:Id}).strict();
export const DivineTrialEmptySchema=z.object({}).strict();
