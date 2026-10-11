/** Exact failed original realm purchase from an application-owned finalized RPC.
 * Historical fee facts grant no payment, replacement consent or journal release. */
import {createHash} from 'node:crypto';
import {Message,PublicKey,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse} from '@solana/web3.js';
import {buildRealmSaleMessage} from './seekerRealmSaleMessage';
import {validateRealmSalePurchaseArgs} from './seekerRealmSaleProtocol';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {isFailedSolanaExecution} from './solanaFailedExecution';
import {decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority} from './registryAttestation';
import {createSeekerRealmAccessSnapshotReader,type SeekerRealmAccessTrust} from './seekerRealmAccessSnapshot';
import type {SeekerRealmSaleFinalityRpc,SeekerRealmSaleFinalityRequest} from './seekerRealmSaleFinality';

const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR=new PublicKey('Sysvar1111111111111111111111111111111111111');
const MAX_PENDING=8,MAX_DEADLINE_MS=60_000,MAX_PROGRAM_DATA=8*1024*1024;
type Code='INPUT'|'BUSY'|'DEADLINE'|'UNAVAILABLE'|'TRANSACTION'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS';
export class SeekerRealmSaleFailureError extends Error{
 readonly journalClearingAuthorized=false;
 constructor(readonly code:Code){super(`Finalized realm sale failure unavailable: ${code}`);this.name='SeekerRealmSaleFailureError';}
}
function need(v:unknown,code:Code='INPUT'):asserts v{if(!v)throw new SeekerRealmSaleFailureError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function key(v:PublicKey){need(v instanceof PublicKey);return new PublicKey(v.toBytes());}
function fields(v:unknown,required:string,optional=''){
 need(v&&typeof v==='object'&&!Array.isArray(v));const expected=required.split(' ').filter(Boolean),allowed=[...expected,...optional.split(' ').filter(Boolean)],actual=Reflect.ownKeys(v);
 need(expected.every(k=>Object.hasOwn(v,k))&&actual.every(k=>typeof k==='string'&&allowed.includes(k)));
}
function dense(v:unknown,max:number):v is unknown[]{return Array.isArray(v)&&v.length<=max&&Object.keys(v).length===v.length&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);}
export type SeekerRealmSaleFailureRpc=SeekerRealmSaleFinalityRpc;
export type SeekerRealmSaleFailureRequest=Omit<SeekerRealmSaleFinalityRequest,'newAccountRentCaps'>;
export interface SeekerRealmSaleFailureOptions{readonly deadlineMs?:number;readonly maxPending?:number}
function original(input:SeekerRealmSaleFailureRequest,trust:SeekerRealmAccessTrust){
 fields(input,'wallet args blockhash needsAccess needsQuota preparedMessageBytes signedTransaction minContextSlot');
 const wallet=key(input.wallet),args=validateRealmSalePurchaseArgs(input.args);
 need(args.developer.equals(trust.developer)&&safe(input.minContextSlot)&&input.minContextSlot>=trust.reviewedDeploymentSlot);
 need(input.preparedMessageBytes instanceof Uint8Array&&input.preparedMessageBytes.length>0&&input.preparedMessageBytes.length<=1167);
 const message=Buffer.from(input.preparedMessageBytes),plan=buildRealmSaleMessage(trust.programId,{wallet,args,blockhash:input.blockhash,needsAccess:input.needsAccess,needsQuota:input.needsQuota});
 need(Buffer.from(plan.messageBytes).equals(message));
 const signed=verifyMiningClaimSignedWire({wallet,intentBytes:message,signedTransaction:input.signedTransaction});
 return {wallet:wallet.toBase58(),saleId:Buffer.from(args.saleId).toString('hex'),spot:args.spot,realm:args.realm,round:args.round.toString(),day:args.day.toString(),message,signed,minContextSlot:input.minContextSlot};
}
/** Reconstruct raw fields, never a provider serializer. Recognized failure of
 * this non-nonce atomic message rolls back all rent, access and quota changes;
 * attempted CPI/log content is neither a payment nor a committed account effect. */
function failedTransaction(tx:VersionedTransactionResponse|null,intent:Buffer,signature:string){
 need(tx&&tx.meta&&tx.transaction,'UNAVAILABLE');const raw=tx.transaction.message,meta=tx.meta;
 need(safe(tx.slot)&&raw?.version==='legacy'&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
 need(tx.blockTime===undefined||tx.blockTime===null||typeof tx.blockTime==='number'&&Number.isSafeInteger(tx.blockTime),'TRANSACTION');
 const expected=Message.from(intent),count=expected.accountKeys.length;
 need(dense(raw.accountKeys,count)&&raw.accountKeys.length===count&&dense(raw.instructions,3)&&raw.instructions.length===expected.instructions.length,'TRANSACTION');
 const h=raw.header;need(h&&h.numRequiredSignatures===1&&h.numReadonlySignedAccounts===0&&safe(h.numReadonlyUnsignedAccounts)&&h.numReadonlyUnsignedAccounts<count,'TRANSACTION');
 const keys=raw.accountKeys.map(key);need(new Set(keys.map(k=>k.toBase58())).size===count,'TRANSACTION');
 need(typeof raw.recentBlockhash==='string'&&raw.recentBlockhash.length>=32&&raw.recentBlockhash.length<=44,'TRANSACTION');
 const instructions=raw.instructions.map((ix,i)=>{need(ix&&safe(ix.programIdIndex)&&ix.programIdIndex<count&&dense(ix.accounts,expected.instructions[i]!.accounts.length)&&ix.accounts.length===expected.instructions[i]!.accounts.length&&ix.accounts.every(j=>safe(j)&&j<count)&&typeof ix.data==='string'&&ix.data.length<=1683,'TRANSACTION');return {programIdIndex:ix.programIdIndex,accounts:[...ix.accounts],data:ix.data};});
 const owned=new Message({header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:h.numReadonlyUnsignedAccounts},accountKeys:keys,recentBlockhash:raw.recentBlockhash,instructions});
 need(owned.serialize().equals(intent)&&dense(tx.transaction.signatures,1)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signature,'TRANSACTION');
 need(isFailedSolanaExecution(meta.err,instructions.length,count),'TRANSACTION');
 need(!meta.loadedAddresses||(dense(meta.loadedAddresses.writable,0)&&dense(meta.loadedAddresses.readonly,0)),'TRANSACTION');
 need(safe(meta.fee)&&dense(meta.preBalances,count)&&dense(meta.postBalances,count)&&meta.preBalances.length===count&&meta.postBalances.length===count&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'TRANSACTION');
 need(meta.preBalances.every((pre,i)=>BigInt(pre)-BigInt(meta.postBalances[i]!)===(i===0?BigInt(meta.fee):0n)),'TRANSACTION');
 // This instruction family never touches SPL tokens. Missing token arrays are
 // allowed by the existing realm transaction contract; nonempty arrays are not.
 for(const rows of [meta.preTokenBalances,meta.postTokenBalances])need(rows===undefined||rows===null||dense(rows,0),'TRANSACTION');
 return {slot:tx.slot,blockTime:tx.blockTime??null,feeLamports:BigInt(meta.fee).toString()};
}
export function createSeekerRealmSaleFailureVerifier(connect:(signal:AbortSignal)=>SeekerRealmSaleFailureRpc,inputTrust:SeekerRealmAccessTrust,options:SeekerRealmSaleFailureOptions={}){
 let trust:SeekerRealmAccessTrust,deadlineMs:number,limit:number;
 try{
  need(typeof connect==='function');fields(inputTrust,'programId developer expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority stateProvenance');fields(options,'','deadlineMs maxPending');
  deadlineMs=options.deadlineMs??MAX_DEADLINE_MS;limit=options.maxPending??MAX_PENDING;
  need(safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=MAX_DEADLINE_MS&&safe(limit)&&limit>0&&limit<=MAX_PENDING);
  trust={...inputTrust,programId:key(inputTrust.programId),developer:key(inputTrust.developer),upgradeAuthority:inputTrust.upgradeAuthority===null?null:key(inputTrust.upgradeAuthority)};
  // Eager existing independent-pin validation only; no current mutable realm
  // state reader is invoked to decide this historical transaction's outcome.
  createSeekerRealmAccessSnapshotReader(connect,trust,{deadlineMs});
 }catch{throw new SeekerRealmSaleFailureError('INPUT');}
 const pd=PublicKey.findProgramAddressSync([trust.programId.toBuffer()],LOADER)[0],addresses=[trust.programId,pd,SYSVAR_CLOCK_PUBKEY];let pending=0;
 return async function verify(input:SeekerRealmSaleFailureRequest){
  let request:ReturnType<typeof original>;try{request=original(input,trust);}catch{throw new SeekerRealmSaleFailureError('INPUT');}
  need(pending<limit,'BUSY');pending++;const controller=new AbortController();let calls=0,finished=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(finished&&calls===0&&!released){released=true;pending--;}};const active=()=>need(!controller.signal.aborted,'DEADLINE');
  async function call<T,R=T>(run:()=>Promise<T>,copy:(v:T)=>R=(v=>v as unknown as R)){active();calls++;try{const raw=await run();active();return copy(raw);}finally{calls--;release();}}
  const work=async()=>{
   const rpc=connect(controller.signal);need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
   const tx=await call(()=>rpc.getTransaction(request.signed.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),raw=>failedTransaction(raw,request.message,request.signed.signature));
   need(tx.slot>trust.reviewedDeploymentSlot&&tx.slot>=request.minContextSlot,'TRANSACTION');
   const before=await call(()=>rpc.getSlot('finalized'));need(safe(before)&&before>=tx.slot,'ACCOUNTS');
   const bank=await call(()=>rpc.getMultipleAccountsInfoAndContext(addresses.map(key),{commitment:'finalized',minContextSlot:before}),raw=>{
    need(raw&&safe(raw.context?.slot)&&raw.context.slot>=before&&dense(raw.value,3)&&raw.value.length===3,'ACCOUNTS');const sizes=[36,MAX_PROGRAM_DATA,40];
    return {slot:raw.context.slot,rows:raw.value.map((row,i)=>{need(row&&key(row.address).equals(addresses[i]!)&&row.data instanceof Uint8Array&&row.data.length<=sizes[i]!&&typeof row.executable==='boolean','ACCOUNTS');return {address:key(row.address),owner:key(row.owner),executable:row.executable,data:Buffer.from(row.data)};})};
   });
   const after=await call(()=>rpc.getSlot('finalized'));need(safe(after)&&after>=bank.slot,'ACCOUNTS');need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
   const [program,data,clock]=bank.rows as [typeof bank.rows[number],typeof bank.rows[number],typeof bank.rows[number]];
   need(program.owner.equals(LOADER)&&program.executable===true&&program.data.length===36&&decodeUpgradeableProgramDataAddress(program.data).equals(pd),'DEPLOYMENT');
   need(data.owner.equals(LOADER)&&data.executable===false&&data.data.length>=45&&hash(data.data)===trust.reviewedProgramDataSha256&&data.data.readBigUInt64LE(4)===BigInt(trust.reviewedDeploymentSlot),'DEPLOYMENT');
   need((decodeProgramDataUpgradeAuthority(data.data)?.toBase58()??null)===(trust.upgradeAuthority?.toBase58()??null),'DEPLOYMENT');
   need(clock.owner.equals(SYSVAR)&&clock.executable===false&&clock.data.length===40&&clock.data.readBigUInt64LE(0)===BigInt(bank.slot),'ACCOUNTS');
   const unix=clock.data.readBigInt64LE(32);need(unix>0n&&(tx.blockTime===null||unix>=BigInt(tx.blockTime)),'ACCOUNTS');
   return Object.freeze({version:1 as const,wallet:request.wallet,saleId:request.saleId,spot:request.spot,realm:request.realm,round:request.round,day:request.day,signature:request.signed.signature,
    originalMessageSha256:request.signed.messageSha256,signedTransactionSha256:request.signed.wireSha256,slot:tx.slot,blockTime:tx.blockTime,feeLamports:tx.feeLamports,actualRentLamports:'0' as const,buyerNetPaymentLamports:'0' as const,accessChanged:false as const,quotaConsumed:false as const,
    observedAccountSlot:bank.slot,proofClockUnixTimestamp:unix.toString(),source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,stateProvenance:'fresh-reviewed-deployment' as const,genesisHash:trust.expectedGenesisHash,programId:trust.programId.toBase58(),reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,upgradeAuthority:trust.upgradeAuthority?.toBase58()??null,
     accounts:Object.freeze(bank.rows.map(row=>Object.freeze({address:row.address.toBase58(),exists:true as const,owner:row.owner.toBase58(),executable:row.executable,dataSha256:hash(row.data)})))}),
    outcome:'failed' as const,transactionFailed:true as const,finalityVerified:true as const,paymentAuthorized:false as const,admissionAuthorized:false as const,signingAuthorized:false as const,broadcastAuthorized:false as const,journalClearingAuthorized:false as const});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SeekerRealmSaleFailureError('DEADLINE'));},deadlineMs);});
  try{return await Promise.race([work(),deadline]);}catch(error){if(error instanceof SeekerRealmSaleFailureError)throw error;throw new SeekerRealmSaleFailureError('UNAVAILABLE');}finally{if(timer!==undefined)clearTimeout(timer);controller.abort();finished=true;release();}
 };
}
export type SeekerRealmSaleFailureProof=Awaited<ReturnType<ReturnType<typeof createSeekerRealmSaleFailureVerifier>>>;
