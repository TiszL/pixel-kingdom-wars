import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import anchorPkg from '@coral-xyz/anchor';
import {Message,PublicKey} from '@solana/web3.js';
import {realmSaleFinalityFixture as fixture} from './testFixtures/seekerRealmSaleFinality';
import {createSeekerRealmSaleFinalityVerifier,makeSeekerRealmSaleFinalityRpc} from './seekerRealmSaleFinality';
const {BN}=anchorPkg,key=(n:number)=>new PublicKey(Buffer.alloc(32,n));
describe('trusted finalized exact realm sale receipt composition',()=>{
 it('joins exact finalized transaction to same-bank original receipt and pinned deployment without admission authority',async()=>{
  const f=await fixture(),tx=vi.spyOn(f.rpc,'getTransaction'),accounts=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext');
  const r=await createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request);
  expect(tx).toHaveBeenCalledExactlyOnceWith(f.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
  expect(accounts).toHaveBeenCalledOnce();expect(accounts.mock.calls[0]![1]).toEqual({commitment:'finalized',minContextSlot:150});
  expect(r).toMatchObject({version:1,finalityVerified:true,transactionEvidenceVerified:true,paymentAuthorized:false,admissionAuthorized:false,signingAuthorized:false,observedAccountSlot:150});
  expect(r.evidence).toMatchObject({signature:f.signature,finalityVerified:false,transactionEvidenceVerified:true});expect(r.evidence.receipt.finalityVerified).toBe(false);
  expect(r.source.reviewedDeploymentSlot).toBe(90);expect(Object.isFrozen(r)).toBe(true);
 });
 it('retains the exact canonical receipt bytes for later offline SDK recovery',async()=>{
  const f=await fixture(),r=await createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request);
  const hex=Buffer.from(f.bank.rows[5]!.data).toString('hex');expect(r.receiptAccountHex).toBe(hex);
  expect(createHash('sha256').update(Buffer.from(r.receiptAccountHex,'hex')).digest('hex')).toBe(r.source.accounts[5]!.dataSha256);
  f.bank.rows[5]!.data.fill(0);expect(r.receiptAccountHex).toBe(hex);expect(r.evidence.receipt.finalityVerified).toBe(false);
 });
 it('raises the account bank floor to the exact transaction even when the opening horizon is behind it',async()=>{
  const f=await fixture();f.transaction.slot=151;let call=0;f.rpc.getSlot=async()=>++call<3?150:152;
  f.bank.rows[4]!.data.writeBigUInt64LE(152n);const accounts=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext').mockImplementation(async()=>({context:{slot:152},value:f.bank.rows}));
  const r=await createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request);expect(accounts.mock.calls[0]![1].minContextSlot).toBe(151);expect(r.observedAccountSlot).toBe(152);
 });
 it('keeps expired original success after later renewal, with no current-term or pause prerequisite',async()=>{
  const f=await fixture(),later=f.expected.args.validAfter+1000000n;f.bank.rows[4]!.data.writeBigInt64LE(later,32);
  f.bank.accessModel.expires_at=new BN((later+1000000n).toString());await f.bank.encode('access');
  const r=await createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request);expect(r.evidence.receipt.expiresAt).toBeLessThan(r.proofClockUnixTimestamp);
 });
 it.each(['genesis','closing-genesis','deployment','receipt','missing-receipt','missing-transaction','failed','future-transaction','old-bank'] as const)('refuses %s without granting journal release',async fault=>{
  const f=await fixture();
  if(fault==='genesis')f.rpc.getGenesisHash=async()=>key(9).toBase58();
  if(fault==='closing-genesis'){let count=0;f.rpc.getGenesisHash=async()=>++count>2?key(9).toBase58():f.trust.expectedGenesisHash;}
  if(fault==='deployment')f.bank.rows[1]!.data[50]=99;
  if(fault==='receipt')f.bank.rows[5]={...await f.reencode({seller:key(9)}),data:Buffer.from((await f.reencode({seller:key(9)})).data)};
  if(fault==='missing-receipt')f.bank.rows[5]=null;
  if(fault==='missing-transaction')f.rpc.getTransaction=async()=>null;
  if(fault==='failed')f.transaction.meta!.err={InstructionError:[0,'AccountAlreadyInitialized']};
  if(fault==='future-transaction')f.transaction.slot=151;
  if(fault==='old-bank')f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:100},value:f.bank.rows});
  await expect(createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request)).rejects.toMatchObject({name:'SeekerRealmSaleFinalityError',journalReleaseAuthorized:false});
 });
 it('copies request and trust before RPC and transaction body before asynchronous account verification',async()=>{
  const f=await fixture(),verify=createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust),read=f.rpc.getMultipleAccountsInfoAndContext;
  f.rpc.getMultipleAccountsInfoAndContext=async(...args)=>{f.transaction.meta!.postBalances.fill(0);(f.transaction.transaction.message as Message).instructions[0]!.data='0';return read(...args);};
  const pending=verify(f.request);f.request.signedTransaction.fill(0);f.request.preparedMessageBytes.fill(0);f.request.newAccountRentCaps[0]!.maxIncreaseLamports=0n;
  f.trust.expectedGenesisHash=key(9).toBase58();f.trust.reviewedProgramDataSha256='0'.repeat(64);
  expect((await pending).evidence.signature).toBe(f.signature);
 });
 it.each(['instruction','inner','keys','signature','balance','header'] as const)('bounds malformed %s before any account read',async fault=>{
  const f=await fixture(),m=f.transaction.transaction.message as Message,read=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext');
  if(fault==='instruction')m.instructions[0]!.data='2'.repeat(1000000);
  if(fault==='inner')f.transaction.meta!.innerInstructions![0]!.instructions[0]!.data='2'.repeat(1000000);
  if(fault==='keys')m.accountKeys.push(...Array(1000).fill(key(9)));
  if(fault==='signature')f.transaction.transaction.signatures[0]='2'.repeat(1000000);
  if(fault==='balance')f.transaction.meta!.preBalances[0]=Number.MAX_SAFE_INTEGER+1;
  if(fault==='header')(m as unknown as {header:unknown}).header=undefined;
  await expect(createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust)(f.request)).rejects.toMatchObject({journalReleaseAuthorized:false});expect(read).not.toHaveBeenCalled();
 });
 it('validates explicit trust and retained request scope before opening a transport',async()=>{
  const f=await fixture(),connect=vi.fn(()=>f.rpc);
  expect(()=>createSeekerRealmSaleFinalityVerifier(connect,{...f.trust,stateProvenance:'unknown'} as never)).toThrow();
  const verify=createSeekerRealmSaleFinalityVerifier(connect,f.trust);for(const patch of [{minContextSlot:89},{signedTransaction:new Uint8Array(1233)},{newAccountRentCaps:[]},{unexpected:true}])await expect(verify({...f.request,...patch} as never)).rejects.toMatchObject({code:'INPUT'});
  expect(connect).not.toHaveBeenCalled();
 });
 it('aborts the whole deadline and does not continue RPC after a late transport resolves',async()=>{
  const f=await fixture();let signal:AbortSignal|undefined,resolve:((value:string)=>void)|undefined;
  f.rpc.getGenesisHash=()=>new Promise(r=>{resolve=r;});const next=vi.spyOn(f.rpc,'getSlot');
  const verify=createSeekerRealmSaleFinalityVerifier(s=>{signal=s;return f.rpc;},f.trust,{deadlineMs:10});
  await expect(verify(f.request)).rejects.toMatchObject({code:'DEADLINE',journalReleaseAuthorized:false});expect(signal!.aborted).toBe(true);
  resolve!(f.trust.expectedGenesisHash);await Promise.resolve();await Promise.resolve();expect(next).not.toHaveBeenCalled();
 });
 it('caps explicit production transport bodies and blocks redirects without a fallback endpoint',async()=>{
  const controller=new AbortController(),fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new Uint8Array(16*1024*1024+1)));
  try{await expect(makeSeekerRealmSaleFinalityRpc('http://127.0.0.1:8899',controller.signal).getGenesisHash()).rejects.toThrow();expect(fetch.mock.calls[0]![1]).toMatchObject({signal:controller.signal,redirect:'error'});}finally{fetch.mockRestore();}
 });
 it('keeps bounded capacity occupied until ignored-abort account calls settle after both deadlines',async()=>{
  const f=await fixture(),normal=f.rpc.getMultipleAccountsInfoAndContext,resolvers:Array<(v:Awaited<ReturnType<typeof normal>>)=>void>=[];
  f.rpc.getMultipleAccountsInfoAndContext=()=>new Promise(resolve=>resolvers.push(resolve));
  const verify=createSeekerRealmSaleFinalityVerifier(()=>f.rpc,f.trust,{deadlineMs:20});
  const results=await Promise.allSettled(Array.from({length:8},()=>verify(f.request)));expect(results.every(r=>r.status==='rejected')).toBe(true);expect(resolvers).toHaveLength(8);
  // The snapshot's own race also settles; the abandoned transport must still
  // occupy capacity. This finite wait only exercises nested timeout ordering.
  await new Promise(resolve=>setTimeout(resolve,30));
  await expect(verify(f.request)).rejects.toMatchObject({code:'BUSY'});
  f.rpc.getMultipleAccountsInfoAndContext=normal;for(const resolve of resolvers)resolve({context:{slot:150},value:f.bank.rows});
  await vi.waitFor(async()=>expect((await verify(f.request)).finalityVerified).toBe(true));
 });
});
