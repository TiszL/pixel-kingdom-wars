/** D195 actual earned fragment source -> HTTP/SQL -> real local SPL -> buyer
 * relisting/cancellation. Private deed, qualification and historical term banks
 * are fixture authority; fragment awards/stock are produced by actual services.
 * Explicit isolated Vitest config only; source wrapper owns its disposable DB. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {MessageV0,VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as MARKET,PHASE_E_POLICY} from '@shardkeep/shared';
import {KeepEquipmentCancellationSchema,KeepEquipmentListingSchema,KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,KeepEquipmentStockViewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {openKeepEquipmentLocal} from './fixtures/keepEquipmentMarketLocal';

it('actual source fragments sell partially for real v0 KEEP credit and burn, coexist with source claims, then relist and return to their original bases',async()=>{
 expect(process.env.PHASE_E_FRAGMENT_LOCAL_FIXTURE).toBe('1');const local=await openKeepEquipmentLocal();let app:FastifyInstance|undefined;
 try{
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_DATABASE_URL',local.databaseUrl);vi.stubEnv('TEST_ADMIN_DATABASE_URL',local.databaseUrl.replace('/shardkeep_test','/postgres'));vi.stubEnv('TEST_REDIS_URL',local.redisUrl);
  for(const flag of ['MULTI_BASE_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_CHARTER_ENABLED','ENABLE_WORKERS'])vi.stubEnv(flag,'false');
  const [{createKeepEquipmentMarketProvider},{buildApp},{TEST_CONFIG},{sessions},{issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC},{withFragmentMarketSource}]=await Promise.all([
   import('../src/game/keepEquipmentMarketProvider'),
   import('../src/app'),import('./helpers'),import('../src/db/schema'),import('../src/auth/session'),import('./fixtures/fragmentMarketSource'),
  ]);
  await withFragmentMarketSource(async source=>{try{
   const {conn,seller,buyer}=source,itemId='crystal_fragment',listed=8n,bought=3n,initialStock=await source.stock(seller.baseId);
   expect(initialStock).toEqual({available:'12',market_outgoing:'0',market_incoming:'0'});expect(await source.stock(buyer.baseId)).toEqual({available:'0',market_outgoing:'0',market_incoming:'0'});
   const sourceState=async()=>({awards:Array.from(await conn.sql`select record from divine_fragment_awards order by event_id,wallet`),settlements:Array.from(await conn.sql`select record from divine_fragment_settlements order by event_id`),deliveries:Array.from(await conn.sql`select record from divine_fragment_deliveries order by id`)});
   const originalSource=await sourceState();await source.assertOriginalSource();
   // Real wall-clock bank polling is separate from immutable gameplay time.
   vi.useRealTimers();const token=await local.tokens(buyer.signer,seller.signer.publicKey,false);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(source.clock());
   const unit=MARKET.minFillBaseUnits+1n,total=bought*unit,sellerCredit=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),burn=total-sellerCredit;
   const config={...TEST_CONFIG,DATABASE_URL:source.f.f.url.toString(),REDIS_URL:local.redisUrl,SOLANA_RPC_URL:local.endpoint,PLAYTEST_OPEN:'true' as const};
   async function cookie(wallet:string){const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)};}
   const sellerCookies=await cookie(seller.wallet),buyerCookies=await cookie(buyer.wallet);let fillId='',retainedHex='',sends=0;
   const deps:KeepEquipmentPaymentDependencies={trust:{transactionVersion:0,expectedGenesisHash:local.genesis,expectedKeepMint:token.mint.toBase58(),providerIds:['owned-bank-one','owned-bank-two'],minContextSlot:1,deadlineMs:10_000,maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000},preparationConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],finalityConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],broadcastConnect:signal=>{const rpc=local.connect(signal);return {getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),sendRawTransaction:async(bytes,options)=>{
    const [saved]=await conn.sql`select signature,encode(signed_transaction,'hex') wire from keep_equipment_payment_wires where fill_id=${fillId}`;expect(saved?.wire).toBe(retainedHex);expect(Buffer.from(bytes).toString('hex')).toBe(retainedHex);
    expect(Array.from(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${saved!.signature}`)).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:fillId}]);expect(options).toMatchObject({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0});sends++;return rpc.sendRawTransaction(bytes,options);
   }}}};
   async function open(payments:KeepEquipmentPaymentDependencies=deps){await app?.close();app=undefined;vi.stubEnv('MULTI_BASE_ENABLED','false');app=await buildApp(config,conn.db,{keepEquipmentMarket:createKeepEquipmentMarketProvider(conn.db,{deedCollection:source.collection,finalizedDeedReader:source.deedReader,payments})});await app.ready();vi.stubEnv('MULTI_BASE_ENABLED','true');}
   async function post(path:string,cookies:Record<string,string>,payload:unknown={}){const r=await app!.inject({method:'POST',url:'/keep-equipment-market'+path,cookies,headers:{'content-type':'application/json'},payload:JSON.stringify(payload)});expect(r.statusCode,r.body).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');return r.json() as unknown;}
   await open();await source.refresh();
   const stockReply=await app!.inject({url:'/keep-equipment-market/stock?baseId='+seller.baseId+'&catalogueVersion=3',cookies:sellerCookies});expect(stockReply.statusCode,stockReply.body).toBe(200);const discovery=KeepEquipmentStockViewSchema.parse(stockReply.json());expect(discovery.items).toHaveLength(12);expect(discovery.items.find(row=>row.itemId===itemId)).toMatchObject({available:'12',reserved:'0',pendingOutput:'0'});
   const listing=KeepEquipmentListingSchema.parse(await post('/listings',sellerCookies,{idempotencyKey:randomUUID(),baseId:seller.baseId,itemId,quantity:listed.toString(),unitPriceBaseUnits:unit.toString()}));
   const reserved=KeepEquipmentPurchaseSchema.parse(await post('/fills',buyerCookies,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:buyer.baseId,quantity:bought.toString()}));fillId=reserved.fill.id;
   expect(await source.stock(seller.baseId)).toEqual({available:'4',market_outgoing:listed.toString(),market_incoming:'0'});expect(await source.stock(buyer.baseId)).toEqual({available:'0',market_outgoing:'0',market_incoming:bought.toString()});
   // An original Seeker source credit must coexist with market holds; buying does
   // not buy the source rights, create a new award, or alter the earning carry.
   const sourceClaim=await source.claimSourceShare(),claimQuantity=BigInt(sourceClaim.quantity);expect(claimQuantity).toBeGreaterThan(0n);
   expect(await source.stock(seller.baseId)).toEqual({available:(4n+claimQuantity).toString(),market_outgoing:listed.toString(),market_incoming:'0'});expect(await sourceState()).toEqual(originalSource);await source.assertOriginalSource();
   const prepared=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/prepare`,buyerCookies)),p=prepared.preparation!;expect(p.original.sellerAtaExists).toBe(false);
   const review=KeepEquipmentReviewSchema.parse(await post(`/fills/${fillId}/review`,buyerCookies));expect(review.current.messageHex).toBe(p.messageHex);
   const transaction=new VersionedTransaction(MessageV0.deserialize(Buffer.from(p.messageHex,'hex')));transaction.sign([buyer.signer]);retainedHex=Buffer.from(transaction.serialize()).toString('hex');
   const retained=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/signed`,buyerCookies,{signedTransactionHex:retainedHex}));expect(retained.status).toBe('signed');
   const sent=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyerCookies));expect(sent.status).toBe('submitted');expect(sends).toBe(1);
   vi.useRealTimers();await local.finalized(retained.wire!.signature,p.lastValidBlockHeight);const raw=await local.connection.getTransaction(retained.wire!.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});expect(raw?.meta?.err).toBeNull();
   const supply=(await local.connection.getTokenSupply(token.mint,'finalized')).value.amount,buyerKeep=(await local.connection.getTokenAccountBalance(token.buyerAta,'finalized')).value.amount,sellerKeep=(await local.connection.getTokenAccountBalance(token.sellerAta,'finalized')).value.amount;
   expect(supply).toBe((token.initial-burn).toString());expect(buyerKeep).toBe((token.initial-total).toString());expect(sellerKeep).toBe(sellerCredit.toString());
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(source.clock());vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await open();
   const delivered=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/recover`,buyerCookies));expect(delivered.status).toBe('delivered');expect(delivered.delivery).toMatchObject({buyerBaseId:buyer.baseId,itemId,quantity:bought.toString(),proof:{sellerBaseUnits:sellerCredit.toString(),burnBaseUnits:burn.toString(),sellerAtaCreated:true}});
   expect(await source.stock(buyer.baseId)).toEqual({available:bought.toString(),market_outgoing:'0',market_incoming:'0'});expect(await source.stock(seller.baseId)).toEqual({available:(4n+claimQuantity).toString(),market_outgoing:(listed-bought).toString(),market_incoming:'0'});
   await open({});expect(await post(`/fills/${fillId}/recover`,buyerCookies)).toEqual(delivered);expect(sends).toBe(1);
   vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');await source.refresh();
   const relisted=KeepEquipmentListingSchema.parse(await post('/listings',buyerCookies,{idempotencyKey:randomUUID(),baseId:buyer.baseId,itemId,quantity:bought.toString(),unitPriceBaseUnits:unit.toString()}));expect(await source.stock(buyer.baseId)).toEqual({available:'0',market_outgoing:bought.toString(),market_incoming:'0'});
   const returned=KeepEquipmentCancellationSchema.parse(await post('/cancellations',buyerCookies,{idempotencyKey:randomUUID(),listingId:relisted.id}));expect(returned.quantity).toBe(bought.toString());expect(await source.stock(buyer.baseId)).toEqual({available:bought.toString(),market_outgoing:'0',market_incoming:'0'});
   const unsold=KeepEquipmentCancellationSchema.parse(await post('/cancellations',sellerCookies,{idempotencyKey:randomUUID(),listingId:listing.id}));expect(unsold.quantity).toBe((listed-bought).toString());expect(await source.stock(seller.baseId)).toEqual({available:(BigInt(initialStock.available)+claimQuantity-bought).toString(),market_outgoing:'0',market_incoming:'0'});
   await source.assertOriginalSource();expect(await sourceState()).toEqual(originalSource);expect(Array.from(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${fillId}`)).toHaveLength(1);expect(Array.from(await conn.sql`select record from seeker_fragment_claims`)).toEqual([{record:sourceClaim}]);
   expect(BigInt((await source.stock(seller.baseId)).available)+BigInt((await source.stock(buyer.baseId)).available)).toBe(BigInt(initialStock.available)+claimQuantity);
   const report={kind:'D195 actual earned fragments and local v0/ATA SPL market through buyer relisting/cancellation',genesis:local.genesis,validatorPid:local.validatorPid,containerName:local.name,twoIndependentProvidersProven:false,deedOwnershipQualificationAndHistoricalTermsUseFixtures:true,sponsorMaterialsUseExistingSourceFixture:true,sourceAward:source.settlement.awards,sourceDelivery:source.delivery,sourceClaim,originalSourceUnchanged:true,initialStock,fillId,signature:retained.wire!.signature,itemId,listedQuantity:listed.toString(),deliveredQuantity:bought.toString(),returnedUnsoldQuantity:unsold.quantity,unitBaseUnits:unit.toString(),totalBaseUnits:total.toString(),sellerCredit:sellerKeep,burn:burn.toString(),initialSupply:token.initial.toString(),finalSupply:supply,buyerKeep,sends,delivered,buyerRelisting:relisted,buyerReturn:returned,finalSellerStock:await source.stock(seller.baseId),finalBuyerStock:await source.stock(buyer.baseId)};
   const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';await writeFile(join(local.directory,'actual-transaction.json'),json(raw));await writeFile(join(local.directory,'fragment-market-report.json'),json(report));console.log(JSON.stringify({report:join(local.directory,'fragment-market-report.json'),fillId,signature:retained.wire!.signature,sellerCredit:sellerKeep,burn:burn.toString(),deliveredQuantity:bought.toString(),sourceClaimQuantity:sourceClaim.quantity,buyerRelistingAndCancellation:true}));
  }finally{await app?.close();app=undefined;}});
 }finally{try{await app?.close();}finally{vi.useRealTimers();vi.unstubAllEnvs();await local.close();console.log(JSON.stringify({ownedResourcesStopped:true,directory:local.directory}));}}
},300000);
