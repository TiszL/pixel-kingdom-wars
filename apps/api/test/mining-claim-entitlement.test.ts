import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi } from 'vitest';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof,verifyMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { createDb } from '../src/db/client';
import { projectMiningClaimEntitlements,createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import { withMiningClaimEntitlementFixture as fixture } from './fixtures/miningClaimEntitlement';
describe('settled first-root wallet entitlements',()=>{
 it('returns only the authenticated wallet proof from a complete actual settled two-wallet projection',async()=>fixture(async f=>{
  const read=createMiningClaimEntitlementReader(f.conn.db,f.identity);expect(await read(f.wallet)).toMatchObject({kind:'unavailable'});
  await expect(projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId})).rejects.toMatchObject({code:'NOT_SETTLED'});
  await f.settle();const header=await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});expect(header.leafCount).toBe(2);
  const result=await read(f.wallet);expect(result.kind).toBe('entitlement');if(result.kind!=='entitlement')throw Error('Expected own leaf');
  expect(result.leaf.wallet).toBe(f.wallet);expect(result.proofHex.length).toBe((4+41)*2);expect(result.claimabilityVerified).toBe(false);
  expect(verifyMiningAllocationProof(decodeMiningAllocationLeaf(Buffer.from(result.leafHex,'hex')),decodeMiningAllocationProof(Buffer.from(result.proofHex,'hex')),Buffer.from(result.header.root,'hex'),BigInt(result.header.totalCumulative))).toBe(true);
  expect(JSON.stringify(result)).not.toContain(f.buyer);expect(Object.keys(result).sort()).toEqual(['claimabilityVerified','header','kind','leaf','leafHex','leafIndex','preparationAuthorized','proofHex']);
  expect(await read(Keypair.generate().publicKey.toBase58())).toMatchObject({kind:'no_allocation',header});
  expect((await read(f.buyer)).kind).toBe('entitlement');
 }));
 it('replays complete projection after pause and reconnect, while mismatched chain identity stays unavailable',async()=>fixture(async f=>{
  await f.settle();const first=await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  expect(await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId})).toEqual(first);
  const conn=createDb(f.url.toString());try{expect((await createMiningClaimEntitlementReader(conn.db,f.identity)(f.wallet)).kind).toBe('entitlement');}finally{await conn.sql.end();}
  expect(await createMiningClaimEntitlementReader(f.conn.db,{...f.identity,genesisHash:Keypair.generate().publicKey.toBase58()})(f.wallet)).toMatchObject({kind:'unavailable'});
  await expect(createMiningClaimEntitlementReader(f.conn.db,f.identity)({wallet:f.wallet} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
 }));
 it('serializes concurrent projection and retains complete rows through migration retries',async()=>fixture(async f=>{
  await f.settle();const runs=await Promise.allSettled([projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId}),projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId})]);expect(runs.some(r=>r.status==='fulfilled')).toBe(true);
  const first=await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});for(const r of runs)if(r.status==='fulfilled')expect(r.value).toEqual(first);else expect(r.reason).toMatchObject({code:'BUSY'});
  const migration=readFileSync(new URL('../drizzle/0172_mining_claim_entitlements.sql',import.meta.url),'utf8');for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});
  expect(await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId})).toEqual(first);expect(await f.conn.sql`select wallet from mining_claim_entitlement_leaves`).toHaveLength(2);
 }));
 it('rejects incomplete header commit and rolls back every projection row',async()=>fixture(async f=>{
  await f.settle();await expect(f.conn.sql`insert into mining_claim_entitlement_headers(epoch_id) values(${f.epochId})`).rejects.toThrow('MINING_ENTITLEMENT_INCOMPLETE');
  expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers`).toHaveLength(0);expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.wallet)).kind).toBe('unavailable');
  await f.conn.sql.unsafe("create function test_fail_claim_leaf() returns trigger language plpgsql as $$begin raise exception 'injected leaf failure';end$$;create trigger test_fail_claim_leaf before insert on mining_claim_entitlement_leaves for each row execute function test_fail_claim_leaf()");
  await expect(projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId})).rejects.toMatchObject({cause:{message:'injected leaf failure'}});
  expect(await f.conn.sql`select epoch_id from mining_claim_entitlement_headers`).toHaveLength(0);
 }));
 it('allows minimal runtime reads without private-source grants and denies broad-grant runtime forgery',async()=>fixture(async f=>{
  await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});const role=`claim_read_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on mining_claim_entitlement_headers,mining_claim_entitlement_leaves to ${role}`);
  try{await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect((await createMiningClaimEntitlementReader(tx,f.identity)(f.wallet)).kind).toBe('entitlement');});
   await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}`);
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_claim_entitlement_headers(epoch_id) values(${f.epochId})`;})).rejects.toThrow('MINING_ENTITLEMENT_OWNER_REQUIRED');
   await expect(f.conn.sql`delete from mining_claim_entitlement_leaves`).rejects.toThrow('MINING_ENTITLEMENT_IMMUTABLE');
   await expect(f.conn.sql`truncate mining_claim_entitlement_headers cascade`).rejects.toThrow('MINING_ENTITLEMENT_IMMUTABLE');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('migration grants the existing API runtime SELECT only on the public projection',async()=>fixture(async f=>{
  await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});
  const rollback=Error('rollback fixture role and grants');
  const migration=readFileSync(new URL('../drizzle/0172_mining_claim_entitlements.sql',import.meta.url),'utf8');
  await expect(f.conn.db.transaction(async tx=>{
   // A missing cluster role is created only inside this rolled-back transaction.
   // Other fixtures cannot observe it, and any preexisting role stays untouched.
   await tx.execute(sql.raw("do $$begin if not exists(select 1 from pg_roles where rolname='shardkeep_api_runtime') then create role shardkeep_api_runtime;end if;end$$"));
   await tx.execute(sql.raw('grant usage on schema public to shardkeep_api_runtime;revoke all on all tables in schema public from shardkeep_api_runtime'));
   for(const statement of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.execute(sql.raw(statement));
   const [privileges]=await tx.execute<{header:boolean;leaf:boolean;manifest:boolean;write:boolean}>(sql`select
    has_table_privilege('shardkeep_api_runtime','mining_claim_entitlement_headers','SELECT') as header,
    has_table_privilege('shardkeep_api_runtime','mining_claim_entitlement_leaves','SELECT') as leaf,
    has_table_privilege('shardkeep_api_runtime','mining_publication_manifests','SELECT') as manifest,
    has_table_privilege('shardkeep_api_runtime','mining_claim_entitlement_leaves','INSERT') as write`);
   expect(privileges).toEqual({header:true,leaf:true,manifest:false,write:false});
   await tx.execute(sql.raw('set local role shardkeep_api_runtime'));
   expect((await createMiningClaimEntitlementReader(tx,f.identity)(f.wallet)).kind).toBe('entitlement');
   throw rollback;
  })).rejects.toBe(rollback);
 }));
});
