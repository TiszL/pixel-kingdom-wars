import {describe,it,expect,vi} from 'vitest';
import {Message,PublicKey} from '@solana/web3.js';
import {realmSaleFailureFixture as fixture,realmSaleQuotaLoserFixture} from './testFixtures/seekerRealmSaleFailure';
import {createSeekerRealmSaleFailureVerifier} from './seekerRealmSaleFailure';
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n));
const read=async(f:Awaited<ReturnType<typeof fixture>>)=>createSeekerRealmSaleFailureVerifier(()=>f.rpc,f.trust)(f.request);
describe('exact finalized realm sale failure foundation',()=>{
 it('proves the signed final-slot loser with actual fee above quote and no payment, rent or access/quota effect',async()=>{
  const f=await realmSaleQuotaLoserFixture(),get=vi.spyOn(f.rpc,'getTransaction');
  expect(f.quote.quotaRemaining).toBe(1);expect(f.tx.meta!.fee).toBeGreaterThan(Number(f.quote.feeLamports));
  const proof=await createSeekerRealmSaleFailureVerifier(()=>f.rpc,f.trust)(f.request);
  expect(get).toHaveBeenCalledExactlyOnceWith(f.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  expect(proof).toMatchObject({signature:f.signature,slot:f.tx.slot,blockTime:f.tx.blockTime,feeLamports:String(f.tx.meta!.fee),actualRentLamports:'0',buyerNetPaymentLamports:'0',accessChanged:false,quotaConsumed:false,outcome:'failed',transactionFailed:true,finalityVerified:true,paymentAuthorized:false,admissionAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false});
  expect(proof.originalMessageSha256).toBe(f.quote.messageSha256);expect(Object.isFrozen(proof)).toBe(true);expect(Object.isFrozen(proof.source.accounts)).toBe(true);
 });
 it.each(['seller','developer','both','recipients'] as const)('fee-only rollback respects aliased %s roles',async alias=>{const f=await fixture({alias});expect((await read(f)).buyerNetPaymentLamports).toBe('0');});
 it.each([null,undefined,-1,0] as const)('retains nullable or lagging metadata blockTime %s without imposing a quote-time lower bound',async blockTime=>{
  const f=await fixture();Object.assign(f.transaction,{blockTime});expect((await read(f)).blockTime).toBe(blockTime??null);
 });
 it('does not use later mutable access/receipt state or attempted CPI/logs as proof of this failed packet',async()=>{
  const f=await fixture(),accounts=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext');f.bank.rows[2]=null;f.bank.rows[3]=null;f.bank.rows[5]=null;
  const proof=await read(f);expect(proof.accessChanged).toBe(false);expect(accounts.mock.calls[0]![0].map(k=>k.toBase58())).toEqual([f.bank.rows[0]!.address.toBase58(),f.bank.rows[1]!.address.toBase58(),f.bank.rows[4]!.address.toBase58()]);
 });
 it.each([null,{},false,'unknown',{InstructionError:[-1,{Custom:1}]},{InstructionError:[99,{Custom:1}]},{InstructionError:[0,{Custom:4294967296}]},{InstructionError:[0,{Unknown:1}]},{InstructionError:[0,{Custom:1,Other:2}]}])('holds unknown or nonfailed execution metadata %j',async err=>{
  const f=await fixture();f.transaction.meta!.err=err as never;await expect(read(f)).rejects.toMatchObject({code:'TRANSACTION',journalClearingAuthorized:false});
 });
 it.each(['missing','meta','signature','message','wire','v0','payer','other','rent','token','loaded','fee','future-slot','old-slot','future-time'] as const)('rejects %s instead of inventing a failed outcome',async kind=>{
  const f=await fixture(),tx=f.transaction,m=tx.transaction.message as Message;
  if(kind==='missing')f.rpc.getTransaction=async()=>null;
  if(kind==='meta')tx.meta=null;
  if(kind==='signature')tx.transaction.signatures[0]='2'.repeat(88);
  if(kind==='message')m.recentBlockhash=key(27).toBase58();
  if(kind==='wire')f.request.signedTransaction[1]=f.request.signedTransaction[1]!^1;
  if(kind==='v0')Object.assign(tx,{version:0});
  if(kind==='payer')tx.meta!.postBalances[0]!++;
  if(kind==='other')tx.meta!.postBalances[1]!++;
  if(kind==='rent'){const i=m.accountKeys.findIndex(k=>k.toBase58()===f.plan.expectedNewAccounts[0]!.address);tx.meta!.postBalances[i]!++;tx.meta!.postBalances[0]!--;}
  if(kind==='token')tx.meta!.postTokenBalances=[{accountIndex:1,mint:key(9).toBase58(),uiTokenAmount:{amount:'1',decimals:0,uiAmount:1}}];
  if(kind==='loaded')tx.meta!.loadedAddresses={readonly:[key(9)],writable:[]};
  if(kind==='fee')tx.meta!.fee=Number.MAX_SAFE_INTEGER+1;
  if(kind==='future-slot')tx.slot=151;
  if(kind==='old-slot')tx.slot=f.request.minContextSlot-1;
  if(kind==='future-time')tx.blockTime=Number(f.bank.now)+1;
  await expect(read(f)).rejects.toMatchObject({journalClearingAuthorized:false});
 });
 it.each(['genesis','closing-genesis','program-owner','program-bytes','data-owner','data-hash','clock-owner','clock-slot','clock-time','old-bank','closing-slot'] as const)('rejects changed independent %s evidence',async kind=>{
  const f=await fixture();
  if(kind==='genesis')f.rpc.getGenesisHash=async()=>key(9).toBase58();
  if(kind==='closing-genesis'){let calls=0;f.rpc.getGenesisHash=async()=>++calls===1?f.trust.expectedGenesisHash:key(9).toBase58();}
  if(kind==='program-owner')f.bank.rows[0]!.owner=key(9);
  if(kind==='program-bytes')f.bank.rows[0]!.data[4]=0;
  if(kind==='data-owner')f.bank.rows[1]!.owner=key(9);
  if(kind==='data-hash')f.bank.rows[1]!.data[50]=0;
  if(kind==='clock-owner')f.bank.rows[4]!.owner=key(9);
  if(kind==='clock-slot')f.bank.rows[4]!.data.writeBigUInt64LE(149n);
  if(kind==='clock-time')f.bank.rows[4]!.data.writeBigInt64LE(0n,32);
  if(kind==='old-bank'){const read=f.rpc.getMultipleAccountsInfoAndContext;f.rpc.getMultipleAccountsInfoAndContext=async(...a)=>({...await read(...a),context:{slot:149}});}
  if(kind==='closing-slot'){let calls=0;f.rpc.getSlot=async()=>++calls===1?150:149;}
  await expect(read(f)).rejects.toMatchObject({journalClearingAuthorized:false});
 });
 it.each(['keys','instructions','balances','program-data'] as const)('bounds hostile %s before accepting evidence',async kind=>{
  const f=await fixture(),m=f.transaction.transaction.message as Message;
  if(kind==='keys')m.accountKeys.push(...Array(1000).fill(key(9)));
  if(kind==='instructions')delete m.instructions[0];
  if(kind==='balances')delete f.transaction.meta!.preBalances[0];
  if(kind==='program-data')f.bank.rows[1]!.data=Buffer.alloc(8*1024*1024+1);
  await expect(read(f)).rejects.toMatchObject({journalClearingAuthorized:false});
 });
 it('copies original request, trust, raw transaction and account bytes before later awaits',async()=>{
  const f=await fixture(),verify=createSeekerRealmSaleFailureVerifier(()=>f.rpc,f.trust),accounts=f.rpc.getMultipleAccountsInfoAndContext,slot=f.rpc.getSlot;let slots=0;
  f.rpc.getMultipleAccountsInfoAndContext=async(...a)=>{f.transaction.meta!.postBalances.fill(0);return accounts(...a);};
  f.rpc.getSlot=async c=>{if(++slots===2)f.bank.rows[1]!.data.fill(0);return slot(c);};
  const pending=verify(f.request);f.request.signedTransaction.fill(0);f.request.preparedMessageBytes.fill(0);f.request.args.saleId.fill(0);f.trust.reviewedProgramDataSha256='0'.repeat(64);
  expect((await pending).signature).toBe(f.signature);
 });
 it('rejects changed canonical intent or independent pins before connecting',async()=>{
  const f=await fixture(),connect=vi.fn(()=>f.rpc);
  for(const patch of [{stateProvenance:'unknown'},{programId:key(9)},{reviewedProgramDataSha256:'x'}])expect(()=>createSeekerRealmSaleFailureVerifier(connect,{...f.trust,...patch} as never)).toThrow();
  const verify=createSeekerRealmSaleFailureVerifier(connect,f.trust);
  for(const patch of [{minContextSlot:89},{extra:true},{signedTransaction:new Uint8Array(1233)},{args:{...f.request.args,developer:key(9)}}])await expect(verify({...f.request,...patch} as never)).rejects.toMatchObject({code:'INPUT'});
  expect(connect).not.toHaveBeenCalled();
 });
 it('keeps ignored-abort RPC capacity occupied until actual work drains and cannot accept a late proof',async()=>{
  const f=await fixture(),normal=f.rpc.getGenesisHash,resolvers:Array<(value:string)=>void>=[],signals:AbortSignal[]=[];
  f.rpc.getGenesisHash=()=>new Promise(resolve=>resolvers.push(resolve));
  const verify=createSeekerRealmSaleFailureVerifier(signal=>{signals.push(signal);return f.rpc;},f.trust,{deadlineMs:10,maxPending:2});
  const outcomes=await Promise.allSettled([verify(f.request),verify(f.request)]);expect(outcomes.every(r=>r.status==='rejected')).toBe(true);expect(signals.every(s=>s.aborted)).toBe(true);
  await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});f.rpc.getGenesisHash=normal;for(const resolve of resolvers)resolve(f.trust.expectedGenesisHash);
  await vi.waitFor(async()=>expect((await verify(f.request)).transactionFailed).toBe(true));
 });
});
