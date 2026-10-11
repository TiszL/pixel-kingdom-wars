import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Keypair} from '@solana/web3.js';
import {fundCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {expect,it,vi} from 'vitest';
import {divineClanFragmentFixture} from './fixtures/divineClanFragments';
import {withMixedDivineFragmentFixture} from './fixtures/mixedDivineFragments';
import {playFragmentTrial} from './fixtures/divineFragments';
import {createDivineClanFragments} from '../src/game/divineClanFragments';
import {createDivineFragments} from '../src/game/divineFragments';
import {createSeekerFragmentClaims} from '../src/game/seekerFragmentClaims';
import {leaveClan,joinClan} from '../src/game/clans';
import {divineFragmentWeekAt} from '@shardkeep/shared/divineFragments';

it('actual D181 occupation pays every original roster share with unissued dust and one original Seeker pool',async()=>{
 const f=await divineClanFragmentFixture();try{
  await f.clan.enroll(f.event.id);await f.play();const stock=await f.sql`select * from crafting_stocks order by base_id,item_id`;
  const result=await f.settle();expect(result.record).toMatchObject({occupiedSites:1,gross:'39',net:'33',tax:'6',unissuedClan:'1961'});
  expect(result.awards).toHaveLength(3);expect(result.awards.map(a=>a.wallet).sort()).toEqual(f.members.map(a=>a.wallet).sort());
  for(const award of result.awards){expect(award).toMatchObject({site:'divine-clan-001',gross:'13',net:'11',tax:'2',carryBefore:'0',carryAfter:'6000',clan:{clanId:f.birth.consent.clanId,rosterSize:3,siteGross:'40',tournamentDomain:f.domain}});}
  // 2026-10-10: the member leaves at the fixture instant its deed was last observed (the settlement source clock), not
  // at the real wall clock; the old 2035 observation only looked fresh because it lay in the real future.
  await f.clear();await leaveClan(f.db,f.members[1]!.wallet,{baseId:f.members[1]!.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id,f.clock());}});await joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId);
  expect((await f.fragments.award(f.buyer.wallet,f.event.id)).award).toBeNull();
  for(const member of f.members){const receipt=await f.fragments.deliver(member.wallet,f.event.id,{baseId:member.baseId,idempotencyKey:randomUUID()});expect(receipt.quantity).toBe('11');}
  const terms=await f.seeker.term(f.source.wallet,result.term!.snapshot.termId);expect(terms.rows[0]).toMatchObject({poolTotal:'6',claimable:'3'});
  const receipt=await f.seeker.claim(f.source.wallet,{baseId:f.source.baseId,idempotencyKey:randomUUID(),termId:result.term!.snapshot.termId,spotId:0});expect(receipt.quantity).toBe('3');
  expect((await f.fragments.stock(f.source.wallet,f.source.baseId)).available).toBe('14');
  expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(stock);
  expect((await f.fragments.awards(f.members[1]!.wallet)).rows[0]?.award).toEqual(result.awards.find(a=>a.wallet===f.members[1]!.wallet));
 }finally{await f.dispose();}
},120000);

it('clan settlement and delivery races conserve once and original paused recovery survives destination transfer',async()=>{
 const f=await divineClanFragmentFixture();try{
  await f.clan.enroll(f.event.id);await f.play();
  const [first,second]=await f.withSourceClock(()=>Promise.all([f.clan.settle(f.event.id),f.clan.settle(f.event.id)]));expect(second).toEqual(first);
  const cmd={baseId:f.source.baseId,idempotencyKey:randomUUID()},results=await Promise.all([f.fragments.deliver(f.source.wallet,f.event.id,cmd),f.fragments.deliver(f.source.wallet,f.event.id,cmd)]);expect(results[0]).toEqual(results[1]);
  await expect(f.fragments.deliver(f.source.wallet,f.event.id,{...cmd,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DIVINE_FRAGMENT_IDEMPOTENCY_BODY_MISMATCH'});
  const termId=first.term!.snapshot.termId,claim={baseId:f.source.baseId,idempotencyKey:randomUUID(),termId,spotId:0};
  const claims=await Promise.all([f.seeker.claim(f.source.wallet,claim),f.seeker.claim(f.source.wallet,claim)]);expect(claims[0]).toEqual(claims[1]);
  const fragments=createDivineFragments(f.db,{...f.fragmentOptions,termSource:null,finalizedDeedReader:null}),seeker=createSeekerFragmentClaims(f.db,{...f.fragmentOptions,finalizedDeedReader:null});
  await f.sql.begin(async tx=>{await tx`update bases set owner_wallet=${f.buyer.wallet},status='inactive' where id=${f.source.baseId}`;await tx`update base_slots set active=false where base_id=${f.source.baseId}`;});
  process.env.PHASE_E_CATALOG_ENABLED='false';process.env.PHASE_E_SEEKER_ENABLED='false';
  expect(await fragments.deliver(f.source.wallet,f.event.id,cmd)).toEqual(results[0]);expect(await seeker.claim(f.source.wallet,claim)).toEqual(claims[0]);
  expect((await fragments.deliveryRead(f.buyer.wallet,cmd.idempotencyKey)).receipt).toBeNull();
  expect((await seeker.term(f.source.wallet,termId)).rows[0]).toMatchObject({poolTotal:'6',claimable:'0'});
  expect((await f.sql`select available::text from crystal_fragment_stocks where base_id=${f.source.baseId}`)[0]?.available).toBe('14');
 }finally{await f.dispose();}
},120000);

it('missing historical source cannot issue and proven zero-winning original term holds clan tax',async()=>{
 const f=await divineClanFragmentFixture(1,0);try{
  await f.clan.enroll(f.event.id);await f.play();
  const absent=createDivineClanFragments(f.db,{...f.fragmentOptions,domain:f.domain,termSource:null});await expect(absent.settle(f.event.id)).rejects.toMatchObject({code:'DIVINE_FRAGMENT_DISABLED'});
  expect(await f.sql`select * from divine_fragment_settlements`).toHaveLength(0);
  const settled=await f.settle();expect(settled.awards[0]).toMatchObject({gross:'40',net:'32',tax:'8',winnerCount:0,poolDisposition:'held_zero_winners'});
  expect((await f.seeker.terms(f.source.wallet)).rows).toEqual([]);
  expect((await f.fragments.deliver(f.source.wallet,f.event.id,{baseId:f.source.baseId,idempotencyKey:randomUUID()})).quantity).toBe('32');
 }finally{await f.dispose();}
},120000);

it('future-only clan enrollment rejects participation backfill, kind aliases and source-controlled fields',async()=>{
 const f=await divineClanFragmentFixture();try{
  await f.play();f.setTime(new Date(Date.parse(f.event.entryStartsAt)-86_400_000));
  await expect(f.clan.enroll(f.event.id)).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_ENROLLMENT'}});
  expect(await f.sql`select * from divine_fragment_enrollments`).toHaveLength(0);
  await expect(f.sql`insert into divine_fragment_enrollments(event_id,source_kind,week_start,domain,earned_at,enrolled_at) values(${f.event.id},'individual',${divineFragmentWeekAt(f.event.playEndsAt)},${JSON.stringify(f.fragmentOptions.domain)}::jsonb,${f.event.playEndsAt},${new Date(Date.parse(f.event.entryStartsAt)-86_400_000).toISOString()})`).rejects.toThrow();
 }finally{await f.dispose();}
},120000);

it('clan raw SQL cannot forge source/carry/stock, bypass early constraints or run under weaker roles/isolation',async()=>{
 const f=await divineClanFragmentFixture();try{
  await f.clan.enroll(f.event.id);await f.play();const settled=await f.settle();
  const migration=await readFile(new URL('../drizzle/0247_divine_clan_fragments.sql',import.meta.url),'utf8');
  // D195 extends the prospective seal; replaying D193 must not downgrade custody.
  await expect(f.sql.begin(async tx=>{await tx.unsafe(migration);})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');expect((await f.fragments.award(f.source.wallet,f.event.id)).award).toEqual(settled.awards.find(a=>a.wallet===f.source.wallet));
  for(const query of ["update divine_fragment_enrollments set source_kind='individual'","update divine_fragment_awards set record=jsonb_set(record,'{carryAfter}','\"0\"')","delete from divine_fragment_settlements","truncate divine_fragment_awards","update divine_fragment_clan_contract set record='{}'"])
   await expect(f.sql.begin(async tx=>{await tx`set constraints all immediate`;await tx.unsafe(query);})).rejects.toThrow();
  await expect(f.sql`insert into divine_fragment_awards(event_id,wallet,site,record) values(${f.event.id},${f.buyer.wallet},'divine-clan-001',${JSON.stringify({...settled.awards[0],wallet:f.buyer.wallet})}::jsonb)`).rejects.toThrow('DIVINE_FRAGMENT_AWARD');
  await expect(f.sql.begin(async tx=>{await tx`insert into divine_fragment_deliveries(id,event_id,wallet,base_id,quantity,record,delivered_at) values(${randomUUID()},${f.event.id},${f.source.wallet},${f.source.baseId},null,'{}',${f.clock().toISOString()})`;await tx`set constraints all immediate`;await tx`update crystal_fragment_stocks set available=available+1 where base_id=${f.source.baseId}`;})).rejects.toThrow('DIVINE_FRAGMENT_STOCK_CONSERVATION');
  expect(await f.sql`select * from divine_fragment_deliveries`).toHaveLength(0);
  await expect(f.sql.begin(async tx=>{await tx`alter table divine_fragment_awards disable trigger divine_fragment_awards_guard`;await tx.unsafe(migration);})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
  for(const isolation of ['repeatable read','serializable'])await expect(f.sql.begin(async tx=>{await tx.unsafe(`set transaction isolation level ${isolation}`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_OWNER_ISOLATION');
  const role='clan_fragment_'+randomUUID().replaceAll('-','');await f.sql.unsafe(`create role ${role} noinherit`);
  try{await expect(f.sql.begin(async tx=>{await tx.unsafe(`grant usage on schema public to ${role}`);await tx.unsafe(`grant select,insert on divine_fragment_awards to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow();}
  finally{await f.sql.unsafe(`drop owned by ${role}`);await f.sql.unsafe(`drop role ${role}`);}
 }finally{await f.dispose();}
},120000);

it('individual and clan production share deterministic order, carry and cumulative original-term top-ups',async()=>withMixedDivineFragmentFixture(async f=>{
 await f.enroll();await f.play();
 await expect(f.clan.settle()).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_ORDER'}});
 expect(await f.clan.sql`select * from divine_fragment_settlements`).toHaveLength(0);
 const individual=await f.settleIndividual(),original=individual.awards.find(a=>a.wallet===f.individual.wallet)!;
 expect(original).toMatchObject({gross:'14',tax:'2',carryAfter:'8000'});expect('clan' in original).toBe(false);
 const termId=individual.term!.snapshot.termId,cmd={termId,spotId:0,baseId:f.clan.source.baseId,idempotencyKey:randomUUID()};
 const first=await f.clan.seeker.claim(f.clan.source.wallet,cmd);expect(first).toMatchObject({poolTotal:'2',cumulativeTotal:'1',quantity:'1'});
 const clan=await f.clan.settle();expect(clan.record).toMatchObject({gross:'39',net:'32',tax:'7'});
 expect(clan.awards.find(a=>a.wallet===f.individual.wallet)).toMatchObject({gross:'13',net:'10',tax:'3',carryBefore:'8000',carryAfter:'4000'});
 const next=await f.clan.seeker.claim(f.clan.source.wallet,{...cmd,idempotencyKey:randomUUID()});expect(next).toMatchObject({poolTotal:'9',previousTotal:'1',cumulativeTotal:'4',quantity:'3'});
 expect((await f.issuer.award(f.individual.wallet,f.individualEvent.id)).award).toEqual(original);
 expect((await f.issuer.awards(f.individual.wallet)).rows).toHaveLength(2);
 expect(await f.clan.sql`select count(*)::int n from divine_fragment_periods`).toEqual([{n:1}]);
}),180000);

it('same-week late clan enrollment cannot backfill behind an already settled individual using a stale private clock',async()=>withMixedDivineFragmentFixture(async f=>{
 await f.issuer.enroll(f.individualEvent.id);
 // Leave the clan event completely unentered: only the common settled frontier,
 // not its own participation/terminal guard, can reject this stale enrollment.
 await playFragmentTrial(f.individual,f.individualEvent,[{wallet:f.individual.wallet,baseId:f.individual.baseId}]);await f.settleIndividual();
 expect(await f.clan.sql`select * from charter_tournament_entries where event_id=${f.clan.event.id}`).toHaveLength(0);
 f.clan.setTime(new Date(Date.parse(f.clan.event.entryStartsAt)-86_400_000));
 await expect(f.clan.clan.enroll(f.clan.event.id)).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_ENROLLMENT'}});
 expect(await f.clan.sql`select source_kind from divine_fragment_enrollments`).toEqual([{source_kind:'individual'}]);
}),180000);

it('alternate domain and event UUID cannot reopen the same global clan weekly allocation',async()=>{
 const f=await divineClanFragmentFixture(1);try{
  await f.clan.enroll(f.event.id);await f.source.refresh();
  const domain={...f.domain,craftProgram:Keypair.generate().publicKey.toBase58()};
  const other=await fundCharterTournamentEvent(f.db,f.source.wallet,{id:randomUUID(),baseId:f.source.baseId,weekStart:f.event.entryStartsAt,budget:Object.fromEntries(Object.keys(f.event.budget).map(k=>[k,'1'])) as typeof f.event.budget},
   {baseId:f.source.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}},
   {domain,sponsorWallet:f.source.wallet,clock:f.clock});
  const issuer=createDivineClanFragments(f.db,{...f.fragmentOptions,domain});
  await expect(issuer.enroll(other.id)).rejects.toMatchObject({cause:{code:'23505'}});
  expect(await f.sql`select event_id,source_kind from divine_fragment_enrollments`).toEqual([{event_id:f.event.id,source_kind:'clan'}]);
  await expect(f.fragments.enroll(f.event.id)).rejects.toMatchObject({code:'DIVINE_FRAGMENT_SOURCE_KIND'});
 }finally{await f.dispose();}
},120000);

it('concurrent individual and clan enrollment of one UUID rejects the losing source kind after the shared lock',async()=>withMixedDivineFragmentFixture(async f=>{
 const domain={...f.clan.domain,treasury:Keypair.generate().publicKey.toBase58()};await f.clan.source.refresh();
 const event=await fundCharterTournamentEvent(f.clan.db,f.clan.source.wallet,{id:f.individualEvent.id,baseId:f.clan.source.baseId,weekStart:f.clan.event.entryStartsAt,budget:Object.fromEntries(Object.keys(f.clan.event.budget).map(k=>[k,'1'])) as typeof f.clan.event.budget},
  {baseId:f.clan.source.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id);}},{domain,sponsorWallet:f.clan.source.wallet,clock:f.clan.clock});
 const clan=createDivineClanFragments(f.clan.db,{...f.clan.fragmentOptions,domain});
 const transaction=f.clan.db.transaction.bind(f.clan.db);let entered=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const spy=vi.spyOn(f.clan.db,'transaction').mockImplementation(async(...args)=>{if(++entered===2)release();await gate;return transaction(...args);});
 try{
  const results=await Promise.allSettled([f.issuer.enroll(event.id),clan.enroll(event.id)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'DIVINE_FRAGMENT_SOURCE_KIND'}});
  expect(await f.clan.sql`select * from divine_fragment_enrollments`).toHaveLength(1);
 }finally{spy.mockRestore();}
}),180000);
