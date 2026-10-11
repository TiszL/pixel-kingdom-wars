import {describe,it,expect,vi,afterEach} from 'vitest';
import {PHASE_E_POLICY as P} from '@shardkeep/shared';
import {enrolledLinkCalendar,enrollBuyer} from './fixtures/miningEnrolledLink';
import {withFundedMiningReplayFixture,type FundedReplayFixture} from './fixtures/fundedMiningReplay';
import {randomUUID} from 'node:crypto';
import {resealExistingMiningWalletFixtureClock} from './fixtures/existingMiningWallet';
import {captureExistingMiningWallet,readExistingMiningWalletBaseline} from '../src/mining/existingMiningWallet';
import {readMiningWalletActivity} from '../src/mining/walletActivity';
import {readFreeGemsEvidence} from '../src/mining/freeGemsEvidence';
import {collectMiningActivityEvidence} from '../src/mining/activityEvidence';
import {collectMiningWalletExperience} from '../src/mining/walletExperience';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {enrolledSeekerResourceMiningPolicy,enrolledSeekerResourceMiningPolicyV3} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;

/** Synthetic finalized banks, authentic private SQL sources; no live or SBF claim. */
async function withExistingWorld(run:(f:FundedReplayFixture,cal:ReturnType<typeof enrolledLinkCalendar>)=>Promise<void>){
 const cal=enrolledLinkCalendar();
 return withFundedMiningReplayFixture(f=>run(f,cal),{replayFirstDay:cal.first,resourceClock:cal.resourceClock,enrollmentClock:true,precoverageBuyer:true});
}
describe('existing-wallet manifests11/12',()=>{
 it('preserves earlier covered XP and unknown opening Gems across two future publications, then replays the exact claims offline',()=>withExistingWorld(async(f,cal)=>{
  await resealExistingMiningWalletFixtureClock(f.conn);
  await installResourceMiningV3Cutover(f.conn.db,cal.next);
  expect(await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.buyer} and source_table='players'`).toHaveLength(0);
  expect(await f.conn.sql`select id from mining_gems_flow_events where wallet=${f.buyer}`).toHaveLength(0);
  const [opening]=await f.conn.sql`select balance::text balance from accounts where owner_wallet=${f.buyer} and kind='player_gems'`;
  expect(BigInt(opening!.balance)).toBeGreaterThan(0n);
  // This paid-wallet raid predates enrollment but belongs to a completely covered day.
  const priorRaid=randomUUID(),at=cal.earlier+'T16:00:00Z';await f.clock(at);
  await f.conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
   values(${priorRaid},${f.buyer},${f.paidBaseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at)-1000).toISOString()})`;
  await f.conn.sql`update player_action_events set occurred_at=${at} where source_id=${priorRaid} and source_key='battle_fought'`;
  await f.conn.sql`update raids set status='resolved',result='{"stars":1,"retreated":false}',resolved_at=${at} where id=${priorRaid}`;
  await f.conn.sql`update player_action_events set occurred_at=${at} where source_id=${priorRaid} and source_key='pve_battle'`;
  const e=await enrollBuyer(f,cal);
  await captureExistingMiningWallet(f.conn.db,f.buyer);
  const baseline=await readExistingMiningWalletBaseline(f.conn.db,{wallet:f.buyer});
  expect(baseline.firstEligibleDay).toBe(cal.first);
  const sourceFirst=new Date(Date.parse(cal.first)-2*86400000).toISOString().slice(0,10);
  expect(baseline.firstActivityDay).toBe(sourceFirst);
  await f.clock(cal.closed+'T00:00:00Z');
  let priorXp=0;
  for(const day of [sourceFirst,cal.earlier]){
   await collectMiningActivityEvidence(f.conn.db,{day,policyVersion:'battle-evidence-v1'},cal.resourceClock);
   const xp=await collectMiningWalletExperience(f.conn.db,{day,policyVersion:1},cal.resourceClock);
   priorXp+=xp.wallets.find(w=>w.wallet===f.buyer)?.awardedXp??0;
  }
  expect(priorXp).toBeGreaterThan(0);
  const existingWallet={baselineFor:(wallet:string,day:string)=>wallet===f.buyer&&day>=baseline.firstEligibleDay?{baselineId:baseline.id}:null};
  const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
  let previousClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
  for(const [index,date] of [cal.first,cal.next].entries()){
   const stage=await f.stageResources(date,index===0?{free:[{resourceId:'forge_ingot',quantity:'1'}],paid:[{resourceId:'forge_ingot',quantity:'1'},{resourceId:'heartwood_logs',quantity:'10'}]}:{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},undefined,{policyVersion:index===0?2:3,seekerEnrollment:e.seekerEnrollment,existingWallet});
   await expect(readMiningWalletActivity(f.conn.db,{wallet:f.buyer,day:date,policyVersion:1})).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
   await expect(readFreeGemsEvidence(f.conn.db,{wallet:f.buyer,day:date})).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
   if(index===0){
    const {existingWallet:_wired,...unwiredSources}=stage.optionsForPrepare.sources;
    const unwired=createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:unwiredSources});
    await expect(unwired(stage.request)).rejects.toThrow(/IDENTITY_COVERAGE_UNAVAILABLE/);
   }
   const prepared=await stage.prepare(stage.request);if(prepared.status!=='prepared')throw Error('Useful original required');
   const manifest=JSON.parse(prepared.manifestJson);
   expect(manifest).toMatchObject({version:index===0?11:12,scope:index===0?'ordinary-resource-mining-existing-wallet-v2':'ordinary-resource-mining-existing-wallet-v3',input:{policyVersion:index===0?2:3}});
   const boosted=manifest.participants.find((p:{wallet:string})=>p.wallet===f.buyer);
   expect(boosted.bonusBps).toBe(P.mining.seekerBonusBps);
   expect(boosted.weight).toBe(String(BigInt(boosted.eligibleValue)*BigInt(boosted.baseScoreBps)*BigInt(P.basisPoints+P.mining.seekerBonusBps)/BigInt(P.basisPoints)));
   expect(BigInt(boosted.weight)>0n).toBe(true);
   expect(manifest.participants.find((p:{wallet:string})=>p.wallet===f.wallet).bonusBps).toBe(0);
   const paid=manifest.captures.find((c:{wallet:string})=>c.wallet===f.buyer),free=manifest.captures.find((c:{wallet:string})=>c.wallet===f.wallet);
   expect(paid.activity.identity).toMatchObject({kind:'committed-existing-wallet',baselineId:baseline.id});
   expect(paid.activity.identity).not.toHaveProperty('birthEventId');
   expect(paid.activity.recordedXp).toBeGreaterThan(priorXp);
   expect(paid.activity.experienceCoverage.fromDay).toBe(sourceFirst);
   expect(paid.activity.qualifiedRaids.some((r:{raidId:string})=>r.raidId===priorRaid)).toBe(true);
   expect(paid.gems).toMatchObject({sourceKind:'committed-existing-wallet-no-debit',baselineId:baseline.id,openingGems:'unknown',debitCount:0,contribution:'0'});
   expect(paid.gems).not.toHaveProperty('zeroQualifyingCredit');
   expect(paid.gemsContribution).toBeNull();expect(boosted.usefulChainBps).toBe(0);
   expect(paid.seeker).toEqual({linkSource:'committed-enrollment-interval',wallet:f.buyer,day:date,enrollmentId:e.challenge.enrollment.id,link:{wallet:f.buyer,seekerWallet:e.identity.linkedWallet,sgtMint:e.identity.mint,revokedAt:null}});
   expect(paid.seekerQualification).toMatchObject({version:2,interval:{enrollmentId:e.challenge.enrollment.id}});
   expect(paid.seekerQualification.providers).toHaveLength(2);
   expect(free.seeker).toMatchObject({status:'no_link',openingLink:null,closingLink:null,changes:[],sourceUniverse:'recorded-seeker-link-events'});
   expect(free).not.toHaveProperty('seekerQualification');
   expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Record<string,unknown>)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow();
   const mutations:[string,(m:Json)=>void][]=[
    ['downgrade to the original enrolled profile9/10',m=>{m.version=index===0?9:10;m.scope=index===0?'ordinary-resource-mining-enrolled-seeker-v2':'ordinary-resource-mining-enrolled-seeker-v3';m.policy=index===0?enrolledSeekerResourceMiningPolicy:enrolledSeekerResourceMiningPolicyV3;}],
    ['changed baseline ID',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).gems.baselineId=randomUUID();}],
    ['earlier verified XP range omitted',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).activity.experienceCoverage.fromDay=date;}],
    ['Gems source grafted to free wallet',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.wallet).gems=structuredClone(paid.gems);}],
    ['unknown balance relabelled as legacy zero',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).gems=structuredClone(free.gems);}],
    ['debit count invented',m=>{m.captures.find((c:{wallet:string})=>c.wallet===f.buyer).gems.debitCount=1;}],
   ];
   for(const [reason,mutate] of mutations){const changed=structuredClone(manifest);mutate(changed);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:prepared.publication}),reason).rejects.toThrow();}
   const published=await stage.publish();saved.push(published);
   expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
   expect(BigInt(manifest.playerNet)+BigInt(manifest.recycle)+BigInt(manifest.tax)).toBe(BigInt(manifest.freeGross)+BigInt(manifest.deedGross));
   previousClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,previousClaim);f.acceptClaim(previousClaim);
   expect(previousClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(index+1),daysAttested:BigInt(index+1)});
  }
  const [unchanged]=await f.conn.sql`select balance::text balance from accounts where owner_wallet=${f.buyer} and kind='player_gems'`;expect(unchanged!.balance).toBe(opening!.balance);
  // Providerless paused replay after a later revocation: originals, settlement and cumulative rights are unchanged.
  const last=saved[1]!;
  await f.clock(cal.closed+'T02:00:00Z');await f.conn.sql`update seeker_links set revoked_at=${cal.closed+'T02:00:00Z'} where wallet=${f.buyer}`;
  for(const source of e.archives.archives)source.reader.getGenesisHash.mockRejectedValue(Error('Original archive offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(const p of saved){expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);}
  const m=JSON.parse(last.prepared.manifestJson),s=m.funding.source,c=m.funding.config;
  const replay=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,
   reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,sequence:'2'});
  expect(replay.declaration.total).toBe(BigInt(last.prepared.publication.total));
  expect(replay.declaration.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({cumulativeRenown:2n,cumulativeDays:2n});
  expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
 }),240_000);
});
