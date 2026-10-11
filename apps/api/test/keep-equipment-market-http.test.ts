/** Real authenticated routes and SQL stock; no preverified payment injection.
 * Payment execution is covered separately by keep-equipment-payments.test.ts. */
import {createKeepEquipmentMarketProvider} from '../src/game/keepEquipmentMarketProvider';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {BASE_OWNERSHIP,PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT} from '@shardkeep/shared';
import {KeepEquipmentPurchaseSchema,KeepEquipmentListingPageSchema,KeepEquipmentHistoryPageSchema,KeepEquipmentStockViewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import type {FinalizedDeedReader} from '../src/game/baseOwnership';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb(),collection=Keypair.generate().publicKey.toBase58(),owners=new Map<string,string>();
const reader:FinalizedDeedReader=vi.fn(async asset=>({owner:owners.get(asset)!,collection,frozen:false,delegate:null,slot:100}));
let app:FastifyInstance;
const market=createKeepEquipmentMarketProvider(conn.db,{finalizedDeedReader:reader,deedCollection:collection});
const root='/keep-equipment-market',price=PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits.toString();
beforeAll(async()=>{vi.stubEnv('MULTI_BASE_ENABLED','false');app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},conn.db,{keepEquipmentMarket:market});await app.ready();});
afterEach(()=>{vi.useRealTimers();vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');});
afterAll(async()=>{await app.close();await conn.sql.end();vi.unstubAllEnvs();});
async function player(stock='30'){
 const wallet=Keypair.generate().publicKey.toBase58(),baseId=randomUUID(),deed=Keypair.generate().publicKey.toBase58();
 owners.set(deed,wallet);await conn.sql`insert into players(wallet) values(${wallet})`;
 await conn.sql`insert into bases(id,owner_wallet,deed_asset_id,land_paid_at) values(${baseId},${wallet},${deed},now())`;
 await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
 await conn.sql`insert into ordinary_equipment_stocks(base_id,item_id,available) values(${baseId},'route_compass',${stock}::bigint)`;
 const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 return {wallet,baseId,deed,cookies:{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)}};
}
const enabled=()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');};
const listing=(baseId:string,quantity='3')=>({idempotencyKey:randomUUID(),baseId,itemId:'route_compass',quantity,unitPriceBaseUnits:price});
async function post(path:string,cookies:Record<string,string>,payload:unknown){return app.inject({method:'POST',url:root+path,cookies,headers:{'content-type':'application/json'},payload:JSON.stringify(payload)});}
async function offer(s:Awaited<ReturnType<typeof player>>,quantity='3'){
 const command=listing(s.baseId,quantity),reply=await post('/listings',s.cookies,command);expect(reply.statusCode,reply.body).toBe(200);return {command,value:reply.json()};
}
it('authenticates first, refuses ambient providers/default admission, and bounds the strict request surface',async()=>{
 // The request adapter cannot hand route code a database or trusted source.
 expect(Object.isFrozen(market)).toBe(true);expect('db'in market).toBe(false);expect(Object.values(market).every(value=>typeof value==='function')).toBe(true);
 const s=await player();expect((await app.inject({url:root+'/history'})).statusCode).toBe(401);
 expect((await post('/listings',s.cookies,listing(s.baseId))).json().error.code).toBe('KEEP_EQUIPMENT_MARKET_DISABLED');enabled();
 for(const field of ['wallet','sellerWallet','proof','signature','taxRate'])expect((await post('/listings',s.cookies,{...listing(s.baseId),[field]:'forged'})).statusCode).toBe(400);
 for(const action of ['prepare','recover','review','deliver'])expect((await post('/fills/'+randomUUID()+'/'+action,s.cookies,{proof:{}})).statusCode).toBe(400);
 expect((await app.inject({url:root+'/listings?limit=1000000',cookies:s.cookies})).statusCode).toBe(400);
 expect((await app.inject({url:root+'/history?wallet='+s.wallet,cookies:s.cookies})).statusCode).toBe(400);
 expect((await post('/fills/'+randomUUID()+'/signed',s.cookies,{signedTransactionHex:'a'.repeat(5000)})).statusCode).toBe(413);
 vi.stubEnv('MULTI_BASE_ENABLED','false');const absent=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},conn.db);try{await absent.ready();const reply=await absent.inject({url:root+'/fills/'+randomUUID(),cookies:s.cookies});expect(reply.statusCode).toBe(503);expect(reply.json().error.code).toBe('KEEP_EQUIPMENT_MARKET_UNAVAILABLE');}finally{await absent.close();}
});
it('lists and reserves real stock without a Market building, then reopens exact originals while paused',async()=>{
 const s=await player(),b=await player('0');enabled();const o=await offer(s),command={idempotencyKey:randomUUID(),listingId:o.value.id,buyerBaseId:b.baseId,quantity:'2'};
 const response=await post('/fills',b.cookies,command);expect(response.statusCode,response.body).toBe(200);const receipt=KeepEquipmentPurchaseSchema.parse(response.json());expect(receipt.status).toBe('reserved');
 expect(await conn.sql`select available::text,market_incoming::text from ordinary_equipment_stocks where base_id=${b.baseId}`).toEqual([{available:'0',market_incoming:'2'}]);
 const inventoryReply=await app.inject({url:root+'/stock?baseId='+b.baseId,cookies:b.cookies});expect(inventoryReply.statusCode,inventoryReply.body).toBe(200);
 const inventory=KeepEquipmentStockViewSchema.parse(inventoryReply.json());expect(inventory.items.find(i=>i.itemId==='route_compass')).toEqual({itemId:'route_compass',available:'0',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'2'});
 expect(inventory.items.find(i=>i.itemId==='survey_lens')?.available).toBe('0');expect(inventory.policy.reviewMaxAgeMs).toBe(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs);
 expect((await app.inject({url:root+'/stock?baseId='+s.baseId,cookies:b.cookies})).statusCode).not.toBe(200);
 expect((await post('/fills/'+receipt.fill.id+'/prepare',b.cookies,{})).json().error.code).toBe('KEEP_EQUIPMENT_PREPARATION_UNAVAILABLE');
 vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');
 const replay=await post('/fills',b.cookies,command);expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual(receipt);
 expect((await post('/listings',s.cookies,o.command)).statusCode).toBe(200);
 expect((await post('/fills',b.cookies,{...command,quantity:'1'})).statusCode).toBe(409);
 const read=await app.inject({url:root+'/fills/'+receipt.fill.id,cookies:b.cookies});expect(read.headers['cache-control']).toBe('private, no-store');expect(read.json()).toEqual(receipt);
 expect((await app.inject({url:root+'/fills/'+receipt.fill.id,cookies:s.cookies})).statusCode).toBe(404);
 expect((await post('/fills/'+receipt.fill.id+'/recover',b.cookies,{})).json().error.code).toBe('KEEP_EQUIPMENT_PAYMENT_NOT_RETAINED');
 const history=KeepEquipmentHistoryPageSchema.parse((await app.inject({url:root+'/history',cookies:b.cookies})).json());expect(history.items).toEqual([expect.objectContaining({kind:'fill',id:receipt.fill.id,baseId:b.baseId})]);
});
it('cancels only unsold units and privately recovers that original cancellation during a pause',async()=>{
 const s=await player(),b=await player('0');enabled();const o=await offer(s);
 expect((await post('/fills',b.cookies,{idempotencyKey:randomUUID(),listingId:o.value.id,buyerBaseId:b.baseId,quantity:'1'})).statusCode).toBe(200);
 const command={idempotencyKey:randomUUID(),listingId:o.value.id},reply=await post('/cancellations',s.cookies,command);expect(reply.statusCode,reply.body).toBe(200);expect(reply.json().quantity).toBe('2');
 expect(await conn.sql`select available::text,market_outgoing::text from ordinary_equipment_stocks where base_id=${s.baseId}`).toEqual([{available:'29',market_outgoing:'1'}]);
 vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');expect((await post('/cancellations',s.cookies,command)).json()).toEqual(reply.json());
 expect((await app.inject({url:root+'/cancellations/'+command.idempotencyKey,cookies:b.cookies})).statusCode).toBe(404);
});
it('requires both current deeds for new purchases and rejects non-v4 keys before holding stock',async()=>{
 const s=await player(),b=await player('0');enabled();const o=await offer(s),body={idempotencyKey:'00000000-0000-7000-8000-000000000001',listingId:o.value.id,buyerBaseId:b.baseId,quantity:'1'};
 expect((await post('/fills',b.cookies,body)).statusCode).toBe(400);
 owners.set(s.deed,Keypair.generate().publicKey.toBase58());
 // The prior listing legitimately populated the bounded finalized-deed cache.
 // Advance fixture Date past its real policy lease before demanding a new read.
 const refreshAt=Date.now()+BASE_OWNERSHIP.mutationFreshnessMs+1;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(refreshAt);
 expect((await post('/fills',b.cookies,{...body,idempotencyKey:randomUUID()})).statusCode).not.toBe(200);
 expect(await conn.sql`select available::text,market_incoming::text from ordinary_equipment_stocks where base_id=${b.baseId}`).toEqual([{available:'0',market_incoming:'0'}]);
});
it('paginates bounded listing discovery and private history without losing same-time originals',async()=>{
 const s=await player(String(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.pageSize+1));enabled();const ids:string[]=[];
 for(let n=0;n<=PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.pageSize;n++)ids.push((await offer(s,'1')).value.id);
 let cursor:Record<string,string>|null=null;const history:string[]=[];
 do{const suffix=cursor?'?'+new URLSearchParams(cursor):'',reply=await app.inject({url:root+'/history'+suffix,cookies:s.cookies});expect(reply.statusCode,reply.body).toBe(200);const page=KeepEquipmentHistoryPageSchema.parse(reply.json());history.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);
 expect(new Set(history)).toEqual(new Set(ids));expect(history).toHaveLength(ids.length);
 const listingReply=await app.inject({url:root+'/listings?itemId=route_compass',cookies:s.cookies});const page=KeepEquipmentListingPageSchema.parse(listingReply.json());expect(page.items.length).toBeLessThanOrEqual(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.pageSize);expect(page.nextCursor).not.toBeNull();
});

it('D194 explicitly opts into eleven stock rows and filters Resources/Items without changing policy or old discovery',async()=>{
 const s=await player();enabled();await conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${s.baseId},'frostglass',6),(${s.baseId},'navigation_kit',4)`;
 const resource={...listing(s.baseId,'2'),itemId:'frostglass'},kit={...listing(s.baseId,'1'),itemId:'navigation_kit'};
 for(const body of [resource,kit])expect((await post('/listings',s.cookies,body)).statusCode).toBe(200);
 const old=await app.inject({url:root+'/stock?baseId='+s.baseId,cookies:s.cookies});expect(old.statusCode,old.body).toBe(200);expect(old.json().catalogueVersion).toBeUndefined();expect(old.json().items).toHaveLength(2);
 const next=await app.inject({url:root+'/stock?baseId='+s.baseId+'&catalogueVersion=2',cookies:s.cookies});expect(next.statusCode,next.body).toBe(200);const view=KeepEquipmentStockViewSchema.parse(next.json());expect(view.items).toHaveLength(11);expect(view).toMatchObject({catalogueVersion:2,policy:old.json().policy});expect(view.items.find(r=>r.itemId==='frostglass')).toMatchObject({available:'4',reserved:'0',marketOutgoing:'2'});
 for(const tail of ['/stock?baseId='+s.baseId+'&catalogueVersion=1','/stock?baseId='+s.baseId+'&catalogueVersion=2&category=resources','/listings?category=resources','/history?catalogueVersion=2&category=items&itemId=frostglass'])expect((await app.inject({url:root+tail,cookies:s.cookies})).statusCode).toBe(400);
 const v1=KeepEquipmentHistoryPageSchema.parse((await app.inject({url:root+'/history',cookies:s.cookies})).json());expect(v1.items).toHaveLength(0);
 const resources=KeepEquipmentListingPageSchema.parse((await app.inject({url:root+'/listings?catalogueVersion=2&category=resources&itemId=frostglass',cookies:s.cookies})).json());expect(resources.items.some(x=>x.id===resource.idempotencyKey)).toBe(true);expect(resources.items.every(x=>x.itemId==='frostglass')).toBe(true);
 const items=KeepEquipmentHistoryPageSchema.parse((await app.inject({url:root+'/history?catalogueVersion=2&category=items',cookies:s.cookies})).json());expect(items.items.map(i=>i.id)).toEqual([kit.idempotencyKey]);
});
it('D194 crafting originals remain exact and privately recoverable through source pause without retaxing delivery rights',async()=>{
 const s=await player(),b=await player('0');enabled();await conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${s.baseId},'crownsteel',5)`;
 const command={...listing(s.baseId,'3'),itemId:'crownsteel'},offer=await post('/listings',s.cookies,command);expect(offer.statusCode,offer.body).toBe(200);
 const request={idempotencyKey:randomUUID(),listingId:command.idempotencyKey,buyerBaseId:b.baseId,quantity:'2'},fill=await post('/fills',b.cookies,request);expect(fill.statusCode,fill.body).toBe(200);expect(fill.json().fill.itemId).toBe('crownsteel');
 vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');const released=await post('/fills/'+request.idempotencyKey+'/release',b.cookies,{});expect(released.statusCode,released.body).toBe(200);expect(released.json().status).toBe('released');
 expect((await post('/fills',b.cookies,request)).json()).toEqual(released.json());expect((await app.inject({url:root+'/listings/'+command.idempotencyKey,cookies:s.cookies})).json().itemId).toBe('crownsteel');
 expect((await app.inject({url:root+'/fills/'+request.idempotencyKey,cookies:s.cookies})).statusCode).toBe(404);
 const h=await app.inject({url:root+'/history?catalogueVersion=2&category=resources',cookies:b.cookies});expect(h.statusCode,h.body).toBe(200);expect(h.headers['cache-control']).toBe('private, no-store');expect(h.json().items).toEqual([expect.objectContaining({id:request.idempotencyKey,itemId:'crownsteel'})]);
 expect(await conn.sql`select available::text,market_outgoing::text from crafting_stocks where base_id=${s.baseId}`).toEqual([{available:'4',market_outgoing:'1'}]);expect(await conn.sql`select available::text,market_incoming::text from crafting_stocks where base_id=${b.baseId}`).toEqual([{available:'0',market_incoming:'0'}]);
});

it('D195 exposes protected fragments only in exact catalogue3 stock, preserving v2 eleven and default two',async()=>{
 const s=await player();enabled();
 const reply=await app.inject({url:root+'/stock?baseId='+s.baseId+'&catalogueVersion=3',cookies:s.cookies});expect(reply.statusCode,reply.body).toBe(200);
 const view=KeepEquipmentStockViewSchema.parse(reply.json());expect(view).toMatchObject({catalogueVersion:3});expect(view.items).toHaveLength(12);expect(view.items.find(i=>i.itemId==='crystal_fragment')).toEqual({itemId:'crystal_fragment',available:'0',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'});
 const old=await app.inject({url:root+'/stock?baseId='+s.baseId+'&catalogueVersion=2',cookies:s.cookies});expect(old.json().items).toHaveLength(11);expect(old.json().items.some((i:{itemId:string})=>i.itemId==='crystal_fragment')).toBe(false);
 for(const query of ['catalogueVersion=2&itemId=crystal_fragment','catalogueVersion=3&category=items&itemId=crystal_fragment'])expect((await app.inject({url:root+'/listings?'+query,cookies:s.cookies})).statusCode).toBe(400);
});
