/** Prospective physical Mine sources. RPC is only in explicit admission before
 * locks; every later earning/raid/custody operation reads durable original facts. */
import {randomUUID,createHash} from 'node:crypto';
import {sql,eq} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import type {Db,DbOrTx,DbTx} from '../db/client';
import {partitionMineWholeUnits} from './shardsTaxMinePartition';
import {attachMineProductionClock} from './shardsTaxMineProduction';
import {players} from '../db/schema';
import {phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../game/stableBasePrerequisites';
import {parseExpeditionTermObservation,type ExpeditionTermReader} from '../game/expeditionTerms';
import {pinObservedOperatingExpeditionTerm,readStoredExpeditionTerm} from '../game/expeditionTermStore';
const request=z.object({idempotencyKey:z.uuid(),baseId:z.uuid()}).strict();
export type MineTaxCommand=z.infer<typeof request>;
const requireValue=(v:unknown,message:string):void=>{if(!v)throw Error(`SHARDS source unavailable: ${message}`);};
export async function readPhysicalMineTaxSource(db:DbOrTx,wallet:string,key:string){
 z.uuid().parse(key);const [r]=await db.execute<{id:string;wallet:string;base_id:string;admitted_at:string;term_id:string;term_hash:string;observation:unknown;mine_ids:string[]}>(sql`select id,wallet,base_id,to_char(admitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') admitted_at,term_id,term_hash,observation,mine_ids from shards_mine_admissions where id=${key}`);
 if(!r||r.wallet!==wallet)return null;const term=await readStoredExpeditionTerm(db,r.term_id,r.term_hash);requireValue(term,'original term');
 const observation=parseExpeditionTermObservation(r.observation,r.admitted_at);requireValue(JSON.stringify(observation.snapshot)===JSON.stringify(term!.snapshot),'original term identity');
 return Object.freeze({idempotencyKey:r.id,wallet:r.wallet,baseId:r.base_id,admittedAt:r.admitted_at,mineIds:Object.freeze([...r.mine_ids]),termId:r.term_id,termHash:r.term_hash});
}
export async function admitPhysicalMineTaxSources(db:Db,wallet:string,value:unknown,context:StableBaseMutationContext,deps:{reader:ExpeditionTermReader;clock?:()=>Date;onlyMissing?:boolean}){
 const cmd=request.parse(value),clock=deps.clock??(()=>new Date()),prior=await readPhysicalMineTaxSource(db,wallet,cmd.idempotencyKey);if(prior){requireValue(prior.baseId===cmd.baseId,'original base');return prior;}
 if(!phaseEMiningEnabled())throw new HttpError(503,'Mining source admission is paused','PHASE_E_DISABLED');
 // Providers must be the server-owned finalized reader/prefetch bridge, never
 // an HTTP body. An unavailable answer cannot become a known-zero term.
 const fetchedAt=new Date(clock().getTime()).toISOString(),raw=await deps.reader.readOperatingTerm(fetchedAt);requireValue(raw,'finalized term');
 const fetched=parseExpeditionTermObservation(raw,fetchedAt);
 return db.transaction(async tx=>{
  await tx.select().from(players).where(eq(players.wallet,wallet)).for('update');const old=await readPhysicalMineTaxSource(tx,wallet,cmd.idempotencyKey);if(old){requireValue(old.baseId===cmd.baseId,'original base');return old;}
  requireValue(context.baseId===cmd.baseId,'base context');await lockStablePrerequisiteBase(tx,wallet,context);
  if(!phaseEMiningEnabled())throw new HttpError(503,'Mining source admission is paused','PHASE_E_DISABLED');
  const preparedAt=new Date(clock().getTime()),initialObservation=parseExpeditionTermObservation(fetched,preparedAt.toISOString());requireValue(+preparedAt-Date.parse(initialObservation.finality.observedAt)<=PHASE_E_SEEKER_AUCTION.observationMaxAgeMs,'stale term');
  // Keep the existing term-before-Mine/carry lock order. Pinning is not the
  // admission timestamp: subsequent lock waits must not backdate authority.
  const pinned=await pinObservedOperatingExpeditionTerm(tx,preparedAt,{readOperatingTerm:async()=>initialObservation});
  // Pool-handle completion can own a job/state before requesting the base FK.
  // Refuse busy provenance instead of waiting while this admission owns base.
  try{
   await tx.execute(sql`select j.id from builder_jobs j join buildings b on b.id=j.building_id where b.base_id=${cmd.baseId} and b.type='mine' and j.kind='build' order by j.id for update of j nowait`);
   await tx.execute(sql`select id from buildings where base_id=${cmd.baseId} and type='mine' order by id for update nowait`);
   await tx.execute(sql`select s.mine_building_id from mine_accrual_states s join buildings b on b.id=s.mine_building_id where b.base_id=${cmd.baseId} and b.type='mine' order by s.mine_building_id for update of s nowait`);
  }catch(error){const e=error as {code?:string;cause?:{code?:string}};if(e?.code==='55P03'||e?.cause?.code==='55P03')throw new HttpError(503,'Mine source provenance is busy; retry admission','SHARDS_SOURCE_HELD');throw error;}
  await lockPhysicalMineTaxActors(tx,[wallet]);
  await context.assertAuthority(tx,wallet,cmd.baseId);
  if(!phaseEMiningEnabled())throw new HttpError(503,'Mining source admission is paused','PHASE_E_DISABLED');
  const at=new Date(clock().getTime());requireValue(+at>=+preparedAt,'admission clock regression');
  const observation=parseExpeditionTermObservation(fetched,at.toISOString());requireValue(+at-Date.parse(observation.finality.observedAt)<=PHASE_E_SEEKER_AUCTION.observationMaxAgeMs,'stale term');
  // Materialize once through the final admission time while the old head still
  // exists. An intermediate reanchor would lose fractional production; closing
  // the old head first would strand its valid earning during the lock wait.
  const targets=deps.onlyMissing?await physicalMinesNeedingTaxSource(tx,wallet,cmd.baseId,at):undefined;
  if(targets?.length===0){
   const [head]=await tx.execute<{admission_id:string}>(sql`select h.admission_id from shards_mine_heads h join shards_mine_admissions a on a.id=h.admission_id where a.base_id=${cmd.baseId} and a.wallet=${wallet} order by h.mine_id limit 1`);
   requireValue(head,'completed physical Mine');return (await readPhysicalMineTaxSource(tx,wallet,head!.admission_id))!;
  }
  const {preparePhysicalMineTaxAdmission}=await import('../game/baseMining');const mines=await preparePhysicalMineTaxAdmission(tx,cmd.baseId,wallet,at,targets);
  requireValue(mines.length>0,'completed physical Mine');await tx.execute(sql`insert into shards_mine_admissions(id,wallet,base_id,admitted_at,term_id,term_hash,observation,mine_ids) values(${cmd.idempotencyKey},${wallet},${cmd.baseId},${at.toISOString()},${pinned.snapshot.termId},${pinned.hash},${JSON.stringify(observation)}::jsonb,ARRAY[${sql.join(mines.map(m=>sql`${m.id}::uuid`),sql`, `)}])`);
  for(const mine of mines){await closePhysicalMineTaxSource(tx,mine.id,at,'replacement');await tx.execute(sql`insert into shards_mine_heads(mine_id,admission_id,quota) values(${mine.id},${cmd.idempotencyKey},${mine.quota.toString()}) on conflict(mine_id) do update set admission_id=excluded.admission_id,quota=excluded.quota`);}
  if(!phaseEMiningEnabled())throw new HttpError(503,'Mining source admission is paused','PHASE_E_DISABLED');return (await readPhysicalMineTaxSource(tx,wallet,cmd.idempotencyKey))!;
 });
}
export async function hasPhysicalMineTaxEra(db:DbOrTx,mineId:string){const [r]=await db.execute(sql`select mine_id from shards_mine_eras where mine_id=${mineId}`);return !!r;}
export async function initializePhysicalMineTaxEra(tx:DbOrTx,input:{mineId:string;baseId:string;at:Date;legacy:bigint}){
 if(await hasPhysicalMineTaxEra(tx,input.mineId))return;requireValue(input.legacy>=0n,'legacy amount');await tx.execute(sql`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${input.mineId},${input.baseId},${input.at.toISOString()},${input.legacy.toString()})`);
 if(input.legacy)await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer) values(${randomUUID()},${input.mineId},${input.baseId},${'legacy:'+input.mineId},${input.at.toISOString()},${input.at.toISOString()},0,${input.legacy.toString()},${input.legacy.toString()})`);
}
export async function closePhysicalMineTaxSource(tx:DbOrTx,mineId:string,at:Date,reason:'replacement'|'custody_change'){
 await tx.execute(sql`insert into shards_mine_closures(admission_id,mine_id,closed_at,reason) select admission_id,mine_id,${at.toISOString()},${reason} from shards_mine_heads where mine_id=${mineId} on conflict do nothing`);
}
export async function closeBaseMineTaxSources(tx:DbOrTx,baseId:string,at:Date){
 await tx.execute(sql`insert into shards_mine_closures(admission_id,mine_id,closed_at,reason) select h.admission_id,h.mine_id,${at.toISOString()},'custody_change' from shards_mine_heads h join shards_mine_eras e on e.mine_id=h.mine_id where e.base_id=${baseId} on conflict do nothing`);
}
export async function physicalMineTaxProjection(db:DbOrTx,input:{mineId:string;wallet:string;lastAt:Date;now:Date}){
 const [r]=await db.execute<{admission_id:string;quota:string;wallet:string;admitted_at:Date;observation:unknown;closed_at:Date|null}>(sql`select h.admission_id,h.quota::text,a.wallet,a.admitted_at,a.observation,c.closed_at from shards_mine_heads h join shards_mine_admissions a on a.id=h.admission_id left join shards_mine_closures c on c.admission_id=h.admission_id and c.mine_id=h.mine_id where h.mine_id=${input.mineId}`);
 if(!r||r.wallet!==input.wallet)return null;
 const observation=parseExpeditionTermObservation(r.observation,new Date(r.admitted_at).toISOString());
 return {admissionId:r.admission_id,observation,startsAtMs:BigInt(Math.max(+new Date(r.admitted_at),Date.parse(observation.snapshot.startsAt))),endsAtMs:BigInt(Math.min(Date.parse(observation.snapshot.endsAt),r.closed_at?+new Date(r.closed_at):Infinity))};
}
/** Read-only fast path, repeated under admission's base/provenance locks before
 * any reanchor. Existing immutable operating coverage needs no new RPC proof. */
export async function physicalMinesNeedingTaxSource(db:DbOrTx,wallet:string,baseId:string,at:Date){
 const mines=await db.execute<{id:string}>(sql`select b.id from buildings b left join builder_jobs j on j.building_id=b.id and j.kind='build' where b.base_id=${baseId} and b.type='mine' and (j.completed_at is not null or j.finishes_at is null or j.finishes_at<=${at.toISOString()}) order by b.id`);
 const missing:string[]=[];
 for(const mine of mines){const source=await physicalMineTaxProjection(db,{mineId:mine.id,wallet,lastAt:at,now:at});if(!source||source.startsAtMs>BigInt(+at)||source.endsAtMs<=BigInt(+at))missing.push(mine.id);}
 return missing;
}
export interface MineCaptureInput {mineId:string;baseId:string;wallet:string;version:number;lastAt:Date;now:Date;gross:bigint;quota:bigint;dayMs:bigint;ownershipUnresolved?:boolean;remainder?:bigint|undefined;productionSettlementId?:string|undefined}
export async function physicalMineTaxPartitions(db:DbOrTx,input:MineCaptureInput){
 const source=await physicalMineTaxProjection(db,input);
 const [policy]=await db.execute<{effective_at:Date}>(sql`select p.effective_at from shards_mine_eras e join shards_mine_policy_boundary p on p.id=e.policy_boundary_id where e.mine_id=${input.mineId}`);
 const parts=partitionMineWholeUnits({anchorMs:BigInt(+input.lastAt),quota:input.quota,dayMs:input.dayMs,gross:input.gross,remainder:input.remainder,term:source&&source.endsAtMs>source.startsAtMs?source:null,...(policy?{legacyBeforeMs:BigInt(+new Date(policy.effective_at))}:{})});
 return parts.map(part=>({...part,covered:part.covered&&!input.ownershipUnresolved,admissionId:part.covered&&!input.ownershipUnresolved?source!.admissionId:null}));
}
export async function recordPhysicalMineTaxAccrual(tx:DbOrTx,input:MineCaptureInput){
 await lockPhysicalMineTaxActors(tx,[input.wallet]);requireValue(+input.now>=+input.lastAt,'clock regression');
 const [boundary]=await tx.execute<{recorded_wallet:string;observed_wallet:string;event_at:Date}>(sql`select recorded_wallet,observed_wallet,event_at from shards_mine_custody_boundaries where base_id=${input.baseId} order by event_at desc limit 1`);
 for(const part of await physicalMineTaxPartitions(tx,input)){
  if(part.legacy){
   await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer) values(${randomUUID()},${input.mineId},${input.baseId},${'policy-legacy:'+input.mineId+':v'+input.version+':u'+part.firstUnit+(input.productionSettlementId?':p'+input.productionSettlementId:'')},${new Date(Number(part.firstAtMs)).toISOString()},${new Date(Number(part.lastAtMs)).toISOString()},0,${part.gross.toString()},${part.gross.toString()})`);
  }else {const segmentId=randomUUID();await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,admission_id,wallet,ownership_status,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer) values(${segmentId},${input.mineId},${input.baseId},${part.admissionId},${input.wallet},${input.ownershipUnresolved||!part.covered&&boundary?.recorded_wallet===input.wallet&&boundary.observed_wallet!==input.wallet&&+new Date(boundary.event_at)<=Number(part.lastAtMs)?'custody_unresolved':'confirmed'},${'mine:'+input.mineId+':v'+input.version+':u'+part.firstUnit+(input.productionSettlementId?':p'+input.productionSettlementId:'')},${new Date(Number(part.firstAtMs)).toISOString()},${new Date(Number(part.lastAtMs)).toISOString()},${input.quota.toString()},${input.lastAt.toISOString()},${part.firstUnit.toString()},${part.lastUnit.toString()},${part.gross.toString()},${part.gross.toString()})`);
   if(input.productionSettlementId)await attachMineProductionClock(tx,segmentId,input.productionSettlementId);
  }
 }
}
export async function physicalMineTaxHeld(db:DbOrTx,input:MineCaptureInput){
 const [prior]=await db.execute(sql`select id from shards_mine_segments where mine_id=${input.mineId} and buffer>0 and wallet is not null and admission_id is null and to_jsonb(shards_mine_segments)->>'recovery_parent_id' is null limit 1`);
 return !!prior||(await physicalMineTaxPartitions(db,input)).some(part=>!part.covered&&!part.legacy);
}
export async function recordPhysicalMineTaxHold(tx:DbOrTx,input:MineCaptureInput&{previous:bigint;projected:bigint}){
 await tx.execute(sql`insert into shards_mine_held_projections(mine_id,state_version,at,wallet,anchor_at,quota,previous_gross,projected_gross) values(${input.mineId},${input.version},${input.now.toISOString()},${input.wallet},${input.lastAt.toISOString()},${input.quota.toString()},${input.previous.toString()},${input.projected.toString()}) on conflict do nothing`);
}
export async function assertPhysicalMineTaxBuffer(db:DbOrTx,mineId:string,amount:bigint){const [r]=await db.execute<{total:string}>(sql`select coalesce(sum(buffer),0)::text total from shards_mine_segments where mine_id=${mineId}`);requireValue(BigInt(r!.total)===amount,'numeric buffer differs from original segments');}
export async function updatePhysicalMineTaxRate(tx:DbOrTx,mineId:string,quota:bigint){await tx.execute(sql`update shards_mine_heads h set quota=${quota.toString()} where mine_id=${mineId} and not exists(select 1 from shards_mine_closures c where c.mine_id=h.mine_id and c.admission_id=h.admission_id)`);}
export const physicalMineSourceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A received finalized mismatch is not a proven historical transfer instant.
 * Repeated observations of the same source epoch never add drain boundaries. */
export async function capturePhysicalMineCustodyBoundary(tx:DbOrTx,input:{baseId:string;recordedWallet:string;observedWallet:string;eventAt:Date;observedAt:Date;slot:bigint|null;source:string}){
 const heads=await tx.execute<{admission_id:string}>(sql`select h.admission_id from shards_mine_heads h join shards_mine_eras e on e.mine_id=h.mine_id where e.base_id=${input.baseId} order by h.mine_id`);
 if(!heads.length)return false;
 const id=physicalMineSourceHash({baseId:input.baseId,from:input.recordedWallet,to:input.observedWallet,epochs:heads.map(h=>h.admission_id)});
 const [prior]=await tx.execute(sql`select id from shards_mine_custody_boundaries where id=${id}`);if(prior)return false;
 const {reanchorBaseMineAccrual}=await import('../game/baseMining');
 await reanchorBaseMineAccrual(tx,input.baseId,input.eventAt,undefined,true);
 await tx.execute(sql`insert into shards_mine_custody_boundaries(id,base_id,recorded_wallet,observed_wallet,event_at,observed_at,observed_slot,source) values(${id},${input.baseId},${input.recordedWallet},${input.observedWallet},${input.eventAt.toISOString()},${input.observedAt.toISOString()},${input.slot?.toString()??null},${input.source})`);
 await closeBaseMineTaxSources(tx,input.baseId,input.eventAt);return true;
}

/** Existing cutover stock remains untaxed even when its physical adoption is delayed. */
export async function recordPhysicalMineLegacyAdoption(tx:DbOrTx,input:{mineId:string;baseId:string;wallet:string;amount:bigint;at:Date}){
 if(!await hasPhysicalMineTaxEra(tx,input.mineId))return;
 await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer) values(${randomUUID()},${input.mineId},${input.baseId},${'legacy-adoption:'+input.wallet+':'+input.mineId},${input.at.toISOString()},${input.at.toISOString()},0,${input.amount.toString()},${input.amount.toString()})`);
}

/** Canonical base/Mine locks precede these wallet locks; no foreign base lock follows. */
export async function lockPhysicalMineTaxActors(tx:DbOrTx,wallets:readonly string[]){
 for(const wallet of [...new Set(wallets)].sort()){
  await tx.execute(sql`insert into shards_tax_wallet_locks(wallet) values(${wallet}) on conflict do nothing`);
  await tx.execute(sql`select wallet from shards_tax_wallet_locks where wallet=${wallet} for update`);
 }
}
