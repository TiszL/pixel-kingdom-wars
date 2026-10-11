/** Creation-derived ownership, conditional on a trusted archival finalized RPC
 * and authenticated genesis/collection configuration. Address history outside
 * the separately reconciled mint block trusts that provider's complete index.
 * The anchor is END of mint slot, never interval-start ownership if creation
 * falls inside that interval. No earning eligibility follows from this reader. */
import { PublicKey,type Connection,type ConfirmedSignatureInfo,type VersionedTransactionResponse } from '@solana/web3.js';
import { getCreateV1InstructionDataSerializer,getCreateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { originalDeedOwner } from './deedMintEvidence';
import { replayDeedOwner,type DeedOwnerTransition } from './deedCloseEvidence';
export type DeedMiningCreationReader=Pick<Connection,'getGenesisHash'|'getSlot'|'getSignaturesForAddress'|'getTransaction'|'getBlockTime'|'getBlockSignatures'>;
export interface DeedMiningCreationInput {assetId:string;collection:string;expectedGenesisHash:string;throughSlot?:string}
type Code='INVALID_INPUT'|'GENESIS_MISMATCH'|'CONTEXT_REGRESSION'|'HISTORY_INCOMPLETE'|'EVIDENCE_CONFLICT'|'UNSUPPORTED_HISTORY'|'TOO_LARGE'|'READER_UNAVAILABLE';
export class DeedMiningCreationAnchorError extends Error {
 constructor(readonly code:Code){super(`Deed creation anchor refused: ${code}`);this.name='DeedMiningCreationAnchorError';}
}
function fail(code:Code):never{throw new DeedMiningCreationAnchorError(code);}
const CORE=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// Local operational bounds. Exhaustion refuses instead of truncating history.
const PAGE_SIZE=1_000,MAX_PAGES=20,MAX_TRANSACTIONS=2_000,MAX_BLOCK_SIGNATURES=50_000;
const slotValid=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const timeValid=(v:unknown):v is number=>slotValid(v)&&v<=8_640_000_000_000;
function keyValid(v:unknown):v is string{if(typeof v!=='string'||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}}
function signatureValid(v:unknown):v is string{if(typeof v!=='string'||v.length>88)return false;try{const bytes=bs58.decode(v);return bytes.length===64&&bs58.encode(bytes)===v;}catch{return false;}}
async function read<T>(fn:()=>Promise<T>):Promise<T>{try{return await fn();}catch{return fail('READER_UNAVAILABLE');}}
type Tx=VersionedTransactionResponse;
type Proven={tx:Tx;signature:string;transactionIndex:number};
export interface DeedMiningCreationTransaction {signature:string;slot:string;blockTime:number;transactionIndex:number;failed:boolean;transitions:DeedOwnerTransition[]}
function checkBody(tx:Tx,signature:string,slot:number,blockTime:number,row?:ConfirmedSignatureInfo){
 try{
  if(tx.version!==undefined&&tx.version!==0&&tx.version!=='legacy')return fail('UNSUPPORTED_HISTORY');
  const msg=tx.transaction.message,header=msg.header;
  if(!tx.meta||tx.slot!==slot||tx.blockTime!==blockTime||!Array.isArray(tx.transaction.signatures)
   ||tx.transaction.signatures[0]!==signature||tx.transaction.signatures.length>256
   ||tx.transaction.signatures.length!==header.numRequiredSignatures||!tx.transaction.signatures.every(signatureValid)
   ||!Number.isInteger(header.numRequiredSignatures)||header.numRequiredSignatures<1
   ||(tx.meta.err!==null&&(typeof tx.meta.err!=='object'||tx.meta.err===undefined)))return fail('EVIDENCE_CONFLICT');
  if(row&&((row.blockTime!=null&&row.blockTime!==blockTime)||JSON.stringify(row.err)!==JSON.stringify(tx.meta.err)))return fail('EVIDENCE_CONFLICT');
  const keys=msg.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses??null});
  if(keys.length>256||header.numRequiredSignatures>keys.staticAccountKeys.length)return fail('EVIDENCE_CONFLICT');
  for(let i=0;i<keys.length;i++)if(!keyValid(keys.get(i)?.toBase58()))return fail('EVIDENCE_CONFLICT');
  const validIndex=(i:number)=>Number.isInteger(i)&&i>=0&&i<keys.length;
  if(!Array.isArray(msg.compiledInstructions)||msg.compiledInstructions.length>256)return fail('EVIDENCE_CONFLICT');
  for(const ix of msg.compiledInstructions)if(!validIndex(ix.programIdIndex)||!ix.accountKeyIndexes.every(validIndex)||!(ix.data instanceof Uint8Array)||ix.data.length>65_536)return fail('EVIDENCE_CONFLICT');
  if(tx.meta.err===null&&!Array.isArray(tx.meta.innerInstructions))return fail('UNSUPPORTED_HISTORY');
  const inner=tx.meta.innerInstructions??[];if(!Array.isArray(inner)||inner.length>256)return fail('EVIDENCE_CONFLICT');
  for(const group of inner){
   if(!Number.isInteger(group.index)||group.index<0||group.index>=msg.compiledInstructions.length||!Array.isArray(group.instructions)||group.instructions.length>256)return fail('EVIDENCE_CONFLICT');
   for(const ix of group.instructions)if(!validIndex(ix.programIdIndex)||!Array.isArray(ix.accounts)||!ix.accounts.every(validIndex)||typeof ix.data!=='string'||ix.data.length>90_000)return fail('EVIDENCE_CONFLICT');
  }
  return keys;
 }catch(error){if(error instanceof DeedMiningCreationAnchorError)throw error;return fail('EVIDENCE_CONFLICT');}
}
function coreInstructions(tx:Tx,asset:string){
 const keys=tx.transaction.message.getAccountKeys({accountKeysFromLookups:tx.meta!.loadedAddresses??null});
 if(tx.meta!.err!==null)return [];
 for(const group of tx.meta!.innerInstructions!)for(const ix of group.instructions)
  if(keys.get(ix.programIdIndex)?.equals(CORE)&&ix.accounts.some(i=>keys.get(i)?.toBase58()===asset))return fail('UNSUPPORTED_HISTORY');
 return tx.transaction.message.compiledInstructions.flatMap((ix,index)=>keys.get(ix.programIdIndex)?.equals(CORE)&&ix.accountKeyIndexes.some(i=>keys.get(i)?.toBase58()===asset)?[{ix,index}]:[]);
}
export async function readDeedMiningCreationAnchor(reader:DeedMiningCreationReader,input:DeedMiningCreationInput){
 if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['assetId','collection','expectedGenesisHash','throughSlot'].includes(k))
  ||![input.assetId,input.collection,input.expectedGenesisHash].every(keyValid)||input.assetId===input.collection
  ||(input.throughSlot!==undefined&&(typeof input.throughSlot!=='string'||input.throughSlot.length>16||!/^(0|[1-9]\d*)$/.test(input.throughSlot)||!slotValid(Number(input.throughSlot)))))return fail('INVALID_INPUT');
 const asset=input.assetId,collection=input.collection,genesis=input.expectedGenesisHash,requested=input.throughSlot;
 if(await read(()=>reader.getGenesisHash())!==genesis)return fail('GENESIS_MISMATCH');
 const finalized=await read(()=>reader.getSlot('finalized'));if(!slotValid(finalized))return fail('CONTEXT_REGRESSION');
 const through=requested===undefined?finalized:Number(requested);if(through>finalized)return fail('CONTEXT_REGRESSION');
 const observedThroughTime=await read(()=>reader.getBlockTime(through));if(!timeValid(observedThroughTime))return fail('EVIDENCE_CONFLICT');
 const throughTime:number=observedThroughTime;
 const rows:ConfirmedSignatureInfo[]=[],seen=new Set<string>();let before:string|undefined,previous=Number.MAX_SAFE_INTEGER,complete=false;
 for(let page=0;page<MAX_PAGES;page++){
  const pageRows=await read(()=>reader.getSignaturesForAddress(new PublicKey(asset),{limit:PAGE_SIZE,minContextSlot:finalized,...(before?{before}:{})},'finalized'));
  if(!Array.isArray(pageRows)||pageRows.length>PAGE_SIZE)return fail('EVIDENCE_CONFLICT');
  for(const row of pageRows){
   if(!row||!signatureValid(row.signature)||!slotValid(row.slot)||row.slot>previous||seen.has(row.signature)
    ||(row.confirmationStatus!=null&&row.confirmationStatus!=='finalized')||(row.err!==null&&(typeof row.err!=='object'||row.err===undefined))
    ||(row.blockTime!=null&&!timeValid(row.blockTime)))return fail('EVIDENCE_CONFLICT');
   previous=row.slot;seen.add(row.signature);if(row.slot<=through)rows.push(row);if(rows.length>MAX_TRANSACTIONS)return fail('TOO_LARGE');
  }
  if(pageRows.length<PAGE_SIZE){complete=true;break;}before=pageRows.at(-1)!.signature;
 }
 if(!complete)return fail('TOO_LARGE');if(!rows.length)return fail('HISTORY_INCOMPLETE');
 const blocks=new Map<number,{time:number;signatures:string[]}>(),bodies=new Map<string,Tx>();
 async function block(slot:number){
  const existing=blocks.get(slot);if(existing)return existing;
  const [time,order]=await Promise.all([read(()=>reader.getBlockTime(slot)),read(()=>reader.getBlockSignatures(slot,'finalized'))]);
  if(!timeValid(time)||time>throughTime||!order||!Array.isArray(order.signatures))return fail('EVIDENCE_CONFLICT');
  if(order.signatures.length>MAX_BLOCK_SIGNATURES)return fail('TOO_LARGE');
  if((order.blockTime!=null&&order.blockTime!==time)||!order.signatures.every(signatureValid)||new Set(order.signatures).size!==order.signatures.length)return fail('EVIDENCE_CONFLICT');
  const result={time,signatures:order.signatures};blocks.set(slot,result);return result;
 }
 async function body(signature:string,slot:number,time:number,row?:ConfirmedSignatureInfo){
  let tx=bodies.get(signature);if(!tx){if(bodies.size>=MAX_TRANSACTIONS)return fail('TOO_LARGE');tx=await read(()=>reader.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0}))??undefined;if(!tx)return fail('HISTORY_INCOMPLETE');bodies.set(signature,tx);}
  return {tx,keys:checkBody(tx,signature,slot,time,row)};
 }
 const ordered:Proven[]=[];
 for(const row of rows){
  const b=await block(row.slot),index=b.signatures.indexOf(row.signature);if(index<0)return fail('EVIDENCE_CONFLICT');
  const {tx,keys}=await body(row.signature,row.slot,b.time,row);let bound=false;
  for(let i=0;i<keys.length;i++)if(keys.get(i)?.toBase58()===asset)bound=true;if(!bound)return fail('EVIDENCE_CONFLICT');
  ordered.push({tx,signature:row.signature,transactionIndex:index});
 }
 ordered.sort((a,b)=>a.tx.slot-b.tx.slot||a.transactionIndex-b.transactionIndex);
 let lastTime=0,mint:Proven|undefined,mintInstruction=-1,originalOwner='';
 for(const item of ordered){
  if(item.tx.blockTime!<lastTime)return fail('EVIDENCE_CONFLICT');lastTime=item.tx.blockTime!;
  const core=coreInstructions(item.tx,asset),creates=core.filter(({ix})=>ix.data[0]===0||ix.data[0]===20);
  if(!creates.length)continue;if(mint||creates.length!==1||core.length!==1)return fail('UNSUPPORTED_HISTORY');
  const {ix,index}=creates[0]!,msg=item.tx.transaction.message,keys=msg.getAccountKeys({accountKeysFromLookups:item.tx.meta!.loadedAddresses??null});
  try{
   const decoder=ix.data[0]===0?getCreateV1InstructionDataSerializer():getCreateV2InstructionDataSerializer(),[data,offset]=decoder.deserialize(ix.data);
   if(offset!==ix.data.length||data.dataState!==0||ix.accountKeyIndexes.length!==8||keys.get(ix.accountKeyIndexes[0]!)?.toBase58()!==asset
    ||keys.get(ix.accountKeyIndexes[1]!)?.toBase58()!==collection||!msg.isAccountSigner(ix.accountKeyIndexes[0]!)||!msg.isAccountSigner(ix.accountKeyIndexes[3]!)
    ||!msg.isAccountWritable(ix.accountKeyIndexes[0]!)||!msg.isAccountWritable(ix.accountKeyIndexes[1]!)
    ||(keys.get(ix.accountKeyIndexes[2]!)?.toBase58()!==CORE.toBase58()&&!msg.isAccountSigner(ix.accountKeyIndexes[2]!)))return fail('UNSUPPORTED_HISTORY');
   const original=originalDeedOwner(item.tx,asset,collection);if(!original||!keyValid(original))return fail('UNSUPPORTED_HISTORY');originalOwner=original;
  }catch{return fail('UNSUPPORTED_HISTORY');}
  mint=item;mintInstruction=index;
 }
 if(!mint)return fail('HISTORY_INCOMPLETE');
 const mintBlock=await block(mint.tx.slot);
 if(new Set([...bodies.keys(),...mintBlock.signatures]).size>MAX_TRANSACTIONS)return fail('TOO_LARGE');
 // Independently reconcile the mint block's complete inventory, including a
 // later asset transaction accidentally omitted by address indexing.
 for(const signature of mintBlock.signatures){
  const {keys}=await body(signature,mint.tx.slot,mintBlock.time);let references=false;
  for(let i=0;i<keys.length;i++)if(keys.get(i)?.toBase58()===asset)references=true;
  if(references&&!rows.some(r=>r.signature===signature))return fail('HISTORY_INCOMPLETE');
 }
 let owner=originalOwner,ownerAtMintSlot=originalOwner;
 const transactions:DeedMiningCreationTransaction[]=[];
 for(const item of ordered){
  if(item===mint)continue;
  if(item.tx.slot<mint.tx.slot||(item.tx.slot===mint.tx.slot&&item.transactionIndex<mint.transactionIndex)){
   if(item.tx.meta!.err===null)return fail('HISTORY_INCOMPLETE');continue;
  }
  const core=coreInstructions(item.tx,asset),keys=item.tx.transaction.message.getAccountKeys({accountKeysFromLookups:item.tx.meta!.loadedAddresses??null});
  if(core.some(({ix})=>keys.get(ix.accountKeyIndexes[0]!)?.toBase58()!==asset))return fail('UNSUPPORTED_HISTORY');
  const transitions:DeedOwnerTransition[]=[];
  try{owner=replayDeedOwner(item.tx,asset,collection,owner,transitions);}catch{return fail('UNSUPPORTED_HISTORY');}
  if(item.tx.slot===mint.tx.slot)ownerAtMintSlot=owner;
  transactions.push({signature:item.signature,slot:String(item.tx.slot),blockTime:item.tx.blockTime!,transactionIndex:item.transactionIndex,failed:item.tx.meta!.err!==null,transitions});
 }
 const finalSlot=await read(()=>reader.getSlot('finalized'));if(!slotValid(finalSlot)||finalSlot<finalized)return fail('CONTEXT_REGRESSION');
 if(await read(()=>reader.getGenesisHash())!==genesis)return fail('GENESIS_MISMATCH');
 return {assetId:asset,collection,originalOwner,ownerAtMintSlot,ownerAtHorizon:owner,anchor:{owner:ownerAtMintSlot,priorFinalizedSlot:String(mint.tx.slot)},
  evidence:{trust:'trusted-finalized-rpc' as const,genesisHash:genesis,throughSlot:String(through),throughBlockTime:throughTime,
   mint:{signature:mint.signature,slot:String(mint.tx.slot),blockTime:mint.tx.blockTime!,transactionIndex:mint.transactionIndex,instructionIndex:mintInstruction},
   sameSlotTransactions:transactions.filter(t=>t.slot===String(mint!.tx.slot)),transactions,
   historySignatures:ordered.map(t=>({signature:t.signature,slot:String(t.tx.slot),transactionIndex:t.transactionIndex,failed:t.tx.meta!.err!==null}))}};
}
