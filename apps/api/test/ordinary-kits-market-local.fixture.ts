/** D153.208 actual earned source -> HTTP/SQL -> real local SPL -> buyer kit commitment.
 * Explicit isolated Vitest config, no default/global DB setup. Source Deed and
 * historical term banks are declared fixtures, never production authority. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {readOrdinaryCraftingEnvelope} from '../src/game/ordinaryCraftingView';
import {join} from 'node:path';
import {MessageV0,VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import type {FastifyInstance} from 'fastify';
import type {KeepEquipmentPaymentDependencies} from '../src/game/keepEquipmentPayments';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as MARKET,PHASE_E_POLICY,PHASE_E_MINING_SCORE_POLICY as SCORE,BUILD_COSTS,BuildingType} from '@shardkeep/shared';
import {KeepEquipmentListingSchema,KeepEquipmentPurchaseSchema,KeepEquipmentReviewSchema,KeepEquipmentSendSchema,KeepEquipmentStockViewSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import type {MiningContributionRequest} from '@shardkeep/shared/miningContributionApi';
import {and,eq} from 'drizzle-orm';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
import {reserveMiningContribution,readMiningContribution} from '../src/game/miningContributions';
import {buildings,builderJobs,bases} from '../src/db/schema';
import {openKeepEquipmentLocal} from './fixtures/keepEquipmentMarketLocal';

it('actual earned Expedition Kit partial sale burns exact KEEP and commits only the delivered kit under future mining3',async()=>{
 expect(process.env.PHASE_E_ORDINARY_KITS_LOCAL_FIXTURE).toBe('1');const local=await openKeepEquipmentLocal();let app:FastifyInstance|undefined,closeDb:(()=>Promise<void>)|undefined;
 try{
  vi.stubEnv('NODE_ENV','test');vi.stubEnv('TEST_DATABASE_URL',local.databaseUrl);vi.stubEnv('TEST_ADMIN_DATABASE_URL',local.databaseUrl.replace('/shardkeep_test','/postgres'));vi.stubEnv('TEST_REDIS_URL',local.redisUrl);
  for(const flag of ['MULTI_BASE_ENABLED','KEEP_EQUIPMENT_MARKET_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_MINING_ENABLED','PHASE_E_SEEKER_ENABLED','PHASE_E_VEHICLES_ENABLED','PHASE_E_CHARTER_ENABLED','ENABLE_WORKERS'])vi.stubEnv(flag,'false');
  const [{createKeepEquipmentMarketProvider},{createDb},{runMigrations},{bootstrapEconomyAllocations},{buildApp},{TEST_CONFIG},{sessions},{issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC},{ordinaryKitsSource}]=await Promise.all([
   import('../src/game/keepEquipmentMarketProvider'),
   import('../src/db/client'),import('../src/db/migrate'),import('../src/ledger'),import('../src/app'),import('./helpers'),import('../src/db/schema'),import('../src/auth/session'),import('./fixtures/ordinaryKitsSource'),
  ]);
  const conn=createDb(local.databaseUrl,{max:8,legacyTestEscape:true});closeDb=()=>conn.sql.end();await runMigrations(conn.db);await bootstrapEconomyAllocations(conn.db);
  const source=await ordinaryKitsSource(conn),{seller,buyer}=source;
  const initialStocks=Array.from(await source.stock(seller.baseId));expect(initialStocks.filter(r=>['climate_kit','expedition_kit'].includes(r.item_id)).map(r=>r.available)).toEqual(['2','2']);expect(initialStocks.every(r=>r.pending_output==='0')).toBe(true);
  const itemId='expedition_kit',needed=1n,sourceStock=BigInt(initialStocks.find(r=>r.item_id===itemId)!.available);
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
  const stockReply=await app!.inject({url:'/keep-equipment-market/stock?baseId='+seller.baseId+'&catalogueVersion=4',cookies:sellerCookies});expect(stockReply.statusCode,stockReply.body).toBe(200);expect(KeepEquipmentStockViewSchema.parse(stockReply.json()).items).toHaveLength(14);
  const listing=KeepEquipmentListingSchema.parse(await post('/listings',sellerCookies,{idempotencyKey:randomUUID(),baseId:seller.baseId,itemId,quantity:sourceStock.toString(),unitPriceBaseUnits:unit.toString()}));
  const reserved=KeepEquipmentPurchaseSchema.parse(await post('/fills',buyerCookies,{idempotencyKey:randomUUID(),listingId:listing.id,buyerBaseId:buyer.baseId,quantity:needed.toString()}));fillId=reserved.fill.id;
  expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:'0',market_incoming:needed.toString()});
  const prepared=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/prepare`,buyerCookies)),p=prepared.preparation!;expect(p.original.sellerAtaExists).toBe(false);
  const review=KeepEquipmentReviewSchema.parse(await post(`/fills/${fillId}/review`,buyerCookies));expect(review.current.messageHex).toBe(p.messageHex);
  const transaction=new VersionedTransaction(MessageV0.deserialize(Buffer.from(p.messageHex,'hex')));transaction.sign([buyer.signer]);retainedHex=Buffer.from(transaction.serialize()).toString('hex');
  const retained=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/signed`,buyerCookies,{signedTransactionHex:retainedHex}));expect(retained.status).toBe('signed');
  const sent=KeepEquipmentSendSchema.parse(await post(`/fills/${fillId}/deliver`,buyerCookies));expect(sent.status).toBe('submitted');expect(sends).toBe(1);
  vi.useRealTimers();await local.finalized(retained.wire!.signature,p.lastValidBlockHeight);const raw=await local.connection.getTransaction(retained.wire!.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});expect(raw?.meta?.err).toBeNull();await writeFile(join(local.directory,'actual-transaction.json'),JSON.stringify(raw,null,2));
  const supply=(await local.connection.getTokenSupply(token.mint,'finalized')).value.amount,buyerKeep=(await local.connection.getTokenAccountBalance(token.buyerAta,'finalized')).value.amount,sellerKeep=(await local.connection.getTokenAccountBalance(token.sellerAta,'finalized')).value.amount;
  expect(supply).toBe((token.initial-burn).toString());expect(buyerKeep).toBe((token.initial-total).toString());expect(sellerKeep).toBe(sellerCredit.toString());
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(source.clock());vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','false');await open();
  const delivered=KeepEquipmentPurchaseSchema.parse(await post(`/fills/${fillId}/recover`,buyerCookies));expect(delivered.status).toBe('delivered');expect(delivered.delivery).toMatchObject({buyerBaseId:buyer.baseId,itemId,quantity:needed.toString(),proof:{sellerBaseUnits:sellerCredit.toString(),burnBaseUnits:burn.toString(),sellerAtaCreated:true}});
  expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:needed.toString(),market_incoming:'0'});
  await open({});expect(await post(`/fills/${fillId}/recover`,buyerCookies)).toEqual(delivered);expect(sends).toBe(1);
  vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');await source.refresh();
  const buyerStockReply=await app!.inject({url:'/keep-equipment-market/stock?baseId='+buyer.baseId+'&catalogueVersion=4',cookies:buyerCookies});expect(buyerStockReply.statusCode,buyerStockReply.body).toBe(200);KeepEquipmentStockViewSchema.parse(buyerStockReply.json());
  const originalRecipes=await Promise.all(source.receipts.map(p=>readOrdinaryCraftingEnvelope(conn.db,seller.wallet,p.job.id)));
  const [legacyJob]=await conn.sql`select id from ordinary_crafting_jobs where base_id=${seller.baseId} and recipe_version=1 order by started_at,id limit 1`;
  const legacyRecipe=await readOrdinaryCraftingEnvelope(conn.db,seller.wallet,legacyJob!.id);
  await writeFile('/tmp/ordinary-kits-market-http-pair.json',JSON.stringify({scope:'actual earned kit sale through authenticated API and finalized SPL',sellerStock:stockReply.json(),buyerStock:buyerStockReply.json(),delivered,originalRecipes,legacyRecipe},null,2));

  // Install the private immutable future policy before entering that day.
  // Existing fixture facilities are prerequisites; no kit or SHARDS stock is seeded.
  const [future]=await conn.sql`select ((clock_timestamp() at time zone 'UTC')::date+1)::text first_day`; 
  const cutover=await installResourceMiningV3Cutover(conn.db,future!.first_day);source.advance(new Date(cutover.firstDay+'T01:00:00.000Z'));await source.refresh();
  await conn.db.update(bases).set({keepLevel:SCORE.requiredLevel.keep}).where(eq(bases.id,buyer.baseId));
  await conn.db.update(buildings).set({level:SCORE.requiredLevel.workshop}).where(and(eq(buildings.baseId,buyer.baseId),eq(buildings.type,BuildingType.Workshop)));
  for(const [index,type] of [BuildingType.Keep,BuildingType.GoldForge].entries()){
   const level=type===BuildingType.Keep?SCORE.requiredLevel.keep:SCORE.requiredLevel.goldforge;
   const [building]=await conn.db.insert(buildings).values({baseId:buyer.baseId,playerWallet:buyer.wallet,type,level,tx:17+index*3,ty:2}).returning();
   if(type===BuildingType.GoldForge){const completedAt=new Date(+source.clock()-1000);await conn.db.insert(builderJobs).values({baseId:buyer.baseId,playerWallet:buyer.wallet,buildingId:building!.id,kind:'build',startedAt:new Date(+completedAt-BUILD_COSTS.goldforge.buildSec*1000),finishesAt:completedAt,completedAt});}
  }
  vi.stubEnv('PHASE_E_CATALOG_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  const request:MiningContributionRequest={idempotencyKey:randomUUID(),baseId:buyer.baseId,policyVersion:3 as const,expectedDay:cutover.firstDay,lines:[{resourceId:itemId,quantity:needed.toString()}]};
  const commitment=await reserveMiningContribution(conn.db,buyer.wallet,request,buyer.authority,{clock:source.clock});expect(commitment.status).toBe('accepted');
  expect((await source.stock(buyer.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:'0',market_incoming:'0',mining_pending:needed.toString()});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await readMiningContribution(conn.db,buyer.wallet,request.idempotencyKey,source.clock())).toEqual(commitment);
  expect((await source.stock(seller.baseId)).find(r=>r.item_id===itemId)).toMatchObject({available:'0',market_outgoing:(sourceStock-needed).toString()});
  const sourceJobs=Array.from(await conn.sql`select recipe_id,quantity,output_item_id,output_quantity::text,completed_at from ordinary_crafting_jobs where base_id in (${seller.baseId},${buyer.baseId}) order by base_id,recipe_id`);
  expect(sourceJobs).toHaveLength(6);expect(sourceJobs.every(r=>r.completed_at)).toBe(true);expect(sourceJobs.filter(r=>['craft_climate_kit','craft_expedition_kit'].includes(r.recipe_id))).toHaveLength(2);
  const returnCount=(await conn.sql`select count(*)::int n from starter_expedition_returns r join starter_expeditions e on e.id=r.expedition_id where e.base_id in (${seller.baseId},${buyer.baseId})`)[0]!.n;expect(returnCount).toBeGreaterThan(0);
  const deliveries=Array.from(await conn.sql`select fill_id from keep_equipment_deliveries where fill_id=${fillId}`);expect(deliveries).toHaveLength(1);
  const report={kind:'D153.208 earned kit and actual v0/ATA SPL partial sale into prospective v3 kit custody',genesis:local.genesis,validatorPid:local.validatorPid,containerName:local.name,twoIndependentProvidersProven:false,deedOwnershipAndHistoricalTermsUseFixtures:true,initialStocks,sourceJobs,rawReturnCount:returnCount,fillId,signature:retained.wire!.signature,itemId,listedQuantity:sourceStock.toString(),deliveredAndCommittedQuantity:needed.toString(),unsoldHeldQuantity:(sourceStock-needed).toString(),unitBaseUnits:unit.toString(),totalBaseUnits:total.toString(),sellerCredit:sellerKeep,burn:burn.toString(),initialSupply:token.initial.toString(),finalSupply:supply,buyerKeep,sends,delivered,cutover,commitment,finalSellerStock:Array.from(await source.stock(seller.baseId)),finalBuyerStock:Array.from(await source.stock(buyer.baseId))};
  const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';await writeFile(join(local.directory,'actual-transaction.json'),json(raw));await writeFile(join(local.directory,'ordinary-kits-market-report.json'),json(report));console.log(JSON.stringify({report:join(local.directory,'ordinary-kits-market-report.json'),fillId,signature:retained.wire!.signature,sellerCredit:sellerKeep,burn:burn.toString(),rawReturnCount:returnCount,sourceJobs:sourceJobs.length,actualBuyerKitCommitted:true}));
 }finally{try{await app?.close();}finally{try{await closeDb?.();}finally{vi.useRealTimers();vi.unstubAllEnvs();await local.close();console.log(JSON.stringify({ownedResourcesStopped:true,directory:local.directory}));}}}
},300000);
