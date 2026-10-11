/** Actual old account, zero boundary and ordinary paid effect; chain banks are simulated. */
import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PHASE_E_GEMS_MINING_CREDIT as GEMS_POLICY} from '@shardkeep/shared';
import {enrolledLinkCalendar,enrollBuyer} from './fixtures/miningEnrolledLink';
import {withFundedMiningReplayFixture} from './fixtures/fundedMiningReplay';
import {fundedMiningGems} from './fixtures/fundedMiningGems';
import {resealExistingMiningWalletFixtureClock} from './fixtures/existingMiningWallet';
import {resealGemsZeroOpeningFixtureClock} from './fixtures/gemsZeroOpening';
import {captureExistingMiningWallet,readExistingMiningWalletBaseline} from '../src/mining/existingMiningWallet';
import {captureGemsZeroOpening,readGemsZeroOpening} from '../src/mining/gemsZeroOpening';
import {collectMiningActivityEvidence} from '../src/mining/activityEvidence';
import {collectMiningWalletExperience} from '../src/mining/walletExperience';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {seekerAbsenceResourceMiningPolicy,seekerAbsenceResourceMiningPolicyV3} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;
describe('zero Gems inventory manifests15/16',()=>{
 it('publishes two covered future days with actual conversion and paid research, then preserves cumulative rights offline',async()=>{
  const cal=enrolledLinkCalendar();
  await withFundedMiningReplayFixture(async f=>{
   await resealExistingMiningWalletFixtureClock(f.conn);await resealGemsZeroOpeningFixtureClock(f.conn);
   await installResourceMiningV3Cutover(f.conn.db,cal.next);
   expect(await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.buyer} and source_table='players'`).toHaveLength(0);
   expect(await f.conn.sql`select id from mining_gems_flow_events where wallet=${f.buyer}`).toHaveLength(0);
   const [account]=await f.conn.sql`select id,balance::text balance from accounts where owner_wallet=${f.buyer} and kind='player_gems'`;expect(account!.balance).toBe('0');
   const e=await enrollBuyer(f,cal);await captureExistingMiningWallet(f.conn.db,f.buyer);
   const baseline=await readExistingMiningWalletBaseline(f.conn.db,{wallet:f.buyer});
   await captureGemsZeroOpening(f.conn.db,{wallet:f.buyer,baselineId:baseline.id});
   const [row]=await f.conn.sql`select id from mining_gems_zero_openings where wallet=${f.buyer}`;
   const opening=await readGemsZeroOpening(f.conn.db,{wallet:f.buyer,openingId:row!.id});
   expect(opening).toMatchObject({firstEligibleDay:cal.first,account:{id:account!.id,balance:'0'}});expect(opening).not.toHaveProperty('birthEventId');
   const sourceFirst=baseline.firstActivityDay;
   await f.clock(cal.closed+'T00:00:00Z');
   for(let at=Date.parse(sourceFirst);at<Date.parse(cal.first);at+=86400000){const day=new Date(at).toISOString().slice(0,10);await collectMiningActivityEvidence(f.conn.db,{day,policyVersion:'battle-evidence-v1'},cal.resourceClock);await collectMiningWalletExperience(f.conn.db,{day,policyVersion:1},cal.resourceClock);}
   const credit=await fundedMiningGems(f,f.identity,cal.first);
   await f.clock(cal.closed+'T00:00:00Z');
   const existingWallet={baselineFor:(wallet:string)=>wallet===f.buyer?{baselineId:baseline.id,openingId:opening.id}:null};
   const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
   let previousClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
   for(const [index,day] of [cal.first,cal.next].entries()){
    const stage=await f.stageResources(day,index===0?{free:[{resourceId:'forge_ingot',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'10'}]}:{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},undefined,{policyVersion:index===0?2:3,seekerEnrollment:e.seekerEnrollment,existingWallet,gems:credit.wiring});
    if(index===0){
     const noOpening={baselineFor:(wallet:string)=>wallet===f.buyer?{baselineId:baseline.id}:null};
     await expect(createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...stage.optionsForPrepare.sources,existingWallet:noOpening}})(stage.request)).rejects.toThrow();
     const {gems:_gems,...sources}=stage.optionsForPrepare.sources;
     await expect(createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources})(stage.request)).rejects.toThrow();
    }
    const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Covered zero source required');
    const m=JSON.parse(prepared.manifestJson),paid=m.captures.find((c:Json)=>c.wallet===f.buyer),participant=m.participants.find((c:Json)=>c.wallet===f.buyer);
    expect(m).toMatchObject({version:index===0?15:16,scope:index===0?'ordinary-resource-mining-zero-gems-v2':'ordinary-resource-mining-zero-gems-v3'});
    expect(paid.gems).toMatchObject({sourceKind:'committed-zero-inventory-fifo',openingId:opening.id,flow:{opening},result:{credits:index===0?1:0,usefulGemsComponentBps:index===0?GEMS_POLICY.usefulComponentBps:0}});
    expect(paid.activity.identity).toMatchObject({kind:'committed-existing-wallet',baselineId:baseline.id});expect(paid.activity.experienceCoverage.fromDay).toBe(sourceFirst);
    expect(paid.gemsContribution).toBeNull();expect(participant.usefulChainBps).toBe(index===0?GEMS_POLICY.usefulComponentBps:0);
    expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Json)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow();
    const mutations:[string,(v:Json)=>void][]=[
     ['old profile cannot admit new opening',v=>{v.version=index===0?13:14;v.scope=index===0?'ordinary-resource-mining-seeker-absence-v2':'ordinary-resource-mining-seeker-absence-v3';v.policy=index===0?seekerAbsenceResourceMiningPolicy:seekerAbsenceResourceMiningPolicyV3;}],
     ['foreign opening',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.openingId=randomUUID();}],
     ['different original baseline',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.flow.opening.baselineId=randomUUID();}],
     ['changed inventory',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.flow.opening.account.balance='1';}],
     ['invented birth',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.flow.birthEventId='1';}],
     ['changed chain identity',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.origins.chainIdentity.expectedGenesisHash=f.buyer;}],
     ['claimed unverified reward',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).gems.result.usefulGemsComponentBps++;}],
     ['omitted original XP range',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).activity.experienceCoverage.fromDay=day;}],
    ];
    for(const [reason,mutate] of mutations){const v=structuredClone(m);mutate(v);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(v),publication:prepared.publication}),reason).rejects.toThrow();}
    const published=await stage.publish();saved.push(published);
    expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
    expect(BigInt(m.playerNet)+BigInt(m.recycle)+BigInt(m.tax)).toBe(BigInt(m.freeGross)+BigInt(m.deedGross));
    previousClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,previousClaim);f.acceptClaim(previousClaim);
    expect(previousClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(index+1),daysAttested:BigInt(index+1)});
   }
   expect((await f.conn.sql`select balance::text balance from accounts where id=${account!.id}`)[0]?.balance).toBe('0');
   credit.transactions.clear();for(const source of e.archives.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Original source offline'));
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');
   for(const p of saved){expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);}
   const last=saved[1]!,m=JSON.parse(last.prepared.manifestJson),s=m.funding.source,c=m.funding.config;
   const prior=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,sequence:'2'});
   expect(prior.declaration.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({cumulativeRenown:2n,cumulativeDays:2n});
   expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
  },{replayFirstDay:cal.first,resourceClock:cal.resourceClock,enrollmentClock:true,precoverageBuyer:true,precoverageBuyerZero:true});
 },240_000);
});
