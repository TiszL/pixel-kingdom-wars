/** D153.175 local controlled transfer contract. Bytes are consent, never gameplay
 * clearance, a live permit issuer, signing authority or a database fence release. */
import {createHash} from 'node:crypto';
import {PublicKey,SystemProgram,SYSVAR_INSTRUCTIONS_PUBKEY,TransactionInstruction} from '@solana/web3.js';
import {keccak_256} from '@noble/hashes/sha3';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {charterClanIdBytes,charterConfigPda,charterPda,charterAssetPda,charterMintPda,charterExecutorPda,charterFreezePda} from './charterProtocol';
import {seekerAuthorityPda,seekerPermitReceiptPda} from './seekerAuctionProtocol';
export const CHARTER_TRANSFER_RECEIPT_BYTES=338,CHARTER_TRANSFER_CONFIG_BYTES=76;
export const CORE_PROGRAM=new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const transferDisc=(name:string)=>createHash('sha256').update(name).digest().subarray(0,8);
export function transferNeed(v:unknown):asserts v {if(!v)throw new TypeError('Invalid exact Charter transfer contract');}
const U64=(1n<<64n)-1n;
function key(v:PublicKey){transferNeed(v instanceof PublicKey&&!v.equals(PublicKey.default));return Buffer.from(v.toBytes());}
export function transferU64(v:bigint){transferNeed(typeof v==='bigint'&&v>=0n&&v<=U64);const b=Buffer.alloc(8);b.writeBigUInt64LE(v);return b;}
function u32(v:number){transferNeed(Number.isInteger(v)&&v>=0&&v<=0xffffffff);const b=Buffer.alloc(4);b.writeUInt32LE(v);return b;}
function bytes(v:Uint8Array,n:number){transferNeed(v instanceof Uint8Array&&v.length===n);return Buffer.from(v);}
function hash(v:Uint8Array){const b=bytes(v,32);transferNeed(b.some(Boolean));return b;}
function pda(p:PublicKey,seed:string,id?:Uint8Array){return PublicKey.findProgramAddressSync([Buffer.from(seed),...(id?[Buffer.from(id)]:[])],p)[0];}
export const charterTransferConfigPda=(economy:PublicKey)=>pda(economy,'charter_transfer_config');
export const charterTransferReceiptPda=(economy:PublicKey,id:string)=>pda(economy,'charter_transfer',charterClanIdBytes(id));
export interface CharterTransferTerms {
 readonly clanId:string;readonly transferId:string;readonly fenceId:string;readonly expectedRevision:number;
 readonly priceLamports:bigint;readonly termsHash:Uint8Array;
}
export interface CharterTransferDomain {readonly economy:PublicKey;readonly craft:PublicKey;readonly seller:PublicKey;readonly buyer:PublicKey;readonly treasury:PublicKey}
export interface CharterTransferPermit {readonly permitId:Uint8Array;readonly expiry:bigint;readonly ed25519Instruction:number}
export function charterTransferAccounts(d:CharterTransferDomain,t:CharterTransferTerms,permitId:Uint8Array){
 const asset=charterMintPda(d.craft,t.clanId);
 return {buyer:d.buyer,seller:d.seller,authority:seekerAuthorityPda(d.economy),config:charterConfigPda(d.economy),transferConfig:charterTransferConfigPda(d.economy),treasury:d.treasury,
  charter:charterPda(d.economy,t.clanId),assetBinding:charterAssetPda(d.economy,asset),transferReceipt:charterTransferReceiptPda(d.economy,t.transferId),
  receipt:seekerPermitReceiptPda(d.economy,bytes(permitId,16)),executor:charterExecutorPda(d.economy,t.clanId),craftProgram:d.craft,craftControl:pda(d.craft,'charter_control'),asset,
  collection:pda(d.craft,'charter_collection'),collectionAuthority:pda(d.craft,'charter_collection_authority'),freezeAuthority:charterFreezePda(d.craft,t.clanId),
  mplCoreProgram:CORE_PROGRAM,instructions:SYSVAR_INSTRUCTIONS_PUBKEY,systemProgram:SystemProgram.programId,economyProgram:d.economy};
}
export function encodeCharterTransferPayload(d:CharterTransferDomain,t:CharterTransferTerms){
 const a=charterTransferAccounts(d,t,new Uint8Array(16));
 transferNeed(t.priceLamports>0n&&!d.seller.equals(d.buyer)&&!d.treasury.equals(d.seller)&&!d.treasury.equals(d.buyer));
 const royalty=Buffer.alloc(2);royalty.writeUInt16LE(PHASE_E_CHARTER_TRANSFER.royaltyBps);
 return Buffer.concat([Buffer.from('SKCHXFR1'),Buffer.from([1,0]),...[a.config,a.transferConfig,d.craft,a.craftControl,a.collection,a.collectionAuthority,a.charter,a.asset,a.assetBinding,a.freezeAuthority,a.executor,a.transferReceipt,d.seller,d.buyer,d.treasury].map(key),
  charterClanIdBytes(t.clanId),charterClanIdBytes(t.transferId),charterClanIdBytes(t.fenceId),u32(t.expectedRevision),transferU64(t.priceLamports),royalty,hash(t.termsHash)]);
}
export const hashCharterTransferPayload=(d:CharterTransferDomain,t:CharterTransferTerms)=>Buffer.from(keccak_256(encodeCharterTransferPayload(d,t)));
export function encodeCharterPurposePermit(genesis:PublicKey,economy:PublicKey,kind:1|6,wallet:PublicKey,p:Omit<CharterTransferPermit,'ed25519Instruction'>,payload:Uint8Array){
 transferNeed(kind===1||kind===6);transferNeed(typeof p.expiry==='bigint'&&p.expiry>=0n&&p.expiry<(1n<<63n));
 return Buffer.concat([Buffer.from('SKPERMT2'),key(genesis),key(economy),Buffer.from([kind]),bytes(p.permitId,16),key(wallet),transferU64(p.expiry),hash(payload)]);
}
function permitArgs(p:CharterTransferPermit){transferNeed(Number.isInteger(p.ed25519Instruction)&&p.ed25519Instruction>=0&&p.ed25519Instruction<=65535);const index=Buffer.alloc(2);index.writeUInt16LE(p.ed25519Instruction);transferNeed(p.expiry>=0n&&p.expiry<(1n<<63n));return Buffer.concat([bytes(p.permitId,16),transferU64(p.expiry),index]);}
export function buildCharterTransferInstruction(d:CharterTransferDomain,t:CharterTransferTerms,p:CharterTransferPermit){
 encodeCharterTransferPayload(d,t);const a=charterTransferAccounts(d,t,p.permitId);
 const writable=new Set(['buyer','seller','treasury','charter','transferReceipt','receipt','asset','collection']);
 const keys=Object.entries(a).map(([name,pubkey])=>({pubkey:new PublicKey(pubkey.toBytes()),isSigner:name==='buyer'||name==='seller',isWritable:writable.has(name)}));
 transferNeed(new Set(keys.map(k=>k.pubkey.toBase58())).size===keys.length);
 return new TransactionInstruction({programId:d.economy,keys,data:Buffer.concat([transferDisc('global:settle_charter_transfer'),charterClanIdBytes(t.clanId),charterClanIdBytes(t.transferId),charterClanIdBytes(t.fenceId),u32(t.expectedRevision),transferU64(t.priceLamports),hash(t.termsHash),permitArgs(p)])});
}
export interface CharterLockTerms {readonly clanId:string;readonly lockId:string;readonly expectedRevision:number;readonly termsHash:Uint8Array;readonly action:'set'|'clear'}
export function hashCharterLockPayload(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterLockTerms){
 transferNeed(t.action==='set'||t.action==='clear');return Buffer.from(keccak_256(Buffer.concat([Buffer.from('SKCHLCK1'),Buffer.from([1,0]),...[charterConfigPda(economy),charterPda(economy,t.clanId),charterMintPda(craft,t.clanId),leader].map(key),charterClanIdBytes(t.clanId),charterClanIdBytes(t.lockId),u32(t.expectedRevision),Buffer.from([t.action==='set'?1:2]),hash(t.termsHash)])));
}
export function buildCharterLockInstruction(economy:PublicKey,craft:PublicKey,leader:PublicKey,t:CharterLockTerms,p:CharterTransferPermit){
 hashCharterLockPayload(economy,craft,leader,t);const a=[leader,seekerAuthorityPda(economy),charterConfigPda(economy),charterPda(economy,t.clanId),pda(craft,'charter_control'),seekerPermitReceiptPda(economy,p.permitId),SYSVAR_INSTRUCTIONS_PUBKEY,SystemProgram.programId];
 return new TransactionInstruction({programId:economy,keys:a.map((pubkey,i)=>({pubkey,isSigner:i===0,isWritable:[0,3,5].includes(i)})),data:Buffer.concat([transferDisc('global:'+t.action+'_charter_lock'),charterClanIdBytes(t.clanId),charterClanIdBytes(t.lockId),u32(t.expectedRevision),hash(t.termsHash),permitArgs(p)])});
}
export function matchCharterTransferReceipt(data:Uint8Array,d:CharterTransferDomain,t:CharterTransferTerms,permitId:Uint8Array){
 const b=bytes(data,CHARTER_TRANSFER_RECEIPT_BYTES);transferNeed(b.subarray(0,8).equals(transferDisc('account:CharterTransferReceipt'))&&b[8]===1);let at=9;
 const same=(wanted:Uint8Array)=>{transferNeed(b.subarray(at,at+wanted.length).equals(Buffer.from(wanted)));at+=wanted.length;};
 same(key(charterTransferConfigPda(d.economy)));for(const id of [t.transferId,t.fenceId,t.clanId])same(charterClanIdBytes(id));
 for(const p of [charterPda(d.economy,t.clanId),charterMintPda(d.craft,t.clanId),d.seller,d.buyer,d.treasury])same(key(p));
 const royalty=t.priceLamports*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/10000n,seller=t.priceLamports-royalty;
 for(const n of [t.priceLamports,seller,royalty])same(transferU64(n));same(u32(t.expectedRevision));same(u32(t.expectedRevision+1));same(hash(t.termsHash));same(bytes(permitId,16));
 const acceptedAt=b.readBigInt64LE(at);at+=8;transferNeed(acceptedAt>=0n);const bump=PublicKey.findProgramAddressSync([Buffer.from('charter_transfer'),charterClanIdBytes(t.transferId)],d.economy)[1];transferNeed(b[at]===bump);
 return Object.freeze({transferId:t.transferId,fenceId:t.fenceId,clanId:t.clanId,seller:d.seller.toBase58(),buyer:d.buyer.toBase58(),treasury:d.treasury.toBase58(),priceLamports:t.priceLamports.toString(),sellerLamports:seller.toString(),royaltyLamports:royalty.toString(),priorRevision:t.expectedRevision,revision:t.expectedRevision+1,termsHash:Buffer.from(t.termsHash).toString('hex'),acceptedAt:acceptedAt.toString()});
}
