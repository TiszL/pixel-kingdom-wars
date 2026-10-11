import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {joinClan} from '../src/game/clans';
import {createClanCharterSalesStore} from '../src/db/charterSales';
import {charterSalesFixture,type CharterSalesFixture} from './fixtures/charterSales';
let f:CharterSalesFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesFixture();});
afterEach(async()=>{const closing=f;f=undefined;try{await closing?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}});

it('captures a real post-epoch creation birth and pays a zero-raid chest without inventing a raid or ledger post',async()=>{
 const c=f!,epoch=await c.initialize(),birth=await c.birth(),draft=await c.draft(birth);
 expect(draft.state).toMatchObject({status:'draft',original:{clanId:birth.consent.clanId,seller:birth.actor.wallet,epochId:epoch.id,expectedRevision:0}});
 const accepted=await c.store().accept(c.buyer.wallet,draft.state.original.id,{termsHash:draft.state.original.termsHash,buyerBaseId:c.buyer.baseId});
 expect(accepted).toMatchObject({status:'accepted',inventory:{revision:'0',count:0,messages:[]}});expect(accepted.fenceId).not.toBeNull();
 const before=await c.salesSnapshot(),paid=await c.memberSettlement().settle(birth.actor.wallet,accepted.fenceId!);
 expect(paid).toMatchObject({totalShards:'0',ledgerTransactionId:null});expect(await c.salesSnapshot()).toBe(before);
 expect(await c.sql`select count(*)::int n from clan_charter_raid_events where original_clan_id=${birth.consent.clanId}`).toEqual([{n:0}]);
 expect(await c.store().read(c.buyer.wallet,accepted.original.id)).toMatchObject({status:'members_paid',memberPayment:{id:paid.id,totalShards:'0'}});
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const offline=createClanCharterSalesStore(c.db);
 expect(await offline.create(birth.actor.wallet,draft.input,null)).toEqual(await offline.read(birth.actor.wallet,accepted.original.id));
});

it('holds an already activated clan when the ordinary-only epoch did not precede its actual birth',async()=>{
 const c=f!,birth=await c.birth();await c.initialize();const before=await c.salesSnapshot();
 await expect(c.draft(birth)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_SOURCE'});
 expect(await c.salesSnapshot()).toBe(before);
});

it('reserves the accepted buyer against the legacy join writer without requiring its player lock',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),otherActor=await c.actor(),other=await c.birth(otherActor),draft=await c.draft(birth);
 const accepted=await c.store().accept(c.buyer.wallet,draft.state.original.id,{termsHash:draft.state.original.termsHash,buyerBaseId:c.buyer.baseId});
 expect(accepted.status).toBe('accepted');const before=await c.salesSnapshot();
 await expect(joinClan(c.db,c.buyer.wallet,other.consent.clanId)).rejects.toThrow();expect(await c.salesSnapshot()).toBe(before);
 expect(await c.store().read(birth.actor.wallet,accepted.original.id)).toMatchObject({status:'accepted',acceptance:{buyerBaseId:c.buyer.baseId}});
});
