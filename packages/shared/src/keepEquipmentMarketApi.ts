/** D153.190 ordinary equipment market requests. Lazy subpath only.
 * These grammars grant no admission, payment, delivery or release authority. */
import {z} from 'zod';
import {RAW_RESOURCE_STORAGE_MAX} from './phaseEResources';
import {ORDINARY_CRAFTING_ITEM_IDS,ORDINARY_CRAFTING_ITEM_IDS_V2,ORDINARY_REFINED_IDS} from './phaseEOrdinaryCrafting';
import {OrdinaryEquipmentUuidSchema} from './ordinaryEquipmentApi';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT,PHASE_E_KEEP_EQUIPMENT_MARKET,PHASE_E_POLICY,TOKEN} from './constants';
const uuid=OrdinaryEquipmentUuidSchema;
// A fill ID is the canonical on-chain payment memo identity. The payment
// protocol accepts v4 only; reject other UUID versions before holding stock.
const paymentId=uuid.refine(v=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v),'Payment ID must be UUID v4');
// Protocol/persistence bounds, not gameplay tuning. Compare full integer values;
// JS numbers cannot represent all legal SPL amounts or stock quantities.
const u64=(1n<<64n)-1n;
export const KeepEquipmentMarketQuantitySchema=z.string().regex(/^[1-9][0-9]{0,18}$/)
 .pipe(z.string().refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX,'Quantity exceeds stock representation'));
export const KeepEquipmentMarketPriceSchema=z.string().regex(/^[1-9][0-9]{0,19}$/)
 .pipe(z.string().refine(v=>BigInt(v)<=u64,'Price exceeds SPL representation'));
// D153.194: immutable IDs, never a caller-selected stock-table label.
export const KEEP_MARKET_EQUIPMENT_IDS=['route_compass','survey_lens'] as const;
export const KEEP_MARKET_CRAFTING_CATALOGUE_IDS=[...KEEP_MARKET_EQUIPMENT_IDS,...ORDINARY_CRAFTING_ITEM_IDS] as const;
export const KEEP_MARKET_ITEM_IDS=[...KEEP_MARKET_CRAFTING_CATALOGUE_IDS,'crystal_fragment'] as const;
export const KEEP_MARKET_ITEM_IDS_V4=[...KEEP_MARKET_EQUIPMENT_IDS,...ORDINARY_CRAFTING_ITEM_IDS_V2,'crystal_fragment'] as const;
/** Explicit discovery compatibility; an omitted version remains equipment-only. */
export function keepMarketCatalogueIds(version?:'2'|'3'|'4') {
 if(version===undefined)return KEEP_MARKET_EQUIPMENT_IDS;
 if(version==='2')return KEEP_MARKET_CRAFTING_CATALOGUE_IDS;
 if(version==='3')return KEEP_MARKET_ITEM_IDS;
 if(version==='4')return KEEP_MARKET_ITEM_IDS_V4;
 throw Error('Unsupported KEEP market catalogue');
}
export const KeepEquipmentMarketItemSchema=z.enum(KEEP_MARKET_ITEM_IDS_V4);
export type KeepEquipmentMarketItem=z.infer<typeof KeepEquipmentMarketItemSchema>;
export function keepMarketStockKind(itemId:KeepEquipmentMarketItem):'equipment'|'crafting'|'fragment'{
 KeepEquipmentMarketItemSchema.parse(itemId);if(itemId==='crystal_fragment')return 'fragment';return (KEEP_MARKET_EQUIPMENT_IDS as readonly string[]).includes(itemId)?'equipment':'crafting';
}
export function keepMarketCategory(itemId:KeepEquipmentMarketItem):'resources'|'items'{
 KeepEquipmentMarketItemSchema.parse(itemId);return itemId==='crystal_fragment'||(ORDINARY_REFINED_IDS as readonly string[]).includes(itemId)?'resources':'items';
}
const discoveryFields={catalogueVersion:z.enum(['2','3','4']).optional(),category:z.enum(['resources','items']).optional(),itemId:KeepEquipmentMarketItemSchema.optional()};
function discoveryMatches(v:{catalogueVersion?:'2'|'3'|'4'|undefined;category?:'resources'|'items'|undefined;itemId?:KeepEquipmentMarketItem|undefined}){
 const ids:readonly string[]=keepMarketCatalogueIds(v.catalogueVersion);
 return (v.catalogueVersion!==undefined||v.category===undefined)&&(!v.itemId||ids.includes(v.itemId))
  &&(!v.category||!v.itemId||keepMarketCategory(v.itemId)===v.category);
}
export const KeepEquipmentStockQuerySchema=z.object({baseId:uuid,catalogueVersion:z.enum(['2','3','4']).optional()}).strict();
export const KeepEquipmentMarketListingRequestSchema=z.object({
 idempotencyKey:uuid,baseId:uuid,itemId:KeepEquipmentMarketItemSchema,
 quantity:KeepEquipmentMarketQuantitySchema,unitPriceBaseUnits:KeepEquipmentMarketPriceSchema,
}).strict();
export const KeepEquipmentMarketFillRequestSchema=z.object({
 idempotencyKey:paymentId,listingId:uuid,buyerBaseId:uuid,quantity:KeepEquipmentMarketQuantitySchema,
}).strict();
export const KeepEquipmentMarketCancelRequestSchema=z.object({idempotencyKey:uuid,listingId:uuid}).strict();
export type KeepEquipmentMarketListingRequest=z.infer<typeof KeepEquipmentMarketListingRequestSchema>;
export type KeepEquipmentMarketFillRequest=z.infer<typeof KeepEquipmentMarketFillRequestSchema>;
export type KeepEquipmentMarketCancelRequest=z.infer<typeof KeepEquipmentMarketCancelRequestSchema>;

// Bounded wire contracts only. Parsing grants no chain or payment authority.
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[0-9a-f]{64}$/);
const amount=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/);
const address=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const pins=z.tuple([z.string().min(1).max(128),z.string().min(1).max(128)]).refine(v=>v[0]!==v[1]);
const flags={signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),deliveryAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false),unpaidProven:z.literal(false)};
export const KeepEquipmentPaymentPreparationSchema=z.object({
 version:z.literal(1),transactionVersion:z.union([z.literal('legacy'),z.literal(0)]),
 original:z.object({reservationId:z.uuid(),buyer:address,seller:address,keepMint:address,totalBaseUnits:amount,sellerAtaExists:z.boolean(),sellerAtaRentCapLamports:amount.optional()}).strict(),
 limits:z.object({maxFeeLamports:amount,maxPriorityFeeLamports:amount,maxComputeUnitLimit:integer}).strict(),
 expectedGenesisHash:address,expectedKeepMint:address,providerIds:pins,blockhash:address,lastValidBlockHeight:integer,blockhashSlot:integer,minContextSlot:integer,
 messageSha256:hash,messageHex:z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/),
 observedAccounts:z.array(z.object({address,owner:address.nullable(),lamports:amount,dataLength:integer,dataSha256:hash.nullable(),executable:z.literal(false)}).strict()).length(4),accountEvidenceSha256:hash,
 observations:z.array(z.object({openingSlot:integer,accountSlot:integer,feeSlot:integer,validitySlot:integer,closingSlot:integer,currentBlockHeight:integer,feeLamports:amount}).strict()).length(2),
 balances:z.object({buyerKeepBaseUnits:amount,sellerKeepBaseUnits:amount.nullable(),buyerSolLamports:amount,sellerAccountState:z.enum(['existing','missing','prefunded'])}).strict(),
 costs:z.object({feeLamports:amount,rentLamports:amount,fullAtaRentLamports:amount,totalLamports:amount}).strict(),...flags,
}).strict();
export type KeepEquipmentSavedPreparation=z.infer<typeof KeepEquipmentPaymentPreparationSchema>&{recordedAt:string};
export const KeepEquipmentPaymentCurrentSchema=KeepEquipmentPaymentPreparationSchema.omit({blockhashSlot:true}).extend({currentReviewPassed:z.literal(true),finalityVerified:z.literal(false)});
export const KeepEquipmentPaymentProofSchema=z.object({
 version:z.literal(1),signature:z.string().min(64).max(88),reservationId:z.uuid(),buyer:address,seller:address,keepMint:address,buyerAta:address,sellerAta:address,
 totalBaseUnits:amount,sellerBaseUnits:amount,burnBaseUnits:amount,slot:integer,feeLamports:amount,createsSellerAta:z.boolean(),sellerAtaCreated:z.boolean(),sellerAtaRentCapLamports:amount,sellerAtaRentLamports:amount,
 innerInstructionsSha256:hash,messageSha256:hash,resolvedKeys:z.array(address).min(1).max(16),tokenBefore:z.array(amount).length(2),tokenAfter:z.array(amount).length(2),lamportsBefore:z.array(integer).min(1).max(16),lamportsAfter:z.array(integer).min(1).max(16),
 evidenceSha256:hash,fenceReleaseAuthorized:z.literal(false),unpaidProven:z.literal(false),expectedGenesisHash:address,providerIds:pins,finalizedAgreement:z.literal(true),
}).strict();

const timestamp=z.iso.datetime({precision:3});
const stock=amount.pipe(z.string().refine(v=>BigInt(v)<=RAW_RESOURCE_STORAGE_MAX));
export const KeepEquipmentListingSchema=z.object({id:uuid,sellerWallet:address,sellerBaseId:uuid,itemId:KeepEquipmentMarketItemSchema,quantity:KeepEquipmentMarketQuantitySchema,unitPriceBaseUnits:KeepEquipmentMarketPriceSchema,createdAt:timestamp,availableQuantity:stock,reservedQuantity:stock,cancelledQuantity:stock}).strict().refine(v=>BigInt(v.quantity)===BigInt(v.availableQuantity)+BigInt(v.reservedQuantity)+BigInt(v.cancelledQuantity));
export const KeepEquipmentFillSchema=z.object({id:paymentId,listingId:uuid,buyerWallet:address,buyerBaseId:uuid,quantity:KeepEquipmentMarketQuantitySchema,totalBaseUnits:KeepEquipmentMarketPriceSchema,createdAt:timestamp,sellerWallet:address,sellerBaseId:uuid,itemId:KeepEquipmentMarketItemSchema,unitPriceBaseUnits:KeepEquipmentMarketPriceSchema}).strict().refine(v=>v.buyerWallet!==v.sellerWallet&&v.buyerBaseId!==v.sellerBaseId&&BigInt(v.totalBaseUnits)===BigInt(v.quantity)*BigInt(v.unitPriceBaseUnits));
export const KeepEquipmentCancellationSchema=z.object({id:uuid,listingId:uuid,actorWallet:address,quantity:KeepEquipmentMarketQuantitySchema,createdAt:timestamp}).strict();
export const KeepEquipmentSavedWireSchema=z.object({signature:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),wireSha256:hash,messageSha256:hash,signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/),recordedAt:timestamp}).strict();
export const KeepEquipmentWireSchema=KeepEquipmentSavedWireSchema.omit({recordedAt:true});
export const KeepEquipmentDeliverySchema=z.object({fillId:paymentId,buyerBaseId:uuid,itemId:KeepEquipmentMarketItemSchema,quantity:KeepEquipmentMarketQuantitySchema,proof:KeepEquipmentPaymentProofSchema,deliveredAt:timestamp}).strict();
// Failure observations remain evidence, not client authority. Bound the raw
// recognized error representation without importing server chain code here.
const failureError=z.unknown().superRefine((value,ctx)=>{
 const bounded=(v:unknown,depth:number):boolean=>{
  if(depth>4)return false;if(typeof v==='string')return v.length<=256;
  if(typeof v==='number')return Number.isSafeInteger(v)&&v>=0;
  if(Array.isArray(v))return v.length>0&&v.length<=2&&v.every(x=>bounded(x,depth+1));
  if(!v||typeof v!=='object'||Object.getPrototypeOf(v)!==Object.prototype)return false;
  const names=Object.keys(v);return names.length===1&&names[0]!.length<=64&&bounded((v as Record<string,unknown>)[names[0]!],depth+1);
 };
 if(value===''||(typeof value!=='string'&&(!value||typeof value!=='object'||Array.isArray(value)))||!bounded(value,0))ctx.addIssue({code:'custom',message:'Malformed failed execution error'});
});
const splAmount=amount.refine(v=>BigInt(v)<=u64);
export const KeepEquipmentPaymentFailureSchema=z.object({
 version:z.literal(1),outcome:z.literal('failed'),reservationId:paymentId,buyer:address,seller:address,keepMint:address,totalBaseUnits:KeepEquipmentMarketPriceSchema,
 signature:KeepEquipmentSavedWireSchema.shape.signature,messageSha256:hash,wireSha256:hash,transactionVersion:z.union([z.literal('legacy'),z.literal(0)]),
 slot:integer.positive(),blockTime:integer,error:failureError,feeLamports:splAmount,resolvedKeys:z.array(address).min(1).max(16),
 lamportsBefore:z.array(integer).min(1).max(16),lamportsAfter:z.array(integer).min(1).max(16),
 tokenBalances:z.array(z.object({accountIndex:integer,mint:address,owner:address,programId:address,decimals:integer.max(255),amount:splAmount}).strict()).min(1).max(2).nullable(),evidenceSha256:hash,
 rentLamports:z.literal('0'),paidKeepBaseUnits:z.literal('0'),expectedGenesisHash:address,providerIds:pins,minContextSlot:integer,
 observations:z.array(z.object({openingSlot:integer,closingSlot:integer}).strict()).length(2),finalizedAgreement:z.literal(true),paymentAuthorized:z.literal(false),...flags,
}).strict().superRefine((v,c)=>{
 const bad=()=>c.addIssue({code:'custom',message:'Malformed failed execution evidence'});
 if(v.slot<v.minContextSlot||v.observations.some(o=>o.openingSlot<v.minContextSlot||o.closingSlot<Math.max(o.openingSlot,v.slot))
  ||new Set(v.resolvedKeys).size!==v.resolvedKeys.length||v.resolvedKeys[0]!==v.buyer||v.lamportsBefore.length!==v.resolvedKeys.length||v.lamportsAfter.length!==v.resolvedKeys.length)bad();
 else if(v.lamportsBefore.some((n,i)=>BigInt(n)-BigInt(v.lamportsAfter[i]!)!==(i===0?BigInt(v.feeLamports):0n)))bad();
 if(v.tokenBalances&&(new Set(v.tokenBalances.map(t=>t.accountIndex)).size!==v.tokenBalances.length||v.tokenBalances.some(t=>t.accountIndex>=v.resolvedKeys.length||t.mint!==v.keepMint||![v.buyer,v.seller].includes(t.owner)||t.decimals!==TOKEN.decimals)))bad();
});
export const KeepEquipmentReleaseSchema=z.object({fillId:paymentId,reason:z.enum(['never_prepared','finalized_failed']),signature:KeepEquipmentSavedWireSchema.shape.signature.nullable(),proof:KeepEquipmentPaymentFailureSchema.nullable(),releasedAt:timestamp}).strict().superRefine((v,c)=>{
 if(v.reason==='never_prepared'?v.signature!==null||v.proof!==null:!v.signature||!v.proof||v.proof.signature!==v.signature||v.proof.reservationId!==v.fillId)c.addIssue({code:'custom',message:'Release differs from its original payment'});
});
export type KeepEquipmentRelease=z.infer<typeof KeepEquipmentReleaseSchema>;
export const KeepEquipmentPurchaseSchema=z.object({
 fill:KeepEquipmentFillSchema,preparation:KeepEquipmentPaymentPreparationSchema.extend({recordedAt:timestamp}).nullable(),wire:KeepEquipmentSavedWireSchema.nullable(),delivery:KeepEquipmentDeliverySchema.nullable(),
 release:KeepEquipmentReleaseSchema.optional(),status:z.enum(['reserved','prepared','signed','delivered','released']),signingAuthorized:z.literal(false),broadcastAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false),unpaidProven:z.literal(false),
}).strict().superRefine((v,c)=>{
 const bad=()=>c.addIssue({code:'custom',message:'Purchase differs from original consent'}),p=v.preparation,w=v.wire,d=v.delivery,f=v.fill,r=v.release;
 if(v.status!==(r?'released':d?'delivered':w?'signed':p?'prepared':'reserved')||w&&!p||d&&(!p||!w)||r&&d)bad();
 if(r){
  if(r.fillId!==f.id)bad();
  if(r.reason==='never_prepared'){if(p||w)bad();}
  else{const proof=r.proof;if(!p||!w||!proof||r.signature!==w.signature||proof.reservationId!==f.id||proof.buyer!==f.buyerWallet||proof.seller!==f.sellerWallet||proof.totalBaseUnits!==f.totalBaseUnits
    ||proof.keepMint!==p.expectedKeepMint||proof.expectedGenesisHash!==p.expectedGenesisHash||JSON.stringify(proof.providerIds)!==JSON.stringify(p.providerIds)||proof.messageSha256!==p.messageSha256||proof.wireSha256!==w.wireSha256||proof.transactionVersion!==p.transactionVersion||proof.minContextSlot<p.minContextSlot)bad();}
 }
 if(p&&(p.original.reservationId!==f.id||p.original.buyer!==f.buyerWallet||p.original.seller!==f.sellerWallet||p.original.totalBaseUnits!==f.totalBaseUnits||p.original.keepMint!==p.expectedKeepMint))bad();
 if(w&&p&&w.messageSha256!==p.messageSha256)bad();
 if(d&&(d.fillId!==f.id||d.buyerBaseId!==f.buyerBaseId||d.itemId!==f.itemId||d.quantity!==f.quantity||d.proof.reservationId!==f.id||d.proof.signature!==w?.signature||d.proof.messageSha256!==p?.messageSha256||d.proof.buyer!==f.buyerWallet||d.proof.seller!==f.sellerWallet||d.proof.totalBaseUnits!==f.totalBaseUnits))bad();
});
export type KeepEquipmentPurchase=z.infer<typeof KeepEquipmentPurchaseSchema>;
export const KeepEquipmentReviewSchema=z.object({purchase:KeepEquipmentPurchaseSchema,current:KeepEquipmentPaymentCurrentSchema,reviewedAt:timestamp,expiresAt:timestamp}).strict().refine(v=>!v.purchase.release&&v.current.messageSha256===v.purchase.preparation?.messageSha256&&JSON.stringify(v.current.original)===JSON.stringify(v.purchase.preparation.original)&&Date.parse(v.expiresAt)-Date.parse(v.reviewedAt)===PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs);
export const KeepEquipmentSendSchema=z.object({purchase:KeepEquipmentPurchaseSchema,status:z.enum(['delivered','submitted','held']),reason:z.string().min(1).max(128).nullable(),broadcastAuthorized:z.literal(false),fenceReleaseAuthorized:z.literal(false)}).strict().refine(v=>v.status==='delivered'?v.purchase.delivery!==null&&v.reason===null:v.status==='submitted'?!v.purchase.release&&v.purchase.wire!==null&&v.reason===null:v.reason!==null);
export const KeepEquipmentSignedRequestSchema=z.object({signedTransactionHex:KeepEquipmentSavedWireSchema.shape.signedTransactionHex}).strict();
export const KeepEquipmentPageCursorSchema=z.object({before:timestamp,beforeId:uuid}).strict();
export const KeepEquipmentListingsQuerySchema=z.object({...discoveryFields,before:timestamp.optional(),beforeId:uuid.optional()}).strict().refine(discoveryMatches).refine(v=>(v.before===undefined)===(v.beforeId===undefined));
export const KeepEquipmentListingPageSchema=z.object({items:z.array(KeepEquipmentListingSchema).max(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.pageSize),nextCursor:KeepEquipmentPageCursorSchema.nullable()}).strict();
export const KeepEquipmentHistoryItemSchema=z.object({kind:z.enum(['listing','fill','cancellation']),id:uuid,baseId:uuid,itemId:KeepEquipmentMarketItemSchema,createdAt:timestamp}).strict();
export const KeepEquipmentHistoryCursorSchema=KeepEquipmentPageCursorSchema.extend({beforeKind:KeepEquipmentHistoryItemSchema.shape.kind});
export const KeepEquipmentHistoryQuerySchema=z.object({...discoveryFields,before:timestamp.optional(),beforeId:uuid.optional(),beforeKind:KeepEquipmentHistoryItemSchema.shape.kind.optional()}).strict().refine(discoveryMatches).refine(v=>[v.before,v.beforeId,v.beforeKind].every(x=>x===undefined)||[v.before,v.beforeId,v.beforeKind].every(x=>x!==undefined));
export const KeepEquipmentHistoryPageSchema=z.object({wallet:address,items:z.array(KeepEquipmentHistoryItemSchema).max(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.pageSize),nextCursor:KeepEquipmentHistoryCursorSchema.nullable()}).strict();
export const KeepEquipmentMarketPolicySchema=z.object({version:z.literal(PHASE_E_KEEP_EQUIPMENT_MARKET.policyVersion),decimals:z.literal(TOKEN.decimals),minFillBaseUnits:z.literal(PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits.toString()),sellerBps:z.literal(PHASE_E_POLICY.taxes.keepMarket.sellerBps),basisPoints:z.literal(PHASE_E_POLICY.basisPoints),reviewMaxAgeMs:z.literal(PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs)}).strict();
const stockItem=z.object({itemId:KeepEquipmentMarketItemSchema,available:stock,reserved:stock,pendingOutput:stock,marketOutgoing:stock,marketIncoming:stock}).strict();
const stockView={baseId:uuid,wallet:address,serverNow:timestamp,policy:KeepEquipmentMarketPolicySchema};
export const KeepEquipmentStockViewSchema=z.union([
 z.object({...stockView,items:z.array(stockItem.extend({itemId:z.enum(KEEP_MARKET_EQUIPMENT_IDS)})).length(KEEP_MARKET_EQUIPMENT_IDS.length)}).strict(),
 z.object({...stockView,catalogueVersion:z.literal(2),items:z.array(stockItem.extend({itemId:z.enum(KEEP_MARKET_CRAFTING_CATALOGUE_IDS)})).length(KEEP_MARKET_CRAFTING_CATALOGUE_IDS.length)}).strict(),
 z.object({...stockView,catalogueVersion:z.literal(4),items:z.array(stockItem).length(KEEP_MARKET_ITEM_IDS_V4.length)}).strict(),
 z.object({...stockView,catalogueVersion:z.literal(3),items:z.array(stockItem.extend({itemId:z.enum(KEEP_MARKET_ITEM_IDS)})).length(KEEP_MARKET_ITEM_IDS.length)}).strict(),
]).refine(v=>new Set(v.items.map(i=>i.itemId)).size===v.items.length&&v.items.every(i=>
 (keepMarketStockKind(i.itemId)==='equipment'||i.reserved==='0')&&(i.itemId!=='crystal_fragment'||i.pendingOutput==='0')&&BigInt(i.available)+BigInt(i.reserved)+BigInt(i.pendingOutput)+BigInt(i.marketOutgoing)+BigInt(i.marketIncoming)<=RAW_RESOURCE_STORAGE_MAX));
