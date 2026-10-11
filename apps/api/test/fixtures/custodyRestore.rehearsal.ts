/** Real pre-0095 migration, combined custody retirement, pg_dump and restore.
 * Only an explicitly named, inspected root-owned tmpfs container is accepted.
 * This cannot select a production database or provide cutover authorization. */
import { randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../../src/db/keepCustodyJournal';
import { applyFixtureUnbondingWithdrawalDrain } from '../../src/db/keepCustodyWithdrawalDrain';
import { baseForgePositions, baseItems, deedOwnershipObservations } from '../../src/db/schema';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, postTransaction } from '../../src/ledger';
import { requestWithdrawal } from '../../src/money/withdrawals';
import { buildWeeklySnapshot, getInclusionProof, getProofOfReserves } from '../../src/money/snapshot';
import { deliverSystemMail } from '../../src/mail/service';
import { spendGems } from '../../src/game/spend';
import { createTestPlayer, fundTestKeep } from '../helpers';
import { ADMIN_DATABASE_URL } from '../db-url';
import { custodyLeagueFixture, WEEKS } from './custodyLeague';
import { DRAIN_GROSS } from './custodyWithdrawalDrain';

const command=promisify(execFile),sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const ident=(value:string)=>'"'+value.replaceAll('"','""')+'"';
async function ownedContainer(){
 const container=process.env['PHASE_E_RESTORE_CONTAINER'];
 if(!container||!/^phase-e-focused-[0-9a-f]{12}-pg$/.test(container))throw Error('RESTORE_OWNED_CONTAINER_REQUIRED');
 const url=new URL(ADMIN_DATABASE_URL);
 if(url.hostname!=='127.0.0.1'||url.username!=='shardkeep'||url.pathname!=='/postgres'||!url.port)throw Error('RESTORE_OWNED_ADMIN_REQUIRED');
 const {stdout}=await command('docker',['inspect',container],{timeout:10_000});
 const rows=JSON.parse(stdout) as {Name:string;Config:{Image:string};State:{Running:boolean};HostConfig:{Tmpfs?:Record<string,string>};NetworkSettings:{Ports:Record<string,{HostIp:string;HostPort:string}[]>}}[];
 const c=rows[0],ports=c?.NetworkSettings.Ports['5432/tcp'];
 if(rows.length!==1||c?.Name!=='/'+container||!c.State.Running||c.Config.Image!=='postgres:16-alpine'
  ||!c.HostConfig.Tmpfs||!Object.hasOwn(c.HostConfig.Tmpfs,'/var/lib/postgresql/data')
  ||ports?.length!==1||ports[0]!.HostIp!=='127.0.0.1'||ports[0]!.HostPort!==url.port)throw Error('RESTORE_CONTAINER_IDENTITY');
 return container;
}
async function restore(container:string,database:string,bytes:Buffer){
 if(!/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(database))throw Error('RESTORE_FIXTURE_DATABASE_REQUIRED');
 await command('docker',['exec',container,'dropdb','--username=shardkeep',database],{timeout:30_000});
 await command('docker',['exec',container,'createdb','--username=shardkeep',database],{timeout:30_000});
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('docker',['exec','-i',container,'pg_restore','--username=shardkeep','--single-transaction','--exit-on-error','--dbname='+database],{stdio:['pipe','ignore','pipe']});
  let error='';const timer=setTimeout(()=>child.kill('SIGTERM'),120_000);
  child.stderr.on('data',(part:Buffer)=>{error=(error+part.toString()).slice(-16_000);});
  child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('RESTORE_FAILED: '+error));});
  child.stdin.on('error',()=>{});child.stdin.end(bytes);
 });
}
async function fingerprint(conn:ReturnType<typeof createDb>){
 const tables=await conn.sql<{schema:string;name:string}[]>`select n.nspname "schema",c.relname "name" from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','drizzle') and c.relkind='r' order by n.nspname,c.relname`;
 const data=[];
 for(const table of tables){
  const [row]=await conn.sql.unsafe(`select count(*)::text count,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text collate "C"),'[]'::jsonb)::text,'UTF8')),'hex') hash from ${ident(table.schema)}.${ident(table.name)} t`);
  data.push({...table,...row});
 }
 // Object OIDs legitimately change on restore; names, definitions, owner and
 // normalized ACLs must not. Retaining default PUBLIC function grants is unsafe.
 const objects=await conn.sql`select 'function' kind,n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' identity,
   pg_get_functiondef(p.oid) definition,pg_get_userbyid(p.proowner) owner,
   (select jsonb_agg(v::text order by v::text) from unnest(coalesce(p.proacl,acldefault('f',p.proowner))) v) acl
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','drizzle') and p.prokind='f'
  union all select 'table',n.nspname||'.'||c.relname,null,pg_get_userbyid(c.relowner),
   (select jsonb_agg(v::text order by v::text) from unnest(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner))) v)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','S')
  union all select 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid,false)||':'||t.tgenabled::text,null,null
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname='public'
  union all select 'index',n.nspname||'.'||c.relname,pg_get_indexdef(c.oid),null,null
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='i' and n.nspname in ('public','drizzle')
  order by kind,identity`;
 const sequences=await conn.sql`select schemaname,sequencename,sequenceowner,data_type::text,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
  from pg_sequences where schemaname in ('public','drizzle') order by schemaname,sequencename`;
 return {data,objects,sequences};
}

it('restores the complete migrated retirement checkpoint, exact proofs and fences before resuming Gems and original receipts',async()=>{
 const container=await ownedContainer(),folder=await mkdtemp('/tmp/phase-e-custody-restore-');
 vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('WITHDRAWALS_ENABLED','true');vi.stubEnv('MAIL_DELIVERY_ENABLED','true');
 const f=await custodyLeagueFixture();let reopened:ReturnType<typeof createDb>|undefined;
 try{
  const captured=await f.capture();await f.migrateAll();
  const at=new Date().toISOString(),day=new Date(Date.parse(at)-86_400_000).toISOString().slice(0,10);await f.authorizeBuyer(at);
  const sys=await bootstrapSystemAccounts(f.db),internal=await createTestPlayer(f.db),withdrawers=[];
  await fundTestKeep(f.db,internal.wallet,5n,'fixture.restore.internal',randomUUID());
  for(let i=0;i<2;i++){
   const p=await createTestPlayer(f.db);await fundTestKeep(f.db,p.wallet,DRAIN_GROSS,'fixture.restore.withdrawal',randomUUID());
   const withdrawal=await requestWithdrawal(f.db,p.wallet,DRAIN_GROSS,Keypair.generate().publicKey.toBase58(),randomUUID());
   withdrawers.push({...p,withdrawal});
  }
  const escrow=await getOrCreateBaseAccount(f.db,f.baseId,'base_forge_escrow');
  await postTransaction(f.db,{idempotencyKey:randomUUID(),type:'fixture.restore.forge-fund',entries:[
   {account:sys.keep_genesis,delta:-12n},{account:sys.emission_pool,delta:12n},{account:sys.shard_genesis,delta:-8n},{account:escrow.id,delta:8n}]});
  const metadata={day,baseId:f.baseId,counted:'8'};
  const burned=await postTransaction(f.db,{idempotencyKey:`forge:base:${day}:${f.baseId}:shards`,type:'forge.burn',metadata,entries:[{account:escrow.id,delta:-8n},{account:sys.shard_burn,delta:8n}]});
  const allocated=await postTransaction(f.db,{idempotencyKey:`forge:base:${day}:${f.baseId}:keep`,type:'forge.allocate',metadata,entries:[{account:sys.emission_pool,delta:-9n},{account:sys.forge_payout_escrow,delta:9n}]});
  const [position]=await f.db.insert(baseForgePositions).values({day,baseId:f.baseId,contributedShards:10n,raidDebitedShards:2n,countedShards:8n,shardsRefunded:0n,keepPaid:9n,
   settlementOwnerWallet:f.seller,itemsDropped:['keg_of_haste'],shardSettlementTxnId:burned.transaction.id,keepEscrowTxnId:allocated.transaction.id,settledAt:new Date(at)}).returning();
  await f.db.insert(baseItems).values({baseId:f.baseId,itemId:'keg_of_haste',qty:1});
  await f.db.update(deedOwnershipObservations).set({checkedAt:new Date(at)}).where(eq(deedOwnershipObservations.baseId,f.baseId));
  const mail=await deliverSystemMail(f.db,{recipientWallet:f.buyer,deliveryKey:'fixture.restore.mail',subject:'Fixture restoration',body:'Keep original rewards',attachments:[{kind:'KEEP',amount:3n},{kind:'SHARDS',amount:4n}]},new Date(at));
  const oldSnapshot=await buildWeeklySnapshot(f.db,new Date(at)),oldProof=await getInclusionProof(f.db,f.seller),historicalLeague=await f.historicalGraph();
  await f.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
  // Freeze the cutover instant after every original source has been written.
  const asOf=new Date().toISOString();
  const drainRequest={fixtureId:randomUUID(),asOf,withdrawalIds:withdrawers.map(p=>p.withdrawal.id)};
  const drain=await applyFixtureUnbondingWithdrawalDrain(drainRequest,f.env);
  expect(drain.totalKeepReturned).toBe(String(DRAIN_GROSS*2n));
  const request:FixtureRetirementRequest={...f.retirementRequest(asOf),players:[
   {wallet:f.seller,keep:'600',internal:false},...withdrawers.map(p=>({wallet:p.wallet,keep:String(DRAIN_GROSS),internal:false})),{wallet:internal.wallet,keep:'5',internal:true}],
   mails:[{messageId:mail.message.id,wallet:f.buyer,keep:'3',internal:false}],
   forge:[{positionId:position!.id,baseId:f.baseId,day,wallet:f.buyer,keep:'9',internal:false}]};
  const env={...f.env,ALPHA_WALLETS:internal.wallet},retirement=await applyFixtureL1Retirement(request,env);
  expect(retirement).toMatchObject({measuredG8:true,totalKeepConverted:String(852n+DRAIN_GROSS*2n),sweptInternalKeep:'5',retirementAuthorized:false});
  expect(await f.historicalGraph()).toBe(historicalLeague);expect(await getInclusionProof(f.db,f.seller)).toEqual(oldProof);
  await expect(f.payPreviouslySelected()).rejects.toThrow();
  const nextWeek=new Date(Date.parse(at)+7*86400000);
  const noRoot=await buildWeeklySnapshot(f.db,nextWeek);expect(noRoot).toMatchObject({kind:'no_liabilities',phase:'frozen',root:null,totalBalance:0n});
  const por=await getProofOfReserves(f.db);expect(por.custodyTransition).toMatchObject({phase:'frozen',reserveAttested:false});
  const before=await fingerprint(f),backup=join(folder,'retired.dump');
  const dumped=await command('docker',['exec',container,'pg_dump','--username=shardkeep','--format=custom',f.database],{encoding:'buffer',maxBuffer:128*1024*1024,timeout:120_000});
  await writeFile(backup,dumped.stdout,{mode:0o600});
  await spendGems(f.db,f.buyer,1n,'fixture.restore.before-loss',randomUUID());expect(await fingerprint(f)).not.toEqual(before);
  await f.sql.end();await restore(container,f.database,await readFile(backup));reopened=createDb(env.TEST_DATABASE_URL,{max:4});
  expect(await fingerprint(reopened)).toEqual(before);await runMigrations(reopened.db);expect(await fingerprint(reopened)).toEqual(before);
  expect(await applyFixtureL1Retirement(request,env)).toEqual(retirement);expect(await applyFixtureUnbondingWithdrawalDrain(drainRequest,env)).toEqual(drain);
  expect(await f.capture()).toEqual(captured);expect(await getInclusionProof(reopened.db,f.seller)).toEqual(oldProof);
  expect(await buildWeeklySnapshot(reopened.db,new Date(at))).toEqual({...oldSnapshot,alreadyExisted:true});expect(await buildWeeklySnapshot(reopened.db,nextWeek)).toEqual(noRoot);
  expect(await getProofOfReserves(reopened.db)).toEqual(por);
  await expect(reopened.sql`update keep_custody_journal set input_hash=repeat('0',64)`).rejects.toThrow();
  await expect(reopened.sql`select shardkeep_advance_keep_custody_phase('frozen','open')`).rejects.toThrow();
  const operation=randomUUID();await spendGems(reopened.db,f.buyer,1n,'fixture.restore.resume',operation);
  const spent=await fingerprint(reopened);await spendGems(reopened.db,f.buyer,1n,'fixture.restore.resume',operation);expect(await fingerprint(reopened)).toEqual(spent);
  expect(await applyFixtureL1Retirement(request,env)).toEqual(retirement);expect(await applyFixtureUnbondingWithdrawalDrain(drainRequest,env)).toEqual(drain);
  await writeFile(join(folder,'result.json'),JSON.stringify({status:'passed',fixtureOnly:true,retirementAuthorized:false,database:f.database,
   sourcePrefix:'0094_tutorial_guide_skip',dump:backup,dumpSha256:sha(dumped.stdout),snapshotSha256:sha(JSON.stringify(before)),tables:before.data.length,
   retirement,drain,leagueWeek:WEEKS[1],historicalProofRetained:true,privateDefinitionsAndAclRetained:true,oldWorkerRefused:true},null,2),{mode:0o600});
  console.info('Verified custody restore artifacts: '+folder);
 }finally{await reopened?.sql.end();await f.dispose();vi.unstubAllEnvs();}
});
