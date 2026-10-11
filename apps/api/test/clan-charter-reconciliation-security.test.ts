/** Independent read-proof tests. Raw raid headers isolate the witness reader;
 * actual gameplay settlement is covered by clan-charter-terminal-gameplay.
 * Guard-disabled cases explicitly model owner storage damage, not a player or
 * runtime-role permission bypass. Every exact guard is restored before read. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type {DbOrTx} from '../src/db/client';
import {createClanCharterReconciliation} from '../src/game/clanCharterReconciliation';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {randomWallet} from './helpers';

let f:ReturnType<typeof resourceClaimsDatabase>,actor:string,target:string,clan:string,att:string,def:string,pool:string;
beforeEach(async()=>{
 f=resourceClaimsDatabase();await f.setup();actor=randomWallet();target=randomWallet();clan=randomUUID();
 await f.sql`insert into players(wallet) values(${actor}),(${target})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${clan},${clan},${clan},${actor})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${actor},${clan})`;
 const sys=await bootstrapSystemAccounts(f.db);pool=sys.clan_chest;
 att=(await getOrCreatePlayerAccount(f.db,actor,'player_shards')).id;def=(await getOrCreatePlayerAccount(f.db,target,'player_shards')).id;
 await postTransaction(f.db,{idempotencyKey:randomUUID(),type:'test.charter-security.fund',entries:[{account:sys.shard_genesis,delta:-1000n},{account:def,delta:1000n}]});
 await f.sql`select * from shardkeep_clan_charter_event_source_initialize()`;
},120_000);
afterEach(async()=>{await f?.close();},120_000);
async function admit(campaign=false){
 const id=randomUUID();await f.sql`insert into raids(id,attacker_wallet,defender_wallet,campaign_stage,seed,snapshot,army_snapshot,orders_deadline_at)
 values(${id},${actor},${campaign?null:target},${campaign?1:null},1,'{}','{}',now()+interval '1 minute')`;return id;
}
function post(db:DbOrTx,id:string){return postTransaction(db,{idempotencyKey:`raid:${id}:loot`,type:'raid.loot',metadata:{raidId:id,attacker:actor,defender:target,clanChest:'10'},entries:[{account:def,delta:-100n},{account:att,delta:90n},{account:pool,delta:10n}]});}
async function terminal(db:DbOrTx,id:string,net:number){
 await db.execute(sql`update raids set status='resolving' where id=${id}`);
 await db.execute(sql`update raids set status='resolved',resolved_at=now(),result=${JSON.stringify({lootShards:net})}::jsonb where id=${id}`);
}
async function settle(id:string){return f.db.transaction(async tx=>{const p=await post(tx,id);await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${clan}`);await terminal(tx,id,90);return p;});}
const read=(id:string)=>createClanCharterReconciliation(f.db).read(id);
async function held(id:string){expect(await read(id)).toMatchObject({status:'held',reason:expect.any(String)});}
type Writer=Pick<ReturnType<typeof resourceClaimsDatabase>['sql'],'unsafe'>;
// These older, unpriced records deliberately model owner storage damage.
// Suppress the exact new completion hook before the damage so no deferred event
// prevents restoring its table guards. Restoring a chest witness also bypasses
// its new insertion guard solely inside this fixture; every hook is checked
// enabled again before the independent reader sees either damaged or restored data.
function damageGuards(table:string){
 return [table+'_guard',
  ...(table==='clan_charter_chest_updates'?['clan_charter_chest_updates_raid_chest_guard']:[]),
  ...(['clan_charter_chest_updates','clan_charter_raid_events'].includes(table)?[table+'_clan_charter_raid_chest_complete']:[])];
}
async function assertDamageGuardsEnabled(table:string){
 for(const guard of damageGuards(table))expect((await f.sql`select tgenabled from pg_trigger where tgrelid=${table}::regclass and tgname=${guard}`)[0]!.tgenabled).toBe('O');
}
async function damage(table:string,work:(tx:Writer)=>Promise<unknown>){
 await f.sql.begin(async tx=>{
  for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} disable trigger ${guard}`);
  await work(tx);
  for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} enable trigger ${guard}`);
 });
 await assertDamageGuardsEnabled(table);
}
async function money(){return {accounts:await f.sql`select id,balance from accounts order by id`,entries:await f.sql`select to_jsonb(e)::text row from ledger_entries e order by id`,chest:await f.sql`select id,chest_shards from clans order by id`};}

it.each(['canonical wrong type','raid-linked wrong key'])('does not certify zero chest when raw discovery finds an uncaptured %s header',async variant=>{
 const id=await admit(true);await f.db.transaction(tx=>terminal(tx,id,77));
 expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'0'});
 const key=variant==='canonical wrong type'?`raid:${id}:loot`:`unexpected:${id}:reward`;
 // An incomplete raw ledger header is deliberately inconsistent storage. It
 // must be discovered even though the canonical capture refuses its shape.
 await f.sql`insert into ledger_transactions(idempotency_key,type,metadata) values(${key},${variant==='canonical wrong type'?'unexpected.reward':'raid.loot'},${JSON.stringify({raidId:id})}::jsonb)`;
 const before=await money();await held(id);expect(await money()).toEqual(before);
});

it('holds changed header, entry, account and terminal snapshots without changing balances or repairing stored evidence',async()=>{
 const id=await admit();await settle(id);expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
 const vectors=[
  {table:'clan_charter_loot_posts',column:'original_transaction',change:"jsonb_set(original_transaction,'{type}','\"wrong.type\"'::jsonb)"},
  {table:'clan_charter_loot_entries',column:'original_entry',change:"jsonb_set(original_entry,'{delta}','0'::jsonb)"},
  {table:'clan_charter_loot_entries',column:'account_identity',change:"jsonb_set(account_identity,'{currency}','\"KEEP\"'::jsonb)"},
  {table:'clan_charter_raid_terminals',column:'after_raid',change:"jsonb_set(after_raid,'{result,lootShards}','91'::jsonb)"},
 ];
 for(const vector of vectors){
  const original=await f.sql.unsafe(`select to_jsonb(t) row from ${vector.table} t`),before=await money();
  await damage(vector.table,tx=>tx.unsafe(`update ${vector.table} set ${vector.column}=${vector.change}`));
  await held(id);expect(await money()).toEqual(before);
  // Restore the exact captured value, not a newly fabricated proof.
  await damage(vector.table,async tx=>{for(const r of original){const row=r.row as Record<string,unknown>;const key=vector.table==='clan_charter_loot_entries'?'entry_id':vector.table==='clan_charter_loot_posts'?'ledger_id':'raid_id';await tx.unsafe(`update ${vector.table} set ${vector.column}=$1::jsonb where ${key}=$2`,[JSON.stringify(row[vector.column]),String(row[key])]);}});
  expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
 }
});

it('holds each missing header, entry, credit or terminal witness instead of accepting the surviving raw rows',async()=>{
 const id=await admit();await settle(id);expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
 for(const table of ['clan_charter_loot_entries','clan_charter_chest_updates','clan_charter_raid_terminals']){
  const original=await f.sql.unsafe(`select to_jsonb(t) row from ${table} t`),before=await money();
  await damage(table,tx=>tx.unsafe(`delete from ${table}`));await held(id);expect(await money()).toEqual(before);
  await damage(table,async tx=>{for(const row of original)await tx.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row.row)]);});
  expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
 }
 // Header deletion requires removing its real FK children too. Preserve and
 // restore that exact graph instead of disabling constraints or using CASCADE.
 const tables=['clan_charter_loot_posts','clan_charter_loot_entries','clan_charter_chest_updates'];
 const saved=await Promise.all(tables.map(table=>f.sql.unsafe(`select to_jsonb(t) row from ${table} t`))),before=await money();
 await f.sql.begin(async tx=>{
  for(const table of tables)for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} disable trigger ${guard}`);
  for(const table of [...tables].reverse())await tx.unsafe(`delete from ${table}`);
  for(const table of tables)for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} enable trigger ${guard}`);
 });
 for(const table of tables)await assertDamageGuardsEnabled(table);
 await held(id);expect(await money()).toEqual(before);
 await f.sql.begin(async tx=>{
  for(const table of tables)for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} disable trigger ${guard}`);
  for(const [i,table] of tables.entries())for(const row of saved[i]!)await tx.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row.row)]);
  for(const table of tables)for(const guard of damageGuards(table))await tx.unsafe(`alter table ${table} enable trigger ${guard}`);
 });
 for(const table of tables)await assertDamageGuardsEnabled(table);
 expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
});

it('does not match the same chest amount posted in an earlier transaction to a later terminal and clan update',async()=>{
 const id=await admit(),posting=await post(f.db,id);
 await f.db.transaction(async tx=>{await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${clan}`);await terminal(tx,id,90);});
 const [proof]=await f.sql`select p.tx_key post_tx,t.tx_key terminal_tx,c.tx_key chest_tx,c.pairing from clan_charter_loot_posts p join clan_charter_raid_terminals t on t.raid_id=p.raid_id cross join clan_charter_chest_updates c where p.ledger_id=${posting.transaction.id}`;
 expect(proof!.post_tx).not.toBe(proof!.terminal_tx);expect(proof!.chest_tx).toBe(proof!.terminal_tx);expect(proof!.pairing).toBe('unmatched');
 const before=await money();await held(id);expect(await money()).toEqual(before);
});

it('does not let an early constraint flush conceal later raw header drift or refresh the original capture',async()=>{
 const id=await admit();let original:unknown;
 await f.db.transaction(async tx=>{
  const posting=await post(tx,id);await tx.execute(sql`update clans set chest_shards=chest_shards+10 where id=${clan}`);await terminal(tx,id,90);
  await tx.execute(sql`set constraints all immediate`);
  const [row]=await tx.execute(sql`select original_transaction from clan_charter_loot_posts where ledger_id=${posting.transaction.id}`);original=row!.original_transaction;
  await tx.execute(sql`update ledger_transactions set metadata=metadata||' {"afterFlush":true}'::jsonb where id=${posting.transaction.id}`);
 });
 expect((await f.sql`select original_transaction from clan_charter_loot_posts where raid_id=${id}`)[0]!.original_transaction).toEqual(original);
 const before=await money();await held(id);expect(await money()).toEqual(before);
});

it('rejects a nonpositive campaign target even when owner-damaged admission and terminal snapshots otherwise agree',async()=>{
 const id=await admit(true);
 await f.sql`update raids set campaign_stage=0 where id=${id}`;
 await damage('clan_charter_raid_events',tx=>tx.unsafe('update clan_charter_raid_events set campaign_stage=0 where raid_id=$1',[id]));
 await f.db.transaction(tx=>terminal(tx,id,0));
 expect(await read(id)).toEqual({status:'held',reason:'admission_mismatch'});
});

it('rejects a changed original actor in the terminal before-image even with an unchanged after-image and raw raid',async()=>{
 const id=await admit();await settle(id);expect(await read(id)).toMatchObject({status:'reconciled',chestShards:'10'});
 await damage('clan_charter_raid_terminals',tx=>tx.unsafe("update clan_charter_raid_terminals set before_raid=jsonb_set(before_raid,'{attacker_wallet}',to_jsonb($1::text)) where raid_id=$2",[target,id]));
 expect(await read(id)).toEqual({status:'held',reason:'terminal_mismatch'});
});
