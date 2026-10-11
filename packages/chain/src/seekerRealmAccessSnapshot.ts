/** Read-only realm access from one finalized bank. Reviewed fresh-deployment
 * provenance is an explicit application attestation; receipt account observation
 * is not independent verification of the original payment transaction. */
import { createHash } from 'node:crypto';
import { Connection,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { decodeProgramDataUpgradeAuthority,decodeUpgradeableProgramDataAddress } from './registryAttestation';
import { REALM_SALE_ACCOUNT_BYTES,RealmSaleProtocolError,
 realmSaleConfigPda,realmAccessPda,realmSaleReceiptPda,decodeRealmSaleConfig,decodeRealmAccess,
 decodeRealmSaleReceipt,type RealmSaleRawAccount } from './seekerRealmSaleProtocol';
import { isEconomyProgramIdentity } from './devnetTestProfile';
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR_OWNER=new PublicKey('Sysvar1111111111111111111111111111111111111');
// Transport/work bounds, never gameplay policy. Base64 RPC overhead fits under
// the wire bound; decoded accounts have individual and aggregate bounds below.
const MAX_PROGRAM_DATA=8*1024*1024,MAX_RPC_BYTES=16*1024*1024,DEADLINE_MS=60_000;
export type SeekerRealmAccessSnapshotErrorCode='INPUT'|'UNAVAILABLE'|'DEADLINE'|'IDENTITY'|'DEPLOYMENT'|'ACCOUNTS'|'RECEIPT';
export class SeekerRealmAccessSnapshotError extends Error {
 constructor(readonly code:SeekerRealmAccessSnapshotErrorCode){super(`Seeker realm access snapshot refused: ${code}`);this.name='SeekerRealmAccessSnapshotError';}
}
function need(value:unknown,code:SeekerRealmAccessSnapshotErrorCode):asserts value{if(!value)throw new SeekerRealmAccessSnapshotError(code);}
function fields(value:unknown,required:string,optional=''):void{
 need(value&&typeof value==='object'&&!Array.isArray(value),'INPUT');const names=Reflect.ownKeys(value),wanted=required.split(' ').filter(Boolean),allowed=[...wanted,...optional.split(' ').filter(Boolean)];
 need(wanted.every(n=>Object.hasOwn(value,n))&&names.every(n=>typeof n==='string'&&allowed.includes(n)),'INPUT');
}
function key(value:PublicKey,allowSystem=false):PublicKey{
 try{need(value&&typeof value.toBytes==='function'&&typeof value.toBase58==='function','INPUT');const bytes=value.toBytes();need(bytes instanceof Uint8Array&&bytes.length===32,'INPUT');const p=new PublicKey(bytes);need(p.toBase58()===value.toBase58()&&(allowSystem||!p.equals(PublicKey.default)),'INPUT');return p;}catch{throw new SeekerRealmAccessSnapshotError('INPUT');}
}
const slot=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export interface SeekerRealmAccessRpc {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(RealmSaleRawAccount|null)[]}>;
}
export interface SeekerRealmAccessTrust {
 readonly programId:PublicKey;
 readonly developer:PublicKey;
 readonly expectedGenesisHash:string;
 readonly reviewedDeploymentSlot:number;
 readonly reviewedProgramDataSha256:string;
 readonly upgradeAuthority:PublicKey|null;
 /** Retained state from an upgrade needs separately reviewed migration provenance. */
 readonly stateProvenance:'fresh-reviewed-deployment';
}
export interface SeekerRealmAccessRequest {readonly wallet:PublicKey;readonly realm:number;readonly saleId?:Uint8Array}
export interface SeekerRealmAccessSnapshotOptions {readonly deadlineMs?:number}

/** Explicit transport only: no default endpoint, redirect, retry or signer. The
 * reader's whole-operation deadline also cancels an unfinished response body. */
export function makeSeekerRealmAccessRpc(url:string,signal:AbortSignal):SeekerRealmAccessRpc{
 const connection=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
  const response=await fetch(input,{...init,signal,redirect:'error'});
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new SeekerRealmAccessSnapshotError('UNAVAILABLE');}
  need(response.body,'UNAVAILABLE');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{while(true){signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;need(total<=MAX_RPC_BYTES,'ACCOUNTS');chunks.push(chunk.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');return new Response(Buffer.concat(chunks),{status:response.status,headers});
 }});
 return {getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getMultipleAccountsInfoAndContext:async(addresses,options)=>{
  const response=await connection.getMultipleAccountsInfoAndContext(addresses,options);
  return {context:response.context,value:response.value.map((row,i)=>row===null?null:{address:addresses[i]!,owner:row.owner,executable:row.executable,data:row.data})};
 }};
}

export function createSeekerRealmAccessSnapshotReader(connect:(signal:AbortSignal)=>SeekerRealmAccessRpc,inputTrust:SeekerRealmAccessTrust,options:SeekerRealmAccessSnapshotOptions={}){
 try{
  need(typeof connect==='function','INPUT');fields(inputTrust,'programId developer expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority stateProvenance');fields(options,'','deadlineMs');
  const programId=key(inputTrust.programId),developer=key(inputTrust.developer),upgradeAuthority=inputTrust.upgradeAuthority===null?null:key(inputTrust.upgradeAuthority);
  need(isEconomyProgramIdentity(programId.toBase58())&&inputTrust.stateProvenance==='fresh-reviewed-deployment','INPUT');
  const {expectedGenesisHash,reviewedDeploymentSlot,reviewedProgramDataSha256}=inputTrust;
  need(typeof expectedGenesisHash==='string'&&expectedGenesisHash.length<=44,'INPUT');const genesis=key(new PublicKey(expectedGenesisHash));need(genesis.toBase58()===expectedGenesisHash,'INPUT');
  need(slot(reviewedDeploymentSlot)&&typeof reviewedProgramDataSha256==='string'&&/^[0-9a-f]{64}$/.test(reviewedProgramDataSha256),'INPUT');
  const deadlineMs=options.deadlineMs??DEADLINE_MS;need(Number.isSafeInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=DEADLINE_MS,'INPUT');
  const programData=PublicKey.findProgramAddressSync([programId.toBuffer()],LOADER)[0],configAddress=realmSaleConfigPda(programId);
  return async function read(input:SeekerRealmAccessRequest){
   let timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();
   try{
    fields(input,'wallet realm','saleId');const wallet=key(input.wallet),realm=input.realm,accessAddress=realmAccessPda(programId,wallet,realm);
    if(input.saleId!==undefined)need(input.saleId instanceof Uint8Array&&input.saleId.length===16&&input.saleId.some(v=>v!==0),'INPUT');
    const saleId=input.saleId===undefined?undefined:Buffer.from(input.saleId);
    // The SDK validates nonzero 16-byte IDs and realm bounds without RPC. Copy
    // first so a mutable application request cannot change the later decoder.
    const receiptAddress=saleId===undefined?null:realmSaleReceiptPda(programId,wallet,saleId);
    const addresses=[programId,programData,configAddress,accessAddress,SYSVAR_CLOCK_PUBKEY,...receiptAddress?[receiptAddress]:[]];
    const caps=[36,MAX_PROGRAM_DATA,REALM_SALE_ACCOUNT_BYTES.RealmSaleConfig,REALM_SALE_ACCOUNT_BYTES.RealmAccess,40,...receiptAddress?[REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt]:[]];
    const maxBytes=caps.reduce((a,b)=>a+b,0);
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SeekerRealmAccessSnapshotError('DEADLINE'));},deadlineMs);});
    const task=async()=>{
     const rpc=connect(controller.signal),check=()=>need(!controller.signal.aborted,'DEADLINE');
     need(await rpc.getGenesisHash()===expectedGenesisHash,'IDENTITY');check();
     const before=await rpc.getSlot('finalized');check();need(slot(before)&&before>=reviewedDeploymentSlot,'DEPLOYMENT');
     const response=await rpc.getMultipleAccountsInfoAndContext(addresses.map(p=>key(p)),{commitment:'finalized',minContextSlot:before});check();
     need(response&&slot(response.context?.slot)&&response.context.slot>=before&&Array.isArray(response.value)&&response.value.length===addresses.length,'ACCOUNTS');
     const observedSlot=response.context.slot;let total=0;
     // Copy every bounded byte and key before awaiting the closing bracket.
     // A null account is an absent fact only at the requested canonical address.
     const rows=response.value.map((row,i):RealmSaleRawAccount|null=>{
      if(row===null){need(i===3||i===5,'ACCOUNTS');return null;}
      need(row&&row.data instanceof Uint8Array&&row.data.byteLength<=caps[i]!&&typeof row.executable==='boolean','ACCOUNTS');
      total+=row.data.byteLength;need(total<=maxBytes,'ACCOUNTS');const address=key(row.address);need(address.equals(addresses[i]!),'IDENTITY');
      return {address,owner:key(row.owner,true),executable:row.executable,data:Buffer.from(row.data)};
     });
     const after=await rpc.getSlot('finalized');check();need(slot(after)&&after>=observedSlot,'ACCOUNTS');need(await rpc.getGenesisHash()===expectedGenesisHash,'IDENTITY');check();
     const executable=rows[0]!,data=rows[1]!;
     need(executable.owner.equals(LOADER)&&executable.executable===true&&executable.data.length===36&&data.owner.equals(LOADER)&&data.executable===false&&data.data.length>=45,'DEPLOYMENT');
     let actualAuthority:PublicKey|null;
     try{need(decodeUpgradeableProgramDataAddress(Buffer.from(executable.data)).equals(programData),'DEPLOYMENT');actualAuthority=decodeProgramDataUpgradeAuthority(Buffer.from(data.data));}
     catch{throw new SeekerRealmAccessSnapshotError('DEPLOYMENT');}
     need((actualAuthority?.toBase58()??null)===(upgradeAuthority?.toBase58()??null)&&Buffer.from(data.data).readBigUInt64LE(4)===BigInt(reviewedDeploymentSlot)&&digest(data.data)===reviewedProgramDataSha256,'DEPLOYMENT');
     const config=decodeRealmSaleConfig(rows[2]!,{programId,developer});
     // Anchor init accepts prefunded System PDAs. They are uninitialized,
     // never fabricated program state; malformed accounts still hit the decoder.
     const state=(row:RealmSaleRawAccount|null)=>row===null?'absent' as const:row.owner.equals(SystemProgram.programId)&&!row.executable&&row.data.length===0?'uninitialized' as const:'initialized' as const;
     const accessState=state(rows[3]!);
     const receiptState=receiptAddress?state(rows[5]!):'not-requested' as const;
     const access=accessState==='initialized'?decodeRealmAccess(rows[3]!,{programId,wallet,realm}):null;
     const clock=rows[4]!;need(clock.owner.equals(SYSVAR_OWNER)&&clock.executable===false&&clock.data.length===40,'ACCOUNTS');
     const clockBytes=Buffer.from(clock.data),unixTimestamp=clockBytes.readBigInt64LE(32);need(clockBytes.readBigUInt64LE(0)===BigInt(observedSlot)&&unixTimestamp>0n,'ACCOUNTS');
     const receipt=receiptState==='initialized'?decodeRealmSaleReceipt(rows[5]!,{programId,buyer:wallet,saleId:saleId!}):null;
     if(receipt)need(access&&receipt.realm===realm&&receipt.config===config.address&&receipt.developer===developer.toBase58()&&receipt.acceptedAt<=unixTimestamp&&receipt.expiresAt<=access.expiresAt,'RECEIPT');
     return Object.freeze({version:1 as const,wallet:wallet.toBase58(),realm,slot:observedSlot,unixTimestamp,config,access,accessState,receipt,receiptState,receiptRequested:receiptAddress!==null,
      expiresAt:access?.expiresAt??null,active:access!==null&&access.expiresAt>unixTimestamp,
      // The transaction verifier can bind this exact same-bank receipt without
      // a second RPC. Every access returns owned bytes and keys; the captured
      // source rows and attestation remain immutable and private.
      get rawReceipt():Readonly<RealmSaleRawAccount>|null{const row=receiptState==='initialized'?rows[5]:null;return row?Object.freeze({address:key(row.address),owner:key(row.owner,true),executable:row.executable,data:Buffer.from(row.data)}):null;},
      source:Object.freeze({trust:'trusted-finalized-rpc-reviewed-program' as const,stateProvenance:'fresh-reviewed-deployment' as const,genesisHash:expectedGenesisHash,
       programId:programId.toBase58(),reviewedDeploymentSlot,reviewedProgramDataSha256,upgradeAuthority:upgradeAuthority?.toBase58()??null,
       accounts:Object.freeze(rows.map((row,i)=>Object.freeze(row?{address:addresses[i]!.toBase58(),exists:true as const,owner:row.owner.toBase58(),executable:row.executable,dataSha256:digest(row.data)}:{address:addresses[i]!.toBase58(),exists:false as const})))}),
      paymentAuthorized:false as const,admissionAuthorized:false as const,transactionProofVerified:false as const});
    };
    return await Promise.race([task(),deadline]);
   }catch(error){
    if(error instanceof SeekerRealmAccessSnapshotError)throw error;
    if(error instanceof RealmSaleProtocolError)throw new SeekerRealmAccessSnapshotError(error.code==='INPUT'?'INPUT':error.code==='IDENTITY'?'IDENTITY':'ACCOUNTS');
    throw new SeekerRealmAccessSnapshotError('UNAVAILABLE');
   }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
  };
 }catch(error){if(error instanceof SeekerRealmAccessSnapshotError)throw error;throw new SeekerRealmAccessSnapshotError('INPUT');}
}
export type SeekerRealmAccessSnapshot=Awaited<ReturnType<ReturnType<typeof createSeekerRealmAccessSnapshotReader>>>;
