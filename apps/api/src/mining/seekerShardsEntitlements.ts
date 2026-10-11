/** Original-wallet SHARDS rights; no current-base, provider or issuance dependency. */
import {sql} from 'drizzle-orm';
import {SeekerShardsEntitlementQuerySchema,SeekerShardsEntitlementViewSchema,type SeekerShardsEntitlementView} from '@shardkeep/shared/seekerShardsClaimsApi';
import type {Db} from '../db/client';
import {readOriginalSeekerResourceTerm} from '../game/seekerResourceClaims';
import {readCompleteShardsTaxPool,ShardsTaxHistoryError} from './shardsTaxHistory';
import {readSeekerShardsClaim,seekerShardsClaimsEnabled} from './seekerShardsClaims';
// Operational browse bounds, never a tax/payout cap. Refresh from null to see
// terms inserted earlier in UUID order; unknown sources return no partial totals.
const MAX_SCANNED_TERMS=16,MAX_TERM_BYTES=128*1024;
export async function readSeekerShardsEntitlements(db:Db,wallet:string,query:unknown):Promise<SeekerShardsEntitlementView>{
 const {cursor=null}=SeekerShardsEntitlementQuerySchema.parse(query);
 const base=SeekerShardsEntitlementViewSchema.parse({version:1,wallet,claimsEnabled:seekerShardsClaimsEnabled(),currency:'SHARDS',status:'available',reason:null,cursor,nextCursor:null,rows:[]});
 try{return await db.transaction(async tx=>{
  const terms=await tx.execute<{term_id:string;bytes:string;snapshot_bytes:string}>(sql`select term_id,octet_length(canonical)::text bytes,octet_length(snapshot::text)::text snapshot_bytes from expedition_term_snapshots where ${cursor===null?sql`true`:sql`term_id>${cursor}::uuid`} order by term_id limit ${MAX_SCANNED_TERMS}`);
  let position:string|null=null;const rows:SeekerShardsEntitlementView['rows']=[];
  for(const entry of terms){position=entry.term_id;
   if(BigInt(entry.bytes)>BigInt(MAX_TERM_BYTES)||BigInt(entry.snapshot_bytes)>BigInt(MAX_TERM_BYTES))throw new ShardsTaxHistoryError('SOURCE_BOUNDS','term bytes');
   const term=await readOriginalSeekerResourceTerm(tx,entry.term_id),winners=term.snapshot.spots.filter(s=>s.ownerWallet!==null),owned=winners.filter(s=>s.ownerWallet===wallet);if(!owned.length)continue;
   const total=await readCompleteShardsTaxPool(tx,entry.term_id,term.hash),cumulative=total/BigInt(winners.length);
   for(const spot of owned){
    // Do not wallet-filter the head: a contradictory recipient must be held,
    // never concealed as an unclaimed spot with an inflated amount due.
    const [head]=await tx.execute<{id:string}>(sql`select id from seeker_shards_claims where term_id=${entry.term_id}::uuid and spot_id=${spot.spotId} order by cumulative_total desc limit 1`);
    const receipt=head?await readSeekerShardsClaim(tx,wallet,head.id):null;
    if(head&&(!receipt||receipt.termId!==entry.term_id||receipt.spotId!==spot.spotId))throw new ShardsTaxHistoryError('SOURCE_INTEGRITY','claim head');
    const claimed=BigInt(receipt?.cumulativeTotal??'0');if(claimed>cumulative)throw new ShardsTaxHistoryError('SOURCE_INTEGRITY','claimed share');
    if(total>0n)rows.push({termId:entry.term_id,termHash:term.hash,startsAt:term.snapshot.startsAt,endsAt:term.snapshot.endsAt,spotId:spot.spotId,winnerCount:winners.length,poolTotal:total.toString(),cumulativeTotal:cumulative.toString(),claimedTotal:claimed.toString(),dueQuantity:(cumulative-claimed).toString()});
   }
   break;
  }
  const [more]=position===null?[]:await tx.execute<{value:boolean}>(sql`select exists(select 1 from expedition_term_snapshots where term_id>${position}::uuid) value`);
  return SeekerShardsEntitlementViewSchema.parse({...base,rows:rows.sort((a,b)=>a.spotId-b.spotId),nextCursor:more?.value?position:null});
 },{isolationLevel:'repeatable read',accessMode:'read only'});}
 catch(error){return {...base,status:'unavailable',reason:error instanceof ShardsTaxHistoryError?error.reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null};}
}
