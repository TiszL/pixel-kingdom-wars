/** Original-spot tax consent only. Immutable recovery precedes new admission;
 * this service never signs, relays, settles or changes a permanent tax cursor. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {z} from 'zod';
import {sql} from 'drizzle-orm';
import {MiningTaxClaimPrepareRequestSchema,type MiningTaxClaimPrepareRequest,type MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {createMiningTaxQuoteReader,MiningTaxQuoteError,type MiningTaxQuoteRpc} from '@shardkeep/chain/mining-tax-quote';
import {MiningTaxSnapshotError,type MiningTaxSnapshotTrust} from '@shardkeep/chain/mining-tax-snapshot';
import {MiningTaxMessageError} from '@shardkeep/chain/mining-tax-message';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {createMiningTaxClaimPreparationRecord,getMiningTaxClaimPreparation,saveMiningTaxClaimPreparation,MiningTaxClaimPreparationStoreError} from './taxClaimPreparationStore';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000;
type Code='INVALID_INPUT'|'REQUEST_CONFLICT'|'DISABLED'|'BUSY'|'TIMEOUT'|'QUOTE_UNAVAILABLE'|'SOURCE_CONFLICT'|'STORAGE_UNAVAILABLE'|'CLAIM_BLOCKHASH_REUSED';
export class MiningTaxClaimPreparationError extends Error{
 constructor(readonly code:Code,readonly reason?:string){super(`Mining tax preparation refused: ${code}`);this.name='MiningTaxClaimPreparationError';}
}
function fail(code:Code):never{throw new MiningTaxClaimPreparationError(code);}
function actor(value:string):string{
 if(typeof value!=='string'||value.length<32||value.length>44)fail('INVALID_INPUT');
 try{const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default)||!PublicKey.isOnCurve(p.toBytes()))fail('INVALID_INPUT');return value;}catch{fail('INVALID_INPUT');}
}
function own(value:unknown,names:readonly string[]){
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!names.includes(k)))fail('INVALID_INPUT');
}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function copyTrust(input:MiningTaxSnapshotTrust):MiningTaxSnapshotTrust{
 try{
  // The quote reader validates the exact nested policy, including unknown keys.
  createMiningTaxQuoteReader(()=>{throw Error('Trust validation never connects');},input);
  const m=input.mining,s=input.seeker,key=(v:PublicKey)=>new PublicKey(v.toBytes());
  return {mining:{...m,programId:key(m.programId),keepMint:key(m.keepMint),reserveOwner:key(m.reserveOwner)},
   seeker:{...s,programId:key(s.programId),config:key(s.config),mint:key(s.mint),prizeOwner:key(s.prizeOwner),prizeAta:key(s.prizeAta),genesisHash:key(s.genesisHash),deployment:{...s.deployment}}};
 }catch{fail('INVALID_INPUT');}
}
const capKeys=['maxFeeLamports','maxRentLamports','maxTotalLamports'] as const;
function same(a:Pick<MiningTaxClaimPrepareRequest,'round'|'spot'|'caps'>,b:MiningTaxClaimPrepareRequest){
 return a.round===b.round&&a.spot===b.spot&&capKeys.every(k=>a.caps[k]===b.caps[k]);
}
function match(saved:MiningTaxClaimPreparation,request:MiningTaxClaimPrepareRequest){if(!same(saved,request))fail('REQUEST_CONFLICT');return freeze(saved);}
export interface MiningTaxClaimPreparationSources{
 readonly connect:(signal:AbortSignal)=>MiningTaxQuoteRpc;readonly trust:MiningTaxSnapshotTrust;readonly now?:()=>Date;readonly timeoutMs?:number;
}
export function createMiningTaxClaimPreparer(db:Db,sources:MiningTaxClaimPreparationSources){
 own(sources,['connect','trust','now','timeoutMs']);if(typeof sources.connect!=='function'||sources.now!==undefined&&typeof sources.now!=='function')fail('INVALID_INPUT');
 const connect=sources.connect,trust=copyTrust(sources.trust),now=sources.now??(()=>new Date()),timeout=sources.timeoutMs??MAX_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 const pending=new Map<string,{request:MiningTaxClaimPrepareRequest;reply:Promise<MiningTaxClaimPreparation>}>();
 async function prepareNew(wallet:string,request:MiningTaxClaimPrepareRequest,signal:AbortSignal,trackedConnect:(s:AbortSignal)=>MiningTaxQuoteRpc){
  const alive=()=>{if(signal.aborted)fail('TIMEOUT');},admitted=()=>{alive();if(!phaseEMiningEnabled())fail('DISABLED');};
  const lookup={wallet,idempotencyKey:request.idempotencyKey},old=await getMiningTaxClaimPreparation(db,lookup);alive();if(old)return match(old,request);
  admitted();const read=createMiningTaxQuoteReader(s=>trackedConnect(AbortSignal.any([s,signal])),trust,{timeoutMs:timeout});
  const quote=await read({wallet:new PublicKey(wallet),round:BigInt(request.round),spot:request.spot,
   caps:{maxFeeLamports:BigInt(request.caps.maxFeeLamports),maxRentLamports:BigInt(request.caps.maxRentLamports),maxTotalLamports:BigInt(request.caps.maxTotalLamports)}});admitted();
  const at=now();if(!(at instanceof Date)||!Number.isFinite(at.getTime()))fail('SOURCE_CONFLICT');
  const record=createMiningTaxClaimPreparationRecord(wallet,request,quote,{claimId:randomUUID(),preparedAt:new Date(at.getTime())});admitted();
  // Chain reads remain outside locks. Pause/timeout during store awaits aborts
  // this transaction; a lost reply after COMMIT recovers the original key.
  return db.transaction(async tx=>{
   const prior=await getMiningTaxClaimPreparation(tx,lookup);alive();if(prior)return match(prior,request);admitted();
   // Ed25519 signatures are deterministic: changing only the intent UUID
   // cannot make a failed message a new packet or reparent its saved signature.
   for(const packet of record.artifact.transactions){
    const [used]=await tx.execute(sql`select w.claim_id from mining_tax_claim_signed_wires w join mining_tax_claim_failures f on f.claim_id=w.claim_id and f.ordinal=w.ordinal where w.wallet=${wallet} and w.message_sha256=${packet.messageSha256} limit 1`);admitted();
    if(used)fail('CLAIM_BLOCKHASH_REUSED');
   }
   const saved=await saveMiningTaxClaimPreparation(tx,record);admitted();return match(saved,request);
  });
 }
 return {
  async prepare(authenticatedWallet:string,value:unknown):Promise<MiningTaxClaimPreparation>{
   const wallet=actor(authenticatedWallet);own(value,['idempotencyKey','round','spot','caps']);
   own((value as {caps?:unknown}).caps,capKeys);const parsed=MiningTaxClaimPrepareRequestSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');
   const request=freeze(parsed.data),key=`${wallet}:${request.idempotencyKey}`,old=pending.get(key);
   if(old){if(!same(old.request,request))fail('REQUEST_CONFLICT');return old.reply;}
   if(pending.size>=MAX_PENDING)fail('BUSY');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   const outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{};
   // Nested readers can stop waiting before a noncooperative RPC. Count the
   // concrete transport promises, retaining the outer slot until all drain.
   const trackedConnect=(signal:AbortSignal):MiningTaxQuoteRpc=>{
    signal.throwIfAborted();const rpc=connect(signal);
    function track<T>(invoke:()=>Promise<T>):Promise<T>{
     if(signal.aborted)return Promise.reject(new MiningTaxClaimPreparationError('TIMEOUT'));
     let call:Promise<T>;try{call=Promise.resolve(invoke());}catch(error){call=Promise.reject(error);}
     outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call;
    }
    return {getGenesisHash:()=>track(()=>rpc.getGenesisHash()),getSlot:(...a)=>track(()=>rpc.getSlot(...a)),
     getMultipleAccountsInfoAndContext:(...a)=>track(()=>rpc.getMultipleAccountsInfoAndContext(...a)),getSignaturesForAddress:(...a)=>track(()=>rpc.getSignaturesForAddress(...a)),
     getTransaction:((...a:Parameters<MiningTaxQuoteRpc['getTransaction']>)=>track(()=>rpc.getTransaction(...a))) as MiningTaxQuoteRpc['getTransaction'],
     getBlock:((...a:Parameters<MiningTaxQuoteRpc['getBlock']>)=>track(()=>rpc.getBlock(...a))) as MiningTaxQuoteRpc['getBlock'],
     getLatestBlockhashAndContext:(...a)=>track(()=>rpc.getLatestBlockhashAndContext(...a)),getFeeForMessage:(...a)=>track(()=>rpc.getFeeForMessage(...a)),
     getMinimumBalanceForRentExemption:(...a)=>track(()=>rpc.getMinimumBalanceForRentExemption(...a)),getBlockHeight:(...a)=>track(()=>rpc.getBlockHeight(...a))};
   };
   const work=prepareNew(wallet,request,controller.signal,trackedConnect).catch(error=>{
    if(error instanceof MiningTaxClaimPreparationError)throw error;
    if(error instanceof MiningTaxQuoteError||error instanceof MiningTaxSnapshotError||error instanceof MiningTaxMessageError){
     if(controller.signal.aborted||error.code==='TIMEOUT')fail('TIMEOUT');throw new MiningTaxClaimPreparationError('QUOTE_UNAVAILABLE',error.code);
    }
    if(error instanceof MiningTaxClaimPreparationStoreError)fail(error.code==='REQUEST_CONFLICT'?'REQUEST_CONFLICT':'SOURCE_CONFLICT');fail('STORAGE_UNAVAILABLE');
   });
   const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxClaimPreparationError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
   const entry={request,reply};pending.set(key,entry);release=()=>{if(workDone&&outstanding.size===0&&pending.get(key)===entry)pending.delete(key);};
   const done=()=>{workDone=true;controller.abort();release();};void work.then(done,done);return reply;
  },
  async get(authenticatedWallet:string,idempotencyKey:string):Promise<MiningTaxClaimPreparation|null>{
   const wallet=actor(authenticatedWallet),key=z.uuid().refine(v=>v===v.toLowerCase()).safeParse(idempotencyKey);if(!key.success)fail('INVALID_INPUT');
   try{const saved=await getMiningTaxClaimPreparation(db,{wallet,idempotencyKey:key.data});return saved?freeze(saved):null;}
   catch(error){if(error instanceof MiningTaxClaimPreparationStoreError)fail('SOURCE_CONFLICT');throw error;}
  },
 };
}
