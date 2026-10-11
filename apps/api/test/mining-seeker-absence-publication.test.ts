import {describe,it,expect,vi,afterEach} from 'vitest';
import {Keypair} from '@solana/web3.js';
import {withEnrolledLinkWorld,coverageOrder,enrollBuyer} from './fixtures/miningEnrolledLink';
import {readMiningSeekerLinkHistory} from '../src/mining/seekerLinkHistory';
import {readMiningSeekerAbsenceInterval,validateMiningSeekerAbsenceIntervalEvidence} from '../src/mining/seekerMiningAbsence';
import {executeFundedMiningClaim} from './fixtures/fundedMiningClaims';
import {auditStoredResourcePublication,loadAuditedMiningPrior} from '../src/mining/publicationHistory';
import {getPreparedMiningPublication} from '../src/mining/publicationPreparation';
import {resourceMiningPolicy,resourceMiningPolicyV3,existingWalletResourceMiningPolicy,existingWalletResourceMiningPolicyV3} from '../src/mining/resourceMiningAudit';
import {miningCanonical} from '../src/mining/fundedMiningAudit';
import {deriveFundedMiningWallet} from '../src/mining/fundedMiningQualification';
import {createMiningClaimEntitlementReader} from '../src/mining/claimEntitlement';
import {createResourceMiningPublicationPreparer} from '../src/mining/fundedMiningAllocation';
import {installResourceMiningV3Cutover} from '../src/mining/resourceMiningPolicy';
afterEach(()=>vi.unstubAllEnvs());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json=Record<string,any>;
const lines={free:[{resourceId:'forge_ingot' as const,quantity:'1'}],paid:[{resourceId:'forge_ingot' as const,quantity:'1'},{resourceId:'heartwood_logs' as const,quantity:'10'}]};

describe('Seeker absence manifests13/14',()=>{
 it('admits captured pre-marker players without a bonus across two days, retains exact claims after a later link and provider loss',()=>withEnrolledLinkWorld(async(f,cal)=>{
  await installResourceMiningV3Cutover(f.conn.db,cal.next);
  expect(await coverageOrder(f,f.buyer)).toMatchObject({afterFloor:false,markerBeforeObserved:false,identityCoverageBeforeBirth:true,gemsCoverageBeforeBirth:true,activityCoverageBeforeBirth:true});
  const seekerAbsence={absenceFor:(wallet:string)=>wallet===f.buyer};
  const saved:Awaited<ReturnType<Awaited<ReturnType<typeof f.stageResources>>['publish']>>[]=[];
  let previousClaim:Awaited<ReturnType<typeof executeFundedMiningClaim>>|null=null;
  for(const [index,day] of [cal.first,cal.next].entries()){
   const stage=await f.stageResources(day,index===0?lines:{free:[{resourceId:'climate_kit',quantity:'1'}],paid:[{resourceId:'expedition_kit',quantity:'3'}]},undefined,{policyVersion:index===0?2:3,seekerAbsence});
   await expect(readMiningSeekerLinkHistory(f.conn.db,{wallet:f.buyer,day,policyVersion:1})).rejects.toMatchObject({code:'IDENTITY_COVERAGE_UNAVAILABLE'});
   if(index===0){
    const {seekerAbsence:_wired,...sources}=stage.optionsForPrepare.sources;
    await expect(createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources})(stage.request)).rejects.toThrow(/IDENTITY_COVERAGE_UNAVAILABLE/);
    await expect(createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...sources,seekerAbsence:{absenceFor:()=>false}}})(stage.request)).rejects.toThrow(/IDENTITY_COVERAGE_UNAVAILABLE/);
    const invalid={absenceFor:()=>1} as unknown as NonNullable<typeof stage.optionsForPrepare.sources.seekerAbsence>;
    await expect(createResourceMiningPublicationPreparer(f.conn.db,{...stage.optionsForPrepare,sources:{...sources,seekerAbsence:invalid}})(stage.request)).rejects.toThrow(/SOURCE_CONFLICT/);
   }
   const p=await stage.prepare(stage.request);if(p.status!=='prepared')throw Error('Useful original required');
   const m=JSON.parse(p.manifestJson),paid=m.captures.find((c:{wallet:string})=>c.wallet===f.buyer);
   expect(m).toMatchObject({version:index===0?13:14,scope:index===0?'ordinary-resource-mining-seeker-absence-v2':'ordinary-resource-mining-seeker-absence-v3'});
   expect(paid.seeker).toEqual({linkSource:'committed-absence-interval',wallet:f.buyer,day,link:null});
   expect(paid.seekerAbsence).toMatchObject({purpose:'seeker_absence_interval',wallet:f.buyer,day,link:null,bonusAuthorized:false});
   expect(paid.seekerAbsence.birth.eventId).toBe(paid.activity.identity.birthEventId);
   expect(paid).not.toHaveProperty('seekerQualification');
   expect(m.participants.every((a:{bonusBps:number})=>a.bonusBps===0)).toBe(true);
   expect(BigInt(m.participants.find((a:{wallet:string})=>a.wallet===f.buyer).weight)).toBeGreaterThan(0n);
   expect(()=>deriveFundedMiningWallet({...paid,bases:paid.bases.map((b:Json)=>({...b,reservedUnits:1}))},f.identity.genesisHash,2)).toThrow();
   const mutations:[string,(v:Json)=>void][]=[
    ['downgraded ordinary profile',v=>{v.version=index===0?5:7;v.scope=index===0?'ordinary-resource-mining-v2':'ordinary-resource-mining-v3';v.policy=index===0?resourceMiningPolicy:resourceMiningPolicyV3;}],
    ['downgraded baseline profile',v=>{v.version=index===0?11:12;v.scope=index===0?'ordinary-resource-mining-existing-wallet-v2':'ordinary-resource-mining-existing-wallet-v3';v.policy=index===0?existingWalletResourceMiningPolicy:existingWalletResourceMiningPolicyV3;}],
    ['foreign wallet proof',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).seekerAbsence.wallet=f.wallet;}],
    ['missing proof',v=>{delete v.captures.find((c:Json)=>c.wallet===f.buyer).seekerAbsence;}],
    ['profile without any absence source',v=>{const cap=v.captures.find((c:Json)=>c.wallet===f.buyer);delete cap.seekerAbsence;cap.seeker={...structuredClone(v.captures.find((c:Json)=>c.wallet===f.wallet).seeker),wallet:f.buyer};}],
    ['bonus authority invented',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).seekerAbsence.bonusAuthorized=true;}],
    ['unknown link discriminator',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).seeker.linkSource='unknown';}],
    ['captured birth changed',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).seekerAbsence.birth.eventId='999999';}],
    ['internally consistent foreign birth',v=>{const proof=v.captures.find((c:Json)=>c.wallet===f.buyer).seekerAbsence;proof.birth.eventId='999999';proof.marker.birthEventFloor='999999';proof.events.find((e:Json)=>e.sourceTable==='players').id='999999';validateMiningSeekerAbsenceIntervalEvidence(proof);}],
    ['extra projection authority',v=>{v.captures.find((c:Json)=>c.wallet===f.buyer).seeker.bonusAuthorized=true;}],
    ['source graft to free wallet',v=>{v.captures.find((c:Json)=>c.wallet===f.wallet).seekerAbsence=structuredClone(paid.seekerAbsence);}]
   ];
   for(const [reason,mutate] of mutations){const changed=structuredClone(m);mutate(changed);await expect(auditStoredResourcePublication(f.conn.db,{manifestJson:miningCanonical(changed),publication:p.publication}),reason).rejects.toThrow();}
   const published=await stage.publish();saved.push(published);
   expect(published.settlement.contributions.every(c=>c.outcome==='consumed')).toBe(true);
   expect(BigInt(m.playerNet)+BigInt(m.recycle)+BigInt(m.tax)).toBe(BigInt(m.freeGross)+BigInt(m.deedGross));
   previousClaim=await executeFundedMiningClaim({...f,wallet:f.buyer,walletSigner:f.buyerSigner},published,previousClaim);f.acceptClaim(previousClaim);
   expect(previousClaim.postSnapshot.renownRecord).toMatchObject({renownTotal:BigInt(index+1),daysAttested:BigInt(index+1)});
  }
  // A future link cannot rewrite either saved zero-bonus day.
  await f.clock(cal.closed+'T02:00:00Z');
  await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${Keypair.generate().publicKey.toBase58()},${Keypair.generate().publicKey.toBase58()})`;
  expect((await readMiningSeekerAbsenceInterval(f.conn.db,{wallet:f.buyer,day:cal.next})).link).toBeNull();
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  for(const p of saved){p.backing.reader.getGenesisHash=async()=>{throw Error('Provider offline');};expect(await getPreparedMiningPublication(f.conn.db,p.prepared.epochId)).toEqual(p.prepared);expect(await p.settle()).toEqual(p.settlement);}
  const last=saved[1]!,m=JSON.parse(last.prepared.manifestJson),s=m.funding.source,c=m.funding.config;
  const replay=await loadAuditedMiningPrior(f.conn.db,{genesisHash:s.genesisHash,programId:s.programId,configAddress:c.address,keepMint:c.keepMint,reserveOwner:c.emissionReserveOwner,
   reviewedDeploymentSlot:s.reviewedDeploymentSlot,reviewedProgramDataSha256:s.reviewedProgramDataSha256,sequence:'2'});
  expect(replay.declaration.leaves.find(l=>l.wallet===f.buyer)).toMatchObject({cumulativeRenown:2n,cumulativeDays:2n});
  expect((await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.buyer)).kind).toBe('entitlement');
 }),240_000);
 it('refuses simultaneous positive enrollment and absence instead of silently choosing zero bonus',()=>withEnrolledLinkWorld(async(f,cal)=>{
  const e=await enrollBuyer(f,cal);
  const stage=await f.stageResources(cal.first,lines,undefined,{policyVersion:2,seekerEnrollment:e.seekerEnrollment,seekerAbsence:{absenceFor:wallet=>wallet===f.buyer}});
  await expect(stage.prepare(stage.request)).rejects.toThrow(/SOURCE_CONFLICT/);
 }),120_000);
});
