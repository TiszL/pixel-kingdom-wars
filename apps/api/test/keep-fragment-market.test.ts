/** D195 real Divine earning + protected fragment market custody. The payment
 * observations here are private raw-RPC fixtures; real SPL is a separate case. */
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Keypair} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as M} from '@shardkeep/shared';
import type {KeepEquipmentPaymentFailureRpc} from '../../../packages/chain/src/keepEquipmentPaymentFailure';
import {RAW_RESOURCE_STORAGE_MAX as MAX} from '@shardkeep/shared/phaseEResources';
import {createKeepEquipmentListing,reserveKeepEquipmentFill,cancelKeepEquipmentListing} from '../src/game/keepEquipmentMarket';
import {listKeepEquipmentOffers,listKeepEquipmentHistory} from '../src/game/keepEquipmentMarketDiscovery';
import {createKeepEquipmentReleases} from '../src/game/keepEquipmentReleases';
import {createKeepEquipmentPayments} from '../src/game/keepEquipmentPayments';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../src/game/baseOwnership';
import {createSeekerFragmentClaims} from '../src/game/seekerFragmentClaims';
import type {StableBaseMutationContext} from '../src/game/stableBasePrerequisites';
import {runMigrations} from '../src/db/migrate';
import {withDivineFragmentFixture,type DivineFragmentFixture} from './fixtures/divineFragments';
import {paymentFixture,fixtureFee} from './fixtures/keepEquipmentPayments';
async function earned(f:DivineFragmentFixture,buyerEarned=false){
 await f.fragments.enroll(f.event.id);await f.play();const settlement=await f.settle();
 const original=await f.fragments.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId});
 if(buyerEarned)await f.fragments.deliver(f.buyer,f.event.id,{idempotencyKey:randomUUID(),baseId:f.buyerBaseId});
 // Only deed admission is synthetic: all fragments above are actual played awards.
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(f.clock());
 const collection=f.options.deedCollection!,sellerDeed=Keypair.generate().publicKey.toBase58(),owners=new Map([[sellerDeed,f.wallet],[f.f.assetId,f.buyer]]);
 await f.sql`update bases set deed_asset_id=${sellerDeed},land_paid_at=${f.clock().toISOString()} where id=${f.baseId}`;
 const reader=async(asset:string)=>({owner:owners.get(asset)!,collection,slot:5000,frozen:false,delegate:null});
 async function actor(wallet:string,baseId:string,deed:string,signer:Keypair){
  expect(await refreshBaseOwnership(f.db,baseId,reader,collection,f.clock(),'fragment-market-test',f.clock)).toBe('owned');
  const authority:StableBaseMutationContext={baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b,f.clock());}};
  return {wallet,baseId,deed,signer,collection,get now(){return f.clock();},authority};
 }
 const seller=await actor(f.wallet,f.baseId,sellerDeed,f.f.walletSigner),buyer=await actor(f.buyer,f.buyerBaseId,f.f.assetId,f.f.buyerSigner),deps={clock:f.clock,assertAdmission:()=>{}};
 const seeker=createSeekerFragmentClaims(f.db,{...f.options,finalizedDeedReader:reader});
 const stock=async(baseId:string)=>(await f.sql`select available::text,market_outgoing::text,market_incoming::text from crystal_fragment_stocks where base_id=${baseId}`)[0];
 const list=(quantity='12',actor=seller)=>createKeepEquipmentListing(f.db,actor.wallet,{idempotencyKey:randomUUID(),baseId:actor.baseId,itemId:'crystal_fragment',quantity,unitPriceBaseUnits:(M.minFillBaseUnits+1n).toString()},actor.authority,deps);
 const fill=(listingId:string,quantity='2')=>reserveKeepEquipmentFill(f.db,buyer.wallet,{idempotencyKey:randomUUID(),listingId,buyerBaseId:buyer.baseId,quantity},{buyer:buyer.authority,seller:seller.authority},deps);
 return {original,settlement,seller,buyer,deps,seeker,stock,list,fill,owners};
}
it('earned rights become protected base stock, partial sale conserves source, buyer may relist/cancel without buying personal rights',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f),before=(await f.sql`select event_id,wallet,record from divine_fragment_awards order by wallet`);
 const p=await paymentFixture(f.f.conn,0,false,{actors:e,itemId:'crystal_fragment',listingQuantity:'8',fillQuantity:'3'});
 const prepared=await p.payments.prepare(p.buyer.wallet,p.fill.id);p.controls.preparation=prepared.preparation;const wire=p.sign(prepared.preparation!);p.controls.wire=wire;
 await p.payments.retainSigned(p.buyer.wallet,p.fill.id,wire);const [a,b]=await Promise.all([p.payments.recover(p.buyer.wallet,p.fill.id),p.payments.recover(p.buyer.wallet,p.fill.id)]);expect(a).toEqual(b);expect(a?.delivery).toMatchObject({itemId:'crystal_fragment',quantity:'3',buyerBaseId:e.buyer.baseId});
 expect(await e.stock(e.seller.baseId)).toMatchObject({available:'4',market_outgoing:'5',market_incoming:'0'});expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'3',market_incoming:'0'});
 const relisted=await e.list('2',e.buyer);expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'1',market_outgoing:'2'});
 const cmd={idempotencyKey:randomUUID(),listingId:relisted.id};const cancelled=await Promise.all([cancelKeepEquipmentListing(f.db,e.buyer.wallet,cmd,e.buyer.authority,e.deps),cancelKeepEquipmentListing(f.db,e.buyer.wallet,cmd,e.buyer.authority,e.deps)]);expect(cancelled[0]).toEqual(cancelled[1]);expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'3',market_outgoing:'0'});
 expect(await f.sql`select event_id,wallet,record from divine_fragment_awards order by wallet`).toEqual(before);
 await expect(f.fragments.deliver(e.buyer.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:e.seller.baseId})).rejects.toThrow();
 expect(await createKeepEquipmentPayments(f.db).recover(e.buyer.wallet,p.fill.id)).toEqual(a);
}),120000);
it('incoming into already earned stock and concurrent Seeker top-up preserve strict before-insert conservation and original rights',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f,true),offer=await e.list('8'),termId=e.settlement!.term!.snapshot.termId;
 const result=await Promise.all([e.fill(offer.id,'3'),e.seeker.claim(e.buyer.wallet,{idempotencyKey:randomUUID(),baseId:e.buyer.baseId,termId,spotId:1}),e.seeker.claim(e.seller.wallet,{idempotencyKey:randomUUID(),baseId:e.seller.baseId,termId,spotId:0})]);
 expect(await e.stock(e.seller.baseId)).toMatchObject({available:'6',market_outgoing:'8'});expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'14',market_incoming:'3'});
 const release=createKeepEquipmentReleases(f.db),receipts=await Promise.all([release.release(e.buyer.wallet,result[0].id),release.release(e.buyer.wallet,result[0].id)]);expect(receipts[0]).toEqual(receipts[1]);
 expect(await e.stock(e.seller.baseId)).toMatchObject({available:'9',market_outgoing:'5'});expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'14',market_incoming:'0'});
 expect(await f.sql`select * from seeker_fragment_claims`).toHaveLength(2);
}),120000);
it('concurrent listing/fill races, unsold cancellation and transferred-base release preserve one original stock',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f),listings=await Promise.allSettled([e.list('8'),e.list('8')]);expect(listings.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const offer=(listings.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof e.list>>>).value;
 const fills=await Promise.allSettled([e.fill(offer.id,'5'),e.fill(offer.id,'5')]);expect(fills.filter(r=>r.status==='fulfilled')).toHaveLength(1);const fill=(fills.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof e.fill>>>).value;
 await cancelKeepEquipmentListing(f.db,e.seller.wallet,{idempotencyKey:randomUUID(),listingId:offer.id},e.seller.authority,e.deps);
 for(const actor of [e.seller,e.buyer]){const wallet=Keypair.generate().publicKey.toBase58();await f.sql`insert into players(wallet) values(${wallet})`;e.owners.set(actor.deed,wallet);expect(await refreshBaseOwnership(f.db,actor.baseId,async()=>({owner:wallet,collection:actor.collection,slot:10000,frozen:false,delegate:null}),actor.collection,f.clock(),'fragment-market-transfer',f.clock)).toBe('mismatch');}
 await createKeepEquipmentReleases(f.db).release(e.buyer.wallet,fill.id);
 expect(await e.stock(e.seller.baseId)).toMatchObject({available:'12',market_outgoing:'0'});expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
 await expect(e.list()).rejects.toMatchObject({code:'DEED_OWNERSHIP_CHANGED'});
}),120000);
it('untrusted stock writers, identity/deletion/truncation, broken custody seals and old migrations cannot create fragment value',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f),offer=await e.list('8');await e.fill(offer.id,'3');
 for(const query of ["update crystal_fragment_stocks set available=available+1","update crystal_fragment_stocks set market_outgoing=0","update crystal_fragment_stocks set market_incoming=0","update crystal_fragment_stocks set available=9223372036854775807","delete from crystal_fragment_stocks","truncate crystal_fragment_stocks","update divine_fragment_market_contract set record='{}'","delete from divine_fragment_market_contract","truncate divine_fragment_market_contract"])
  await expect(f.sql.begin(async tx=>{await tx`set constraints all immediate`;await tx.unsafe(query);})).rejects.toThrow();
 await expect(f.sql`update crystal_fragment_stocks set base_id=${randomUUID()} where base_id=${e.seller.baseId}`).rejects.toThrow('DIVINE_FRAGMENT_STOCK_IDENTITY');
 await expect(f.sql`insert into crystal_fragment_stocks(base_id,available) values(${e.seller.baseId},0) on conflict do nothing`).rejects.toThrow('DIVINE_FRAGMENT_STOCK_CONSERVATION');
 for(const table of ['keep_equipment_listings','keep_equipment_deliveries','keep_equipment_fill_releases'])await expect(f.sql.begin(async tx=>{await tx.unsafe(`alter table ${table} disable trigger all`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 const old=await readFile(new URL('../drizzle/0248_keep_crafting_market.sql',import.meta.url),'utf8');await expect(f.sql.begin(async tx=>{await tx.unsafe(old);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow();
 const migration=await readFile(new URL('../drizzle/0249_keep_fragment_market.sql',import.meta.url),'utf8'),before=await e.stock(e.seller.baseId);
 // D153.199's prospective mining seal retains the old row but makes a downgrade
 // fail closed: rerunning0249 must not remove protected contribution custody.
 await expect(f.sql.begin(tx=>tx.unsafe(migration))).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 // 0254 was the current migration when this case was written. Its successors
 // (0259-0283) replaced the Divine fragment source and guarded bodies, so a
 // direct 0254 re-run is now the same refused downgrade (mining-funded-v2 pins
 // it too). Replaying the current journal applies nothing and keeps the stock.
 const superseded=await readFile(new URL('../drizzle/0254_mining_resource_publication.sql',import.meta.url),'utf8');
 await expect(f.sql.begin(tx=>tx.unsafe(superseded))).rejects.toMatchObject({code:'P0001',message:'DIVINE_FRAGMENT_SOURCE'});expect(await e.stock(e.seller.baseId)).toEqual(before);
 await runMigrations(f.db);expect(await e.stock(e.seller.baseId)).toEqual(before);await f.sql`select public.shardkeep_divine_fragment_source()`;
 const [capacity]=await f.sql`select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='crystal_fragment_stocks'::regclass and conname='crystal_fragment_market_capacity_ck'`;expect(capacity!.definition).toContain('market_incoming');expect(capacity!.definition).toContain('market_outgoing');expect(capacity!.definition).toContain(MAX.toString());
 // Exercise the exact table constraint at int64 edges on a temporary probe.
 // No earned inventory or provenance is seeded, and no live guard is disabled.
 await f.sql.begin(async tx=>{await tx`create temporary table fragment_capacity_probe(like public.crystal_fragment_stocks including constraints including defaults) on commit drop`;await tx`insert into fragment_capacity_probe(base_id,available,market_outgoing,market_incoming) values(${randomUUID()},${(MAX-2n).toString()}::bigint,1,1)`;});
 for(const [available,outgoing,incoming] of [[MAX-1n,1n,1n],[0n,MAX,1n],[0n,1n,MAX]])await expect(f.sql.begin(async tx=>{await tx`create temporary table fragment_capacity_probe(like public.crystal_fragment_stocks including constraints including defaults) on commit drop`;await tx`insert into fragment_capacity_probe(base_id,available,market_outgoing,market_incoming) values(${randomUUID()},${available!.toString()}::bigint,${outgoing!.toString()}::bigint,${incoming!.toString()}::bigint)`;})).rejects.toThrow('crystal_fragment_market_capacity_ck');
 const role='fragment_market_'+randomUUID().replaceAll('-','');await f.sql.unsafe(`create role ${role} noinherit`);
 try{await expect(f.sql.begin(async tx=>{await tx.unsafe(`grant usage on schema public to ${role}`);await tx.unsafe(`grant select,insert,update on crystal_fragment_stocks,keep_equipment_listings to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`update crystal_fragment_stocks set available=available+1 where base_id=${e.seller.baseId}`;})).rejects.toThrow();}finally{await f.sql.unsafe(`drop owned by ${role}`);await f.sql.unsafe(`drop role ${role}`);}
}),120000);
it('fragment discovery opt-in filters before paging and preserves old catalogue/history identities',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f),offer=await e.list('2');
 for(const catalogueVersion of [undefined,'2']){expect((await listKeepEquipmentOffers(f.db,catalogueVersion?{catalogueVersion}:{})).items.some(x=>x.id===offer.id)).toBe(false);expect((await listKeepEquipmentHistory(f.db,e.seller.wallet,catalogueVersion?{catalogueVersion}:{})).items).toHaveLength(0);}
 expect((await listKeepEquipmentOffers(f.db,{catalogueVersion:'3',category:'resources',itemId:'crystal_fragment'})).items.map(x=>x.id)).toEqual([offer.id]);expect((await listKeepEquipmentHistory(f.db,e.seller.wallet,{catalogueVersion:'3',category:'resources'})).items.map(x=>x.id)).toEqual([offer.id]);expect((await listKeepEquipmentOffers(f.db,{catalogueVersion:'3',category:'items'})).items).toHaveLength(0);
}),120000);

it('prepared uncertainty stays held and only exact retained finalized failure releases original fragment custody',async()=>withDivineFragmentFixture(async f=>{
 const e=await earned(f),p=await paymentFixture(f.f.conn,0,false,{actors:e,itemId:'crystal_fragment',listingQuantity:'8',fillQuantity:'3'});
 const prepared=await p.prepare();await expect(createKeepEquipmentReleases(f.db).release(e.buyer.wallet,p.fill.id)).rejects.toMatchObject({code:'KEEP_EQUIPMENT_RELEASE_PREPARED'});
 p.controls.wire=p.sign(prepared);await p.payments.retainSigned(e.buyer.wallet,p.fill.id,p.controls.wire);let finalized=false;
 const failureConnect=p.deps.finalityConnect.map(connect=>(signal:AbortSignal):KeepEquipmentPaymentFailureRpc=>{const source=connect(signal);return {...source,getTransaction:async(signature,options)=>{if(!finalized)return null;const tx=await source.getTransaction(signature,options);if(!tx)return null;tx.meta!.err={InstructionError:[0,'InvalidArgument']};tx.meta!.fee=fixtureFee;tx.meta!.postBalances=tx.meta!.preBalances.map((n,i)=>n-(i===0?fixtureFee:0));tx.meta!.postTokenBalances=structuredClone(tx.meta!.preTokenBalances!);tx.meta!.innerInstructions=[];return tx;}};}) as [(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc,(signal:AbortSignal)=>KeepEquipmentPaymentFailureRpc];
 const releases=createKeepEquipmentReleases(f.db,{trust:p.trust,failureConnect});await expect(releases.release(e.buyer.wallet,p.fill.id)).rejects.toThrow();expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'0',market_incoming:'3'});
 finalized=true;const receipts=await Promise.all([releases.release(e.buyer.wallet,p.fill.id),releases.release(e.buyer.wallet,p.fill.id)]);expect(receipts[0]).toEqual(receipts[1]);expect(receipts[0]).toMatchObject({reason:'finalized_failed',proof:{paidKeepBaseUnits:'0'}});
 expect(await e.stock(e.seller.baseId)).toMatchObject({available:'7',market_outgoing:'5'});expect(await e.stock(e.buyer.baseId)).toMatchObject({available:'0',market_incoming:'0'});
 expect(await f.sql`select * from payment_signature_claims where signature=${receipts[0]!.signature!}`).toHaveLength(1);expect(await f.sql`select * from keep_equipment_deliveries where fill_id=${p.fill.id}`).toHaveLength(0);
}),120000);
