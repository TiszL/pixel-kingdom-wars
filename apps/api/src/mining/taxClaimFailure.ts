/** Owner-only immutable failed-packet proof. No whole-plan completion or retry. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import {createMiningTaxFailureVerifier,MiningTaxFailureError as ChainFailureError,type MiningTaxFailureReceipt,type MiningTaxFailureRpc} from '@shardkeep/chain/mining-tax-failure';
import type {MiningBackingTrust} from '@shardkeep/chain/mining-backing';
import type {Db,DbOrTx} from '../db/client';
import {getMiningTaxClaimSigned,type MiningTaxClaimSigned} from './taxClaimSignedStore';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'RECEIPT_UNAVAILABLE'|'RECEIPT_CONFLICT'|'BUSY'|'TIMEOUT';
export class MiningTaxClaimFailureError extends Error{constructor(readonly code:Code){super(`Mining tax failure held: ${code}`);this.name='MiningTaxClaimFailureError';}}
function fail(code:Code):never{throw new MiningTaxClaimFailureError(code);}
const P=MiningTaxClaimPreparationSchema.shape,Count=P.blockHeight,Amount=P.caps.shape.maxFeeLamports;
const keySchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey,ordinal:Count.max(1)}).strict();
export type MiningTaxClaimFailureKey=z.infer<typeof keySchema>;
export interface MiningTaxClaimFailure extends MiningTaxClaimFailureKey{claimId:string;receipt:MiningTaxFailureReceipt;verifiedAt:string;transactionFailed:true;claimFinalized:false}
const receiptSchema=z.object({version:z.literal(1),wallet:P.wallet,idempotencyKey:P.idempotencyKey,claimId:P.claimId,round:P.round,spot:P.spot,ordinal:Count.max(1),kind:z.enum(['claim','combined','setup']),
 signature:z.string().min(64).max(88),messageSha256:P.identity.shape.registryHash,signedTransactionSha256:P.identity.shape.registryHash,slot:Count,blockTime:Count,feeLamports:Amount,rentLamports:z.literal('0'),paidKeepBaseUnits:z.literal('0'),
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),genesisHash:P.identity.shape.genesisHash,programId:P.identity.shape.programId,configAddress:P.identity.shape.configAddress,reviewedDeploymentSlot:Count,reviewedProgramDataSha256:P.source.shape.reviewedProgramDataSha256,snapshotSha256:P.source.shape.snapshotSha256,snapshotSlot:Count,blockhashSlot:Count,observedAccountSlot:Count}).strict(),
 outcome:z.literal('failed'),finalityAuthenticated:z.literal(true),paymentAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict();
function key(input:unknown):MiningTaxClaimFailureKey{if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).length!==3||Reflect.ownKeys(input).some(k=>typeof k!=='string'||!['wallet','idempotencyKey','ordinal'].includes(k)))fail('INVALID_INPUT');const parsed=keySchema.safeParse(input);if(!parsed.success)fail('INVALID_INPUT');return parsed.data;}
function audit(value:unknown,verifiedAt:string,signed:MiningTaxClaimSigned,k:MiningTaxClaimFailureKey):MiningTaxClaimFailure{
 try{
  const r=receiptSchema.parse(value),a=signed.preparation,w=signed.wires.find(w=>w.ordinal===k.ordinal),s=r.source,o=a.source;
  if(!w||r.wallet!==k.wallet||r.idempotencyKey!==k.idempotencyKey||r.claimId!==a.claimId||r.ordinal!==k.ordinal||r.kind!==w.kind||r.round!==a.round||r.spot!==a.spot||r.signature!==w.signature||r.messageSha256!==w.messageSha256||r.signedTransactionSha256!==w.wireSha256)fail('RECEIPT_CONFLICT');
  if(s.genesisHash!==a.identity.genesisHash||s.programId!==a.identity.programId||s.configAddress!==a.identity.configAddress||s.reviewedDeploymentSlot!==o.reviewedDeploymentSlot||s.reviewedProgramDataSha256!==o.reviewedProgramDataSha256||s.snapshotSha256!==o.snapshotSha256||s.snapshotSlot!==o.snapshotSlot||s.blockhashSlot!==o.blockhashSlot||r.slot<=o.reviewedDeploymentSlot||r.slot<Math.max(o.snapshotSlot,o.blockhashSlot)||s.observedAccountSlot<r.slot||BigInt(r.blockTime)<BigInt(a.snapshot.unixTimestamp))fail('RECEIPT_CONFLICT');
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(verifiedAt)||!Number.isFinite(Date.parse(verifiedAt)))fail('RECEIPT_CONFLICT');
  return Object.freeze({...k,claimId:a.claimId,receipt:Object.freeze({...r,source:Object.freeze(s)}),verifiedAt,transactionFailed:true,claimFinalized:false});
 }catch{fail('RECEIPT_CONFLICT');}
}
export async function getMiningTaxClaimFailure(db:DbOrTx,input:MiningTaxClaimFailureKey):Promise<MiningTaxClaimFailure|null>{
 const k=key(input),signed=await getMiningTaxClaimSigned(db,{wallet:k.wallet,idempotencyKey:k.idempotencyKey});if(!signed)return null;
 const [row]=await db.execute<{wallet:string;claim_id:string;receipt:unknown;verified_at:string}>(sql`select wallet,claim_id,receipt,to_char(verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') verified_at from mining_tax_claim_failures where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey} and ordinal=${k.ordinal}`);
 if(!row)return null;
 const [success]=await db.execute(sql`select claim_id from mining_tax_claim_receipts where claim_id=${signed.preparation.claimId} and ordinal>=${k.ordinal}`);
 if(success||row.wallet!==k.wallet||row.claim_id!==signed.preparation.claimId)fail('RECEIPT_CONFLICT');return audit(row.receipt,row.verified_at,signed,k);
}
export function createMiningTaxClaimFailure(db:Db,options:{connect:(signal:AbortSignal)=>MiningTaxFailureRpc;trust:MiningBackingTrust;timeoutMs?:number}){
 if(!options||typeof options!=='object'||Reflect.ownKeys(options).some(k=>!['connect','trust','timeoutMs'].includes(k as string))||typeof options.connect!=='function')fail('INVALID_INPUT');
 const timeout=options.timeoutMs??MAX_TIMEOUT_MS;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 // Constructor validation and a private deep copy keep caller mutation from
 // replacing reviewed authority while any historical DB lookup is awaited.
 createMiningTaxFailureVerifier(options.connect,options.trust);
 const connect=options.connect,t=options.trust,pk=(v:PublicKey)=>new PublicKey(v.toBytes());
 const trust:MiningBackingTrust={...t,programId:pk(t.programId),keepMint:pk(t.keepMint),reserveOwner:pk(t.reserveOwner)};
 const pending=new Map<string,Promise<MiningTaxClaimFailure>>();
 return async(input:MiningTaxClaimFailureKey):Promise<MiningTaxClaimFailure>=>{
  const k=key(input),id=`${k.wallet}:${k.idempotencyKey}:${k.ordinal}`,existing=pending.get(id);if(existing)return existing;if(pending.size>=MAX_PENDING)fail('BUSY');
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  const trackedConnect=(inner:AbortSignal):MiningTaxFailureRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const raw=connect(signal);
   const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{if(signal.aborted)return Promise.reject(new MiningTaxClaimFailureError('TIMEOUT'));let call:Promise<T>;try{call=Promise.resolve(invoke());}catch(e){call=Promise.reject(e);}outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call;};
   return {getGenesisHash:()=>track(()=>raw.getGenesisHash()),getSlot:(...a)=>track(()=>raw.getSlot(...a)),getMultipleAccountsInfoAndContext:(...a)=>track(()=>raw.getMultipleAccountsInfoAndContext(...a)),
    getTransaction:((...a:Parameters<MiningTaxFailureRpc['getTransaction']>)=>track(()=>raw.getTransaction(...a))) as MiningTaxFailureRpc['getTransaction']};
  };
  const work=(async()=>{
   const old=await getMiningTaxClaimFailure(db,k);alive();if(old)return old;
   const [authority]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_tax_claim_failures'::regclass) allowed`);alive();if(!authority?.allowed)fail('OWNER_REQUIRED');
   const lookup={wallet:k.wallet,idempotencyKey:k.idempotencyKey},signed=await getMiningTaxClaimSigned(db,lookup);alive();
   const wire=signed?.wires.find(w=>w.ordinal===k.ordinal);if(!signed||!wire)fail('NOT_SIGNED');
   const a=signed.preparation;
   const receipt=await createMiningTaxFailureVerifier(trackedConnect,trust,{timeoutMs:timeout})({preparation:a,ordinal:k.ordinal,signedTransaction:Buffer.from(wire.signedTransactionHex,'hex')});alive();
   // Bind the exact failed packet and original source before SQL;
   // this placeholder timestamp is not the durable database settlement time.
   audit(receipt,'2000-01-01T00:00:00.000000Z',signed,k);
   return db.transaction(async tx=>{
    const prior=await getMiningTaxClaimFailure(tx,k);alive();if(prior)return prior;
    await tx.execute(sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${a.claimId},${k.ordinal},${JSON.stringify(receipt)}::jsonb) on conflict(claim_id,ordinal) do nothing`);alive();
    const saved=await getMiningTaxClaimFailure(tx,k);alive();if(!saved)fail('RECEIPT_CONFLICT');return saved;
   });
  })().catch(e=>{if(e instanceof MiningTaxClaimFailureError)throw e;if(controller.signal.aborted)fail('TIMEOUT');if(e instanceof ChainFailureError)fail(e.code==='TIMEOUT'?'TIMEOUT':['UNAVAILABLE','FAILED_OBSERVATION'].includes(e.code)?'RECEIPT_UNAVAILABLE':'RECEIPT_CONFLICT');fail('RECEIPT_UNAVAILABLE');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxClaimFailureError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  pending.set(id,reply);release=()=>{if(workDone&&outstanding.size===0&&pending.get(id)===reply)pending.delete(id);};
  const finished=()=>{workDone=true;controller.abort();release();};void work.then(finished,finished);return reply;
 };
}
