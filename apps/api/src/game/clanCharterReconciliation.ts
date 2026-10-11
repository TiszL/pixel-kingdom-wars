/** D-153.147: committed original-clan chest evidence only. This read neither
 * settles members nor authorizes a Charter permit, payout, transfer or unlock. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {readClanCharterRaidChestInTransaction} from './clanCharterRaidChest';

export type ClanCharterReconciliation =
 | {status:'untracked'}
 | {status:'held';reason:string}
 | {status:'reconciled';raidId:string;originalClanId:string|null;terminalStatus:'resolved'|'expired';chestShards:string};
const hold=(reason:string):ClanCharterReconciliation=>({status:'held',reason});
const denied=(code:string):never=>{throw new HttpError(503,'Clan reward history is temporarily unavailable',code);};

export function createClanCharterReconciliation(db:Db){
 if('rollback'in db)denied('CLAN_CHARTER_RECONCILIATION_TOP_LEVEL');
 async function read(raidId:string):Promise<ClanCharterReconciliation>{
  raidId=z.uuid().parse(raidId).toLowerCase();
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.clan_charter_event_source'::regclass) allowed`);
  if(!owner?.allowed)denied('CLAN_CHARTER_RECONCILIATION_OWNER');
  return db.transaction<ClanCharterReconciliation>(async tx=>{
   // Snapshot JSON uses UTC in the exact capture functions as well.
   await tx.execute(sql`set local time zone 'UTC'`);
   // Rule-covered admissions use the same enduring proof as the new deletion
   // boundary. Earlier committed B6b observations keep their prior semantics.
   const [rule]=await tx.execute<{id:string|null}>(sql`select to_jsonb(e)->>'tithe_rule_id' id
    from public.clan_charter_raid_events e where raid_id=${raidId}`);
   if(rule?.id){
    const proof=await readClanCharterRaidChestInTransaction(tx,raidId);
    if(proof.status==='unenrolled')return hold('admission_mismatch');
    if(proof.status==='held')return proof;
    return {status:'reconciled',raidId:proof.raidId,originalClanId:proof.originalClanId,
     terminalStatus:proof.terminalStatus,chestShards:proof.chestShards};
   }
   const [event]=await tx.execute<{source_id:string;original_clan_id:string|null;kind:string;attacker_wallet:string;defender_wallet:string|null;consistent:boolean}>(sql`
    select e.source_id,e.original_clan_id,e.kind,e.attacker_wallet,e.defender_wallet,
     (s.source_id is not null and r.id is not null
      and e.attacker_wallet is not distinct from r.attacker_wallet and e.attacker_base_id is not distinct from r.attacker_base_id
      and e.defender_wallet is not distinct from r.defender_wallet and e.defender_base_id is not distinct from r.defender_base_id
      and e.pve_camp_id is not distinct from r.pve_camp_id and e.campaign_stage is not distinct from r.campaign_stage
      and e.admitted_at is not distinct from r.created_at
      and (case when e.defender_wallet is null then 0 else 1 end + case when e.pve_camp_id is null then 0 else 1 end
       + case when e.campaign_stage is null then 0 else 1 end)=1
      and (e.defender_base_id is null or e.defender_wallet is not null)
      and (e.defender_wallet is null or e.defender_wallet<>e.attacker_wallet)
      and (e.campaign_stage is null or e.campaign_stage>0)
      and ((e.original_clan_id is null and e.original_leader_wallet is null and e.clan_ordinal is null)
       or (e.original_clan_id is not null and e.original_leader_wallet is not null and e.clan_ordinal>0))
      and e.kind=case when r.campaign_stage is not null then 'campaign' when r.pve_camp_id is not null then 'pve'
       when r.attacker_base_id is not null and r.defender_base_id is not null then 'deed_pvp' else 'legacy_pvp' end
      and (e.original_clan_id is null or (h.ordinal>=e.clan_ordinal
       and h.ordinal=(select count(*) from public.clan_charter_raid_events n where n.original_clan_id=e.original_clan_id)
       and h.ordinal=(select max(n.clan_ordinal) from public.clan_charter_raid_events n where n.original_clan_id=e.original_clan_id)))) consistent
    from public.clan_charter_raid_events e left join public.clan_charter_event_source s on s.source_id=e.source_id
    left join public.raids r on r.id=e.raid_id left join public.clan_charter_event_heads h on h.clan_id=e.original_clan_id where e.raid_id=${raidId}`);
   if(!event)return {status:'untracked'};
   if(!event.consistent)return hold('admission_mismatch');
   const [terminal]=await tx.execute<{tx_key:string;terminal_status:'resolved'|'expired';loot:string|null;consistent:boolean}>(sql`
    select t.tx_key,t.terminal_status,t.after_raid->'result'->>'lootShards' loot,
     (t.source_id=${event.source_id} and t.after_raid=to_jsonb(r)
      and t.after_raid->>'status'=t.terminal_status
      and ((t.terminal_status='resolved' and t.before_raid->>'status'='resolving' and r.resolved_at is not null)
       or (t.terminal_status='expired' and t.before_raid->>'status'='pending_orders'))
      and t.before_raid->>'id'=t.raid_id::text
      and jsonb_build_array(t.before_raid->'attacker_wallet',t.before_raid->'attacker_base_id',t.before_raid->'defender_wallet',
       t.before_raid->'defender_base_id',t.before_raid->'pve_camp_id',t.before_raid->'campaign_stage',t.before_raid->'created_at')
       =jsonb_build_array(t.after_raid->'attacker_wallet',t.after_raid->'attacker_base_id',t.after_raid->'defender_wallet',
        t.after_raid->'defender_base_id',t.after_raid->'pve_camp_id',t.after_raid->'campaign_stage',t.after_raid->'created_at')) consistent
    from public.clan_charter_raid_terminals t left join public.raids r on r.id=t.raid_id where t.raid_id=${raidId}`);
   if(!terminal)return hold('terminal_missing');
   if(!terminal.consistent)return hold('terminal_mismatch');
   const posts=await tx.execute<{ledger_id:string;tx_key:string;consistent:boolean}>(sql`
    with ids as (select ledger_id id from public.clan_charter_loot_posts where raid_id=${raidId}
     union select id from public.ledger_transactions where idempotency_key=${'raid:'+raidId+':loot'} or metadata->>'raidId'=${raidId})
    select ids.id ledger_id,p.tx_key,(p.raid_id=${raidId} and p.source_id=${event.source_id}
     and p.tx_key=${terminal.tx_key} and p.original_transaction=to_jsonb(t)
     and t.type='raid.loot' and t.idempotency_key=${'raid:'+raidId+':loot'}
     and t.metadata->>'raidId'=${raidId} and t.metadata->>'attacker'=${event.attacker_wallet}
     and t.metadata->>'defender'=${event.defender_wallet}) consistent
    from ids left join public.clan_charter_loot_posts p on p.ledger_id=ids.id left join public.ledger_transactions t on t.id=ids.id`);
   const credits=await tx.execute<{ledger_id:string|null;actual_clan_id:string;delta:string;pairing:string;candidate_ledger_ids:string[];consistent:boolean}>(sql`
    select c.ledger_id,c.actual_clan_id,c.delta::text,c.pairing,c.candidate_ledger_ids,
     (c.source_id=${event.source_id} and c.tx_key=${terminal.tx_key}
      and c.before_clan->>'id'=c.actual_clan_id::text and c.after_clan->>'id'=c.actual_clan_id::text
      and (c.after_clan->>'chest_shards')::bigint-(c.before_clan->>'chest_shards')::bigint=c.delta
      and c.delta>0 and c.before_clan-'chest_shards'=c.after_clan-'chest_shards') consistent
    from public.clan_charter_chest_updates c where c.tx_key=${terminal.tx_key}
     or c.ledger_id in (select ledger_id from public.clan_charter_loot_posts where raid_id=${raidId})
     or c.candidate_ledger_ids && array(select ledger_id from public.clan_charter_loot_posts where raid_id=${raidId})`);
   const done=(chestShards:string):ClanCharterReconciliation=>({status:'reconciled',raidId,originalClanId:event.original_clan_id,terminalStatus:terminal.terminal_status,chestShards});
   if(posts.length===0){
    if(credits.length)return hold('credit_without_loot');
    if(terminal.terminal_status==='expired')return done('0');
    // These source kinds have separate reward/loot paths with no clan chest
    // accrual. This says nothing about their other rewards or obligations.
    if(event.kind!=='legacy_pvp')return done('0');
    if(terminal.loot==='0')return done('0');
    return hold('loot_proof_missing');
   }
   if(posts.length!==1||!posts[0]!.consistent)return hold('loot_mismatch');
   if(event.kind!=='legacy_pvp'||terminal.terminal_status!=='resolved')return hold('unexpected_loot');
   const post=posts[0]!;
   const entries=await tx.execute<{delta:string;kind:string;currency:string;owner_wallet:string|null;base_id:string|null;consistent:boolean}>(sql`
    with ids as (select entry_id id from public.clan_charter_loot_entries where ledger_id=${post.ledger_id}
     union select id from public.ledger_entries where txn_id=${post.ledger_id})
    select e.delta::text,a.kind,a.currency,a.owner_wallet,a.base_id,
     (w.ledger_id=${post.ledger_id} and w.tx_key=${post.tx_key} and w.original_entry=to_jsonb(e)
      and w.account_identity=to_jsonb(a)-'balance' and e.txn_id=${post.ledger_id}) consistent
    from ids left join public.clan_charter_loot_entries w on w.entry_id=ids.id
    left join public.ledger_entries e on e.id=ids.id left join public.accounts a on a.id=e.account_id`);
   if(entries.length<2||entries.length>3||entries.some(e=>!e.consistent||e.currency!=='SHARDS'||e.base_id!==null))return hold('entries_mismatch');
   const attacker=entries.filter(e=>e.kind==='player_shards'&&e.owner_wallet===event.attacker_wallet&&BigInt(e.delta)>0n);
   const defender=entries.filter(e=>e.kind==='player_shards'&&e.owner_wallet===event.defender_wallet&&BigInt(e.delta)<0n);
   const pool=entries.filter(e=>e.kind==='clan_chest'&&e.owner_wallet===null&&BigInt(e.delta)>0n);
   if(attacker.length!==1||defender.length!==1||pool.length>1||attacker.length+defender.length+pool.length!==entries.length
    ||entries.reduce((sum,e)=>sum+BigInt(e.delta),0n)!==0n||terminal.loot!==attacker[0]!.delta)return hold('loot_conservation');
   const cut=pool[0]?.delta??'0';
   const [metadata]=await tx.execute<{consistent:boolean}>(sql`select original_transaction->'metadata'=
    jsonb_build_object('raidId',${raidId}::text,'attacker',${event.attacker_wallet}::text,'defender',${event.defender_wallet}::text,'clanChest',${cut}::text) consistent
    from public.clan_charter_loot_posts where ledger_id=${post.ledger_id}`);
   if(!metadata?.consistent)return hold('loot_metadata');
   if(cut==='0'){
    if(credits.length)return hold('unexpected_credit');
    // No rule snapshot exists for these admissions: zero could be rounding or
    // leaving the original clan. Today's tithe cannot prove the historical cut.
    return event.original_clan_id===null?done('0'):hold('zero_tithe_ambiguous');
   }
   if(credits.length!==1)return hold('credit_missing_or_ambiguous');
   const credit=credits[0]!;
   if(!credit.consistent||credit.pairing!=='matched'||credit.ledger_id!==post.ledger_id||credit.delta!==cut
    ||credit.candidate_ledger_ids.length!==1||credit.candidate_ledger_ids[0]!==post.ledger_id)return hold('credit_mismatch');
   if(credit.actual_clan_id!==event.original_clan_id)return hold('original_clan_mismatch');
   return done(cut);
  },{isolationLevel:'repeatable read',accessMode:'read only'}).catch(error=>{
   if(error instanceof HttpError)throw error;
   // Broken storage, absent migration or database errors cannot certify zero.
   return hold('proof_unavailable');
  });
 }
 return Object.freeze({read});
}
