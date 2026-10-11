/** CI cluster C regression (2026-10-10, migration 0301). The owner's mining
 * coverage initializers legitimately ENABLE eleven capture triggers on
 * accounts and the ledger. In production they run after the Phase E seals were
 * taken; before 0301 that flipped the sealed retirement fingerprint and every
 * guarded Phase E path (Divine fragments, advanced returns, raid capture,
 * crafting runtime) failed closed for players. These tests pin the rule: the
 * coverage transition keeps every source valid, while any trigger change that
 * the coverage rows do not explain still fails closed. Each database here is
 * owned by this file and dropped at the end. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {afterAll,afterEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {initializeFreeCohortCoverage} from '../src/mining/freeCohort';
import {initializeFreeGemsEvidence} from '../src/mining/freeGemsEvidence';
import {initializeGemsFlowEvidence} from '../src/mining/gemsFlowEvidence';
import {ADMIN_DATABASE_URL} from './db-url';

type Conn=ReturnType<typeof createDb>;
const MIGRATIONS=fileURLToPath(new URL('../drizzle',import.meta.url));
const FIX='0301_retirement_coverage_activation';
// The eleven triggers 0161/0166/0179 create DISABLED and the coverage inserts enable.
const GOVERNED=['accounts.accounts_mining_free_attribution','accounts.accounts_mining_gems_flow_capture','accounts.accounts_mining_gems_flow_truncate',
 'ledger_entries.ledger_entries_mining_free_capture','ledger_entries.ledger_entries_mining_free_gems_capture','ledger_entries.ledger_entries_mining_free_truncate',
 'ledger_entries.ledger_entries_mining_gems_flow_capture','ledger_entries.ledger_entries_mining_gems_flow_truncate',
 'ledger_transactions.ledger_transactions_mining_free_attribution','ledger_transactions.ledger_transactions_mining_gems_flow_capture',
 'ledger_transactions.ledger_transactions_mining_gems_flow_truncate'];
const ALL_VALID={visual:true,wake:true,ret:true,starter:true,advanced:true,coverage:true};

const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});
const owned:{name:string;conn:Conn}[]=[];
async function ownedDatabase():Promise<Conn>{
 const name=`retirement_coverage_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('retirement coverage fixture requires a local owned database');
 await admin.unsafe(`create database ${name}`);const conn=createDb(url.toString(),{max:2});owned.push({name,conn});return conn;
}
afterEach(()=>{vi.unstubAllEnvs();});
afterAll(async()=>{
 for(const {name,conn} of owned){await conn.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);}
 await admin.end();
});

const sources=async(c:Conn)=>(await c.sql`select public.shardkeep_bound_cosmetic_visual_sources_valid() visual,
 public.shardkeep_bound_cosmetic_wake_sources_valid() wake,public.shardkeep_bound_cosmetic_return_sources_valid() ret,
 public.shardkeep_raid_starter_sources_valid() starter,public.shardkeep_raid_advanced_sources_valid() advanced,
 public.shardkeep_retirement_coverage_sources_valid() coverage`)[0];
const retirement=async(c:Conn)=>(await c.sql`select record->>'retirement' sealed,public.shardkeep_raid_starter_retirement_predecessor() live
 from public.bound_cosmetic_charter_contract where singleton`)[0]!;
const enablement=async(c:Conn)=>(await c.sql`select c.relname||'.'||t.tgname name,t.tgenabled::text state from pg_trigger t
 join pg_class c on c.oid=t.tgrelid where c.relnamespace='public'::regnamespace and (c.relname||'.'||t.tgname) in ${c.sql(GOVERNED)} order by 1`)
 .map(row=>[row.name,row.state]);
const states=(state:'D'|'O')=>GOVERNED.map(name=>[name,state]);
// The real owner initializers, in their production order; each is idempotent.
async function initializeCoverage(c:Conn){
 vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 await initializeFreeCohortCoverage(c.db);await initializeFreeGemsEvidence(c.db);await initializeGemsFlowEvidence(c.db);
}
// A rolled-back change the coverage rows do not explain must break the
// retirement fingerprint and close the Divine source guard.
async function failsClosed(c:Conn,mutation:string){
 await expect(c.sql.begin(async tx=>{
  await tx.unsafe(mutation);
  const [changed]=await tx`select record->>'retirement' sealed,public.shardkeep_raid_starter_retirement_predecessor() live
   from public.bound_cosmetic_charter_contract where singleton`;
  expect(changed!.live).not.toBe(changed!.sealed);
  await tx`select public.shardkeep_divine_fragment_source()`;
 }),mutation).rejects.toMatchObject({message:'DIVINE_FRAGMENT_SOURCE'});
}

let fresh:Conn;
it('seals a fresh database with every coverage trigger disabled; enabling one without its coverage row still fails closed',async()=>{
 fresh=await ownedDatabase();await runMigrations(fresh.db);
 expect((await fresh.sql`select baseline from public.retirement_coverage_contract`)[0]!.baseline).toEqual({free:'D',freeGems:'D',gemsFlow:'D'});
 expect(await enablement(fresh)).toEqual(states('D'));
 expect(await sources(fresh)).toEqual(ALL_VALID);
 await fresh.sql`select public.shardkeep_divine_fragment_source()`;
 for(const mutation of ['alter table public.ledger_entries enable trigger ledger_entries_mining_free_capture',
  'alter table public.accounts enable trigger accounts_mining_gems_flow_capture'])await failsClosed(fresh,mutation);
 expect(await sources(fresh)).toEqual(ALL_VALID);
},300_000);

it('owner coverage initialisation after the Phase E seals keeps Divine, wake, return and raid sources valid',async()=>{
 await initializeCoverage(fresh);
 expect(await enablement(fresh)).toEqual(states('O'));
 const fingerprint=await retirement(fresh);expect(fingerprint.live).toBe(fingerprint.sealed);
 expect(await sources(fresh)).toEqual(ALL_VALID);
 await fresh.sql`select public.shardkeep_divine_fragment_source(),public.shardkeep_charter_retirement_source()`;
},300_000);

it('after coverage, disabling a charter, ledger or raid trigger or an activated capture trigger still fails closed',async()=>{
 await initializeCoverage(fresh);expect(await enablement(fresh)).toEqual(states('O'));
 for(const mutation of ['alter table public.raids disable trigger raids_clan_charter_capture',
  'alter table public.ledger_entries disable trigger ledger_entries_charter_terminal_capture',
  'alter table public.accounts disable trigger accounts_mining_gems_flow_capture',
  'alter table public.ledger_entries enable always trigger ledger_entries_mining_free_gems_capture'])await failsClosed(fresh,mutation);
 // The sealed-time vector cannot be rewritten to match the new state.
 await expect(fresh.sql`update public.retirement_coverage_contract set baseline='{"free":"O","freeGems":"O","gemsFlow":"O"}'`)
  .rejects.toThrow('RETIREMENT_COVERAGE_SEAL_IMMUTABLE');
 await failsClosed(fresh,`set local session_replication_role=replica;
  update public.retirement_coverage_contract set baseline='{"free":"O","freeGems":"O","gemsFlow":"O"}';
  set local session_replication_role=origin`);
 expect(await sources(fresh)).toEqual(ALL_VALID);
},300_000);

it('repairs a database whose coverage was initialised after the seals but before 0301, and refuses any other drift',async()=>{
 const before=await ownedDatabase(),folder=await mkdtemp(join(tmpdir(),'retirement-coverage-journal-'));
 try{
  await cp(MIGRATIONS,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8'));
  const fix=journal.entries.findIndex((e:{tag:string})=>e.tag===FIX);expect(fix).toBeGreaterThan(0);
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,fix)}));
  await runMigrations(before.db,{migrationsFolder:folder});
 }finally{await rm(folder,{recursive:true,force:true});}
 // The production defect this migration repairs: without it, coverage closes Phase E.
 await initializeCoverage(before);
 expect((await before.sql`select public.shardkeep_bound_cosmetic_visual_sources_valid() visual,
  public.shardkeep_bound_cosmetic_wake_sources_valid() wake`)[0]).toEqual({visual:false,wake:false});
 await expect(before.sql`select public.shardkeep_divine_fragment_source()`).rejects.toMatchObject({message:'DIVINE_FRAGMENT_SOURCE'});
 // Drift that coverage does not explain finds no sealed-time vector.
 const body=await readFile(join(MIGRATIONS,`${FIX}.sql`),'utf8');
 await expect(before.sql.begin(async tx=>{
  await tx.unsafe('alter table public.raids disable trigger raids_clan_charter_capture');
  for(const part of body.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);
 })).rejects.toThrow('RETIREMENT_COVERAGE_PREDECESSOR');
 await runMigrations(before.db);
 expect((await before.sql`select baseline from public.retirement_coverage_contract`)[0]!.baseline).toEqual({free:'D',freeGems:'D',gemsFlow:'D'});
 expect(await enablement(before)).toEqual(states('O'));
 expect(await sources(before)).toEqual(ALL_VALID);
 await before.sql`select public.shardkeep_divine_fragment_source(),public.shardkeep_charter_retirement_source()`;
},600_000);
