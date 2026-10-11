/** Normal source composition over actual loopback RPC and segregated LOGINs.
 * Encoded fixture accounts/signatures are not live program or funding evidence. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import {PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION} from '@shardkeep/shared';
import {afterEach,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {realmSaleRuntimeRpc} from './fixtures/realmSaleRuntime';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHarvesterFixture} from './fixtures/harvesters';
import {TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {createRealmSaleRuntime} from '../src/seeker/realmSaleRuntime';
import {createPhaseEServices} from '../src/phaseEServices';
import {prefetchOperatingExpeditionTermReader} from '../src/game/operatingExpeditionTermReader';
import {prefetchHistoricalShardsTermAt} from '../src/mining/shardsTaxHistoricalTermDiscovery';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function chain(){
 const f=await realmSaleQuoteFixture({genesisHash:SOLANA_GENESIS_HASH.devnet});
 f.bodies.clear();f.history.clear();
 const start=new Date(Math.floor((Date.now()-2*86_400_000)/86_400_000)*86_400_000),first=BigInt(+start/1000)-BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec);
 async function round(n:bigint){
  const day=new Date(Number(first+n*BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec)+BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec))*1000).toISOString().slice(0,10);
  const bank=await createMiningTermFixture({day,genesisHash:f.termPolicy.genesisHash,programId:f.termPolicy.programId,
   programData:f.programData,programDataAddress:f.programDataAddress,upgradeAuthority:f.upgradeAuthority,
   round:n,firstOperatingStart:first,mint:f.termPolicy.mint,prizeOwner:f.termPolicy.prizeOwner,winners:[{spotId:0,wallet:f.seller}]});
  for(const [k,v] of bank.store)f.store.set(k,v);
  for(const [k,v] of bank.bodies){f.bodies.set(k,v);f.history.set(v.transaction.message.staticAccountKeys[3]!.toBase58(),k);}
  time(new Date(day+'T01:00:00.000Z'));
 }
 function time(at:Date){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);f.controls.now=BigInt(Math.floor(+at/1000));}
 await round(0n);const rpc=await realmSaleRuntimeRpc(f);
 const config={...TEST_CONFIG,SOLANA_RPC_URL:rpc.url,SEEKER_REALM_SALE_PROGRAM_ID:f.termPolicy.programId.toBase58(),
  SEEKER_REALM_SALE_DEPLOYMENT_SLOT:f.accessTrust.reviewedDeploymentSlot,SEEKER_REALM_SALE_PROGRAM_DATA_SHA256:f.accessTrust.reviewedProgramDataSha256,
  SEEKER_REALM_SALE_UPGRADE_AUTHORITY:f.upgradeAuthority.toBase58(),SEEKER_REALM_SALE_AUCTION_MINT:f.termPolicy.mint.toBase58(),
  SEEKER_REALM_SALE_PRIZE_OWNER:f.termPolicy.prizeOwner.toBase58(),SEEKER_REALM_SALE_DEVELOPER:f.developer.toBase58(),
  SEEKER_REALM_SALE_ROUND:'999',SEEKER_REALM_SALE_POLICY_REVISION:'gameplay-r1',SEEKER_REALM_SALE_STATE_PROVENANCE:'fresh-reviewed-deployment' as const};
 return {f,rpc,config,time,round};
}
it('discovers current rounds independently of sale quotes, retains historical originals and refuses changed pins or mid-read rollover',async()=>{
 const f=await chain(),runtime=createRealmSaleRuntime(f.config)!,source=runtime.gameplaySources.term;
 try{
  expect(runtime.preparationSources.policy.term.round).toBe(999n);expect(source.policy).not.toHaveProperty('round');
  const connector=source.connect(new AbortController().signal);
  expect(Object.keys(connector).sort()).toEqual(['getBlock','getGenesisHash','getMultipleAccountsInfoAndContext','getSignaturesForAddress','getTransaction']);
  expect(Object.keys(runtime.gameplaySources.access.connect(new AbortController().signal)).sort()).toEqual(['getGenesisHash','getMultipleAccountsInfoAndContext','getSlot']);
  const originalAt=new Date().toISOString(),reader=await prefetchOperatingExpeditionTermReader(source.connect,source.policy),proof=(await reader.readOperatingTerm(originalAt))!;
  expect(proof.snapshot.source.round).toBe('0');expect(proof.snapshot.spots[0]!.ownerWallet).toBe(f.f.seller.toBase58());
  await expect(reader.readOperatingTerm(originalAt)).rejects.toThrow('already consumed');
  await f.round(1n);const next=await prefetchOperatingExpeditionTermReader(source.connect,source.policy);
  expect((await next.readOperatingTerm(new Date().toISOString()))!.snapshot.source.round).toBe('1');
  const original=await prefetchHistoricalShardsTermAt(source.connect,source.policy,originalAt);
  expect(original.snapshot.source.round).toBe('0');expect(original.operatingAdmissionAuthorized).toBe(false);
  const bad=createRealmSaleRuntime({...f.config,SEEKER_REALM_SALE_PROGRAM_DATA_SHA256:'f'.repeat(64)})!;
  try{await expect(prefetchOperatingExpeditionTermReader(bad.gameplaySources.term.connect,bad.gameplaySources.term.policy)).rejects.toThrow();}finally{bad.close();}
  let reads=0;f.f.controls.beforeRead=async()=>{if(++reads===2)f.f.controls.now+=BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec);};
  await expect(prefetchOperatingExpeditionTermReader(source.connect,source.policy)).rejects.toThrow();
  expect(f.rpc.sent).toHaveLength(0);runtime.close();await expect(connector.getGenesisHash()).rejects.toThrow();
 }finally{runtime.close();await f.rpc.close();}
},120_000);
it('mounts current starter and Harvester authority through restricted HTTP and keeps originals available across pause and providerless restart',async()=>{
 const chainFixture=await chain(),conn=resourceClaimsDatabase();await conn.setup();
 const [database]=await conn.sql`select current_database() name`;const ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='seeker_game_'+suffix,worker='seeker_worker_'+suffix,password=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30_000,maxBuffer:2*1024*1024,
  env:{PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),
   POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:2});
 const config={...chainFixture.config,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString()},runtime=createRealmSaleRuntime(config)!;
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_EXPEDITIONS_ENABLED','HARVESTERS_ENABLED','FREE_ONBOARDING'])vi.stubEnv(flag,'true');
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
 const f=await createHarvesterFixture(conn.db,{now:new Date()});
 const [session]=await conn.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)},headers={origin:config.WEB_ORIGIN[0]!};
 let services=await createPhaseEServices(config,request.db,{},undefined,undefined,undefined,undefined,runtime.gameplaySources),app=await buildApp(config,request.db,services!.deps);
 const {id,...body}=f.command,trip={idempotencyKey:id,...body};
 try{
  expect(services!.deps.physicalMineRecoveryProvider).toBeDefined();expect(services!.deps.physicalMineSourceProvider!.policy).not.toHaveProperty('round');
  const departed=await app.inject({method:'POST',url:'/starter-expeditions',headers,cookies,payload:trip});
  expect(departed.statusCode,departed.body).toBe(201);const original=departed.json();expect(original.status).toBe('accepted');
  const selected=await app.inject({method:'POST',url:'/harvesters/sources',headers,cookies,payload:f.request});
  expect(selected.statusCode,selected.body).toBe(201);const harvest=selected.json();expect(harvest.status).toBe('accepted');
  const paid=await app.inject({url:`/starter-expeditions/paid-route?baseId=${f.baseId}&realm=0`,cookies});
  expect(paid.statusCode,paid.body).toBe(200);expect(paid.json().coverage.status).toBe('blocked');
  await app.close();await services!.close();runtime.close();const count=chainFixture.rpc.requests.length;
  for(const flag of ['STARTER_EXPEDITIONS_ENABLED','HARVESTERS_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(flag,'false');
  services=await createPhaseEServices(config,request.db);app=await buildApp(config,request.db,services!.deps);
  const recovered=await app.inject({url:`/starter-expeditions/by-key/${id}`,cookies});
  expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().originalReceipt).toEqual(original.originalReceipt);
  const oldHarvest=await app.inject({url:`/harvesters/sources/by-key/${f.request.idempotencyKey}`,cookies});
  expect(oldHarvest.statusCode,oldHarvest.body).toBe(200);expect(oldHarvest.json().originalReceipt).toEqual(harvest.originalReceipt);
  expect(chainFixture.rpc.requests).toHaveLength(count);expect(chainFixture.rpc.sent).toHaveLength(0);
 }finally{await app.close();await services?.close();runtime.close();await request.sql.end();await chainFixture.rpc.close();
  for(const name of [role,worker])await conn.sql.unsafe(`drop owned by ${name};drop role ${name}`);await conn.close();}
},120_000);
