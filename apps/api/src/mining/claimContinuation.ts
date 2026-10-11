/** Explicit fresh consent for a proved failed or unsigned-expired remainder.
 * Original custody survives forever; a child is never an automatic resend. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {MiningClaimContinuationSchema,MiningClaimContinuationRequestSchema,type MiningClaimContinuation} from '@shardkeep/shared/miningClaimsApi';
import type {Db,DbOrTx} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {getMiningClaimSigned} from './claimSignedStore';
import {getMiningClaimSettlement} from './claimSettlement';
import {getMiningClaimFailure} from './claimFailure';
import {miningClaimSetup,miningClaimSetupBinding,sameMiningClaimEntitlement} from './claimContinuationStore';
import {createMiningClaimPreparer,type MiningClaimPreparationSources} from './claimPreparation';
import {getMiningClaimPreparation,saveMiningClaimPreparation} from './claimPreparationStore';
import {toMiningClaimPreparationView} from './claimHttpView';
const keySchema=z.object({wallet:z.string().min(32).max(44),claimId:z.uuid()}).strict();type Key=z.infer<typeof keySchema>;
type Code='INVALID_INPUT'|'NOT_PREPARED'|'SETUP_REQUIRED'|'PARENT_SIGNED'|'REQUEST_CONFLICT'|'DISABLED'|'NOT_EXPIRED'|'SOURCE_CONFLICT'|'BUSY'|'TIMEOUT'|'STORAGE_UNAVAILABLE';
export class MiningClaimContinuationError extends Error{constructor(readonly code:Code){super(`Mining claim continuation held: ${code}`);this.name='MiningClaimContinuationError';}}
function fail(code:Code):never{throw new MiningClaimContinuationError(code);}
const count=(n:unknown):number=>{if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)fail('SOURCE_CONFLICT');return n;};
const key=(v:unknown):Key=>{const p=keySchema.safeParse(v);if(!p.success)fail('INVALID_INPUT');return p.data;};
const failureBinding=(failure:NonNullable<Awaited<ReturnType<typeof getMiningClaimFailure>>>)=>({ordinal:failure.ordinal,signature:failure.signature,slot:failure.receipt.slot,observedAccountSlot:failure.receipt.observedAccountSlot,messageSha256:failure.receipt.originalMessageSha256,wireSha256:failure.receipt.signedTransactionSha256});
export async function getMiningClaimContinuation(db:DbOrTx,value:Key,serverNow=new Date().toISOString()):Promise<MiningClaimContinuation|null>{
 const k=key(value),[row]=await db.execute<{wallet:string;parent_claim_id:string;child_claim_id:string;setup_claim_id:string;reason:'unsigned-expired'|'failed';expiry_height:string;expiry_slot:string;created_at:string}>(sql`select wallet,parent_claim_id,child_claim_id,setup_claim_id,reason,expiry_height::text,expiry_slot::text,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at from mining_claim_continuations where wallet=${k.wallet} and parent_claim_id=${k.claimId}`);
 if(!row)return null;const p=await getMiningClaimSigned(db,k),c=await getMiningClaimSigned(db,{wallet:k.wallet,claimId:row.child_claim_id});
 if(!p||!c||!sameMiningClaimEntitlement(p.preparation,c.preparation))fail('SOURCE_CONFLICT');
 const setup=await miningClaimSetup(db,p);if(!setup||setup.claimId!==row.setup_claim_id)fail('SOURCE_CONFLICT');
 // The immutable reason describes evidence at creation. A later retained parent
 // wire/failure remains its own outcome and cannot erase an existing child.
 const ordinal=p.preparation.transactions.length-1,failure=row.reason==='failed'?await getMiningClaimFailure(db,{...k,ordinal}):null;
 if(row.reason==='failed'&&!failure)fail('SOURCE_CONFLICT');
 try{return MiningClaimContinuationSchema.parse({version:1,wallet:k.wallet,parentClaimId:k.claimId,childClaimId:c.preparation.claimId,reason:row.reason,parentPreparation:toMiningClaimPreparationView(p.preparation,serverNow),setup:miningClaimSetupBinding(setup),failure:failure?failureBinding(failure):null,childPreparation:toMiningClaimPreparationView(c.preparation,serverNow),expiry:{blockHeight:count(Number(row.expiry_height)),slot:count(Number(row.expiry_slot))},createdAt:row.created_at,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false});}catch{fail('SOURCE_CONFLICT');}
}
async function parent(db:DbOrTx,k:Key){
 const signed=await getMiningClaimSigned(db,k);if(!signed||!signed.preparation.format)fail('NOT_PREPARED');
 const a=signed.preparation,ordinal=a.transactions.length-1;if(a.transactions[ordinal]?.kind!=='claim')fail('SETUP_REQUIRED');
 const setup=await miningClaimSetup(db,signed,true);if(!setup)fail('SETUP_REQUIRED');
 if(await getMiningClaimSettlement(db,{...k,ordinal}))fail('SOURCE_CONFLICT');
 const failure=await getMiningClaimFailure(db,{...k,ordinal});if(signed.wires.some(w=>w.ordinal===ordinal)&&!failure)fail('PARENT_SIGNED');
 return {a,setup,failure,reason:failure?'failed' as const:'unsigned-expired' as const};
}
export function createMiningClaimContinuation(db:Db,sources:MiningClaimPreparationSources){
 const ordered=sources.ordered?Object.freeze({...sources.ordered}):undefined;
 const now=sources.now??(()=>new Date()),timeout=sources.timeoutMs??30_000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30_000)fail('INVALID_INPUT');
 const prepare=createMiningClaimPreparer(db,sources),pending=new Map<string,{key:string;reply:Promise<MiningClaimContinuation>}>();
 return async(value:Key,input:unknown):Promise<MiningClaimContinuation>=>{
  const k=key(value),p=MiningClaimContinuationRequestSchema.safeParse(input);if(!p.success)fail('INVALID_INPUT');const childKey=p.data.idempotencyKey,id=`${k.wallet}:${k.claimId}`,old=pending.get(id);
  if(old){if(old.key!==childKey)fail('REQUEST_CONFLICT');return old.reply;}if(pending.size>=32)fail('BUSY');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');},active=()=>{alive();if(!phaseEMiningEnabled())fail('DISABLED');};
  const match=(saved:MiningClaimContinuation)=>{if(saved.childPreparation.idempotencyKey!==childKey)fail('REQUEST_CONFLICT');return saved;};
  const work=(async()=>{
   const previous=await getMiningClaimContinuation(db,k,now().toISOString());alive();if(previous)return match(previous);
   const original=await parent(db,k);active();const a=original.a;
   if(a.idempotencyKey===childKey||await getMiningClaimPreparation(db,{wallet:k.wallet,idempotencyKey:childKey}))fail('REQUEST_CONFLICT');
   const pin=ordered;if(!pin||pin.address!==a.format!.expectedLookupTable.address||pin.dataSha256!==a.format!.expectedLookupTable.dataSha256)fail('SOURCE_CONFLICT');
   const rpc=sources.quoteSource(controller.signal);if(await rpc.getGenesisHash()!==a.header.genesisHash)fail('SOURCE_CONFLICT');active();
   const floor=Math.max(a.snapshotSlot,a.blockhashContextSlot,original.setup.receipt.observedAccountSlot,original.failure?.receipt.observedAccountSlot??0);
   const height=count(await rpc.getBlockHeight({commitment:'finalized',minContextSlot:floor}));active();if(original.reason==='unsigned-expired'&&height<=a.lastValidBlockHeight)fail('NOT_EXPIRED');
   const slot=count(await rpc.getSlot('finalized'));active();if(slot<floor||await rpc.getGenesisHash()!==a.header.genesisHash)fail('SOURCE_CONFLICT');active();
   const child=await prepare.quoteForContinuation(k.wallet,childKey,controller.signal,slot);active();
   if(!sameMiningClaimEntitlement(a,child)||child.needsAta||child.needsMinerRecords||child.transactions.length!==1||child.transactions[0]?.kind!=='claim'||child.blockhash===a.blockhash||child.lastValidBlockHeight<height)fail('SOURCE_CONFLICT');
   const current=()=>{active();const at=now();if(!(at instanceof Date)||!Number.isFinite(+at)||+at<Date.parse(child.preparedAt)||+at>=Date.parse(child.expiresAt))fail('SOURCE_CONFLICT');};current();
   return db.transaction(async tx=>{
    await tx.execute(sql`select public.shardkeep_mining_claim_continuation_lock(${a.claimId}::uuid)`);alive();
    const prior=await getMiningClaimContinuation(tx,k,now().toISOString());alive();if(prior)return match(prior);current();
    const checked=await parent(tx,k);current();if(checked.reason!==original.reason||JSON.stringify(checked.setup)!==JSON.stringify(original.setup)||JSON.stringify(checked.failure)!==JSON.stringify(original.failure))fail('SOURCE_CONFLICT');
    if(await getMiningClaimPreparation(tx,{wallet:k.wallet,idempotencyKey:childKey}))fail('REQUEST_CONFLICT');current();
    const saved=await saveMiningClaimPreparation(tx,child);current();if(saved.claimId!==child.claimId)fail('REQUEST_CONFLICT');
    await tx.execute(sql`insert into mining_claim_continuations(parent_claim_id,child_claim_id,reason,expiry_height,expiry_slot) values(${a.claimId},${child.claimId},${original.reason},${height},${slot})`);current();
    const link=await getMiningClaimContinuation(tx,k,now().toISOString());current();if(!link)fail('SOURCE_CONFLICT');return match(link);
   });
  })().catch(error=>{if(error instanceof MiningClaimContinuationError)throw error;if(controller.signal.aborted)fail('TIMEOUT');fail('STORAGE_UNAVAILABLE');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningClaimContinuationError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer)clearTimeout(timer);});
  pending.set(id,{key:childKey,reply});void work.then(()=>{controller.abort();pending.delete(id);},()=>{controller.abort();pending.delete(id);});return reply;
 };
}
