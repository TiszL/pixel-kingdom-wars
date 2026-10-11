import {expect,it} from 'vitest';
import {KeepEquipmentMarketListingRequestSchema as Listing,KeepEquipmentMarketFillRequestSchema as Fill,KeepEquipmentMarketCancelRequestSchema as Cancel,KeepEquipmentPurchaseSchema,KeepEquipmentPaymentFailureSchema} from './keepEquipmentMarketApi';
import {RAW_RESOURCE_STORAGE_MAX} from './phaseEResources';
const key='00000000-0000-4000-8000-000000000001',base='00000000-0000-4000-8000-000000000002';
const listing={idempotencyKey:key,baseId:base,itemId:'route_compass',quantity:'1',unitPriceBaseUnits:'1'};
it('carries exact decimal strings through the full stock/SPL representation, never rounded numbers',()=>{
 const input={...listing,itemId:'survey_lens',quantity:RAW_RESOURCE_STORAGE_MAX.toString(),unitPriceBaseUnits:((1n<<64n)-1n).toString()};
 expect(Listing.parse(input)).toEqual(input);expect(Fill.parse({idempotencyKey:key,listingId:base,buyerBaseId:base,quantity:input.quantity}).quantity).toBe(input.quantity);
});
it.each(['0','01','-1','1.0','1e3',' 1','1 ',(1n<<64n).toString()])('rejects noncanonical or out-of-range price/quantity %s',value=>{
 expect(Listing.safeParse({...listing,unitPriceBaseUnits:value}).success).toBe(false);
 expect(Listing.safeParse({...listing,quantity:value}).success).toBe(false);
});
it('cannot accept a buyer-selected seller, destination, payment proof or unapproved item',()=>{
 for(const itemId of ['gems','shards','forge_ingot','charter'])expect(Listing.safeParse({...listing,itemId}).success).toBe(false);
 const fill={idempotencyKey:key,listingId:base,buyerBaseId:base,quantity:'1'};
 for(const field of ['sellerWallet','totalBaseUnits','proof','signature','delivered'])expect(Fill.safeParse({...fill,[field]:'forged'}).success).toBe(false);
 expect(Cancel.safeParse({idempotencyKey:key,listingId:base,quantity:'9'}).success).toBe(false);
});
it('binds explicit immutable base/listing identity and refuses floating wallet-global orders',()=>{
 const {baseId:_,...missing}=listing;expect(Listing.safeParse(missing).success).toBe(false);
 expect(Fill.safeParse({idempotencyKey:key,listingId:base,quantity:'1'}).success).toBe(false);
 expect(Cancel.parse({idempotencyKey:key,listingId:base})).toEqual({idempotencyKey:key,listingId:base});
});

it('refuses a non-v4 fill identity before permanently holding any stock',()=>{
 expect(Fill.safeParse({idempotencyKey:'00000000-0000-7000-8000-000000000001',listingId:base,buyerBaseId:base,quantity:'1'}).success).toBe(false);
});


const buyer='11111111111111111111111111111111',seller='22222222222222222222222222222222';
function reserved(){return {fill:{id:key,listingId:base,buyerWallet:buyer,buyerBaseId:key,sellerWallet:seller,sellerBaseId:base,itemId:'route_compass',quantity:'1',unitPriceBaseUnits:'1000000',totalBaseUnits:'1000000',createdAt:'2035-01-01T00:00:00.000Z'},preparation:null,wire:null,delivery:null,status:'reserved',signingAuthorized:false,broadcastAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false};}
it('keeps old active receipt and persisted journal shapes unchanged when no release exists',()=>{
 const old=reserved();expect(KeepEquipmentPurchaseSchema.parse(old)).toEqual(old);expect(Object.hasOwn(KeepEquipmentPurchaseSchema.parse(old),'release')).toBe(false);
 expect(KeepEquipmentPurchaseSchema.safeParse({...old,release:null}).success).toBe(false);
});
it('binds a never-prepared terminal release to the original fill and excludes false payment histories',()=>{
 const old=reserved(),release={fillId:key,reason:'never_prepared',signature:null,proof:null,releasedAt:'2035-01-01T01:00:00.000Z'},done={...old,status:'released',release};
 expect(KeepEquipmentPurchaseSchema.parse(done)).toEqual(done);
 for(const bad of [{...done,status:'reserved'},{...old,status:'released'},{...done,release:{...release,fillId:base}},{...done,release:{...release,reason:'finalized_failed'}},{...done,release:{...release,signature:'1'.repeat(64)}},{...done,release:{...release,proof:{}}}])expect(KeepEquipmentPurchaseSchema.safeParse(bad).success).toBe(false);
});
it('bounds failed evidence and preserves fee-only rollback with no claimed action authority',()=>{
 const proof={version:1,outcome:'failed',reservationId:key,buyer,seller,keepMint:buyer,totalBaseUnits:'1000000',signature:'1'.repeat(64),messageSha256:'a'.repeat(64),wireSha256:'b'.repeat(64),transactionVersion:'legacy',slot:100,blockTime:1,error:{InstructionError:[0,'InvalidArgument']},feeLamports:'5000',resolvedKeys:[buyer,seller],lamportsBefore:[10000,0],lamportsAfter:[5000,0],tokenBalances:null,evidenceSha256:'c'.repeat(64),rentLamports:'0',paidKeepBaseUnits:'0',expectedGenesisHash:buyer,providerIds:['a','b'],minContextSlot:90,observations:[{openingSlot:100,closingSlot:101},{openingSlot:100,closingSlot:101}],finalizedAgreement:true,paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,deliveryAuthorized:false,fenceReleaseAuthorized:false,unpaidProven:false};
 expect(KeepEquipmentPaymentFailureSchema.parse(proof)).toEqual(proof);
 expect(KeepEquipmentPaymentFailureSchema.safeParse({...proof,error:{InstructionError:[0,{BorshIoError:''}]}}).success).toBe(true);
 for(const bad of [{...proof,error:null},{...proof,error:{InstructionError:[0,{BorshIoError:'x'.repeat(257)}]}},{...proof,lamportsAfter:[5000,1]},{...proof,resolvedKeys:[buyer,buyer]},{...proof,paidKeepBaseUnits:'1'},{...proof,slot:89},{...proof,feeLamports:(1n<<64n).toString()},{...proof,observations:[{openingSlot:89,closingSlot:101},{openingSlot:100,closingSlot:101}]}])expect(KeepEquipmentPaymentFailureSchema.safeParse(bad).success).toBe(false);
 for(const flag of ['paymentAuthorized','signingAuthorized','broadcastAuthorized','deliveryAuthorized','fenceReleaseAuthorized','unpaidProven'])expect(KeepEquipmentPaymentFailureSchema.safeParse({...proof,[flag]:true}).success).toBe(false);
});

// D153.194: discovery opt-in never leaks new identities to old clients.
import {KEEP_MARKET_ITEM_IDS,KEEP_MARKET_CRAFTING_CATALOGUE_IDS,KEEP_MARKET_EQUIPMENT_IDS,KeepEquipmentStockViewSchema,KeepEquipmentStockQuerySchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema,KeepEquipmentMarketPolicySchema,keepMarketCategory,keepMarketStockKind} from './keepEquipmentMarketApi';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as M,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as MC,PHASE_E_POLICY,TOKEN} from './constants';
const marketPolicy={version:M.policyVersion,decimals:TOKEN.decimals,minFillBaseUnits:M.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:MC.reviewMaxAgeMs};
const stockRow=(itemId:string)=>({itemId,available:'1',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'});
it.each(KEEP_MARKET_ITEM_IDS)('maps and admits the immutable %s stock identity without a posted family label',itemId=>{
 expect(Listing.parse({...listing,itemId}).itemId).toBe(itemId);
 expect(Listing.safeParse({...listing,itemId,stockKind:keepMarketStockKind(itemId)}).success).toBe(false);
 expect(KeepEquipmentListingsQuerySchema.safeParse({itemId}).success).toBe(keepMarketStockKind(itemId)==='equipment');
 expect(KeepEquipmentListingsQuerySchema.parse({catalogueVersion:itemId==='crystal_fragment'?'3':'2',category:keepMarketCategory(itemId),itemId}).itemId).toBe(itemId);
});
it('keeps original stock/policy byte shapes and requires all eleven unique version2 rows with exact custody bounds',()=>{
 const old={baseId:base,wallet:buyer,serverNow:'2035-01-01T00:00:00.000Z',policy:marketPolicy,items:KEEP_MARKET_EQUIPMENT_IDS.map(stockRow)};
 expect(KeepEquipmentStockViewSchema.parse(old)).toEqual(old);expect(KeepEquipmentMarketPolicySchema.parse(marketPolicy)).toEqual(marketPolicy);
 const next={...old,catalogueVersion:2,items:KEEP_MARKET_CRAFTING_CATALOGUE_IDS.map(stockRow)};expect(KeepEquipmentStockViewSchema.parse(next)).toEqual(next);
 for(const v of [{...next,catalogueVersion:'2'},{...next,items:next.items.slice(1)},{...next,items:next.items.map((r,i)=>i===2?next.items[0]:r)},{...next,items:next.items.map(r=>r.itemId==='frostglass'?{...r,reserved:'1'}:r)},{...next,items:next.items.map(r=>r.itemId==='frostglass'?{...r,available:RAW_RESOURCE_STORAGE_MAX.toString(),marketIncoming:'1'}:r)}])expect(KeepEquipmentStockViewSchema.safeParse(v).success).toBe(false);
 expect(KeepEquipmentStockQuerySchema.safeParse({baseId:base,catalogueVersion:'2',category:'resources'}).success).toBe(false);
});
it('requires explicit version2 for categories and refuses contradictions before cursors reach SQL',()=>{
 for(const schema of [KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema]){
  expect(schema.parse({})).toEqual({});
  for(const v of [{catalogueVersion:'1'},{catalogueVersion:2},{category:'resources'},{catalogueVersion:'2',category:'resources',itemId:'navigation_kit'},{catalogueVersion:'2',category:'items',itemId:'frostglass'},{catalogueVersion:'2',category:'resources',itemId:'forge_ingot'}])expect(schema.safeParse(v).success).toBe(false);
  expect(schema.parse({catalogueVersion:'2',category:'items',itemId:'navigation_kit'})).toEqual({catalogueVersion:'2',category:'items',itemId:'navigation_kit'});
 }
});

it('requires exact version3 fragment discovery while retaining version2 and all original receipts',()=>{
 const view={baseId:base,wallet:buyer,serverNow:'2035-01-01T00:00:00.000Z',policy:marketPolicy,catalogueVersion:3,items:KEEP_MARKET_ITEM_IDS.map(stockRow)};
 expect(KeepEquipmentStockViewSchema.parse(view)).toEqual(view);
 expect(keepMarketStockKind('crystal_fragment')).toBe('fragment');expect(keepMarketCategory('crystal_fragment')).toBe('resources');
 for(const schema of [KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema]){
  expect(schema.parse({catalogueVersion:'3',category:'resources',itemId:'crystal_fragment'})).toMatchObject({itemId:'crystal_fragment'});
  for(const q of [{itemId:'crystal_fragment'},{catalogueVersion:'2',itemId:'crystal_fragment'},{catalogueVersion:'3',category:'items',itemId:'crystal_fragment'}])expect(schema.safeParse(q).success).toBe(false);
 }
 for(const v of [{...view,catalogueVersion:2},{...view,items:view.items.slice(1)},{...view,items:view.items.map(i=>i.itemId==='crystal_fragment'?{...i,pendingOutput:'1'}:i)},{...view,items:view.items.map(i=>i.itemId==='crystal_fragment'?{...i,marketOutgoing:RAW_RESOURCE_STORAGE_MAX.toString()}:i)}])expect(KeepEquipmentStockViewSchema.safeParse(v).success).toBe(false);
 expect(KeepEquipmentPurchaseSchema.parse({...reserved(),fill:{...reserved().fill,itemId:'crystal_fragment'}})).toMatchObject({fill:{itemId:'crystal_fragment'}});
});
