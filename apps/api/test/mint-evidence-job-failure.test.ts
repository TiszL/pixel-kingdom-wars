import { afterEach, expect, it, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { DeedMintInventoryError, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import type { Db } from '../src/db/client';
import { invalidateMintEvidenceInventory, reconcilePlaytestMintEvidence, reconcileCampaignCloseEvidence } from '../src/game/playtestMintEvidence';
import { relayServerError } from '../src/telemetry';
import { runConfiguredMintEvidenceReconciliation, runMintEvidenceReconciliation } from '../src/jobs';
vi.mock('../src/game/playtestMintEvidence', () => ({ invalidateMintEvidenceInventory: vi.fn(), reconcilePlaytestMintEvidence: vi.fn(), reconcileCampaignCloseEvidence: vi.fn() }));
vi.mock('../src/telemetry', async original => ({ ...await original<typeof import('../src/telemetry')>(), relayServerError: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const db = {} as Db, rpc = {} as Connection;
it('preserves the typed inventory failure and separately reports a sanitized secondary close failure', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const primary = new DeedMintInventoryError({ reason: 'rpc_rate_limit', stage: 'assets', attempts: 3, contextRetries: 0, httpStatus: 429 });
  vi.mocked(reconcilePlaytestMintEvidence).mockRejectedValue(primary);
  vi.mocked(reconcileCampaignCloseEvidence).mockRejectedValue(new Error('PRIVATE_SQL_BODY https://rpc.invalid?token=PRIVATE_KEY'));
  await expect(runMintEvidenceReconciliation(db, rpc, 'collection', rpc)).rejects.toBe(primary);
  expect(reconcileCampaignCloseEvidence).toHaveBeenCalledExactlyOnceWith(db, rpc, 'collection');
  expect(relayServerError).toHaveBeenCalledOnce();
  const [error, context] = vi.mocked(relayServerError).mock.calls[0]!;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('Campaign close evidence verification unavailable');
  expect(context).toEqual({ logger: 'pkw-worker', route: 'job:mint-evidence:close' });
  expect(JSON.stringify(log.mock.calls)).toContain('rpc_rate_limit');
  expect(`${JSON.stringify(log.mock.calls)} ${(error as Error).stack}`).not.toMatch(/PRIVATE|rpc.invalid/);
});
it('throws only the sanitized close failure when inventory succeeded, for the common failed-job relay', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(reconcilePlaytestMintEvidence).mockResolvedValue({ complete: true, assets: 1, diagnostics: { stage: 'collection_after', attempts: 1, contextRetries: 0 } });
  vi.mocked(reconcileCampaignCloseEvidence).mockRejectedValue(new Error('PRIVATE_SQL_BODY'));
  const error = await runMintEvidenceReconciliation(db, rpc, 'collection', rpc).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain('Campaign close evidence verification unavailable');
  expect(relayServerError).not.toHaveBeenCalled();
  expect(`${error.stack} ${JSON.stringify(log.mock.calls)}`).not.toContain('PRIVATE');
});


it.each([undefined, 'https://mint.example/?api-key=private'])('keeps inventory, original proofs and campaign close on the attested selected endpoint (%s)', async override => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: SOLANA_GENESIS_HASH.devnet }))));
  vi.mocked(reconcilePlaytestMintEvidence).mockResolvedValue({ complete: true, assets: 1, diagnostics: { stage: 'collection_after', attempts: 1, contextRetries: 0 } });
  vi.mocked(reconcileCampaignCloseEvidence).mockResolvedValue({ campaigns: 0 });
  const primary = 'https://primary.example/?api-key=private';
  await runConfiguredMintEvidenceReconciliation(db, { SOLANA_RPC_URL: primary, SOLANA_CLUSTER: 'devnet', MINT_EVIDENCE_RPC_URL: override }, 'collection');
  expect(fetch).toHaveBeenCalledWith(override ?? primary, expect.anything());
  const [, connection, , factory] = vi.mocked(reconcilePlaytestMintEvidence).mock.calls[0]!;
  expect(connection.rpcEndpoint).toBe(override ?? primary);
  if (typeof factory !== 'function') throw new Error('expected cancellable inventory connection factory');
  expect(factory(new AbortController().signal).rpcEndpoint).toBe(override ?? primary);
  expect(reconcileCampaignCloseEvidence).toHaveBeenCalledExactlyOnceWith(db, connection, 'collection');
});
it.each(['wrong_cluster', 'unavailable'])('withholds every reconciliation when mint endpoint attestation fails: %s', async reason => {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (reason === 'unavailable') throw new Error('https://mint.example/?api-key=PRIVATE_KEY');
    return new Response(JSON.stringify({ result: SOLANA_GENESIS_HASH['mainnet-beta'] }));
  }));
  const error = await runConfiguredMintEvidenceReconciliation(db, {
    SOLANA_RPC_URL: 'https://primary.example', SOLANA_CLUSTER: 'devnet', MINT_EVIDENCE_RPC_URL: 'https://mint.example',
  }, 'collection').catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain('PRIVATE');
  expect(invalidateMintEvidenceInventory).toHaveBeenCalledWith(db, expect.objectContaining({ diagnostics: expect.objectContaining({ reason: reason === 'wrong_cluster' ? 'cluster_mismatch' : 'cluster_unavailable' }) }));
  expect(reconcilePlaytestMintEvidence).not.toHaveBeenCalled();
  expect(reconcileCampaignCloseEvidence).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});
