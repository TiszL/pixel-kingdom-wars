/** Actual protected custody. Synthetic raw/refined opening balances are explicit;
 * Forge Ingots and Crystal Fragments must still prove their earned sources. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FORGE_INGOT } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { ORDINARY_REFINED_IDS } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import type { MiningContributionLine } from '@shardkeep/shared/miningContribution';
import { bases, baseSlots, buildings, resourceStocks, craftingStocks } from '../src/db/schema';
import { reserveMiningContribution, readMiningContribution, abortMiningContributions } from '../src/game/miningContributions';
import { rewardBaseShards, getBaseShardBalance } from '../src/game/baseEconomy';
import { readRaidExposedRawStock, reserveRawStock } from '../src/game/resourceStock';
import { startRefine, collectRefine, getWorkshopView } from '../src/game/workshop';
import { runMigrations } from '../src/db/migrate';
import { withDivineFragmentFixture } from './fixtures/divineFragments';
import { connectTestDb, createTestPlayer } from './helpers';
const conn=connectTestDb(),db=conn.db;let dateNumber=0;
afterAll(()=>conn.sql.end());
beforeEach(()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('FORGE_INGOTS_ENABLED','true');vi.stubEnv('PHASE_E_BUILDINGS_ENABLED','true');});
afterEach(()=>vi.unstubAllEnvs());
async function fixture(paid=true,wallet?:string,slot=1){
 wallet??=(await createTestPlayer(db)).wallet;
 const at=new Date(Date.UTC(2040,0,1+dateNumber++));
 const deed=randomUUID();
 const [base]=await db.insert(bases).values({ownerWallet:wallet,keepLevel:3,...(paid?{landPaidAt:new Date('2020-01-01'),deedAssetId:deed,deedMintAssetId:deed}:{})}).returning();
 const baseId=base!.id;await db.insert(baseSlots).values({wallet,baseId,slot});
 for(const [i,type] of (['keep','workshop','goldforge'] as const).entries())await db.insert(buildings).values({baseId,playerWallet:wallet,type,level:type==='keep'?3:1,tx:10+i*4,ty:10});
 const authority={baseId,assertAuthority:async()=>{}};
 const command=(lines:MiningContributionLine[])=>({idempotencyKey:randomUUID(),baseId,policyVersion:2 as const,expectedDay:at.toISOString().slice(0,10),lines});
 const reserve=(lines:MiningContributionLine[])=>reserveMiningContribution(db,wallet!,command(lines),authority,{clock:()=>at});
 return {wallet,baseId,at,authority,command,reserve};
}
it('protects all eight raw and nine refined identities; exact same-key replay and abort return every original quantity',async()=>{
 const f=await fixture();
 for(const resourceId of PHASE_E_RAW_RESOURCE_IDS)await db.insert(resourceStocks).values({baseId:f.baseId,resourceId,available:50n});
 for(const itemId of [...ORDINARY_REFINED_IDS,'navigation_kit'])await db.insert(craftingStocks).values({baseId:f.baseId,itemId,available:50n});
 const lines=[...PHASE_E_RAW_RESOURCE_IDS,...ORDINARY_REFINED_IDS,'navigation_kit' as const].map(resourceId=>({resourceId,quantity:'3'}));
 const cmd=f.command(lines),a=await reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at});expect(a.status).toBe('accepted');
 expect((await reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at})).receipt).toEqual(a.receipt);
 expect(a.receipt!.lines).toHaveLength(17);
 expect((await readRaidExposedRawStock(db,f.baseId)).every(r=>r.available==='47'&&r.total==='47')).toBe(true);
 const pending=await conn.sql`select mining_pending from resource_stocks where base_id=${f.baseId}`;expect(pending.every(r=>r.mining_pending==='3')).toBe(true);
 // Ordinary reservation remains raid-exposed and cannot absorb protected units.
 await reserveRawStock(db,f.wallet,{baseId:f.baseId,resourceId:PHASE_E_RAW_RESOURCE_IDS[0],quantity:1n,operationId:randomUUID()},f.authority);
 const abort={epochId:a.receipt!.epochId,decisionKey:randomUUID(),reason:'test-original-resource-return'};
 await abortMiningContributions(db,abort,f.at);await abortMiningContributions(db,abort,f.at);
 expect((await readMiningContribution(db,f.wallet,cmd.idempotencyKey,f.at)).settlement?.outcome).toBe('returned');
 expect((await conn.sql`select available,mining_pending from crafting_stocks where base_id=${f.baseId}`).every(r=>r.available==='50'&&r.mining_pending==='0')).toBe(true);
 expect((await readRaidExposedRawStock(db,f.baseId)).every(r=>r.total==='50')).toBe(true);
});
it('escrows SHARDS once and returns to the original base after transfer, with immutable balanced evidence',async()=>{
 const f=await fixture();await rewardBaseShards(db,f.baseId,90n,'test.mining',randomUUID());
 const cmd=f.command([{resourceId:'shards',quantity:'40'}]);const a=await reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at});
 expect(await getBaseShardBalance(db,f.baseId)).toBe(50n);
 const [r]=await conn.sql`select shards_txn_id from mining_contribution_receipts where id=${cmd.idempotencyKey}`;
 await expect(conn.sql`update ledger_transactions set metadata='{}' where id=${r!.shards_txn_id}`).rejects.toThrow();
 await expect(conn.sql`update accounts set balance=balance+1 where kind='mining_contribution_escrow'`).rejects.toThrow();
 const buyer=await createTestPlayer(db);await db.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));
 await db.update(baseSlots).set({wallet:buyer.wallet,active:false}).where(eq(baseSlots.baseId,f.baseId));
 vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect((await reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at})).receipt).toEqual(a.receipt);
 expect((await readMiningContribution(db,buyer.wallet,cmd.idempotencyKey,f.at)).status).toBe('unknown');
 await abortMiningContributions(db,{epochId:a.receipt!.epochId,decisionKey:randomUUID(),reason:'test-return-after-transfer'},f.at);
 expect(await getBaseShardBalance(db,f.baseId)).toBe(90n);
});
it('rolls back the entire basket and SHARDS posting when a later native resource is missing',async()=>{
 const f=await fixture();await rewardBaseShards(db,f.baseId,90n,'test.mining',randomUUID());
 const cmd=f.command([{resourceId:'shards',quantity:'40'},{resourceId:'thornsilk',quantity:'1'}]);
 await expect(reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at})).rejects.toMatchObject({code:'INSUFFICIENT_MINING_RESOURCES'});
 expect(await getBaseShardBalance(db,f.baseId)).toBe(90n);expect((await readMiningContribution(db,f.wallet,cmd.idempotencyKey,f.at)).status).toBe('unknown');
});
it('serializes concurrent overdrafts and same keys without changing original consent',async()=>{
 const f=await fixture();await db.insert(resourceStocks).values({baseId:f.baseId,resourceId:'heartwood_logs',available:5n});
 const cmd=f.command([{resourceId:'heartwood_logs',quantity:'4'}]);
 const results=await Promise.allSettled([reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at}),reserveMiningContribution(db,f.wallet,cmd,f.authority,{clock:()=>f.at}),f.reserve([{resourceId:'heartwood_logs',quantity:'4'}])]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
 await expect(reserveMiningContribution(db,f.wallet,{...cmd,lines:[{resourceId:'heartwood_logs',quantity:'1'}]},f.authority,{clock:()=>f.at})).rejects.toThrow();
});
it('retains free daily value across bases and rejects stale-day/development admission before custody',async()=>{
 const f=await fixture(false),other=await fixture(false,f.wallet,2);other.at.setTime(f.at.getTime());
 for(const baseId of [f.baseId,other.baseId])await rewardBaseShards(db,baseId,30_000n,'test.mining',randomUUID());
 await f.reserve([{resourceId:'shards',quantity:'15000'}]);
 await expect(other.reserve([{resourceId:'shards',quantity:'6000'}])).rejects.toMatchObject({code:'MINING_FREE_CAP_EXCEEDED'});
 const stale={...other.command([{resourceId:'shards',quantity:'1'}]),expectedDay:'2000-01-01'};
 await expect(reserveMiningContribution(db,f.wallet,stale,other.authority,{clock:()=>other.at})).rejects.toMatchObject({code:'MINING_DAY_CHANGED'});
 await db.update(bases).set({keepLevel:2}).where(eq(bases.id,other.baseId));
 await expect(other.reserve([{resourceId:'shards',quantity:'1'}])).rejects.toMatchObject({code:'DEVELOPMENT_REQUIRED'});
});
it('requires authentic Forge output and preserves Workshop holding capacity while committed',async()=>{
 const f=await fixture();await rewardBaseShards(db,f.baseId,BigInt(FORGE_INGOT.shardsPerIngot)*10n,'test.mining',randomUUID());
 const job=await startRefine(db,f.wallet,f.baseId,2,FORGE_INGOT.recipeVersion,randomUUID(),f.at,f.authority);
 f.at.setTime(new Date(job.readyAt).getTime());await collectRefine(db,f.wallet,f.baseId,job.jobId,randomUUID(),f.at,f.authority);
 const before=await getWorkshopView(db,f.wallet,f.baseId,f.at),a=await f.reserve([{resourceId:'forge_ingot',quantity:'2'}]);
 expect((await getWorkshopView(db,f.wallet,f.baseId,f.at)).allowance.holding.remaining).toBe(before.allowance.holding.remaining);
 await expect(conn.sql`update base_items set qty=qty+1 where base_id=${f.baseId} and item_id='forge_ingot'`).rejects.toThrow();
 await abortMiningContributions(db,{epochId:a.receipt!.epochId,decisionKey:randomUUID(),reason:'test-ingot-return'},f.at);
});
it('refuses forged pending projections, incomplete aborts, unearned fragments and forged legacy publication quantities',async()=>{
 const f=await fixture();await db.insert(resourceStocks).values({baseId:f.baseId,resourceId:'heartwood_logs',available:5n});
 const a=await f.reserve([{resourceId:'heartwood_logs',quantity:'1'}]);
 await expect(conn.sql`update resource_stocks set mining_pending=0 where base_id=${f.baseId}`).rejects.toThrow('MINING_CONTRIBUTION_PENDING');
 await expect(conn.sql`insert into mining_ingot_aborts(epoch_id,decision_key,reason,created_at) values(${a.receipt!.epochId},${randomUUID()},'partial-return',${f.at.toISOString()})`).rejects.toThrow('MINING_CONTRIBUTION_ABORT_INCOMPLETE');
 await expect(conn.sql`insert into crystal_fragment_stocks(base_id,available) values(${f.baseId},1)`).rejects.toThrow('DIVINE_FRAGMENT_STOCK_CONSERVATION');
 await expect(conn.sql`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes,reserved_ingots) values(${a.receipt!.epochId},${randomUUID()},decode('01','hex'),1)`).rejects.toThrow('MINING_PUBLICATION_DERIVED_FIELDS');
});
it('refuses the superseded custody migration twice and replays the current journal without changing the seal or originals',async()=>{
 const f=await fixture();await rewardBaseShards(db,f.baseId,10n,'test.mining',randomUUID());const a=await f.reserve([{resourceId:'shards',quantity:'3'}]);
 const old=readFileSync(new URL('../drizzle/0253_mining_contribution_custody.sql',import.meta.url),'utf8');
 await expect(conn.sql.begin(tx=>tx.unsafe(old))).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 // 0254 was the current prospective custody migration when this case was
 // written. Its successors (0259-0283) replaced the Divine fragment source and
 // guarded bodies, so re-running 0254 now reinstalls superseded custody and its
 // own 0254-era seal refuses it (the rule mining-funded-v2 pins since 0277).
 // Each attempt must fail atomically; the journal replay applies no SQL twice.
 const migration=readFileSync(new URL('../drizzle/0254_mining_resource_publication.sql',import.meta.url),'utf8');
 const seals=async()=>conn.sql`select (select record from divine_fragment_mining_contract where singleton) mining,(select record from divine_fragment_resource_publication_contract where singleton) publication`;
 const sealed=await seals();
 for(let n=0;n<2;n++){
  await expect(conn.sql.begin(async tx=>{for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(statement);})).rejects.toMatchObject({code:'P0001',message:'DIVINE_FRAGMENT_SOURCE'});
  await runMigrations(db);expect(await seals()).toEqual(sealed);await conn.sql`select public.shardkeep_divine_fragment_source()`;
  expect((await readMiningContribution(db,f.wallet,a.idempotencyKey,f.at)).receipt).toEqual(a.receipt);
 }
});
// Builds a whole fresh database (every migration) plus a played Divine trial
// before the first assertion; the default 30 s budget timed out in CI shard 2 and
// locally under load. Same 120 s budget as the other withDivineFragmentFixture cases.
it('commits only actually earned Divine fragments and returns the same protected units',async()=>withDivineFragmentFixture(async f=>{
 await f.fragments.enroll(f.event.id);await f.play();await f.settle();
 await f.fragments.deliver(f.wallet,f.event.id,{idempotencyKey:randomUUID(),baseId:f.baseId});
 await f.sql`update bases set keep_level=3 where id=${f.baseId}`;
 for(const [i,type] of ['keep','workshop','goldforge'].entries()){
  const existing=await f.sql`select id from buildings where base_id=${f.baseId} and type=${type}`;
  if(existing.length)await f.sql`update buildings set level=${type==='keep'?3:1} where base_id=${f.baseId} and type=${type}`;
  else await f.db.insert(buildings).values({baseId:f.baseId,playerWallet:f.wallet,type:type as 'keep'|'workshop'|'goldforge',level:type==='keep'?3:1,tx:25+i*4,ty:25});
 }
 const [before]=await f.sql`select available from crystal_fragment_stocks where base_id=${f.baseId}`;
 const cmd={idempotencyKey:randomUUID(),baseId:f.baseId,policyVersion:2 as const,expectedDay:f.clock().toISOString().slice(0,10),lines:[{resourceId:'crystal_fragment' as const,quantity:'1'}]};
 const a=await reserveMiningContribution(f.db,f.wallet,cmd,{baseId:f.baseId,assertAuthority:async()=>{}},{clock:f.clock});
 const [held]=await f.sql`select available,mining_pending from crystal_fragment_stocks where base_id=${f.baseId}`;
 expect(BigInt(held!.available)).toBe(BigInt(before!.available)-1n);expect(held!.mining_pending).toBe('1');
 await abortMiningContributions(f.db,{epochId:a.receipt!.epochId,decisionKey:randomUUID(),reason:'test-earned-fragment-return'},f.clock());
 expect((await f.sql`select available from crystal_fragment_stocks where base_id=${f.baseId}`)[0]!.available).toBe(before!.available);
}),120_000);
it('legacy stock roles retain ordinary writes but cannot erase pending stock by rename or TRUNCATE',async()=>{
 const f=await fixture();await db.insert(resourceStocks).values({baseId:f.baseId,resourceId:'heartwood_logs',available:5n});
 await f.reserve([{resourceId:'heartwood_logs',quantity:'1'}]);
 const role='mining_stock_'+randomUUID().replaceAll('-','');
 await conn.sql.unsafe(`create role ${role}`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}`);await conn.sql.unsafe(`grant select,insert,update,delete,truncate on resource_stocks to ${role}`);
  await conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`update resource_stocks set available=available-1 where base_id=${f.baseId}`;});
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`update resource_stocks set resource_id='frost_quartz',mining_pending=0 where base_id=${f.baseId}`;})).rejects.toThrow('MINING_CONTRIBUTION_PENDING');
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`truncate resource_stocks`;})).rejects.toThrow('MINING_CONTRIBUTION_PENDING');
 }finally{await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
});
it('reserves return capacity for SHARDS and raw materials at the exact int64 boundary',async()=>{
 const f=await fixture(),max=9223372036854775807n;
 await rewardBaseShards(db,f.baseId,10n,'test.mining',randomUUID());
 await db.insert(resourceStocks).values({baseId:f.baseId,resourceId:'heartwood_logs',available:max});
 const a=await f.reserve([{resourceId:'shards',quantity:'5'},{resourceId:'heartwood_logs',quantity:'5'}]);
 // A direct projection write must also preserve room for every owed return.
 await expect(conn.sql`update accounts set balance=${String(max-4n)}::bigint where kind='base_shards' and base_id=${f.baseId}`).rejects.toThrow('MINING_CONTRIBUTION_RETURN_CAPACITY');
 await expect(conn.sql`update resource_stocks set available=available+1 where base_id=${f.baseId}`).rejects.toThrow('resource_mining_capacity');
 await abortMiningContributions(db,{epochId:a.receipt!.epochId,decisionKey:randomUUID(),reason:'test-capacity-return'},f.at);
 expect(await getBaseShardBalance(db,f.baseId)).toBe(10n);
 expect((await readRaidExposedRawStock(db,f.baseId)).find(r=>r.resourceId==='heartwood_logs')!.available).toBe(String(max));
});
it('rejects extra or moved ledger legs, unbound escrow postings and duplicate native effects',async()=>{
 const f=await fixture();await rewardBaseShards(db,f.baseId,10n,'test.mining',randomUUID());const a=await f.reserve([{resourceId:'shards',quantity:'3'}]);
 const [r]=await conn.sql`select shards_txn_id from mining_contribution_receipts where id=${a.idempotencyKey}`;
 const [entry]=await conn.sql`select * from ledger_entries where txn_id=${r!.shards_txn_id} limit 1`;
 await expect(conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${r!.shards_txn_id},${entry!.account_id},0,0)`).rejects.toThrow('MINING_CONTRIBUTION_MONEY');
 await expect(conn.sql`update ledger_entries set delta=delta+1 where id=${entry!.id}`).rejects.toThrow('MINING_CONTRIBUTION_MONEY_IMMUTABLE');
 await expect(conn.sql`insert into ledger_transactions(idempotency_key,type) values(${randomUUID()},'mining.contribution.reserve')`).rejects.toThrow('MINING_CONTRIBUTION_MONEY_UNBOUND');
 await conn.sql`insert into mining_contribution_lines select * from mining_contribution_lines where receipt_id=${a.idempotencyKey} on conflict do nothing`;
 expect(await getBaseShardBalance(db,f.baseId)).toBe(7n);
});
it('rejects a stale repeatable-read legacy TRUNCATE after another connection commits custody',async()=>{
 const f=await fixture();await db.insert(resourceStocks).values({baseId:f.baseId,resourceId:'heartwood_logs',available:5n});
 const role='mining_rr_'+randomUUID().replaceAll('-',''),other=connectTestDb();
 await conn.sql.unsafe(`create role ${role}`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}`);await conn.sql.unsafe(`grant select,truncate on resource_stocks to ${role}`);
  await expect(other.sql.begin(async tx=>{
   await tx`set transaction isolation level repeatable read`;await tx.unsafe(`set local role ${role}`);
   expect((await tx`select mining_pending from resource_stocks where base_id=${f.baseId}`)[0]!.mining_pending).toBe('0');
   await f.reserve([{resourceId:'heartwood_logs',quantity:'1'}]);
   expect((await tx`select mining_pending from resource_stocks where base_id=${f.baseId}`)[0]!.mining_pending).toBe('0');
   await tx`truncate resource_stocks`;
  })).rejects.toThrow('MINING_CONTRIBUTION_READ_COMMITTED');
  expect((await conn.sql`select available,mining_pending from resource_stocks where base_id=${f.baseId}`)[0]).toMatchObject({available:'4',mining_pending:'1'});
 }finally{await other.sql.end();await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
});
