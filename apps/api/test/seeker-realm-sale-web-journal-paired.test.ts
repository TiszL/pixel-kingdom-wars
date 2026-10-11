/** Actual IndexedDB, browser signing and authenticated API pairing. Explicit
 * steps prove storage ordering; the controller/UI are a separate acceptance. */
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,type Transaction} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {RealmSalePreparationEnvelopeSchema,type RealmSalePreparationView,type RealmSalePrepareRequest} from '@shardkeep/shared/realmSalesApi';
import {validateRealmSaleReview} from '@shardkeep/shared/realmSaleReviewApi';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
type Signed={wire:string;signature:string};
type Operation={request:RealmSalePrepareRequest;prepareAttempted:boolean;preparation:RealmSalePreparationView|null;signingStarted:boolean;signed:Signed|null;submitAttempted:boolean};
type Journal={version:1;identity:object;revision:number;operation:Operation|null};
type Store={read():Promise<Journal>;compareAndSet(revision:number,update:(j:Journal)=>Journal):Promise<Journal>;close():Promise<void>};
const {RealmSaleJournalStore}=await vi.importActual<{RealmSaleJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/realmSales/journal');
const signing=await vi.importActual<{prepareRealmSaleSigning(p:unknown,trust:object):Promise<object>;signRealmSale(p:object,wallet:object):Promise<Signed>}>('../../web/src/lib/realmSales/signing');
const {IDBFactory}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown};
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
describe('paired durable realm purchase',()=>{
 it('recovers lost replies and saves each external attempt before the next step',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58(),request={idempotencyKey:randomUUID(),spot:0,realm:0};
  const sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'journal-pair-r1'}},identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet',wallet},factory=new IDBFactory(),stores:Store[]=[];
  let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources}),store=new RealmSaleJournalStore(identity,factory);stores.push(store);
  const update=async(patch:Partial<Operation>)=>{const current=await store.read();return store.compareAndSet(current.revision,j=>({...j,operation:{...j.operation!,...patch}}));};
  try{
   await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};
   await store.compareAndSet(0,j=>({...j,operation:{request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));await update({prepareAttempted:true});
   const prepared=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies,payload:request});expect(prepared.statusCode).toBe(201); // Simulate losing this reply before client retention.
   store=new RealmSaleJournalStore(identity,factory);stores.push(store);expect((await store.read()).operation?.prepareAttempted).toBe(true);expect((await store.read()).operation?.preparation).toBeNull();
   const recovered=await app.inject({url:`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}`,cookies}),p=RealmSalePreparationEnvelopeSchema.parse(recovered.json()).preparation!;await update({preparation:p});
   f.controls.now+=10n;f.controls.slot++;const reviewed=await app.inject({url:`/seeker/realm-sales/review/by-key/${request.idempotencyKey}`,cookies});expect(reviewed.statusCode).toBe(200);const review=validateRealmSaleReview(p,reviewed.json());expect(review.unixTimestamp).toBe(f.controls.now.toString());expect(p.quote.unixTimestamp).not.toBe(review.unixTimestamp);expect(review.validUntil).toBe(p.terms.validUntil);
   const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
   const approval=await signing.prepareRealmSaleSigning(p,trust);await update({signingStarted:true});
   const signTransaction=vi.fn(async(tx:Transaction)=>{expect((await store.read()).operation?.signingStarted).toBe(true);tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
   const signed=await signing.signRealmSale(approval,{publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false});await update({signed});await update({submitAttempted:true});
   expect((await store.read()).operation?.signed).toEqual(signed);const submitted=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies,payload:{idempotencyKey:request.idempotencyKey,signedTransaction:signed.wire}});expect(submitted.statusCode).toBe(202); // Lost response remains uncertain.
   vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);store=new RealmSaleJournalStore(identity,factory);stores.push(store);
   const local=await store.read();expect(local.operation).toMatchObject({prepareAttempted:true,signingStarted:true,signed,submitAttempted:true});const history=await app.inject({url:`/seeker/realm-sales/by-key/${request.idempotencyKey}`,cookies});expect(history.statusCode).toBe(200);expect(history.json().wire.signedTransactionHex).toBe(Buffer.from(signed.wire,'base64').toString('hex'));expect(history.json().settlement).toBeNull();
   await expect(store.compareAndSet(local.revision,j=>({...j,operation:null}))).rejects.toThrow();expect(signTransaction).toHaveBeenCalledOnce();
  }finally{await Promise.all(stores.map(s=>s.close()));await app.close();}
 });
});
