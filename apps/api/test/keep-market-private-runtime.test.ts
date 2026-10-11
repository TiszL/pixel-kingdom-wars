/** Normal private factory and restricted HTTP with real custody/chain readers.
 * Opening Compass stock and raw execution banks are explicit fixtures; separate
 * keep-equipment-runtime tests cover actual bounded RPC transport. */
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Keypair} from '@solana/web3.js';
import postgres from 'postgres';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {buildApp} from '../src/app';
import {createPhaseEServices} from '../src/phaseEServices';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts} from '../src/ledger';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../src/game/baseOwnership';
import type {KeepEquipmentRuntimeSources} from '../src/game/keepEquipmentRuntime';
import {paymentFixture,paymentStock,transferPaymentBase} from './fixtures/keepEquipmentPayments';
import {ADMIN_DATABASE_URL} from './db-url';
import {createMigratedDatabase,releaseMigratedTemplates} from './migratedTemplate';
import {TEST_CONFIG} from './helpers';

const suffix=randomUUID().replaceAll('-',''),name=`keep_private_${suffix}_test`,role=`keep_api_${suffix}`,worker=`keep_worker_${suffix}`;
const ownerUrl=new URL(ADMIN_DATABASE_URL);ownerUrl.pathname=`/${name}`;
if(!['localhost','127.0.0.1','[::1]'].includes(ownerUrl.hostname))throw Error('Owned local fixture required');
const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),requestUrl=new URL(ownerUrl);requestUrl.username=role;requestUrl.password=randomBytes(32).toString('hex');
const config={...TEST_CONFIG,PLAYTEST_OPEN:'true' as const,DATABASE_URL:requestUrl.toString(),PHASE_E_SERVICE_DATABASE_URL:ownerUrl.toString()};
let owner:ReturnType<typeof createDb>,request:ReturnType<typeof createDb>;
function provision(){execFileSync('sh',[fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url))],{timeout:30_000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,
 PGHOST:ownerUrl.hostname,PGPORT:ownerUrl.port,PGDATABASE:name,PGUSER:decodeURIComponent(ownerUrl.username),PGPASSWORD:decodeURIComponent(ownerUrl.password),POSTGRES_USER:decodeURIComponent(ownerUrl.username),POSTGRES_PASSWORD:decodeURIComponent(ownerUrl.password),
 DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:requestUrl.password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});}
beforeAll(async()=>{await createMigratedDatabase(admin,name);owner=createDb(ownerUrl.toString(),{max:4});await runMigrations(owner.db);await bootstrapSystemAccounts(owner.db);provision();request=createDb(requestUrl.toString(),{max:2});},120_000);
afterEach(()=>vi.unstubAllEnvs());
afterAll(async()=>{await request?.sql.end();await owner?.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);
 // A migrated template holds GRANTs to the groups; release it before dropping them.
 await releaseMigratedTemplates();for(const id of [role,worker,'shardkeep_api_runtime','shardkeep_worker_runtime'])await admin.unsafe(`drop role if exists ${id}`);await admin.end();});
const root='/keep-equipment-market';
async function cookie(wallet:string){const [session]=await owner.sql`insert into sessions(wallet,expires_at) values(${wallet},${new Date(Date.now()+SESSION_TTL_SEC*1000).toISOString()}) returning id`;return {[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)};}
async function fixture(){
 const collection=Keypair.generate().publicKey.toBase58(),owners=new Map<string,string>();
 async function actor(stock:string){
  const signer=Keypair.generate(),wallet=signer.publicKey.toBase58(),baseId=randomUUID(),deed=Keypair.generate().publicKey.toBase58(),now=new Date();owners.set(deed,wallet);
  await owner.sql`insert into players(wallet) values(${wallet})`;await owner.sql`insert into bases(id,owner_wallet,deed_asset_id,land_paid_at) values(${baseId},${wallet},${deed},${now.toISOString()})`;
  await owner.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;await owner.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${baseId},'route_compass',${stock}::bigint)`;
  expect(await refreshBaseOwnership(owner.db,baseId,async()=>({owner:wallet,collection,frozen:false,delegate:null,slot:100}),collection,now,'private-market-fixture',()=>now)).toBe('owned');
  return {signer,wallet,baseId,deed,collection,now,authority:{baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}}};
 }
 const seller=await actor('10'),buyer=await actor('0'),f=await paymentFixture(owner,'legacy',false,{actors:{seller,buyer},itemId:'route_compass',listingQuantity:'10',fillQuantity:'2'});
 let deedReads=0;const ownership={deedCollection:collection,finalizedDeedReader:async(asset:string)=>{deedReads++;return {owner:owners.get(asset)!,collection,frozen:false,delegate:null,slot:100};}};
 const sent:Uint8Array[]=[],sources:KeepEquipmentRuntimeSources={payments:{...f.deps,broadcastConnect:()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,sendRawTransaction:async(bytes,options)=>{
  expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});expect(Buffer.from(bytes).toString('hex')).toBe(Buffer.from(f.controls.wire!).toString('hex'));sent.push(Uint8Array.from(bytes));
  return (await owner.sql`select signature from keep_equipment_payment_wires where signed_transaction=${Buffer.from(bytes)}`)[0]!.signature as string;
 }})},releases:{trust:f.trust,failureConnect:f.deps.finalityConnect}};
 return {...f,ownership,sources,sent,deedReads:()=>deedReads};
}
async function mount(ownership:Parameters<typeof createPhaseEServices>[2]={},sources?:KeepEquipmentRuntimeSources){
 vi.stubEnv('MULTI_BASE_ENABLED','false');const services=await createPhaseEServices(config,request.db,ownership,undefined,undefined,undefined,undefined,undefined,undefined,undefined,sources);
 expect(services?.deps.keepEquipmentMarket).toBeDefined();const app=await buildApp(config,request.db,services!.deps);await app.ready();
 return {app,services:services!,close:async()=>{await app.close();await services!.close();}};
}
it('normal private mount trades through restricted HTTP then recovers original receipts with sources removed and admissions paused',async()=>{
 const f=await fixture(),buyerCookies=await cookie(f.buyer.wallet),sellerCookies=await cookie(f.seller.wallet);let live=await mount(f.ownership,f.sources);
 const get=(path:string,cookies=buyerCookies)=>live.app.inject({url:root+path,cookies});
 const post=(path:string,payload:object={},cookies=buyerCookies)=>live.app.inject({method:'POST',url:root+path,cookies,payload,headers:{origin:config.WEB_ORIGIN[0]!}});
 try{
  const initialReads=f.controls.preparationCalls+f.controls.finalityCalls;expect((await live.app.inject({url:root+'/history'})).statusCode).toBe(401);expect(f.controls.preparationCalls+f.controls.finalityCalls).toBe(initialReads);
  // Clear the helper's genuine initial reservation, then admit the actual new
  // listing/fill through the normal HTTP/private factory boundary.
  expect((await post(`/fills/${f.fill.id}/release`)).statusCode).toBe(200);
  vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');
  expect((await post('/cancellations',{idempotencyKey:randomUUID(),listingId:f.listing.id},sellerCookies)).statusCode).toBe(200);
  const listing={idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId:'route_compass',quantity:'2',unitPriceBaseUnits:f.listing.unitPriceBaseUnits};
  const listed=await post('/listings',listing,sellerCookies);expect(listed.statusCode,listed.body).toBe(200);
  const command={idempotencyKey:randomUUID(),listingId:listing.idempotencyKey,buyerBaseId:f.buyer.baseId,quantity:'1'},filled=await post('/fills',command);expect(filled.statusCode,filled.body).toBe(200);
  const id=command.idempotencyKey;expect((await get(`/fills/${id}`,sellerCookies)).statusCode).toBe(404);
  const prepared=await post(`/fills/${id}/prepare`);expect(prepared.statusCode,prepared.body).toBe(200);f.controls.preparation=KeepEquipmentPurchaseSchema.parse(prepared.json()).preparation;
  const wire=f.sign(f.controls.preparation!);f.controls.wire=wire;const retained=await post(`/fills/${id}/signed`,{signedTransactionHex:Buffer.from(wire).toString('hex')});expect(retained.statusCode,retained.body).toBe(200);
  f.controls.finalityMode='missing';const relayed=await post(`/fills/${id}/deliver`);expect(relayed.statusCode,relayed.body).toBe(200);expect(relayed.json().status).toBe('submitted');expect(f.sent).toHaveLength(1);
  f.controls.finalityMode='ok';const collected=await post(`/fills/${id}/recover`);expect(collected.statusCode,collected.body).toBe(200);const original=collected.json();expect(original.status).toBe('delivered');
  expect(await paymentStock(owner,f.buyer.baseId)).toMatchObject({available:'1',market_incoming:'0'});
  expect(await owner.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(1);
  const newBuyer=await transferPaymentBase(owner,{...f.buyer,now:new Date()}),newBuyerCookies=await cookie(newBuyer);
  vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');f.controls.finalityMode='throw';await live.close();live=await mount();const before={chain:f.controls.preparationCalls+f.controls.finalityCalls,deed:f.deedReads()};
  for(const path of [`/fills/${id}`,`/fills/${id}/recover`]){const result=path.endsWith('/recover')?await post(path):await get(path);expect(result.statusCode,result.body).toBe(200);expect(result.json()).toEqual(original);expect(result.headers['cache-control']).toBe('private, no-store');}
  expect((await post('/fills',command)).json()).toEqual(original);expect((await get(`/fills/${id}`,newBuyerCookies)).statusCode).toBe(404);
  const history=await get('/history');expect(history.statusCode,history.body).toBe(200);expect(history.json().items).toContainEqual(expect.objectContaining({kind:'fill',id}));
  const denied=await post('/listings',{...listing,idempotencyKey:randomUUID()},sellerCookies);expect(denied.statusCode).toBe(503);expect(denied.json().error.code).toBe('KEEP_EQUIPMENT_MARKET_DISABLED');
  expect({chain:f.controls.preparationCalls+f.controls.finalityCalls,deed:f.deedReads()}).toEqual(before);expect(f.sent).toHaveLength(1);
 }finally{await live.close();}
},120_000);

it('rejects direct, column and latent membership escalation while preserving the immutable source seal across reprovisioning',async()=>{
 const seal=await owner.sql`select record from divine_fragment_resource_publication_contract`;await owner.sql`select shardkeep_divine_fragment_source()`;
 for(const table of ['keep_equipment_listings','keep_equipment_payment_wires','keep_equipment_deliveries','ordinary_equipment_stocks','payment_signature_claims']){
  await expect(request.sql.unsafe(`select * from ${table}`)).rejects.toMatchObject({code:'42501'});await expect(request.sql.unsafe(`insert into ${table} default values`)).rejects.toMatchObject({code:'42501'});
 }
 for(const [table,column] of [['keep_equipment_payment_preparations','fill_id'],['keep_equipment_fills','id'],['payment_signature_claims','signature']]){
  await owner.sql.unsafe(`grant select (${column}) on ${table} to ${role}`);
  try{await expect(createPhaseEServices(config,request.db)).rejects.toThrow('not isolated');}finally{await owner.sql.unsafe(`revoke select (${column}) on ${table} from ${role}`);}
 }
 const ownerRole=decodeURIComponent(ownerUrl.username);await owner.sql.unsafe(`alter role ${role} noinherit;grant ${ownerRole} to ${role}`);
 try{await expect(createPhaseEServices(config,request.db)).rejects.toThrow('not isolated');}finally{await owner.sql.unsafe(`revoke ${ownerRole} from ${role};alter role ${role} inherit`);}
 // Poisoned legacy grants are normalized by the actual script, not accepted by
 // resealing a wider source definition or teaching request roles private writes.
 await owner.sql.unsafe(`grant select on keep_equipment_listings to ${role}`);await expect(createPhaseEServices(config,request.db)).rejects.toThrow('not isolated');
 provision();await owner.sql`select shardkeep_divine_fragment_source()`;expect(await owner.sql`select record from divine_fragment_resource_publication_contract`).toEqual(seal);
 await expect(request.sql`select * from keep_equipment_listings`).rejects.toMatchObject({code:'42501'});
 const live=await mount();try{expect(Object.isFrozen(live.services.deps.keepEquipmentMarket)).toBe(true);expect(live.services.deps.keepEquipmentMarket).not.toHaveProperty('db');}finally{await live.close();}
},120_000);
