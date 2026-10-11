/** Serialized synthetic finalized bank for the original real API preparation.
 * No receipt is hand-inserted: the owner verifier must accept exact account/tx facts. */
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {PublicKey,Message,SystemProgram,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import {createRealmSalePurchaseArgs,realmSaleReceiptPda} from '../seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../seekerRealmSaleMessage';
import type {realmSaleQuoteFixture} from '../seekerRealmSaleQuote.fixture';
import type {RealmSalePreparationView as RealmSalePreparation} from '@shardkeep/shared/realmSalesApi';
const {BorshCoder,BN}=anchorPkg,coder=new BorshCoder(idl as Idl);
const u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};const tag=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
export async function settleNativeRealmSaleBank(f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>,p:RealmSalePreparation,wire:Buffer){
 const program=f.accessTrust.programId,buyer=new PublicKey(p.wallet),seller=new PublicKey(p.terms.seller),developer=new PublicKey(p.terms.developer),saleId=Buffer.from(p.saleId,'hex');
 const args=createRealmSalePurchaseArgs({saleId,spot:p.spot,realm:p.realm,round:BigInt(p.terms.round),day:BigInt(p.terms.day),seller,developer,priorExpiry:BigInt(p.terms.priorExpiry),validAfter:BigInt(p.terms.validAfter),validUntil:BigInt(p.terms.validUntil)});
 const plan=buildRealmSaleMessage(program,{wallet:buyer,args,blockhash:p.quote.blockhash,needsAccess:p.quote.needsAccess,needsQuota:p.quote.needsQuota});
 if(!Buffer.from(plan.messageBytes).equals(Buffer.from(p.quote.messageHex,'hex'))||!wire.subarray(65).equals(Buffer.from(plan.messageBytes)))throw Error('Fixture must preserve original message');
 const message=Message.from(plan.messageBytes),keys=message.accountKeys.map(k=>k.toBase58()),signature=bs58.encode(wire.subarray(1,65));
 const pre=keys.map(()=>100_000_000),post=[...pre],fee=4000,at=BigInt(p.quote.unixTimestamp),half=args.priceLamports*BigInt(args.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),dev=args.priceLamports-half;
 const changes=new Map<string,bigint>();const add=(address:string,n:bigint)=>changes.set(address,(changes.get(address)??0n)+n);
 add(buyer.toBase58(),-args.priceLamports-BigInt(fee));add(seller.toBase58(),half);add(developer.toBase58(),dev);
 const inner:Array<{index:number;instructions:Array<{programIdIndex:number;accounts:number[];data:string;stackHeight:number}>}>=[];
 for(const [index,account]of plan.expectedNewAccounts.entries()){
  const rent=1_000_000n;pre[keys.indexOf(account.address)]=0;add(account.address,rent);add(buyer.toBase58(),-rent);
  const instructions:Array<{programIdIndex:number;accounts:number[];data:string;stackHeight:number}>=[];
  const push=(data:Buffer,addresses:string[])=>instructions.push({programIdIndex:keys.indexOf(SystemProgram.programId.toBase58()),accounts:addresses.map(a=>keys.indexOf(a)),data:bs58.encode(data),stackHeight:2});
  push(Buffer.concat([tag(0),u64(rent),u64(BigInt(account.space)),program.toBuffer()]),[buyer.toBase58(),account.address]);
  if(index===plan.expectedNewAccounts.length-1){if(!seller.equals(buyer))push(Buffer.concat([tag(2),u64(half)]),[buyer.toBase58(),seller.toBase58()]);if(!developer.equals(buyer))push(Buffer.concat([tag(2),u64(dev)]),[buyer.toBase58(),developer.toBase58()]);}
  inner.push({index,instructions});
 }
 for(const [i,key]of keys.entries())post[i]=Number(BigInt(pre[i]!)+(changes.get(key)??0n));
 const start=args.priorExpiry>at?args.priorExpiry:at,expiry=start+args.durationSec;
 const receipt=realmSaleReceiptPda(program,buyer,saleId),bump=PublicKey.findProgramAddressSync([Buffer.from('realm_sale'),buyer.toBuffer(),saleId],program)[1];
 const model={version:p.version,config:f.addresses.saleConfig,sale_id:[...saleId],buyer,seller,developer,term:f.addresses.term,spot:p.spot,realm:p.realm,
  day:new BN(args.day.toString()),round:new BN(args.round.toString()),registry_version:1,registry_hash:f.models.registry.hash,
  price_lamports:new BN(args.priceLamports.toString()),seller_lamports:new BN(half.toString()),developer_lamports:new BN(dev.toString()),prior_expiry:new BN(args.priorExpiry.toString()),
  coverage_start:new BN(start.toString()),expires_at:new BN(expiry.toString()),accepted_at:new BN(at.toString()),bump};
 const tx:VersionedTransactionResponse={slot:f.controls.slot+1,blockTime:Number(at)-3,version:'legacy',transaction:{message,signatures:[signature]},
  meta:{err:null,fee,preBalances:pre,postBalances:post,innerInstructions:inner,preTokenBalances:[],postTokenBalances:[],loadedAddresses:{writable:[],readonly:[]}}};
 f.models.access.expires_at=expiry;f.models.quota.sales++;f.controls.slot+=2;f.controls.now=at+1n;await f.repack();
 f.store.set(receipt.toBase58(),{owner:program,executable:false,lamports:1_000_000,rentEpoch:0,data:await coder.accounts.encode('RealmSaleReceipt',model)});f.bodies.set(signature,tx);
}
