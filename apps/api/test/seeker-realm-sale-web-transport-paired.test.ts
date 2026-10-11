/** Actual browser ports/transport/controller/storage/signing against the local
 * authenticated API and injected relay. No public RPC, mount or device. */
import {createRequire} from 'node:module';
import {Keypair,type Transaction} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
type Signed={wire:string;signature:string};
type Journal={operation:null|{request:{idempotencyKey:string};prepareAttempted:boolean;preparation:unknown;signingStarted:boolean;signed:Signed|null;submitAttempted:boolean}};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;review():Promise<void>;sign():Promise<void>;submit():Promise<void>;snapshot():{error:string|null}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const {createRealmSaleBrowserPorts,realmSaleIdentity}=await vi.importActual<{createRealmSaleBrowserPorts(input:object):object;realmSaleIdentity(wallet:string):object}>('../../web/src/lib/realmSales/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>{useApp.getState().setAuth(null);vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('paired realm purchase browser transport',()=>{
 it('survives lost prepare/submit replies through actual owned fetch without another signature or POST',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58();
  const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'transport-pair-r1'}},factory=new IDBFactory(),stores:Store[]=[];
  let activeStore!:Store,relays=0,actionsEnabled=true,losePrepare=true,loseSubmit=true;
  let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources,realmSaleRelaySources:{admission:sources,transport:()=>({
   getGenesisHash:async()=>f.controls.genesisHash,getSignatureStatuses:async()=>({context:{slot:f.controls.slot},value:[null]}),getBlockHeight:async()=>f.controls.blockHeight,
   sendRawTransaction:async bytes=>{relays++;expect(Buffer.from(bytes).toString('base64')).toBe((await activeStore.read()).operation?.signed?.wire);throw Error('lost relay acknowledgement');},
  })}});
  try{
   await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};
   vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!}});vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});useApp.getState().setAuth(wallet,true);
   const posts:Array<{path:string;journal:Journal}>=[];
   vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
    const target=new URL(String(input)),method=init?.method??'GET';if(target.origin!==new URL(API_URL).origin||method!=='GET'&&method!=='POST')throw Error('Unexpected paired request');
    const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
    const saved=method==='POST'?await activeStore.read():null;
    const r=await app.inject({method,url:target.pathname+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
    if(method==='POST'){posts.push({path:target.pathname,journal:saved!});if(target.pathname.endsWith('/prepare')&&losePrepare){losePrepare=false;expect(r.statusCode).toBe(201);throw Error('lost prepare reply');}if(target.pathname.endsWith('/submit')&&loseSubmit){loseSubmit=false;expect(r.statusCode).toBe(202);throw Error('lost submit reply');}}
    return new Response(r.body,{status:r.statusCode,headers:{'content-type':'application/json'}});
   });
   const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
   const signTransaction=vi.fn(async(tx:Transaction)=>{expect((await activeStore.read()).operation?.signingStarted).toBe(true);tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
   const client=(pins:typeof trust|null=trust)=>{activeStore=new RealmSaleJournalStore(realmSaleIdentity(wallet),factory);stores.push(activeStore);return new RealmSaleController(activeStore,createRealmSaleBrowserPorts({identity:realmSaleIdentity(wallet),trust:pins,wallet:()=>({publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false}),lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled})}));};
   let c=client();await c.begin(0,0);expect(c.snapshot().error).not.toBeNull();expect(posts).toHaveLength(1);expect(posts[0]!.journal.operation?.prepareAttempted).toBe(true);
   c=client();await c.open();expect(c.snapshot().error).toBeNull();await c.review();expect(c.snapshot().error).toBeNull();await c.sign();expect(c.snapshot().error).toBeNull();expect(signTransaction).toHaveBeenCalledOnce();const signed=(await activeStore.read()).operation?.signed;expect(signed).not.toBeNull();
   await c.submit();expect(c.snapshot().error).not.toBeNull();expect(posts).toHaveLength(2);expect(relays).toBe(1);expect(posts[1]!.journal.operation).toMatchObject({signingStarted:true,signed,submitAttempted:true});
   actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);c=client(null);await c.open();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation?.signed).toEqual(signed);
   await c.sign();await c.submit();await c.begin(0,0);expect(posts).toHaveLength(2);expect(relays).toBe(1);expect(signTransaction).toHaveBeenCalledOnce();
  }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
 });
});
