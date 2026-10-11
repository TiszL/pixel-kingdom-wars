import {CLANS,PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL,PHASE_E_CHARTER_TRANSFER,PHASE_E_CHARTER_ADMISSION,PHASE_E_POLICY,RAID_RULES} from '@shardkeep/shared';
import {SIM_VERSION} from '@shardkeep/sim';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {joinClan} from '../src/game/clans';
import {createTestPlayer} from './helpers';
import {charterSalesFixture,type CharterSalesFixture} from './fixtures/charterSales';
let f:CharterSalesFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesFixture();},120000);
afterEach(async()=>{const closing=f;f=undefined;try{await closing?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('does not adopt a real birth when enrollment occurs after the actual clan INSERT but before its genuine activation terminal',async()=>{
 const c=f!,policy={rosterCap:CLANS.rosterCap,anteSchedule:[...PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL],royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,
  basisPoints:PHASE_E_POLICY.basisPoints,simVersion:SIM_VERSION,batchGraceSeconds:RAID_RULES.batchOrdersGraceSec,
  titheBps:CLANS.chestTitheBps,observationMaxAgeMs:PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs};
 await c.sql`create table public.fixture_late_sale_epoch(domain jsonb not null,policy jsonb not null)`;
 await c.sql`insert into public.fixture_late_sale_epoch values(${JSON.stringify(c.domain)}::jsonb,${JSON.stringify(policy)}::jsonb)`;
 await c.sql.unsafe(`create function public.fixture_late_sale_epoch() returns trigger language plpgsql as $$declare input record;begin
  select * into strict input from public.fixture_late_sale_epoch;
  perform public.shardkeep_charter_sale_epoch(input.domain,input.policy);return NEW;end$$;
  create trigger zzz_fixture_late_sale_epoch after insert on public.clans for each row execute function public.fixture_late_sale_epoch();`);
 const birth=await c.birth();expect(birth.terminal.state).toBe('activated');
 expect(await c.sql`select count(*)::int n from charter_sale_epochs`).toEqual([{n:1}]);
 expect(await c.sql`select count(*)::int n from charter_creation_terminals where reservation_id=${birth.consent.reservationId}`).toEqual([{n:1}]);
 expect(await c.sql`select count(*)::int n from charter_sale_clan_inserts`).toEqual([{n:0}]);
 expect(await c.sql`select count(*)::int n from charter_sale_births`).toEqual([{n:0}]);
 const before=await c.salesSnapshot();await expect(c.draft(birth)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_SOURCE'});
 expect(await c.salesSnapshot()).toBe(before);
},120000);

it('keeps the real full-roster seat rule: an outside buyer can replace a leaving seller but cannot add a seat when the seller stays',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth();
 for(let i=1;i<CLANS.rosterCap;i++){const member=await createTestPlayer(c.db);await joinClan(c.db,member.wallet,birth.consent.clanId);}
 expect(await c.sql`select count(*)::int n from clan_members where clan_id=${birth.consent.clanId}`).toEqual([{n:CLANS.rosterCap}]);
 const staying=await c.draft(birth,{sellerLeaves:false}),before=await c.salesSnapshot();
 await expect(c.store().accept(c.buyer.wallet,staying.state.original.id,{termsHash:staying.state.original.termsHash,buyerBaseId:c.buyer.baseId}))
  .rejects.toMatchObject({code:'CLAN_CHARTER_SALE_CONFLICT'});
 expect(await c.salesSnapshot()).toBe(before);expect((await c.store().read(c.buyer.wallet,staying.state.original.id)).acceptance).toBeNull();
 const leaving=await c.draft(birth,{sellerLeaves:true}),accepted=await c.store().accept(c.buyer.wallet,leaving.state.original.id,
  {termsHash:leaving.state.original.termsHash,buyerBaseId:c.buyer.baseId});
 expect(accepted.status).toBe('accepted');
 expect(await c.sql`select count(*)::int n from clan_charter_member_roster where fence_id=${accepted.fenceId}`).toEqual([{n:CLANS.rosterCap}]);
 expect(await c.sql`select count(*)::int n from clan_members where player_wallet=${c.buyer.wallet}`).toEqual([{n:0}]);
},120000);
