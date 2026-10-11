/** Funded SHARDS escrow transfers to original winning spots. New earnings and
 * current source/owner substitutions are forbidden; prior receipt replay is read-only. */
import {PublicKey} from '@solana/web3.js';
import {eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import {SeekerShardsClaimRequestSchema,SeekerShardsClaimReceiptSchema,matchSeekerShardsClaimReceipt,type SeekerShardsClaimReceipt} from '@shardkeep/shared/seekerShardsClaimsApi';
import type {Db,DbOrTx} from '../db/client';
import {players} from '../db/schema';
import {phaseESeekerEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../ledger';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from '../game/stableBasePrerequisites';
import {readOriginalSeekerResourceTerm} from '../game/seekerResourceClaims';
import {readCompleteShardsTaxPool} from './shardsTaxHistory';
const uuid=z.uuid().transform(v=>v.toLowerCase());
const actor=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const fail=(code:string,message:string)=>new HttpError(409,message,code);
const integrity=()=>fail('SEEKER_SHARDS_EVIDENCE','Original SHARDS tax evidence is unavailable or inconsistent');
export const seekerShardsClaimsEnabled=phaseESeekerEnabled;
function assertAdmission(){if(!seekerShardsClaimsEnabled())throw new HttpError(503,'SHARDS tax claims are paused','PHASE_E_DISABLED');}
export async function readSeekerShardsClaim(db:DbOrTx,wallet:string,id:string):Promise<SeekerShardsClaimReceipt|null>{
 wallet=actor.parse(wallet);id=uuid.parse(id);
 const [r]=await db.execute<Record<string,unknown>>(sql`select id,wallet,base_id,term_id,term_hash,spot_id,winner_count,ledger_id,previous_id,pool_total::text,previous_total::text,cumulative_total::text,quantity::text,balance_before::text,balance_after::text,claimed_at from seeker_shards_claims where id=${id}::uuid and wallet=${wallet}`);
 if(!r)return null;
 const receipt=SeekerShardsClaimReceiptSchema.parse({id:r.id,idempotencyKey:r.id,wallet:r.wallet,baseId:r.base_id,termId:r.term_id,termHash:r.term_hash,spotId:r.spot_id,winnerCount:r.winner_count,ledgerTransactionId:r.ledger_id,poolTotal:r.pool_total,previousTotal:r.previous_total,cumulativeTotal:r.cumulative_total,quantity:r.quantity,balanceBefore:r.balance_before,balanceAfter:r.balance_after,claimedAt:new Date(r.claimed_at as Date|string).toISOString(),currency:'SHARDS'});
 const term=await readOriginalSeekerResourceTerm(db,receipt.termId),winners=term.snapshot.spots.filter(s=>s.ownerWallet!==null);
 if(term.hash!==receipt.termHash||winners.length!==receipt.winnerCount||!winners.some(s=>s.spotId===receipt.spotId&&s.ownerWallet===wallet))throw integrity();
 if(r.previous_id===null){if(receipt.previousTotal!=='0')throw integrity();}
 else{const [prior]=await db.execute<{wallet:string;term_id:string;spot_id:number;cumulative_total:string}>(sql`select wallet,term_id,spot_id,cumulative_total::text from seeker_shards_claims where id=${String(r.previous_id)}::uuid`);if(!prior||prior.wallet!==wallet||prior.term_id!==receipt.termId||prior.spot_id!==receipt.spotId||prior.cumulative_total!==receipt.previousTotal)throw integrity();}
 const [posting]=await db.execute<{type:string;idempotency_key:string;metadata:unknown;created_at:Date}>(sql`select type,idempotency_key,metadata,created_at from ledger_transactions where id=${receipt.ledgerTransactionId}::uuid`);
 const expected={wallet,baseId:receipt.baseId,termId:receipt.termId,spotId:receipt.spotId};
 if(!posting||posting.type!=='seeker.shards.claim'||posting.idempotency_key!=='seeker.shards.claim:'+id||new Date(posting.created_at).toISOString()!==receipt.claimedAt||JSON.stringify(Object.entries(posting.metadata as object).sort())!==JSON.stringify(Object.entries(expected).sort()))throw integrity();
 const entries=await db.execute<{kind:string;currency:string;owner_wallet:string|null;base_id:string|null;delta:string;balance_after:string}>(sql`select a.kind,a.currency,a.owner_wallet,a.base_id,e.delta::text,e.balance_after::text from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${receipt.ledgerTransactionId}::uuid order by a.kind`);
 const [base,escrow]=entries;
 if(entries.length!==2||base?.kind!=='base_shards'||base.base_id!==receipt.baseId||base.owner_wallet!==null||base.currency!=='SHARDS'||base.delta!==receipt.quantity||base.balance_after!==receipt.balanceAfter||escrow?.kind!=='shards_tax_escrow'||escrow.base_id!==null||escrow.owner_wallet!==null||escrow.currency!=='SHARDS'||escrow.delta!=='-'+receipt.quantity)throw integrity();
 return Object.freeze(receipt);
}
export async function claimSeekerShardsTax(db:Db,wallet:string,raw:unknown,authority:StableBaseMutationContext,deps:{assertAdmission?:()=>void}={}):Promise<SeekerShardsClaimReceipt>{
 wallet=actor.parse(wallet);const input=SeekerShardsClaimRequestSchema.parse(raw),admit=deps.assertAdmission??assertAdmission;
 const prior=await readSeekerShardsClaim(db,wallet,input.idempotencyKey);
 const match=(r:SeekerShardsClaimReceipt)=>{try{return matchSeekerShardsClaimReceipt(r,wallet,input);}catch{throw fail('IDEMPOTENCY_BODY_MISMATCH','This key belongs to another original SHARDS claim');}};
 if(prior)return match(prior);admit();
 if(authority.baseId!==input.baseId)throw fail('BASE_NOT_OWNED','Claim destination does not match its authority');
 return db.transaction(async tx=>{
  const [mode]=await tx.execute<{isolation:string}>(sql`select current_setting('transaction_isolation') isolation`);if(mode?.isolation!=='read committed')throw integrity();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'seeker-shards-request:'+input.idempotencyKey},0))`);
  const old=await readSeekerShardsClaim(tx,wallet,input.idempotencyKey);if(old)return match(old);admit();
  const [player]=await tx.select({wallet:players.wallet}).from(players).where(eq(players.wallet,wallet)).for('update');if(!player)throw new HttpError(404,'player not found');
  await lockStablePrerequisiteBase(tx,wallet,authority);admit();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'seeker-shards:'+input.termId},0))`);
  const term=await readOriginalSeekerResourceTerm(tx,input.termId),winners=term.snapshot.spots.filter(s=>s.ownerWallet!==null);
  if(!winners.some(s=>s.spotId===input.spotId&&s.ownerWallet===wallet))throw fail('SEEKER_SHARDS_NOT_OWNER','This wallet did not win the original spot');
  const total=await readCompleteShardsTaxPool(tx,input.termId,term.hash);
  const [head]=await tx.execute<{id:string}>(sql`select id from seeker_shards_claims where term_id=${input.termId}::uuid and spot_id=${input.spotId} order by cumulative_total desc limit 1`);
  const previousReceipt=head?await readSeekerShardsClaim(tx,wallet,head.id):null;if(head&&!previousReceipt)throw integrity();
  const previous=BigInt(previousReceipt?.cumulativeTotal??'0'),cumulative=total/BigInt(winners.length),quantity=cumulative-previous;
  if(quantity<=0n)throw fail('SEEKER_SHARDS_NOTHING_DUE','No additional whole SHARDS share is currently due');
  const systems=await bootstrapSystemAccounts(tx),base=await getOrCreateBaseAccount(tx,input.baseId,'base_shards');admit();
  const posted=await postTransaction(tx,{idempotencyKey:'seeker.shards.claim:'+input.idempotencyKey,type:'seeker.shards.claim',entries:[{account:systems.shards_tax_escrow,delta:-quantity},{account:base.id,delta:quantity}],metadata:{wallet,baseId:input.baseId,termId:input.termId,spotId:input.spotId}});
  if(posted.duplicate)throw integrity();admit();
  await tx.execute(sql`insert into seeker_shards_claims(id,wallet,base_id,term_id,spot_id,expected_pool,expected_previous,ledger_id) values(${input.idempotencyKey}::uuid,${wallet},${input.baseId}::uuid,${input.termId}::uuid,${input.spotId},${total.toString()}::bigint,${previous.toString()}::bigint,${posted.transaction.id}::uuid)`);
  const result=await readSeekerShardsClaim(tx,wallet,input.idempotencyKey);if(!result)throw integrity();return match(result);
 }).catch(error=>{
  const cause=error instanceof Error?(error.cause instanceof Error?error.cause.message:error.message):'';
  for(const code of ['SEEKER_SHARDS_SOURCE_CHANGED','SEEKER_SHARDS_CURSOR_CHANGED'])
   if(cause===code)throw fail(code,'Original SHARDS rights changed; retry the same request');
  throw error;
 });
}
