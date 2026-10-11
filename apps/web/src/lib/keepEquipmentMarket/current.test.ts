import {webcrypto} from 'node:crypto';
import {Buffer} from 'buffer';
import {Keypair,Message,MessageV0,PublicKey,SystemProgram,type SignatureStatus} from '@solana/web3.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P,TOKEN} from '@shardkeep/shared';
import {createKeepEquipmentCurrentChecks,type KeepEquipmentCurrentConnection} from './current';
import {KEEP_TOKEN_PROGRAM,prepareKeepEquipmentSigning,signKeepEquipment} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';

beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
type Row={owner:PublicKey;lamports:number;executable:boolean;data:Buffer};
const copy=(row:Row|null)=>row===null?null:{...row,owner:new PublicKey(row.owner.toBytes()),data:Buffer.from(row.data)};

function fixture(version:'legacy'|0='legacy',createAta=false){
 const f=keepMarketFixture(version,createAta),p=f.value.preparation!;
 const {recordedAt:_at,blockhashSlot:_blockhashSlot,...current}=structuredClone(p);
 const review={purchase:structuredClone(f.value),current:{...current,currentReviewPassed:true as const,finalityVerified:false as const},reviewedAt:p.recordedAt,expiresAt:new Date(Date.parse(p.recordedAt)+P.reviewMaxAgeMs).toISOString()};
 const token=(wallet:string,amount:bigint):Row=>{const data=Buffer.alloc(165);new PublicKey(f.trust.expectedKeepMint).toBuffer().copy(data,0);new PublicKey(wallet).toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;return {owner:KEEP_TOKEN_PROGRAM,lamports:2039280,executable:false,data};};
 const mint=Buffer.alloc(82);mint[44]=TOKEN.decimals;mint[45]=1;
 const rows:Array<Row|null>=[{owner:KEEP_TOKEN_PROGRAM,lamports:1461600,executable:false,data:mint},token(p.original.buyer,10000000n),createAta?null:token(p.original.seller,0n),{owner:SystemProgram.programId,lamports:100000000,executable:false,data:Buffer.alloc(0)}];
 const controls={rows,rent:2039280,fee:5000 as number|null,accountSlot:104,feeSlot:105,validitySlot:106,statusSlot:107,height:200,valid:true,status:null as SignatureStatus|null};
 const rpc={
  getGenesisHash:vi.fn(async()=>f.trust.expectedGenesisHash),
  getMultipleAccountsInfoAndContext:vi.fn(async(_keys:PublicKey[],_options:unknown)=>({context:{slot:controls.accountSlot},value:controls.rows.map(copy)})),
  getMinimumBalanceForRentExemption:vi.fn(async(_size:number,_commitment:unknown)=>controls.rent),
  getFeeForMessage:vi.fn(async(_message:Message|MessageV0,_commitment:unknown)=>({context:{slot:controls.feeSlot},value:controls.fee})),
  isBlockhashValid:vi.fn(async(_hash:string,_options:unknown)=>({context:{slot:controls.validitySlot},value:controls.valid})),
  getBlockHeight:vi.fn(async(_options:unknown)=>controls.height),
  getSignatureStatuses:vi.fn(async(_signatures:string[],_options:unknown)=>({context:{slot:controls.statusSlot},value:[controls.status]})),
 };
 const guard=vi.fn(),check=createKeepEquipmentCurrentChecks(rpc as unknown as KeepEquipmentCurrentConnection,f.trust);
 const run=(started=performance.now())=>check(f.value,review,started,guard);
 return {...f,review,controls,rpc,guard,check,run,token};
}
type Fixture=ReturnType<typeof fixture>;
async function retain(f:Fixture){
 const prepared=await prepareKeepEquipmentSigning(f.value,f.trust,f.value.fill.buyerWallet),wire=await signKeepEquipment(prepared,f.signer);
 f.value.wire={...wire,recordedAt:f.value.preparation!.recordedAt};f.value.status='signed';f.review.purchase=structuredClone(f.value);return wire;
}

it.each([['legacy',false],['legacy',true],[0,false],[0,true]] as const)('independently prices %s create=%s exact saved packet and checks its original accounts',async(version,create)=>{
 const f=fixture(version,create);await f.run();const p=f.value.preparation!;
 expect(f.rpc.getGenesisHash).toHaveBeenCalledTimes(2);
 const [keys,options]=f.rpc.getMultipleAccountsInfoAndContext.mock.calls[0]!;
 expect(keys.map(k=>k.toBase58())).toEqual([p.original.keepMint,f.built.buyerAta,f.built.sellerAta,p.original.buyer]);
 expect(options).toEqual({commitment:'finalized',minContextSlot:103});
 expect(Buffer.from(f.rpc.getFeeForMessage.mock.calls[0]![0].serialize()).toString('hex')).toBe(p.messageHex);
 expect(f.rpc.getMinimumBalanceForRentExemption).toHaveBeenCalledWith(165,'finalized');
 expect(f.rpc.isBlockhashValid).toHaveBeenCalledWith(p.blockhash,{commitment:'finalized',minContextSlot:105});
 expect(f.rpc.getBlockHeight).toHaveBeenCalledWith({commitment:'finalized',minContextSlot:106});
 expect(f.rpc.getSignatureStatuses).not.toHaveBeenCalled();expect(f.guard).toHaveBeenCalled();
});

it.each(['mint program','mint length','mint decimals','mint initialization','mint authority option','buyer mint','buyer authority','buyer frozen','buyer native','buyer extension','buyer delegate option','seller owner','seller frozen','seller close option','executable','unsafe lamports','payer program','payer allocated'] as const)('refuses malformed independent %s instead of trusting the server review',async kind=>{
 const f=fixture(),r=f.controls.rows;
 if(kind==='mint program')r[0]!.owner=SystemProgram.programId;
 if(kind==='mint length')r[0]!.data=Buffer.alloc(81);
 if(kind==='mint decimals')r[0]!.data[44]=TOKEN.decimals-1;
 if(kind==='mint initialization')r[0]!.data[45]=2;
 if(kind==='mint authority option')r[0]!.data.writeUInt32LE(2,0);
 if(kind==='buyer mint')f.buyer.publicKey.toBuffer().copy(r[1]!.data,0);
 if(kind==='buyer authority')f.seller.publicKey.toBuffer().copy(r[1]!.data,32);
 if(kind==='buyer frozen')r[1]!.data[108]=2;
 if(kind==='buyer native')r[1]!.data.writeUInt32LE(1,109);
 if(kind==='buyer extension')r[1]!.data=Buffer.alloc(166);
 if(kind==='buyer delegate option')r[1]!.data.writeUInt32LE(2,72);
 if(kind==='seller owner')r[2]!.owner=SystemProgram.programId;
 if(kind==='seller frozen')r[2]!.data[108]=2;
 if(kind==='seller close option')r[2]!.data.writeUInt32LE(2,129);
 if(kind==='executable')r[0]!.executable=true;
 if(kind==='unsafe lamports')r[3]!.lamports=Number.MAX_SAFE_INTEGER+1;
 if(kind==='payer program')r[3]!.owner=KEEP_TOKEN_PROGRAM;
 if(kind==='payer allocated')r[3]!.data=Buffer.of(0);
 await expect(f.run()).rejects.toThrow();expect(f.rpc.getFeeForMessage).not.toHaveBeenCalled();
});

it.each(['missing','prefunded'] as const)('refuses a no-create original when seller ATA became %s',async mode=>{
 const f=fixture();f.controls.rows[2]=mode==='missing'?null:{owner:SystemProgram.programId,lamports:890880,executable:false,data:Buffer.alloc(0)};
 await expect(f.run()).rejects.toThrow();
});

it.each(['prefunded','created race'] as const)('retains the full saved creation rent through %s and never discounts funding',async mode=>{
 const f=fixture(0,true);f.controls.rows[2]=mode==='prefunded'?{owner:SystemProgram.programId,lamports:890880,executable:false,data:Buffer.alloc(0)}:f.token(f.value.fill.sellerWallet,0n);
 f.controls.rows[3]!.lamports=2044280;await f.run();
 f.controls.rows[3]!.lamports--;await expect(f.run()).rejects.toThrow('Not enough SOL');
 f.controls.rows[3]!.lamports=100000000;f.controls.rent++;f.review.current.costs.fullAtaRentLamports=String(f.controls.rent);f.review.current.costs.rentLamports=String(f.controls.rent);f.review.current.costs.totalLamports=String(f.controls.rent+5000);
 await expect(f.run()).rejects.toThrow();
});

it.each(['KEEP','SOL','fee disagreement','rent disagreement','fee limit','missing fee','invalid rent','quoted total'] as const)('holds changed %s without accepting a cheaper or unfunded consent',async kind=>{
 const f=fixture('legacy',true);
 if(kind==='KEEP')f.controls.rows[1]!.data.writeBigUInt64LE(1000000n,64);
 if(kind==='SOL')f.controls.rows[3]!.lamports=2044279;
 if(kind==='fee disagreement')f.controls.fee=5001;
 if(kind==='rent disagreement')f.controls.rent--;
 if(kind==='fee limit'){f.controls.fee=100001;f.review.current.costs.feeLamports='100001';f.review.current.costs.totalLamports='2139281';}
 if(kind==='missing fee')f.controls.fee=null;
 if(kind==='invalid rent')f.controls.rent=0;
 if(kind==='quoted total')f.review.current.costs.totalLamports='1';
 await expect(f.run()).rejects.toThrow();
});

it.each(['account slot','fee slot','validity slot','expired height','unsafe height','invalid blockhash','opening network','closing network'] as const)('holds %s rather than replace the blockhash or infer unpaid status',async kind=>{
 const f=fixture();
 if(kind==='account slot')f.controls.accountSlot=102;
 if(kind==='fee slot')f.controls.feeSlot=103;
 if(kind==='validity slot')f.controls.validitySlot=104;
 if(kind==='expired height')f.controls.height=301;
 if(kind==='unsafe height')f.controls.height=Number.MAX_SAFE_INTEGER+1;
 if(kind==='invalid blockhash')f.controls.valid=false;
 if(kind==='opening network')f.rpc.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
 if(kind==='closing network')f.rpc.getGenesisHash.mockResolvedValueOnce(f.trust.expectedGenesisHash).mockResolvedValueOnce(Keypair.generate().publicKey.toBase58());
 await expect(f.run()).rejects.toThrow();
});

it.each(['message','blockhash','mint','genesis','base','fee pin','rent pin'] as const)('rejects changed %s before contacting the independent wallet provider',async kind=>{
 const f=fixture('legacy',true);
 if(kind==='message')f.review.current.messageHex='00';
 if(kind==='blockhash')f.review.current.blockhash=Keypair.generate().publicKey.toBase58();
 if(kind==='mint')f.review.current.expectedKeepMint=Keypair.generate().publicKey.toBase58();
 if(kind==='genesis')f.review.current.expectedGenesisHash=Keypair.generate().publicKey.toBase58();
 if(kind==='base')f.review.purchase.fill.buyerBaseId='12345678-1234-4234-8234-123456789012';
 if(kind==='fee pin'){f.value.preparation!.limits.maxFeeLamports='100001';f.review.purchase=structuredClone(f.value);}
 if(kind==='rent pin'){f.value.preparation!.original.sellerAtaRentCapLamports='2039281';f.review.purchase=structuredClone(f.value);f.review.current.original=structuredClone(f.value.preparation!.original);}
 await expect(f.run()).rejects.toThrow();expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
});

it('detects another server session retaining a wire before any new signature review proceeds',async()=>{
 const f=fixture(),unsigned=structuredClone(f.value);await retain(f);Object.assign(f.value,unsigned);
 await expect(f.run()).rejects.toThrow('Another session advanced');expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
});

it('a retained packet checks exactly its own historical signature without treating null as nonpayment proof',async()=>{
 const f=fixture(0),wire=await retain(f);expect(await f.run()).toBeUndefined();
 expect(f.rpc.getSignatureStatuses).toHaveBeenCalledWith([wire.signature],{searchTransactionHistory:true});
});

it.each(['processed','confirmed','finalized'] as const)('holds a retained signature reported %s so the caller must recover instead of resending',async confirmationStatus=>{
 const f=fixture();await retain(f);f.controls.status={slot:106,confirmations:confirmationStatus==='finalized'?null:1,err:null,confirmationStatus};
 await expect(f.run()).rejects.toThrow('recover it first');
});

it('refuses stale signature context even when the provider returns no status',async()=>{
 const f=fixture();await retain(f);f.controls.statusSlot=105;await expect(f.run()).rejects.toThrow();
});

it.each([P.reviewMaxAgeMs,-1])('rejects elapsed performance age %s before any RPC',async age=>{
 const f=fixture();vi.spyOn(performance,'now').mockReturnValue(100000);
 await expect(f.run(100000-age)).rejects.toThrow('expired');expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
});

it('rechecks elapsed time and active wallet/session guards after every asynchronous observation',async()=>{
 const f=fixture();let time=100;vi.spyOn(performance,'now').mockImplementation(()=>time);
 f.rpc.getGenesisHash.mockImplementation(async()=>{time+=P.reviewMaxAgeMs;return f.trust.expectedGenesisHash;});
 await expect(f.run(100)).rejects.toThrow('expired');expect(f.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 const next=fixture();next.rpc.getGenesisHash.mockImplementation(async()=>{next.guard.mockImplementation(()=>{throw Error('wallet changed');});return next.trust.expectedGenesisHash;});
 await expect(next.run()).rejects.toThrow('wallet changed');expect(next.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
});

it('copies the purchase, review, private pins and account bytes before later callbacks can mutate them',async()=>{
 const f=fixture(),before=structuredClone(f.value),expectedKeys=[before.preparation!.original.keepMint,f.built.buyerAta,f.built.sellerAta,before.fill.buyerWallet];
 f.rpc.getGenesisHash.mockResolvedValue(f.trust.expectedGenesisHash);
 const pending=f.run();f.value.preparation!.original.buyer=f.seller.publicKey.toBase58();f.review.current.messageHex='00';Object.assign(f.trust,{expectedGenesisHash:Keypair.generate().publicKey.toBase58()});
 await pending;
 expect(f.rpc.getMultipleAccountsInfoAndContext.mock.calls[0]![0].map(k=>k.toBase58())).toEqual(expectedKeys);
 const next=fixture(),snapshot={context:{slot:104},value:next.controls.rows.map(copy)};
 next.rpc.getMultipleAccountsInfoAndContext.mockResolvedValue(snapshot);
 next.rpc.getMinimumBalanceForRentExemption.mockImplementation(async()=>{snapshot.context.slot=1;snapshot.value[1]!.data.fill(0);return next.controls.rent;});
 await next.run();
});

it('pins connection methods before provider callbacks can replace later checks',async()=>{
 const f=fixture(),height=f.rpc.getBlockHeight;
 f.rpc.getGenesisHash.mockImplementation(async()=>{f.rpc.getBlockHeight=vi.fn(async()=>999);return f.trust.expectedGenesisHash;});
 await f.run();expect(height).toHaveBeenCalledOnce();
});

it('holds timeout capacity until abort-ignoring calls drain and schedules no later checks after timeout',async()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const f=fixture();
 const outstanding:Array<()=>void>=[];let entered:()=>void=()=>undefined;
 f.rpc.getGenesisHash.mockImplementation(()=>new Promise<string>(resolve=>{outstanding.push(()=>resolve(f.trust.expectedGenesisHash));entered();}));
 for(let i=0;i<P.maxPendingRpc;i++){
  const began=new Promise<void>(resolve=>{entered=resolve;});
  const checked=expect(f.run()).rejects.toThrow('timed out');await began;await vi.advanceTimersByTimeAsync(P.rpcTimeoutMs+1);await checked;
 }
 await expect(f.run()).rejects.toThrow('still pending');expect(f.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 for(const finish of outstanding)finish();await vi.advanceTimersByTimeAsync(0);
 expect(f.rpc.getMultipleAccountsInfoAndContext).not.toHaveBeenCalled();
 f.rpc.getGenesisHash.mockResolvedValue(f.trust.expectedGenesisHash);await f.run();
});

it('releases capacity after a completed provider rejection without hiding the failure',async()=>{
 const f=fixture();f.rpc.getGenesisHash.mockRejectedValue(Error('offline'));
 for(let i=0;i<P.maxPendingRpc+1;i++)await expect(f.run()).rejects.toThrow('offline');
 f.rpc.getGenesisHash.mockResolvedValue(f.trust.expectedGenesisHash);await f.run();
});
