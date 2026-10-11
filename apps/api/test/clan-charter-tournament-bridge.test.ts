import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {VersionedTransaction} from '@solana/web3.js';
import {joinClan,leaveClan} from '../src/game/clans';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {closeCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {createClanCharterSales,charterSaleView} from '../src/game/clanCharterSales';
import {charterTournamentWorkflowFixture,type CharterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
import type {TournamentOperationState} from '../src/db/charterTournaments';
let f:CharterTournamentWorkflowFixture|undefined;
beforeEach(async()=>{f=await charterTournamentWorkflowFixture();},120000);
afterEach(async()=>{const previous=f;f=undefined;try{await previous?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function complete(c:CharterTournamentWorkflowFixture,original:TournamentOperationState){
 const id=original.original.operation.id,prepared=await c.prepare(id);await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));
 await c.finalizeLock(id);return c.service().recover(c.source.wallet,id);
}
const sale=(c:CharterTournamentWorkflowFixture)=>({clanId:c.birth.consent.clanId,buyer:c.buyer.wallet,priceLamports:'100000003',sellerLeaves:true,idempotencyKey:randomUUID()});

it('requires finalized set before participation, blocks membership/sale/payment, then projects clear into a genuinely fresh ordinary sale',async()=>{
 const c=f!,ordinary=createClanCharterSales(c.db,c.options()),historical=await c.store().create(c.source.wallet,sale(c),c.domain);
 await ordinary.cancel(c.source.wallet,historical.original.id);const originalHistory=await c.store().read(c.source.wallet,historical.original.id);
 const entry=(await c.entry()).state;expect(entry.status).toBe('pending');expect(entry.set.original.operation.expectedRevision).toBe(0);
 expect(await c.sql`select public.shardkeep_charter_tournament_entries(${c.event.id}::uuid) entries`).toEqual([{entries:[]}]);
 await expect(joinClan(c.db,c.buyer.wallet,entry.clanId)).rejects.toThrow();
 await expect(leaveClan(c.db,c.source.wallet)).rejects.toThrow();
 await expect(c.store().create(c.source.wallet,sale(c),c.domain)).rejects.toThrow();
 await expect(createClanCharterMemberFences(c.db).begin(c.source.wallet,{clanId:entry.clanId,idempotencyKey:randomUUID()})).rejects.toThrow();
 const completed=await complete(c,entry.set);
 expect(completed.status).toBe('completed');expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).status).toBe('entered');
 expect(await c.sql`select public.shardkeep_charter_tournament_entry_for_wallet(${c.event.id}::uuid,${c.source.wallet}) entry`).toMatchObject([{entry:{entryId:entry.id,roster:[c.source.wallet]}}]);
 await expect(c.tournamentStore.createClear(c.source.wallet,entry.id,randomUUID())).rejects.toThrow();
 const end=c.event.playEndsAt;c.setTime(new Date(end));await closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(end)});
 const clear=await c.tournamentStore.createClear(c.source.wallet,entry.id,randomUUID());expect(clear.original.operation.expectedRevision).toBe(1);
 await complete(c,clear);
 const released=await c.tournamentStore.readEntry(c.source.wallet,entry.id);expect(released.status).toBe('released');
 const draft=await c.store().create(c.source.wallet,sale(c),c.domain);
 expect(draft.original.expectedRevision).toBe(2);expect(draft.original.epochId).toBe(entry.epochId);
 expect(await c.sql`select count(*)::int n from charter_tournament_sale_sources where sale_id=${draft.original.id}`).toEqual([{n:1}]);
 c.selectSale(charterSaleView(draft));await ordinary.accept(c.buyer.wallet,draft.original.id,{termsHash:draft.original.termsHash,buyerBaseId:c.buyer.baseId});
 const preparedSale=await ordinary.prepare(c.source.wallet,draft.original.id),tx=VersionedTransaction.deserialize(Buffer.from(preparedSale.preparation!.packet.unsignedTransactionHex,'hex'));
 tx.sign([c.keys.get(c.source.wallet)!,c.keys.get(c.buyer.wallet)!]);await ordinary.retainSigned(c.source.wallet,draft.original.id,tx.serialize());
 await c.finalize(draft.original.id,c.source.wallet);expect((await ordinary.recover(c.source.wallet,draft.original.id)).status).toBe('completed');
 expect(await c.store().read(c.source.wallet,historical.original.id)).toEqual(originalHistory);
 expect(await c.sql`select leader_wallet,revision::text from charter_sale_heads where clan_id=${entry.clanId}`).toEqual([{leader_wallet:c.buyer.wallet,revision:'3'}]);
 expect(await c.service().readOperation(c.source.wallet,completed.original.operation.id)).toEqual(completed);
 expect(await c.sql`select contract from charter_sale_epochs`).toEqual([{contract:'ordinary-monotone-d175-v1'}]);
},120000);

it('rejects direct head, entry and release fabrication and holds when an exact source capture hook is disabled',async()=>{
 const c=f!,entry=(await c.entry()).state;
 await expect(c.sql`update charter_sale_heads set revision=revision+1 where clan_id=${entry.clanId}`).rejects.toThrow();
 await expect(c.sql`insert into charter_tournament_entry_completions(entry_id,lock_terminal_id) values(${entry.id},${randomUUID()})`).rejects.toThrow();
 await expect(c.sql`insert into charter_tournament_releases(entry_id,terminal_id) values(${entry.id},${randomUUID()})`).rejects.toThrow();
 await expect(c.sql.begin(async tx=>{
  await tx`alter table charter_tournament_entries disable trigger charter_tournament_entries_tournament_capture`;
  await tx`select public.shardkeep_charter_tournament_entry_read(${c.source.wallet},${entry.id}::uuid)`;
 })).rejects.toThrow();
 expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).status).toBe('pending');
 expect(await c.sql`select revision::text from charter_sale_heads where clan_id=${entry.clanId}`).toEqual([{revision:'0'}]);
},120000);

it('late finalized set never becomes participation and remains unlockable after a cancelled clear',async()=>{
 const c=f!,entry=(await c.entry()).state,prepared=await c.prepare(entry.set.original.operation.id);
 await c.service().retainSigned(c.source.wallet,entry.set.original.operation.id,c.signed(prepared));c.setTime(new Date(c.event.playStartsAt));
 await c.finalizeLock(entry.set.original.operation.id);await c.service().recover(c.source.wallet,entry.set.original.operation.id);
 expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).status).toBe('nonparticipating');
 expect(await c.sql`select public.shardkeep_charter_tournament_entries(${c.event.id}::uuid) entries`).toEqual([{entries:[]}]);
 await c.sql`select public.shardkeep_charter_tournament_assert_closable(${c.event.id}::uuid)`;
 const first=await c.tournamentStore.createClear(c.source.wallet,entry.id,randomUUID());expect(first.operationTerms.clearance).toMatchObject({kind:'late-entry-nonparticipation',entryId:entry.id,awards:[]});
 await c.service().cancel(c.source.wallet,first.original.operation.id);expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).status).toBe('nonparticipating');
 const next=await c.tournamentStore.createClear(c.source.wallet,entry.id,randomUUID());expect(next.original.operation.id).not.toBe(first.original.operation.id);
 expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).clear?.original.operation.id).toBe(next.original.operation.id);
 await complete(c,next);expect((await c.tournamentStore.readEntry(c.source.wallet,entry.id)).status).toBe('released');
 await expect(c.entry()).rejects.toThrow();
},120000);

it('an in-flight roster mutation wins atomically or entry holds, and the retry freezes the committed roster',async()=>{
 const c=f!,blocker=await c.dedicatedOwner();let unlock!:()=>void,arrive!:()=>void;
 const locked=new Promise<void>(resolve=>{arrive=resolve;}),release=new Promise<void>(resolve=>{unlock=resolve;});
 const mutation=blocker.sql.begin(async tx=>{
  await tx`select id from clans where id=${c.birth.consent.clanId} for update`;
  await tx`insert into clan_members(player_wallet,clan_id) values(${c.buyer.wallet},${c.birth.consent.clanId})`;
  arrive();await release;
 });
 try{
  await locked;await expect(c.entry()).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_BUSY'});
  unlock();await mutation;const entry=(await c.entry()).state;
  expect(entry.roster).toEqual([c.source.wallet,c.buyer.wallet].sort());
  await expect(c.sql`delete from clan_members where player_wallet=${c.buyer.wallet}`).rejects.toThrow();
 }finally{unlock();await mutation;await blocker.sql.end({timeout:5});}
},120000);
