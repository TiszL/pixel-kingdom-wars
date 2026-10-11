/** Coordinator acceptance over genuine local Charter birth/lock/raid sources.
 * These finalized bank fixtures are not a live issuer or SBF claim. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,expect,it,vi} from 'vitest';
import {RAID_RULES} from '@shardkeep/shared';
import {baseArmy} from '../src/db/schema';
import {createDivineClanRuntime} from '../src/game/divineClanRuntime';
import {createDivineRuntime} from '../src/game/divineRuntime';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {acceptLiveRaidCommand} from '../src/game/liveRaids';
import {recoverDueStartedLiveRaids} from '../src/game/raids';
import {joinClan,leaveClan} from '../src/game/clans';
import {divineClanFragmentFixture,type DivineClanFragmentFixture} from './fixtures/divineClanFragments';

afterEach(()=>vi.unstubAllEnvs());
function runtime(f:DivineClanFragmentFixture){
 let connections=0;
 const history={clock:f.clock,finalizedDeedReader:f.reader,deedCollection:f.source.collection};
 const options={history,funding:{domain:f.domain,sponsorWallet:f.source.wallet},
  term:{policy:f.fragmentBank.policy,connect:(signal:AbortSignal)=>{connections++;return f.fragmentBank.connect(signal);}},
  tournaments:{chain:f.lockChain,issuer:f.lockIssuer,clock:f.clock}};
 return {options,service:createDivineClanRuntime(f.db,options),reads:()=>connections};
}
const funding=(f:DivineClanFragmentFixture)=>({id:f.event.id,baseId:f.source.baseId,weekStart:f.event.entryStartsAt,budget:f.event.budget});
async function complete(f:DivineClanFragmentFixture,r:ReturnType<typeof runtime>['service'],id:string){
 // The existing typed issuer fixture selects and independently verifies this
 // original candidate. The coordinator never supplies a receipt or winner.
 const prepared=await f.prepare(id);
 await r.deps.charterTournamentProvider.retainSigned(f.source.wallet,id,f.signed(prepared));
 await f.finalizeLock(id);return r.deps.charterTournamentProvider.recover(f.source.wallet,id);
}
it('coordinates a real enrolled original lock and simulated raid into immutable clan shares and saved recovery',async()=>{
 const f=await divineClanFragmentFixture();try{
  const r=runtime(f),{charterTournamentProvider:locks,charterTournamentEventsProvider:events}=r.service.deps,operator=r.service.operator!;
  expect(Object.keys(operator).sort()).toEqual(['closeAndSettle','enroll','fundAndEnroll','initializeEpoch']);expect(r.service.deps).not.toHaveProperty('operator');
  const stock=await f.sql`select item_id,available from crafting_stocks where base_id=${f.source.baseId} order by item_id`;
  await operator.fundAndEnroll(f.source.wallet,funding(f));await operator.fundAndEnroll(f.source.wallet,funding(f));
  expect(await f.sql`select item_id,available from crafting_stocks where base_id=${f.source.baseId} order by item_id`).toEqual(stock);
  expect(await f.sql`select event_id,source_kind from divine_fragment_enrollments`).toEqual([{event_id:f.event.id,source_kind:'clan'}]);
  f.setTime(new Date(Date.parse(f.event.entryStartsAt)+3_600_000));const command=f.request(),entered=await locks.createEntry(f.source.wallet,command);
  await complete(f,r.service,entered.set.original.operation.id);
  f.setTime(new Date(Date.parse(f.event.playStartsAt)+3_600_000));
  await f.db.insert(baseArmy).values({baseId:f.source.baseId,troop:'highlander',count:5}).onConflictDoUpdate({target:[baseArmy.baseId,baseArmy.troop],set:{count:5}});
  const admitted=await events.startRaid(f.source.wallet,f.event.id,{baseId:f.source.baseId,idempotencyKey:randomUUID()}),raid=admitted.raid as {id:string};
  await acceptLiveRaidCommand(f.db,f.source.wallet,raid.id,randomUUID(),{kind:'deploy',payload:{troop:'highlander',tx:6,ty:10}},f.clock());
  f.setTime(new Date(f.clock().getTime()+RAID_RULES.battleDurationSec*1000+1));
  expect((await recoverDueStartedLiveRaids(f.db,f.clock(),undefined,raid.id)).resolved).toBe(1);
  const result=await f.withSourceClock(()=>operator.closeAndSettle(f.event.id));
  expect(result.settlement.awards.map(a=>a.wallet).sort()).toEqual(f.members.map(m=>m.wallet).sort());
  for(const award of result.settlement.awards){expect('clan' in award?award.clan:null).toMatchObject({clanId:f.birth.consent.clanId,entryId:entered.id,rosterSize:f.members.length,tournamentDomain:f.domain});expect(BigInt(award.gross)).toBe(BigInt(award.net)+BigInt(award.tax));}
  // Clearing allows genuine membership changes; it does not change old rights.
  const clearing=await locks.createClear(f.source.wallet,entered.id,{idempotencyKey:randomUUID()});await complete(f,r.service,clearing.original.operation.id);
  // 2026-10-10: the member leaves at the fixture instant its deed was last observed (the settlement source clock), not
  // at the real wall clock; the old 2035 observation only looked fresh because it lay in the real future.
  const member=f.members[1]!;await leaveClan(f.db,member.wallet,{baseId:member.baseId,assertAuthority:async(tx,w,id)=>{await assertFreshLockedBaseAuthority(tx,w,id,f.clock());}});await joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId);
  expect((await f.fragments.award(f.buyer.wallet,f.event.id)).award).toBeNull();expect((await f.fragments.award(member.wallet,f.event.id)).award).toEqual(result.settlement.awards.find(a=>a.wallet===member.wallet));
  const delivery={baseId:member.baseId,idempotencyKey:randomUUID()},receipt=await f.fragments.deliver(member.wallet,f.event.id,delivery);
  const termId=result.settlement.term.snapshot.termId,claim={termId,spotId:0,baseId:f.source.baseId,idempotencyKey:randomUUID()},share=await f.seeker.claim(f.source.wallet,claim);
  const prize=await events.claim(f.source.wallet,f.event.id,{baseId:f.source.baseId});
  const savedStock=await f.sql`select * from crystal_fragment_stocks order by base_id`,crafting=await f.sql`select * from crafting_stocks order by base_id,item_id`,original=await locks.readEntry(f.source.wallet,entered.id),reads=r.reads();
  for(const flag of ['PHASE_E_CHARTER_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_SEEKER_ENABLED'])vi.stubEnv(flag,'false');
  const restarted=createDivineClanRuntime(f.db),wallets=createDivineRuntime(f.db).deps.divineFragmentProvider;
  expect(restarted.operator).toBeNull();expect(await restarted.deps.charterTournamentProvider.createEntry(f.source.wallet,command)).toEqual(original);
  await expect(restarted.deps.charterTournamentProvider.createEntry(f.source.wallet,{...command,eventId:randomUUID()})).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_CONFLICT'});
  expect(await restarted.deps.charterTournamentEventsProvider.fund(f.source.wallet,funding(f))).toEqual(await events.read(f.source.wallet,f.event.id));
  expect(await restarted.deps.charterTournamentEventsProvider.claim(f.source.wallet,f.event.id,{baseId:f.source.baseId})).toEqual(prize);
  expect(await wallets.fragments.deliver(member.wallet,f.event.id,delivery)).toEqual(receipt);expect(await wallets.seeker.claim(f.source.wallet,claim)).toEqual(share);
  expect(await f.sql`select * from crystal_fragment_stocks order by base_id`).toEqual(savedStock);expect(await f.sql`select * from crafting_stocks order by base_id,item_id`).toEqual(crafting);expect(r.reads()).toBe(reads);
 }finally{await f.dispose();}
},120000);

it('funds an explicit new event once, keeps public new funding held and refuses missing enrollment/domain/source',async()=>{
 const f=await divineClanFragmentFixture(1);try{
  const r=runtime(f),operator=r.service.operator!,next={...funding(f),id:randomUUID(),weekStart:new Date(Date.parse(f.event.entryStartsAt)+7*86_400_000).toISOString(),budget:Object.fromEntries(Object.keys(f.event.budget).map(k=>[k,'1']))};
  const before=await f.sql`select item_id,available from crafting_stocks where base_id=${f.source.baseId} order by item_id`;
  const epochBefore=await f.sql`select * from charter_tournament_epochs`;
  const epoch=await operator.initializeEpoch();expect(await operator.initializeEpoch()).toEqual(epoch);
  expect(await f.sql`select * from charter_tournament_epochs`).toEqual(epochBefore);
  await expect(r.service.deps.charterTournamentEventsProvider.fund(f.source.wallet,next)).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_FUNDING_HELD'});
  await f.source.refresh();await operator.fundAndEnroll(f.source.wallet,next);
  const after=await f.sql`select item_id,available from crafting_stocks where base_id=${f.source.baseId} order by item_id`;
  expect(after).toEqual(before.map(row=>({...row,available:(BigInt(row.available)-1n).toString()})));
  await operator.fundAndEnroll(f.source.wallet,next);expect(await f.sql`select item_id,available from crafting_stocks where base_id=${f.source.baseId} order by item_id`).toEqual(after);
  await expect(operator.fundAndEnroll(f.buyer.wallet,{...next,id:randomUUID()})).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_SPONSOR'});
  f.setTime(new Date(f.event.entryStartsAt));await expect(r.service.deps.charterTournamentProvider.createEntry(f.source.wallet,f.request())).rejects.toMatchObject({code:'DIVINE_FRAGMENT_NOT_ENROLLED'});
  expect(await f.sql`select id from charter_tournament_entries`).toHaveLength(0);
  const wrong=createDivineClanRuntime(f.db,{...r.options,funding:{...r.options.funding,domain:{...f.domain,treasury:Keypair.generate().publicKey.toBase58()}}});
  await expect(wrong.operator!.initializeEpoch()).rejects.toThrow();expect(await f.sql`select * from charter_tournament_epochs`).toEqual(epochBefore);
  await expect(wrong.operator!.closeAndSettle(f.event.id)).rejects.toMatchObject({code:'DIVINE_FRAGMENT_DOMAIN'});expect(await f.sql`select * from charter_tournament_event_terminals`).toHaveLength(0);
  expect(createDivineClanRuntime(f.db,{...r.options,term:null}).operator).toBeNull();expect(createDivineClanRuntime(f.db,{...r.options,funding:null}).operator).toBeNull();expect(r.reads()).toBe(0);
 }finally{await f.dispose();}
},120000);

it('cannot backfill a genuine existing participation even with a stale private enrollment clock',async()=>{
 const f=await divineClanFragmentFixture(1);try{
  // Existing accepted D181 history predates this coordinator. It must remain
  // replayable, but cannot be converted retroactively into fragment earning.
  f.setTime(new Date(f.event.entryStartsAt));const entered=await f.entry();f.setTime(new Date(Date.parse(f.event.entryStartsAt)-86_400_000));
  const r=runtime(f);await expect(r.service.operator!.enroll(f.event.id)).rejects.toMatchObject({cause:{message:'DIVINE_FRAGMENT_ENROLLMENT'}});
  expect(await r.service.deps.charterTournamentProvider.createEntry(f.source.wallet,entered.input)).toEqual(entered.state);
  expect(await f.sql`select * from divine_fragment_enrollments`).toHaveLength(0);expect(r.reads()).toBe(0);
 }finally{await f.dispose();}
},120000);
