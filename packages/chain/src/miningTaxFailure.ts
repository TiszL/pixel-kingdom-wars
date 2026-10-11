/** Exact failed tax packet, authenticated by an application-owned finalized RPC.
 * Does not assert entitlement, payout, successful setup or permission to retry. */
import {createHash} from 'node:crypto';
import {Message,PublicKey,SYSVAR_CLOCK_PUBKEY,type VersionedTransactionResponse} from '@solana/web3.js';
import {MiningTaxClaimPreparationSchema,type MiningTaxClaimPreparation} from '@shardkeep/shared/miningTaxClaimsApi';
import {validateMiningTaxPreparationMessages} from './miningTaxPreparation';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
import {isFailedSolanaExecution} from './solanaFailedExecution';
import {decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority} from './registryAttestation';
import {MINING_PROGRAM_ADDRESS,miningConfigPda,type MiningRawAccount} from './miningProgramProtocol';
import type {MiningBackingTrust} from './miningBackingSnapshot';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR=new PublicKey('Sysvar1111111111111111111111111111111111111');
const MAX_PENDING=32,MAX_TIMEOUT=30_000,MAX_PROGRAM_DATA=8*1024*1024,U64=(1n<<64n)-1n;
type Code='INPUT'|'BUSY'|'TIMEOUT'|'UNAVAILABLE'|'TRANSACTION'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS';
export class MiningTaxFailureError extends Error{readonly journalClearingAuthorized=false;constructor(readonly code:Code){super(`Finalized tax failure unavailable: ${code}`);this.name='MiningTaxFailureError';}}
function need(v:unknown,code:Code='INPUT'):asserts v{if(!v)throw new MiningTaxFailureError(code);}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function key(v:PublicKey){need(v instanceof PublicKey);return new PublicKey(v.toBytes());}
function address(v:unknown){need(typeof v==='string'&&v.length>=32&&v.length<=44,'TRANSACTION');const k=new PublicKey(v);need(k.toBase58()===v,'TRANSACTION');return v;}
function dense(v:unknown,max:number){return Array.isArray(v)&&v.length<=max&&Object.keys(v).length===v.length&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);}
export interface MiningTaxFailureRpc{
 getGenesisHash():Promise<string>;getSlot(commitment:'finalized'):Promise<number>;
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(MiningRawAccount|null)[]}>;
}
export interface MiningTaxFailureRequest{readonly preparation:MiningTaxClaimPreparation;readonly ordinal:number;readonly signedTransaction:Uint8Array}
export interface MiningTaxFailureOptions{readonly timeoutMs?:number;readonly maxPending?:number}
function tokenRows(rows:unknown,count:number){
 need(dense(rows,2),'TRANSACTION');const out=new Map<number,string>();
 for(const r of rows as NonNullable<NonNullable<VersionedTransactionResponse['meta']>['preTokenBalances']>){
  need(r&&safe(r.accountIndex)&&r.accountIndex<count&&!out.has(r.accountIndex),'TRANSACTION');const u=r.uiTokenAmount;
  need(u&&safe(u.decimals)&&u.decimals<=255&&typeof u.amount==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(u.amount)&&BigInt(u.amount)<=U64,'TRANSACTION');
  out.set(r.accountIndex,[address(r.mint),r.owner===undefined?'':address(r.owner),r.programId===undefined?'':address(r.programId),u.decimals,u.amount].join(':'));
 }return out;
}
/** No provider serializer, logs, current cursor, status or expiry is proof. */
function failedTransaction(tx:VersionedTransactionResponse|null,intent:Uint8Array,signature:string){
 need(tx&&tx.meta&&tx.transaction,'UNAVAILABLE');const m=tx.transaction.message,meta=tx.meta;
 need(safe(tx.slot)&&safe(tx.blockTime)&&m?.version==='legacy'&&(tx.version===undefined||tx.version==='legacy'),'TRANSACTION');
 const expected=Message.from(intent),count=expected.accountKeys.length;
 need(dense(m.accountKeys,count)&&m.accountKeys.length===count&&dense(m.instructions,11)&&m.instructions.length===expected.instructions.length,'TRANSACTION');
 const h=m.header;need(h&&h.numRequiredSignatures===1&&h.numReadonlySignedAccounts===0&&safe(h.numReadonlyUnsignedAccounts)&&h.numReadonlyUnsignedAccounts<count,'TRANSACTION');
 const keys=m.accountKeys.map(key);need(new Set(keys.map(k=>k.toBase58())).size===count,'TRANSACTION');
 const instructions=m.instructions.map(ix=>{need(ix&&safe(ix.programIdIndex)&&ix.programIdIndex<count&&dense(ix.accounts,count)&&Array.from(ix.accounts).every(i=>safe(i)&&i<count)&&typeof ix.data==='string'&&ix.data.length<=1683,'TRANSACTION');return {programIdIndex:ix.programIdIndex,accounts:[...ix.accounts],data:ix.data};});
 const owned=new Message({header:{numRequiredSignatures:1,numReadonlySignedAccounts:0,numReadonlyUnsignedAccounts:h.numReadonlyUnsignedAccounts},accountKeys:keys,recentBlockhash:address(m.recentBlockhash),instructions});
 need(owned.serialize().equals(Buffer.from(intent))&&dense(tx.transaction.signatures,1)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signature,'TRANSACTION');
 need(isFailedSolanaExecution(meta.err,instructions.length,count),'TRANSACTION');
 need(!meta.loadedAddresses||(dense(meta.loadedAddresses.writable,0)&&dense(meta.loadedAddresses.readonly,0)),'TRANSACTION');
 need(safe(meta.fee)&&dense(meta.preBalances,count)&&dense(meta.postBalances,count)&&meta.preBalances.length===count&&meta.postBalances.length===count&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'TRANSACTION');
 need(meta.preBalances.every((pre,i)=>BigInt(pre)-BigInt(meta.postBalances[i]!)===(i===0?BigInt(meta.fee):0n)),'TRANSACTION');
 if(meta.preTokenBalances!==undefined||meta.postTokenBalances!==undefined){const pre=tokenRows(meta.preTokenBalances,count),post=tokenRows(meta.postTokenBalances,count);need(pre.size===post.size&&[...pre].every(([i,value])=>post.get(i)===value),'TRANSACTION');}
 // A failed non-nonce packet rolls back all rent and token/account effects. Its
 // charged fee remains a historical fact even if it exceeds old consent caps.
 return {slot:tx.slot,blockTime:tx.blockTime,feeLamports:BigInt(meta.fee).toString()};
}
export function createMiningTaxFailureVerifier(connect:(signal:AbortSignal)=>MiningTaxFailureRpc,inputTrust:MiningBackingTrust,options:MiningTaxFailureOptions={}){
 need(typeof connect==='function');const trust={programId:key(inputTrust.programId),keepMint:key(inputTrust.keepMint),reserveOwner:key(inputTrust.reserveOwner),expectedGenesisHash:address(inputTrust.expectedGenesisHash),reviewedDeploymentSlot:inputTrust.reviewedDeploymentSlot,reviewedProgramDataSha256:inputTrust.reviewedProgramDataSha256};
 need(trust.programId.toBase58()===MINING_PROGRAM_ADDRESS&&safe(trust.reviewedDeploymentSlot)&&typeof trust.reviewedProgramDataSha256==='string'&&/^[0-9a-f]{64}$/.test(trust.reviewedProgramDataSha256));
 need(options&&typeof options==='object'&&Reflect.ownKeys(options).every(k=>k==='timeoutMs'||k==='maxPending'));
 const timeout=options.timeoutMs??MAX_TIMEOUT,limit=options.maxPending??MAX_PENDING;need(safe(timeout)&&timeout>0&&timeout<=MAX_TIMEOUT&&safe(limit)&&limit>0&&limit<=MAX_PENDING);
 const pd=PublicKey.findProgramAddressSync([trust.programId.toBuffer()],LOADER)[0],addresses=[trust.programId,pd,SYSVAR_CLOCK_PUBKEY];let pending=0;
 return async function verify(value:MiningTaxFailureRequest){
  let p:MiningTaxClaimPreparation,ordinal:number,signed:ReturnType<typeof verifyMiningClaimSignedWire>,intent:Buffer;
  try{
   need(value&&typeof value==='object'&&Reflect.ownKeys(value).sort().join(',')==='ordinal,preparation,signedTransaction');p=MiningTaxClaimPreparationSchema.parse(value.preparation);ordinal=value.ordinal;need(safe(ordinal)&&ordinal<p.transactions.length);
   const i=p.identity,s=p.source;need(i.programId===trust.programId.toBase58()&&i.keepMint===trust.keepMint.toBase58()&&i.reserveOwner===trust.reserveOwner.toBase58()&&i.genesisHash===trust.expectedGenesisHash&&i.configAddress===miningConfigPda(trust.programId).toBase58()&&s.reviewedDeploymentSlot===trust.reviewedDeploymentSlot&&s.reviewedProgramDataSha256===trust.reviewedProgramDataSha256);
   validateMiningTaxPreparationMessages(p);intent=Buffer.from(p.transactions[ordinal]!.messageHex,'hex');signed=verifyMiningClaimSignedWire({intentBytes:intent,signedTransaction:value.signedTransaction,wallet:new PublicKey(p.wallet)});
  }catch{throw new MiningTaxFailureError('INPUT');}
  need(pending<limit,'BUSY');pending++;const controller=new AbortController();let calls=0,finished=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=()=>{if(finished&&calls===0&&!released){released=true;pending--;}};const active=()=>need(!controller.signal.aborted,'TIMEOUT');
  async function call<T,R=T>(run:()=>Promise<T>,copy:(v:T)=>R=(v=>v as unknown as R)){active();calls++;try{const raw=await run();active();return copy(raw);}finally{calls--;release();}}
  const work=async()=>{
   const rpc=connect(controller.signal);need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
   const tx=await call(()=>rpc.getTransaction(signed.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),raw=>failedTransaction(raw,intent,signed.signature));
   need(tx.slot>trust.reviewedDeploymentSlot&&tx.slot>=Math.max(p.source.snapshotSlot,p.source.blockhashSlot)&&BigInt(tx.blockTime)>=BigInt(p.snapshot.unixTimestamp),'TRANSACTION');
   const before=await call(()=>rpc.getSlot('finalized'));need(safe(before)&&before>=tx.slot,'ACCOUNTS');
   const bank=await call(()=>rpc.getMultipleAccountsInfoAndContext(addresses.map(key),{commitment:'finalized',minContextSlot:before}),raw=>{
    need(raw&&safe(raw.context?.slot)&&raw.context.slot>=before&&dense(raw.value,3)&&raw.value.length===3,'ACCOUNTS');const sizes=[36,MAX_PROGRAM_DATA,40];
    return {slot:raw.context.slot,rows:raw.value.map((row,j)=>{need(row&&key(row.address).equals(addresses[j]!)&&row.data instanceof Uint8Array&&row.data.length<=sizes[j]!,'ACCOUNTS');return {address:key(row.address),owner:key(row.owner),executable:row.executable,data:Buffer.from(row.data)};})};
   });
   const after=await call(()=>rpc.getSlot('finalized'));need(safe(after)&&after>=bank.slot,'ACCOUNTS');need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');
   const [program,data,clock]=bank.rows as [typeof bank.rows[number],typeof bank.rows[number],typeof bank.rows[number]];
   need(program.owner.equals(LOADER)&&program.executable===true&&program.data.length===36&&decodeUpgradeableProgramDataAddress(program.data).equals(pd),'DEPLOYMENT');
   need(data.owner.equals(LOADER)&&data.executable===false&&data.data.length>=45&&hash(data.data)===trust.reviewedProgramDataSha256&&data.data.readBigUInt64LE(4)===BigInt(trust.reviewedDeploymentSlot),'DEPLOYMENT');decodeProgramDataUpgradeAuthority(data.data);
   need(clock.owner.equals(SYSVAR)&&clock.executable===false&&clock.data.length===40&&clock.data.readBigUInt64LE(0)===BigInt(bank.slot)&&clock.data.readBigInt64LE(32)>=BigInt(tx.blockTime),'ACCOUNTS');
   return Object.freeze({version:1 as const,wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,round:p.round,spot:p.spot,ordinal,kind:p.transactions[ordinal]!.kind,signature:signed.signature,messageSha256:signed.messageSha256,signedTransactionSha256:signed.wireSha256,slot:tx.slot,blockTime:tx.blockTime,feeLamports:tx.feeLamports,rentLamports:'0' as const,paidKeepBaseUnits:'0' as const,
    source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,genesisHash:trust.expectedGenesisHash,programId:trust.programId.toBase58(),configAddress:p.identity.configAddress,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,snapshotSha256:p.source.snapshotSha256,snapshotSlot:p.source.snapshotSlot,blockhashSlot:p.source.blockhashSlot,observedAccountSlot:bank.slot}),
    outcome:'failed' as const,finalityAuthenticated:true as const,paymentAuthorized:false as const,signingAuthorized:false as const,broadcastAuthorized:false as const,journalClearingAuthorized:false as const});
  };
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MiningTaxFailureError('TIMEOUT'));},timeout);});
  try{return await Promise.race([work(),deadline]);}catch(error){if(error instanceof MiningTaxFailureError)throw error;throw new MiningTaxFailureError('UNAVAILABLE');}finally{if(timer)clearTimeout(timer);controller.abort();finished=true;release();}
 };
}
export type MiningTaxFailureReceipt=Awaited<ReturnType<ReturnType<typeof createMiningTaxFailureVerifier>>>;
