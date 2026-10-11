/** D194 actual earned source -> HTTP/SQL -> real local SPL -> buyer craft/trip.
 * Explicit isolated Vitest config, no default/global DB setup. Source Deed and
 * historical term banks are declared fixtures, never production authority. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {MessageV0,VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as MARKET,PHASE_E_POLICY} from '@shardkeep/shared';
import {ORDINARY_CRAFTING_ITEM_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {KeepEquipmentListingSchema,KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,KeepEquipmentStockViewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {openKeepEquipmentLocal} from './fixtures/keepEquipmentMarketLocal';

it('actual v0/ATA refined partial sale credits and burns KEEP, then buyer crafts and uses a Compass from the delivered material',async()=>{
 expect(process.env.PHASE_E_CRAFTING_LOCAL_FIXTURE).toBe('1');const local=await openKeepEquipmentLocal();let app:FastifyInstance|undefined,closeDb:(()=>Promise<void>)|undefined;
 try{
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_DATABASE_URL',local.databaseUrl);vi.stubEnv('TEST_ADMIN_DATABASE_URL',local.databaseUrl.replace('/shardkeep_test','/postgres'));vi.stubEnv('TEST_REDIS_URL',local.redisUrl);
  for(const flag of ['MULTI_BASE_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_CHARTER_ENABLED','ENABLE_WORKERS'])vi.stubEnv(flag,'false');
  const [{createKeepEquipmentMarketProvider},{createDb},{runMigrations},{bootstrapEconomyAllocations},{buildApp},{TEST_CONFIG},{sessions},{issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC},{craftingMarketSource}]=await Promise.all([
   import('../src/game/keepEquipmentMarketProvider'),
   import('../src/db/client'),import('../src/db/migrate'),import('../src/ledger'),import('../src/app'),import('./helpers'),import('../src/db/schema'),import('../src/auth/session'),import('./fixtures/craftingMarketSource'),
  ]);
  const conn=createDb(local.databaseUrl,{max:8,legacyTestEscape:true});closeDb=()=>conn.sql.end();await runMigrations(conn.db);await bootstrapEconomyAllocations(conn.db);
  const source=await craftingMarketSource(conn),{seller,buyer}=source;
  const initialStocks=Array.from(await source.stock(seller.baseId));expect(initialStocks.map(r=>r.item_id).sort()).toEqual([...ORDINARY_CRAFTING_ITEM_IDS].sort());expect(initialStocks.every(r=>BigInt(r.available)>0n&&r.pending_output==='0')).toBe(true);
  const itemId='prismstone_lens',needed=BigInt(source.compass.inputs.find(i=>i.itemId===itemId)!.quantity),sourceStock=BigInt(initialStocks.find(r=>r.item_id===itemId)!.available);
  expect(sourceStock).toBeGreaterThan(needed);expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)?.available??'0').toBe('0');
  // Owned bank polling uses real wall time; the source helper's clock remains
  // immutable and is restored before every application/gameplay operation.
  vi.useRealTimers();const token=await local.tokens(buyer.signer,seller.signer.publicKey,false);vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(source.clock());
  const unit=MARKET.minFillBaseUnits+1n,total=needed*unit,sellerCredit=total*BigInt(PHASE_E_POLICY.taxes.keepMarket.sellerBps)/BigInt(PHASE_E_POLICY.basisPoints),burn=total-sellerCredit;
  const config={...TEST_CONFIG,DATABASE_URL:local.databaseUrl,REDIS_URL:local.redisUrl,SOLANA_RPC_URL:local.endpoint,PLAYTEST_OPEN:'true' as const};
  async function cookie(wallet:string){const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(config,wallet,session!.id)};}
  const sellerCookies=await cookie(seller.wallet),buyerCookies=await cookie(buyer.wallet);let fillId='',retainedHex='',sends=0;
  const deps:KeepEquipmentPaymentDependencies={trust:{transactionVersion:0,expectedGenesisHash:local.genesis,expectedKeepMint:token.mint.toBase58(),providerIds:['owned-bank-one','owned-bank-two'],minContextSlot:1,deadlineMs:10_000,maxFeeLamports:100_000n,maxPriorityFeeLamports:0n,maxComputeUnitLimit:300_000},preparationConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],finalityConnect:[signal=>local.connect(signal),signal=>local.connect(signal)],broadcastConnect:signal=>{const rpc=local.connect(signal);return {getGenesisHash:()=>rpc.getGenesisHash(),getSlot:c=>rpc.getSlot(c),sendRawTransaction:async(bytes,options)=>{
   const [saved]=await conn.sql`select signature,encode(signed_transaction,'hex') wire from keep_equipment_payment_wires where fill_id=${fillId}`;expect(saved?.wire).toBe(retainedHex);expect(Buffer.from(bytes).toString('hex')).toBe(retainedHex);
   expect(Array.from(await conn.sql`select consumer_kind,consumer_id from payment_signature_claims where signature=${saved!.signature}`)).toEqual([{consumer_kind:'keep_equipment_market',consumer_id:fillId}]);expect(options).toMatchObject({skipPreflight:false,preflightCommitment:'finalized',maxRetries:0});sends++;return rpc.sendRawTransaction(bytes,options);
  }}}};
  async function open(payments:KeepEquipmentPaymentDependencies=deps){await app?.close();app=undefined;vi.stubEnv('MULTI_BASE_ENABLED','false');app=await buildApp(config,conn.db,{keepEquipmentMarket:createKeepEquipmentMarketProvider(conn.db,{deedCollection:source.collection,finalizedDeedReader:source.deedReader,payments})});await app.ready();vi.stubEnv('MULTI_BASE_ENABLED','true');}
  async function post(path:string,cookies:Record<string,string>,payload:unknown={}){const r=await app!.inject({method:'POST',url:'/keep-equipment-market'+path,cookies,headers:{'content-type':'application/json'},payload:JSON.stringify(payload)});expect(r.statusCode,r.body).toBe(200);expect(r.headers['cache-control']).toBe('private, no-store');return r.json() as unknown;}
  await open();await source.refresh();
  const stockReply=await app!.inject({url:'/keep-equipment-market/stock?baseId='+seller.baseId+'&catalogueVersion=2',cookies:sellerCookies});expect(stockReply.statusCode,stockReply.body).toBe(200);expect(KeepEquipmentStockViewSchema.parse(stockReply.json()).items).toHaveLength(11);
  const listing=KeepEquipmentListingSchema.parse(await post('/listings',sellerCookies,{idempotencyKey:randomUUID(),baseId:seller.baseId,itemId,quantity:sourceStock.toString(),unitPriceBaseUnits:unit.toString()}));
  const reserved=KeepEquipmentPurchaseSchema.parse(await post('/fills',buyerCookies,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:buyer.baseId,quantity:needed.toString()}));fillId=reserved.fill.id;
  expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:'0',market_incoming:needed.toString()});
  const prepared=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/prepare`,buyerCookies)),p=prepared.preparation!;expect(p.original.sellerAtaExists).toBe(false);
  const review=KeepEquipmentReviewSchema.parse(await post(`/fills/${fillId}/review`,buyerCookies));expect(review.current.messageHex).toBe(p.messageHex);
  const transaction=new VersionedTransaction(MessageV0.deserialize(Buffer.from(p.messageHex,'hex')));transaction.sign([buyer.signer]);retainedHex=Buffer.from(transaction.serialize()).toString('hex');
  const retained=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/signed`,buyerCookies,{signedTransactionHex:retainedHex}));expect(retained.status).toBe('signed');
  const sent=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyerCookies));expect(sent.status).toBe('submitted');expect(sends).toBe(1);
  vi.useRealTimers();await local.finalized(retained.wire!.signature,p.lastValidBlockHeight);const raw=await local.connection.getTransaction(retained.wire!.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});expect(raw?.meta?.err).toBeNull();
  const supply=(await local.connection.getTokenSupply(token.mint,'finalized')).value.amount,buyerKeep=(await local.connection.getTokenAccountBalance(token.buyerAta,'finalized')).value.amount,sellerKeep=(await local.connection.getTokenAccountBalance(token.sellerAta,'finalized')).value.amount;
  expect(supply).toBe((token.initial-burn).toString());expect(buyerKeep).toBe((token.initial-total).toString());expect(sellerKeep).toBe(sellerCredit.toString());
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(source.clock());vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await open();
  const delivered=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/recover`,buyerCookies));expect(delivered.status).toBe('delivered');expect(delivered.delivery).toMatchObject({buyerBaseId:buyer.baseId,itemId,quantity:needed.toString(),proof:{sellerBaseUnits:sellerCredit.toString(),burnBaseUnits:burn.toString(),sellerAtaCreated:true}});
  expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:needed.toString(),market_incoming:'0'});
  await open({});expect(await post(`/fills/${fillId}/recover`,buyerCookies)).toEqual(delivered);expect(sends).toBe(1);
  const used=await source.buyerUsesPurchasedMaterials();expect(used.trip.routeSnapshot.fitting).toMatchObject({itemId:'route_compass'});expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)?.available).toBe('0');
  expect(Array.from(await conn.sql`select available::text,reserved::text from ordinary_equipment_stocks where base_id=${buyer.baseId} and item_id='route_compass'`)).toEqual([{available:'1',reserved:'0'}]);
  expect((await source.stock(seller.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:'0',market_outgoing:(sourceStock-needed).toString()});
  const sourceJobs=Array.from(await conn.sql`select recipe_id,quantity,output_item_id,output_quantity::text,completed_at from ordinary_crafting_jobs where base_id in (${seller.baseId},${buyer.baseId}) order by base_id,recipe_id`);
  expect(sourceJobs).toHaveLength(10);expect(sourceJobs.every(r=>r.completed_at)).toBe(true);expect(sourceJobs.filter(r=>r.recipe_id==='craft_navigation_kit')).toHaveLength(1);
  const returnCount=(await conn.sql`select count(*)::int n from starter_expedition_returns r join starter_expeditions e on e.id=r.expedition_id where e.base_id in (${seller.baseId},${buyer.baseId})`)[0]!.n;expect(returnCount).toBeGreaterThan(0);
  const deliveries=Array.from(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${fillId}`);expect(deliveries).toHaveLength(1);
  const report={kind:'D194 actual earned/refined source and local v0/ATA SPL market through buyer craft/fitted return',genesis:local.genesis,validatorPid:local.validatorPid,containerName:local.name,twoIndependentProvidersProven:false,deedOwnershipAndHistoricalTermsUseFixtures:true,initialStocks,sourceJobs,rawReturnCount:returnCount,fillId,signature:retained.wire!.signature,itemId,listedQuantity:sourceStock.toString(),deliveredAndConsumedQuantity:needed.toString(),unsoldHeldQuantity:(sourceStock-needed).toString(),unitBaseUnits:unit.toString(),totalBaseUnits:total.toString(),sellerCredit:sellerKeep,burn:burn.toString(),initialSupply:token.initial.toString(),finalSupply:supply,buyerKeep,sends,delivered,originalBuyerCraft:used.craft,originalFittedTrip:used.trip,originalReturn:used.returned,finalSellerStock:Array.from(await source.stock(seller.baseId)),finalBuyerStock:Array.from(await source.stock(buyer.baseId))};
  const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';await writeFile(join(local.directory,'actual-transaction.json'),json(raw));await writeFile(join(local.directory,'crafting-market-report.json'),json(report));console.log(JSON.stringify({report:join(local.directory,'crafting-market-report.json'),fillId,signature:retained.wire!.signature,sellerCredit:sellerKeep,burn:burn.toString(),rawReturnCount:returnCount,sourceJobs:sourceJobs.length,actualBuyerFittedReturn:true}));
 }finally{try{await app?.close();}finally{try{await closeDb?.();}finally{vi.useRealTimers();vi.unstubAllEnvs();await local.close();console.log(JSON.stringify({ownedResourcesStopped:true,directory:local.directory}));}}}
},300000);
