import {readFile} from 'node:fs/promises';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {memberSettlementFixture,type MemberSettlementFixture} from './fixtures/clanCharterMemberSettlement';
let f:MemberSettlementFixture|undefined;
beforeEach(async()=>{f=await memberSettlementFixture();},120_000);
afterEach(async()=>{try{await f?.close();}finally{f=undefined;vi.restoreAllMocks();vi.unstubAllEnvs();}},120_000);

it('retains real private receipts against owner rewrites and detects damaged witnesses after repeatable DDL',async()=>{
 const c=f!,s=await c.source(),service=c.service(),paid=await service.settle(s.leader.wallet,s.fence.fenceId),before=await c.snapshot();
 for(const [table,column] of [['clan_charter_member_payments','id'],['clan_charter_member_posts','ledger_id'],
  ['clan_charter_member_entries','entry_id'],['clan_charter_member_effects','target_id']] as const){
  await expect(c.sql.unsafe(`update public.${table} set ${column}=${column}`)).rejects.toThrow();
  await expect(c.sql.unsafe(`delete from public.${table}`)).rejects.toThrow();
  await expect(c.sql.unsafe(`truncate public.${table} cascade`)).rejects.toThrow();
 }
 const migration=await readFile(new URL('../drizzle/0229_clan_charter_member_payments.sql',import.meta.url),'utf8');
 await c.db.transaction(async tx=>{for(const part of migration.split('--> statement-breakpoint'))if(part.trim())await tx.execute(sql.raw(part));});
 expect(await service.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(before);
 const [witness]=await c.sql`select entry_id::text,original_entry from clan_charter_member_entries order by entry_id limit 1`;
 // A privileged corruption fixture deliberately bypasses storage guards. The
 // receipt reader must detect damage after ordinary canonical hooks return.
 await c.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;
  await tx`update clan_charter_member_entries set original_entry=jsonb_set(original_entry,'{delta}','0'::jsonb) where entry_id=${witness!.entry_id}`;});
 await expect(service.read(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject({code:'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE'});
 await c.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;
  await tx`update clan_charter_member_entries set original_entry=${JSON.stringify(witness!.original_entry)}::jsonb where entry_id=${witness!.entry_id}`;});
 expect(await service.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(before);
});

it('rejects conditional and column-restricted copies of a mandatory private hook while preserving paid history',async()=>{
 const c=f!,s=await c.source(),service=c.service(),paid=await service.settle(s.leader.wallet,s.fence.fenceId),before=await c.snapshot();
 for(const variant of ['before insert or update or delete on clan_charter_member_payments for each row when (false)',
  'before insert or update of id or delete on clan_charter_member_payments for each row']){
  await c.sql`drop trigger clan_charter_member_payments_guard on clan_charter_member_payments`;
  await c.sql.unsafe(`create trigger clan_charter_member_payments_guard ${variant} execute function public.shardkeep_charter_member_payment_private()`);
  try{await expect(service.read(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject({code:'CLAN_CHARTER_MEMBER_SETTLEMENT_SOURCE'});}
  finally{
   await c.sql`drop trigger clan_charter_member_payments_guard on clan_charter_member_payments`;
   await c.sql`create trigger clan_charter_member_payments_guard before insert or update or delete on clan_charter_member_payments
    for each row execute function public.shardkeep_charter_member_payment_private()`;
  }
 }
 expect(await service.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(before);
});
