import { randomUUID } from 'node:crypto';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { describe,expect,it,vi } from 'vitest';
import { createMiningWalletFixture } from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import { qualifyInitialFreeMiningDay } from '../src/mining/initialFreeQualification';
import { withInitialFreeMiningFixture as fixture } from './fixtures/initialFreeMining';

const day='2020-01-01',startAt=new Date(`${day}T00:00:00.000Z`),endAt=new Date('2020-01-02T00:00:00.000Z');
async function prepare(f:Parameters<Parameters<typeof fixture>[0]>[0]){
 await f.reserve(day);await f.battle(day);await f.clock(null);
 await f.collect('2019-12-31');await f.collect(day);
}
function source(wallet:string,scenario:'none'|'out-back'|'continuous'|'minted-in-day'='none'){
 const chain=createMiningWalletFixture({targetWallet:wallet,startAt,endAt,scenario});
 // Fixture implements the withContext:true overload used by every inventory read.
 return {...chain,deps:{source:chain.reader as unknown as DeedMiningWalletReader,collection:chain.collection,expectedGenesisHash:chain.expectedGenesisHash}};
}
describe('initial-free qualification joins registered and external ownership',()=>{
 it('qualifies covered play and paid ingots only after complete chain absence, without consuming or allocating',async()=>fixture(async f=>{
  await prepare(f);const chain=source(f.wallet),request={wallet:f.wallet,day,policyVersion:1};
  const result=await qualifyInitialFreeMiningDay(f.conn.db,chain.deps,request);
  expect(result).toMatchObject({wallet:f.wallet,baseId:f.baseId,reason:'qualified',eligibleUnits:1,
   allocationReady:false,publicationAuthorized:false,sourceQualification:'complete'});
  expect(BigInt(result.weight)).toBeGreaterThan(0n);
  expect(result.sources.deeds).toMatchObject({targetWallet:f.wallet,deedlessThroughout:true,heldDuringIntervalAssetIds:[]});
  expect((await f.conn.sql`select count(*)::int n from mining_ingot_releases`)[0]!.n).toBe(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const again=await qualifyInitialFreeMiningDay(f.conn.db,source(f.wallet).deps,request);
  expect(again.weight).toBe(result.weight);expect(again.eligibleUnits).toBe(1);
 },{roster:true}));
 it.each(['continuous','out-back','minted-in-day'] as const)('excludes an unregistered %s deed even when the game registry remains free',async scenario=>fixture(async f=>{
  await prepare(f);const chain=source(f.wallet,scenario);
  const result=await qualifyInitialFreeMiningDay(f.conn.db,chain.deps,{wallet:f.wallet,day,policyVersion:1});
  expect(result).toMatchObject({reason:'external_deed_owned',eligibleUnits:0,weight:'0',allocationReady:false});
  expect(result.sources.deeds.heldDuringIntervalAssetIds).toContain(chain.assetId);
  expect((await f.conn.sql`select deed_asset_id from bases where id=${f.baseId}`)[0]!.deed_asset_id).toBeNull();
 },{roster:true}));
 it('rejects missing registry coverage instead of inferring it from the current base',async()=>fixture(async f=>{
  await prepare(f);await expect(qualifyInitialFreeMiningDay(f.conn.db,source(f.wallet).deps,{wallet:f.wallet,day,policyVersion:1}))
   .rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
 }));
 it('preserves an in-day roster removal and return instead of trusting matching endpoint membership',async()=>fixture(async f=>{
  await f.clock(`${day}T10:00:00Z`);await f.conn.sql`update base_slots set active=false where wallet=${f.wallet}`;
  await f.clock(`${day}T11:00:00Z`);await f.conn.sql`update base_slots set active=true where wallet=${f.wallet}`;
  await prepare(f);
  const result=await qualifyInitialFreeMiningDay(f.conn.db,source(f.wallet).deps,{wallet:f.wallet,day,policyVersion:1});
  expect(result).toMatchObject({reason:'registered_roster_invalid',eligibleUnits:0,weight:'0'});
 },{roster:true}));
 it('excludes a temporary second registered base even when the original base and both endpoint rosters match',async()=>fixture(async f=>{
  const transient=randomUUID();await f.clock(`${day}T09:00:00Z`);
  await f.conn.sql`insert into bases(id,owner_wallet,status,created_at) values(${transient},${f.wallet},'inactive',${day})`;
  await f.clock(`${day}T10:00:00Z`);await f.conn.sql`delete from bases where id=${transient}`;
  await prepare(f);
  const result=await qualifyInitialFreeMiningDay(f.conn.db,source(f.wallet).deps,{wallet:f.wallet,day,policyVersion:1});
  expect(result).toMatchObject({reason:'registered_roster_invalid',eligibleUnits:0,weight:'0'});
  expect(result.sources.registeredRoster.open.bases).toHaveLength(1);
  expect(result.sources.registeredRoster.close.bases).toHaveLength(1);
  expect(result.sources.registeredRoster.continuityBrokenBaseIds).toContain(transient);
 },{roster:true}));
 it('refuses unavailable chain evidence, never treating a failed inventory as no deeds',async()=>fixture(async f=>{
  await prepare(f);const chain=source(f.wallet);
  chain.reader.getProgramAccounts=vi.fn().mockRejectedValue(new Error('private provider unavailable'));
  await expect(qualifyInitialFreeMiningDay(f.conn.db,chain.deps,{wallet:f.wallet,day,policyVersion:1})).rejects.toHaveProperty('code');
 },{roster:true}));
 it('rejects caller-provided eligibility, source identities, timestamps and malformed days before reading any source',async()=>fixture(async f=>{
  const chain=source(f.wallet);
  for(const extra of [{eligible:true},{weight:'10000'},{collection:randomUUID()},{now:new Date()},{day:'2020-02-30'},{wallet:'1'.repeat(100000)}]){
   await expect(qualifyInitialFreeMiningDay(f.conn.db,chain.deps,{wallet:f.wallet,day,policyVersion:1,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  }
  expect(chain.reader.getProgramAccounts).not.toHaveBeenCalled();
 },{roster:true}));
});
