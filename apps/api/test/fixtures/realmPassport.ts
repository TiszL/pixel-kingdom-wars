/** Real-source Realm Passport contexts for source, HTTP and client evidence.
 * Each context owns a disposable local database and produces ACTUAL accepted
 * departures with settled returns (synthetic term authority), real audited
 * publications projected into the entitlement tables, and a real current
 * assessment over an encoded finalized bank. Nothing here inserts a return,
 * header or leaf by hand; the superuser corruption helpers exist only to prove
 * refusal and are named as such. Never imported by production code. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_MINING_PUBLICATION as POLICY} from '@shardkeep/shared';
import type {MiningClaimSnapshotReader} from '@shardkeep/chain/mining-claim-snapshot';
import {eq} from 'drizzle-orm';
import {createMiningClaimFixture} from '../../../../packages/chain/src/testFixtures/miningClaim';
import {createDb,type Db} from '../../src/db/client';
import {bases,baseSlots,players} from '../../src/db/schema';
import {createRealmPassportProvider,type RealmPassportMiningCapability} from '../../src/game/realmPassport';
import {dispatchStarterExpedition} from '../../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions} from '../../src/game/starterExpeditionReturns';
import {projectMiningClaimEntitlements} from '../../src/mining/claimEntitlement';
import {createMiningClaimReader} from '../../src/mining/claimStatus';
import {ADMIN_DATABASE_URL} from '../db-url';
import {createTestPlayer} from '../helpers';
import {withCumulativeFreePublicationFixture} from './cumulativeFreePublication';
import {executeFundedMiningClaim} from './fundedMiningClaims';
import {withFundedMiningReplayFixture} from './fundedMiningReplay';
import {withMiningClaimEntitlementFixture,type MiningClaimEntitlementFixture} from './miningClaimEntitlement';
import {resourceClaimsDatabase} from './resourceClaimsDatabase';
import {createStarterExpeditionFixture} from './starterExpeditions';
import {vehicleServiceExpeditions} from './vehicleService';
import {vehicleServiceInstalledFixture} from './vehicleServicePreparation';

/** Env flags a test stubs to 'true' before the starter/advanced contexts (vi.stubEnv). */
export const REALM_PASSPORT_TEST_FLAGS=['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','STARTER_FLEET_ENABLED','STARTER_EXPEDITIONS_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_VEHICLES_ENABLED','FREE_ONBOARDING'] as const;
const ADVANCED_TABLES=['advanced_vehicle_installations','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies'];
/** Canonical table snapshot for no-write proofs. */
export async function snapshotTables(sql:ReturnType<typeof createDb>['sql'],names:readonly string[]){
 const rows=[];for(const name of names)rows.push(await sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${sql(name)} t`);return JSON.stringify(rows);
}
export const STARTER_SOURCE_TABLES=['starter_expeditions','starter_expedition_returns','starter_expedition_entries','starter_expedition_inflight','resource_stocks','expedition_free_homes','expedition_term_snapshots','bases','base_slots'] as const;
export const MINING_SOURCE_TABLES=['mining_claim_entitlement_headers','mining_claim_entitlement_leaves'] as const;

/** Owned database with one starter base, `completed` real dispatch->settle cycles
 * by the original actor, and helpers to depart more, settle, sell the base to a
 * buyer, open a non-owner reader role, and prove refusal of a changed return. */
export async function realmPassportStarterFixture(options:{completed?:number}={}){
 const conn=resourceClaimsDatabase();await conn.setup();
 try{
  const base=await createStarterExpeditionFixture(conn.db,{now:new Date('2035-01-01T01:00:00.000Z')});
  const depart=()=>dispatchStarterExpedition(conn.db,base.wallet,{...base.command,id:randomUUID()},base.authority,{reader:base.reader,clock:()=>base.now});
  async function settle(trip:Awaited<ReturnType<typeof depart>>){
   base.now=trip.returnsAt;const proofs=await conn.db.transaction(tx=>settleDueStarterExpeditions(tx,base.baseId,base.now));
   const proof=proofs.find(p=>p.expedition.id===trip.id);if(!proof)throw Error('Fixture return was not settled');return proof;
  }
  const completed:Awaited<ReturnType<typeof settle>>[]=[];
  for(let n=0;n<(options.completed??2);n++)completed.push(await settle(await depart()));
  const buyer=(await createTestPlayer(conn.db)).wallet;
  async function sell(){await conn.db.transaction(async tx=>{
   await tx.select().from(players).where(eq(players.wallet,base.wallet)).for('update');await tx.select().from(bases).where(eq(bases.id,base.baseId)).for('update');
   await tx.delete(baseSlots).where(eq(baseSlots.baseId,base.baseId));await tx.update(bases).set({ownerWallet:buyer}).where(eq(bases.id,base.baseId));
   await tx.insert(baseSlots).values({wallet:buyer,baseId:base.baseId,slot:2});});}
  const [current]=await conn.sql<{name:string}[]>`select current_database() name`,name=current!.name;
  const roles:string[]=[],readers:ReturnType<typeof createDb>[]=[];
  /** A login role that may SELECT every public table except the owner-private advanced_* tables. */
  async function readerRole(){
   const role=`passport_reader_${randomUUID().replaceAll('-','').slice(0,12)}`,password=randomUUID();
   await conn.sql.unsafe(`create role ${role} login password '${password}'`);roles.push(role);
   await conn.sql.unsafe(`grant usage on schema public to ${role}; grant select on all tables in schema public to ${role}; grant execute on all functions in schema public to ${role}; revoke all on ${ADVANCED_TABLES.join(',')} from ${role}`);
   const url=new URL(ADMIN_DATABASE_URL);url.username=role;url.password=password;url.pathname=`/${name}`;
   const reader=createDb(url.toString(),{max:2});readers.push(reader);return reader;
  }
  /** SUPERUSER PROOF HELPER: shifts a settled return before its schedule behind the immutability trigger. */
  async function shiftReturn(expeditionId:string,hours:number){
   await conn.sql`alter table starter_expedition_returns disable trigger user`;
   try{await conn.sql`update starter_expedition_returns set returned_at=returned_at+make_interval(hours=>${hours}) where expedition_id=${expeditionId}`;}
   finally{await conn.sql`alter table starter_expedition_returns enable trigger user`;}
  }
  /** A second actor's own starter base with one real dispatch->settle cycle (the wallet needs slot 1 free). */
  async function ownTrip(wallet:string){
   const own=await createStarterExpeditionFixture(conn.db,{wallet,now:new Date('2035-01-01T01:00:00.000Z')});
   const trip=await dispatchStarterExpedition(conn.db,wallet,{...own.command,id:randomUUID()},own.authority,{reader:own.reader,clock:()=>own.now});
   own.now=trip.returnsAt;const proofs=await conn.db.transaction(tx=>settleDueStarterExpeditions(tx,own.baseId,own.now));
   const proof=proofs.find(p=>p.expedition.id===trip.id);if(!proof)throw Error('Fixture own return was not settled');return {base:own,proof};
  }
  return {conn,db:conn.db,sql:conn.sql,wallet:base.wallet,buyer,baseId:base.baseId,base,completed,depart,settle,sell,ownTrip,readerRole,shiftReturn,
   provider:(db:Db=conn.db,mining?:RealmPassportMiningCapability)=>createRealmPassportProvider(db,mining?{mining}:{}),
   async close(){try{for(const r of readers)await r.sql.end();for(const role of roles)await conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);}finally{await conn.close();}}};
 }catch(error){await conn.close();throw error;}
}

/** Owned database with a real installed advanced vehicle, one settled advanced
 * trip and one accepted pending trip. Uses fake Date timers (vitest) internally. */
export async function realmPassportAdvancedFixture(){
 const f=await vehicleServiceInstalledFixture();
 try{
  const trips=await vehicleServiceExpeditions(f),trip=await trips.depart(),[proof]=await trips.complete(trip);
  if(!proof||proof.expedition.id!==trip.id)throw Error('Fixture advanced return was not settled');
  const pending=await trips.depart();
  return {f,db:f.conn.db,sql:f.conn.sql,wallet:f.actor,baseId:f.baseId,trip,proof,pending,trips,provider:(db:Db=f.conn.db)=>createRealmPassportProvider(db),dispose:()=>f.dispose()};
 }catch(error){await f.dispose();throw error;}
}

/** Two real settled and projected publications (sequence 1 and 2) for f.wallet;
 * f.buyer earned on day one only and carries its leaf into sequence 2. */
export async function withRealmPassportInclusionsFixture(run:(f:{
 db:Db;sql:ReturnType<typeof createDb>['sql'];identity:MiningClaimEntitlementFixture['identity'];wallet:string;buyer:string;
 provider:(mining?:RealmPassportMiningCapability|null)=>ReturnType<typeof createRealmPassportProvider>;corruptLeaf:(wallet:string,sequence:string)=>Promise<void>;
})=>Promise<void>){
 return withCumulativeFreePublicationFixture(async f=>{
  const first=await f.first();await projectMiningClaimEntitlements(f.conn.db,{epochId:first.prepared.epochId});
  const second=await (await f.stageDay('2020-01-02')).publish();await projectMiningClaimEntitlements(f.conn.db,{epochId:second.prepared.epochId});
  /** SUPERUSER PROOF HELPER: flips one cumulativeKeep byte of a projected leaf behind MINING_ENTITLEMENT_IMMUTABLE. */
  async function corruptLeaf(wallet:string,sequence:string){
   await f.conn.sql`alter table mining_claim_entitlement_leaves disable trigger user`;
   try{const changed=await f.conn.sql`update mining_claim_entitlement_leaves l set leaf_bytes=set_byte(l.leaf_bytes,40,(get_byte(l.leaf_bytes,40)+1)%256) from mining_claim_entitlement_headers h
    where h.epoch_id=l.epoch_id and l.wallet=${wallet} and h.sequence=${sequence}::numeric and h.genesis_hash=${f.identity.genesisHash} and h.program_id=${f.identity.programId} and h.config_address=${f.identity.configAddress} returning get_byte(l.leaf_bytes,40) byte`;
    if(changed.length!==1){const rows=await f.conn.sql`select h.sequence::text sequence,h.genesis_hash,h.program_id,h.config_address,l.wallet from mining_claim_entitlement_headers h join mining_claim_entitlement_leaves l on l.epoch_id=h.epoch_id`;throw Error(`corruptLeaf matched ${changed.length} rows; wanted ${wallet}@${sequence} in ${JSON.stringify(f.identity)}; present ${JSON.stringify(rows)}`);}}
   finally{await f.conn.sql`alter table mining_claim_entitlement_leaves enable trigger user`;}
  }
  // null = no mining capability at all (undefined would select the default identity-only capability).
  await run({db:f.conn.db,sql:f.conn.sql,identity:f.identity,wallet:f.wallet,buyer:f.buyer,corruptLeaf,
   provider:(mining:RealmPassportMiningCapability|null={identity:f.identity})=>createRealmPassportProvider(f.conn.db,mining?{mining}:{})});
 });
}

/** Encoded finalized bank over the fixture's real settled publication (copied from
 * mining-claim-status.test.ts): a fake RPC reader plus config/allocation/record mutators. */
export async function realmPassportCurrentBank(f:MiningClaimEntitlementFixture,wallet=f.wallet){
 const bank=await createMiningClaimFixture({wallet:new PublicKey(wallet),day:'2020-01-01'});
 for(let i=0;i<8;i++)bank.rows[i]={...f.backing.rows[i]!,data:Buffer.from(f.backing.rows[i]!.data)};
 const clock=bank.rows[7]!.data as Buffer;clock.writeBigUInt64LE(3000n);clock.writeBigInt64LE(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec),32);
 function sync(){bank.rows[0]=f.chain.accounts[0]!;bank.rows[8]=f.chain.accounts[2]!;bank.rows[9]=f.chain.accounts[1]!;}
 sync();
 for(const [i,which] of [[1,0],[2,1]] as const)(bank.rows[i]!.data as Buffer).writeBigUInt64LE(BigInt(f.chain.tx.meta!.postTokenBalances![which]!.uiTokenAmount.amount),64);
 let reads=0;const reader:MiningClaimSnapshotReader={getGenesisHash:async()=>f.identity.genesisHash,getSlot:async()=>3000,getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot:3000},value:bank.rows};}};
 return {...bank,reader,trust:f.chain.trusted,sync,clock:(at:bigint)=>clock.writeBigInt64LE(at,32),reads:()=>reads,
  async config(change:Record<string,unknown>){Object.assign(f.chain.models[0]!,change);await f.chain.encode(0);sync();},
  async allocation(change:Record<string,unknown>){Object.assign(f.chain.models[2]!,change);await f.chain.encode(2);sync();}};
}
/** One real settled and projected publication plus a real current assessment
 * (createMiningClaimReader over the encoded bank, no network). */
export async function withRealmPassportCurrentFixture(run:(f:{
 fixture:MiningClaimEntitlementFixture;bank:Awaited<ReturnType<typeof realmPassportCurrentBank>>;db:Db;identity:MiningClaimEntitlementFixture['identity'];wallet:string;buyer:string;
 assess:(wallet:string)=>Promise<import('../../src/mining/claimStatus').MiningClaimAssessment>;provider:(mining?:RealmPassportMiningCapability)=>ReturnType<typeof createRealmPassportProvider>;
})=>Promise<void>){
 return withMiningClaimEntitlementFixture(async f=>{
  await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});
  const bank=await realmPassportCurrentBank(f),reader=createMiningClaimReader(f.conn.db,bank),assess=reader.assess;
  await run({fixture:f,bank,db:f.conn.db,identity:f.identity,wallet:f.wallet,buyer:f.buyer,assess,
   provider:(mining:RealmPassportMiningCapability|undefined={identity:f.identity,assess})=>createRealmPassportProvider(f.conn.db,mining?{mining}:{})});
 });
}

/** Two real FUNDED publications (sequence 1 and 2, projected by the fixture) with
 * a real sequence-1 claim, so the chain record attests {1,1,1} while the current
 * leaf publishes renown/days 2: nonzero, lagging, never derived from each other. */
export async function withRealmPassportFundedFixture(run:(f:{
 db:Db;sql:ReturnType<typeof createDb>['sql'];identity:MiningClaimEntitlementFixture['identity'];wallet:string;buyer:string;observedSlot:number;chainUnixTimestamp:string;
 claim:Awaited<ReturnType<typeof executeFundedMiningClaim>>;assess:(wallet:string)=>Promise<import('../../src/mining/claimStatus').MiningClaimAssessment>;
 provider:(mining?:RealmPassportMiningCapability)=>ReturnType<typeof createRealmPassportProvider>;
})=>Promise<void>){
 return withFundedMiningReplayFixture(async f=>{
  // The funded fixture's setup can leave a transaction in flight on its own pool; the publish path locks
  // with NOWAIT and answers BUSY (55P03) when it overlaps under host load. Wait for the database to be
  // quiescent (no other session in a transaction) before each publish, and name any holder if it still refuses.
  const others=()=>f.conn.sql`select pid,state,wait_event_type,left(query,160) query,xact_start from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null`;
  async function quiescent(label:string){for(let n=0;n<60;n++){if((await others()).length===0)return;await new Promise(r=>setTimeout(r,50));}throw Error(`funded fixture ${label}: sessions still in a transaction ${JSON.stringify(await others())}`);}
  async function publish<T>(label:string,run:()=>Promise<T>):Promise<T>{await quiescent(label);try{return await run();}catch(error){throw Error(`funded fixture ${label} refused: ${String(error)}; sessions ${JSON.stringify(await others())}`,{cause:error});}}
  const first=await publish('day-one publish',async()=>(await f.stage('2020-01-01')).publish()),claim=await executeFundedMiningClaim(f,first,null);f.acceptClaim(claim);
  const second=await publish('day-two publish',async()=>(await f.stage('2020-01-02')).publish());
  const identity={genesisHash:f.identity.genesisHash,programId:f.identity.programId,configAddress:f.identity.configAddress};
  const copy=<T extends {data:Uint8Array}|null>(row:T):T=>(row?{...row,data:Buffer.from(row.data)}:row);
  const day=new Date(Number(BigInt(second.prepared.publication.day)*BigInt(POLICY.daySec)*1000n)).toISOString().slice(0,10);
  const raw=await createMiningClaimFixture({wallet:new PublicKey(f.wallet),day}),rows=raw.rows.map(copy);
  for(let i=0;i<8;i++)rows[i]=copy(second.backing.rows[i]!);
  rows[0]=copy(second.chain.accounts[0]!);rows[8]=copy(second.chain.accounts[2]!);rows[9]=copy(second.chain.accounts[1]!);
  (rows[1]!.data as Buffer).writeBigUInt64LE(second.chain.afterTokenBalance.vaultAfter,64);(rows[2]!.data as Buffer).writeBigUInt64LE(second.chain.afterTokenBalance.reserveAfter,64);
  for(const i of [10,11,12,13])rows[i]=copy(claim.post.rows[i]!);
  const observedSlot=second.chain.contextSlot+10,at=second.chain.fundedAt+BigInt(POLICY.claimDelaySec),clock=rows[7]!.data as Buffer;clock.writeBigUInt64LE(BigInt(observedSlot));clock.writeBigInt64LE(at,32);
  const reader:MiningClaimSnapshotReader={getGenesisHash:async()=>identity.genesisHash,getSlot:async()=>observedSlot,getMultipleAccountsInfoAndContext:async()=>({context:{slot:observedSlot},value:rows.map(copy)})};
  const assess=createMiningClaimReader(f.conn.db,{reader,trust:second.chain.trusted}).assess;
  await run({db:f.conn.db,sql:f.conn.sql,identity,wallet:f.wallet,buyer:f.buyer,observedSlot,chainUnixTimestamp:at.toString(),claim,assess,
   provider:(mining:RealmPassportMiningCapability|undefined={identity,assess})=>createRealmPassportProvider(f.conn.db,mining?{mining}:{})});
 });
}
