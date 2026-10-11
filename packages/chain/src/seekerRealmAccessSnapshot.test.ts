import { createHash } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import anchorPkg from '@coral-xyz/anchor';
import { PublicKey,SystemProgram } from '@solana/web3.js';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { createSeekerRealmAccessSnapshotReader,makeSeekerRealmAccessRpc } from './seekerRealmAccessSnapshot';
import { createSeekerRealmAccessFixture as fixture,realmAccessFixtureKey as key } from './testFixtures/seekerRealmAccess';
const {BN}=anchorPkg;
const load=async(f:Awaited<ReturnType<typeof fixture>>)=>createSeekerRealmAccessSnapshotReader(()=>f.rpc,f.trust)(f.request);
describe('finalized same-bank original realm access observation',()=>{
 it('reads config, access, Clock, deployment and optional receipt in exactly one finalized bank without claiming payment authority',async()=>{
  const f=await fixture(),spy=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext'),r=await load(f);
  expect(spy).toHaveBeenCalledOnce();expect(spy.mock.calls[0]![0]).toHaveLength(6);expect(spy.mock.calls[0]![1]).toEqual({commitment:'finalized',minContextSlot:150});
  expect(r).toMatchObject({version:1,wallet:f.wallet.toBase58(),realm:0,slot:150,unixTimestamp:f.now,expiresAt:f.now+BigInt(PHASE_E_POLICY.seekerIsland.permitDurationSec),active:true,paymentAuthorized:false,admissionAuthorized:false,transactionProofVerified:false});
  expect(r.receipt).toMatchObject({buyer:f.wallet.toBase58(),finalityVerified:false,paymentAuthorized:false});expect(r.access?.finalityVerified).toBe(false);
  expect(r.source).toMatchObject({trust:'trusted-finalized-rpc-reviewed-program',stateProvenance:'fresh-reviewed-deployment',genesisHash:f.genesis.toBase58(),upgradeAuthority:f.upgradeAuthority.toBase58()});
  for(const value of [r,r.source,r.source.accounts,r.source.accounts[0],r.config,r.access,r.receipt])expect(Object.isFrozen(value)).toBe(true);
 });
 it('preserves absent access and receipt as absent facts, with no synthetic zero account',async()=>{
  const f=await fixture();f.rows[3]=null;f.rows[5]=null;const r=await load(f);expect(r).toMatchObject({access:null,receipt:null,rawReceipt:null,expiresAt:null,active:false});expect(r.source.accounts[3]).toMatchObject({exists:false});
 });
 it.each([3,5])('recognizes a canonical prefunded PDA at index%s as uninitialized without inventing a receipt',async index=>{
  const f=await fixture();f.rows[5]=index===5?{...f.rows[5]!,owner:SystemProgram.programId,data:Buffer.alloc(0)}:null;
  if(index===3)f.rows[3]={...f.rows[3]!,owner:SystemProgram.programId,data:Buffer.alloc(0)};
  const r=await load(f);expect(r.receipt).toBe(null);expect(r.rawReceipt).toBe(null);
  expect(r.source.accounts[index]).toMatchObject({exists:true,owner:SystemProgram.programId.toBase58()});
  expect(index===3?r.accessState:r.receiptState).toBe('uninitialized');
  if(index===3)expect(r).toMatchObject({access:null,expiresAt:null,active:false});
 });
 it.each(['data','executable','program-empty','wrong-owner'])('rejects malformed prefunded accounts: %s',async fault=>{
  const f=await fixture();f.rows[5]=null;f.rows[3]={...f.rows[3]!,owner:SystemProgram.programId,data:Buffer.alloc(0)};
  if(fault==='data')f.rows[3]!.data=Buffer.of(1);
  if(fault==='executable')f.rows[3]!.executable=true;
  if(fault==='program-empty')f.rows[3]!.owner=f.programId;
  if(fault==='wrong-owner')f.rows[3]!.owner=key(9);
  await expect(load(f)).rejects.toMatchObject({name:'SeekerRealmAccessSnapshotError'});
 });
 it('omits receipt lookup entirely unless the caller supplies its original sale ID',async()=>{
  const f=await fixture(),spy=vi.spyOn(f.rpc,'getMultipleAccountsInfoAndContext');const r=await createSeekerRealmAccessSnapshotReader(()=>f.rpc,f.trust)({wallet:f.wallet,realm:0});expect(spy.mock.calls[0]![0]).toHaveLength(5);expect(r.receipt).toBe(null);expect(r.receiptRequested).toBe(false);expect(r.rawReceipt).toBe(null);
 });
 it.each([-1n,0n,1n])('measures exclusive expiry boundary at Clock %+s',async delta=>{
  const f=await fixture();f.rows[5]=null;f.accessModel.expires_at=new BN((f.now+delta).toString());await f.encode('access');expect((await load(f)).active).toBe(delta>0n);
 });
 it('keeps original historical receipts through later renewals and does not query current term, lease or pause',async()=>{
  const f=await fixture();f.accessModel.expires_at=new BN((f.now+2n*BigInt(PHASE_E_POLICY.seekerIsland.permitDurationSec)).toString());await f.encode('access');const r=await load(f);expect(r.receipt!.expiresAt).toBeLessThan(r.expiresAt!);expect(r.active).toBe(true);expect(r.source.accounts).toHaveLength(6);
 });
 it('accepts an explicitly reviewed immutable deployment',async()=>{
  const f=await fixture();f.rows[1]!.data[12]=0;f.trust.upgradeAuthority=null;f.trust.reviewedProgramDataSha256=createHash('sha256').update(f.rows[1]!.data).digest('hex');expect((await load(f)).source.upgradeAuthority).toBe(null);
 });
 it.each(['genesis','after-genesis','before-slot','after-slot','context','unsafe-slot','row-count','missing-config','program-owner','program-executable','program-pointer','program-tag','data-owner','data-executable','data-tag','deployment-slot','binary','upgrader','upgrader-option','clock-slot','clock-owner','clock-size','clock-zero','clock-negative','config-owner','config-pda','config-developer','access-owner','access-pda','access-wallet','access-realm','access-negative','access-overflow','receipt-buyer','receipt-realm','receipt-developer','receipt-config','receipt-future','receipt-above-access','receipt-without-access','truncated','oversize'] as const)('fails closed on %s rather than inventing expiry',async fault=>{
  const f=await fixture();
  if(fault==='genesis')f.rpc.getGenesisHash=async()=>key(9).toBase58();
  if(fault==='after-genesis'){let n=0;f.rpc.getGenesisHash=async()=>n++?key(9).toBase58():f.genesis.toBase58();}
  if(fault==='before-slot')f.rpc.getSlot=async()=>89;
  if(fault==='after-slot'){let n=0;f.rpc.getSlot=async()=>n++?149:150;}
  if(fault==='context')f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:149},value:f.rows});
  if(fault==='unsafe-slot')f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:Number.MAX_SAFE_INTEGER+1},value:f.rows});
  if(fault==='row-count')f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:150},value:f.rows.slice(1)});
  if(fault==='missing-config')f.rows[2]=null;
  if(fault==='program-owner')f.rows[0]!.owner=key(9);
  if(fault==='program-executable')f.rows[0]!.executable=false;
  if(fault==='program-pointer')key(9).toBuffer().copy(f.rows[0]!.data,4);
  if(fault==='program-tag')f.rows[0]!.data.writeUInt32LE(3);
  if(fault==='data-owner')f.rows[1]!.owner=key(9);
  if(fault==='data-executable')f.rows[1]!.executable=true;
  if(fault==='data-tag')f.rows[1]!.data.writeUInt32LE(2);
  if(fault==='deployment-slot'){f.rows[1]!.data.writeBigUInt64LE(91n,4);f.trust.reviewedProgramDataSha256=createHash('sha256').update(f.rows[1]!.data).digest('hex');}
  if(fault==='binary')f.rows[1]!.data[50]=99;
  if(fault==='upgrader'){key(9).toBuffer().copy(f.rows[1]!.data,13);f.trust.reviewedProgramDataSha256=createHash('sha256').update(f.rows[1]!.data).digest('hex');}
  if(fault==='upgrader-option')f.rows[1]!.data[12]=2;
  if(fault==='clock-slot')f.rows[4]!.data.writeBigUInt64LE(149n);
  if(fault==='clock-owner')f.rows[4]!.owner=key(9);
  if(fault==='clock-size')f.rows[4]!.data=Buffer.alloc(39);
  if(fault==='clock-zero')f.rows[4]!.data.writeBigInt64LE(0n,32);
  if(fault==='clock-negative')f.rows[4]!.data.writeBigInt64LE(-1n,32);
  if(fault==='config-owner')f.rows[2]!.owner=key(9);
  if(fault==='config-pda'){const r={...f.rows[2]!,address:key(9)};f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:150},value:f.rows.map((v,i)=>i===2?r:v)});}
  if(fault==='config-developer'){f.configModel.developer=key(9);await f.encode('config');}
  if(fault==='access-owner')f.rows[3]!.owner=key(9);
  if(fault==='access-pda'){const r={...f.rows[3]!,address:key(9)};f.rpc.getMultipleAccountsInfoAndContext=async()=>({context:{slot:150},value:f.rows.map((v,i)=>i===3?r:v)});}
  if(fault==='access-wallet'){f.accessModel.wallet=key(9);await f.encode('access');}
  if(fault==='access-realm'){f.accessModel.realm=1;await f.encode('access');}
  if(fault==='access-negative'){f.accessModel.expires_at=new BN(-1);await f.encode('access');}
  if(fault==='access-overflow')f.rows[3]!.data.fill(255,74,82);
  if(fault==='receipt-buyer'){f.receiptModel.buyer=key(9);await f.encode('receipt');}
  if(fault==='receipt-realm'){f.receiptModel.realm=1;await f.encode('receipt');}
  if(fault==='receipt-developer'){f.receiptModel.developer=key(9);await f.encode('receipt');}
  if(fault==='receipt-config'){f.receiptModel.config=key(9);await f.encode('receipt');}
  if(fault==='receipt-future'){for(const field of ['accepted_at','coverage_start','expires_at'] as const)f.receiptModel[field]=f.receiptModel[field].addn(1);f.accessModel.expires_at=f.accessModel.expires_at.addn(1);await f.encode('access');await f.encode('receipt');}
  if(fault==='receipt-above-access'){f.accessModel.expires_at=f.accessModel.expires_at.subn(1);await f.encode('access');}
  if(fault==='receipt-without-access')f.rows[3]=null;
  if(fault==='truncated')f.rows[5]!.data=f.rows[5]!.data.subarray(0,-1);
  if(fault==='oversize')f.rows[1]!.data=Buffer.alloc(8*1024*1024+1);
  await expect(load(f)).rejects.toMatchObject({name:'SeekerRealmAccessSnapshotError'});
 });
 it('returns fresh owned receipt bytes and keys for same-bank transaction evidence without promoting proof flags',async()=>{
  const f=await fixture(),r=await load(f),first=r.rawReceipt!,second=r.rawReceipt!;
  expect(first).not.toBe(second);expect(first.address).not.toBe(second.address);expect(first.owner).not.toBe(second.owner);expect(first.data).not.toBe(second.data);expect(Object.isFrozen(first)).toBe(true);
  const expected=Buffer.from(second.data);first.data.fill(0);(first.address as unknown as {_bn:unknown})._bn=(key(9) as unknown as {_bn:unknown})._bn;
  expect(r.rawReceipt!.address.toBase58()).toBe(r.receipt!.address);expect(Buffer.from(r.rawReceipt!.data)).toEqual(expected);
  expect(createHash('sha256').update(r.rawReceipt!.data).digest('hex')).toBe(r.source.accounts[5]!.dataSha256);expect(r.transactionProofVerified).toBe(false);
 });
 it('retains an expired original receipt without requiring a new term or payment',async()=>{
  const f=await fixture();f.rows[4]!.data.writeBigInt64LE(f.now+BigInt(PHASE_E_POLICY.seekerIsland.permitDurationSec)+1n,32);
  const r=await load(f);expect(r.active).toBe(false);expect(r.receipt).not.toBe(null);expect(r.rawReceipt).not.toBe(null);expect(r.expiresAt).toBe(r.receipt!.expiresAt);
 });
 it('copies provider buffers, trust and request before asynchronous continuation',async()=>{
  const f=await fixture(),read=createSeekerRealmAccessSnapshotReader(()=>f.rpc,f.trust),expected=(await load(f)).source.accounts;
  let n=0;f.rpc.getSlot=async()=>{if(n++){for(const row of f.rows)row?.data.fill(0);}return 150;};
  const promise=read(f.request);f.request.saleId.fill(9);f.trust.expectedGenesisHash=key(9).toBase58();f.trust.reviewedProgramDataSha256='0'.repeat(64);const r=await promise;expect(r.source.accounts).toEqual(expected);expect(r.active).toBe(true);
 });
 it('rejects missing explicit deployment provenance, malformed identities, extras and invalid deadlines before RPC',async()=>{
  const f=await fixture(),connect=vi.fn(()=>f.rpc);
  for(const patch of [{stateProvenance:'upgraded'},{programId:key(9)},{developer:PublicKey.default},{expectedGenesisHash:'bad'},{reviewedDeploymentSlot:-1},{reviewedProgramDataSha256:'a'},{upgradeAuthority:undefined},{extra:true}])expect(()=>createSeekerRealmAccessSnapshotReader(connect,{...f.trust,...patch} as never)).toThrow();
  for(const deadlineMs of [0,60_001,NaN])expect(()=>createSeekerRealmAccessSnapshotReader(connect,f.trust,{deadlineMs})).toThrow();expect(connect).not.toHaveBeenCalled();
  const read=createSeekerRealmAccessSnapshotReader(connect,f.trust);for(const request of [{...f.request,realm:8},{...f.request,saleId:Buffer.alloc(16)},{...f.request,wallet:PublicKey.default},{...f.request,extra:true}])await expect(read(request)).rejects.toMatchObject({code:'INPUT'});expect(connect).not.toHaveBeenCalled();
 });
 it('times out the whole operation and cancels the factory signal, without continuing to another RPC',async()=>{
  const f=await fixture();let signal:AbortSignal|undefined,resolve:((s:string)=>void)|undefined;f.rpc.getGenesisHash=()=>new Promise(r=>{resolve=r;});const spy=vi.spyOn(f.rpc,'getSlot');
  const read=createSeekerRealmAccessSnapshotReader(s=>{signal=s;return f.rpc;},f.trust,{deadlineMs:10});await expect(read(f.request)).rejects.toMatchObject({code:'DEADLINE'});expect(signal!.aborted).toBe(true);resolve!(f.genesis.toBase58());await Promise.resolve();await Promise.resolve();expect(spy).not.toHaveBeenCalled();
 });
 it('maps unavailable transport to a typed refusal and always releases the factory signal',async()=>{
  const f=await fixture();let signal:AbortSignal|undefined;f.rpc.getSlot=async()=>{throw new Error('provider failure');};await expect(createSeekerRealmAccessSnapshotReader(s=>{signal=s;return f.rpc;},f.trust)(f.request)).rejects.toMatchObject({code:'UNAVAILABLE'});expect(signal!.aborted).toBe(true);
 });
 it('production transport has explicit URL, cancels redirects and refuses oversized response bodies',async()=>{
  const controller=new AbortController(),fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new Uint8Array(16*1024*1024+1),{status:200}));
  try{const rpc=makeSeekerRealmAccessRpc('http://127.0.0.1:8899',controller.signal);await expect(rpc.getGenesisHash()).rejects.toThrow();expect(fetchSpy.mock.calls[0]![1]).toMatchObject({signal:controller.signal,redirect:'error'});}finally{fetchSpy.mockRestore();}
 });
});
