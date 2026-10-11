import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {vi} from 'vitest';
import type {createDb} from '../../src/db/client';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount,postTransaction} from '../../src/ledger';
import {fundGemsRewardBudget,grantGems} from '../../src/game/gemsGrants';
import {initializeGemsFlowEvidence} from '../../src/mining/gemsFlowEvidence';
import {captureExistingMiningWallet,readExistingMiningWalletBaseline} from '../../src/mining/existingMiningWallet';
import {withWalletActivityFixture} from './walletActivity';
/** One test-only reseal before any baseline in an isolated loopback database.
 * Production trigger bytes/enabled state are preserved, not bypassed at capture. */
export async function resealExistingMiningWalletFixtureClock(conn:ReturnType<typeof createDb>):Promise<void>{
 if(!conn.sql.options.host.every(h=>['localhost','127.0.0.1','::1'].includes(h)))throw Error('existing-wallet fixture requires loopback');
 const [r]=await conn.sql`select current_database() name,(select count(*)::int from mining_existing_wallet_baselines) n`;
 if(!r||!/^\w+_test$/.test(r.name)||r.n!==0)throw Error('existing-wallet fixture requires empty disposable baselines');
 await conn.db.transaction(async tx=>{
  const [c]=await tx.execute<{record:unknown}>(sql`select public.shardkeep_mining_existing_wallet_contract() record`);if(!c)throw Error('missing source contract');
  await tx.execute(sql`alter table public.mining_existing_wallet_contract disable trigger mining_existing_wallet_contract_immutable`);
  await tx.execute(sql`update public.mining_existing_wallet_contract set record=${JSON.stringify(c.record)}::jsonb where singleton`);
  await tx.execute(sql`alter table public.mining_existing_wallet_contract enable trigger mining_existing_wallet_contract_immutable`);
 });
}
export async function withExistingMiningWalletFixture(run:(f:Awaited<ReturnType<typeof extend>>)=>Promise<void>,options:Parameters<typeof withWalletActivityFixture>[1]={}){
 await withWalletActivityFixture(async f=>run(await extend(f)),{birthAt:'2019-12-01T00:00:00Z',observedBirthAt:'2019-12-01T00:00:00Z',identityCoverageAt:'2019-12-30T00:00:00Z',activityCoverageAt:'2020-01-01T00:00:00Z',birthBeforeInitialization:true,...options});
}
type Base=Parameters<Parameters<typeof withWalletActivityFixture>[0]>[0];
async function extend(f:Base){
 vi.stubEnv('GEMS_ENABLED','true');
 await f.conn.sql`create table public.test_existing_mining_wallet_clock(id boolean primary key check(id),at timestamptz not null check(isfinite(at)))`;
 await f.conn.sql`insert into public.test_existing_mining_wallet_clock values(true,'2019-12-31T00:00:00Z')`;
 await f.conn.sql`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile set search_path=pg_catalog,public,pg_temp as $$ select at from public.test_existing_mining_wallet_clock where id $$`;
 await resealExistingMiningWalletFixtureClock(f.conn);
 const clock=async(at:string)=>{if(!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at)&&!/^2019-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at))throw Error('fixture clock');await f.conn.sql`update public.test_existing_mining_wallet_clock set at=${at}::timestamptz where id`;};
 const sys=await bootstrapSystemAccounts(f.conn.db),gems=await getOrCreatePlayerAccount(f.conn.db,f.wallet,'player_gems');
 // Real conserved ledger posting predates flow capture; no origin is inferred.
 await postTransaction(f.conn.db,{idempotencyKey:randomUUID(),type:'fixture.opening.budget',entries:[{account:sys.keep_genesis,delta:-50n},{account:sys.emission_pool,delta:50n}]});
 await fundGemsRewardBudget(f.conn.db,50n,randomUUID());await grantGems(f.conn.db,{wallet:f.wallet,gems:50n,reason:'dev'});
 await initializeGemsFlowEvidence(f.conn.db);
 const raid=async(day:string,options:{baseId?:string;at?:string;stars?:number;retreated?:boolean}={})=>{
  const id=randomUUID(),baseId=options.baseId??f.bases[0]!,at=options.at??day+'T12:00:00.000Z',resolved=new Date(Date.parse(at)+1000).toISOString();await clock(at);
  await f.conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
   values(${id},${f.wallet},${baseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at)-1000).toISOString()})`;
  await f.conn.sql`update player_action_events set occurred_at=${at} where source_id=${id} and source_key='battle_fought'`;
  await f.conn.sql`update raids set status='resolved',result=${JSON.stringify({stars:options.stars??1,retreated:options.retreated??false})}::jsonb,resolved_at=${resolved} where id=${id}`;
  await f.conn.sql`update player_action_events set occurred_at=${resolved} where source_id=${id} and source_key='pve_battle'`;return {id,baseId,at};
 };
 const capture=async(at='2020-01-03T12:00:00.000000Z')=>{await clock(at);await captureExistingMiningWallet(f.conn.db,f.wallet);return readExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet});};
 const close=()=>clock('2020-01-05T00:00:00.000000Z');
 return {...f,sys,gems,clock,raid,capture,close};
}
