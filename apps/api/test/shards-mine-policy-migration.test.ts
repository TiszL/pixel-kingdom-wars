/** A future policy boundary may classify only the locked original Mine state. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../src/ledger';
const owner=resourceClaimsDatabase(),root=fileURLToPath(new URL('../drizzle',import.meta.url));
const boundary='2038-01-02T00:00:00.000Z',anchor='2038-01-01T00:00:00.000Z',at='2038-01-03T00:00:00.000Z';
type Tx=postgres.TransactionSql;
beforeAll(()=>owner.setup(),120_000);
afterAll(()=>owner.close());
async function rollback(work:(tx:Tx)=>Promise<void>){
 const sentinel=Error('fixture rollback');
 try{await owner.sql.begin(async tx=>{await work(tx);throw sentinel;});}catch(e){if(e!==sentinel)throw e;}
}
async function mine(tx:Tx,amount='7',time=anchor){
 const wallet=randomUUID(),base=randomUUID(),id=randomUUID();
 await tx`insert into players(wallet) values(${wallet})`;
 await tx`insert into bases(id,owner_wallet) values(${base},${wallet})`;
 // Production bases carry their owner's active slot. Without it the D153.235/238
 // capture refuses any raid defending this base before the Mine policy guard runs.
 await tx`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
 await tx`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${id},${wallet},${base},'mine',0,0)`;
 await tx`insert into mine_accrual_states(mine_building_id,accrued_shards,last_accrual_at) values(${id},${amount},${time})`;
 return {wallet,base,id};
}
async function activate(tx:Tx){await tx`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${boundary})`;}
async function era(tx:Tx,f:Awaited<ReturnType<typeof mine>>,changes:Record<string,unknown>={}){
 const row={mine_id:f.id,base_id:f.base,admitted_at:at,legacy_gross:'7',policy_boundary_id:1,
  initialization_kind:'locked_pre_policy_state',source_state_version:0,source_anchor_at:anchor,build_job_id:null,production_started_at:null,...changes};
 await tx`insert into shards_mine_eras select * from jsonb_populate_record(null::shards_mine_eras,${JSON.stringify(row)}::jsonb)`;
}
it('installs no policy or backfilled Mine eras',async()=>{
 expect(await owner.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
 expect(await owner.sql`select * from shards_mine_eras`).toHaveLength(0);
});
it('uses database recording time and refuses retroactive, submillisecond or unsupported policy boundaries',async()=>{
 await rollback(async tx=>{
  await tx`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at,recorded_at) values(1,1,1,1,${boundary},'1900-01-01')`;
  expect(await tx`select recorded_at>'2026-01-01'::timestamptz fresh,effective_at>=recorded_at prospective from shards_mine_policy_boundary`).toEqual([{fresh:true,prospective:true}]);
 });
 for(const value of ['1900-01-01','2038-01-02T00:00:00.000001Z','infinity'])await expect(rollback(async tx=>{
  await tx`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${value})`;
 })).rejects.toThrow('SHARDS_MINE_POLICY_BOUNDARY');
 for(const column of ['id','version','policy_version','tax_table_version'])await expect(rollback(async tx=>{
  const row={id:1,version:1,policy_version:1,tax_table_version:1,effective_at:boundary,[column]:2};
  await tx`insert into shards_mine_policy_boundary select * from jsonb_populate_record(null::shards_mine_policy_boundary,${JSON.stringify(row)}::jsonb)`;
 })).rejects.toThrow();
});
it('keeps the absent-policy legacy path and refuses activation over an existing era',async()=>{
 await expect(rollback(async tx=>{
  const f=await mine(tx);await tx`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${f.id},${f.base},${at},7)`;
  expect(await tx`select policy_boundary_id from shards_mine_eras where mine_id=${f.id}`).toEqual([{policy_boundary_id:null}]);
  await activate(tx);
 })).rejects.toThrow('SHARDS_MINE_POLICY_EXISTING_ERAS');
});
it('refuses unresolved pre-policy raid custody at activation and per-Mine initialization',async()=>{
 for(const before of [true,false])await expect(rollback(async tx=>{
  if(!before)await activate(tx);
  const f=await mine(tx),raid=randomUUID();
  await tx`insert into raids(id,attacker_wallet,attacker_base_id,defender_wallet,defender_base_id,seed,snapshot,army_snapshot,orders_deadline_at) values(${raid},${f.wallet},${f.base},${f.wallet},${f.base},1,'{}','{}',${at})`;
  await tx`insert into raid_loot_reservations(raid_id,formula_version,attacker_base_id,defender_base_id,mine_reserved_shards,private_snapshot_hash) values(${raid},1,${f.base},${f.base},7,${'ab'.repeat(32)})`;
  await tx`insert into raid_mine_loot_reservations(raid_id,mine_building_id,frozen_shards) values(${raid},${f.id},7)`;
  if(before)await activate(tx);else await era(tx,f);
 })).rejects.toThrow('SHARDS_MINE_POLICY_UNMANAGED_RAID');
});
it('rejects era and boundary creation from snapshots that can hide a concurrent activation',async()=>{
 const conn=resourceClaimsDatabase();
 try{
  await conn.setup();
  // Create the source under RC first: global Charter guards now reject base
  // creation under stale isolation before the Mine-specific guard can run.
  const f=await conn.sql.begin(async tx=>mine(tx));
  for(const isolation of ['REPEATABLE READ','SERIALIZABLE'])for(const createBoundary of [true,false])await expect(conn.sql.begin(async tx=>{
   await tx.unsafe('SET TRANSACTION ISOLATION LEVEL '+isolation);
   if(createBoundary)await activate(tx);
   else await tx`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${f.id},${f.base},${at},7)`;
  })).rejects.toMatchObject({code:'P0001',message:'SHARDS_MINE_POLICY_ISOLATION'});
  expect(await conn.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
  expect(await conn.sql`select * from shards_mine_eras`).toHaveLength(0);
 }finally{await conn.close();}
});
it('makes a concurrent legacy era writer observe the policy committed while it waited for the activation lock',async()=>{
 const conn=resourceClaimsDatabase(),other=conn.reopen();let release=()=>{},boundaryReady=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{boundaryReady=resolve;});
 let activation:Promise<unknown>|undefined,writer:Promise<unknown>|undefined;
 try{
  await conn.setup();const f=await conn.sql.begin(async tx=>mine(tx));
  activation=conn.sql.begin(async tx=>{await activate(tx);boundaryReady();await gate;});await ready;
  writer=other.sql.unsafe('/* mine_policy_race */ insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values($1,$2,$3,7)',[f.id,f.base,at]).then(()=>({accepted:true}),error=>error);
  await expect.poll(async()=>{
   const [r]=await conn.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and query like '/* mine_policy_race */%' and wait_event_type='Lock') blocked`;return r!.blocked;
  }).toBe(true);
  release();await activation;expect(await writer).toMatchObject({message:'SHARDS_MINE_POLICY_PROVENANCE'});
  expect(await conn.sql`select * from shards_mine_eras`).toHaveLength(0);
 }finally{release();await Promise.allSettled([activation,writer]);await other.sql.end();await conn.close();}
},120_000);
it('binds an opening era to the locked Mine buffer, version, anchor and base',async()=>{
 await rollback(async tx=>{await activate(tx);const f=await mine(tx);await era(tx,f);expect(await tx`select legacy_gross::text from shards_mine_eras`).toEqual([{legacy_gross:'7'}]);});
 for(const changes of [{legacy_gross:'8'},{source_state_version:1},{source_anchor_at:boundary},{base_id:randomUUID()},
  {policy_boundary_id:null,initialization_kind:null,source_state_version:null,source_anchor_at:null},
  {initialization_kind:null},{build_job_id:randomUUID()}])await expect(rollback(async tx=>{await activate(tx);await era(tx,await mine(tx),changes);})).rejects.toThrow('SHARDS_MINE_POLICY');
 // Equality is ambiguous: that buffer can already contain a unit earned at B.
 await expect(rollback(async tx=>{await activate(tx);const f=await mine(tx,'7',boundary);await era(tx,f,{source_anchor_at:boundary});})).rejects.toThrow('SHARDS_MINE_POLICY');
});
it('requires a real scheduled Mine build and an empty exact opening state for fresh provenance',async()=>{
 async function run(change:Record<string,unknown>={}){await rollback(async tx=>{
  await activate(tx);const f=await mine(tx,'0',boundary),job=randomUUID();
  await tx`insert into builder_jobs(id,player_wallet,base_id,kind,building_id,started_at,finishes_at) values(${job},${f.wallet},${f.base},'build',${f.id},${anchor},${boundary})`;
  await era(tx,f,{legacy_gross:'0',source_anchor_at:boundary,initialization_kind:'fresh_scheduled_build',build_job_id:job,production_started_at:boundary,...change});
 });}
 await run();
 for(const change of [{legacy_gross:'1'},{build_job_id:randomUUID()},{production_started_at:at},{source_state_version:1},{source_anchor_at:anchor}])await expect(run(change)).rejects.toThrow('SHARDS_MINE_POLICY');
});
it('keeps the boundary and era provenance immutable against update, delete and truncate',async()=>{
 for(const query of ['update shards_mine_policy_boundary set version=version','delete from shards_mine_policy_boundary','truncate shards_mine_policy_boundary cascade',
  'update shards_mine_eras set source_state_version=source_state_version','delete from shards_mine_eras','truncate shards_mine_eras cascade']){
  await expect(rollback(async tx=>{await activate(tx);await era(tx,await mine(tx));await tx.unsafe(query);})).rejects.toThrow('IMMUTABLE');
 }
});
it('lets an old runtime LOGIN read public policy timing while refusing to let it choose the boundary',async()=>{
 const owner=resourceClaimsDatabase();await owner.setup();
 const role=`mine_policy_${randomUUID().replaceAll('-','')}`,password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined,created=false;
 try{
  const [database]=await owner.sql`select current_database() name`;
  await owner.sql.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);created=true;
  await owner.sql.unsafe(`GRANT CONNECT ON DATABASE ${database!.name} TO ${role};GRANT USAGE ON SCHEMA public TO ${role};GRANT SELECT,INSERT ON shards_mine_eras TO ${role}`);
  const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
  expect(await runtime.sql`select current_user u,session_user s`).toEqual([{u:role,s:role}]);
  // Normal Mine lifecycle reads this public, wallet-free timing even while
  // dark. Existing runtime roles need no new private-history grants to do so.
  expect(await runtime.sql`select has_table_privilege(current_user,'public.shards_mine_policy_boundary','SELECT') allowed`).toEqual([{allowed:true}]);
  expect(await runtime.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
  await expect(runtime.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${boundary})`).rejects.toMatchObject({code:'42501'});
  const f=await owner.sql.begin(async tx=>mine(tx));
  const sentinel=Error('old role rollback');
  await expect(runtime.sql.begin(async tx=>{
   await tx`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${f.id},${f.base},${at},7)`;
   expect(await tx`select mine_id from shards_mine_eras where mine_id=${f.id}`).toEqual([{mine_id:f.id}]);throw sentinel;
  })).rejects.toBe(sentinel);
  for(const hook of ['shardkeep_shards_mine_policy_boundary_guard','shardkeep_shards_mine_policy_era_guard']){
   expect(await runtime.sql`select has_function_privilege(current_user,${'public.'+hook+'()'},'EXECUTE') allowed`).toEqual([{allowed:false}]);
   await expect(runtime.sql.unsafe(`select public.${hook}()`)).rejects.toMatchObject({code:'42501'});
  }
  await owner.sql.begin(async tx=>activate(tx));
  expect(await runtime.sql`select id,version,policy_version,tax_table_version,effective_at=${boundary}::timestamptz exact_effective_at from shards_mine_policy_boundary`)
   .toEqual([{id:1,version:1,policy_version:1,tax_table_version:1,exact_effective_at:true}]);
  await owner.sql.unsafe(`GRANT INSERT ON shards_mine_policy_boundary TO ${role}`);
  await expect(runtime.sql`insert into shards_mine_policy_boundary(id,version,policy_version,tax_table_version,effective_at) values(1,1,1,1,${boundary})`).rejects.toMatchObject({code:'42501',message:'SHARDS_MINE_POLICY_OWNER_REQUIRED'});
 }finally{await runtime?.sql.end();try{if(created){await owner.sql.unsafe(`DROP OWNED BY ${role}`);await owner.sql.unsafe(`DROP ROLE ${role}`);}}finally{await owner.close();}}
});
it('upgrades and repeats without changing original era or ledger values and table identities',async()=>{
 const name=`mine_policy_upgrade_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),folder=await mkdtemp(path.join(tmpdir(),'phase-e-mine-policy-upgrade-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  const all=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  const index=all.entries.findIndex(e=>e.tag==='0200_shards_mine_policy_boundary');expect(index).toBeGreaterThan(0);
  const journal={...all,entries:all.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const e of journal.entries)await copyFile(path.join(root,e.tag+'.sql'),path.join(folder,e.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  const f=await conn.sql.begin(async tx=>{const f=await mine(tx);await tx`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${f.id},${f.base},${at},7)`;return f;});
  const system=await bootstrapSystemAccounts(conn.db),account=await getOrCreateBaseAccount(conn.db,f.base,'base_shards');
  await postTransaction(conn.db,{idempotencyKey:randomUUID(),type:'test.mine.policy.upgrade',entries:[{account:system.shard_genesis,delta:-7n},{account:account.id,delta:7n}]});
  const tables=['mine_accrual_states','ledger_transactions','ledger_entries'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,{oid:(await conn!.sql`select ${t}::regclass::oid::text oid`)[0]!.oid,rows:await conn!.sql.unsafe(`select to_jsonb(t)::text value from ${t} t order by to_jsonb(t)::text`)}])));
  const before=await snapshot(),eras=await conn.sql`select mine_id,base_id,admitted_at,legacy_gross from shards_mine_eras`;
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  for(let pass=0;pass<2;pass++)for(const statement of (await readFile(path.join(root,'0200_shards_mine_policy_boundary.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);expect(await conn.sql`select mine_id,base_id,admitted_at,legacy_gross from shards_mine_eras`).toEqual(eras);
  expect(await conn.sql`select policy_boundary_id,initialization_kind,source_state_version,source_anchor_at,build_job_id,production_started_at from shards_mine_eras`).toEqual([{policy_boundary_id:null,initialization_kind:null,source_state_version:null,source_anchor_at:null,build_job_id:null,production_started_at:null}]);
  expect(await conn.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);

it('refuses busy provenance rows without blocking behind pool-handle completion lock order',async()=>{
 const conn=resourceClaimsDatabase(),other=conn.reopen();
 try{
  await conn.setup();await conn.sql.begin(async tx=>activate(tx));
  for(const target of ['building','state','job'] as const){
   const f=await conn.sql.begin(async tx=>{
    const f=await mine(tx,'0',boundary),job=randomUUID();
    await tx`insert into builder_jobs(id,player_wallet,base_id,kind,building_id,started_at,finishes_at)
      values(${job},${f.wallet},${f.base},'build',${f.id},${anchor},${boundary})`;
    return {...f,job};
   });
   let release=()=>{},notify=()=>{};
   const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{notify=resolve;});
   const locker=conn.sql.begin(async tx=>{
    if(target==='building')await tx`select id from buildings where id=${f.id} for update`;
    else if(target==='state')await tx`select mine_building_id from mine_accrual_states where mine_building_id=${f.id} for update`;
    else await tx`select id from builder_jobs where id=${f.job} for update`;
    notify();await gate;
   });
   const provenance={legacy_gross:'0',source_anchor_at:boundary,initialization_kind:'fresh_scheduled_build',
    build_job_id:f.job,production_started_at:boundary};
   try{
    await ready;
    // A blocking lock would hit57014 instead: the intended refusal is NOWAIT55P03.
    await expect(other.sql.begin(async tx=>{
     await tx`set local statement_timeout='500ms'`;
     await era(tx,f,provenance);
    })).rejects.toMatchObject({code:'55P03'});
    expect(await conn.sql`select * from shards_mine_eras where mine_id=${f.id}`).toHaveLength(0);
   }finally{release();await locker;}
   await other.sql.begin(async tx=>era(tx,f,provenance));
   expect(await conn.sql`select mine_id from shards_mine_eras where mine_id=${f.id}`).toHaveLength(1);
  }
 }finally{await other.sql.end();await conn.close();}
},120_000);
