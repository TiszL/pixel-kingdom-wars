/** Ordinary land authority comes from the original migration or paid purchase,
 * never merely from a catalog tile, a NULL expected mint or a credited label. */
import { describe,expect,it } from 'vitest';
import { ECONOMY } from '@shardkeep/shared';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { fantasyManifestHash } from '../src/db/fantasyMigration';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { withFundedMiningFixture } from './fixtures/fundedMining';
import { withFundedMiningReplayFixture } from './fixtures/fundedMiningReplay';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';

const LAND_PRICE_LAMPORTS=Math.round(ECONOMY.entryFeeSol*LAMPORTS_PER_SOL);
// 2026-10-10 (release/phase-e-20261010): the 'holds %s' cases timed out at the default 30 s in CI run 38043546234
// (API shard 10). They passed at d080b2405 (CI run 37503885235) at ~23 s per case for the file, and measured 14-18 s
// per case on a dev Mac on both d080b2405 and this branch, so the merge did not slow them; the runner is just near the
// edge. Every case now uses the 90 s budget the first case already had. The assertions are unchanged.
describe('funded ordinary mining classification source authority',()=>{
 it('funds and claims the actual SOL purchase whose immutable claim has no expected mint',async()=>withFundedMiningReplayFixture(async f=>{
  const [source]=await f.conn.sql`select c.expected_mint,c.source,d.status,d.amount::text,r.state,b.deed_asset_id,b.deed_mint_asset_id
    from fantasy_land_claims c join deposits d on d.id=c.deposit_id join plot_reservations r on r.deposit_id=d.id
    join bases b on b.id=c.base_id where c.base_id=${f.paidBaseId}`;
  expect(source).toEqual({expected_mint:null,source:'purchase',status:'credited',amount:String(LAND_PRICE_LAMPORTS),state:'converted',deed_asset_id:f.assetId,deed_mint_asset_id:f.assetId});
  const stage=await f.stage('2020-01-01'),p=await stage.publish(),m=JSON.parse(p.prepared.manifestJson);
  const capture=m.captures.find((c:{wallet:string})=>c.wallet===f.buyer),original=capture.bases[0].ordinary;
  expect(original).toMatchObject({assetId:f.assetId,source:'purchase',sourceEvidence:{kind:'purchase',deposit:{status:'credited',amount:String(LAND_PRICE_LAMPORTS)},reservation:{state:'converted'},base:{deedAssetId:f.assetId,deedMintAssetId:f.assetId,deedMintingAt:null}}});
  const award=m.awards.find((a:{wallet:string})=>a.wallet===f.buyer);expect(BigInt(award.net)).toBeGreaterThan(0n);
  expect(p.settlement.dispositions.find(d=>d.baseId===f.paidBaseId)).toMatchObject({consumed:1,returned:0});
  const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},p,null);
  expect(claim.payment).toBe(BigInt(award.net));expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:1n,daysAttested:1n});
  expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);
  expect(await claim.recover()).toEqual(claim.settlement);
 },{classification:'purchase'}),90000);

 it('accepts a genuinely activated held migration while preserving its original historical owner',async()=>withFundedMiningFixture(async f=>{
  const stage=await f.stage(),p=await stage.prepare(stage.request);expect(p.status).toBe('prepared');if(p.status!=='prepared')throw Error('Activated original migration must qualify');
  const m=JSON.parse(p.manifestJson),original=m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).bases[0].ordinary;
  expect(original.source).toBe('migration-inactive');expect(original.sourceEvidence.manifest.entries[0]).toMatchObject({baseId:f.paidBaseId,mintId:f.assetId,state:'held'});
  expect(original.sourceEvidence.manifest.entries[0].ownerWallet).not.toBe(f.buyer);
  expect(fantasyManifestHash(original.sourceEvidence.manifest)).toBe(original.sourceId);
  expect((await f.conn.sql`select state from fantasy_land_claims where base_id=${f.paidBaseId}`)[0]?.state).toBe('assigned');
  expect(BigInt(p.publication.deedGross)).toBeGreaterThan(0n);
  expect(await getPreparedMiningPublication(f.conn.db,p.epochId)).toEqual(p);
 },{classification:'migration-inactive'}),90000);

 it.each(['migration-hash','migration-entry','dev'] as const)('holds %s despite an assigned ordinary tile, preserving the reserved ingots',async classification=>withFundedMiningFixture(async f=>{
  const stage=await f.stage(),before=await f.conn.sql`select base_id,item_id,qty from base_items order by base_id,item_id`;
  expect((await f.conn.sql`select state from fantasy_land_claims where base_id=${f.paidBaseId}`)[0]?.state).toBe('assigned');
  await expect(stage.prepare(stage.request)).rejects.toMatchObject({code:'CLASSIFICATION_UNAVAILABLE'});
  expect(await f.conn.sql`select * from mining_publication_attempts`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_publication_manifests`).toHaveLength(0);
  expect(await f.conn.sql`select * from mining_ingot_dispositions`).toHaveLength(0);
  expect(await f.conn.sql`select base_id,item_id,qty from base_items order by base_id,item_id`).toEqual(before);
 },{classification}),90000);
});
