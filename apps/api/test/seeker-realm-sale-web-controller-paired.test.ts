/** Headless browser controller, real IndexedDB/signing and authenticated API.
 * Injected ports simulate lost transport replies; no UI, public RPC or broadcast. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,type Transaction} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import type {RealmSalePreparationView,RealmSalePrepareRequest} from '@shardkeep/shared/realmSalesApi';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
type Signed={wire:string;signature:string};type Guard=()=>void;type Retain=(raw:unknown)=>Promise<void>;
type Journal={operation:null|{request:RealmSalePrepareRequest;prepareAttempted:boolean;preparation:RealmSalePreparationView|null;signingStarted:boolean;signed:Signed|null;submitAttempted:boolean}};
type Store={read():Promise<Journal>;close():Promise<void>};
type Controller={begin(spot:number,realm:number):Promise<void>;open():Promise<void>;review():Promise<void>;sign():Promise<void>;submit():Promise<void>;snapshot():{error:string|null}};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const {RealmSaleController}=await vi.importActual<{RealmSaleController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/realmSales/controller');
const signing=await vi.importActual<{prepareRealmSaleSigning(p:unknown,trust:object):Promise<object>;signRealmSale(p:object,wallet:object):Promise<Signed>}>('../../web/src/lib/realmSales/signing');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
describe('paired realm purchase browser controller',()=>{
 it('recovers lost prepare/submit responses without a second wallet signature or POST',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58(),idempotencyKey=randomUUID();
  const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'controller-pair-r1'}},identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet},factory=new IDBFactory(),stores:Store[]=[];
  let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources}),activeStore!:Store,actionsEnabled=true,prepares=0,submits=0;
  try{
   await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};
   const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
   const signTransaction=vi.fn(async(tx:Transaction)=>{expect((await activeStore.read()).operation?.signingStarted).toBe(true);tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
   const ports={
    capture:(newAction:boolean)=>()=>{if(newAction&&!actionsEnabled)throw Error('Actions paused');},lock:async<T>(_name:string,run:()=>Promise<T>)=>run(),key:()=>idempotencyKey,clock:()=>0,
    prepare:async(request:RealmSalePrepareRequest,guard:Guard,_retain:Retain)=>{guard();prepares++;expect((await activeStore.read()).operation).toMatchObject({request,prepareAttempted:true});const r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies,payload:request});expect(r.statusCode).toBe(201);throw Error('lost prepare reply');},
    getPreparation:async(request:RealmSalePrepareRequest,guard:Guard,retain:Retain)=>{guard();const r=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}`,cookies});expect(r.statusCode).toBe(200);const raw=r.json();await retain(raw);guard();return raw;},
    getSaved:async(key:string,guard:Guard,retain:Retain)=>{guard();const r=await app.inject({url:`/seeker/realm-sales/by-key/${key}`,cookies});expect(r.statusCode).toBe(200);const raw=r.json();await retain(raw);guard();return raw;},
    getFailure:async(key:string,guard:Guard,retain:Retain)=>{guard();const r=await app.inject({url:`/seeker/realm-sales/failures/by-key/${key}`,cookies});expect(r.statusCode).toBe(200);const raw=r.json();await retain(raw);guard();return raw;},
    currentReview:async(p:RealmSalePreparationView,guard:Guard)=>{guard();const r=await app.inject({url:`/seeker/realm-sales/review/by-key/${p.idempotencyKey}`,cookies});expect(r.statusCode).toBe(200);guard();return r.json();},
    sign:async(p:RealmSalePreparationView,guard:Guard)=>{guard();return signing.signRealmSale(await signing.prepareRealmSaleSigning(p,trust),{publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false});},
    submit:async(request:{idempotencyKey:string;signedTransaction:string},guard:Guard,_retain:Retain)=>{guard();submits++;const j=await activeStore.read();expect(j.operation?.submitAttempted).toBe(true);expect(j.operation?.signed?.wire).toBe(request.signedTransaction);const r=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies,payload:request});expect(r.statusCode).toBe(202);throw Error('lost submit reply');},
   };
   const client=()=>{activeStore=new RealmSaleJournalStore(identity,factory);stores.push(activeStore);return new RealmSaleController(activeStore,ports);};
   let c=client();await c.begin(0,0);expect(c.snapshot().error).not.toBeNull();expect(prepares).toBe(1);expect((await activeStore.read()).operation?.preparation).toBeNull();
   c=client();await c.open();expect(c.snapshot().error).toBeNull();expect((await activeStore.read()).operation?.preparation).not.toBeNull();f.controls.now+=10n;f.controls.slot++;
   await c.review();expect(c.snapshot().error).toBeNull();await c.sign();expect(c.snapshot().error).toBeNull();expect(signTransaction).toHaveBeenCalledOnce();const original=(await activeStore.read()).operation?.signed;expect(original).not.toBeNull();
   await c.submit();expect(c.snapshot().error).not.toBeNull();expect(submits).toBe(1);expect((await activeStore.read()).operation?.submitAttempted).toBe(true);
   actionsEnabled=false;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);c=client();await c.open();expect((await activeStore.read()).operation?.signed).toEqual(original);
   await c.sign();await c.submit();await c.begin(0,0);expect(signTransaction).toHaveBeenCalledOnce();expect(prepares).toBe(1);expect(submits).toBe(1);
  }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
 });
});
