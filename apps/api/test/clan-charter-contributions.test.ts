import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createCharterContributions} from '../src/db/charterContributions';
import {charterSalesWorkflowFixture,salesPath,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
let f:SalesWorkflowFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const old=f;f=undefined;try{await old?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function prepared(){
 const c=f!,app=await c.open(),p=await c.prepared(app),saved=await c.store().read(c.buyer.wallet,p.state.id),wire=c.signed(p.state),store=createCharterContributions(c.db);
 const input=(index:number)=>({attemptId:saved.attempt!.id,messageSha256:p.state.preparation!.packet.messageSha256,signature:Buffer.from(wire.tx.signatures[index]!).toString('base64')});
 return {c,app,p,saved,wire,store,input,buyer:c.buyer.wallet,seller:c.birth.actor.wallet,id:p.state.id};
}
it('retains one real wallet consent without relayable wire, then atomically combines both original signatures across restart',async()=>{
 const {c,p,store,input,buyer,seller,id,wire}=await prepared();
 expect(await store.read(buyer,id)).toEqual([]);
 await store.retain(seller,id,input(1));expect(await store.read(buyer,id)).toEqual([{wallet:seller,...input(1)}]);
 expect((await c.store().read(buyer,id)).signed).toBeNull();
 c.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const restarted=createCharterContributions(c.db);await restarted.retain(buyer,id,input(0));
 expect(await restarted.read(seller,id)).toEqual([{wallet:buyer,...input(0)},{wallet:seller,...input(1)}]);
 const saved=await c.store().read(buyer,id);expect(saved.status).toBe('signed');expect(saved.signed!.signedTransactionHex).toBe(wire.bytes.toString('hex'));
 const before=await c.sql`select to_jsonb(c) row from charter_sale_contributions c order by actor_wallet`;
 await restarted.retain(buyer,id,input(0));await restarted.retain(seller,id,input(1));
 expect(await c.sql`select to_jsonb(c) row from charter_sale_contributions c order by actor_wallet`).toEqual(before);
 expect(saved.original.id).toBe(p.state.id);
});
it('authenticates original participants and binds real signatures to the original attempt and exact message',async()=>{
 const {c,store,input,buyer,seller,id}=await prepared(),other=await c.actor();
 for(const target of [id,randomUUID()])await expect(store.retain(other.wallet,target,input(0))).rejects.toMatchObject({statusCode:404});
 for(const value of [{...input(0),attemptId:randomUUID()},{...input(0),messageSha256:'ab'.repeat(32)},input(1),{...input(0),signature:Buffer.alloc(64).toString('base64')}, {...input(0),signature:input(0).signature+'\n'}, {...input(0),seller}]){
  await expect(store.retain(buyer,id,value)).rejects.toMatchObject({statusCode:400});
 }
 expect(await store.read(seller,id)).toEqual([]);expect((await c.store().read(buyer,id)).signed).toBeNull();
});
it('preserves an existing fully signed internal packet with no contributions and only accepts its exact signer slots',async()=>{
 const {c,app,store,input,buyer,seller,id,wire}=await prepared();
 expect((await c.post(app,`${salesPath}/${id}/signed`,wire.body)).statusCode).toBe(200);
 expect(await store.read(buyer,id)).toEqual([]);await store.retain(buyer,id,input(0));await store.retain(seller,id,input(1));
 expect((await c.store().read(seller,id)).signed!.signedTransactionHex).toBe(wire.bytes.toString('hex'));
 expect(await store.read(seller,id)).toHaveLength(2);
});
it('does not add a late partial consent after strict original expiry cancellation',async()=>{
 const {c,app,store,input,buyer,seller,id,saved}=await prepared();
 await store.retain(buyer,id,input(0));const candidate=Buffer.from(saved.attempt!.candidateHex,'hex');c.bank.clock.writeBigInt64LE(candidate.readBigInt64LE(121)+1n,32);
 const cancelled=await c.post(app,`${salesPath}/${id}/cancel`);expect(cancelled.statusCode,cancelled.body).toBe(200);expect(cancelled.json().status).toBe('cancelled');
 await store.retain(seller,id,input(1));expect(await store.read(seller,id)).toEqual([{wallet:buyer,...input(0)}]);expect((await c.store().read(seller,id)).signed).toBeNull();
});
it('serializes two independent party submissions without losing consent or exposing two rows without a wire',async()=>{
 const {c,store,input,buyer,seller,id,wire}=await prepared();
 const outcomes=await Promise.allSettled([store.retain(buyer,id,input(0)),createCharterContributions(c.db).retain(seller,id,input(1))]);
 for(const [index,result] of outcomes.entries())if(result.status==='rejected'){
  expect(result.reason).toMatchObject({statusCode:409,code:'CLAN_CHARTER_SALE_BUSY'});await store.retain(index===0?buyer:seller,id,input(index));
 }
 expect(await store.read(seller,id)).toHaveLength(2);expect((await c.store().read(buyer,id)).signed!.signedTransactionHex).toBe(wire.bytes.toString('hex'));
});
