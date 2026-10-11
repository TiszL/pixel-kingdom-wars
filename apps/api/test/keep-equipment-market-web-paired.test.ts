/** Actual browser controller/IndexedDB/HTTP/SQL composition with genuine buyer
 * signatures and raw private reader inputs. RPC execution observations are
 * simulated; the separate accepted local-validator journey covers real SPL. */
import {createKeepEquipmentMarketProvider} from '../src/game/keepEquipmentMarketProvider';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import type {KeepEquipmentPaymentFailureRpc} from '@shardkeep/chain/keep-equipment-payment-failure';
import type {FastifyInstance} from 'fastify';
import {KEEP_MARKET_ITEM_IDS_V4,KeepEquipmentPurchaseSchema,type KeepEquipmentPurchase} from '@shardkeep/shared/keepEquipmentMarketApi';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {sessions} from '../src/db/schema';
import type {KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {type connectTestDb,TEST_CONFIG} from './helpers';
import {isolatedFantasyTestDb} from './fantasy-test-db';
import {craftingMarketSource} from './fixtures/craftingMarketSource';
import {withFragmentMarketSource} from './fixtures/fragmentMarketSource';
import {paymentFixture,paymentStock,fixtureFee,fixtureRent,transferPaymentBase,type PaymentFixtureSource} from './fixtures/keepEquipmentPayments';
import {SEAL_BOUND_PAIRED_HTTP_CASE_MS} from './sealLatencyBudgets';
type Wire={signature:string;wireSha256:string;messageSha256:string;signedTransactionHex:string};
type Operation={command:{kind:string;key:string;request:Record<string,unknown>|null};original:unknown;signingStarted:boolean;wire:Wire|null;observedComplete:boolean};
type Store={read():Promise<{pending:Operation[];archive:Operation[]}>;close():Promise<void>};
type Controller={category(value:'resources'|'items'):void;begin(kind:string,input:object):Promise<unknown>;select(key:string):void;load():Promise<unknown>;recover(retry?:boolean):Promise<unknown>;prepare():Promise<unknown>;review():Promise<unknown>;sign():Promise<unknown>;upload():Promise<unknown>;deliver():Promise<unknown>;release():Promise<unknown>;archive():Promise<unknown>;stock(baseId:string):Promise<unknown>;offers():Promise<unknown>;getSnapshot():{history:{items:Array<{id:string;kind:string;baseId:string}>}|null;stock:{items:Array<{itemId:string;available:string}>}|null;offers:{items:Array<{id:string}>}|null}};
const {KeepMarketJournalStore}=await vi.importActual<{KeepMarketJournalStore:new(identity:object,factory:unknown)=>Store}>('../../web/src/lib/keepEquipmentMarket/journal');
const {KeepMarketController}=await vi.importActual<{KeepMarketController:new(store:Store,ports:object)=>Controller}>('../../web/src/lib/keepEquipmentMarket/controller');
const {createKeepMarketBrowserPorts,browserKeepMarketIdentity}=await vi.importActual<{createKeepMarketBrowserPorts(input:object):object;browserKeepMarketIdentity(wallet:string):object}>('../../web/src/lib/keepEquipmentMarket/browser');
const {API_URL}=await vi.importActual<{API_URL:string}>('../../web/src/lib/api');
const {useApp}=await vi.importActual<{useApp:{getState():{setAuth(wallet:string|null,paid?:boolean):void;setSelectedBaseId(baseId:string|null,persist?:boolean):void}}}>('../../web/src/state/store');
const {IDBFactory,IDBKeyRange}=createRequire(new URL('../../web/package.json',import.meta.url))('fake-indexeddb') as {IDBFactory:new()=>unknown;IDBKeyRange:unknown};
// Real crafting homes install permanent fantasy claims; keep their global
// presentation boundary inside this suite's own database.
const conn=isolatedFantasyTestDb(),root='/keep-equipment-market';
beforeAll(()=>conn.prepare());
afterEach(()=>{useApp.getState().setAuth(null);vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(()=>conn.dispose());
async function paired(version:'legacy'|0='legacy',source?:PaymentFixtureSource,connection:ReturnType<typeof connectTestDb>=conn){
 const conn=connection;
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');
 const f=await paymentFixture(conn,version,version===0,source);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.buyer.now);
 const cookies=new Map<string,Record<string,string>>();
 for(const actor of [f.buyer,f.seller]){const [session]=await conn.db.insert(sessions).values({wallet:actor.wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();cookies.set(actor.wallet,{[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,actor.wallet,session!.id)});}
 const states={enabled:true,actor:f.buyer.wallet,signatures:0,walletFrozen:false,signHook:null as null|((tx:VersionedTransaction)=>Promise<VersionedTransaction>)};
 const sent:Uint8Array[]=[],requests:Array<{path:string;method:string;status:number;body:unknown}>=[],lose=new Set<string>(),stores:Store[]=[],factory=new IDBFactory();
 let app:FastifyInstance|undefined,activeStore!:Store,failed=false;
 const finalityConnect=f.deps.finalityConnect.map(connect=>(signal:AbortSignal):KeepEquipmentPaymentFailureRpc=>{const rpc=connect(signal);return {...rpc,getTransaction:async(signature,options)=>{const tx=await rpc.getTransaction(signature,options);if(!tx||!failed)return tx;
  tx.meta!.err={InstructionError:[version===0?2:1,{Custom:1}]};tx.meta!.postBalances=tx.meta!.preBalances.map((n,i)=>n-(i===0?tx.meta!.fee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];return tx;}};}) as [(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 f.controls.finalityMode='missing';
 const deps:KeepEquipmentPaymentDependencies={...f.deps,finalityConnect,broadcastConnect:()=>({getGenesisHash:async()=>f.genesis,getSlot:async()=>120,sendRawTransaction:async(bytes,options)=>{
  const signature=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
  const [wire]=await conn.sql`select fill_id,encode(signed_transaction,'hex') wire from keep_equipment_payment_wires where signature=${signature}`;
  expect(wire).toBeDefined();expect(wire!.wire).toBe(Buffer.from(bytes).toString('hex'));
  expect(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:wire!.fill_id}]);
  expect(options).toEqual({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:100});sent.push(Uint8Array.from(bytes));return signature;
 }})};
 async function reopen(){await app?.close();app=undefined;vi.stubEnv('MULTI_BASE_ENABLED','false');try{
  app=await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},conn.db,{keepEquipmentMarket:createKeepEquipmentMarketProvider(conn.db,{payments:deps,releases:{failureConnect:finalityConnect,trust:f.trust},deedCollection:f.seller.collection,
   finalizedDeedReader:async asset=>({owner:asset===f.seller.deed?f.seller.wallet:f.buyer.wallet,collection:f.seller.collection,frozen:false,delegate:null,slot:100})})});await app.ready();
 }finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}}
 await reopen();
 const storage=new Map<string,string>();vi.stubGlobal('IDBKeyRange',IDBKeyRange);vi.stubGlobal('window',{location:{origin:TEST_CONFIG.WEB_ORIGIN[0]!},localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
 vi.stubGlobal('navigator',{locks:{request:async<T>(name:string,_options:unknown,run:(lock:{name:string})=>Promise<T>)=>run({name})}});
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  const target=new URL(String(input)),method=init?.method??'GET';expect(target.origin).toBe(new URL(API_URL).origin);const path=target.pathname,body=typeof init?.body==='string'?JSON.parse(init.body) as Record<string,unknown>:undefined;
  const saved=await activeStore.read();
  if(method==='POST'){
   const command=body?.idempotencyKey===undefined?null:saved.pending.find(op=>op.command.key===body.idempotencyKey);
   if(command)expect(command.command.request).toEqual(body);
   if(['/listings','/fills','/cancellations'].some(suffix=>path===root+suffix))expect(command,'Original command must commit before HTTP admission').toBeDefined();
   if(path.endsWith('/signed'))expect(saved.pending.some(op=>op.signingStarted&&op.wire?.signedTransactionHex===body?.signedTransactionHex)).toBe(true);
  }
  const headers:Record<string,string>={};new Headers(init?.headers).forEach((v,k)=>{headers[k]=v;});
  const response=await app!.inject({method:method as 'GET'|'POST',url:path+target.search,headers:{...headers,origin:TEST_CONFIG.WEB_ORIGIN[0]!},...(init?.credentials==='include'?{cookies:cookies.get(states.actor)!}:{}),...(init?.body==null?{}:{payload:String(init.body)})});
  requests.push({path,method,status:response.statusCode,body});
  if(response.statusCode===200&&path.endsWith('/prepare'))f.controls.preparation=KeepEquipmentPurchaseSchema.parse(response.json()).preparation;
  if(response.statusCode===200&&path.endsWith('/signed')){const purchase=KeepEquipmentPurchaseSchema.parse(response.json());f.controls.preparation=purchase.preparation;f.controls.wire=Buffer.from(purchase.wire!.signedTransactionHex,'hex');}
  if(lose.delete(path))throw Error('Paired lost HTTP response');
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 // These wallet-side reads have their own byte copies and may disagree with
 // private readers. They prove client validation, not real network independence.
 const local=f.deps.preparationConnect[0](new AbortController().signal),current={...local,getMultipleAccountsInfoAndContext:async(...args:Parameters<typeof local.getMultipleAccountsInfoAndContext>)=>{
  const result=await local.getMultipleAccountsInfoAndContext(...args);if(states.walletFrozen&&result.value[1])result.value[1].data[108]=2;return result;
 },getSignatureStatuses:async()=>({context:{slot:100},value:[null]})};
 const trust={version:1,revision:'paired-browser-test',expectedGenesisHash:f.genesis,expectedKeepMint:f.mint.toBase58(),maxFeeLamports:f.trust.maxFeeLamports.toString(),maxAtaRentLamports:String(fixtureRent)};
 function client(actor:'buyer'|'seller',key:string=randomUUID(),pins:object|null=trust,selected:string|null=f[actor].baseId){
  states.actor=f[actor].wallet;useApp.getState().setAuth(states.actor,true);useApp.getState().setSelectedBaseId(selected,false);
  const store=new KeepMarketJournalStore(browserKeepMarketIdentity(states.actor),factory);stores.push(store);activeStore=store;
  const wallet={publicKey:f[actor].signer.publicKey,signVersionedTransaction:async(tx:VersionedTransaction)=>{
   const op=(await store.read()).pending.find(item=>item.command.key===key);expect(op?.signingStarted,'Durable marker must precede the sign-only SDK').toBe(true);states.signatures++;tx.sign([f[actor].signer]);return states.signHook?states.signHook(tx):tx;
  },sendTransaction:vi.fn(()=>{throw Error('Wallet must never broadcast');}),signMessage:null,isEmbedded:false};
  const ports=createKeepMarketBrowserPorts({identity:browserKeepMarketIdentity(states.actor),trust:pins,wallet:()=>wallet,connection:current,lifecycle:()=>({active:true,visible:true,epoch:0,actionsEnabled:states.enabled})});
  const controller=new KeepMarketController(store,{...ports,key:()=>key});controller.select('fill:'+key);return {controller,store,key,wallet};
 }
 async function ready(){const c=client('buyer',f.fill.id);await c.controller.begin('fill',{listingId:f.listing.id,buyerBaseId:f.buyer.baseId,quantity:'2'});await c.controller.prepare();await c.controller.review();return c;}
 const saved=async(store:Store,id:string):Promise<KeepEquipmentPurchase>=>KeepEquipmentPurchaseSchema.parse((await store.read()).pending.find(op=>op.command.key===id)!.original);
 return {f,states,sent,requests,lose,client,ready,saved,reopen,setFailed:(value:boolean)=>{failed=value;f.controls.finalityMode='ok';},cookies,app:()=>app!,close:async()=>{try{await Promise.all(stores.map(s=>s.close()));}finally{await app?.close();}}};
}

it.each(['legacy',0] as const)('pairs %s selling and original purchase through lost replies, exact relay, paused restart and transferred-base recovery',async version=>{
 const p=await paired(version);try{
  // The reusable reader fixture already holds two units. Cancel its eight
  // unsold units through the real browser before making a new three-unit sale.
  let seller=p.client('seller'),c=seller.controller;const cancellation=seller.key;
  p.lose.add(root+'/cancellations');await expect(c.begin('cancellation',{listingId:p.f.listing.id})).rejects.toThrow('lost HTTP');
  expect((await seller.store.read()).pending[0]!.original).toBeNull();seller=p.client('seller',cancellation);c=seller.controller;c.select('cancellation:'+cancellation);await c.recover();await c.archive();
  expect(await paymentStock(conn,p.f.seller.baseId)).toMatchObject({available:'8',market_outgoing:'2'});
  seller=p.client('seller');const listing=seller.key;c=seller.controller;p.lose.add(root+'/listings');
  await expect(c.begin('listing',{baseId:p.f.seller.baseId,itemId:'route_compass',quantity:'3',unitPriceBaseUnits:p.f.listing.unitPriceBaseUnits})).rejects.toThrow('lost HTTP');
  seller=p.client('seller',listing);c=seller.controller;c.select('listing:'+listing);await c.recover();await c.archive();
  let buyer=p.client('buyer'),id=buyer.key;c=buyer.controller;await c.load();await c.offers();expect(c.getSnapshot().offers!.items.some(row=>row.id===listing)).toBe(true);
  await c.stock(p.f.buyer.baseId);expect(c.getSnapshot().stock!.items.find(row=>row.itemId==='route_compass')!.available).toBe('0');
  p.lose.add(root+'/fills');await expect(c.begin('fill',{listingId:listing,buyerBaseId:p.f.buyer.baseId,quantity:'2'})).rejects.toThrow('lost HTTP');
  expect((await buyer.store.read()).pending[0]!.original).toBeNull();buyer=p.client('buyer',id);c=buyer.controller;await c.recover();
  p.lose.add(`${root}/fills/${id}/prepare`);await expect(c.prepare()).rejects.toThrow('lost HTTP');await c.recover();const prepared=await p.saved(buyer.store,id);
  expect(prepared.preparation!.transactionVersion).toBe(version);expect(prepared.preparation!.costs.rentLamports).toBe(String(version===0?fixtureRent:0));
  await c.review();await c.sign();const signed=(await buyer.store.read()).pending[0]!.wire!;expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(0);
  p.lose.add(`${root}/fills/${id}/signed`);await expect(c.upload()).rejects.toThrow('lost HTTP');expect((await buyer.store.read()).pending[0]!.wire).toEqual(signed);
  buyer=p.client('buyer',id);c=buyer.controller;await c.recover();expect((await p.saved(buyer.store,id)).status).toBe('signed');
  p.lose.add(`${root}/fills/${id}/deliver`);await expect(c.deliver()).rejects.toThrow('lost HTTP');expect(p.sent).toHaveLength(1);expect(Buffer.from(p.sent[0]!).toString('hex')).toBe(signed.signedTransactionHex);
  expect(await paymentStock(conn,p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'4'});expect(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(0);
  p.f.controls.finalityMode='ok';const newBuyer=await transferPaymentBase(conn,p.f.buyer);await transferPaymentBase(conn,p.f.seller);
  vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');p.states.enabled=false;await p.reopen();buyer=p.client('buyer',id,null,null);c=buyer.controller;await c.load();
  expect(c.getSnapshot().history!.items).toContainEqual(expect.objectContaining({id,kind:'fill',baseId:p.f.buyer.baseId}));
  await c.recover();await c.recover();const delivered=await p.saved(buyer.store,id);expect(delivered.status).toBe('delivered');expect(delivered.preparation).toEqual(prepared.preparation);expect(delivered.wire).toMatchObject(signed);expect(delivered.delivery!.buyerBaseId).toBe(p.f.buyer.baseId);
  expect(await paymentStock(conn,p.f.buyer.baseId)).toMatchObject({available:'2',market_incoming:'2'});expect(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(1);
  expect((await conn.sql`select owner_wallet from bases where id=${p.f.buyer.baseId}`)[0]!.owner_wallet).toBe(newBuyer);await c.archive();expect((await buyer.store.read()).archive).toHaveLength(1);
  const foreign=p.client('seller',id,null,null);expect((await foreign.store.read()).pending.every(op=>op.command.key!==id)).toBe(true);
  expect((await p.app().inject({url:`${root}/fills/${id}`,cookies:p.cookies.get(p.f.seller.wallet)!})).statusCode).toBe(404);
  expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(1);expect(buyer.wallet.sendTransaction).not.toHaveBeenCalled();
 }finally{await p.close();}
},120000);

it('retains a late genuine wallet signature under its original actor before refusing an account switch, and uploads it while paused',async()=>{
 const p=await paired();try{let b=await p.ready();p.states.signHook=async tx=>{useApp.getState().setAuth(p.f.seller.wallet,true);return tx;};
  await expect(b.controller.sign()).rejects.toThrow('changed');const op=(await b.store.read()).pending[0]!;expect(op.signingStarted).toBe(true);expect(op.wire).not.toBeNull();expect(p.sent).toHaveLength(0);
  const other=p.client('seller');expect((await other.store.read()).pending).toHaveLength(0);
  vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');p.states.enabled=false;b=p.client('buyer',p.f.fill.id,null,null);await expect(b.controller.sign()).rejects.toThrow();await b.controller.upload();
  expect((await p.saved(b.store,p.f.fill.id)).wire).toMatchObject(op.wire!);p.f.controls.finalityMode='ok';await b.controller.recover();expect((await p.saved(b.store,p.f.fill.id)).status).toBe('delivered');
  expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(0);
 }finally{await p.close();}
});

it('lost sign-only wallet reply leaves the original fenced and never opens a second approval',async()=>{
 const p=await paired();try{let b=await p.ready();p.states.signHook=async()=>{throw Error('Wallet response lost');};await expect(b.controller.sign()).rejects.toThrow('response lost');
  expect((await b.store.read()).pending[0]).toMatchObject({signingStarted:true,wire:null});b=p.client('buyer',p.f.fill.id);await b.controller.recover();await expect(b.controller.sign()).rejects.toThrow();await expect(b.controller.prepare()).rejects.toThrow();
  expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(0);expect(await conn.sql`select fill_id from keep_equipment_payment_wires where fill_id=${p.f.fill.id}`).toHaveLength(0);
  expect(await paymentStock(conn,p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});
 }finally{await p.close();}
});

it('an actually signed replacement blockhash cannot cross browser custody or replace the immutable server message',async()=>{
 const p=await paired();try{const b=await p.ready(),before=await p.saved(b.store,p.f.fill.id);p.states.signHook=async tx=>{tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();tx.sign([p.f.buyer.signer]);return tx;};
  await expect(b.controller.sign()).rejects.toThrow();expect((await b.store.read()).pending[0]).toMatchObject({signingStarted:true,wire:null});await b.controller.recover();expect((await p.saved(b.store,p.f.fill.id)).preparation).toEqual(before.preparation);
  expect(p.requests.some(row=>row.path.endsWith('/signed'))).toBe(false);expect(p.sent).toHaveLength(0);expect(p.states.signatures).toBe(1);
 }finally{await p.close();}
});

it('private provider disagreement and independent frozen wallet account both stop before the durable signing marker',async()=>{
 const p=await paired();try{const b=p.client('buyer',p.f.fill.id);await b.controller.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'2'});await b.controller.prepare();
  p.f.controls.preparationMode='disagree';await expect(b.controller.review()).rejects.toThrow();expect(p.requests.at(-1)).toMatchObject({status:503});
  p.f.controls.preparationMode='ok';p.states.walletFrozen=true;await expect(b.controller.review()).rejects.toThrow('frozen');expect(p.requests.at(-1)).toMatchObject({status:200});
  expect((await b.store.read()).pending[0]).toMatchObject({signingStarted:false,wire:null});expect(p.states.signatures).toBe(0);expect(p.sent).toHaveLength(0);
  p.states.walletFrozen=false;await b.controller.review();expect((await p.saved(b.store,p.f.fill.id)).status).toBe('prepared');
 }finally{await p.close();}
});


it.each(['legacy',0] as const)('pairs %s released terminal recovery with real API stock and permanent signature custody',async version=>{
 const p=await paired(version);try{
  let buyer=p.client('buyer'),c=buyer.controller;
  await c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'1'});await c.release();
  expect((await p.saved(buyer.store,buyer.key)).release).toMatchObject({reason:'never_prepared',signature:null,proof:null});await c.archive();
  buyer=p.client('buyer');c=buyer.controller;const id=buyer.key;
  await c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'2'});await c.prepare();const prepared=await p.saved(buyer.store,id);
  await c.review();await c.sign();await c.upload();const signed=await p.saved(buyer.store,id);await c.deliver();expect(p.sent).toHaveLength(1);
  p.setFailed(true);await transferPaymentBase(conn,p.f.buyer);await transferPaymentBase(conn,p.f.seller);
  p.states.enabled=false;vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await p.reopen();buyer=p.client('buyer',id,null,null);c=buyer.controller;
  p.lose.add(`${root}/fills/${id}/release`);await expect(c.release()).rejects.toThrow('lost HTTP');
  expect((await p.saved(buyer.store,id)).status).toBe('signed');buyer=p.client('buyer',id,null,null);c=buyer.controller;await c.load();await c.recover();
  const done=await p.saved(buyer.store,id);expect(done.status).toBe('released');expect(done.release).toMatchObject({reason:'finalized_failed',signature:signed.wire!.signature,proof:{paidKeepBaseUnits:'0',rentLamports:'0'}});expect(done.preparation).toEqual(prepared.preparation);expect(done.wire).toEqual(signed.wire);expect(done.delivery).toBeNull();
  // Deliberately change simulated providers after terminal SQL commit. Earlier
  // positive responses cannot regain delivery authority or remove the fence.
  p.setFailed(false);await c.recover();expect(await p.saved(buyer.store,id)).toEqual(done);
  for(const action of [()=>c.prepare(),()=>c.review(),()=>c.sign(),()=>c.upload(),()=>c.deliver(),()=>c.release()])await expect(action()).rejects.toThrow();
  expect(await paymentStock(conn,p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});expect(await paymentStock(conn,p.f.seller.baseId)).toMatchObject({available:'3',market_outgoing:'7'});
  expect(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(0);expect(await conn.sql`select fill_id from keep_equipment_fill_releases where fill_id=${id}`).toHaveLength(1);
  expect(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${done.wire!.signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:id}]);
  await c.archive();expect((await buyer.store.read()).archive).toHaveLength(2);expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(1);
  expect((await p.app().inject({url:`${root}/fills/${id}`,cookies:p.cookies.get(p.f.seller.wallet)!})).statusCode).toBe(404);
 }finally{await p.close();}
},120000);


it('pairs actual earned refined goods through original release, lost payment replies, paused recovery and buyer Compass use',async()=>{
 const source=await craftingMarketSource(conn),earned=await source.stock(source.seller.baseId);
 expect(earned.map(row=>row.item_id).sort()).toEqual([...ORDINARY_REFINED_IDS,'navigation_kit'].sort());
 expect(earned.every(row=>BigInt(row.available)>0n&&row.pending_output==='0'&&row.market_outgoing==='0'&&row.market_incoming==='0')).toBe(true);
 const p=await paired('legacy',{actors:{seller:{...source.seller,get now(){return source.clock();}},buyer:{...source.buyer,get now(){return source.clock();}}},itemId:'prismstone_lens',listingQuantity:'4',fillQuantity:'2'});
 const stock=async(baseId:string)=>(await source.stock(baseId)).find(row=>row.item_id==='prismstone_lens');
 try{
  expect(await stock(p.f.seller.baseId)).toMatchObject({available:'0',market_outgoing:'4'});
  expect(await stock(p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});
  // Recover the exact fixture-created reservation through its original API key;
  // its units came from earned returns/refining, never an inventory seed.
  let buyer=p.client('buyer',p.f.fill.id),c=buyer.controller;
  await c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'2'});await c.release();
  expect((await p.saved(buyer.store,buyer.key)).release).toMatchObject({reason:'never_prepared',signature:null,proof:null});await c.archive();
  expect(await stock(p.f.seller.baseId)).toMatchObject({available:'2',market_outgoing:'2'});
  expect(await stock(p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
  buyer=p.client('buyer');const id=buyer.key;c=buyer.controller;c.category('resources');await c.load();await c.offers();
  expect(c.getSnapshot().offers!.items).toContainEqual(expect.objectContaining({id:p.f.listing.id,itemId:'prismstone_lens',availableQuantity:'2'}));
  await c.stock(p.f.buyer.baseId);
  // The browser requests catalogue4; pin that version and its complete shared ID list.
  expect(c.getSnapshot().stock).toMatchObject({catalogueVersion:4});
  expect(c.getSnapshot().stock!.items.map(row=>row.itemId).sort()).toEqual([...KEEP_MARKET_ITEM_IDS_V4].sort());
  expect(c.getSnapshot().stock!.items.find(row=>row.itemId==='prismstone_lens')!.available).toBe('0');
  p.lose.add(root+'/fills');await expect(c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'2'})).rejects.toThrow('lost HTTP');
  expect((await buyer.store.read()).pending[0]!.original).toBeNull();buyer=p.client('buyer',id);c=buyer.controller;await c.recover();
  expect((await p.saved(buyer.store,id)).fill).toMatchObject({itemId:'prismstone_lens',quantity:'2',buyerBaseId:p.f.buyer.baseId});
  p.lose.add(`${root}/fills/${id}/prepare`);await expect(c.prepare()).rejects.toThrow('lost HTTP');await c.recover();const prepared=await p.saved(buyer.store,id);
  await c.review();await c.sign();const signed=(await buyer.store.read()).pending[0]!.wire!;expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(0);
  p.lose.add(`${root}/fills/${id}/signed`);await expect(c.upload()).rejects.toThrow('lost HTTP');buyer=p.client('buyer',id);c=buyer.controller;await c.recover();
  expect((await p.saved(buyer.store,id)).wire).toMatchObject(signed);
  p.lose.add(`${root}/fills/${id}/deliver`);await expect(c.deliver()).rejects.toThrow('lost HTTP');expect(p.sent).toHaveLength(1);
  expect(Buffer.from(p.sent[0]!).toString('hex')).toBe(signed.signedTransactionHex);expect(await stock(p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});
  p.f.controls.finalityMode='ok';p.states.enabled=false;vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await p.reopen();
  buyer=p.client('buyer',id,null,null);c=buyer.controller;c.category('resources');await c.load();await c.recover();const delivered=await p.saved(buyer.store,id);
  expect(delivered).toMatchObject({status:'delivered',delivery:{itemId:'prismstone_lens',quantity:'2',buyerBaseId:p.f.buyer.baseId}});expect(delivered.preparation).toEqual(prepared.preparation);expect(delivered.wire).toMatchObject(signed);
  expect(await stock(p.f.buyer.baseId)).toMatchObject({available:'2',market_incoming:'0'});expect(await stock(p.f.seller.baseId)).toMatchObject({available:'2',market_outgoing:'0'});
  // The API and real craft/dispatch writers consume the buyer's purchased input.
  // Only the finalized execution RPC trace is simulated in this client pair.
  const used=await source.buyerUsesPurchasedMaterials();expect(used.craft.status).toBe('accepted');expect(used.returned.expedition.routeSnapshot.fitting).toMatchObject({itemId:'route_compass'});
  expect(await stock(p.f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
  expect((await conn.sql`select available::text,reserved::text,pending_output::text,market_outgoing::text,market_incoming::text from ordinary_equipment_stocks where base_id=${p.f.buyer.baseId} and item_id='route_compass'`)[0]).toMatchObject({available:'1',reserved:'0',pending_output:'0',market_outgoing:'0',market_incoming:'0'});
  const newBuyer=await transferPaymentBase(conn,{...p.f.buyer,now:source.clock()});await transferPaymentBase(conn,{...p.f.seller,now:source.clock()});
  p.f.controls.finalityMode='throw';await p.reopen();buyer=p.client('buyer',id,null,null);c=buyer.controller;c.category('resources');await c.load();await c.recover();
  expect(await p.saved(buyer.store,id)).toEqual(delivered);expect((await conn.sql`select owner_wallet from bases where id=${p.f.buyer.baseId}`)[0]!.owner_wallet).toBe(newBuyer);
  expect(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(1);expect(await conn.sql`select fill_id from keep_equipment_fill_releases where fill_id=${p.f.fill.id}`).toHaveLength(1);
  expect(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${signed.signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:id}]);
  await c.archive();expect((await buyer.store.read()).archive).toHaveLength(2);
  const foreign=p.client('seller',id,null,null);expect((await foreign.store.read()).pending.every(op=>op.command.key!==id)).toBe(true);
  expect((await p.app().inject({url:`${root}/fills/${id}`,cookies:p.cookies.get(p.f.seller.wallet)!})).statusCode).toBe(404);
  expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(1);expect(buyer.wallet.sendTransaction).not.toHaveBeenCalled();
 }finally{await p.close();}
},SEAL_BOUND_PAIRED_HTTP_CASE_MS);


it('pairs earned Divine fragments and held Seeker credits through exact browser payment, paused recovery and buyer relisting',async()=>{
 await withFragmentMarketSource(async source=>{
  const p=await paired(0,{actors:{seller:source.seller,buyer:source.buyer},itemId:'crystal_fragment',listingQuantity:'8',fillQuantity:'3'},source.conn);
  try{
   expect(await source.stock(source.seller.baseId)).toEqual({available:'4',market_outgoing:'8',market_incoming:'0'});
   const share=await source.claimSourceShare();expect(share.quantity).toBe('2');
   expect(await source.stock(source.seller.baseId)).toEqual({available:'6',market_outgoing:'8',market_incoming:'0'});
   let buyer=p.client('buyer',p.f.fill.id),c=buyer.controller;
   await c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'3'});await c.release();await c.archive();
   expect(await source.stock(source.seller.baseId)).toEqual({available:'9',market_outgoing:'5',market_incoming:'0'});
   buyer=p.client('buyer');const id=buyer.key;c=buyer.controller;c.category('resources');await c.load();await c.offers();
   expect(c.getSnapshot().offers!.items).toContainEqual(expect.objectContaining({id:p.f.listing.id,itemId:'crystal_fragment',availableQuantity:'5'}));
   await c.stock(p.f.buyer.baseId);
   // The browser requests catalogue4; pin that version and its complete shared ID list.
   expect(c.getSnapshot().stock).toMatchObject({catalogueVersion:4});
   expect(c.getSnapshot().stock!.items.map(row=>row.itemId).sort()).toEqual([...KEEP_MARKET_ITEM_IDS_V4].sort());
   expect(c.getSnapshot().stock!.items.find(row=>row.itemId==='crystal_fragment')).toMatchObject({available:'0',reserved:'0',pendingOutput:'0'});
   p.lose.add(root+'/fills');await expect(c.begin('fill',{listingId:p.f.listing.id,buyerBaseId:p.f.buyer.baseId,quantity:'3'})).rejects.toThrow('lost HTTP');
   buyer=p.client('buyer',id);c=buyer.controller;await c.recover();
   p.lose.add(`${root}/fills/${id}/prepare`);await expect(c.prepare()).rejects.toThrow('lost HTTP');await c.recover();const prepared=await p.saved(buyer.store,id);
   await c.review();await c.sign();const signed=(await buyer.store.read()).pending[0]!.wire!;expect(p.states.signatures).toBe(1);
   p.lose.add(`${root}/fills/${id}/signed`);await expect(c.upload()).rejects.toThrow('lost HTTP');buyer=p.client('buyer',id);c=buyer.controller;await c.recover();
   p.lose.add(`${root}/fills/${id}/deliver`);await expect(c.deliver()).rejects.toThrow('lost HTTP');expect(p.sent).toHaveLength(1);
   expect(Buffer.from(p.sent[0]!).toString('hex')).toBe(signed.signedTransactionHex);
   expect(await source.stock(source.buyer.baseId)).toEqual({available:'0',market_outgoing:'0',market_incoming:'3'});
   p.f.controls.finalityMode='ok';p.states.enabled=false;vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await p.reopen();
   buyer=p.client('buyer',id,null,null);c=buyer.controller;await c.load();await c.recover();const delivered=await p.saved(buyer.store,id);
   expect(delivered).toMatchObject({status:'delivered',delivery:{itemId:'crystal_fragment',quantity:'3',buyerBaseId:source.buyer.baseId}});
   expect(delivered.preparation).toEqual(prepared.preparation);expect(delivered.wire).toMatchObject(signed);await c.archive();
   expect(await source.stock(source.buyer.baseId)).toEqual({available:'3',market_outgoing:'0',market_incoming:'0'});
   // Purchased stock can be sold again; it does not transfer the original
   // winner's personal award or create a fictional fragment consumption sink.
   p.states.enabled=true;vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');await p.reopen();await source.refresh();
   const resale=p.client('buyer');await resale.controller.begin('listing',{baseId:source.buyer.baseId,itemId:'crystal_fragment',quantity:'3',unitPriceBaseUnits:p.f.listing.unitPriceBaseUnits});await resale.controller.archive();
   expect(await source.stock(source.buyer.baseId)).toEqual({available:'0',market_outgoing:'3',market_incoming:'0'});
   const cancel=p.client('buyer');await cancel.controller.begin('cancellation',{listingId:resale.key});await cancel.controller.archive();
   expect(await source.stock(source.buyer.baseId)).toEqual({available:'3',market_outgoing:'0',market_incoming:'0'});
   const seller=p.client('seller');await seller.controller.begin('cancellation',{listingId:p.f.listing.id});await seller.controller.archive();
   expect(await source.stock(source.seller.baseId)).toEqual({available:'11',market_outgoing:'0',market_incoming:'0'});
   await source.assertOriginalSource();
   expect(await source.conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${id}`).toHaveLength(1);
   expect(await source.conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${signed.signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:id}]);
   expect((await p.app().inject({url:`${root}/fills/${id}`,cookies:p.cookies.get(p.f.seller.wallet)!})).statusCode).toBe(404);
   expect(p.states.signatures).toBe(1);expect(p.sent).toHaveLength(1);expect(buyer.wallet.sendTransaction).not.toHaveBeenCalled();
  }finally{await p.close();}
 });
},120000);
