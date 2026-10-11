/** Registered private Mine provenance SQL consistency. Synthetic certificates
 * test database constraints only; actual signed source authority has separate
 * service/assessment fixtures. No gameplay recovery writer is mounted. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { ADMIN_DATABASE_URL } from './db-url';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, postTransaction } from '../src/ledger';
import { MINE_DAY_MS } from '../src/game/baseMining';
const owner = resourceClaimsDatabase(), anchor = new Date('2035-01-08T00:00:00.000Z');
type Tx = postgres.TransactionSql;
beforeAll(() => owner.setup(), 120_000);
afterAll(() => owner.close());
async function rollback(work: (tx: Tx) => Promise<void>) {
  const end = Error('rollback fixture');
  try { await owner.sql.begin(async tx => { await work(tx); throw end; }); } catch (e) { if (e !== end) throw e; }
}
async function fixture(tx: Tx) {
  const wallet = randomUUID(), base = randomUUID(), mine = randomUUID(), parent = randomUUID();
  await tx`insert into players(wallet) values(${wallet})`;
  await tx`insert into bases(id,owner_wallet) values(${base},${wallet})`;
  await tx`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${mine},${wallet},${base},'mine',0,0)`;
  await tx`insert into shards_mine_eras(mine_id,base_id,admitted_at,legacy_gross) values(${mine},${base},${anchor.toISOString()},0)`;
  await tx`insert into shards_mine_segments(id,mine_id,base_id,wallet,source_key,starts_at,ends_at,quota,anchor_at,first_unit,last_unit,gross,buffer)
    values(${parent},${mine},${base},${wallet},${'mine:'+mine+':v0:u1'},${new Date(+anchor+1).toISOString()},${new Date(+anchor+4).toISOString()},${MINE_DAY_MS},${anchor.toISOString()},1,4,4,4)`;
  const source = { genesisHash: randomUUID(), programId: randomUUID(), auctionConfig: randomUUID() };
  const terms = [];
  for (const round of [0, 1]) {
    const termId = randomUUID(), startsAt = new Date(+anchor + 3 + (round-1)*7*MINE_DAY_MS).toISOString();
    const endsAt = new Date(Date.parse(startsAt)+7*MINE_DAY_MS).toISOString();
    const snapshot = { version: 1, termId, startsAt, endsAt, source: { kind: 'solana_auction_round', ...source, round: String(round) }, spots: Array.from({length:100},()=>({})) };
    const canonical = JSON.stringify(snapshot);
    const [stored] = await tx`insert into expedition_term_snapshots(term_id,snapshot_hash,canonical,snapshot,genesis_hash,program_id,auction_config,round,starts_at,ends_at)
      values(${termId},encode(sha256(convert_to(${canonical},'UTF8')),'hex'),${canonical},${canonical}::jsonb,${source.genesisHash},${source.programId},${source.auctionConfig},${String(round)},${startsAt},${endsAt}) returning snapshot_hash`;
    terms.push({ version:1,purpose:'historical_shards_attribution',snapshot,termHash:stored!.snapshot_hash,
      completedAt:startsAt,completedSlot:'10',deployment:{programDataAddress:'fixture',programDataSha256:'a'.repeat(64),deployedSlot:'1',upgradeAuthority:null},
      finality:{commitment:'finalized',contextSlot:'20',observedAt:'2035-01-16T00:00:00.000Z'},operatingAdmissionAuthorized:false });
  }
  const claim = { status:'confirmed',baseId:base,wallet,classification:'registered_free',assetId:null,startsAt:anchor.toISOString(),endsAt:new Date(+anchor+5).toISOString(),evidenceSha256:'b'.repeat(64) };
  const evidence = {version:1,purpose:'historical_physical_mine_custody',segment:{id:parent,mineId:mine,baseId:base,wallet,admissionId:null,ownershipStatus:'confirmed',sourceKey:'mine:'+mine+':v0:u1',anchorAt:anchor.toISOString(),startsAt:new Date(+anchor+1).toISOString(),endsAt:new Date(+anchor+4).toISOString(),quota:String(MINE_DAY_MS),firstUnit:'1',lastUnit:'4',gross:'4'},rosters:[{fixture:'complete roster retained for TS replay'}],deeds:null,custody:claim,sourceVerified:true,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false};
  const custody = { version:1,...claim,evidence };
  return { wallet,base,mine,parent,source,terms,custody };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function header(tx: Tx, f: Fixture, custody: unknown = f.custody, verifiedAt = '2035-01-16T00:00:00.000Z') {
  await tx`insert into shards_mine_resolutions(parent_id,term_source,custody,verified_at) values(${f.parent},${JSON.stringify(f.source)}::jsonb,${JSON.stringify(custody)}::jsonb,${verifiedAt})`;
}
async function child(tx: Tx, f: Fixture, first: number, last: number, term: number, changes: Record<string,unknown> = {}, withProof = true) {
  const id = randomUUID();
  const row = { id,mine_id:f.mine,base_id:f.base,wallet:f.wallet,admission_id:null,ownership_status:'confirmed',
    source_key:`mine-recovered:${f.parent}:u${first}`,starts_at:new Date(+anchor+first).toISOString(),ends_at:new Date(+anchor+last).toISOString(),
    quota:MINE_DAY_MS,anchor_at:anchor.toISOString(),first_unit:first,last_unit:last,gross:last-first+1,buffer:last-first+1,reserved:0,issued:0,discarded:0,resolved:0,recovery_parent_id:f.parent,...changes };
  await tx`insert into shards_mine_segments select * from jsonb_populate_record(null::shards_mine_segments,${JSON.stringify(row)}::jsonb)`;
  const proof = f.terms[term]!;
  if (withProof) await tx`insert into shards_mine_resolution_terms(segment_id,parent_id,term_id,term_hash,certificate)
    values(${id},${f.parent},${proof.snapshot.termId},${proof.termHash},${JSON.stringify(proof)}::jsonb)`;
  return id;
}
async function finish(tx: Tx, f: Fixture) {
  await tx`update shards_mine_segments set buffer=0,resolved=gross where id=${f.parent}`;
  await tx`set constraints all immediate`;
}
it('installs empty private evidence with no policy activation or backfill',async()=>{
 expect(await owner.sql`select * from shards_mine_resolutions`).toHaveLength(0);
 expect(await owner.sql`select * from shards_mine_resolution_terms`).toHaveLength(0);
 expect(await owner.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
 expect(await owner.sql`select * from shards_mine_segments`).toHaveLength(0);
});
it('keeps original parent immutable and replaces its entire pending quantity with exact term children once', async () => rollback(async tx => {
  const f=await fixture(tx);await header(tx,f);await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);
  expect(await tx`select buffer,resolved,issued,discarded from shards_mine_segments where id=${f.parent}`).toEqual([{buffer:'0',resolved:'4',issued:'0',discarded:'0'}]);
  expect(await tx`select sum(buffer)::text amount from shards_mine_segments where mine_id=${f.mine}`).toEqual([{amount:'4'}]);
  expect(await tx`select id from shards_mine_admissions`).toHaveLength(0);
}));
it('rejects gaps, overlaps, missing certificates and unmatched parent consumption at deferred completion', async () => {
  for (const variant of ['gap','overlap','missing-proof','unconsumed']) await expect(rollback(async tx => {
    const f=await fixture(tx);await header(tx,f);await child(tx,f,1,2,0);
    if(variant==='missing-proof') {
      await child(tx,f,3,4,1,{},false);await finish(tx,f);
    } else if(variant==='overlap') {
      // Both child certificates cover their units; only the ordinal partition
      // exposes unit 2 being copied twice.
      await child(tx,f,2,2,0);await child(tx,f,3,4,1);await finish(tx,f);
    } else {
      await child(tx,f,variant==='gap'?4:3,4,1);
      if(variant==='unconsumed')await tx`set constraints all immediate`;else await finish(tx,f);
    }
  })).rejects.toThrow();
});
it('rejects changed Mine, base, wallet, anchor, quota, source key and ordinal completion', async () => {
  for(const change of [{mine_id:randomUUID()},{base_id:randomUUID()},{wallet:randomUUID()},{anchor_at:new Date(+anchor-1).toISOString()},
    {quota:MINE_DAY_MS+1},{source_key:'forged'},{starts_at:anchor.toISOString()},{admission_id:randomUUID()}])
    await expect(rollback(async tx=>{const f=await fixture(tx);await header(tx,f);await child(tx,f,1,2,0,change);})).rejects.toThrow();
});
it('refuses partially spent, reserved, discarded, legacy or already admitted parents',async()=>{
  for(const change of ['issued','reserved','discarded','legacy','admitted'])await expect(rollback(async tx=>{
    const f=await fixture(tx);
    if(change==='legacy')await tx`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer) values(${randomUUID()},${f.mine},${f.base},'legacy:'||${f.mine},${anchor.toISOString()},${anchor.toISOString()},0,1,1)`;
    else if(change==='admitted'){
      const admission=randomUUID(),id=randomUUID(),term=f.terms[0]!;
      await tx`insert into shards_mine_admissions(id,wallet,base_id,admitted_at,term_id,term_hash,observation,mine_ids) values(${admission},${f.wallet},${f.base},${anchor.toISOString()},${term.snapshot.termId},${term.termHash},'{}',ARRAY[${f.mine}::uuid])`;
      await tx`insert into shards_mine_segments select (jsonb_populate_record(null::shards_mine_segments,to_jsonb(s)||jsonb_build_object('id',${id}::text,'admission_id',${admission}::text,'source_key',${'admitted:'+id}::text))).* from shards_mine_segments s where s.id=${f.parent}`;
      f.parent=id;
    }
    else await tx.unsafe(`update shards_mine_segments set buffer=3,${change}=1 where id='${f.parent}'`);
    if(change==='legacy'){const [legacy]=await tx`select id from shards_mine_segments where mine_id=${f.mine} and wallet is null`;f.parent=legacy!.id;}
    await header(tx,f);
  })).rejects.toThrow();
});
it('refuses custody identity changes and a certificate granting operating authority or covering the wrong term',async()=>{
  for(const variant of ['wallet','base','range','operating','wrong-term','late-completion'])await expect(rollback(async tx=>{
    const f=await fixture(tx);
    if(variant==='wallet')f.custody.wallet=randomUUID();if(variant==='base')f.custody.baseId=randomUUID();
    if(variant==='range')f.custody.startsAt=new Date(+anchor+2).toISOString();
    await header(tx,f);
    if(variant==='operating')f.terms[0]!.operatingAdmissionAuthorized=true;
    if(variant==='late-completion')f.terms[0]!.completedAt=new Date(+anchor+2).toISOString();
    await child(tx,f,1,2,variant==='wrong-term'?1:0);
  })).rejects.toThrow();
});
it('does not permit recursive splitting, duplicate resolution, reopening or changing immutable proof',async()=>{
  for(const variant of ['recursive','duplicate','reopen','certificate','header','delete','truncate'])await expect(rollback(async tx=>{
    const f=await fixture(tx);await header(tx,f);const id=await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);
    if(variant==='recursive'){f.parent=id;await header(tx,f);}
    if(variant==='duplicate')await header(tx,f);
    if(variant==='reopen')await tx`update shards_mine_segments set buffer=4,resolved=0 where id=${f.parent}`;
    if(variant==='certificate')await tx`update shards_mine_resolution_terms set certificate='{}' where segment_id=${id}`;
    if(variant==='header')await tx`update shards_mine_resolutions set custody='{}' where parent_id=${f.parent}`;
    if(variant==='delete')await tx`delete from shards_mine_resolutions where parent_id=${f.parent}`;
    if(variant==='truncate')await tx`truncate shards_mine_resolutions,shards_mine_resolution_terms`;
  })).rejects.toThrow();
});
it('refuses runtime recovery fabrication even when accidental DML grants exist',async()=>{
  for(const target of ['header','child','certificate','resolve'])await expect(rollback(async tx=>{
    const f=await fixture(tx),role='mine_resolution_'+randomUUID().replaceAll('-','');
    if(target!=='header')await header(tx,f);
    const id=target==='certificate'?await child(tx,f,1,2,0):null;
    await tx.unsafe(`create role ${role} noinherit;grant usage on schema public to ${role};grant select,insert,update on shards_mine_segments,shards_mine_resolutions,shards_mine_resolution_terms to ${role};set local role ${role}`);
    if(target==='header')await header(tx,f);
    if(target==='child')await child(tx,f,1,2,0);
    if(target==='certificate')await tx`insert into shards_mine_resolution_terms select ${randomUUID()}::uuid,parent_id,term_id,term_hash,certificate from shards_mine_resolution_terms where segment_id=${id}`;
    if(target==='resolve')await tx`update shards_mine_segments set buffer=0,resolved=4 where id=${f.parent}`;
  })).rejects.toMatchObject({code:'42501'});
});

it('stores server verification time separately from real database recording time and preserves full custody evidence',async()=>rollback(async tx=>{
 const f=await fixture(tx);await header(tx,f);await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);
 const [r]=await tx`select custody,verified_at,recorded_at from shards_mine_resolutions where parent_id=${f.parent}`;
 expect(r!.custody).toEqual(f.custody);expect(+new Date(r!.verified_at)).toBe(Date.parse('2035-01-16T00:00:00.000Z'));
 expect(Math.abs(+new Date(r!.recorded_at)-Date.now())).toBeLessThan(30_000);
}));
it('refuses nonfinite or submillisecond verification time, dropped custody evidence and observations after verification',async()=>{
 for(const value of ['infinity','2035-01-16T00:00:00.000001Z'])await expect(rollback(async tx=>{
  const f=await fixture(tx);await header(tx,f,f.custody,value);
 })).rejects.toThrow('MINE_RESOLUTION_VERIFIED_TIME');
 await expect(rollback(async tx=>{const f=await fixture(tx);const {evidence,...incomplete}=f.custody;await header(tx,f,incomplete);})).rejects.toThrow('MINE_RESOLUTION_CUSTODY');
 await expect(rollback(async tx=>{const f=await fixture(tx);await header(tx,f,f.custody,'2035-01-15T00:00:00.000Z');await child(tx,f,1,2,0);})).rejects.toThrow('MINE_RESOLUTION_TERM');
});
it('rolls back a complete split atomically when the enclosing operation fails',async()=>{
 const f=await owner.sql.begin(tx=>fixture(tx));
 await expect(owner.sql.begin(async tx=>{await header(tx,f);await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);throw Error('downstream fixture failure');})).rejects.toThrow('downstream fixture failure');
 expect(await owner.sql`select buffer,resolved from shards_mine_segments where id=${f.parent}`).toEqual([{buffer:'4',resolved:'0'}]);
 expect(await owner.sql`select parent_id from shards_mine_resolutions where parent_id=${f.parent}`).toHaveLength(0);
 expect(await owner.sql`select id from shards_mine_segments where recovery_parent_id=${f.parent}`).toHaveLength(0);
});
it('refuses concurrent resolution without deadlock and commits only one exact parent partition',async()=>{
 const f=await owner.sql.begin(tx=>fixture(tx)),peer=owner.reopen();
 let locked!:()=>void,release!:()=>void;
 const acquired=new Promise<void>(resolve=>{locked=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const first=owner.sql.begin(async tx=>{await header(tx,f);locked();await gate;await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);});
 try{
  await Promise.race([acquired,first]);
  await expect(peer.sql.begin(tx=>header(tx,f))).rejects.toMatchObject({code:'55P03'});
  release();await first;
  await expect(peer.sql.begin(tx=>header(tx,f))).rejects.toThrow('MINE_RESOLUTION_PARENT');
  expect(await owner.sql`select count(*)::integer n,sum(buffer)::text amount from shards_mine_segments where recovery_parent_id=${f.parent}`).toEqual([{n:2,amount:'4'}]);
 }finally{release();await first.catch(()=>{});await peer.sql.end();}
});
it('rejects partial or orphan resolved counters and preserves normal child quantity conservation',async()=>{
 for(const withHeader of [true,false])await expect(rollback(async tx=>{
  const f=await fixture(tx);if(withHeader)await header(tx,f);
  await tx`update shards_mine_segments set buffer=2,resolved=2 where id=${f.parent}`;
 })).rejects.toThrow('MINE_RESOLUTION_CONSERVATION');
 await rollback(async tx=>{
  const f=await fixture(tx);await header(tx,f);const id=await child(tx,f,1,2,0);await child(tx,f,3,4,1);await finish(tx,f);
  await tx`update shards_mine_segments set buffer=1,reserved=1 where id=${id}`;
  await tx`update shards_mine_segments set reserved=0,issued=1 where id=${id}`;
  expect(await tx`select gross,buffer,reserved,issued,resolved from shards_mine_segments where id=${id}`).toEqual([{gross:'2',buffer:'1',reserved:'0',issued:'1',resolved:'0'}]);
 });
});
it('keeps ordinary runtime segment writes compatible without exposing private recovery evidence',async()=>rollback(async tx=>{
 const f=await fixture(tx),role='mine_ordinary_'+randomUUID().replaceAll('-','');
 await tx.unsafe(`create role ${role} noinherit;grant usage on schema public to ${role};grant select,update on shards_mine_segments to ${role};set local role ${role}`);
 expect(await tx`select has_table_privilege(current_user,'public.shards_mine_resolutions','SELECT') allowed`).toEqual([{allowed:false}]);
 await tx`update shards_mine_segments set buffer=3,reserved=1 where id=${f.parent}`;
 await tx`set constraints all immediate`;
 expect(await tx`select buffer,reserved from shards_mine_segments where id=${f.parent}`).toEqual([{buffer:'3',reserved:'1'}]);
}));

it('upgrades the0200 frontier and safely repeats both contracts without changing original balances, source rows or relation identities',async()=>{
 const root=fileURLToPath(new URL('../drizzle',import.meta.url));
 const folder=await mkdtemp(path.join(tmpdir(),'mine-resolution-migrations-'));
 const name='mine_resolution_upgrade_'+randomUUID().replaceAll('-','')+'_test';
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+name;
 let conn:ReturnType<typeof createDb>|undefined;
 try{
  const all=JSON.parse(await readFile(path.join(root,'meta/_journal.json'),'utf8')) as {entries:{tag:string}[]};
  const index=all.entries.findIndex(e=>e.tag==='0202_shards_mine_resolution_contract');expect(index).toBeGreaterThan(1);
  const journal={...all,entries:all.entries.slice(0,index+1)};
  await mkdir(path.join(folder,'meta'));
  for(const e of journal.entries)await copyFile(path.join(root,e.tag+'.sql'),path.join(folder,e.tag+'.sql'));
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,-2)}));
  await admin.unsafe(`CREATE DATABASE ${name}`);conn=createDb(url.toString(),{max:4});await runMigrations(conn.db,{migrationsFolder:folder});
  const f=await conn.sql.begin(tx=>fixture(tx));
  await conn.sql`insert into mine_accrual_states(mine_building_id,accrued_shards,last_accrual_at) values(${f.mine},4,${anchor.toISOString()})`;
  const sys=await bootstrapSystemAccounts(conn.db),account=await getOrCreateBaseAccount(conn.db,f.base,'base_shards');
  await postTransaction(conn.db,{idempotencyKey:randomUUID(),type:'test.mine.resolution.upgrade',entries:[{account:sys.shard_genesis,delta:-7n},{account:account.id,delta:7n}]});
  const tables=['mine_accrual_states','shards_mine_eras','expedition_term_snapshots','accounts','ledger_transactions','ledger_entries'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,{
   oid:(await conn!.sql`select ${table}::regclass::oid::text oid`)[0]!.oid,
   rows:await conn!.sql.unsafe(`select to_jsonb(t)::text value from ${table} t order by to_jsonb(t)::text`)}])));
  const before=await snapshot(),segments=await conn.sql`select to_jsonb(s)::text value from shards_mine_segments s order by id`;
  const segmentOid=await conn.sql`select 'shards_mine_segments'::regclass::oid::text oid`;
  await writeFile(path.join(folder,'meta/_journal.json'),JSON.stringify(journal));await runMigrations(conn.db,{migrationsFolder:folder});
  for(let pass=0;pass<2;pass++)for(const tag of ['0201_shards_mine_resolutions','0202_shards_mine_resolution_contract']){
   await conn.sql.begin(async tx=>{
    for(const statement of (await readFile(path.join(root,tag+'.sql'),'utf8')).split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(statement);
   });
  }
  expect(await snapshot()).toEqual(before);
  expect(await conn.sql`select (to_jsonb(s)-ARRAY['resolved','recovery_parent_id'])::text value from shards_mine_segments s order by id`).toEqual(segments);
  expect(await conn.sql`select 'shards_mine_segments'::regclass::oid::text oid`).toEqual(segmentOid);
  expect(await conn.sql`select resolved::text,recovery_parent_id from shards_mine_segments`).toEqual([{resolved:'0',recovery_parent_id:null}]);
  expect(await conn.sql`select * from shards_mine_resolutions`).toHaveLength(0);
  expect(await conn.sql`select * from shards_mine_resolution_terms`).toHaveLength(0);
  expect(await conn.sql`select * from shards_mine_policy_boundary`).toHaveLength(0);
  const [journalCount]=await conn.sql`select count(*)::integer n from drizzle.__drizzle_migrations`;
  expect(journalCount!.n).toBe(journal.entries.length);
 }finally{await conn?.sql.end();await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);await admin.end();await rm(folder,{recursive:true,force:true});}
},120_000);
