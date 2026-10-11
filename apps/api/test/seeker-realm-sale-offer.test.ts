/** Actual encoded finalized fixtures, never a public RPC or synthetic quote. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SystemProgram} from '@solana/web3.js';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {RealmSaleOfferSchema,RealmSaleCoverageSchema} from '@shardkeep/shared/realmSaleOfferApi';
import {createRealmSaleOfferReader} from '../src/seeker/realmSaleOffer';
const sources=(f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>)=>({connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'offer-r1'}});
afterEach(()=>vi.unstubAllEnvs());
describe('selected realm sale offer and current coverage',()=>{
 it('projects measured costs and current quota without creating signing material',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const f=await realmSaleQuoteFixture(),read=createRealmSaleOfferReader(sources(f));
  const result=await read.offer(f.buyer.toBase58(),{spot:0,realm:0});expect(RealmSaleOfferSchema.parse(result)).toEqual(result);
  expect(result).toMatchObject({wallet:f.buyer.toBase58(),status:'available',authorization:'none',offer:{seller:f.seller.toBase58(),priceLamports:String(PHASE_E_POLICY.seekerIsland.permitPriceLamports),durationSec:PHASE_E_POLICY.seekerIsland.permitDurationSec,quotaRemaining:PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax,feeLamports:String(f.controls.fee),payerLamports:String(f.controls.balance)}});
  for(const key of ['saleId','idempotencyKey','messageHex','blockhash','signature','preparation'])expect(JSON.stringify(result)).not.toContain(`"${key}"`);
  if(result.status!=='available')throw Error('missing quote');
  expect(RealmSaleOfferSchema.safeParse({...result,offer:{...result.offer,requiredLamports:'1'}}).success).toBe(false);
  expect(RealmSaleOfferSchema.safeParse({...result,offer:{...result.offer,priceLamports:'1'}}).success).toBe(false);
 });
 it('never calls providers when paused or missing, and rechecks pause after quote awaits',async()=>{
  const f=await realmSaleQuoteFixture(),read=createRealmSaleOfferReader(sources(f)),wallet=f.buyer.toBase58();vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  expect(await read.offer(wallet,{spot:0,realm:0})).toMatchObject({status:'blocked',reason:'PAUSED',offer:null});expect(f.reads).toHaveLength(0);
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');expect(await createRealmSaleOfferReader(null).offer(wallet,{spot:0,realm:0})).toMatchObject({status:'unavailable',offer:null});
  expect(await createRealmSaleOfferReader(null).coverage(wallet,{realm:0})).toMatchObject({status:'unavailable',coverage:null});
  f.controls.onFee=async()=>{vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');};expect(await read.offer(wallet,{spot:0,realm:0})).toMatchObject({status:'blocked',reason:'PAUSED',offer:null});
 });
 it('returns only safe blocked reasons; malformed chain identity is unavailable',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const f=await realmSaleQuoteFixture(),read=createRealmSaleOfferReader(sources(f)),wallet=f.buyer.toBase58();
  expect(await read.offer(wallet,{spot:2,realm:0})).toMatchObject({status:'blocked',reason:'UNSOLD',offer:null});
  f.controls.balance=1;expect(await read.offer(wallet,{spot:0,realm:0})).toMatchObject({status:'blocked',reason:'INSUFFICIENT_SOL',offer:null});
  f.controls.genesisHash=f.seller.toBase58();expect(await read.offer(wallet,{spot:0,realm:0})).toMatchObject({status:'unavailable',reason:'SOURCE_UNAVAILABLE',offer:null});
 });
 it('copies reviewed trust and preserves seller-payer aliases in the observed debit',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const f=await realmSaleQuoteFixture(),source=sources(f),read=createRealmSaleOfferReader(source);
  source.policy.revision='caller-mutated';source.policy.access={...source.policy.access,expectedGenesisHash:f.seller.toBase58()};
  f.store.get(f.seller.toBase58())!.lamports=f.controls.balance;
  const result=await read.offer(f.seller.toBase58(),{spot:0,realm:0});expect(result.status).toBe('available');if(result.status!=='available')throw Error('missing alias quote');
  expect(result.offer.source.revision).toBe('offer-r1');expect(result.offer.paymentDebitLamports).toBe(result.offer.developerLamports);expect(RealmSaleOfferSchema.safeParse(result).success).toBe(true);
  f.models.quota.sales=PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax;await f.repack();expect(await read.offer(f.buyer.toBase58(),{spot:0,realm:0})).toMatchObject({status:'blocked',reason:'NO_QUOTA',offer:null});
 });
 it('reads exact current coverage while paused, including expiry boundary and canonical absence',async()=>{
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const f=await realmSaleQuoteFixture(),read=createRealmSaleOfferReader(sources(f)),wallet=f.buyer.toBase58();
  f.models.access.expires_at=f.controls.now+1n;await f.repack();const active=await read.coverage(wallet,{realm:0});expect(RealmSaleCoverageSchema.parse(active)).toEqual(active);expect(active).toMatchObject({status:'observed',coverage:{accountState:'initialized',active:true,expiresAt:String(f.controls.now+1n)}});
  if(active.status!=='observed')throw Error('missing coverage');expect(RealmSaleCoverageSchema.safeParse({...active,coverage:{...active.coverage,active:false}}).success).toBe(false);
  f.controls.now++;expect(await read.coverage(wallet,{realm:0})).toMatchObject({coverage:{active:false}});
  f.store.delete(f.addresses.access.toBase58());expect(await read.coverage(wallet,{realm:0})).toMatchObject({coverage:{address:f.addresses.access.toBase58(),accountState:'absent',active:false,expiresAt:null}});
  f.store.set(f.addresses.access.toBase58(),{owner:SystemProgram.programId,data:Buffer.alloc(0),executable:false,lamports:1});expect(await read.coverage(wallet,{realm:0})).toMatchObject({coverage:{accountState:'uninitialized',expiresAt:null}});
  f.store.get(f.addresses.access.toBase58())!.data=Buffer.alloc(1);expect(await read.coverage(wallet,{realm:0})).toMatchObject({status:'unavailable',coverage:null});
 });
 it('refuses forged selection or actor before RPC and isolates another wallet',async()=>{
  const f=await realmSaleQuoteFixture(),read=createRealmSaleOfferReader(sources(f)),wallet=f.buyer.toBase58();
  for(const input of [{spot:100,realm:0},{spot:0,realm:0,wallet},{spot:0,realm:0,[Symbol('x')]:true}])await expect(read.offer(wallet,input)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(read.coverage(SystemProgram.programId.toBase58(),{realm:0})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.reads).toHaveLength(0);
  const other=await read.coverage(f.seller.toBase58(),{realm:0});expect(other).toMatchObject({wallet:f.seller.toBase58(),coverage:{accountState:'absent',active:false}});expect(JSON.stringify(other)).not.toContain(wallet);
 });
 it('keeps bounded capacity occupied until abort-ignoring RPC actually settles',async()=>{
  const f=await realmSaleQuoteFixture(),releases:Array<()=>void>=[],original=f.rpc.getGenesisHash.bind(f.rpc);let started=0,entered!:()=>void;
  const allStarted=new Promise<void>(resolve=>{entered=resolve;});f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.controls.genesisHash));if(++started===32)entered();});
  const read=createRealmSaleOfferReader({...sources(f),timeoutMs:50}),wallet=f.buyer.toBase58();const requests=Array.from({length:32},()=>read.coverage(wallet,{realm:0}));await allStarted;
  expect((await Promise.all(requests)).every(r=>r.status==='unavailable')).toBe(true);await new Promise(resolve=>setTimeout(resolve,25));
  expect(await read.coverage(wallet,{realm:0})).toMatchObject({status:'unavailable'});expect(started).toBe(32);
  releases.forEach(release=>release());f.rpc.getGenesisHash=original;await new Promise(resolve=>setTimeout(resolve,10));expect(await read.coverage(wallet,{realm:0})).toMatchObject({status:'observed'});
 });
});
