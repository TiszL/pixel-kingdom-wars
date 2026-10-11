import {describe, expect, it} from 'vitest';
import * as m from './marketLogic';
import type {MarketBuyUi, MarketOfferUi, MarketSellUi, OpenOrderUi} from './marketLogic';

// Native MarketLogicTest fixtures: examples, never production prices or policy.
const keep = 1_000_000_000n;
const item = {itemId:'frostglass',name:'Frostglass',icon:'craft:inv_frostglass',source:'Refine here',usedFor:'For tools and kits.'};
const lot: MarketOfferUi = {offerId:'o-1',itemId:'frostglass',quantity:20n,unitPrice:18n*keep/10n,decimals:9,currency:'KEEP',sellerBaseId:'base-a',sellerName:'Ashford',minimumPurchase:1n,isMine:false};
const buy: MarketBuyUi = {offers:[lot],selectedOfferId:'o-1',quantity:10n,wallet:{linked:true,keepBaseUnits:312n*keep},paymentsAvailable:true,hydration:'READY',money:'READY'};
const sell: MarketSellUi = {sellable:[{itemId:'frostglass',available:14n,reserved:3n}],selectedItemId:'frostglass',qty:10n,unitPrice:19n*keep/10n,tick:keep/10n,feeBps:500,slots:{used:3,max:5},listingAllowed:true,decimals:9,currency:'KEEP',items:{frostglass:item},hydration:'READY',submit:{stage:'IDLE'}};

describe('MarketLogic native parity — authored, unrun', () => {
  // Base units stay integers; what the player pays rounds up, what they get rounds down.
  it('base-unit amounts format exactly and round in the player’s disfavour', () => {
    expect(m.formatUnits(18n*keep/10n,9)).toBe('1.8');
    expect(m.formatUnits(18n*keep,9)).toBe('18');
    expect(m.formatUnits(0n,9)).toBe('0');
    expect(m.formatUnits(null,9)).toBe('…');
    expect(m.formatUnits(1_234_567_891n,9,2,true)).toBe('1.24');
    expect(m.formatUnits(1_234_567_891n,9,2)).toBe('1.23');
    expect(m.feePercent(500)).toBe('5%');
    expect(m.feePercent(250)).toBe('2.5%');
    expect(m.feePercent(null)).toBe('…');
  });
  // SPEC §3.3: the fee comes from the server's feeBps; "You get" may never be more than the player will receive.
  it('listing proceeds round the fee up so you-get never flatters', () => {
    expect(m.sellProceeds(10n,19n*keep/10n,500)).toEqual({gross:19n*keep,fee:950_000_000n,net:18_050_000_000n});
    expect(m.sellProceeds(1n,1n,500)).toEqual({gross:1n,fee:1n,net:0n});
    expect(m.sellProceeds(10n,19n*keep/10n,null)).toBeNull();
    expect(m.sellProceeds(10n,null,500)).toBeNull();
  });
  it('BUY shows the lot total and asks the host for the Seal', () => {
    expect(m.buyPrimary(buy)).toMatchObject({label:'BUY 10',sub:'for 18 KEEP',action:'START',price:null});
    expect(m.buyQuantity(buy,lot)).toBe(10n);
    expect(m.buyQuantity({...buy,quantity:99n},lot)).toBe(20n);
    expect(m.buyQuantity({...buy,quantity:1n},{...lot,minimumPurchase:5n})).toBe(5n);
  });
  // An unknown balance is never SHORT: the wallet decides.
  it('BUY explains every refusal and never auto-spends', () => {
    expect(m.buyPrimary({...buy,offers:[{...lot,isMine:true}]})).toBeNull();
    expect(m.buyPrimary({...buy,wallet:{linked:false}})).toMatchObject({state:'LOCKED',action:'LINK_WALLET'});
    expect(m.buyPrimary({...buy,paymentsAvailable:false})?.reason).toBe('Wallet payments are not available in this build.');
    expect(m.buyPrimary({...buy,wallet:{linked:true,keepBaseUnits:5n*keep}})).toMatchObject({state:'SHORT',action:'NEED_MORE',price:{status:'SHORT'}});
    expect(m.buyPrimary({...buy,wallet:{linked:true,keepBaseUnits:null}})?.action).toBe('START');
  });
  // DESIGN-SYSTEM §6 money sequence: nothing can be sent twice; BOUGHT shows only after the receipt (the SENT stage).
  it('the money sequence never takes a second tap while in flight', () => {
    for (const money of ['CHECK_WALLET','SENDING'] as const) expect(m.buyPrimary({...buy,money})?.state).toBe('BUSY');
    expect(m.buyPrimary({...buy,money:'SENT'})).toMatchObject({label:'BOUGHT',verb:'MOSS',action:'NONE'});
    expect(m.buyPrimary({...buy,money:'FAILED'})).toMatchObject({label:'RETRY',action:'START'});
  });
  it('the BUY seal names pay and get and never claims a result', () => {
    const seal=m.buySeal(lot,10n,item,42);
    expect(seal).toMatchObject({title:'BUY 10 FROSTGLASS',price:{amount:'18',currency:'KEEP'},gets:{amount:'10',icon:item.icon},confirmLabel:'BUY',armedAtMs:42});
    expect(seal.lines.some(line=>line.includes('Nothing'))).toBe(false);
    expect(m.buySeal({...lot,currency:'SOL'},1n,item,0).lines[0]).toContain('SOL');
  });
  // Design correction 7: only an authoritative failure may say nothing was sent.
  it('a lost buy answer is checked, not declared unsent', () => {
    expect(m.buyFailureCopy(true)).toBe("Wallet didn't answer. Nothing was sent.");
    expect(m.buyFailureCopy(false)).not.toContain('Nothing');
  });
  it('lot lines name the price, the seller and what you hold', () => {
    expect(m.lotLines(lot,14n,item)).toEqual(['1.8 KEEP each · from Ashford','You hold 14. For tools and kits.']);
    expect(m.lotLines({...lot,isMine:true},14n,item)[1]).toBe('Your lot · manage it in ORDERS');
    expect(m.lotLines(lot,null,null)[1]).toBe('You hold ….');
  });
  it('SELL lists only what is free and explains locks and full slots', () => {
    expect(m.sellPrimary(sell)).toMatchObject({label:'LIST 10',sub:'Frostglass at 1.9 each'});
    expect(m.sellQuantity({...sell,qty:99n})).toBe(14n);
    expect(m.sellPrimary({...sell,listingAllowed:false})?.state).toBe('LOCKED');
    expect(m.sellPrimary({...sell,slots:{used:5,max:5}})).toMatchObject({action:'OPEN_ORDERS',reason:'All 5 slots are in use. Take one back in ORDERS.'});
    expect(m.proceedsLines(sell)).toEqual(['You get 18.05 KEEP','19 total, market fee 5%']);
    expect(m.listReview(sell)?.title).toBe('LIST 10 FROSTGLASS');
  });
  it('price steps by one server tick and never below it', () => {
    expect(m.stepPrice(19n*keep/10n,-1,keep/10n)).toBe(18n*keep/10n);
    expect(m.stepPrice(keep/10n,-1,keep/10n)).toBe(keep/10n);
    expect(m.stepPrice(null,1,keep/10n)).toBe(keep/10n);
    expect(m.stepPrice(5n,1,null)).toBe(5n);
  });
  it('orders read sold, on sale, paying and free slots', () => {
    expect(m.orderTitle('Crownsteel',6n)).toBe('CROWNSTEEL x6');
    expect(m.orderTitle('Land Deed',1n)).toBe('LAND DEED');
    const open: OpenOrderUi={listingId:'l-1',itemId:'frostglass',listed:10n,sold:4n,unitPrice:'1.9',currency:'KEEP',state:'OPEN',baseId:'b'};
    expect(m.openLine(open)).toBe('4 sold · 1.9 each');
    expect(m.openLine({...open,sold:0n})).toBe('none sold · 1.9 each');
    expect(m.openLine({...open,unitPrice:'2.5',currency:'SOL',state:'PAYING'})).toBe('2.5 SOL · buyer paying');
    expect(m.openProgress(open)).toBeCloseTo(.4);
    expect(m.freeSlotsLine({used:3,max:5})).toBe('2 free slots. List from SELL.');
    expect(m.freeSlotsLine({used:4,max:5})).toBe('1 free slot. List from SELL.');
    expect(m.freeSlotsLine(null)).toBeNull();
    expect(m.takeBackReview(open,item).line).toBe('Take back 6 Frostglass? They return to your stores.');
    expect(m.soldLine({proceeds:'14.4',currency:'KEEP',at:'2h ago'})).toBe('14.4 KEEP · 2h ago');
    expect(m.ordersPrimary().action).toBe('OPEN_SELL');
  });
  it('retains exact integer precision and native signed-Long overflow boundaries', () => {
    expect(m.formatUnits(9_007_199_254_740_993n,0)).toBe('9007199254740993');
    expect(m.formatUnits(-1_234_567_891n,9,2,true)).toBe('-1.24');
    expect(m.lotTotal(9_223_372_036_854_775_807n,2n)).toBeNull();
    expect(m.sellProceeds(1n,9_223_372_036_854_775_807n,500)).toBeNull();
  });
  it('order progress divides bigint quantities before the bounded display conversion',()=>{
    const open:OpenOrderUi={listingId:'large',itemId:'frostglass',listed:10n**400n,sold:4n*10n**399n,unitPrice:'1',currency:'KEEP',state:'OPEN',baseId:'b'};
    expect(m.openProgress(open)).toBe(.4);
    expect(m.openProgress({...open,sold:-1n})).toBe(0);
    expect(m.openProgress({...open,sold:open.listed+1n})).toBe(1);
    expect(m.openProgress({...open,sold:1n,listed:3n})).toBe(.3333);
  });
  it('fractional server fees remain unknown while UI price directions truncate',()=>{
    expect(m.feePercent(250.9)).toBe('…');
    expect(m.sellProceeds(1n,10000n,500.9)).toBeNull();
    expect(m.stepPrice(5n,.5,1n)).toBe(5n);
    for(const invalid of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
      expect(m.feePercent(invalid)).toBe('…');
      expect(m.sellProceeds(1n,100n,invalid)).toBeNull();
      expect(m.stepPrice(5n,invalid,1n)).toBeNull();
      expect(m.formatUnits(1n,invalid)).toBe('…');
    }
  });

});
