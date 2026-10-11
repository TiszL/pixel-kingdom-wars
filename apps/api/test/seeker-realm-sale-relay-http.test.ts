/** Mounted runtime relay: original consent only, no HTTP-owned finality writer. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import type {FastifyInstance} from 'fastify';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {buildApp} from '../src/app';
import {players,sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {connectTestDb,TEST_CONFIG} from './helpers';
import {getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import * as reconciliation from '../src/seeker/realmSaleReconcile';
import * as settlement from '../src/seeker/realmSaleSettlement';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
const conn=connectTestDb(),db=conn.db;let app:FastifyInstance,f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>;
const sent:Buffer[]=[];
const transport={getGenesisHash:vi.fn(async()=>f.controls.genesisHash),getSignatureStatuses:vi.fn(async()=>({context:{slot:f.controls.slot},value:[null]})),getBlockHeight:vi.fn(async()=>f.controls.blockHeight),sendRawTransaction:vi.fn(async(bytes:Uint8Array,options:{skipPreflight:false;preflightCommitment:'finalized';maxRetries:0;minContextSlot:number})=>{
 expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:f.controls.slot});sent.push(Buffer.from(bytes));return bs58.encode(bytes.subarray(1,65));
})};
const transportFactory=vi.fn(()=>transport);
async function start(relay=true,provider=true){const old=process.env.MULTI_BASE_ENABLED;process.env.MULTI_BASE_ENABLED='false';const source={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'relay-http-r1'}};try{app=await buildApp(TEST_CONFIG,db,{realmSalePreparationSources:provider?source:null,realmSaleRelaySources:relay?{admission:source,transport:transportFactory}:null});await app.ready();}finally{if(old===undefined)delete process.env.MULTI_BASE_ENABLED;else process.env.MULTI_BASE_ENABLED=old;}}
async function cookies(wallet:string){await db.insert(players).values({wallet}).onConflictDoNothing();const [s]=await db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,s!.id)};}
beforeAll(async()=>{f=await realmSaleQuoteFixture();await start();});afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await app.close();await conn.sql.end();});
async function prepared(){vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const idempotencyKey=randomUUID(),session=await cookies(f.buyer.toBase58());const r=await app.inject({method:'POST',url:'/seeker/realm-sales/prepare',cookies:session,payload:{idempotencyKey,spot:0,realm:0}});expect(r.statusCode).toBe(201);const a=r.json().preparation,tx=new VersionedTransaction(Message.from(Buffer.from(a.quote.messageHex,'hex')));tx.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);const wire=Buffer.from(tx.serialize());return {idempotencyKey,session,wire,payload:{idempotencyKey,signedTransaction:wire.toString('base64')}};}
const post=(p:Awaited<ReturnType<typeof prepared>>)=>app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:p.session,payload:p.payload});
describe('realm sale original-wire relay HTTP',()=>{
 it('retains exact consent before a fresh verified relay, without acquiring an owner settlement writer',async()=>{
  const p=await prepared(),writer=vi.spyOn(settlement,'createRealmSaleSettlement').mockImplementation(()=>{throw Error('HTTP cannot acquire owner writer');});
  const baseSend=transport.sendRawTransaction.getMockImplementation()!;transport.sendRawTransaction.mockImplementationOnce(async(bytes,options)=>{const retained=await getRealmSaleSigned(db,{wallet:f.buyer.toBase58(),idempotencyKey:p.idempotencyKey});expect(retained?.wire?.signedTransactionHex).toBe(p.wire.toString('hex'));return baseSend(bytes,options);});
  try{const before=sent.length,r=await post(p);expect(r.statusCode).toBe(202);const body=r.json();expect(body).toMatchObject({wallet:f.buyer.toBase58(),idempotencyKey:p.idempotencyKey,delivery:'submitted',settlement:null,wire:{signedTransactionHex:p.wire.toString('hex')},reconciliation:{status:'submitted',signature:bs58.encode(p.wire.subarray(1,65)),purchaseFinalized:false}});expect(sent.slice(before)).toEqual([p.wire]);expect(writer).not.toHaveBeenCalled();
   expect(await conn.sql`select * from seeker_realm_sale_receipts where wallet=${f.buyer.toBase58()} and idempotency_key=${p.idempotencyKey}`).toHaveLength(0);
  }finally{writer.mockRestore();}
 });
 it('keeps paused and offline signatures recoverable, while GET, foreign actors and queries never relay',async()=>{
  const p=await prepared(),before=sent.length;vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const held=await post(p);expect(held.statusCode).toBe(202);expect(held.json()).toMatchObject({delivery:'held',settlement:null,reconciliation:{status:'held'},wire:{signedTransactionHex:p.wire.toString('hex')}});expect(sent.length).toBe(before);
  const calls=transportFactory.mock.calls.length;const history=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}`,cookies:p.session});expect(history.statusCode).toBe(200);expect(history.json().wire.signedTransactionHex).toBe(p.wire.toString('hex'));expect(history.headers['cache-control']).toBe('private, no-store');
  expect((await app.inject({method:'POST',url:'/seeker/realm-sales/submit',payload:p.payload})).statusCode).toBe(401);
  expect((await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}?relay=true`,cookies:p.session})).statusCode).toBe(400);
  expect((await app.inject({method:'POST',url:'/seeker/realm-sales/submit?relay=true',cookies:p.session,payload:p.payload})).statusCode).toBe(400);
  const other=await cookies(f.seller.toBase58()),foreign=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}`,cookies:other});expect(foreign.json()).toMatchObject({preparation:null,wire:null,settlement:null});expect(foreign.body).not.toContain(p.wire.toString('hex'));
  expect((await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:other,payload:p.payload})).statusCode).toBe(404);expect(transportFactory.mock.calls.length).toBe(calls);
  await app.close();await start(false,false);const offline=await post(p);expect(offline.statusCode).toBe(202);expect(offline.json()).toMatchObject({delivery:'held',reason:'DELIVERY_UNAVAILABLE',wire:{signedTransactionHex:p.wire.toString('hex')}});expect(sent.length).toBe(before);await app.close();await start();
 });
 it('constructs one relay factory and preserves the original signed wire when that step unexpectedly throws',async()=>{
  const p=await prepared(),before=sent.length;await app.close();const broken=vi.fn(async()=>{throw Error('unexpected source loss');}),factory=vi.spyOn(reconciliation,'createRealmSaleReconciler').mockReturnValue(broken);
  try{await start();for(let n=0;n<2;n++){const r=await post(p);expect(r.statusCode).toBe(202);expect(r.json()).toMatchObject({delivery:'held',reason:'SOURCE_UNAVAILABLE',settlement:null,wire:{signedTransactionHex:p.wire.toString('hex')},reconciliation:{status:'held',reason:'SOURCE_UNAVAILABLE'}});}expect(factory).toHaveBeenCalledOnce();expect(broken).toHaveBeenCalledTimes(2);expect(sent.length).toBe(before);
   const read=await app.inject({url:`/seeker/realm-sales/by-key/${p.idempotencyKey}`,cookies:p.session});expect(read.json().wire.signedTransactionHex).toBe(p.wire.toString('hex'));expect(broken).toHaveBeenCalledTimes(2);
  }finally{factory.mockRestore();await app.close();await start();}
 });
 it('returns a retained owner-verified success before relay, despite pause or unavailable current sources',async()=>{
  const retained=await retainRealmSaleSettlementFixture(db),saved=await settlement.createRealmSaleSettlement(db,{connect:()=>retained.chain.rpc,trust:retained.chain.trust})(retained.key),session=await cookies(retained.key.wallet),before=transportFactory.mock.calls.length;
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const writer=vi.spyOn(settlement,'createRealmSaleSettlement').mockImplementation(()=>{throw Error('HTTP cannot acquire owner writer');});
  try{const r=await app.inject({method:'POST',url:'/seeker/realm-sales/submit',cookies:session,payload:{idempotencyKey:retained.key.idempotencyKey,signedTransaction:Buffer.from(retained.chain.expected.signedTransaction).toString('base64')}});expect(r.statusCode).toBe(200);expect(r.json()).toMatchObject({delivery:'settled',settlement:saved,reconciliation:{status:'settled',settlement:saved}});expect(transportFactory.mock.calls.length).toBe(before);expect(writer).not.toHaveBeenCalled();}finally{writer.mockRestore();}
 });
});
