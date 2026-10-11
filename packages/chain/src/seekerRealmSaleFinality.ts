/** Application-owned finalized receipt composition. Retained intent is not an
 * HTTP finality proof. No signer, relay, terminal-failure writer or admission. */
import {Connection,Message,PublicKey,type VersionedTransactionResponse} from '@solana/web3.js';
import {createSeekerRealmAccessSnapshotReader,SeekerRealmAccessSnapshotError,
 type SeekerRealmAccessRpc,type SeekerRealmAccessTrust} from './seekerRealmAccessSnapshot';
import {buildRealmSaleMessage} from './seekerRealmSaleMessage';
import {validateRealmSalePurchaseArgs} from './seekerRealmSaleProtocol';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {verifyRealmSaleTransactionEvidence,RealmSaleReceiptError,type RealmSaleTransactionExpectation} from './seekerRealmSaleReceipt';
const DEADLINE_MS=60_000,MAX_PENDING=8,MAX_RPC_BYTES=16*1024*1024,U64=(1n<<64n)-1n;
type Code='INPUT'|'BUSY'|'DEADLINE'|'UNAVAILABLE'|'IDENTITY'|'DEPLOYMENT'|'TRANSACTION'|'ACCOUNTS'|'PAYMENT'|'FAILED_OBSERVATION';
export class SeekerRealmSaleFinalityError extends Error {
 readonly journalReleaseAuthorized=false;
 constructor(readonly code:Code){super(`Finalized realm sale evidence unavailable: ${code}`);this.name='SeekerRealmSaleFinalityError';}
}
function need(v:unknown,code:Code):asserts v{if(!v)throw new SeekerRealmSaleFinalityError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function fields(v:object,names:string){need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const actual=Reflect.ownKeys(v),expected=names.split(' ');need(actual.length===expected.length&&actual.every(k=>typeof k==='string'&&expected.includes(k)),'INPUT');}
function key(p:PublicKey){need(p instanceof PublicKey,'INPUT');return new PublicKey(p.toBytes());}
export interface SeekerRealmSaleFinalityRpc extends SeekerRealmAccessRpc {
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
}
export type SeekerRealmSaleFinalityRequest=Omit<RealmSaleTransactionExpectation,'programId'|'reviewedDeploymentSlot'|'observedAccountSlot'|'proofClockUnixTimestamp'>;
function copiedRequest(input:SeekerRealmSaleFinalityRequest,trust:SeekerRealmAccessTrust){
 fields(input,'wallet args blockhash needsAccess needsQuota preparedMessageBytes signedTransaction minContextSlot newAccountRentCaps');
 need(input.preparedMessageBytes instanceof Uint8Array&&input.preparedMessageBytes.length>0&&input.preparedMessageBytes.length<=1167
  &&input.signedTransaction instanceof Uint8Array&&input.signedTransaction.length>65&&input.signedTransaction.length<=1232,'INPUT');
 need(safe(input.minContextSlot)&&input.minContextSlot>=trust.reviewedDeploymentSlot,'INPUT');
 const wallet=key(input.wallet),args=validateRealmSalePurchaseArgs(input.args),blockhash=input.blockhash,needsAccess=input.needsAccess,needsQuota=input.needsQuota;
 const preparedMessageBytes=Uint8Array.from(input.preparedMessageBytes),signedTransaction=Uint8Array.from(input.signedTransaction);
 const plan=buildRealmSaleMessage(trust.programId,{wallet,args,blockhash,needsAccess,needsQuota});
 need(Buffer.from(plan.messageBytes).equals(Buffer.from(preparedMessageBytes)),'INPUT');
 const signed=verifyMiningClaimSignedWire({wallet,intentBytes:preparedMessageBytes,signedTransaction});
 need(Array.isArray(input.newAccountRentCaps)&&input.newAccountRentCaps.length===plan.expectedNewAccounts.length,'INPUT');
 const newAccountRentCaps=input.newAccountRentCaps.map((cap,i)=>{
  fields(cap,'address maxIncreaseLamports');const address=key(cap.address),maxIncreaseLamports=cap.maxIncreaseLamports;
  need(address.toBase58()===plan.expectedNewAccounts[i]!.address&&typeof maxIncreaseLamports==='bigint'&&maxIncreaseLamports>=0n&&maxIncreaseLamports<=U64,'INPUT');
  return {address,maxIncreaseLamports};
 });
 return {wallet,args,blockhash,needsAccess,needsQuota,preparedMessageBytes,signedTransaction,minContextSlot:input.minContextSlot,newAccountRentCaps,signature:signed.signature};
}
/** Whitelist only bounded fields used by the pure verifier; never retain RPC
 * object references, logs, token metadata or injected serialize implementations. */
function copiedTransaction(tx:VersionedTransactionResponse|null,messageBytes:Uint8Array,signature:string):VersionedTransactionResponse{
 need(tx&&tx.meta,'UNAVAILABLE');need(safe(tx.slot)&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
 need(tx.blockTime===undefined||tx.blockTime===null||typeof tx.blockTime==='number'&&Number.isSafeInteger(tx.blockTime),'TRANSACTION');
 const raw=tx.transaction?.message,meta=tx.meta;
 need(raw&&raw.version==='legacy'&&Array.isArray(raw.accountKeys)&&raw.accountKeys.length>0&&raw.accountKeys.length<=32
  &&Array.isArray(raw.instructions)&&raw.instructions.length>0&&raw.instructions.length<=3,'TRANSACTION');
 const count=raw.accountKeys.length,index=(n:number)=>{need(safe(n)&&n<count,'TRANSACTION');return n;};
 need(raw.header&&[raw.header.numRequiredSignatures,raw.header.numReadonlySignedAccounts,raw.header.numReadonlyUnsignedAccounts].every(n=>safe(n)&&n<=count),'TRANSACTION');
 need(typeof raw.recentBlockhash==='string'&&raw.recentBlockhash.length>=32&&raw.recentBlockhash.length<=44,'TRANSACTION');
 const accountKeys=raw.accountKeys.map(p=>key(p)),instructions=raw.instructions.map(ix=>{
  need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=32,'TRANSACTION');
  return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data};
 });
 const message=new Message({header:{numRequiredSignatures:raw.header.numRequiredSignatures,numReadonlySignedAccounts:raw.header.numReadonlySignedAccounts,
  numReadonlyUnsignedAccounts:raw.header.numReadonlyUnsignedAccounts},accountKeys,recentBlockhash:raw.recentBlockhash,instructions});
 need(message.serialize().equals(Buffer.from(messageBytes))&&Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===1
  &&tx.transaction.signatures[0]===signature,'TRANSACTION');
 need(meta.err!==undefined,'UNAVAILABLE');
 // This observation never proves safe journal release, even when RPC calls it
 // finalized. A separate terminal-failure verifier would need its own contract.
 need(meta.err===null,'FAILED_OBSERVATION');
 need(!meta.loadedAddresses||Array.isArray(meta.loadedAddresses.readonly)&&Array.isArray(meta.loadedAddresses.writable)
  &&meta.loadedAddresses.readonly.length===0&&meta.loadedAddresses.writable.length===0,'TRANSACTION');
 need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===count
  &&meta.postBalances.length===count&&Array.from(meta.preBalances).every(safe)&&Array.from(meta.postBalances).every(safe),'TRANSACTION');
 for(const balances of [meta.preTokenBalances,meta.postTokenBalances])need(balances===undefined||balances===null||Array.isArray(balances)&&balances.length===0,'TRANSACTION');
 need(meta.innerInstructions!==null&&meta.innerInstructions!==undefined,'UNAVAILABLE');
 need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length<=3,'TRANSACTION');let innerCount=0;
 const innerInstructions=meta.innerInstructions.map(group=>{
  need(group&&safe(group.index)&&group.index<instructions.length&&Array.isArray(group.instructions),'TRANSACTION');
  innerCount+=group.instructions.length;need(innerCount<=16,'TRANSACTION');
  return {index:group.index,instructions:group.instructions.map(ix=>{
   need(ix&&typeof ix.data==='string'&&ix.data.length<=128&&Array.isArray(ix.accounts)&&ix.accounts.length<=2
    &&(ix as typeof ix&{stackHeight?:unknown}).stackHeight===2,'TRANSACTION');
   return {programIdIndex:index(ix.programIdIndex),accounts:ix.accounts.map(index),data:ix.data,stackHeight:2};
  })};
 });
 return {slot:tx.slot,blockTime:tx.blockTime??null,version:'legacy',transaction:{message,signatures:[signature]},
  meta:{err:null,fee:meta.fee,preBalances:[...meta.preBalances],postBalances:[...meta.postBalances],innerInstructions,
   preTokenBalances:[],postTokenBalances:[],loadedAddresses:{readonly:[],writable:[]}}};
}
export function createSeekerRealmSaleFinalityVerifier(connect:(signal:AbortSignal)=>SeekerRealmSaleFinalityRpc,
 inputTrust:SeekerRealmAccessTrust,options:{deadlineMs?:number}={}){
 let trust:SeekerRealmAccessTrust,deadlineMs:number;
 try{
  need(typeof connect==='function','INPUT');fields(inputTrust,'programId developer expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority stateProvenance');
  need(Reflect.ownKeys(options).every(k=>k==='deadlineMs'),'INPUT');deadlineMs=options.deadlineMs??DEADLINE_MS;need(safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=DEADLINE_MS,'INPUT');
  trust={programId:key(inputTrust.programId),developer:key(inputTrust.developer),upgradeAuthority:inputTrust.upgradeAuthority===null?null:key(inputTrust.upgradeAuthority),
   expectedGenesisHash:inputTrust.expectedGenesisHash,reviewedDeploymentSlot:inputTrust.reviewedDeploymentSlot,reviewedProgramDataSha256:inputTrust.reviewedProgramDataSha256,stateProvenance:inputTrust.stateProvenance};
  // Validate all explicit deployment fields before a request can open RPC.
  createSeekerRealmAccessSnapshotReader(connect,trust,{deadlineMs});
 }catch{throw new SeekerRealmSaleFinalityError('INPUT');}
 let pending=0;
 return async function verify(input:SeekerRealmSaleFinalityRequest){
  let request:ReturnType<typeof copiedRequest>;try{request=copiedRequest(input,trust);}catch{throw new SeekerRealmSaleFinalityError('INPUT');}
  need(pending<MAX_PENDING,'BUSY');pending++;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,workDone=false,released=false;
  const outstanding=new Set<Promise<unknown>>();
  const release=()=>{if(workDone&&!released&&outstanding.size===0){released=true;pending--;}};
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  const work=(async()=>{
   const rpc=connect(controller.signal);
   async function call<T>(read:()=>Promise<T>){
    active();const operation=Promise.resolve().then(()=>{active();return read();});outstanding.add(operation);
    try{const value=await operation;active();return value;}finally{outstanding.delete(operation);release();}
   }
   need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
   const opening=await call(()=>rpc.getSlot('finalized'));need(safe(opening)&&opening>=trust.reviewedDeploymentSlot,'DEPLOYMENT');
   const body=await call(()=>rpc.getTransaction(request.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}));
   // This bounded owned clone precedes every following await.
   const tx=copiedTransaction(body,request.preparedMessageBytes,request.signature);
   need(tx.slot>trust.reviewedDeploymentSlot,'DEPLOYMENT');need(tx.slot>=request.minContextSlot,'ACCOUNTS');
   const floor=Math.max(request.minContextSlot,tx.slot);
   const read=createSeekerRealmAccessSnapshotReader(()=>({getGenesisHash:()=>call(()=>rpc.getGenesisHash()),getSlot:c=>call(()=>rpc.getSlot(c)),
    getMultipleAccountsInfoAndContext:(addresses,settings)=>call(()=>rpc.getMultipleAccountsInfoAndContext(addresses,{...settings,minContextSlot:Math.max(settings.minContextSlot,floor)}))}),trust,{deadlineMs});
   const snapshot=await read({wallet:request.wallet,realm:request.args.realm,saleId:request.args.saleId});active();
   need(snapshot.slot>=floor&&snapshot.rawReceipt!==null,'ACCOUNTS');
   const {signature:_,...original}=request;
   const evidence=verifyRealmSaleTransactionEvidence(tx,snapshot.rawReceipt,{...original,programId:trust.programId,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,
    observedAccountSlot:snapshot.slot,proofClockUnixTimestamp:snapshot.unixTimestamp});
   active();return Object.freeze({version:1 as const,evidence,receiptAccountHex:Buffer.from(snapshot.rawReceipt.data).toString('hex'),source:snapshot.source,observedAccountSlot:snapshot.slot,proofClockUnixTimestamp:snapshot.unixTimestamp,
    finalityVerified:true as const,transactionEvidenceVerified:true as const,paymentAuthorized:false as const,admissionAuthorized:false as const,signingAuthorized:false as const});
  })();
  // A timed-out transport that ignores cancellation still occupies its bounded
  // slot until it settles, preventing unlimited abandoned background work.
  void work.then(()=>{workDone=true;release();},()=>{workDone=true;release();});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SeekerRealmSaleFinalityError('DEADLINE'));},deadlineMs);})]);}
  catch(error){
   if(error instanceof SeekerRealmSaleFinalityError)throw error;
   if(error instanceof SeekerRealmAccessSnapshotError)throw new SeekerRealmSaleFinalityError(error.code==='RECEIPT'?'ACCOUNTS':error.code);
   if(error instanceof RealmSaleReceiptError)throw new SeekerRealmSaleFinalityError(error.code==='FAILED'?'FAILED_OBSERVATION':error.code==='INPUT'?'TRANSACTION':error.code);
   throw new SeekerRealmSaleFinalityError('UNAVAILABLE');
  }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
 };
}
export type SeekerRealmSaleFinalizedEvidence=Awaited<ReturnType<ReturnType<typeof createSeekerRealmSaleFinalityVerifier>>>;

/** Explicit endpoint, bounded response bodies, no redirects, retries or signer. */
export function makeSeekerRealmSaleFinalityRpc(url:string,signal:AbortSignal):SeekerRealmSaleFinalityRpc{
 const rpc=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
  const response=await fetch(input,{...init,signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new SeekerRealmSaleFinalityError('UNAVAILABLE');}
  need(response.body,'UNAVAILABLE');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;need(bytes<=MAX_RPC_BYTES,'TRANSACTION');chunks.push(part.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');return new Response(Buffer.concat(chunks),{status:response.status,headers});
 }});
 return {getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),getTransaction:(signature,options)=>rpc.getTransaction(signature,options),
  getMultipleAccountsInfoAndContext:async(addresses,options)=>{const response=await rpc.getMultipleAccountsInfoAndContext(addresses,options);return {context:response.context,
   value:response.value.map((row,i)=>row===null?null:{address:addresses[i]!,owner:row.owner,executable:row.executable,data:row.data})};}};
}
