import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {baseArmy} from '../src/db/schema';
import {createCampaignRaid} from '../src/game/raids';
import {postgresLeaf} from './fixtures/charterPermitInventory';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Db} from '../src/db/client';
import {createClanCharterSales} from '../src/game/clanCharterSales';
import {charterSalesWorkflowFixture,salesPath,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
let f:SalesWorkflowFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const closing=f;f=undefined;try{await closing?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('rolls back the complete finalized roster projection and release when a later writer removes the new leader after early constraints passed',async()=>{
 const c=f!,app=await c.open(),p=await c.prepared(app),id=p.state.id;
 const retained=await c.post(app,`${salesPath}/${id}/signed`,c.signed(p.state).body);expect(retained.statusCode,retained.body).toBe(200);await c.finalize(id);
 const before=await c.salesSnapshot(),saved=await c.store().read(c.buyer.wallet,id);
 await c.sql`create sequence public.charter_sale_early_terminal_reached`;
 const transaction=c.db.transaction.bind(c.db),db=new Proxy(c.db,{get(target,key){
  if(key!=='transaction'){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}
  return (callback:Parameters<Db['transaction']>[0],config?:Parameters<Db['transaction']>[1])=>transaction(async tx=>{
   const result=await callback(tx);
   if(result&&typeof result==='object'&&'status'in result&&result.status==='completed'){
    await tx.execute(sql`set constraints all immediate`);
    await tx.execute(sql`select nextval('public.charter_sale_early_terminal_reached')`);
    await tx.execute(sql`delete from clan_members where player_wallet=${c.buyer.wallet}`);
   }return result;
  },config);
 }});
 const attacked=createClanCharterSales(db,c.options());
 await expect(attacked.recover(c.birth.actor.wallet,id)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_INCOMPLETE'});
 expect(await c.sql`select is_called from public.charter_sale_early_terminal_reached`).toEqual([{is_called:true}]);
 expect(await c.salesSnapshot()).toBe(before);expect(await c.store().read(c.buyer.wallet,id)).toEqual(saved);
 expect(await c.sql`select count(*)::int n from charter_sale_terminals where sale_id=${id}`).toEqual([{n:0}]);
 expect(await c.sql`select count(*)::int n from charter_sale_fence_releases where sale_id=${id}`).toEqual([{n:0}]);
 const completed=await c.post(app,`${salesPath}/${id}/recover`);expect(completed.statusCode,completed.body).toBe(200);expect(completed.json().status).toBe('completed');
 expect(await c.sql`select leader_wallet from clans where id=${c.birth.consent.clanId}`).toEqual([{leader_wallet:c.buyer.wallet}]);
 expect(await c.sql`select player_wallet from clan_members where clan_id=${c.birth.consent.clanId}`).toEqual([{player_wallet:c.buyer.wallet}]);
 expect(c.issuer.issueOnce).toHaveBeenCalledTimes(1);
},120000);


it('rechecks buyer raid-lock authority after early acceptance and attempt validation before either operation commits',async()=>{
 const c=f!,other=await c.actor();await c.db.insert(baseArmy).values({baseId:other.baseId,troop:'plunderer',count:1});
 const raid=await createCampaignRaid(c.db,other.wallet,1,randomUUID(),new Date(),{attackerBaseId:other.baseId,authorizeAttackerBase:async()=>{}});
 const app=await c.open(),p=await c.drafted(app),id=p.state.id;
 await c.sql`create sequence public.charter_sale_late_lock_reached`;
 for(const stage of ['accepted','issuing'] as const){
  const saved=await c.store().read(c.buyer.wallet,id),before=await c.salesSnapshot();let leaf:unknown;
  const transaction=c.db.transaction.bind(c.db),db=new Proxy(c.db,{get(target,key){
   if(key!=='transaction'){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}
   return (callback:Parameters<Db['transaction']>[0],config?:Parameters<Db['transaction']>[1])=>transaction(async tx=>{
    const result=await callback(tx);
    if(result&&typeof result==='object'&&'status'in result&&result.status===stage){
     await tx.execute(sql`set constraints all immediate`);
     await tx.execute(sql`select nextval('public.charter_sale_late_lock_reached')`);
     await tx.execute(sql`insert into base_raid_locks(base_id,raid_id,expires_at)
      select ${c.buyer.baseId}::uuid,id,orders_deadline_at from raids where id=${raid.id}::uuid`);
    }return result;
   },config).catch(error=>{leaf=postgresLeaf(error);throw error;});
  }});
  const attacked=createClanCharterSales(db,c.options());
  if(stage==='accepted')await expect(attacked.accept(c.buyer.wallet,id,{termsHash:p.state.original.termsHash,buyerBaseId:c.buyer.baseId})).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_HELD'});
  else await expect(attacked.prepare(c.birth.actor.wallet,id)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_HELD'});
  expect(leaf).toEqual({code:'P0001',message:'CLAN_CHARTER_MEMBER_SETTLEMENT_DESTINATION'});
  expect(await c.sql`select last_value::int,is_called from public.charter_sale_late_lock_reached`).toEqual([{last_value:stage==='accepted'?1:2,is_called:true}]);
  expect(await c.sql`select count(*)::int n from base_raid_locks where base_id=${c.buyer.baseId}`).toEqual([{n:0}]);
  expect(await c.salesSnapshot()).toBe(before);expect(await c.store().read(c.buyer.wallet,id)).toEqual(saved);expect(c.issuer.issueOnce).not.toHaveBeenCalled();
  if(stage==='accepted'){
   const service=createClanCharterSales(c.db,c.options());expect((await service.accept(c.buyer.wallet,id,{termsHash:p.state.original.termsHash,buyerBaseId:c.buyer.baseId})).status).toBe('accepted');
   expect((await service.payMembers(c.birth.actor.wallet,id)).status).toBe('members_paid');
  }
 }
 const prepared=await c.post(app,`${salesPath}/${id}/prepare`);expect(prepared.statusCode,prepared.body).toBe(200);expect(prepared.json().status).toBe('prepared');expect(c.issuer.issueOnce).toHaveBeenCalledTimes(1);
},120000);
