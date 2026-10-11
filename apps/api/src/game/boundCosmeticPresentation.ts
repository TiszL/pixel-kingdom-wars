/** Public appearance projections stay in the request transaction. The private
 * preference writer never grants an appearance or consumes materials. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {BoundCosmeticBaseReadSchema,type BoundCosmeticBaseRead} from '@shardkeep/shared/boundCosmeticVisual';
import type {Db,DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {lockStablePrerequisiteBase,type StableBaseMutationContext} from './stableBasePrerequisites';

const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Revision=z.string().regex(/^(0|[1-9][0-9]*)$/).max(19)
 .refine(value=>BigInt(value)<9223372036854775807n,'Preference revision exceeds signed storage');
const PreferenceCommand=z.object({baseId:Uuid,enabled:z.boolean(),expectedRevision:Revision}).strict();
const unavailable=():BoundCosmeticBaseRead=>({state:'unavailable',visual:null});

export async function readBoundCosmeticBase(db:DbOrTx,baseId:string,expectedWallet:string):Promise<BoundCosmeticBaseRead>{
 Uuid.parse(baseId);Wallet.parse(expectedWallet);
 const [capability]=await db.execute<{ready:boolean}>(sql`select to_regprocedure('public.shardkeep_bound_cosmetic_base_visual(uuid,text)') is not null ready`);
 if(!capability?.ready)return unavailable();
 const [row]=await db.execute<{visual:unknown}>(sql`select public.shardkeep_bound_cosmetic_base_visual(${baseId}::uuid,${expectedWallet}) visual`);
 const parsed=BoundCosmeticBaseReadSchema.safeParse(row?.visual);
 return parsed.success?parsed.data:unavailable();
}

/** Null storage means an original without capture. Never consult current art to
 * repair it; unavailable is retained separately from historical absence. */
export async function readBoundCosmeticRaid(db:DbOrTx,raidId:string):Promise<BoundCosmeticBaseRead|undefined>{
 Uuid.parse(raidId);
 const [capability]=await db.execute<{ready:boolean}>(sql`select to_regprocedure('public.shardkeep_bound_cosmetic_raid_visual(uuid)') is not null ready`);
 if(!capability?.ready)return unavailable();
 const [row]=await db.execute<{visual:unknown}>(sql`select public.shardkeep_bound_cosmetic_raid_visual(${raidId}::uuid) visual`);
 if(row?.visual===null)return undefined;
 const parsed=BoundCosmeticBaseReadSchema.safeParse(row?.visual);
 return parsed.success?parsed.data:unavailable();
}

/** Optimistic revision prevents a delayed toggle from reversing a newer choice.
 * An identical retry at exactly the next revision is already applied. SQL also
 * enforces current ownership, completed entitlement and the revision transition.
 * Public mounting waits for the actual appearance delivery acceptance. */
export async function setBoundCosmeticAwning(db:Db,wallet:string,raw:unknown,authority:StableBaseMutationContext){
 if('rollback'in db)throw Error('Appearance preferences require a top-level database');
 Wallet.parse(wallet);const request=PreferenceCommand.parse(raw);
 if(authority.baseId!==request.baseId)throw new HttpError(409,'Appearance kingdom differs','BASE_ID_MISMATCH');
 const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user=session_user and not exists(
  select 1 from pg_class where oid in('public.bound_cosmetic_preferences'::regclass,'public.bound_cosmetic_jobs'::regclass,
  'public.bound_cosmetic_completions'::regclass) and relowner<>current_user::regrole::oid) allowed`);
 if(!owner?.allowed)throw new HttpError(503,'Appearance preferences are unavailable','BOUND_COSMETIC_OWNER');
 return db.transaction(async tx=>{
  const [actor]=await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
  if(!actor)throw new HttpError(404,'Player not found');
  await lockStablePrerequisiteBase(tx,wallet,authority);
  const [previous]=await tx.execute<{awning_enabled:boolean;revision:string}>(sql`select awning_enabled,revision::text revision
   from public.bound_cosmetic_preferences where wallet=${wallet} and base_id=${request.baseId}::uuid for update`);
  const expected=BigInt(request.expectedRevision),revision=BigInt(previous?.revision??'0');
  const replay=previous?.awning_enabled===request.enabled&&revision===expected+1n;
  if(!replay){
   if(revision!==expected)throw new HttpError(409,'Your appearance choice changed. Refresh and try again.','BOUND_COSMETIC_PREFERENCE_CHANGED');
   if(previous)await tx.execute(sql`update public.bound_cosmetic_preferences set awning_enabled=${request.enabled},revision=revision+1,updated_at=clock_timestamp()
    where wallet=${wallet} and base_id=${request.baseId}::uuid`);
   else await tx.execute(sql`insert into public.bound_cosmetic_preferences(wallet,base_id,awning_enabled,revision,updated_at)
    values(${wallet},${request.baseId}::uuid,${request.enabled},1,clock_timestamp())`);
  }
  await authority.assertAuthority(tx,wallet,request.baseId);
  return {baseId:request.baseId,enabled:request.enabled,revision:(replay?revision:revision+1n).toString(),
   visual:await readBoundCosmeticBase(tx,request.baseId,wallet)};
 });
}

/** Optional transport sibling; absent originals stay absent in JSON archives. */
export async function boundCosmeticRaidFields(db:DbOrTx,raidId:string):Promise<{boundCosmeticVisual?:BoundCosmeticBaseRead}>{
 const visual=await readBoundCosmeticRaid(db,raidId);
 return visual===undefined?{}:{boundCosmeticVisual:visual};
}
