/** Real SQL release custody: exact failed packets or no preparation at all.
 * No expiry, missing RPC or rejected success proof can erase a payment fence. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {createKeepEquipmentPaymentReader} from '@shardkeep/chain/keep-equipment-payment';
import {createKeepEquipmentPayments} from '../src/game/keepEquipmentPayments';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {cancelKeepEquipmentListing,createKeepEquipmentListing,readKeepEquipmentListing,reserveKeepEquipmentFill} from '../src/game/keepEquipmentMarket';
import type {KeepEquipmentPaymentFailureRpc} from '../../../packages/chain/src/keepEquipmentPaymentFailure';
import {paymentFixture,paymentStock,transferPaymentBase,fixtureFee} from './fixtures/keepEquipmentPayments';
import {connectTestDb} from './helpers';
import {TEST_DATABASE_URL} from './db-url';
const conn=connectTestDb(),db=conn.db,migration=readFileSync(new URL('../drizzle/0245_keep_equipment_fill_releases.sql',import.meta.url),'utf8');
const marketMigration=readFileSync(new URL('../drizzle/0249_keep_fragment_market.sql',import.meta.url),'utf8');
// Every case runs after a replay of the current migration journal. This used to
// re-run 0249 directly, when 0249 was the newest market migration; since 0253
// (crystal_fragment_stocks.mining_pending) and the 0254-0283 source successors,
// that direct re-run is a downgrade the sealed source refuses (pinned below).
// The runner verifies the applied history and applies no SQL twice.
beforeAll(async()=>{await runMigrations(db);await conn.sql`select public.shardkeep_divine_fragment_source()`;});
beforeEach(()=>vi.stubEnv('MULTI_BASE_ENABLED','true'));
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>conn.sql.end());
type Fixture=Awaited<ReturnType<typeof paymentFixture>>;
async function fixture(version:'legacy'|0='legacy',missingAta=false){
 const f=await paymentFixture(conn,version,missingAta),control={mode:'failed' as 'failed'|'success'|'missing'|'mismatch'|'fee'};
 const failureConnect=f.deps.finalityConnect.map((connect,peer)=>(signal:AbortSignal):KeepEquipmentPaymentFailureRpc=>{
  const source=connect(signal);return {...source,getTransaction:async(signature,options)=>{
   const tx=await source.getTransaction(signature,options);if(!tx||control.mode==='missing')return null;if(control.mode==='success')return tx;
   tx.meta!.err={InstructionError:[0,'InvalidArgument']};if(peer===1&&control.mode==='mismatch')tx.slot++;
   tx.meta!.fee=control.mode==='fee'?200_000:fixtureFee;
   tx.meta!.postBalances=tx.meta!.preBalances.map((n,i)=>n-(i===0?tx.meta!.fee:0));
   tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];
   return tx;
  }};
 }) as [(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 const releaseDeps={trust:f.trust,failureConnect};return {...f,control,releaseDeps,releases:createKeepEquipmentReleases(db,releaseDeps)};
}
async function expectReleased(f:Fixture){
 expect(await paymentStock(conn,f.seller.baseId)).toEqual({available:'2',market_outgoing:'8',market_incoming:'0'});
 expect(await paymentStock(conn,f.buyer.baseId)).toEqual({available:'0',market_outgoing:'0',market_incoming:'0'});
 expect(await conn.sql`select fill_id from keep_equipment_fill_releases where fill_id=${f.fill.id}`).toHaveLength(1);
 expect(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${f.fill.id}`).toHaveLength(0);
}
async function rawDelivery(f:Fixture){
 const state=await f.payments.read(f.buyer.wallet,f.fill.id),p=state.preparation!,{sellerAtaRentCapLamports,...o}=p.original;
 const proof=await createKeepEquipmentPaymentReader(f.deps.finalityConnect,f.trust)({...o,totalBaseUnits:BigInt(o.totalBaseUnits),...(sellerAtaRentCapLamports===undefined?{}:{sellerAtaRentCapLamports:BigInt(sellerAtaRentCapLamports)})},state.wire!.signature);
 return conn.sql`insert into keep_equipment_deliveries(fill_id,proof) values(${f.fill.id},${JSON.stringify(proof)}::jsonb) on conflict do nothing`;
}
const rawRelease=(f:Fixture,reason='never_prepared',signature:string|null=null,proof:unknown=null)=>conn.sql`insert into keep_equipment_fill_releases(fill_id,reason,signature,proof) values(${f.fill.id},${reason},${signature},${proof===null?null:JSON.stringify(proof)}::jsonb)`;

it('releases a never-prepared reservation once across pause, restart and concurrent recovery',async()=>{
 const f=await fixture();f.controls.paused=true;
 const rows=await Promise.all([f.releases.release(f.buyer.wallet,f.fill.id),createKeepEquipmentReleases(db).release(f.buyer.wallet,f.fill.id)]);
 expect(rows[0]).toEqual(rows[1]);expect(rows[0]).toMatchObject({fillId:f.fill.id,reason:'never_prepared',signature:null,proof:null});await expectReleased(f);
 expect(f.controls.preparationCalls).toBe(0);expect(f.controls.finalityCalls).toBe(0);
 expect(await createKeepEquipmentReleases(db).release(f.buyer.wallet,f.fill.id)).toEqual(rows[0]);
});

it.each((['legacy',0] as const).flatMap(version=>[false,true].map(missingAta=>({version,missingAta}))))('releases exact retained finalized failed $version missingATA=$missingAta while preserving signature and original wire',async({version,missingAta})=>{
 const f=await fixture(version,missingAta),{state}=await f.retain();f.controls.paused=true;
 const receipt=await f.releases.release(f.buyer.wallet,f.fill.id);
 expect(receipt).toMatchObject({reason:'finalized_failed',signature:state.wire!.signature,proof:{outcome:'failed',messageSha256:state.preparation!.messageSha256,wireSha256:state.wire!.wireSha256,rentLamports:'0',paidKeepBaseUnits:'0',paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false}});
 await expectReleased(f);expect((await f.payments.read(f.buyer.wallet,f.fill.id)).wire).toEqual(state.wire);
 expect(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${state.wire!.signature}`).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:f.fill.id}]);
 const calls=f.controls.finalityCalls;expect(await createKeepEquipmentReleases(db).release(f.buyer.wallet,f.fill.id)).toEqual(receipt);expect(f.controls.finalityCalls).toBe(calls);
});

it('records historical fee above the quotation cap without inventing rent or KEEP loss',async()=>{
 const f=await fixture(0,true);await f.retain();f.control.mode='fee';const receipt=await f.releases.release(f.buyer.wallet,f.fill.id);
 expect(receipt.proof).toMatchObject({feeLamports:'200000',rentLamports:'0',paidKeepBaseUnits:'0'});await expectReleased(f);
});

it('prepared without retained wire stays held even after blockhash expiry and provider failure',async()=>{
 const f=await fixture();await f.prepare();f.controls.height=1000;f.controls.blockhashValid=false;f.control.mode='missing';
 await expect(f.releases.release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_PREPARED'});
 await expect(rawRelease(f)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_PREPARED'});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'0',market_outgoing:'10'});
});

it.each(['success','missing','mismatch'] as const)('does not release %s RPC evidence or modify any custody',async mode=>{
 const f=await fixture();await f.retain();f.control.mode=mode;
 await expect(f.releases.release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_UNAVAILABLE'});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'2'});
});

it('unconfigured or changed private pins cannot release a signed purchase',async()=>{
 const f=await fixture();await f.retain();await expect(createKeepEquipmentReleases(db).release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_UNAVAILABLE'});
 await expect(createKeepEquipmentReleases(db,{...f.releaseDeps,trust:{...f.trust,providerIds:['wrong-a','wrong-b']}}).release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_CONFIGURATION'});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();
});

it.each([false,true])('recovery signed=%s follows original bases through both transfers and remains private to original buyer',async signed=>{
 const f=await fixture();if(signed)await f.retain();const newBuyer=await transferPaymentBase(conn,f.buyer),newSeller=await transferPaymentBase(conn,f.seller);f.controls.paused=true;
 for(const actor of [newBuyer,newSeller,f.seller.wallet])await expect(f.releases.release(actor,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_FILL_UNKNOWN'});
 await f.releases.release(f.buyer.wallet,f.fill.id);await expectReleased(f);
 expect((await conn.sql`select owner_wallet from bases where id=${f.seller.baseId}`)[0]?.owner_wallet).toBe(newSeller);
});

it('released fills remain spent against original listing: only unsold remainder cancels and returned units can form a new listing',async()=>{
 const f=await fixture();await f.releases.release(f.buyer.wallet,f.fill.id);
 expect(await readKeepEquipmentListing(db,f.listing.id)).toMatchObject({availableQuantity:'8',reservedQuantity:'2'});
 const deps={clock:()=>f.buyer.now,assertAdmission:()=>undefined};
 await expect(reserveKeepEquipmentFill(db,f.buyer.wallet,{idempotencyKey:randomUUID(),listingId:f.listing.id,buyerBaseId:f.buyer.baseId,quantity:'9'},{buyer:f.buyer.authority,seller:f.seller.authority},deps)).rejects.toThrow();
 const cancelled=await cancelKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),listingId:f.listing.id},f.seller.authority,deps);expect(cancelled.quantity).toBe('8');
 expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'10',market_outgoing:'0'});
 const listing=await createKeepEquipmentListing(db,f.seller.wallet,{idempotencyKey:randomUUID(),baseId:f.seller.baseId,itemId:'route_compass',quantity:'2',unitPriceBaseUnits:f.listing.unitPriceBaseUnits},f.seller.authority,deps);
 expect(listing.quantity).toBe('2');expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'8',market_outgoing:'2'});
});

it.each(['seller','buyer'] as const)('rolls back the receipt and both effects if original %s custody is missing',async side=>{
 const f=await fixture();if(side==='seller')await conn.sql`update ordinary_equipment_stocks set market_outgoing=0 where base_id=${f.seller.baseId}`;
 else await conn.sql`update ordinary_equipment_stocks set market_incoming=0 where base_id=${f.buyer.baseId}`;
 await expect(f.releases.release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({cause:{message:side==='seller'?'KEEP_EQUIPMENT_RELEASE_CUSTODY':'KEEP_EQUIPMENT_RELEASE_CAPACITY'}});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'0',market_outgoing:side==='seller'?'0':'10'});
});

it('i64 capacity already held by outgoing stock makes its exact return safe without granting buyer items',async()=>{
 const f=await fixture();await conn.sql`update ordinary_equipment_stocks set available=9223372036854775797 where base_id=${f.seller.baseId}`;
 await f.releases.release(f.buyer.wallet,f.fill.id);
 expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'9223372036854775799',market_outgoing:'8'});expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
});

it('release is immutable and an ignored duplicate INSERT never repeats its effect',async()=>{
 const f=await fixture();const receipt=await f.releases.release(f.buyer.wallet,f.fill.id);
 for(const query of [conn.sql`update keep_equipment_fill_releases set reason=reason where fill_id=${f.fill.id}`,conn.sql`delete from keep_equipment_fill_releases where fill_id=${f.fill.id}`,conn.sql`truncate keep_equipment_fill_releases`])await expect(query).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_IMMUTABLE'});
 await conn.sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${f.fill.id},'never_prepared') on conflict(fill_id) do nothing`;
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toEqual(receipt);await expectReleased(f);
});

it('read committed and derived timestamps cannot be bypassed by raw inserts or nested services',async()=>{
 const f=await fixture();await expect(conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into keep_equipment_fill_releases(fill_id,reason) values(${f.fill.id},'never_prepared')`;})).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_READ_COMMITTED'});
 await expect(conn.sql`insert into keep_equipment_fill_releases(fill_id,reason,released_at) values(${f.fill.id},'never_prepared',now())`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_DERIVED'});
 await expect(db.transaction(async tx=>{createKeepEquipmentReleases(tx as unknown as typeof db);})).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_TOP_LEVEL'});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();
});

it('sealed custody refuses an old release or market migration and preserves immutable receipts and exact stock',async()=>{
 const f=await fixture();await f.retain();const receipt=await f.releases.release(f.buyer.wallet,f.fill.id);
 // 0245 is refused since D195 (0249) sealed the market; 0249 itself since 0253.
 for(const old of [migration,marketMigration]){
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(old);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toEqual(receipt);await expectReleased(f);
  await conn.sql`select public.shardkeep_divine_fragment_source()`;
 }
});

it('a released genuine signature remains unavailable to Gems in either signature column',async()=>{
 const f=await fixture(),{state}=await f.retain();await f.releases.release(f.buyer.wallet,f.fill.id);
 for(const column of ['payment_signature','tx_signature'])await expect(conn.sql`insert into deposits(id,player_wallet,kind,reference,${conn.sql(column)}) values(${randomUUID()},${f.buyer.wallet},'gems_buy',${randomUUID()},${state.wire!.signature})`).rejects.toMatchObject({message:'PAYMENT_SIGNATURE_ALREADY_CLAIMED'});
 expect(await conn.sql`select consumer_id from payment_signature_claims where signature=${state.wire!.signature}`).toEqual([{consumer_id:f.fill.id}]);await expectReleased(f);
});

it('null, missing and malformed failed proof fields cannot return custody through owner SQL',async()=>{
 const f=await fixture();await f.retain();const receipt=await f.releases.release(f.buyer.wallet,f.fill.id),proof=receipt.proof!;
 for(const field of ['signature','wireSha256','messageSha256','expectedGenesisHash','providerIds','slot','feeLamports','evidenceSha256','outcome','error','paymentAuthorized','rentLamports','paidKeepBaseUnits']){
  const absent:Record<string,unknown>={...proof};delete absent[field];
  for(const value of [absent,{...proof,[field]:null},{...proof,[field]:field==='error'?[]:'invalid'}])await expect(rawRelease(f,'finalized_failed',receipt.signature,value)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_PROOF'});
 }
 const other=await fixture();await other.retain();await expect(rawRelease(other,'finalized_failed',receipt.signature,proof)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_PROOF'});
 await expect(rawRelease(f,'finalized_failed',null,proof)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_PROOF'});await expectReleased(f);
});

it('an accidentally privileged runtime role still cannot author releases or read them as owner',async()=>{
 const f=await fixture(),role='keep_release_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await conn.sql.unsafe(`create role "${role}" login password '${password}'`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to "${role}"; grant select on all tables in schema public to "${role}"; grant insert,update,delete,truncate on keep_equipment_fill_releases to "${role}"`);
  const url=new URL(TEST_DATABASE_URL);url.username=role;url.password=password;runtime=createDb(url.toString(),{max:1});
  await expect(runtime.sql`insert into keep_equipment_fill_releases(fill_id,reason) values(${f.fill.id},'never_prepared')`).rejects.toMatchObject({code:'42501',message:'KEEP_EQUIPMENT_RELEASE_OWNER'});
  await expect(createKeepEquipmentReleases(runtime.db).release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_OWNER'});
 }finally{await runtime?.sql.end();await conn.sql.unsafe(`drop owned by "${role}"; drop role "${role}"`);}
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();
});

it('release beats a still-running preparation and blocks its late bytes from ever being published',async()=>{
 const f=await fixture();let enter!:()=>void,proceed!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{proceed=r;});
 const delayed=f.deps.preparationConnect.map(connect=>(signal:AbortSignal)=>{const rpc=connect(signal);return {...rpc,getLatestBlockhashAndContext:async(options:Parameters<typeof rpc.getLatestBlockhashAndContext>[0])=>{enter();await gate;return rpc.getLatestBlockhashAndContext(options);}};}) as typeof f.deps.preparationConnect;
 const work=createKeepEquipmentPayments(db,{...f.deps,preparationConnect:delayed}).prepare(f.buyer.wallet,f.fill.id);const outcome=work.then(value=>({value}),error=>({error}));await entered;
 try{await f.releases.release(f.buyer.wallet,f.fill.id);}finally{proceed();}
 expect(await outcome).toMatchObject({error:{cause:{message:'KEEP_EQUIPMENT_FILL_RELEASED'}}});await expectReleased(f);
 expect(await conn.sql`select fill_id from keep_equipment_payment_preparations where fill_id=${f.fill.id}`).toHaveLength(0);
});

it('release versus successful delivery serializes one terminal stock effect and blocks later evidence writes',async()=>{
 const f=await fixture(),{p,wire}=await f.retain();const outcomes=await Promise.allSettled([f.releases.release(f.buyer.wallet,f.fill.id),f.payments.recover(f.buyer.wallet,f.fill.id)]);
 expect(outcomes.some(r=>r.status==='fulfilled')).toBe(true);
 const releases=await conn.sql`select fill_id from keep_equipment_fill_releases where fill_id=${f.fill.id}`,deliveries=await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${f.fill.id}`;
 expect(releases.length+deliveries.length).toBe(1);
 if(releases.length){
  await expectReleased(f);const {recordedAt:_at,...raw}=p;
  await expect(conn.sql`insert into keep_equipment_payment_preparations(fill_id,preparation,message_bytes) values(${f.fill.id},${JSON.stringify(raw)}::jsonb,${Buffer.from(p.messageHex,'hex')}) on conflict do nothing`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});
  await expect(conn.sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(wire)}) on conflict do nothing`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});
  expect((await f.payments.recover(f.buyer.wallet,f.fill.id)).status).toBe('released');
  await expect(rawDelivery(f)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});
 }else{
  expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'0',market_outgoing:'8'});expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'2',market_incoming:'0'});
  await expect(f.releases.release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_DELIVERED'});
 }
});


it('a terminal failed release rejects preparation, wire and delivery inserts even when duplicates are ignored',async()=>{
 const f=await fixture(),{p,wire}=await f.retain();await f.releases.release(f.buyer.wallet,f.fill.id);const {recordedAt:_time,...original}=p;
 await expect(conn.sql`insert into keep_equipment_payment_preparations(fill_id,preparation,message_bytes) values(${f.fill.id},${JSON.stringify(original)}::jsonb,${Buffer.from(p.messageHex,'hex')}) on conflict do nothing`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});
 await expect(conn.sql`insert into keep_equipment_payment_wires(fill_id,signed_transaction) values(${f.fill.id},${Buffer.from(wire)}) on conflict do nothing`).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});
 expect((await f.payments.recover(f.buyer.wallet,f.fill.id)).status).toBe('released');
  await expect(rawDelivery(f)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_FILL_RELEASED'});await expectReleased(f);
});

it('an already delivered payment can never release its original sold custody',async()=>{
 const f=await fixture();await f.retain();await f.payments.recover(f.buyer.wallet,f.fill.id);
 await expect(f.releases.release(f.buyer.wallet,f.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_DELIVERED'});
 await expect(rawRelease(f)).rejects.toMatchObject({message:'KEEP_EQUIPMENT_RELEASE_DELIVERED'});
 expect(await f.releases.read(f.buyer.wallet,f.fill.id)).toBeNull();expect(await paymentStock(conn,f.seller.baseId)).toMatchObject({available:'0',market_outgoing:'8'});expect(await paymentStock(conn,f.buyer.baseId)).toMatchObject({available:'2',market_incoming:'0'});
});
