/** Explicit additional consent for an expired unsigned split remainder. Chain
 * observations precede locks; immutable linkage never erases historical custody. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {MiningTaxClaimPreparationSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import {MiningTaxClaimContinuationRequestSchema,MiningTaxClaimContinuationSchema,type MiningTaxClaimContinuationRequest,type MiningTaxClaimContinuation} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {createMiningTaxQuoteReader,type MiningTaxQuoteRpc} from '@shardkeep/chain/mining-tax-quote';
import type {Db,DbOrTx} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {getMiningTaxClaimSigned} from './taxClaimSignedStore';
import {getMiningTaxClaimSettlement} from './taxClaimSettlement';
import {createMiningTaxClaimPreparationRecord,getMiningTaxClaimPreparation,saveMiningTaxClaimPreparation} from './taxClaimPreparationStore';
import type {MiningTaxClaimPreparationSources} from './taxClaimPreparation';
const MAX_PENDING=32,MAX_TIMEOUT_MS=30_000,P=MiningTaxClaimPreparationSchema.shape;
type Code='INVALID_INPUT'|'NOT_PREPARED'|'SETUP_REQUIRED'|'PARENT_SIGNED'|'REQUEST_CONFLICT'|'DISABLED'|'NOT_EXPIRED'|'SOURCE_CONFLICT'|'BUSY'|'TIMEOUT'|'STORAGE_UNAVAILABLE'|'CLAIM_BLOCKHASH_REUSED';
export class MiningTaxClaimContinuationError extends Error{constructor(readonly code:Code){super(`Mining tax continuation held: ${code}`);this.name='MiningTaxClaimContinuationError';}}
function fail(code:Code):never{throw new MiningTaxClaimContinuationError(code);}
const keySchema=z.object({wallet:P.wallet,idempotencyKey:P.idempotencyKey}).strict();type Key=z.infer<typeof keySchema>;
function own(value:unknown,allowed:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>typeof k!=='string'||!allowed.includes(k)))fail('INVALID_INPUT');}
function key(value:unknown):Key{own(value,['wallet','idempotencyKey']);const result=keySchema.safeParse(value);if(!result.success)fail('INVALID_INPUT');return result.data;}
const count=(n:unknown):number=>{if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)fail('SOURCE_CONFLICT');return n;};
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
const same=(a:MiningTaxClaimContinuationRequest,b:MiningTaxClaimContinuationRequest)=>a.idempotencyKey===b.idempotencyKey&&(['maxFeeLamports','maxRentLamports','maxTotalLamports'] as const).every(k=>a.caps[k]===b.caps[k]);
/** Suppression only: an immutable link never grants any new action authority. */
export async function hasMiningTaxClaimContinuation(db:DbOrTx,input:Key):Promise<boolean>{const k=key(input);const [row]=await db.execute(sql`select c.parent_claim_id from mining_tax_claim_continuations c join mining_tax_claim_preparations p on p.claim_id=c.parent_claim_id where p.wallet=${k.wallet} and p.idempotency_key=${k.idempotencyKey}`);return !!row;}
export async function getMiningTaxClaimContinuation(db:DbOrTx,input:Key):Promise<MiningTaxClaimContinuation|null>{
 const k=key(input),[row]=await db.execute<{wallet:string;parent_claim_id:string;child_claim_id:string;child_key:string;expiry_height:string;expiry_slot:string;created_at:string}>(sql`select c.wallet,c.parent_claim_id,c.child_claim_id,q.idempotency_key child_key,c.expiry_height::text,c.expiry_slot::text,to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at from mining_tax_claim_continuations c join mining_tax_claim_preparations p on p.claim_id=c.parent_claim_id join mining_tax_claim_preparations q on q.claim_id=c.child_claim_id where p.wallet=${k.wallet} and p.idempotency_key=${k.idempotencyKey}`);
 if(!row)return null;const parentSetup=await getMiningTaxClaimSettlement(db,{...k,ordinal:0}),childPreparation=await getMiningTaxClaimPreparation(db,{wallet:k.wallet,idempotencyKey:row.child_key});
 if(!parentSetup||!childPreparation||row.wallet!==k.wallet||parentSetup.claimId!==row.parent_claim_id||childPreparation.claimId!==row.child_claim_id)fail('SOURCE_CONFLICT');
 const signed=await getMiningTaxClaimSigned(db,k),p=signed?.preparation,parentWire=signed?.wires.find(w=>w.ordinal===0);if(!p||!parentWire)fail('SOURCE_CONFLICT');try{return freeze(MiningTaxClaimContinuationSchema.parse({version:1,wallet:k.wallet,parentIdempotencyKey:k.idempotencyKey,parentPreparation:p,parentWire,parentSetup,childPreparation,
  expiry:{genesisHash:p.source.genesisHash,programId:p.source.programId,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256,blockHeight:count(Number(row.expiry_height)),slot:count(Number(row.expiry_slot))},createdAt:row.created_at,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false}));}catch{fail('SOURCE_CONFLICT');}
}
async function parent(db:DbOrTx,k:Key){
 const signed=await getMiningTaxClaimSigned(db,k);if(!signed)fail('NOT_PREPARED');const a=signed.preparation;
 if(a.transactions.length!==2||a.transactions[0]?.kind!=='setup'||a.transactions[1]?.kind!=='claim')fail('SETUP_REQUIRED');
 if(signed.wires.some(w=>w.ordinal===1))fail('PARENT_SIGNED');
 const setup=await getMiningTaxClaimSettlement(db,{...k,ordinal:0});if(!setup||setup.claimFinalized||setup.receipt.phase!=='setup')fail('SETUP_REQUIRED');
 const [outcome]=await db.execute(sql`select claim_id from mining_tax_claim_receipts where claim_id=${a.claimId} and ordinal=1 union all select claim_id from mining_tax_claim_failures where claim_id=${a.claimId}`);if(outcome)fail('PARENT_SIGNED');
 const wire=signed.wires.find(w=>w.ordinal===0);if(!wire)fail('SETUP_REQUIRED');return {a,setup,wire};
}
export function createMiningTaxClaimContinuation(db:Db,sources:MiningTaxClaimPreparationSources){
 own(sources,['connect','trust','now','timeoutMs']);if(typeof sources.connect!=='function'||sources.now!==undefined&&typeof sources.now!=='function')fail('INVALID_INPUT');
 const timeout=sources.timeoutMs??MAX_TIMEOUT_MS;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TIMEOUT_MS)fail('INVALID_INPUT');
 const connect=sources.connect,now=sources.now??(()=>new Date());let trust:MiningTaxClaimPreparationSources['trust'];
 try{createMiningTaxQuoteReader(()=>{throw Error('validation only');},sources.trust);const m=sources.trust.mining,s=sources.trust.seeker,pk=(k:PublicKey)=>new PublicKey(k.toBytes());trust={mining:{...m,programId:pk(m.programId),keepMint:pk(m.keepMint),reserveOwner:pk(m.reserveOwner)},seeker:{...s,programId:pk(s.programId),config:pk(s.config),mint:pk(s.mint),prizeOwner:pk(s.prizeOwner),prizeAta:pk(s.prizeAta),genesisHash:pk(s.genesisHash),deployment:{...s.deployment}}};}catch{fail('INVALID_INPUT');}
 const pending=new Map<string,{request:MiningTaxClaimContinuationRequest;reply:Promise<MiningTaxClaimContinuation>}>();
 return {async prepare(wallet:string,parentIdempotencyKey:string,value:unknown):Promise<MiningTaxClaimContinuation>{
  const k=key({wallet,idempotencyKey:parentIdempotencyKey});own(value,['idempotencyKey','caps']);own((value as {caps?:unknown}).caps,['maxFeeLamports','maxRentLamports','maxTotalLamports']);
  const parsed=MiningTaxClaimContinuationRequestSchema.safeParse(value);if(!parsed.success||parsed.data.idempotencyKey===k.idempotencyKey)fail('INVALID_INPUT');const request=freeze(parsed.data),id=`${k.wallet}:${k.idempotencyKey}`,old=pending.get(id);
  if(old){if(!same(old.request,request))fail('REQUEST_CONFLICT');return old.reply;}if(pending.size>=MAX_PENDING)fail('BUSY');
  const controller=new AbortController(),outstanding=new Set<Promise<unknown>>();let workDone=false,release=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
  const alive=()=>{if(controller.signal.aborted)fail('TIMEOUT');},active=()=>{alive();if(!phaseEMiningEnabled())fail('DISABLED');};
  const match=(saved:MiningTaxClaimContinuation)=>{if(!same({idempotencyKey:saved.childPreparation.idempotencyKey,caps:saved.childPreparation.caps},request))fail('REQUEST_CONFLICT');return saved;};
  const trackedConnect=(inner:AbortSignal):MiningTaxQuoteRpc=>{const signal=AbortSignal.any([controller.signal,inner]);signal.throwIfAborted();const rpc=connect(signal);return new Proxy(rpc,{get(t,p,r){const fn=Reflect.get(t,p,r);if(typeof fn!=='function')return fn;return (...args:unknown[])=>{signal.throwIfAborted();let call:Promise<unknown>;try{call=Promise.resolve(fn.apply(t,args));}catch(e){call=Promise.reject(e);}outstanding.add(call);const done=()=>{outstanding.delete(call);release();};void call.then(done,done);return call.then(result=>{signal.throwIfAborted();return result;});};}});};
  const work=(async()=>{
   const previous=await getMiningTaxClaimContinuation(db,k);alive();if(previous)return match(previous);
   const original=await parent(db,k);active();const a=original.a;
   if(await getMiningTaxClaimPreparation(db,{wallet:k.wallet,idempotencyKey:request.idempotencyKey}))fail('REQUEST_CONFLICT');active();
   const m=trust.mining;if(a.source.genesisHash!==m.expectedGenesisHash||a.source.programId!==m.programId.toBase58()||a.source.reviewedDeploymentSlot!==m.reviewedDeploymentSlot||a.source.reviewedProgramDataSha256!==m.reviewedProgramDataSha256)fail('SOURCE_CONFLICT');
   const rpc=trackedConnect(controller.signal);if(await rpc.getGenesisHash()!==m.expectedGenesisHash)fail('SOURCE_CONFLICT');active();
   // Height must precede the slot floor; a bank sampled before expiry cannot be
   // promoted to post-expiry authority by a later height read.
   const height=count(await rpc.getBlockHeight({commitment:'finalized',minContextSlot:Math.max(a.source.snapshotSlot,a.source.blockhashSlot,original.setup.receipt.source.observedAccountSlot)}));active();if(height<=a.lastValidBlockHeight)fail('NOT_EXPIRED');
   const slot=count(await rpc.getSlot('finalized'));active();if(slot<Math.max(a.source.snapshotSlot,a.source.blockhashSlot,original.setup.receipt.source.observedAccountSlot))fail('SOURCE_CONFLICT');
   if(await rpc.getGenesisHash()!==m.expectedGenesisHash)fail('SOURCE_CONFLICT');active();
   const quote=await createMiningTaxQuoteReader(trackedConnect,trust,{timeoutMs:timeout})({wallet:new PublicKey(k.wallet),round:BigInt(a.round),spot:a.spot,caps:{maxFeeLamports:BigInt(request.caps.maxFeeLamports),maxRentLamports:BigInt(request.caps.maxRentLamports),maxTotalLamports:BigInt(request.caps.maxTotalLamports)}});active();
   if(quote.source.firstSnapshotSlot<slot||quote.source.snapshotSlot<slot||quote.blockHeight<height||quote.blockhash===a.blockhash)fail('SOURCE_CONFLICT');
   const at=now();if(!(at instanceof Date)||!Number.isFinite(+at))fail('SOURCE_CONFLICT');const record=createMiningTaxClaimPreparationRecord(k.wallet,{...request,round:a.round,spot:a.spot},quote,{claimId:randomUUID(),preparedAt:new Date(+at)});
   // This structural precheck cannot replace the locked setup/absence audit.
   const candidate={version:1,wallet:k.wallet,parentIdempotencyKey:k.idempotencyKey,parentPreparation:a,parentWire:original.wire,parentSetup:original.setup,childPreparation:record.artifact,expiry:{genesisHash:a.source.genesisHash,programId:a.source.programId,reviewedDeploymentSlot:a.source.reviewedDeploymentSlot,reviewedProgramDataSha256:a.source.reviewedProgramDataSha256,blockHeight:height,slot},createdAt:'2000-01-01T00:00:00.000000Z',currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false};
   if(!MiningTaxClaimContinuationSchema.safeParse(candidate).success)fail('SOURCE_CONFLICT');
   const current=()=>{active();const time=now();if(!(time instanceof Date)||!Number.isFinite(+time)||+time<+at||+time>=Date.parse(record.artifact.expiresAt))fail('SOURCE_CONFLICT');};current();
   return db.transaction(async tx=>{
    await tx.execute(sql`select public.shardkeep_mining_tax_continuation_lock(${a.claimId}::uuid)`);alive();
    const previous=await getMiningTaxClaimContinuation(tx,k);alive();if(previous)return match(previous);current();
    const checked=await parent(tx,k);current();if(checked.a.claimId!==a.claimId||JSON.stringify(checked.setup)!==JSON.stringify(original.setup))fail('SOURCE_CONFLICT');
    if(await getMiningTaxClaimPreparation(tx,{wallet:k.wallet,idempotencyKey:request.idempotencyKey}))fail('REQUEST_CONFLICT');current();
    for(const packet of record.artifact.transactions){const [used]=await tx.execute(sql`select w.claim_id from mining_tax_claim_signed_wires w join mining_tax_claim_failures f on f.claim_id=w.claim_id and f.ordinal=w.ordinal where w.wallet=${k.wallet} and w.message_sha256=${packet.messageSha256} limit 1`);current();if(used)fail('CLAIM_BLOCKHASH_REUSED');}
    const child=await saveMiningTaxClaimPreparation(tx,record);current();if(child.claimId!==record.artifact.claimId)fail('REQUEST_CONFLICT');
    await tx.execute(sql`insert into mining_tax_claim_continuations(parent_claim_id,child_claim_id,expiry_height,expiry_slot) values(${a.claimId},${child.claimId},${height},${slot})`);current();
    const saved=await getMiningTaxClaimContinuation(tx,k);current();if(!saved)fail('SOURCE_CONFLICT');return match(saved);
   });
  })().catch(error=>{if(error instanceof MiningTaxClaimContinuationError)throw error;if(controller.signal.aborted)fail('TIMEOUT');fail('STORAGE_UNAVAILABLE');});
  const reply=Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxClaimContinuationError('TIMEOUT'));},timeout);})]).finally(()=>{if(timer!==undefined)clearTimeout(timer);});
  const entry={request,reply};pending.set(id,entry);release=()=>{if(workDone&&outstanding.size===0&&pending.get(id)===entry)pending.delete(id);};const done=()=>{workDone=true;controller.abort();release();};void work.then(done,done);return reply;
 }};
}
