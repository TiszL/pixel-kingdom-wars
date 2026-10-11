import {randomUUID} from 'node:crypto';
import {createDb} from '../../src/db/client';
import type {MiningClaimReceiptReader,MiningClaimReceiptTrust} from '@shardkeep/chain/mining-claim-receipt';
import type {MiningClaimSettlementFixture} from './miningClaimSettlement';

export function failedMiningClaimTransaction(f:MiningClaimSettlementFixture){
 const meta=f.tx.meta!;
 return {...f.tx,meta:{...meta,err:{InstructionError:[f.tx.transaction.message.compiledInstructions.length-1,{Custom:6000}]},
  postBalances:meta.preBalances.map((n,i)=>i===0?n-meta.fee:n),postTokenBalances:structuredClone(meta.preTokenBalances!)}};
}
export function miningClaimFailureSource(f:MiningClaimSettlementFixture):{reader:MiningClaimReceiptReader;trust:MiningClaimReceiptTrust}{return {reader:{...f.receiptReader,getTransaction:async()=>failedMiningClaimTransaction(f)},trust:f.trust};}
export async function withMiningClaimFailureRuntime(f:MiningClaimSettlementFixture,run:(conn:ReturnType<typeof createDb>,role:string)=>Promise<void>){
 const role=`claim_fail_http_${randomUUID().replaceAll('-','')}`,password=randomUUID(),url=new URL(f.url);
 await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};
  grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
  grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
 url.username=role;url.password=password;const conn=createDb(url.toString(),{max:3});
 try{await run(conn,role);}finally{await conn.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
}
