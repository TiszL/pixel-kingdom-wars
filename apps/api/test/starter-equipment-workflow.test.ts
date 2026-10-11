/** Fitted admission uses a closed owner service; automatic returns stay in the
 * restricted caller transaction. Local signed source fixtures are not live chain evidence. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,expect,it,vi} from 'vitest';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {starterEquipmentChain} from './fixtures/starterEquipmentWorkflow';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {ADMIN_DATABASE_URL} from './db-url';
import {createDb} from '../src/db/client';
import {createRealmSaleRuntime} from '../src/seeker/realmSaleRuntime';
import {createPhaseEServices} from '../src/phaseEServices';
import {buildApp} from '../src/app';
import {getBaseState} from '../src/game/base';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {settleDueStarterExpeditions,readStarterExpeditionReturn} from '../src/game/starterExpeditionReturns';
import {finishStarterEquipmentReturn} from '../src/game/starterEquipmentReturn';
import {starterExpeditionEnvelope} from '../src/game/starterExpeditionView';
import {runStarterExpeditionReturns} from '../src/game/starterExpeditionWorker';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{await f.close();}}
async function setup(){
 const chain=await starterEquipmentChain(),owner=resourceClaimsDatabase();await owner.setup();
 const [database]=await owner.sql`select current_database() name`;const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;
 const suffix=randomUUID().replaceAll('-',''),role='starter_api_'+suffix,worker='starter_worker_'+suffix,password=randomBytes(32).toString('hex'),workerPassword=randomBytes(32).toString('hex');
 const provision=()=>execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),POSTGRES_USER:decodeURIComponent(url.username),POSTGRES_PASSWORD:decodeURIComponent(url.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:workerPassword}});
 provision();const requestUrl=new URL(url);requestUrl.username=role;requestUrl.password=password;const workerUrl=new URL(url);workerUrl.username=worker;workerUrl.password=workerPassword;
 const request=createDb(requestUrl.toString(),{max:4}),workerDb=createDb(workerUrl.toString(),{max:2});
 const config={...chain.config,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:url.toString()},runtime=createRealmSaleRuntime(config)!;
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED','STARTER_EXPEDITIONS_ENABLED','FREE_ONBOARDING'])vi.stubEnv(flag,'true');
 let services=await createPhaseEServices(config,request.db,{},undefined,undefined,undefined,undefined,runtime.gameplaySources),app=await buildApp(config,request.db,services!.deps);
 async function base(item:'route_compass'|'survey_lens'='survey_lens'){
  const now=new Date(),f=await createStarterExpeditionFixture(owner.db,{now}),recipe=ordinaryEquipmentRecipe(item==='survey_lens'?'craft_survey_lens':'craft_route_compass'),workshop=randomUUID();
  const completed=new Date(+now-recipe.durationSec*1000-1000).toISOString();
  await owner.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${workshop},${f.baseId},${f.wallet},'workshop',9,2)`;
  await owner.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.baseId},${f.wallet},${workshop},'build',${new Date(+new Date(completed)-3600000).toISOString()},${completed},${completed})`;
  for(const i of recipe.inputs)await owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${i.itemId},${i.quantity})`;
  await startOrdinaryEquipment(owner.db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:recipe.recipeId,recipeVersion:1,quantity:1},f.authority,{clock:()=>new Date(+now-recipe.durationSec*1000)});
  await owner.db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,now));
  const route=starterRoutePreview('crownlands','coastal_survey'),fitting=item==='survey_lens'?{itemId:item,policyVersion:1,resourceId:'frost_quartz'} as const:{itemId:item,policyVersion:1} as const;
  const command={idempotencyKey:randomUUID(),baseId:f.baseId,installationId:f.installationId,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting};
  const [session]=await owner.sql`insert into sessions(wallet,expires_at) values(${f.wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;
  const cookies={[SESSION_COOKIE]:await issueSessionJwt(config,f.wallet,session!.id)},headers={origin:config.WEB_ORIGIN[0]!};
  const post=(payload=command)=>app.inject({method:'POST',url:'/starter-expeditions',headers,cookies,payload});
  async function depart(){const response=await post();expect(response.statusCode,response.body).toBe(201);return response.json();}
  return {...f,command,cookies,headers,post,depart};
 }
 return {owner,request,workerDb,role,worker,chain,provision,base,fallback:()=>buildApp(config,request.db,{starterExpeditionProvider:runtime.gameplaySources.term}),get app(){return app;},async providerless(){await app.close();await services!.close();runtime.close();services=await createPhaseEServices(config,request.db);app=await buildApp(config,request.db,services!.deps);},async close(){await app.close();await services?.close();runtime.close();await Promise.all([request.sql.end(),workerDb.sql.end(),chain.rpc.close()]);for(const r of [role,worker])await owner.sql.unsafe(`drop owned by ${r};drop role ${r}`);await owner.close();}};
}
type F=Awaited<ReturnType<typeof setup>>;
const stock=(f:F,baseId:string)=>f.owner.sql`select item_id,available,reserved from ordinary_equipment_stocks where base_id=${baseId}`;
it('admits a genuine current fitted source through private startup and recovers exactly while paused/providerless',()=>fixture(async f=>{
 const a=await f.base(),b=await f.base('route_compass'),before=f.chain.rpc.requests.length;
 expect((await f.app.inject({method:'POST',url:'/starter-expeditions',payload:a.command})).statusCode).toBe(401);expect(f.chain.rpc.requests).toHaveLength(before);
 expect((await b.post({...a.command,idempotencyKey:randomUUID()})).statusCode).toBe(404);
 const fallback=await f.fallback();try{
  const view=await fallback.inject({url:`/starter-expeditions?baseId=${a.baseId}&fitting=survey_lens&resourceId=frost_quartz`,cookies:a.cookies});
  expect(view.statusCode,view.body).toBe(200);expect(view.json().acceptingDepartures).toBe(false);
  const held=await fallback.inject({method:'POST',url:'/starter-expeditions',headers:a.headers,cookies:a.cookies,payload:a.command});expect(held.statusCode,held.body).toBe(503);expect(held.json().error.code).toBe('EQUIPMENT_OWNER');
 }finally{await fallback.close();}
 const original=await a.depart();expect(await stock(f,a.baseId)).toEqual([{item_id:'survey_lens',available:'0',reserved:'1'}]);
 expect((await f.app.inject({url:`/starter-expeditions/by-key/${a.command.idempotencyKey}`,cookies:b.cookies})).json().status).toBe('unknown');
 await expect(f.request.sql`select * from ordinary_equipment_reservations`).rejects.toMatchObject({code:'42501'});
 await expect(f.request.sql`insert into ordinary_equipment_releases(trip_kind,expedition_id,base_id,return_id) values('starter',${a.command.idempotencyKey},${a.baseId},${randomUUID()})`).rejects.toMatchObject({code:'42501'});
 vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');await f.providerless();const count=f.chain.rpc.requests.length;
 const recovered=await a.post();expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json().originalReceipt).toEqual(original.originalReceipt);
 expect((await a.post({...a.command,fitting:{itemId:'route_compass',policyVersion:1}})).statusCode).toBe(409);
 expect((await a.post({...a.command,idempotencyKey:randomUUID()})).statusCode).toBe(503);
 const view=await f.app.inject({url:`/starter-expeditions?baseId=${a.baseId}&fitting=survey_lens&resourceId=frost_quartz`,cookies:a.cookies});expect(view.statusCode,view.body).toBe(200);expect(view.json().acceptingDepartures).toBe(false);
 expect(f.chain.rpc.requests).toHaveLength(count);expect(f.chain.rpc.sent).toHaveLength(0);
}),120000);
it.each(['route_compass','survey_lens'] as const)('returns %s through actual restricted worker and concurrent owner collection exactly once',item=>fixture(async f=>{
 const a=await f.base(item),original=await a.depart(),id=a.command.idempotencyKey,at=new Date(original.receipt.returnsAt);
 vi.stubEnv('STARTER_EXPEDITIONS_ENABLED','false');const result=await Promise.all([runStarterExpeditionReturns(f.workerDb.db,{limit:5,clock:()=>at}),f.owner.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,at))]);
 expect(result[0].failures).toEqual([]);expect(await stock(f,a.baseId)).toEqual([{item_id:item,available:'1',reserved:'0'}]);
 const proof=await readStarterExpeditionReturn(f.request.db,id);expect(proof!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);
 expect(await f.request.db.transaction(tx=>finishStarterEquipmentReturn(tx,id))).toBe(0);
 expect(await f.owner.sql`select * from ordinary_equipment_releases where expedition_id=${id}`).toHaveLength(1);
 const secondary=await f.owner.sql`select * from ordinary_equipment_secondary_entries where expedition_id=${id}`;expect(secondary).toHaveLength(item==='survey_lens'?3:0);expect(secondary.reduce((n,e)=>n+BigInt(e.delta),0n)).toBe(0n);
}),120000);
it('keeps primary, Lens, stock, equipment and flight atomic on overflow and a late outer rollback before retry',()=>fixture(async f=>{
 const a=await f.base(),original=await a.depart(),id=a.command.idempotencyKey,at=new Date(original.receipt.returnsAt);
 await f.owner.sql`insert into resource_stocks(base_id,resource_id,available) values(${a.baseId},'frost_quartz',9223372036854775807)`;
 await expect(f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,at))).rejects.toThrow();
 expect(await readStarterExpeditionReturn(f.owner.db,id)).toBeNull();expect(await stock(f,a.baseId)).toEqual([{item_id:'survey_lens',available:'0',reserved:'1'}]);
 await f.owner.sql`update resource_stocks set available=0 where base_id=${a.baseId} and resource_id='frost_quartz'`;
 await expect(f.request.db.transaction(async tx=>{await settleDueStarterExpeditions(tx,a.baseId,at);throw Error('late boundary failure');})).rejects.toThrow('late boundary failure');
 for(const table of ['starter_expedition_returns','ordinary_equipment_secondary_returns','ordinary_equipment_releases'])expect(await f.owner.sql.unsafe(`select * from ${table} where expedition_id=$1`,[id])).toHaveLength(0);
 expect(await f.owner.sql`select * from starter_expedition_inflight where expedition_id=${id}`).toHaveLength(1);
 expect((await f.owner.sql`select available from resource_stocks where base_id=${a.baseId} and resource_id='frost_quartz'`)[0]!.available).toBe('0');
 await f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,at));expect((await starterExpeditionEnvelope(f.request.db,a.wallet,id)).return).not.toBeNull();
}),120000);
it('rejects future primary time, missing accounting and source drift; migration and provisioning replay preserve both old seals',()=>fixture(async f=>{
 const a=await f.base(),original=await a.depart(),id=a.command.idempotencyKey,at=new Date(original.receipt.returnsAt);
 // Direct runtime callers cannot manufacture any unbounded private tail.
 await expect(f.request.db.transaction(tx=>finishStarterEquipmentReturn(tx,id))).rejects.toThrow();
 const [clock]=await f.owner.sql`select clock_timestamp() now`;await expect(f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,new Date(+new Date(clock!.now)+86400000)))).rejects.toThrow();
 const primary=async(missing:boolean)=>f.request.db.transaction(async tx=>{
  const [r]=await tx.execute<{id:string}>(sql`insert into starter_expedition_returns(expedition_id,custody_wallet,returned_at) values(${id},${a.wallet},${at.toISOString()}::timestamptz) returning id`);
  await tx.execute(sql`delete from starter_expedition_inflight where expedition_id=${id}`);
  if(!missing)await tx.execute(sql`insert into starter_expedition_entries(return_id,bucket,delta) select ${r!.id}::uuid,v.bucket,v.delta from starter_expeditions s cross join lateral(values('issued',-s.gross),('base_stock',s.net),('island_pool',s.tax)) v(bucket,delta) where s.id=${id}`);
  return finishStarterEquipmentReturn(tx,id);
 });
 await expect(primary(true)).rejects.toThrow();expect(await readStarterExpeditionReturn(f.owner.db,id)).toBeNull();
 const [held]=await f.owner.sql`select fitting_snapshot from ordinary_equipment_reservations where expedition_id=${id}`;
 await f.owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update ordinary_equipment_reservations set fitting_snapshot=jsonb_set(fitting_snapshot,'{itemId}','"route_compass"'::jsonb) where expedition_id=${id}`;});
 await expect(primary(false)).rejects.toThrow();expect(await readStarterExpeditionReturn(f.owner.db,id)).toBeNull();
 await f.owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update ordinary_equipment_reservations set fitting_snapshot=${JSON.stringify(held!.fitting_snapshot)}::jsonb where expedition_id=${id}`;});
 const before=(await f.owner.sql`select shardkeep_advanced_return_fingerprint() advanced,shardkeep_starter_return_fingerprint() starter`)[0];await f.owner.sql`select shardkeep_divine_fragment_source()`;
 const migration=readFileSync(new URL('../drizzle/0257_starter_equipment_return_capability.sql',import.meta.url),'utf8'),replay=()=>f.owner.sql.begin(async tx=>{for(const part of migration.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);});
 // 2026-10-10 (CI 37503885235): 0278 added the workshop trigger to 0257's sealed relations and 0279 superseded
 // its seal with bound_cosmetic_return_contract, so a direct 0257 replay is a refused downgrade at EVERY boundary,
 // clean or tampered (successor-aware replay, dd92d0f16). Tamper detection is proved by the settlement refusal
 // and the successor validator; each refused replay must leave both predecessor fingerprints unchanged.
 const sources=async()=>(await f.owner.sql`select shardkeep_bound_cosmetic_return_sources_valid() ok`)[0]!.ok;
 await f.owner.sql`alter table starter_expedition_returns disable trigger starter_return_insert_guard`;
 await expect(f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,at))).rejects.toThrow();await expect(replay()).rejects.toThrow('STARTER_RETURN_SOURCE_CHANGED');
 expect(await sources()).toBe(false);
 await f.owner.sql`alter table starter_expedition_returns enable trigger starter_return_insert_guard`;
 await f.provision();await expect(replay()).rejects.toThrow('STARTER_RETURN_SOURCE_CHANGED');expect((await f.owner.sql`select shardkeep_advanced_return_fingerprint() advanced,shardkeep_starter_return_fingerprint() starter`)[0]).toEqual(before);
 expect(await sources()).toBe(true);
 await f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,at));await expect(replay()).rejects.toThrow('STARTER_RETURN_SOURCE_CHANGED');await f.owner.sql`select shardkeep_divine_fragment_source()`;
 expect(await f.request.db.transaction(tx=>finishStarterEquipmentReturn(tx,id))).toBe(0);
}),120000);
it('settles fitted cargo at restricted custody transfer and preserves original actor history',()=>fixture(async f=>{
 const a=await f.base(),original=await a.depart(),id=a.command.idempotencyKey,at=new Date(original.receipt.returnsAt),buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58();
 await f.owner.sql`insert into players(wallet) values(${buyer})`;await registerOwnedDeed(f.owner.db,a.wallet,deed);
 await transferStableBase(f.request.db,a.baseId,a.wallet,buyer,deed,{owner:buyer,collection:'fixture',frozen:false,delegate:null,slot:100,observedAtMs:+at},()=>at);
 const proof=await readStarterExpeditionReturn(f.request.db,id);expect(proof!.receipt.custodyWallet).toBe(a.wallet);expect(proof!.expedition.actorWallet).toBe(a.wallet);
 expect((await starterExpeditionEnvelope(f.request.db,buyer,id)).status).toBe('unknown');expect((await starterExpeditionEnvelope(f.request.db,a.wallet,id)).status).toBe('accepted');
 expect(await stock(f,a.baseId)).toEqual([{item_id:'survey_lens',available:'1',reserved:'0'}]);
 expect(await f.request.db.transaction(tx=>finishStarterEquipmentReturn(tx,id))).toBe(0);
}),120000);
it('settles due fitted cargo through the ordinary restricted base snapshot with no private pool call',()=>fixture(async f=>{
 const a=await f.base(),original=await a.depart(),at=new Date(original.receipt.returnsAt);
 const view=await getBaseState(f.request.db,a.wallet,at,a.baseId,a.authority.assertAuthority,()=>at);
 expect(view.starterExpeditions?.flight).toBeNull();expect(await stock(f,a.baseId)).toEqual([{item_id:'survey_lens',available:'1',reserved:'0'}]);
 expect((await readStarterExpeditionReturn(f.request.db,a.command.idempotencyKey))!.receipt.returnedAt).toEqual(at);
}),120000);
