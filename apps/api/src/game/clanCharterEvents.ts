/** D-153.146: prospective raid admission facts only. Captured absence is not
 * missing history; neither a capture nor a frontier authorizes a Charter sale. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {phaseECharterEnabled} from '../config';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const instant=z.iso.datetime({precision:6});
const sourceSchema=z.object({sourceId:uuid,startedAt:instant}).strict();
const ordinal=z.string().regex(/^[1-9][0-9]*$/).refine(value=>BigInt(value)<=9223372036854775807n);
const wallet=z.string().min(1).max(128);
const eventSchema=z.object({
 raidId:uuid,sourceId:uuid,actorWallet:wallet,attackerBaseId:uuid.nullable(),
 defenderWallet:wallet.nullable(),defenderBaseId:uuid.nullable(),pveCampId:uuid.nullable(),campaignStage:z.number().int().positive().nullable(),
 kind:z.enum(['deed_pvp','legacy_pvp','campaign','pve']),originalClanId:uuid.nullable(),originalLeaderWallet:wallet.nullable(),clanOrdinal:ordinal.nullable(),admittedAt:instant,
}).strict().superRefine((value,ctx)=>{
 const hasClan=value.originalClanId!==null;
 const targets=Number(value.defenderWallet!==null)+Number(value.pveCampId!==null)+Number(value.campaignStage!==null);
 const kind=value.campaignStage!==null?'campaign':value.pveCampId!==null?'pve':value.attackerBaseId!==null&&value.defenderBaseId!==null?'deed_pvp':'legacy_pvp';
 if(hasClan!==(value.originalLeaderWallet!==null)||hasClan!==(value.clanOrdinal!==null)||targets!==1||kind!==value.kind
  ||(value.defenderBaseId!==null&&value.defenderWallet===null))ctx.addIssue({code:'custom',message:'Inconsistent original admission facts'});
});
export type ClanCharterEventSource=z.infer<typeof sourceSchema>;
export type ClanCharterRaidEvent=z.infer<typeof eventSchema>;
export type ClanCharterRaidHistory={status:'untracked';event:null}|{status:'captured';event:ClanCharterRaidEvent};
const held=(code:string,status=503):never=>{throw new HttpError(status,'Clan reward history is temporarily unavailable',code);};
function translate(error:unknown):never{
 if(error instanceof HttpError)throw error;
 let cause=error;
 for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&cause.code==='55P03')held('CLAN_CHARTER_EVENT_BUSY');
  if('message'in cause&&cause.message==='CLAN_CHARTER_EVENT_PENDING_RAIDS')held('CLAN_CHARTER_EVENT_PENDING_RAIDS',409);
  cause='cause'in cause?cause.cause:undefined;
 }
 return held('CLAN_CHARTER_EVENT_HELD');
}
async function owner(db:DbOrTx){
 const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.clan_charter_event_source'::regclass) allowed`);
 if(!row?.allowed)held('CLAN_CHARTER_EVENT_OWNER');
}
async function source(db:DbOrTx):Promise<ClanCharterEventSource|null>{
 const [row]=await db.execute<{value:unknown}>(sql`select jsonb_build_object('sourceId',source_id,'startedAt',to_char(started_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) value from public.clan_charter_event_source where singleton`);
 if(!row)return null;const parsed=sourceSchema.safeParse(row.value);return parsed.success?parsed.data:held('CLAN_CHARTER_EVENT_HELD');
}
export function createClanCharterEvents(db:Db){
 if('rollback'in db)held('CLAN_CHARTER_EVENT_TOP_LEVEL');
 async function initialize():Promise<ClanCharterEventSource>{
  try{
   await owner(db);const existing=await source(db);if(existing)return existing;
   return await db.transaction(async tx=>{
    const replay=await source(tx);if(replay)return replay;
    if(!phaseECharterEnabled())held('CLAN_CHARTER_EVENT_DISABLED');
    // SQL owns the exact raid-table barrier and rejects unfinished predecessors.
    await tx.execute(sql`select public.shardkeep_clan_charter_event_source_initialize()`);
    if(!phaseECharterEnabled())held('CLAN_CHARTER_EVENT_DISABLED');
    return await source(tx)??held('CLAN_CHARTER_EVENT_HELD');
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function read(raidId:string):Promise<ClanCharterRaidHistory>{
  raidId=uuid.parse(raidId);
  try{
   await owner(db);
   return await db.transaction(async tx=>{
    const [row]=await tx.execute<{value:unknown;consistent:boolean}>(sql`
     select jsonb_build_object('raidId',e.raid_id,'sourceId',e.source_id,'actorWallet',e.attacker_wallet,'attackerBaseId',e.attacker_base_id,
      'defenderWallet',e.defender_wallet,'defenderBaseId',e.defender_base_id,'pveCampId',e.pve_camp_id,'campaignStage',e.campaign_stage,'kind',e.kind,
      'originalClanId',e.original_clan_id,'originalLeaderWallet',e.original_leader_wallet,'clanOrdinal',e.clan_ordinal::text,
      'admittedAt',to_char(e.admitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) value,
      (s.source_id is not null and r.id is not null and e.attacker_wallet is not distinct from r.attacker_wallet
       and e.attacker_base_id is not distinct from r.attacker_base_id and e.defender_wallet is not distinct from r.defender_wallet
       and e.defender_base_id is not distinct from r.defender_base_id and e.pve_camp_id is not distinct from r.pve_camp_id
       and e.campaign_stage is not distinct from r.campaign_stage and e.admitted_at is not distinct from r.created_at
       and (e.original_clan_id is null or (h.ordinal>=e.clan_ordinal
        and h.ordinal=(select count(*) from public.clan_charter_raid_events n where n.original_clan_id=e.original_clan_id)
        and h.ordinal=(select max(n.clan_ordinal) from public.clan_charter_raid_events n where n.original_clan_id=e.original_clan_id)))) consistent
     from public.clan_charter_raid_events e
     left join public.clan_charter_event_source s on s.source_id=e.source_id
     left join public.raids r on r.id=e.raid_id
     left join public.clan_charter_event_heads h on h.clan_id=e.original_clan_id
     where e.raid_id=${raidId}`);
    if(!row)return {status:'untracked',event:null};
    const parsed=eventSchema.safeParse(row.value);if(!row.consistent||!parsed.success)held('CLAN_CHARTER_EVENT_HELD');
    return {status:'captured',event:parsed.data!};
   },{isolationLevel:'repeatable read',accessMode:'read only'});
  }catch(error){return translate(error);}
 }
 return Object.freeze({initialize,read});
}
