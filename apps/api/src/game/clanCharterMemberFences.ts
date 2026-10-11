/** D-153.148: freeze preparation facts and ordinary extraction/membership.
 * A raid-only frontier and historical eligibility are not payout readiness. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {phaseECharterEnabled} from '../config';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const wallet=z.string().min(1).max(128);
const natural=z.string().regex(/^(0|[1-9][0-9]*)$/).refine(value=>BigInt(value)<=9223372036854775807n);
const memberSchema=z.object({wallet,eligibilityAtFence:z.boolean(),baseId:uuid.nullable(),slot:z.number().int().nonnegative().nullable()}).strict()
 .refine(value=>value.eligibilityAtFence?(value.baseId!==null&&value.slot!==null):(value.baseId===null&&value.slot===null));
const fenceSchema=z.object({fenceId:uuid,clanId:uuid,actorWallet:wallet,idempotencyKey:z.string().min(1).max(128),sourceId:uuid,
 raidOrdinal:natural,chestShards:natural,createdAt:z.iso.datetime({precision:6}),status:z.literal('preparing'),members:z.array(memberSchema).min(1),
}).strict().refine(value=>new Set(value.members.map(m=>m.wallet)).size===value.members.length&&value.members.some(m=>m.wallet===value.actorWallet));
export type ClanCharterMemberFence=z.infer<typeof fenceSchema>;
const beginSchema=z.object({clanId:uuid,idempotencyKey:z.string().min(1).max(128)}).strict();
const fail=(code:string,status=503):never=>{throw new HttpError(status,'Clan settlement preparation is temporarily unavailable',code);};
function translate(error:unknown):never{
 if(error instanceof HttpError)throw error;
 let cause=error;
 for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&cause.code==='55P03')fail('CLAN_CHARTER_FENCE_BUSY');
  if('code'in cause&&cause.code==='23505')fail('CLAN_CHARTER_FENCE_CONFLICT',409);
  if('message'in cause&&cause.message==='CLAN_CHARTER_MEMBER_LEADER')fail('CLAN_CHARTER_FENCE_NOT_FOUND',404);
  cause='cause'in cause?cause.cause:undefined;
 }
 return fail('CLAN_CHARTER_FENCE_HELD');
}
async function owner(db:DbOrTx){
 const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.clan_charter_member_fences'::regclass) allowed`);
 if(!row?.allowed)fail('CLAN_CHARTER_FENCE_OWNER');
}
async function stored(db:DbOrTx,id:string):Promise<ClanCharterMemberFence>{
 const [row]=await db.execute<{value:unknown;consistent:boolean}>(sql`
  select jsonb_build_object('fenceId',f.id,'clanId',f.clan_id,'actorWallet',f.actor_wallet,'idempotencyKey',f.idempotency_key,
   'sourceId',f.source_id,'raidOrdinal',f.raid_ordinal::text,'chestShards',f.chest_shards::text,
   'createdAt',to_char(f.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'status','preparing',
   'members',coalesce((select jsonb_agg(jsonb_build_object('wallet',m.member_wallet,'eligibilityAtFence',m.eligible,'baseId',m.base_id,'slot',m.slot)
    order by m.member_wallet) from public.clan_charter_member_roster m where m.fence_id=f.id),'[]'::jsonb)) value,
   (case when public.shardkeep_charter_retirement_historical_fence(f.id) then true else public.shardkeep_charter_sale_historical_fence(f.id) end or (s.source_id is not null and c.id is not null and f.original_clan->>'id'=f.clan_id::text
    and f.original_clan->>'leader_wallet'=f.actor_wallet and (f.original_clan->>'chest_shards')::bigint=f.chest_shards
    and f.original_clan-'chest_shards'=to_jsonb(c)-'chest_shards'
    and case when exists(select 1 from public.clan_charter_member_payments payment where payment.fence_id=f.id)
     then c.chest_shards=0 and public.shardkeep_charter_member_payment_read(f.id,f.actor_wallet) is not null
     else c.chest_shards>=f.chest_shards end
    and f.raid_ordinal=coalesce(h.ordinal,0)
    and f.raid_ordinal=(select count(*) from public.clan_charter_raid_events e where e.original_clan_id=f.clan_id)
    and f.raid_ordinal=coalesce((select max(e.clan_ordinal) from public.clan_charter_raid_events e where e.original_clan_id=f.clan_id),0)
    and f.roster_count=(select count(*) from public.clan_charter_member_roster m where m.fence_id=f.id)
    and f.eligible_count=(select count(*) from public.clan_charter_member_roster m where m.fence_id=f.id and m.eligible)
    and f.roster_count=(select count(*) from public.clan_members m where m.clan_id=f.clan_id)
    and not exists(select 1 from public.clan_charter_member_roster m left join public.clan_members live on live.player_wallet=m.member_wallet
     where m.fence_id=f.id and (live.clan_id is distinct from f.clan_id or m.original_membership is distinct from to_jsonb(live)
      or m.original_membership->>'clan_id' is distinct from f.clan_id::text
      or m.original_membership->>'player_wallet' is distinct from m.member_wallet
      or (m.eligible and (m.base_id is null or m.slot is null or m.slot<0 or m.original_base is null or m.original_slot is null
       or m.original_base->>'id' is distinct from m.base_id::text or m.original_base->>'owner_wallet' is distinct from m.member_wallet
       or m.original_base->>'status' is distinct from 'active' or m.original_base->>'land_paid_at' is null
       or m.original_slot->>'base_id' is distinct from m.base_id::text or m.original_slot->>'wallet' is distinct from m.member_wallet
       or m.original_slot->>'active' is distinct from 'true' or m.original_slot->>'slot' is distinct from m.slot::text))
      or (not m.eligible and (m.base_id is not null or m.slot is not null or m.original_base is not null or m.original_slot is not null)))))) consistent
  from public.clan_charter_member_fences f left join public.clan_charter_event_source s on s.source_id=f.source_id
  left join public.clans c on c.id=f.clan_id left join public.clan_charter_event_heads h on h.clan_id=f.clan_id where f.id=${id}`);
 if(!row)return fail('CLAN_CHARTER_FENCE_NOT_FOUND',404);
 const parsed=fenceSchema.safeParse(row.value);
 if(!row.consistent||!parsed.success)fail('CLAN_CHARTER_FENCE_HELD');
 return parsed.data!;
}
export function createClanCharterMemberFences(db:Db){
 if('rollback'in db)fail('CLAN_CHARTER_FENCE_TOP_LEVEL');
 async function read(fenceId:string):Promise<ClanCharterMemberFence>{
  fenceId=uuid.parse(fenceId);
  try{
   await owner(db);
   return await db.transaction(async tx=>{await tx.execute(sql`set local time zone 'UTC'`);return stored(tx,fenceId);},
    {isolationLevel:'read committed',accessMode:'read only'});
  }catch(error){return translate(error);}
 }
 async function begin(actorWallet:string,input:z.input<typeof beginSchema>):Promise<ClanCharterMemberFence>{
  actorWallet=wallet.parse(actorWallet);const request=beginSchema.parse(input);
  try{
   await owner(db);
   return await db.transaction(async tx=>{
    await tx.execute(sql`set local time zone 'UTC'`);
    const [existing]=await tx.execute<{id:string;clan_id:string}>(sql`select id,clan_id from public.clan_charter_member_fences where actor_wallet=${actorWallet} and idempotency_key=${request.idempotencyKey}`);
    if(existing){if(existing.clan_id!==request.clanId)fail('CLAN_CHARTER_FENCE_CONFLICT',409);return stored(tx,existing.id);}
    if(!phaseECharterEnabled())fail('CLAN_CHARTER_FENCE_DISABLED');
    // The SQL command derives the snapshot while membership and eligibility
    // table barriers make even absent rows stable. No caller-supplied proof.
    const [created]=await tx.execute<{id:string}>(sql`insert into public.clan_charter_member_fences(clan_id,actor_wallet,idempotency_key)
     values(${request.clanId},${actorWallet},${request.idempotencyKey}) on conflict do nothing returning id`);
    if(!created){
     const [replay]=await tx.execute<{id:string;clan_id:string}>(sql`select id,clan_id from public.clan_charter_member_fences where actor_wallet=${actorWallet} and idempotency_key=${request.idempotencyKey}`);
     if(!replay||replay.clan_id!==request.clanId)return fail('CLAN_CHARTER_FENCE_CONFLICT',409);
     return stored(tx,replay.id);
    }
    if(!phaseECharterEnabled())fail('CLAN_CHARTER_FENCE_DISABLED');
    return stored(tx,created.id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 return Object.freeze({begin,read});
}
