/** A cumulative root must inherit authenticated complete rights, never a cursor
 * or a caller-provided leaf list. Historical recovery needs no live RPC. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { withMiningClaimEntitlementFixture } from './fixtures/miningClaimEntitlement';
import { loadAuditedMiningPrior } from '../src/mining/publicationHistory';

type Fixture = Parameters<Parameters<typeof withMiningClaimEntitlementFixture>[0]>[0];
function identity(f: Fixture) {
  const t = f.backing.trust;
  return { ...f.identity, keepMint: t.keepMint.toBase58(), reserveOwner: t.reserveOwner.toBase58(),
    reviewedDeploymentSlot: t.reviewedDeploymentSlot, reviewedProgramDataSha256: t.reviewedProgramDataSha256,
    sequence: '1' };
}

describe('owner-held complete mining publication history', () => {
  it('requires finalized custody, then recovers both wallets and the exact frontier while paused without RPC', async () =>
    withMiningClaimEntitlementFixture(async f => {
      await expect(loadAuditedMiningPrior(f.conn.db, identity(f))).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
      const settled = await f.settle();
      f.chain.reader.getTransaction = async () => { throw new Error('Historical replay must not fetch RPC'); };
      vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
      try {
        const prior = await loadAuditedMiningPrior(f.conn.db, identity(f));
        expect(prior.reference).toMatchObject({ epochId: f.epochId, sequence: '1', root: f.prepared.publication.root,
          total: f.prepared.publication.total, signature: settled.signature, sourceHash: f.prepared.sourceHash });
        expect(prior.declaration.leaves.map(l => l.wallet).sort()).toEqual([f.wallet, f.buyer].sort());
        expect(prior.declaration.total).toBe(BigInt(f.prepared.publication.playerNet));
        expect(prior.frontier).toMatchObject({ latestSequence: 1n, totalPublished: prior.declaration.total,
          totalPublishedHighwater: prior.declaration.total, taxHighwater: BigInt(f.prepared.publication.tax),
          recycledTotal: BigInt(f.prepared.publication.recycle), grossPublished: BigInt(f.prepared.publication.freeGross),
          splitCursor: f.prepared.publication.splitEnd });
      } finally { vi.unstubAllEnvs(); }
    }));

  it('refuses a missing predecessor and foreign source identity without treating either as empty history', async () =>
    withMiningClaimEntitlementFixture(async f => {
      await f.settle();
      await expect(loadAuditedMiningPrior(f.conn.db, { ...identity(f), sequence: '2' }))
        .rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
      await expect(loadAuditedMiningPrior(f.conn.db, { ...identity(f), genesisHash: f.buyer }))
        .rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' });
      const good = await loadAuditedMiningPrior(f.conn.db, identity(f));
      await expect(loadAuditedMiningPrior(f.conn.db, { ...identity(f), expectedReference: { ...good.reference, sourceHash: '0'.repeat(64) } }))
        .rejects.toMatchObject({ code: 'HISTORY_CONFLICT' });
    }));

  it('rejects a broadly granted runtime account before loading historical authority', async () =>
    withMiningClaimEntitlementFixture(async f => {
      await f.settle(); const role = `history_${randomUUID().replaceAll('-', '')}`;
      await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
      try {
        await expect(f.conn.db.transaction(async tx => {
          const { sql } = await import('drizzle-orm');
          await tx.execute(sql.raw(`set local role ${role}`));
          return loadAuditedMiningPrior(tx, identity(f));
        })).rejects.toMatchObject({ code: 'OWNER_REQUIRED' });
      } finally { await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
    }));
});
