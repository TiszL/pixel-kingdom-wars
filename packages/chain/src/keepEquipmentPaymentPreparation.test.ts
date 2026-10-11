import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {Keypair,Message,MessageV0,PublicKey,SystemProgram,VersionedTransaction} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,AccountLayout,AccountState,MintLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import {verifyKeepEquipmentPaymentSignedWire} from './keepEquipmentPaymentWire';
import {createKeepEquipmentPaymentPreparationReader,KeepEquipmentPaymentPreparationError,type KeepEquipmentPreparationAccount,type KeepEquipmentPaymentPreparationTrust,type KeepEquipmentPaymentPreparationRpc} from './keepEquipmentPaymentPreparation';

const copy=(row:KeepEquipmentPreparationAccount|null)=>row===null?null:{owner:new PublicKey(row.owner.toBytes()),data:Buffer.from(row.data),executable:row.executable,lamports:row.lamports};
function fixture(mode:'existing'|'missing'|'prefunded'='existing',transactionVersion:'legacy'|0='legacy'){
 const buyer=Keypair.generate(),seller=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();
 const original={reservationId:randomUUID(),buyer:buyer.publicKey.toBase58(),seller:seller.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:1_000_001n};
 const trust:KeepEquipmentPaymentPreparationTrust={expectedGenesisHash:genesis,expectedKeepMint:mint.toBase58(),minContextSlot:90,deadlineMs:100,transactionVersion,providerIds:['private-one','private-two'],maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
 const mintData=Buffer.alloc(MINT_SIZE);MintLayout.encode({mintAuthorityOption:1,mintAuthority:buyer.publicKey,supply:20_000_000n,decimals:TOKEN.decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);
 const ata=(owner:PublicKey,amount:bigint)=>{const data=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:AccountState.Initialized,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return {owner:TOKEN_PROGRAM_ID,data,executable:false,lamports:2_039_280};};
 const initial: Array<KeepEquipmentPreparationAccount|null>=[{owner:TOKEN_PROGRAM_ID,data:mintData,executable:false,lamports:1_461_600},ata(buyer.publicKey,10_000_000n),mode==='missing'?null:mode==='prefunded'?{owner:SystemProgram.programId,data:Buffer.alloc(0),executable:false,lamports:890_880}:ata(seller,5n),{owner:SystemProgram.programId,data:Buffer.alloc(0),executable:false,lamports:100_000_000}];
 const expectedKeys=[mint,getAssociatedTokenAddressSync(mint,buyer.publicKey),getAssociatedTokenAddressSync(mint,seller),buyer.publicKey].map(k=>k.toBase58());
 const peers=[0,1].map(i=>{
  const controls={rows:initial.map(copy),rent:2_039_280,fee:5_000,slot:100,accountSlot:100,blockSlot:100,feeSlot:100,validitySlot:100,height:200,lastHeight:300,blockhash:i===0?blockhash:Keypair.generate().publicKey.toBase58()};
  const rpc={
   getGenesisHash:vi.fn(async()=>genesis),getSlot:vi.fn(async()=>controls.slot),
   getMultipleAccountsInfoAndContext:vi.fn(async(keys:PublicKey[],options:{commitment:'finalized';minContextSlot:number})=>{expect(keys.map(k=>k.toBase58())).toEqual(expectedKeys);expect(options.commitment).toBe('finalized');return {context:{slot:controls.accountSlot},value:controls.rows.map(copy)};}),
   getMinimumBalanceForRentExemption:vi.fn(async(bytes:number,commitment:'finalized')=>{expect(bytes).toBe(165);expect(commitment).toBe('finalized');return controls.rent;}),
   getLatestBlockhashAndContext:vi.fn(async()=>({context:{slot:controls.blockSlot},value:{blockhash:controls.blockhash,lastValidBlockHeight:controls.lastHeight}})),
   getFeeForMessage:vi.fn(async(_message:Message|MessageV0,_commitment:'finalized')=>({context:{slot:controls.feeSlot},value:controls.fee})),
   isBlockhashValid:vi.fn(async(hash:string,_options:{commitment:'finalized';minContextSlot:number})=>({context:{slot:controls.validitySlot},value:hash===blockhash})),
   getBlockHeight:vi.fn(async()=>controls.height),
  } satisfies KeepEquipmentPaymentPreparationRpc;
  return {controls,rpc};
 });
 const signals:AbortSignal[]=[];
 const connectors=[(signal:AbortSignal)=>{signals.push(signal);return peers[0]!.rpc;},(signal:AbortSignal)=>{signals.push(signal);return peers[1]!.rpc;}] as const;
 const read=()=>createKeepEquipmentPaymentPreparationReader(connectors,trust)(original);
 return {buyer,seller,mint,genesis,blockhash,original,trust,peers,signals,connectors,read};
}
const data=(f:ReturnType<typeof fixture>,peer:number,row:number)=>f.peers[peer]!.controls.rows[row]!.data as Buffer;
afterEach(()=>vi.useRealTimers());
async function held(f:ReturnType<typeof fixture>,code?:string){await expect(f.read()).rejects.toMatchObject({...(code?{code}:{}),signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false});}

it.each((['legacy',0] as const).flatMap(version=>(['existing','missing','prefunded'] as const).map(mode=>({version,mode}))))('prepares $version $mode ATA from agreeing finalized account, fee and full-rent evidence',async({version,mode})=>{
 const f=fixture(mode,version),p=await f.read();expect(p.transactionVersion).toBe(version);expect(p.original.sellerAtaExists).toBe(mode==='existing');
 expect(p.costs).toEqual({feeLamports:5_000n,rentLamports:mode==='existing'?0n:2_039_280n,fullAtaRentLamports:2_039_280n,totalLamports:mode==='existing'?5_000n:2_044_280n});
 expect(p.original.sellerAtaRentCapLamports).toBe(mode==='existing'?undefined:2_039_280n);expect(p.balances.buyerKeepBaseUnits).toBe(10_000_000n);expect(p.observedAccounts).toHaveLength(4);
 expect(p).toMatchObject({expectedGenesisHash:f.genesis,blockhash:f.blockhash,lastValidBlockHeight:300,minContextSlot:100,signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false});
 expect(f.peers[1]!.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();for(const peer of f.peers){expect(peer.rpc.isBlockhashValid).toHaveBeenCalledWith(f.blockhash,{commitment:'finalized',minContextSlot:100});expect(peer.rpc.getGenesisHash).toHaveBeenCalledTimes(2);}expect(f.signals.every(s=>s.aborted)).toBe(true);
 const transaction=new VersionedTransaction(version==='legacy'?Message.from(p.messageBytes):MessageV0.deserialize(p.messageBytes));transaction.sign([f.buyer]);expect(verifyKeepEquipmentPaymentSignedWire({preparedMessageBytes:p.messageBytes,signedTransaction:transaction.serialize(),buyer:f.buyer.publicKey}).messageSha256).toBe(p.messageSha256);
});
it('requires full ATA rent despite existing partial or excess prefunding',async()=>{
 const f=fixture('prefunded');for(const peer of f.peers)peer.controls.rows[2]!.lamports=3_000_000;
 const p=await f.read();expect(p.costs.rentLamports).toBe(2_039_280n);expect(p.original.sellerAtaExists).toBe(false);
});
it.each(['mint owner','mint size','mint decimals','mint uninitialized','mint invalid boolean','mint authority option','buyer mint','buyer owner','buyer frozen','buyer uninitialized','buyer invalid state','buyer native','buyer owner program','buyer extra bytes','seller mint','seller owner','seller frozen','seller invalid program','seller executable','system seller allocated','wallet program','wallet allocated','unsafe lamports'] as const)('holds %s before producing payment bytes',async kind=>{
 const f=fixture(kind==='system seller allocated'?'prefunded':'existing'),c=f.peers[1]!.controls;
 if(kind==='mint owner')c.rows[0]!.owner=SystemProgram.programId;
 if(kind==='mint size')c.rows[0]!.data=Buffer.alloc(81);
 if(kind==='mint decimals')data(f,1,0)[44]=TOKEN.decimals-1;
 if(kind==='mint uninitialized')data(f,1,0)[45]=0;
 if(kind==='mint invalid boolean')data(f,1,0)[45]=2;
 if(kind==='mint authority option')data(f,1,0).writeUInt32LE(2,0);
 if(kind==='buyer mint')Keypair.generate().publicKey.toBuffer().copy(data(f,1,1),0);
 if(kind==='buyer owner')f.seller.toBuffer().copy(data(f,1,1),32);
 if(kind==='buyer frozen')data(f,1,1)[108]=2;
 if(kind==='buyer uninitialized')data(f,1,1)[108]=0;
 if(kind==='buyer invalid state')data(f,1,1)[108]=3;
 if(kind==='buyer native')data(f,1,1).writeUInt32LE(1,109);
 if(kind==='buyer owner program')c.rows[1]!.owner=SystemProgram.programId;
 if(kind==='buyer extra bytes')c.rows[1]!.data=Buffer.alloc(166);
 if(kind==='seller mint')Keypair.generate().publicKey.toBuffer().copy(data(f,1,2),0);
 if(kind==='seller owner')f.buyer.publicKey.toBuffer().copy(data(f,1,2),32);
 if(kind==='seller frozen')data(f,1,2)[108]=2;
 if(kind==='seller invalid program')c.rows[2]!.owner=Keypair.generate().publicKey;
 if(kind==='seller executable')c.rows[2]!.executable=true;
 if(kind==='system seller allocated')c.rows[2]!.data=Buffer.of(0);
 if(kind==='wallet program')c.rows[3]!.owner=TOKEN_PROGRAM_ID;
 if(kind==='wallet allocated')c.rows[3]!.data=Buffer.of(0);
 if(kind==='unsafe lamports')c.rows[3]!.lamports=Number.MAX_SAFE_INTEGER+1;
 await held(f);
});
it.each(['KEEP','SOL'] as const)('holds insufficient buyer %s instead of producing an unaffordable quote',async kind=>{
 const f=fixture('prefunded');for(let i=0;i<2;i++){if(kind==='KEEP')data(f,i,1).writeBigUInt64LE(f.original.totalBaseUnits-1n,64);else f.peers[i]!.controls.rows[3]!.lamports=2_044_279;}
 await held(f,kind==='KEEP'?'KEEP_BALANCE':'SOL_BALANCE');
});
it.each(['account','rent','fee','seller existence'] as const)('requires independent agreement on %s facts',async kind=>{
 const f=fixture();if(kind==='account')data(f,1,1).writeBigUInt64LE(10_000_001n,64);if(kind==='rent')f.peers[1]!.controls.rent++;if(kind==='fee')f.peers[1]!.controls.fee++;if(kind==='seller existence')f.peers[1]!.controls.rows[2]=null;await held(f,'PROVIDER_MISMATCH');
});
it.each(['genesis','closing genesis','opening slot','account context','block context','fee context','validity context','invalid blockhash','expired height','unsafe height','fee cap','invalid rent','missing account response'] as const)('holds %s evidence',async kind=>{
 const f=fixture(),p=f.peers[0]!;
 if(kind==='genesis')p.rpc.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
 if(kind==='closing genesis')p.rpc.getGenesisHash.mockResolvedValueOnce(f.genesis).mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
 if(kind==='opening slot')p.controls.slot=89;
 if(kind==='account context')p.controls.accountSlot=99;
 if(kind==='block context')p.controls.blockSlot=99;
 if(kind==='fee context')p.controls.feeSlot=99;
 if(kind==='validity context')p.controls.validitySlot=99;
 if(kind==='invalid blockhash')p.rpc.isBlockhashValid.mockResolvedValue({context:{slot:100},value:false});
 if(kind==='expired height')p.controls.height=301;
 if(kind==='unsafe height')p.controls.height=Number.MAX_SAFE_INTEGER+1;
 if(kind==='fee cap')p.controls.fee=100_001;
 if(kind==='invalid rent')p.controls.rent=0;
 if(kind==='missing account response')p.rpc.getMultipleAccountsInfoAndContext.mockResolvedValue({context:{slot:100},value:[]});
 await held(f);
});
it('permits different current provider slots while both validate the selected original blockhash',async()=>{
 const f=fixture(),a=f.peers[0]!,b=f.peers[1]!;
 a.rpc.getSlot.mockResolvedValueOnce(100).mockResolvedValueOnce(104);b.rpc.getSlot.mockResolvedValueOnce(101).mockResolvedValueOnce(105);
 a.controls.accountSlot=100;b.controls.accountSlot=101;a.controls.blockSlot=102;
 for(const p of f.peers){p.controls.feeSlot=103;p.controls.validitySlot=104;}
 const result=await f.read();expect(result.blockhash).toBe(f.blockhash);expect(result.observations.map(p=>p.accountSlot)).toEqual([100,101]);expect(result.observations.map(p=>p.closingSlot)).toEqual([104,105]);
});
it('copies original/trust/provider pins and every returned byte buffer before asynchronous evidence',async()=>{
 const f=fixture('missing'),read=createKeepEquipmentPaymentPreparationReader(f.connectors,f.trust),pending=read(f.original),wallet=f.original.buyer;
 f.original.buyer=f.seller.toBase58();f.original.totalBaseUnits=1n;Object.assign(f.trust,{expectedGenesisHash:Keypair.generate().publicKey.toBase58(),maxFeeLamports:0n});Object.assign(f.trust.providerIds,{0:'mutated'});
 const result=await pending,bytes=result.messageBytes;result.messageBytes.fill(0);f.peers[0]!.controls.rows[1]!.data.fill(0);
 expect(result.original.buyer).toBe(wallet);expect(result.original.totalBaseUnits).toBe(1_000_001n);expect(result.providerIds).toEqual(['private-one','private-two']);expect(result.messageBytes).toEqual(bytes);
 for(const value of [result,result.original,result.limits,result.providerIds,result.observedAccounts,result.observedAccounts[0],result.observations,result.observations[0],result.balances,result.costs])expect(Object.isFrozen(value)).toBe(true);
});
it('pins connector method identities before mutable provider objects can replace them',async()=>{
 const f=fixture(),original=f.peers[0]!.rpc.getBlockHeight;
 f.peers[0]!.rpc.getGenesisHash.mockImplementation(async()=>{f.peers[0]!.rpc.getBlockHeight=vi.fn(async()=>999);return f.genesis;});
 await f.read();expect(original).toHaveBeenCalledOnce();
});
it('passes detached messages to fee RPCs so provider mutation cannot rewrite saved consent',async()=>{
 const f=fixture();f.peers[0]!.rpc.getFeeForMessage.mockImplementation(async(message)=>{message.recentBlockhash=Keypair.generate().publicKey.toBase58();return {context:{slot:100},value:5000};});
 const p=await f.read();expect(Message.from(p.messageBytes).recentBlockhash).toBe(f.blockhash);
});
it('does not free concurrency capacity while timed-out providers ignore abort',async()=>{
 vi.useFakeTimers();const f=fixture(),resolvers:Array<(value:string)=>void>=[];
 f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>resolvers.push(resolve)));
 const read=createKeepEquipmentPaymentPreparationReader(f.connectors,{...f.trust,deadlineMs:10});
 for(let i=0;i<4;i++){const p=read(f.original),check=expect(p).rejects.toMatchObject({code:'DEADLINE',unpaidProven:false});await vi.advanceTimersByTimeAsync(11);await check;}
 await expect(read(f.original)).rejects.toMatchObject({code:'BUSY'});expect(f.peers[1]!.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 for(const resolve of resolvers)resolve(f.genesis);await vi.advanceTimersByTimeAsync(0);
 f.peers[1]!.rpc.getGenesisHash.mockResolvedValue(f.genesis);await expect(read(f.original)).resolves.toHaveProperty('messageSha256');
});
it('retains capacity after one failing peer while the other still owns an outstanding request',async()=>{
 const f=fixture(),resolvers:Array<(value:string)=>void>=[];f.peers[0]!.rpc.getGenesisHash.mockRejectedValue(Error('offline'));f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>resolvers.push(resolve)));
 const read=createKeepEquipmentPaymentPreparationReader(f.connectors,f.trust);for(let i=0;i<4;i++)await expect(read(f.original)).rejects.toMatchObject({code:'UNAVAILABLE'});
 await expect(read(f.original)).rejects.toMatchObject({code:'BUSY'});for(const resolve of resolvers)resolve(f.genesis);await Promise.resolve();await Promise.resolve();
});
it('fails closed for null/malformed fill data before opening an RPC',async()=>{
 const f=fixture(),read=createKeepEquipmentPaymentPreparationReader(f.connectors,f.trust);
 for(const input of [null,[],{}, {...f.original,proof:{}},{...f.original,totalBaseUnits:0n},{...f.original,buyer:'bad'},{...f.original,keepMint:Keypair.generate().publicKey.toBase58()}])await expect(read(input as typeof f.original)).rejects.toBeInstanceOf(KeepEquipmentPaymentPreparationError);
 expect(f.signals).toHaveLength(0);
});
it('requires private distinct provider and mint/genesis pins',()=>{
 const f=fixture();for(const trust of [null,{...f.trust,providerIds:['same','same']},{...f.trust,expectedKeepMint:'bad'},{...f.trust,deadlineMs:0},{...f.trust,transactionVersion:1}])expect(()=>createKeepEquipmentPaymentPreparationReader(f.connectors,trust as KeepEquipmentPaymentPreparationTrust)).toThrow(KeepEquipmentPaymentPreparationError);
});

it('copies validated response contexts and fees before later provider callbacks can mutate them',async()=>{
 const f=fixture(),peer=f.peers[0]!,snapshot={context:{slot:100},value:peer.controls.rows.map(copy)},fee={context:{slot:100},value:5000},valid={context:{slot:100},value:true};
 peer.rpc.getMultipleAccountsInfoAndContext.mockResolvedValue(snapshot);peer.rpc.getFeeForMessage.mockResolvedValue(fee);peer.rpc.isBlockhashValid.mockResolvedValue(valid);
 peer.rpc.getMinimumBalanceForRentExemption.mockImplementation(async()=>{snapshot.context.slot=1;snapshot.value[1]!.data.fill(0);return 2_039_280;});
 peer.rpc.getBlockHeight.mockImplementation(async()=>{fee.context.slot=1;fee.value=0;valid.context.slot=1;valid.value=false;return 200;});
 const result=await f.read();expect(result.costs.feeLamports).toBe(5000n);expect(result.observations[0]).toMatchObject({accountSlot:100,feeSlot:100,validitySlot:100});expect(result.balances.buyerKeepBaseUnits).toBe(10_000_000n);
});
