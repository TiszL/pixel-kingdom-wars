import vectors from './testFixtures/vehicleClientCurrent.json';
import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {Keypair,Message,PublicKey,VersionedTransaction} from '@solana/web3.js';
import {Key,MPL_CORE_PROGRAM_ID,PluginType,getPluginSerializer,getPluginHeaderV1AccountDataSerializer} from '@metaplex-foundation/mpl-core';
import {getAssetV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import {getCollectionV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import {getPluginRegistryV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/pluginRegistryV1AccountData';
import {publicKey} from '@metaplex-foundation/umi';
import {PHASE_E_VEHICLE_CLIENT} from '@shardkeep/shared';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
import {buildVehicleServiceBurnMessage} from './vehicleServiceBurnMessage';
import {createVehicleClientCurrent,type VehicleClientCurrentRpc,type VehicleClientCurrentSaved,type VehicleClientCurrentPrepared} from './vehicleClientCurrent';
const CORE=new PublicKey(MPL_CORE_PROGRAM_ID),LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const DATA=PublicKey.findProgramAddressSync([CORE.toBuffer()],LOADER)[0];
function fixture(service=false){
 const wallet=Keypair.generate(),other=Keypair.generate(),asset=Keypair.generate().publicKey,collection=Keypair.generate().publicKey;
 const identity={assetId:asset.toBase58(),collection:collection.toBase58(),family:'cargo_cutter' as const,tier:2 as const};
 const initial={wallet:wallet.publicKey.toBase58(),identity,reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e054',blockhash:Keypair.generate().publicKey.toBase58()};
 const servicePlan={...initial,service:{operation:'upgrade' as const,installationId:'4e8cf44a-6f82-4a6c-9df5-c4a5d9942822',baseId:'45d728c7-69f1-4a56-9869-fd0f6a6351b1',berthId:'d59c4d39-2f9e-4816-a0c3-f9e1fbd29654',revision:0,family:identity.family,tier:identity.tier,completedTotal:'0',allowanceStart:'0'}};
 const built=service?buildVehicleServiceBurnMessage(servicePlan):buildVehicleBurnMessage(initial),tx=new VersionedTransaction(Message.from(built.messageBytes));tx.sign([wallet]);
 const code=Buffer.alloc(50);code.writeUInt32LE(3);code.writeBigUInt64LE(50n,4);code[45]=99;
 const raw=(address:PublicKey,data:Uint8Array,owner=CORE,executable=false)=>({address,data:Buffer.from(data),owner,executable});
 const accounts=[raw(CORE,Buffer.concat([Buffer.of(2,0,0,0),DATA.toBuffer()]),LOADER,true),raw(DATA,code,LOADER),
  raw(asset,getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(initial.wallet),updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Vehicle',uri:'',seq:null})),
  raw(collection,getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(initial.wallet),name:'Vehicles',uri:'',numMinted:1,currentSize:1}))];
 const trust={expectedGenesisHash:Keypair.generate().publicKey.toBase58(),reviewedDeploymentSlot:50,reviewedProgramDataSha256:createHash('sha256').update(code).digest('hex'),upgradeAuthority:null};
 const anchor={version:1 as const,wallet:initial.wallet,identity:{...identity},slot:90,genesisHash:trust.expectedGenesisHash,reviewedDeploymentSlot:50,reviewedProgramDataSha256:trust.reviewedProgramDataSha256,assetDataHex:accounts[2]!.data.toString('hex'),collectionDataHex:accounts[3]!.data.toString('hex')};
 const prepared:VehicleClientCurrentPrepared={status:'prepared',...(service?{kind:'service' as const,plan:servicePlan}:{kind:'installation' as const,plan:initial}),preparedMessageBytes:built.messageBytes,anchor,blockhashContextSlot:95,lastValidBlockHeight:500,signedTransaction:tx.serialize()};
 let saved:VehicleClientCurrentSaved=prepared;
 const rpc={getGenesisHash:vi.fn(async()=>trust.expectedGenesisHash),getSlot:vi.fn(async()=>100),
  getMultipleAccountsInfoAndContext:vi.fn(async(keys:PublicKey[])=>({context:{slot:100},value:keys.map(k=>accounts.find(v=>v.address.equals(k))??null)})),
  getSignatureStatuses:vi.fn(async()=>({context:{slot:100},value:[null]})),getFeeForMessage:vi.fn(async(_message:Message)=>({context:{slot:100},value:5000})),
  getBalanceAndContext:vi.fn(async()=>({context:{slot:100},value:5000})),isBlockhashValid:vi.fn(async()=>({context:{slot:100},value:true})),
  getBlockHeight:vi.fn(async()=>500),sendRawTransaction:vi.fn(async()=>{const bs58=await import('bs58');return bs58.default.encode(tx.signatures[0]!);})};
 const load=vi.fn(async()=>saved),connect=vi.fn((_signal:AbortSignal)=>rpc as VehicleClientCurrentRpc),reader=createVehicleClientCurrent(connect,trust,load);
 const ref={kind:prepared.kind,id:initial.reservationId};
 return {wallet,other,identity,initial,prepared,built,tx,accounts,trust,rpc,load,connect,reader,ref,setSaved(v:VehicleClientCurrentSaved){saved=v;}};
}
function plugin(bytes:Buffer,type:'PermanentFreezeDelegate'|'TransferDelegate'){
 const payload=Buffer.from(getPluginSerializer().serialize(type==='PermanentFreezeDelegate'?{__kind:type,fields:[{frozen:true}]}:{__kind:type,fields:[{}]}));
 const offset=bytes.length+9,header=getPluginHeaderV1AccountDataSerializer().serialize({key:Key.PluginHeaderV1,pluginRegistryOffset:offset+payload.length});
 const registry=getPluginRegistryV1AccountDataSerializer().serialize({key:Key.PluginRegistryV1,registry:[{pluginType:PluginType[type],authority:{__kind:'None'},offset}],externalRegistry:[]});
 return Buffer.concat([bytes,header,payload,registry]);
}
describe('private bounded current vehicle consent and exact delivery',()=>{
 it.each([false,true])('rebuilds %s service consent, reviews exact fee and sends only one retained legacy wire',async service=>{
  const f=fixture(service),review=await f.reader.review(f.ref);expect(review).toMatchObject({ownerWallet:f.initial.wallet,ownerSlot:100,closingSlot:100,networkFeeLamports:'5000',payerLamports:'5000',blockhashValid:true,currentBlockHeight:500});
  expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();const result=await f.reader.deliver(f.ref);expect(result.status).toBe('submitted');
  expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);expect(f.rpc.sendRawTransaction).toHaveBeenCalledWith(f.tx.serialize(),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});
  expect(f.load).toHaveBeenCalledTimes(4);expect(f.rpc.getFeeForMessage.mock.calls[0]![0].serialize()).toEqual(Buffer.from(f.built.messageBytes));
 });
 it('does not promote an ahead-of-finality signature-cache context to finalized bank authority',async()=>{
  const f=fixture();f.rpc.getSignatureStatuses.mockResolvedValue({context:{slot:132},value:[null]});
  expect(await f.reader.deliver(f.ref)).toMatchObject({status:'submitted',observation:{closingSlot:100}});
  expect(f.rpc.sendRawTransaction).toHaveBeenCalledWith(f.tx.serialize(),expect.objectContaining({minContextSlot:100}));
 });
 it('reviews unsigned original without inferring an absent signature or granting delivery',async()=>{
  const f=fixture();f.prepared.signedTransaction=null;await expect(f.reader.review(f.ref)).resolves.toHaveProperty('ownerWallet',f.initial.wallet);
  expect(f.rpc.getSignatureStatuses).not.toHaveBeenCalled();await expect(f.reader.deliver(f.ref)).rejects.toMatchObject({code:'NOT_SIGNED'});
 });
 it.each(['null','paused','terminal'] as const)('stops %s before any RPC and preserves original inventory',async kind=>{
  const f=fixture();f.setSaved(kind==='null'?null:{status:kind});await expect(f.reader.review(f.ref)).rejects.toHaveProperty('reservationReleaseAuthorized',false);expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
 });
 it.each(['owner','collection','asset-program','executable','malformed','freeze','delegate'] as const)('holds %s current ownership instead of authorizing the historical owner',async kind=>{
  const f=fixture();if(kind==='owner')f.accounts[2]!.data.set(f.other.publicKey.toBytes(),1);
  if(kind==='collection')f.accounts[2]!.data.set(f.other.publicKey.toBytes(),34);
  if(kind==='asset-program')f.accounts[2]!.owner=f.other.publicKey;if(kind==='executable')f.accounts[2]!.executable=true;
  if(kind==='malformed')f.accounts[2]!.data=Buffer.of(255);
  if(kind==='freeze')f.accounts[3]!.data=plugin(f.accounts[3]!.data,'PermanentFreezeDelegate');
  if(kind==='delegate')f.accounts[2]!.data=plugin(f.accounts[2]!.data,'TransferDelegate');
  await expect(f.reader.deliver(f.ref)).rejects.toMatchObject({code:'OWNERSHIP'});expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
 });
 it.each(['genesis','program','slot','code','authority','context'] as const)('holds %s deployment/network inconsistency',async kind=>{
  const f=fixture();if(kind==='genesis')f.rpc.getGenesisHash.mockResolvedValue(f.other.publicKey.toBase58());
  if(kind==='program')f.accounts[0]!.executable=false;if(kind==='slot')f.accounts[1]!.data.writeBigUInt64LE(51n,4);
  if(kind==='code')f.accounts[1]!.data[45]=1;if(kind==='authority')f.accounts[1]!.data[12]=1;
  if(kind==='context')f.rpc.getSlot.mockResolvedValue(94);
  await expect(f.reader.review(f.ref)).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it.each(['hash','height','fee','balance','observed','failed-observed','stale-fee'] as const)('holds %s rather than replacing or releasing the original',async kind=>{
  const f=fixture();if(kind==='hash')f.rpc.isBlockhashValid.mockResolvedValue({context:{slot:100},value:false});
  if(kind==='height')f.rpc.getBlockHeight.mockResolvedValue(501);if(kind==='fee')f.rpc.getFeeForMessage.mockResolvedValue({context:{slot:100},value:PHASE_E_VEHICLE_CLIENT.maxNetworkFeeLamports+1});
  if(kind==='balance')f.rpc.getBalanceAndContext.mockResolvedValue({context:{slot:100},value:4999});
  if(kind==='observed'||kind==='failed-observed')f.rpc.getSignatureStatuses.mockResolvedValue({context:{slot:100},value:[{slot:99,err:kind==='observed'?null:{InstructionError:[0,'Custom']}}] as never});
  if(kind==='stale-fee')f.rpc.getFeeForMessage.mockResolvedValue({context:{slot:99},value:5000});
  await expect(f.reader.deliver(f.ref)).rejects.toHaveProperty('reservationReleaseAuthorized',false);expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
 });
 it.each(['pause','terminal','message','wire','height','code','owner'] as const)('closing %s change fences the exact send',async kind=>{
  const f=fixture();f.rpc.getBlockHeight.mockImplementationOnce(async()=>{
   if(kind==='pause')f.setSaved({status:'paused'});if(kind==='terminal')f.setSaved({status:'terminal'});
   if(kind==='message')f.prepared.preparedMessageBytes.fill(0);if(kind==='wire')f.prepared.signedTransaction=null;
   if(kind==='height')f.prepared.lastValidBlockHeight++;if(kind==='code')f.accounts[1]!.data[45]=100;
   if(kind==='owner')f.accounts[2]!.data.set(f.other.publicKey.toBytes(),1);return 500;
  });await expect(f.reader.deliver(f.ref)).rejects.toHaveProperty('reservationReleaseAuthorized',false);expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
 });
 it('copies trust and binds provider methods before yielding so later mutation cannot select a new send',async()=>{
  const f=fixture(),original=f.trust.expectedGenesisHash;f.rpc.getGenesisHash.mockResolvedValue(original);f.trust.expectedGenesisHash=f.other.publicKey.toBase58();
  const send=f.rpc.sendRawTransaction;f.rpc.getBlockHeight.mockImplementation(async()=>{f.rpc.sendRawTransaction=vi.fn(async()=>{throw Error('replacement');});return 500;});
  await expect(f.reader.deliver(f.ref)).resolves.toHaveProperty('status','submitted');expect(send).toHaveBeenCalledTimes(1);expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();
 });
 it.each(['error','wrong-signature'] as const)('retains uncertain %s sends as a held original',async kind=>{
  const f=fixture();if(kind==='error')f.rpc.sendRawTransaction.mockRejectedValue(Error('lost reply'));else f.rpc.sendRawTransaction.mockResolvedValue('wrong');
  await expect(f.reader.deliver(f.ref)).rejects.toMatchObject({code:'SEND_UNCERTAIN',reservationReleaseAuthorized:false});expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);
 });
 it('uses one bounded scan and excludes ordinary absent/other-owner candidates without hiding malformed data',async()=>{
  const f=fixture(),input={wallet:f.initial.wallet,identities:[f.identity]};expect(await f.reader.scanCandidates(input)).toEqual([{identity:f.identity,observedSlot:100}]);
  f.accounts[2]!.data.set(f.other.publicKey.toBytes(),1);expect(await f.reader.scanCandidates(input)).toEqual([]);
  const asset=f.accounts.splice(2,1)[0]!;expect(await f.reader.scanCandidates(input)).toEqual([]);
  f.accounts.push({...asset,data:Buffer.of(255)});await expect(f.reader.scanCandidates(input)).rejects.toHaveProperty('code','OWNERSHIP');
  f.accounts.pop();f.accounts[2]!.data=Buffer.of(255);await expect(f.reader.scanCandidates(input)).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it('holds unknown or trailing plugin encodings that the convenience decoder could ignore',async()=>{
  const f=fixture();f.accounts[2]!.data=Buffer.concat([f.accounts[2]!.data,Buffer.alloc(9)]);
  await expect(f.reader.review(f.ref)).rejects.toHaveProperty('code','OWNERSHIP');
  const g=fixture(),bytes=plugin(g.accounts[2]!.data,'TransferDelegate');bytes[bytes.length-14]=255;g.accounts[2]!.data=bytes;
  await expect(g.reader.review(g.ref)).rejects.toHaveProperty('code','OWNERSHIP');
 });
 it('retains all eight occupied slots after timeout until ignored-abort provider work drains; no late send',async()=>{
  vi.useFakeTimers();try{
   const f=fixture();let release!:(v:string)=>void;const blocked=new Promise<string>(resolve=>{release=resolve;});f.rpc.getGenesisHash.mockImplementation(()=>blocked);
   const work=Array.from({length:PHASE_E_VEHICLE_CLIENT.maxPendingRpc},()=>f.reader.deliver(f.ref).catch(e=>e));
   await vi.advanceTimersByTimeAsync(PHASE_E_VEHICLE_CLIENT.rpcTimeoutMs);expect((await Promise.all(work)).every(e=>e.code==='TIMEOUT')).toBe(true);
   await expect(f.reader.review(f.ref)).rejects.toHaveProperty('code','BUSY');release(f.trust.expectedGenesisHash);await vi.runAllTimersAsync();
   expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();f.rpc.getGenesisHash.mockResolvedValue(f.trust.expectedGenesisHash);
   await expect(f.reader.review(f.ref)).resolves.toHaveProperty('ownerWallet',f.initial.wallet);
  }finally{vi.useRealTimers();}
 });
});

// Raw bytes are deliberately shared with the independent browser/native decoder
// tests. A public fixture contains no wallet secret or reusable authority.
describe('D182 ordinary current raw Core profile vectors',()=>{
 it.each(vectors.variants)('$name',async vector=>{
  const f=fixture();f.rpc.getGenesisHash.mockResolvedValue(vectors.trust.expectedGenesisHash);
  const raw=(key:string,data:string,owner:string,executable=false)=>({address:new PublicKey(key),owner:new PublicKey(owner),executable,data:Buffer.from(data,'hex')});
  const rows=[raw(vectors.core.programId,vectors.core.programHex,vectors.core.loaderId,true),
   raw(vectors.core.programDataAddress,vectors.core.programDataHex,vectors.core.loaderId),
   ...vector.assetDataHex===null?[]:[raw(vectors.identity.assetId,vector.assetDataHex,vectors.core.programId)],
   raw(vectors.identity.collection,vector.collectionDataHex,vectors.core.programId)];
  f.rpc.getMultipleAccountsInfoAndContext.mockImplementation(async keys=>({context:{slot:100},value:keys.map(key=>rows.find(v=>v.address.equals(key))??null)}));
  const reader=createVehicleClientCurrent(f.connect,vectors.trust,f.load);
  const result=reader.scanCandidates({wallet:vectors.wallet,identities:[{...vectors.identity,family:'cargo_cutter',tier:2}]});
  if(vector.expected==='held')await expect(result).rejects.toHaveProperty('reservationReleaseAuthorized',false);
  else expect(await result).toEqual(vector.expected==='eligible'?[{identity:vectors.identity,observedSlot:100}]:[]);
 });
});
