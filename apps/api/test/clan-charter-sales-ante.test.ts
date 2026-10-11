import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {charterSalesRaidFixture,type CharterSalesRaidFixture} from './fixtures/charterSalesRaid';
import {postgresLeaf} from './fixtures/charterPermitInventory';
let f:CharterSalesRaidFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesRaidFixture();},120000);
afterEach(async()=>{const closing=f;f=undefined;try{await closing?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('retains the real original charge after actual raid resolution and permits the paid member frontier',async()=>{
 const c=f!,raid=await c.raid();
 const [post]=await c.sql`select * from charter_sale_raid_admissions where raid_id=${raid.value.id}`;expect(BigInt(post!.ante_amount)).toBeGreaterThan(0n);
 const before=await c.sql`select balance::text from accounts where kind='shard_burn'`;
 await c.resolve(raid);const paid=await c.pay();
 const [proof]=await c.sql`select shardkeep_charter_sale_clearance(${paid.accepted.original.id}::uuid) value`;
 expect(proof!.value.raids).toHaveLength(1);expect(proof!.value.raids[0].classification).toBe('resolved-retained');
 expect(proof!.value.raids[0].admission.ante_post).toBe(post!.ante_post);expect(proof!.value.raids[0].entries).toHaveLength(2);
 expect(await c.sql`select balance::text from accounts where kind='shard_burn'`).toEqual(before);
 expect(await c.sql`select count(*)::int n from ledger_transactions where idempotency_key=${'raid-ante-refund:'+raid.value.id}`).toEqual([{n:0}]);
 expect((await c.store().read(c.buyer.wallet,paid.accepted.original.id)).memberPayment?.id).toBe(paid.paid.id);
},120000);

it('uses the actual system compensation reversal and preserves exact original entry identities before sale admission',async()=>{
 const c=f!,raid=await c.raid();expect(await c.compensate(raid)).toBe(true);const paid=await c.pay();
 const [proof]=await c.sql`select shardkeep_charter_sale_clearance(${paid.accepted.original.id}::uuid) value`,source=proof!.value.raids[0];
 expect(source.classification).toBe('system-refunded');expect(source.refund.original_transaction.idempotency_key).toBe('raid-ante-refund:'+raid.value.id);
 expect(source.refundEntries).toHaveLength(2);
 for(const entry of source.entries){const reversal=source.refundEntries.find((e:typeof entry)=>e.original_entry.account_id===entry.original_entry.account_id)!;
  expect(reversal.account_identity).toEqual(entry.account_identity);expect(BigInt(reversal.original_entry.delta)).toBe(-BigInt(entry.original_entry.delta));}
 // Snapshot after the defender's real funding, immediately before admission:
 // both actual ante accounts return to their pre-charge balances.
 const before=new Map(raid.before.map(r=>[r.id,r.balance])),after=new Map((await c.money()).map(r=>[r.id,r.balance]));
 for(const entry of source.entries)expect(after.get(entry.original_entry.account_id)).toBe(before.get(entry.original_entry.account_id));
 expect(paid.paid).toMatchObject({totalShards:'0',ledgerTransactionId:null});
},120000);

it('holds an early no-refund compensation despite a reconciled zero chest instead of guessing retained ante',async()=>{
 const c=f!,raid=await c.raid();expect(await c.compensate(raid,false)).toBe(true);const paid=await c.pay(),before=await c.salesSnapshot();
 // A bare internal no-refund request has no authenticated army-shortage facts.
 expect(await c.sql`select raid_id from charter_army_dispositions where raid_id=${raid.value.id}`).toHaveLength(0);
 const error=await c.sql`select shardkeep_charter_sale_clearance(${paid.accepted.original.id}::uuid)`.then(()=>null,error=>error);
 expect(postgresLeaf(error)).toEqual({code:'P0001',message:'CLAN_CHARTER_SALE_ANTE_AMBIGUOUS'});
 expect(await c.salesSnapshot()).toBe(before);expect((await c.store().read(c.buyer.wallet,paid.accepted.original.id)).inventory).toEqual({version:1,revision:'0',count:0,messages:[]});
},120000);
