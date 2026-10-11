import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
/** Real browser intent/receipt storage -> authenticated resource claim -> conserved stock. */
import { createRequire } from 'node:module';
import type { SeekerResourceClaimReceipt, SeekerResourceClaimRequest, SeekerResourceEntitlementView } from '@shardkeep/shared/seekerResourceClaimsApi';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { sessions } from '../src/db/schema';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { retainResourceViewTerm } from './fixtures/seekerResourceEntitlements';
import { TEST_CONFIG } from './helpers';
type Identity={origin:string;api:string;wallet:string;cluster:'devnet'|'mainnet-beta'};
type Command={request:SeekerResourceClaimRequest;termHash:string;browseCursor:string|null};
type Operation={command:Command;attemptRevision:number|null;proof:{wallet:string;receipt:SeekerResourceClaimReceipt}|null};
type Journal={revision:number;operation:Operation|null;archives:{operation:Operation}[]};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={beginClaim(baseId:string,row:SeekerResourceEntitlementView['rows'][number]):Promise<void>;confirm():Promise<void>;open():Promise<void>;
 loadPage(cursor:string|null):Promise<void>;
 finish(hydrate:(guard:()=>void)=>Promise<void>):Promise<void>;snapshot():{error:string|null;view:SeekerResourceEntitlementView|null;review:{command:Command}|null}};
const {API_URL,api}=await vi.importActual<{API_URL:string;api:{getPrivate(path:string):Promise<unknown>}}>('../../web/src/lib/api');
const {SeekerResourceClaimsController}=await vi.importActual<{SeekerResourceClaimsController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/seekerResourceClaims/controller');
const {SeekerResourceClaimsJournalStore}=await vi.importActual<{SeekerResourceClaimsJournalStore:new(identity:Identity,factory:unknown)=>Store}>('../../web/src/lib/seekerResourceClaims/journal');
const {seekerResourceClaimsIdentity,createSeekerResourceClaimsBrowserPorts}=await vi.importActual<{
 seekerResourceClaimsIdentity(wallet:string):Identity;createSeekerResourceClaimsBrowserPorts(input:{identity:Identity;lifecycle():{active:boolean;visible:boolean;epoch:number;actionsEnabled:boolean}}):object;
}>('../../web/src/lib/seekerResourceClaims/browser');
const {refreshSeekerResourceClaimsSnapshot}=await vi.importActual<{refreshSeekerResourceClaimsSnapshot(identity:Identity,ports:object,guard:()=>void,originalBaseId:string):Promise<{view:{baseId:string;rawStock:{resourceId:string;available:string}[]}}|null>}>('../../web/src/lib/seekerResourceClaims/snapshot');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,entryPaid?:boolean):void;setSelectedBaseId(id:string|null,persist?:boolean):void;selectedBaseId:string|null}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=resourceClaimsDatabase();let app:FastifyInstance;const stores:Store[]=[];
beforeAll(async()=>{await conn.setup();await bootstrapSystemAccounts(conn.db);vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('FREE_ONBOARDING','true');app=await buildApp(TEST_CONFIG,conn.db);await app.ready();});
afterEach(async()=>{await Promise.all(stores.splice(0).map(s=>s.close()));useApp.getState().setAuth(null);useApp.getState().setSelectedBaseId(null,false);vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(async()=>{await app?.close();await conn.close();});
async function fixture(){
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('FREE_ONBOARDING','true');
 const f=await createResourceTaxFixture(conn.db),wallet=f.winner.wallet,factory=new IDBFactory();
 // The wallet's first owned term follows an entire unrelated retained page.
 // Keep browser pagination/review proofs real even when this file runs alone.
 for(let i=1;i<=16;i++){
  const hex=(BigInt('0x'+f.trip.termId.replaceAll('-',''))-BigInt(i)).toString(16).padStart(32,'0');
  await retainResourceViewTerm(conn.db,[hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-'),null);
 }
 const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
 const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
 vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,action:(lock:{name:string})=>Promise<T>)=>action({name})}});
 useApp.getState().setAuth(wallet,true);useApp.getState().setSelectedBaseId(f.baseId,false);const identity=seekerResourceClaimsIdentity(wallet);
 let lost=false,activeStore:Store|undefined;const posts:{body:unknown;journal:Journal;status:number}[]=[];
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit):Promise<Response>=>{
  const url=new URL(String(input)),method=init?.method??'GET';if(url.origin!==new URL(API_URL).origin||method!=='GET'&&method!=='POST')throw Error('Unexpected paired request');
  expect(init?.credentials).toBe('include');expect(init?.cache).toBe('no-store');
  const journal=method==='POST'?await activeStore!.read():null,headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
  const response=await app.inject({method,url:`${url.pathname}${url.search}`,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},cookies,
   ...(init?.body===undefined||init.body===null?{}:{payload:String(init.body)})});
  if(method==='POST'){posts.push({body:JSON.parse(String(init?.body)),journal:journal!,status:response.statusCode});if(lost){lost=false;throw TypeError('Lost accepted reply');}}
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 expect(await api.getPrivate('/me')).toMatchObject({wallet});
 function client(){const store=new SeekerResourceClaimsJournalStore(identity,factory);stores.push(store);activeStore=store;
  const ports=createSeekerResourceClaimsBrowserPorts({identity,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:process.env.PHASE_E_SEEKER_ENABLED==='true'})});
  return {store,controller:new SeekerResourceClaimsController(store,ports),hydrate:async(guard:()=>void)=>{
   const receipt=(await store.read()).operation!.proof!.receipt,snapshot=await refreshSeekerResourceClaimsSnapshot(identity,ports,guard,receipt.baseId);
   expect(snapshot?.view.baseId).toBe(f.baseId);expect(snapshot?.view.rawStock.find(r=>r.resourceId===receipt.resourceId)?.available).toBe(receipt.stockAfter);
  }};
 }
 return {...f,wallet,posts,client,loseReply:()=>{lost=true;}};
}
async function conserved(receipt:SeekerResourceClaimReceipt){
 const legs=await conn.sql`select bucket,delta::text from seeker_resource_claim_entries where claim_id=${receipt.id} order by bucket`;
 expect(legs).toEqual([{bucket:'base_stock',delta:receipt.quantity},{bucket:'island_pool',delta:(-BigInt(receipt.quantity)).toString()}]);
 expect(await conn.sql`select id from seeker_resource_claims where id=${receipt.id}`).toHaveLength(1);
 const [stock]=await conn.sql`select available::text from resource_stocks where base_id=${receipt.baseId} and resource_id=${receipt.resourceId}`;expect(stock!.available).toBe(receipt.stockAfter);
}
async function discoverOriginalRow(controller:Controller,termId:string){
 await controller.open();expect(controller.snapshot().error).toBeNull();let view=controller.snapshot().view!;
 expect(view).toMatchObject({status:'available',rows:[]});const visited=new Set<string>();
 while(!view.rows.some(row=>row.termId===termId&&row.spotId===0)){
  expect(view.nextCursor).not.toBeNull();const cursor=view.nextCursor!;
  expect(visited.has(cursor)).toBe(false);visited.add(cursor);await controller.loadPage(cursor);
  expect(controller.snapshot().error).toBeNull();view=controller.snapshot().view!;expect(view).toMatchObject({status:'available',cursor});
 }
 expect(view.cursor).not.toBeNull();return {row:view.rows.find(row=>row.termId===termId&&row.spotId===0)!,cursor:view.cursor};
}
describe('paired web original Seeker resource claim',()=>{
 it('reviews actual earned rights, saves exact destination before one POST, and refreshes conserved usable stock',async()=>{
  const f=await fixture(),c=f.client(),{row,cursor}=await discoverOriginalRow(c.controller,f.trip.termId);
  await c.controller.beginClaim(f.baseId,row);expect(c.controller.snapshot().error).toBeNull();expect(f.posts).toHaveLength(0);const command=c.controller.snapshot().review!.command;expect(command.browseCursor).toBe(cursor);
  await c.controller.confirm();expect(c.controller.snapshot().error).toBeNull();const receipt=(await c.store.read()).operation!.proof!.receipt;
  expect(f.posts).toHaveLength(1);expect(f.posts[0]!.body).toEqual(command.request);expect(f.posts[0]!.status).toBe(201);expect(f.posts[0]!.journal.operation?.command).toEqual(command);
  expect(f.posts[0]!.journal.operation?.attemptRevision).toBe(f.posts[0]!.journal.revision);expect(receipt.quantity).toBe(((f.trip.tax+3n)/3n).toString());await conserved(receipt);
  await c.controller.finish(c.hydrate);expect(c.controller.snapshot().error).toBeNull();expect((await c.store.read()).operation).toBeNull();expect((await c.store.read()).archives[0]!.operation.proof!.receipt).toEqual(receipt);
 });
 it('recovers a lost accepted reply in a new browser journal while paused, never resubmitting',async()=>{
  const f=await fixture(),c=f.client(),{row,cursor}=await discoverOriginalRow(c.controller,f.trip.termId);await c.controller.beginClaim(f.baseId,row);
  expect(c.controller.snapshot().review!.command.browseCursor).toBe(cursor);f.loseReply();await c.controller.confirm();
  expect(c.controller.snapshot().error).not.toBeNull();expect((await c.store.read()).operation?.proof).toBeNull();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const recovered=f.client();
  await recovered.controller.open();expect(recovered.controller.snapshot().error).toBeNull();const receipt=(await recovered.store.read()).operation!.proof!.receipt;await conserved(receipt);
  await recovered.controller.confirm();await recovered.controller.finish(recovered.hydrate);expect(recovered.controller.snapshot().error).toBeNull();expect(f.posts).toHaveLength(1);expect((await recovered.store.read()).archives[0]!.operation.proof!.receipt).toEqual(receipt);
 });
});
