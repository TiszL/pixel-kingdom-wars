/** Browser-independent canonical SPL consent. Lazy client code; no chain/server
 * imports, API readiness shortcut, custodial key, or signing-and-sending wallet. */
import {Message,MessageV0,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {KeepEquipmentPurchaseSchema,KeepEquipmentWireSchema,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import type {CharterSignOnlyWallet} from '../charter/signing';
export const KEEP_TOKEN_PROGRAM=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const KEEP_ATA_PROGRAM=new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO=new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export interface KeepEquipmentSigningTrust {readonly version:1;readonly revision:string;readonly expectedGenesisHash:string;readonly expectedKeepMint:string;readonly maxFeeLamports:string;readonly maxAtaRentLamports:string}
export type KeepEquipmentWire=ReturnType<typeof KeepEquipmentWireSchema.parse>;
export function need(value:unknown,message='Equipment payment differs from its original.'):asserts value{if(!value)throw Error(message);}
export const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
export async function sha(bytes:Uint8Array){return Buffer.from(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))).toString('hex');}
const key=(value:string)=>{const address=new PublicKey(value);need(address.toBase58()===value);return address;};
export const keepAta=(mint:PublicKey,wallet:PublicKey)=>PublicKey.findProgramAddressSync([wallet.toBuffer(),KEEP_TOKEN_PROGRAM.toBuffer(),mint.toBuffer()],KEEP_ATA_PROGRAM)[0];
const u64=(1n<<64n)-1n;
export function keepEquipmentTrust(raw:KeepEquipmentSigningTrust){
 const value=structuredClone(raw);need(value&&value.version===1&&Object.keys(value).length===6&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value.revision));
 key(value.expectedGenesisHash);key(value.expectedKeepMint);
 for(const n of [value.maxFeeLamports,value.maxAtaRentLamports])need(typeof n==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(n)&&BigInt(n)<=u64);
 return Object.freeze(value);
}
export async function canonicalKeepEquipmentMessage(raw:KeepEquipmentPurchase){
 const value=KeepEquipmentPurchaseSchema.parse(raw),p=value.preparation;need(p,'Prepare this original purchase before reviewing payment.');
 const o=p.original,buyer=key(o.buyer),seller=key(o.seller),mint=key(o.keepMint),from=keepAta(mint,buyer),to=keepAta(mint,seller),total=BigInt(o.totalBaseUnits);
 need(PublicKey.isOnCurve(buyer.toBytes())&&PublicKey.isOnCurve(seller.toBytes())&&!buyer.equals(seller)&&total>=PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits&&total<=u64);
 need(new Set([buyer,seller,mint,from,to,KEEP_TOKEN_PROGRAM,KEEP_ATA_PROGRAM,SystemProgram.programId,MEMO].map(v=>v.toBase58())).size===9);
 need(o.sellerAtaExists?o.sellerAtaRentCapLamports===undefined:typeof o.sellerAtaRentCapLamports==='string'&&BigInt(o.sellerAtaRentCapLamports)>0n&&BigInt(o.sellerAtaRentCapLamports)<=BigInt(Number.MAX_SAFE_INTEGER));
 const sellerAmount=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),burnAmount=total-sellerAmount;
 need(sellerAmount>0n&&burnAmount>0n);
 const instructions:TransactionInstruction[]=[];
 if(!o.sellerAtaExists)instructions.push(new TransactionInstruction({programId:KEEP_ATA_PROGRAM,keys:[
  {pubkey:buyer,isSigner:true,isWritable:true},{pubkey:to,isSigner:false,isWritable:true},{pubkey:seller,isSigner:false,isWritable:false},
  {pubkey:mint,isSigner:false,isWritable:false},{pubkey:SystemProgram.programId,isSigner:false,isWritable:false},{pubkey:KEEP_TOKEN_PROGRAM,isSigner:false,isWritable:false},
 ],data:Buffer.of(1)}));
 const data=(opcode:number,amount:bigint)=>{const bytes=Buffer.alloc(10);bytes[0]=opcode;bytes.writeBigUInt64LE(amount,1);bytes[9]=TOKEN.decimals;return bytes;};
 instructions.push(new TransactionInstruction({programId:KEEP_TOKEN_PROGRAM,keys:[{pubkey:from,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:false},{pubkey:to,isSigner:false,isWritable:true},{pubkey:buyer,isSigner:true,isWritable:false}],data:data(12,sellerAmount)}),
  new TransactionInstruction({programId:KEEP_TOKEN_PROGRAM,keys:[{pubkey:from,isSigner:false,isWritable:true},{pubkey:mint,isSigner:false,isWritable:true},{pubkey:buyer,isSigner:true,isWritable:false}],data:data(15,burnAmount)}),
  new TransactionInstruction({programId:MEMO,keys:[],data:Buffer.from(`pkw:keep-market:${value.fill.id}`,'utf8')}));
 const builder=new TransactionMessage({payerKey:buyer,recentBlockhash:key(p.blockhash).toBase58(),instructions}),message=p.transactionVersion==='legacy'?builder.compileToLegacyMessage():builder.compileToV0Message();
 const bytes=Buffer.from(message.serialize()),unsigned=Buffer.from(new VersionedTransaction(message).serialize());
 need(unsigned.length<=1232&&message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&bytes.toString('hex')===p.messageHex&&await sha(bytes)===p.messageSha256);
 return {value,message:bytes,unsigned,buyerAta:from.toBase58(),sellerAta:to.toBase58(),sellerBaseUnits:sellerAmount.toString(),burnBaseUnits:burnAmount.toString()};
}
export interface PreparedKeepEquipmentSigning {readonly wallet:string;readonly fillId:string;readonly messageSha256:string;readonly unsignedTransaction:Uint8Array}
const approvals=new WeakMap<PreparedKeepEquipmentSigning,{purchase:KeepEquipmentPurchase;message:Uint8Array}>();
export async function prepareKeepEquipmentSigning(raw:KeepEquipmentPurchase,installed:KeepEquipmentSigningTrust,wallet:string):Promise<PreparedKeepEquipmentSigning>{
 const trust=keepEquipmentTrust(installed),v=KeepEquipmentPurchaseSchema.parse(raw),p=v.preparation;
 need(v.fill.buyerWallet===wallet&&p&&!v.wire&&!v.delivery&&!v.release,'This purchase is not awaiting a new signature.');
 need(p.expectedGenesisHash===trust.expectedGenesisHash&&p.expectedKeepMint===trust.expectedKeepMint&&BigInt(p.limits.maxFeeLamports)<=BigInt(trust.maxFeeLamports)
  &&BigInt(p.original.sellerAtaRentCapLamports??'0')<=BigInt(trust.maxAtaRentLamports),'Independent KEEP payment pins differ.');
 const {message,unsigned}=await canonicalKeepEquipmentMessage(v);
 const result=Object.freeze({wallet,fillId:v.fill.id,messageSha256:p.messageSha256,get unsignedTransaction(){return Uint8Array.from(unsigned);}});
 approvals.set(result,{purchase:v,message});return result;
}
export async function verifyKeepEquipmentWire(raw:KeepEquipmentPurchase,input:KeepEquipmentWire):Promise<KeepEquipmentWire>{
 const wire=KeepEquipmentWireSchema.parse(input);
 const {value,message}=await canonicalKeepEquipmentMessage(raw),bytes=Buffer.from(wire.signedTransactionHex,'hex');
 need(bytes.length===message.length+65&&bytes[0]===1&&equal(bytes.subarray(65),message));
 const tx=VersionedTransaction.deserialize(bytes);need((tx.message instanceof Message||tx.message instanceof MessageV0)&&equal(tx.serialize(),bytes));
 const publicKey=await crypto.subtle.importKey('raw',Uint8Array.from(key(value.fill.buyerWallet).toBytes()),{name:'Ed25519'},false,['verify']);
 need(await crypto.subtle.verify({name:'Ed25519'},publicKey,Uint8Array.from(bytes.subarray(1,65)),Uint8Array.from(message)),'Equipment payment signature is invalid.');
 need(bs58.encode(bytes.subarray(1,65))===wire.signature&&await sha(bytes)===wire.wireSha256&&await sha(message)===wire.messageSha256);return wire;
}
export async function signKeepEquipment(prepared:PreparedKeepEquipmentSigning,wallet:CharterSignOnlyWallet):Promise<KeepEquipmentWire>{
 const approved=approvals.get(prepared);need(approved&&wallet.publicKey?.toBase58()===prepared.wallet&&typeof wallet.signVersionedTransaction==='function','Original payment wallet changed.');
 const signed=await wallet.signVersionedTransaction(VersionedTransaction.deserialize(prepared.unsignedTransaction));
 need(signed instanceof VersionedTransaction&&(signed.message instanceof Message||signed.message instanceof MessageV0)&&signed.signatures.length===1&&signed.signatures[0] instanceof Uint8Array&&signed.signatures[0].length===64);
 need(signed.message.staticAccountKeys.length<=10&&signed.message.compiledInstructions.length<=4&&signed.message.compiledInstructions.every(i=>i.accountKeyIndexes.length<=6&&i.data.length<=80)&&equal(signed.message.serialize(),approved.message));
 const bytes=Buffer.from(signed.serialize());return verifyKeepEquipmentWire(approved.purchase,{signature:bs58.encode(signed.signatures[0]!),signedTransactionHex:bytes.toString('hex'),messageSha256:prepared.messageSha256,wireSha256:await sha(bytes)});
}
export async function verifyKeepEquipmentReceipt(raw:unknown){
 const value=KeepEquipmentPurchaseSchema.parse(raw);
 if(value.wire){const {recordedAt:_at,...wire}=value.wire;await verifyKeepEquipmentWire(value,wire);}
 if(value.delivery){const built=await canonicalKeepEquipmentMessage(value),proof=value.delivery.proof;need(value.wire&&proof.signature===value.wire.signature&&proof.messageSha256===value.wire.messageSha256&&proof.buyerAta===built.buyerAta&&proof.sellerAta===built.sellerAta&&proof.sellerBaseUnits===built.sellerBaseUnits&&proof.burnBaseUnits===built.burnBaseUnits&&proof.keepMint===value.preparation!.expectedKeepMint&&proof.expectedGenesisHash===value.preparation!.expectedGenesisHash);}
 return value;
}
