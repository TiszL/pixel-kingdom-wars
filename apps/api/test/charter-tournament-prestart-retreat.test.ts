/** D181 admits only the existing normal V2 zero-simulation retreat. The saved
 * clock/command witness survives later reconnect-row edits, without granting a
 * generic pending-to-resolved or a new loot path. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {LIVE_RAID,RAID_RULES} from '@shardkeep/shared';
import {baseArmy} from '../src/db/schema';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {createRaid,createCampaignRaid} from '../src/game/raids';
import {acceptLiveRaidCommandReceipt,retreatLiveRaid} from '../src/game/liveRaids';
import {charterSalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
let f:Awaited<ReturnType<typeof charterSalesWorkflowFixture>>|undefined;
// 2026-10-10: 0286 refuses a raid capture cutoff later than Postgres clock_timestamp(), which no test can fake, so the
// raid clock is 01:00Z three real days ago rather than 2035-01-07T01:00Z.
const at=new Date(Math.floor((Date.now()-3*86_400_000)/86_400_000)*86_400_000+3_600_000);
const zero={stars:0,destructionPct:0,keepDestroyed:false,lootShards:0,attackerTrophyDelta:0,defenderTrophyDelta:0,retreated:true};
beforeEach(async()=>{f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const c=f;f=undefined;try{await c?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
function options(){const c=f!;const authority:NonNullable<Parameters<typeof createRaid>[2]['authorizeAttackerBase']>=async(wallet,baseId,tx)=>{const actor=[c.source,c.buyer].find(a=>a.wallet===wallet&&a.baseId===baseId);if(!tx&&actor)await actor.refresh();await assertFreshLockedBaseAuthority(tx??c.db,wallet,baseId);};return {attackerBaseId:c.source.baseId,authorizeAttackerBase:authority,authorizeDefenderBase:authority,raidProtocolVersion:LIVE_RAID.protocolVersion,allowRaidProtocolV2:true} as const;}
async function raid(){const c=f!;return createRaid(c.db,c.source.wallet,{...options(),idempotencyKey:randomUUID()},()=>new Date(at));}

it('rejects missing, started, clock-mismatched and nonzero direct terminals without consuming the original retreat',async()=>{
 const c=f!,r=await raid();
 for(const mutation of ['missing-command','wrong-sequence','started','wrong-time','nonzero','changed-original'] as const){
  // Drizzle installs transparent JSON serializers on this shared postgres
  // handle, so raw SQL parameters must contain JSON text rather than tx.json.
  await expect(c.sql.begin(async tx=>{
   const payload={_clock:{protocolVersion:LIVE_RAID.protocolVersion,revision:0,rate:1,anchorWallAt:null,anchorSimMs:0,serverNow:at.toISOString(),simNowMs:0,battleEndsAt:null,durationMs:RAID_RULES.battleDurationSec*1000}};
   if(mutation!=='missing-command')await tx`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash,accepted_at) values(${r.id},0,${randomUUID()},'retreat',${JSON.stringify(payload)}::jsonb,0,'fixture',${at.toISOString()})`;
   await tx`update raid_live_states set last_sequence=${mutation==='wrong-sequence'?1:0},stream_closed_at=${at.toISOString()},updated_at=${at.toISOString()} where raid_id=${r.id}`;
   if(mutation==='started')await tx`update raid_live_states set started_at=${at.toISOString()},battle_ends_at=${new Date(at.getTime()+RAID_RULES.battleDurationSec*1000).toISOString()},clock_anchor_wall_at=${at.toISOString()},clock_anchor_sim_ms=0 where raid_id=${r.id}`;
   if(mutation==='changed-original')await tx`update raids set snapshot=jsonb_set(snapshot,'{fixtureTamper}','true') where id=${r.id}`;
   await tx`update raids set status='resolved',orders=${JSON.stringify({deploys:[],heroDeploys:[],retreated:true,idempotencyKey:'live-finish:'+r.id})}::jsonb,result=${JSON.stringify(mutation==='nonzero'?{...zero,lootShards:1}:zero)}::jsonb,events='[]',resolved_at=${new Date(at.getTime()+(mutation==='wrong-time'?1:0)).toISOString()} where id=${r.id}`;
  }),mutation).rejects.toThrow('CHARTER_PRESTART_SOURCE');
 }
 expect(await c.sql`select count(*)::int n from charter_tournament_prestart_retreats`).toEqual([{n:0}]);
 expect(await retreatLiveRaid(c.db,c.source.wallet,r.id,randomUUID(),at)).toMatchObject({terminal:true,result:zero});
 expect(await c.sql`select public.shardkeep_clan_charter_raid_chest_proof(${r.id},true)->>'status' status`).toEqual([{status:'reconciled'}]);
},120000);

it('retains immutable original retreat evidence and does not re-trust mutable reconnect rows',async()=>{
 const c=f!,r=await raid();await retreatLiveRaid(c.db,c.source.wallet,r.id,randomUUID(),at);
 const [saved]=await c.sql`select * from charter_tournament_prestart_retreats where raid_id=${r.id}`;
 expect(saved!.before_raid.status).toBe('pending_orders');expect(saved!.after_raid.status).toBe('resolved');expect(saved!.retreat.kind).toBe('retreat');
 await c.sql`update raid_commands set payload='{}',kind='fixture-mutation' where raid_id=${r.id}`;
 await c.sql`update raid_live_states set last_sequence=last_sequence+1 where raid_id=${r.id}`;
 expect(await c.sql`select public.shardkeep_clan_charter_raid_chest_proof(${r.id},true)->>'status' status`).toEqual([{status:'reconciled'}]);
 expect((await c.sql`select * from charter_tournament_prestart_retreats where raid_id=${r.id}`)[0]).toEqual(saved);
 await expect(c.sql`update charter_tournament_prestart_retreats set live_state='{}' where raid_id=${r.id}`).rejects.toThrow('CHARTER_PRESTART_IMMUTABLE');
 await expect(c.sql`delete from charter_tournament_prestart_retreats where raid_id=${r.id}`).rejects.toThrow('CHARTER_PRESTART_IMMUTABLE');
 await expect(c.sql`truncate charter_tournament_prestart_retreats`).rejects.toThrow('CHARTER_PRESTART_IMMUTABLE');
},120000);

it('staged campaign deploys may retreat before ATTACK while retaining zero loot and the original army',async()=>{
 const c=f!;await c.db.insert(baseArmy).values({baseId:c.source.baseId,troop:'highlander',count:2}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:2}});
 const r=await createCampaignRaid(c.db,c.source.wallet,1,randomUUID(),at,options());
 // PostgreSQL retains microseconds but its Date projection truncates to millis.
 // The next millisecond is explicitly after the original admission, so the
 // zero-time retreat cannot falsely precede that immutable source timestamp.
 const stagedAt=new Date(r.createdAt.getTime()+1);
 expect(await c.sql`select created_at<=${stagedAt.toISOString()}::timestamptz as ordered from raids where id=${r.id}`).toEqual([{ordered:true}]);
 await acceptLiveRaidCommandReceipt(c.db,c.source.wallet,r.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:1,ty:1}},stagedAt);
 expect(await retreatLiveRaid(c.db,c.source.wallet,r.id,randomUUID(),stagedAt)).toMatchObject({terminal:true,result:zero});
 const [saved]=await c.sql`select before_raid,after_raid,live_state from charter_tournament_prestart_retreats where raid_id=${r.id}`;
 expect(saved!.live_state.started_at).toBeNull();expect(saved!.after_raid.orders.deploys).toHaveLength(1);expect(saved!.after_raid.army_snapshot).toEqual(saved!.before_raid.army_snapshot);
 expect(await c.sql`select public.shardkeep_clan_charter_raid_chest_proof(${r.id},true)->>'status' status`).toEqual([{status:'reconciled'}]);
 expect(await c.sql`select count(*)::int n from clan_charter_loot_posts where raid_id=${r.id}`).toEqual([{n:0}]);
},120000);

it('cannot insert a forged saved witness directly or invoke its definer on a copied raid table',async()=>{
 const c=f!,r=await raid();
 await expect(c.sql`insert into charter_tournament_prestart_retreats select r.id,e.source_id,to_jsonb(r),to_jsonb(r),'{}','{}',pg_current_xact_id()::text from raids r join clan_charter_raid_events e on e.raid_id=r.id where r.id=${r.id}`).rejects.toThrow('CHARTER_PRESTART_ORIGIN');
 await c.sql`create table copied_prestart_raid(like public.raids including all)`;
 await c.sql`create trigger raids_aa_charter_prestart_retreat before update on copied_prestart_raid for each row execute function public.shardkeep_charter_prestart_retreat_capture()`;
 await c.sql`insert into copied_prestart_raid select * from raids where id=${r.id}`;
 await expect(c.sql`update copied_prestart_raid set status='resolved' where id=${r.id}`).rejects.toThrow('CHARTER_PRESTART_TRIGGER');
},120000);

it('the immutable source contract detects disabling the separate capture before accepting a terminal',async()=>{
 const c=f!,r=await raid();await c.sql`alter table raids disable trigger raids_aa_charter_prestart_retreat`;
 try{await expect(retreatLiveRaid(c.db,c.source.wallet,r.id,randomUUID(),at)).rejects.toThrow();await expect(c.sql`select public.shardkeep_charter_tournament_raid_source()`).rejects.toThrow('CHARTER_TOURNAMENT_RAID_SOURCE');}
 finally{await c.sql`alter table raids enable trigger raids_aa_charter_prestart_retreat`;}
 expect(await c.sql`select count(*)::int n from charter_tournament_prestart_retreats`).toEqual([{n:0}]);
},120000);
