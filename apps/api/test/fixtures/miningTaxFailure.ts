/** Independent owner proofs over actual saved signed packets; no live readers. */
import {readFileSync} from 'node:fs';
import {createMiningTaxFailureVerifier,type MiningTaxFailureReceipt,type MiningTaxFailureRpc} from '@shardkeep/chain/mining-tax-failure';
import {createMiningTaxReceiptReader} from '@shardkeep/chain/mining-tax-receipt-reader';
import {withMiningTaxSettlementFixture,type MiningTaxSettlementFixture} from './miningTaxSettlement';
export const failureMigration=()=>readFileSync(new URL('../../drizzle/0189_mining_tax_claim_failures.sql',import.meta.url),'utf8');
type FailureFixture=MiningTaxSettlementFixture&{failure:(ordinal?:number)=>Promise<MiningTaxFailureReceipt>;success:(ordinal?:number)=>ReturnType<ReturnType<typeof createMiningTaxReceiptReader>>;failureOptions:{connect:(signal:AbortSignal)=>MiningTaxFailureRpc;trust:MiningTaxSettlementFixture['chain']['trust']['mining']}};
export async function withMiningTaxFailureFixture(run:(f:FailureFixture)=>Promise<void>,options:{mode?:'claim'|'combined'|'split';persistSigned?:boolean}={}){
 return withMiningTaxSettlementFixture(async f=>{
  for(const statement of failureMigration().split('--> statement-breakpoint').filter(x=>x.trim()))await f.conn.sql.unsafe(statement);
  // Solana account-info arrays are positional; derive addresses from the exact
  // request, as the existing tax reader adapter does for its raw account bank.
  const connect=(signal:AbortSignal):MiningTaxFailureRpc=>{const rpc=f.chain.connect(signal);return {
   getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),getTransaction:(signature,options)=>rpc.getTransaction(signature,options),
   getMultipleAccountsInfoAndContext:async(keys,options)=>{const r=await rpc.getMultipleAccountsInfoAndContext(keys,options);return {context:r.context,value:r.value.map((row,i)=>row?{address:keys[i]!,owner:row.owner,executable:row.executable,data:row.data}:null)};}};};
  const failureOptions={connect,trust:f.chain.trust.mining};
  async function failure(ordinal=0){
   const tx=f.chain.txs[ordinal]!,original=tx.meta!,fee=original.fee;
   tx.meta={...original,err:{InstructionError:[0,{Custom:9}]},postBalances:original.preBalances.map((n,i)=>n-(i===0?fee:0)),postTokenBalances:structuredClone(original.preTokenBalances!)};
   try{return await createMiningTaxFailureVerifier(connect,f.chain.trust.mining)({preparation:f.record.artifact,ordinal,signedTransaction:f.wire(ordinal)});}finally{tx.meta=original;}
  }
  const success=(ordinal=0)=>createMiningTaxReceiptReader(f.chain.connect,f.chain.trust)({...f.chain.request,signedTransactions:f.chain.request.signedTransactions.slice(0,ordinal+1)});
  await run({...f,failureOptions,failure,success});
 },options);
}
