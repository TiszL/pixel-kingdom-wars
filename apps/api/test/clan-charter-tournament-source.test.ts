import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Keypair} from '@solana/web3.js';
import {randomUUID} from 'node:crypto';
import {createCharterTournamentsStore} from '../src/db/charterTournaments';
import {charterSalesFixture,type CharterSalesFixture} from './fixtures/charterSales';
let f:CharterSalesFixture|undefined;
beforeEach(async()=>{f=await charterSalesFixture();},120000);
afterEach(async()=>{const previous=f;f=undefined;try{await previous?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);

it('creates a distinct prospective source without changing the ordinary-only epoch or its original sales',async()=>{
 const c=f!,ordinary=await c.initialize(),birth=await c.birth(),sale=await c.draft(birth),before=await c.store().read(birth.actor.wallet,sale.state.original.id);
 const store=createCharterTournamentsStore(c.db),epoch=await store.initializeEpoch(c.domain);
 expect(epoch.ordinaryEpochId).toBe(ordinary.id);expect(epoch.id).not.toBe(ordinary.id);
 expect(await store.initializeEpoch(c.domain)).toEqual(epoch);
 expect(await c.store().read(birth.actor.wallet,sale.state.original.id)).toEqual(before);
 expect(await c.sql`select contract from charter_sale_epochs`).toEqual([{contract:'ordinary-monotone-d175-v1'}]);
 expect(await c.sql`select count(*)::int n from charter_tournament_adoptions`).toEqual([{n:0}]);
});

it('does not allow a second domain to reinterpret an enrolled tournament epoch',async()=>{
 const c=f!;await c.initialize();const store=createCharterTournamentsStore(c.db);await store.initializeEpoch(c.domain);
 await expect(store.initializeEpoch({...c.domain,treasury:Keypair.generate().publicKey.toBase58()})).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_CONFLICT'});
});

it('cannot create a fence or exposure from an unfunded or missing event',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),store=createCharterTournamentsStore(c.db);await store.initializeEpoch(c.domain);
 const before=await c.salesSnapshot();await expect(store.createEntry(birth.actor.wallet,{eventId:randomUUID(),clanId:birth.consent.clanId,idempotencyKey:randomUUID()})).rejects.toThrow();
 expect(await c.salesSnapshot()).toBe(before);
 expect(await c.sql`select count(*)::int n from charter_tournament_entries`).toEqual([{n:0}]);
 expect(await c.sql`select count(*)::int n from charter_tournament_operations`).toEqual([{n:0}]);
});

it('keeps the source epoch immutable and rejects partial direct operation evidence',async()=>{
 const c=f!;await c.initialize();await createCharterTournamentsStore(c.db).initializeEpoch(c.domain);
 await expect(c.sql`update charter_tournament_epochs set domain='{}'::jsonb`).rejects.toThrow();
 await expect(c.sql`delete from charter_tournament_epochs`).rejects.toThrow();
 await expect(c.sql`truncate charter_tournament_epochs cascade`).rejects.toThrow();
 await expect(c.sql`insert into charter_tournament_attempts(operation_id,record) values(${randomUUID()},'{}'::jsonb)`).rejects.toThrow();
});

it('rejects repeatable-read source operations before consulting an old empty snapshot',async()=>{
 const c=f!;await c.initialize();await createCharterTournamentsStore(c.db).initializeEpoch(c.domain);
 await expect(c.sql.begin('isolation level repeatable read',async tx=>{
  await tx`select public.shardkeep_charter_tournament_epoch(${JSON.stringify(c.domain)}::jsonb)`;
 })).rejects.toThrow('CLAN_CHARTER_TOURNAMENT_READ_COMMITTED');
});
