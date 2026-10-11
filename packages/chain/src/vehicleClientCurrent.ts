/** D182: bounded, private current checks over an already committed legacy burn.
 * Observation/send never proves consumption, installation, service or release. */
import {createHash} from 'node:crypto';
import {Connection,Message,PublicKey,type SignatureStatus} from '@solana/web3.js';
import {deserializeAssetV1,deserializeCollectionV1,Key,MPL_CORE_PROGRAM_ID,PluginType,getPluginSerializer,getPluginHeaderV1AccountDataSerializer} from '@metaplex-foundation/mpl-core';
import {getAssetV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import {getCollectionV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import {getPluginRegistryV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData';
import {createAmount,publicKey} from '@metaplex-foundation/umi';
import {PHASE_E_VEHICLE_CLIENT} from '@shardkeep/shared';
import {PhaseEVehicleMintIdentitySchema,type PhaseEVehicleMintIdentity} from '@shardkeep/shared/phaseEVehicles';
import {coreOwnershipFromAccounts} from './coreOwnership';
import {decodeUpgradeableProgramDataAddress,decodeProgramDataUpgradeAuthority} from './registryAttestation';
import {buildVehicleBurnMessage,type VehicleBurnMessageInput} from './vehicleBurnMessage';
import {buildVehicleServiceBurnMessage,type VehicleServiceBurnMessageInput} from './vehicleServiceBurnMessage';
import type {VehicleBurnCoreTrust,VehicleBurnOwnerAnchor} from './vehicleBurnFinality';
import {verifyMiningClaimSignedWire} from './miningClaimWire';

const CORE=new PublicKey(MPL_CORE_PROGRAM_ID),LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_DATA=PublicKey.findProgramAddressSync([CORE.toBuffer()],LOADER)[0];
const MAX_CODE_BYTES=8*1024*1024,MAX_ACCOUNT_BYTES=65_536,MAX_RPC_BYTES=16*1024*1024;
// D182 current-only profile; historical readers keep their accepted semantics.
const OWNERSHIP_PLUGIN_TYPES=[1,2,3,5,7,8] as const;
export type VehicleClientCurrentCode='NOT_PREPARED'|'NOT_SIGNED'|'TERMINAL'|'PAUSED'|'PROVIDER_UNAVAILABLE'|'IDENTITY'|'OWNERSHIP'|'EXPIRED_UNRESOLVED'|'INSUFFICIENT_SOL'|'FEE_LIMIT'|'OBSERVED_TRANSACTION'|'SEND_UNCERTAIN'|'TIMEOUT'|'BUSY';
export class VehicleClientCurrentError extends Error {
 readonly reservationReleaseAuthorized=false;
 constructor(readonly code:VehicleClientCurrentCode){super(`Vehicle current check held: ${code}`);this.name='VehicleClientCurrentError';}
}
function need(v:unknown,code:VehicleClientCurrentCode='IDENTITY'):asserts v{if(!v)throw new VehicleClientCurrentError(code);}
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function address(v:string){need(typeof v==='string'&&v.length>=32&&v.length<=44);const k=new PublicKey(v);need(k.toBase58()===v);return k;}
function fields(v:unknown,required:string,optional=''){
 need(v&&typeof v==='object'&&!Array.isArray(v));const names=required.split(' ').filter(Boolean),allowed=[...names,...optional.split(' ')];
 need(names.every(k=>Object.hasOwn(v,k))&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&allowed.includes(k)));
}
export interface VehicleClientCurrentReference {kind:'installation'|'service';id:string}
export type VehicleClientCurrentPrepared={status:'prepared';preparedMessageBytes:Uint8Array;anchor:VehicleBurnOwnerAnchor;
 blockhashContextSlot:number;lastValidBlockHeight:number;signedTransaction:Uint8Array|null}&(
 {kind:'installation';plan:VehicleBurnMessageInput}|{kind:'service';plan:VehicleServiceBurnMessageInput});
/** Trusted application loader must read original source, terminal and pause each
 * time. Never supply this callback from an HTTP payload or a mutable DTO. */
export type VehicleClientCurrentSaved=VehicleClientCurrentPrepared|{status:'paused'|'terminal'}|null;
export interface VehicleClientCurrentAccount {address:PublicKey;owner:PublicKey;executable:boolean;data:Uint8Array}
type Options={commitment:'finalized';minContextSlot:number};
export interface VehicleClientCurrentRpc {
 getGenesisHash():Promise<string>;
 getSlot(commitment:'finalized'):Promise<number>;
 getMultipleAccountsInfoAndContext(addresses:PublicKey[],options:Options):Promise<{context:{slot:number};value:(VehicleClientCurrentAccount|null)[]}>;
 getSignatureStatuses(signatures:string[],options:{searchTransactionHistory:true}):Promise<{context:{slot:number};value:(SignatureStatus|null)[]}>;
 getFeeForMessage(message:Message,commitment:'finalized'):Promise<{context:{slot:number};value:number|null}>;
 getBalanceAndContext(wallet:PublicKey,options:Options):Promise<{context:{slot:number};value:number}>;
 isBlockhashValid(blockhash:string,options:Options):Promise<{context:{slot:number};value:boolean}>;
 getBlockHeight(options:Options):Promise<number>;
 sendRawTransaction(wire:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number}):Promise<string>;
}
export interface VehicleClientCurrentObservation {
 genesisHash:string;core:{reviewedDeploymentSlot:number;reviewedProgramDataSha256:string;upgradeAuthority:string|null};
 ownerWallet:string;ownerSlot:number;feeSlot:number;balanceSlot:number;validitySlot:number;closingSlot:number;
 blockhash:string;lastValidBlockHeight:number;currentBlockHeight:number;blockhashValid:true;networkFeeLamports:string;payerLamports:string;
}
type Call=<T>(f:()=>Promise<T>)=>Promise<T>;
/** The SDK's convenience decoder skips unknown registry entries. Current consent
 * must hold unsupported/malformed extensions rather than silently dropping them. */
function layout(bytes:Uint8Array,collection:boolean){
 const codec=collection?getCollectionV1AccountDataSerializer():getAssetV1AccountDataSerializer();
 const [base,baseEnd]=codec.deserialize(bytes);
 need(Buffer.from(codec.serialize(base as never)).equals(Buffer.from(bytes.subarray(0,baseEnd))),'OWNERSHIP');
 if(baseEnd===bytes.length)return;
 const [header,pluginStart]=getPluginHeaderV1AccountDataSerializer().deserialize(bytes,baseEnd),registryStart=Number(header.pluginRegistryOffset);
 need(header.key===Key.PluginHeaderV1&&safe(registryStart)&&registryStart>=pluginStart&&registryStart<bytes.length,'OWNERSHIP');
 // Bound counts before the SDK allocates arrays; only six fixed ownership
 // plugins and no external adapters belong to this ordinary current profile.
 const raw=Buffer.from(bytes);need(registryStart+5<=bytes.length,'OWNERSHIP');
 const count=raw.readUInt32LE(registryStart+1);need(count<=OWNERSHIP_PLUGIN_TYPES.length,'OWNERSHIP');let at=registryStart+5;
 for(let i=0;i<count;i++){
  need(at+2<=bytes.length&&OWNERSHIP_PLUGIN_TYPES.includes(bytes[at] as typeof OWNERSHIP_PLUGIN_TYPES[number]),'OWNERSHIP');
  const authority=bytes[at+1]!;need(authority<=3,'OWNERSHIP');at+=2+(authority===3?32:0)+8;need(at<=bytes.length,'OWNERSHIP');
 }
 need(at+4===bytes.length&&raw.readUInt32LE(at)===0,'OWNERSHIP');
 const [registry,end]=getPluginRegistryV1AccountDataSerializer().deserialize(bytes,registryStart);
 need(registry.key===Key.PluginRegistryV1&&end===bytes.length&&registry.externalRegistry.length===0
  &&new Set(registry.registry.map(v=>v.pluginType)).size===registry.registry.length,'OWNERSHIP');
 let next=pluginStart;
 for(const entry of [...registry.registry].sort((a,b)=>Number(a.offset-b.offset))){
  const offset=Number(entry.offset);need(safe(offset)&&offset===next&&offset<registryStart,'OWNERSHIP');
  need(bytes[offset]===entry.pluginType,'OWNERSHIP');
  if(entry.pluginType===1||entry.pluginType===5)need(bytes[offset+1]===0||bytes[offset+1]===1,'OWNERSHIP');
  const [plugin,pluginEnd]=getPluginSerializer().deserialize(bytes,offset);
  need(pluginEnd<=registryStart&&PluginType[entry.pluginType]===plugin.__kind,'OWNERSHIP');next=pluginEnd;
 }
 need(next===registryStart,'OWNERSHIP');
}
function owner(identity:PhaseEVehicleMintIdentity,assetBytes:Uint8Array,collectionBytes:Uint8Array){
 try{
  layout(assetBytes,false);layout(collectionBytes,true);
  const row=(key:string,data:Uint8Array)=>({publicKey:publicKey(key),owner:publicKey(CORE.toBase58()),executable:false,data,lamports:createAmount(1,'SOL',9)});
  const asset=deserializeAssetV1(row(identity.assetId,assetBytes)),collection=deserializeCollectionV1(row(identity.collection,collectionBytes));
  need(asset.key===Key.AssetV1&&collection.key===Key.CollectionV1,'OWNERSHIP');
  return coreOwnershipFromAccounts(asset,collection);
 }catch{throw new VehicleClientCurrentError('OWNERSHIP');}
}
function eligible(value:ReturnType<typeof owner>,wallet:string,identity:PhaseEVehicleMintIdentity){
 return value.owner===wallet&&value.collection===identity.collection&&!value.frozen&&value.delegate===null;
}
function reference(value:VehicleClientCurrentReference){
 fields(value,'kind id');need(value.kind==='installation'||value.kind==='service');
 need(typeof value.id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id));
 return Object.freeze({kind:value.kind,id:value.id});
}
function savedCopy(value:VehicleClientCurrentSaved,ref:VehicleClientCurrentReference,trust:VehicleBurnCoreTrust){
 need(value,'NOT_PREPARED');
 if(value.status==='paused'||value.status==='terminal')throw new VehicleClientCurrentError(value.status==='paused'?'PAUSED':'TERMINAL');
 fields(value,'status kind plan preparedMessageBytes anchor blockhashContextSlot lastValidBlockHeight signedTransaction');
 need(value.status==='prepared'&&value.kind===ref.kind);
 const built=value.kind==='installation'?buildVehicleBurnMessage(value.plan):buildVehicleServiceBurnMessage(value.plan);
 need(built.reservationId===ref.id&&value.preparedMessageBytes instanceof Uint8Array&&value.preparedMessageBytes.length<=1167
  &&Buffer.from(value.preparedMessageBytes).equals(Buffer.from(built.messageBytes)));
 need(safe(value.blockhashContextSlot)&&safe(value.lastValidBlockHeight));
 fields(value.anchor,'version wallet identity slot genesisHash reviewedDeploymentSlot reviewedProgramDataSha256 assetDataHex collectionDataHex');
 const a=value.anchor,identity=PhaseEVehicleMintIdentitySchema.parse(a.identity);
 need(a.version===1&&a.wallet===built.wallet&&JSON.stringify(identity)===JSON.stringify(built.identity)
  &&safe(a.slot)&&a.slot>=trust.reviewedDeploymentSlot&&value.blockhashContextSlot>=a.slot
  &&a.genesisHash===trust.expectedGenesisHash&&a.reviewedDeploymentSlot===trust.reviewedDeploymentSlot
  &&a.reviewedProgramDataSha256===trust.reviewedProgramDataSha256);
 for(const v of [a.assetDataHex,a.collectionDataHex])need(typeof v==='string'&&v.length>0&&v.length<=MAX_ACCOUNT_BYTES*2&&v.length%2===0&&/^[0-9a-f]+$/.test(v));
 need(eligible(owner(identity,Buffer.from(a.assetDataHex,'hex'),Buffer.from(a.collectionDataHex,'hex')),built.wallet,identity),'OWNERSHIP');
 const anchor={...a,identity};
 need(value.signedTransaction===null||value.signedTransaction instanceof Uint8Array);
 const signed=value.signedTransaction===null?null:verifyMiningClaimSignedWire({wallet:address(built.wallet),intentBytes:built.messageBytes,signedTransaction:value.signedTransaction});
 const fingerprint=JSON.stringify({kind:ref.kind,id:ref.id,message:built.messageSha256,anchor,blockhashContextSlot:value.blockhashContextSlot,
  lastValidBlockHeight:value.lastValidBlockHeight,wire:signed?.wireSha256??null});
 return {built,anchor,signed,blockhashContextSlot:value.blockhashContextSlot,lastValidBlockHeight:value.lastValidBlockHeight,fingerprint};
}

export function createVehicleClientCurrent(connect:(signal:AbortSignal)=>VehicleClientCurrentRpc,inputTrust:VehicleBurnCoreTrust,
 loadSaved:(reference:VehicleClientCurrentReference)=>Promise<VehicleClientCurrentSaved>){
 fields(inputTrust,'expectedGenesisHash reviewedDeploymentSlot reviewedProgramDataSha256 upgradeAuthority');
 need(typeof connect==='function'&&typeof loadSaved==='function');const trust=Object.freeze({...inputTrust});
 address(trust.expectedGenesisHash);if(trust.upgradeAuthority!==null)address(trust.upgradeAuthority);
 need(safe(trust.reviewedDeploymentSlot)&&typeof trust.reviewedProgramDataSha256==='string'&&/^[0-9a-f]{64}$/.test(trust.reviewedProgramDataSha256));
 let pending=0;
 async function run<T>(action:(rpc:VehicleClientCurrentRpc,call:Call)=>Promise<T>):Promise<T>{
  need(pending<PHASE_E_VEHICLE_CLIENT.maxPendingRpc,'BUSY');pending++;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const active=()=>need(!controller.signal.aborted,'TIMEOUT');
  const call:Call=async fn=>{active();const value=await fn();active();return value;};
  const task=Promise.resolve().then(()=>{
   active();const raw=connect(controller.signal),methods=['getGenesisHash','getSlot','getMultipleAccountsInfoAndContext','getSignatureStatuses','getFeeForMessage','getBalanceAndContext','isBlockhashValid','getBlockHeight','sendRawTransaction'] as const;
   const rpc={} as VehicleClientCurrentRpc;
   for(const k of methods){need(typeof raw?.[k]==='function','PROVIDER_UNAVAILABLE');Object.defineProperty(rpc,k,{value:raw[k].bind(raw)});}
   return action(Object.freeze(rpc),call);
  });
  // Occupancy is owned by the underlying work, not Promise.race. An RPC ignoring
  // abort cannot free this slot or reach later calls/send when it eventually ends.
  void task.then(()=>{pending--;},()=>{pending--;});
  try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
   controller.abort();reject(new VehicleClientCurrentError('TIMEOUT'));
  },PHASE_E_VEHICLE_CLIENT.rpcTimeoutMs);})]);}
  catch(error){if(error instanceof VehicleClientCurrentError)throw error;throw new VehicleClientCurrentError('PROVIDER_UNAVAILABLE');}
  finally{if(timer)clearTimeout(timer);}
 }
 async function bank(rpc:VehicleClientCurrentRpc,call:Call,minimum:number,identities:readonly PhaseEVehicleMintIdentity[],allowMissingAssets=false){
  need(await call(()=>rpc.getGenesisHash())===trust.expectedGenesisHash);
  const opening=await call(()=>rpc.getSlot('finalized'));need(safe(opening)&&opening>=minimum&&opening>=trust.reviewedDeploymentSlot);
  const keys=[CORE,PROGRAM_DATA,...identities.flatMap(v=>[address(v.assetId),address(v.collection)])];
  const response=await call(()=>rpc.getMultipleAccountsInfoAndContext(keys.map(k=>new PublicKey(k.toBytes())),{commitment:'finalized',minContextSlot:opening}));
  need(response&&safe(response.context?.slot)&&response.context.slot>=opening&&Array.isArray(response.value)&&response.value.length===keys.length);
  const slot=response.context.slot,rows=Array.from(response.value,(row,i)=>{
   if(allowMissingAssets&&i>=2&&i%2===0&&row===null)return null;
   need(row&&row.address instanceof PublicKey&&row.address.equals(keys[i]!)&&row.owner instanceof PublicKey&&typeof row.executable==='boolean'
    &&row.data instanceof Uint8Array&&row.data.length<=(i===0?36:i===1?MAX_CODE_BYTES:MAX_ACCOUNT_BYTES),i<2?'IDENTITY':'OWNERSHIP');
   return {owner:new PublicKey(row.owner.toBytes()),executable:row.executable,data:Buffer.from(row.data)};
  });
  const program=rows[0]!,code=rows[1]!;
  need(program.owner.equals(LOADER)&&program.executable&&code.owner.equals(LOADER)&&!code.executable
   &&decodeUpgradeableProgramDataAddress(program.data).equals(PROGRAM_DATA)&&code.data.length>=45);
  need(code.data.readBigUInt64LE(4)===BigInt(trust.reviewedDeploymentSlot)&&hash(code.data)===trust.reviewedProgramDataSha256
   &&(decodeProgramDataUpgradeAuthority(code.data)?.toBase58()??null)===trust.upgradeAuthority);
  for(const row of rows.slice(2))if(row)need(row.owner.equals(CORE)&&!row.executable,'OWNERSHIP');
  const owners=identities.map((identity,i)=>{
   const asset=rows[2+i*2],collection=rows[3+i*2]!;
   // A burned/absent candidate is an exclusion only after its admitted collection
   // has itself decoded under the reviewed Core bank. Malformed data holds.
   if(!asset){
    layout(collection.data,true);
    const decoded=deserializeCollectionV1({publicKey:publicKey(identity.collection),owner:publicKey(CORE.toBase58()),executable:false,data:collection.data,lamports:createAmount(1,'SOL',9)});
    need(decoded.key===Key.CollectionV1,'OWNERSHIP');return null;
   }
   return owner(identity,asset.data,collection.data);
  });
  return {slot,owners};
 }
 async function check(rpc:VehicleClientCurrentRpc,call:Call,ref:VehicleClientCurrentReference,send:boolean){
  const saved=savedCopy(await call(()=>loadSaved(ref)),ref,trust),{built}=saved;
  if(send)need(saved.signed,'NOT_SIGNED');
  const opening=await bank(rpc,call,saved.blockhashContextSlot,[built.identity]);
  need(eligible(opening.owners[0]!,built.wallet,built.identity),'OWNERSHIP');
  const fee=await call(()=>rpc.getFeeForMessage(Message.from(built.messageBytes),'finalized'));
  need(fee&&safe(fee.context?.slot)&&fee.context.slot>=opening.slot&&safe(fee.value),'PROVIDER_UNAVAILABLE');
  const feeSlot=fee.context.slot,networkFee=fee.value;
  need(networkFee<=PHASE_E_VEHICLE_CLIENT.maxNetworkFeeLamports,'FEE_LIMIT');
  const balance=await call(()=>rpc.getBalanceAndContext(address(built.wallet),{commitment:'finalized',minContextSlot:feeSlot}));
  need(balance&&safe(balance.context?.slot)&&balance.context.slot>=feeSlot&&safe(balance.value),'PROVIDER_UNAVAILABLE');
  const balanceSlot=balance.context.slot,payer=balance.value;need(payer>=networkFee,'INSUFFICIENT_SOL');
  const valid=await call(()=>rpc.isBlockhashValid(built.blockhash,{commitment:'finalized',minContextSlot:balanceSlot}));
  need(valid&&safe(valid.context?.slot)&&valid.context.slot>=balanceSlot&&typeof valid.value==='boolean','PROVIDER_UNAVAILABLE');
  need(valid.value,'EXPIRED_UNRESOLVED');const validitySlot=valid.context.slot;
  const height=await call(()=>rpc.getBlockHeight({commitment:'finalized',minContextSlot:validitySlot}));
  need(safe(height),'PROVIDER_UNAVAILABLE');need(height<=saved.lastValidBlockHeight,'EXPIRED_UNRESOLVED');
  if(saved.signed){
   const status=await call(()=>rpc.getSignatureStatuses([saved.signed!.signature],{searchTransactionHistory:true}));
   need(status&&safe(status.context?.slot)&&status.context.slot>=validitySlot&&Array.isArray(status.value)&&status.value.length===1,'PROVIDER_UNAVAILABLE');
   need(status.value[0]===null,'OBSERVED_TRANSACTION');
   // Signature status has no commitment option. Its current-bank context may be
   // ahead of finalized; absence only fences duplicate delivery, not bank finality.
  }
  const closing=await bank(rpc,call,validitySlot,[built.identity]);need(eligible(closing.owners[0]!,built.wallet,built.identity),'OWNERSHIP');
  const current=savedCopy(await call(()=>loadSaved(ref)),ref,trust);need(current.fingerprint===saved.fingerprint);
  const observation:VehicleClientCurrentObservation={genesisHash:trust.expectedGenesisHash,core:{reviewedDeploymentSlot:trust.reviewedDeploymentSlot,
   reviewedProgramDataSha256:trust.reviewedProgramDataSha256,upgradeAuthority:trust.upgradeAuthority},ownerWallet:built.wallet,ownerSlot:opening.slot,
   feeSlot,balanceSlot,validitySlot,closingSlot:closing.slot,blockhash:built.blockhash,lastValidBlockHeight:saved.lastValidBlockHeight,currentBlockHeight:height,
   blockhashValid:true,networkFeeLamports:String(networkFee),payerLamports:String(payer)};
  return {observation,saved};
 }
 return Object.freeze({
  review(input:VehicleClientCurrentReference){const ref=reference(input);return run(async(rpc,call)=>(await check(rpc,call,ref,false)).observation);},
  deliver(input:VehicleClientCurrentReference){const ref=reference(input);return run(async(rpc,call)=>{
   const {observation,saved}=await check(rpc,call,ref,true),signed=saved.signed!;
   try{
    const signature=await call(()=>rpc.sendRawTransaction(signed.signedTransaction,{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:observation.closingSlot}));
    need(signature===signed.signature,'SEND_UNCERTAIN');return {status:'submitted' as const,signature,observation};
   }catch(error){if(error instanceof VehicleClientCurrentError)throw error;throw new VehicleClientCurrentError('SEND_UNCERTAIN');}
  });},
  scanCandidates(input:{wallet:string;identities:readonly PhaseEVehicleMintIdentity[];minContextSlot?:number}){
   fields(input,'wallet identities','minContextSlot');const wallet=address(input.wallet).toBase58();need(PublicKey.isOnCurve(address(wallet).toBytes()));
   need(Array.isArray(input.identities)&&input.identities.length<=PHASE_E_VEHICLE_CLIENT.discoveryPageSize);
   const identities=input.identities.map(v=>PhaseEVehicleMintIdentitySchema.parse(v));need(new Set(identities.map(v=>v.assetId)).size===identities.length);
   const minimum=input.minContextSlot??trust.reviewedDeploymentSlot;need(safe(minimum));
   return run(async(rpc,call)=>{
    const current=await bank(rpc,call,minimum,identities,true);
    return identities.flatMap((identity,i)=>current.owners[i]&&eligible(current.owners[i]!,wallet,identity)?[{identity,observedSlot:current.slot}]:[]);
   });
  },
 });
}

/** Configured URL only. No HTTP caller can choose a provider or override pins. */
export function vehicleClientCurrentRpcConnection(rpcUrl:string):(signal:AbortSignal)=>VehicleClientCurrentRpc {
 return signal=>{
  const connection=new Connection(rpcUrl,{commitment:'finalized',disableRetryOnRateLimit:true,
   fetch:async(input,init)=>{
    const response=await globalThis.fetch(input,{...init,signal,redirect:'error'});need(response.ok&&response.body,'PROVIDER_UNAVAILABLE');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){signal.throwIfAborted();const piece=await reader.read();if(piece.done)break;size+=piece.value.length;
     need(size<=MAX_RPC_BYTES,'PROVIDER_UNAVAILABLE');chunks.push(piece.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const headers=new Headers(response.headers);headers.delete('content-length');headers.delete('content-encoding');
    return new Response(Buffer.concat(chunks),{status:response.status,headers});
   }});
  return {
   getGenesisHash:connection.getGenesisHash.bind(connection),getSlot:connection.getSlot.bind(connection),
   async getMultipleAccountsInfoAndContext(keys,options){
    const r=await connection.getMultipleAccountsInfoAndContext(keys,options);
    return {context:r.context,value:r.value.map((v,i)=>v?{address:keys[i]!,owner:v.owner,executable:v.executable,data:v.data}:null)};
   },
   getSignatureStatuses:connection.getSignatureStatuses.bind(connection),getFeeForMessage:connection.getFeeForMessage.bind(connection),
   getBalanceAndContext:connection.getBalanceAndContext.bind(connection),isBlockhashValid:connection.isBlockhashValid.bind(connection),
   getBlockHeight:connection.getBlockHeight.bind(connection),sendRawTransaction:connection.sendRawTransaction.bind(connection),
  };
 };
}
