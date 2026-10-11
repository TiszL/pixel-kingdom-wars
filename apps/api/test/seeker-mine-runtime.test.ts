/** Actual loopback source -> closed owner service -> provisioned request LOGIN.
 * Locally signed fixture settlements prove adapter compatibility, not live funds. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Keypair} from '@solana/web3.js';
import {SOLANA_GENESIS_HASH} from '@shardkeep/chain';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {afterEach,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {realmSaleRuntimeRpc} from './fixtures/realmSaleRuntime';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {createRealmSaleRuntime} from '../src/seeker/realmSaleRuntime';
import {createPhaseEServices} from '../src/phaseEServices';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function setup(){
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_MINING_ENABLED','FREE_ONBOARDING'])vi.stubEnv(flag,'true');
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
 const conn=resourceClaimsDatabase();await conn.setup();
 const sale=await realmSaleQuoteFixture({genesisHash:SOLANA_GENESIS_HASH.devnet});sale.bodies.clear();sale.history.clear();
 const identity={genesisHash:sale.termPolicy.genesisHash,programId:sale.termPolicy.programId,programData:sale.programData,
  programDataAddress:sale.programDataAddress,upgradeAuthority:sale.upgradeAuthority,mint:sale.termPolicy.mint,prizeOwner:sale.termPolicy.prizeOwner};
 // The registered fixture boundary remains genuinely prospective to DB time.
 const history=await createHistoricalMineResolutionFixture(conn,{identity,round1Winners:[{spotId:0,wallet:sale.seller}]});
 const current=await createMiningTermFixture({...identity,day:'2035-01-16',round:2n,firstOperatingStart:BigInt(Date.parse('2035-01-01T00:00:00Z')/1000),winners:[{spotId:1,wallet:sale.developer}]});
 for(const [key,value] of [...history.bank.store,...current.store])sale.store.set(key,value);
 for(const [key,value] of history.bank.bodies)sale.bodies.set(key,value);
 for(const [key,value] of history.bank.history)sale.history.set(key,value);
 for(const [key,value] of current.bodies){sale.bodies.set(key,value);sale.history.set(value.transaction.message.staticAccountKeys[3]!.toBase58(),key);}
 async function time(at:Date){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(at);sale.controls.now=BigInt(Math.floor(+at/1000));await history.rosterClock(at.toISOString());}
 await time(mineResolutionFixtureTimes.verified);const rpc=await realmSaleRuntimeRpc(sale);
 const [database]=await conn.sql`select current_database() name`,ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='mine_api_'+suffix,worker='mine_worker_'+suffix,password=randomBytes(32).toString('hex');
 execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,
  env:{PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),
   POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:2});
 const config={...TEST_CONFIG,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString(),SOLANA_RPC_URL:rpc.url,
  SEEKER_REALM_SALE_PROGRAM_ID:sale.termPolicy.programId.toBase58(),SEEKER_REALM_SALE_DEPLOYMENT_SLOT:sale.accessTrust.reviewedDeploymentSlot,
  SEEKER_REALM_SALE_PROGRAM_DATA_SHA256:sale.accessTrust.reviewedProgramDataSha256,SEEKER_REALM_SALE_UPGRADE_AUTHORITY:sale.upgradeAuthority.toBase58(),
  SEEKER_REALM_SALE_AUCTION_MINT:sale.termPolicy.mint.toBase58(),SEEKER_REALM_SALE_PRIZE_OWNER:sale.termPolicy.prizeOwner.toBase58(),SEEKER_REALM_SALE_DEVELOPER:sale.developer.toBase58(),
  SEEKER_REALM_SALE_ROUND:'999',SEEKER_REALM_SALE_POLICY_REVISION:'mine-runtime-test',SEEKER_REALM_SALE_STATE_PROVENANCE:'fresh-reviewed-deployment' as const};
 const runtime=createRealmSaleRuntime(config)!;
 let services=await createPhaseEServices(config,request.db,{},undefined,undefined,undefined,undefined,runtime.gameplaySources),app=await buildApp(config,request.db,services!.deps);
 async function cookies(wallet:string){const [s]=await conn.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;return {[SESSION_COOKIE]:await issueSessionJwt(config,wallet,s!.id)};}
 async function restart(){await app.close();await services!.close();runtime.close();services=await createPhaseEServices(config,request.db);app=await buildApp(config,request.db,services!.deps);}
 return {conn,request,history,current,sale,rpc,runtime,config,time,cookies,restart,get app(){return app;},get services(){return services;},
  async close(){await app.close();await services?.close();runtime.close();await request.sql.end();await rpc.close();for(const name of [role,worker])await conn.sql.unsafe(`drop owned by ${name};drop role ${name}`);await conn.close();}};
}
const tax=(gross:bigint)=>gross*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
async function withFixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{await f.close();}}
it('admits the real current Mine round through ordinary restricted HTTP and collects its conserved source while paused/providerless',()=>withFixture(async f=>{
 const wallet=Keypair.generate().publicKey.toBase58(),baseId=randomUUID(),mineId=randomUUID(),at=mineResolutionFixtureTimes.verified;
 await f.conn.sql`insert into players(wallet) values(${wallet})`;await f.conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},1)`;
 await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
 await f.conn.sql`insert into buildings(id,base_id,player_wallet,type,level,tx,ty) values(${mineId},${baseId},${wallet},'mine',1,1,1)`;
 await f.conn.sql`insert into mine_accrual_states(mine_building_id,last_accrual_at) values(${mineId},${at.toISOString()})`;await initializeMiningRosterHistory(f.conn.db,wallet);
 const cookies=await f.cookies(wallet),collect=()=>f.app.inject({method:'POST',url:'/mine/collect',cookies,payload:{baseId}}),before=f.rpc.requests.length;
 expect((await f.app.inject({method:'POST',url:'/mine/collect',payload:{baseId}})).statusCode).toBe(401);expect(f.rpc.requests).toHaveLength(before);
 const initial=await collect();expect(initial.statusCode,initial.body).toBe(200);expect(initial.json()).toEqual({amount:'0'});
 const [source]=await f.conn.sql`select * from shards_mine_admissions where wallet=${wallet}`;expect(source!.observation.snapshot.source.round).toBe('2');expect(source!.mine_ids).toEqual([mineId]);
 expect(f.services!.deps.physicalMineSourceProvider!.policy).not.toHaveProperty('round');expect(f.runtime.preparationSources.policy.term.round).toBe(999n);
 const admittedReads=f.rpc.requests.length;expect(admittedReads).toBeGreaterThan(before);
 const gross=BigInt(mineResolutionFixtureTimes.quota);await f.time(new Date(+at+mineResolutionFixtureTimes.unit*Number(gross)));
 vi.stubEnv('PHASE_E_MINING_ENABLED','false');await f.restart();
 const collected=await collect();expect(collected.statusCode,collected.body).toBe(200);expect(collected.json()).toEqual({amount:String(gross-tax(gross))});expect((await collect()).json()).toEqual({amount:'0'});
 const [ledger]=await f.conn.sql`select coalesce(sum(e.delta),0)::text net from ledger_entries e join accounts a on a.id=e.account_id where a.base_id=${baseId} and a.kind='base_shards'`;
 expect(ledger!.net).toBe(String(gross-tax(gross)));expect(await f.conn.sql`select * from shards_mine_admissions where wallet=${wallet}`).toHaveLength(1);
 const saved=await f.app.inject({url:`/mining/shards/sources/by-key/${source!.id}`,cookies});expect(saved.statusCode,saved.body).toBe(200);expect(saved.json().source.termId).toBe(source!.term_id);expect(saved.json().source.termHash).toBe(source!.term_hash);
 const changed=await f.app.inject({method:'POST',url:'/mining/shards/sources',cookies,payload:{idempotencyKey:source!.id,baseId:randomUUID()}});expect(changed.statusCode,changed.body).toBe(409);
 expect(f.rpc.requests).toHaveLength(admittedReads);expect(f.rpc.sent).toHaveLength(0);
}),120000);
it('repairs free historical originals through the private runtime factory, binds old terms and preserves paused/providerless collection',()=>withFixture(async f=>{
 const old=await f.history.createSource(),cookies=await f.cookies(old.wallet),collect=()=>f.app.inject({method:'POST',url:'/mine/collect',cookies,payload:{baseId:old.base.id}});
 expect(f.services!.deps.physicalMineRecoveryProvider).toBeDefined();
 await expect(f.request.sql`select * from mining_roster_baselines`).rejects.toMatchObject({code:'42501'});
 const first=await collect();expect(first.statusCode,first.body).toBe(200);
 const gross=BigInt(mineResolutionFixtureTimes.quota);expect(first.json()).toEqual({amount:String(gross-tax(gross-4n))});
 const terms=await f.conn.sql`select t.certificate from shards_mine_resolution_terms t join shards_mine_segments s on s.id=t.segment_id where s.mine_id=${old.mine.id} order by s.first_unit`;
 expect([...new Set(terms.map(t=>t.certificate.snapshot.source.round))].sort()).toEqual(['0','1']);
 expect(terms.every(t=>t.certificate.operatingAdmissionAuthorized===false)).toBe(true);
 expect(terms.find(t=>t.certificate.snapshot.source.round==='0')!.certificate.snapshot.spots.every((s:{ownerWallet:string|null})=>s.ownerWallet===null)).toBe(true);
 expect(terms.find(t=>t.certificate.snapshot.source.round==='1')!.certificate.snapshot.spots[0].ownerWallet).toBe(f.sale.seller.toBase58());
 const [head]=await f.conn.sql`select a.observation from shards_mine_heads h join shards_mine_admissions a on a.id=h.admission_id where h.mine_id=${old.mine.id}`;expect(head!.observation.snapshot.source.round).toBe('2');
 const [conservation]=await f.conn.sql`select sum(gross)::text gross,sum(resolved+buffer+reserved+issued+discarded)::text accounted from shards_mine_segments where mine_id=${old.mine.id}`;expect(conservation!.accounted).toBe(conservation!.gross);
 const headers=await f.conn.sql`select to_jsonb(r) value from shards_mine_resolutions r join shards_mine_segments s on s.id=r.parent_id where s.mine_id=${old.mine.id} order by parent_id`;
 expect(headers.length).toBeGreaterThan(0);await expect(f.request.sql`insert into shards_mine_resolutions select * from shards_mine_resolutions where parent_id=${old.parent.id}`).rejects.toMatchObject({code:'42501'});
 await expect(f.request.sql`insert into shards_mine_resolution_terms select * from shards_mine_resolution_terms where parent_id=${old.parent.id}`).rejects.toMatchObject({code:'42501'});
 const reads=f.rpc.requests.length;vi.stubEnv('PHASE_E_MINING_ENABLED','false');await f.restart();
 expect((await collect()).json()).toEqual({amount:'0'});expect(await f.conn.sql`select to_jsonb(r) value from shards_mine_resolutions r join shards_mine_segments s on s.id=r.parent_id where s.mine_id=${old.mine.id} order by parent_id`).toEqual(headers);
 expect(f.rpc.requests).toHaveLength(reads);expect(f.rpc.sent).toHaveLength(0);
}),120000);
