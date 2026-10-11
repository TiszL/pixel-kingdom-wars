/** Complete-universe source facts, conditional on the configured trusted RPC's
 * exhaustive finalized address index. No DAS, registry, owner hint or earning
 * authority is accepted. Unsupported history is unknown, never known zero. */
import { PublicKey,SystemProgram } from '@solana/web3.js';
import { getCreateCollectionV1InstructionDataSerializer,getCreateCollectionV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { readDeedMiningInventory,DeedMiningInventoryError,type DeedMiningInventoryReader } from './deedMiningInventory';
import { readDeedMiningCreationAnchor,DeedMiningCreationAnchorError,type DeedMiningCreationReader } from './deedMiningCreationAnchor';
export type DeedMiningWalletReader=DeedMiningInventoryReader&DeedMiningCreationReader;
export interface DeedMiningWalletInput {collection:string;expectedGenesisHash:string;targetWallet:string;startAt:Date;endAt:Date}
type Code='INVALID_INPUT'|'SOURCE_REFUSED'|'HISTORY_INCOMPLETE'|'EVIDENCE_CONFLICT'|'UNSUPPORTED_HISTORY'|'INTERVAL_NOT_CLOSED'|'TOO_LARGE'|'TIMEOUT'|'READER_UNAVAILABLE';
export class DeedMiningWalletEvidenceError extends Error {
 constructor(readonly code:Code,readonly sourceCode?:string){super(`Mining wallet evidence refused: ${code}`);this.name='DeedMiningWalletEvidenceError';}
}
function fail(code:Code):never{throw new DeedMiningWalletEvidenceError(code);}
// Operational ceilings, not gameplay limits. There is one budget for the whole
// universe, including repeated per-asset mint-block reconciliation work.
export const MINING_WALLET_EVIDENCE_LIMITS=Object.freeze({maxAssets:256,maxRpcCalls:2048,maxTransactionReads:4096,maxSignatureRows:8192,maxBlockSignatureRows:65536,timeoutMs:20_000});
const CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function key(v:unknown):v is string{try{return typeof v==='string'&&v.length<=44&&new PublicKey(v).toBase58()===v;}catch{return false;}}
function signature(v:unknown):v is string{try{return typeof v==='string'&&v.length<=88&&bs58.decode(v).length===64&&bs58.encode(bs58.decode(v))===v;}catch{return false;}}

/** The collection account itself must belong to one unique original generation.
 * Asset instructions may legitimately reference the collection at account 1;
 * they are not collection mutations. Actual collection-target mutations other
 * than the decoded creation are conservatively unsupported by this version. */
async function collectionGeneration(reader:DeedMiningWalletReader,collection:string,through:number,throughTime:number){
 const rows:{signature:string;slot:number;blockTime:number|null;err:unknown}[]=[],seen=new Set<string>();
 let before:string|undefined,previous=Number.MAX_SAFE_INTEGER;
 for(;;){
  const page=await reader.getSignaturesForAddress(new PublicKey(collection),{limit:1000,minContextSlot:through,...(before?{before}:{})},'finalized');
  if(!Array.isArray(page)||page.length>1000)fail('EVIDENCE_CONFLICT');
  for(const row of page){
   if(!row||!signature(row.signature)||!integer(row.slot)||row.slot>previous||seen.has(row.signature)||(row.confirmationStatus!=null&&row.confirmationStatus!=='finalized')||(row.err!==null&&(typeof row.err!=='object'||row.err===undefined))||(row.blockTime!=null&&!integer(row.blockTime)))fail('EVIDENCE_CONFLICT');
   previous=row.slot;seen.add(row.signature);if(row.slot<=through)rows.push({...row,blockTime:row.blockTime??null});
  }
  if(page.length<1000)break;before=page.at(-1)!.signature;
 }
 let creation:{signature:string;slot:string;blockTime:number;transactionIndex:number}|undefined;
 for(const row of rows){
  const [tx,time,block]=await Promise.all([reader.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}),reader.getBlockTime(row.slot),reader.getBlockSignatures(row.slot,'finalized')]);
  if(!tx)fail('HISTORY_INCOMPLETE');
  if(!integer(time)||time>throughTime||!block||!Array.isArray(block.signatures)||!block.signatures.every(signature)||new Set(block.signatures).size!==block.signatures.length||(block.blockTime!=null&&block.blockTime!==time))fail('EVIDENCE_CONFLICT');
  const transactionIndex=block.signatures.indexOf(row.signature);
  if(transactionIndex<0||tx.slot!==row.slot||tx.blockTime!==time||(row.blockTime!==null&&row.blockTime!==time)||!tx.meta||JSON.stringify(tx.meta.err)!==JSON.stringify(row.err)||(tx.version!==undefined&&tx.version!==0&&tx.version!=='legacy'))fail('EVIDENCE_CONFLICT');
  const msg=tx.transaction.message,keys=msg.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses??null});
  if(keys.length>256||!integer(msg.header.numRequiredSignatures)||msg.header.numRequiredSignatures<1||msg.header.numRequiredSignatures>keys.staticAccountKeys.length||!Array.isArray(tx.transaction.signatures)||tx.transaction.signatures[0]!==row.signature||tx.transaction.signatures.length!==msg.header.numRequiredSignatures||!tx.transaction.signatures.every(signature)||!Array.isArray(msg.compiledInstructions)||msg.compiledInstructions.length>256)fail('EVIDENCE_CONFLICT');
  const validIndex=(i:number)=>integer(i)&&i<keys.length;
  let references=false;for(let i=0;i<keys.length;i++){if(!key(keys.get(i)?.toBase58()))fail('EVIDENCE_CONFLICT');if(keys.get(i)?.toBase58()===collection)references=true;}
  if(!references)fail('EVIDENCE_CONFLICT');
  for(const ix of msg.compiledInstructions)if(!validIndex(ix.programIdIndex)||!ix.accountKeyIndexes.every(validIndex)||!(ix.data instanceof Uint8Array)||ix.data.length>65536)fail('EVIDENCE_CONFLICT');
  if(tx.meta.err!==null)continue;
  if(!Array.isArray(tx.meta.innerInstructions)||tx.meta.innerInstructions.length>256)fail('UNSUPPORTED_HISTORY');
  for(const group of tx.meta.innerInstructions){
   if(!integer(group.index)||group.index>=msg.compiledInstructions.length||!Array.isArray(group.instructions)||group.instructions.length>256)fail('EVIDENCE_CONFLICT');
   for(const ix of group.instructions){
    if(!validIndex(ix.programIdIndex)||!Array.isArray(ix.accounts)||!ix.accounts.every(validIndex)||typeof ix.data!=='string'||ix.data.length>90000)fail('EVIDENCE_CONFLICT');
    if(keys.get(ix.programIdIndex)?.equals(CORE)){
     let data:Uint8Array;try{data=bs58.decode(ix.data);}catch{fail('EVIDENCE_CONFLICT');}
     if(keys.get(ix.accounts[0]!)?.toBase58()===collection||(ix.accounts.some(i=>keys.get(i)?.toBase58()===collection)&&(data[0]===undefined||data[0]>32)))fail('UNSUPPORTED_HISTORY');
    }
   }
  }
  for(const ix of msg.compiledInstructions){
   if(!keys.get(ix.programIdIndex)?.equals(CORE))continue;
   // Core v1.10 discriminators 0..32 use the target at account zero.
   // Group/unknown multi-object instructions need a separate source proof.
   if(ix.accountKeyIndexes.some(i=>keys.get(i)?.toBase58()===collection)&&(ix.data[0]===undefined||ix.data[0]>32))fail('UNSUPPORTED_HISTORY');
   if(keys.get(ix.accountKeyIndexes[0]!)?.toBase58()!==collection)continue;
   const isCreate=ix.data[0]===1||ix.data[0]===21;
   if(!isCreate||creation)fail('UNSUPPORTED_HISTORY');
   const decoder=ix.data[0]===1?getCreateCollectionV1InstructionDataSerializer():getCreateCollectionV2InstructionDataSerializer();
   try{const [,offset]=decoder.deserialize(ix.data);if(offset!==ix.data.length)fail('UNSUPPORTED_HISTORY');}catch{fail('UNSUPPORTED_HISTORY');}
   if(ix.accountKeyIndexes.length!==4||!msg.isAccountSigner(ix.accountKeyIndexes[0]!)||!msg.isAccountWritable(ix.accountKeyIndexes[0]!)||!msg.isAccountSigner(ix.accountKeyIndexes[2]!)||!msg.isAccountWritable(ix.accountKeyIndexes[2]!)||!keys.get(ix.accountKeyIndexes[3]!)?.equals(SystemProgram.programId))fail('UNSUPPORTED_HISTORY');
   creation={signature:row.signature,slot:String(row.slot),blockTime:time,transactionIndex};
  }
 }
 if(!creation)fail('HISTORY_INCOMPLETE');
 return Object.freeze(creation);
}

export async function readDeedMiningWalletEvidence(source:DeedMiningWalletReader|((signal:AbortSignal)=>DeedMiningWalletReader),input:DeedMiningWalletInput){
 if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['collection','expectedGenesisHash','targetWallet','startAt','endAt'].includes(k))||![input.collection,input.expectedGenesisHash,input.targetWallet].every(key)||!(input.startAt instanceof Date)||!(input.endAt instanceof Date)||!Number.isSafeInteger(input.startAt.getTime())||!Number.isSafeInteger(input.endAt.getTime())||input.startAt.getTime()<0||input.startAt>=input.endAt)fail('INVALID_INPUT');
 const collection=input.collection,genesis=input.expectedGenesisHash,targetWallet=input.targetWallet,start=input.startAt.getTime(),end=input.endAt.getTime();
 const controller=new AbortController();let terminal:DeedMiningWalletEvidenceError|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let calls=0,txReads=0,signatureRows=0,blockRows=0;
 const stop=(code:Code):never=>{terminal??=new DeedMiningWalletEvidenceError(code);controller.abort();throw terminal;};
 try{
  const raw=typeof source==='function'?source(controller.signal):source;
  const cache=new Map<string,Promise<unknown>>();
  async function invoke(method:keyof DeedMiningWalletReader,args:unknown[]){
   if(controller.signal.aborted)throw terminal??new DeedMiningWalletEvidenceError('TIMEOUT');
   if(method==='getTransaction'&&++txReads>MINING_WALLET_EVIDENCE_LIMITS.maxTransactionReads)stop('TOO_LARGE');
   const cached=['getTransaction','getBlockTime','getBlockSignatures'].includes(method)?`${method}:${String(args[0])}`:undefined;
   if(cached&&cache.has(cached))return cache.get(cached)!;
   if(++calls>MINING_WALLET_EVIDENCE_LIMITS.maxRpcCalls)stop('TOO_LARGE');
   const pending=(async()=>{
    const fn=raw[method] as (...values:unknown[])=>Promise<unknown>;const result=await fn.apply(raw,args);
    if(controller.signal.aborted)throw terminal??new DeedMiningWalletEvidenceError('TIMEOUT');
    if(method==='getProgramAccounts'&&result&&typeof result==='object'&&'value' in result&&Array.isArray(result.value)&&result.value.length>MINING_WALLET_EVIDENCE_LIMITS.maxAssets)stop('TOO_LARGE');
    if(method==='getSignaturesForAddress'&&Array.isArray(result)){signatureRows+=result.length;if(signatureRows>MINING_WALLET_EVIDENCE_LIMITS.maxSignatureRows)stop('TOO_LARGE');}
    if(method==='getBlockSignatures'&&result&&typeof result==='object'&&'signatures' in result&&Array.isArray(result.signatures)){blockRows+=result.signatures.length;if(blockRows>MINING_WALLET_EVIDENCE_LIMITS.maxBlockSignatureRows)stop('TOO_LARGE');}
    return result;
   })();if(cached)cache.set(cached,pending);return pending;
  }
  const reader=Object.fromEntries(['getGenesisHash','getAccountInfoAndContext','getProgramAccounts','getSlot','getSignaturesForAddress','getTransaction','getBlockTime','getBlockSignatures'].map(method=>[method,(...args:unknown[])=>invoke(method as keyof DeedMiningWalletReader,args)])) as unknown as DeedMiningWalletReader;
  const run=async()=>{
   const inventory=await readDeedMiningInventory(reader,{collection,expectedGenesisHash:genesis}),through=Number(inventory.throughSlot);
   const throughBlockTime=await reader.getBlockTime(through);
   if(!integer(throughBlockTime)||!Number.isSafeInteger(throughBlockTime*1000))fail('EVIDENCE_CONFLICT');
   if(throughBlockTime*1000<end)fail('INTERVAL_NOT_CLOSED');
   const generation=await collectionGeneration(reader,collection,through,throughBlockTime);
   const held:string[]=[],continuous:string[]=[],assets=[];
   for(const item of inventory.assets){
    const proof=await readDeedMiningCreationAnchor(reader,{assetId:item.assetId,collection,expectedGenesisHash:genesis,throughSlot:inventory.throughSlot}),e=proof.evidence;
    if(proof.ownerAtHorizon!==item.owner||e.throughSlot!==inventory.throughSlot||e.throughBlockTime!==throughBlockTime||e.genesisHash!==genesis||proof.collection!==collection||proof.assetId!==item.assetId)fail('EVIDENCE_CONFLICT');
    if(Number(e.mint.slot)<Number(generation.slot)||(e.mint.slot===generation.slot&&e.mint.transactionIndex<=generation.transactionIndex)||e.mint.blockTime<generation.blockTime)fail('EVIDENCE_CONFLICT');
    let owner=proof.originalOwner,ownerAtStart:string|null=e.mint.blockTime*1000<start?owner:null;
    // Initial boundary is before exact-start instructions. An acquisition at
    // that boundary is observed ownership, but not continuous prior ownership.
    for(const tx of e.transactions){if(tx.blockTime*1000>=start)break;for(const move of tx.transitions){if(move.from!==owner)fail('EVIDENCE_CONFLICT');owner=move.to;}ownerAtStart=owner;}
    let any=ownerAtStart===targetWallet,all=ownerAtStart===targetWallet;
    if(e.mint.blockTime*1000>=start&&e.mint.blockTime*1000<end&&proof.originalOwner===targetWallet)any=true;
    for(const tx of e.transactions){if(tx.blockTime*1000<start)continue;for(const move of tx.transitions){if(move.from!==owner)fail('EVIDENCE_CONFLICT');if(tx.blockTime*1000<end){if(move.from===targetWallet||move.to===targetWallet)any=true;if(move.from!==targetWallet||move.to!==targetWallet)all=false;}owner=move.to;}}
    if(owner!==item.owner)fail('EVIDENCE_CONFLICT');
    if(any)held.push(item.assetId);if(all)continuous.push(item.assetId);
    assets.push(Object.freeze({assetId:item.assetId,ownerAtStart,ownerAtHorizon:item.owner,mint:Object.freeze({...e.mint}),transactions:Object.freeze(e.transactions.map(t=>Object.freeze({...t,transitions:Object.freeze(t.transitions.map(m=>Object.freeze({...m})))})))}));
   }
   if(await reader.getGenesisHash()!==genesis)fail('EVIDENCE_CONFLICT');
   const finalized=await reader.getSlot('finalized');if(!integer(finalized)||finalized<through)fail('EVIDENCE_CONFLICT');
   return Object.freeze({collection,genesisHash:genesis,targetWallet,startAt:new Date(start),endAt:new Date(end),throughSlot:inventory.throughSlot,throughBlockTime,deedlessThroughout:held.length===0,heldDuringIntervalAssetIds:Object.freeze(held),continuouslyHeldAssetIds:Object.freeze(continuous),eligibilityAuthorized:false as const,evidence:Object.freeze({trust:'trusted-finalized-rpc' as const,addressIndexCompleteness:'configured-provider-trust' as const,collectionGeneration:generation,numMinted:inventory.numMinted,currentSize:inventory.currentSize,assets:Object.freeze(assets)})});
  };
  return await Promise.race([run(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{terminal=new DeedMiningWalletEvidenceError('TIMEOUT');controller.abort();reject(terminal);},MINING_WALLET_EVIDENCE_LIMITS.timeoutMs);})]);
 }catch(error){
  if(terminal)throw terminal;if(error instanceof DeedMiningWalletEvidenceError)throw error;
  if(error instanceof DeedMiningInventoryError||error instanceof DeedMiningCreationAnchorError)throw new DeedMiningWalletEvidenceError(error.code==='READER_UNAVAILABLE'?'READER_UNAVAILABLE':error.code==='TIMEOUT'?'TIMEOUT':'SOURCE_REFUSED',error.code);
  throw new DeedMiningWalletEvidenceError('READER_UNAVAILABLE');
 }finally{if(timer)clearTimeout(timer);controller.abort();}
}
