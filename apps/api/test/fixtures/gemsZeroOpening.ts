import {sql} from 'drizzle-orm';
import {vi} from 'vitest';
import type {createDb} from '../../src/db/client';
import {bootstrapSystemAccounts,getOrCreatePlayerAccount} from '../../src/ledger';
import {initializeGemsFlowEvidence} from '../../src/mining/gemsFlowEvidence';
import {captureExistingMiningWallet,readExistingMiningWalletBaseline} from '../../src/mining/existingMiningWallet';
import {captureGemsZeroOpening,readGemsZeroOpening} from '../../src/mining/gemsZeroOpening';
import {withWalletActivityFixture} from './walletActivity';
import {resealExistingMiningWalletFixtureClock} from './existingMiningWallet';
/** Test clock changes are admitted once, before any opening, in an isolated DB. */
export async function resealGemsZeroOpeningFixtureClock(conn:ReturnType<typeof createDb>){
 if(!conn.sql.options.host.every(h=>['localhost','127.0.0.1','::1'].includes(h)))throw Error('zero-opening fixture requires loopback');
 const [r]=await conn.sql`select current_database() name,(select count(*)::int from mining_gems_zero_openings) n`;
 if(!r||!/^\w+_test$/.test(r.name)||r.n!==0)throw Error('zero-opening fixture requires empty disposable openings');
 await conn.db.transaction(async tx=>{const [c]=await tx.execute<{record:unknown}>(sql`select public.shardkeep_mining_gems_zero_contract() record`);if(!c)throw Error('missing zero contract');
 await tx.execute(sql`alter table public.mining_gems_zero_contract disable trigger mining_gems_zero_contract_immutable`);
 await tx.execute(sql`update public.mining_gems_zero_contract set record=${JSON.stringify(c.record)}::jsonb where singleton`);
 await tx.execute(sql`alter table public.mining_gems_zero_contract enable trigger mining_gems_zero_contract_immutable`);});
}
export async function withGemsZeroOpeningFixture(run:(f:Awaited<ReturnType<typeof extend>>)=>Promise<void>){
 await withWalletActivityFixture(async f=>run(await extend(f)),{birthAt:'2019-12-01T00:00:00Z',observedBirthAt:'2019-12-01T00:00:00Z',identityCoverageAt:'2019-12-30T00:00:00Z',activityCoverageAt:'2020-01-01T00:00:00Z',birthBeforeInitialization:true});
}
type Base=Parameters<Parameters<typeof withWalletActivityFixture>[0]>[0];
async function extend(f:Base){
 vi.stubEnv('GEMS_ENABLED','true');
 await f.conn.sql`create table public.test_gems_zero_clock(id boolean primary key check(id),at timestamptz not null check(isfinite(at)))`;
 await f.conn.sql`insert into public.test_gems_zero_clock values(true,'2019-12-31T00:00:00Z')`;
 await f.conn.sql`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile set search_path=pg_catalog,public,pg_temp as $$ select at from public.test_gems_zero_clock where id $$`;
 await resealExistingMiningWalletFixtureClock(f.conn);await resealGemsZeroOpeningFixtureClock(f.conn);
 const clock=async(at:string)=>{if(!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at)&&!/^2019-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at))throw Error('fixture clock');await f.conn.sql`update public.test_gems_zero_clock set at=${at}::timestamptz where id`;};
 const sys=await bootstrapSystemAccounts(f.conn.db),gems=await getOrCreatePlayerAccount(f.conn.db,f.wallet,'player_gems');
 await initializeGemsFlowEvidence(f.conn.db);await clock('2020-01-03T12:00:00.000000Z');await captureExistingMiningWallet(f.conn.db,f.wallet);
 const baseline=await readExistingMiningWalletBaseline(f.conn.db,{wallet:f.wallet});
 const capture=async(at='2020-01-03T12:00:00.000000Z')=>{await clock(at);await captureGemsZeroOpening(f.conn.db,{wallet:f.wallet,baselineId:baseline.id});const [r]=await f.conn.sql`select id from mining_gems_zero_openings where wallet=${f.wallet}`;return readGemsZeroOpening(f.conn.db,{wallet:f.wallet,openingId:r!.id});};
 return {...f,sys,gems,clock,baseline,capture,close:()=>clock('2020-01-05T00:00:00.000000Z')};
}
