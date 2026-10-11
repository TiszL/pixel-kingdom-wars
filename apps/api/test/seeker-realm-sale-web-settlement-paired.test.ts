/** Browser consistency checks consume authenticated owner-attested success.
 * The server fixture verifies finality; the DTO parser is not an RPC verifier. */
import {Keypair} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {validateRealmSaleSettlement} from '../../../packages/shared/src/realmSaleSettlementApi';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb();afterAll(()=>conn.sql.end());afterEach(()=>vi.unstubAllEnvs());
const {verifySignedRealmSale}=await vi.importActual<{verifySignedRealmSale(preparation:unknown,wire:unknown):Promise<{wire:string;signature:string}>}>('../../web/src/lib/realmSales/signing');
async function cookies(wallet:string){await conn.db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
describe('paired browser owner-attested realm settlement contract',()=>{
 it('binds actual verified API success to the saved consent/wire through paused provider-free recovery',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');vi.stubEnv('MULTI_BASE_ENABLED','false');
  const f=await retainRealmSaleSettlementFixture(conn.db),session=await cookies(f.key.wallet),url=`/seeker/realm-sales/by-key/${f.key.idempotencyKey}`;
  let app=await buildApp(TEST_CONFIG,conn.db);
  try{
   const pending=(await app.inject({url,cookies:session})).json();expect(pending.settlement).toBeNull();expect(()=>validateRealmSaleSettlement(pending.preparation,pending.wire,pending.settlement)).toThrow();
   const connect=vi.fn(()=>f.chain.rpc),settled=await createRealmSaleSettlement(conn.db,{connect,trust:f.chain.trust})(f.key);expect(connect).toHaveBeenCalledOnce();
   f.chain.rpc.getGenesisHash=async()=>{throw Error('offline');};vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');await app.close();app=await buildApp(TEST_CONFIG,conn.db);
   const response=await app.inject({url,cookies:session});expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');const body=response.json();
   // Signature verification remains separate from the bounded consistency DTO.
   const wire=await verifySignedRealmSale(body.preparation,Buffer.from(body.wire.signedTransactionHex,'hex').toString('base64'));expect(wire.signature).toBe(settled.signature);
   const checked=validateRealmSaleSettlement(body.preparation,body.wire,body.settlement);expect(checked).toEqual(settled);expect(checked).toMatchObject({purchaseFinalized:true,admissionAuthorized:false,relayAuthorized:false,signingAuthorized:false});
   for(const changed of [{...body.settlement,signature:Keypair.generate().publicKey.toBase58()},{...body.settlement,purchase:{...body.settlement.purchase,expiresAt:String(BigInt(body.settlement.purchase.expiresAt)+1n)}},{...body.settlement,receipt:{...body.settlement.receipt,signedTransactionSha256:'00'.repeat(32)}}])expect(()=>validateRealmSaleSettlement(body.preparation,body.wire,changed)).toThrow();
   body.settlement.purchase.expiresAt='0';expect(checked.purchase.expiresAt).toBe(settled.purchase.expiresAt);
   const foreign=(await app.inject({url,cookies:await cookies(Keypair.generate().publicKey.toBase58())})).json();expect(foreign).toMatchObject({preparation:null,wire:null,settlement:null});expect(()=>validateRealmSaleSettlement(foreign.preparation,foreign.wire,foreign.settlement)).toThrow();expect(connect).toHaveBeenCalledOnce();
  }finally{await app.close();}
 });
});
