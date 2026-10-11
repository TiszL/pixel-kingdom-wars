/** Real browser journal/HTTP, authenticated API and SQL worker completions. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {afterEach,it,expect,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {readOwnedStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {readOwnedAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {buildApp} from '../src/app';
import {TEST_CONFIG} from './helpers';
import {surveyLensPairFixture} from './fixtures/surveyLensPair';
import {SEAL_BOUND_PAIRED_HTTP_CASE_MS} from './sealLatencyBudgets';
import type {OrdinaryEquipmentViewV2} from '@shardkeep/shared/ordinaryEquipmentApi';
import type {StarterExpeditionView} from '@shardkeep/shared/starterExpeditionApi';
import type {VehicleRoutes} from '@shardkeep/shared/vehicleClientApi';
type Op={command:{kind:string;request:{idempotencyKey:string};quote:object};attemptRevision:number|null;proof:unknown};
type Store={read():Promise<{operation:Op|null;archives:{operation:Op}[]}>;close():Promise<void>};
type Controller={chooseFitting(fitting:object):void;load(baseId?:string):Promise<unknown>;begin(command:object):Promise<unknown>;recover(key:string,post?:boolean):Promise<unknown>;collect(baseId:string):Promise<unknown>;abandon(key:string):Promise<unknown>;getSnapshot():{equipment:OrdinaryEquipmentViewV2|null;starter:StarterExpeditionView|null;routes:VehicleRoutes|null}};
const {CompassJournalStore}=await vi.importActual<{CompassJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/routeCompass/journal');
const {CompassController}=await vi.importActual<{CompassController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/routeCompass/controller');
const {createCompassBrowserPorts,browserCompassIdentity}=await vi.importActual<{createCompassBrowserPorts(input:object):object;browserCompassIdentity(wallet:string):object}>('../../web/src/lib/routeCompass/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(baseId:string|null,reset?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
afterEach(()=>{useApp.getState().setAuth(null);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
it('crafts a Lens, preserves its selected second cargo through lost replies and current-choice changes, and returns both legs once',async()=>{
 const f=await surveyLensPairFixture(),stores:Store[]=[];let app:FastifyInstance|undefined;
 try{
  async function application(){const old=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const next=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},f.f.conn.db,f.providers());await next.ready();return next;}finally{process.env['MULTI_BASE_ENABLED']=old;}}
  app=await application();vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
  const factory=new IDBFactory(),lose=new Set<string>(),posts:string[]=[];let store!:Store,enabled=true;
  vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});if(method==='POST'){posts.push(target.pathname);if(target.pathname!=='/advanced-expeditions/collect'){const saved=await store.read();expect(saved.operation?.command.request).toEqual(JSON.parse(String(init?.body)));expect(saved.operation?.attemptRevision).toBeGreaterThan(0);}}
   const response=await app!.inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies:f.cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});expect(response.statusCode,response.body).toBeLessThan(500);if(method==='POST'&&lose.delete(target.pathname))throw Error('paired lost Compass reply');return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
  });
  function client(){useApp.getState().setAuth(f.config.wallet,true);useApp.getState().setSelectedBaseId(f.config.baseId,false);const identity=browserCompassIdentity(f.config.wallet);store=new CompassJournalStore(identity,factory);stores.push(store);return new CompassController(store,createCompassBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})}));}
  const fitting={itemId:'survey_lens',policyVersion:1,resourceId:f.config.lensResourceId};let c=client();c.chooseFitting(fitting);await c.load(f.config.baseId);const craftKey=randomUUID(),quote=c.getSnapshot().equipment!.recipes.find(r=>r.recipeId==='craft_survey_lens')!;
  await c.begin({kind:'craft',request:{idempotencyKey:craftKey,baseId:f.config.baseId,recipeId:quote.recipeId,recipeVersion:quote.recipeVersion,quantity:quote.quantity},quote});lose.add('/ordinary-equipment/jobs');await expect(c.recover(craftKey,true)).rejects.toThrow('paired lost');c=client();await c.recover(craftKey,true);await f.finishCraft(craftKey);await c.load(f.config.baseId);expect(c.getSnapshot().equipment!.equipmentStock.find(s=>s.itemId==='survey_lens')!.available).toBe('1');await c.recover(craftKey);
  c.chooseFitting(fitting);await c.load(f.config.baseId);const starter=c.getSnapshot().starter!,route=starter.routes.find(r=>r.routeId==='coastal_survey')!,starterKey=randomUUID();
  await c.begin({kind:'starter',request:{idempotencyKey:starterKey,baseId:f.config.baseId,installationId:starter.installation!.installationId,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting},quote:route});lose.add('/starter-expeditions');await expect(c.recover(starterKey,true)).rejects.toThrow('paired lost');c=client();await c.recover(starterKey,true);
  const trip=await readOwnedStarterExpedition(f.f.conn.db,f.config.wallet,starterKey);f.advanceTo(trip!.returnsAt);await c.load(f.config.baseId);await c.recover(starterKey);expect(c.getSnapshot().equipment!.equipmentStock.find(s=>s.itemId==='survey_lens')!.available).toBe('1');
  // Changing the current selector cannot rewrite the completed saved original.
  c.chooseFitting({itemId:'route_compass',policyVersion:1});await c.recover(starterKey);expect((await store.read()).operation!.command.request).toMatchObject({fitting});c.chooseFitting(fitting);await c.load(f.config.baseId);
  const advanced=c.getSnapshot().routes!.items.find(i=>i.installationId===f.config.installationId)!.previews.find(p=>p.routeId===f.config.routeId)!,advancedKey=randomUUID();await c.begin({kind:'advanced',request:{idempotencyKey:advancedKey,baseId:f.config.baseId,installationId:f.config.installationId,routeId:advanced.routeId,policyVersion:advanced.policyVersion,fitting},quote:advanced});lose.add('/advanced-expeditions');await expect(c.recover(advancedKey,true)).rejects.toThrow('paired lost');
  f.state({paused:true,providerless:true});enabled=false;await app.close();app=await application();c=client();await c.recover(advancedKey);const advancedTrip=await readOwnedAdvancedExpedition(f.f.conn.db,f.config.wallet,advancedKey);f.advanceTo(advancedTrip!.returnsAt);await c.collect(f.config.baseId);await c.recover(advancedKey);
  const journal=await store.read();expect(journal.archives).toHaveLength(2);expect(journal.operation!.proof).toMatchObject({receipt:{request:{fitting},route:{secondaryOutput:{resourceId:f.config.lensResourceId}}},return:{completedTotal:'2',secondaryOutput:{resourceId:f.config.lensResourceId}}});expect((await f.f.conn.sql`select available,reserved,pending_output from ordinary_equipment_stocks where base_id=${f.config.baseId} and item_id='survey_lens'`)[0]).toEqual({available:'1',reserved:'0',pending_output:'0'});expect(await f.f.conn.sql`select * from ordinary_equipment_reservations`).toHaveLength(2);expect(await f.f.conn.sql`select * from ordinary_equipment_releases`).toHaveLength(2);expect(posts).toEqual(['/ordinary-equipment/jobs','/starter-expeditions','/advanced-expeditions','/advanced-expeditions/collect']);
  // Race/empty-stock denial is definitive only after the API rolls back. It
  // must not strand the browser's durable attempt or erase its used key.
  f.state({paused:false});enabled=true;await app.close();app=await application();c=client();const refusedKey=randomUUID();
  await c.begin({kind:'craft',request:{idempotencyKey:refusedKey,baseId:f.config.baseId,recipeId:quote.recipeId,recipeVersion:quote.recipeVersion,quantity:quote.quantity},quote});
  await expect(c.recover(refusedKey,true)).rejects.toThrow('Insufficient refined');await c.abandon(refusedKey);
  expect((await store.read()).operation).toBeNull();expect((await store.read()).archives.at(-1)).toMatchObject({reason:'refused',operation:{refusal:{code:'INSUFFICIENT_CRAFTING_STOCK'}}});
 }finally{await Promise.all(stores.map(s=>s.close()));await app?.close();await f.dispose();}
},SEAL_BOUND_PAIRED_HTTP_CASE_MS);
