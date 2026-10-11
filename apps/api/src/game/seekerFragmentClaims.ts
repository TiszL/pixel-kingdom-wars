/** Original winning-spot Crystal Fragment rights; never a raw-resource claim. */
import {sql} from 'drizzle-orm';
import {PHASE_E_DIVINE_FRAGMENTS as P} from '@shardkeep/shared';
import {divineFragmentSeekerShare} from '@shardkeep/shared/divineFragments';
import {DivineFragmentSeekerClaimRequestSchema,DivineFragmentSeekerClaimReceiptSchema,DivineFragmentSeekerClaimEnvelopeSchema,DivineFragmentClaimablePageSchema,DivineFragmentPageQuerySchema} from '@shardkeep/shared/divineFragmentsApi';
import type {Db,DbOrTx} from '../db/client';
import {readStoredExpeditionTerm} from './expeditionTermStore';
import {assertFragmentSource,fragmentId,fragmentWallet,fragmentFail,fragmentClock,fragmentOwnedBase,fragmentLockedBase,readFragmentSettlement,type FragmentDestinationOptions} from './divineFragments';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
// Operational history bounds, never a quota or expiry of an owner's rights.
const MAX_SOURCES=2_000,MAX_SOURCE_BYTES=8*1024*1024;
export async function readFragmentPool(db:DbOrTx,termId:string){
 fragmentId.parse(termId);await assertFragmentSource(db);
 const [size]=await db.execute<{count:string;bytes:string}>(sql`select count(*)::text count,coalesce(sum(octet_length(certificate_json)+octet_length(record::text)),0)::text bytes from public.divine_fragment_settlements where term_id=${termId}::uuid`);
 if(!size||BigInt(size.count)>BigInt(MAX_SOURCES)||BigInt(size.bytes)>BigInt(MAX_SOURCE_BYTES))fragmentFail('SOURCE_BOUNDS',503);
 const ids=await db.execute<{event_id:string;term_hash:string}>(sql`select event_id,term_hash from public.divine_fragment_settlements where term_id=${termId}::uuid order by event_id limit ${MAX_SOURCES+1}`);
 if(ids.length>MAX_SOURCES)fragmentFail('SOURCE_BOUNDS',503);
 let total=0n;let term:Awaited<ReturnType<typeof readStoredExpeditionTerm>>=null;
 for(const r of ids){const original=await readFragmentSettlement(db,r.event_id);if(!original||original.term.snapshot.termId!==termId||original.term.hash!==r.term_hash)fragmentFail('SOURCE',503);
  if(term&&term.hash!==original.term.hash)fragmentFail('SOURCE',503);term=original.term;
  for(const a of original.awards)total+=BigInt(a.tax);
  if(total>RAW_RESOURCE_STORAGE_MAX)fragmentFail('SOURCE_BOUNDS',503);
 }
 return {total,term};
}
export async function readSeekerFragmentClaim(db:DbOrTx,wallet:string,id:string){
 fragmentWallet.parse(wallet);fragmentId.parse(id);await assertFragmentSource(db);
 const [row]=await db.execute<{record:unknown}>(sql`select record from public.seeker_fragment_claims where id=${id}::uuid and wallet=${wallet}`);
 if(!row)return null;const receipt=DivineFragmentSeekerClaimReceiptSchema.parse(row.record),term=await readStoredExpeditionTerm(db,receipt.termId,receipt.termHash);
 if(!term||term.snapshot.spots.filter(s=>s.ownerWallet!==null).length!==receipt.winnerCount||!term.snapshot.spots.some(s=>s.spotId===receipt.spotId&&s.ownerWallet===wallet))fragmentFail('SOURCE',503);
 return receipt;
}
export function createSeekerFragmentClaims(db:Db,options:FragmentDestinationOptions={}){
 if('rollback'in db)throw Error('DIVINE_FRAGMENT_TOP_LEVEL');const clock=fragmentClock(options);
 async function claim(wallet:string,raw:unknown){
  fragmentWallet.parse(wallet);const cmd=DivineFragmentSeekerClaimRequestSchema.parse(raw);
  const match=(r:NonNullable<Awaited<ReturnType<typeof readSeekerFragmentClaim>>>)=>{if(r.idempotencyKey!==cmd.idempotencyKey||r.baseId!==cmd.baseId||r.termId!==cmd.termId||r.spotId!==cmd.spotId)fragmentFail('IDEMPOTENCY_BODY_MISMATCH');return r;};
  const prior=await readSeekerFragmentClaim(db,wallet,cmd.idempotencyKey);if(prior)return match(prior);
  await fragmentOwnedBase(db,wallet,cmd.baseId,options);
  return db.transaction(async tx=>{
   await fragmentLockedBase(tx,wallet,cmd.baseId,options);const again=await readSeekerFragmentClaim(tx,wallet,cmd.idempotencyKey);if(again)return match(again);
   await tx.execute(sql`select term_id from public.expedition_term_snapshots where term_id=${cmd.termId}::uuid for update`);
   const pool=await readFragmentPool(tx,cmd.termId);if(!pool.term||!pool.term.snapshot.spots.some(s=>s.spotId===cmd.spotId&&s.ownerWallet===wallet))fragmentFail('SPOT_OWNER',403);
   await tx.execute(sql`insert into public.seeker_fragment_claims(id,wallet,base_id,term_id,spot_id,term_hash,quantity,cumulative_total,record,claimed_at) values(${cmd.idempotencyKey}::uuid,${wallet},${cmd.baseId}::uuid,${cmd.termId}::uuid,${cmd.spotId},null,null,null,'{}',${clock().toISOString()}::timestamptz)`);
   return match((await readSeekerFragmentClaim(tx,wallet,cmd.idempotencyKey))!);
  });
 }
 async function claimRead(wallet:string,id:string){return DivineFragmentSeekerClaimEnvelopeSchema.parse({version:P.version,wallet,idempotencyKey:id,receipt:await readSeekerFragmentClaim(db,wallet,id)});}
 async function termRows(wallet:string,termId:string){
  const {term,total}=await readFragmentPool(db,termId);if(!term)fragmentFail('TERM_NOT_FOUND',404);
  const rows=[],winners=term.snapshot.spots.filter(s=>s.ownerWallet!==null);
  if(total>0n)for(const spot of winners.filter(s=>s.ownerWallet===wallet)){
   const [head]=await db.execute<{previous:string}>(sql`select coalesce(max(cumulative_total),0)::text previous from public.seeker_fragment_claims where term_id=${termId}::uuid and spot_id=${spot.spotId}`);
   const previous=BigInt(head?.previous??'0'),share=divineFragmentSeekerShare(total,winners.length,previous);
   rows.push({termId,termHash:term.hash,startsAt:term.snapshot.startsAt,endsAt:term.snapshot.endsAt,spotId:spot.spotId,winnerCount:winners.length,poolTotal:total.toString(),previousTotal:previous.toString(),cumulativeTotal:share.cumulativeTotal.toString(),claimable:share.quantity.toString()});
  }
  return rows;
 }
 /** Exact permanent rights never depend on discovery page positions. */
 async function term(wallet:string,termId:string){
  fragmentWallet.parse(wallet);fragmentId.parse(termId);
  return DivineFragmentClaimablePageSchema.parse({version:P.version,wallet,rows:await termRows(wallet,termId),nextCursor:null});
 }
 async function terms(wallet:string,raw:unknown={}){
  fragmentWallet.parse(wallet);const {cursor}=DivineFragmentPageQuerySchema.parse(raw);await assertFragmentSource(db);
  const ids=await db.execute<{term_id:string}>(sql`select distinct term_id from public.divine_fragment_settlements where ${cursor?sql`term_id>${cursor}::uuid`:sql`true`} order by term_id limit 2`);
  const id=ids[0]?.term_id,rows=id?await termRows(wallet,id):[];
  return DivineFragmentClaimablePageSchema.parse({version:P.version,wallet,rows,nextCursor:ids.length>1?id:null});
 }
 return Object.freeze({terms,term,claim,claimRead});
}
export type SeekerFragmentProvider=ReturnType<typeof createSeekerFragmentClaims>;
