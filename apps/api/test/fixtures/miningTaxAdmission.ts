/** Encoded original/pre-setup/post-setup banks, real signatures and owner-only
 * receipt persistence in an owned loopback DB. No fabricated finalized receipt. */
import {Keypair,SYSVAR_CLOCK_PUBKEY,type Message,type PublicKey} from '@solana/web3.js';
import {createMiningTaxQuoteReader,type MiningTaxQuoteRpc,type MiningTaxQuote} from '@shardkeep/chain/mining-tax-quote';
import type {MiningTaxSnapshotTrust} from '@shardkeep/chain/mining-tax-snapshot';
import {createMiningTaxClaimSettlement,type MiningTaxClaimSettlement} from '../../src/mining/taxClaimSettlement';
import {withMiningTaxSettlementFixture,type MiningTaxSettlementFixture} from './miningTaxSettlement';

type Mode='claim'|'combined'|'split';
export type MiningTaxAdmissionFixture=MiningTaxSettlementFixture&{
 control:{now:Date;slot:number;fee:number|null;rent:number;height:number;lastValidBlockHeight:number;blockhash:string;afterFee:(message:Message)=>Promise<void>};
 calls:{connect:number;genesis:number;messages:string[];rents:number[];signals:AbortSignal[]};
 sources:{connect:(signal:AbortSignal)=>MiningTaxQuoteRpc;trust:MiningTaxSnapshotTrust;now:()=>Date};
 quote:()=>Promise<MiningTaxQuote>;stage:(which:'prepared'|'setup'|'paid')=>Promise<void>;verifySetup:(fee?:number)=>Promise<MiningTaxClaimSettlement>;
};
async function setup(f:MiningTaxSettlementFixture,mode:Mode):Promise<MiningTaxAdmissionFixture>{
 const s=f.chain.state,original=f.record.snapshot,bank=new Map([...s.store].map(([key,row])=>[key,{...row,data:Buffer.from(row.data)}]));
 const control={now:new Date(f.record.artifact.preparedAt),slot:2006,fee:5 as number|null,rent:100,height:f.record.artifact.blockHeight+1,lastValidBlockHeight:999,
  blockhash:Keypair.generate().publicKey.toBase58(),afterFee:async(_message:Message)=>{}};
 const calls={connect:0,genesis:0,messages:[] as string[],rents:[] as number[],signals:[] as AbortSignal[]};
 function restore(){s.store.clear();for(const [key,row]of bank)s.store.set(key,{...row,data:Buffer.from(row.data)});}
 async function stage(which:'prepared'|'setup'|'paid'){
  restore();if(which==='paid')return;
  const pool=s.store.get(s.addresses.pool.toBase58())!,cursor=s.store.get(s.addresses.cursor.toBase58())!;
  // Fixed actual MiningTaxPool/Spot ABI counters; their original identities,
  // bumps and hashes remain the encoded canonical fixture bytes.
  pool.data.writeBigUInt64LE(which==='setup'?BigInt(f.record.artifact.intended.cumulativeBaseUnits)*BigInt(original.term.winnerCount)+BigInt(f.record.artifact.intended.dustBaseUnits):original.pool?.accrued??0n,108);
  pool.data.writeBigUInt64LE(original.pool?.paid??0n,116);cursor.data.writeBigUInt64LE(original.cursor?.claimedTotal??0n,107);
  s.backing.model.tax_paid=original.backing.config.taxPaid;await s.config();
  s.store.get(s.backing.rows[1]!.address.toBase58())!.data.writeBigUInt64LE(original.backing.vaultAmount,64);
  s.store.get(s.addresses.ata.toBase58())!.data.writeBigUInt64LE(original.claimantAta.balanceBaseUnits??0n,64);
  if(which==='prepared')for(const tx of f.record.artifact.transactions)for(const account of tx.newAccounts)s.store.delete(account.address);
  s.store.get(f.wallet)!.lamports=Number(original.payer.lamports!)-(which==='setup'?1005:0);
  const clock=s.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data;clock.writeBigUInt64LE(BigInt(control.slot),0);clock.writeBigInt64LE(original.chainClock.unixTimestamp+10n,32);
 }
 const originalByAddress=new Map(original.term.auctions.map(a=>[a.terms.auction,a]));
 const rpc:MiningTaxQuoteRpc={...f.chain.rpc,
  getGenesisHash:async()=>{calls.genesis++;return f.chain.trust.mining.expectedGenesisHash;},getSlot:async()=>control.slot,
  getMultipleAccountsInfoAndContext:async(keys)=>({context:{slot:control.slot},value:keys.map(key=>{const r=s.store.get(key.toBase58());if(!r)return null;const data=Buffer.from(r.data);if(key.equals(SYSVAR_CLOCK_PUBKEY))data.writeBigUInt64LE(BigInt(control.slot),0);return {...r,data};})}),
  getSignaturesForAddress:async(address)=>{const a=originalByAddress.get(address.toBase58());return a?[{signature:a.settlement.signature,slot:Number(a.settledSlot),err:null,memo:null,confirmationStatus:'finalized'}]:[];},
  getLatestBlockhashAndContext:async()=>({context:{slot:control.slot},value:{blockhash:control.blockhash,lastValidBlockHeight:control.lastValidBlockHeight}}),
  getFeeForMessage:async message=>{calls.messages.push(Buffer.from(message.serialize()).toString('hex'));await control.afterFee(message as Message);return {context:{slot:control.slot},value:control.fee};},
  getMinimumBalanceForRentExemption:async space=>{calls.rents.push(space);return control.rent;},getBlockHeight:async()=>control.height,
 };
 const sources={connect:(signal:AbortSignal)=>{calls.connect++;calls.signals.push(signal);return rpc;},trust:f.chain.trust,now:()=>new Date(control.now)};
 const quote=()=>createMiningTaxQuoteReader(sources.connect,sources.trust)({wallet:f.chain.signer.publicKey,round:BigInt(f.record.artifact.round),spot:f.record.artifact.spot,caps:f.chain.request.caps});
 async function verifySetup(fee=5){
  if(mode!=='split')throw Error('Setup fixture requires split');restore();const tx=f.chain.txs[0]!,old=tx.meta!.fee;tx.meta!.fee=fee;tx.meta!.postBalances[0]!-=fee-old;
  const receipt=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);await stage('setup');
  s.store.get(f.wallet)!.lamports=Number(original.payer.lamports!-BigInt(receipt.receipt.feeLamports)-BigInt(receipt.receipt.rentLamports));return receipt;
 }
 await stage('prepared');return {...f,control,calls,rpc,sources,quote,stage,verifySetup};
}
export async function withMiningTaxAdmissionFixture(run:(f:MiningTaxAdmissionFixture)=>Promise<void>,options:{mode?:Mode;persistSigned?:boolean;genesisHash?:PublicKey}={}){
 return withMiningTaxSettlementFixture(async f=>run(await setup(f,options.mode??'claim')),options);
}
