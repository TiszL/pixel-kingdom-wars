/** Permanent Charter retirement consent. Policy clearance is an authenticated
 * backend assertion; these bytes grant no generic Core or database authority. */
import {PublicKey,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,TransactionInstruction} from '@solana/web3.js';
import {keccak_256} from '@noble/hashes/sha3';
import {charterClanIdBytes,charterConfigPda,charterPda,charterAssetPda,charterMintPda,charterFreezePda} from './charterProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from './seekerAuctionProtocol';
import {CORE_PROGRAM,transferDisc,type CharterTransferPermit} from './charterTransferProtocol';
export const CHARTER_RETIREMENT_RECEIPT_BYTES=250,CHARTER_RETIREMENT_PURPOSE=9;
export interface CharterRetirementTerms {readonly clanId:string;readonly retirementId:string;readonly fenceId:string;readonly expectedRevision:number;readonly clearanceHash:Uint8Array}
function need(v:unknown):asserts v {if(!v)throw new TypeError('Invalid exact Charter retirement contract');}
function key(v:PublicKey){need(v instanceof PublicKey&&!v.equals(PublicKey.default));return Buffer.from(v.toBytes());}
function bytes(v:Uint8Array,n:number){need(v instanceof Uint8Array&&v.length===n);return Buffer.from(v);}
function hash(v:Uint8Array){const b=bytes(v,32);need(b.some(Boolean));return b;}
function u32(v:number){need(Number.isInteger(v)&&v>=0&&v<=0xffffffff);const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;}
function i64(v:bigint){need(typeof v==='bigint'&&v>=0n&&v<(1n<<63n));const b=Buffer.alloc(8);b.writeBigInt64LE(v);return b;}
const pda=(p:PublicKey,seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed)],p)[0];
export const charterRetirementReceiptPda=(economy:PublicKey,clanId:string)=>PublicKey.findProgramAddressSync([Buffer.from('charter_retirement'),charterClanIdBytes(clanId)],economy)[0];
export function charterRetirementAccounts(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterRetirementTerms,permitId:Uint8Array){
 const asset=charterMintPda(craft,t.clanId);
 return {leader,authority:seekerAuthorityPda(economy),config:charterConfigPda(economy),charter:charterPda(economy,t.clanId),assetBinding:charterAssetPda(economy,asset),
  retirementReceipt:charterRetirementReceiptPda(economy,t.clanId),permitReceipt:seekerPermitReceiptPda(economy,bytes(permitId,16)),craftProgram:craft,craftControl:pda(craft,'charter_control'),asset,
  collection:pda(craft,'charter_collection'),collectionAuthority:pda(craft,'charter_collection_authority'),freezeAuthority:charterFreezePda(craft,t.clanId),mplCoreProgram:CORE_PROGRAM,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,systemProgram:SystemProgram.programId};
}
export function encodeCharterRetirementPayload(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterRetirementTerms){
 need(Number.isInteger(t.expectedRevision)&&t.expectedRevision>=0&&t.expectedRevision<0xffffffff);const a=charterRetirementAccounts(economy,craft,leader,t,new Uint8Array(16));
 return Buffer.concat([Buffer.from('SKCHRET1'),Buffer.from([1,0]),...[a.config,craft,a.craftControl,a.collection,a.collectionAuthority,a.charter,a.asset,a.assetBinding,a.freezeAuthority,a.retirementReceipt,leader].map(key),
  charterClanIdBytes(t.clanId),charterClanIdBytes(t.retirementId),charterClanIdBytes(t.fenceId),u32(t.expectedRevision),hash(t.clearanceHash)]);
}
export const hashCharterRetirementPayload=(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterRetirementTerms)=>Buffer.from(keccak_256(encodeCharterRetirementPayload(economy,craft,leader,t)));
export function encodeCharterRetirementPermit(genesis:PublicKey,economy:PublicKey,leader:PublicKey,p:Omit<CharterTransferPermit,'ed25519Instruction'>,payload:Uint8Array){
 return Buffer.concat([Buffer.from('SKPERMT2'),key(genesis),key(economy),Buffer.from([CHARTER_RETIREMENT_PURPOSE]),bytes(p.permitId,16),key(leader),i64(p.expiry),hash(payload)]);
}
export function buildCharterRetirementInstruction(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterRetirementTerms,p:CharterTransferPermit){
 encodeCharterRetirementPayload(economy,craft,leader,t);need(Number.isInteger(p.ed25519Instruction)&&p.ed25519Instruction>=0&&p.ed25519Instruction<=65535);
 const a=charterRetirementAccounts(economy,craft,leader,t,p.permitId),index=Buffer.alloc(2);index.writeUInt16LE(p.ed25519Instruction);
 const writable=new Set(['leader','charter','retirementReceipt','permitReceipt']),keys=Object.entries(a).map(([name,pubkey])=>({pubkey:new PublicKey(pubkey.toBytes()),isSigner:name==='leader',isWritable:writable.has(name)}));
 need(new Set(keys.map(k=>k.pubkey.toBase58())).size===keys.length);
 return new TransactionInstruction({programId:economy,keys,data:Buffer.concat([transferDisc('global:retire_charter'),charterClanIdBytes(t.clanId),charterClanIdBytes(t.retirementId),charterClanIdBytes(t.fenceId),u32(t.expectedRevision),hash(t.clearanceHash),bytes(p.permitId,16),i64(p.expiry),index])});
}
export function matchCharterRetirementReceipt(data:Uint8Array,economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterRetirementTerms,permitId:Uint8Array){
 encodeCharterRetirementPayload(economy,craft,leader,t);const b=bytes(data,CHARTER_RETIREMENT_RECEIPT_BYTES);need(b.subarray(0,8).equals(transferDisc('account:CharterRetirementReceipt'))&&b[8]===1);let at=9;
 const same=(wanted:Uint8Array)=>{need(b.subarray(at,at+wanted.length).equals(Buffer.from(wanted)));at+=wanted.length;};
 same(key(charterConfigPda(economy)));for(const id of [t.retirementId,t.fenceId,t.clanId])same(charterClanIdBytes(id));
 for(const k of [charterPda(economy,t.clanId),charterMintPda(craft,t.clanId),leader])same(key(k));
 same(u32(t.expectedRevision));same(u32(t.expectedRevision+1));same(hash(t.clearanceHash));same(bytes(permitId,16));const acceptedAt=b.readBigInt64LE(at);at+=8;
 need(acceptedAt>0n&&b[at]===PublicKey.findProgramAddressSync([Buffer.from('charter_retirement'),charterClanIdBytes(t.clanId)],economy)[1]&&at+1===b.length);
 return Object.freeze({retirementId:t.retirementId,fenceId:t.fenceId,clanId:t.clanId,charter:charterPda(economy,t.clanId).toBase58(),asset:charterMintPda(craft,t.clanId).toBase58(),leader:leader.toBase58(),priorRevision:t.expectedRevision,revision:t.expectedRevision+1,clearanceHash:Buffer.from(t.clearanceHash).toString('hex'),permitId:Buffer.from(permitId).toString('hex'),acceptedAt:acceptedAt.toString()});
}
