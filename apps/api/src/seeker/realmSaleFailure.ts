/** Owner-attested original failure. Retained custody never grants a new action. */
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createSeekerRealmSaleFailureVerifier,SeekerRealmSaleFailureError as ChainFailureError,type SeekerRealmSaleFailureProof,type SeekerRealmSaleFailureRpc} from '@shardkeep/chain/seeker-realm-sale-failure';
import type {SeekerRealmAccessTrust} from '@shardkeep/chain/seeker-realm-access-snapshot';
import type {Db,DbOrTx} from '../db/client';
import {getRealmSaleSigned,type RealmSaleSigned} from './realmSaleSignedStore';
import {realmSalePreparationArgs} from './realmSalePreparationStore';
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'RECEIPT_UNAVAILABLE'|'RECEIPT_CONFLICT'|'BUSY'|'TIMEOUT';
export class RealmSaleFailureError extends Error{readonly journalClearingAuthorized=false;constructor(readonly code:Code){super(`Realm sale failure held: ${code}`);this.name='RealmSaleFailureError';}}
function fail(code:Code):never{throw new RealmSaleFailureError(code);}
const MAX_TIMEOUT_MS=60_000,MAX_PENDING=1;
const address=z.string().min(32).max(44).refine(v=>{if(v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}}),hash=z.string().length(64).regex(/^[0-9a-f]{64}$/);
const uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),u64=z.string().max(20).regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const keySchema=z.object({wallet:address,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
export type RealmSaleFailureKey=z.infer<typeof keySchema>;
const receiptSchema=z.object({version:z.literal(1),wallet:address,saleId:z.string().length(32).regex(/^[0-9a-f]{32}$/),spot:uint,realm:uint,round:u64,day:u64,
 signature:z.string().min(64).max(88),originalMessageSha256:hash,signedTransactionSha256:hash,slot:uint,blockTime:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),feeLamports:u64,
 actualRentLamports:z.literal('0'),buyerNetPaymentLamports:z.literal('0'),accessChanged:z.literal(false),quotaConsumed:z.literal(false),observedAccountSlot:uint,proofClockUnixTimestamp:u64,
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:address,programId:address,reviewedDeploymentSlot:uint,reviewedProgramDataSha256:hash,upgradeAuthority:address.nullable(),accounts:z.array(z.object({address,exists:z.literal(true),owner:address,executable:z.boolean(),dataSha256:hash}).strict()).length(3)}).strict(),
 outcome:z.literal('failed'),transactionFailed:z.literal(true),finalityVerified:z.literal(true),paymentAuthorized:z.literal(false),admissionAuthorized:z.literal(false),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),journalClearingAuthorized:z.literal(false)}).strict();
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR='Sysvar1111111111111111111111111111111111111';
export interface RealmSaleFailure extends RealmSaleFailureKey{saleId:string;receipt:SeekerRealmSaleFailureProof;verifiedAt:string;transactionFailed:true;purchaseFinalized:false;journalClearingAuthorized:false}
function key(value:unknown):RealmSaleFailureKey{if(!value||typeof value!=='object'||Reflect.ownKeys(value).length!==2||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!['wallet','idempotencyKey'].includes(k)))fail('INVALID_INPUT');const p=keySchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');return p.data;}
function audit(value:unknown,signed:RealmSaleSigned,k:RealmSaleFailureKey,verifiedAt:string):RealmSaleFailure{
 try{
  const r=receiptSchema.parse(value),a=signed.preparation,w=signed.wire,s=r.source,o=a.source;if(!w)fail('RECEIPT_CONFLICT');
  if(r.wallet!==k.wallet||r.saleId!==a.saleId||r.spot!==a.spot||r.realm!==a.realm||r.round!==a.terms.round||r.day!==a.terms.day||r.signature!==w.signature||r.originalMessageSha256!==w.messageSha256||r.signedTransactionSha256!==w.wireSha256)fail('RECEIPT_CONFLICT');
  if(s.genesisHash!==o.genesisHash||s.programId!==o.programId||s.reviewedDeploymentSlot!==o.reviewedDeploymentSlot||s.reviewedProgramDataSha256!==o.programDataSha256||r.slot<=o.reviewedDeploymentSlot||r.slot<o.admissionSlot||r.observedAccountSlot<r.slot)fail('RECEIPT_CONFLICT');
  const unix=BigInt(r.proofClockUnixTimestamp);if(unix<=0n||unix>((1n<<63n)-1n)||(r.blockTime!==null&&unix<BigInt(r.blockTime)))fail('RECEIPT_CONFLICT');
  const program=new PublicKey(o.programId),addresses=[program,PublicKey.findProgramAddressSync([program.toBuffer()],LOADER)[0],SYSVAR_CLOCK_PUBKEY];
  for(const [i,row]of s.accounts.entries())if(row.address!==addresses[i]!.toBase58()||row.owner!==(i<2?LOADER.toBase58():SYSVAR)||row.executable!==(i===0))fail('RECEIPT_CONFLICT');
  if(s.accounts[1]!.dataSha256!==s.reviewedProgramDataSha256||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(verifiedAt)||!Number.isFinite(Date.parse(verifiedAt)))fail('RECEIPT_CONFLICT');
  return Object.freeze({...k,saleId:a.saleId,receipt:Object.freeze({...r,source:Object.freeze({...s,accounts:Object.freeze(s.accounts.map(row=>Object.freeze(row)))})}),verifiedAt,transactionFailed:true,purchaseFinalized:false,journalClearingAuthorized:false});
 }catch{fail('RECEIPT_CONFLICT');}
}
export async function getRealmSaleFailure(db:DbOrTx,input:RealmSaleFailureKey):Promise<RealmSaleFailure|null>{
 const k=key(input),signed=await getRealmSaleSigned(db,k);if(!signed)return null;
 const [row]=await db.execute<{wallet:string;sale_id:string;receipt:unknown;verified_at:string}>(sql`select wallet,sale_id,receipt,to_char(verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') verified_at from seeker_realm_sale_failures where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey}`);if(!row)return null;
 const [success]=await db.execute(sql`select sale_id from seeker_realm_sale_receipts where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey}`);
 if(success||row.wallet!==k.wallet||row.sale_id!==signed.preparation.saleId)fail('RECEIPT_CONFLICT');return audit(row.receipt,signed,k,row.verified_at);
}
/** Pool handle only. Trusted RPC finishes before acquiring the outcome lock. */
export function createRealmSaleFailure(db:Db,options:{connect:(signal:AbortSignal)=>SeekerRealmSaleFailureRpc;trust:SeekerRealmAccessTrust;timeoutMs?:number}){
 if(!options||typeof options!=='object'||Reflect.ownKeys(options).some(k=>typeof k!=='string'||!['connect','trust','timeoutMs'].includes(k))||typeof options.connect!=='function')fail('INVALID_INPUT');
 const timeout=options.timeoutMs??MAX_TIMEOUT_MS;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 try{createSeekerRealmSaleFailureVerifier(options.connect,options.trust);}catch{fail('INVALID_INPUT');}
 const connect=options.connect,t=options.trust,pk=(v:PublicKey)=>new PublicKey(v.toBytes()),trust:SeekerRealmAccessTrust={...t,programId:pk(t.programId),developer:pk(t.developer),upgradeAuthority:t.upgradeAuthority===null?null:pk(t.upgradeAuthority)};
 const pending=new Map<string,Promise<RealmSaleFailure>>();
 return async(input:RealmSaleFailureKey):Promise<RealmSaleFailure>=>{
  const k=key(input),id=`${k.wallet}:${k.idempotencyKey}`,existing=pending.get(id);if(existing)return existing;if(pending.size>=MAX_PENDING)fail('BUSY');
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  const trackedConnect=(inner:AbortSignal):SeekerRealmSaleFailureRpc=>{
   const signal=AbortSignal.any([inner,controller.signal]);signal.throwIfAborted();const raw=connect(signal);
   const track=<T>(invoke:()=>Promise<T>):Promise<T>=>{if(signal.aborted)return Promise.reject(new RealmSaleFailureError('TIMEOUT'));let call:Promise<T>;try{call=Promise.resolve(invoke());}catch(e){call=Promise.reject(e);}outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call;};
   return {getGenesisHash:()=>track(()=>raw.getGenesisHash()),getSlot:(...args)=>track(()=>raw.getSlot(...args)),getMultipleAccountsInfoAndContext:(...args)=>track(()=>raw.getMultipleAccountsInfoAndContext(...args)),getTransaction:(...args)=>track(()=>raw.getTransaction(...args))};
  };
  const work=(async()=>{
   const old=await getRealmSaleFailure(db,k);alive();if(old)return old;
   const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.seeker_realm_sale_failures'::regclass) allowed`);alive();if(!owner?.allowed)fail('OWNER_REQUIRED');
   const signed=await getRealmSaleSigned(db,k);alive();if(!signed?.wire)fail('NOT_SIGNED');const a=signed.preparation,w=signed.wire;
   if(a.source.genesisHash!==trust.expectedGenesisHash||a.source.programId!==trust.programId.toBase58()||a.source.reviewedDeploymentSlot!==trust.reviewedDeploymentSlot||a.source.programDataSha256!==trust.reviewedProgramDataSha256||a.terms.developer!==trust.developer.toBase58())fail('RECEIPT_CONFLICT');
   const [success]=await db.execute(sql`select sale_id from seeker_realm_sale_receipts where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey}`);alive();if(success)fail('RECEIPT_CONFLICT');
   const receipt=await createSeekerRealmSaleFailureVerifier(trackedConnect,trust,{deadlineMs:timeout})({wallet:new PublicKey(a.wallet),args:realmSalePreparationArgs(a),blockhash:a.quote.blockhash,needsAccess:a.quote.needsAccess,needsQuota:a.quote.needsQuota,preparedMessageBytes:Buffer.from(a.quote.messageHex,'hex'),signedTransaction:Buffer.from(w.signedTransactionHex,'hex'),minContextSlot:a.source.admissionSlot});alive();
   audit(receipt,signed,k,'2000-01-01T00:00:00.000000Z');
   return db.transaction(async tx=>{alive();await tx.execute(sql`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${k.wallet},${k.idempotencyKey},${JSON.stringify(receipt)}::jsonb) on conflict(wallet,idempotency_key) do nothing`);alive();const saved=await getRealmSaleFailure(tx,k);alive();if(!saved)fail('RECEIPT_CONFLICT');return saved;});
  })().catch(e=>{if(e instanceof RealmSaleFailureError)throw e;if(controller.signal.aborted)fail('TIMEOUT');if(e instanceof ChainFailureError)fail(e.code==='DEADLINE'?'TIMEOUT':e.code==='UNAVAILABLE'?'RECEIPT_UNAVAILABLE':'RECEIPT_CONFLICT');fail('RECEIPT_UNAVAILABLE');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RealmSaleFailureError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  pending.set(id,reply);release=()=>{if(workDone&&outstanding.size===0&&pending.get(id)===reply)pending.delete(id);};const finished=()=>{workDone=true;controller.abort();release();};void work.then(finished,finished);return reply;
 };
}
