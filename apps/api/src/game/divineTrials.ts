/** D184 private service: authenticated routes expose only owned originals.
 * Funding/closing are operator capabilities, never player-supplied outcomes. */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PublicKey} from '@solana/web3.js';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {SIM_VERSION} from '@shardkeep/sim';
import {DIVINE_TRIAL_POLICY,DivineTrialBudgetSchema,DivineTrialIdSchema as Id,divineTrialCanonicalJson,divineTrialSchedule,divineTrialSettlement} from '@shardkeep/shared/divineTrials';
import {DivineTrialEventSchema,DivineTrialEntrySchema,DivineTrialAttemptSchema,DivineTrialClaimSchema,DivineTrialParticipantSchema,DivineTrialEventsSchema,DivineTrialEntryRequestSchema,DivineTrialAttemptRequestSchema,DivineTrialSubmitRequestSchema,DivineTrialPrizeRequestSchema,type DivineTrialEvent,type DivineTrialAttempt,type DivineTrialClaim,type DivineTrialEntry,type DivineTrialOrders} from '@shardkeep/shared/divineTrialsApi';
import type {Db,DbOrTx,DbTx} from '../db/client';
import {bases,players} from '../db/schema';
import {phaseECatalogEnabled,phaseEBuildingsEnabled,phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireExactFinalizedOwnedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {lockStablePrerequisiteBase} from './stableBasePrerequisites';
import {makeCampaignSnapshot} from './world';
import {validateDropPoint} from './liveRaids';
import {claimRaidSimulationPermit} from './raidSimulationRunner';
import {createDivineTrialQualificationReader,assertDivineTrialQualificationAge} from './divineTrialQualification';
import type {createMiningClaimReader} from '../mining/claimStatus';

const fail=(code:string,status=409):never=>{throw new HttpError(status,'Divine trial unavailable',`DIVINE_TRIAL_${code}`);};
const address=z.string().refine(v=>{try{return new PublicKey(v).toBase58()===v&&v!==PublicKey.default.toBase58();}catch{return false;}});
const domainSchema=z.object({genesisHash:address,economyProgram:address}).strict();
const cursorSchema=z.object({at:z.iso.datetime({precision:3}),id:Id}).strict();
const Fund=z.object({id:Id,baseId:Id,weekStart:z.string(),budget:DivineTrialBudgetSchema}).strict();
const hash=(value:unknown)=>createHash('sha256').update(divineTrialCanonicalJson(value)).digest('hex');
function enabled(){if(!phaseECatalogEnabled()||!phaseEBuildingsEnabled()||!phaseEMiningEnabled())fail('DISABLED',503);}
function identity(wallet:string,id?:string){address.parse(wallet);if(id!==undefined)Id.parse(id);}
async function source(db:DbOrTx){await db.execute(sql`select public.shardkeep_divine_trial_event_source()`);}
function verifyEncounter(e:DivineTrialEvent['encounter']){const {inputSha256,...input}=e;if(inputSha256!==hash(input))throw Error('DIVINE_TRIAL_ENCOUNTER_HASH');}
/** I4 SIM18 preparation preserves the exact SIM17 Divine input/event vectors.
 * Only this immutable encounter has proven engine17/18 equivalence; ordinary
 * raids and all future engines retain their separate exact-version refusal. */
export function supportsDivineTrialSimulator(encounterVersion:number,engineVersion:number=SIM_VERSION){
 return P.simVersion===17&&encounterVersion===17&&(engineVersion===17||engineVersion===18);
}
export function divineTrialEncounter(){
 if(!supportsDivineTrialSimulator(P.simVersion))throw Error('DIVINE_TRIAL_SIM_VERSION');
 const input={simVersion:P.simVersion,seed:P.seed,snapshot:makeCampaignSnapshot(P.campaignStage),army:structuredClone(P.army),levels:structuredClone(P.levels)};
 return {...input,inputSha256:hash(input)};
}
async function event(db:DbOrTx,id:string):Promise<DivineTrialEvent>{
 Id.parse(id);const [row]=await db.execute<{state:unknown}>(sql`select public.divine_trial_event_terms(e.id)||jsonb_build_object('terminal',t.record) state from public.divine_trial_events e left join public.divine_trial_event_terminals t on t.event_id=e.id where e.id=${id}::uuid`);
 if(!row)return fail('NOT_FOUND',404);const e=DivineTrialEventSchema.parse(row.state);verifyEncounter(e.encounter);return e;
}
async function entry(db:DbOrTx,wallet:string,eventId:string):Promise<DivineTrialEntry|null>{
 await source(db);const [row]=await db.execute<{record:unknown}>(sql`select record from public.divine_trial_entries where event_id=${eventId}::uuid and wallet=${wallet}`);return row?DivineTrialEntrySchema.parse(row.record):null;
}
async function attempt(db:DbOrTx,wallet:string,id:string):Promise<DivineTrialAttempt>{
 await source(db);const [row]=await db.execute<{record:unknown}>(sql`select a.record||jsonb_build_object('encounter',e.encounter,'orders',c.orders,'status',case when o.attempt_id is not null then o.status when c.attempt_id is not null then 'committed' else 'admitted' end,'result',o.result,'completedAt',case when o.attempt_id is null then null else to_char(o.completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end) record from public.divine_trial_attempts a join public.divine_trial_events e on e.id=a.event_id left join public.divine_trial_commands c on c.attempt_id=a.id left join public.divine_trial_outcomes o on o.attempt_id=a.id where a.id=${id}::uuid and a.wallet=${wallet}`);
 if(!row)return fail('ATTEMPT_NOT_FOUND',404);const a=DivineTrialAttemptSchema.parse(row.record);verifyEncounter(a.encounter);
 if(a.result&&a.result.inputSha256!==hash({encounter:a.encounter,orders:a.orders}))throw Error('DIVINE_TRIAL_INPUT_HASH');return a;
}
async function prize(db:DbOrTx,wallet:string,eventId:string):Promise<DivineTrialClaim|null>{
 await source(db);const [row]=await db.execute(sql`select event_id as "eventId",wallet,base_id as "baseId",amounts,to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "claimedAt" from public.divine_trial_prize_claims where event_id=${eventId}::uuid and wallet=${wallet}`);
 return row?DivineTrialClaimSchema.parse(row):null;
}
export interface DivineTrialOptions {
 readonly domain:{genesisHash:string;economyProgram:string};
 readonly sponsorWallet:string;
 readonly qualificationSource:Parameters<typeof createMiningClaimReader>[1];
 readonly finalizedDeedReader?:FinalizedDeedReader|null;readonly deedCollection?:string|null;
 readonly clock?:()=>Date;
}
export type DivineTrialHistoryOptions=Pick<DivineTrialOptions,'finalizedDeedReader'|'deedCollection'|'clock'>;
export function createDivineTrials(db:Db,options:DivineTrialOptions|DivineTrialHistoryOptions={}){
 if('rollback'in db)throw Error('DIVINE_TRIAL_TOP_LEVEL');
 const current='domain'in options?options:null;
 const domain=current?domainSchema.parse(current.domain):null,sponsorWallet=current?address.parse(current.sponsorWallet):null,clock=options.clock??(()=>new Date());
 if(current&&(domain!.genesisHash!==current.qualificationSource.trust.expectedGenesisHash||domain!.economyProgram!==current.qualificationSource.trust.programId.toBase58()))throw Error('DIVINE_TRIAL_DOMAIN');
 const qualify=current?createDivineTrialQualificationReader(db,current.qualificationSource,clock):null,reader=options.finalizedDeedReader??null,collection=options.deedCollection??null;
 const now=()=>{const d=new Date(clock().getTime());if(!Number.isSafeInteger(d.getTime()))throw Error('DIVINE_TRIAL_CLOCK');return d;};
 async function ownedBase(wallet:string,baseId:string){
  const [base]=await db.select().from(bases).where(and(eq(bases.id,baseId),eq(bases.ownerWallet,wallet),eq(bases.status,'active')));
  if(!base)return fail('BASE_NOT_OWNED',404);
  if(base.deedAssetId)await requireExactFinalizedOwnedBaseAuthority(db,wallet,baseId,reader,collection,now());
  else if(base.deedMintAssetId)return fail('BASE_AUTHORITY',503);
 }
 async function lockedBase(tx:DbTx,wallet:string,baseId:string){
  await lockStablePrerequisiteBase(tx,wallet,{baseId,assertAuthority:async(t,w,id)=>{await assertFreshLockedBaseAuthority(t,w,id,now());}});
 }
 async function player(tx:DbTx,wallet:string){if(!(await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update',{noWait:true}))[0])fail('OWNER',404);}
 async function lockedEvent(tx:DbTx,id:string){if(!(await tx.execute(sql`select id from public.divine_trial_events where id=${id}::uuid for update nowait`))[0])fail('NOT_FOUND',404);const e=await event(tx,id);if(domain&&!isDeepStrictEqual(e.domain,domain))fail('DOMAIN',503);return e;}
 function window(e:DivineTrialEvent,at:Date,kind:'entry'|'play'){const ms=at.getTime(),start=Date.parse(kind==='entry'?e.entryStartsAt:e.playStartsAt),end=Date.parse(kind==='entry'?e.playStartsAt:e.playEndsAt);if(e.terminal||ms<start||ms>=end)fail('WINDOW');}
 function sameEntry(prior:DivineTrialEntry,cmd:z.infer<typeof DivineTrialEntryRequestSchema>){if(prior.baseId!==cmd.baseId||prior.idempotencyKey!==cmd.idempotencyKey)fail('IDEMPOTENCY_BODY_MISMATCH');return prior;}
 async function fund(wallet:string,raw:unknown){
  identity(wallet);const cmd=Fund.parse(raw);divineTrialSchedule(cmd.weekStart);if(wallet!==sponsorWallet)fail('SPONSOR',403);
  const prior=await db.execute<{funding:{baseId:string}}>(sql`select funding from public.divine_trial_events where id=${cmd.id}::uuid`);
  const original=async()=>{const e=await event(db,cmd.id);if(prior[0]?.funding.baseId!==cmd.baseId||e.sponsorWallet!==wallet||e.entryStartsAt!==cmd.weekStart||!isDeepStrictEqual(e.domain,domain)||!isDeepStrictEqual(e.budget,cmd.budget))fail('IDEMPOTENCY_BODY_MISMATCH');return e;};
  if(prior[0])return original();enabled();await ownedBase(wallet,cmd.baseId);
  return db.transaction(async tx=>{
   await player(tx,wallet);await lockedBase(tx,wallet,cmd.baseId);enabled();const at=now();if(at.getTime()>=Date.parse(cmd.weekStart))fail('WINDOW');
   const duplicate=await tx.execute<{funding:{baseId:string}}>(sql`select funding from public.divine_trial_events where id=${cmd.id}::uuid`);
   if(duplicate[0]){const e=await event(tx,cmd.id);if(duplicate[0].funding.baseId!==cmd.baseId||e.sponsorWallet!==wallet||e.entryStartsAt!==cmd.weekStart||!isDeepStrictEqual(e.domain,domain)||!isDeepStrictEqual(e.budget,cmd.budget))fail('IDEMPOTENCY_BODY_MISMATCH');return e;}
   await tx.execute(sql`insert into public.divine_trial_events(id,domain,week_start,sponsor_wallet,policy,budget,encounter,funding,funded_at,tx_key) values(${cmd.id}::uuid,${JSON.stringify(domain)}::jsonb,${cmd.weekStart}::timestamptz,${wallet},${JSON.stringify(DIVINE_TRIAL_POLICY)}::jsonb,${JSON.stringify(cmd.budget)}::jsonb,${JSON.stringify(divineTrialEncounter())}::jsonb,${JSON.stringify({baseId:cmd.baseId})}::jsonb,${at.toISOString()}::timestamptz,pg_current_xact_id()::text)`);return event(tx,cmd.id);
  });
 }
 async function enter(wallet:string,eventId:string,raw:unknown){
  identity(wallet,eventId);const cmd=DivineTrialEntryRequestSchema.parse(raw),prior=await entry(db,wallet,eventId);if(prior)return sameEntry(prior,cmd);
  if(!qualify||!domain)fail('CONFIGURATION',503);enabled();const current=await event(db,eventId);window(current,now(),'entry');await ownedBase(wallet,cmd.baseId);const proof=await qualify!(wallet);
  return db.transaction(async tx=>{
   await player(tx,wallet);const again=await entry(tx,wallet,eventId);if(again)return sameEntry(again,cmd);
   await lockedBase(tx,wallet,cmd.baseId);const e=await lockedEvent(tx,eventId);enabled();const at=now();window(e,at,'entry');assertDivineTrialQualificationAge(proof,at);
   if(proof.wallet!==wallet||!isDeepStrictEqual(proof.domain,e.domain))fail('QUALIFICATION',503);
   const id=randomUUID(),record={version:P.version,id,eventId,wallet,...cmd,enteredAt:at.toISOString(),qualification:proof.qualification};
   await tx.execute(sql`insert into public.divine_trial_entries(id,event_id,wallet,base_id,idempotency_key,record,source_json,source_sha256,observed_at,entered_at) values(${id}::uuid,${eventId}::uuid,${wallet},${cmd.baseId}::uuid,${cmd.idempotencyKey}::uuid,${JSON.stringify(record)}::jsonb,${proof.sourceJson},${proof.qualification.sourceSha256},${new Date(proof.observedAtMs).toISOString()}::timestamptz,${at.toISOString()}::timestamptz)`);
   // No admission can refresh an observation after queued locks/writes.
   enabled();window(e,now(),'entry');assertDivineTrialQualificationAge(proof,now());return (await entry(tx,wallet,eventId))!;
  });
 }
 async function admit(wallet:string,eventId:string,raw:unknown){
  identity(wallet,eventId);const cmd=DivineTrialAttemptRequestSchema.parse(raw);
  async function prior(t:DbOrTx){const [r]=await t.execute<{id:string}>(sql`select id from public.divine_trial_attempts where event_id=${eventId}::uuid and wallet=${wallet} and idempotency_key=${cmd.idempotencyKey}::uuid`);if(!r)return null;const a=await attempt(t,wallet,r.id);if(a.baseId!==cmd.baseId)fail('IDEMPOTENCY_BODY_MISMATCH');return a;}
  const old=await prior(db);if(old)return old;if(!qualify||!domain)fail('CONFIGURATION',503);enabled();await ownedBase(wallet,cmd.baseId);
  return db.transaction(async tx=>{
   await player(tx,wallet);const again=await prior(tx);if(again)return again;await lockedBase(tx,wallet,cmd.baseId);const e=await lockedEvent(tx,eventId);enabled();const at=now();window(e,at,'play');
   if(!await entry(tx,wallet,eventId))fail('NOT_ENTERED');
   const rows=await tx.execute<{id:string;terminal:boolean}>(sql`select a.id,o.attempt_id is not null terminal from public.divine_trial_attempts a left join public.divine_trial_outcomes o on o.attempt_id=a.id where a.event_id=${eventId}::uuid and a.wallet=${wallet}`);
   if(rows.some(r=>!r.terminal))fail('UNFINISHED');if(rows.length>=P.attemptsPerWallet)fail('ATTEMPT_LIMIT');
   const id=randomUUID(),ordinal=rows.length+1,record={version:P.version,id,eventId,wallet,...cmd,ordinal,admittedAt:at.toISOString()};
   await tx.execute(sql`insert into public.divine_trial_attempts(id,event_id,wallet,base_id,idempotency_key,ordinal,record,admitted_at) values(${id}::uuid,${eventId}::uuid,${wallet},${cmd.baseId}::uuid,${cmd.idempotencyKey}::uuid,${ordinal},${JSON.stringify(record)}::jsonb,${at.toISOString()}::timestamptz)`);enabled();window(e,now(),'play');return attempt(tx,wallet,id);
  });
 }
 async function resolve(wallet:string,id:string){
  const a=await attempt(db,wallet,id);if(a.status!=='committed')return a;
  // No DB locks or ordinary raid effects during CPU work. The durable original
  // tolerates duplicate processes; the event lock decides the sole equal result.
  if(!supportsDivineTrialSimulator(a.encounter.simVersion))fail('SIM_VERSION',503);
  const permit=claimRaidSimulationPermit();let result;
  try{const out=await permit.run({snapshot:a.encounter.snapshot,orders:a.orders!,seed:a.encounter.seed,options:{troopLevels:a.encounter.levels}});result={stars:out.stars,destruction:out.destructionPct,events:out.events,inputSha256:hash({encounter:a.encounter,orders:a.orders})};}finally{await permit.release();}
  return db.transaction(async tx=>{
   await lockedEvent(tx,a.eventId);const original=await attempt(tx,wallet,id);if(original.status==='completed'){if(!isDeepStrictEqual(original.result,result))throw Error('DIVINE_TRIAL_RESULT_CONFLICT');return original;}
   if(original.status!=='committed'||!isDeepStrictEqual(original.orders,a.orders))throw Error('DIVINE_TRIAL_COMMAND_CONFLICT');
   const at=now();await tx.execute(sql`insert into public.divine_trial_outcomes(attempt_id,status,result,completed_at) values(${id}::uuid,'completed',${JSON.stringify(result)}::jsonb,${at.toISOString()}::timestamptz)`);return attempt(tx,wallet,id);
  });
 }
 async function submit(wallet:string,id:string,raw:unknown){
  identity(wallet,id);const {orders}=DivineTrialSubmitRequestSchema.parse(raw),a=await attempt(db,wallet,id);
  if(a.orders){if(!isDeepStrictEqual(a.orders,orders))fail('IDEMPOTENCY_BODY_MISMATCH');return resolve(wallet,id);}
  if(a.status!=='admitted')fail('ATTEMPT_CLOSED');enabled();for(const d of orders.deploys)validateDropPoint(a.encounter.snapshot,d.tx,d.ty);
  await db.transaction(async tx=>{
   await player(tx,wallet);const e=await lockedEvent(tx,a.eventId),original=await attempt(tx,wallet,id);
   if(original.orders){if(!isDeepStrictEqual(original.orders,orders))fail('IDEMPOTENCY_BODY_MISMATCH');return;}
   if(original.status!=='admitted')fail('ATTEMPT_CLOSED');enabled();const at=now();window(e,at,'play');
   await tx.execute(sql`insert into public.divine_trial_commands(attempt_id,orders,input_sha256,committed_at) values(${id}::uuid,${JSON.stringify(orders)}::jsonb,${hash({encounter:a.encounter,orders})},${at.toISOString()}::timestamptz)`);enabled();window(e,now(),'play');
  });return resolve(wallet,id);
 }
 async function abandon(wallet:string,id:string){
  identity(wallet,id);const a=await attempt(db,wallet,id);
  return db.transaction(async tx=>{await player(tx,wallet);await lockedEvent(tx,a.eventId);const original=await attempt(tx,wallet,id);if(original.status==='abandoned'||original.status==='expired')return original;if(original.status!=='admitted')fail('COMMAND_COMMITTED');
   await tx.execute(sql`insert into public.divine_trial_outcomes(attempt_id,status,result,completed_at) values(${id}::uuid,'abandoned',null,${now().toISOString()}::timestamptz)`);return attempt(tx,wallet,id);});
 }
 async function close(eventId:string){
  Id.parse(eventId);const e=await event(db,eventId);if(e.terminal)return e;if(now().getTime()<Date.parse(e.playEndsAt))fail('WINDOW');
  const pending=await db.execute<{id:string;wallet:string}>(sql`select a.id,a.wallet from public.divine_trial_attempts a join public.divine_trial_commands c on c.attempt_id=a.id left join public.divine_trial_outcomes o on o.attempt_id=a.id where a.event_id=${eventId}::uuid and o.attempt_id is null order by a.wallet collate "C",a.ordinal`);
  for(const a of pending)await resolve(a.wallet,a.id);
  return db.transaction(async tx=>{const locked=await lockedEvent(tx,eventId);if(locked.terminal)return locked;const at=now();if(at.getTime()<Date.parse(locked.playEndsAt))fail('WINDOW');
   await tx.execute(sql`insert into public.divine_trial_outcomes(attempt_id,status,result,completed_at) select a.id,'expired',null,${at.toISOString()}::timestamptz from public.divine_trial_attempts a left join public.divine_trial_commands c on c.attempt_id=a.id left join public.divine_trial_outcomes o on o.attempt_id=a.id where a.event_id=${eventId}::uuid and c.attempt_id is null and o.attempt_id is null`);
   await tx.execute(sql`insert into public.divine_trial_event_terminals(event_id,record,completed_at,tx_key) values(${eventId}::uuid,'{}',${at.toISOString()}::timestamptz,pg_current_xact_id()::text)`);
   const closed=await event(tx,eventId),rows=await tx.execute<{wallet:string;attemptId:string;ordinal:number;stars:number;destruction:number}>(sql`select a.wallet,a.id as "attemptId",a.ordinal,(o.result->>'stars')::integer stars,(o.result->>'destruction')::integer destruction from public.divine_trial_attempts a join public.divine_trial_outcomes o on o.attempt_id=a.id where a.event_id=${eventId}::uuid and o.status='completed'`);
   const expected=divineTrialSettlement(rows,closed.budget,closed.sponsorWallet);expected.rankings=expected.rankings.slice(0,P.divineSites);
   if(!isDeepStrictEqual(closed.terminal,{version:P.version,eventId,completedAt:at.toISOString(),...expected}))throw Error('DIVINE_TRIAL_SETTLEMENT_MISMATCH');return closed;
  });
 }
 async function claim(wallet:string,eventId:string,raw:unknown){
  identity(wallet,eventId);const cmd=DivineTrialPrizeRequestSchema.parse(raw),same=(p:DivineTrialClaim)=>{if(p.baseId!==cmd.baseId)fail('IDEMPOTENCY_BODY_MISMATCH');return p;},prior=await prize(db,wallet,eventId);if(prior)return same(prior);
  await ownedBase(wallet,cmd.baseId);return db.transaction(async tx=>{await player(tx,wallet);const again=await prize(tx,wallet,eventId);if(again)return same(again);await lockedBase(tx,wallet,cmd.baseId);await lockedEvent(tx,eventId);
   await tx.execute(sql`insert into public.divine_trial_prize_claims(event_id,wallet,base_id,amounts,stock,claimed_at,tx_key) values(${eventId}::uuid,${wallet},${cmd.baseId}::uuid,'{}','[]',${now().toISOString()}::timestamptz,pg_current_xact_id()::text)`);return (await prize(tx,wallet,eventId))!;});
 }
 async function participant(wallet:string,eventId:string){
  identity(wallet,eventId);const e=await event(db,eventId),rows=await db.execute<{id:string}>(sql`select id from public.divine_trial_attempts where event_id=${eventId}::uuid and wallet=${wallet} order by ordinal`),attempts=[];
  for(const r of rows)attempts.push(await attempt(db,wallet,r.id));const entitlement=e.terminal?.entitlements.find(x=>x.wallet===wallet);
  return DivineTrialParticipantSchema.parse({version:P.version,eventId,wallet,entry:await entry(db,wallet,eventId),attempts,prize:entitlement?{amounts:entitlement.amounts,claim:await prize(db,wallet,eventId)}:null});
 }
 async function events(wallet:string,rawCursor?:string){
  identity(wallet);await source(db);let cursor:z.infer<typeof cursorSchema>|null=null;
  if(rawCursor!==undefined){try{if(rawCursor.length>P.maxStringLength)fail('INPUT',400);const bytes=Buffer.from(rawCursor,'base64url');if(bytes.toString('base64url')!==rawCursor)fail('INPUT',400);cursor=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return fail('INPUT',400);}}
  const rows=await db.execute<{id:string;at:string}>(sql`select id,to_char(week_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at from public.divine_trial_events where ${domain?sql`domain=${JSON.stringify(domain)}::jsonb`:sql`true`} ${cursor?sql`and (week_start,id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)`:sql``} order by week_start desc,id desc limit ${P.discoveryPageSize+1}`),page=rows.slice(0,P.discoveryPageSize),last=page.at(-1),items=[];
  for(const r of page)items.push(await event(db,r.id));return DivineTrialEventsSchema.parse({version:P.version,events:items,nextCursor:rows.length>P.discoveryPageSize&&last?Buffer.from(JSON.stringify({at:last.at,id:last.id})).toString('base64url'):null});
 }
 async function read(wallet:string,id:string){identity(wallet,id);return attempt(db,wallet,id);}
 return Object.freeze({fund,close,enter,admit,submit,abandon,claim,participant,events,read});
}
/** Deliberately omits operator funding and closing from HTTP dependencies. */
export type DivineTrialProvider=Pick<ReturnType<typeof createDivineTrials>,'enter'|'admit'|'submit'|'abandon'|'claim'|'participant'|'events'|'read'>;
