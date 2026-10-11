import { mineProductionRemainder, mineUnitCompletion, readMineProductionClock, type MineProductionClock } from './shardsTaxMineProduction';
/** Independent immutable Mine source reconstruction for collection and replay.
 * A receipt cannot supply its own original custody, quantity or term authority. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import type {DbOrTx} from '../db/client';
import {MINE_DAY_MS} from '../game/baseMining';
import {readStoredExpeditionTerm} from '../game/expeditionTermStore';
import {hashPhysicalMineCustodyEvidence,type PhysicalMineCustodySegment,type PhysicalMineCustodyEvidence,type PhysicalMineClosedDayCustodyEvidence} from './shardsTaxMineCustody';
import {readPhysicalMineResolution} from './shardsTaxMineResolution';
import {hashHistoricalShardsTermCertificate,type HistoricalShardsTermCertificate} from './shardsTaxObstacleEvidence';
import {hashHistoricalMineTaxEvidence,HISTORICAL_MINE_SOURCE_DECISION,type HistoricalMineTaxOriginal} from './shardsTaxMineHistoricalAttribution';
import {parseShardsTaxSource} from './shardsTaxAttribution';
import {validateMiningRosterIntervalEvidence} from './rosterIntervalHistory';
import {validateMiningRosterCheckpointIntervalEvidence} from './rosterCheckpointHistory';
function need(value:unknown,reason:string):asserts value{if(!value)throw Error(`Historical Mine source held: ${reason}`);}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
 Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value;
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function quantity(value:unknown):bigint{need(typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value),'canonical quantity');const n=BigInt(value);need(n<=RAW_RESOURCE_STORAGE_MAX,'quantity overflow');return n;}
function instant(value:unknown):string{need(value instanceof Date||typeof value==='string','stored timestamp');const at=new Date(value);need(Number.isSafeInteger(+at),'finite timestamp');return at.toISOString();}
function key(value:unknown):boolean{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value;}catch{return false;}}
type Segment={id:string;mine_id:string;base_id:string;wallet:string|null;admission_id:string|null;ownership_status:string;source_key:string;anchor_at:string;starts_at:string;ends_at:string;quota:string;first_unit:string;last_unit:string;gross:string;buffer:string;reserved:string;issued:string;discarded:string;resolved:string;recovery_parent_id:string|null;production_clock?:MineProductionClock};
function original(s:Segment):PhysicalMineCustodySegment{
 need(s.wallet&&key(s.wallet)&&s.admission_id===null&&s.recovery_parent_id===null,'original parent identity');
 need(s.ownership_status==='confirmed'||s.ownership_status==='custody_unresolved','original custody state');
 const first=quantity(s.first_unit),last=quantity(s.last_unit),gross=quantity(s.gross),quota=quantity(s.quota);
 need(first>0n&&last>=first&&gross===last-first+1n&&quota>0n,'original unit range');
 const anchorAt=instant(s.anchor_at),startsAt=instant(s.starts_at),endsAt=instant(s.ends_at);
 const completion=(u:bigint)=>mineUnitCompletion(BigInt(Date.parse(anchorAt)),quota,BigInt(MINE_DAY_MS),u,mineProductionRemainder(s.production_clock,BigInt(MINE_DAY_MS)));
 need(completion(first)===BigInt(Date.parse(startsAt))&&completion(last)===BigInt(Date.parse(endsAt)),'original completion');
 need(new RegExp(`^mine:${s.mine_id}:v(0|[1-9][0-9]*):u${first}${s.production_clock?':p'+s.production_clock.settlementId:''}$`).test(s.source_key),'original source key');
 return {id:s.id,mineId:s.mine_id,baseId:s.base_id,wallet:s.wallet,admissionId:null,ownershipStatus:s.ownership_status,
  sourceKey:s.source_key,anchorAt,startsAt,endsAt,quota:s.quota,firstUnit:s.first_unit,lastUnit:s.last_unit,gross:s.gross,...(s.production_clock?{productionClock:s.production_clock}:{})};
}
function custody(proof:PhysicalMineCustodyEvidence,parent:PhysicalMineCustodySegment,resolvedAt:string){
 need((proof.version===1||proof.version===2||proof.version===3)&&proof.purpose==='historical_physical_mine_custody'&&proof.sourceVerified===true
  &&proof.postingAuthorized===false&&proof.payoutAuthorized===false&&proof.operatingAdmissionAuthorized===false,'stored custody purpose');
 need(same(proof.segment,parent),'original custody source');
 const c=proof.custody,start=proof.version===1?Math.floor(Date.parse(parent.startsAt)/MINE_DAY_MS)*MINE_DAY_MS:Date.parse(parent.startsAt),
  end=proof.version===1?(Math.floor(Date.parse(parent.endsAt)/MINE_DAY_MS)+1)*MINE_DAY_MS:Date.parse(parent.endsAt)+1;
 need(c.status==='confirmed'&&c.wallet===parent.wallet&&c.baseId===parent.baseId&&c.startsAt===new Date(start).toISOString()&&c.endsAt===new Date(end).toISOString(),'whole original custody interval');
 need(hashPhysicalMineCustodyEvidence(proof)===c.evidenceSha256,'complete custody digest');
 let assetId:string|null=null,classification:'registered_free'|'deeded'|undefined;
 if(proof.version===1){
 need(Array.isArray(proof.rosters)&&proof.rosters.length===(end-start)/MINE_DAY_MS&&proof.rosters.length>0&&proof.rosters.length<=32,'complete closed days');
 for(let i=0;i<proof.rosters.length;i++){
  const r:PhysicalMineClosedDayCustodyEvidence['rosters'][number]=proof.rosters[i]!;const at=start+i*MINE_DAY_MS,day=new Date(at).toISOString().slice(0,10);
  need(r.wallet===parent.wallet&&r.day===day&&r.policyVersion===1&&Date.parse(r.observedAt)>=at+MINE_DAY_MS
   &&r.baseline.wallet===parent.wallet&&Date.parse(r.baseline.effectiveFrom)<=at
   &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(r.observedAt)&&r.observedAt<=resolvedAt.replace('Z','000Z'),'original closed roster');
  need(r.sourceUniverse==='registered-stable-bases'&&r.historicalBirth==='unknown'&&r.externalDeedOwnership==='unknown'
   &&r.eligibilityAuthorized===false&&r.replacementAuthorized===false,'roster authority scope');
  const opens=r.open.bases.filter(b=>b.id===parent.baseId),closes=r.close.bases.filter(b=>b.id===parent.baseId),slots=r.open.slots.filter(s=>s.base_id===parent.baseId),closedSlots=r.close.slots.filter(s=>s.base_id===parent.baseId);
  need(r.open.facts.sourceIdentityConsistent&&r.close.facts.sourceIdentityConsistent&&opens.length===1&&closes.length===1
   &&same(opens,closes)&&!r.continuityBrokenBaseIds.includes(parent.baseId)&&slots.length===1&&same(slots,closedSlots)
   &&slots[0]!.wallet===parent.wallet&&slots[0]!.active,'original registered custody');
  need(r.changes.every(e=>![e.beforeState,e.afterState].some(s=>s&&('id'in s?s.id:s.base_id)===parent.baseId)),'original custody event');
  const b=opens[0]!;need(b.owner_wallet===parent.wallet&&b.status==='active','original registered base');
  const free=b.land_paid_at===null&&b.deed_asset_id===null&&b.deed_mint_asset_id===null&&b.deed_minting_at===null;
  if(free){need(classification!=='deeded','original class continuity');classification='registered_free';}
  else{need(b.land_paid_at!==null&&Date.parse(b.land_paid_at)<at&&key(b.deed_asset_id)&&b.deed_minting_at===null
   &&(b.deed_mint_asset_id===null||b.deed_mint_asset_id===b.deed_asset_id)&&classification!=='registered_free'
   &&(assetId===null||assetId===b.deed_asset_id),'original deed classification');
   need(!r.open.bases.some(other=>other.id!==parent.baseId&&(other.deed_asset_id===b.deed_asset_id||other.deed_mint_asset_id===b.deed_asset_id)),'ambiguous original deed');
   classification='deeded';assetId=b.deed_asset_id;}
 }
 }else{
  need(Array.isArray(proof.rosters)&&proof.rosters.length===1&&end>start&&end-start<=32*MINE_DAY_MS,'complete original interval');
  const r=proof.version===2?validateMiningRosterIntervalEvidence(proof.rosters[0]):validateMiningRosterCheckpointIntervalEvidence(proof.rosters[0]);
  need(r.wallet===parent.wallet&&r.baseId===parent.baseId&&r.startsAt===c.startsAt&&r.endsAt===c.endsAt
   &&r.observedAt<=resolvedAt.replace('Z','000Z'),'original interval roster');
  const b=r.base,free=b.land_paid_at===null&&b.deed_asset_id===null&&b.deed_mint_asset_id===null&&b.deed_minting_at===null;
  if(free)classification='registered_free';
  else{need(b.land_paid_at!==null&&b.land_paid_at<c.startsAt.replace('Z','000Z')&&key(b.deed_asset_id)&&b.deed_minting_at===null
   &&(b.deed_mint_asset_id===null||b.deed_mint_asset_id===b.deed_asset_id),'original interval deed classification');
   classification='deeded';assetId=b.deed_asset_id;}
 }
 need(c.classification===classification&&c.assetId===assetId,'original custody classification');
 if(classification==='registered_free')need(proof.deeds===null,'free source gained deed authority');
 else{const archiveStart=proof.version===1?start:Math.floor(start/1000)*1000,archiveEnd=proof.version===1?end:Math.ceil(end/1000)*1000;
  const d=proof.deeds;need(d&&key(d.collection)&&key(d.genesisHash)&&d.targetWallet===parent.wallet&&d.startAt===new Date(archiveStart).toISOString()&&d.endAt===new Date(archiveEnd).toISOString()
   &&Number.isSafeInteger(d.throughBlockTime)&&d.throughBlockTime*1000>=archiveEnd&&d.throughBlockTime*1000<=Date.parse(resolvedAt)&&d.continuouslyHeldAssetIds.includes(assetId!)
   &&d.heldDuringIntervalAssetIds.includes(assetId!)&&d.eligibilityAuthorized===false&&d.evidence.trust==='trusted-finalized-rpc'
   &&d.evidence.addressIndexCompleteness==='configured-provider-trust','original archival deed');
  const assets=d.evidence.assets;need(Array.isArray(assets)&&Number.isSafeInteger(d.evidence.numMinted)&&d.evidence.numMinted===d.evidence.currentSize
   &&assets.length===d.evidence.numMinted&&new Set(assets.map(a=>a.assetId)).size===assets.length,'complete retained archival assets');
  const originals=assets.filter(a=>a.assetId===assetId);need(originals.length===1,'original archival asset');const a=originals[0]!;
  need(a.ownerAtStart===parent.wallet&&key(a.ownerAtHorizon)&&Number.isSafeInteger(a.mint.blockTime)&&a.mint.blockTime*1000<archiveStart,'original archival owner');
  const slot=(value:string)=>{need(/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=BigInt(Number.MAX_SAFE_INTEGER),'archival slot');return BigInt(value);};
  const signature=(value:string)=>{try{return bs58.decode(value).length===64&&bs58.encode(bs58.decode(value))===value;}catch{return false;}};
  let previousSlot=slot(a.mint.slot),previousIndex=a.mint.transactionIndex,previousTime=a.mint.blockTime,owner=a.ownerAtStart;
  need(signature(a.mint.signature)&&Number.isSafeInteger(previousIndex)&&previousIndex>=0&&previousSlot<=slot(d.throughSlot),'original archival mint');
  for(const transaction of a.transactions){const atSlot=slot(transaction.slot),index=transaction.transactionIndex;
   need(signature(transaction.signature)&&Number.isSafeInteger(index)&&index>=0&&(atSlot>previousSlot||atSlot===previousSlot&&index>previousIndex)
    &&atSlot<=slot(d.throughSlot)&&Number.isSafeInteger(transaction.blockTime)&&transaction.blockTime>=previousTime
    &&transaction.blockTime<=d.throughBlockTime&&typeof transaction.failed==='boolean'&&Array.isArray(transaction.transitions)
    &&(!transaction.failed||transaction.transitions.length===0),'archival transaction order');
   previousSlot=atSlot;previousIndex=index;previousTime=transaction.blockTime;
   if(transaction.blockTime*1000<archiveStart)continue;
   for(const move of transaction.transitions){need(key(move.from)&&key(move.to)&&move.from===owner,'archival owner continuity');
    if(transaction.blockTime*1000<archiveEnd)need(move.from===parent.wallet&&move.to===parent.wallet,'original deed left custody');owner=move.to;
   }
  }
  need(owner===a.ownerAtHorizon,'archival final owner');
 }
 return c.evidenceSha256;
}
export interface HistoricalMineTaxSource {readonly original:HistoricalMineTaxOriginal;readonly term:HistoricalShardsTermCertificate;readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false}
export async function readHistoricalMineTaxSource(db:DbOrTx,childId:string):Promise<HistoricalMineTaxSource>{
 z.uuid().parse(childId);const [child]=await db.execute<{recovery_parent_id:string|null}>(sql`select recovery_parent_id from shards_mine_segments where id=${childId}`);
 need(child?.recovery_parent_id,'recovered child required');const graph=await readPhysicalMineResolution(db,child.recovery_parent_id);need(graph,'complete resolution required');
 // SQL compares the untouched original JSONB without converting bigint values
 // through JavaScript Number. Only conserved counters may change after capture.
 const [row]=await db.execute<Segment&{original_matches:boolean;precise:boolean;no_prior_issue:boolean}>(sql`select p.*,
  ((to_jsonb(p)-ARRAY['buffer','reserved','issued','discarded','resolved'])=(r.parent_original-ARRAY['buffer','reserved','issued','discarded','resolved'])
   and r.parent_original->>'buffer'=r.parent_original->>'gross' and r.parent_original->>'reserved'='0'
   and r.parent_original->>'issued'='0' and r.parent_original->>'discarded'='0' and r.parent_original->>'resolved'='0') is true original_matches,
  (p.anchor_at=date_trunc('milliseconds',p.anchor_at) and p.starts_at=date_trunc('milliseconds',p.starts_at)
   and p.ends_at=date_trunc('milliseconds',p.ends_at) and r.verified_at=date_trunc('milliseconds',r.verified_at) and e.base_id=p.base_id) is true precise,
  (not exists(select 1 from shards_mine_deliveries where segment_id=p.id) and not exists(select 1 from shards_mine_reservations where segment_id=p.id)
   and not exists(select 1 from shards_mine_dispositions where segment_id=p.id) and not exists(select 1 from shards_tax_assessments where segment_id=p.id)) no_prior_issue
  from shards_mine_segments p join shards_mine_resolutions r on r.parent_id=p.id join shards_mine_eras e on e.mine_id=p.mine_id where p.id=${graph.parentId}`);
 need(row?.original_matches&&row.precise&&row.no_prior_issue,'unchanged wholly buffered original');
 need(row.buffer==='0'&&row.reserved==='0'&&row.issued==='0'&&row.discarded==='0'&&row.resolved===row.gross,'resolved parent conservation');
 const productionClock=await readMineProductionClock(db,graph.parentId,row.source_key);
 const parent=original({...row,...(productionClock?{production_clock:productionClock}:{})}),h=graph.header,resolvedAt=instant(h.verified_at),proof=h.custody.evidence,custodyHash=custody(proof,parent,resolvedAt);
 const {version,evidence:_proof,...outer}=h.custody;need(version===1&&same(outer,proof.custody),'stored custody wrapper');
 const children=[];
 for(const part of graph.children){const s=part.segment,t=part.certificate;
  need(s.mine_id===parent.mineId&&s.base_id===parent.baseId&&s.wallet===parent.wallet&&instant(s.anchor_at)===parent.anchorAt&&s.quota===parent.quota
   &&same(s.production_clock,parent.productionClock)&&s.admission_id===null&&s.ownership_status==='confirmed'&&s.recovery_parent_id===parent.id&&s.resolved==='0','original child scope');
  need(quantity(s.buffer)+quantity(s.reserved)+quantity(s.issued)+quantity(s.discarded)===quantity(s.gross),'child conservation');
  const stored=await readStoredExpeditionTerm(db,part.termId,part.termHash);need(stored&&same(stored.snapshot,t.snapshot),'independent original term');
  const {kind:_kind,round:_round,...domain}=t.snapshot.source;need(same(h.term_source,domain),'original term domain');
  const value={parentId:parent.id,childId:s.id,mineId:s.mine_id,baseId:s.base_id,wallet:parent.wallet,custodyHash,
   sourceKey:s.source_key,anchorAt:instant(s.anchor_at),quota:s.quota,firstUnit:s.first_unit,lastUnit:s.last_unit,gross:s.gross,
   startsAt:instant(s.starts_at),endsAt:instant(s.ends_at),resolvedAt,...(s.production_clock?{productionClock:s.production_clock}:{})};
  // The kernel independently enforces exact units and half-open term coverage.
  hashHistoricalMineTaxEvidence({...value,recoveryHash:'0'.repeat(64)},t);children.push({original:value,term:t});
 }
 const recoveryHash=createHash('sha256').update('shardkeep:physical-mine-recovery:v1\n').update(JSON.stringify(canonical({parent,custodyHash,resolvedAt,source:h.term_source,
  children:children.map(c=>({original:c.original,certificateHash:hashHistoricalShardsTermCertificate(c.term)}))}))).digest('hex');
 const selected=children.find(c=>c.original.childId===childId);need(selected,'original child missing');
 return freeze({original:{...selected.original,recoveryHash},term:selected.term,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
}
export function historicalMineTaxSource(evidence:HistoricalMineTaxSource,gross:bigint,operationKey:string,ledgerId:string){
 const o=evidence.original;
 return parseShardsTaxSource({version:1,kind:'physical_mine',key:o.sourceKey+':'+operationKey,wallet:o.wallet,baseId:o.baseId,gross,
  earning:o.startsAt===o.endsAt?{kind:'instant',at:o.startsAt}:{kind:'interval',startsAt:o.startsAt,endsAt:new Date(Date.parse(o.endsAt)+1).toISOString()},
  authority:{classification:'new_earning',decisionRef:HISTORICAL_MINE_SOURCE_DECISION,evidenceSha256:hashHistoricalMineTaxEvidence(o,evidence.term)},
  ledger:{transactionId:ledgerId,idempotencyKey:operationKey}});
}
