/** Bounded, read-only original Mine/cache tax evidence. This authenticates stored
 * source/ledger consistency, never current custody, chain finality or a payout.
 * The first assessment SELECT fixes the returned pool prefix. Concurrent source
 * posts may grow it; immutable dependencies cannot change that prefix. A claim
 * service must separately serialize its cumulative entitlement and ledger post. */
import {sql} from 'drizzle-orm';
import {readHistoricalMineTaxSource,historicalMineTaxSource,type HistoricalMineTaxSource} from './shardsTaxMineRecoveryHistory';
import {replayHistoricalMineTax,type HistoricalMineTaxReceipt} from './shardsTaxMineHistoricalAttribution';
import {z} from 'zod';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import type {DbOrTx} from '../db/client';
import {MINE_DAY_MS} from '../game/baseMining';
import {readStoredExpeditionTerm,type StoredExpeditionTerm} from '../game/expeditionTermStore';
import {parseExpeditionTermObservation,type ExpeditionTermObservation} from '../game/expeditionTerms';
import {shardsCacheSource} from './shardsTaxCacheSource';
import {physicalMineSourceHash} from './shardsTaxMineSources';
import {replayShardsTaxAttribution,SHARDS_TAX_LINEAGE,type ShardsTaxAttributionReceipt} from './shardsTaxAttribution';

// Work limits, not game economics. Callers may tighten, never lift these bounds.
const LIMITS=Object.freeze({maxAssessments:256,maxOperations:128,maxDeliveries:512,maxLedgerEntries:1024,maxWallets:64});
export type ShardsTaxHistoryBudget=Partial<{[K in keyof typeof LIMITS]:number}>;
export class ShardsTaxHistoryError extends Error {
 constructor(readonly reason:'SOURCE_BOUNDS'|'SOURCE_INTEGRITY',message:string){super(`SHARDS tax history held: ${message}`);}
}
function need(v:unknown,message:string):asserts v{if(!v)throw new ShardsTaxHistoryError('SOURCE_INTEGRITY',message);}
function bound(v:unknown):asserts v{if(!v)throw new ShardsTaxHistoryError('SOURCE_BOUNDS','bounded history limit exceeded');}
type Row=Record<string,unknown>;
function object(v:unknown):Row{need(v&&typeof v==='object'&&!Array.isArray(v),'object');return v as Row;}
function text(v:unknown):string{need(typeof v==='string','text');return v;}
function quantity(v:unknown):bigint{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v),'canonical quantity');const n=BigInt(v);need(n<=RAW_RESOURCE_STORAGE_MAX,'quantity overflow');return n;}
function signed(v:unknown):bigint{need(typeof v==='string'&&/^-?(0|[1-9][0-9]{0,18})$/.test(v)&&v!=='-0','signed quantity');const n=BigInt(v);need(n>=-RAW_RESOURCE_STORAGE_MAX&&n<=RAW_RESOURCE_STORAGE_MAX,'signed overflow');return n;}
function instant(v:unknown):string{need(v instanceof Date||typeof v==='string','instant');const at=new Date(v);need(Number.isFinite(+at),'finite instant');return at.toISOString();}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const id=(r:Row)=>`${text(r.source_kind??'physical_mine')}|${text(r.operation_key)}|${text(r.segment_id)}`;
/** JSONB encodes bigint as decimal strings. Decode only named quantity fields;
 * never recursively turn identity, signature, slot or source strings into ints. */
function decodeReceipt(v:unknown):Row{
 const r=structuredClone(object(v)),s=object(r.source),before=object(r.carryBefore),after=object(r.carryAfter),pool=object(r.pool);
 s.gross=quantity(s.gross);for(const c of [before,after]){c.sequence=quantity(c.sequence);c.value=quantity(c.value);}
 r.net=quantity(r.net);r.tax=quantity(r.tax);pool.amount=quantity(pool.amount);return r;
}
export interface ShardsTaxPoolHistory{readonly term:StoredExpeditionTerm;readonly total:bigint;readonly assessmentCount:number;readonly payoutAuthorized:false}

export async function readShardsTaxPoolHistory(db:DbOrTx,termId:string,termHash:string,budget:ShardsTaxHistoryBudget={}):Promise<ShardsTaxPoolHistory>{
 try{return await read(db,termId,termHash,budget);}catch(error){if(error instanceof ShardsTaxHistoryError)throw error;throw new ShardsTaxHistoryError('SOURCE_INTEGRITY',error instanceof Error?error.message:'original evidence unavailable');}
}
export async function readCompleteShardsTaxPool(db:DbOrTx,termId:string,termHash:string,budget:ShardsTaxHistoryBudget={}):Promise<bigint>{return (await readShardsTaxPoolHistory(db,termId,termHash,budget)).total;}
async function read(db:DbOrTx,termId:string,termHash:string,budget:ShardsTaxHistoryBudget):Promise<ShardsTaxPoolHistory>{
 z.uuid().parse(termId);z.string().regex(/^[0-9a-f]{64}$/).parse(termHash);
 const limits={...LIMITS,...budget};bound(Object.keys(budget).every(k=>k in LIMITS));for(const k of Object.keys(LIMITS) as Array<keyof typeof LIMITS>)bound(Number.isInteger(limits[k])&&limits[k]>0&&limits[k]<=LIMITS[k]);
 const term=await readStoredExpeditionTerm(db,termId,termHash);need(term,'missing original term');
 const terms=new Map<string,StoredExpeditionTerm>([[termId,term]]),assessments=new Map<string,{row:Row;receipt:ShardsTaxAttributionReceipt|HistoricalMineTaxReceipt}>(),operations=new Set<string>(),prefixes=new Map<string,bigint>(),checkedPrefixes=new Map<string,bigint>();
 const segments=new Map<string,Row>(),segmentDeliveries=new Map<string,Row[]>();let deliveryCount=0,sourceDeliveryCount=0,ledgerCount=0;
 async function storedTerm(id:string,hash:string){const old=terms.get(id);if(old){need(old.hash===hash,'term reference');return old;}const t=await readStoredExpeditionTerm(db,id,hash);need(t,'missing assessment term');terms.set(id,t);return t;}
 async function segment(segmentId:string){if(segments.has(segmentId))return segments.get(segmentId)!;const [s]=await db.execute<Row>(sql`select * from shards_mine_segments where id=${segmentId}`);need(s,'missing original segment');segments.set(segmentId,s);
  const gross=quantity(s.gross);need(gross>0n&&quantity(s.buffer)+quantity(s.reserved)+quantity(s.issued)+quantity(s.discarded)+quantity(s.resolved??'0')===gross,'source conservation');
  const ds=await db.execute<Row>(sql`select * from shards_mine_deliveries where segment_id=${segmentId} order by operation_key limit ${limits.maxDeliveries-sourceDeliveryCount+1}`);sourceDeliveryCount+=ds.length;bound(sourceDeliveryCount<=limits.maxDeliveries);segmentDeliveries.set(segmentId,ds);
  need(ds.reduce((n,d)=>n+quantity(d.gross),0n)===quantity(s.issued),'source issuance differs from deliveries');return s;
 }
 async function assessment(a:Row){const key=id(a);if(assessments.has(key))return;bound(assessments.size<limits.maxAssessments);
  const wallet=text(a.wallet);let source:unknown,observation:ExpeditionTermObservation|undefined,historical:HistoricalMineTaxSource|undefined;
  if(a.source_kind==='daily_cache'){
   const [s]=await db.execute<Row>(sql`select * from shards_cache_sources where operation_key=${text(a.operation_key)}`);need(s,'missing original cache source');
   const at=instant(s.earned_at),day=text(s.day);need(day===at.slice(0,10)&&s.operation_key===`cache.claim:${text(s.base_id)}:${day}`,'cache earning identity');
   need(Number.isSafeInteger(s.streak_days)&&Number(s.streak_days)>0&&typeof s.ever_completed_week1_before==='boolean','original cache streak');
   const original=await storedTerm(text(a.term_id),text(a.term_hash));observation=parseExpeditionTermObservation(s.observation,at);
   need(s.wallet===wallet&&s.term_id===a.term_id&&s.term_hash===a.term_hash&&s.ledger_id===a.ledger_id&&quantity(s.gross)>0n&&quantity(s.gross)===quantity(a.gross)&&same(observation.snapshot,original.snapshot),'original cache authority');
   source=shardsCacheSource({baseId:text(s.base_id),wallet,earnedAt:at,day,streakDays:Number(s.streak_days),everCompletedWeek1Before:s.ever_completed_week1_before as boolean,gross:text(s.gross)},text(s.ledger_id));
  }else{
  need(a.source_kind===undefined||a.source_kind==='physical_mine','unknown earning source');
  const s=await segment(text(a.segment_id));need(s.wallet!==null&&s.ownership_status==='confirmed','unresolved source issued');
  if(s.admission_id===null&&s.recovery_parent_id){
   historical=await readHistoricalMineTaxSource(db,text(s.id));need(historical.original.wallet===wallet&&historical.term.snapshot.termId===a.term_id&&historical.term.termHash===a.term_hash,'historical assessment authority');
   source=historicalMineTaxSource(historical,quantity(a.gross),text(a.operation_key),text(a.ledger_id));
  }else{
  need(s.admission_id!==null,'missing original source authority');
  const [admission]=await db.execute<Row>(sql`select * from shards_mine_admissions where id=${text(s.admission_id)}`);need(admission,'missing admission');
  const original=await storedTerm(text(a.term_id),text(a.term_hash));observation=parseExpeditionTermObservation(admission.observation,instant(admission.admitted_at));
  need(wallet===s.wallet&&wallet===admission.wallet&&s.base_id===admission.base_id&&Array.isArray(admission.mine_ids)&&admission.mine_ids.includes(s.mine_id),'original admission scope');
  need(admission.term_id===a.term_id&&admission.term_hash===a.term_hash&&same(observation.snapshot,original.snapshot),'original admission term');
  const first=quantity(s.first_unit),last=quantity(s.last_unit),quota=quantity(s.quota),gross=quantity(s.gross),anchor=BigInt(+new Date(instant(s.anchor_at)));
  need(first>0n&&last>=first&&last-first+1n===gross&&quota>0n,'original unit range');
  const completion=(unit:bigint)=>anchor+(unit*BigInt(MINE_DAY_MS)+quota-1n)/quota,starts=instant(s.starts_at),ends=instant(s.ends_at);
  need(completion(first)===BigInt(Date.parse(starts))&&completion(last)===BigInt(Date.parse(ends))&&starts>=instant(admission.admitted_at),'original unit completion');
  // Replacement first materializes old-rate units through its actual reanchor
  // instant, then closes the old head. A unit exactly there is valid history.
  const [closure]=await db.execute<Row>(sql`select closed_at from shards_mine_closures where admission_id=${text(s.admission_id)} and mine_id=${text(s.mine_id)}`);need(!closure||ends<=instant(closure.closed_at),'earning after source closure');
  need(new RegExp(`^mine:${text(s.mine_id)}:v(0|[1-9][0-9]*):u${first}$`).test(text(s.source_key)),'original source key');
  source={version:1,kind:'physical_mine',key:text(s.source_key)+':'+text(a.operation_key),wallet,baseId:s.base_id,gross:quantity(a.gross),earning:starts===ends?{kind:'instant',at:starts}:{kind:'interval',startsAt:starts,endsAt:new Date(Date.parse(ends)+1).toISOString()},authority:{classification:'new_earning',decisionRef:'physical-mine-source-v1',evidenceSha256:physicalMineSourceHash({id:s.id,admissionId:s.admission_id,mineId:s.mine_id,quota:String(s.quota),startsAt:starts,endsAt:ends,gross:String(s.gross)})},ledger:{transactionId:a.ledger_id,idempotencyKey:a.operation_key}};
  }
  }
  const receipt=historical?replayHistoricalMineTax(decodeReceipt(a.receipt),source,historical.original,historical.term):replayShardsTaxAttribution(decodeReceipt(a.receipt),source);
  need((historical!==undefined||same(receipt.term,observation))&&a.lineage===SHARDS_TAX_LINEAGE&&receipt.termHash===a.term_hash&&receipt.pool.termId===a.term_id,'receipt original authority');
  need(receipt.net===quantity(a.net)&&receipt.tax===quantity(a.tax)&&receipt.carryBefore.value===quantity(a.carry_before)&&receipt.carryAfter.value===quantity(a.carry_after)&&receipt.carryAfter.sequence===quantity(a.wallet_sequence),'assessment scalar mismatch');
  assessments.set(key,{row:a,receipt});const sequence=receipt.carryAfter.sequence;prefixes.set(wallet,sequence>(prefixes.get(wallet)??0n)?sequence:prefixes.get(wallet)!);bound(prefixes.size<=limits.maxWallets);
 }
 const target=await db.execute<Row>(sql`select * from shards_tax_all_assessments where term_id=${termId} order by wallet,wallet_sequence limit ${limits.maxAssessments+1}`);bound(target.length<=limits.maxAssessments);
 // Independently discover funded source obligations. Starting only from the
 // assessment table would mistake a missing/corrupt assessment for a zero pool.
 const sourceRows=await db.execute<Row>(sql`select d.operation_key,d.segment_id,a.term_id,a.term_hash from shards_mine_deliveries d join shards_mine_segments s on s.id=d.segment_id join shards_mine_admissions m on m.id=s.admission_id left join shards_tax_assessments a on a.operation_key=d.operation_key and a.segment_id=d.segment_id where m.term_id=${termId} order by d.operation_key,d.segment_id limit ${limits.maxDeliveries+1}`);bound(sourceRows.length<=limits.maxDeliveries);
 for(const row of sourceRows)need(row.term_id===termId&&row.term_hash===termHash,'missing original source assessment');
 // Discover original obligations by immutable earning time, independently of
 // assessment/certificate rows. Unrelated old terms require no new private
 // privileges; overlapping malformed or missing proof still holds this pool.
 // JSONB projection also keeps pre-recovery schema replay available.
 const recovered=await db.execute<Row>(sql`select d.operation_key,d.segment_id from shards_mine_deliveries d join shards_mine_segments s on s.id=d.segment_id where to_jsonb(s)->>'recovery_parent_id' is not null and s.starts_at<${term.snapshot.endsAt}::timestamptz and s.ends_at>=${term.snapshot.startsAt}::timestamptz order by d.operation_key,d.segment_id limit ${limits.maxDeliveries-sourceRows.length+1}`);
 bound(sourceRows.length+recovered.length<=limits.maxDeliveries);
 for(const row of recovered){const h=await readHistoricalMineTaxSource(db,text(row.segment_id));
  need(h.term.snapshot.termId===termId&&h.term.termHash===termHash,'historical source term differs');
  const [a]=await db.execute<Row>(sql`select term_id,term_hash from shards_tax_assessments where operation_key=${text(row.operation_key)} and segment_id=${text(row.segment_id)}`);
  need(a&&a.term_id===termId&&a.term_hash===termHash,'missing historical source assessment');
 }
 const cacheRows=await db.execute<Row>(sql`select a.term_id,a.term_hash from shards_cache_sources s left join shards_cache_assessments a using(operation_key) where s.term_id=${termId} order by s.operation_key limit ${limits.maxDeliveries-sourceRows.length-recovered.length+1}`);bound(sourceRows.length+recovered.length+cacheRows.length<=limits.maxDeliveries);
 for(const row of cacheRows)need(row.term_id===termId&&row.term_hash===termHash,'missing original cache assessment');
 for(const a of target){need(a.term_hash===termHash,'pool original term');await assessment(a);}
 async function ledger(transactionId:string,key:string,type:string){
  const [tx]=await db.execute<Row>(sql`select * from ledger_transactions where id=${transactionId}`);need(tx&&tx.idempotency_key===key&&tx.type===type,'original ledger operation');
  const es=await db.execute<Row>(sql`select e.delta::text,a.id,a.kind,a.currency,a.owner_wallet,a.base_id from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${transactionId} order by e.id limit ${limits.maxLedgerEntries+1}`);
  ledgerCount+=es.length;bound(ledgerCount<=limits.maxLedgerEntries);need(es.length>0&&es.every(e=>e.currency==='SHARDS'),'original ledger currency');need(es.reduce((n,e)=>n+signed(e.delta),0n)===0n,'entire ledger conservation');
  const values=new Map<string,bigint>();for(const e of es){need(e.owner_wallet===null,'unexpected wallet ledger leg');const role=`${text(e.kind)}:${e.base_id??''}`;need(!values.has(role),'duplicate ledger account leg');values.set(role,signed(e.delta));}
  return {tx,values};
 }
 function exactLegs(actual:Map<string,bigint>,expected:Map<string,bigint>){for(const [key,n] of [...expected])if(n===0n)expected.delete(key);need(actual.size===expected.size&&[...expected].every(([key,n])=>actual.get(key)===n),'exact original ledger legs');}
 async function operation(key:string){if(operations.has(key))return;bound(operations.size<limits.maxOperations);operations.add(key);
  if(key.startsWith('cache.claim:')){
   const [a]=await db.execute<Row>(sql`select * from shards_tax_all_assessments where operation_key=${key} and source_kind='daily_cache'`);need(a,'missing cache operation assessment');await assessment(a);
   const receipt=assessments.get(id(a))!.receipt,source=receipt.source;
   const {tx,values}=await ledger(text(a.ledger_id),key,'cache.claim'),metadata=object(tx.metadata);
   const [original]=await db.execute<Row>(sql`select day,streak_days from shards_cache_sources where operation_key=${key}`);need(original&&metadata.baseId===source.baseId&&metadata.day===original.day&&metadata.streakDays===original.streak_days,'cache ledger identity');
   exactLegs(values,new Map([['shard_genesis:',-source.gross],[`base_shards:${source.baseId}`,receipt.net],['shards_tax_escrow:',receipt.tax]]));return;
  }
  const ds=await db.execute<Row>(sql`select * from shards_mine_deliveries where operation_key=${key} order by segment_id limit ${limits.maxDeliveries+1}`);deliveryCount+=ds.length;bound(deliveryCount<=limits.maxDeliveries);need(ds.length>0,'missing deliveries');
  let gross=0n,tax=0n,net=0n;const first=ds[0]!,destination=text(first.destination_base_id),ledgerId=text(first.ledger_id),mineIds=new Set<string>();
  for(const d of ds){need(d.ledger_id===ledgerId&&d.destination_base_id===destination&&quantity(d.gross)>0n&&quantity(d.net)+quantity(d.tax)===quantity(d.gross),'delivery operation scalars');const s=await segment(text(d.segment_id));mineIds.add(text(s.mine_id));
   const [a]=await db.execute<Row>(sql`select * from shards_tax_assessments where operation_key=${key} and segment_id=${text(d.segment_id)}`);
   if(s.wallet===null){need(!a&&s.admission_id===null&&quantity(s.quota)===0n&&quantity(d.tax)===0n&&s.anchor_at===null&&s.first_unit===null&&s.last_unit===null,'legacy stock classification');}
   else {need(a,'missing delivery assessment');for(const field of ['gross','net','tax','ledger_id'])need(a[field]===d[field],'assessment/delivery mismatch');await assessment(a);}
   gross+=quantity(d.gross);tax+=quantity(d.tax);net+=quantity(d.net);
  }
  need(gross<=RAW_RESOURCE_STORAGE_MAX&&net+tax===gross,'operation amounts');
  if(key.startsWith('mine.collect:')){const {tx,values}=await ledger(ledgerId,key,'mine.collect'),metadata=object(tx.metadata);need(mineIds.size===1&&new RegExp(`^mine.collect:${[...mineIds][0]}:v(0|[1-9][0-9]*)$`).test(key)&&metadata.baseId===destination&&metadata.mineBuildingId===[...mineIds][0],'collection identity');for(const d of ds)need((await segment(text(d.segment_id))).base_id===destination,'collection source base');exactLegs(values,new Map([['shard_genesis:',-gross],[`base_shards:${destination}`,net],['shards_tax_escrow:',tax]]));}
  else {const match=/^raid:([0-9a-f-]{36}):loot-terminal$/.exec(key);need(match,'unknown source operation');const raidId=z.uuid().parse(match[1]),[r]=await db.execute<Row>(sql`select * from raid_loot_reservations where raid_id=${raidId}`);need(r&&r.state==='settled'&&r.terminal_ledger_txn_id===ledgerId&&r.attacker_base_id===destination,'original raid terminal');
   const mineRows=await db.execute<Row>(sql`select * from raid_mine_loot_reservations where raid_id=${raidId} limit ${limits.maxDeliveries+1}`);bound(mineRows.length<=limits.maxDeliveries);const minted=mineRows.reduce((n,m)=>n+quantity(m.awarded_shards),0n);need(minted>=gross,'raid Mine mint');
   for(const d of ds){const s=await segment(text(d.segment_id));need(s.base_id===r.defender_base_id,'raid source base');const [reservation]=await db.execute<Row>(sql`select * from shards_mine_reservations where raid_id=${raidId} and segment_id=${text(d.segment_id)}`);need(reservation&&quantity(reservation.awarded)===quantity(d.gross),'original segment award');}
   const managed=await db.execute<Row>(sql`select e.mine_id,e.gross::text,m.awarded_shards::text from shards_mine_raid_eras e join raid_mine_loot_reservations m on m.raid_id=e.raid_id and m.mine_building_id=e.mine_id where e.raid_id=${raidId} limit ${limits.maxDeliveries+1}`);bound(managed.length<=limits.maxDeliveries);need(managed.reduce((n,m)=>n+quantity(m.awarded_shards),0n)===gross,'complete managed raid deliveries');
   const liquid=quantity(r.spendable_reserved_shards),forge=quantity(r.forge_reserved_shards),escrow=liquid+forge,defender=text(r.defender_base_id);
   if(escrow){need(r.reserve_ledger_txn_id,'original reserve posting');const reserve=await ledger(text(r.reserve_ledger_txn_id),`raid:${raidId}:loot-reserve`,'raid.loot.reserve');exactLegs(reserve.values,new Map([[`base_shards:${defender}`,-liquid],[`base_forge_escrow:${defender}`,-forge],['raid_loot_escrow:',escrow]]));}
   const {tx,values}=await ledger(ledgerId,key,'raid.loot.settle'),metadata=object(tx.metadata),liquidReturn=values.get(`base_shards:${defender}`)??0n,forgeReturn=values.get(`base_forge_escrow:${defender}`)??0n;
   need(liquidReturn>=0n&&liquidReturn<=liquid&&forgeReturn>=0n&&forgeReturn<=forge,'raid transfer return');const balance=escrow-liquidReturn-forgeReturn;need(!escrow||liquid-liquidReturn===balance*liquid/escrow,'original proportional transfer');
   need(metadata.raidId===raidId&&metadata.attackerBaseId===destination&&metadata.defenderBaseId===defender&&quantity(metadata.exactPayout)===balance+minted-tax,'raid payout identity');
   exactLegs(values,new Map([['raid_loot_escrow:',-escrow],['shard_genesis:',-minted],[`base_shards:${defender}`,liquidReturn],[`base_forge_escrow:${defender}`,forgeReturn],[`base_shards:${destination}`,balance+minted-tax],['shards_tax_escrow:',tax]]));
  }
 }
 // Close over wallet prefixes and all source operation peers. Every query has
 // a row limit; no disconnected/unverified carry anchor or partial operation is
 // accepted when the graph grows past the operational work budget.
 for(;;){let progress=false;
  for(const [wallet,max] of prefixes){if((checkedPrefixes.get(wallet)??0n)>=max)continue;const rows=await db.execute<Row>(sql`select * from shards_tax_all_assessments where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} and wallet_sequence<=${max.toString()} order by wallet_sequence limit ${limits.maxAssessments+1}`);bound(rows.length<=limits.maxAssessments);need(BigInt(rows.length)===max,'missing carry prefix');let carry=0n,prior:ShardsTaxAttributionReceipt|HistoricalMineTaxReceipt|undefined;
   for(let i=0;i<rows.length;i++){const a=rows[i]!;await assessment(a);const receipt=assessments.get(id(a))!.receipt;need(receipt.carryBefore.sequence===BigInt(i)&&receipt.carryBefore.value===carry,'carry continuity');if(prior&&prior.pool.termId!==receipt.pool.termId)need(prior.term.snapshot.endsAt<=receipt.term.snapshot.startsAt,'original term order');carry=receipt.carryAfter.value;prior=receipt;}checkedPrefixes.set(wallet,max);progress=true;
  }
  for(const {row} of assessments.values())if(!operations.has(text(row.operation_key))){await operation(text(row.operation_key));progress=true;}
  for(const ds of segmentDeliveries.values())for(const d of ds)if(!operations.has(text(d.operation_key))){await operation(text(d.operation_key));progress=true;}
  if(!progress)break;
 }
 const total=target.reduce((sum,a)=>sum+assessments.get(id(a))!.receipt.tax,0n);need(total<=RAW_RESOURCE_STORAGE_MAX,'term pool overflow');
 return Object.freeze({term,total,assessmentCount:target.length,payoutAuthorized:false});
}
