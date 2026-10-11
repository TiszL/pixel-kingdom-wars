import {randomUUID} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {charterClanIdBytes} from '@shardkeep/chain/charter-protocol';
import {closeCharterTournamentEvent,readCharterTournamentEvent} from '../src/game/charterTournamentEvents';
import {charterTournamentWorkflowFixture,type CharterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';

let f:CharterTournamentWorkflowFixture|undefined;
beforeEach(async()=>{f=await charterTournamentWorkflowFixture();},120000);
afterEach(async()=>{const previous=f;f=undefined;try{await previous?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function fenced(c:CharterTournamentWorkflowFixture,entryId:string){
 expect(await c.sql`select * from charter_tournament_releases where entry_id=${entryId}`).toHaveLength(0);
 expect(await c.sql`select public.shardkeep_charter_tournament_fenced(${c.birth.consent.clanId}::uuid) held`).toEqual([{held:true}]);
 await expect(c.store().create(c.source.wallet,{clanId:c.birth.consent.clanId,buyer:c.buyer.wallet,priceLamports:'100000003',sellerLeaves:true,idempotencyKey:randomUUID()},c.domain)).rejects.toThrow();
}
function close(c:CharterTournamentWorkflowFixture){return closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(c.event.playEndsAt)});}

it('abandoned zero-exposure entry cannot hold global closure and retains its own private fence',async()=>{
 const c=f!,entry=(await c.entry()).state;
 await expect(closeCharterTournamentEvent(c.db,c.event.id,{clock:()=>new Date(Date.parse(c.event.playEndsAt)-1)})).rejects.toThrow();
 const result=await close(c);expect(result.terminal).toMatchObject({rankings:[],occupations:[],entitlements:[{wallet:c.source.wallet,amounts:c.event.budget}]});
 expect(await c.sql`select * from charter_tournament_terminals`).toHaveLength(0);
 expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(0);
 expect(await c.sql`select * from charter_tournament_nonparticipations`).toHaveLength(0);
 expect((await c.service().readEntry(c.source.wallet,entry.id)).status).toBe('pending');await fenced(c,entry.id);
});

it('hostile prepared wire outside original retention cannot hold other fixed rights or infer cancellation',async()=>{
 const c=f!,entry=(await c.entry()).state,id=entry.set.original.operation.id,prepared=await c.prepare(id);
 // A real actor can re-sign the issued policy message with a different recent
 // blockhash outside this API. The explicit R1 bank reflects that transition;
 // no exact retained-wire receipt is manufactured for private recovery.
 const alternate=VersionedTransaction.deserialize(c.signed(prepared));alternate.message.recentBlockhash=Keypair.generate().publicKey.toBase58();alternate.sign([c.keys.get(c.source.wallet)!]);
 await expect(c.service().retainSigned(c.source.wallet,id,alternate.serialize())).rejects.toThrow();
 const registry=c.bank.rows.find(row=>row.address.toBase58()===prepared.original.creation.chain.charter)!;
 registry.data.writeUInt32LE(prepared.original.operation.expectedRevision+1,153);registry.data[158]=1;charterClanIdBytes(entry.lockId).copy(registry.data,159);
 const expiry=Buffer.from(prepared.attempt!.candidateHex,'hex').readBigInt64LE(121);c.bank.clock.writeBigInt64LE(expiry+1n,32);
 await expect(c.service().recover(c.source.wallet,id)).rejects.toThrow();
 const result=await close(c);expect(result.terminal).toMatchObject({rankings:[],occupations:[],entitlements:[{wallet:c.source.wallet,amounts:c.event.budget}]});
 expect((await c.service().readOperation(c.source.wallet,id)).status).toBe('prepared');
 expect(await c.sql`select * from charter_tournament_terminals`).toHaveLength(0);await fenced(c,entry.id);
});

it('backdated recovery after closure completes only its original lock and never changes frozen event rights',async()=>{
 const c=f!,entry=(await c.entry()).state,id=entry.set.original.operation.id,prepared=await c.prepare(id);
 await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));const result=await close(c);
 c.setTime(new Date(Date.parse(c.event.entryStartsAt)+7_200_000));await c.finalizeLock(id);
 expect((await c.service().recover(c.source.wallet,id)).status).toBe('completed');
 expect((await c.service().readEntry(c.source.wallet,entry.id)).status).toBe('nonparticipating');
 expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(0);
 expect(await c.sql`select public.shardkeep_charter_tournament_entries(${c.event.id}::uuid) entries`).toEqual([{entries:[]}]);
 expect((await readCharterTournamentEvent(c.db,c.event.id)).terminal).toEqual(result.terminal);await fenced(c,entry.id);
});

it('two-connection closure serializes an already-running exact-wire recovery into nonparticipation',async()=>{
 const c=f!,entry=(await c.entry()).state,id=entry.set.original.operation.id,prepared=await c.prepare(id);
 await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));await c.finalizeLock(id);
 const closer=await c.dedicatedOwner();let recovery:ReturnType<ReturnType<typeof c.service>['recover']>|undefined;
 try{
  await closer.sql.begin(async tx=>{
   const [connection]=await tx`select pg_backend_pid() pid`;
   await tx`select public.shardkeep_charter_tournament_assert_closable(${c.event.id}::uuid)`;
   recovery=c.service().recover(c.source.wallet,id);void recovery.catch(()=>{});
   // Observe PostgreSQL lock contention, not a timing-based sleep or a mock.
   await expect.poll(async()=>{const [row]=await tx`select exists(select 1 from pg_stat_activity where ${connection!.pid}::int=any(pg_blocking_pids(pid))) blocked`;return row!.blocked;},{timeout:5000,interval:20}).toBe(true);
   await tx`insert into charter_tournament_event_terminals(event_id,record,completed_at,tx_key) values(${c.event.id},'{}',${c.event.playEndsAt},pg_current_xact_id()::text)`;
  });
  expect((await recovery!).status).toBe('completed');
  expect((await c.service().readEntry(c.source.wallet,entry.id)).status).toBe('nonparticipating');
  expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(0);
  expect((await readCharterTournamentEvent(c.db,c.event.id)).terminal).toMatchObject({rankings:[],occupations:[]});await fenced(c,entry.id);
 }finally{await recovery?.catch(()=>{});await closer.sql.end({timeout:5});}
},120000);
