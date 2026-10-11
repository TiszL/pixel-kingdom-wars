import { bootstrapSystemAccounts, postTransaction, getOrCreatePlayerAccount } from '../../src/ledger';
import { fundGemsRewardBudget, grantGems } from '../../src/game/gemsGrants';
import { PLAYTEST } from '@shardkeep/shared';
import { collectMiningActivityEvidence } from '../../src/mining/activityEvidence';
/** Real Workshop custody, prospective source histories and finalized Core/term banks.
 * Raw fixture rows establish a disposable world; readers and award verifiers are real. */
import { initializeMiningSeekerLinkHistory } from '../../src/mining/seekerLinkHistory';
import { activateHeldFantasyLocation, installFantasyCatalog } from '../../src/game/fantasyLocation';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, crownlandsMigrationTiles } from '@shardkeep/shared/fantasyWorld';
import { fantasyManifestHash } from '../../src/db/fantasyMigration';
import { createInitialFreePublicationSources } from './initialFreePublication';
import { fixture as deedBank, tx as deedTx } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { createFundedMiningPublicationPreparer } from '../../src/mining/fundedMiningAllocation';
import { randomBytes, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { createDepositIntent, creditDeposit } from '../../src/money/deposits';
import { configureDeedMinter, mintDeedIfConfigured } from '../../src/game/deed';
import postgres from 'postgres';
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { FORGE_INGOT, BUILD_COSTS, ECONOMY } from '@shardkeep/shared';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { runMiningPublicationFixtureMigrations } from './miningPublicationClock';
import { refreshBaseOwnership, assertFreshLockedBaseAuthority } from '../../src/game/baseOwnership';
import { rewardBaseShards } from '../../src/game/baseEconomy';
import { collectRefine, startRefine } from '../../src/game/workshop';
import { reservePendingMiningIngots } from '../../src/game/miningIngotReservations';
import { enrollInitialFreeCohort, initializeFreeCohortCoverage } from '../../src/mining/freeCohort';
import { collectFreeWalletShadow } from '../../src/mining/freeWalletShadow';
import { collectMiningWalletExperience } from '../../src/mining/walletExperience';
import { initializeGemsFlowEvidence } from '../../src/mining/gemsFlowEvidence';
import { initializeFreeGemsEvidence } from '../../src/mining/freeGemsEvidence';
import { initializeMiningDevelopmentHistory } from '../../src/mining/developmentHistory';
import { evaluateInitialFreeMiningScore } from '../../src/mining/initialFreeScore';
import { ADMIN_DATABASE_URL } from '../db-url';
import {createMigratedDatabase} from '../migratedTemplate';

import { initializeMiningRosterHistory } from '../../src/mining/rosterHistory';

const LAND_PRICE_LAMPORTS=Math.round(ECONOMY.entryFeeSol*LAMPORTS_PER_SOL);
async function withBaseFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>,options:Parameters<typeof setup>[0]={}) {
  const f=await setup(options);
  try {await run(f);} finally {f.restoreEnv();await f.conn.sql.end();await f.admin.unsafe(`drop database ${f.name} with (force)`);await f.admin.end();}
}
function fixtureCalendar(firstDay='2020-01-01'){
 const shift=Date.parse(firstDay)-Date.parse('2020-01-01');
 return (value:string)=>{const at=new Date(Date.parse(value)+shift).toISOString();return value.length===10?at.slice(0,10):at;};
}
async function setup(options:{sourceCoverageAt?:string;birthAt?:string;roster?:boolean;replayFirstDay?:string;resourceClock?:()=>Date;enrollmentClock?:boolean;publicationClock?:boolean;delayedSeekerMarker?:boolean;precoverageBuyer?:boolean;precoverageBuyerZero?:boolean}={}) {
  if(options.publicationClock&&(options.enrollmentClock||options.precoverageBuyer||options.delayedSeekerMarker))throw new Error('publication clock requires ordinary prospective coverage ordering');
  const calendar=fixtureCalendar(options.replayFirstDay);
  const name=`mining_free_score_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('fixture host required');
  url.pathname=`/${name}`;const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});// The publication clock is injected mid-chain, so that path replays every migration.
  await (options.publicationClock?admin.unsafe(`create database ${name}`):createMigratedDatabase(admin,name));
  const conn=createDb(url.toString(),{max:4});
  // Also used by the private-pipe native fixture, outside the Vitest runtime.
  // Restore only this fixture's flags; never erase its caller's test environment.
  const flags=['PHASE_E_MINING_ENABLED','PHASE_E_BUILDINGS_ENABLED','FORGE_INGOTS_ENABLED','GEMS_ENABLED'];
  const prior=[...flags,'FANTASY_WORLD_ENABLED','MULTI_BASE_ENABLED'].map(key=>[key,process.env[key]] as const);
  const restoreEnv=()=>{for(const [key,value] of prior){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
  try {
  const publicationClock=options.publicationClock?await runMiningPublicationFixtureMigrations(conn,calendar('2019-12-30T00:00:00Z')):null;
  if(!publicationClock)await runMigrations(conn.db);
  // Autovacuum stays out of this disposable database (K-night-R3d, r4-timeouts-batch 2026-10-11).
  // The mining source captures take SHARE locks NOWAIT (fantasy_world_tiles, bases, deposits,
  // players, ledger_*, ...) and answer BUSY on 55P03; autovacuum's VACUUM/ANALYZE holds SHARE UPDATE
  // EXCLUSIVE on its table. Later in this fixture installFantasyCatalog inserts 85,414 tiles, far past both
  // autovacuum thresholds. Measured on the night Mac: that lock held on fantasy_world_tiles makes
  // the first legacy publication of mining-resource-publication case 1 fail exactly as CI run
  // 38120909148 did (FundedMiningAllocationError BUSY, 7.9 s in), and an autovacuum visit after the
  // insert VACUUM ANALYZEs the tiles unless this opt-out is set. Since the fixture clones a template,
  // the database exists 0.2 s before the case body, so the launcher's first visit to it (a new
  // database is picked first) can land in the body; with a per-case replay it most likely fell
  // inside the replay, before the insert (inferred, not measured). No case on this fixture is about autovacuum.
  await conn.sql.unsafe(`do $$ declare t regclass; begin
    for t in select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','drizzle')
    loop execute format('alter table %s set (autovacuum_enabled=false)',t); end loop; end $$`);
  for(const flag of flags) process.env[flag]='true';
  const enrollmentClock=options.enrollmentClock?await (await import('./seekerMiningEnrollment')).installMiningSeekerEnrollmentFixtureClock(conn):null;
  const clock=async(at:string|null)=>{
    if(publicationClock)return publicationClock(at);
    if(enrollmentClock)await enrollmentClock(at??new Date().toISOString());
    for(const name of enrollmentClock?['shardkeep_mining_development_clock','shardkeep_mining_roster_clock']:['shardkeep_mining_free_clock','shardkeep_mining_development_clock','shardkeep_mining_roster_clock'])await conn.sql.unsafe(`create or replace function public.${name}() returns timestamptz language sql volatile as $$ select ${at?`'${at}'::timestamptz`:'clock_timestamp()'} $$`);
  };
  const walletSigner=Keypair.generate(),wallet=walletSigner.publicKey.toBase58(),buyerSigner=Keypair.generate(),buyer=buyerSigner.publicKey.toBase58(),baseId=randomUUID();
  if(options.precoverageBuyer){
    // D217 genuine existing identity and funded Gems before prospective capture.
    // Neither the original player INSERT nor grant can become a captured birth/origin.
    await clock(calendar('2019-12-29T23:00:00Z'));
    await conn.sql`insert into players(wallet,created_at) values(${buyer},${calendar('2019-12-29T23:00:00Z')})`;
    if(options.precoverageBuyerZero)await getOrCreatePlayerAccount(conn.db,buyer,'player_gems');
    else {
    const sys=await bootstrapSystemAccounts(conn.db);
    await postTransaction(conn.db,{idempotencyKey:randomUUID(),type:'fixture.existing-wallet.budget',entries:[{account:sys.keep_genesis,delta:-BigInt(PLAYTEST.welcomeGems)},{account:sys.emission_pool,delta:BigInt(PLAYTEST.welcomeGems)}]});
    await fundGemsRewardBudget(conn.db,BigInt(PLAYTEST.welcomeGems),randomUUID());
    await grantGems(conn.db,{wallet:buyer,gems:BigInt(PLAYTEST.welcomeGems),reason:'welcome'});
    }
  }
  await clock(calendar('2019-12-30T00:00:00Z'));await initializeFreeCohortCoverage(conn.db);await initializeFreeGemsEvidence(conn.db);if(!options.delayedSeekerMarker)await initializeMiningSeekerLinkHistory(conn.db);await initializeGemsFlowEvidence(conn.db);
  await conn.sql`update playtest_activity_coverage set started_at=${options.sourceCoverageAt??calendar('2019-12-30')}`;
  await clock(calendar('2019-12-31T12:00:00Z'));
  if(options.precoverageBuyer){
    if(options.delayedSeekerMarker)await initializeMiningSeekerLinkHistory(conn.db);
    await conn.sql`insert into players(wallet,created_at) values(${wallet},${calendar('2019-12-31T12:00:00Z')})`;
  }else if(options.delayedSeekerMarker){
    // D153.209 coverage order: the buyer's captured birth follows identity/Gems/activity coverage but
    // precedes a later Seeker-link marker (journal floor and clock); the free wallet stays an ordinary
    // post-marker birth so its recorded link history is genuinely readable. Unset keeps the original order.
    await conn.sql`insert into players(wallet,created_at) values(${buyer},${options.birthAt??calendar('2019-12-31')})`;
    await clock(calendar('2019-12-31T12:30:00Z'));await initializeMiningSeekerLinkHistory(conn.db);
    await clock(calendar('2019-12-31T12:45:00Z'));await conn.sql`insert into players(wallet,created_at) values(${wallet},${calendar('2019-12-31T12:45:00Z')})`;
  }else await conn.sql`insert into players(wallet,created_at) values(${wallet},${options.birthAt??calendar('2019-12-31')}),(${buyer},${options.birthAt??calendar('2019-12-31')})`;
  await conn.sql`insert into bases(id,owner_wallet,created_at,keep_level) values(${baseId},${wallet},${calendar('2019-12-31')},${BUILD_COSTS.workshop.requiresKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'keep',${BUILD_COSTS.workshop.requiresKeepLevel},10,10),(${wallet},${baseId},'workshop',1,20,20)`;
  const context={baseId,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],w:string,b:string)=>{await assertFreshLockedBaseAuthority(tx,w,b,new Date());}};
  await enrollInitialFreeCohort(conn.db,wallet,context);
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'goldforge',1,25,25)`;
  await initializeMiningDevelopmentHistory(conn.db,baseId);
  if(options.roster)await initializeMiningRosterHistory(conn.db,wallet);
  await rewardBaseShards(conn.db,baseId,BigInt(FORGE_INGOT.shardsPerIngot)*100n,'test.shadow.fund',randomUUID());
  const reserve=async(day:string,qty=1,epochDay=day,actor=wallet,targetBase=baseId,policyVersion:1|2=1)=>{
    const targetContext={...context,baseId:targetBase};
    await clock(`${day}T06:00:00Z`);
    const job=await startRefine(conn.db,actor,targetBase,qty,FORGE_INGOT.recipeVersion,randomUUID(),new Date(`${day}T06:00:00Z`),targetContext);
    const ready=new Date(job.readyAt);await clock(ready.toISOString());
    await collectRefine(conn.db,actor,targetBase,job.jobId,randomUUID(),ready,targetContext);
    const receipt={...await reservePendingMiningIngots(conn.db,actor,{epochKey:`free-shadow-v${policyVersion}:${epochDay}`,baseId:targetBase,ingots:qty,idempotencyKey:randomUUID()},targetContext,ready)};
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
  const collect=async(day:string)=>{
    if(options.resourceClock)await collectMiningActivityEvidence(conn.db,{day,policyVersion:'battle-evidence-v1'},options.resourceClock);
    await collectFreeWalletShadow(conn.db,input(day));return collectMiningWalletExperience(conn.db,{day,policyVersion:1},options.resourceClock);
  };
  const evaluate=(day:string)=>evaluateInitialFreeMiningScore(conn.db,{wallet,day,policyVersion:1});
  return {name,url,admin,conn,wallet,walletSigner,buyer,buyerSigner,baseId,context,clock,reserve,battle,input,collect,evaluate,restoreEnv};
  } catch(error) {restoreEnv();await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();throw error;}
}

export type FundedMiningFixtureOptions={classification?:'migration'|'purchase'|'dev'|'migration-inactive'|'migration-hash'|'migration-entry';replayFirstDay?:string;resourceClock?:()=>Date;enrollmentClock?:boolean;publicationClock?:boolean;delayedSeekerMarker?:boolean;precoverageBuyer?:boolean;precoverageBuyerZero?:boolean};
export async function withFundedMiningFixture(run: (f: Awaited<ReturnType<typeof extend>>) => Promise<void>,options:FundedMiningFixtureOptions={}) {
  return withBaseFixture(async f => run(await extend(f,options)), {roster:true,...(options.publicationClock?{publicationClock:true}:{}),...(options.precoverageBuyer?{precoverageBuyer:true,precoverageBuyerZero:options.precoverageBuyerZero}:{}),...(options.enrollmentClock?{enrollmentClock:true}:{}),...(options.delayedSeekerMarker?{delayedSeekerMarker:true}:{}),...(options.replayFirstDay?{replayFirstDay:options.replayFirstDay}:{}),...(options.resourceClock?{resourceClock:options.resourceClock}:{})});
}
async function extend(f: Parameters<Parameters<typeof withBaseFixture>[0]>[0],options:FundedMiningFixtureOptions) {
  const calendar=fixtureCalendar(options.replayFirstDay),resourceClock=options.resourceClock;
  const paidBaseId = randomUUID(), assetId = Keypair.generate().publicKey.toBase58();
  await f.clock(calendar('2019-12-31T14:00:00Z'));
  await f.conn.sql`insert into bases(id,owner_wallet,created_at,keep_level,land_paid_at,deed_asset_id)
    values(${paidBaseId},${f.buyer},${calendar('2019-12-31')},${BUILD_COSTS.workshop.requiresKeepLevel},${options.classification==='purchase'?null:calendar('2019-12-31')},${options.classification==='purchase'?null:assetId})`;
  await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.buyer},1,${paidBaseId})`;
  await f.conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
    (${f.buyer},${paidBaseId},'keep',${BUILD_COSTS.workshop.requiresKeepLevel},10,10),
    (${f.buyer},${paidBaseId},'workshop',1,20,20),(${f.buyer},${paidBaseId},'goldforge',1,25,25)`;
  await rewardBaseShards(f.conn.db,paidBaseId,BigInt(FORGE_INGOT.shardsPerIngot)*100n,'test.funded.mine',randomUUID());
  await f.conn.db.transaction(tx=>installFantasyCatalog(tx));
  const tile=crownlandsMigrationTiles()[0]!;
  if(options.classification==='purchase'){
    process.env['FANTASY_WORLD_ENABLED']='true';process.env['MULTI_BASE_ENABLED']='true';
    // The real writers omit createdAt, so the disposable DB clock supplies the
    // historical creation instant prospectively. No source row is backdated.
    for(const table of ['deposits','fantasy_land_claims','plot_reservations'])await f.conn.sql.unsafe(`alter table ${table} alter column created_at set default public.shardkeep_mining_free_clock()`);
    const now=new Date(calendar('2019-12-31T14:00:00Z'));
    const intent=await createDepositIntent(f.conn.db,f.buyer,'entry',{landAddress:{kind:'fantasy',worldId:FANTASY_WORLD_ID,tileId:tile.tileId}},now);
    if(!('baseId' in intent)||intent.baseId!==paidBaseId)throw Error('Purchase must reuse original onboarding base');
    const credited=await creditDeposit(f.conn.db,intent.id,{wallet:f.buyer,kind:'entry',txSignature:bs58.encode(randomBytes(64)),lamports:BigInt(LAND_PRICE_LAMPORTS),finalized:true},now,{eventClock:()=>now});
    if(!credited.credited||credited.baseId!==paidBaseId)throw Error('Actual purchase credit required');
    configureDeedMinter({assetFor:()=>assetId,mint:async(_wallet,_base,expected)=>({asset:expected})});
    try{await mintDeedIfConfigured(f.conn.db,f.buyer,paidBaseId);}finally{configureDeedMinter(null);}
    const [minted]=await f.conn.sql`select deed_asset_id,deed_mint_asset_id,deed_minting_at from bases where id=${paidBaseId}`;
    if(minted?.deed_asset_id!==assetId||minted.deed_mint_asset_id!==assetId||minted.deed_minting_at!==null)throw Error('Actual fixed mint attachment required');
  }else if(options.classification==='dev'){
    // Malformed historical fixture has the same assigned ordinary claim shape,
    // but no real SOL payment/reservation/mint graph. NULL mint alone is not proof.
    const depositId=randomUUID();
    await f.conn.sql`insert into deposits(id,player_wallet,kind,reference,status,amount,payload,created_at,finalized_at)
      values(${depositId},${f.buyer},'entry',${`dev-fantasy:${paidBaseId}`},'credited',0,${JSON.stringify({baseId:paidBaseId,devFixture:true,amountLamports:LAND_PRICE_LAMPORTS})}::jsonb,${calendar('2019-12-31T14:00:00Z')},${calendar('2019-12-31T14:00:00Z')})`;
    await f.conn.sql`insert into fantasy_land_claims(world_id,tile_id,base_id,state,source,deposit_id,created_at,assigned_at)
      values(${FANTASY_WORLD_ID},${tile.tileId},${paidBaseId},'assigned','purchase',${depositId},${calendar('2019-12-31T14:00:00Z')},${calendar('2019-12-31T14:00:00Z')})`;
  }else{
    const held=options.classification==='migration-inactive';
    const manifest={version:1 as const,worldId:FANTASY_WORLD_ID,catalogHash:FANTASY_CATALOG_HASH,snapshotAt:calendar('2019-12-31T14:00:00.000Z'),
      entries:[{baseId:paidBaseId,mintId:options.classification==='migration-entry'?Keypair.generate().publicKey.toBase58():assetId,
        ownerWallet:held?Keypair.generate().publicKey.toBase58():f.buyer,tileId:tile.tileId,state:held?'held' as const:'assigned' as const}],exclusions:[]};
    const manifestHash=options.classification==='migration-hash'?'a'.repeat(64):fantasyManifestHash(manifest);
    await f.conn.sql`insert into fantasy_migration_batches(manifest_hash,world_id,manifest) values(${manifestHash},${FANTASY_WORLD_ID},${JSON.stringify(manifest)}::jsonb)`;
    await f.conn.sql`insert into fantasy_land_claims(world_id,tile_id,base_id,state,source,expected_mint,manifest_hash,created_at,assigned_at)
      values(${FANTASY_WORLD_ID},${tile.tileId},${paidBaseId},${held?'held':'assigned'},${held?'migration-inactive':'migration-active'},${assetId},${manifestHash},${calendar('2019-12-31T14:00:00Z')},${held?null:calendar('2019-12-31T14:00:00Z')})`;
    if(held){
      const now=new Date(calendar('2019-12-31T15:00:00Z')),bank=chain(calendar('2020-01-01'));await f.clock(now.toISOString());
      await refreshBaseOwnership(f.conn.db,paidBaseId,async()=>({owner:f.buyer,slot:25,collection:bank.input.collection,frozen:false,delegate:null}),bank.input.collection,now);
      await f.conn.db.transaction(tx=>activateHeldFantasyLocation(tx,f.buyer,paidBaseId,now));
    }
  }
  await initializeMiningDevelopmentHistory(f.conn.db,paidBaseId); await initializeMiningRosterHistory(f.conn.db,f.buyer);
  function chain(day: string, outBack=false) {
    const start=Date.parse(day+'T00:00:00Z')/1000,end=start+86400,id=new PublicKey(assetId),owner=new PublicKey(f.buyer);
    const times:Record<number,number>={1:start-100,10:start-1,12:start+100,13:start+200,19:end,20:end+1,21:end+2,25:end+3};
    const rows=[deedTx('collection',1),deedTx('mint',10,owner,id)];
    if(outBack){const other=Keypair.generate().publicKey; rows.push(deedTx('transfer',12,other,id,owner),deedTx('transfer',13,owner,id,other));}
    for(const row of rows)row.blockTime=times[row.slot]!;
    const bank=deedBank(rows,[{id,owner}]);
    bank.reader.getBlockTime.mockImplementation(async slot=>times[slot]??null);
    bank.reader.getBlockSignatures.mockImplementation(async slot=>({blockTime:times[slot]!,signatures:rows.filter(row=>row.slot===slot).map(row=>row.transaction.signatures[0])}));
    return bank;
  }
  async function admit(day='2020-01-01',options:{outBack?:boolean;paidQuantity?:number;freeQuantity?:number;policyVersion?:1|2}={}) {
    const bank=chain(day,options.outBack);
    const refresh=async()=>{
      // Other composed journeys may already have observed a newer Core slot.
      // Inject a finalized bank above that floor, never stale25 after a trial.
      const [floor]=await f.conn.sql`select coalesce(max(slot),25)::text slot from deed_ownership_observations where base_id=${paidBaseId}`;
      return refreshBaseOwnership(f.conn.db,paidBaseId,async()=>({owner:f.buyer,slot:Number(floor!.slot)+1,collection:bank.input.collection,frozen:false,delegate:null}),bank.input.collection);
    };
    await refresh();const free=await f.reserve(day,options.freeQuantity??1,day,f.wallet,f.baseId,options.policyVersion);await refresh();const paid=await f.reserve(day,options.paidQuantity??1,day,f.buyer,paidBaseId,options.policyVersion);
    await f.battle(day);
    const raid=randomUUID(),at=day+'T12:01:00Z';await f.clock(at);
    await f.conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
      values(${raid},${f.buyer},${paidBaseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at)-1000).toISOString()})`;
    await f.conn.sql`update player_action_events set occurred_at=${at} where source_id=${raid} and source_key='battle_fought'`;
    await f.conn.sql`update raids set status='resolved',result='{"stars":1,"retreated":false}',resolved_at=${at} where id=${raid}`;
    await f.conn.sql`update player_action_events set occurred_at=${at} where source_id=${raid} and source_key='pve_battle'`;
    await f.clock(resourceClock?.().toISOString()??null);await f.collect(calendar('2019-12-31'));await f.collect(day);
    return {free,paid,bank};
  }
  async function stage(day='2020-01-01',options:{outBack?:boolean;paidQuantity?:number;freeQuantity?:number;policyVersion?:1|2}={}) {
    const {free,paid,bank}=await admit(day,options),source=await createInitialFreePublicationSources(f);
    const signer=Keypair.generate();source.backing.model.publisher=signer.publicKey;source.backing.model.flags=0;await source.backing.config();
    const sources={...source.sources,qualification:{source:()=>chain(day,options.outBack).reader as unknown as DeedMiningWalletReader,
      collection:bank.input.collection,expectedGenesisHash:bank.input.expectedGenesisHash}};
    const request={epochId:free.receipt.epochId,day,policyVersion:options.policyVersion??1,attemptKey:randomUUID()};
    const optionsForPrepare={sources,signer:signer.publicKey,blockhashSource:()=>({getGenesisHash:async()=>source.backing.trust.expectedGenesisHash,
      getLatestBlockhashAndContext:async()=>({context:{slot:2000},value:{blockhash:new PublicKey(Buffer.alloc(32,91)).toBase58(),lastValidBlockHeight:2200}})})};
    return {request,sources,backing:source.backing,signer,optionsForPrepare,free,paid,prepare:createFundedMiningPublicationPreparer(f.conn.db,optionsForPrepare)};
  }
  return {...f,paidBaseId,assetId,admit,stage};
}
