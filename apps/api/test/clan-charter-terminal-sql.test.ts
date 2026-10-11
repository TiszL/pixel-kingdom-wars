import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {createDb,type DbOrTx} from '../src/db/client';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import {ADMIN_DATABASE_URL} from './db-url';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,defender:string,clan:string,att:string,def:string,pool:string;
const tables=['clan_charter_loot_posts','clan_charter_loot_entries','clan_charter_chest_updates','clan_charter_raid_terminals'];
const migration=new URL('../drizzle/0216_clan_charter_terminal_evidence.sql',import.meta.url);
beforeEach(async()=>{
 f=resourceClaimsDatabase();await f.setup();actor=randomUUID();defender=randomUUID();clan=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${defender})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${actor})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;
 const sys=await bootstrapSystemAccounts(f.db);pool=sys.clan_chest;att=(await getOrCreatePlayerAccount(f.db,actor,'player_shards')).id;def=(await getOrCreatePlayerAccount(f.db,defender,'player_shards')).id;
 await postTransaction(f.db,{type:'test.fund',idempotencyKey:randomUUID(),entries:[{account:sys.shard_genesis,delta:-10_000n},{account:def,delta:10_000n}]});
 await f.sql`select * from shardkeep_clan_charter_event_source_initialize()`;
},120_000);
afterEach(async()=>{await f?.close();},120_000);
async function raid(){const id=randomUUID();await f.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${id},${actor},${defender},1,'{}','{}',now())`;return id;}
async function post(db:DbOrTx,id:string,cut=10n){return postTransaction(db,{idempotencyKey:`raid:${id}:loot`,type:'raid.loot',entries:[{account:def,delta:-100n},{account:att,delta:100n-cut},{account:pool,delta:cut}],metadata:{raidId:id,attacker:actor,defender,clanChest:cut.toString()}});}
async function settle(id:string){return f.db.transaction(async tx=>{
 const p=await post(tx,id);await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${clan}`);
 await tx.execute(sql`update raids set status='resolving' where id=${id}`);await tx.execute(sql`update raids set status='resolved',resolved_at=now(),result='{}'::jsonb where id=${id}`);return p;
});}
async function snapshot(){return Promise.all(tables.map(t=>f.sql.unsafe(`select to_jsonb(w) value from ${t} w order by to_jsonb(w)::text`)));}

it('witnesses actual posting, chest destination and terminal transition in one full transaction',async()=>{
 const id=await raid(),p=await settle(id),[posting]=await f.sql`select * from clan_charter_loot_posts where raid_id=${id}`;
 expect(posting).toMatchObject({ledger_id:p.transaction.id,raid_id:id});
 const entries=await f.sql`select * from clan_charter_loot_entries where ledger_id=${p.transaction.id}`;expect(entries).toHaveLength(3);expect(entries.every(e=>e.tx_key===posting!.tx_key&&!('balance'in e.account_identity))).toBe(true);
 expect((await f.sql`select actual_clan_id,delta,pairing,ledger_id,tx_key from clan_charter_chest_updates`)[0]).toEqual({actual_clan_id:clan,delta:'10',pairing:'matched',ledger_id:p.transaction.id,tx_key:posting!.tx_key});
 expect((await f.sql`select terminal_status,tx_key,before_raid->>'status' before,after_raid->>'status' after from clan_charter_raid_terminals where raid_id=${id}`)[0]).toEqual({terminal_status:'resolved',tx_key:posting!.tx_key,before:'resolving',after:'resolved'});
 expect((await f.sql`select chest_shards from clans where id=${clan}`)[0]!.chest_shards).toBe('10');
});
it('records ambiguous equal postings and preserves an actual destination different from admission',async()=>{
 const a=await raid(),b=await raid(),actual=randomUUID();await f.sql`insert into clans(id,name,tag,leader_wallet) values(${actual},${actual},${actual},${defender})`;
 await f.db.transaction(async tx=>{const first=await post(tx,a),second=await post(tx,b);await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${actual}`);
  const [w]=await tx.execute(sql`select * from clan_charter_chest_updates`);expect(w).toMatchObject({actual_clan_id:actual,pairing:'ambiguous',ledger_id:null});expect((w!.candidate_ledger_ids as string[]).sort()).toEqual([first.transaction.id,second.transaction.id].sort());
 });
});
it('never launders a committed posting into a later chest update through no-op raw updates',async()=>{
 const id=await raid(),p=await post(f.db,id);await f.sql.begin(async tx=>{await tx`update ledger_transactions set type=type where id=${p.transaction.id}`;await tx`update ledger_entries set delta=delta where txn_id=${p.transaction.id}`;await tx`update clans set chest_shards=chest_shards+10 where id=${clan}`;});
 expect((await f.sql`select pairing,ledger_id,candidate_ledger_ids from clan_charter_chest_updates`)[0]).toEqual({pairing:'unmatched',ledger_id:null,candidate_ledger_ids:[]});
});
it('rolls back posting and chest witnesses together with the outer failed resolution',async()=>{
 const id=await raid(),before=await snapshot(),balance=await f.sql`select id,balance from accounts order by id`;
 await expect(f.db.transaction(async tx=>{await post(tx,id);await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${clan}`);await tx.execute(sql`update raids set status='resolving' where id=${id}`);await tx.execute(sql`update raids set status='resolved' where id=${id}`);throw Error('fixture rollback');})).rejects.toThrow('fixture rollback');
 expect(await snapshot()).toEqual(before);expect(await f.sql`select id,balance from accounts order by id`).toEqual(balance);
 await settle(id);expect(await f.sql`select * from clan_charter_chest_updates`).toHaveLength(1);
});
it('keeps all witnesses immutable and refuses copied trigger contexts or direct insertion',async()=>{
 const id=await raid();await settle(id);const before=await snapshot();
 for(const t of tables){await expect(f.sql.unsafe(`insert into ${t} select * from ${t}`)).rejects.toMatchObject({code:'42501'});await expect(f.sql.unsafe(`delete from ${t}`)).rejects.toThrow('CLAN_CHARTER_TERMINAL_IMMUTABLE');await expect(f.sql.unsafe(`truncate ${t} cascade`)).rejects.toThrow('CLAN_CHARTER_TERMINAL_IMMUTABLE');}
 await expect(f.sql`update clan_charter_chest_updates set delta=delta`).rejects.toThrow('CLAN_CHARTER_TERMINAL_IMMUTABLE');
 await f.sql`create table copied_charter_clans(like clans including defaults)`;await f.sql`insert into copied_charter_clans select * from clans where id=${clan}`;
 await f.sql`create trigger clans_clan_charter_chest after update on copied_charter_clans for each row execute function shardkeep_clan_charter_capture_chest()`;
 await expect(f.sql`update copied_charter_clans set chest_shards=chest_shards+1`).rejects.toThrow('CLAN_CHARTER_TERMINAL_TRIGGER');expect(await snapshot()).toEqual(before);
});
it('captures expiry once and does not backfill terminal rows or duplicate witnesses on migration replay',async()=>{
 const id=await raid();await f.sql`update raids set status='expired' where id=${id}`;const before=await snapshot();
 await f.sql`update raids set status=status where id=${id}`;
 await f.sql.begin(async tx=>{for(const statement of readFileSync(migration,'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
 expect(await snapshot()).toEqual(before);expect((await f.sql`select terminal_status from clan_charter_raid_terminals where raid_id=${id}`)[0]!.terminal_status).toBe('expired');
});
it('allows ordinary LOGIN terminal and chest writes without private witness reads or execution',async()=>{
 const id=await raid(),role='charter_terminal_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await f.sql.unsafe(`grant usage on schema public to ${role};grant select,update on raids,clans to ${role};grant select on deed_economy_cutover_state to ${role}`);
  const [database]=await f.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await runtime.sql`update raids set status='expired' where id=${id}`;await runtime.sql`update clans set chest_shards=chest_shards+1 where id=${clan}`;
  expect((await f.sql`select pairing from clan_charter_chest_updates`)[0]!.pairing).toBe('unmatched');
  for(const table of tables)await expect(runtime.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});
  await f.sql.unsafe(`grant insert on clan_charter_chest_updates to ${role}`);
  await expect(runtime.sql`insert into clan_charter_chest_updates(id) values(${randomUUID()})`).rejects.toMatchObject({code:'42501'});
  await expect(runtime.sql`select shardkeep_clan_charter_capture_chest()`).rejects.toMatchObject({code:'42501'});
 }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
it('keeps unenrolled READ COMMITTED writes uncaptured but refuses stale-isolation evidence paths',async()=>{
 const other=resourceClaimsDatabase();await other.setup();
 try{
  const a=randomUUID(),d=randomUUID(),c=randomUUID(),r=randomUUID();
  await other.sql`insert into players(wallet) values(${a}),(${d})`;
  await other.sql`insert into clans(id,name,tag,leader_wallet) values(${c},${c},${c},${a})`;
  await other.sql`insert into raids(id,attacker_wallet,defender_wallet,seed,snapshot,army_snapshot,orders_deadline_at) values(${r},${a},${d},1,'{}','{}',now())`;
  // Each BEFORE path checks isolation before reading an absent enrollment:
  // Custody league for ledger, Charter sale for raids, and creation for clans.
  await expect(other.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into ledger_transactions(idempotency_key,type,metadata) values(${'raid:'+r+':loot'},'raid.loot','{}')`;})).rejects.toMatchObject({code:'P0001',message:'CUSTODY_LEAGUE_READ_COMMITTED_REQUIRED'});
  expect(await other.sql`select id from ledger_transactions where idempotency_key=${'raid:'+r+':loot'}`).toHaveLength(0);
  await expect(other.sql.begin('isolation level repeatable read',async tx=>{await tx`update clans set chest_shards=chest_shards+1 where id=${c}`;})).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_CREATION_READ_COMMITTED'});
  expect((await other.sql`select chest_shards from clans where id=${c}`)[0]!.chest_shards).toBe('0');
  await expect(other.sql.begin('isolation level repeatable read',async tx=>{await tx`update raids set status='expired' where id=${r}`;})).rejects.toMatchObject({code:'P0001',message:'CLAN_CHARTER_SALE_READ_COMMITTED'});
  // These legacy owner writes do not claim a valid economic settlement. They
  // establish that absent enrollment creates no private witness or backfill.
  await other.sql`insert into ledger_transactions(idempotency_key,type,metadata) values(${'raid:'+r+':loot'},'raid.loot','{}')`;
  await other.sql`update clans set chest_shards=chest_shards+1 where id=${c}`;
  await other.sql`update raids set status='expired' where id=${r}`;
  for(const table of tables)expect(await other.sql.unsafe(`select * from ${table}`)).toHaveLength(0);
 }finally{await other.close();}
},120_000);
