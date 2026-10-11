import { expect, it } from 'vitest';
import { withFundedMiningReplayFixture } from './fundedMiningReplay';
import { createResourceMiningProgramBridge } from './resourceMiningProgramArtifact';
import { runFundedMiningProgram } from '../../../../programs/mining-local-funded';

it('publishes native mixed baskets at the free cap and above former deed caps on A, then claims original KEEP/Renown once in explicitly aged B', async () => {
  await withFundedMiningReplayFixture(async f => {
    const report = await runFundedMiningProgram({
      claimants: [f.walletSigner, f.buyerSigner], bridge: createResourceMiningProgramBridge(f),
    });
    expect(report.genesisA).not.toBe(report.genesisB);
    expect(report.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.claims.map(claim => claim.wallet).sort()).toEqual([f.wallet, f.buyer].sort());
    for (const claim of report.claims) {
      expect(BigInt(claim.keep)).toBeGreaterThan(0n);
      expect(claim.renown).toBe('1'); expect(claim.days).toBe('1'); expect(claim.replayPreserved).toBe(true);
    }
    expect(report.tamperRejected).toBe(true); expect(report.dbReplayStable).toBe(true);
    expect(report.allowedMutations).toEqual(['AllocationRoot.publishedAt']); expect(report.copiedAccounts).toBeGreaterThan(0);
  });
});
