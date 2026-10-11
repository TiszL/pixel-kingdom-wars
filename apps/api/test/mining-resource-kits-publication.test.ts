/** Real DB custody and funded-bank replay on an explicitly simulated future
 * calendar. Opening kits here are synthetic stock; earned kit/SPL composition
 * is accepted separately. No real UTC day elapsed and no live source activated. */
import { describe,it,expect,vi,afterEach } from 'vitest';
import { withFundedMiningReplayFixture as fixture } from './fixtures/fundedMiningReplay';
import { createSeekerMiningArchives } from './fixtures/seekerMiningQualification';
import { executeFundedMiningClaim } from './fixtures/fundedMiningClaims';
import { installResourceMiningV3Cutover } from '../src/mining/resourceMiningPolicy';
import { getPreparedMiningPublication } from '../src/mining/publicationPreparation';
import { initializeMiningSeekerCoverageChallenge,readMiningSeekerCoverageChallenge,captureMiningSeekerCheckpoint } from '../src/mining/seekerCheckpointHistory';
import { auditStoredResourcePublication } from '../src/mining/publicationHistory';
import { miningCanonical } from '../src/mining/fundedMiningAudit';
import { createResourceMiningPublicationPreparer } from '../src/mining/fundedMiningAllocation';
const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
afterEach(()=>vi.unstubAllEnvs());
describe('resource kit manifests7/8',()=>{
 it('settles lastv2 then firstv3, retains old bytes, rejects altered cutover and claims cumulative rights',async()=>{
  const previous=day(1),next=day(2),closed=day(3),resourceClock=()=>new Date(closed+'T12:00:00Z');
  await fixture(async f=>{
   const cutover=await installResourceMiningV3Cutover(f.conn.db,next);
   const before=await(await f.stageResources(previous,{free:[{resourceId:'shards',quantity:'2000'}],paid:[{resourceId:'shards',quantity:'2000'}]})).publish();
   const oldBytes=before.prepared.manifestJson;expect(JSON.parse(oldBytes).version).toBe(5);
   const stage=await f.stageResources(next,{free:[{resourceId:'climate_kit',quantity:'1'},{resourceId:'expedition_kit',quantity:'1'}],paid:[{resourceId:'climate_kit',quantity:'10'},{resourceId:'expedition_kit',quantity:'10'}]},undefined,{policyVersion:3});
   const p=await stage.prepare(stage.request);if(p.status!=='prepared')throw Error('Useful v3 award required');
   const manifest=JSON.parse(p.manifestJson);expect(manifest).toMatchObject({version:7,scope:'ordinary-resource-mining-v3',input:{policyVersion:3},epoch:{cutover}});
   expect(manifest.policy.resourceCatalogue).toMatchObject({climate_kit:'2000',expedition_kit:'2025'});
   expect(manifest.participants.find((v:{wallet:string})=>v.wallet===f.buyer).capacityValue).toBeNull();
   for(const mutate of [(m:typeof manifest)=>{m.epoch.cutover.sha256='0'.repeat(64);},(m:typeof manifest)=>{m.epoch.cutover.firstDay=previous;},(m:typeof manifest)=>{m.policy.resourceCatalogue.expedition_kit='9999';},(m:typeof manifest)=>{m.epoch.contributions[0].request.policyVersion=2;}]){
    const changed=structuredClone(manifest);mutate(changed);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:p.publication})).rejects.toThrow();
   }
   const published=await stage.publish();expect(published.settlement.contributions.every(r=>r.outcome==='consumed')).toBe(true);
   const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,null);f.acceptClaim(claim);
   expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:2n,daysAttested:2n});
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');published.chain.reader.getGenesisHash=async()=>{throw Error('Offline original');};
   expect(await getPreparedMiningPublication(f.conn.db,p.epochId)).toEqual(p);expect(await published.settle()).toEqual(published.settlement);
   expect(before.prepared.manifestJson).toBe(oldBytes);expect(await before.settle()).toEqual(before.settlement);
  },{replayFirstDay:previous,resourceClock});
 },180_000);
 it('publishes representative Seeker manifest8 with original two-provider evidence and unchanged claim ABI',async()=>{
  const next=day(2),earlier=day(1),closed=day(3),resourceClock=()=>new Date(closed+'T12:00:00Z');
  await fixture(async f=>{
   await installResourceMiningV3Cutover(f.conn.db,next);
   await f.clock(earlier+'T15:00:00Z');await initializeMiningSeekerCoverageChallenge(f.conn.db);
   const challenge=await readMiningSeekerCoverageChallenge(f.conn.db),sources=createSeekerMiningArchives(challenge,{mintBirthAt:earlier+'T16:00:00Z',accountCreatedAt:earlier+'T16:01:00Z',issuedAt:earlier+'T16:02:00Z',observedAt:closed+'T01:00:00Z'});
   await f.clock(earlier+'T18:00:00Z');await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${sources.input.linkedWallet},${sources.input.mint})`;
   await f.clock(earlier+'T19:00:00Z');await captureMiningSeekerCheckpoint(f.conn.db,f.buyer);
   const stage=await f.stageResources(next,{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},sources.wiring,{policyVersion:3});
   const invalidClock=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.optionsForPrepare.sources,resourceClock:()=>new Date(NaN)}});
   await expect(invalidClock(stage.request)).rejects.toThrow('MINING_RESOURCE_CLOCK');
   const p=await stage.publish(),m=JSON.parse(p.prepared.manifestJson);expect(m).toMatchObject({version:8,scope:'ordinary-resource-mining-seeker-v3',input:{policyVersion:3}});
   expect(m.captures.find((v:{wallet:string})=>v.wallet===f.buyer).seekerQualification.providers).toHaveLength(2);
   const claim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},p,null);expect(claim.postSnapshot.renownRecord).toMatchObject({renownTotal:1n,daysAttested:1n});
   for(const source of sources.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Archive offline'));
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);
  },{replayFirstDay:next,resourceClock});
 },180_000);
});
