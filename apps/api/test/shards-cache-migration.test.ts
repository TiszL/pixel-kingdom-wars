import {seedHistoricalTaxedCache} from './fixtures/historicalTaxedCache';
/** Cache schema preserves old money/source rows and serializes a mixed-source prefix. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {afterEach,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {DAILY_CACHE} from '@shardkeep/shared';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createShardsHistoryFixture} from './fixtures/shardsTaxHistory';
import {reanchorBaseMineAccrual,MINE_DAY_MS} from '../src/game/baseMining';
import {admitPhysicalMineTaxSources} from '../src/mining/shardsTaxMineSources';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {buildings,mineAccrualStates} from '../src/db/schema';
import {issueHistoricalShardsCache} from './fixtures/historicalTaxedCache';
import {bootstrapSystemAccounts,getOrCreateBaseAccount,postTransaction} from '../src/ledger';
const root=fileURLToPath(new URL('../drizzle',import.meta.url));
afterEach(()=>vi.unstubAllEnvs());
function enable(){vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');}
// Fixture-only compatibility for today's source writer at an older migration
// frontier. It is dropped BEFORE taking the pre-upgrade schema/data snapshot.
const mineOnlyView=`CREATE VIEW shards_tax_all_assessments AS SELECT operation_key,segment_id::text AS segment_id,wallet,wallet_sequence,lineage,gross,net,tax,carry_before,carry_after,term_id,term_hash,ledger_id,receipt,'physical_mine'::text AS source_kind FROM shards_tax_assessments`;

it('upgrades the funded pre-cache frontier without money/source backfill and repeats with stable identities',async()=>{
 const name=`shards_cache_upgrade_${randomUUID().replaceAll('-','')}_test`,admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 const folder=await mkdtemp(path.join(tmpdir(),'phase-e-cache-upgrade-'));let conn:ReturnType<typeof createDb>|undefined;
 try{
  const full=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{idx:number;tag:string;when:number}[]};
  const index=full.entries.findIndex(e=>e.tag==='0195_shards_cache_sources');expect(index).toBeGreaterThan(0);
  const journal={...full,entries:full.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));for(const e of journal.entries)await copyFile(path.join(root,e.tag+'.sql'),path.join(folder,e.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-1)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  // This historical frontier has no obstacle captures. Supply only the absent
  // pending predicate for today's Mine writer, then drop it before the snapshot.
  await conn.sql.unsafe(`CREATE FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz) RETURNS boolean LANGUAGE sql VOLATILE AS 'SELECT false'`);
  // Today's writer probes the later, uninstalled Mine boundary. This empty
  // fixture-only relation is also removed before measuring the old frontier.
  await conn.sql.unsafe(`CREATE VIEW shards_mine_policy_boundary AS SELECT 1::integer id,NULL::timestamptz effective_at WHERE false`);
  await conn.sql.unsafe('ALTER TABLE shards_mine_eras ADD COLUMN policy_boundary_id integer');
  // Current Drizzle/source reads name the later0232 remainder column. NULL
  // preserves legacy accrual; remove it before testing the actual old schema.
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states ADD COLUMN production_remainder bigint');

  enable();await conn.sql.unsafe(mineOnlyView);const f=await createShardsHistoryFixture(conn.db,{legacy:7n});await f.collect();await conn.sql.unsafe('DROP VIEW shards_tax_all_assessments');await conn.sql.unsafe('DROP VIEW shards_mine_policy_boundary');await conn.sql.unsafe('ALTER TABLE shards_mine_eras DROP COLUMN policy_boundary_id');await conn.sql.unsafe('DROP FUNCTION public.shardkeep_shards_obstacle_pending(text,timestamptz)');
  expect(await conn.sql`select production_remainder from mine_accrual_states`).toEqual([{production_remainder:null}]);
  await conn.sql.unsafe('ALTER TABLE mine_accrual_states DROP COLUMN production_remainder');
  const sql=conn.sql,tables=['accounts','deposits','withdrawals','ledger_transactions','ledger_entries','mine_accrual_states','shards_mine_admissions','shards_mine_eras','shards_mine_segments','shards_mine_deliveries','shards_tax_assessments','seeker_shards_claims'];
  const remainderColumns=()=>sql`select column_name from information_schema.columns where table_schema='public' and table_name='mine_accrual_states' and column_name='production_remainder'`;
  expect(await remainderColumns()).toEqual([]);
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async t=>[t,{oid:(await sql`select ${t}::regclass::oid::text oid`)[0]!.oid,rows:await sql.unsafe(`select to_jsonb(t)::text value from ${t} t order by to_jsonb(t)::text`)}])));
  const before=await snapshot(),enumBefore=await sql`select oid::text from pg_type where typname='account_kind'`;
  const [pool]=await sql`select sum(tax)::text amount from shards_tax_assessments where term_id=${f.termId}`;
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  for(let pass=0;pass<2;pass++)for(const statement of (await readFile(path.join(root,'0195_shards_cache_sources.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await sql.unsafe(statement);
  expect(await snapshot()).toEqual(before);expect(await sql`select oid::text from pg_type where typname='account_kind'`).toEqual(enumBefore);
  expect(await remainderColumns()).toEqual([]);
  expect(await sql`select count(*)::int n from shards_cache_sources`).toEqual([{n:0}]);expect(await sql`select count(*)::int n from shards_cache_assessments`).toEqual([{n:0}]);
  expect(await readCompleteShardsTaxPool(conn.db,f.termId,f.termHash)).toBe(BigInt(pool!.amount));
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);

it('preserves every Seeker payout guard check while changing only its complete pool relation',async()=>{
 const old=await readFile(path.join(root,'0193_seeker_shards_claims.sql'),'utf8'),next=await readFile(path.join(root,'0195_shards_cache_sources.sql'),'utf8');
 const extract=(s:string)=>s.slice(s.indexOf('CREATE OR REPLACE FUNCTION public.shardkeep_seeker_shards_claim_guard()')).split('END $$;')[0]+'END $$;';
 expect(extract(next)).toBe(extract(old).replace('FROM public.shards_tax_assessments WHERE term_id=NEW.term_id','FROM public.shards_tax_all_assessments WHERE term_id=NEW.term_id'));
});

it('checks mixed Mine/cache SQL sequence, arithmetic and source binding and keeps both histories immutable',async()=>{
 const conn=resourceClaimsDatabase();try{
  await conn.setup();enable();const f=await createShardsHistoryFixture(conn.db),at=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota)));
  await f.collect(at);await seedHistoricalTaxedCache(conn.db,f.player.wallet,{...f.context,shardsCacheSource:{clock:()=>at,prefetch:async()=>({readOperatingTerm:async()=>({...f.observation,finality:{...f.observation.finality,observedAt:at.toISOString()}})})}},at);
  const [assessment]=await conn.sql`select to_jsonb(t) value from shards_cache_assessments t where wallet=${f.player.wallet}`;
  // Remove only the tested row under fixture authority, then restore origin
  // triggers before its replacement. Failure at COMMIT must restore the row.
  async function rejected(change:(a:any)=>void,message:string){
   const replacement=structuredClone(assessment!.value);change(replacement);
   await expect(conn.sql.begin(async tx=>{
    await tx`set local session_replication_role='replica'`;await tx`delete from shards_cache_assessments where operation_key=${replacement.operation_key}`;await tx`set local session_replication_role='origin'`;
    await tx`insert into shards_cache_assessments select * from jsonb_populate_record(null::shards_cache_assessments,${JSON.stringify(replacement)}::jsonb)`;
   })).rejects.toThrow(message);
   expect(await conn.sql`select to_jsonb(t) value from shards_cache_assessments t where wallet=${f.player.wallet}`).toEqual([assessment]);
  }
  await rejected(a=>{a.wallet_sequence='1';a.receipt.carryBefore.sequence='0';a.receipt.carryAfter.sequence='1';},'SHARDS_TAX_SEQUENCE_DUPLICATE');
  await rejected(a=>{a.wallet_sequence='4';a.receipt.carryBefore.sequence='3';a.receipt.carryAfter.sequence='4';},'SHARDS_TAX_CARRY_ORDER');
  await rejected(a=>{a.carry_before='0';a.carry_after='0';a.receipt.carryBefore.value='0';a.receipt.carryAfter.value='0';},'SHARDS_TAX_CARRY_ORDER');
  await rejected(a=>{a.tax='0';},'SHARDS_TAX_ARITHMETIC');
  await rejected(a=>{a.receipt.source.baseId=randomUUID();},'SHARDS_CACHE_ASSESSMENT_SOURCE');
  for(const table of ['shards_cache_sources','shards_cache_assessments']){
   await expect(conn.sql.unsafe(`UPDATE ${table} SET wallet=wallet`)).rejects.toThrow('IMMUTABLE');
   await expect(conn.sql.unsafe(`DELETE FROM ${table}`)).rejects.toThrow('IMMUTABLE');
   await expect(conn.sql.unsafe(`TRUNCATE ${table} CASCADE`)).rejects.toThrow('IMMUTABLE');
  }
 }finally{await conn.close();}
},120_000);

it('allows globally ordered Mine source parts to be inserted in per-Mine ledger groups',async()=>{
 const conn=resourceClaimsDatabase();try{
  await conn.setup();enable();const f=await createShardsHistoryFixture(conn.db);
  const [second]=await conn.db.insert(buildings).values({playerWallet:f.player.wallet,baseId:f.base.id,type:'mine',level:1,tx:2,ty:1}).returning();
  await conn.db.insert(mineAccrualStates).values({mineBuildingId:second!.id,lastAccrualAt:f.start,accruedShards:0n});
  await admitPhysicalMineTaxSources(conn.db,f.player.wallet,{idempotencyKey:randomUUID(),baseId:f.base.id},f.context,{clock:()=>f.start,reader:{readOperatingTerm:async()=>f.observation}});
  const firstAt=new Date(+f.start+Math.ceil(3*MINE_DAY_MS/Number(f.quota))),secondAt=new Date(+firstAt+Math.ceil(2*MINE_DAY_MS/Number(f.quota)));
  await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,firstAt));await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,secondAt));
  expect((await f.collect(secondAt)).amount).toBe(8n);
  const rows=await conn.sql`select a.wallet_sequence,s.mine_id from shards_tax_all_assessments a join shards_mine_segments s on s.id::text=a.segment_id where a.wallet=${f.player.wallet} order by a.wallet_sequence`;
  expect(rows.map(r=>BigInt(r.wallet_sequence))).toEqual([1n,2n,3n,4n]);expect(new Set(rows.slice(0,2).map(r=>r.mine_id)).size).toBe(2);
  expect(await readCompleteShardsTaxPool(conn.db,f.termId,f.termHash)).toBe(2n);
 }finally{await conn.close();}
},120_000);

it('serializes direct Mine/cache sequence collisions and rolls back the losing cache source and ledger',async()=>{
 const conn=resourceClaimsDatabase(),other=conn.reopen();let release=()=>{};
 let winner:Promise<unknown>|undefined,loser:Promise<unknown>|undefined;
 try{
  await conn.setup();enable();const f=await createShardsHistoryFixture(conn.db),gross=BigInt(DAILY_CACHE.firstWeekStepShards);
  const at=new Date(+f.start+Math.ceil(Number(gross)*MINE_DAY_MS/Number(f.quota)));
  await f.collect(at);
  const [mine]=await conn.sql`select to_jsonb(a) value from shards_tax_assessments a where wallet=${f.player.wallet}`;
  expect(BigInt(mine!.value.gross)).toBe(gross);expect(BigInt(mine!.value.carry_after)).toBe(0n);
  let source:any,assessment:any;
  const rollback=new Error('rollback valid cache candidate');
  // Obtain a real valid source/receipt without committing its money or history.
  // The two direct inserts below bypass service player/base serialization.
  await expect(conn.db.transaction(async tx=>{
   await issueHistoricalShardsCache(tx,{baseId:f.base.id,wallet:f.player.wallet,earnedAt:at.toISOString(),day:at.toISOString().slice(0,10),
    streakDays:1,everCompletedWeek1Before:false,gross:gross.toString()},f.observation);
   const [s]=await tx.execute(sql`select to_jsonb(s) value from shards_cache_sources s where wallet=${f.player.wallet}`);
   const [a]=await tx.execute(sql`select to_jsonb(a) value from shards_cache_assessments a where wallet=${f.player.wallet}`);
   source=s!.value;assessment=a!.value;throw rollback;
  })).rejects.toBe(rollback);
  assessment.wallet_sequence='1';assessment.receipt.carryBefore.sequence='0';assessment.receipt.carryAfter.sequence='1';
  expect(BigInt(assessment.carry_before)).toBe(0n);
  // Only this isolated fixture's original assessment is removed. Restore all
  // triggers before competing inserts; the original Mine source remains valid.
  await conn.sql.begin(async tx=>{
   await tx`set local session_replication_role='replica'`;
   await tx`delete from shards_tax_assessments where wallet=${f.player.wallet}`;
   await tx`set local session_replication_role='origin'`;
  });
  const balances=()=>conn.sql`select id,balance::text from accounts order by id`;
  const before=await balances();
  let signalWinner!:(pid:number)=>void,signalLoser!:(pid:number)=>void;
  const winnerReady=new Promise<number>(resolve=>{signalWinner=resolve;}),loserReady=new Promise<number>(resolve=>{signalLoser=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  winner=conn.sql.begin(async tx=>{
   await tx`insert into shards_tax_assessments select * from jsonb_populate_record(null::shards_tax_assessments,${JSON.stringify(mine!.value)}::jsonb)`;
   const [pid]=await tx`select pg_backend_pid() pid`;signalWinner(pid!.pid);await held;
  });
  const winnerPid=await winnerReady;
  // Attach rejection handling immediately while the losing query is pending.
  loser=other.db.transaction(async tx=>{
   const [pid]=await tx.execute(sql`select pg_backend_pid() pid`);signalLoser(Number(pid!.pid));
   const systems=await bootstrapSystemAccounts(tx),base=await getOrCreateBaseAccount(tx,f.base.id,'base_shards');
   const posted=await postTransaction(tx,{idempotencyKey:source.operation_key,type:'cache.claim',metadata:{baseId:f.base.id,day:source.day,streakDays:1},
    entries:[{account:systems.shard_genesis,delta:-gross},{account:base.id,delta:BigInt(assessment.net)},{account:systems.shards_tax_escrow,delta:BigInt(assessment.tax)}]});
   source.ledger_id=posted.transaction.id;assessment.ledger_id=posted.transaction.id;assessment.receipt.source.ledger.transactionId=posted.transaction.id;
   await tx.execute(sql`insert into shards_cache_sources select * from jsonb_populate_record(null::shards_cache_sources,${JSON.stringify(source)}::jsonb)`);
   await tx.execute(sql`insert into shards_cache_assessments select * from jsonb_populate_record(null::shards_cache_assessments,${JSON.stringify(assessment)}::jsonb)`);
  }).then(()=>null,error=>error);
  const loserPid=await loserReady;let blocked=false;const deadline=Date.now()+10_000;
  while(!blocked&&Date.now()<deadline){
   const [state]=await conn.sql`select ${winnerPid}::integer=any(pg_blocking_pids(${loserPid}::integer)) blocked,
    query like '%insert into shards_cache_assessments%' inserting from pg_stat_activity where pid=${loserPid}`;
   blocked=state?.blocked===true&&state?.inserting===true;
  }
  expect(blocked).toBe(true);release();await winner;
  const failure=await loser;
  expect(failure).not.toBeNull();
  const messages:string[]=[];for(let error:any=failure;error;error=error.cause)messages.push(String(error.message));
  expect(messages.join('\n')).toContain('SHARDS_TAX_SEQUENCE_DUPLICATE');
  expect(await conn.sql`select wallet_sequence::text,source_kind from shards_tax_all_assessments where wallet=${f.player.wallet}`).toEqual([{wallet_sequence:'1',source_kind:'physical_mine'}]);
  expect(await conn.sql`select operation_key from shards_cache_sources where wallet=${f.player.wallet}`).toHaveLength(0);
  expect(await conn.sql`select id from ledger_transactions where idempotency_key=${source.operation_key}`).toHaveLength(0);
  expect(await conn.sql`select id from ledger_entries where txn_id=${source.ledger_id}`).toHaveLength(0);
  expect(await balances()).toEqual(before);
  expect(await readCompleteShardsTaxPool(conn.db,f.termId,f.termHash)).toBe(BigInt(mine!.value.tax));
 }finally{release();await Promise.allSettled([...(winner?[winner]:[]),...(loser?[loser]:[])]);await other.sql.end();await conn.close();}
},120_000);
