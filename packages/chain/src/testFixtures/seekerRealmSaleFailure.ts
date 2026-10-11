/** Locally signed synthetic finalized failures. No live proof or receipt writer. */
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import bs58 from 'bs58';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {realmSaleReceiptFixture} from './seekerRealmSaleReceipt';
import {createSeekerRealmAccessFixture} from './seekerRealmAccess';
import {realmSaleQuoteFixture} from '../seekerRealmSaleQuote.fixture';
import {createSeekerRealmSaleQuoteReader} from '../seekerRealmSaleQuote';
import type {SeekerRealmSaleFailureRequest,SeekerRealmSaleFailureRpc} from '../seekerRealmSaleFailure';

export async function realmSaleFailureFixture(options:Parameters<typeof realmSaleReceiptFixture>[0]={}){
 const sale=await realmSaleReceiptFixture(options),bank=await createSeekerRealmAccessFixture();
 bank.trust.developer=sale.expected.args.developer;
 const {programId:_,reviewedDeploymentSlot:__,observedAccountSlot:___,proofClockUnixTimestamp:____,newAccountRentCaps:_____,...request}=sale.expected;
 const transaction=sale.transaction,meta=transaction.meta!;
 meta.err={InstructionError:[(transaction.transaction.message as Message).instructions.length-1,{Custom:9}]};
 meta.postBalances=meta.preBalances.map((n,i)=>n-(i===0?meta.fee:0));
 const rpc:SeekerRealmSaleFailureRpc={...bank.rpc,getTransaction:async()=>transaction};
 return {...sale,bank,trust:bank.trust,request,rpc};
}

/** The selected spot really has one remaining quote slot. Another buyer then
 * consumes it before this exact locally signed packet executes and rolls back. */
export async function realmSaleQuotaLoserFixture(){
 const f=await realmSaleQuoteFixture();f.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax-1;await f.repack();
 const quote=await createSeekerRealmSaleQuoteReader(()=>f.rpc,{term:f.termPolicy,access:f.accessTrust,revision:'failure-final-slot'})({buyer:f.buyer,spot:0,realm:0},{saleId:Buffer.alloc(16,17)});
 const message=Message.from(quote.messageBytes),signed=new VersionedTransaction(message);signed.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);
 const wire=signed.serialize(),signature=bs58.encode(signed.signatures[0]!),preBalances=message.accountKeys.map(()=>100_000_000),fee=Number(quote.feeLamports)+1;
 const tx:VersionedTransactionResponse={slot:f.controls.slot+1,blockTime:Number(quote.unixTimestamp)-3,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:{InstructionError:[message.instructions.length-1,{Custom:9}]},fee,preBalances,postBalances:preBalances.map((n,i)=>n-(i===0?fee:0)),preTokenBalances:[],postTokenBalances:[]}};
 f.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax;f.controls.slot+=2;f.controls.now+=1n;await f.repack();f.bodies.set(signature,tx);
 const request:SeekerRealmSaleFailureRequest={wallet:f.buyer,args:quote.args,blockhash:quote.blockhash,needsAccess:!quote.accessExists,needsQuota:!quote.quotaExists,preparedMessageBytes:quote.messageBytes,signedTransaction:wire,minContextSlot:quote.source.admissionSlot};
 return {chain:f,quote,tx,request,trust:f.accessTrust,rpc:f.rpc,signature};
}
