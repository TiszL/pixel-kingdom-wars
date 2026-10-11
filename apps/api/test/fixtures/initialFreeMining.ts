import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { FORGE_INGOT, BUILD_COSTS } from '@shardkeep/shared';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { assertFreshLockedBaseAuthority } from '../../src/game/baseOwnership';
import { rewardBaseShards } from '../../src/game/baseEconomy';
import { collectRefine, startRefine } from '../../src/game/workshop';
import { reservePendingMiningIngots } from '../../src/game/miningIngotReservations';
import { enrollInitialFreeCohort, initializeFreeCohortCoverage } from '../../src/mining/freeCohort';
import { collectFreeWalletShadow } from '../../src/mining/freeWalletShadow';
import { collectMiningWalletExperience } from '../../src/mining/walletExperience';
import { initializeFreeGemsEvidence } from '../../src/mining/freeGemsEvidence';
import { initializeMiningDevelopmentHistory } from '../../src/mining/developmentHistory';
import { evaluateInitialFreeMiningScore } from '../../src/mining/initialFreeScore';
import { ADMIN_DATABASE_URL } from '../db-url';
import {createMigratedDatabase} from '../migratedTemplate';

import { initializeMiningRosterHistory } from '../../src/mining/rosterHistory';

export async function withInitialFreeMiningFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,options:Parameters<typeof setup>[0]={}) {
  const f=await setup(options);
  try {await run(f);} finally {f.restoreEnv();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
async function setup(options:{sourceCoverageAt?:string;birthAt?:string;roster?:boolean}={}) {
  const name=`mining_free_score_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('fixture host required');
  url.pathname=`/${name}`;const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await createMigratedDatabase(admin,name);
  const conn=createDb(url.toString(),{max:4});
  // Also used by the private-pipe native fixture, outside the Vitest runtime.
  // Restore only this fixture's flags; never erase its caller's test environment.
  const flags=['PHASE_E_MINING_ENABLED','PHASE_E_BUILDINGS_ENABLED','FORGE_INGOTS_ENABLED'];
  const prior=flags.map(key=>[key,process.env[key]] as const);
  const restoreEnv=()=>{for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
  try {
  await runMigrations(conn.db);
  for(const flag of flags) process.env[flag]='true';
  const clock=async(at:string|null)=>{for(const name of ['shardkeep_mining_free_clock','shardkeep_mining_development_clock','shardkeep_mining_roster_clock'])await conn.sql.unsafe(`create or replace function public.${name}() returns timestamptz language sql volatile as $$ select ${at?`'${at}'::timestamptz`:'clock_timestamp()'} $$`);};
  await clock('2019-12-30T00:00:00Z');await initializeFreeCohortCoverage(conn.db);await initializeFreeGemsEvidence(conn.db);
  await conn.sql`update playtest_activity_coverage set started_at=${options.sourceCoverageAt??'2019-12-30'}`;
  await clock('2019-12-31T12:00:00Z');
  const walletSigner=Keypair.generate(),wallet=walletSigner.publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58(),baseId=randomUUID();
  await conn.sql`insert into players(wallet,created_at) values(${wallet},${options.birthAt??'2019-12-31'}),(${buyer},${options.birthAt??'2019-12-31'})`;
  await conn.sql`insert into bases(id,owner_wallet,created_at,keep_level) values(${baseId},${wallet},'2019-12-31',${BUILD_COSTS.workshop.requiresKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'keep',${BUILD_COSTS.workshop.requiresKeepLevel},10,10),(${wallet},${baseId},'workshop',1,20,20)`;
  const context={baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],w:string,b:string)=>{await assertFreshLockedBaseAuthority(tx,w,b,new Date());}};
  await enrollInitialFreeCohort(conn.db,wallet,context);
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'goldforge',1,25,25)`;
  await initializeMiningDevelopmentHistory(conn.db,baseId);
  if(options.roster)await initializeMiningRosterHistory(conn.db,wallet);
  await rewardBaseShards(conn.db,baseId,BigInt(FORGE_INGOT.shardsPerIngot)*100n,'test.shadow.fund',randomUUID());
  const reserve=async(day:string,qty=1,epochDay=day,actor=wallet,targetBase=baseId)=>{
    const targetContext={...context,baseId:targetBase};
    await clock(`${day}T06:00:00Z`);
    const job=await startRefine(conn.db,actor,targetBase,qty,FORGE_INGOT.recipeVersion,randomUUID(),new Date(`${day}T06:00:00Z`),targetContext);
    const ready=new Date(job.readyAt);await clock(ready.toISOString());
    await collectRefine(conn.db,actor,targetBase,job.jobId,randomUUID(),ready,targetContext);
    const receipt={...await reservePendingMiningIngots(conn.db,actor,{epochKey:`free-shadow-v1:${epochDay}`,baseId:targetBase,ingots:qty,idempotencyKey:randomUUID()},targetContext,ready)};
    return {job,receipt};
  };
  const battle=async(day:string,pending=false,at=`${day}T12:00:00Z`)=>{
    const id=randomUUID();await clock(at);
    await conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
      values(${id},${wallet},${baseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at)-1000).toISOString()})`;
    await conn.sql`update player_action_events set occurred_at=${at} where source_id=${id} and source_key='battle_fought'`;
    const finish=async(resolvedAt=at)=>{await conn.sql`update raids set status='resolved',result='{"stars":1,"retreated":false}',resolved_at=${resolvedAt} where id=${id}`;
      await conn.sql`update player_action_events set occurred_at=${resolvedAt} where source_id=${id} and source_key='pve_battle'`;};
    if(!pending) await finish();return {id,finish};
  };
  const input=(day:string)=>({day,wallet,policyVersion:'free-shadow-v1'});
  const collect=async(day:string)=>{await collectFreeWalletShadow(conn.db,input(day));return collectMiningWalletExperience(conn.db,{day,policyVersion:1});};
  const evaluate=(day:string)=>evaluateInitialFreeMiningScore(conn.db,{wallet,day,policyVersion:1});
  return {name,url,admin,conn,wallet,walletSigner,buyer,baseId,context,clock,reserve,battle,input,collect,evaluate,restoreEnv};
  } catch(error) {restoreEnv();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}
