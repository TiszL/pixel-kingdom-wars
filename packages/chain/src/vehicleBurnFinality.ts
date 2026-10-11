/** D-153.125: application-owned finalized Core ownership and burn recovery.
 * Saved reservations come only from a private application loader. Address-index
 * completeness is explicitly configured-provider trust, not a cryptographic
 * completeness proof. Neither mint registration nor installation is authorized. */
import {createHash} from 'node:crypto';
import {Connection,Message,MessageV0,PublicKey,VersionedTransaction,type VersionedTransactionResponse,type ConfirmedSignatureInfo} from '@solana/web3.js';
import {deserializeAssetV1,deserializeCollectionV1,MPL_CORE_PROGRAM_ID,Key,getTransferV1InstructionDataSerializer} from '@metaplex-foundation/mpl-core';
import {createAmount,publicKey} from '@metaplex-foundation/umi';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import bs58 from 'bs58';
import {decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority} from './registryAttestation';
import {coreOwnershipFromAccounts} from './coreOwnership';
import {buildVehicleBurnMessage,type VehicleBurnMessageInput} from './vehicleBurnMessage';
import {verifyVehicleBurnEvidence,verifyVehicleServiceBurnEvidence,type VehicleBurnEvidence} from './vehicleBurnEvidence';
import {buildVehicleServiceBurnMessage,type VehicleServiceBurnMessageInput} from './vehicleServiceBurnMessage';
import {verifyMiningClaimSignedWire} from './miningClaimWire';
const CORE=new PublicKey(MPL_CORE_PROGRAM_ID),LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA=PublicKey.findProgramAddressSync([CORE.toBuffer()],LOADER)[0];
// Operational work/transport bounds, not game numbers. Exhaustion always holds.
const DEADLINE_MS=60_000,MAX_PENDING=8,MAX_RPC_BYTES=16*1024*1024,MAX_CODE_BYTES=8*1024*1024,MAX_ACCOUNT_BYTES=65_536,MAX_ROWS=2_000,MAX_BLOCK_ROWS=50_000;
type Code='INPUT'|'RESERVATION'|'IDENTITY'|'DEPLOYMENT'|'OWNERSHIP'|'HISTORY'|'UNSUPPORTED'|'UNAVAILABLE'|'DEADLINE'|'BUSY';
export class VehicleBurnFinalityError extends Error {
 readonly reservationReleaseAuthorized=false;
 constructor(readonly code:Code){super(`Vehicle burn finality refused: ${code}`);this.name='VehicleBurnFinalityError';}
}
function need(v:unknown,code:Code):asserts v{if(!v)throw new VehicleBurnFinalityError(code);}
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function fields(v:unknown,required:string,optional=''){
 need(v&&typeof v==='object'&&!Array.isArray(v),'INPUT');const req=required.split(' ').filter(Boolean),allowed=[...req,...optional.split(' ')];
 need(req.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&allowed.includes(k)),'INPUT');
}
function address(v:string){need(typeof v==='string'&&v.length>=32&&v.length<=44,'INPUT');const p=new PublicKey(v);need(p.toBase58()===v,'INPUT');return p;}
function signature(v:unknown):v is string{try{return typeof v==='string'&&v.length<=88&&bs58.decode(v).length===64&&bs58.encode(bs58.decode(v))===v;}catch{return false;}}
function uuid(v:unknown):v is string{return typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);}
export interface VehicleBurnCoreTrust {expectedGenesisHash:string;reviewedDeploymentSlot:number;reviewedProgramDataSha256:string;upgradeAuthority:string|null}
interface RawAccount {address:PublicKey;owner:PublicKey;executable:boolean;data:Uint8Array}
export interface VehicleBurnFinalityRpc {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:{commitment:'finalized';minContextSlot:number}):Promise<{context:{slot:number};value:(RawAccount|null)[]}>;
 getSignaturesForAddress(address:PublicKey,options:{limit:number;minContextSlot:number;before?:string},commitment:'finalized'):Promise<ConfirmedSignatureInfo[]>;
 getTransaction(signature:string,options:{commitment:'finalized';maxSupportedTransactionVersion:0}):Promise<VersionedTransactionResponse|null>;
 getBlockSignatures(slot:number,commitment:'finalized'):Promise<{signatures:string[]}>;
}
export interface VehicleBurnOwnerAnchor {
 version:1;wallet:string;identity:PhaseEVehicleMintIdentity;slot:number;genesisHash:string;reviewedDeploymentSlot:number;reviewedProgramDataSha256:string;
 assetDataHex:string;collectionDataHex:string;
}
/** This loader is trusted application code over committed private records, never
 * an HTTP callback or a caller-provided anchor. Rehydration retains this trust. */
interface SavedBurn<Plan> {plan:Plan;preparedMessageBytes:Uint8Array;anchor:VehicleBurnOwnerAnchor}
export interface VehicleBurnSavedReservation extends SavedBurn<VehicleBurnMessageInput> {}
export interface VehicleServiceBurnSavedReservation extends SavedBurn<VehicleServiceBurnMessageInput> {}
type Call=<T>(fn:()=>Promise<T>)=>Promise<T>;

function decodeOwner(identity:PhaseEVehicleMintIdentity,wallet:string,assetBytes:Uint8Array,collectionBytes:Uint8Array){
 const row=(address:string,data:Uint8Array)=>({publicKey:publicKey(address),owner:publicKey(CORE.toBase58()),executable:false,data,lamports:createAmount(1,'SOL',9)});
 const asset=deserializeAssetV1(row(identity.assetId,assetBytes)),collection=deserializeCollectionV1(row(identity.collection,collectionBytes));
 need(asset.key===Key.AssetV1&&collection.key===Key.CollectionV1,'OWNERSHIP');
 const owner=coreOwnershipFromAccounts(asset,collection);
 need(owner.owner===wallet&&owner.collection===identity.collection&&!owner.frozen&&owner.delegate===null,'OWNERSHIP');
}
function copyAnchor(value:VehicleBurnOwnerAnchor,plan:Pick<ReturnType<typeof buildVehicleBurnMessage>,'wallet'|'identity'>,trust:VehicleBurnCoreTrust){
 fields(value,'version wallet identity slot genesisHash reviewedDeploymentSlot reviewedProgramDataSha256 assetDataHex collectionDataHex');
 need(value.version===1&&value.wallet===plan.wallet&&safe(value.slot)&&value.slot>=trust.reviewedDeploymentSlot
  &&value.genesisHash===trust.expectedGenesisHash&&value.reviewedDeploymentSlot===trust.reviewedDeploymentSlot
  &&value.reviewedProgramDataSha256===trust.reviewedProgramDataSha256,'RESERVATION');
 const identity=PhaseEVehicleMintIdentitySchema.parse(value.identity);need(JSON.stringify(identity)===JSON.stringify(plan.identity),'RESERVATION');
 for(const bytes of [value.assetDataHex,value.collectionDataHex])need(typeof bytes==='string'&&bytes.length>0&&bytes.length<=MAX_ACCOUNT_BYTES*2&&bytes.length%2===0&&/^[0-9a-f]+$/.test(bytes),'RESERVATION');
 const copy={...value,identity};decodeOwner(identity,copy.wallet,Buffer.from(copy.assetDataHex,'hex'),Buffer.from(copy.collectionDataHex,'hex'));return copy;
}

/** Rebuild ordinary history bodies from bounded raw fields before another await.
 * The endpoint authenticates these observations; message methods never do. */
function copyHistory(tx:VersionedTransactionResponse|null,expected:string,slot:number):VersionedTransactionResponse{
 need(tx&&tx.meta&&tx.slot===slot&&safe(slot),'HISTORY');const raw=tx.transaction?.message,meta=tx.meta;
 need(raw&&raw.header&&['legacy',0].includes(raw.version)&&(tx.version===undefined||tx.version===raw.version),'HISTORY');
 const header={...raw.header};need(Object.values(header).every(safe),'HISTORY');
 const keys=raw.version==='legacy'?raw.accountKeys:raw.staticAccountKeys;
 need(Array.isArray(keys)&&keys.length>0&&keys.length<=256,'HISTORY');const copiedKeys=Array.from(keys,k=>{need(k instanceof PublicKey,'HISTORY');return new PublicKey(k.toBytes());});
 need(typeof raw.recentBlockhash==='string'&&address(raw.recentBlockhash).toBase58()===raw.recentBlockhash,'HISTORY');
 const copiedLoaded={readonly:[] as PublicKey[],writable:[] as PublicKey[]};
 if(meta.loadedAddresses){for(const part of ['readonly','writable'] as const){need(Array.isArray(meta.loadedAddresses[part])&&meta.loadedAddresses[part].length<=256,'HISTORY');copiedLoaded[part]=Array.from(meta.loadedAddresses[part],k=>{need(k instanceof PublicKey,'HISTORY');return new PublicKey(k.toBytes());});}}
 const count=copiedKeys.length+copiedLoaded.readonly.length+copiedLoaded.writable.length;need(count<=256,'HISTORY');
 const index=(n:number)=>{need(safe(n)&&n<count,'HISTORY');return n;};let message:Message|MessageV0;
 if(raw.version==='legacy'){
  need(copiedLoaded.readonly.length===0&&copiedLoaded.writable.length===0&&Array.isArray(raw.instructions)&&raw.instructions.length<=256,'HISTORY');
  message=new Message({header,accountKeys:copiedKeys,recentBlockhash:raw.recentBlockhash,instructions:Array.from(raw.instructions,ix=>{
   need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=256,'HISTORY');const data=bs58.decode(ix.data);need(bs58.encode(data)===ix.data,'HISTORY');
   return {programIdIndex:index(ix.programIdIndex),accounts:Array.from(ix.accounts,index),data:ix.data};
  })});
 }else{
  need(Array.isArray(raw.compiledInstructions)&&raw.compiledInstructions.length<=256&&Array.isArray(raw.addressTableLookups)&&raw.addressTableLookups.length<=32,'HISTORY');
  message=new MessageV0({header,staticAccountKeys:copiedKeys,recentBlockhash:raw.recentBlockhash,
   compiledInstructions:Array.from(raw.compiledInstructions,ix=>{
    need(ix&&ix.data instanceof Uint8Array&&ix.data.length<=1232&&Array.isArray(ix.accountKeyIndexes)&&ix.accountKeyIndexes.length<=256,'HISTORY');
    return {programIdIndex:index(ix.programIdIndex),accountKeyIndexes:Array.from(ix.accountKeyIndexes,index),data:Uint8Array.from(ix.data)};
   }),addressTableLookups:Array.from(raw.addressTableLookups,lookup=>{
    need(lookup&&lookup.accountKey instanceof PublicKey&&Array.isArray(lookup.readonlyIndexes)&&Array.isArray(lookup.writableIndexes)
     &&lookup.readonlyIndexes.length+lookup.writableIndexes.length<=256,'HISTORY');
    const at=(n:number)=>{need(safe(n)&&n<256,'HISTORY');return n;};return {accountKey:new PublicKey(lookup.accountKey.toBytes()),readonlyIndexes:Array.from(lookup.readonlyIndexes,at),writableIndexes:Array.from(lookup.writableIndexes,at)};
   })});
 }
 need(message.serialize().length<=1232&&header.numRequiredSignatures>0&&header.numRequiredSignatures<=copiedKeys.length
  &&header.numReadonlySignedAccounts<=header.numRequiredSignatures&&header.numReadonlyUnsignedAccounts<=copiedKeys.length-header.numRequiredSignatures,'HISTORY');
 if(message.version===0)need(message.addressTableLookups.reduce((n,l)=>n+l.writableIndexes.length,0)===copiedLoaded.writable.length
  &&message.addressTableLookups.reduce((n,l)=>n+l.readonlyIndexes.length,0)===copiedLoaded.readonly.length,'HISTORY');
 const all=message.getAccountKeys({accountKeysFromLookups:copiedLoaded});need(all.length===count,'HISTORY');
 need(Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===header.numRequiredSignatures
  &&tx.transaction.signatures[0]===expected&&Array.from(tx.transaction.signatures).every(signature),'HISTORY');
 need(meta.err===null||meta.err!==undefined&&typeof meta.err==='object','HISTORY');const err=JSON.stringify(meta.err);need(err.length<=4096,'HISTORY');
 need(meta.err!==null||Array.isArray(meta.innerInstructions),'HISTORY');
 const inner=meta.innerInstructions??[];need(Array.isArray(inner)&&inner.length<=256,'HISTORY');let total=0;
 const innerInstructions=Array.from(inner,group=>{
  need(group&&safe(group.index)&&group.index<message.compiledInstructions.length&&Array.isArray(group.instructions),'HISTORY');total+=group.instructions.length;need(total<=256,'HISTORY');
  return {index:group.index,instructions:Array.from(group.instructions,ix=>{
   need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=256,'HISTORY');const bytes=bs58.decode(ix.data);need(bs58.encode(bytes)===ix.data,'HISTORY');
   return {programIdIndex:index(ix.programIdIndex),accounts:Array.from(ix.accounts,index),data:ix.data};
  })};
 });
 // Burn evidence also needs exact balances/fee. Copy and bound these rather than
 // substituting ownership-only dummy metadata for a candidate burn.
 need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===count&&meta.postBalances.length===count
  &&Array.from(meta.preBalances).every(safe)&&Array.from(meta.postBalances).every(safe),'HISTORY');
 for(const b of [meta.preTokenBalances,meta.postTokenBalances])need(b===null||b===undefined||Array.isArray(b)&&b.length===0,'UNSUPPORTED');
 need(tx.blockTime===null||tx.blockTime===undefined||safe(tx.blockTime),'HISTORY');
 return {slot,blockTime:tx.blockTime??null,version:message.version,transaction:{message,signatures:[...tx.transaction.signatures]},
  meta:{err:JSON.parse(err),fee:meta.fee,preBalances:[...meta.preBalances],postBalances:[...meta.postBalances],innerInstructions,loadedAddresses:copiedLoaded}};
}
function replayOwner(tx:VersionedTransactionResponse,asset:string,collection:string,owner:string){
 if(tx.meta!.err!==null)return owner;const message=tx.transaction.message,keys=message.getAccountKeys({accountKeysFromLookups:tx.meta!.loadedAddresses!});
 const at=(i:number)=>keys.get(i)!.toBase58();
 for(const group of tx.meta!.innerInstructions!)for(const ix of group.instructions)
  if(keys.get(ix.programIdIndex)!.equals(CORE)&&ix.accounts.some(i=>at(i)===asset))throw new VehicleBurnFinalityError('UNSUPPORTED');
 for(const ix of message.compiledInstructions){
  if(!keys.get(ix.programIdIndex)!.equals(CORE)||!ix.accountKeyIndexes.some(i=>at(i)===asset))continue;
  need(ix.data.length===2&&ix.data[0]===14&&ix.data[1]===0&&ix.accountKeyIndexes.length===7
   &&at(ix.accountKeyIndexes[0]!)===asset&&at(ix.accountKeyIndexes[1]!)===collection,'UNSUPPORTED');
  const [,offset]=getTransferV1InstructionDataSerializer().deserialize(ix.data);need(offset===ix.data.length,'UNSUPPORTED');
  need(message.isAccountWritable(ix.accountKeyIndexes[0]!)&&message.isAccountSigner(ix.accountKeyIndexes[2]!)
   &&(at(ix.accountKeyIndexes[3]!)===CORE.toBase58()||message.isAccountSigner(ix.accountKeyIndexes[3]!)),'UNSUPPORTED');
  owner=at(ix.accountKeyIndexes[4]!);need(owner!==CORE.toBase58(),'UNSUPPORTED');
 }
 return owner;
}

type BurnProof=Omit<VehicleBurnEvidence,'version'>;
type CompiledBurn<Proof extends BurnProof>={plan:ReturnType<typeof buildVehicleBurnMessage>;verify:(tx:VersionedTransactionResponse,signed:Uint8Array)=>Proof};
// Module-private fixed codecs own all values before the next provider await.
function installationCodec(input:VehicleBurnMessageInput){
 const plan=buildVehicleBurnMessage(input),owned={wallet:plan.wallet,identity:plan.identity,reservationId:plan.reservationId,blockhash:plan.blockhash};
 return {plan,verify:(tx:VersionedTransactionResponse,signed:Uint8Array)=>verifyVehicleBurnEvidence(tx,{plan:owned,preparedMessageBytes:plan.messageBytes,signedTransaction:signed})};
}
function serviceCodec(input:VehicleServiceBurnMessageInput){
 const plan=buildVehicleServiceBurnMessage(input),s=plan.service;
 const service=Object.freeze({operation:s.operation,installationId:s.installationId,baseId:s.baseId,berthId:s.berthId,revision:s.revision,
  family:s.family,tier:s.tier,completedTotal:s.completedTotal,allowanceStart:s.allowanceStart});
 const owned=Object.freeze({wallet:plan.wallet,identity:plan.identity,reservationId:plan.reservationId,blockhash:plan.blockhash,service});
 return {plan,verify:(tx:VersionedTransactionResponse,signed:Uint8Array)=>verifyVehicleServiceBurnEvidence(tx,{plan:owned,preparedMessageBytes:plan.messageBytes,signedTransaction:signed})};
}
export function createVehicleBurnFinalityReader(connect:(signal:AbortSignal)=>VehicleBurnFinalityRpc,inputTrust:VehicleBurnCoreTrust,
 loadSavedReservation:(reservationId:string)=>Promise<VehicleBurnSavedReservation|null>,options:{deadlineMs?:number}={}){
 return createFinalityReader(connect,inputTrust,loadSavedReservation,options,installationCodec);
}
export function createVehicleServiceBurnFinalityReader(connect:(signal:AbortSignal)=>VehicleBurnFinalityRpc,inputTrust:VehicleBurnCoreTrust,
 loadSavedReservation:(reservationId:string)=>Promise<VehicleServiceBurnSavedReservation|null>,options:{deadlineMs?:number}={}){
 return createFinalityReader(connect,inputTrust,loadSavedReservation,options,serviceCodec);
}
function createFinalityReader<Plan,Proof extends BurnProof>(connect:(signal:AbortSignal)=>VehicleBurnFinalityRpc,inputTrust:VehicleBurnCoreTrust,
 loadSavedReservation:(reservationId:string)=>Promise<SavedBurn<Plan>|null>,options:{deadlineMs?:number},compile:(input:Plan)=>CompiledBurn<Proof>){
 fields(inputTrust,'expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority');fields(options,'','deadlineMs');
 need(typeof connect==='function'&&typeof loadSavedReservation==='function','INPUT');
 const trust={...inputTrust};address(trust.expectedGenesisHash);if(trust.upgradeAuthority!==null)address(trust.upgradeAuthority);
 need(safe(trust.reviewedDeploymentSlot)&&typeof trust.reviewedProgramDataSha256==='string'&&trust.reviewedProgramDataSha256.length===64&&/^[0-9a-f]+$/.test(trust.reviewedProgramDataSha256),'INPUT');
 const deadlineMs=options.deadlineMs??DEADLINE_MS;need(safe(deadlineMs)&&deadlineMs>0&&deadlineMs<=DEADLINE_MS,'INPUT');let pending=0;
 async function run<T>(action:(rpc:VehicleBurnFinalityRpc,call:Call)=>Promise<T>):Promise<T>{
  need(pending<MAX_PENDING,'BUSY');pending++;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,done=false,released=false;
  const outstanding=new Set<Promise<unknown>>(),release=()=>{if(done&&!released&&outstanding.size===0){released=true;pending--;}};
  const active=()=>need(!controller.signal.aborted,'DEADLINE');
  const call:Call=async fn=>{active();const p=Promise.resolve().then(()=>{active();return fn();});outstanding.add(p);try{const v=await p;active();return v;}finally{outstanding.delete(p);release();}};
  const task=Promise.resolve().then(()=>action(connect(controller.signal),call));
  try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new VehicleBurnFinalityError('DEADLINE'));},deadlineMs);})]);}
  catch(error){if(error instanceof VehicleBurnFinalityError)throw error;throw new VehicleBurnFinalityError('UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);done=true;release();}
 }
 async function bank(rpc:VehicleBurnFinalityRpc,call:Call,minimum:number,identity?:PhaseEVehicleMintIdentity){
  need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');const opening=await call(()=>rpc.getSlot('finalized'));
  need(safe(opening)&&opening>=minimum&&opening>=trust.reviewedDeploymentSlot,'DEPLOYMENT');
  const addresses=[CORE,PROGRAM_DATA,...identity?[address(identity.assetId),address(identity.collection)]:[]],caps=[36,MAX_CODE_BYTES,MAX_ACCOUNT_BYTES,MAX_ACCOUNT_BYTES];
  const response=await call(()=>rpc.getMultipleAccountsInfoAndContext(addresses.map(k=>new PublicKey(k.toBytes())),{commitment:'finalized',minContextSlot:opening}));
  need(response&&safe(response.context?.slot)&&response.context.slot>=opening&&Array.isArray(response.value)&&response.value.length===addresses.length,'DEPLOYMENT');const observed=response.context.slot;
  const rows=Array.from(response.value,(row,i)=>{need(row&&row.address instanceof PublicKey&&row.address.equals(addresses[i]!)&&row.owner instanceof PublicKey
   &&typeof row.executable==='boolean'&&row.data instanceof Uint8Array&&row.data.length<=caps[i]!,'DEPLOYMENT');
   return {address:new PublicKey(row.address.toBytes()),owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};});
  const executable=rows[0]!,code=rows[1]!;
  need(executable.owner.equals(LOADER)&&executable.executable&&!code.executable&&code.owner.equals(LOADER)
   &&decodeUpgradeableProgramDataAddress(executable.data).equals(PROGRAM_DATA)&&code.data.length>=45,'DEPLOYMENT');
  need(code.data.readBigUInt64LE(4)===BigInt(trust.reviewedDeploymentSlot)&&hash(code.data)===trust.reviewedProgramDataSha256
   &&(decodeProgramDataUpgradeAuthority(code.data)?.toBase58()??null)===trust.upgradeAuthority,'DEPLOYMENT');
  for(const row of rows.slice(2))need(row.owner.equals(CORE)&&!row.executable,'OWNERSHIP');
  const closing=await call(()=>rpc.getSlot('finalized'));need(safe(closing)&&closing>=observed,'DEPLOYMENT');
  need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash,'IDENTITY');return {slot:observed,rows};
 }
 return Object.freeze({
  async captureOwner(input:{wallet:string;identity:PhaseEVehicleMintIdentity}){
   fields(input,'wallet identity');const wallet=address(input.wallet).toBase58(),identity=PhaseEVehicleMintIdentitySchema.parse(input.identity);
   need(PublicKey.isOnCurve(address(wallet).toBytes())&&wallet!==identity.assetId&&wallet!==identity.collection,'INPUT');
   return run(async(rpc,call)=>{const snapshot=await bank(rpc,call,trust.reviewedDeploymentSlot,identity),asset=snapshot.rows[2]!.data,collection=snapshot.rows[3]!.data;
    decodeOwner(identity,wallet,asset,collection);return Object.freeze({version:1 as const,wallet,identity:Object.freeze(identity),slot:snapshot.slot,
     genesisHash:trust.expectedGenesisHash,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,
     assetDataHex:asset.toString('hex'),collectionDataHex:collection.toString('hex')});});
  },
  async verify(input:{reservationId:string;signedTransaction?:Uint8Array}){
   fields(input,'reservationId','signedTransaction');need(uuid(input.reservationId),'INPUT');const reservationId=input.reservationId;
   need(input.signedTransaction===undefined||input.signedTransaction instanceof Uint8Array&&input.signedTransaction.length>65&&input.signedTransaction.length<=1232,'INPUT');
   const provided=input.signedTransaction===undefined?undefined:Uint8Array.from(input.signedTransaction);
   return run(async(rpc,call)=>{
    const saved=await call(()=>loadSavedReservation(reservationId));need(saved,'RESERVATION');fields(saved,'plan preparedMessageBytes anchor');
    let compiled:CompiledBurn<Proof>,plan:ReturnType<typeof buildVehicleBurnMessage>,anchor:VehicleBurnOwnerAnchor;
    try{compiled=compile(saved.plan);plan=compiled.plan;need(plan.reservationId===reservationId&&saved.preparedMessageBytes instanceof Uint8Array
     &&saved.preparedMessageBytes.length<=1232&&Buffer.from(saved.preparedMessageBytes).equals(Buffer.from(plan.messageBytes)),'RESERVATION');anchor=copyAnchor(saved.anchor,plan,trust);}
    catch{throw new VehicleBurnFinalityError('RESERVATION');}
    const expected=provided?verifyMiningClaimSignedWire({wallet:address(plan.wallet),intentBytes:plan.messageBytes,signedTransaction:provided}).signature:null;
    const opening=await bank(rpc,call,anchor.slot),through=opening.slot;
    const rows:ConfirmedSignatureInfo[]=[],seen=new Set<string>();let previous=Number.MAX_SAFE_INTEGER,before:string|undefined,reached=false;
    for(let page=0;page<20&&!reached;page++){
     const raw=await call(()=>rpc.getSignaturesForAddress(address(plan.identity.assetId),{limit:1000,minContextSlot:through,...before?{before}:{}},'finalized'));
     need(Array.isArray(raw)&&raw.length<=1000,'HISTORY');
     for(const row of raw){need(row&&signature(row.signature)&&safe(row.slot)&&row.slot<=previous&&!seen.has(row.signature)
      &&(row.blockTime===null||row.blockTime===undefined||safe(row.blockTime))&&(row.confirmationStatus===undefined||row.confirmationStatus==='finalized')&&(row.err===null||row.err!==undefined&&typeof row.err==='object'),'HISTORY');
      previous=row.slot;seen.add(row.signature);if(row.slot<=anchor.slot)reached=true;
      else if(row.slot<=through){const err=JSON.stringify(row.err);need(err.length<=4096,'HISTORY');rows.push({signature:row.signature,slot:row.slot,err:JSON.parse(err),memo:null,blockTime:row.blockTime??null,confirmationStatus:'finalized'});need(rows.length<=MAX_ROWS,'HISTORY');}}
     if(!reached&&raw.length<1000)throw new VehicleBurnFinalityError('HISTORY');before=raw.at(-1)?.signature;
    }
    need(reached,'HISTORY');const orders=new Map<number,string[]>();let blockRows=0;const ordered:{tx:VersionedTransactionResponse;index:number;signature:string}[]=[];
    let burn:{proof:Proof;index:number}|undefined;
    for(const row of rows){
     const tx=copyHistory(await call(()=>rpc.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0})),row.signature,row.slot);
     need(JSON.stringify(tx.meta!.err)===JSON.stringify(row.err)&&(row.blockTime===null||row.blockTime===undefined||row.blockTime===tx.blockTime),'HISTORY');
     const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta!.loadedAddresses!});
     need(Array.from({length:keys.length},(_,i)=>keys.get(i)!.toBase58()).includes(plan.identity.assetId),'HISTORY');
     let order=orders.get(row.slot);if(!order){const block=await call(()=>rpc.getBlockSignatures(row.slot,'finalized'));
      need(block&&Array.isArray(block.signatures),'HISTORY');blockRows+=block.signatures.length;
      need(blockRows<=MAX_BLOCK_ROWS&&Array.from(block.signatures).every(signature)
       &&new Set(block.signatures).size===block.signatures.length,'HISTORY');order=[...block.signatures];orders.set(row.slot,order);}
     const index=order.indexOf(row.signature);need(index>=0,'HISTORY');ordered.push({tx,index,signature:row.signature});
     if(tx.transaction.message.version==='legacy'&&tx.transaction.message.serialize().equals(Buffer.from(plan.messageBytes))){
      need(!burn&&(!expected||expected===row.signature),'HISTORY');const signed=provided??new VersionedTransaction(tx.transaction.message,tx.transaction.signatures.map(s=>bs58.decode(s))).serialize();
      const proof=compiled.verify(tx,signed);
      burn={proof,index};
     }
    }
    need(burn,'HISTORY');need(burn.proof.slot>anchor.slot,'OWNERSHIP');
    ordered.sort((a,b)=>a.tx.slot-b.tx.slot||a.index-b.index);let owner=anchor.wallet;
    const history:{signature:string;slot:number;transactionIndex:number;ownerAfter:string}[]=[];
    for(const row of ordered){if(row.tx.slot>burn.proof.slot||row.tx.slot===burn.proof.slot&&row.index>=burn.index)break;
     owner=replayOwner(row.tx,plan.identity.assetId,plan.identity.collection,owner);history.push({signature:row.signature,slot:row.tx.slot,transactionIndex:row.index,ownerAfter:owner});}
    need(owner===plan.wallet,'OWNERSHIP');const closing=await bank(rpc,call,through);
    const {finalityVerified:_finality,preBurnOwnershipVerified:_ownership,...transactionProof}=burn.proof;
    return Object.freeze({...transactionProof,finalityVerified:true as const,preBurnOwnershipVerified:true as const,preBurnOwner:owner,
     finalizedThroughSlot:closing.slot,anchorSlot:anchor.slot,history:Object.freeze(history.map(h=>Object.freeze(h))),
     source:Object.freeze({genesisHash:trust.expectedGenesisHash,reviewedDeploymentSlot:trust.reviewedDeploymentSlot,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,
      upgradeAuthority:trust.upgradeAuthority,addressIndexCompleteness:'configured-provider-trust' as const,savedAnchorAuthority:'private-application-reservation' as const})});
   });
  },
 });
}

/** Explicit endpoint, abortable whole-response budget, no retry, redirect,
 * signer or send method. Application trust and feature flags remain separate. */
export function makeVehicleBurnFinalityRpc(url:string,signal:AbortSignal):VehicleBurnFinalityRpc{
 const connection=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(input,init)=>{
  const response=await fetch(input,{...init,signal,redirect:'error'});need(response.ok&&response.body,'UNAVAILABLE');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){signal.throwIfAborted();const piece=await reader.read();if(piece.done)break;size+=piece.value.length;need(size<=MAX_RPC_BYTES,'UNAVAILABLE');chunks.push(piece.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');return new Response(Buffer.concat(chunks),{status:response.status,headers});
 }});
 return {getGenesisHash:()=>connection.getGenesisHash(),getSlot:c=>connection.getSlot(c),getTransaction:(s,o)=>connection.getTransaction(s,o),
  getSignaturesForAddress:(a,o,c)=>connection.getSignaturesForAddress(a,o,c),getBlockSignatures:(s,c)=>connection.getBlockSignatures(s,c),
  getMultipleAccountsInfoAndContext:async(addresses,options)=>{const r=await connection.getMultipleAccountsInfoAndContext(addresses,options);
   return {context:r.context,value:r.value.map((v,i)=>v===null?null:{address:addresses[i]!,owner:v.owner,executable:v.executable,data:v.data})};}};
}
