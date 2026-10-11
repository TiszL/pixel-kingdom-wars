/** Private owner capture of full original production. No term, tax or issuance
 * authority is inferred; the existing resolver must prove each saved parent. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {captureFullBaseMineAccrual} from '../game/baseMining';
import {assertFreshLockedBaseAuthority} from '../game/baseOwnership';
import {lockStablePrerequisiteBase} from '../game/stableBasePrerequisites';
import {HttpError} from '../lib/errors';
import {lockPhysicalMineTaxActors} from './shardsTaxMineSources';
const held=(reason:string):never=>{throw new HttpError(503,`Mine full capture held: ${reason}`,'SHARDS_MINE_CAPTURE_HELD');};
function enabled(){if(!phaseEMiningEnabled())throw new HttpError(503,'Mine capture is paused','PHASE_E_DISABLED');}
export async function captureFullPhysicalMineSources(db:Db,wallet:string,baseId:string,deps:{clock?:()=>Date}={}):Promise<void>{
 return capturePhysicalMineSources(db,wallet,baseId,deps,false);
}
export async function capturePhysicalMineSources(db:Db,wallet:string,baseId:string,deps:{clock?:()=>Date}={},includePartial=true):Promise<void>{
 if('rollback'in db)held('top-level owner connection required');z.uuid().parse(baseId);enabled();
 const clock=deps.clock??(()=>new Date());
 const [role]=await db.execute<{owner:boolean}>(sql`select current_user=pg_get_userbyid(relowner) as owner from pg_class where oid='public.shards_mine_eras'::regclass`);
 if(!role?.owner)held('table owner required');
 try{await db.transaction(async tx=>{
  await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
  await lockStablePrerequisiteBase(tx,wallet,{baseId,assertAuthority:async(tx,actor,id)=>{await assertFreshLockedBaseAuthority(tx,actor,id);}});
  const [policy]=await tx.execute(sql`select id from shards_mine_policy_boundary where id=1`);if(!policy)return;
  // Match admission's lock order and refuse completion/state contention rather
  // than waiting while holding a base needed by a completing builder job.
  await tx.execute(sql`select j.id from builder_jobs j join buildings b on b.id=j.building_id where b.base_id=${baseId} and b.type='mine' and j.kind='build' order by j.id for update of j nowait`);
  await tx.execute(sql`select id from buildings where base_id=${baseId} and type='mine' order by id for update nowait`);
  await tx.execute(sql`select s.mine_building_id from mine_accrual_states s join buildings b on b.id=s.mine_building_id where b.base_id=${baseId} and b.type='mine' order by s.mine_building_id for update of s nowait`);
  await lockPhysicalMineTaxActors(tx,[wallet]);
  await assertFreshLockedBaseAuthority(tx,wallet,baseId);enabled();
  const now=new Date(clock().getTime());if(!Number.isSafeInteger(+now))held('invalid server clock');
  await captureFullBaseMineAccrual(tx,baseId,now,includePartial);enabled();
 });}catch(error){let cause=error;for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&cause.code==='55P03')held('original provenance is busy; retry');cause='cause'in cause?cause.cause:undefined;
 }throw error;}
}
