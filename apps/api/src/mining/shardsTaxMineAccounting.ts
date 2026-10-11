/** Original Mine quantity custody and atomic issuance. Reserve/restore/discard
 * never mints or taxes. A tax liability exists only beside its funded ledger leg. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {phaseEMiningEnabled} from '../config';
import type {DbOrTx} from '../db/client';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import {evaluateShardsTaxAttribution,replayShardsTaxAttribution,SHARDS_TAX_LINEAGE,type ShardsTaxAttributionReceipt,type ShardsTaxCarry} from './shardsTaxAttribution';
import {assertPhysicalMineTaxBuffer,hasPhysicalMineTaxEra,physicalMineSourceHash,lockPhysicalMineTaxActors} from './shardsTaxMineSources';
import {assertMineTaxTermPrefix} from './shardsTaxMineOrder';
import {readHistoricalMineTaxSource,historicalMineTaxSource,type HistoricalMineTaxSource} from './shardsTaxMineRecoveryHistory';
import {attributeHistoricalMineTax,replayHistoricalMineTax,type HistoricalMineTaxReceipt} from './shardsTaxMineHistoricalAttribution';
import type {PostedTransaction,EntryInput} from '../ledger';
const need=(v:unknown,message:string):void=>{if(!v)throw Error(`SHARDS Mine accounting held: ${message}`);};
const encode=(v:unknown)=>JSON.stringify(v,(_k,x)=>typeof x==='bigint'?x.toString():x);
type Segment={id:string;mine_id:string;base_id:string;admission_id:string|null;recovery_parent_id:string|null;wallet:string|null;source_key:string;starts_at:Date;ends_at:Date;quota:string;gross:string;buffer:string;reserved:string};
export async function reservePhysicalMineTaxSegments(tx:DbOrTx,raidId:string,mineId:string,gross:bigint){
 if(!await hasPhysicalMineTaxEra(tx,mineId)){need(!phaseEMiningEnabled()||gross===0n,'source admission required for Mine reservation');return;}await assertPhysicalMineTaxBuffer(tx,mineId,gross);
 await tx.execute(sql`insert into shards_mine_raid_eras(raid_id,mine_id,gross) values(${raidId},${mineId},${gross.toString()})`);
 const segments=await tx.execute<Segment>(sql`select * from shards_mine_segments where mine_id=${mineId} and buffer>0 order by starts_at,id for update`);
 for(const s of segments){const amount=BigInt(s.buffer);await tx.execute(sql`insert into shards_mine_reservations(raid_id,segment_id,gross) values(${raidId},${s.id},${amount.toString()})`);await tx.execute(sql`update shards_mine_segments set reserved=reserved+buffer,buffer=0 where id=${s.id}`);}
}
export async function restorePhysicalMineTaxSegments(tx:DbOrTx,raidId:string,mineId:string,award:boolean,oldBuffer:bigint,capacity:bigint,at:Date){
 const [managed]=await tx.execute<{mine_id:string;gross:string}>(sql`select mine_id,gross::text from shards_mine_raid_eras where raid_id=${raidId} and mine_id=${mineId}`);if(!managed||BigInt(managed.gross)===0n)return;
 await assertPhysicalMineTaxBuffer(tx,mineId,oldBuffer);
 // The existing capacity rule can discard unminted old buffer as well as the
 // returning portion. Preserve both as explicit source dispositions.
 let room=capacity>oldBuffer?capacity-oldBuffer:0n,excess=oldBuffer>capacity?oldBuffer-capacity:0n;
 if(!award&&excess){const rows=await tx.execute<Segment>(sql`select * from shards_mine_segments where mine_id=${mineId} and buffer>0 order by starts_at desc,id desc for update`);for(const s of rows){const n=BigInt(s.buffer)<excess?BigInt(s.buffer):excess;if(!n)break;await tx.execute(sql`insert into shards_mine_dispositions(operation_key,segment_id,kind,gross,at) values(${`raid:${raidId}:existing-cap`},${s.id},'capacity_discard',${n.toString()},${at.toISOString()})`);await tx.execute(sql`update shards_mine_segments set buffer=buffer-${n.toString()},discarded=discarded+${n.toString()} where id=${s.id}`);excess-=n;}}
 const rows=await tx.execute<{segment_id:string;gross:string;restored:string|null}>(sql`select r.segment_id,r.gross::text,r.restored::text from shards_mine_reservations r join shards_mine_segments s on s.id=r.segment_id where r.raid_id=${raidId} and s.mine_id=${mineId} order by s.starts_at,s.id for update of r,s`);
 for(const r of rows){need(r.restored===null,'reservation already terminal');const gross=BigInt(r.gross),restored=award?0n:(gross<room?gross:room),awarded=award?gross:0n,discarded=gross-restored-awarded;room-=restored;
  await tx.execute(sql`update shards_mine_reservations set restored=${restored.toString()},awarded=${awarded.toString()},discarded=${discarded.toString()} where raid_id=${raidId} and segment_id=${r.segment_id}`);
  await tx.execute(sql`update shards_mine_segments set reserved=reserved-${(restored+discarded).toString()},buffer=buffer+${restored.toString()},discarded=discarded+${discarded.toString()} where id=${r.segment_id}`);
  if(discarded)await tx.execute(sql`insert into shards_mine_dispositions(operation_key,segment_id,kind,gross,at) values(${`raid:${raidId}:return-cap`},${r.segment_id},'capacity_discard',${discarded.toString()},${at.toISOString()})`);
 }
}
interface Part {segment:Segment;gross:bigint;net:bigint;tax:bigint;from:'buffer'|'reserved';receipt:ShardsTaxAttributionReceipt|HistoricalMineTaxReceipt|null;historical?:HistoricalMineTaxSource}
export interface MineTaxIssuePlan{operationKey:string;destinationBaseId:string;gross:bigint;net:bigint;tax:bigint;parts:Part[]}
export async function lockPhysicalMineTaxWallets(tx:DbOrTx,baseId:string,currentWallet:string){
 const rows=await tx.execute<{wallet:string}>(sql`select distinct wallet from shards_mine_segments where base_id=${baseId} and wallet is not null and buffer>0`);
 await lockPhysicalMineTaxActors(tx,[currentWallet,...rows.map(r=>r.wallet)]);
}
async function plan(tx:DbOrTx,operationKey:string,destinationBaseId:string,parts:Array<{segment:Segment;gross:bigint;from:'buffer'|'reserved';operationKey?:string}>,unmanaged=0n,captured:ReadonlyMap<string,Date>=new Map()):Promise<MineTaxIssuePlan>{
 const wallets=[...new Set(parts.flatMap(p=>p.segment.wallet?[p.segment.wallet]:[]))].sort();
 await lockPhysicalMineTaxActors(tx,wallets);
 parts.sort((a,b)=>+new Date(a.segment.starts_at)-+new Date(b.segment.starts_at)||a.segment.id.localeCompare(b.segment.id));
 const issuing=new Map(parts.map(p=>[p.segment.id,p.gross]));
 const termFloors=new Map<string,{term_id:string;term_hash:string}>();
 const carries=new Map<string,ShardsTaxCarry>();for(const wallet of wallets){const [r]=await tx.execute<{wallet_sequence:string;carry_after:string}>(sql`select wallet_sequence::text,carry_after::text from shards_tax_all_assessments where wallet=${wallet} and lineage=${SHARDS_TAX_LINEAGE} order by wallet_sequence desc limit 1`);carries.set(wallet,{wallet,currency:'SHARDS',lineage:SHARDS_TAX_LINEAGE,sequence:r?BigInt(r.wallet_sequence):0n,value:r?BigInt(r.carry_after):0n});}
 let gross=unmanaged,net=unmanaged,tax=0n;const result:Part[]=[];
 for(const part of parts){const s=part.segment,key=part.operationKey??operationKey;let receipt:ShardsTaxAttributionReceipt|HistoricalMineTaxReceipt|null=null,historical:HistoricalMineTaxSource|undefined,n=part.gross,t=0n;
  need(!s.wallet||s.admission_id||s.recovery_parent_id,'unresolved original earning term');
  if(s.admission_id){need(s.wallet,'original wallet');const [a]=await tx.execute<{wallet:string;term_id:string;term_hash:string;observation:unknown}>(sql`select wallet,term_id,term_hash,observation from shards_mine_admissions where id=${s.admission_id}`);need(a&&a.wallet===s.wallet,'original admission');
   await assertMineTaxTermPrefix(tx,s.wallet!,a!.term_id,a!.term_hash,issuing,captured,termFloors.get(s.wallet!));
   termFloors.set(s.wallet!,{term_id:a!.term_id,term_hash:a!.term_hash});
   const source={version:1,kind:'physical_mine',key:s.source_key+':'+key,wallet:s.wallet!,baseId:s.base_id,gross:part.gross,earning:new Date(s.starts_at).getTime()===new Date(s.ends_at).getTime()?{kind:'instant',at:new Date(s.starts_at).toISOString()}:{kind:'interval',startsAt:new Date(s.starts_at).toISOString(),endsAt:new Date(new Date(s.ends_at).getTime()+1).toISOString()},authority:{classification:'new_earning',decisionRef:'physical-mine-source-v1',evidenceSha256:physicalMineSourceHash({id:s.id,admissionId:s.admission_id,mineId:s.mine_id,quota:String(s.quota),startsAt:new Date(s.starts_at).toISOString(),endsAt:new Date(s.ends_at).toISOString(),gross:String(s.gross)})},ledger:{transactionId:randomUUID(),idempotencyKey:key}};
   const evaluated=evaluateShardsTaxAttribution({source,term:a!.observation,carry:carries.get(s.wallet!)});need(evaluated.status==='attributed','original attribution');if(evaluated.status!=='attributed')throw Error('unavailable original attribution');receipt=evaluated.receipt;need(receipt.termHash===a!.term_hash&&receipt.pool.termId===a!.term_id,'original term identity');n=receipt.net;t=receipt.tax;carries.set(s.wallet!,receipt.carryAfter);
  }else if(s.wallet){
   historical=await readHistoricalMineTaxSource(tx,s.id);const term=historical.term;
   need(historical.original.wallet===s.wallet&&historical.original.baseId===s.base_id,'historical original actor');
   await assertMineTaxTermPrefix(tx,s.wallet,term.snapshot.termId,term.termHash,issuing,captured,termFloors.get(s.wallet));
   termFloors.set(s.wallet,{term_id:term.snapshot.termId,term_hash:term.termHash});
   receipt=attributeHistoricalMineTax({source:historicalMineTaxSource(historical,part.gross,key,randomUUID()),original:historical.original,term,carry:carries.get(s.wallet)});
   n=receipt.net;t=receipt.tax;carries.set(s.wallet,receipt.carryAfter);
  }
  result.push({...part,net:n,tax:t,receipt,...(historical?{historical}:{})});gross+=part.gross;net+=n;tax+=t;need(gross<=RAW_RESOURCE_STORAGE_MAX&&net<=RAW_RESOURCE_STORAGE_MAX&&tax<=RAW_RESOURCE_STORAGE_MAX,'issuance overflow');
 }
 return {operationKey,destinationBaseId,gross,net,tax,parts:result};
}
export async function planPhysicalMineCollections(tx:DbOrTx,mines:ReadonlyArray<{mineId:string;amount:bigint;operationKey:string}>,destinationBaseId:string,at:Date){
 const parts:Array<{segment:Segment;gross:bigint;from:'buffer';operationKey:string}>=[],managed:typeof mines[number][]=[];
 for(const mine of mines){if(!await hasPhysicalMineTaxEra(tx,mine.mineId))continue;await assertPhysicalMineTaxBuffer(tx,mine.mineId,mine.amount);managed.push(mine);
  const rows=await tx.execute<Segment>(sql`select * from shards_mine_segments where mine_id=${mine.mineId} and buffer>0 order by starts_at,id for update`);
  parts.push(...rows.map(segment=>({segment,gross:BigInt(segment.buffer),from:'buffer' as const,operationKey:mine.operationKey})));
 }
 const all=await plan(tx,'unused-batch-key',destinationBaseId,parts,0n,new Map(managed.map(m=>[m.mineId,at])));
 return new Map(managed.map(m=>{const selected=all.parts.filter(p=>p.segment.mine_id===m.mineId);return [m.mineId,{operationKey:m.operationKey,destinationBaseId,gross:selected.reduce((n,p)=>n+p.gross,0n),net:selected.reduce((n,p)=>n+p.net,0n),tax:selected.reduce((n,p)=>n+p.tax,0n),parts:selected} satisfies MineTaxIssuePlan];}));
}
export async function planPhysicalMineRaidIssue(tx:DbOrTx,raidId:string,amount:bigint,destinationBaseId:string,operationKey:string){
 const missing=await tx.execute(sql`select r.mine_building_id from raid_mine_loot_reservations r join shards_mine_eras e on e.mine_id=r.mine_building_id join raid_loot_reservations p on p.raid_id=r.raid_id left join shards_mine_raid_eras m on m.raid_id=r.raid_id and m.mine_id=r.mine_building_id where r.raid_id=${raidId} and m.mine_id is null`);need(!missing.length,'missing original raid source marker');
 const markers=await tx.execute<{mine_id:string;gross:string;awarded_shards:string}>(sql`select e.mine_id,e.gross::text,r.awarded_shards::text from shards_mine_raid_eras e join raid_mine_loot_reservations r on r.raid_id=e.raid_id and r.mine_building_id=e.mine_id where e.raid_id=${raidId}`);if(!markers.length)return null;
 const rows=await tx.execute<Segment&{award:string}>(sql`select s.*,r.awarded::text award from shards_mine_reservations r join shards_mine_segments s on s.id=r.segment_id where r.raid_id=${raidId} and r.awarded>0 order by s.starts_at,s.id for update of s`);
 const managed=markers.reduce((sum,r)=>sum+BigInt(r.awarded_shards),0n),parts=rows.map(segment=>({segment,gross:BigInt(segment.award),from:'reserved' as const}));need(parts.reduce((sum,p)=>sum+p.gross,0n)===managed&&managed<=amount,'raid source partitions');
 return plan(tx,operationKey,destinationBaseId,parts,amount-managed);
}
function entriesEqual(a:EntryInput[],b:PostedTransaction['entries']){const sums=(entries:Array<{account:string;delta:bigint}>)=>{const map=new Map<string,bigint>();for(const e of entries)map.set(e.account,(map.get(e.account)??0n)+e.delta);return [...map].sort(([x],[y])=>x.localeCompare(y)).map(([id,n])=>[id,n.toString()]);};return JSON.stringify(sums(a))===JSON.stringify(sums(b.map(e=>({account:e.accountId,delta:e.delta}))));}
export async function finishPhysicalMineIssue(tx:DbOrTx,p:MineTaxIssuePlan,posted:PostedTransaction,entries:EntryInput[],type:string){
 need(posted.transaction.idempotencyKey===p.operationKey&&posted.transaction.type===type&&entriesEqual(entries,posted.entries),'exact original ledger posting');
 // A duplicate posting without these same committed source receipts is not
 // permission to charge mutable carry again or adopt an unrelated old credit.
 const old=await tx.execute<{segment_id:string;gross:string;net:string;tax:string;ledger_id:string;destination_base_id:string}>(sql`select segment_id,gross::text,net::text,tax::text,ledger_id,destination_base_id from shards_mine_deliveries where operation_key=${p.operationKey}`);
 if(old.length){need(posted.duplicate&&old.length===p.parts.length&&p.parts.every(part=>old.some(r=>r.segment_id===part.segment.id&&BigInt(r.gross)===part.gross&&BigInt(r.net)===part.net&&BigInt(r.tax)===part.tax&&r.ledger_id===posted.transaction.id&&r.destination_base_id===p.destinationBaseId)),'original source replay');return;}
 need(!posted.duplicate,'unattributed old ledger posting');
 for(const part of p.parts){const s=part.segment;await tx.execute(sql`insert into shards_mine_deliveries(operation_key,segment_id,destination_base_id,gross,net,tax,ledger_id) values(${p.operationKey},${s.id},${p.destinationBaseId},${part.gross.toString()},${part.net.toString()},${part.tax.toString()},${posted.transaction.id})`);
  if(part.receipt){const receipt={...part.receipt,source:{...part.receipt.source,ledger:{transactionId:posted.transaction.id,idempotencyKey:p.operationKey}}};if(receipt.version===2){need(part.historical,'missing historical original');const h=part.historical!;replayHistoricalMineTax(receipt,historicalMineTaxSource(h,part.gross,p.operationKey,posted.transaction.id),h.original,h.term);}else replayShardsTaxAttribution(receipt,receipt.source);await tx.execute(sql`insert into shards_tax_assessments(operation_key,segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt) values(${p.operationKey},${s.id},${s.wallet!},${receipt.carryAfter.sequence.toString()},${SHARDS_TAX_LINEAGE},${part.gross.toString()},${part.net.toString()},${part.tax.toString()},${receipt.carryBefore.value.toString()},${receipt.carryAfter.value.toString()},${receipt.pool.termId},${receipt.termHash},${posted.transaction.id},${encode(receipt)}::jsonb)`);}
  const available=part.from==='buffer'?sql`buffer`:sql`reserved`;await tx.execute(sql`update shards_mine_segments set ${available}=${available}-${part.gross.toString()},issued=issued+${part.gross.toString()} where id=${s.id}`);
 }
}

/** Historical display uses original committed deliveries, never current carry. */
export async function readPhysicalMineRaidNet(tx:DbOrTx,raidId:string,gross:bigint){
 const [r]=await tx.execute<{tax:string;gross:string}>(sql`select coalesce(sum(tax),0)::text tax,coalesce(sum(gross),0)::text gross from shards_mine_deliveries where operation_key=${'raid:'+raidId+':loot-terminal'}`);
 const [original]=await tx.execute<{gross:string}>(sql`select coalesce(sum(r.awarded_shards),0)::text gross from shards_mine_raid_eras e join raid_mine_loot_reservations r on r.raid_id=e.raid_id and r.mine_building_id=e.mine_id where e.raid_id=${raidId}`);
 const tax=BigInt(r!.tax);need(tax<=gross&&BigInt(r!.gross)===BigInt(original!.gross),'historical raid delivery');return gross-tax;
}
