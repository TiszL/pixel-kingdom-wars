/** Complete MarketLogic.kt presentation port. No wallet, quote, transport or journal imports.
 * A returned START is a display intent only. This module must not bypass the original
 * controller, accepted recovery guards, shared Seal, or money-path integration review.
 */
import {busyPrimary,clampBigInt,commonGate,craftItemIcon,groupDigits,offPrimary,primary,safeWholeBigInt} from './craftNativeLogic';
import type {CraftHydration,CraftItemUi,CraftPrimaryUi,CraftReviewUi,Currency,PriceUi,SubmitUi} from './craftNativeModels';
export type MoneyStage='READY'|'CHECK_WALLET'|'SENDING'|'SENT'|'FAILED';
export interface MarketOfferUi {offerId:string;itemId:string;quantity:bigint;unitPrice:bigint;decimals:number;currency:Currency;sellerBaseId:string;sellerName:string;minimumPurchase:bigint;isMine:boolean}
export interface MarketWalletUi {linked:boolean;keepBaseUnits?:bigint|null;solBaseUnits?:bigint|null}
export interface MarketBuyUi {offers:readonly MarketOfferUi[];selectedOfferId:string|null;quantity:bigint;wallet:MarketWalletUi;paymentsAvailable:boolean;hydration:CraftHydration;money:MoneyStage}
export interface SellableUi {itemId:string;available:bigint|null;reserved:bigint|null}
export interface MarketSlotsUi {used:number;max:number}
export interface MarketSellUi {sellable:readonly SellableUi[];selectedItemId:string|null;qty:bigint;unitPrice:bigint|null;tick:bigint|null;feeBps:number|null;slots:MarketSlotsUi|null;listingAllowed:boolean;decimals:number;currency:Currency;items?:Readonly<Record<string,CraftItemUi>>;hydration:CraftHydration;submit:SubmitUi;royaltyBps?:number|null}
export interface OpenOrderUi {listingId:string;itemId:string;listed:bigint;sold:bigint;unitPrice:string;currency:Currency;state:'OPEN'|'PAYING';baseId:string}
export interface SealUi {title:string;lines:readonly string[];price:PriceUi;confirmLabel:string;armedAtMs:number;gets:PriceUi}
export const currencyName=(currency:Currency)=>currency==='SHARDS'?'Shards':currency==='GEMS'?'Gems':currency==='ITEM'?'items':currency;

/** Base units never pass through Number; UP is away from zero, DOWN toward zero. */
export function formatUnits(amount:bigint|null,decimals:number,maxFraction=4,roundUp=false):string {
  if(amount===null||safeWholeBigInt(decimals)===null||safeWholeBigInt(maxFraction)===null)return '…';
  const scale=Math.max(0,Math.trunc(decimals)),places=Math.min(scale,Math.max(0,Math.trunc(maxFraction)));
  const divisor=10n**BigInt(scale-places),magnitude=amount<0n?-amount:amount;
  const truncated=magnitude/divisor,units=truncated+(roundUp&&magnitude%divisor!==0n?1n:0n);
  if(units===0n)return '0';
  const digits=units.toString().padStart(places+1,'0');
  const text=places===0?digits:`${digits.slice(0,-places)}.${digits.slice(-places)}`.replace(/0+$/,'').replace(/\.$/,'');
  return `${amount<0n?'-':''}${text}`;
}
/** Basis points are a unit conversion, not a configured fee. */
export const feePercent=(feeBps:number|null)=>{const whole=feeBps!==null&&Number.isSafeInteger(feeBps)&&feeBps>=0?safeWholeBigInt(feeBps):null;return whole===null?'…':`${formatUnits(whole,2,2)}%`;};
export const selectedOffer=(ui:MarketBuyUi)=>ui.offers.find(offer=>offer.offerId===ui.selectedOfferId)??ui.offers[0]??null;
export function buyBounds(offer:MarketOfferUi):[bigint,bigint] {const max=offer.quantity<1n?1n:offer.quantity;return [clampBigInt(offer.minimumPurchase,1n,max),max];}
export function buyQuantity(ui:MarketBuyUi,offer:MarketOfferUi):bigint {const [min,max]=buyBounds(offer);return clampBigInt(ui.quantity,min,max);}
// Native Math.multiplyExact boundaries. bigint keeps the computation exact before checking.
const longMin=-(1n<<63n),longMax=(1n<<63n)-1n;
export function lotTotal(unitPrice:bigint,quantity:bigint):bigint|null {const total=unitPrice*quantity;return total<longMin||total>longMax?null:total;}
const balanceFor=(wallet:MarketWalletUi,currency:Currency)=>currency==='KEEP'?wallet.keepBaseUnits??null:currency==='SOL'?wallet.solBaseUnits??null:null;
export function buyPrimary(ui:MarketBuyUi):CraftPrimaryUi|null {
  const offer=selectedOffer(ui);if(!offer||offer.isMine)return null;
  const qty=buyQuantity(ui,offer),total=lotTotal(offer.unitPrice,qty);
  const label=`BUY ${groupDigits(qty)}`,sub=`for ${formatUnits(total,offer.decimals,4,true)} ${currencyName(offer.currency)}`;
  switch(ui.money){
    case 'CHECK_WALLET':return busyPrimary('Check wallet');
    case 'SENDING':return busyPrimary('Sending');
    case 'SENT':return primary('BOUGHT',null,'ENABLED','MOSS',null,null,'NONE');
    case 'FAILED':return primary('RETRY',sub,'ENABLED','RED',null,null,'START');
  }
  if(ui.hydration==='ERROR')return primary('Try again',null,'ENABLED','STONE',null,null,'RETRY');
  if(!ui.wallet.linked)return primary('Link a wallet to buy',null,'LOCKED','CHARCOAL',null,null,'LINK_WALLET');
  if(!ui.paymentsAvailable)return offPrimary(label,sub,'Wallet payments are not available in this build.');
  const balance=balanceFor(ui.wallet,offer.currency);
  if(total!==null&&balance!==null&&balance<total)return primary(label,sub,'SHORT','GOLD',null,{currency:offer.currency,amount:formatUnits(total,offer.decimals,4,true),status:'SHORT'},'NEED_MORE');
  return primary(label,sub,'ENABLED','GOLD',null,null,'START');
}
export function buySeal(offer:MarketOfferUi,quantity:bigint,item:CraftItemUi|null,armedAtMs:number):SealUi {
  const total=lotTotal(offer.unitPrice,quantity),name=item?.name??offer.itemId,pay=formatUnits(total,offer.decimals,4,true);
  return {title:`BUY ${groupDigits(quantity)} ${name.toUpperCase()}`,lines:[offer.currency==='SOL'?'Paid from your wallet in SOL. You sign once.':'Paid from your wallet. You sign once.',"Goes to this kingdom's stores."],
    price:{currency:offer.currency,amount:total===null?null:pay,status:total===null?'CHECKING':'OK',description:`Pay ${pay} ${currencyName(offer.currency)}`},confirmLabel:'BUY',armedAtMs,
    gets:{currency:'ITEM',amount:groupDigits(quantity),status:'OK',icon:item?.icon??craftItemIcon(offer.itemId),description:`Get ${groupDigits(quantity)} ${quantity===1n?name:item?.pluralName??name}`}};
}
export const buyFailureCopy=(authoritative:boolean)=>authoritative?"Wallet didn't answer. Nothing was sent.":'No answer yet. Checking whether it went through.';
export function lotLines(offer:MarketOfferUi,held:bigint|null,item:CraftItemUi|null):[string,string] {
  const each=`${formatUnits(offer.unitPrice,offer.decimals,4,true)} ${currencyName(offer.currency)} each · from ${offer.sellerName}`;
  return [each,offer.isMine?'Your lot · manage it in ORDERS':[`You hold ${groupDigits(held)}.`,item?.usedFor].filter(part=>part!==null&&part!==undefined).join(' ')];
}
export const selectedSellable=(ui:MarketSellUi)=>ui.sellable.find(item=>item.itemId===ui.selectedItemId)??ui.sellable[0]??null;
export function sellQuantity(ui:MarketSellUi):bigint {
  const available=selectedSellable(ui)?.available??null;
  return available===null?(ui.qty<1n?1n:ui.qty):clampBigInt(ui.qty,1n,available<1n?1n:available);
}
export function stepPrice(current:bigint|null,direction:number,tick:bigint|null):bigint|null {
  const whole=safeWholeBigInt(direction);if(whole===null)return null;
  if(tick===null||tick<=0n)return current;
  if(current===null)return tick;
  const next=current+(whole<0n?-1n:whole>0n?1n:0n)*tick;
  return next<tick?tick:next;
}
export interface SellProceeds {gross:bigint;fee:bigint;net:bigint}
export function sellProceeds(quantity:bigint,unitPrice:bigint|null,feeBps:number|null):SellProceeds|null {
  const fee=feeBps!==null&&Number.isSafeInteger(feeBps)&&feeBps>=0?safeWholeBigInt(feeBps):null;
  if(unitPrice===null||fee===null)return null;
  const gross=lotTotal(unitPrice,quantity);if(gross===null)return null;
  const scaled=lotTotal(gross,fee);if(scaled===null)return null;
  // Exact ceil for nonnegative server amounts; avoids the native addition overflowing near Long.MAX.
  const charged=(scaled+9999n)/10000n;
  return {gross,fee:charged,net:gross-charged};
}
export function proceedsLines(ui:MarketSellUi):[string,string] {
  const p=sellProceeds(sellQuantity(ui),ui.unitPrice,ui.feeBps),royalty=ui.royaltyBps==null?'':`, ${feePercent(ui.royaltyBps)} royalty`;
  return [`You get ${formatUnits(p?.net??null,ui.decimals)} ${currencyName(ui.currency)}`,`${formatUnits(p?.gross??null,ui.decimals)} total, market fee ${feePercent(ui.feeBps)}${royalty}`];
}
export function sellPrimary(ui:MarketSellUi):CraftPrimaryUi|null {
  const item=selectedSellable(ui);if(!item)return null;
  const label=`LIST ${groupDigits(sellQuantity(ui))}`,sub=`${ui.items?.[item.itemId]?.name??item.itemId} at ${formatUnits(ui.unitPrice,ui.decimals)} each`;
  const gate=commonGate(ui.hydration,ui.submit,null,label,sub);if(gate)return gate;
  if(!ui.listingAllowed)return primary('Pick a kingdom you own to list.',null,'LOCKED','CHARCOAL',null,null,'SHAKE');
  if(ui.slots&&ui.slots.used>=ui.slots.max)return primary(label,sub,'DISABLED','GOLD',`All ${ui.slots.max} slots are in use. Take one back in ORDERS.`,null,'OPEN_ORDERS');
  if(item.available===0n)return offPrimary(label,sub,'None left to list.');
  if(ui.unitPrice===null)return offPrimary(label,sub,'Set a price first.');
  return primary(label,sub,'ENABLED','GOLD',null,null,'START');
}
export function listReview(ui:MarketSellUi,sending=false):CraftReviewUi|null {
  const selected=selectedSellable(ui);if(!selected)return null;
  const qty=sellQuantity(ui),item=ui.items?.[selected.itemId],name=item?(qty===1n?item.name:item.pluralName??item.name):selected.itemId;
  return {title:`LIST ${groupDigits(qty)} ${name.toUpperCase()}`,line:`At ${formatUnits(ui.unitPrice,ui.decimals)} ${currencyName(ui.currency)} each. They leave your stores until sold or taken back.`,confirmLabel:'LIST',backLabel:'BACK',sending};
}
export const ordersPrimary=()=>primary('SELL MORE','opens SELL','ENABLED','GOLD',null,null,'OPEN_SELL');
export const orderTitle=(name:string,quantity:bigint)=>name.toUpperCase()+(quantity>1n?` x${groupDigits(quantity)}`:'');
export const soldLine=(order:{proceeds:string;currency:Currency;at:string})=>`${order.proceeds} ${currencyName(order.currency)} · ${order.at}`;
export const openLine=(order:OpenOrderUi)=>order.state==='PAYING'?`${order.unitPrice} ${currencyName(order.currency)} · buyer paying`:`${order.sold<=0n?'none':groupDigits(order.sold)} sold · ${order.unitPrice} each`;
export const openProgress=(order:OpenOrderUi)=>order.listed<=0n?0:Number(clampBigInt(order.sold*10000n/order.listed,0n,10000n))/10000;
export function freeSlotsLine(slots:MarketSlotsUi|null):string|null {if(!slots)return null;const free=Math.max(0,slots.max-slots.used);return `${free} free slot${free===1?'':'s'}. List from SELL.`;}
export function takeBackReview(order:OpenOrderUi,item:CraftItemUi|null,sending=false):CraftReviewUi {
  const left=order.listed>order.sold?order.listed-order.sold:0n,name=left===1n?item?.name??order.itemId:item?.pluralName??item?.name??order.itemId;
  return {title:'TAKE BACK',line:`Take back ${groupDigits(left)} ${name}? They return to your stores.`,confirmLabel:'TAKE BACK',backLabel:'BACK',sending};
}
