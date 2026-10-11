/** Existing current authority is a prospective snapshot, never a second bill. */
import {randomUUID} from 'node:crypto';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {createCharterCreationCancellationReader} from '@shardkeep/chain/charter-creation-cancellation';
import {buildCharterCreationPacket} from '@shardkeep/chain/charter-creation-preparation';
import {verifyCharterCreationSignedWire} from '@shardkeep/chain/charter-creation-wire';
import {decodeCharterRegistrationPermit} from '@shardkeep/chain/charter-protocol';
import {createClanCharterMigrationsStore} from '../src/db/charterMigrations';
import {createClanCharterRetirementDraftsStore} from '../src/db/charterRetirementDrafts';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {charterSalesFixture} from './fixtures/charterSales';
import {postgresLeaf} from './fixtures/charterPermitInventory';
import {migrationBank} from './fixtures/charterMigrationBank';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
async function fixture(){const f=await charterSalesFixture();try{
 await f.initialize();const id=randomUUID(),leader=Keypair.generate(),wallet=leader.publicKey.toBase58();
 // Trusted pre-existing legacy rows, deliberately without a deed or a forged
 // charter funding/birth receipt. Current authority is what this test captures.
 await f.sql`insert into players(wallet) values(${wallet})`;
 await f.sql`insert into clans(id,name,tag,leader_wallet) values(${id},${'Legacy '+id.slice(0,8)},${id.slice(0,4).toUpperCase()},${wallet})`;
 await f.sql`insert into clan_members(player_wallet,clan_id) values(${wallet},${id})`;
 const store=createClanCharterMigrationsStore(f.db),config={domain:{genesisHash:f.domain.genesisHash,economyProgram:f.domain.economyProgram,craftProgram:f.domain.craftProgram},metadataUriPrefix:'https://invalid.example/charter/'};
 return {...f,id,wallet,leader,salesStore:f.store,store,config,request:()=>({clanId:id,idempotencyKey:randomUUID()})};
 }catch(e){await f.dispose();throw e;}}
it('captures an existing landless leader with unchanged identity roster chest and money and replays before flags',async()=>{
 const f=await fixture();try{const before=await f.salesSnapshot(),input=f.request(),s=await f.store.create(f.wallet,input,f.config);
  expect(s).toMatchObject({actor:f.wallet,request:input,status:'pending',clan:{id:f.id},snapshot:{memberCount:1,chestShards:'0'},inventory:{count:0,revision:'0',messages:[]}});
  expect(s.original).toMatchObject({creationIntentId:s.id,clanId:f.id,payer:f.wallet,admissionCommitment:s.snapshot.commitment});expect(s.original).not.toHaveProperty('funding');
  expect(await f.salesSnapshot()).toBe(before);expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);expect(await f.sql`select * from charter_sale_births`).toHaveLength(0);
  const [row]=await f.sql`select source from charter_migrations where id=${s.id}`;expect(row!.source.liabilityCoverage).toBe('unknown-before-cutover');
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await f.store.create(f.wallet,input,null)).toEqual(s);expect(await f.store.readByKey(f.wallet,input.idempotencyKey)).toEqual(s);
  expect(await f.store.readByKey(f.buyer.wallet,input.idempotencyKey)).toBeNull();await expect(f.store.read(f.buyer.wallet,s.id)).rejects.toMatchObject({code:'CLAN_CHARTER_MIGRATION_NOT_FOUND'});
  await expect(f.store.create(f.wallet,{...input,clanId:randomUUID()},null)).rejects.toMatchObject({code:'CLAN_CHARTER_MIGRATION_CONFLICT'});
 }finally{await f.dispose();vi.unstubAllEnvs();}
},120000);
async function evidence(f:Awaited<ReturnType<typeof fixture>>,id:string,bank:ReturnType<typeof migrationBank>){
 return createCharterCreationCancellationReader(bank.connect,bank.trust,async originalId=>{if(originalId!==id)return null;const s=await f.store.read(f.wallet,id);return {original:s.original,permitInventory:{...s.inventory,messages:s.inventory.messages.map(hex=>Buffer.from(hex,'hex'))}};})(id);
}
it('cancels only authentic absent inventory and preserves the cancelled snapshot after later membership and a new migration',async()=>{
 const f=await fixture();try{const s=await f.store.create(f.wallet,f.request(),f.config),bank=migrationBank(s),before=await f.salesSnapshot();
  const cancelled=await f.store.cancel(f.wallet,s.id,await evidence(f,s.id,bank));expect(cancelled.status).toBe('cancelled');expect(await f.salesSnapshot()).toBe(before);
  await f.sql`insert into clan_members(player_wallet,clan_id) values(${f.buyer.wallet},${f.id})`;
  const next=await f.store.create(f.wallet,f.request(),f.config);expect(next.snapshot.memberCount).toBe(2);expect(next.snapshotHash).not.toBe(s.snapshotHash);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await f.store.read(f.wallet,s.id)).toEqual(cancelled);expect(await f.store.cancel(f.wallet,s.id,{})).toEqual(cancelled);
  await expect(f.store.beginAttempt(f.wallet,s.id,{}, {elapsedMs:0})).resolves.toEqual(cancelled);
 }finally{await f.dispose();vi.unstubAllEnvs();}
},120000);
it('cuts over a real observed original without charging or rewriting identity and keeps unknown history held for sale and dissolution',async()=>{
 const f=await fixture();try{let s=await f.store.create(f.wallet,f.request(),f.config);let bank=migrationBank(s);const before=await f.salesSnapshot();
  const quote=await bank.quote();s=await f.store.beginAttempt(f.wallet,s.id,quote,{elapsedMs:0});const {candidateHex,...input}=quote.packetInput;
  const signature=sign(bank.policy,Buffer.from(candidateHex,'hex')),packet=buildCharterCreationPacket({...input,candidate:Buffer.from(candidateHex,'hex'),policySignature:signature});
  s=await f.store.retainPreparation(f.wallet,s.id,s.attempt!.id,{policySignatureHex:signature.toString('hex'),packet});
  const tx=VersionedTransaction.deserialize(Buffer.from(packet.unsignedTransactionHex,'hex'));tx.sign([f.leader]);const wire=verifyCharterCreationSignedWire({wallet:f.leader.publicKey,intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:tx.serialize()});
  s=await f.store.retainSigned(f.wallet,s.id,{signedTransactionHex:Buffer.from(wire.signedTransaction).toString('hex'),signature:wire.signature,wireSha256:wire.wireSha256,messageSha256:wire.messageSha256});
  bank=migrationBank(s,bank.policy,true);const proof=await evidence(f,s.id,bank),encoded=JSON.parse(JSON.stringify(proof,(_k,v:unknown)=>typeof v==='bigint'?v.toString():v));
  const malformed=structuredClone(encoded);delete malformed.mint.metadataHash;
  const rejected=await f.sql`insert into charter_migration_terminals(migration_id,outcome,observation) values(${s.id},'controlled',${JSON.stringify(malformed)}::jsonb)`.then(()=>null,e=>e);
  expect(rejected).toMatchObject({code:'P0001',message:'CLAN_CHARTER_MIGRATION_EVIDENCE'});expect(await f.sql`select * from charter_sale_births`).toHaveLength(0);
  const early=await f.sql.begin(async tx=>{await tx`insert into charter_migration_terminals(migration_id,outcome,observation) values(${s.id},'controlled',${JSON.stringify(encoded)}::jsonb)`;await tx`set constraints all immediate`;await tx`update clans set invite_mode='invite' where id=${f.id}`;}).then(()=>null,e=>e);
  expect(postgresLeaf(early).message).toBe('CLAN_CHARTER_MIGRATION_PENDING');
  const controlled=await f.store.complete(f.wallet,s.id,proof);expect(controlled.status).toBe('controlled');expect(await f.salesSnapshot()).toBe(before);
  const [birth]=await f.sql`select * from charter_sale_births where clan_id=${f.id}`;expect(birth).toMatchObject({migration_id:s.id,reservation_id:null,terminal_id:null});
  expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);expect(await f.sql`select * from charter_creation_funding_posts`).toHaveLength(0);
  await expect(createClanCharterRetirementDraftsStore(f.db).create(f.wallet,{clanId:f.id,idempotencyKey:randomUUID()})).rejects.toThrow();expect(await f.sql`select * from charter_retirement_drafts`).toHaveLength(0);
  const sale=await f.salesStore().create(f.wallet,{clanId:f.id,buyer:f.buyer.wallet,priceLamports:'1000000000',sellerLeaves:true,idempotencyKey:randomUUID()},f.domain);
  const accepted=await f.salesStore().accept(f.buyer.wallet,sale.original.id,{termsHash:sale.original.termsHash,buyerBaseId:f.buyer.baseId});
  await expect(createClanCharterMemberSettlement(f.db,{deedCollection:f.buyer.collection,finalizedDeedReader:f.reader}).settle(f.wallet,accepted.fenceId!)).rejects.toThrow();
  expect(await f.store.read(f.wallet,s.id)).toEqual(controlled);expect(await f.sql`select * from clan_charter_member_payments`).toHaveLength(0);
 }finally{await f.dispose();}
},120000);
it('keeps uncertain issuance fenced until every exact exposed permit is observed absent strictly after expiry',async()=>{
 const f=await fixture();try{let s=await f.store.create(f.wallet,f.request(),f.config);const bank=migrationBank(s);
  s=await f.store.beginAttempt(f.wallet,s.id,await bank.quote(),{elapsedMs:0});await expect(evidence(f,s.id,bank)).rejects.toMatchObject({code:'LIVE_PERMIT'});
  const expiry=decodeCharterRegistrationPermit(Buffer.from(s.attempt!.candidateHex,'hex')).expiry;bank.clock.writeBigInt64LE(expiry,32);await expect(evidence(f,s.id,bank)).rejects.toMatchObject({code:'LIVE_PERMIT'});
  bank.clock.writeBigInt64LE(expiry+1n,32);const proof=await evidence(f,s.id,bank),damaged=JSON.parse(JSON.stringify(proof,(_k,v:unknown)=>typeof v==='bigint'?v.toString():v));damaged.inventory={version:1,revision:'0',count:0,messages:[]};
  const rejected=await f.sql`insert into charter_migration_terminals(migration_id,outcome,observation) values(${s.id},'cancelled',${JSON.stringify(damaged)}::jsonb)`.then(()=>null,e=>e);expect(rejected).toMatchObject({code:'P0001',message:'CLAN_CHARTER_MIGRATION_EVIDENCE'});
  const before=await f.salesSnapshot(),cancelled=await f.store.cancel(f.wallet,s.id,proof);expect(cancelled.status).toBe('cancelled');expect(await f.salesSnapshot()).toBe(before);
  await expect(f.sql`insert into charter_migration_preparations(migration_id,record) values(${s.id},'{}'::jsonb)`).rejects.toThrow();expect(await f.sql`select * from charter_sale_births`).toHaveLength(0);
 }finally{await f.dispose();}
},120000);
it('holds conflicting current clan and roster writes and duplicate pending requests without changing the snapshot',async()=>{
 const f=await fixture();try{const s=await f.store.create(f.wallet,f.request(),f.config),before=await f.salesSnapshot();
  for(const op of [()=>f.sql`update clans set invite_mode='invite' where id=${f.id}`,()=>f.sql`delete from clan_members where player_wallet=${f.wallet}`,
   ()=>f.sql`insert into clan_members(player_wallet,clan_id) values(${f.buyer.wallet},${f.id})`]){
   const e=await op().then(()=>null,e=>e);expect(postgresLeaf(e).message).toBe('CLAN_CHARTER_MIGRATION_PENDING');
  }
  await expect(f.store.create(f.wallet,f.request(),f.config)).rejects.toMatchObject({code:'CLAN_CHARTER_MIGRATION_CONFLICT'});
  expect(await f.store.read(f.wallet,s.id)).toEqual(s);expect(await f.salesSnapshot()).toBe(before);
  const other=await f.dedicatedOwner();let enter!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const work=other.sql.begin(async tx=>{await tx`lock table clan_members in share row exclusive mode`;enter();await gate;});try{await ready;await expect(f.store.read(f.wallet,s.id)).rejects.toMatchObject({code:'CLAN_CHARTER_MIGRATION_BUSY'});}finally{release();await work;await other.sql.end();}
 }finally{await f.dispose();}
},120000);
it('refuses spoofed source hooks isolation and birth origins without forging a funded reservation',async()=>{
 const f=await fixture();try{const s=await f.store.create(f.wallet,f.request(),f.config);
  const rr=await f.sql.begin('isolation level repeatable read',tx=>tx`select shardkeep_charter_migration_read(${f.wallet},${s.id}::uuid)`).then(()=>null,e=>e);expect(postgresLeaf(rr).message).toBe('CLAN_CHARTER_MIGRATION_READ_COMMITTED');
  const hooks=await f.sql.begin(async tx=>{await tx`alter table clans disable trigger clans_migration_boundary`;await tx`select shardkeep_charter_migration_read(${f.wallet},${s.id}::uuid)`;}).then(()=>null,e=>e);expect(postgresLeaf(hooks).message).toBe('CLAN_CHARTER_MIGRATION_SOURCE');
  await expect(f.sql`insert into charter_sale_births(clan_id,migration_id) values(${f.id},${s.id})`).rejects.toThrow();
  await expect(f.sql`update charter_migrations set snapshot_hash=${'0'.repeat(64)} where id=${s.id}`).rejects.toThrow();
  expect(await f.sql`select * from charter_sale_births`).toHaveLength(0);
 }finally{await f.dispose();}
},120000);
