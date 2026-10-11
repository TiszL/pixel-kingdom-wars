/** Actual browser controller/storage/sign-only/transport against authenticated
 * HTTP and original SQL workflows. Chain banks/transport are explicit fixtures;
 * actual Core execution is the separate charter-client-core acceptance. */
import {createRequire} from 'node:module';
import {AddressLookupTableAccount,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {PHASE_E_CHARTER_TRANSFER} from '@shardkeep/shared';
import {CharterClientSchema,type CharterClient} from '@shardkeep/shared/charterApi';
import type {CharterSigningTrust,SignedCharter} from '../../web/src/lib/charter/signing';
import {buildApp} from '../src/app';
import {createClanCharterClient,type CharterClientProvider} from '../src/game/clanCharterClient';
import type {CharterClientDeliveryRpc} from '../src/game/clanCharterClientDelivery';
import {TEST_CONFIG} from './helpers';
import {charterCreationWorkflowFixture} from './fixtures/charterCreationWorkflow';
import {charterSalesWorkflowFixture} from './fixtures/charterSalesWorkflow';

type Journal={operation:null|{command:{key:string};actions:string[];signingStarted:boolean;signed:SignedCharter|null;original:CharterClient|null}};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={create(request:object):Promise<void>;createSale(request:object):Promise<void>;check():Promise<void>;open(kind:string,id:string):Promise<void>;load():Promise<void>;accept(request:object):Promise<void>;command(action:string,body?:object):Promise<void>;review():Promise<void>;sign():Promise<void>;upload():Promise<void>;deliver():Promise<void>;archive():Promise<void>};
const {CharterJournalStore}=await vi.importActual<{CharterJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/charter/journal');
const {CharterController}=await vi.importActual<{CharterController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/charter/controller');
const {createCharterBrowserPorts,browserCharterIdentity}=await vi.importActual<{createCharterBrowserPorts(input:object):object;browserCharterIdentity(wallet:string):object}>('../../web/src/lib/charter/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
beforeEach(()=>vi.stubEnv('PHASE_E_CHARTER_ENABLED','true'));
afterEach(()=>{useApp.getState().setAuth(null);vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
async function application(db:Parameters<typeof buildApp>[1],provider:CharterClientProvider){const previous=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';try{const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},db,{charterClientProvider:provider});await app.ready();return app;}finally{if(previous===undefined)delete process.env['MULTI_BASE_ENABLED'];else process.env['MULTI_BASE_ENABLED']=previous;}}
function browserHarness(app:()=>FastifyInstance,trust:CharterSigningTrust,connection:object){
 const factory=new IDBFactory(),stores:Store[]=[],posts:string[]=[];let store!:Store,actor='',cookies:Record<string,string>={},enabled=true;
 let after=async(_path:string,_raw:unknown)=>{};const lose=new Set<string>();
 vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});
 vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);expect(['GET','POST']).toContain(method);
  const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
  if(method==='POST'){const saved=await store.read();expect(saved.operation).not.toBeNull();posts.push(target.pathname);}
  const response=await app().inject({method:method as 'GET'|'POST',url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
  expect(response.statusCode,response.body).toBeLessThan(300);await after(target.pathname,response.json());
  if(lose.delete(target.pathname))throw Error('paired lost response');
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 function client(wallet:string,auth:Record<string,string>,sign:(tx:VersionedTransaction)=>Promise<VersionedTransaction>,pins:CharterSigningTrust|null=trust){
  actor=wallet;cookies=auth;useApp.getState().setAuth(actor,true);store=new CharterJournalStore(browserCharterIdentity(actor),factory);stores.push(store);
  const signer={publicKey:new PublicKey(actor),signVersionedTransaction:async(tx:VersionedTransaction)=>{expect((await store.read()).operation?.signingStarted).toBe(true);return sign(tx);},sendTransaction:vi.fn(()=>{throw Error('Wallet must never deliver Charter');}),signMessage:null,isEmbedded:false};
  const controller=new CharterController(store,createCharterBrowserPorts({identity:browserCharterIdentity(actor),trust:pins,wallet:()=>signer,connection,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:enabled})}));
  return {controller,store};
 }
 return {client,posts,lose,after:(f:typeof after)=>{after=f;},pause:()=>{enabled=false;},close:async()=>{await Promise.all(stores.map(s=>s.close()));}};
}
function pins(chain:{trust:CharterSigningTrust['deployment'];expectedCurrentSigner:string;lookupTable:{address:string;dataSha256:string}},treasury:string):CharterSigningTrust{return {version:1,revision:'paired-D180',deployment:chain.trust,policySigner:chain.expectedCurrentSigner,treasury,royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,lookupTables:[chain.lookupTable]};}

it('recovers lost creation and upload replies across real browser restarts, delivers once, and archives original activation while paused',async()=>{
 const f=await charterCreationWorkflowFixture({staticLookupTable:true});await f.useSigningActor();let app:FastifyInstance|undefined,h:ReturnType<typeof browserHarness>|undefined;
 try{
  const send=vi.fn<CharterClientDeliveryRpc['sendRawTransaction']>(async bytes=>bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!)),rpc={...f.rpc,sendRawTransaction:send,getSignatureStatuses:async()=>({context:{slot:150},value:[null]})};
  app=await application(f.db,createClanCharterClient(f.db,{creation:f.options(),delivery:{connect:()=>rpc,trust:f.chain.trust,expectedCurrentSigner:f.chain.expectedCurrentSigner,lookupTable:f.chain.lookupTable}}));
  const trust=pins(f.chain,AddressLookupTableAccount.deserialize(f.lookupData).addresses[11]!.toBase58());h=browserHarness(()=>app!,trust,f.rpc);
  const input=f.request(),base='/clans/charter/client/creations',url=base+'/'+input.creationIntentId;h.lose.add(base);h.lose.add(url+'/signed');
  h.after(async(path)=>{if(path===base)await f.sync(input.creationIntentId);});
  let current:{controller:Controller;store:Store};let signatures=0;const sign=async(_tx:VersionedTransaction)=>{signatures++;const original=(await current.store.read()).operation!.original!;expect(original.kind).toBe('creation');if(original.kind!=='creation')throw Error();return f.signed(original.state).tx;};
  current=h.client(f.payerActor.wallet,f.auth.cookies,sign);await expect(current.controller.create(input)).rejects.toThrow('lost response');
  expect((await current.store.read()).operation?.command.key).toBe(input.creationIntentId);const fundedBalance=await f.balance('base_shards',f.payerActor.baseId);
  current=h.client(f.payerActor.wallet,f.auth.cookies,sign);await current.controller.check();await current.controller.command('prepare');await current.controller.review();await current.controller.sign();
  const saved=(await current.store.read()).operation!.signed;expect(saved?.kind).toBe('creation');await expect(current.controller.upload()).rejects.toThrow('lost response');
  current=h.client(f.payerActor.wallet,f.auth.cookies,sign);await current.controller.check();expect((await current.store.read()).operation!.signed).toEqual(saved);await current.controller.deliver();expect(send).toHaveBeenCalledOnce();expect(signatures).toBe(1);
  await f.sync(input.creationIntentId,true);await current.controller.command('recover');expect((await current.store.read()).operation!.original!.state.status).toBe('activated');
  await app.close();app=await application(f.db,createClanCharterClient(f.db));f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');h.pause();
  current=h.client(f.payerActor.wallet,f.auth.cookies,sign,null);await current.controller.check();await expect(current.controller.sign()).rejects.toThrow();await current.controller.archive();expect((await current.store.read()).operation).toBeNull();
  expect(h.posts.filter(p=>p===base)).toHaveLength(1);expect(h.posts.filter(p=>p===url+'/signed')).toHaveLength(1);expect(h.posts.filter(p=>p===url+'/deliver')).toHaveLength(1);expect(signatures).toBe(1);expect(await f.balance('base_shards',f.payerActor.baseId)).toBe(fundedBalance);
 }finally{await h?.close();await app?.close();await f.dispose();}
},120000);

it('uses the seller key after a lost draft, obtains separate buyer and seller signatures, and resumes both journals through one completed sale',async()=>{
 const f=await charterSalesWorkflowFixture({staticLookupTable:true});let app:FastifyInstance|undefined,h:ReturnType<typeof browserHarness>|undefined;
 try{
  const send=vi.fn<CharterClientDeliveryRpc['sendRawTransaction']>(async bytes=>bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!)),rpc={...f.rpc,sendRawTransaction:send,getSignatureStatuses:async()=>({context:{slot:150},value:[null]})};
  app=await application(f.db,createClanCharterClient(f.db,{sales:f.options(),delivery:{connect:()=>rpc,trust:f.chain.trust,expectedCurrentSigner:f.chain.expectedCurrentSigner,lookupTable:f.chain.lookupTable}}));
  h=browserHarness(()=>app!,pins(f.chain,f.domain.treasury),f.rpc);const input=f.request(),base='/clans/charter/client/sales',seller=f.birth.actor.wallet,buyer=f.buyer.wallet,counts=new Map<string,number>();
  const sign=(actor:string)=>async(tx:VersionedTransaction)=>{counts.set(actor,(counts.get(actor)??0)+1);tx.sign([f.keys.get(actor)!]);return tx;};
  h.lose.add(base);h.after(async(path,raw)=>{if(path===base){const value=CharterClientSchema.parse(raw);if(value.kind!=='sale')throw Error();f.selectSale(value.state);}});
  let sellerClient=h.client(seller,f.sellerAuth.cookies,sign(seller));await expect(sellerClient.controller.createSale(input)).rejects.toThrow('lost response');sellerClient=h.client(seller,f.sellerAuth.cookies,sign(seller));await sellerClient.controller.check();
  const draft=(await sellerClient.store.read()).operation!.original!;expect(draft.kind).toBe('sale');if(draft.kind!=='sale')throw Error();const saleId=draft.key;
  let buyerClient=h.client(buyer,f.buyerAuth.cookies,sign(buyer));await buyerClient.controller.load();await buyerClient.controller.open('sale',saleId);await buyerClient.controller.accept({termsHash:draft.state.original.termsHash,buyerBaseId:f.buyer.baseId});
  sellerClient=h.client(seller,f.sellerAuth.cookies,sign(seller));await sellerClient.controller.check();await sellerClient.controller.command('prepare');await sellerClient.controller.review();await sellerClient.controller.sign();await sellerClient.controller.upload();expect((await sellerClient.store.read()).operation!.original!.wire).toBeNull();
  buyerClient=h.client(buyer,f.buyerAuth.cookies,sign(buyer));await buyerClient.controller.check();await buyerClient.controller.review();await buyerClient.controller.sign();h.lose.add(`${base}/${saleId}/signature`);await expect(buyerClient.controller.upload()).rejects.toThrow('lost response');
  buyerClient=h.client(buyer,f.buyerAuth.cookies,sign(buyer));await buyerClient.controller.check();const full=(await buyerClient.store.read()).operation!.original!;expect(full.contributions).toHaveLength(2);expect(full.wire).not.toBeNull();await buyerClient.controller.deliver();expect(send).toHaveBeenCalledOnce();
  await f.finalize(saleId);await buyerClient.controller.command('recover');expect((await buyerClient.store.read()).operation!.original!.state.status).toBe('completed');
  await app.close();app=await application(f.db,createClanCharterClient(f.db));f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');h.pause();
  sellerClient=h.client(seller,f.sellerAuth.cookies,sign(seller),null);await sellerClient.controller.check();expect((await sellerClient.store.read()).operation!.original!.state.status).toBe('completed');await sellerClient.controller.archive();
  buyerClient=h.client(buyer,f.buyerAuth.cookies,sign(buyer),null);await buyerClient.controller.check();await buyerClient.controller.archive();
  expect([...counts.values()]).toEqual([1,1]);expect(h.posts.filter(p=>p===base)).toHaveLength(1);expect(h.posts.filter(p=>p.endsWith('/signature'))).toHaveLength(2);expect(h.posts.filter(p=>p.endsWith('/deliver'))).toHaveLength(1);
 }finally{await h?.close();await app?.close();await f.dispose();}
},120000);
