/** One unsigned atomic sale packet. Trusted admission chooses account existence,
 * seller, term, day and prior coverage; this pure builder grants none of them. */
import {createHash} from 'node:crypto';
import {Message,PACKET_DATA_SIZE,PublicKey,TransactionMessage,VersionedTransaction,type TransactionInstruction} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {buildBuyRealmAccessInstruction,buildOpenRealmAccessInstruction,buildOpenSpotSalesQuotaInstruction,
 realmAccessPda,spotSalesQuotaPda,realmSaleReceiptPda,REALM_SALE_ACCOUNT_BYTES,validateRealmSalePurchaseArgs,type RealmSalePurchaseArgs} from './seekerRealmSaleProtocol';

export class RealmSaleMessageError extends Error {
 constructor(readonly code:'INPUT'|'PACKET'){super(`Realm sale message refused: ${code}`);this.name='RealmSaleMessageError';}
}
export interface RealmSaleMessageInput {
 readonly wallet:PublicKey;readonly args:RealmSalePurchaseArgs;readonly blockhash:string;
 readonly needsAccess:boolean;readonly needsQuota:boolean;
}
export interface RealmSaleUnsignedMessage {
 readonly mode:'atomic';readonly wallet:string;readonly messageBytes:Uint8Array;readonly messageSha256:string;readonly packetBytes:number;
 /** Operational rent planning only; fee and rent must come from trusted RPC. */
 readonly expectedNewAccounts:readonly Readonly<{address:string;space:number}>[];
 readonly grossPriceLamports:bigint;readonly buyerNetPaymentLamports:bigint;
 readonly signingAuthorized:false;readonly broadcastAuthorized:false;
}
function need(v:unknown,code:RealmSaleMessageError['code']='INPUT'):asserts v{if(!v)throw new RealmSaleMessageError(code);}
/** No split or caller-injected instruction path: setup and payment succeed or
 * roll back together. An account-creation race needs original-outcome recovery. */
export function buildRealmSaleMessage(programId:PublicKey,input:RealmSaleMessageInput):RealmSaleUnsignedMessage {
 try {
  need(input&&typeof input==='object'&&!Array.isArray(input));
  const fields=['wallet','args','blockhash','needsAccess','needsQuota'];need(Object.keys(input).length===fields.length&&Object.keys(input).every(k=>fields.includes(k)));
  need(input.wallet instanceof PublicKey&&PublicKey.isOnCurve(input.wallet.toBytes()));
  const wallet=new PublicKey(input.wallet.toBytes()),args=validateRealmSalePurchaseArgs(input.args);
  need(typeof input.needsAccess==='boolean'&&typeof input.needsQuota==='boolean');
  need(typeof input.blockhash==='string'&&input.blockhash.length>=32&&input.blockhash.length<=44&&new PublicKey(input.blockhash).toBase58()===input.blockhash);
  const instructions:TransactionInstruction[]=[],accounts:{address:string;space:number}[]=[];
  if(input.needsAccess){
   instructions.push(buildOpenRealmAccessInstruction(programId,{payer:wallet,wallet,realm:args.realm}));
   accounts.push({address:realmAccessPda(programId,wallet,args.realm).toBase58(),space:REALM_SALE_ACCOUNT_BYTES.RealmAccess});
  }
  if(input.needsQuota){
   instructions.push(buildOpenSpotSalesQuotaInstruction(programId,{payer:wallet,spot:args.spot,day:args.day}));
   accounts.push({address:spotSalesQuotaPda(programId,args.spot,args.day).toBase58(),space:REALM_SALE_ACCOUNT_BYTES.SpotSalesQuota});
  }
  instructions.push(buildBuyRealmAccessInstruction(programId,{buyer:wallet,args}));
  accounts.push({address:realmSaleReceiptPda(programId,wallet,args.saleId).toBase58(),space:REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt});
  let bytes:Uint8Array,packetBytes:number;
  try {
   const message=new TransactionMessage({payerKey:wallet,recentBlockhash:input.blockhash,instructions}).compileToLegacyMessage();
   need(message.header.numRequiredSignatures===1&&message.header.numReadonlySignedAccounts===0&&message.accountKeys[0]!.equals(wallet));
   bytes=Uint8Array.from(message.serialize());need(Buffer.from(Message.from(bytes).serialize()).equals(Buffer.from(bytes)),'PACKET');
   packetBytes=new VersionedTransaction(message).serialize().length;need(packetBytes<=PACKET_DATA_SIZE,'PACKET');
  }catch(e){if(e instanceof RealmSaleMessageError)throw e;throw new RealmSaleMessageError('PACKET');}
  const price=args.priceLamports,basis=BigInt(PHASE_E_POLICY.basisPoints);
  const buyerNetPaymentLamports=price-(args.seller.equals(wallet)?price*BigInt(args.sellerBps)/basis:0n)-(args.developer.equals(wallet)?price*BigInt(args.developerBps)/basis:0n);
  need(buyerNetPaymentLamports>=0n);
  return Object.freeze({mode:'atomic' as const,wallet:wallet.toBase58(),get messageBytes(){return Uint8Array.from(bytes);},
   messageSha256:createHash('sha256').update(bytes).digest('hex'),packetBytes,expectedNewAccounts:Object.freeze(accounts.map(a=>Object.freeze(a))),
   grossPriceLamports:price,buyerNetPaymentLamports,signingAuthorized:false as const,broadcastAuthorized:false as const});
 }catch(e){if(e instanceof RealmSaleMessageError)throw e;throw new RealmSaleMessageError('INPUT');}
}
