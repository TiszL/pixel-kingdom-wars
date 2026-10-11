/** Actual collection/raid lifecycle must consume recovered original units once,
 * preserve old wallet carry and fund the same independently replayed pools. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {createTestPlayer} from './helpers';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {bases,raids,baseRaidLocks} from '../src/db/schema';
import {reanchorBaseMineAccrual,collectBaseMines} from '../src/game/baseMining';
import {reserveDeedRaidLoot,releaseDeedRaidLoot,settleDeedRaidLoot} from '../src/game/raidLoot';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {getOrCreateBaseAccount} from '../src/ledger';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
},120000);
afterEach(async()=>{vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function prepared(){
 const f=await fixture.createResolvedSource();
 // Normal capped production since the first capture ends inside round1. Bank
 // that real buffer at today's injected clock before resolving its old units.
 await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,fixture.verified));
 const parents=await conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and wallet=${f.wallet} and admission_id is null and recovery_parent_id is null and buffer>0 order by starts_at`;
 expect(parents).toHaveLength(1);for(const parent of parents)await fixture.resolve(parent.id);
 const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints),context={baseId:f.base.id,assertAuthority:async()=>{}};
 return {...f,gross,tax,net:gross-tax,context,collect:(db=conn.db)=>collectBaseMines(db,f.wallet,context,fixture.verified)};
}
type Source=Awaited<ReturnType<typeof prepared>>;
async function raid(f:Source){
 const player=await createTestPlayer(conn.db),[destination]=await conn.db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:1}).returning();
 const [r]=await conn.db.insert(raids).values({idempotencyKey:randomUUID(),attackerWallet:player.wallet,attackerBaseId:destination!.id,defenderWallet:f.wallet,defenderBaseId:f.base.id,seed:1n,snapshot:{},armySnapshot:{},simVersion:9,ordersDeadlineAt:new Date(+fixture.verified+120000)}).returning();
 await conn.db.insert(baseRaidLocks).values({baseId:f.base.id,raidId:r!.id,expiresAt:new Date(+fixture.verified+180000)});
 await reserveDeedRaidLoot(conn.db,{raidId:r!.id,attackerBaseId:destination!.id,defenderBaseId:f.base.id,now:fixture.verified});return {raid:r!,destination:destination!,player};
}
async function originalPools(f:Source,db=conn.db){
 const rows=await conn.sql`select distinct t.term_id,t.term_hash from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${f.mine.id}`;
 let total=0n;for(const r of rows)total+=await readCompleteShardsTaxPool(db,r.term_id,r.term_hash);return total;
}
const footprint=async(f:Source)=>({segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s where mine_id=${f.mine.id} order by id`,
 state:await conn.sql`select to_jsonb(s) value from mine_accrual_states s where mine_building_id=${f.mine.id}`,
 deliveries:await conn.sql`select to_jsonb(d) value from shards_mine_deliveries d join shards_mine_segments s on s.id=d.segment_id where s.mine_id=${f.mine.id}`,
 assessments:await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${f.wallet}`,
 accounts:await conn.sql`select to_jsonb(a) value from accounts a where base_id=${f.base.id} or kind in ('shard_genesis','shards_tax_escrow') order by id`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t where metadata->>'baseId'=${f.base.id} or metadata->>'defenderBaseId'=${f.base.id} order by id`});
describe.sequential('recovered original Mine issuance',()=>{
 it('collects at the actual recovery clock with old-term carry and no duplicate gross from resolved parents',async()=>{
  const f=await prepared();expect((await f.collect()).amount).toBe(f.net);
  expect((await getOrCreateBaseAccount(conn.db,f.base.id,'base_shards')).balance).toBe(f.net);
  const rows=await conn.sql`select * from shards_tax_assessments where wallet=${f.wallet} order by wallet_sequence`;
  expect(rows).toHaveLength(3);expect(rows.map(r=>r.wallet_sequence)).toEqual(['1','2','3']);
  expect(rows.every(r=>r.receipt.version===2&&r.receipt.purpose==='historical_physical_mine')).toBe(true);
  expect(rows.reduce((n,r)=>n+BigInt(r.gross),0n)).toBe(f.gross-4n);expect(rows.reduce((n,r)=>n+BigInt(r.tax),0n)).toBe(f.tax);
  expect(await originalPools(f)).toBe(f.tax);expect((await f.collect()).amount).toBe(0n);
 });
 it('preserves funded history after paused database reopen without invoking providers',async()=>{
  const f=await prepared();await f.collect();vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{expect(await originalPools(f,reopened.db)).toBe(f.tax);expect((await f.collect(reopened.db)).amount).toBe(0n);}finally{await reopened.sql.end();}
 });
 it('reserves and restores exact recovered sources without taxing the unminted reservation',async()=>{
  const f=await prepared(),r=await raid(f);
  expect(await conn.sql`select operation_key from shards_mine_deliveries where operation_key=${'raid:'+r.raid.id+':loot-terminal'}`).toHaveLength(0);
  await releaseDeedRaidLoot(conn.db,r.raid.id,fixture.verified);
  expect((await f.collect()).amount).toBe(f.net);expect(await originalPools(f)).toBe(f.tax);
  expect(await releaseDeedRaidLoot(conn.db,r.raid.id,fixture.verified)).toBe(true);expect(await originalPools(f)).toBe(f.tax);
 });
 it('awards recovered Mine output to the attacker while retaining seller carry and original terms',async()=>{
  const f=await prepared(),r=await raid(f),result=await settleDeedRaidLoot(conn.db,r.raid.id,1,[{id:f.mine.id,type:'mine',destroyed:true}],fixture.verified);
  expect(result.mines).toBe(f.net);expect((await getOrCreateBaseAccount(conn.db,r.destination.id,'base_shards')).balance).toBe(f.net);
  const rows=await conn.sql`select distinct wallet from shards_tax_assessments where operation_key=${'raid:'+r.raid.id+':loot-terminal'}`;
  expect(rows).toEqual([{wallet:f.wallet}]);expect(await originalPools(f)).toBe(f.tax);
 });
 it('rolls back every ledger, source and carry change if an assessment cannot persist',async()=>{
  const f=await prepared(),before=await footprint(f);
  await conn.sql.unsafe(`create function mine_recovery_issuance_fail() returns trigger language plpgsql as $$begin raise exception 'fixture recovered assessment failure';end$$;create trigger mine_recovery_issuance_fail before insert on shards_tax_assessments for each row execute function mine_recovery_issuance_fail()`);
  try{await expect(f.collect()).rejects.toThrow();expect(await footprint(f)).toEqual(before);}
  finally{await conn.sql.unsafe('drop trigger mine_recovery_issuance_fail on shards_tax_assessments;drop function mine_recovery_issuance_fail()');}
  expect((await f.collect()).amount).toBe(f.net);expect(await originalPools(f)).toBe(f.tax);
 });
 it.each(['assessment','certificate'] as const)('finds a missing %s through the immutable recovered source instead of reporting a smaller pool',async missing=>{
  const f=await prepared();await f.collect();const abort=Error('restore missing assessment');
  await expect(conn.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role='replica'`);
   if(missing==='assessment')await tx.execute(sql`delete from shards_tax_assessments where wallet=${f.wallet} and wallet_sequence=3`);
   else await tx.execute(sql`delete from shards_mine_resolution_terms where segment_id=${f.resolution.children[1]!.segment.id}`);
   const last=f.resolution.children[1]!;await expect(readCompleteShardsTaxPool(tx,last.termId,last.termHash)).rejects.toThrow();throw abort;
  })).rejects.toBe(abort);expect(await originalPools(f)).toBe(f.tax);
 });
 it('keeps unrelated old-term history readable by its existing restricted role after recovered delivery elsewhere',async()=>{
  const old=await createShardsHistoryFixture(conn.db);await old.collect();
  const expected=await readCompleteShardsTaxPool(conn.db,old.termId,old.termHash);
  const f=await prepared();await f.collect();
  const role=`mine_history_${randomUUID().replaceAll('-','')}`,password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`);
  try{
   const [database]=await conn.sql`select current_database() name`;
   await conn.sql.unsafe(`grant connect on database ${database!.name} to ${role};grant usage on schema public to ${role};
    grant select on expedition_term_snapshots,shards_tax_assessments,shards_cache_assessments,shards_cache_sources,
    shards_mine_segments,shards_mine_deliveries,shards_mine_admissions,shards_mine_closures,ledger_transactions,
    ledger_entries,accounts,raid_loot_reservations,raid_mine_loot_reservations,shards_mine_reservations,shards_mine_raid_eras to ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
   expect(await runtime.sql`select has_table_privilege(current_user,'shards_mine_resolutions','SELECT') header,has_table_privilege(current_user,'shards_mine_resolution_terms','SELECT') certificate`).toEqual([{header:false,certificate:false}]);
   expect(await readCompleteShardsTaxPool(runtime.db,old.termId,old.termHash)).toBe(expected);
   // A requested recovered term still needs its private original proof.
   const target=f.resolution.children[1]!;await expect(readCompleteShardsTaxPool(runtime.db,target.termId,target.termHash)).rejects.toThrow();
  }finally{await runtime?.sql.end();await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 });

});
