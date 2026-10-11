import { mineProductionRemainder, mineUnitCompletion, readMineProductionClock, type MineProductionClock } from './shardsTaxMineProduction';
/** Private provenance-only repair. No route, operating admission, ledger or
 * payout authority. The actual database owner remains required by SQL. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ReviewedSeekerSourcePolicy, SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import type { Db, DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { MINE_DAY_MS } from '../game/baseMining';
import { pinHistoricalShardsTerm } from '../game/expeditionTermStore';
import type { DeedMiningRosterSource } from './deedRosterQualification';
import { prefetchPhysicalMineCustody, type PhysicalMineCustodyEvidence, type PhysicalMineCustodySegment } from './shardsTaxMineCustody';
import { copyHistoricalShardsSourcePolicy } from './shardsTaxHistoricalTermReader';
import { prefetchHistoricalShardsTermAt } from './shardsTaxHistoricalTermDiscovery';
import { parseHistoricalShardsTermCertificate, type HistoricalShardsTermCertificate } from './shardsTaxObstacleEvidence';
import { lockPhysicalMineTaxActors } from './shardsTaxMineSources';
// Technical work bound; never a quantity/rate/eligibility rule.
const MAX_CHILDREN=32, uuid=z.uuid().refine(v=>v===v.toLowerCase());
const hold=(reason:string):never=>{throw new HttpError(503,`Mine original resolution held: ${reason}`,'SHARDS_MINE_RESOLUTION_HELD');};
function need(value:unknown,reason:string):asserts value{if(!value)hold(reason);}
function instant(value:unknown):string{const at=new Date(value as string);need(Number.isSafeInteger(+at),'invalid stored time');return at.toISOString();}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function enabled(){if(!phaseEMiningEnabled())throw new HttpError(503,'Mine original resolution is paused','PHASE_E_DISABLED');}
type Segment = {
 id:string;mine_id:string;base_id:string;wallet:string|null;admission_id:string|null;ownership_status:string;source_key:string;
 starts_at:string;ends_at:string;anchor_at:string;quota:string;first_unit:string;last_unit:string;gross:string;
 buffer:string;reserved:string;issued:string;discarded:string;resolved:string;recovery_parent_id:string|null;production_clock?:MineProductionClock;
}
type Header = {parent_id:string;parent_original:string;term_source:{genesisHash:string;programId:string;auctionConfig:string};
 custody:PhysicalMineCustodyEvidence['custody']&{version:1;evidence:PhysicalMineCustodyEvidence};verified_at:string;recorded_at:string}
export interface PhysicalMineResolution {
 readonly parentId:string;readonly header:Header;
 readonly children:readonly {segment:Segment;termId:string;termHash:string;certificate:HistoricalShardsTermCertificate}[];
 readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}
const segmentTime=(s:Segment):Segment=>({...s,starts_at:instant(s.starts_at),ends_at:instant(s.ends_at),anchor_at:instant(s.anchor_at)});
async function parent(db:DbOrTx,id:string){const [s]=await db.execute<Segment>(sql`select * from shards_mine_segments where id=${id}`);if(!s)return null;const clock=await readMineProductionClock(db,id,s.source_key);return segmentTime({...s,...(clock?{production_clock:clock}:{})});}
/** Full persisted graph for later independent history validation. Keep original
 * parent JSON as text: parsing JSONB bigint numbers would lose exact quantities. */
export async function readPhysicalMineResolution(db:DbOrTx,segmentId:string):Promise<PhysicalMineResolution|null>{
 uuid.parse(segmentId);
 // One statement keeps the immutable header/children and mutable parent on
 // one READ COMMITTED snapshot, including a concurrently committed repair.
 const rows=await db.execute<Segment&Header&{parent_first:string;parent_last:string;parent_gross:string;parent_resolved:string;
  parent_buffer:string;parent_reserved:string;parent_issued:string;parent_discarded:string;term_id:string|null;term_hash:string|null;certificate:unknown}>(sql`
  select s.*,r.parent_id,r.parent_original::text,r.term_source,r.custody,r.verified_at,r.recorded_at,
   p.first_unit parent_first,p.last_unit parent_last,p.gross parent_gross,p.resolved parent_resolved,
   p.buffer parent_buffer,p.reserved parent_reserved,p.issued parent_issued,p.discarded parent_discarded,
   t.term_id,t.term_hash,t.certificate
  from shards_mine_segments p left join shards_mine_resolutions r on r.parent_id=p.id
  left join shards_mine_segments s on s.recovery_parent_id=p.id
  left join shards_mine_resolution_terms t on t.segment_id=s.id and t.parent_id=p.id
  where p.id=${segmentId} order by s.first_unit,s.id limit ${MAX_CHILDREN+1}`);
 const first=rows[0];if(!first)return null;
 const children=rows.filter(row=>row.id!==null);
 if(!first.parent_id){need(!children.length&&first.parent_resolved==='0','incomplete resolution header');return null;}
 need(first.parent_resolved===first.parent_gross&&first.parent_buffer==='0'&&first.parent_reserved==='0'
  &&first.parent_issued==='0'&&first.parent_discarded==='0','incomplete resolved parent');
 const r:Header={parent_id:first.parent_id,parent_original:first.parent_original,term_source:first.term_source,custody:first.custody,
  verified_at:first.verified_at,recorded_at:first.recorded_at};
 need(children.length>0&&children.length<=MAX_CHILDREN,'incomplete child graph');let next=BigInt(first.parent_first),gross=0n;
 const parts=await Promise.all(children.map(async row=>{
  need(row.term_id&&row.term_hash&&row.certificate,'missing historical child certificate');
  const certificate=parseHistoricalShardsTermCertificate(row.certificate),first=BigInt(row.first_unit),last=BigInt(row.last_unit);
  need(first===next&&last>=first&&BigInt(row.gross)===last-first+1n,'incomplete child ordinals');next=last+1n;gross+=BigInt(row.gross);
  need(certificate.snapshot.termId===row.term_id&&certificate.termHash===row.term_hash,'child term identity');
  const {term_id,term_hash,certificate:_certificate,parent_id:_parent,parent_original:_original,term_source:_source,
   custody:_custody,verified_at:_verified,recorded_at:_recorded,parent_first:_first,parent_last:_last,parent_gross:_gross,
   parent_resolved:_resolved,parent_buffer:_buffer,parent_reserved:_reserved,parent_issued:_issued,parent_discarded:_discarded,...segment}=row;
  const clock=await readMineProductionClock(db,row.id,row.source_key);
  return {segment:segmentTime({...segment,...(clock?{production_clock:clock}:{})}),termId:term_id,termHash:term_hash,certificate};
 }));
 need(next===BigInt(first.parent_last)+1n&&gross===BigInt(first.parent_gross),'incomplete child quantity');
 return freeze({parentId:segmentId,header:{...r,verified_at:instant(r.verified_at),recorded_at:instant(r.recorded_at)},children:parts,
  postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
}
function original(s:Segment):PhysicalMineCustodySegment{
 need(s.wallet&&s.admission_id===null&&s.recovery_parent_id===null,'uncovered original parent required');
 return {id:s.id,mineId:s.mine_id,baseId:s.base_id,wallet:s.wallet,admissionId:null,
  ownershipStatus:s.ownership_status as PhysicalMineCustodySegment['ownershipStatus'],sourceKey:s.source_key,
  anchorAt:s.anchor_at,startsAt:s.starts_at,endsAt:s.ends_at,quota:s.quota,firstUnit:s.first_unit,lastUnit:s.last_unit,gross:s.gross,...(s.production_clock?{productionClock:s.production_clock}:{})};
}
function full(s:Segment){need(s.buffer===s.gross&&s.reserved==='0'&&s.issued==='0'&&s.discarded==='0'&&s.resolved==='0','parent is not wholly buffered');}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export interface PhysicalMineResolutionDependencies {
 historicalTerm?:{connect:(signal:AbortSignal)=>SeekerTermRpc;policy:ReviewedSeekerSourcePolicy};
 deedCustody?:DeedMiningRosterSource;clock?:()=>Date;
}
export async function resolvePhysicalMineTaxSource(db:Db,segmentId:string,deps:PhysicalMineResolutionDependencies={}):Promise<PhysicalMineResolution>{
 if('rollback' in db)hold('top-level database required');uuid.parse(segmentId);
 // Copy every application-owned pin/context before the first asynchronous read.
 const configured=deps.historicalTerm,chain=configured?{connect:configured.connect,policy:copyHistoricalShardsSourcePolicy(configured.policy)}:undefined;
 const deed=deps.deedCustody?{source:deps.deedCustody.source,collection:deps.deedCustody.collection,expectedGenesisHash:deps.deedCustody.expectedGenesisHash}:undefined;
 const clock=deps.clock??(()=>new Date());
 const prior=await readPhysicalMineResolution(db,segmentId);if(prior)return prior;
 enabled();need(chain,'historical finalized provider required');const before=await parent(db,segmentId);need(before,'original parent missing');
 if(before.resolved!=='0'){const raced=await readPhysicalMineResolution(db,segmentId);need(raced,'incomplete concurrent repair');return raced;}full(before);
 const originalBefore=original(before),custody=await prefetchPhysicalMineCustody(db,segmentId,deed);
 need(same(custody.segment,originalBefore),'original custody source changed');
 const anchor=BigInt(Date.parse(before.anchor_at)),quota=BigInt(before.quota),last=BigInt(before.last_unit),day=BigInt(MINE_DAY_MS);
 need(quota>0n,'original quota');const remainder=mineProductionRemainder(before.production_clock,day);
 const completion=(unit:bigint)=>mineUnitCompletion(anchor,quota,day,unit,remainder);
 const prepared:Array<{first:bigint;last:bigint;certificate:HistoricalShardsTermCertificate}>=[];
 for(let first=BigInt(before.first_unit);first<=last;){
  need(prepared.length<MAX_CHILDREN,'historical work bound exceeded');
  const certificate=await prefetchHistoricalShardsTermAt(chain.connect,chain.policy,new Date(Number(completion(first))).toISOString());
  const termEnd=BigInt(Date.parse(certificate.snapshot.endsAt));
  const termLast=(remainder+(termEnd-anchor-1n)*quota)/day,end=termLast<last?termLast:last;
  need(end>=first&&completion(first)>=BigInt(Date.parse(certificate.completedAt)),'original term does not cover earning');
  need(completion(end)<termEnd&&completion(end)<=BigInt(Date.parse(certificate.finality.observedAt)),'original term interval');
  prepared.push({first,last:end,certificate});first=end+1n;
 }
 try{return await db.transaction(async tx=>{
  await tx.execute(sql`select wallet from players where wallet=${before.wallet} for update`);
  const raced=await readPhysicalMineResolution(tx,segmentId);if(raced)return raced;enabled();
  // Original base identity is locked without requiring today's owner to be the
  // original earner. Refuse a busy current-owner base instead of adding an
  // original-player→current-base blocking edge. Closed custody stays authoritative.
  const [base]=await tx.execute(sql`select id from bases where id=${before.base_id} for update nowait`);need(base,'original base missing');
  for(const part of prepared)await pinHistoricalShardsTerm(tx,{readHistoricalTerm:async()=>part.certificate});
  const [mine]=await tx.execute(sql`select id from buildings where id=${before.mine_id} and base_id=${before.base_id} and type='mine' for update nowait`);need(mine,'original Mine missing');
  const [state]=await tx.execute(sql`select mine_building_id from mine_accrual_states where mine_building_id=${before.mine_id} for update nowait`);need(state,'original Mine state missing');
  await lockPhysicalMineTaxActors(tx,[before.wallet!]);
  await tx.execute(sql`select id from shards_mine_segments where id=${segmentId} for update nowait`);
  const current=await parent(tx,segmentId);need(current,'original parent missing');full(current);need(same(original(current),originalBefore),'original parent changed');
  enabled();const verifiedAt=new Date(clock().getTime());need(Number.isSafeInteger(+verifiedAt),'invalid server verification clock');
  need(prepared.every(p=>Date.parse(p.certificate.finality.observedAt)<=+verifiedAt),'certificate observed after verification');
  need(custody.rosters.every(r=>r.observedAt<=verifiedAt.toISOString().replace('Z','000Z'))
   &&(!custody.deeds||custody.deeds.throughBlockTime*1000<=+verifiedAt),'custody observed after verification');
  const source=prepared[0]!.certificate.snapshot.source,domain={genesisHash:source.genesisHash,programId:source.programId,auctionConfig:source.auctionConfig};
  need(prepared.every(p=>p.certificate.snapshot.source.genesisHash===domain.genesisHash&&p.certificate.snapshot.source.programId===domain.programId&&p.certificate.snapshot.source.auctionConfig===domain.auctionConfig),'historical source domain');
  await tx.execute(sql`insert into shards_mine_resolutions(parent_id,term_source,custody,verified_at) values(${segmentId},${JSON.stringify(domain)}::jsonb,${JSON.stringify({version:1,...custody.custody,evidence:custody})}::jsonb,${verifiedAt.toISOString()})`);
  for(const part of prepared){
   const id=randomUUID(),gross=part.last-part.first+1n;
   await tx.execute(sql`insert into shards_mine_segments(id,mine_id,base_id,wallet,ownership_status,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer,recovery_parent_id) values(${id},${before.mine_id},${before.base_id},${before.wallet},'confirmed',${'mine-recovered:'+segmentId+':u'+part.first+(before.production_clock?':p'+before.production_clock.settlementId:'')},${new Date(Number(completion(part.first))).toISOString()},${new Date(Number(completion(part.last))).toISOString()},${before.quota},${before.anchor_at},${part.first.toString()},${part.last.toString()},${gross.toString()},${gross.toString()},${segmentId})`);
   await tx.execute(sql`insert into shards_mine_resolution_terms(segment_id,parent_id,term_id,term_hash,certificate) values(${id},${segmentId},${part.certificate.snapshot.termId},${part.certificate.termHash},${JSON.stringify(part.certificate)}::jsonb)`);
  }
  await tx.execute(sql`update shards_mine_segments set buffer=0,resolved=gross where id=${segmentId}`);
  enabled();const accepted=await readPhysicalMineResolution(tx,segmentId);need(accepted,'missing committed resolution');return accepted;
 });}catch(error){const e=error as {code?:string;cause?:{code?:string}};
  if(e?.code==='55P03'||e?.cause?.code==='55P03')hold('original provenance is busy; retry');throw error;
 }
}
