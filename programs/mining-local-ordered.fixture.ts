import {expect,it} from 'vitest';
import {withFundedMiningFixture} from '../apps/api/test/fixtures/fundedMining';
import {createFundedMiningProgramBridge} from '../apps/api/test/fixtures/fundedMiningProgramArtifact';
import {runFundedMiningProgram} from './mining-local-funded';
it('executes the source-derived ordered v0 profile on real SBF with an actual frozen table and bounded compute',async()=>{
 await withFundedMiningFixture(async f=>{
  const report=await runFundedMiningProgram({claimants:[f.walletSigner,f.buyerSigner],bridge:createFundedMiningProgramBridge(f),orderedV0:true});
  expect(report.genesisA).not.toBe(report.genesisB);expect(report.allowedMutations).toEqual(['AllocationRoot.publishedAt']);
  expect(report.claims).toHaveLength(2);expect(report.claims.every(c=>c.replayPreserved&&c.renown==='1'&&c.days==='1')).toBe(true);
  expect(report.dbReplayStable).toBe(true);expect(report.tamperRejected).toBe(true);expect(report.ordered?.packets).toHaveLength(3);expect(report.ordered?.executions).toHaveLength(6);
 });
});
