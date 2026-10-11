/** D153.181 private server matchmade admissions and deterministic replay. No
 * caller-selected defender, post-hoc ordinary raid adoption or supplied score. */
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {COMBAT_TICK_MS,LIVE_RAID,RAID_RULES,PHASE_E_CHARTER_TOURNAMENT as P,type BaseSnapshot} from '@shardkeep/shared';
import {resolveBaseVisualContext} from '@shardkeep/shared/baseVisual';
import {SIM_VERSION,type RaidOrders,type RaidOutcome,type SimOptions} from '@shardkeep/sim';
import type {Db,DbOrTx} from '../db/client';
import {players,raids} from '../db/schema';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {createRaid} from './raids';
import {claimRaidSimulationPermit} from './raidSimulationRunner';
import type {RaidSimulationWorkerInput} from './raidSimulationWorker';
const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const Command=z.object({eventId:uuid,baseId:uuid,idempotencyKey:uuid}).strict();
type RaidOptions=Parameters<typeof createRaid>[2];
export interface CharterTournamentRaidOptions{authorizeAttackerBase:NonNullable<RaidOptions['authorizeAttackerBase']>;authorizeDefenderBase:NonNullable<RaidOptions['authorizeDefenderBase']>;clock?:()=>Date}
type RaidRow=Awaited<ReturnType<typeof createRaid>>;
type TournamentRaidSnapshot=Pick<RaidRow,'id'|'defenderWallet'|'attackerBaseId'|'defenderBaseId'|'snapshot'|'armySnapshot'|'ordersDeadlineAt'|'simVersion'|'raidProtocolVersion'>&{seed:number;visualContext:ReturnType<typeof resolveBaseVisualContext>};
export interface CharterTournamentRaidState{version:1;status:'requested'|'admitted'|'cancelled';eventId:string;requestId:string;baseId:string;ordinal:number|null;raid:TournamentRaidSnapshot|null}
const fail=(code:string,status=409):never=>{throw new HttpError(status,'Charter tournament raid is unavailable',code);};
async function request(db:DbOrTx,actor:string,eventId:string,idempotencyKey:string){
 uuid.parse(eventId);uuid.parse(idempotencyKey);if(!actor)return fail('CHARTER_TOURNAMENT_ACTOR',400);
 await db.execute(sql`SELECT public.shardkeep_charter_tournament_raid_source()`);
 const rows=await db.execute(sql`SELECT r.id,r.event_id,r.base_id,r.private_key,a.ordinal,a.raid_id,c.request_id AS cancelled FROM public.charter_tournament_raid_requests r LEFT JOIN public.charter_tournament_raid_admissions a ON a.request_id=r.id LEFT JOIN public.charter_tournament_raid_cancellations c ON c.request_id=r.id WHERE r.event_id=${eventId}::uuid AND r.actor=${actor} AND r.command_id=${idempotencyKey}::uuid`);
 return rows[0] as {id:string;event_id:string;base_id:string;private_key:string;ordinal:number|null;raid_id:string|null;cancelled:string|null}|undefined;
}
export async function readCharterTournamentRaid(db:DbOrTx,actor:string,eventId:string,idempotencyKey:string):Promise<CharterTournamentRaidState|null>{
 const row=await request(db,actor,eventId,idempotencyKey);if(!row)return null;
 let raid:CharterTournamentRaidState['raid']=null;
 if(row.raid_id){const [saved]=await db.select().from(raids).where(eq(raids.id,row.raid_id));if(!saved||saved.attackerWallet!==actor)throw new Error('CHARTER_TOURNAMENT_SOURCE');// Match the ordinary raid admission DTO. SQL bigint seed is safely bounded
 // by the original raid contract; private matchmaking keys and worker leases
 // never cross the client boundary.
 raid={id:saved.id,defenderWallet:saved.defenderWallet,attackerBaseId:saved.attackerBaseId,defenderBaseId:saved.defenderBaseId,snapshot:saved.snapshot,visualContext:resolveBaseVisualContext(saved.visualContext),armySnapshot:saved.armySnapshot,ordersDeadlineAt:saved.ordersDeadlineAt,seed:Number(saved.seed),simVersion:saved.simVersion,raidProtocolVersion:LIVE_RAID.protocolVersion};}
 return {version:1,status:row.cancelled?'cancelled':row.raid_id?'admitted':'requested',eventId:row.event_id,requestId:row.id,baseId:row.base_id,ordinal:row.ordinal,raid};
}
export async function startCharterTournamentRaid(db:Db,actor:string,command:z.infer<typeof Command>,options:CharterTournamentRaidOptions):Promise<CharterTournamentRaidState>{
 const cmd=Command.parse(command);let row=await request(db,actor,cmd.eventId,cmd.idempotencyKey);
 if(row?.base_id!==undefined&&row.base_id!==cmd.baseId)return fail('IDEMPOTENCY_BODY_MISMATCH');
 if(row?.raid_id||row?.cancelled)return (await readCharterTournamentRaid(db,actor,cmd.eventId,cmd.idempotencyKey))!;
 if(!phaseECharterEnabled())return fail('PHASE_E_DISABLED',503);
 if(!row){await db.transaction(async tx=>{
  const [player]=await tx.select().from(players).where(eq(players.wallet,actor)).for('update',{noWait:true});if(!player)return fail('CHARTER_TOURNAMENT_ACTOR',404);
  const again=await request(tx,actor,cmd.eventId,cmd.idempotencyKey);if(again){if(again.base_id!==cmd.baseId)return fail('IDEMPOTENCY_BODY_MISMATCH');return;}
  const now=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isFinite(now.getTime()))throw new Error('CHARTER_TOURNAMENT_CLOCK');
  const privateKey=randomUUID(),namespace=createHash('sha256').update(`${actor}\0pvp`).digest('hex');
  await tx.execute(sql`INSERT INTO public.charter_tournament_raid_requests(id,event_id,actor,base_id,command_id,private_key,raid_key,created_at,entry,tx_key) VALUES(${randomUUID()}::uuid,${cmd.eventId}::uuid,${actor},${cmd.baseId}::uuid,${cmd.idempotencyKey}::uuid,${privateKey}::uuid,${`raid:${namespace}:${privateKey}`},${now.toISOString()}::timestamptz,'{}',pg_current_xact_id()::text)`);
 });row=await request(db,actor,cmd.eventId,cmd.idempotencyKey);}
 if(!row)throw new Error('CHARTER_TOURNAMENT_REQUEST');
 if(row.cancelled||row.raid_id)return (await readCharterTournamentRaid(db,actor,cmd.eventId,cmd.idempotencyKey))!;
 // This key is durable before the original effect and never included in the
 // tournament DTO. Its retry uses the identical automatic matchmaking route.
 await createRaid(db,actor,{attackerBaseId:cmd.baseId,idempotencyKey:row.private_key,authorizeAttackerBase:options.authorizeAttackerBase,authorizeDefenderBase:options.authorizeDefenderBase,raidProtocolVersion:LIVE_RAID.protocolVersion,allowRaidProtocolV2:true},options.clock);
 const saved=await readCharterTournamentRaid(db,actor,cmd.eventId,cmd.idempotencyKey);if(!saved?.raid||saved.ordinal===null)throw new Error('CHARTER_TOURNAMENT_ADMISSION');return saved;
}
/** Abandon only an original request that has never created a raid. The SQL
 * tombstone fences a delayed createRaid at its actual admission transaction. */
export async function cancelCharterTournamentRaidRequest(db:Db,actor:string,command:{eventId:string;idempotencyKey:string},options:{clock?:()=>Date}={}):Promise<CharterTournamentRaidState>{
 const cmd=z.object({eventId:uuid,idempotencyKey:uuid}).strict().parse(command);
 return db.transaction(async tx=>{
  const [player]=await tx.select().from(players).where(eq(players.wallet,actor)).for('update',{noWait:true});if(!player)return fail('CHARTER_TOURNAMENT_ACTOR',404);
  await tx.execute(sql`SELECT id FROM public.charter_tournament_events WHERE id=${cmd.eventId}::uuid FOR UPDATE NOWAIT`);
  const saved=await request(tx,actor,cmd.eventId,cmd.idempotencyKey);if(!saved)return fail('CHARTER_TOURNAMENT_RAID_NOT_FOUND',404);
  await tx.execute(sql`SELECT id FROM public.charter_tournament_raid_requests WHERE id=${saved.id}::uuid FOR UPDATE NOWAIT`);
  if(saved.cancelled)return (await readCharterTournamentRaid(tx,actor,cmd.eventId,cmd.idempotencyKey))!;
  if(saved.raid_id)return fail('CHARTER_TOURNAMENT_ALREADY_ADMITTED');
  const now=new Date((options.clock??(()=>new Date()))().getTime());if(!Number.isFinite(now.getTime()))throw new Error('CHARTER_TOURNAMENT_CLOCK');
  await tx.execute(sql`INSERT INTO public.charter_tournament_raid_cancellations(request_id,actor,original_request,cancelled_at,tx_key) VALUES(${saved.id}::uuid,${actor},'{}',${now.toISOString()}::timestamptz,pg_current_xact_id()::text)`);
  return (await readCharterTournamentRaid(tx,actor,cmd.eventId,cmd.idempotencyKey))!;
 });
}
interface OriginalTerminal{status:string;sim_version:number;seed:number;snapshot:BaseSnapshot;orders:RaidOrders|null;army_snapshot:{levels:NonNullable<SimOptions['troopLevels']>};result:{stars:number;destructionPct:number;retreated?:boolean}|null;events:unknown}
export interface CharterTournamentReplay{raidId:string;completed:boolean;stars:number;destruction:number;inputSha256:string}
/** Only original server-captured rows enter here. Exported for focused CPU
 * verification; never exposed as an HTTP body or used without the SQL binding. */
export async function verifyCharterTournamentReplay(original:unknown,retreat:unknown,run:(input:RaidSimulationWorkerInput)=>Promise<RaidOutcome>,liveState?:unknown):Promise<Omit<CharterTournamentReplay,'raidId'>>{
 const json=JSON.stringify({original,retreat,liveState:liveState??null});if(Buffer.byteLength(json,'utf8')>P.maxReplayInputBytes)throw new Error('CHARTER_TOURNAMENT_REPLAY_BOUNDS');
 const r=original as OriginalTerminal;if(!r||typeof r!=='object'||!['resolved','expired'].includes(r.status))return fail('CHARTER_TOURNAMENT_PENDING_RAID');
 const inputSha256=createHash('sha256').update(json).digest('hex');
 if(r.status==='expired')return {completed:false,stars:0,destruction:0,inputSha256};
 const live=liveState as {started_at?:unknown;stream_closed_at?:unknown}|undefined;
 if(live&&live.started_at===null){const control=retreat as {kind?:unknown;payload?:{_clock?:{simNowMs?:unknown}}}|null;if(!live.stream_closed_at||control?.kind!=='retreat'||control.payload?._clock?.simNowMs!==0||r.result?.retreated!==true||r.result.stars!==0||r.result.destructionPct!==0||!isDeepStrictEqual(r.events,[]))throw new Error('CHARTER_TOURNAMENT_PRESTART_RETREAT');return {completed:false,stars:0,destruction:0,inputSha256};}
 if(r.sim_version!==SIM_VERSION||!Number.isSafeInteger(r.seed)||r.seed<0||r.seed>0xffffffff||!r.orders||!r.snapshot||!r.army_snapshot?.levels||!r.result)throw new Error('CHARTER_TOURNAMENT_REPLAY_INPUT');
 let stopAfterTick:number|undefined;
 if(r.result.retreated){const control=retreat as {kind?:unknown;payload?:{_clock?:{simNowMs?:unknown}}}|null;const ms=control?.payload?._clock?.simNowMs;if(control?.kind!=='retreat'||typeof ms!=='number'||!Number.isSafeInteger(ms)||ms<0||ms>=RAID_RULES.battleDurationSec*1000)throw new Error('CHARTER_TOURNAMENT_RETREAT');stopAfterTick=Math.floor(ms/COMBAT_TICK_MS);}
 const outcome=await run({snapshot:r.snapshot,orders:r.orders,seed:r.seed,options:{troopLevels:r.army_snapshot.levels,...(stopAfterTick===undefined?{}:{stopAfterTick})}});
 if(!Number.isSafeInteger(outcome.stars)||outcome.stars<0||outcome.stars>P.maxStarsPerRaid||!Number.isSafeInteger(outcome.destructionPct)||outcome.destructionPct<0||outcome.destructionPct>P.maxDestructionPerRaid||outcome.stars!==r.result.stars||outcome.destructionPct!==r.result.destructionPct||!isDeepStrictEqual(outcome.events,r.events))throw new Error('CHARTER_TOURNAMENT_REPLAY_MISMATCH');
 return {completed:true,stars:outcome.stars,destruction:outcome.destructionPct,inputSha256};
}
export async function replayCharterTournamentRaid(db:Db,actor:string,raidId:string):Promise<CharterTournamentReplay>{
 uuid.parse(raidId);await db.execute(sql`SELECT public.shardkeep_charter_tournament_raid_source()`);
 const rows=await db.execute(sql`SELECT a.actor,o.original_terminal,o.retreat,o.live_state,p.record FROM public.charter_tournament_raid_admissions a LEFT JOIN public.charter_tournament_raid_outcomes o ON o.raid_id=a.raid_id LEFT JOIN public.charter_tournament_raid_replays p ON p.raid_id=a.raid_id WHERE a.raid_id=${raidId}::uuid AND a.actor=${actor}`);
 const row=rows[0];if(!row)return fail('CHARTER_TOURNAMENT_RAID_NOT_FOUND',404);if(row['record'])return row['record'] as unknown as CharterTournamentReplay;
 if(!row['original_terminal'])return fail('CHARTER_TOURNAMENT_PENDING_RAID');
 const result=await verifyCharterTournamentReplay(row['original_terminal'],row['retreat'],async input=>{const permit=claimRaidSimulationPermit();try{return await permit.run(input);}finally{await permit.release();}},row['live_state']);
 const record={raidId,...result,kind:result.completed?'deterministic-original-replay':(row['original_terminal'] as OriginalTerminal).status==='expired'?'original-expiry':'original-prestart-retreat'};
 await db.transaction(async tx=>{
  await tx.execute(sql`SELECT raid_id FROM public.charter_tournament_raid_outcomes WHERE raid_id=${raidId}::uuid FOR UPDATE NOWAIT`);
  const prior=await tx.execute(sql`SELECT record FROM public.charter_tournament_raid_replays WHERE raid_id=${raidId}::uuid`);if(prior[0]){if(!isDeepStrictEqual(prior[0]['record'],record))throw new Error('CHARTER_TOURNAMENT_REPLAY_MISMATCH');return;}
  await tx.execute(sql`INSERT INTO public.charter_tournament_raid_replays(raid_id,original_terminal,input_sha256,stars,destruction,completed,record,tx_key) VALUES(${raidId}::uuid,${JSON.stringify(row['original_terminal'])}::jsonb,${result.inputSha256},${result.stars},${result.destruction},${result.completed},${JSON.stringify(record)}::jsonb,pg_current_xact_id()::text)`);
 });return record;
}
export async function replayCharterTournamentEvent(db:Db,eventId:string):Promise<CharterTournamentReplay[]>{
 uuid.parse(eventId);await db.execute(sql`SELECT public.shardkeep_charter_tournament_raid_source()`);
 const rows=await db.execute(sql`SELECT raid_id,actor FROM public.charter_tournament_raid_admissions WHERE event_id=${eventId}::uuid ORDER BY actor,ordinal`);const result:CharterTournamentReplay[]=[];
 for(const row of rows)result.push(await replayCharterTournamentRaid(db,String(row['actor']),String(row['raid_id'])));return result;
}
