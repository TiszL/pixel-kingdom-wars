import {Message,PublicKey,SystemProgram,Transaction,TransactionInstruction,TransactionMessage} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import {RealmSalePreparationSchema,type RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import type {GameWallet} from '../../auth/useGameWallet';
/** Independent application pins, never learned from the preparation response. */
export interface RealmSaleSigningTrust {readonly genesisHash:string;readonly programId:string;readonly developer:string;readonly reviewedProgramDataSha256:string;readonly reviewedDeploymentSlot:number;readonly revision:string}
export interface SignedRealmSale {readonly wire:string;readonly signature:string}
export interface PreparedRealmSaleSigning {readonly wallet:string}
export class RealmSaleSigningError extends Error{constructor(readonly code:'INPUT'|'TRUST'|'MESSAGE'|'WALLET'|'SIGNATURE'){super(`Realm sale signing refused: ${code}`);this.name='RealmSaleSigningError';}}
function need(v:unknown,code:RealmSaleSigningError['code']):asserts v{if(!v)throw new RealmSaleSigningError(code);}
const same=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const P=PHASE_E_POLICY.seekerIsland,S=PHASE_E_SEEKER_SALE,DAY=BigInt(PHASE_E_MINING_PUBLICATION.daySec),I64_MAX=(1n<<63n)-1n;
// Reviewed Anchor ABI bytes/sizes, not game tuning. Cross-tested against actual
// server SDK/IDL without putting its Node/Anchor graph in the browser bundle.
const OPEN_ACCESS=[13,64,189,200,181,103,12,45],OPEN_QUOTA=[59,247,177,192,45,28,122,123],BUY=[164,171,176,133,181,169,81,131];
const ACCESS_BYTES=83,QUOTA_BYTES=20,RECEIPT_BYTES=294,REGISTRY_VERSION=1;
const proofs=new WeakMap<PreparedRealmSaleSigning,{p:RealmSalePreparationView;message:Buffer}>();
function key(value:unknown):PublicKey{need(typeof value==='string'&&value.length>=32&&value.length<=44,'TRUST');try{const p=new PublicKey(value);need(p.toBase58()===value&&!p.equals(PublicKey.default),'TRUST');return p;}catch{throw new RealmSaleSigningError('TRUST');}}
function integer(value:string,signed=false):bigint{need(typeof value==='string'&&value.length<=20&&/^(0|[1-9][0-9]*)$/.test(value),'MESSAGE');const n=BigInt(value);need(n<=(signed?I64_MAX:(1n<<64n)-1n),'MESSAGE');return n;}
function le(n:bigint,size=8):Buffer{const b=Buffer.alloc(size);if(size===2)b.writeUInt16LE(Number(n));else b.writeBigUInt64LE(n);return b;}
function preparation(value:RealmSalePreparationView):RealmSalePreparationView{
 // Bound variable-length inputs before Zod's child parsing/refinements.
 need(value&&typeof value==='object'&&value.quote&&typeof value.quote==='object'&&Array.isArray(value.quote.rents)&&value.quote.rents.length>=1&&value.quote.rents.length<=3
  &&typeof value.quote.messageHex==='string'&&value.quote.messageHex.length<=2334,'INPUT');
 const parsed=RealmSalePreparationSchema.safeParse(value);need(parsed.success,'INPUT');return parsed.data;
}
function canonicalMessage(p:RealmSalePreparationView):Buffer{
 try{
  const program=key(p.source.programId),buyer=key(p.wallet),seller=key(p.terms.seller),developer=key(p.terms.developer);need(PublicKey.isOnCurve(buyer.toBytes()),'MESSAGE');
  const round=integer(p.terms.round),day=integer(p.terms.day),prior=integer(p.terms.priorExpiry,true),after=integer(p.terms.validAfter,true),until=integer(p.terms.validUntil,true),saleId=Buffer.from(p.saleId,'hex');
  need(saleId.length===16&&saleId.some(v=>v!==0)&&Number.isSafeInteger(p.spot)&&p.spot>=0&&p.spot<P.totalSpots&&Number.isSafeInteger(p.realm)&&p.realm>=0&&p.realm<P.realmCount,'MESSAGE');
  let realmMask=0;if(p.spot<P.kingSpots)realmMask=(1<<P.realmCount)-1;else for(let i=0;i<PHASE_E_SEEKER_AUCTION.regularRealmCount;i++)realmMask|=1<<((p.spot-P.kingSpots+i)%P.realmCount);
  const dayEnd=(day+1n)*DAY-1n,latest=until<dayEnd?until:dayEnd;need((realmMask&(1<<p.realm))!==0&&dayEnd<=I64_MAX&&until>=after&&until-after<=BigInt(S.quoteTtlSec)&&after<(day+1n)*DAY&&until>=day*DAY
   &&(prior>latest?prior:latest)+BigInt(P.permitDurationSec)<=I64_MAX,'MESSAGE');
  const pda=(seed:string,...tails:Buffer[])=>PublicKey.findProgramAddressSync([Buffer.from(seed),...tails],program)[0];
  const authority=pda('seeker_authority'),config=pda('realm_sale_config'),auctionConfig=pda('auction_config'),registry=pda('seeker_registry'),term=pda('seeker_term',auctionConfig.toBuffer(),le(round));
  const auction=pda('auction',auctionConfig.toBuffer(),Buffer.of(p.spot),le(round)),quota=pda('spot_sales',Buffer.of(p.spot),le(day)),access=pda('realm_access',buyer.toBuffer(),Buffer.of(p.realm)),receipt=pda('realm_sale',buyer.toBuffer(),saleId);
  const meta=(pubkey:PublicKey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner}),instructions:TransactionInstruction[]=[],rentAccounts:{address:string;space:number}[]=[];
  if(p.quote.needsAccess){instructions.push(new TransactionInstruction({programId:program,keys:[meta(buyer,true,true),meta(config),meta(access,true),meta(SystemProgram.programId)],data:Buffer.concat([Buffer.from(OPEN_ACCESS),buyer.toBuffer(),Buffer.of(p.realm)])}));rentAccounts.push({address:access.toBase58(),space:ACCESS_BYTES});}
  if(p.quote.needsQuota){instructions.push(new TransactionInstruction({programId:program,keys:[meta(buyer,true,true),meta(config),meta(quota,true),meta(SystemProgram.programId)],data:Buffer.concat([Buffer.from(OPEN_QUOTA),Buffer.of(p.spot),le(day)])}));rentAccounts.push({address:quota.toBase58(),space:QUOTA_BYTES});}
  instructions.push(new TransactionInstruction({programId:program,keys:[meta(buyer,true,true),meta(authority),meta(config),meta(auctionConfig),meta(registry),meta(term),meta(auction),meta(quota,true),meta(access,true),meta(receipt,true),meta(seller,true),meta(developer,true),meta(SystemProgram.programId)],
   data:Buffer.concat([Buffer.from(BUY),Buffer.of(S.version),saleId,Buffer.of(p.spot,p.realm),le(round),le(day),seller.toBuffer(),developer.toBuffer(),le(BigInt(REGISTRY_VERSION),2),le(BigInt(P.permitPriceLamports)),le(BigInt(P.permitDurationSec)),le(BigInt(P.contractSellerBps),2),le(BigInt(P.contractDevBps),2),le(prior),le(after),le(until)])}));
  rentAccounts.push({address:receipt.toBase58(),space:RECEIPT_BYTES});need(p.quote.rents.length===rentAccounts.length,'MESSAGE');
  let rent=0n;for(const [i,r]of p.quote.rents.entries()){const expected=rentAccounts[i]!,minimum=integer(r.minimumBalanceLamports),existing=integer(r.existingLamports),increase=integer(r.maxIncreaseLamports);need(r.address===expected.address&&r.space===expected.space&&increase===(minimum>existing?minimum-existing:0n),'MESSAGE');rent+=increase;}
  const price=BigInt(P.permitPriceLamports),bps=BigInt(PHASE_E_POLICY.basisPoints),debit=price-(buyer.equals(seller)?price*BigInt(P.contractSellerBps)/bps:0n)-(buyer.equals(developer)?price*BigInt(P.contractDevBps)/bps:0n),required=debit+rent+integer(p.quote.feeLamports);
  need(integer(p.quote.paymentDebitLamports)===debit&&integer(p.quote.rentLamports)===rent&&integer(p.quote.requiredLamports)===required&&integer(p.quote.payerLamports)>=required,'MESSAGE');
  const expected=Buffer.from(new TransactionMessage({payerKey:buyer,recentBlockhash:key(p.quote.blockhash).toBase58(),instructions}).compileToLegacyMessage().serialize()),message=Buffer.from(p.quote.messageHex,'hex');
  need(message.length<=1167&&same(message,expected)&&message[0]===1&&p.quote.packetBytes===message.length+65,'MESSAGE');
  const decoded=Message.from(message);need(decoded.header.numRequiredSignatures===1&&decoded.header.numReadonlySignedAccounts===0&&decoded.accountKeys[0]?.equals(buyer)&&same(decoded.serialize(),message),'MESSAGE');return message;
 }catch(error){if(error instanceof RealmSaleSigningError)throw error;throw new RealmSaleSigningError('MESSAGE');}
}
async function hashMatches(p:RealmSalePreparationView,message:Buffer):Promise<void>{try{const digest=await crypto.subtle.digest('SHA-256',new Uint8Array(message));need(Buffer.from(digest).toString('hex')===p.quote.messageSha256,'MESSAGE');}catch(error){if(error instanceof RealmSaleSigningError)throw error;throw new RealmSaleSigningError('MESSAGE');}}
/** Pure consent validation only. Caller owns live Clock/block-height admission. */
export async function prepareRealmSaleSigning(value:RealmSalePreparationView,trust:RealmSaleSigningTrust):Promise<PreparedRealmSaleSigning>{
 const p=preparation(value);need(trust&&typeof trust==='object','TRUST');
 for(const [name,expected]of [['genesisHash',p.source.genesisHash],['programId',p.source.programId],['developer',p.terms.developer]] as const)need(key(trust[name]).toBase58()===expected,'TRUST');
 need(trust.reviewedProgramDataSha256===p.source.programDataSha256&&trust.reviewedDeploymentSlot===p.source.reviewedDeploymentSlot&&trust.revision===p.source.revision,'TRUST');
 const message=canonicalMessage(p);await hashMatches(p,message);const prepared=Object.freeze({wallet:p.wallet});proofs.set(prepared,{p,message});return prepared;
}
/** Recovery proves exact original message/signature bytes, never fresh admission. */
export async function verifySignedRealmSale(value:RealmSalePreparationView,raw:unknown):Promise<SignedRealmSale>{
 const p=preparation(value),message=canonicalMessage(p);
 need(typeof raw==='string'&&raw.length>=88&&raw.length<=1644&&raw.length%4===0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw),'INPUT');
 const wire=Buffer.from(raw,'base64');need(wire.length<=1232&&wire.toString('base64')===raw,'INPUT');need(wire[0]===1&&wire.length===message.length+65&&same(wire.subarray(65),message),'MESSAGE');await hashMatches(p,message);
 try{const tx=Transaction.from(wire),buyer=key(p.wallet),signature=tx.signatures[0];need(tx.signatures.length===1&&tx.feePayer?.equals(buyer)&&signature?.publicKey.equals(buyer)&&signature.signature&&same(tx.serializeMessage(),message)&&tx.verifySignatures(true),'SIGNATURE');
  need(same(tx.serialize({requireAllSignatures:true,verifySignatures:false}),wire),'SIGNATURE');return Object.freeze({wire:raw,signature:bs58.encode(signature!.signature!)});
 }catch(error){if(error instanceof RealmSaleSigningError)throw error;throw new RealmSaleSigningError('SIGNATURE');}
}
/** Sign only; valid late signatures are evidence for the caller to retain first. */
export async function signRealmSale(prepared:PreparedRealmSaleSigning,wallet:GameWallet):Promise<SignedRealmSale>{
 const proof=proofs.get(prepared);need(proof,'INPUT');const sign=wallet.signTransaction;need(wallet.publicKey?.toBase58()===proof.p.wallet&&typeof sign==='function','WALLET');
 const tx=Transaction.populate(Message.from(proof.message),[bs58.encode(new Uint8Array(64))]);need(same(tx.serializeMessage(),proof.message),'MESSAGE');
 const signed=await sign.call(wallet,tx);
 // Refuse oversized/nonce/versioned mutations before any wallet-supplied object
 // can cause legacy serialization to decode arbitrary-length keys or blockhashes.
 need(signed instanceof Transaction&&Array.isArray(signed.instructions)&&signed.instructions.length>=1&&signed.instructions.length<=3&&Array.isArray(signed.signatures)&&signed.signatures.length===1
  &&signed.nonceInfo===undefined&&signed.recentBlockhash===proof.p.quote.blockhash
  &&(signed.signatures[0]?.signature===null||signed.signatures[0]?.signature instanceof Uint8Array&&signed.signatures[0].signature.length===64),'MESSAGE');
 const original=Transaction.populate(Message.from(proof.message));need(signed.instructions.length===original.instructions.length,'MESSAGE');
 for(const [i,ix]of signed.instructions.entries()){const expected=original.instructions[i]!;need(ix instanceof TransactionInstruction&&ix.programId instanceof PublicKey&&ix.programId.equals(expected.programId)&&ix.data instanceof Uint8Array&&ix.data.length<=153&&same(ix.data,expected.data)&&Array.isArray(ix.keys)&&ix.keys.length===expected.keys.length&&ix.keys.length<=13,'MESSAGE');
  for(const [j,k]of ix.keys.entries()){const e=expected.keys[j]!;need(k.pubkey instanceof PublicKey&&k.pubkey.equals(e.pubkey)&&k.isSigner===e.isSigner&&k.isWritable===e.isWritable,'MESSAGE');}}
 need(signed.feePayer instanceof PublicKey&&signed.feePayer.equals(original.feePayer!)&&signed.signatures[0]?.publicKey instanceof PublicKey&&signed.signatures[0].publicKey.equals(original.feePayer!)&&same(signed.serializeMessage(),proof.message),'MESSAGE');
 try{return await verifySignedRealmSale(proof.p,signed.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'));}catch(error){if(error instanceof RealmSaleSigningError)throw error;throw new RealmSaleSigningError('SIGNATURE');}
}
