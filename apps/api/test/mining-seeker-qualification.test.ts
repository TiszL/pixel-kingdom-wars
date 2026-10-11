/** Actual prospective DB checkpoints composed with SDK-encoded synthetic archive
 * records. These tests are source/retained-replay acceptance, not live RPC proof. */
import { describe, expect, it, vi } from 'vitest';
import { PHASE_E_POLICY as P } from '@shardkeep/shared';
import { replayMiningSeekerCoverageEvidence } from '@shardkeep/chain/mining-seeker-coverage';
import { seekerMintBirthFixture } from '../../../packages/chain/src/testFixtures/miningSeekerHolding';
import { seekerCoverageFixture } from '../../../packages/chain/src/testFixtures/miningSeekerCoverage';
import { captureMiningSeekerCheckpoint, initializeMiningSeekerCoverageChallenge, readMiningSeekerCoverageChallenge } from '../src/mining/seekerCheckpointHistory';
import { captureMiningSeekerQualification, replayMiningSeekerQualification, type MiningSeekerQualificationEvidence,
 type SeekerMiningQualificationReader, type SeekerMiningQualificationWiring } from '../src/mining/seekerMiningQualification';
import { withSeekerLinkHistoryFixture } from './fixtures/seekerLinkHistory';
import { createSeekerMiningArchives } from './fixtures/seekerMiningQualification';
import type { Db } from '../src/db/client';

type DbFixture = Parameters<Parameters<typeof withSeekerLinkHistoryFixture>[0]>[0];
type EditableEvidence = { wallet: string; day: string; bonusBps?: number;
 checkpoint: { link: { seekerWallet: string }; coverageStartedAt: string };
 coverageChallenge: { nonce: string; memo: string; birthEventFloor: string }; coverageSignature: string;
 providers: [{ id: string; evidenceJson: string; coverageEvidenceJson: string; trusted?: boolean }, { id: string; evidenceJson: string; coverageEvidenceJson: string; trusted?: boolean }] };
async function fixture(run: (f: DbFixture & ReturnType<typeof createSeekerMiningArchives> & {
 capture: (signal?: AbortSignal) => Promise<MiningSeekerQualificationEvidence> }) => Promise<void>) {
 await withSeekerLinkHistoryFixture(async f => {
  await initializeMiningSeekerCoverageChallenge(f.conn.db);
  const sources = createSeekerMiningArchives(await readMiningSeekerCoverageChallenge(f.conn.db));
  await f.clock('2020-01-01T12:00:00Z'); await f.link(f.wallet, sources.input.mint, sources.input.linkedWallet);
  await f.clock('2020-01-01T13:00:00Z'); await captureMiningSeekerCheckpoint(f.conn.db, f.wallet); await f.close();
  const request = { wallet: f.wallet, day: f.request.day };
  await run({ ...f, ...sources, capture: signal => captureMiningSeekerQualification(f.conn.db, sources.wiring, request, signal) });
 });
}

describe('prospective positive SGT mining qualification', () => {
 it('binds the committed DB challenge, finalized signed nonce, original mint birth, checkpoint and both full holding transcripts, retaining the original when live sources change', () => fixture(async f => {
  const evidence = await f.capture(), replay = replayMiningSeekerQualification(evidence);
  expect(replay).toMatchObject({ wallet: f.wallet, day: f.request.day, seekerWallet: f.archives[0].input.linkedWallet,
   sgtMint: f.archives[0].input.mint, tokenAccount: f.archives[0].input.tokenAccount, bonusBps: P.mining.seekerBonusBps });
  expect(evidence.checkpoint).toMatchObject({ uniqueMintSinceCoverage: true, historicalChainOwnership: 'unknown', bonusAuthorized: false, eligibilityAuthorized: false });
  expect(evidence.providers).toHaveLength(2); expect(evidence.providers.every(p => JSON.parse(p.evidenceJson).bodies.length === 3)).toBe(true);
  expect(evidence.coverageChallenge.nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(evidence.providers.every(p => replayMiningSeekerCoverageEvidence(p.coverageEvidenceJson,
   { nonceHex: evidence.coverageChallenge.nonce, signature: evidence.coverageSignature }).slot < f.archives[0].birth.slot)).toBe(true);
  expect(Object.isFrozen(evidence)).toBe(true); expect(Object.isFrozen(evidence.checkpoint)).toBe(true); expect(Object.isFrozen(evidence.providers)).toBe(true);
  await f.conn.sql`update seeker_links set revoked_at=now() where wallet=${f.wallet}`;
  for (const source of f.archives) source.reader.getGenesisHash.mockRejectedValue(Error('offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  expect(replayMiningSeekerQualification(JSON.parse(JSON.stringify(evidence)))).toEqual(replay);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }), 30_000);

 it('rejects tampered envelope, link, provider identity, mint creation and token holding without trusting a supplied bonus', () => fixture(async f => {
  const original = await f.capture();
  const changes: [string, (value: EditableEvidence) => void][] = [
   ['claimed bonus', v => { v.bonusBps = P.mining.seekerBonusBps; }],
   ['foreign game wallet', v => { v.wallet = f.buyer; }],
   ['different UTC day', v => { v.day = '2020-01-03'; }],
   ['duplicate provider aliases', v => { v.providers[1].id = v.providers[0].id.toUpperCase(); }],
   ['provider URL', v => { v.providers[0].id = 'https://secret.example/?key=secret'; }],
   ['extra provider authority', v => { v.providers[0].trusted = true; }],
   ['changed source link', v => { v.checkpoint.link.seekerWallet = f.buyer; }],
   ['late coverage', v => { v.checkpoint.coverageStartedAt = '2020-01-01T06:00:00.000001Z'; }],
   ['foreign coverage nonce', v => { v.coverageChallenge.nonce = 'f1'.repeat(32); v.coverageChallenge.memo = 'SHARDKEEP:MINING:SEEKER:COVERAGE:v1:' + v.coverageChallenge.nonce; }],
   ['different original marker', v => { v.coverageChallenge.birthEventFloor = '999999'; }],
   ['foreign original witness', v => { v.coverageSignature = f.archives[0].birth.transaction.signatures[0]!; }],
   ['missing witness', v => { v.providers[0].coverageEvidenceJson = '{}'; }],
   ['forged signed memo', v => { const t = JSON.parse(v.providers[0].coverageEvidenceJson); const bytes = Buffer.from(t.transaction.messageBase64, 'base64'); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; t.transaction.messageBase64 = bytes.toString('base64'); v.providers[0].coverageEvidenceJson = JSON.stringify(t); }],
   ['missing mint birth', v => { const t = JSON.parse(v.providers[0].evidenceJson); t.bodies = t.bodies.filter((b: { slot: number }) => b.slot !== 5); v.providers[0].evidenceJson = JSON.stringify(t); }],
   ['changed raw holding', v => { const t = JSON.parse(v.providers[0].evidenceJson); const bytes = Buffer.from(t.accounts[1].data, 'base64'); bytes.writeBigUInt64LE(0n, 64); t.accounts[1].data = bytes.toString('base64'); v.providers[0].evidenceJson = JSON.stringify(t); }],
  ];
  for (const [reason, change] of changes) { const value = JSON.parse(JSON.stringify(original)); change(value); expect(() => replayMiningSeekerQualification(value), reason).toThrow(); }
  const tooLarge = JSON.parse(JSON.stringify(original)); tooLarge.providers[0].evidenceJson = 'x'.repeat(4 * 1024 * 1024);
  expect(() => replayMiningSeekerQualification(tooLarge)).toThrow(/TOO_LARGE/);
 }), 30_000);

 it('requires causal slot ordering even when estimated mint timestamps appear later than the DB coverage clock', () => fixture(async f => {
  const original = await f.capture();
  for (const witnessSlot of [f.archives[0].birth.slot, f.archives[0].birth.slot + 1]) {
   const value = JSON.parse(JSON.stringify(original)) as EditableEvidence;
   for (const provider of value.providers) {
    const transcript = JSON.parse(provider.coverageEvidenceJson);
    // Signed message and all chain-time claims stay unchanged. Both archives
    // now locate that otherwise-valid Memo at/after original mint creation.
    transcript.transaction.slot = witnessSlot; transcript.status.slot = witnessSlot; transcript.block.slot = witnessSlot;
    provider.coverageEvidenceJson = JSON.stringify(transcript);
    expect(replayMiningSeekerCoverageEvidence(provider.coverageEvidenceJson,
     { nonceHex: value.coverageChallenge.nonce, signature: value.coverageSignature }).slot).toBe(witnessSlot);
   }
   expect(() => replayMiningSeekerQualification(value)).toThrow(/SOURCE_CONFLICT/);
  }
 }), 30_000);

 it('treats incomplete, non-mainnet and disagreeing archives as unavailable instead of a zero bonus', () => fixture(async f => {
  const [a, b] = f.archives;
  b.reader.getGenesisHash.mockResolvedValueOnce(f.buyer); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  const original = b.reader.getTransaction.getMockImplementation()!;
  b.reader.getTransaction.mockResolvedValueOnce(null); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); b.reader.getTransaction.mockImplementation(original);
  // Both transcripts remain structurally valid, but disagree about immutable mint bytes.
  b.accounts[0]!.data.writeBigUInt64LE(2n, 302);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  expect(a.reader.getGenesisHash).toHaveBeenCalled(); expect(b.reader.getGenesisHash).toHaveBeenCalled();
 }), 30_000);

 it('refuses a same-object provider despite different labels and propagates cancellation to both transports', () => fixture(async f => {
  const request = { wallet: f.wallet, day: f.request.day };
  const duplicate: SeekerMiningQualificationWiring = { coverageSignature: f.wiring.coverageSignature, providers: [f.wiring.providers[0], { id: 'different-name', connect: f.wiring.providers[0].connect }] };
  await expect(captureMiningSeekerQualification(f.conn.db, duplicate, request)).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); const signals: AbortSignal[] = [];
  const wiring: SeekerMiningQualificationWiring = { coverageSignature: f.wiring.coverageSignature, providers: [0, 1].map(i => ({ id: `archive-${i}`, connect: (signal: AbortSignal) => {
   signals.push(signal); const reader = f.archives[i]!.reader;
   reader.getGenesisHash.mockImplementation(() => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); if (signals.length === 2) ready(); }));
   return reader as unknown as SeekerMiningQualificationReader;
  } })) as unknown as SeekerMiningQualificationWiring['providers'] };
  const controller = new AbortController(), pending = captureMiningSeekerQualification(f.conn.db, wiring, request, controller.signal);
  await started; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); expect(signals.every(signal => signal.aborted)).toBe(true);
 }), 30_000);

 it('rejects request authority and malformed or repeated archive identities before a DB or RPC read', async () => {
  const source = seekerMintBirthFixture(), coverageSignature = seekerCoverageFixture().input.signature,
   connect = vi.fn(() => source.reader as unknown as SeekerMiningQualificationReader);
  const providers = [{ id: 'same', connect }, { id: 'SAME', connect }] as const;
  await expect(captureMiningSeekerQualification({} as Db, { providers, coverageSignature }, { wallet: source.input.linkedWallet, day: '2020-01-02' })).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });
  await expect(captureMiningSeekerQualification({} as Db, { providers, coverageSignature }, { wallet: source.input.linkedWallet, day: '2020-01-02', bonusBps: P.mining.seekerBonusBps } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(connect).not.toHaveBeenCalled();
 });
});
