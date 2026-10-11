import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {Keypair,Message,MessageV0,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {ACCOUNT_SIZE,MINT_SIZE,AccountLayout,AccountState,MintLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {TOKEN} from '@shardkeep/shared';
import {buildKeepEquipmentPaymentMessage,type KeepEquipmentPaymentOriginal} from './keepEquipmentPayment';
import {createKeepEquipmentPaymentPreparationReader,type KeepEquipmentPreparationAccount,type KeepEquipmentPaymentPreparationTrust,type KeepEquipmentPaymentPreparationRpc} from './keepEquipmentPaymentPreparation';
import {createKeepEquipmentPaymentCurrentReader,KeepEquipmentPaymentCurrentError,type KeepEquipmentPaymentCurrentInput} from './keepEquipmentPaymentCurrent';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const copy=(row:KeepEquipmentPreparationAccount|null)=>row===null?null:{owner:new PublicKey(row.owner.toBytes()),data:Buffer.from(row.data),executable:row.executable,lamports:row.lamports};
function fixture(mode:'existing'|'missing'|'prefunded'|'created-race'='existing',transactionVersion:'legacy'|0='legacy'){
 const buyer=Keypair.generate().publicKey,seller=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,genesis=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();
 const trust:KeepEquipmentPaymentPreparationTrust={expectedGenesisHash:genesis,expectedKeepMint:mint.toBase58(),minContextSlot:90,deadlineMs:100,transactionVersion,providerIds:['private-one','private-two'],maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000};
 const original:KeepEquipmentPaymentOriginal={reservationId:randomUUID(),buyer:buyer.toBase58(),seller:seller.toBase58(),keepMint:mint.toBase58(),totalBaseUnits:1_000_001n,sellerAtaExists:mode==='existing',...(mode!=='existing'?{sellerAtaRentCapLamports:2_039_280n}:{})};
 const built=buildKeepEquipmentPaymentMessage(original,trust,blockhash,transactionVersion);
 const saved:KeepEquipmentPaymentCurrentInput={original,messageBytes:built.messageBytes,messageSha256:built.messageSha256,blockhash,lastValidBlockHeight:300,minContextSlot:95};
 const mintData=Buffer.alloc(MINT_SIZE);MintLayout.encode({mintAuthorityOption:1,mintAuthority:buyer,supply:20_000_000n,decimals:TOKEN.decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);
 const ata=(owner:PublicKey,amount:bigint)=>{const data=Buffer.alloc(ACCOUNT_SIZE);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:AccountState.Initialized,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return {owner:TOKEN_PROGRAM_ID,data,executable:false,lamports:2_039_280};};
 const initial:Array<KeepEquipmentPreparationAccount|null>=[{owner:TOKEN_PROGRAM_ID,data:mintData,executable:false,lamports:1_461_600},ata(buyer,10_000_000n),mode==='missing'?null:mode==='prefunded'?{owner:SystemProgram.programId,data:Buffer.alloc(0),executable:false,lamports:890_880}:ata(seller,5n),{owner:SystemProgram.programId,data:Buffer.alloc(0),executable:false,lamports:100_000_000}];
 const expectedKeys=[mint,getAssociatedTokenAddressSync(mint,buyer),getAssociatedTokenAddressSync(mint,seller),buyer].map(k=>k.toBase58());
 const peers=[0,1].map(()=>{
  const controls={rows:initial.map(copy),rent:2_039_280,fee:5_000,slot:100,accountSlot:100,feeSlot:100,validitySlot:100,height:200};
  const rpc={
   getGenesisHash:vi.fn(async()=>genesis),getSlot:vi.fn(async()=>controls.slot),
   getMultipleAccountsInfoAndContext:vi.fn(async(keys:PublicKey[],options:{commitment:'finalized';minContextSlot:number})=>{expect(keys.map(k=>k.toBase58())).toEqual(expectedKeys);expect(options).toEqual({commitment:'finalized',minContextSlot:controls.slot});return {context:{slot:controls.accountSlot},value:controls.rows.map(copy)};}),
   getMinimumBalanceForRentExemption:vi.fn(async(bytes:number,commitment:'finalized')=>{expect(bytes).toBe(165);expect(commitment).toBe('finalized');return controls.rent;}),
   getLatestBlockhashAndContext:vi.fn(async()=>({context:{slot:100},value:{blockhash,lastValidBlockHeight:300}})),
   getFeeForMessage:vi.fn(async(message:Message|MessageV0,commitment:'finalized')=>{expect(commitment).toBe('finalized');expect(Uint8Array.from(message.serialize())).toEqual(saved.messageBytes);return {context:{slot:controls.feeSlot},value:controls.fee};}),
   isBlockhashValid:vi.fn(async(value:string,options:{commitment:'finalized';minContextSlot:number})=>{expect(value).toBe(blockhash);expect(options.commitment).toBe('finalized');return {context:{slot:controls.validitySlot},value:true};}),
   getBlockHeight:vi.fn(async(options:{commitment:'finalized';minContextSlot:number})=>{expect(options.commitment).toBe('finalized');return controls.height;}),
  } satisfies KeepEquipmentPaymentPreparationRpc;
  return {controls,rpc};
 });
 const signals:AbortSignal[]=[];
 const connectors=[(signal:AbortSignal)=>{signals.push(signal);return peers[0]!.rpc;},(signal:AbortSignal)=>{signals.push(signal);return peers[1]!.rpc;}] as const;
 const read=()=>createKeepEquipmentPaymentCurrentReader(connectors,trust)(saved);
 return {buyer,seller,mint,genesis,blockhash,original,saved,trust,peers,signals,connectors,read};
}
const data=(f:ReturnType<typeof fixture>,peer:number,row:number)=>f.peers[peer]!.controls.rows[row]!.data as Buffer;
const noAuthority={signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false,finalityVerified:false};
async function held(f:ReturnType<typeof fixture>,code?:string){await expect(f.read()).rejects.toMatchObject({...noAuthority,...(code?{code}:{})});}
afterEach(()=>vi.useRealTimers());

it.each((['legacy',0] as const).flatMap(version=>(['existing','missing','prefunded','created-race'] as const).map(mode=>({version,mode}))))('reviews the saved $version $mode packet without replacing its message, blockhash or authority',async({version,mode})=>{
 const f=fixture(mode,version),result=await f.read();
 expect(result).toMatchObject({...noAuthority,currentReviewPassed:true,transactionVersion:version,original:f.original,blockhash:f.blockhash,lastValidBlockHeight:300,minContextSlot:95,messageSha256:f.saved.messageSha256});
 expect(result.messageBytes).toEqual(f.saved.messageBytes);expect(result.costs).toEqual({feeLamports:5000n,rentLamports:mode==='existing'?0n:2_039_280n,fullAtaRentLamports:2_039_280n,totalLamports:mode==='existing'?5000n:2_044_280n});
 expect(result.balances.sellerAccountState).toBe(mode==='created-race'?'existing':mode);
 for(const peer of f.peers){expect(peer.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();expect(peer.rpc.getFeeForMessage).toHaveBeenCalledOnce();expect(peer.rpc.isBlockhashValid).toHaveBeenCalledWith(f.blockhash,{commitment:'finalized',minContextSlot:100});expect(peer.rpc.getGenesisHash).toHaveBeenCalledTimes(2);}
 expect(f.signals.every(signal=>signal.aborted)).toBe(true);
});
it('accepts a real preparation result unchanged, without repeating preparation or refreshing its validity horizon',async()=>{
 const f=fixture('missing',0),{sellerAtaExists:_exists,sellerAtaRentCapLamports:_rent,...fill}=f.original;
 const preparation=await createKeepEquipmentPaymentPreparationReader(f.connectors,f.trust)(fill);
 for(const peer of f.peers)peer.rpc.getLatestBlockhashAndContext.mockClear();
 const current=await createKeepEquipmentPaymentCurrentReader(f.connectors,f.trust)({original:preparation.original,messageBytes:preparation.messageBytes,messageSha256:preparation.messageSha256,blockhash:preparation.blockhash,lastValidBlockHeight:preparation.lastValidBlockHeight,minContextSlot:preparation.minContextSlot});
 expect(current.messageBytes).toEqual(preparation.messageBytes);expect(current.original).toEqual(preparation.original);expect(current.lastValidBlockHeight).toBe(preparation.lastValidBlockHeight);
 for(const peer of f.peers)expect(peer.rpc.getLatestBlockhashAndContext).not.toHaveBeenCalled();
});
it.each(['missing','created-race'] as const)('holds full current rent above original creation consent even for %s',async mode=>{
 const f=fixture(mode);for(const peer of f.peers)peer.controls.rent++;await held(f,'ATA_RENT_CAP');
});
it('does not subtract prefunding or lower the full rent requirement after a seller-ATA creation race',async()=>{
 for(const mode of ['prefunded','created-race'] as const){const f=fixture(mode);for(const peer of f.peers){peer.controls.rows[2]!.lamports=3_000_000;peer.controls.rows[3]!.lamports=2_044_279;}await held(f,'SOL_BALANCE');}
});
it.each(['missing','prefunded'] as const)('holds a saved no-create packet when the seller ATA is now %s',async mode=>{
 const f=fixture(),other=fixture(mode);for(const peer of f.peers)peer.controls.rows[2]=copy(other.peers[0]!.controls.rows[2]!);await held(f,'SELLER_ACCOUNT');
});
it('does not invent rent spending for a saved no-create packet when current rent changes',async()=>{
 const f=fixture();for(const peer of f.peers){peer.controls.rent++;peer.controls.rows[3]!.lamports=5000;}expect((await f.read()).costs.totalLamports).toBe(5000n);
});
it.each(['KEEP','SOL'] as const)('holds changed buyer %s funds rather than creating a replacement or claiming nonpayment',async kind=>{
 const f=fixture();for(let i=0;i<2;i++){if(kind==='KEEP')data(f,i,1).writeBigUInt64LE(f.original.totalBaseUnits-1n,64);else f.peers[i]!.controls.rows[3]!.lamports=4999;}await held(f,kind==='KEEP'?'KEEP_BALANCE':'SOL_BALANCE');
});
it.each(['mint owner','mint size','mint decimals','mint initialized','mint authority','buyer mint','buyer authority','buyer frozen','buyer native','buyer extension','seller frozen','seller mint','seller program','seller executable','prefunded allocated','wallet program','wallet allocated','unsafe lamports'] as const)('holds malformed current %s facts',async kind=>{
 const f=fixture(kind==='prefunded allocated'?'prefunded':'created-race'),p=f.peers[1]!.controls;
 if(kind==='mint owner')p.rows[0]!.owner=SystemProgram.programId;
 if(kind==='mint size')p.rows[0]!.data=Buffer.alloc(81);
 if(kind==='mint decimals')data(f,1,0)[44]=TOKEN.decimals-1;
 if(kind==='mint initialized')data(f,1,0)[45]=2;
 if(kind==='mint authority')data(f,1,0).writeUInt32LE(2,0);
 if(kind==='buyer mint')f.seller.toBuffer().copy(data(f,1,1),0);
 if(kind==='buyer authority')f.seller.toBuffer().copy(data(f,1,1),32);
 if(kind==='buyer frozen')data(f,1,1)[108]=2;
 if(kind==='buyer native')data(f,1,1).writeUInt32LE(1,109);
 if(kind==='buyer extension')p.rows[1]!.data=Buffer.alloc(166);
 if(kind==='seller frozen')data(f,1,2)[108]=2;
 if(kind==='seller mint')f.buyer.toBuffer().copy(data(f,1,2),0);
 if(kind==='seller program')p.rows[2]!.owner=f.buyer;
 if(kind==='seller executable')p.rows[2]!.executable=true;
 if(kind==='prefunded allocated')p.rows[2]!.data=Buffer.of(0);
 if(kind==='wallet program')p.rows[3]!.owner=TOKEN_PROGRAM_ID;
 if(kind==='wallet allocated')p.rows[3]!.data=Buffer.of(0);
 if(kind==='unsafe lamports')p.rows[3]!.lamports=Number.MAX_SAFE_INTEGER+1;
 await held(f);
});
it.each(['account','rent','fee','seller existence'] as const)('holds independent provider disagreement about %s',async kind=>{
 const f=fixture('created-race');if(kind==='account')data(f,1,1).writeBigUInt64LE(10_000_001n,64);if(kind==='rent')f.peers[1]!.controls.rent--;if(kind==='fee')f.peers[1]!.controls.fee++;if(kind==='seller existence')f.peers[1]!.controls.rows[2]=null;await held(f,'PROVIDER_MISMATCH');
});
it.each(['genesis','closing genesis','saved floor','operator floor','account context','fee context','validity context','closing slot','invalid blockhash','expired height','unsafe height','fee cap','unknown fee','invalid rent','missing accounts'] as const)('holds %s without asserting the saved packet is unpaid',async kind=>{
 const f=fixture(),p=f.peers[0]!;
 if(kind==='genesis')p.rpc.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
 if(kind==='closing genesis')p.rpc.getGenesisHash.mockResolvedValueOnce(f.genesis).mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
 if(kind==='saved floor')Object.assign(f.saved,{minContextSlot:101});
 if(kind==='operator floor')Object.assign(f.trust,{minContextSlot:101});
 if(kind==='account context')p.controls.accountSlot=99;
 if(kind==='fee context')p.controls.feeSlot=99;
 if(kind==='validity context')p.controls.validitySlot=99;
 if(kind==='closing slot')p.rpc.getSlot.mockResolvedValueOnce(100).mockResolvedValueOnce(99);
 if(kind==='invalid blockhash')p.rpc.isBlockhashValid.mockResolvedValue({context:{slot:100},value:false});
 if(kind==='expired height')p.controls.height=301;
 if(kind==='unsafe height')p.controls.height=Number.MAX_SAFE_INTEGER+1;
 if(kind==='fee cap')p.controls.fee=100_001;
 if(kind==='unknown fee')p.rpc.getFeeForMessage.mockResolvedValue({context:{slot:100},value:null as never});
 if(kind==='invalid rent')p.controls.rent=0;
 if(kind==='missing accounts')p.rpc.getMultipleAccountsInfoAndContext.mockResolvedValue({context:{slot:100},value:[]});
 await held(f);
});
it('allows different finalized slots and heights within the original expiry while holding every later context above both account snapshots',async()=>{
 const f=fixture(),a=f.peers[0]!,b=f.peers[1]!;b.controls.slot=101;b.controls.accountSlot=101;b.controls.height=300;
 a.rpc.getSlot.mockResolvedValueOnce(100).mockResolvedValueOnce(105);b.rpc.getSlot.mockResolvedValueOnce(101).mockResolvedValueOnce(106);
 for(const peer of f.peers){peer.controls.feeSlot=102;peer.controls.validitySlot=104;}
 const result=await f.read();expect(result.observations.map(p=>p.currentBlockHeight)).toEqual([200,300]);
 for(const peer of f.peers){expect(peer.rpc.isBlockhashValid).toHaveBeenCalledWith(f.blockhash,{commitment:'finalized',minContextSlot:102});expect(peer.rpc.getBlockHeight).toHaveBeenCalledWith({commitment:'finalized',minContextSlot:104});}
});
it('rejects malformed saved originals, message mismatch and arbitrary additional instructions before opening providers',async()=>{
 const f=fixture(),read=createKeepEquipmentPaymentCurrentReader(f.connectors,f.trust),message=Message.from(f.saved.messageBytes);
 const arbitrary=new TransactionMessage({payerKey:f.buyer,recentBlockhash:f.blockhash,instructions:[new TransactionInstruction({programId:SystemProgram.programId,keys:[],data:Buffer.of(0)})]}).compileToLegacyMessage().serialize();
 message.recentBlockhash=Keypair.generate().publicKey.toBase58();const replacement=message.serialize();
 for(const input of [null,[],{}, {...f.saved,proof:{}},{...f.saved,messageBytes:new Uint8Array(1233)},{...f.saved,messageBytes:arbitrary,messageSha256:hash(arbitrary)},
  {...f.saved,messageBytes:replacement,messageSha256:hash(replacement)},{...f.saved,messageSha256:'0'.repeat(64)}, {...f.saved,blockhash:'bad'},
  {...f.saved,lastValidBlockHeight:0},{...f.saved,minContextSlot:-1},{...f.saved,original:{...f.original,instructions:[]}},
  {...f.saved,original:{...f.original,keepMint:Keypair.generate().publicKey.toBase58()}},{...f.saved,original:{...f.original,totalBaseUnits:0n}},
  {...f.saved,original:{...f.original,sellerAtaExists:false}}])await expect(read(input as KeepEquipmentPaymentCurrentInput)).rejects.toBeInstanceOf(KeepEquipmentPaymentCurrentError);
 expect(f.signals).toHaveLength(0);
});
it('requires the privately fixed message version and rejects unapproved compute instructions',async()=>{
 const f=fixture(),v0=buildKeepEquipmentPaymentMessage(f.original,f.trust,f.blockhash,0),compute=buildKeepEquipmentPaymentMessage(f.original,f.trust,f.blockhash,'legacy',{units:100_000});
 const read=createKeepEquipmentPaymentCurrentReader(f.connectors,f.trust);
 for(const built of [v0,compute])await expect(read({...f.saved,messageBytes:built.messageBytes,messageSha256:built.messageSha256})).rejects.toMatchObject({code:'MESSAGE'});expect(f.signals).toHaveLength(0);
});
it('copies saved terms, expiry, bytes and private pins before asynchronous evidence and returns detached immutable evidence',async()=>{
 const f=fixture('missing'),read=createKeepEquipmentPaymentCurrentReader(f.connectors,f.trust),before=Uint8Array.from(f.saved.messageBytes),original={...f.original},promise=read(f.saved);
 // Fee assertions must compare the original bytes after the caller mutates its input.
 for(const peer of f.peers)peer.rpc.getFeeForMessage.mockImplementation(async message=>{expect(Uint8Array.from(message.serialize())).toEqual(before);return {context:{slot:100},value:5000};});
 Object.assign(f.original,{buyer:f.seller.toBase58(),totalBaseUnits:1n});Object.assign(f.saved,{lastValidBlockHeight:1,minContextSlot:999,blockhash:Keypair.generate().publicKey.toBase58()});f.saved.messageBytes.fill(0);
 Object.assign(f.trust,{maxFeeLamports:0n,expectedGenesisHash:'bad'});Object.assign(f.trust.providerIds,{0:'changed'});
 const result=await promise;result.messageBytes.fill(0);f.peers[0]!.controls.rows[1]!.data.fill(0);
 expect(result.original).toEqual(original);expect(result.messageBytes).toEqual(before);expect(result).toMatchObject({lastValidBlockHeight:300,minContextSlot:95,providerIds:['private-one','private-two']});
 for(const value of [result,result.original,result.limits,result.providerIds,result.observedAccounts,result.observedAccounts[0],result.observations,result.observations[0],result.balances,result.costs])expect(Object.isFrozen(value)).toBe(true);
});
it('fixes connector method identities and passes detached original messages to fee providers',async()=>{
 const f=fixture(),original=f.peers[0]!.rpc.getBlockHeight;
 f.peers[0]!.rpc.getGenesisHash.mockImplementation(async()=>{f.peers[0]!.rpc.getBlockHeight=vi.fn(async()=>999);return f.genesis;});
 f.peers[0]!.rpc.getFeeForMessage.mockImplementation(async message=>{message.recentBlockhash=Keypair.generate().publicKey.toBase58();return {context:{slot:100},value:5000};});
 const result=await f.read();expect(original).toHaveBeenCalledOnce();expect(Message.from(result.messageBytes).recentBlockhash).toBe(f.blockhash);
});
it('copies validated account contexts, fees and blockhash validity before later provider callbacks mutate responses',async()=>{
 const f=fixture(),peer=f.peers[0]!,snapshot={context:{slot:100},value:peer.controls.rows.map(copy)},fee={context:{slot:100},value:5000},valid={context:{slot:100},value:true};
 peer.rpc.getMultipleAccountsInfoAndContext.mockResolvedValue(snapshot);peer.rpc.getFeeForMessage.mockResolvedValue(fee);peer.rpc.isBlockhashValid.mockResolvedValue(valid);
 peer.rpc.getMinimumBalanceForRentExemption.mockImplementation(async()=>{snapshot.context.slot=1;snapshot.value[1]!.data.fill(0);return 2_039_280;});
 peer.rpc.getBlockHeight.mockImplementation(async()=>{fee.context.slot=1;fee.value=0;valid.context.slot=1;valid.value=false;return 200;});
 const result=await f.read();expect(result.costs.feeLamports).toBe(5000n);expect(result.observations[0]).toMatchObject({accountSlot:100,feeSlot:100,validitySlot:100});expect(result.balances.buyerKeepBaseUnits).toBe(10_000_000n);
});
it('retains concurrency occupancy while timed-out providers ignore abort, then drains without scheduling later work',async()=>{
 vi.useFakeTimers();const f=fixture(),resolvers:Array<(value:string)=>void>=[];f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>resolvers.push(resolve)));
 const read=createKeepEquipmentPaymentCurrentReader(f.connectors,{...f.trust,deadlineMs:10});
 for(let i=0;i<4;i++){const check=expect(read(f.saved)).rejects.toMatchObject({...noAuthority,code:'DEADLINE'});await vi.advanceTimersByTimeAsync(11);await check;}
 await expect(read(f.saved)).rejects.toMatchObject({code:'BUSY'});expect(f.peers[1]!.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 for(const resolve of resolvers)resolve(f.genesis);await vi.advanceTimersByTimeAsync(0);expect(f.peers[1]!.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 f.peers[1]!.rpc.getGenesisHash.mockResolvedValue(f.genesis);await expect(read(f.saved)).resolves.toHaveProperty('currentReviewPassed',true);
});
it('does not free a failed peer’s concurrency slot while its counterpart is still outstanding',async()=>{
 const f=fixture(),resolvers:Array<(value:string)=>void>=[];f.peers[0]!.rpc.getGenesisHash.mockRejectedValue(Error('offline'));f.peers[1]!.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>resolvers.push(resolve)));
 const read=createKeepEquipmentPaymentCurrentReader(f.connectors,f.trust);for(let i=0;i<4;i++)await expect(read(f.saved)).rejects.toMatchObject({...noAuthority,code:'UNAVAILABLE'});
 await expect(read(f.saved)).rejects.toMatchObject({code:'BUSY'});for(const resolve of resolvers)resolve(f.genesis);await Promise.resolve();await Promise.resolve();
});
it('fails closed for malformed private provider configuration before any RPC',()=>{
 const f=fixture();for(const trust of [null,{...f.trust,providerIds:['same','same']},{...f.trust,expectedKeepMint:'bad'},{...f.trust,deadlineMs:0},{...f.trust,transactionVersion:1},{...f.trust,maxFeeLamports:-1n}])expect(()=>createKeepEquipmentPaymentCurrentReader(f.connectors,trust as KeepEquipmentPaymentPreparationTrust)).toThrow(KeepEquipmentPaymentCurrentError);
 expect(f.signals).toHaveLength(0);
});
