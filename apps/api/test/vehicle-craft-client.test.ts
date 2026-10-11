/** Genuine earned originals, serialized finality and normal restricted HTTP.
 * No validator or production provenance/activation is claimed. */
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Keypair,PublicKey} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {VehicleAssetPageSchema,VehicleAssetPageV2Schema} from '@shardkeep/shared/vehicleClientApi';
import {VehicleCraftHistoryPageSchema,VehicleCraftRecoverySchema,VehicleCraftRecordSchema} from '@shardkeep/shared/vehicleCraftClientApi';
import {createVehicleCraftClient} from '../src/game/vehicleCraftClient';
import {createVehicleActivationReservations} from '../src/game/vehicleActivationReservations';
import {vehicleIssuanceFixture} from '../../../packages/chain/src/testFixtures/vehicleIssuance';
import {withVehicleCraftClientFixture} from './fixtures/vehicleCraftClient';
import {buildApp} from '../src/app';
import {createPhaseEServices} from '../src/phaseEServices';
import {createDb} from '../src/db/client';
import {TEST_CONFIG} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
import {SEAL_BOUND_EARNED_VEHICLE_CASE_MS} from './sealLatencyBudgets';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
function redacted(value:unknown){if(!value||typeof value!=='object')return;for(const [key,v] of Object.entries(value)){expect(['nonce','original','proof','source','metadata','permitId','terms','signedTransaction']).not.toContain(key);redacted(v);}}
it('shows exact earned available/held leaves, paid outcomes and honest mixed provenance with current ownership',()=>withVehicleCraftClientFixture(async f=>{
 const {wallet,baseId}=f.seller,request={baseId,family:f.recipe.family,tier:f.recipe.tier,recipeVersion:1};
 const quote=await f.client.quote(wallet,request);expect(quote.applicationFeeLamports).toBe(String(PHASE_E_POLICY.craft.applicationFeeLamports));expect(quote.ingredients.every(i=>i.held==='0')).toBe(true);
 const held=await f.reserve(),won=await f.reserve(),lost=await f.reserve(),heldRecord=await f.client.read(wallet,held.request.idempotencyKey),after=await f.client.quote(wallet,request);
 for(const input of after.ingredients)expect(input.held).toBe(String(BigInt(input.required)*3n));expect(after.ingredients.filter(i=>i.kind==='refined').every(i=>i.available==='0')).toBe(true);
 const terminalWin=await f.terminal(won,'won'),terminalLoss=await f.terminal(lost,'lost'),mintProof=await f.minted(won);
 const candidate=f.candidates(won),[session]=await f.conn.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`,cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)},headers={origin:TEST_CONFIG.WEB_ORIGIN[0]!};
 vi.stubEnv('MULTI_BASE_ENABLED','false');let active=f.client;const app=await buildApp(TEST_CONFIG,f.db,{vehicleCraftClientProvider:{...f.client,recover:(actor,key)=>active.recover(actor,key)},vehicleClientProvider:candidate.client});
 const raw:Record<string,string>={};const http=async(name:string,url:string,post=false,payload:unknown={})=>{const response=await app.inject({method:post?'POST':'GET',url,cookies,headers,...post?{payload:payload as Record<string,unknown>}:{}});expect(response.statusCode,response.body).toBe(200);raw[name]=response.body;return response.json();};
 try{
 await http('quote','/vehicles/craft/quote',true,request);await http('held','/vehicles/craft/by-key/'+held.request.idempotencyKey);

 const recover=createVehicleCraftClient(f.db,{...f.identity,readFinalizedResult:async root=>root===won.original.rootId?terminalWin:terminalLoss});
 active=recover;const win=VehicleCraftRecoverySchema.parse(await http('recoverWon','/vehicles/craft/by-key/'+won.request.idempotencyKey+'/recover',true)),loss=VehicleCraftRecoverySchema.parse(await http('recoverLoss','/vehicles/craft/by-key/'+lost.request.idempotencyKey+'/recover',true));
 await http('won_unminted','/vehicles/craft/by-key/'+won.request.idempotencyKey);await http('paid_loss','/vehicles/craft/by-key/'+lost.request.idempotencyKey);
 expect(win).toMatchObject({status:'held',reason:'PROVIDER_UNAVAILABLE',record:{status:'won_unminted'}});expect(loss).toMatchObject({status:'current',reason:null,record:{status:'paid_loss'}});
 active=createVehicleCraftClient(f.db,{readFinalizedMint:async()=>mintProof});const finalized=VehicleCraftRecoverySchema.parse(await http('recoverMinted','/vehicles/craft/by-key/'+won.request.idempotencyKey+'/recover',true));expect(finalized.record.status).toBe('minted');await http('minted','/vehicles/craft/by-key/'+won.request.idempotencyKey);
 const legacy=vehicleIssuanceFixture(randomBytes(16).toString('hex'));new PublicKey(wallet).toBuffer().copy(legacy.rows[10]!.data,1);candidate.bank.rows.push(legacy.rows[10]!);
 await createVehicleActivationReservations(f.db).register(legacy.original.identity,{fixture:'explicit owner attestation; not finalized issuance'});
 const assetsV2=VehicleAssetPageV2Schema.parse(await http('assetsV2','/vehicles/client/assets-v2')),assetsV1=VehicleAssetPageSchema.parse(await http('assetsV1','/vehicles/client/assets'));
 expect(assetsV2.items).toHaveLength(2);expect(assetsV2.items.find(i=>i.identity.assetId===won.original.identity.assetId)?.provenance).toEqual({kind:'finalized_issuance',rootId:won.original.rootId});expect(assetsV1.items.map(i=>i.identity.assetId)).toEqual([legacy.original.identity.assetId]);
 // The saved mint graph cannot substitute for present asset ownership.
 new PublicKey(Keypair.generate().publicKey).toBuffer().copy(candidate.bank.rows[10]!.data,1);
 expect((await candidate.client.assetsV2(wallet)).items.map(i=>i.identity.assetId)).toEqual([legacy.original.identity.assetId]);
 const history=VehicleCraftHistoryPageSchema.parse(await http('history','/vehicles/craft/history'));expect(history.items).toHaveLength(3);for(const value of [quote,after,history,win,loss,finalized])redacted(value);
 writeFileSync('/tmp/vehicle-craft-client-http-all-states-pair.json',JSON.stringify({wallet,baseId,quote:JSON.parse(raw.quote!),history,records:{held:JSON.parse(raw.held!),paid_loss:JSON.parse(raw.paid_loss!),won_unminted:JSON.parse(raw.won_unminted!),minted:JSON.parse(raw.minted!)},recoveries:{won_unminted:win,paid_loss:loss,minted:finalized},assetsV2,assetsV1,raw}));
 }finally{await app.close();}
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
it('keeps original actor history after base transfer, pause and provider outage without revealing or changing originals',()=>withVehicleCraftClientFixture(async f=>{
 const saved=await f.reserve(),{wallet,baseId}=f.seller,key=saved.request.idempotencyKey,other=f.fragmentSource.f.buyer;
 const first=await f.client.read(wallet,key);await expect(f.client.read(other,key)).rejects.toMatchObject({statusCode:404});expect((await f.client.history(other)).items).toEqual([]);
 await expect(f.client.history(wallet,Buffer.from(JSON.stringify({version:1,wallet:other,id:saved.id})).toString('base64url'))).rejects.toMatchObject({code:'VEHICLE_CRAFT_CURSOR'});
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');await f.conn.sql`delete from base_slots where base_id=${baseId}`;await f.conn.sql`update bases set owner_wallet=${other} where id=${baseId}`;
 const replay=await f.client.read(wallet,key);expect({...replay,serverNow:first.serverNow}).toEqual(first);
 expect(await f.client.recover(wallet,key)).toMatchObject({status:'held',reason:'PROVIDER_UNAVAILABLE',record:{status:'held',baseId,wallet}});
 expect(await createVehicleCraftClient(f.db,{readFinalizedResult:async()=>{throw Error('provider unavailable');}}).recover(wallet,key)).toMatchObject({status:'held',reason:'PROOF_UNAVAILABLE',record:{status:'held'}});
 await expect(f.client.quote(wallet,{baseId,family:f.recipe.family,tier:f.recipe.tier,recipeVersion:1})).rejects.toMatchObject({statusCode:404});
 expect(await f.conn.sql`select * from vehicle_craft_material_terminals where reservation_id=${saved.id}`).toHaveLength(0);
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
it('refuses structural and partial saved-graph damage instead of empty history or synthetic loss',()=>withVehicleCraftClientFixture(async f=>{
 const saved=await f.reserve(),key=saved.request.idempotencyKey,wallet=f.seller.wallet,candidate=f.candidates(saved);
 await f.conn.sql`alter table vehicle_issuance_acquisitions disable trigger vehicle_issuance_acquisitions_issuance_guard`;
 try{await expect(f.client.history(wallet)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});await expect(candidate.client.assetsV2(wallet)).rejects.toMatchObject({statusCode:503});}finally{await f.conn.sql`alter table vehicle_issuance_acquisitions enable trigger vehicle_issuance_acquisitions_issuance_guard`;}
 await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`delete from vehicle_issuance_originals where root_id=${saved.original.rootId}`;});
 await expect(f.client.read(wallet,key)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});await expect(f.client.history(wallet)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});await expect(f.client.recover(wallet,key)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
it('ordinary private startup serves original HTTP while request SQL stays restricted, with no reserve or proof endpoint',()=>withVehicleCraftClientFixture(async f=>{
 const saved=await f.reserve(),wallet=f.seller.wallet,key=saved.request.idempotencyKey,suffix=randomUUID().replaceAll('-',''),apiRole='craft_api_'+suffix,workerRole='craft_worker_'+suffix;
 const [database]=await f.conn.sql`select current_database() name`,ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname='/'+database!.name;if(!['localhost','127.0.0.1','[::1]'].includes(ownerUrl.hostname))throw Error('Disposable loopback required');
 const requestUrl=new URL(ownerUrl);requestUrl.username=apiRole;requestUrl.password=randomBytes(32).toString('hex');
 const [unprovisioned]=await f.conn.sql`select public.shardkeep_divine_fragment_contract() record`;expect(unprovisioned!.record).not.toBeNull();
 const script=fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url));execFileSync('sh',[script],{timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:database!.name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:apiRole,API_DB_PASSWORD:requestUrl.password,WORKER_DB_USER:workerRole,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 const request=createDb(requestUrl.toString()),config={...TEST_CONFIG,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString()},[session]=await f.conn.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`,cookies={[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)},headers={origin:config.WEB_ORIGIN[0]!};
 let services:Awaited<ReturnType<typeof createPhaseEServices>>=null,app:Awaited<ReturnType<typeof buildApp>>|undefined;
 try{
  // 2026-10-10 (r2 v-vehicle-seal-latency): 0272's divine_fragment_vehicle_client_contract is no longer the newest
  // Divine seal. Since 0275 (then 0276, 0277, 0279, 0298) the projection carries later tables and functions and is
  // proven through the successor chain, so it no longer equals that saved record (55 differing paths; this pin sat
  // behind the case's 120 s timeout). The rule kept: provisioning the runtime roles leaves the Divine projection
  // byte-identical, and the live seal chain still accepts the provisioned database.
  const [provisioned]=await f.conn.sql`select public.shardkeep_divine_fragment_contract() record`,seal={saved:unprovisioned!.record,actual:provisioned!.record};
  await f.conn.sql`select public.shardkeep_divine_fragment_source()`;
  const diff=(a:unknown,b:unknown,path=''):string[]=>{if(JSON.stringify(a)===JSON.stringify(b))return [];if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b))return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(k=>diff((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k],path+'.'+k));return [path+': '+JSON.stringify(a)+' => '+JSON.stringify(b)];};
  writeFileSync('/tmp/vehicle-craft-client-provision-seal-diff.json',JSON.stringify(diff(seal!.saved,seal!.actual),null,2));
  expect(diff(seal!.saved,seal!.actual)).toEqual([]);
  const extra='craft_extra_'+suffix;await f.conn.sql.unsafe(`create role ${extra} nologin`);
  try{for(const grant of [`grant select on crafting_stocks to ${extra}`,`grant truncate on crafting_stocks to shardkeep_api_runtime`,`grant select on crafting_stocks to shardkeep_api_runtime with grant option`,`grant select (item_id) on crafting_stocks to ${extra}`]){
   await f.conn.sql.unsafe(grant);await expect(f.client.history(wallet)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});
   await f.conn.sql.unsafe(`revoke all on crafting_stocks from ${extra};revoke all(item_id) on crafting_stocks from ${extra};revoke truncate on crafting_stocks from shardkeep_api_runtime;revoke grant option for select on crafting_stocks from shardkeep_api_runtime`);
  }
  const [owner]=await f.conn.sql`select current_user name`;await f.conn.sql.unsafe(`alter table vehicle_issuance_acquisitions owner to ${extra}`);
  try{await expect(f.client.history(wallet)).rejects.toMatchObject({code:'VEHICLE_CRAFT_HISTORY_HELD'});}finally{await f.conn.sql.unsafe(`alter table vehicle_issuance_acquisitions owner to ${owner!.name}`);}
  }finally{await f.conn.sql.unsafe(`drop owned by ${extra};drop role ${extra}`);}
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');vi.stubEnv('MULTI_BASE_ENABLED','false');services=await createPhaseEServices(config,request.db,f.identity);app=await buildApp(config,request.db,services!.deps);
  const url='/vehicles/craft/by-key/'+key;expect((await app.inject({url})).statusCode).toBe(401);
  const read=await app.inject({url,cookies});expect(read.statusCode,read.body).toBe(200);expect(read.headers['cache-control']).toBe('private, no-store');VehicleCraftRecordSchema.parse(read.json());
  const history=await app.inject({url:'/vehicles/craft/history',cookies});expect(history.statusCode,history.body).toBe(200);expect(history.json().items).toHaveLength(1);
  const recovered=await app.inject({method:'POST',url:url+'/recover',cookies,headers,payload:{}});expect(recovered.statusCode,recovered.body).toBe(200);expect(recovered.json()).toMatchObject({status:'held',reason:'PROVIDER_UNAVAILABLE'});
  for(const payload of [{proof:{}},{original:{}},{nonce:saved.nonce},{baseId:f.seller.baseId},{signedTransaction:'AA=='},{fee:'0'}])expect((await app.inject({method:'POST',url:url+'/recover',cookies,headers,payload})).statusCode).toBe(400);
  expect((await app.inject({url:'/vehicles/craft/history?wallet='+wallet,cookies})).statusCode).toBe(400);expect((await app.inject({method:'POST',url:'/vehicles/craft/reserve',cookies,headers,payload:{}})).statusCode).toBe(404);
  await expect(request.sql`select * from vehicle_craft_material_reservations`).rejects.toMatchObject({code:'42501'});await expect(request.sql`select * from vehicle_issuance_acquisitions`).rejects.toMatchObject({code:'42501'});
  const quote=await app.inject({method:'POST',url:'/vehicles/craft/quote',cookies,headers,payload:{baseId:f.seller.baseId,family:f.recipe.family,tier:f.recipe.tier,recipeVersion:1}});expect(quote.statusCode,quote.body).toBe(200);
  writeFileSync('/tmp/vehicle-craft-client-http-pair.json',JSON.stringify({wallet,baseId:f.seller.baseId,quote:quote.json(),history:history.json(),record:read.json(),recovery:recovered.json()}));
 }finally{await app?.close();await services?.close();await request.sql.end();for(const role of [apiRole,workerRole])await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
}),SEAL_BOUND_EARNED_VEHICLE_CASE_MS);
