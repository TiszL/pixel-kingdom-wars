import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
/** Prospective obstacle obligations preserve evidence only; no issuer is mounted. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {OBSTACLES} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {bases,baseSlots,builderJobs,obstacles} from '../src/db/schema';
import {admitShardsObstacleObligation,readShardsObstacleObligation,assertShardsObstacleTermPrefix} from '../src/mining/shardsTaxObstacleObligations';
import {lockPhysicalMineTaxActors} from '../src/mining/shardsTaxMineSources';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {MINE_DAY_MS} from '../src/game/baseMining';
import {initializeMiningDevelopmentHistory} from '../src/mining/developmentHistory';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';

const conn=resourceClaimsDatabase(),db=conn.db,start=new Date('2038-01-01T00:00:00.000Z');
beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
function enable(){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
async function fixture(){
 enable();const player=await createTestPlayer(db),[base]=await db.insert(bases).values({ownerWallet:player.wallet,status:'active',keepLevel:1}).returning();
 await db.insert(baseSlots).values({wallet:player.wallet,slot:1,baseId:base!.id});
 const [obstacle]=await db.insert(obstacles).values({playerWallet:player.wallet,baseId:base!.id,spriteKey:'obs_bush_1',tx:0,ty:0}).returning();
 const finish=new Date(+start+OBSTACLES.tiers.small.clearSec*1000),[job]=await db.insert(builderJobs).values({playerWallet:player.wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:start,finishesAt:finish}).returning();
 const command={idempotencyKey:randomUUID(),baseId:base!.id,jobId:job!.id},context={baseId:base!.id,assertAuthority:async()=>{}};
 return {player,base:base!,obstacle:obstacle!,job:job!,finish,command,context};
}
const money=async()=>({accounts:await conn.sql`select id,balance::text from accounts order by id`,ledger:await conn.sql`select id from ledger_transactions order by id`,assessments:await conn.sql`select operation_key,wallet_sequence::text from shards_tax_all_assessments order by operation_key`});
const prefix=(wallet:string,termStart:string)=>db.transaction(async tx=>{await lockPhysicalMineTaxActors(tx,[wallet]);await assertShardsObstacleTermPrefix(tx,wallet,termStart);});

describe.sequential('prospective original obstacle obligations',()=>{
 it('captures the unfinished job and canonical gross without issuing, moving money or claiming the earning wallet',async()=>{
  const f=await fixture(),before=await money(),captured=new Date(+start+1);
  const receipt=await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>captured});
  expect(receipt).toMatchObject({idempotencyKey:f.command.idempotencyKey,jobId:f.job.id,baseId:f.base.id,obstacleId:f.obstacle.id,wallet:f.player.wallet,
   deedAssetId:null,capturedAt:captured.toISOString(),startedAt:start.toISOString(),scheduledFinishAt:f.finish.toISOString(),gross:String(OBSTACLES.clearRewardShards),earningWalletConfirmed:false,postingAuthorized:false});
  expect(receipt.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toEqual(receipt);
  expect(await money()).toEqual(before);expect(await conn.sql`select id from shards_obstacle_obligations where job_id=${f.job.id}`).toHaveLength(1);
 });
 it('replays exact original capture across duplicate calls, reconnect, pause and damaged current custody',async()=>{
  const f=await fixture(),results=await Promise.all([1,2].map(()=>admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start})));
  expect(results[1]).toEqual(results[0]);const buyer=await createTestPlayer(db);
  // Only fixture corruption bypasses the unmounted transition fence. Saved
  // capture reads must remain original even when current authority is unusable.
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;await tx`set local session_replication_role='origin'`;});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{expect(await admitShardsObstacleObligation(reopened.db,f.player.wallet,f.command,{...f.context,assertAuthority:async()=>{throw Error('not historical authority');}})).toEqual(results[0]);}
  finally{await reopened.sql.end();}
  expect(await readShardsObstacleObligation(db,buyer.wallet,f.command.idempotencyKey)).toBeNull();
  expect(await conn.sql`select id from shards_obstacle_obligations where job_id=${f.job.id}`).toHaveLength(1);
 });
 it('rejects changed request identity and a second key for the same original job',async()=>{
  const f=await fixture();await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
  for(const command of [{...f.command,jobId:randomUUID()},{...f.command,baseId:randomUUID()},{...f.command,idempotencyKey:randomUUID()}])
   await expect(admitShardsObstacleObligation(db,f.player.wallet,command,f.context,{clock:()=>start})).rejects.toMatchObject({statusCode:409});
 });
 it('requires original active job, uncleared obstacle, exact base and final authority',async()=>{
  for(const mutation of ['kind','completed','cleared','foreign_base','authority']){
   const f=await fixture();if(mutation==='kind')await db.update(builderJobs).set({kind:'build'}).where(eq(builderJobs.id,f.job.id));
   if(mutation==='completed')await db.update(builderJobs).set({completedAt:start}).where(eq(builderJobs.id,f.job.id));
   if(mutation==='cleared')await db.update(obstacles).set({clearedAt:start}).where(eq(obstacles.id,f.obstacle.id));
   const command=mutation==='foreign_base'?{...f.command,baseId:randomUUID()}:f.command;
   const context=mutation==='authority'?{...f.context,assertAuthority:async()=>{throw Error('authority lost');}}:f.context;
   await expect(admitShardsObstacleObligation(db,f.player.wallet,command,context,{clock:()=>start})).rejects.toThrow();
   expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toBeNull();
  }
 });
 it('captures only before due and rolls back when the phase pauses during final authority',async()=>{
  const f=await fixture();for(const at of [new Date(+start-1),f.finish])await expect(admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>at})).rejects.toThrow();
  const before=await money();let checks=0;
  await expect(admitShardsObstacleObligation(db,f.player.wallet,f.command,{...f.context,assertAuthority:async()=>{if(++checks===2)vi.stubEnv('PHASE_E_MINING_ENABLED','false');}},{clock:()=>start})).rejects.toMatchObject({code:'PHASE_E_DISABLED'});
  expect(checks).toBe(2);expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toBeNull();expect(await money()).toEqual(before);
 });
 it('samples final accepted time after an actual second-connection wallet wait',async()=>{
  const f=await fixture(),other=conn.reopen();await conn.sql`insert into shards_tax_wallet_locks(wallet) values(${f.player.wallet}) on conflict do nothing`;
  let release=()=>{},ready!:(pid:number)=>void;const locked=new Promise<number>(resolve=>{ready=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
  const holding=conn.sql.begin(async tx=>{await tx`select wallet from shards_tax_wallet_locks where wallet=${f.player.wallet} for update`;const [pid]=await tx`select pg_backend_pid() pid`;ready(pid!.pid);await held;});
  const holder=await locked;let at=start,pid=0,done=false;
  const capture=admitShardsObstacleObligation(other.db,f.player.wallet,f.command,{...f.context,assertAuthority:async tx=>{const [row]=await tx.execute(sql`select pg_backend_pid() pid`);pid=Number(row!.pid);}},{clock:()=>at}).then(v=>{done=true;return v;},error=>{done=true;return error;});
  try{
   let blocked=false;const deadline=Date.now()+10000;
   while(!blocked&&!done&&Date.now()<deadline){const [r]=await conn.sql`select ${holder}::integer=any(pg_blocking_pids(${pid}::integer)) blocked`;blocked=r!.blocked;}
   expect(blocked).toBe(true);at=f.finish;release();await holding;const result=await capture;expect(result).toMatchObject({code:'SHARDS_OBSTACLE_UNAVAILABLE'});
   expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toBeNull();
  }finally{release();await Promise.allSettled([holding,capture]);await other.sql.end();}
 });
 it('holds earlier due work while allowing the exact boundary and future obligations',async()=>{
  const f=await fixture();await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
  await prefix(f.player.wallet,start.toISOString());await prefix(f.player.wallet,f.finish.toISOString());
  await expect(prefix(f.player.wallet,new Date(+f.finish+1).toISOString())).rejects.toMatchObject({code:'SHARDS_TAX_ORDER_HELD'});
 });
 it('fences unjournaled schedule, completion, obstacle and custody transitions while allowing unrelated base edits',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db);await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
  for(const statement of [conn.sql`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`,
   conn.sql`update builder_jobs set completed_at=${f.finish.toISOString()} where id=${f.job.id}`,conn.sql`update obstacles set cleared_at=${f.finish.toISOString()} where id=${f.obstacle.id}`,
   conn.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`,conn.sql`update bases set deed_asset_id='fixture:replacement' where id=${f.base.id}`])
   await expect(statement).rejects.toThrow('SHARDS_OBSTACLE_TRANSITION_HELD');
  await conn.sql`update bases set updated_at=updated_at+interval '1 millisecond' where id=${f.base.id}`;
  expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).not.toBeNull();
 });
 it('holds damaged schedule, terminal and custody evidence for both original and current wallets',async()=>{
  for(const change of ['schedule','completed','obstacle','custody','deed']){
   const f=await fixture(),buyer=await createTestPlayer(db);await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
   await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
    if(change==='schedule')await tx`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`;
    if(change==='completed')await tx`update builder_jobs set completed_at=${f.finish.toISOString()} where id=${f.job.id}`;
    if(change==='obstacle')await tx`update obstacles set cleared_at=${f.finish.toISOString()} where id=${f.obstacle.id}`;
    if(change==='custody')await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
    if(change==='deed')await tx`update bases set deed_asset_id='fixture:damaged' where id=${f.base.id}`;
    await tx`set local session_replication_role='origin'`;
   });
   await expect(prefix(f.player.wallet,start.toISOString())).rejects.toMatchObject({code:'SHARDS_TAX_ORDER_HELD'});
   if(change==='custody')await expect(prefix(buyer.wallet,start.toISOString())).rejects.toMatchObject({code:'SHARDS_TAX_ORDER_HELD'});
  }
 });
 it('keeps raw captured rows immutable and rejects repeatable-read admission',async()=>{
  const f=await fixture();await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
  for(const statement of [conn.sql`update shards_obstacle_obligations set gross=gross where id=${f.command.idempotencyKey}`,
   conn.sql`delete from shards_obstacle_obligations where id=${f.command.idempotencyKey}`,conn.sql`truncate shards_obstacle_obligations cascade`])await expect(statement).rejects.toThrow('SHARDS_OBSTACLE_IMMUTABLE');
  const [row]=await conn.sql`select to_jsonb(h) value from shards_obstacle_obligations h where id=${f.command.idempotencyKey}`;
  await expect(conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify({...row!.value,id:randomUUID()})}::jsonb)`;})).rejects.toThrow('SHARDS_OBSTACLE_ISOLATION');
 });
 it('preserves SQL microseconds in original schedule while exposing canonical millisecond receipts',async()=>{
  const f=await fixture();await conn.sql`update builder_jobs set started_at=started_at+interval '100 microseconds',finishes_at=finishes_at+interval '200 microseconds' where id=${f.job.id}`;
  const receipt=await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>new Date(+start+1)});
  expect(receipt.startedAt).toBe(start.toISOString());expect(receipt.scheduledFinishAt).toBe(f.finish.toISOString());
  expect(await conn.sql`select h.started_at=j.started_at and h.scheduled_finish_at=j.finishes_at exact from shards_obstacle_obligations h join builder_jobs j on j.id=h.job_id where h.id=${f.command.idempotencyKey}`).toEqual([{exact:true}]);
 });
});

describe.sequential('obstacle obligations against real Mine/cache writers',()=>{
 // Obtain the production capture shape before the term starts, then remove only
 // this fixture's row. Later raw attempts must face every original SQL guard.
 async function candidate(f:Awaited<ReturnType<typeof createShardsHistoryFixture>>){
  const [base]=await db.insert(bases).values({ownerWallet:f.player.wallet,status:'active',keepLevel:1}).returning();
  await db.insert(baseSlots).values({wallet:f.player.wallet,slot:2,baseId:base!.id});
  const [obstacle]=await db.insert(obstacles).values({playerWallet:f.player.wallet,baseId:base!.id,spriteKey:'obs_bush_1',tx:0,ty:0}).returning();
  const finish=new Date(+f.start-1),captured=new Date(+finish-1),began=new Date(+finish-OBSTACLES.tiers.small.clearSec*1000);
  const [job]=await db.insert(builderJobs).values({playerWallet:f.player.wallet,baseId:base!.id,kind:'clear_obstacle',obstacleId:obstacle!.id,startedAt:began,finishesAt:finish}).returning();
  const command={idempotencyKey:randomUUID(),baseId:base!.id,jobId:job!.id};
  await admitShardsObstacleObligation(db,f.player.wallet,command,{baseId:base!.id,assertAuthority:async()=>{}},{clock:()=>captured});
  const [row]=await conn.sql`select to_jsonb(h) value from shards_obstacle_obligations h where id=${command.idempotencyKey}`;
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   // This fixture removes its prospective candidate before testing fresh raw
   // admission; its actual-INSERT sidecars must be removed with that candidate.
   await tx`delete from shards_obstacle_base_changes where obligation_id=${command.idempotencyKey}`;
   await tx`delete from shards_obstacle_base_origins where obligation_id=${command.idempotencyKey}`;
   await tx`delete from shards_obstacle_obligations where id=${command.idempotencyKey}`;await tx`set local session_replication_role='origin'`;
  });
  return row!.value;
 }
 const cacheContext=(f:Awaited<ReturnType<typeof createShardsHistoryFixture>>,at:Date)=>({...f.context,
  shardsCacheSource:{clock:()=>at,prefetch:async()=>({readOperatingTerm:async()=>({...f.observation,finality:{...f.observation.finality,observedAt:at.toISOString()}})})},
 });
 const sourceState=async(wallet:string,baseId:string)=>({
  money:await money(),entries:await conn.sql`select to_jsonb(e) value from ledger_entries e order by id`,
  sources:await conn.sql`select to_jsonb(s) value from shards_cache_sources s where wallet=${wallet} order by operation_key`,
  streak:await conn.sql`select to_jsonb(s) value from base_streaks s where base_id=${baseId}`,
 });

 it('rejects raw capture behind a real committed cache term floor without changing money or cache history',async()=>{
  enable();const f=await createShardsHistoryFixture(db),header=await candidate(f);
  await seedHistoricalTaxedCache(db,f.player.wallet,cacheContext(f,f.start),f.start);
  expect(await conn.sql`select source_kind,term_id from shards_tax_all_assessments where wallet=${f.player.wallet}`).toEqual([{source_kind:'daily_cache',term_id:f.termId}]);
  const before=await sourceState(f.player.wallet,f.base.id);
  await expect(conn.sql`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify(header)}::jsonb)`)
   .rejects.toThrow('SHARDS_OBSTACLE_ORDER_HELD');
  expect(await conn.sql`select id from shards_obstacle_obligations where id=${header.id}`).toHaveLength(0);
  expect(await sourceState(f.player.wallet,f.base.id)).toEqual(before);
 });

 it('refuses both otherwise-valid raw Mine and cache assessments while an earlier captured obligation is pending',async()=>{
  enable();const f=await createShardsHistoryFixture(db),header=await candidate(f),at=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota)));
  await f.collect(at);await seedHistoricalTaxedCache(db,f.player.wallet,cacheContext(f,at),at);
  const [mine]=await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${f.player.wallet}`;
  const [cache]=await conn.sql`select to_jsonb(a) value from shards_cache_assessments a where wallet=${f.player.wallet}`;
  expect(mine).toBeDefined();expect(cache).toBeDefined();
  // Retain real sources/deliveries/ledger entries. Only these two assessments
  // are removed so direct INSERT can be tested without a duplicate-key failure.
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   await tx`delete from shards_tax_assessments where wallet=${f.player.wallet}`;
   await tx`delete from shards_cache_assessments where wallet=${f.player.wallet}`;await tx`set local session_replication_role='origin'`;
  });
  const rollback=new Error('valid direct assessments demonstrated');
  await expect(conn.sql.begin(async tx=>{
   await tx`insert into shards_tax_assessments select * from jsonb_populate_record(null::shards_tax_assessments,${JSON.stringify(mine!.value)}::jsonb)`;
   await tx`insert into shards_cache_assessments select * from jsonb_populate_record(null::shards_cache_assessments,${JSON.stringify(cache!.value)}::jsonb)`;
   await tx`set constraints all immediate`;throw rollback;
  })).rejects.toBe(rollback);
  await conn.sql`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify(header)}::jsonb)`;
  const before=await sourceState(f.player.wallet,f.base.id);
  await expect(conn.sql`insert into shards_tax_assessments select * from jsonb_populate_record(null::shards_tax_assessments,${JSON.stringify(mine!.value)}::jsonb)`)
   .rejects.toThrow('SHARDS_OBSTACLE_ORDER_HELD');
  await expect(conn.sql`insert into shards_cache_assessments select * from jsonb_populate_record(null::shards_cache_assessments,${JSON.stringify(cache!.value)}::jsonb)`)
   .rejects.toThrow('SHARDS_OBSTACLE_ORDER_HELD');
  expect(await sourceState(f.player.wallet,f.base.id)).toEqual(before);
  expect(await conn.sql`select id from shards_obstacle_obligations where id=${header.id}`).toEqual([{id:header.id}]);
  expect(await conn.sql`select operation_key from shards_tax_all_assessments where wallet=${f.player.wallet}`).toHaveLength(0);
 });

 it('makes an actual second-connection cache claim observe a capture committed after its player-lock wait',async()=>{
  enable();const f=await createShardsHistoryFixture(db),header=await candidate(f),before=await sourceState(f.player.wallet,f.base.id),other=conn.reopen();
  let release=()=>{},ready!:(pid:number)=>void,holding:Promise<unknown>|undefined,cache:Promise<unknown>|undefined,done=false;
  const locked=new Promise<number>(resolve=>{ready=resolve;}),held=new Promise<void>(resolve=>{release=resolve;}),authority=vi.fn(async()=>{});
  try{
   holding=conn.sql.begin(async tx=>{
    await tx`insert into shards_obstacle_obligations select * from jsonb_populate_record(null::shards_obstacle_obligations,${JSON.stringify(header)}::jsonb)`;
    const [pid]=await tx`select pg_backend_pid() pid`;ready(pid!.pid);await held;
   });
   const holder=await locked;
   cache=seedHistoricalTaxedCache(other.db,f.player.wallet,{...cacheContext(f,f.start),assertAuthority:authority},f.start)
    .then(value=>{done=true;return value;},error=>{done=true;return error;});
   let blocked:number|undefined;const deadline=Date.now()+10000;
   while(blocked===undefined&&!done&&Date.now()<deadline){
    const rows=await conn.sql`select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
     and ${holder}::integer=any(pg_blocking_pids(pid)) and query like '%from "players"%for update%'`;
    if(rows.length===1)blocked=Number(rows[0]!.pid);
   }
   expect(blocked).toBeDefined();expect(blocked).not.toBe(holder);expect(done).toBe(false);expect(authority).not.toHaveBeenCalled();
   release();await holding;
   expect(await cache).toMatchObject({code:'SHARDS_TAX_ORDER_HELD'});expect(authority).toHaveBeenCalledTimes(2);
   expect(await sourceState(f.player.wallet,f.base.id)).toEqual(before);
   expect(await readShardsObstacleObligation(db,f.player.wallet,header.id)).toMatchObject({idempotencyKey:header.id,postingAuthorized:false});
   expect(await conn.sql`select operation_key from shards_cache_sources where wallet=${f.player.wallet}`).toHaveLength(0);
  }finally{release();await Promise.allSettled([...(holding?[holding]:[]),...(cache?[cache]:[])]);await other.sql.end();}
 });
});

describe.sequential('obstacle capture against stale parent snapshots and capture side effects',()=>{
 const parents=async(f:Awaited<ReturnType<typeof fixture>>)=>({
  base:await conn.sql`select to_jsonb(b) value from bases b where id=${f.base.id}`,
  job:await conn.sql`select to_jsonb(j) value from builder_jobs j where id=${f.job.id}`,
  obstacle:await conn.sql`select to_jsonb(o) value from obstacles o where id=${f.obstacle.id}`,
 });
 const histories=async()=>Object.fromEntries(await Promise.all([
  'player_action_events','player_activity_days','deed_ownership_observations',
  'league_week_closures','league_week_base_snapshots','league_week_base_exclusions',
  'mining_development_baselines','mining_development_events','mining_development_transactions',
  'mining_roster_baselines','mining_roster_events','mining_roster_transactions',
 ].map(async table=>[table,await conn.sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)])));

 it.each(['base','job','obstacle'] as const)('rejects a stale repeatable-read %s writer after capture commits',async target=>{
  const f=await fixture(),buyer=await createTestPlayer(db),other=conn.reopen(),before=await parents(f);
  let ready=()=>{},release=()=>{};const snapshot=new Promise<void>(resolve=>{ready=resolve;}),write=new Promise<void>(resolve=>{release=resolve;});
  const writer=other.sql.begin('isolation level repeatable read',async tx=>{
   // A plain committed read establishes the stale snapshot without holding the
   // row lock that capture needs. Each parameterized case owns fresh parents.
   if(target==='base')await tx`select id from bases where id=${f.base.id}`;
   if(target==='job')await tx`select id from builder_jobs where id=${f.job.id}`;
   if(target==='obstacle')await tx`select id from obstacles where id=${f.obstacle.id}`;
   ready();await write;
   if(target==='base')await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
   if(target==='job')await tx`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`;
   if(target==='obstacle')await tx`update obstacles set cleared_at=${f.finish.toISOString()} where id=${f.obstacle.id}`;
  }).then(()=>({accepted:true as const,error:null}),error=>({accepted:false as const,error}));
  try{
   await snapshot;const receipt=await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
   expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toEqual(receipt);
   release();const result=await writer;expect(result.accepted).toBe(false);
   expect(result.error?.code==='40001'||String(result.error?.message).includes('SHARDS_OBSTACLE_TRANSITION_HELD')).toBe(true);
   expect(await parents(f)).toEqual(before);
  }finally{release();await writer;await other.sql.end();}
 });

 it('preserves unenrolled RC controls while requiring read committed for base and job provenance',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db),before=await parents(f);
  // 0205 requires READ COMMITTED for jobs even before obstacle enrollment.
  await expect(conn.sql.begin('isolation level repeatable read',async tx=>{
   await tx`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`;
  })).rejects.toMatchObject({code:'P0001',message:'VEHICLE_READ_COMMITTED_REQUIRED'});
  expect(await parents(f)).toEqual(before);
  // Charter custody now fences base writers before obstacle enrollment too.
  await expect(conn.sql.begin('isolation level repeatable read',async tx=>{
   await tx`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
  })).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_CUSTODY_READ_COMMITTED'});
  expect(await parents(f)).toEqual(before);
  await conn.sql.begin('isolation level read committed',async tx=>{
   await tx`select id from bases where id=${f.base.id}`;
   await tx`update bases set owner_wallet=${buyer.wallet},updated_at=updated_at+interval '1 millisecond' where id=${f.base.id}`;
   await tx`update obstacles set cleared_at=${f.finish.toISOString()} where id=${f.obstacle.id}`;
  });
  await conn.sql.begin('isolation level read committed',async tx=>{
   await tx`update builder_jobs set finishes_at=finishes_at-interval '1 millisecond' where id=${f.job.id}`;
  });
  const [state]=await conn.sql`select b.owner_wallet,
   b.updated_at=${before.base[0]!.value.updated_at}::timestamptz+interval '1 millisecond' timestamp_changed,
   j.finishes_at=${f.finish.toISOString()}::timestamptz-interval '1 millisecond' schedule_changed,
   o.cleared_at=${f.finish.toISOString()}::timestamptz cleared
   from bases b join builder_jobs j on j.id=${f.job.id} join obstacles o on o.id=${f.obstacle.id} where b.id=${f.base.id}`;
  expect(state).toEqual({owner_wallet:buyer.wallet,timestamp_changed:true,schedule_changed:true,cleared:true});
  expect(await conn.sql`select id from shards_obstacle_obligations where job_id=${f.job.id}`).toHaveLength(0);
 });

 it('preserves restricted parent writers without new header SELECT while enforcing enrolled transition holds',async()=>{
  const f=await fixture(),role=`obstacle_parent_${randomUUID().replaceAll('-','')}`,password=randomUUID();
  let runtime:ReturnType<typeof createDb>|undefined,created=false;
  try{
   const [database]=await conn.sql`select current_database() name`;
   await conn.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created=true;
   await conn.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role};GRANT USAGE ON SCHEMA public TO ${role}`);
   // Reproduce an existing parent writer provisioned before0196. Read access to
   // its old tables cannot imply access to newly captured obligation history.
   const tables=await conn.sql`select tablename from pg_tables where schemaname='public' and tablename<>'shards_obstacle_obligations'`;
   for(const table of tables)await conn.sql.unsafe(`GRANT SELECT ON public.${table.tablename} TO ${role}`);
   await conn.sql.unsafe(`GRANT UPDATE ON public.bases,public.builder_jobs,public.obstacles TO ${role}`);
   await conn.sql.unsafe(`GRANT INSERT,UPDATE ON public.player_action_events,public.player_activity_days TO ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
   const rights=()=>runtime!.sql`select has_table_privilege(current_user,'public.shards_obstacle_obligations','SELECT') header_read,
    has_function_privilege(current_user,'public.shardkeep_shards_obstacle_transition_guard()','EXECUTE') direct_guard_execution`;
   expect(await rights()).toEqual([{header_read:false,direct_guard_execution:false}]);
   await expect(runtime.sql`select * from shards_obstacle_obligations`).rejects.toMatchObject({code:'42501'});
   await runtime.sql`update bases set status='inactive' where id=${f.base.id}`;
   await runtime.sql`update bases set status='active' where id=${f.base.id}`;
   await runtime.sql`update builder_jobs set finishes_at=finishes_at+interval '1 millisecond' where id=${f.job.id}`;
   await runtime.sql`update obstacles set tx=tx+1 where id=${f.obstacle.id}`;
   await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
   for(const statement of [runtime.sql`update bases set status='inactive' where id=${f.base.id}`,
    runtime.sql`update builder_jobs set finishes_at=finishes_at+interval '1 millisecond' where id=${f.job.id}`,
    runtime.sql`update obstacles set cleared_at=${f.finish.toISOString()} where id=${f.obstacle.id}`])
    await expect(statement).rejects.toThrow('SHARDS_OBSTACLE_TRANSITION_HELD');
   expect(await rights()).toEqual([{header_read:false,direct_guard_execution:false}]);
  }finally{await runtime?.sql.end();if(created){await conn.sql.unsafe(`DROP OWNED BY ${role}`);await conn.sql.unsafe(`DROP ROLE ${role}`);}}
 });

 it('leaves complete free and deeded parent JSON, initialized mining histories, action/deed/league events and money unchanged',async()=>{
  for(const deeded of [false,true]){
   const f=await fixture();if(deeded)await conn.sql`update bases set deed_asset_id=${f.player.wallet} where id=${f.base.id}`;
   await initializeMiningDevelopmentHistory(db,f.base.id);await initializeMiningRosterHistory(db,f.player.wallet);
   expect(await conn.sql`select base_id from mining_development_baselines where base_id=${f.base.id}`).toHaveLength(1);
   expect(await conn.sql`select wallet from mining_roster_baselines where wallet=${f.player.wallet}`).toHaveLength(1);
   const before={parents:await parents(f),histories:await histories(),money:await money()};
   const receipt=await admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start});
   expect(receipt.deedAssetId).toBe(deeded?f.player.wallet:null);
   expect({parents:await parents(f),histories:await histories(),money:await money()}).toEqual(before);
  }
 });

 it('holds malformed historical deed reservation without normalizing parent state or writing events',async()=>{
  const f=await fixture();
  // Existing 0072 would normalize this legacy inconsistency on any UPDATE.
  // Only isolated fixture corruption may manufacture it; capture must hold or
  // roll back rather than silently becoming a deed repair operation.
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role='replica'`;
   await tx`update bases set deed_asset_id=${f.player.wallet},deed_mint_asset_id=null where id=${f.base.id}`;
   await tx`set local session_replication_role='origin'`;
  });
  const before={parents:await parents(f),histories:await histories(),money:await money()};
  await expect(admitShardsObstacleObligation(db,f.player.wallet,f.command,f.context,{clock:()=>start})).rejects.toThrow();
  expect(await readShardsObstacleObligation(db,f.player.wallet,f.command.idempotencyKey)).toBeNull();
  expect({parents:await parents(f),histories:await histories(),money:await money()}).toEqual(before);
 });
});
