/** Actual earned Renown -> played Divine occupation -> original fragment delivery.
 * Deed/qualification/Seeker finality are declared local fixture banks. No fragment
 * inventory or award is seeded. The existing source wrapper owns its isolated DB. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {expect,vi} from 'vitest';
import {assertFreshLockedBaseAuthority,refreshBaseOwnership} from '../../src/game/baseOwnership';
import {createDivineFragments} from '../../src/game/divineFragments';
import {createSeekerFragmentClaims} from '../../src/game/seekerFragmentClaims';
import {withDivineFragmentFixture,type DivineFragmentFixture} from './divineFragments';

async function source(f:DivineFragmentFixture){
 await f.fragments.enroll(f.event.id);await f.play();const settlement=await f.settle();
 expect(settlement.awards).toHaveLength(2);
 const delivery=await f.fragments.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId});
 expect(delivery.quantity).toBe(settlement.awards.find(row=>row.wallet===f.wallet)!.net);
 const collection=f.options.deedCollection!;
 // Market admission is deed-only. This local deed conversion occurs after the
 // genuine personal award was delivered and does not author new fragment stock.
 const sellerDeed=Keypair.generate().publicKey.toBase58(),owners=new Map([[sellerDeed,f.wallet],[f.f.assetId,f.buyer]]);
 const now=()=>f.clock();vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now());
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('KEEP_EQUIPMENT_MARKET_ENABLED','true');
 await f.sql`update bases set deed_asset_id=${sellerDeed},land_paid_at=${now().toISOString()} where id=${f.baseId}`;
 const deedReader=async(asset:string)=>{const owner=owners.get(asset);return owner?{owner,collection,slot:100_000,frozen:false,delegate:null}:null;};
 const actor=(wallet:string,baseId:string,deed:string,signer:Keypair)=>({wallet,baseId,deed,signer,collection,get now(){return now();},authority:{baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}}});
 const seller=actor(f.wallet,f.baseId,sellerDeed,f.f.walletSigner),buyer=actor(f.buyer,f.buyerBaseId,f.f.assetId,f.f.buyerSigner);
 async function refresh(){for(const actor of [seller,buyer])expect(await refreshBaseOwnership(f.db,actor.baseId,deedReader,collection,now(),'fragment-market-fixture',now)).toBe('owned');}
 await refresh();
 const options={...f.options,finalizedDeedReader:deedReader},fragments=createDivineFragments(f.db,options),seeker=createSeekerFragmentClaims(f.db,options);
 const sourceReceipt=structuredClone(delivery),sourceAwards=structuredClone(settlement.awards),sourcePool=structuredClone(settlement.record);
 const share=(await seeker.terms(seller.wallet)).rows.find(row=>row.spotId===0)!;expect(BigInt(share.claimable)).toBeGreaterThan(0n);
 async function claimSourceShare(){await refresh();const receipt=await seeker.claim(seller.wallet,{idempotencyKey:randomUUID(),baseId:seller.baseId,termId:share.termId,spotId:share.spotId});expect(receipt.quantity).toBe(share.claimable);return receipt;}
 async function assertOriginalSource(){expect((await fragments.award(seller.wallet,f.event.id)).delivery).toEqual(sourceReceipt);const original=await fragments.settle(f.event.id);expect(original.awards).toEqual(sourceAwards);expect(original.record).toEqual(sourcePool);}
 const stock=async(baseId:string)=>(await f.sql`select available::text,market_outgoing::text,market_incoming::text from crystal_fragment_stocks where base_id=${baseId}`)[0]??{available:'0',market_outgoing:'0',market_incoming:'0'};
 return {f,conn:f.f.conn,db:f.db,seller,buyer,collection,owners,deedReader,clock:now,refresh,fragments,seeker,delivery,settlement,share,claimSourceShare,assertOriginalSource,stock};
}
export type FragmentMarketSource=Awaited<ReturnType<typeof source>>;
export async function withFragmentMarketSource(run:(f:FragmentMarketSource)=>Promise<void>){
 const oldMulti=process.env.MULTI_BASE_ENABLED,oldMarket=process.env.KEEP_EQUIPMENT_MARKET_ENABLED;
 try{await withDivineFragmentFixture(async f=>run(await source(f)));}
 finally{vi.useRealTimers();for(const [key,value] of [['MULTI_BASE_ENABLED',oldMulti],['KEEP_EQUIPMENT_MARKET_ENABLED',oldMarket]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
