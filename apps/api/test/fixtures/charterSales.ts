/** D176 actual funding/inventory/terminal and member-payment DB fixture. The
 * creation bank is serialized finalized evidence, not a caller verified flag. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {createClanCharterSalesStore,type SaleDomain} from '../../src/db/charterSales';
import {createClanCharterMemberSettlement} from '../../src/game/clanCharterMemberSettlement';
import {charterCreationTerminalFixture} from './charterCreationTerminal';
export async function charterSalesFixture(settings:Parameters<typeof charterCreationTerminalFixture>[0]={}){
 const f=await charterCreationTerminalFixture(settings);
 try{
  const buyer=await f.actor(),domain:SaleDomain={...f.domain,treasury:Keypair.generate().publicKey.toBase58()};
  const reader=async(asset:string)=>asset===buyer.deed?buyer.proof():null;
  const store=()=>createClanCharterSalesStore(f.db,{finalizedDeedReader:reader,deedCollection:buyer.collection});
  const initialize=()=>store().initializeEpoch(domain);
  async function birth(actor=f.source){
   const p=await f.prepared({actor,minted:true});
   const terminal=await p.service().recover(actor.wallet,p.consent.creationIntentId);
   return {...p,terminal};
  }
  async function draft(created:Awaited<ReturnType<typeof birth>>,options:{sellerLeaves?:boolean;buyer?:string}={}){
   const input={clanId:created.consent.clanId,buyer:options.buyer??buyer.wallet,priceLamports:'1000000000',
    sellerLeaves:options.sellerLeaves??true,idempotencyKey:randomUUID()};
   return {input,state:await store().create(created.actor.wallet,input,domain)};
  }
  const snapshot=async()=>JSON.stringify(await f.sql`select
   (select jsonb_agg(to_jsonb(c) order by id) from clans c) clans,
   (select jsonb_agg(to_jsonb(m) order by player_wallet) from clan_members m) members,
   (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
   (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
   (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries`);
  return {...f,buyer,domain,reader,store,initialize,birth,draft,salesSnapshot:snapshot,
   memberSettlement:()=>createClanCharterMemberSettlement(f.db)};
 }catch(error){await f.dispose();throw error;}
}
export type CharterSalesFixture=Awaited<ReturnType<typeof charterSalesFixture>>;
