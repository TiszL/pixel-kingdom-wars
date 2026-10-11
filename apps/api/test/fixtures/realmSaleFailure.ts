/** Real consent/wire stores with synthetic finalized-chain evidence only. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import type {VersionedTransactionResponse} from '@solana/web3.js';
import {createSeekerRealmSaleFailureVerifier,type SeekerRealmSaleFailureProof,type SeekerRealmSaleFailureRpc} from '@shardkeep/chain/seeker-realm-sale-failure';
import type {SeekerRealmAccessTrust} from '@shardkeep/chain/seeker-realm-access-snapshot';
import {createSeekerRealmSaleFinalityVerifier} from '@shardkeep/chain/seeker-realm-sale-finality';
import {createDb} from '../../src/db/client';
import type {RealmSaleSettlementReceipt} from '../../src/seeker/realmSaleSettlement';
import {ADMIN_DATABASE_URL} from '../db-url';
import {retainRealmSaleSettlementFixture} from './realmSaleSettlement';
export const realmFailureMigration=()=>readFileSync(new URL('../../drizzle/0194_seeker_realm_sale_failures.sql',import.meta.url),'utf8');
export async function withRealmSaleFailureFixture(run:(f:Awaited<ReturnType<typeof prepare>>&{conn:ReturnType<typeof createDb>;url:URL})=>Promise<void>){
 const database=`realm_failure_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${database}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${database}`);const conn=createDb(url.toString(),{max:4});
 try{
  for(const name of ['0182_seeker_realm_sale_preparations','0183_seeker_realm_sale_signed','0184_seeker_realm_sale_receipts','0194_seeker_realm_sale_failures'])for(const statement of readFileSync(new URL(`../../drizzle/${name}.sql`,import.meta.url),'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(statement);
  await run({...await prepare(conn),conn,url});
 }finally{await conn.sql.end();await admin.unsafe(`drop database ${database} with (force)`);await admin.end();}
}
type Prepared=Awaited<ReturnType<typeof retainRealmSaleSettlementFixture>>&{
 transaction:VersionedTransactionResponse&{meta:NonNullable<VersionedTransactionResponse['meta']>};rpc:SeekerRealmSaleFailureRpc;
 options:{connect:()=>SeekerRealmSaleFailureRpc;trust:SeekerRealmAccessTrust};failure:()=>Promise<SeekerRealmSaleFailureProof>;success:()=>Promise<RealmSaleSettlementReceipt>;
};
async function prepare(conn:ReturnType<typeof createDb>):Promise<Prepared>{
 const f=await retainRealmSaleSettlementFixture(conn.db),success=f.chain.transaction,meta=success.meta!;
 const transaction={...success,meta:{...meta,err:{InstructionError:[0,{Custom:9}]},postBalances:meta.preBalances.map((n,i)=>n-(i===0?meta.fee:0))}};
 const rpc={...f.chain.rpc,getTransaction:async()=>transaction};
 const {newAccountRentCaps:_,...request}=f.chain.request;
 return {...f,transaction,rpc,options:{connect:()=>rpc,trust:f.chain.trust},
  failure:()=>createSeekerRealmSaleFailureVerifier(()=>rpc,f.chain.trust)(request),
  success:async()=>{const p=await createSeekerRealmSaleFinalityVerifier(()=>f.chain.rpc,f.chain.trust)(f.chain.request),e=p.evidence;return {version:1,signature:e.signature,slot:e.slot,blockTime:e.blockTime,originalMessageSha256:e.originalMessageSha256,signedTransactionSha256:e.signedTransactionSha256,receiptAccountHex:p.receiptAccountHex,feeLamports:e.feeLamports,actualRentLamports:e.actualRentLamports,buyerNetPaymentLamports:e.buyerNetPaymentLamports,accountRentIncreases:e.accountRentIncreases.map(row=>({...row})),observedAccountSlot:p.observedAccountSlot,proofClockUnixTimestamp:p.proofClockUnixTimestamp.toString(),source:{...p.source,accounts:p.source.accounts.map(row=>{if(!row.exists)throw Error('fixture success account missing');return {...row};})}};}};
}
