/** A narrower coverage proof must never erase conflicting original identity or retry an archival failure. */
import {Keypair} from '@solana/web3.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {bases,baseSlots,buildings,mineAccrualStates} from '../src/db/schema';
import {reanchorBaseMineAccrual} from '../src/game/baseMining';
import {initializeMiningRosterHistory,MiningRosterHistoryError,readMiningRosterHistory} from '../src/mining/rosterHistory';
import {captureMiningRosterCheckpoint} from '../src/mining/rosterCheckpoints';
import {readMiningRosterCheckpointInterval} from '../src/mining/rosterCheckpointHistory';
import {prefetchPhysicalMineCustody} from '../src/mining/shardsTaxMineCustody';
import {resolvePhysicalMineTaxSource} from '../src/mining/shardsTaxMineResolution';
import {createTestPlayer} from './helpers';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
beforeEach(async()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);vi.stubEnv('PHASE_E_MINING_ENABLED','true');conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);},120000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function conflictingOriginal(kind:'malformed'|'mismatched'){
 await fixture.rosterClock('2035-01-01T00:00:00Z');const {wallet}=await createTestPlayer(conn.db);
 const asset=kind==='malformed'?'not-a-valid-solana-public-key':Keypair.generate().publicKey.toBase58();
 const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,landPaidAt:new Date('2034-12-31T00:00:00Z'),deedAssetId:asset,
  deedMintAssetId:kind==='mismatched'?Keypair.generate().publicKey.toBase58():null}).returning();
 await conn.db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});await initializeMiningRosterHistory(conn.db,wallet);
 // These are real source changes before the first earning. A valid later
 // snapshot cannot erase malformed original identity discovered by day replay.
 await fixture.rosterClock('2035-01-07T12:00:00.123456Z');await conn.sql`update bases set land_paid_at=null,deed_asset_id=null,deed_mint_asset_id=null,deed_minting_at=null where id=${base!.id}`;
 await captureMiningRosterCheckpoint(conn.db,wallet);
 const [mine]=await conn.db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await conn.db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:fixture.anchor});
 await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,base!.id,new Date(+fixture.anchor+8*fixture.unit)));
 const [parent]=await conn.sql`select * from shards_mine_segments where mine_id=${mine!.id} and wallet=${wallet}`;expect(parent).toMatchObject({first_unit:'5',last_unit:'8'});
 await fixture.rosterClock(fixture.verified.toISOString());
 return {wallet,base:base!,parent:parent!,asset};
}
describe.sequential('Mine checkpoint fallback hard boundaries',()=>{
 it('holds malformed original deed identity even when a valid later checkpoint covers the earning',async()=>{
  const f=await conflictingOriginal('malformed'),day=await readMiningRosterHistory(conn.db,{wallet:f.wallet,day:'2035-01-07',policyVersion:1});
  expect(day.open.bases.find(b=>b.id===f.base.id)?.deed_asset_id).toBe(f.asset);expect(day.close.bases.find(b=>b.id===f.base.id)?.deed_asset_id).toBeNull();expect(day.continuityBrokenBaseIds).toContain(f.base.id);
  const checkpoint=await readMiningRosterCheckpointInterval(conn.db,{wallet:f.wallet,baseId:f.base.id,startsAt:new Date(+fixture.anchor+5*fixture.unit).toISOString(),endsAt:new Date(+fixture.anchor+8*fixture.unit+1).toISOString()});
  expect(checkpoint.base.deed_asset_id).toBeNull();expect(checkpoint.events).toHaveLength(0);
  const ledger=await conn.sql`select id from ledger_transactions order by id`;
  await expect(prefetchPhysicalMineCustody(conn.db,f.parent.id)).rejects.toMatchObject({code:'SHARDS_MINE_CUSTODY_UNAVAILABLE'});
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,fixture.deps)).rejects.toMatchObject({code:'SHARDS_MINE_CUSTODY_UNAVAILABLE'});
  expect(await conn.sql`select parent_id from shards_mine_resolutions`).toHaveLength(0);expect(await conn.sql`select parent_id from shards_mine_resolution_terms`).toHaveLength(0);
  expect(await conn.sql`select buffer,gross,resolved from shards_mine_segments where id=${f.parent.id}`).toEqual([{buffer:'4',gross:'4',resolved:'0'}]);expect(await conn.sql`select id from ledger_transactions order by id`).toEqual(ledger);
 });
 it('rejects mismatched attached and reserved deed identities before they can become historical baseline facts',async()=>{
  await expect(conflictingOriginal('mismatched')).rejects.toMatchObject({cause:{code:'23514',message:expect.stringMatching(/differs from reserved deed/)}});
  expect(await conn.sql`select wallet from mining_roster_baselines`).toHaveLength(0);expect(await conn.sql`select id from mining_roster_checkpoints`).toHaveLength(0);
  expect(await conn.sql`select parent_id from shards_mine_resolutions`).toHaveLength(0);
 });
 it('normalizes a typed archival provider coverage failure and never retries it through an interval fallback',async()=>{
  const f=await fixture.createDeededSource();f.chain.reader.getGenesisHash.mockRejectedValue(new MiningRosterHistoryError('COVERAGE_UNAVAILABLE'));
  const ledger=await conn.sql`select id from ledger_transactions order by id`;
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(f.chain.reader.getGenesisHash).toHaveBeenCalledOnce();
  expect(await conn.sql`select parent_id from shards_mine_resolutions`).toHaveLength(0);expect(await conn.sql`select parent_id from shards_mine_resolution_terms`).toHaveLength(0);
  expect(await conn.sql`select buffer,gross,resolved from shards_mine_segments where id=${f.parent.id}`).toEqual([{buffer:'4',gross:'4',resolved:'0'}]);expect(await conn.sql`select id from ledger_transactions order by id`).toEqual(ledger);
 });
});
