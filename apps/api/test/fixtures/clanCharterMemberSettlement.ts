/** Real source/fence/ledger fixture. Synthetic gross loot uses the accepted
 * B6p adapter; the protected submitOrders integration remains K202. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {eq} from 'drizzle-orm';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {vi} from 'vitest';
import {bases,players} from '../../src/db/schema';
import {ensureStartingBase} from '../../src/game/base';
import {ensureWalletBaseIdentity,refreshBaseOwnership,type FinalizedDeedReader} from '../../src/game/baseOwnership';
import {createClanCharterMemberFences} from '../../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../../src/game/clanCharterMemberSettlement';
import {joinClan} from '../../src/game/clans';
import {getOrCreateBaseAccount,getOrCreatePlayerAccount} from '../../src/ledger';
import * as playerFixtures from '../helpers';
import {raidChestFixture} from './clanCharterRaidChest';
const key=()=>Keypair.generate().publicKey.toBase58();
export async function memberSettlementFixture(){
 vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const f=raidChestFixture();await f.setup();const collection=key();
 // Ownership evidence requires signable wallets; the older ledger helper's
 // arbitrary32-byte addresses can be off-curve. Keep its exact DB/account shape.
 vi.spyOn(playerFixtures,'createTestPlayer').mockImplementation(async db=>{
  const wallet=key();await db.insert(players).values({wallet});const account=await getOrCreatePlayerAccount(db,wallet,'player_keep');return {wallet,keepAccountId:account.id};
 });
 const proofs=new Map<string,{owner:string;collection:string;frozen:false;delegate:null;slot:number}>();
 const receivers:Array<{wallet:string;baseId:string;deed:string;accountId:string}>=[];
 const enabled=()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');};
 async function receiver(wallet:string){
  vi.stubEnv('MULTI_BASE_ENABLED','false');await ensureStartingBase(f.db,wallet);const baseId=(await ensureWalletBaseIdentity(f.db,wallet))!,deed=key(),paidAt=new Date();
  await f.db.update(bases).set({deedAssetId:deed,landPaidAt:paidAt}).where(eq(bases.id,baseId));
  await f.db.update(players).set({entryPaidAt:paidAt}).where(eq(players.wallet,wallet));
  const proof={owner:wallet,collection,frozen:false as const,delegate:null,slot:100};proofs.set(deed,proof);
  if(await refreshBaseOwnership(f.db,baseId,async()=>proof,collection)!=='owned')throw Error('Member fixture authority');
  const account=await getOrCreateBaseAccount(f.db,baseId,'base_shards'),result={wallet,baseId,deed,accountId:account.id};receivers.push(result);return result;
 }
 const refresh=async()=>{for(const r of receivers)if(await refreshBaseOwnership(f.db,r.baseId,async()=>proofs.get(r.deed)??null,collection)!=='owned')throw Error('Member fixture refresh');};
 const reader=vi.fn<FinalizedDeedReader>(async(asset:string)=>proofs.get(asset)??null);
 const service=()=>createClanCharterMemberSettlement(f.db,{finalizedDeedReader:reader,deedCollection:collection});
 async function source(options:{members?:number;grossBefore?:bigint;pending?:boolean;head?:boolean;settledBefore?:bigint;eligible?:boolean}={}){
  const leader=await f.attacker(),clan=await f.clan(leader.wallet),roster=[leader];
  for(let i=1;i<(options.members??3);i++){const m=await f.funded();await joinClan(f.db,m.wallet,clan.id);roster.push(m);}
  await f.initialize();let raid:Awaited<ReturnType<typeof f.admit>>|null=null;
  if(options.head!==false){
   if(options.settledBefore!==undefined){const first=await f.defender(),earlier=await f.admit(leader.wallet,first.wallet);await f.settle(earlier.id,options.settledBefore);}
   const defender=await f.defender();raid=await f.admit(leader.wallet,defender.wallet);if(!options.pending)await f.settle(raid.id,options.grossBefore??BigInt(PHASE_E_POLICY.basisPoints));
  }
  for(const m of roster){const r=await receiver(m.wallet);if(options.eligible===false)await f.sql`update bases set land_paid_at=null where id=${r.baseId}`;}
  enabled();await refresh();const fence=await createClanCharterMemberFences(f.db).begin(leader.wallet,{clanId:clan.id,idempotencyKey:randomUUID()});
  return {leader,clan,roster,raid,fence};
 }
 const snapshot=async()=>JSON.stringify(await f.sql`select
  (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
  (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
  (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
  (select jsonb_agg(to_jsonb(c) order by id) from clans c) clans,
  (select jsonb_agg(to_jsonb(m) order by player_wallet) from clan_members m) members`);
 const balance=async(id:string)=>BigInt((await f.sql`select balance::text from accounts where id=${id}`)[0]!.balance);
 return {...f,collection,proofs,receivers,enabled,receiver,refresh,reader,service,source,snapshot,balance};
}
export type MemberSettlementFixture=Awaited<ReturnType<typeof memberSettlementFixture>>;
