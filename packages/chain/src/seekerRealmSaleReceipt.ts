/** Exact original signed-sale transaction evidence. This pure boundary validates
 * supplied facts, not their RPC finality. Application-owned finalized readers
 * must separately authenticate genesis, reviewed deployment and account bank. */
import {Message,PublicKey,SystemProgram,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildRealmSaleMessage} from './seekerRealmSaleMessage';
import {matchRealmSaleReceipt,type RealmSalePurchaseArgs,type RealmSaleRawAccount} from './seekerRealmSaleProtocol';
import {verifyMiningClaimSignedWire} from './miningClaimWire';

type Code='INPUT'|'UNAVAILABLE'|'FAILED'|'TRANSACTION'|'DEPLOYMENT'|'ACCOUNTS'|'PAYMENT';
export class RealmSaleReceiptError extends Error {
 constructor(readonly code:Code){super(`Realm sale receipt refused: ${code}`);this.name='RealmSaleReceiptError';}
}
const MAX_KEYS=32,MAX_INSTRUCTIONS=3,MAX_INNER=16,U64=(1n<<64n)-1n,I64=(1n<<63n)-1n;
function need(value:unknown,code:Code):asserts value{if(!value)throw new RealmSaleReceiptError(code);}
const safe=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function exact(value:object,fields:string){need(value&&typeof value==='object'&&!Array.isArray(value),'INPUT');const names=fields.split(' '),keys=Reflect.ownKeys(value);need(keys.length===names.length&&keys.every(k=>typeof k==='string'&&names.includes(k)),'INPUT');}
function key(value:PublicKey):PublicKey{need(value instanceof PublicKey,'INPUT');return new PublicKey(value.toBytes());}
function uint(value:bigint):bigint{need(typeof value==='bigint'&&value>=0n&&value<=U64,'INPUT');return value;}
function u64(n:bigint){const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;}
function tag(n:number){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;}
export interface RealmSaleTransactionExpectation {
 readonly programId:PublicKey;readonly wallet:PublicKey;readonly args:RealmSalePurchaseArgs;readonly blockhash:string;
 readonly needsAccess:boolean;readonly needsQuota:boolean;readonly preparedMessageBytes:Uint8Array;readonly signedTransaction:Uint8Array;
 /** Expectations supplied by application wiring. They do not grant finality. */
 readonly reviewedDeploymentSlot:number;readonly minContextSlot:number;readonly observedAccountSlot:number;readonly proofClockUnixTimestamp:bigint;
 /** Exactly the builder's new PDA list, with reviewed maximum funding increases.
  * Historical pre/post balances determine actual rent, never today's lamports. */
 readonly newAccountRentCaps:readonly Readonly<{address:PublicKey;maxIncreaseLamports:bigint}>[];
}
export function verifyRealmSaleTransactionEvidence(transaction:VersionedTransactionResponse|null,rawReceipt:RealmSaleRawAccount,
 expected:RealmSaleTransactionExpectation){
 try{
  exact(expected,'programId wallet args blockhash needsAccess needsQuota preparedMessageBytes signedTransaction reviewedDeploymentSlot minContextSlot observedAccountSlot proofClockUnixTimestamp newAccountRentCaps');
  const programId=key(expected.programId),wallet=key(expected.wallet),e=expected;
  need(e.preparedMessageBytes instanceof Uint8Array&&e.preparedMessageBytes.length>0&&e.preparedMessageBytes.length<=1167
   &&e.signedTransaction instanceof Uint8Array&&e.signedTransaction.length>65&&e.signedTransaction.length<=1232,'INPUT');
  need(safe(e.reviewedDeploymentSlot)&&safe(e.minContextSlot)&&safe(e.observedAccountSlot)&&e.minContextSlot>=e.reviewedDeploymentSlot
   &&typeof e.proofClockUnixTimestamp==='bigint'&&e.proofClockUnixTimestamp>=0n&&e.proofClockUnixTimestamp<=I64,'INPUT');
  const plan=buildRealmSaleMessage(programId,{wallet,args:e.args,blockhash:e.blockhash,needsAccess:e.needsAccess,needsQuota:e.needsQuota});
  need(Buffer.from(e.preparedMessageBytes).equals(Buffer.from(plan.messageBytes)),'INPUT');
  const signed=verifyMiningClaimSignedWire({intentBytes:plan.messageBytes,signedTransaction:e.signedTransaction,wallet});
  const original=Message.from(plan.messageBytes),keys=original.accountKeys.map(k=>k.toBase58()),buyer=wallet.toBase58();
  need(keys.length<=MAX_KEYS&&new Set(keys).size===keys.length,'INPUT');
  need(Array.isArray(e.newAccountRentCaps)&&e.newAccountRentCaps.length===plan.expectedNewAccounts.length,'INPUT');
  const caps=e.newAccountRentCaps.map((cap,i)=>{exact(cap,'address maxIncreaseLamports');need(key(cap.address).toBase58()===plan.expectedNewAccounts[i]!.address,'INPUT');return uint(cap.maxIncreaseLamports);});
  const tx=transaction;need(tx,'UNAVAILABLE');
  need(safe(tx.slot)&&tx.slot>e.reviewedDeploymentSlot,'DEPLOYMENT');
  need(tx.slot>=e.minContextSlot&&e.observedAccountSlot>=tx.slot,'ACCOUNTS');
  need(tx.version===undefined||tx.version==='legacy','TRANSACTION');
  const rpc=tx.transaction?.message;need(rpc&&rpc.version==='legacy','TRANSACTION');
  // Copy bounded raw fields into our own Message. Do not trust an injected
  // serialize/compiledInstructions method to describe a different RPC body.
  need(Array.isArray(rpc.accountKeys)&&rpc.accountKeys.length===keys.length&&Array.isArray(rpc.instructions)
   &&rpc.instructions.length>0&&rpc.instructions.length<=MAX_INSTRUCTIONS,'TRANSACTION');
  need(rpc.header&&safe(rpc.header.numRequiredSignatures)&&safe(rpc.header.numReadonlySignedAccounts)&&safe(rpc.header.numReadonlyUnsignedAccounts),'TRANSACTION');
  need(typeof rpc.recentBlockhash==='string'&&rpc.recentBlockhash.length>=32&&rpc.recentBlockhash.length<=44,'TRANSACTION');
  const at=(n:number)=>{need(safe(n)&&n<keys.length,'TRANSACTION');return keys[n]!;};
  const accountKeys=rpc.accountKeys.map((k,i)=>{need(k instanceof PublicKey&&k.toBase58()===keys[i],'TRANSACTION');return new PublicKey(k.toBytes());});
  const instructions=rpc.instructions.map(ix=>{
   need(ix&&typeof ix.data==='string'&&ix.data.length<=1683&&Array.isArray(ix.accounts)&&ix.accounts.length<=MAX_KEYS,'TRANSACTION');
   at(ix.programIdIndex);ix.accounts.forEach(at);const bytes=bs58.decode(ix.data);need(bytes.length<=1232&&bs58.encode(bytes)===ix.data,'TRANSACTION');
   return {programIdIndex:ix.programIdIndex,accounts:[...ix.accounts],data:ix.data};
  });
  const canonical=new Message({header:{...rpc.header},accountKeys,recentBlockhash:rpc.recentBlockhash,instructions});
  need(canonical.serialize().equals(Buffer.from(plan.messageBytes))&&Array.isArray(tx.transaction.signatures)
   &&tx.transaction.signatures.length===1&&tx.transaction.signatures[0]===signed.signature,'TRANSACTION');
  const meta=tx.meta;need(meta,'UNAVAILABLE');
  need(!meta.loadedAddresses||(Array.isArray(meta.loadedAddresses.readonly)&&Array.isArray(meta.loadedAddresses.writable)
   &&meta.loadedAddresses.readonly.length===0&&meta.loadedAddresses.writable.length===0),'TRANSACTION');
  need(meta.err!==undefined,'UNAVAILABLE');need(meta.err===null,'FAILED');
  need(safe(meta.fee)&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length
   &&meta.postBalances.length===keys.length&&meta.preBalances.every(safe)&&meta.postBalances.every(safe),'PAYMENT');
  // This reviewed instruction family never touches SPL token accounts.
  for(const balances of [meta.preTokenBalances,meta.postTokenBalances])need(balances===undefined||balances===null||Array.isArray(balances)&&balances.length===0,'PAYMENT');
  let receipt;try{receipt=matchRealmSaleReceipt(rawReceipt,{programId,buyer:wallet,args:e.args});}catch{throw new RealmSaleReceiptError('ACCOUNTS');}
  need(receipt.acceptedAt<=e.proofClockUnixTimestamp,'ACCOUNTS');
  const pre=meta.preBalances.map(BigInt),post=meta.postBalances.map(BigInt),fee=BigInt(meta.fee);
  const role=new Map<string,bigint>(),add=(address:string,n:bigint)=>role.set(address,(role.get(address)??0n)+n);
  add(buyer,-receipt.priceLamports);add(receipt.seller,receipt.sellerLamports);add(receipt.developer,receipt.developerLamports);
  const rents=plan.expectedNewAccounts.map((a,i)=>{
   const index=keys.indexOf(a.address);need(index>=0&&a.address!==buyer,'INPUT');
   const increase=post[index]!-pre[index]!-(role.get(a.address)??0n);
   need(increase>=0n&&increase<=caps[i]!,'PAYMENT');return {...a,increase,index};
  });
  const rent=rents.reduce((sum,r)=>sum+r.increase,0n);need(rent<=U64,'PAYMENT');
  for(const [i,address]of keys.entries()){
   const paid=(role.get(address)??0n)+(rents.find(r=>r.address===address)?.increase??0n)-(address===buyer?fee+rent:0n);
   need(post[i]! - pre[i]! === paid,'PAYMENT');
  }
  // Pin exact System CPI sequences too: creation/allocate+assign plus the two
  // fixed sale legs. No surplus transfer or hidden nested instruction is proof.
  need(meta.innerInstructions!==null&&meta.innerInstructions!==undefined,'UNAVAILABLE');
  need(Array.isArray(meta.innerInstructions)&&meta.innerInstructions.length===rents.length,'TRANSACTION');
  let count=0;
  for(const [i,r]of rents.entries()){
   const group=meta.innerInstructions[i];need(group&&group.index===i&&Array.isArray(group.instructions),'TRANSACTION');
   const wanted:{accounts:string[];data:Buffer}[]=[],push=(data:Buffer,accounts:string[])=>wanted.push({data,accounts});
   if(pre[r.index]===0n){need(r.increase>0n,'PAYMENT');push(Buffer.concat([tag(0),u64(r.increase),u64(BigInt(r.space)),programId.toBuffer()]),[buyer,r.address]);}
   else {if(r.increase>0n)push(Buffer.concat([tag(2),u64(r.increase)]),[buyer,r.address]);push(Buffer.concat([tag(8),u64(BigInt(r.space))]),[r.address]);push(Buffer.concat([tag(1),programId.toBuffer()]),[r.address]);}
   if(i===rents.length-1){
    if(receipt.seller!==buyer)push(Buffer.concat([tag(2),u64(receipt.sellerLamports)]),[buyer,receipt.seller]);
    if(receipt.developer!==buyer)push(Buffer.concat([tag(2),u64(receipt.developerLamports)]),[buyer,receipt.developer]);
   }
   count+=group.instructions.length;need(count<=MAX_INNER&&group.instructions.length===wanted.length,'TRANSACTION');
   for(const [j,ix]of group.instructions.entries()){
    need(typeof ix.data==='string'&&ix.data.length<=128&&Array.isArray(ix.accounts)&&ix.accounts.length<=2
     &&(ix as typeof ix&{stackHeight?:unknown}).stackHeight===2,'TRANSACTION');
    need(at(ix.programIdIndex)===SystemProgram.programId.toBase58(),'TRANSACTION');
    const bytes=bs58.decode(ix.data);need(bs58.encode(bytes)===ix.data&&Buffer.from(bytes).equals(wanted[j]!.data)
     &&ix.accounts.map(at).join(',')===wanted[j]!.accounts.join(','),'PAYMENT');
   }
  }
  const blockTime=tx.blockTime;need(blockTime===undefined||blockTime===null||typeof blockTime==='number'&&Number.isSafeInteger(blockTime),'TRANSACTION');
  return Object.freeze({version:1 as const,signature:signed.signature,slot:tx.slot,blockTime:blockTime??null,
   originalMessageSha256:signed.messageSha256,signedTransactionSha256:signed.wireSha256,receipt,
   feeLamports:fee.toString(),actualRentLamports:rent.toString(),buyerNetPaymentLamports:plan.buyerNetPaymentLamports.toString(),
   accountRentIncreases:Object.freeze(rents.map(r=>Object.freeze({address:r.address,lamports:r.increase.toString()}))),
   transactionEvidenceVerified:true as const,finalityVerified:false as const,paymentAuthorized:false as const});
 }catch(error){if(error instanceof RealmSaleReceiptError)throw error;throw new RealmSaleReceiptError('INPUT');}
}
export type RealmSaleTransactionEvidence=ReturnType<typeof verifyRealmSaleTransactionEvidence>;
