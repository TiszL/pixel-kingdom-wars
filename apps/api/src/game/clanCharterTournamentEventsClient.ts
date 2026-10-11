/** D181 authenticated event discovery and original beneficiary recovery. The
 * installed factory owns private funding/deed capabilities, never HTTP inputs. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import type {Db,DbTx,DbOrTx} from '../db/client';
import type {SaleDomain} from '../db/charterSales';
import {createCharterTournamentsStore} from '../db/charterTournaments';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireExactFinalizedOwnedBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {readCharterTournamentEvent,readCharterTournamentClaim,closeCharterTournamentEvent,fundCharterTournamentEvent,claimCharterTournamentPrize,FundCharterTournamentSchema,type CharterTournamentEventState} from './charterTournamentEvents';
import {startCharterTournamentRaid,readCharterTournamentRaid,cancelCharterTournamentRaidRequest,replayCharterTournamentRaid,replayCharterTournamentEvent} from './charterTournamentRaids';
import type {CharterTournamentAmounts} from '@shardkeep/shared/charterTournament';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),address=z.string().refine(v=>{try{return new PublicKey(v).toBase58()===v&&v!==PublicKey.default.toBase58();}catch{return false;}});
const cursorSchema=z.object({at:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),id:uuid}).strict();
function fail(suffix:string,status=503):never{throw new HttpError(status,'Tournament event is unavailable','CLAN_CHARTER_TOURNAMENT_'+suffix);}
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||(id!==undefined&&!uuid.safeParse(id).success))return fail('INPUT',400);}
function publicEvent(state:CharterTournamentEventState){const {funding:_funding,...view}=state;return structuredClone(view);}
export interface CharterTournamentEventsClientOptions {
 readonly newFunding?:Readonly<{domain:SaleDomain;sponsorWallet:string}>|null;
 readonly finalizedDeedReader?:FinalizedDeedReader|null;readonly deedCollection?:string|null;readonly clock?:()=>Date;
}
export function createCharterTournamentEventsClient(db:Db,options:CharterTournamentEventsClientOptions={}){
 if('rollback'in db)return fail('TOP_LEVEL');const source=createCharterTournamentsStore(db),clock=options.clock??(()=>new Date());
 const funding=options.newFunding?structuredClone(options.newFunding):null,reader=options.finalizedDeedReader??null,collection=options.deedCollection??null;
 const authority=(baseId:string)=>({baseId,assertAuthority:async(tx:DbTx,actor:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,actor,id);}});
 async function read(actor:string,id:string){identity(actor,id);return publicEvent(await readCharterTournamentEvent(db,id));}
 async function activity(actor:string,rawCursor?:string){
  identity(actor);let cursor:z.infer<typeof cursorSchema>|null=null;
  if(rawCursor!==undefined){try{if(rawCursor.length>256)return fail('INPUT',400);const bytes=Buffer.from(rawCursor,'base64url');if(bytes.toString('base64url')!==rawCursor)return fail('INPUT',400);cursor=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{return fail('INPUT',400);}}
  const rows=await db.execute<{id:string;at:string}>(sql`select id,to_char(week_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') at from public.charter_tournament_events ${cursor?sql`where (week_start,id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)`:sql``} order by week_start desc,id desc limit 21`);
  const page=rows.slice(0,20),last=page.at(-1),events=[];for(const item of page)events.push(await read(actor,item.id));
  return {version:1 as const,events,nextCursor:rows.length>20&&last?Buffer.from(JSON.stringify({at:last.at,id:last.id})).toString('base64url'):null};
 }
 async function entryByKey(actor:string,key:string){identity(actor,key);const [row]=await db.execute<{id:string}>(sql`select id from public.charter_tournament_entries where leader=${actor} and idempotency_key=${key}::uuid`);if(!row)return fail('NOT_FOUND',404);return source.readEntry(actor,row.id);}
 async function close(actor:string,id:string){identity(actor,id);const saved=await readCharterTournamentEvent(db,id);if(saved.terminal)return publicEvent(saved);await replayCharterTournamentEvent(db,id);return publicEvent(await closeCharterTournamentEvent(db,id,{clock}));}
 async function fund(actor:string,input:unknown){
  identity(actor);const cmd=FundCharterTournamentSchema.safeParse(input);if(!cmd.success)return fail('INPUT',400);
  const [exists]=await db.execute<{id:string}>(sql`select id from public.charter_tournament_events where id=${cmd.data.id}::uuid`);
  if(exists){const saved=await readCharterTournamentEvent(db,exists.id);if(saved.sponsorWallet!==actor||saved.funding.baseId!==cmd.data.baseId||saved.entryStartsAt!==cmd.data.weekStart||!isDeepStrictEqual(saved.budget,cmd.data.budget))return fail('CONFLICT',409);return publicEvent(saved);}
  if(!funding||funding.sponsorWallet!==actor)return fail('FUNDING_HELD');
  await requireExactFinalizedOwnedBaseAuthority(db,actor,cmd.data.baseId,reader,collection);
  return publicEvent(await fundCharterTournamentEvent(db,actor,cmd.data,authority(cmd.data.baseId),{...funding,clock}));
 }
 async function claim(actor:string,id:string,raw:unknown){
  identity(actor,id);const cmd=z.object({baseId:uuid}).strict().safeParse(raw);if(!cmd.success)return fail('INPUT',400);
  // An accepted original is replayable with the old destination while paused or
  // after a deed sale. Only a first claim needs fresh ownership and capacity.
  const prior=await readCharterTournamentClaim(db,actor,id);
  if(!prior)await requireExactFinalizedOwnedBaseAuthority(db,actor,cmd.data.baseId,reader,collection);
  return claimCharterTournamentPrize(db,actor,{eventId:id,baseId:cmd.data.baseId},authority(cmd.data.baseId),{clock});
 }
 async function authorizeRaidBase(actor:string,baseId:string,lockedDb?:DbOrTx){
  if(lockedDb){await assertFreshLockedBaseAuthority(lockedDb,actor,baseId);return;}
  await requireExactFinalizedOwnedBaseAuthority(db,actor,baseId,reader,collection);
 }
 async function startRaid(actor:string,id:string,raw:unknown){identity(actor,id);const input=z.object({baseId:uuid,idempotencyKey:uuid}).strict().safeParse(raw);if(!input.success)return fail('INPUT',400);
  return startCharterTournamentRaid(db,actor,{eventId:id,...input.data},{authorizeAttackerBase:authorizeRaidBase,authorizeDefenderBase:authorizeRaidBase,clock});
 }
 async function readRaid(actor:string,id:string,key:string){identity(actor,id);if(!uuid.safeParse(key).success)return fail('INPUT',400);return readCharterTournamentRaid(db,actor,id,key);}
 async function cancelRaidRequest(actor:string,id:string,key:string){identity(actor,id);if(!uuid.safeParse(key).success)return fail('INPUT',400);return cancelCharterTournamentRaidRequest(db,actor,{eventId:id,idempotencyKey:key},{clock});}
 async function replayRaid(actor:string,id:string){identity(actor,id);const value=await replayCharterTournamentRaid(db,actor,id);return {raidId:value.raidId,completed:value.completed,stars:value.stars,destruction:value.destruction,inputSha256:value.inputSha256};}
 async function participation(actor:string,id:string){
  identity(actor,id);const event=await readCharterTournamentEvent(db,id);
  const [sourceRow]=await db.execute<{entry:unknown}>(sql`select public.shardkeep_charter_tournament_entry_for_wallet(${id}::uuid,${actor}) entry`);
  const rows=await db.execute<{command_id:string}>(sql`select r.command_id from public.charter_tournament_raid_requests r left join public.charter_tournament_raid_admissions a on a.request_id=r.id left join public.charter_tournament_raid_cancellations c on c.request_id=r.id where r.event_id=${id}::uuid and r.actor=${actor} and c.request_id is null order by a.ordinal nulls last,r.created_at,r.id limit ${event.policy.raidsPerWallet+event.policy.maxPendingRequestsPerWallet}`),raids=[];
  for(const row of rows){const value=await readCharterTournamentRaid(db,actor,id,row.command_id);if(value)raids.push(value);}
  const entitlement=(event.terminal as {entitlements:{wallet:string;amounts:CharterTournamentAmounts}[]}|null)?.entitlements.find(value=>value.wallet===actor);
  return {version:1 as const,eventId:id,entry:sourceRow?.entry??null,prize:entitlement?{amounts:structuredClone(entitlement.amounts),claim:await readCharterTournamentClaim(db,actor,id)}:null,raids};
 }
 return Object.freeze({read,activity,entryByKey,close,fund,claim,startRaid,readRaid,cancelRaidRequest,replayRaid,participation});
}
export type CharterTournamentEventsClientProvider=ReturnType<typeof createCharterTournamentEventsClient>;
