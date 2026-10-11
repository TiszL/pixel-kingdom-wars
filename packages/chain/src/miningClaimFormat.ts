/** D153.206 optional ordered v0 encoding. This is transport authority only: it
 * never expands admitted roots or grants signing/delivery permission. */
import {createHash} from 'node:crypto';
import {AddressLookupTableAccount,AddressLookupTableProgram,ComputeBudgetProgram,MessageV0,PublicKey,SystemProgram,type VersionedTransactionResponse} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {miningConfigPda,type MiningProgramIdentity} from './miningProgramProtocol';
import type {MiningClaimSnapshotReader} from './miningClaimSnapshot';
export interface MiningClaimFormat {
 readonly version:1;readonly preset:'ordered-v0';
 readonly lookupTable:Readonly<{address:string;owner:string;executable:false;dataHex:string;slot:number}>;
 readonly expectedLookupTable:Readonly<{address:string;dataSha256:string}>;
 readonly blockhashContextSlot:number;
}
export class MiningClaimFormatError extends Error{constructor(){super('Mining claim format refused');this.name='MiningClaimFormatError';}}
function need(v:unknown):asserts v{if(!v)throw new MiningClaimFormatError();}
function exact(v:unknown,names:string):Record<string,unknown>{need(v&&typeof v==='object'&&!Array.isArray(v));const fields=names.split(' ');need(Object.keys(v).length===fields.length&&Object.keys(v).every(k=>fields.includes(k)));return v as Record<string,unknown>;}
const safe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const sha=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function address(v:unknown):string{need(typeof v==='string'&&v.length>=32&&v.length<=44);try{need(new PublicKey(v).toBase58()===v);return v;}catch{throw new MiningClaimFormatError();}}
export function miningClaimLookupAddresses(identity:MiningProgramIdentity):PublicKey[]{const config=miningConfigPda(identity.programId);return [config,getAssociatedTokenAddressSync(identity.keepMint,config,true),new PublicKey(identity.keepMint.toBytes())];}
/** Copy and attest before an await. A pin is application-owned, never supplied
 * by a claimant. Exactly three common keys; changing roots and wallets stay static. */
export function copyMiningClaimFormat(input:unknown,identity?:MiningProgramIdentity):MiningClaimFormat{
 try{
  const r=exact(input,'version preset lookupTable expectedLookupTable blockhashContextSlot'),raw=exact(r.lookupTable,'address owner executable dataHex slot'),pin=exact(r.expectedLookupTable,'address dataSha256');
  need(r.version===1&&r.preset==='ordered-v0'&&safe(r.blockhashContextSlot)&&safe(raw.slot));
  need(raw.executable===false&&address(raw.owner)===AddressLookupTableProgram.programId.toBase58()&&address(raw.address)===address(pin.address));
  // ALT metadata is 56 bytes; the accepted immutable common table has three keys.
  need(typeof raw.dataHex==='string'&&raw.dataHex.length===304&&/^[0-9a-f]+$/.test(raw.dataHex)&&typeof pin.dataSha256==='string'&&/^[0-9a-f]{64}$/.test(pin.dataSha256));
  const bytes=Buffer.from(raw.dataHex,'hex');need(sha(bytes)===pin.dataSha256);const state=AddressLookupTableAccount.deserialize(bytes);
  need(state.authority===undefined&&state.deactivationSlot===(1n<<64n)-1n&&safe(state.lastExtendedSlot)&&state.lastExtendedSlot<raw.slot&&raw.slot<=r.blockhashContextSlot&&state.lastExtendedSlotStartIndex<=3);
  const keys=state.addresses.map(k=>k.toBase58()),programs=[SystemProgram.programId,ComputeBudgetProgram.programId,TOKEN_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,AddressLookupTableProgram.programId,...(identity?[identity.programId]:[])].map(k=>k.toBase58());need(keys.length===3&&new Set(keys).size===3&&!keys.includes(raw.address as string)&&keys.every(k=>!programs.includes(k)));
  if(identity)need(keys.join(',')===miningClaimLookupAddresses(identity).map(k=>k.toBase58()).join(','));
  return Object.freeze({version:1,preset:'ordered-v0',lookupTable:Object.freeze({address:raw.address as string,owner:raw.owner as string,executable:false,dataHex:raw.dataHex,slot:raw.slot}),expectedLookupTable:Object.freeze({address:pin.address as string,dataSha256:pin.dataSha256}),blockhashContextSlot:r.blockhashContextSlot});
 }catch{throw new MiningClaimFormatError();}
}
export function miningClaimLookupTable(format:MiningClaimFormat):AddressLookupTableAccount{return new AddressLookupTableAccount({key:new PublicKey(format.lookupTable.address),state:AddressLookupTableAccount.deserialize(Buffer.from(format.lookupTable.dataHex,'hex'))});}
/** Resolve indices from the saved frozen bytes, never from RPC loaded addresses. */
export function miningClaimV0Accounts(message:MessageV0,format:MiningClaimFormat){
 const table=miningClaimLookupTable(format),lookups=message.addressTableLookups;need(lookups.length<=1);
 if(lookups.length){const l=lookups[0]!;need(l.accountKey.equals(table.key));const all=[...l.writableIndexes,...l.readonlyIndexes];need(all.length>0&&new Set(all).size===all.length&&all.every(i=>Number.isInteger(i)&&i>=0&&i<3));}
 const loaded=lookups.length?message.resolveAddressTableLookups([table]):{writable:[],readonly:[]};
 const keys=[...message.staticAccountKeys,...loaded.writable,...loaded.readonly];need(keys.length<=32&&new Set(keys.map(k=>k.toBase58())).size===keys.length);
 // Solana requires signers and invoked programs to be static; assert that here
 // rather than trusting provider resolution or a permissive message decoder.
 need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0);
 for(const ix of message.compiledInstructions)need(ix.programIdIndex<message.staticAccountKeys.length&&ix.programIdIndex>=1&&ix.accountKeyIndexes.every(i=>i>=0&&i<keys.length));
 const forbidden=new Set([message.staticAccountKeys[0]!.toBase58(),...message.compiledInstructions.map(ix=>message.staticAccountKeys[ix.programIdIndex]!.toBase58())]);
 need(table.state.addresses.every(k=>!forbidden.has(k.toBase58())));
 return {keys,loaded};
}
/** Bound provider fields then construct our own v0 object. No provider serialize
 * method or provider-loaded key can decide which accounts were authenticated. */
export function verifyMiningClaimV0Rpc(tx:VersionedTransactionResponse,intent:Uint8Array,signature:string,format:MiningClaimFormat){
 const m=tx.transaction?.message;need(tx.version===0&&m?.version===0);
 need(Array.isArray(m.staticAccountKeys)&&m.staticAccountKeys.length>0&&m.staticAccountKeys.length<=32&&Array.isArray(m.compiledInstructions)&&m.compiledInstructions.length>0&&m.compiledInstructions.length<=3&&Array.isArray(m.addressTableLookups)&&m.addressTableLookups.length<=1);
 const h=m.header;need(h&&safe(h.numRequiredSignatures)&&safe(h.numReadonlySignedAccounts)&&safe(h.numReadonlyUnsignedAccounts)&&h.numRequiredSignatures===1&&h.numReadonlySignedAccounts===0&&h.numReadonlyUnsignedAccounts<m.staticAccountKeys.length);
 const key=(k:PublicKey)=>{need(k instanceof PublicKey);return new PublicKey(k.toBytes());};
 const copy=new MessageV0({header:{...h},staticAccountKeys:m.staticAccountKeys.map(key),recentBlockhash:address(m.recentBlockhash),compiledInstructions:m.compiledInstructions.map(ix=>{
  need(ix&&safe(ix.programIdIndex)&&ix.programIdIndex<m.staticAccountKeys.length&&ix.data instanceof Uint8Array&&ix.data.length<=1232&&Array.isArray(ix.accountKeyIndexes)&&ix.accountKeyIndexes.length<=32&&ix.accountKeyIndexes.every(safe));
  return {programIdIndex:ix.programIdIndex,accountKeyIndexes:[...ix.accountKeyIndexes],data:Uint8Array.from(ix.data)};
 }),addressTableLookups:m.addressTableLookups.map(l=>{need(l&&Array.isArray(l.writableIndexes)&&Array.isArray(l.readonlyIndexes)&&l.writableIndexes.length+l.readonlyIndexes.length<=3&&[...l.writableIndexes,...l.readonlyIndexes].every(safe));return {accountKey:key(l.accountKey),writableIndexes:[...l.writableIndexes],readonlyIndexes:[...l.readonlyIndexes]};})});
 need(Buffer.from(copy.serialize()).equals(Buffer.from(intent))&&Array.isArray(tx.transaction.signatures)&&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signature);
 const resolved=miningClaimV0Accounts(copy,format),loaded=tx.meta?.loadedAddresses;
 need(loaded&&Array.isArray(loaded.writable)&&Array.isArray(loaded.readonly));
 for(const kind of ['writable','readonly'] as const)need(loaded[kind].length===resolved.loaded[kind].length&&loaded[kind].every((k,i)=>key(k).equals(resolved.loaded[kind][i]!)));
 return {message:copy,...resolved};
}
/** Frozen means its bytes cannot legitimately change after preparation. A current
 * finalized read at/after execution independently authenticates the retained pin. */
export async function attestMiningClaimLookup(reader:MiningClaimSnapshotReader,format:MiningClaimFormat,transactionSlot:number):Promise<void>{
 const floor=Math.max(transactionSlot,format.lookupTable.slot),response=await reader.getMultipleAccountsInfoAndContext([new PublicKey(format.lookupTable.address)],{commitment:'finalized',minContextSlot:floor});
 need(response&&safe(response.context?.slot)&&response.context.slot>=floor&&Array.isArray(response.value)&&response.value.length===1);const row=response.value[0];
 need(row&&row.address instanceof PublicKey&&row.owner instanceof PublicKey&&row.address.toBase58()===format.lookupTable.address&&row.owner.toBase58()===format.lookupTable.owner&&row.executable===false&&row.data instanceof Uint8Array&&row.data.length===152&&sha(row.data)===format.expectedLookupTable.dataSha256);
}
