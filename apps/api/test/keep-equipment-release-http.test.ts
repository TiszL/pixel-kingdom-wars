/** Actual authenticated API composition for original-buyer terminal recovery.
 * Private RPC adapters expose raw execution, never a caller-supplied proof. */
import {createKeepEquipmentMarketProvider} from '../src/game/keepEquipmentMarketProvider';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import {KeepEquipmentPurchaseSchema,KeepEquipmentSendSchema,KeepEquipmentReviewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import type {KeepEquipmentPaymentFailureRpc} from '@shardkeep/chain/keep-equipment-payment-failure';
import {buildApp} from '../src/app';
import {sessions} from '../src/db/schema';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createKeepEquipmentPayments} from '../src/game/keepEquipmentPayments';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {paymentFixture,paymentStock,transferPaymentBase} from './fixtures/keepEquipmentPayments';
import {connectTestDb,TEST_CONFIG} from './helpers';
const conn=connectTestDb(),apps:FastifyInstance[]=[];
beforeEach(()=>{vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');});
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.unstubAllEnvs();});afterAll(()=>conn.sql.end());
async function cookie(wallet:string){const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};}
async function fixture(){
 const f=await paymentFixture(conn),controls={missing:false,sends:0};
 const failureConnect=f.deps.finalityConnect.map(connect=>(signal:AbortSignal):KeepEquipmentPaymentFailureRpc=>{const rpc=connect(signal);return {...rpc,getTransaction:async(signature,options)=>{
  if(controls.missing)return null;const tx=await rpc.getTransaction(signature,options);if(!tx)return null;
  tx.meta!.err={InstructionError:[0,'InvalidArgument']};tx.meta!.postBalances=tx.meta!.preBalances.map((n,i)=>n-(i===0?tx.meta!.fee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];return tx;
 }};}) as [(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 const releaseDeps={failureConnect,trust:f.trust},buyerCookies=await cookie(f.buyer.wallet),sellerCookies=await cookie(f.seller.wallet);
 const open=async(providers=true)=>{
  // Boots stay dark; prior focused cases intentionally leave transferred or
  // stale deeds. Enabling unrelated global observer coverage is not this test.
  const previous=process.env.MULTI_BASE_ENABLED??'false';vi.stubEnv('MULTI_BASE_ENABLED','false');
  const app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},conn.db,{keepEquipmentMarket:createKeepEquipmentMarketProvider(conn.db,{...(providers?{releases:releaseDeps,payments:{...f.deps,broadcastConnect:()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,sendRawTransaction:async()=>{controls.sends++;return (await f.payments.read(f.buyer.wallet,f.fill.id)).wire!.signature;}})}}:{})})});await app.ready();vi.stubEnv('MULTI_BASE_ENABLED',previous);apps.push(app);return app;
 };
 const post=(app:FastifyInstance,action:string,body:unknown={},cookies:Record<string,string>=buyerCookies,query='')=>app.inject({method:'POST',url:'/keep-equipment-market/fills/'+f.fill.id+'/'+action+query,cookies,headers:{'content-type':'application/json'},payload:JSON.stringify(body)});
 return {...f,paymentControls:f.controls,controls,releaseDeps,buyerCookies,sellerCookies,open,post};
}
it('authenticates recovery, refuses foreign actors and proof input, and returns private terminal receipts',async()=>{
 const f=await fixture(),app=await f.open();
 expect((await f.post(app,'release',{},{})).statusCode).toBe(401);expect((await f.post(app,'release',{},f.sellerCookies)).statusCode).toBe(404);
 for(const input of [{proof:{}},{reason:'never_prepared'},{signature:'invented'},{wallet:f.buyer.wallet}])expect((await f.post(app,'release',input)).statusCode).toBe(400);
 expect((await f.post(app,'release',{},f.buyerCookies,'?proof=1')).statusCode).toBe(400);
 const reply=await f.post(app,'release');expect(reply.statusCode,reply.body).toBe(200);expect(reply.headers['cache-control']).toBe('private, no-store');
 const done=KeepEquipmentPurchaseSchema.parse(reply.json());expect(done).toMatchObject({status:'released',release:{reason:'never_prepared',signature:null,proof:null},preparation:null,wire:null,delivery:null});
 expect((await f.post(app,'release')).json()).toEqual(done);expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'2',market_outgoing:'8'});
});
it('never-prepared recovery survives pause, both transfers and providerless reopen without granting new admission',async()=>{
 const f=await fixture(),newBuyer=await transferPaymentBase(conn,f.buyer);await transferPaymentBase(conn,f.seller);const app=await f.open(false);vi.stubEnv('MULTI_BASE_ENABLED','false');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');
 expect((await f.post(app,'release',{},await cookie(newBuyer))).statusCode).toBe(404);
 const reply=await f.post(app,'release');expect(reply.statusCode,reply.body).toBe(200);const done=KeepEquipmentPurchaseSchema.parse(reply.json());
 expect((await f.post(app,'recover')).json()).toEqual(done);expect((await app.inject({url:'/keep-equipment-market/fills/'+f.fill.id,cookies:f.buyerCookies})).json()).toEqual(done);
 for(const action of ['prepare','review'])expect((await f.post(app,action)).json().error).toMatchObject({code:'KEEP_EQUIPMENT_FILL_RELEASED'});
 const relay=KeepEquipmentSendSchema.parse((await f.post(app,'deliver')).json());expect(relay).toMatchObject({status:'held',reason:'FILL_RELEASED',purchase:done});expect(f.controls.sends).toBe(0);
});
it('exact failed signed release remains terminal across paused API restart and every old payment action',async()=>{
 const f=await fixture(),{state,wire}=await f.retain(),app=await f.open();vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');
 const reply=await f.post(app,'release');expect(reply.statusCode,reply.body).toBe(200);const done=KeepEquipmentPurchaseSchema.parse(reply.json());expect(done.status).toBe('released');expect(done.wire).toEqual(state.wire);expect(done.preparation).toEqual(state.preparation);
 expect(done.release).toMatchObject({reason:'finalized_failed',signature:state.wire!.signature,proof:{paidKeepBaseUnits:'0',rentLamports:'0'}});
 const restart=await f.open(false);for(const action of ['recover','release'])expect((await f.post(restart,action)).json()).toEqual(done);
 for(const action of ['prepare','review']){const held=await f.post(restart,action);expect(held.statusCode).toBe(409);expect(held.json().error.code).toBe('KEEP_EQUIPMENT_FILL_RELEASED');}
 const signed=await f.post(restart,'signed',{signedTransactionHex:Buffer.from(wire).toString('hex')});expect(signed.statusCode).toBe(409);expect(signed.json().error.code).toBe('KEEP_EQUIPMENT_FILL_RELEASED');
 expect(KeepEquipmentSendSchema.parse((await f.post(restart,'deliver')).json())).toMatchObject({status:'held',reason:'FILL_RELEASED',purchase:done});expect(f.controls.sends).toBe(0);
 expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
});
it('API cannot infer nonpayment from absent retained wire, missing history or absent private failure configuration',async()=>{
 const f=await fixture(),app=await f.open();await f.prepare();expect((await f.post(app,'release')).json().error.code).toBe('KEEP_EQUIPMENT_RELEASE_PREPARED');
 const p=f.paymentControls.preparation!,wire=f.sign(p);f.paymentControls.wire=wire;await f.payments.retainSigned(f.buyer.wallet,f.fill.id,wire);f.controls.missing=true;
 expect((await f.post(app,'release')).json().error.code).toBe('KEEP_EQUIPMENT_RELEASE_UNAVAILABLE');const unconfigured=await f.open(false);
 expect((await f.post(unconfigured,'release')).json().error.code).toBe('KEEP_EQUIPMENT_RELEASE_UNAVAILABLE');
 expect((await f.payments.read(f.buyer.wallet,f.fill.id)).status).toBe('signed');expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});
});
it('strict terminal graph rejects contradictory delivery, changed fill/wire/payment pins and new submission authority',async()=>{
 const f=await fixture();await f.retain();const review=await f.payments.review(f.buyer.wallet,f.fill.id);await createKeepEquipmentReleases(conn.db,f.releaseDeps).release(f.buyer.wallet,f.fill.id);
 const done=KeepEquipmentPurchaseSchema.parse(await f.payments.read(f.buyer.wallet,f.fill.id)),proof=done.release!.proof!;
 for(const value of [{...done,status:'signed'},{...done,release:{...done.release,fillId:randomUUID()}},{...done,release:{...done.release,proof:{...proof,reservationId:randomUUID()}}},{...done,wire:{...done.wire,wireSha256:'f'.repeat(64)}},{...done,preparation:{...done.preparation,expectedGenesisHash:f.mint.toBase58()}},{...done,release:{...done.release,proof:{...proof,totalBaseUnits:'1000000'}}},{...done,release:{...done.release,proof:{...proof,providerIds:['other-a','other-b']}}}])expect(KeepEquipmentPurchaseSchema.safeParse(value).success).toBe(false);
 expect(KeepEquipmentReviewSchema.safeParse({...review,purchase:done}).success).toBe(false);
 expect(KeepEquipmentSendSchema.safeParse({purchase:done,status:'submitted',reason:null,broadcastAuthorized:false,fenceReleaseAuthorized:false}).success).toBe(false);
});
it('a release committed during broadcaster checks prevents any send and returns the terminal original',async()=>{
 const f=await fixture();await f.retain();f.controls.missing=false;
 // Deliberately conflicting fixture RPCs exercise database arbitration: the
 // success reader sees absence while the separate private failure reader proves
 // the original failed packet. Real providers must never disagree this way.
 const payments=createKeepEquipmentPayments(conn.db,{...f.deps,finalityConnect:[()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,getTransaction:async()=>null}),()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,getTransaction:async()=>null})],broadcastConnect:()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>{await createKeepEquipmentReleases(conn.db,f.releaseDeps).release(f.buyer.wallet,f.fill.id);return 120;},sendRawTransaction:async()=>{f.controls.sends++;return 'unexpected';}})});
 const result=await payments.deliver(f.buyer.wallet,f.fill.id);expect(result).toMatchObject({status:'held',reason:'FILL_RELEASED',purchase:{status:'released'}});expect(f.controls.sends).toBe(0);
});
