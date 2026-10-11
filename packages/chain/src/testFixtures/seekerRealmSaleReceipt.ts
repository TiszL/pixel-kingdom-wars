/** R1 locally signed synthetic RPC facts; never network finality evidence. */
import anchorPkg,{type Idl} from '@coral-xyz/anchor';
import {Keypair,PublicKey,Message,VersionedTransaction,SystemProgram,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_POLICY,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';
import idl from '../idl/shardkeep_economy.json' with {type:'json'};
import {canonicalSeekerRegistry,hashSeekerRegistry,seekerAuctionConfigPda,seekerTermPda} from '../seekerAuctionProtocol';
import {createRealmSalePurchaseArgs,realmSaleConfigPda,realmAccessPda,realmSaleReceiptPda} from '../seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../seekerRealmSaleMessage';
const {BorshCoder,BN}=anchorPkg,coder=new BorshCoder(idl as Idl);
const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)),programId=new PublicKey(idl.address),u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const tag=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
export async function realmSaleReceiptFixture(options:{alias?:'seller'|'developer'|'both'|'recipients'|'new-access';needsAccess?:boolean;needsQuota?:boolean;prefunded?:boolean}={}){
 const buyer=Keypair.generate(),wallet=buyer.publicKey,at=10n*BigInt(PHASE_E_MINING_PUBLICATION.daySec),saleId=Buffer.alloc(16,7);
 const seller=options.alias==='seller'||options.alias==='both'?wallet:options.alias==='new-access'?realmAccessPda(programId,wallet,0):key(2);
 const developer=options.alias==='developer'||options.alias==='both'?wallet:options.alias==='recipients'?seller:key(3);
 const args=createRealmSalePurchaseArgs({saleId,spot:0,realm:0,round:1n,day:10n,seller,developer,priorExpiry:0n,validAfter:at,validUntil:at+60n});
 const input={wallet,args,blockhash:key(4).toBase58(),needsAccess:options.needsAccess??true,needsQuota:options.needsQuota??true},plan=buildRealmSaleMessage(programId,input);
 const message=Message.from(plan.messageBytes),signed=new VersionedTransaction(message);signed.sign([buyer]);const wire=signed.serialize(),signature=bs58.encode(signed.signatures[0]!);
 const keys=message.accountKeys.map(k=>k.toBase58()),pre=keys.map(()=>100000000),post=[...pre],fee=5000;
 const deltas=new Map<string,bigint>(),add=(address:string,n:bigint)=>deltas.set(address,(deltas.get(address)??0n)+n);
 const half=args.priceLamports*BigInt(args.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),dev=args.priceLamports-half;
 add(wallet.toBase58(),-args.priceLamports-BigInt(fee));add(seller.toBase58(),half);add(developer.toBase58(),dev);
 const inner:Array<{index:number;instructions:Array<{programIdIndex:number;accounts:number[];data:string;stackHeight:number}>}>=[];
 const rents=plan.expectedNewAccounts.map(a=>({address:new PublicKey(a.address),maxIncreaseLamports:2000000n}));
 for(const [index,a]of plan.expectedNewAccounts.entries()){
  const i=keys.indexOf(a.address),rent=1000000n;pre[i]=options.prefunded?500000:0;
  add(a.address,rent);add(wallet.toBase58(),-rent);
  const instructions:Array<{programIdIndex:number;accounts:number[];data:string;stackHeight:number}>=[];
  const push=(data:Buffer,accounts:string[])=>instructions.push({programIdIndex:keys.indexOf(SystemProgram.programId.toBase58()),accounts:accounts.map(x=>keys.indexOf(x)),data:bs58.encode(data),stackHeight:2});
  if(options.prefunded){push(Buffer.concat([tag(2),u64(rent)]),[wallet.toBase58(),a.address]);push(Buffer.concat([tag(8),u64(BigInt(a.space))]),[a.address]);push(Buffer.concat([tag(1),programId.toBuffer()]),[a.address]);}
  else push(Buffer.concat([tag(0),u64(rent),u64(BigInt(a.space)),programId.toBuffer()]),[wallet.toBase58(),a.address]);
  if(index===plan.expectedNewAccounts.length-1){if(!seller.equals(wallet))push(Buffer.concat([tag(2),u64(half)]),[wallet.toBase58(),seller.toBase58()]);if(!developer.equals(wallet))push(Buffer.concat([tag(2),u64(dev)]),[wallet.toBase58(),developer.toBase58()]);}
  inner.push({index,instructions});
 }
 for(const [i,k]of keys.entries())post[i]=Number(BigInt(pre[i]!)+(deltas.get(k)??0n));
 const receiptAddress=realmSaleReceiptPda(programId,wallet,saleId),bump=PublicKey.findProgramAddressSync([Buffer.from('realm_sale'),wallet.toBuffer(),saleId],programId)[1];
 const model={version:1,config:realmSaleConfigPda(programId),sale_id:[...saleId],buyer:wallet,seller,developer,term:seekerTermPda(programId,seekerAuctionConfigPda(programId),args.round),spot:0,realm:0,day:new BN(10),round:new BN(1),registry_version:1,
  registry_hash:[...hashSeekerRegistry(canonicalSeekerRegistry())],price_lamports:new BN(args.priceLamports.toString()),seller_lamports:new BN(half.toString()),developer_lamports:new BN(dev.toString()),prior_expiry:new BN(0),coverage_start:new BN(at.toString()),expires_at:new BN((at+args.durationSec).toString()),accepted_at:new BN(at.toString()),bump};
 const receipt={address:receiptAddress,owner:programId,executable:false,data:await coder.accounts.encode('RealmSaleReceipt',model)};
 const transaction={slot:101,blockTime:Number(at)-3,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee,preBalances:pre,postBalances:post,innerInstructions:inner,preTokenBalances:[],postTokenBalances:[],loadedAddresses:{writable:[],readonly:[]}}} as VersionedTransactionResponse;
 const expected={programId,...input,preparedMessageBytes:plan.messageBytes,signedTransaction:wire,reviewedDeploymentSlot:50,minContextSlot:100,observedAccountSlot:102,proofClockUnixTimestamp:at+1n,newAccountRentCaps:rents};
 return {buyer,transaction,receipt,expected,plan,signature,model,reencode:async(patch:Record<string,unknown>)=>({...receipt,data:await coder.accounts.encode('RealmSaleReceipt',{...model,...patch})})};
}
