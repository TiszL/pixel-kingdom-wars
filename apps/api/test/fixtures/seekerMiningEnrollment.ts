import {sql} from 'drizzle-orm';
import type {createDb} from '../../src/db/client';
import {withSeekerLinkHistoryFixture} from './seekerLinkHistory';
/** Disposable local database only. Install once before any enrollment; the
 * fixture changes table data afterwards so the source's clock definition stays
 * sealed. This is deliberately not exported from production code. */
export async function installMiningSeekerEnrollmentFixtureClock(conn:ReturnType<typeof createDb>):Promise<(at:string)=>Promise<void>>{
 const hosts=conn.sql.options.host;
 if(!hosts.every(host=>['localhost','127.0.0.1','::1'].includes(host)))throw new Error('enrollment fixture requires loopback');
 const [identity]=await conn.sql`select current_database() name,(select count(*)::int from public.mining_seeker_enrollments) n`;
 if(!identity||!/^\w+_test$/.test(identity.name)||identity.n!==0)throw new Error('enrollment fixture requires empty disposable DB');
 await conn.sql`create table public.test_mining_seeker_enrollment_clock(id boolean primary key check(id),at timestamptz not null check(isfinite(at)))`;
 await conn.sql`insert into public.test_mining_seeker_enrollment_clock values(true,public.shardkeep_mining_free_clock())`;
 await conn.db.transaction(async tx=>{
  await tx.execute(sql`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile set search_path=pg_catalog,public,pg_temp as $$ select at from public.test_mining_seeker_enrollment_clock where id $$`);
  // Capture the exact enabled contract before the one test-only reseal. Original
  // production guard bytes and enabled state are restored before committing.
  const [contract]=await tx.execute<{record:unknown}>(sql`select public.shardkeep_mining_seeker_enrollment_contract() record`);
  if(!contract)throw new Error('missing enrollment fixture source');
  await tx.execute(sql`alter table public.mining_seeker_enrollment_contract disable trigger mining_seeker_enrollment_contract_immutable`);
  await tx.execute(sql`update public.mining_seeker_enrollment_contract set record=${JSON.stringify(contract.record)}::jsonb where singleton`);
  await tx.execute(sql`alter table public.mining_seeker_enrollment_contract enable trigger mining_seeker_enrollment_contract_immutable`);
 });
 return async(at:string)=>{if(!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at))throw new Error('fixture clock');await conn.sql`update public.test_mining_seeker_enrollment_clock set at=${at}::timestamptz where id`;};
}
type Fixture=Parameters<Parameters<typeof withSeekerLinkHistoryFixture>[0]>[0];
export async function withSeekerMiningEnrollmentFixture(run:(f:Fixture)=>Promise<void>,options:Parameters<typeof withSeekerLinkHistoryFixture>[1]={}){
 await withSeekerLinkHistoryFixture(async f=>{const clock=await installMiningSeekerEnrollmentFixtureClock(f.conn);await run({...f,clock,close:()=>clock('2020-01-04T00:00:00Z')});},options);
}
