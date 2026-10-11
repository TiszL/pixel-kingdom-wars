/** Configured HTTP migration fixture. Only the legacy clan exists at return;
 * the real authenticated POST must create the migration before sync can serve
 * its explicitly synthetic finalized bank. No funded creation is reserved. */
import {randomUUID} from 'node:crypto';
import {AddressLookupTableProgram,Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import type {CharterCreationQuoteRpc} from '@shardkeep/chain/charter-creation-preparation';
import type {CharterTransferRpc} from '@shardkeep/chain/charter-transfer-evidence';
import bs58 from 'bs58';
import {expect,vi} from 'vitest';
import {createClanCharterMigrationsStore} from '../../src/db/charterMigrations';
import {createClanCharterSalesStore} from '../../src/db/charterSales';
import type {CharterMigrationDeliveryRpc} from '../../src/game/clanCharterMigrationWorkflow';
import {charterCreationWorkflowFixture} from './charterCreationWorkflow';
import {migrationBank} from './charterMigrationBank';

export async function charterMigrationHttpFixture(){
 const f=await charterCreationWorkflowFixture({genesisHash:SOLANA_GENESIS_HASH.devnet,staticLookupTable:true});
 try{
  const leader=Keypair.generate(),actor=leader.publicKey.toBase58(),clanId=randomUUID(),policy=Keypair.generate();
  // The configured fixture's static ALT pins its treasury at index 11. Reuse
  // that exact address in independent client trust instead of inventing another.
  const treasury=new PublicKey(f.lookupData.subarray(56+11*32,56+12*32)).toBase58();
  const domain={...f.domain,treasury},input={clanId,idempotencyKey:randomUUID()};
  const reader=async(asset:string)=>asset===f.source.deed?f.source.proof():null;
  const ownership={finalizedDeedReader:reader,deedCollection:f.source.collection};
  await createClanCharterSalesStore(f.db,ownership).initializeEpoch(domain);
  await f.sql`insert into players(wallet) values(${actor})`;
  await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clanId},${'Legacy '+clanId.slice(0,8)},${clanId.slice(0,4).toUpperCase()},${actor})`;
  await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clanId})`;
  const store=createClanCharterMigrationsStore(f.db),trust=f.chain.trust,lookup=f.chain.lookupTable;
  let bank:ReturnType<typeof migrationBank>|null=null,online=true;
  const current=()=>{if(!online||!bank)throw Error('Migration HTTP bank unavailable before genuine creation or while offline');return bank;};
  const blockhash=Keypair.generate().publicKey.toBase58(),sent:Buffer[]=[],submitted=new Set<string>();
  const rpc:CharterCreationQuoteRpc&CharterTransferRpc&CharterMigrationDeliveryRpc={
   getGenesisHash:vi.fn(async()=>current().rpc.getGenesisHash()),
   getSlot:vi.fn(async commitment=>current().rpc.getSlot(commitment)),
   getMultipleAccountsInfoAndContext:vi.fn(async(addresses,options)=>current().rpc.getMultipleAccountsInfoAndContext(addresses,options)),
   // Pin the domain's static 12-address ALT across server-generated migration
   // UUIDs and finality refreshes. Never return the private bank's larger ALT.
   getAccountInfoAndContext:vi.fn(async(address:PublicKey)=>{current();expect(address.toBase58()).toBe(lookup.address);return {context:{slot:150},value:{owner:AddressLookupTableProgram.programId,executable:false,data:Buffer.from(f.lookupData)}};}),
   getLatestBlockhashAndContext:vi.fn(async()=>{current();return {context:{slot:150},value:{blockhash,lastValidBlockHeight:300}};}),
   getFeeForMessage:vi.fn(async()=>{current();return {context:{slot:150},value:10000};}),
   getMinimumBalanceForRentExemption:vi.fn(async n=>{current();return 1000+n*5;}),
   getBlockHeight:vi.fn(async()=>{current();return 200;}),getTransaction:vi.fn(async()=>{current();return null;}),
   getSignatureStatuses:vi.fn(async(signatures:string[])=>{current();return {context:{slot:150},value:signatures.map(signature=>submitted.has(signature)?{slot:150,confirmations:null,err:null,confirmationStatus:'finalized' as const}:null)};}),
   sendRawTransaction:vi.fn(async bytes=>{current();const frozen=Buffer.from(bytes),signature=bs58.encode(VersionedTransaction.deserialize(frozen).signatures[0]!);sent.push(frozen);submitted.add(signature);return signature;}),
  };
  async function sync(id:string,minted=false){
   const state=await store.read(actor,id);expect(state.request).toEqual(input);
   const next=migrationBank(state,policy,minted);expect(next.trust).toEqual(trust);bank=next;return state;
  }
  const snapshot=async()=>JSON.stringify(await f.sql`select
   (select jsonb_agg(to_jsonb(c) order by id) from clans c) clans,
   (select jsonb_agg(to_jsonb(m) order by player_wallet) from clan_members m) members,
   (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
   (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
   (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries`);
  return {db:f.db,sql:f.sql,ownerUrl:f.ownerUrl,dispose:f.dispose,leader,actor,clanId,input,domain,trust,policy,lookup,ownership,reader,rpc,sent,store,sync,snapshot,
   setOnline:(value:boolean)=>{online=value;}};
 }catch(error){await f.dispose();throw error;}
}
