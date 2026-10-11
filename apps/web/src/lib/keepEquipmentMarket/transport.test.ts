import {KEEP_MARKET_ITEM_IDS_V4,KEEP_MARKET_ITEM_IDS,KEEP_MARKET_CRAFTING_CATALOGUE_IDS,KEEP_MARKET_EQUIPMENT_IDS} from '@shardkeep/shared/keepEquipmentMarketApi';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as M,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {keepMarketFixture,keepMarketReleasedFixture} from './fixtures.testHelpers';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('retains the owned late original before rejecting the obsolete view, without retrying fetch',async()=>{
 const f=keepMarketFixture();let current=true,resolve!:(response:Response)=>void;const fetch=vi.fn<typeof globalThis.fetch>(()=>new Promise(r=>{resolve=r;}));vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket}=await import('./transport'),retain=vi.fn(async()=>{}),result=requestKeepMarket({actor:f.value.fill.buyerWallet,request:{kind:'fill',action:'read',id:f.value.fill.id},isCurrent:()=>current,retain}).catch(e=>e);
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());current=false;resolve(json(f.value));expect(await result).toMatchObject({message:'Sign-in changed. Please try again.'});expect(retain).toHaveBeenCalledWith(f.value);expect(fetch).toHaveBeenCalledOnce();
});
it('binds owned receipts to actor and request ID before retention',async()=>{
 const f=keepMarketFixture(),fetch=vi.fn<typeof globalThis.fetch>(async()=>json(f.value));vi.stubGlobal('fetch',fetch);const {requestKeepMarket}=await import('./transport'),retain=vi.fn(async()=>{}),base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain};
 await expect(requestKeepMarket({...base,actor:f.value.fill.sellerWallet,request:{kind:'fill',action:'read',id:f.value.fill.id}})).rejects.toThrow();
 await expect(requestKeepMarket({...base,request:{kind:'fill',action:'read',id:crypto.randomUUID()}})).rejects.toThrow();expect(retain).not.toHaveBeenCalled();
});
it('does not dispatch injected proof, broadcaster, replacement message or irrelevant request fields',async()=>{
 const f=keepMarketFixture(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const {requestKeepMarket}=await import('./transport');
 for(const request of [{kind:'fill',action:'deliver',id:f.value.fill.id,body:{proof:{}}},{kind:'fill',action:'prepare',id:f.value.fill.id,body:{message:'00'}},{kind:'fill',action:'signed',id:f.value.fill.id,body:{signedTransactionHex:'ab'.repeat(100),rpc:'http://bad'}},{kind:'offers',action:'read',query:{wallet:'other'}},{kind:'fill',action:'read',id:f.value.fill.id,rpc:'bad'}] as any[])
  await expect(requestKeepMarket({actor:f.value.fill.buyerWallet,request,isCurrent:()=>true,retain:async()=>{}})).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled();
});
it('preserves existing endpoint families and refuses query smuggling before network access',async()=>{
 const api=await import('../api'),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const input={method:'GET' as const,path:'/keep-equipment-market/history',isCurrent:()=>true,timeoutMs:1000,observe:async()=>({})};
 for(const request of [api.requestUnpaidOriginal,api.requestMiningClaimOriginal,api.requestVehicleOriginal,api.requestCharterOriginal,api.requestRouteCompassOriginal])await expect(request(input)).rejects.toThrow();
 for(const path of ['/market/listings','/keep-equipment-market/history?proof=yes','/keep-equipment-market/listings?itemId=route_compass&itemId=survey_lens','/keep-equipment-market/../deposits','/keep-equipment-market/policy?version=2','/keep-equipment-market/listings#fragment'])await expect(api.requestKeepEquipmentOriginal({...input,path})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('receives a signed original in review before a caller rejects it as no longer signable',async()=>{
 const f=keepMarketFixture(),p=f.value.preparation!,{blockhashSlot:_slot,recordedAt:_at,...current}=p;
 const review={purchase:f.value,current:{...current,currentReviewPassed:true,finalityVerified:false},reviewedAt:p.recordedAt,expiresAt:'2035-01-01T00:00:30.000Z'};
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(review));vi.stubGlobal('fetch',fetch);const {requestKeepMarket}=await import('./transport'),retain=vi.fn(async()=>{});
 await requestKeepMarket({actor:f.value.fill.buyerWallet,request:{kind:'fill',action:'review',id:f.value.fill.id},isCurrent:()=>true,retain});expect(retain).toHaveBeenCalledWith(f.value);expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({});
});

it('retains a late terminal release through the dedicated empty-body route and refuses client proof input',async()=>{
 const f=keepMarketReleasedFixture();let current=true,finish!:(r:Response)=>void;const fetch=vi.fn<typeof globalThis.fetch>(()=>new Promise(resolve=>{finish=resolve;}));vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket}=await import('./transport'),retain=vi.fn(async()=>{}),request={kind:'fill' as const,action:'release' as const,id:f.value.fill.id};
 await expect(requestKeepMarket({actor:f.value.fill.buyerWallet,request:{...request,body:{proof:f.released.release!.proof}},isCurrent:()=>current,retain})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 const result=requestKeepMarket({actor:f.value.fill.buyerWallet,request,isCurrent:()=>current,retain}).catch(e=>e);await vi.waitFor(()=>expect(fetch).toHaveBeenCalledOnce());current=false;finish(json(f.released));
 expect(await result).toMatchObject({message:'Sign-in changed. Please try again.'});expect(retain).toHaveBeenCalledWith(f.released);expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({});expect(fetch.mock.calls[0]![0]).toContain('/release');
});

it('dispatches explicit v2 stock/category cursors through the real dedicated transport and keeps old requests legal',async()=>{
 const f=keepMarketFixture(),fetch=vi.fn<typeof globalThis.fetch>(async()=>json({items:[],nextCursor:null}));vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket,keepMarketEndpointAllowed}=await import('./transport'),base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain:async()=>{}};
 const query={catalogueVersion:'2',category:'resources',itemId:'heartwood_beams',before:f.value.fill.createdAt,beforeId:f.value.fill.listingId};
 await requestKeepMarket({...base,request:{kind:'offers',action:'read',query}});expect(Object.fromEntries(new URL(String(fetch.mock.calls[0]![0])).searchParams)).toEqual(query);
 const policy={version:1,decimals:TOKEN.decimals,minFillBaseUnits:M.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:P.reviewMaxAgeMs};
 const stock=(expanded:boolean)=>({wallet:base.actor,baseId:f.value.fill.buyerBaseId,serverNow:f.value.fill.createdAt,policy,...expanded?{catalogueVersion:2}:{},items:(expanded?KEEP_MARKET_CRAFTING_CATALOGUE_IDS:KEEP_MARKET_EQUIPMENT_IDS).map(itemId=>({itemId,available:'0',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'}))});
 fetch.mockResolvedValueOnce(json(stock(true)));await requestKeepMarket({...base,request:{kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId,query:{catalogueVersion:'2'}}});expect(String(fetch.mock.calls.at(-1)![0])).toContain('catalogueVersion=2');
 fetch.mockResolvedValueOnce(json(stock(false)));await requestKeepMarket({...base,request:{kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId}});
 fetch.mockResolvedValueOnce(json(stock(false)));await expect(requestKeepMarket({...base,request:{kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId,query:{catalogueVersion:'2'}}})).rejects.toThrow();
 const url='/keep-equipment-market/stock?baseId='+f.value.fill.buyerBaseId;expect(keepMarketEndpointAllowed('GET',url)).toBe(true);expect(keepMarketEndpointAllowed('GET',url+'&catalogueVersion=2')).toBe(true);
 for(const suffix of ['&catalogueVersion=1','&catalogueVersion=2&catalogueVersion=2','&category=resources','&proof=x'])expect(keepMarketEndpointAllowed('GET',url+suffix)).toBe(false);
 for(const path of ['/keep-equipment-market/listings?category=resources','/keep-equipment-market/history?catalogueVersion=2&category=resources&itemId=navigation_kit','/keep-equipment-market/listings?itemId=heartwood_beams'])expect(keepMarketEndpointAllowed('GET',path)).toBe(false);
});
it('rejects off-category discovery responses but retains exact new-item originals independently of catalogue selection',async()=>{
 const f=keepMarketFixture();f.value.fill.itemId='heartwood_beams';const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({wallet:f.value.fill.buyerWallet,items:[{kind:'fill',id:f.value.fill.id,baseId:f.value.fill.buyerBaseId,itemId:'heartwood_beams',createdAt:f.value.fill.createdAt}],nextCursor:null}));vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket}=await import('./transport'),retain=vi.fn(async()=>{}),base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain};
 for(const query of [{},{catalogueVersion:'2',category:'items'}])await expect(requestKeepMarket({...base,request:{kind:'history',action:'read',query}})).rejects.toThrow();
 await requestKeepMarket({...base,request:{kind:'history',action:'read',query:{catalogueVersion:'2',category:'resources'}}});expect(retain).not.toHaveBeenCalled();
 fetch.mockResolvedValueOnce(json(f.value));await requestKeepMarket({...base,request:{kind:'fill',action:'read',id:f.value.fill.id}});expect(retain).toHaveBeenCalledWith(f.value);expect(String(fetch.mock.calls.at(-1)![0])).not.toContain('catalogueVersion');
});
it('requires the requested exact stock catalogue and refuses fictitious fragment work or travel',async()=>{
 const f=keepMarketFixture(),fetch=vi.fn<typeof globalThis.fetch>();vi.stubGlobal('fetch',fetch);const {requestKeepMarket,keepMarketEndpointAllowed}=await import('./transport');
 const base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain:async()=>{}},policy={version:1,decimals:TOKEN.decimals,minFillBaseUnits:M.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:P.reviewMaxAgeMs};
 const stock=(version:2|3|undefined)=>({wallet:base.actor,baseId:f.value.fill.buyerBaseId,serverNow:f.value.fill.createdAt,policy,...version?{catalogueVersion:version}:{},items:(version===3?KEEP_MARKET_ITEM_IDS:version===2?KEEP_MARKET_CRAFTING_CATALOGUE_IDS:KEEP_MARKET_EQUIPMENT_IDS).map(itemId=>({itemId,available:'3',reserved:'0',pendingOutput:'0',marketOutgoing:'2',marketIncoming:'1'}))});
 for(const requested of [undefined,2,3] as const)for(const returned of [undefined,2,3] as const){
  fetch.mockResolvedValueOnce(json(stock(returned)));const result=requestKeepMarket({...base,request:{kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId,...requested?{query:{catalogueVersion:String(requested)}}:{}}});
  if(requested===returned)await expect(result).resolves.toEqual(stock(returned));else await expect(result).rejects.toThrow();
 }
 for(const field of ['reserved','pendingOutput'] as const){const invalid=stock(3);invalid.items.find(i=>i.itemId==='crystal_fragment')![field]='1';fetch.mockResolvedValueOnce(json(invalid));await expect(requestKeepMarket({...base,request:{kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId,query:{catalogueVersion:'3'}}})).rejects.toThrow();}
 const path='/keep-equipment-market/stock?baseId='+f.value.fill.buyerBaseId;expect(keepMarketEndpointAllowed('GET',path+'&catalogueVersion=3')).toBe(true);expect(keepMarketEndpointAllowed('GET',path+'&catalogueVersion=3&catalogueVersion=2')).toBe(false);
});
it('admits fragment discovery only in v3 Resources while keeping its exact original recoverable without discovery',async()=>{
 const f=keepMarketFixture();f.value.fill.itemId='crystal_fragment';const fetch=vi.fn<typeof globalThis.fetch>();vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket,keepMarketEndpointAllowed}=await import('./transport'),retain=vi.fn(async()=>{}),base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain};
 const listing={id:f.value.fill.listingId,sellerWallet:f.value.fill.sellerWallet,sellerBaseId:f.value.fill.sellerBaseId,itemId:'crystal_fragment',quantity:'3',unitPriceBaseUnits:f.value.fill.unitPriceBaseUnits,createdAt:f.value.fill.createdAt,availableQuantity:'3',reservedQuantity:'0',cancelledQuantity:'0'};
 for(const kind of ['offers','history'] as const){const page=kind==='offers'?{items:[listing],nextCursor:null}:{wallet:base.actor,items:[{kind:'fill',id:f.value.fill.id,baseId:f.value.fill.buyerBaseId,itemId:'crystal_fragment',createdAt:f.value.fill.createdAt}],nextCursor:null};
  for(const query of [{},{catalogueVersion:'2',category:'resources'},{catalogueVersion:'3',category:'items'},{catalogueVersion:'3',category:'resources',itemId:'heartwood_beams'}]){fetch.mockResolvedValueOnce(json(page));await expect(requestKeepMarket({...base,request:{kind,action:'read',query}})).rejects.toThrow();}
  const query={catalogueVersion:'3',category:'resources',itemId:'crystal_fragment',before:f.value.fill.createdAt,beforeId:f.value.fill.listingId,...kind==='history'?{beforeKind:'fill'}:{}};
  fetch.mockResolvedValueOnce(json(page));await requestKeepMarket({...base,request:{kind,action:'read',query}});expect(Object.fromEntries(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams)).toEqual(query);
 }
 expect(retain).not.toHaveBeenCalled();fetch.mockResolvedValueOnce(json(f.value));await requestKeepMarket({...base,request:{kind:'fill',action:'read',id:f.value.fill.id}});expect(retain).toHaveBeenCalledWith(f.value);expect(String(fetch.mock.calls.at(-1)![0])).not.toContain('catalogueVersion');
 for(const kind of ['listings','history']){expect(keepMarketEndpointAllowed('GET','/keep-equipment-market/'+kind+'?catalogueVersion=3&category=resources&itemId=crystal_fragment')).toBe(true);expect(keepMarketEndpointAllowed('GET','/keep-equipment-market/'+kind+'?catalogueVersion=2&itemId=crystal_fragment')).toBe(false);}
});

it('keeps new kit listings out of old discovery while catalogue4 includes both kits', async () => {
 const f=keepMarketFixture(),fetch=vi.fn<typeof globalThis.fetch>();vi.stubGlobal('fetch',fetch);
 const {requestKeepMarket,keepMarketEndpointAllowed}=await import('./transport'),base={actor:f.value.fill.buyerWallet,isCurrent:()=>true,retain:vi.fn(async()=>{})};
 const row={...f.value.fill,itemId:'expedition_kit',availableQuantity:f.value.fill.quantity,reservedQuantity:'0',cancelledQuantity:'0'};
 const listing={id:row.listingId,sellerWallet:row.sellerWallet,sellerBaseId:row.sellerBaseId,itemId:row.itemId,quantity:row.quantity,unitPriceBaseUnits:row.unitPriceBaseUnits,createdAt:row.createdAt,availableQuantity:row.availableQuantity,reservedQuantity:'0',cancelledQuantity:'0'};
 for(const version of [undefined,'2','3']){fetch.mockResolvedValueOnce(json({items:[listing],nextCursor:null}));await expect(requestKeepMarket({...base,request:{kind:'offers',action:'read',query:version?{catalogueVersion:version,category:'items'}:{}}})).rejects.toThrow();}
 fetch.mockResolvedValueOnce(json({items:[listing],nextCursor:null}));await requestKeepMarket({...base,request:{kind:'offers',action:'read',query:{catalogueVersion:'4',category:'items'}}});
 expect(base.retain).not.toHaveBeenCalled();expect(KEEP_MARKET_ITEM_IDS_V4).toContain('climate_kit');expect(KEEP_MARKET_ITEM_IDS_V4).toContain('expedition_kit');
 expect(keepMarketEndpointAllowed('GET','/keep-equipment-market/listings?catalogueVersion=4&itemId=expedition_kit&category=items')).toBe(true);
 expect(keepMarketEndpointAllowed('GET','/keep-equipment-market/listings?catalogueVersion=3&itemId=expedition_kit&category=items')).toBe(false);
});
