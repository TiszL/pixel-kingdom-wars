/** Actual SDK quote over encoded synthetic finalized facts and an owned test DB. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {Keypair} from '@solana/web3.js';
import {createMiningTaxSnapshotFixture} from '../../../../packages/chain/src/testFixtures/miningTaxSnapshot';
import {createMiningTaxQuoteReader,type MiningTaxQuoteRpc,type MiningTaxQuote} from '@shardkeep/chain/mining-tax-quote';
import type {MiningTaxSnapshotTrust} from '@shardkeep/chain/mining-tax-snapshot';
import type {MiningTaxClaimPrepareRequest} from '@shardkeep/shared/miningTaxClaimsApi';
import {createDb} from '../../src/db/client';
import {ADMIN_DATABASE_URL} from '../db-url';
export async function withMiningTaxPreparationFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){
 const f=await setup();try{await run(f);}finally{await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
interface Fixture{
 name:string;url:URL;admin:ReturnType<typeof postgres>;conn:ReturnType<typeof createDb>;
 chain:Awaited<ReturnType<typeof createMiningTaxSnapshotFixture>>;rpc:MiningTaxQuoteRpc;trust:MiningTaxSnapshotTrust;
 wallet:string;buyer:string;request:MiningTaxClaimPrepareRequest;readQuote:()=>Promise<MiningTaxQuote>;
}
async function setup():Promise<Fixture>{
 const name=`tax_preparation_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe test host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${name}`);const conn=createDb(url.toString(),{max:4});
 try{
  // Admission always checks owner failure history; a fixture must expose the
  // same complete durable schema even when it prepares its first unsigned key.
  for(const migration of ['0186_mining_tax_claim_preparations','0187_mining_tax_claim_signed','0188_mining_tax_claim_receipts','0189_mining_tax_claim_failures','0190_mining_tax_claim_continuations'])
   for(const statement of readFileSync(new URL(`../../drizzle/${migration}.sql`,import.meta.url),'utf8').split('--> statement-breakpoint').filter(x=>x.trim()))await conn.sql.unsafe(statement);
  const chain=await createMiningTaxSnapshotFixture();chain.models.cursor.claimed_total=0n;await chain.encode('cursor');
  const blockhash=Keypair.generate().publicKey.toBase58(),rpc:MiningTaxQuoteRpc={...chain.rpc,
   getLatestBlockhashAndContext:async()=>({context:{slot:2000},value:{blockhash,lastValidBlockHeight:200}}),
   getFeeForMessage:async()=>({context:{slot:2000},value:5000}),getMinimumBalanceForRentExemption:async()=>10_000,getBlockHeight:async()=>100};
  const request={idempotencyKey:randomUUID(),round:'0',spot:0,caps:{maxFeeLamports:'10000',maxRentLamports:'100000',maxTotalLamports:'110000'}};
  const readQuote=()=>createMiningTaxQuoteReader(()=>rpc,chain.trust)({...chain.request,caps:{maxFeeLamports:10_000n,maxRentLamports:100_000n,maxTotalLamports:110_000n}});
  return {name,url,admin,conn,chain,rpc,trust:chain.trust,wallet:chain.wallet.toBase58(),buyer:chain.other.toBase58(),request,readQuote};
 }catch(error){await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}
