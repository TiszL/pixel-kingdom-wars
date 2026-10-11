import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {Keypair,PublicKey,Message,TransactionMessage,TransactionInstruction,AddressLookupTableAccount,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {Key,MPL_CORE_PROGRAM_ID,getTransferV1InstructionDataSerializer} from '@metaplex-foundation/mpl-core';
import {publicKey} from '@metaplex-foundation/umi';
import {getAssetV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import {getCollectionV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import bs58 from 'bs58';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
import {buildVehicleServiceBurnMessage} from './vehicleServiceBurnMessage';
import {verifyVehicleBurnEvidence,verifyVehicleServiceBurnEvidence} from './vehicleBurnEvidence';
import {createVehicleBurnFinalityReader,createVehicleServiceBurnFinalityReader,type VehicleServiceBurnSavedReservation,type VehicleBurnFinalityRpc} from './vehicleBurnFinality';
const core=new PublicKey(MPL_CORE_PROGRAM_ID),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programData=PublicKey.findProgramAddressSync([core.toBuffer()],loader)[0];
function fixture(operation:'upgrade'|'restore_uses'='upgrade'){
 const wallet=Keypair.generate(),other=Keypair.generate(),asset=Keypair.generate().publicKey,collection=Keypair.generate().publicKey;
 const identity={assetId:asset.toBase58(),collection:collection.toBase58(),family:'cargo_cutter' as const,tier:2 as const};
 const plan={wallet:wallet.publicKey.toBase58(),identity,reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e054',blockhash:Keypair.generate().publicKey.toBase58()};
 const service={operation,installationId:'548a40c0-8d08-4c53-ac9d-2d2f5ae8b922',baseId:'bf3b77c1-e048-49eb-8f00-2486c6ac8f76',berthId:'6229952c-d168-423e-b71e-f665a93c6de8',revision:7,family:identity.family,tier:identity.tier,completedTotal:'200',allowanceStart:'100'};
 const servicePlan={...plan,service};
 const prepared=buildVehicleServiceBurnMessage(servicePlan),m=Message.from(prepared.messageBytes),signed=new VersionedTransaction(m);signed.sign([wallet]);
 const signature=bs58.encode(signed.signatures[0]!),ancestor=bs58.encode(Buffer.alloc(64,1));
 const pre=m.accountKeys.map(()=>10_000_000),post=[...pre],ai=m.accountKeys.findIndex(k=>k.equals(asset));post[0]!+=995_000;post[ai]!-=1_000_000;
 const tx:VersionedTransactionResponse={slot:110,blockTime:1_700_000_000,version:'legacy',transaction:{message:m,signatures:[signature]},
  meta:{err:null,fee:5_000,preBalances:pre,postBalances:post,innerInstructions:[],loadedAddresses:{readonly:[],writable:[]}}};
 const code=Buffer.alloc(50);code.writeUInt32LE(3);code.writeBigUInt64LE(50n,4);code[12]=0;code[45]=99;
 const program=Buffer.concat([Buffer.of(2,0,0,0),programData.toBuffer()]);
 const raw=(address:PublicKey,data:Uint8Array,owner=core,executable=false)=>({address,owner,executable,data:Buffer.from(data)});
 const accounts=[raw(core,program,loader,true),raw(programData,code,loader),
  raw(asset,getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,owner:publicKey(plan.wallet),
   updateAuthority:{__kind:'Collection',fields:[publicKey(identity.collection)]},name:'Vehicle',uri:'',seq:null})),
  raw(collection,getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,updateAuthority:publicKey(plan.wallet),name:'Vehicles',uri:'',numMinted:1,currentSize:1}))];
 const trust={expectedGenesisHash:Keypair.generate().publicKey.toBase58(),reviewedDeploymentSlot:50,
  reviewedProgramDataSha256:createHash('sha256').update(code).digest('hex'),upgradeAuthority:null};
 let currentSlot=100,saved:VehicleServiceBurnSavedReservation|undefined;
 const rows=[{signature,slot:110,err:null,blockTime:tx.blockTime,confirmationStatus:'finalized'},
  {signature:ancestor,slot:90,err:null,blockTime:tx.blockTime,confirmationStatus:'finalized'}];
 const bodies=new Map([[signature,tx]]),orders=new Map([[110,[signature]]]);
 const rpc={getGenesisHash:vi.fn(async()=>trust.expectedGenesisHash),getSlot:vi.fn(async()=>currentSlot),
  getMultipleAccountsInfoAndContext:vi.fn(async(addresses:PublicKey[])=>({context:{slot:currentSlot},value:addresses.map(k=>accounts.find(a=>a.address.equals(k))??null)})),
  getSignaturesForAddress:vi.fn(async()=>rows),getTransaction:vi.fn(async(sig:string)=>bodies.get(sig)??null),
  getBlockSignatures:vi.fn(async(slot:number)=>({blockhash:plan.blockhash,previousBlockhash:plan.blockhash,parentSlot:slot-1,blockTime:tx.blockTime,signatures:orders.get(slot)??[]}))};
 const load=vi.fn(async()=>saved??null),connect=vi.fn((_signal:AbortSignal)=>rpc as unknown as VehicleBurnFinalityRpc);
 const reader=createVehicleServiceBurnFinalityReader(connect,trust,load);
 async function capture(){const anchor=await reader.captureOwner({wallet:plan.wallet,identity});saved={plan:servicePlan,preparedMessageBytes:prepared.messageBytes,anchor};currentSlot=120;return anchor;}
 function transfer(to:PublicKey,slot=105,from=wallet,v0=false,authorityOmitted=false){
  const ix=new TransactionInstruction({programId:core,keys:[asset,collection,from.publicKey,authorityOmitted?core:from.publicKey,to,core,core].map((k,i)=>({pubkey:k,isSigner:i===2||i===3&&!authorityOmitted,isWritable:i<3||i===4})),
   data:Buffer.from(getTransferV1InstructionDataSerializer().serialize({}))});
  const draft=new TransactionMessage({payerKey:from.publicKey,recentBlockhash:plan.blockhash,instructions:[ix]});
  const lookup=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:(1n<<64n)-1n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:[asset,collection,to]}});
  const message=v0?draft.compileToV0Message([lookup]):draft.compileToLegacyMessage(),wire=new VersionedTransaction(message);wire.sign([from]);
  const loaded=message.version===0?{readonly:message.addressTableLookups.flatMap(l=>l.readonlyIndexes.map(i=>lookup.state.addresses[i]!)),writable:message.addressTableLookups.flatMap(l=>l.writableIndexes.map(i=>lookup.state.addresses[i]!))}:{readonly:[],writable:[]};
  const keyCount=message.getAccountKeys({accountKeysFromLookups:loaded}).length;
  const sig=bs58.encode(wire.signatures[0]!),body:VersionedTransactionResponse={slot,blockTime:tx.blockTime??null,version:message.version,transaction:{message,signatures:[sig]},meta:{err:null,fee:5000,
   preBalances:Array(keyCount).fill(10_000_000),postBalances:Array(keyCount).fill(10_000_000),innerInstructions:[],loadedAddresses:loaded}};
  bodies.set(sig,body);rows.splice(rows.length-1,0,{signature:sig,slot,err:null,blockTime:tx.blockTime,confirmationStatus:'finalized'});
  orders.set(slot,[...(orders.get(slot)??[]),sig]);rows.sort((a,b)=>b.slot-a.slot);return body;
 }
 return {wallet,other,asset,collection,identity,plan:servicePlan,prepared,signed,signature,tx,accounts,trust,rpc,load,connect,reader,capture,transfer,rows,bodies,orders,
  get saved(){return saved!;},setSlot(n:number){currentSlot=n;}};
}
describe('purpose-bound finalized vehicle service burns',()=>{
 it.each(['upgrade','restore_uses'] as const)('verifies %s with exact supplied wire and lost-wire recovery',async operation=>{
  const f=fixture(operation);await f.capture();
  const explicit=await f.reader.verify({reservationId:f.plan.reservationId,signedTransaction:f.signed.serialize()});
  const recovered=await f.reader.verify({reservationId:f.plan.reservationId});expect(recovered).toEqual(explicit);
  expect(explicit).toMatchObject({version:2,purpose:'vehicle_service',serviceAuthorized:false,installationAuthorized:false,registryMembershipVerified:false,
   finalityVerified:true,preBurnOwnershipVerified:true,serviceSha256:f.prepared.serviceSha256,
   service:{operation,tierAfter:operation==='upgrade'?3:2,remainingUses:operation==='upgrade'?0:100}});
  expect(Object.isFrozen(explicit.service)).toBe(true);
 });
 it('preserves the complete existing installation proof shape and classifications',async()=>{
  const f=fixture();await f.capture();const {service,...plan}=f.plan,prepared=buildVehicleBurnMessage(plan),message=Message.from(prepared.messageBytes),wire=new VersionedTransaction(message);wire.sign([f.wallet]);
  const signature=bs58.encode(wire.signatures[0]!);f.tx.transaction={message,signatures:[signature]};f.rows[0]!.signature=signature;f.bodies.clear();f.bodies.set(signature,f.tx);f.orders.set(110,[signature]);
  const saved={plan,preparedMessageBytes:prepared.messageBytes,anchor:f.saved.anchor},reader=createVehicleBurnFinalityReader(f.connect,f.trust,async()=>saved);
  const proof=await reader.verify({reservationId:plan.reservationId});
  expect(Object.keys(proof).sort()).toEqual(['version','reservationId','wallet','identity','signature','slot','blockTime','originalMessageSha256','signedTransactionSha256','feeLamports','assetRefundLamports','transactionEvidenceVerified','finalityVerified','preBurnOwnershipVerified','registryMembershipVerified','installationAuthorized','preBurnOwner','finalizedThroughSlot','anchorSlot','history','source'].sort());
  expect(proof.version).toBe(1);expect(proof.installationAuthorized).toBe(false);
  await expect(reader.verify({reservationId:plan.reservationId,service} as never)).rejects.toMatchObject({code:'INPUT'});
  saved.preparedMessageBytes.fill(0);await expect(reader.verify({reservationId:plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});
 });
 it('rejects install/service replay in both directions for identical wallet, asset and intent id',async()=>{
  const f=fixture();await f.capture();const {service,...installPlan}=f.plan;
  expect(()=>verifyVehicleBurnEvidence(f.tx,{plan:installPlan,preparedMessageBytes:f.prepared.messageBytes,signedTransaction:f.signed.serialize()})).toThrow();
  const old=buildVehicleBurnMessage(installPlan),message=Message.from(old.messageBytes),wire=new VersionedTransaction(message);wire.sign([f.wallet]);
  const tx={...f.tx,transaction:{message,signatures:[bs58.encode(wire.signatures[0]!)]}};
  expect(()=>verifyVehicleServiceBurnEvidence(tx,{plan:f.plan,preparedMessageBytes:old.messageBytes,signedTransaction:wire.serialize()})).toThrow();
  const oldReader=createVehicleBurnFinalityReader(f.connect,f.trust,async()=>({plan:installPlan,preparedMessageBytes:f.prepared.messageBytes,anchor:f.saved.anchor}));
  await expect(oldReader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});
  f.saved.preparedMessageBytes=old.messageBytes;
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});
 });
 it.each(['operation','installationId','baseId','berthId','revision','completedTotal','allowanceStart'] as const)('holds changed saved %s before contacting chain',async field=>{
  const f=fixture();await f.capture();f.rpc.getGenesisHash.mockClear();
  const state=f.saved.plan.service;
  if(field==='operation')state.operation='restore_uses';
  else if(field==='revision')state.revision++;
  else if(field==='completedTotal')state.completedTotal='199';
  else if(field==='allowanceStart')state.allowanceStart='101';
  else state[field]='548a40c0-8d08-4c53-ac9d-2d2f5ae8b923';
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
 });
 it('copies complete service state before later provider awaits',async()=>{
  const f=fixture();await f.capture();const previous=f.rpc.getGenesisHash.getMockImplementation()!;
  f.rpc.getGenesisHash.mockImplementationOnce(async()=>{f.saved.plan.service.operation='restore_uses';f.saved.plan.service.revision=100;f.saved.plan.service.completedTotal='175';f.saved.preparedMessageBytes.fill(0);return previous();});
  expect(await f.reader.verify({reservationId:f.plan.reservationId})).toMatchObject({service:{operation:'upgrade',revision:7,completedTotal:'200',remainingUses:0},serviceSha256:f.prepared.serviceSha256});
 });
 it('rejects protocol, builder, service and anchor authority injected by requests',async()=>{
  const f=fixture();await f.capture();for(const patch of [{protocol:'service'},{build:buildVehicleServiceBurnMessage},{service:f.plan.service},{anchor:f.saved.anchor},{serviceAuthorized:true}])
   await expect(f.reader.verify({reservationId:f.plan.reservationId,...patch} as never)).rejects.toMatchObject({code:'INPUT'});
  expect(f.load).not.toHaveBeenCalled();
 });
 it.each(['delegate','cpi','history','deployment','balance','signature'] as const)('holds %s without authorizing service or releasing the intent',async kind=>{
  const f=fixture();await f.capture();
  if(kind==='delegate')f.transfer(f.other.publicKey);
  if(kind==='cpi'){const ix=(f.tx.transaction.message as Message).instructions[0]!;f.tx.meta!.innerInstructions=[{index:0,instructions:[{...ix,accounts:[...ix.accounts]}]}];}
  if(kind==='history')f.rows.pop();
  if(kind==='deployment')f.rpc.getTransaction.mockImplementationOnce(async()=>{f.accounts[1]!.data[45]=100;return f.tx;});
  if(kind==='balance')f.tx.meta!.postBalances[0]!++;
  const bytes=f.signed.serialize();if(kind==='signature')bytes[4]=bytes[4]!^1;
  await expect(f.reader.verify({reservationId:f.plan.reservationId,signedTransaction:bytes})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it('retains capacity for providers ignoring abort after the single deadline',async()=>{
  const f=fixture();f.rpc.getGenesisHash.mockImplementation(()=>new Promise(()=>{}));
  const reader=createVehicleServiceBurnFinalityReader(f.connect,f.trust,f.load,{deadlineMs:10});
  for(let i=0;i<8;i++)await expect(reader.captureOwner({wallet:f.plan.wallet,identity:f.identity})).rejects.toMatchObject({code:'DEADLINE'});
  await expect(reader.captureOwner({wallet:f.plan.wallet,identity:f.identity})).rejects.toMatchObject({code:'BUSY'});
  expect(f.connect.mock.calls.every(([signal])=>signal.aborted)).toBe(true);
 });
});
