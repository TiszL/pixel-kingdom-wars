/** Exact owner evidence suppresses review/relay without discarding signatures. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction,type VersionedTransactionResponse} from '@solana/web3.js';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {createSeekerRealmSaleFailureVerifier} from '@shardkeep/chain/seeker-realm-sale-failure';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {TEST_CONFIG} from './helpers';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createRealmSalePreparer} from '../src/seeker/realmSalePreparation';
import {realmSalePreparationArgs} from '../src/seeker/realmSalePreparationStore';
import {acceptRealmSaleSigned,getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import {createRealmSaleReconciler,type RealmSaleTransport} from '../src/seeker/realmSaleReconcile';
import * as failures from '../src/seeker/realmSaleFailure';
import * as settlements from '../src/seeker/realmSaleSettlement';
const conn=resourceClaimsDatabase();beforeAll(()=>conn.setup());afterAll(()=>conn.close());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const f=await realmSaleQuoteFixture(),admission={connect:vi.fn(()=>f.rpc),policy:{term:f.termPolicy,access:f.accessTrust,revision:'failure-admission-r1'}},key={wallet:f.buyer.toBase58(),idempotencyKey:randomUUID()};
 const p=await createRealmSalePreparer(conn.db,admission).prepare(key.wallet,{idempotencyKey:key.idempotencyKey,spot:0,realm:0}),message=Message.from(Buffer.from(p.quote.messageHex,'hex')),signed=new VersionedTransaction(message);signed.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);const bytes=signed.serialize(),wire=await acceptRealmSaleSigned(conn.db,{...key,signedTransaction:bytes});
 const fee=Number(p.quote.feeLamports),preBalances=message.accountKeys.map(()=>100_000_000),tx:VersionedTransactionResponse={slot:f.controls.slot+1,blockTime:Number(f.controls.now),version:'legacy',transaction:{message,signatures:[wire.signature]},meta:{err:{InstructionError:[message.instructions.length-1,{Custom:9}]},fee,preBalances,postBalances:preBalances.map((n,i)=>n-(i===0?fee:0)),preTokenBalances:[],postTokenBalances:[]}};
 f.controls.slot+=2;await f.repack();const proof=await createSeekerRealmSaleFailureVerifier(()=>({...f.rpc,getTransaction:async()=>tx}),f.accessTrust)({wallet:f.buyer,args:realmSalePreparationArgs(p),blockhash:p.quote.blockhash,needsAccess:p.quote.needsAccess,needsQuota:p.quote.needsQuota,preparedMessageBytes:Buffer.from(p.quote.messageHex,'hex'),signedTransaction:bytes,minContextSlot:p.source.admissionSlot});
 const persist=()=>conn.sql`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${key.wallet},${key.idempotencyKey},${JSON.stringify(proof)}::jsonb)`;
 const sends:Uint8Array[]=[],rpc:RealmSaleTransport={getGenesisHash:async()=>f.controls.genesisHash,getSignatureStatuses:async()=>({context:{slot:f.controls.slot},value:[null]}),getBlockHeight:async()=>f.controls.blockHeight,sendRawTransaction:async b=>{sends.push(Uint8Array.from(b));return wire.signature;}},transport=vi.fn(()=>rpc);admission.connect.mockClear();
 return {f,admission,key,p,wire,bytes,proof,persist,rpc,sends,transport,sources:{admission,transport}};
}
describe('saved realm failure action suppression',()=>{
 it('recovers verified failure before pause, provider construction or any new relay',async()=>{
  const x=await fixture();await x.persist();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({...x.key,status:'held',reason:'FINALIZED_FAILURE',signature:x.wire.signature});expect(x.transport).not.toHaveBeenCalled();expect(x.admission.connect).not.toHaveBeenCalled();expect(x.sends).toHaveLength(0);
 });
 it('checks saved failure again after current admission finishes',async()=>{
  const x=await fixture(),genesis=x.f.rpc.getGenesisHash;let inserted=false;x.f.rpc.getGenesisHash=async()=>{if(!inserted){inserted=true;await x.persist();}return genesis();};
  expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({status:'held',reason:'FINALIZED_FAILURE'});expect(x.sends).toHaveLength(0);expect((await getRealmSaleSigned(conn.db,x.key))?.wire).toEqual(x.wire);
 });
 it('catches failure committed during the last awaited transport identity read',async()=>{
  const x=await fixture();let calls=0;const genesis=x.rpc.getGenesisHash;x.rpc.getGenesisHash=async()=>{if(++calls===3)await x.persist();return genesis();};
  expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({status:'held',reason:'FINALIZED_FAILURE'});expect(calls).toBe(3);expect(x.sends).toHaveLength(0);
 });
 it('observes failure last when its owner proof commits during the final settlement read',async()=>{
  const x=await fixture(),read=settlements.getRealmSaleSettlement;let reads=0;vi.spyOn(settlements,'getRealmSaleSettlement').mockImplementation(async(...args)=>{const prior=await read(...args);if(++reads===3)await x.persist();return prior;});
  expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({status:'held',reason:'FINALIZED_FAILURE'});expect(reads).toBe(3);expect(x.sends).toHaveLength(0);
 });
 it.each(['initial','final'])('holds a %s failure lookup outage without sending',async boundary=>{
  const x=await fixture();if(boundary==='initial')vi.spyOn(failures,'getRealmSaleFailure').mockRejectedValueOnce(Error('source unavailable'));else{let calls=0;const genesis=x.rpc.getGenesisHash;x.rpc.getGenesisHash=async()=>{if(++calls===3)vi.spyOn(failures,'getRealmSaleFailure').mockRejectedValueOnce(Error('source unavailable'));return genesis();};}
  expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(x.sends).toHaveLength(0);
 });
 it('keeps unchanged original-wire relay possible when no failure was saved',async()=>{
  const x=await fixture();expect(await createRealmSaleReconciler(conn.db,x.sources)(x.key)).toMatchObject({status:'submitted',purchaseFinalized:false});expect(x.sends).toEqual([x.bytes]);
 });
 it.each(['before','during'])('holds signing review when failure arrives %s current admission',async boundary=>{
  const x=await fixture();if(boundary==='before')await x.persist();else{let inserted=false;const genesis=x.f.rpc.getGenesisHash;x.f.rpc.getGenesisHash=async()=>{if(!inserted){inserted=true;await x.persist();}return genesis();};}
  vi.stubEnv('MULTI_BASE_ENABLED','false');const app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:x.admission});
  try{await conn.db.insert(players).values({wallet:x.key.wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet:x.key.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,x.key.wallet,s!.id)},response=await app.inject({url:`/seeker/realm-sales/review/by-key/${x.key.idempotencyKey}`,cookies});
   expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({error:{code:'REALM_SALE_REVIEW_HELD'}});if(boundary==='before')expect(x.admission.connect).not.toHaveBeenCalled();expect((await getRealmSaleSigned(conn.db,x.key))?.wire).toEqual(x.wire);
  }finally{await app.close();}
 });
});
