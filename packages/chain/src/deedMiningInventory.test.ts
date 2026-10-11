import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type Connection } from '@solana/web3.js';
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { publicKey } from '@metaplex-foundation/umi';
import { getAssetV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';
import { SOLANA_GENESIS_HASH } from './cluster';
import { MINING_INVENTORY_LIMITS, readDeedMiningInventory, type DeedMiningInventoryReader } from './deedMiningInventory';
const key=(n:number)=>{const b=Buffer.alloc(32);b.writeUInt32LE(n);return new PublicKey(b);};
const core=new PublicKey(MPL_CORE_PROGRAM_ID),collection=key(1),owner=key(2),buyer=key(3),asset=key(4);
const identity={collection:collection.toBase58(),expectedGenesisHash:SOLANA_GENESIS_HASH.devnet};
function account(data:Uint8Array){return {owner:core,executable:false,lamports:1,rentEpoch:0,data:Buffer.from(data)};}
function collectionAccount(minted=1,size=minted){return account(getCollectionV1AccountDataSerializer().serialize({key:Key.CollectionV1,
 updateAuthority:publicKey(owner.toBase58()),name:'Deeds',uri:'',numMinted:minted,currentSize:size}));}
function assetAccount(heldBy=owner,belongsTo=collection){return account(getAssetV1AccountDataSerializer().serialize({key:Key.AssetV1,
 owner:publicKey(heldBy.toBase58()),updateAuthority:{__kind:'Collection',fields:[publicKey(belongsTo.toBase58())]},name:'Deed',uri:'',seq:null}));}
function fixture(){
 const entries=[{pubkey:asset,account:assetAccount()}];
 const rpc={getGenesisHash:vi.fn().mockResolvedValue(identity.expectedGenesisHash),
  getAccountInfoAndContext:vi.fn().mockResolvedValueOnce({context:{slot:100},value:collectionAccount()}).mockResolvedValueOnce({context:{slot:150},value:collectionAccount()}),
  getProgramAccounts:vi.fn().mockResolvedValue({context:{slot:120},value:entries})};
 const read=()=>readDeedMiningInventory(rpc as unknown as DeedMiningInventoryReader,identity);
 return {rpc,entries,read};
}
describe('same-bank current mining deed inventory',()=>{
 it('pins every owner to the inventory bank even when ownership changes before the closing collection read',async()=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValueOnce({context:{slot:100},value:collectionAccount()})
   .mockImplementationOnce(async()=>{f.entries[0]!.account=assetAccount(buyer);return {context:{slot:150},value:collectionAccount()};});
  const result=await f.read();expect(result).toMatchObject({throughSlot:'120',currentHorizonOnly:true,intervalDeedlessnessAuthorized:false,
   originalIssuanceVerified:false,assets:[{assetId:asset.toBase58(),owner:owner.toBase58()}]});
  expect(f.rpc.getAccountInfoAndContext).toHaveBeenCalledTimes(2);
  for(const [address] of f.rpc.getAccountInfoAndContext.mock.calls)expect(address.toBase58()).toBe(collection.toBase58());
  expect(f.rpc.getProgramAccounts).toHaveBeenCalledExactlyOnceWith(core,expect.objectContaining({commitment:'finalized',withContext:true,minContextSlot:100}));
  expect(f.rpc.getProgramAccounts.mock.calls[0]![1]).not.toHaveProperty('dataSlice');
  expect(Object.isFrozen(result.assets)).toBe(true);expect(Object.isFrozen(result.assets[0])).toBe(true);
 });
 it('accepts a genuinely empty current collection but never certifies interval deedlessness',async()=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValueOnce({context:{slot:100},value:collectionAccount(0)}).mockResolvedValueOnce({context:{slot:120},value:collectionAccount(0)});
  f.rpc.getProgramAccounts.mockResolvedValue({context:{slot:110},value:[]});
  expect(await f.read()).toMatchObject({assets:[],numMinted:0,currentSize:0,intervalDeedlessnessAuthorized:false});
 });
 it.each(['getGenesisHash','getAccountInfoAndContext','getProgramAccounts'] as const)('refuses %s failure instead of returning an empty inventory',async method=>{
  const f=fixture();f.rpc[method].mockReset().mockRejectedValueOnce(new Error('private provider URL must not leak'));
  await expect(f.read()).rejects.toMatchObject({code:'READER_UNAVAILABLE',message:'Mining deed inventory refused: READER_UNAVAILABLE'});
 });
 it('refuses a wrong cluster before any inventory request and validates copied identity inputs',async()=>{
  const f=fixture();f.rpc.getGenesisHash.mockResolvedValue(SOLANA_GENESIS_HASH['mainnet-beta']);await expect(f.read()).rejects.toMatchObject({code:'CLUSTER_MISMATCH'});
  expect(f.rpc.getProgramAccounts).not.toHaveBeenCalled();
  await expect(readDeedMiningInventory(f.rpc as unknown as Connection,{...identity,collection:'bad'})).rejects.toMatchObject({code:'INVALID_INPUT'});
 });
 it.each([[2,1],[1,2],[2,2]])('refuses burned, moved, imported or incomplete counters %s/%s',async(minted,size)=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValue({context:{slot:100},value:collectionAccount(minted,size)});
  await expect(f.read()).rejects.toMatchObject({code:'INVENTORY_INCOMPLETE'});
 });
 it('refuses changed collection counters or authority across the scan',async()=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValueOnce({context:{slot:100},value:collectionAccount()}).mockResolvedValueOnce({context:{slot:150},value:collectionAccount(2)});
  await expect(f.read()).rejects.toMatchObject({code:'COLLECTION_CHANGED'});
  const changed=fixture(),closing=collectionAccount();key(8).toBuffer().copy(closing.data,1);
  changed.rpc.getAccountInfoAndContext.mockReset().mockResolvedValueOnce({context:{slot:100},value:collectionAccount()}).mockResolvedValueOnce({context:{slot:150},value:closing});
  await expect(changed.read()).rejects.toMatchObject({code:'COLLECTION_CHANGED'});
 });
 it.each(['program','collection','compressed','truncated','trailing','executable'] as const)('refuses invalid asset %s evidence',async kind=>{
  const f=fixture(),info=f.entries[0]!.account;
  if(kind==='program')info.owner=key(9);
  if(kind==='collection')f.entries[0]!.account=assetAccount(owner,key(9));
  if(kind==='compressed')info.data[0]=Key.HashedAssetV1;
  if(kind==='truncated')info.data=info.data.subarray(0,65);
  if(kind==='trailing')info.data=Buffer.concat([info.data,Buffer.of(255)]);
  if(kind==='executable')info.executable=true;
  await expect(f.read()).rejects.toMatchObject({code:'ASSET_INVALID'});
 });
 it('refuses duplicate asset keys and malformed collections',async()=>{
  const f=fixture();f.entries.push(f.entries[0]!);f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValue({context:{slot:100},value:collectionAccount(2)});
  await expect(f.read()).rejects.toMatchObject({code:'ASSET_INVALID'});
  const bad=fixture();bad.rpc.getAccountInfoAndContext.mockReset().mockResolvedValue({context:{slot:100},value:assetAccount()});
  await expect(bad.read()).rejects.toMatchObject({code:'COLLECTION_INVALID'});
 });
 it.each([NaN,-1,1.5,Number.MAX_SAFE_INTEGER+1,99])('refuses malformed or regressing inventory context %s',async slot=>{
  const f=fixture();f.rpc.getProgramAccounts.mockResolvedValue({context:{slot},value:f.entries});await expect(f.read()).rejects.toMatchObject({code:'CONTEXT_INVALID'});
 });
 it('refuses a closing context below the inventory bank',async()=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValueOnce({context:{slot:100},value:collectionAccount()}).mockResolvedValueOnce({context:{slot:119},value:collectionAccount()});
  await expect(f.read()).rejects.toMatchObject({code:'CONTEXT_INVALID'});
 });
 it('bounds counts before scanning and account bytes before decoding',async()=>{
  const f=fixture();f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValue({context:{slot:100},value:collectionAccount(MINING_INVENTORY_LIMITS.maxAssets+1)});
  await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});expect(f.rpc.getProgramAccounts).not.toHaveBeenCalled();
  const big=fixture();big.entries[0]!.account.data=Buffer.alloc(MINING_INVENTORY_LIMITS.maxAccountBytes+1);
  await expect(big.read()).rejects.toMatchObject({code:'TOO_LARGE'});
  const many=fixture();many.rpc.getProgramAccounts.mockResolvedValue({context:{slot:120},value:Array(MINING_INVENTORY_LIMITS.maxAssets+1).fill(many.entries[0])});
  await expect(many.read()).rejects.toMatchObject({code:'TOO_LARGE'});
 });
 it('bounds total account bytes before attempting any asset decoding',async()=>{
  const f=fixture(),n=Math.floor(MINING_INVENTORY_LIMITS.maxTotalBytes/MINING_INVENTORY_LIMITS.maxAccountBytes)+1;
  f.rpc.getAccountInfoAndContext.mockReset().mockResolvedValue({context:{slot:100},value:collectionAccount(n)});
  const data=Buffer.alloc(MINING_INVENTORY_LIMITS.maxAccountBytes);
  f.rpc.getProgramAccounts.mockResolvedValue({context:{slot:120},value:Array.from({length:n},(_,i)=>({pubkey:key(i+100),account:{...assetAccount(),data}}))});
  await expect(f.read()).rejects.toMatchObject({code:'TOO_LARGE'});
 });
 it('aborts a bounded source factory on timeout instead of leaving an accepted empty result',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;
  try{const p=readDeedMiningInventory(s=>{signal=s;return {...fixture().rpc,getGenesisHash:()=>new Promise<string>(()=>{})} as unknown as DeedMiningInventoryReader;},identity);
   const refusal=expect(p).rejects.toMatchObject({code:'TIMEOUT'});await vi.advanceTimersByTimeAsync(MINING_INVENTORY_LIMITS.timeoutMs);await refusal;expect(signal?.aborted).toBe(true);
  }finally{vi.useRealTimers();}
 });
});
