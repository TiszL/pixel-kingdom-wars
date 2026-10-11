/** Actual committed enrollment sources plus SDK-encoded synthetic archives.
 * Acceptance of the composition is not live mainnet verification or activation. */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { PHASE_E_POLICY as P } from '@shardkeep/shared';
import { replayMiningSeekerEnrollmentEvidence } from '@shardkeep/chain/mining-seeker-enrollment';
import { seekerMintBirthFixture, tx, other, wallet as chainWallet, mint } from '../../../packages/chain/src/testFixtures/miningSeekerHolding';
import { seekerCoverageFixture } from '../../../packages/chain/src/testFixtures/miningSeekerCoverage';
import { captureMiningSeekerEnrollment, readMiningSeekerEnrollmentChallenge } from '../src/mining/seekerMiningEnrollment';
import { captureMiningSeekerEnrollmentQualification, replayMiningSeekerEnrollmentQualification,
 type MiningSeekerEnrollmentQualificationEvidence, type SeekerMiningEnrollmentWiring, type SeekerMiningEnrollmentReader } from '../src/mining/seekerEnrollmentQualification';
import { replayMiningSeekerQualification } from '../src/mining/seekerMiningQualification';
import type { Db } from '../src/db/client';
import { withSeekerMiningEnrollmentFixture } from './fixtures/seekerMiningEnrollment';
import { createSeekerEnrollmentArchives } from './fixtures/seekerEnrollmentQualification';

const { createTransferCheckedInstruction, TOKEN_2022_PROGRAM_ID } = createRequire(new URL('../../../packages/chain/package.json', import.meta.url))('@solana/spl-token') as {
 createTransferCheckedInstruction: (source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, decimals: number, signers: never[], program: PublicKey) => TransactionInstruction;
 TOKEN_2022_PROGRAM_ID: PublicKey;
};

type DbFixture = Parameters<Parameters<typeof withSeekerMiningEnrollmentFixture>[0]>[0];
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly unknown[] ? Mutable<T[K][number]>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
type Editable = Mutable<MiningSeekerEnrollmentQualificationEvidence> & { bonusBps?: number };
async function fixture(run: (f: DbFixture & ReturnType<typeof createSeekerEnrollmentArchives> & {
 capture: (day?: string, signal?: AbortSignal) => Promise<MiningSeekerEnrollmentQualificationEvidence> }) => Promise<void>, preCoverageBirth = false) {
 await withSeekerMiningEnrollmentFixture(async f => {
  const identity = seekerMintBirthFixture().input;
  await f.clock('2020-01-01T12:00:00Z'); await f.link(f.wallet, identity.mint, identity.linkedWallet);
  await f.clock('2020-01-01T13:00:00Z'); await captureMiningSeekerEnrollment(f.conn.db, f.wallet);
  const challenge = await readMiningSeekerEnrollmentChallenge(f.conn.db, { wallet: f.wallet });
  const sources = createSeekerEnrollmentArchives(challenge.enrollment); await f.close();
  await run({ ...f, ...sources, capture: (day = f.request.day, signal) => captureMiningSeekerEnrollmentQualification(f.conn.db, sources.wiring, { wallet: f.wallet, day }, signal) });
 }, preCoverageBirth ? { preCoverageBirth: true, birthAt: '2019-12-31T12:00:00Z' } : {});
}

describe('old SGT prospective enrollment qualification', () => {
 it('admits the first full tracked day with the original +10%, preserving providerless replay and refusing a v1 downgrade', () => fixture(async f => {
  const evidence = await f.capture(), replay = replayMiningSeekerEnrollmentQualification(evidence);
  expect(replay).toMatchObject({ wallet: f.wallet, day: f.request.day, seekerWallet: f.input.linkedWallet,
   sgtMint: f.input.mint, tokenAccount: f.input.tokenAccount, bonusBps: P.mining.seekerBonusBps });
  expect(evidence.version).toBe(2);
  expect(f.archives.every(a => a.birth.blockTime! * 1000 < Date.parse(evidence.interval.enrollment.coverageStartedAt))).toBe(true);
  expect(evidence.interval).toMatchObject({ historicalChainOwnership: 'unknown', uniqueMintSinceCoverage: true, bonusAuthorized: false, eligibilityAuthorized: false });
  expect(Object.isFrozen(evidence)).toBe(true); expect(Object.isFrozen(evidence.interval.enrollment)).toBe(true); expect(Object.isFrozen(evidence.providers)).toBe(true);
  expect(() => replayMiningSeekerQualification(evidence)).toThrow();
  expect(() => replayMiningSeekerQualification({ ...evidence, version: 1 })).toThrow();
  await f.conn.sql`update seeker_links set revoked_at=now() where wallet=${f.wallet}`;
  for (const source of f.archives) source.reader.getGenesisHash.mockRejectedValue(Error('archive offline'));
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  expect(replayMiningSeekerEnrollmentQualification(JSON.parse(JSON.stringify(evidence)))).toEqual(replay);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }), 30_000);

 it('accepts an older player only as a prospective enrollment snapshot, never a fabricated post-coverage birth', () => fixture(async f => {
  const evidence = await f.capture();
  expect(evidence.interval.enrollment.player.created_at < evidence.interval.enrollment.coverageStartedAt).toBe(true);
  expect(evidence.interval.events.filter(event => event.sourceTable === 'players')).toEqual([]);
  expect(replayMiningSeekerEnrollmentQualification(evidence).bonusBps).toBe(P.mining.seekerBonusBps);
 }, true), 30_000);

 it('refuses the enrollment day, shifts a delayed witness to the following full day, and refuses a pre-enrollment witness', () => fixture(async f => {
  await expect(f.capture('2020-01-01')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  for (const witness of f.witnesses) witness.transaction.blockTime = Date.parse('2020-01-02T00:00:00Z') / 1000;
  await expect(f.capture('2020-01-02')).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  expect(replayMiningSeekerEnrollmentQualification(await f.capture('2020-01-03')).day).toBe('2020-01-03');
  for (const witness of f.witnesses) witness.transaction.blockTime = Date.parse('2020-01-01T12:59:59Z') / 1000;
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
 }), 30_000);

 it('rejects retargeted authority, enrollment nonce/domain and a witness causally newer than the held account bank', () => fixture(async f => {
  const original = await f.capture();
  const changes: [string, (value: Editable) => void][] = [
   ['invented bonus', value => { value.bonusBps = P.mining.seekerBonusBps; }],
   ['foreign actor', value => { value.wallet = f.buyer; }],
   ['wrong earning day', value => { value.day = '2020-01-03'; }],
   ['foreign enrollment ID', value => { value.interval.enrollmentId = '00000000-0000-4000-8000-000000000000'; }],
   ['retargeted nonce', value => { value.interval.enrollment.nonce = 'a1'.repeat(32); }],
   ['duplicate archives', value => { value.providers[1]!.id = value.providers[0]!.id.toUpperCase(); }],
   ['rewritten link', value => { value.interval.link.seekerWallet = f.buyer; }],
   ['zero token holding', value => { const t = JSON.parse(value.providers[0]!.evidenceJson); const bytes = Buffer.from(t.accounts[1].data, 'base64'); bytes.writeBigUInt64LE(0n, 64); t.accounts[1].data = bytes.toString('base64'); value.providers[0]!.evidenceJson = JSON.stringify(t); }],
  ];
  for (const [reason, change] of changes) { const changed = JSON.parse(JSON.stringify(original)) as Editable; change(changed); expect(() => replayMiningSeekerEnrollmentQualification(changed), reason).toThrow(); }
  const coverage = seekerCoverageFixture(original.interval.enrollment.nonce), oldWitness = await coverage.read();
  const wrongDomain = JSON.parse(JSON.stringify(original)) as Editable;
  wrongDomain.enrollmentSignature = coverage.input.signature;
  for (const provider of wrongDomain.providers) provider.enrollmentEvidenceJson = oldWitness.evidenceJson;
  expect(() => replayMiningSeekerEnrollmentQualification(wrongDomain)).toThrow();
  const future = JSON.parse(JSON.stringify(original)) as Editable;
  for (const provider of future.providers) {
   const t = JSON.parse(provider.enrollmentEvidenceJson);
   t.transaction.slot = 31; t.status.slot = 31; t.block.slot = 31;
   t.finalizedBefore = 31; t.finalizedAfter = 31; t.status.contextSlot = 31;
   provider.enrollmentEvidenceJson = JSON.stringify(t);
   expect(replayMiningSeekerEnrollmentEvidence(provider.enrollmentEvidenceJson, { nonceHex: future.interval.enrollment.nonce, signature: future.enrollmentSignature }).slot).toBe(31);
   expect(JSON.parse(provider.evidenceJson).bank).toBe(30);
  }
  expect(() => replayMiningSeekerEnrollmentQualification(future)).toThrow(/SOURCE_CONFLICT/);
 }), 30_000);

 it('holds publication on unavailable, pruned, unauthentic or disagreeing archives and an in-day out-and-back', () => fixture(async f => {
  const [, b] = f.archives, originalGet = b.reader.getTransaction.getMockImplementation()!, originalIndex = b.reader.getSignaturesForAddress.getMockImplementation()!;
  b.reader.getGenesisHash.mockResolvedValueOnce(f.buyer); await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  b.reader.getTransaction.mockImplementation(async (signature: string) => signature === b.creation.transaction.signatures[0] ? null : originalGet(signature));
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); b.reader.getTransaction.mockImplementation(originalGet);
  b.reader.getSignaturesForAddress.mockResolvedValue([]);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); b.reader.getSignaturesForAddress.mockImplementation(originalIndex);
  const oldAuthority = Buffer.from(b.accounts[0]!.data.subarray(4, 36));
  new PublicKey(f.buyer).toBuffer().copy(b.accounts[0]!.data, 4);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); oldAuthority.copy(b.accounts[0]!.data, 4);
  b.accounts[0]!.data.writeBigUInt64LE(2n, 302);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' }); b.accounts[0]!.data.writeBigUInt64LE(1n, 302);
  const movement = tx([
   createTransferCheckedInstruction(b.tokenAccount, mint, other, chainWallet, 1n, 0, [], TOKEN_2022_PROGRAM_ID),
   createTransferCheckedInstruction(other, mint, b.tokenAccount, other, 1n, 0, [], TOKEN_2022_PROGRAM_ID),
  ], 25);
  movement.blockTime = Date.parse('2020-01-02T12:00:00Z') / 1000; b.txs.push(movement);
  expect(b.accounts[1]!.data.readBigUInt64LE(64)).toBe(1n);
  await expect(f.capture()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }), 30_000);

 it('refuses disguised duplicate transports and aborts both composed providers', () => fixture(async f => {
  const request = { wallet: f.wallet, day: f.request.day };
  const duplicate: SeekerMiningEnrollmentWiring = { ...f.wiring, providers: [f.wiring.providers[0], { id: 'different-label', connect: f.wiring.providers[0].connect }] };
  await expect(captureMiningSeekerEnrollmentQualification(f.conn.db, duplicate, request)).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }), signals: AbortSignal[] = [];
  const wiring: SeekerMiningEnrollmentWiring = { ...f.wiring, providers: [0, 1].map(i => ({ id: `archive-${i}`, connect: (signal: AbortSignal) => {
   signals.push(signal); const reader = f.archives[i]!.reader;
   reader.getGenesisHash.mockImplementation(() => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }); if (signals.length === 2) ready(); }));
   return reader as unknown as SeekerMiningEnrollmentReader;
  } })) as unknown as SeekerMiningEnrollmentWiring['providers'] };
  const controller = new AbortController(), pending = captureMiningSeekerEnrollmentQualification(f.conn.db, wiring, request, controller.signal);
  await started; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'ABORTED' }); expect(signals.every(signal => signal.aborted)).toBe(true);
 }), 30_000);

 it('refuses extra request authority and repeated archive aliases before DB/RPC work', async () => {
  const source = seekerMintBirthFixture(), connect = vi.fn(() => source.reader as unknown as SeekerMiningEnrollmentReader);
  const wiring = { enrollmentId: '00000000-0000-4000-8000-000000000000', enrollmentSignature: seekerCoverageFixture().input.signature,
   providers: [{ id: 'same', connect }, { id: 'SAME', connect }] as const };
  await expect(captureMiningSeekerEnrollmentQualification({} as Db, wiring, { wallet: source.input.linkedWallet, day: '2020-01-02' })).rejects.toMatchObject({ code: 'PROVIDER_CONFIGURATION' });
  await expect(captureMiningSeekerEnrollmentQualification({} as Db, wiring, { wallet: source.input.linkedWallet, day: '2020-01-02', bonusBps: P.mining.seekerBonusBps } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(connect).not.toHaveBeenCalled();
 });
});
