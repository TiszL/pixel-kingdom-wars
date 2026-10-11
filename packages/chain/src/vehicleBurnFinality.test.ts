import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {Keypair,PublicKey,Message,TransactionMessage,TransactionInstruction,AddressLookupTableAccount,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {Key,MPL_CORE_PROGRAM_ID,getTransferV1InstructionDataSerializer} from '@metaplex-foundation/mpl-core';
import {publicKey} from '@metaplex-foundation/umi';
import {getAssetV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import {getCollectionV1AccountDataSerializer} from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import bs58 from 'bs58';
import {buildVehicleBurnMessage} from './vehicleBurnMessage';
import {createVehicleBurnFinalityReader,type VehicleBurnSavedReservation,type VehicleBurnFinalityRpc} from './vehicleBurnFinality';
const core=new PublicKey(MPL_CORE_PROGRAM_ID),loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programData=PublicKey.findProgramAddressSync([core.toBuffer()],loader)[0];
function fixture(){
 const wallet=Keypair.generate(),other=Keypair.generate(),asset=Keypair.generate().publicKey,collection=Keypair.generate().publicKey;
 const identity={assetId:asset.toBase58(),collection:collection.toBase58(),family:'cargo_cutter' as const,tier:2 as const};
 const plan={wallet:wallet.publicKey.toBase58(),identity,reservationId:'ac2ee077-1c46-4fb0-8c35-cb331613e054',blockhash:Keypair.generate().publicKey.toBase58()};
 const prepared=buildVehicleBurnMessage(plan),m=Message.from(prepared.messageBytes),signed=new VersionedTransaction(m);signed.sign([wallet]);
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
 let currentSlot=100,saved:VehicleBurnSavedReservation|undefined;
 const rows=[{signature,slot:110,err:null,blockTime:tx.blockTime,confirmationStatus:'finalized'},
  {signature:ancestor,slot:90,err:null,blockTime:tx.blockTime,confirmationStatus:'finalized'}];
 const bodies=new Map([[signature,tx]]),orders=new Map([[110,[signature]]]);
 const rpc={getGenesisHash:vi.fn(async()=>trust.expectedGenesisHash),getSlot:vi.fn(async()=>currentSlot),
  getMultipleAccountsInfoAndContext:vi.fn(async(addresses:PublicKey[])=>({context:{slot:currentSlot},value:addresses.map(k=>accounts.find(a=>a.address.equals(k))??null)})),
  getSignaturesForAddress:vi.fn(async()=>rows),getTransaction:vi.fn(async(sig:string)=>bodies.get(sig)??null),
  getBlockSignatures:vi.fn(async(slot:number)=>({blockhash:plan.blockhash,previousBlockhash:plan.blockhash,parentSlot:slot-1,blockTime:tx.blockTime,signatures:orders.get(slot)??[]}))};
 const load=vi.fn(async()=>saved??null),connect=vi.fn((_signal:AbortSignal)=>rpc as unknown as VehicleBurnFinalityRpc);
 const reader=createVehicleBurnFinalityReader(connect,trust,load);
 async function capture(){const anchor=await reader.captureOwner({wallet:plan.wallet,identity});saved={plan,preparedMessageBytes:prepared.messageBytes,anchor};currentSlot=120;return anchor;}
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
 return {wallet,other,asset,collection,identity,plan,prepared,signed,signature,tx,accounts,trust,rpc,load,connect,reader,capture,transfer,rows,bodies,orders,
  get saved(){return saved!;},setSlot(n:number){currentSlot=n;}};
}
describe('application-owned finalized vehicle burn history',()=>{
 it('captures a same-bank owner and verifies the saved signed burn through complete finalized history',async()=>{
  const f=fixture(),anchor=await f.capture();expect(anchor).toMatchObject({version:1,wallet:f.plan.wallet,identity:f.identity,slot:100});
  const proof=await f.reader.verify({reservationId:f.plan.reservationId,signedTransaction:f.signed.serialize()});
  expect(proof).toMatchObject({reservationId:f.plan.reservationId,signature:f.signature,preBurnOwner:f.plan.wallet,finalizedThroughSlot:120,
   finalityVerified:true,preBurnOwnershipVerified:true,registryMembershipVerified:false,installationAuthorized:false});
  expect(proof.history).toEqual([]);expect(f.load).toHaveBeenCalledWith(f.plan.reservationId);
  expect(f.rpc.getTransaction).toHaveBeenCalledWith(f.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  expect(f.rpc.getSignaturesForAddress).toHaveBeenCalledWith(f.asset,expect.objectContaining({minContextSlot:120,limit:1000}),'finalized');
 });
 it('discovers the exact burn after a lost local signature without preparing or broadcasting another burn',async()=>{
  const f=fixture();await f.capture();const proof=await f.reader.verify({reservationId:f.plan.reservationId});expect(proof.signature).toBe(f.signature);
  expect(proof.signedTransactionSha256).toBe(createHash('sha256').update(f.signed.serialize()).digest('hex'));
 });
 it('refuses a burn delegate after the actual owner transferred away, despite valid signed burn bytes',async()=>{
  const f=fixture();await f.capture();f.transfer(f.other.publicKey);
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'OWNERSHIP',reservationReleaseAuthorized:false});
 });
 it('uses block order for same-slot transfers, including reacquisition before burn',async()=>{
  const f=fixture();await f.capture();const away=f.transfer(f.other.publicKey,110),back=f.transfer(f.wallet.publicKey,110,f.other);
  f.orders.set(110,[away.transaction.signatures[0]!,back.transaction.signatures[0]!,f.signature]);
  const proof=await f.reader.verify({reservationId:f.plan.reservationId});expect(proof.history.map(h=>h.signature)).toEqual([away.transaction.signatures[0],back.transaction.signatures[0]]);
 });
 it('replays real signed v0 transfers with loaded addresses and SDK omitted-authority fallback',async()=>{
  const f=fixture();await f.capture();f.transfer(f.other.publicKey,104,f.wallet,true,true);f.transfer(f.wallet.publicKey,106,f.other,true,true);
  const proof=await f.reader.verify({reservationId:f.plan.reservationId});expect(proof.history.map(h=>h.ownerAfter)).toEqual([f.other.publicKey.toBase58(),f.plan.wallet]);
  expect(proof.source.addressIndexCompleteness).toBe('configured-provider-trust');
 });
 it('reconciles failed transfers without applying them to ownership',async()=>{
  const f=fixture();await f.capture();const failed=f.transfer(f.other.publicKey);failed.meta!.err={InstructionError:[0,'InvalidArgument']};
  f.rows.find(r=>r.signature===failed.transaction.signatures[0])!.err=failed.meta!.err as never;
  expect((await f.reader.verify({reservationId:f.plan.reservationId})).preBurnOwner).toBe(f.plan.wallet);
 });
 it.each(['cpi','trailing','unknown','nonzero-target','version','order-duplicate'] as const)('holds %s history rather than guessing ownership',async kind=>{
  const f=fixture();await f.capture();const moved=f.transfer(f.wallet.publicKey),message=moved.transaction.message as Message,ix=message.instructions[0]!;
  if(kind==='cpi')moved.meta!.innerInstructions=[{index:0,instructions:[{...ix,accounts:[...ix.accounts]}]}];
  if(kind==='trailing')ix.data=bs58.encode(Buffer.of(14,0,0));
  if(kind==='unknown')ix.data=bs58.encode(Buffer.of(30,0));
  if(kind==='nonzero-target')[ix.accounts[0],ix.accounts[1]]=[ix.accounts[1]!,ix.accounts[0]!];
  if(kind==='version')moved.version=0;
  if(kind==='order-duplicate')f.orders.get(105)!.push(moved.transaction.signatures[0]!);
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it('owns saved consent before later provider awaits and refuses a changed Core deployment at the closing bank',async()=>{
  const f=fixture();await f.capture();const original=f.rpc.getGenesisHash.getMockImplementation()!;
  f.rpc.getGenesisHash.mockImplementationOnce(async()=>{f.saved.plan.identity.tier=4;f.saved.preparedMessageBytes.fill(0);return original();});
  expect((await f.reader.verify({reservationId:f.plan.reservationId})).identity.tier).toBe(2);
  const g=fixture();await g.capture();g.rpc.getTransaction.mockImplementationOnce(async()=>{g.accounts[1]!.data[45]=100;return g.tx;});
  await expect(g.reader.verify({reservationId:g.plan.reservationId})).rejects.toMatchObject({code:'DEPLOYMENT'});
 });
 it('never treats an absent signature or an incompatible RPC body as cancellation authority',async()=>{
  const f=fixture();await f.capture();f.rows.splice(0,1);
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'HISTORY',reservationReleaseAuthorized:false});
  const g=fixture();await g.capture();const msg=g.tx.transaction.message as Message;msg.instructions[0]!.data=bs58.encode(Buffer.of(14,0));msg.serialize=()=>Buffer.from(g.prepared.messageBytes);
  await expect(g.reader.verify({reservationId:g.plan.reservationId})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it('refuses contradictory index times and writable/readonly lookup partitions',async()=>{
  const f=fixture();await f.capture();f.rows[0]!.blockTime=1;
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'HISTORY'});
  const g=fixture();await g.capture();const moved=g.transfer(g.wallet.publicKey,105,g.wallet,true),loaded=moved.meta!.loadedAddresses!;
  loaded.readonly.push(loaded.writable.pop()!);
  await expect(g.reader.verify({reservationId:g.plan.reservationId})).rejects.toMatchObject({code:'HISTORY'});
 });
 it('rejects anchor-slot burns because an end-of-bank observation cannot prove their prior owner',async()=>{
  const f=fixture();await f.capture();f.saved.anchor={...f.saved.anchor,slot:110};
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'HISTORY',reservationReleaseAuthorized:false});
 });
 it.each(['missing','wrong-owner','wrong-collection','fake-program','code','stale'] as const)('refuses %s owner capture',async kind=>{
  const f=fixture();
  if(kind==='missing')f.accounts.splice(2,1);
  if(kind==='wrong-owner')f.accounts[2]!.data.set(f.other.publicKey.toBytes(),1);
  if(kind==='wrong-collection')f.accounts[2]!.data.set(f.other.publicKey.toBytes(),34);
  if(kind==='fake-program')f.accounts[2]!.owner=f.other.publicKey;
  if(kind==='code')f.accounts[1]!.data[45]=10;
  if(kind==='stale')f.setSlot(49);
  await expect(f.capture()).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it.each(['short','overlap','unordered','missing-body','missing-order','failed','trace','wrong-genesis','upgrade','future'] as const)('holds %s history/finality instead of authorizing installation or release',async kind=>{
  const f=fixture();await f.capture();
  if(kind==='short')f.rows.pop();
  if(kind==='overlap')f.rows.splice(1,0,{...f.rows[0]!});
  if(kind==='unordered')f.rows.reverse();
  if(kind==='missing-body')f.bodies.clear();
  if(kind==='missing-order')f.orders.clear();
  if(kind==='failed')f.tx.meta!.err={InstructionError:[0,'InvalidArgument']};
  if(kind==='trace')f.tx.meta!.innerInstructions=null;
  if(kind==='wrong-genesis')f.rpc.getGenesisHash.mockResolvedValue(f.other.publicKey.toBase58());
  if(kind==='upgrade')f.accounts[1]!.data[45]=10;
  if(kind==='future')f.setSlot(109);
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toHaveProperty('reservationReleaseAuthorized',false);
 });
 it('does not accept caller-provided registry, owner, anchor or plan assertions',async()=>{
  const f=fixture();await f.capture();for(const patch of [{owner:f.plan.wallet},{anchor:f.saved.anchor},{plan:f.plan},{finalityVerified:true}])
   await expect(f.reader.verify({reservationId:f.plan.reservationId,...patch} as never)).rejects.toMatchObject({code:'INPUT'});
  expect(f.load).not.toHaveBeenCalled();
 });
 it('holds when no committed saved reservation exists and when the stored consent differs',async()=>{
  const f=fixture();await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});
  await f.capture();f.saved.plan.identity.tier=3 as never;
  await expect(f.reader.verify({reservationId:f.plan.reservationId})).rejects.toMatchObject({code:'RESERVATION'});
 });
 it('copies input trust before later configuration changes and copied owner bytes before closing awaits',async()=>{
  const f=fixture(),genesis=f.trust.expectedGenesisHash;f.trust.reviewedProgramDataSha256='0'.repeat(64);
  f.rpc.getSlot.mockImplementationOnce(async()=>100).mockImplementationOnce(async()=>{f.accounts[2]!.data.fill(0);return 100;});
  const anchor=await f.capture();expect(anchor.genesisHash).toBe(genesis);
  expect((await f.reader.verify({reservationId:f.plan.reservationId})).signature).toBe(f.signature);
 });
 it('cancels a stalled read by one deadline and retains uncertain reservations',async()=>{
  const f=fixture();f.rpc.getGenesisHash.mockImplementation(()=>new Promise(()=>{}));
  const reader=createVehicleBurnFinalityReader(f.connect,f.trust,f.load,{deadlineMs:10});
  await expect(reader.captureOwner({wallet:f.plan.wallet,identity:f.identity})).rejects.toMatchObject({code:'DEADLINE',reservationReleaseAuthorized:false});
  expect(f.connect.mock.calls[0]![0].aborted).toBe(true);
 });
});
