/** Current finalized ownership facts from ONE GPA bank, never interval eligibility.
 * The caller authenticates the provider and selects the cluster/collection. A
 * matching genesis hash does not authenticate an arbitrary untrusted endpoint.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { Key, MPL_CORE_PROGRAM_ID } from '@metaplex-foundation/mpl-core';
import { getAssetV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/hooked/assetAccountData';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/hooked/collectionAccountData';
import bs58 from 'bs58';

/** Operational refusal bounds, not economy policy or collection capacity. */
export const MINING_INVENTORY_LIMITS=Object.freeze({maxAssets:10_000,maxAccountBytes:65_536,maxTotalBytes:16*1024*1024,timeoutMs:10_000});
export type DeedMiningInventoryReader=Pick<Connection,'getGenesisHash'|'getAccountInfoAndContext'|'getProgramAccounts'>;
/** Production supplies the abort-aware factory (the accepted mint-inventory
 * connection factory is compatible). Direct injected readers own their transport. */
export type DeedMiningInventorySource=DeedMiningInventoryReader|((signal:AbortSignal)=>DeedMiningInventoryReader);
type Code='INVALID_INPUT'|'CLUSTER_MISMATCH'|'READER_UNAVAILABLE'|'TIMEOUT'|'CONTEXT_INVALID'|'COLLECTION_INVALID'|'COLLECTION_CHANGED'|'INVENTORY_INCOMPLETE'|'ASSET_INVALID'|'TOO_LARGE';
export class DeedMiningInventoryError extends Error {
 constructor(readonly code:Code){super(`Mining deed inventory refused: ${code}`);this.name='DeedMiningInventoryError';}
}
function fail(code:Code):never{throw new DeedMiningInventoryError(code);}
const CORE=new PublicKey(MPL_CORE_PROGRAM_ID);
function key(value:unknown,code:Code):PublicKey{
 if(typeof value!=='string'||value.length>44)fail(code);
 try{const parsed=new PublicKey(value);if(parsed.toBase58()!==value)fail(code);return parsed;}catch{return fail(code);}
}
function slot(value:unknown,floor=0):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<floor)fail('CONTEXT_INVALID');return value;
}
function data(info:unknown,code:Code):Buffer{
 if(!info||typeof info!=='object')fail(code);
 const a=info as {owner?:unknown;executable?:unknown;data?:unknown;lamports?:unknown};
 if(!(a.owner instanceof PublicKey)||!a.owner.equals(CORE)||a.executable!==false||!Buffer.isBuffer(a.data)
  ||typeof a.lamports!=='number'||!Number.isSafeInteger(a.lamports)||a.lamports<0)fail(code);
 if(a.data.length>MINING_INVENTORY_LIMITS.maxAccountBytes)fail('TOO_LARGE');return a.data;
}
function collectionFacts(info:unknown){
 const bytes=data(info,'COLLECTION_INVALID');
 try{
  const [c]=getCollectionV1AccountDataSerializer().deserialize(bytes);
  if(c.key!==Key.CollectionV1)fail('COLLECTION_INVALID');
  const authority=key(String(c.updateAuthority),'COLLECTION_INVALID').toBase58();
  if(!Number.isSafeInteger(c.numMinted)||c.numMinted<0||!Number.isSafeInteger(c.currentSize)||c.currentSize<0)fail('COLLECTION_INVALID');
  if(c.numMinted>MINING_INVENTORY_LIMITS.maxAssets||c.currentSize>MINING_INVENTORY_LIMITS.maxAssets)fail('TOO_LARGE');
  return {updateAuthority:authority,numMinted:c.numMinted,currentSize:c.currentSize};
 }catch(error){if(error instanceof DeedMiningInventoryError)throw error;return fail('COLLECTION_INVALID');}
}
export interface DeedMiningInventory {
 readonly collection:string;readonly genesisHash:string;readonly throughSlot:string;
 readonly collectionBeforeSlot:string;readonly collectionAfterSlot:string;
 readonly numMinted:number;readonly currentSize:number;readonly collectionUpdateAuthority:string;
 readonly assets:readonly Readonly<{assetId:string;owner:string}>[];
 readonly currentHorizonOnly:true;readonly originalIssuanceVerified:false;readonly intervalDeedlessnessAuthorized:false;
}

export async function readDeedMiningInventory(source:DeedMiningInventorySource,input:{collection:string;expectedGenesisHash:string}):Promise<DeedMiningInventory>{
 if(!input||typeof input!=='object')fail('INVALID_INPUT');
 // Copy primitives before the first await; mutable caller objects cannot retarget a read.
 const collection=key(input.collection,'INVALID_INPUT'),expectedGenesisHash=key(input.expectedGenesisHash,'INVALID_INPUT').toBase58();
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=new DeedMiningInventoryError('TIMEOUT');controller.abort(error);reject(error);},MINING_INVENTORY_LIMITS.timeoutMs);});
 const run=async():Promise<DeedMiningInventory>=>{
  const reader=typeof source==='function'?source(controller.signal):source;
  const read=async<T>(operation:()=>Promise<T>):Promise<T>=>{controller.signal.throwIfAborted();try{const result=await operation();controller.signal.throwIfAborted();return result;}catch(error){if(error instanceof DeedMiningInventoryError)throw error;return fail('READER_UNAVAILABLE');}};
  const genesis=await read(()=>reader.getGenesisHash());if(genesis!==expectedGenesisHash)fail('CLUSTER_MISMATCH');
  const before=await read(()=>reader.getAccountInfoAndContext(collection,{commitment:'finalized'}));
  const beforeSlot=slot(before?.context?.slot),initial=collectionFacts(before?.value);
  if(initial.numMinted!==initial.currentSize)fail('INVENTORY_INCOMPLETE');
  const inventory=await read(()=>reader.getProgramAccounts(CORE,{commitment:'finalized',withContext:true,minContextSlot:beforeSlot,
   filters:[{memcmp:{offset:0,bytes:bs58.encode(Uint8Array.of(Key.AssetV1))}},
    {memcmp:{offset:33,bytes:bs58.encode(Buffer.concat([Buffer.of(2),collection.toBuffer()]))}}]}));
  const throughSlot=slot(inventory?.context?.slot,beforeSlot),entries=inventory?.value;
  if(!Array.isArray(entries))fail('INVENTORY_INCOMPLETE');if(entries.length>MINING_INVENTORY_LIMITS.maxAssets)fail('TOO_LARGE');
  if(entries.length!==initial.numMinted)fail('INVENTORY_INCOMPLETE');
  // Bound the whole response before any plugin/string decoding. Do not hide an
  // oversized response by checking only the accounts that happen to parse.
  let totalBytes=0;
  for(const entry of entries){totalBytes+=data(entry?.account,'ASSET_INVALID').length;if(totalBytes>MINING_INVENTORY_LIMITS.maxTotalBytes)fail('TOO_LARGE');}
  const seen=new Set<string>(),assets:Readonly<{assetId:string;owner:string}>[]=[];
  for(const entry of entries){
   if(!(entry?.pubkey instanceof PublicKey))fail('ASSET_INVALID');const assetId=entry.pubkey.toBase58();if(seen.has(assetId))fail('ASSET_INVALID');seen.add(assetId);
   const bytes=data(entry.account,'ASSET_INVALID');
   if(bytes.length<66||bytes[0]!==Key.AssetV1||bytes[33]!==2||!bytes.subarray(34,66).equals(collection.toBuffer()))fail('ASSET_INVALID');
   try{
    // The decoder consumes THIS GPA account, never a later per-asset read.
    const [asset]=getAssetV1AccountDataSerializer().deserialize(bytes);
    const owner=key(String(asset.owner),'ASSET_INVALID').toBase58();
    if(asset.key!==Key.AssetV1||asset.updateAuthority.type!=='Collection'||String(asset.updateAuthority.address)!==collection.toBase58()
     ||!new PublicKey(bytes.subarray(1,33)).equals(new PublicKey(owner)))fail('ASSET_INVALID');
    assets.push(Object.freeze({assetId,owner}));
   }catch(error){if(error instanceof DeedMiningInventoryError)throw error;fail('ASSET_INVALID');}
  }
  // Owners are copied before this await: a newer collection context cannot
  // replace them or advance their reported bank. Count checks are necessary,
  // but offsetting imports/removals still need original-mint proofs later.
  const after=await read(()=>reader.getAccountInfoAndContext(collection,{commitment:'finalized',minContextSlot:throughSlot}));
  const afterSlot=slot(after?.context?.slot,throughSlot),final=collectionFacts(after?.value);
  if(final.numMinted!==initial.numMinted||final.currentSize!==initial.currentSize||final.updateAuthority!==initial.updateAuthority)fail('COLLECTION_CHANGED');
  assets.sort((a,b)=>Buffer.compare(new PublicKey(a.assetId).toBuffer(),new PublicKey(b.assetId).toBuffer()));
  return Object.freeze({collection:collection.toBase58(),genesisHash:genesis,throughSlot:String(throughSlot),collectionBeforeSlot:String(beforeSlot),collectionAfterSlot:String(afterSlot),
   numMinted:initial.numMinted,currentSize:initial.currentSize,collectionUpdateAuthority:initial.updateAuthority,assets:Object.freeze(assets),
   currentHorizonOnly:true,originalIssuanceVerified:false,intervalDeedlessnessAuthorized:false});
 };
 try{return await Promise.race([run(),deadline]);}catch(error){if(error instanceof DeedMiningInventoryError)throw error;return fail('READER_UNAVAILABLE');}
 finally{clearTimeout(timer);controller.abort();}
}
