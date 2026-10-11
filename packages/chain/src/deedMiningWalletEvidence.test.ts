import { describe,it,expect,vi } from 'vitest';
import bs58 from 'bs58';
import { TransactionMessage } from '@solana/web3.js';
import { readDeedMiningWalletEvidence,MINING_WALLET_EVIDENCE_LIMITS,type DeedMiningWalletReader } from './deedMiningWalletEvidence';
import { key,core,creator,wallet,other,asset,tx,fixture,createMiningWalletFixture } from './testFixtures/deedMiningWallet';
describe('complete wallet interval deed source evidence',()=>{
 it.each(['none','out-back','continuous','minted-in-day'] as const)('supports real-calendar serialized fixture %s',async scenario=>{
  const f=createMiningWalletFixture({targetWallet:wallet.toBase58(),startAt:new Date('2020-01-01T00:00:00Z'),endAt:new Date('2020-01-02T00:00:00Z'),scenario});
  const r=await f.read();expect(r.deedlessThroughout).toBe(scenario==='none');expect(r.continuouslyHeldAssetIds).toEqual(scenario==='continuous'?[f.assetId]:[]);
 });
 it('proves no holdings only after checking every original asset, including unregistered deeds',async()=>{
  const f=fixture();expect(await f.read()).toMatchObject({deedlessThroughout:true,heldDuringIntervalAssetIds:[],continuouslyHeldAssetIds:[],eligibilityAuthorized:false,throughSlot:'20',evidence:{trust:'trusted-finalized-rpc'}});
  const hidden=key(20),r=await fixture([tx('collection',1),tx('mint',9,other),tx('mint',10,wallet,hidden)],[{id:asset,owner:other},{id:hidden,owner:wallet}]).read();
  expect(r.deedlessThroughout).toBe(false);expect(r.continuouslyHeldAssetIds).toEqual([hidden.toBase58()]);
 });
 it('retains brief ownership through out-and-back transfers, including same transaction',async()=>{
  const incoming=tx('transfer',12,wallet),out=tx('transfer',12,other,asset,wallet);
  const r=await fixture([tx('collection',1),tx('mint',10),incoming,out]).read();expect(r.heldDuringIntervalAssetIds).toEqual([asset.toBase58()]);expect(r.continuouslyHeldAssetIds).toEqual([]);
  const merged=tx('transfer',12,wallet); // Compile both instructions together to share a correct account table.
  const parts=[incoming,out].map(t=>{const m=t.transaction.message,ix=m.compiledInstructions[0]!;return {programId:core,keys:ix.accountKeyIndexes.map(i=>({pubkey:m.staticAccountKeys[i]!,isSigner:m.isAccountSigner(i),isWritable:m.isAccountWritable(i)})),data:Buffer.from(ix.data)};});
  merged.transaction.message=new TransactionMessage({payerKey:creator,recentBlockhash:key(9).toBase58(),instructions:parts}).compileToV0Message();
  expect((await fixture([tx('collection',1),tx('mint',10),merged]).read()).deedlessThroughout).toBe(false);
 });
 it('counts minting inside the interval even when it leaves before the horizon',async()=>{
  const r=await fixture([tx('collection',1),tx('mint',12,wallet),tx('transfer',13,other,asset,wallet)]).read();expect(r.deedlessThroughout).toBe(false);expect(r.continuouslyHeldAssetIds).toEqual([]);
 });
 it('reports a continuously held original deed separately from mining eligibility',async()=>{
  const r=await fixture([tx('collection',1),tx('mint',10,wallet)],[{id:asset,owner:wallet}]).read();expect(r.continuouslyHeldAssetIds).toEqual([asset.toBase58()]);expect(r.eligibilityAuthorized).toBe(false);
 });
 it('uses half-open boundaries and does not call an exact-start acquisition continuously held',async()=>{
  expect((await fixture([tx('collection',1),tx('mint',10),tx('transfer',19,wallet)],[{id:asset,owner:wallet}]).read()).deedlessThroughout).toBe(true);
  const start=await fixture([tx('collection',1),tx('mint',11,wallet)],[{id:asset,owner:wallet}]).read();expect(start.deedlessThroughout).toBe(false);expect(start.continuouslyHeldAssetIds).toEqual([]);
 });
 it('refuses an imported replacement even when current collection counters balance',async()=>{
  await expect(fixture([tx('collection',1),tx('mint',10,other,asset,other,key(22))]).read()).rejects.toHaveProperty('code');
 });
 it('refuses historical terminal owners that do not match the one GPA bank',async()=>{
  await expect(fixture([tx('collection',1),tx('mint',10),tx('transfer',12,wallet)]).read()).rejects.toMatchObject({code:'EVIDENCE_CONFLICT'});
 });
 it('requires a proven unique collection generation even for zero assets',async()=>{
  expect((await fixture([tx('collection',1)],[]).read()).deedlessThroughout).toBe(true);
  await expect(fixture([],[]).read()).rejects.toMatchObject({code:'HISTORY_INCOMPLETE'});
  await expect(fixture([tx('collection',1),tx('collection',2)],[]).read()).rejects.toMatchObject({code:'UNSUPPORTED_HISTORY'});
  const burn=tx('collection',2);burn.transaction.message.compiledInstructions[0]!.data=Uint8Array.of(13);
  await expect(fixture([tx('collection',1),burn],[]).read()).rejects.toMatchObject({code:'UNSUPPORTED_HISTORY'});
 });
 it('refuses errors, missing historical bodies, and an interval not closed by the inventory bank',async()=>{
  const bad=fixture();bad.reader.getSignaturesForAddress.mockRejectedValue(Error('private endpoint'));await expect(bad.read()).rejects.toMatchObject({code:'READER_UNAVAILABLE'});
  const missing=fixture();missing.reader.getTransaction.mockResolvedValue(null);await expect(missing.read()).rejects.toHaveProperty('code');
  const open=fixture();open.input.endAt=new Date(201_000);await expect(open.read()).rejects.toMatchObject({code:'INTERVAL_NOT_CLOSED'});
 });
 it('bounds the global asset count before decoding or scanning per-asset history',async()=>{
  const f=fixture();f.reader.getProgramAccounts.mockResolvedValue({context:{slot:20},value:Array(MINING_WALLET_EVIDENCE_LIMITS.maxAssets+1).fill(f.entries[0])});await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});expect(f.reader.getSignaturesForAddress).not.toHaveBeenCalled();
 });
 it('bounds complete address pagination globally before any per-asset replay',async()=>{
  const f=fixture();let n=0;f.reader.getSignaturesForAddress.mockImplementation(async()=>Array.from({length:1000},()=>{const bytes=Buffer.alloc(64,8);bytes.writeUInt32LE(++n);return {signature:bs58.encode(bytes),slot:19,blockTime:190,err:null,confirmationStatus:'finalized'};}));
  await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});expect(f.reader.getTransaction).not.toHaveBeenCalled();expect(f.reader.getSignaturesForAddress.mock.calls.length).toBeLessThanOrEqual(9);
 });
 it('shares mint-block transaction reads across assets without omitting either proof',async()=>{
  const second=key(25),f=fixture([tx('collection',1),tx('mint',10),tx('mint',10,wallet,second)],[{id:asset,owner:other},{id:second,owner:wallet}]);
  expect((await f.read()).heldDuringIntervalAssetIds).toEqual([second.toBase58()]);expect(f.reader.getTransaction).toHaveBeenCalledTimes(3);
 });
 it('refuses actual collection CPI and unknown collection-touching Core instructions',async()=>{
  const create=tx('collection',1),ix=create.transaction.message.compiledInstructions[0]!;
  create.meta!.innerInstructions=[{index:0,instructions:[{programIdIndex:ix.programIdIndex,accounts:[...ix.accountKeyIndexes],data:bs58.encode(ix.data)}]}];
  await expect(fixture([create],[]).read()).rejects.toMatchObject({code:'UNSUPPORTED_HISTORY'});
  const unknown=tx('transfer',12);unknown.transaction.message.compiledInstructions[0]!.data=Uint8Array.of(255);
  await expect(fixture([tx('collection',1),tx('mint',10),unknown]).read()).rejects.toMatchObject({code:'UNSUPPORTED_HISTORY'});
 });
 it('rejects caller authority booleans and aborts a hung source using the global deadline',async()=>{
  const f=fixture();await expect(readDeedMiningWalletEvidence(f.reader as unknown as DeedMiningWalletReader,{...f.input,eligible:true} as typeof f.input)).rejects.toMatchObject({code:'INVALID_INPUT'});
  vi.useFakeTimers();let signal:AbortSignal|undefined;try{const p=readDeedMiningWalletEvidence(s=>{signal=s;return {...f.reader,getGenesisHash:()=>new Promise<string>(()=>{})} as unknown as DeedMiningWalletReader;},f.input);const assertion=expect(p).rejects.toMatchObject({code:'TIMEOUT'});await vi.advanceTimersByTimeAsync(MINING_WALLET_EVIDENCE_LIMITS.timeoutMs);await assertion;expect(signal?.aborted).toBe(true);}finally{vi.useRealTimers();}
 });
});
