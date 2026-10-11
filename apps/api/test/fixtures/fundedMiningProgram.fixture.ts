import { expect, it } from 'vitest';
import { withFundedMiningFixture } from './fundedMining';
import { createFundedMiningProgramBridge } from './fundedMiningProgramArtifact';
import { runFundedMiningProgram } from '../../../../programs/mining-local-funded';

it('derives one paid/free DB award, settles actual publication on A, and earns exact KEEP/Renown once in explicitly aged B', async () => {
  await withFundedMiningFixture(async f => {
    const report = await runFundedMiningProgram({
      claimants: [f.walletSigner, f.buyerSigner], bridge: createFundedMiningProgramBridge(f),
    });
    expect(report.genesisA).not.toBe(report.genesisB);
    expect(report.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.claims.map(c => c.wallet).sort()).toEqual([f.wallet, f.buyer].sort());
    for (const claim of report.claims) {
      expect(BigInt(claim.keep)).toBeGreaterThan(0n);
      expect(claim.renown).toBe('1'); expect(claim.days).toBe('1');
      expect(claim.replayPreserved).toBe(true);
    }
    expect(report.tamperRejected).toBe(true);
    expect(report.dbReplayStable).toBe(true);
    expect(report.allowedMutations).toEqual(['AllocationRoot.publishedAt']);
    expect(report.copiedAccounts).toBeGreaterThan(0);
  });
});
