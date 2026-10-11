/** Browser reconstruction signs the actual API packet; the API retains those
 * exact bytes. This is a headless pairing, not mounted UI or client persistence. */
import {randomUUID} from 'node:crypto';
import {Keypair,type Transaction} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {RealmSalePreparationEnvelopeSchema,RealmSaleSignedWireSchema} from '@shardkeep/shared/realmSalesApi';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
const signing=await vi.importActual<{
 prepareRealmSaleSigning(preparation:unknown,trust:object):Promise<object>;
 signRealmSale(prepared:object,wallet:object):Promise<{wire:string;signature:string}>;
 verifySignedRealmSale(preparation:unknown,wire:unknown):Promise<{wire:string;signature:string}>;
}>('../../web/src/lib/realmSales/signing');
describe('paired realm purchase browser signing',()=>{
 it('signs the API consent once, retains it through HTTP and verifies paused provider-free recovery',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');
  const f=await realmSaleQuoteFixture(),wallet=f.buyer.toBase58(),idempotencyKey=randomUUID(),sources={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'browser-pair-r1'}};
  let app=await buildApp(TEST_CONFIG,conn.db,{realmSalePreparationSources:sources});
  try{
   await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();
   const cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
   const response=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies,payload:{idempotencyKey,spot:0,realm:0}});expect(response.statusCode).toBe(201);
   const envelope=RealmSalePreparationEnvelopeSchema.parse(response.json()),p=envelope.preparation!;
   expect(p.currentSigningAuthorized).toBe(false);expect(p.quote.requiredLamports).toBe((BigInt(p.quote.paymentDebitLamports)+BigInt(p.quote.feeLamports)+BigInt(p.quote.rentLamports)).toString());
   const trust={genesisHash:f.accessTrust.expectedGenesisHash,programId:f.accessTrust.programId.toBase58(),developer:f.accessTrust.developer.toBase58(),reviewedProgramDataSha256:f.accessTrust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.accessTrust.reviewedDeploymentSlot,revision:sources.policy.revision};
   const prepared=await signing.prepareRealmSaleSigning(p,trust),signTransaction=vi.fn(async(tx:Transaction)=>{tx.partialSign(Keypair.fromSeed(Buffer.alloc(32,1)));return tx;});
   const signed=await signing.signRealmSale(prepared,{publicKey:f.buyer,signTransaction,sendTransaction:null,signMessage:null,isEmbedded:false});expect(signTransaction).toHaveBeenCalledOnce();
   const submitted=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies,payload:{idempotencyKey,signedTransaction:signed.wire}});expect(submitted.statusCode).toBe(202);expect(submitted.json().delivery).toBe('held');
   const retained=RealmSaleSignedWireSchema.parse(submitted.json().wire);expect(retained.signature).toBe(signed.signature);expect(retained.signedTransactionHex).toBe(Buffer.from(signed.wire,'base64').toString('hex'));expect(retained.relayAuthorized).toBe(false);
   vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);
   const recovered=await app.inject({url:`/seeker/realm-sales/by-key/${idempotencyKey}`,cookies});expect(recovered.statusCode).toBe(200);expect(recovered.headers['cache-control']).toBe('private, no-store');
   const body=recovered.json();expect(body.preparation).toEqual(p);expect(body.wire).toEqual(retained);expect(await signing.verifySignedRealmSale(body.preparation,Buffer.from(body.wire.signedTransactionHex,'hex').toString('base64'))).toEqual(signed);
   expect(signTransaction).toHaveBeenCalledOnce();expect(body.settlement).toBeNull();
  }finally{await app.close();}
 });
});
