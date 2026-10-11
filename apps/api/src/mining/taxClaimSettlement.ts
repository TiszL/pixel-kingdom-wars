/** Owner-only verified receipt recording. Runtime code receives only immutable
 * read recovery; setup is not payment and saved proof never grants another send. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {MiningTaxClaimRecoveryEnvelopeSchema,type MiningTaxClaimSettlementView} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import {createMiningTaxReceiptReader,MiningTaxReceiptReaderError,type MiningTaxReceiptReaderRpc} from '@shardkeep/chain/mining-tax-receipt-reader';
import type {MiningTaxSnapshotTrust} from '@shardkeep/chain/mining-tax-snapshot';
import type {Db,DbOrTx} from '../db/client';
import {getMiningTaxClaimPreparationRecord} from './taxClaimPreparationStore';
import {getMiningTaxClaimSigned,type MiningTaxClaimSigned} from './taxClaimSignedStore';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'RECEIPT_UNAVAILABLE'|'RECEIPT_CONFLICT'|'BUSY'|'TIMEOUT';
export class MiningTaxClaimSettlementError extends Error{constructor(readonly code:Code){super(`Mining tax settlement held: ${code}`);this.name='MiningTaxClaimSettlementError';}}
function fail(code:Code):never{throw new MiningTaxClaimSettlementError(code);}
const address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&PublicKey.isOnCurve(p.toBytes())&&!p.equals(PublicKey.default);}catch{return false;}});
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),keySchema=z.object({wallet:address,idempotencyKey:uuid,ordinal:z.number().int().min(0).max(1)}).strict();
export type MiningTaxClaimSettlementKey=z.infer<typeof keySchema>;
export type MiningTaxClaimSettlement=MiningTaxClaimSettlementView;
function key(input:unknown):MiningTaxClaimSettlementKey{if(!input||typeof input!=='object'||Array.isArray(input)||Reflect.ownKeys(input).length!==3||Reflect.ownKeys(input).some(k=>typeof k!=='string'||!['wallet','idempotencyKey','ordinal'].includes(k)))fail('INVALID_INPUT');const parsed=keySchema.safeParse(input);if(!parsed.success)fail('INVALID_INPUT');return parsed.data;}
function audit(receipt:unknown,settledAt:string,signed:MiningTaxClaimSigned,k:MiningTaxClaimSettlementKey):MiningTaxClaimSettlement{
 try{
  const a=signed.preparation,phase=(receipt as {phase?:unknown})?.phase;
  const envelope=MiningTaxClaimRecoveryEnvelopeSchema.parse({wallet:k.wallet,idempotencyKey:k.idempotencyKey,claimId:a.claimId,status:phase==='settled'?'settled':'setup',preparation:a,wires:signed.wires,
   settlement:{...k,claimId:a.claimId,receipt,settledAt,claimFinalized:phase==='settled'},serverNow:new Date().toISOString()});
  if(!envelope.settlement)fail('RECEIPT_CONFLICT');return envelope.settlement;
 }catch{fail('RECEIPT_CONFLICT');}
}
export async function getMiningTaxClaimSettlement(db:DbOrTx,input:MiningTaxClaimSettlementKey):Promise<MiningTaxClaimSettlement|null>{
 const k=key(input),signed=await getMiningTaxClaimSigned(db,{wallet:k.wallet,idempotencyKey:k.idempotencyKey});if(!signed)return null;
 const [row]=await db.execute<{wallet:string;claim_id:string;receipt:unknown;settled_at:string}>(sql`select wallet,claim_id,receipt,to_char(settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') settled_at from mining_tax_claim_receipts where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey} and ordinal=${k.ordinal}`);
 if(!row)return null;if(row.wallet!==k.wallet||row.claim_id!==signed.preparation.claimId)fail('RECEIPT_CONFLICT');return audit(row.receipt,row.settled_at,signed,k);
}
export function createMiningTaxClaimSettlement(db:Db,options:{connect:(signal:AbortSignal)=>MiningTaxReceiptReaderRpc;trust:MiningTaxSnapshotTrust;timeoutMs?:number}){
 if(!options||typeof options!=='object'||Reflect.ownKeys(options).some(k=>!['connect','trust','timeoutMs'].includes(k as string))||typeof options.connect!=='function')fail('INVALID_INPUT');
 const timeout=options.timeoutMs??MAX_TIMEOUT_MS;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 // Constructor validation and a private deep copy keep caller mutation from
 // replacing reviewed authority while any historical DB lookup is awaited.
 createMiningTaxReceiptReader(options.connect,options.trust);
 const connect=options.connect,m=options.trust.mining,s=options.trust.seeker,pk=(v:PublicKey)=>new PublicKey(v.toBytes());
 const trust:MiningTaxSnapshotTrust={mining:{...m,programId:pk(m.programId),keepMint:pk(m.keepMint),reserveOwner:pk(m.reserveOwner)},seeker:{...s,programId:pk(s.programId),config:pk(s.config),mint:pk(s.mint),prizeOwner:pk(s.prizeOwner),prizeAta:pk(s.prizeAta),genesisHash:pk(s.genesisHash),deployment:{...s.deployment}}};
 const pending=new Map<string,Promise<MiningTaxClaimSettlement>>();
 return async(input:MiningTaxClaimSettlementKey):Promise<MiningTaxClaimSettlement>=>{
  const k=key(input),id=`${k.wallet}:${k.idempotencyKey}:${k.ordinal}`,existing=pending.get(id);if(existing)return existing;if(pending.size>=MAX_PENDING)fail('BUSY');
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  const trackedConnect=(inner:AbortSignal):MiningTaxReceiptReaderRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const raw=connect(signal);
   const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{if(signal.aborted)return Promise.reject(new MiningTaxClaimSettlementError('TIMEOUT'));let call:Promise<T>;try{call=Promise.resolve(invoke());}catch(e){call=Promise.reject(e);}outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call;};
   return {getGenesisHash:()=>track(()=>raw.getGenesisHash()),getSlot:(...a)=>track(()=>raw.getSlot(...a)),getMultipleAccountsInfoAndContext:(...a)=>track(()=>raw.getMultipleAccountsInfoAndContext(...a)),getSignaturesForAddress:(...a)=>track(()=>raw.getSignaturesForAddress(...a)),
    getTransaction:((...a:Parameters<MiningTaxReceiptReaderRpc['getTransaction']>)=>track(()=>raw.getTransaction(...a))) as MiningTaxReceiptReaderRpc['getTransaction'],getBlock:((...a:Parameters<MiningTaxReceiptReaderRpc['getBlock']>)=>track(()=>raw.getBlock(...a))) as MiningTaxReceiptReaderRpc['getBlock']};
  };
  const work=(async()=>{
   const old=await getMiningTaxClaimSettlement(db,k);alive();if(old)return old;
   const [authority]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_tax_claim_receipts'::regclass) allowed`);alive();if(!authority?.allowed)fail('OWNER_REQUIRED');
   const lookup={wallet:k.wallet,idempotencyKey:k.idempotencyKey},signed=await getMiningTaxClaimSigned(db,lookup);alive();
   const record=await getMiningTaxClaimPreparationRecord(db,lookup);alive();
   if(!signed||!record||k.ordinal>=signed.preparation.transactions.length)fail('NOT_SIGNED');
   const wires=Array.from({length:k.ordinal+1},(_,ordinal)=>signed.wires.find(w=>w.ordinal===ordinal));if(wires.some(w=>!w))fail('NOT_SIGNED');
   const a=record.artifact,c=a.caps;
   const receipt=await createMiningTaxReceiptReader(trackedConnect,trust,{timeoutMs:timeout})({snapshot:record.snapshot,plan:{wallet:new PublicKey(a.wallet),round:BigInt(a.round),spot:a.spot,blockhash:a.blockhash},
    blockhashContextSlot:a.source.blockhashSlot,caps:{maxFeeLamports:BigInt(c.maxFeeLamports),maxRentLamports:BigInt(c.maxRentLamports),maxTotalLamports:BigInt(c.maxTotalLamports)},signedTransactions:wires.map(w=>Buffer.from(w!.signedTransactionHex,'hex'))});alive();
   // Validate the final wire/prefix, original source and paid amount before SQL;
   // this placeholder timestamp is not the durable database settlement time.
   audit(receipt,'2000-01-01T00:00:00.000000Z',signed,k);
   return db.transaction(async tx=>{
    const prior=await getMiningTaxClaimSettlement(tx,k);alive();if(prior)return prior;
    await tx.execute(sql`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${a.claimId},${k.ordinal},${JSON.stringify(receipt)}::jsonb) on conflict(claim_id,ordinal) do nothing`);alive();
    const saved=await getMiningTaxClaimSettlement(tx,k);alive();if(!saved)fail('RECEIPT_CONFLICT');return saved;
   });
  })().catch(e=>{if(e instanceof MiningTaxClaimSettlementError)throw e;if(controller.signal.aborted)fail('TIMEOUT');if(e instanceof MiningTaxReceiptReaderError)fail(e.code==='TIMEOUT'?'TIMEOUT':['UNAVAILABLE','FAILED_OBSERVATION'].includes(e.code)?'RECEIPT_UNAVAILABLE':'RECEIPT_CONFLICT');fail('RECEIPT_UNAVAILABLE');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxClaimSettlementError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  pending.set(id,reply);release=()=>{if(workDone&&outstanding.size===0&&pending.get(id)===reply)pending.delete(id);};
  const finished=()=>{workDone=true;controller.abort();release();};void work.then(finished,finished);return reply;
 };
}
