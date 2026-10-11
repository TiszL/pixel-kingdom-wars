/** @vitest-environment happy-dom */
import { PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MiningTaxClaimPreparationSchema } from '@shardkeep/shared/miningTaxClaimsApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { prepareMiningTaxClaimSigning, verifySignedMiningTaxClaim } from './signing';
import { createMiningTaxClaimBrowserPorts, miningTaxClaimIdentity } from './browser';
import { MiningTaxClaimController } from './controller';
import { MiningTaxClaimJournalStore } from './journal';
import { prepareMiningTaxClaimOriginal, savedMiningTaxClaimOriginal, failedMiningTaxClaimOriginal, prepareMiningTaxClaimContinuation, savedMiningTaxClaimContinuation, reviewMiningTaxClaimOriginal, submitMiningTaxClaimOriginal } from './transport';

vi.mock('./transport', () => ({ prepareMiningTaxClaimOriginal: vi.fn(), savedMiningTaxClaimOriginal: vi.fn(), failedMiningTaxClaimOriginal: vi.fn(), prepareMiningTaxClaimContinuation: vi.fn(), savedMiningTaxClaimContinuation: vi.fn(), reviewMiningTaxClaimOriginal: vi.fn(), submitMiningTaxClaimOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true) } }));
beforeEach(() => {
 vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
 vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
 vi.spyOn(authCookies, 'current').mockReturnValue(true);
 vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);
 for (const fn of [prepareMiningTaxClaimOriginal, savedMiningTaxClaimOriginal, failedMiningTaxClaimOriginal, prepareMiningTaxClaimContinuation, savedMiningTaxClaimContinuation, reviewMiningTaxClaimOriginal, submitMiningTaxClaimOriginal]) vi.mocked(fn).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });

function setup(trusted = true) {
 const p = MiningTaxClaimPreparationSchema.parse(structuredClone(fixtures.combined.preparation));
 const trust = { genesisHash: p.identity.genesisHash, programId: p.identity.programId, configAddress: p.identity.configAddress, keepMint: p.identity.keepMint,
  reserveOwner: p.identity.reserveOwner, reviewedDeploymentSlot: p.source.reviewedDeploymentSlot, reviewedProgramDataSha256: p.source.reviewedProgramDataSha256 };
 const identity = miningTaxClaimIdentity(p.wallet), page = { active: true, visible: true, epoch: 0, actionsEnabled: true };
 useApp.getState().setAuth(p.wallet, true);
 const wire = Buffer.from(fixtures.combined.wires[0]!.signedTransactionHex, 'hex').toString('base64');
 const signer: GameWallet = { publicKey: new PublicKey(p.wallet), signMessage: null, isEmbedded: false, sendTransaction: vi.fn(), signTransaction: vi.fn(async () => Transaction.from(Buffer.from(wire, 'base64'))) };
 let selected = signer, time = 0;
 const ports = createMiningTaxClaimBrowserPorts({ identity, trust: trusted ? trust : null, wallet: () => selected, lifecycle: () => page, clock: () => time });
 const request = { idempotencyKey: p.idempotencyKey, round: p.round, spot: p.spot, caps: p.caps };
 return { p, trust, identity, page, wire, signer, ports, request, changeWallet(wallet: GameWallet) { selected = wallet; }, tick(value: number) { time = value; } };
}
it('captures original actor, cookie generation and lifecycle epoch while base selection is unrelated', () => {
 const f = setup(), guard = f.ports.capture(false);
 useApp.getState().setSelectedBaseId(crypto.randomUUID(), false); useApp.getState().setSelectedBaseId(null, false); expect(guard).not.toThrow();
 f.page.epoch++; f.page.epoch++; expect(guard).toThrow();
 const g = setup(), original = g.ports.capture(false);
 vi.mocked(authCookies.current).mockReturnValue(false); expect(original).toThrow();
 vi.mocked(authCookies.current).mockReturnValue(true); useApp.setState({ wallet: g.p.identity.keepMint }); expect(original).toThrow();
});
it('keeps paused providerless recovery readable but refuses effects, replacement signers and retired pages', async () => {
 const f = setup(false), guard = f.ports.capture(false), retain = vi.fn(async () => undefined);
 f.changeWallet({ ...f.signer, publicKey: null, signTransaction: null }); f.page.actionsEnabled = false; vi.mocked(mutationGate.getSnapshot).mockReturnValue(false);
 await f.ports.getPreparation(f.request, guard, retain); await f.ports.getSaved(f.p.idempotencyKey, guard, retain);
 expect(() => f.ports.capture(true)).toThrow(/trust/);
 await expect(f.ports.prepare(f.request, guard, retain)).rejects.toThrow();
 expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(prepareMiningTaxClaimOriginal).toHaveBeenCalledOnce();
 f.page.visible = false; expect(guard).toThrow();
 const g = setup(); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true); const effect = g.ports.capture(true);
 g.changeWallet({ ...g.signer, signTransaction: async tx => tx }); expect(effect).toThrow();
});
it('copies independent deployment pins and rejects bad or foreign scope before effects', () => {
 const f = setup(); f.trust.programId = 'bad'; expect(() => f.ports.capture(true)).not.toThrow();
 const options = { identity: f.identity, trust: f.trust, wallet: () => f.signer, lifecycle: () => f.page };
 expect(() => createMiningTaxClaimBrowserPorts(options).capture(true)).toThrow(/trust/);
 const foreign = createMiningTaxClaimBrowserPorts({ ...options, identity: { ...f.identity, api: 'https://foreign.test' } });
 expect(() => foreign.capture(false)).toThrow(/origin|server|network/);
});
it('delegates exact original reads and effects with owner callbacks that survive view retirement', async () => {
 const f = setup(), guard = f.ports.capture(true), retain = vi.fn(async () => undefined);
 await f.ports.prepare(f.request, guard, retain); await f.ports.getPreparation(f.request, guard, retain);
 await f.ports.getSaved(f.p.idempotencyKey, guard, retain); await f.ports.currentReview(f.p.idempotencyKey, 0, guard);
 const signed = { idempotencyKey: f.p.idempotencyKey, signedTransaction: f.wire };
 await f.ports.submit(signed, guard, retain);
 expect(vi.mocked(prepareMiningTaxClaimOriginal).mock.calls.map(([x]) => [x.method, x.request, x.retain])).toEqual([['POST', f.request, retain], ['GET', f.request, retain]]);
 expect(savedMiningTaxClaimOriginal).toHaveBeenCalledWith(expect.objectContaining({ identity: f.identity, idempotencyKey: f.p.idempotencyKey, retain }));
 expect(reviewMiningTaxClaimOriginal).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: f.p.idempotencyKey, ordinal: 0 }));
 expect(submitMiningTaxClaimOriginal).toHaveBeenCalledWith(expect.objectContaining({ request: signed, retain }));
 const call = vi.mocked(submitMiningTaxClaimOriginal).mock.calls[0]![0]; f.page.visible = false;
 await call.retain(fixtures.combined); expect(retain).toHaveBeenCalledOnce(); expect(call.isCurrent).toThrow();
});
it('composes the controller with real submit transport without rejecting the acknowledgement’s own durable hold', async () => {
 const f = setup(), store = new MiningTaxClaimJournalStore(f.identity, f.trust, new IDBFactory());
 const controller = new MiningTaxClaimController(store, f.ports, f.trust);
 let row = await store.compareAndSet(0, saved => ({ ...saved, operation: { request: f.request, prepareAttempted: false, preparation: null, transactions: [], observed: [], unattributedObserved: false, setup: null, settlement: null } }));
 row = await store.compareAndSet(row.revision, saved => ({ ...saved, operation: { ...saved.operation!, prepareAttempted: true } }));
 row = await store.compareAndSet(row.revision, saved => ({ ...saved, operation: { ...saved.operation!, preparation: f.p } }));
 row = await store.compareAndSet(row.revision, saved => ({ ...saved, operation: { ...saved.operation!, transactions: [{ ordinal: 0, signingStarted: true, signed: null, submitAttempted: false }] } }));
 const signed = await verifySignedMiningTaxClaim(f.p, f.wire);
 await store.compareAndSet(row.revision, saved => ({ ...saved, operation: { ...saved.operation!, transactions: [{ ...saved.operation!.transactions[0]!, signed }] } }));
 vi.mocked(savedMiningTaxClaimOriginal).mockResolvedValue({ ...fixtures.combined, status: 'prepared', wires: [], settlement: null });
 vi.mocked(failedMiningTaxClaimOriginal).mockResolvedValue({ recovery:{ ...fixtures.combined, status:'prepared',wires:[],settlement:null },failures:[] });
 const p = f.p, tx = p.transactions[0]!;
 vi.mocked(reviewMiningTaxClaimOriginal).mockResolvedValue({ wallet: p.wallet, idempotencyKey: p.idempotencyKey, ordinal: 0, status: 'ready', serverNow: p.preparedAt, review: {
  wallet: p.wallet, idempotencyKey: p.idempotencyKey, claimId: p.claimId, ordinal: 0, status: 'ready', messageSha256: tx.messageSha256, blockhash: p.blockhash,
  preparedAt: p.preparedAt, expiresAt: p.expiresAt, observedAt: p.preparedAt, feeLamports: tx.feeLamports, rentLamports: tx.rentLamports,
  totalLamports: p.fees.totalLamports, paidFeeLamports: '0', paidRentLamports: '0', source: { genesisHash: p.source.genesisHash, programId: p.source.programId,
   reviewedDeploymentSlot: p.source.reviewedDeploymentSlot, reviewedProgramDataSha256: p.source.reviewedProgramDataSha256, snapshotSlot: p.source.snapshotSlot,
   feeSlot: p.source.snapshotSlot, blockHeight: p.blockHeight, lastValidBlockHeight: p.lastValidBlockHeight }, currentSigningAuthorized: false, relayAuthorized: false, settlementAuthorized: false,
 } });
 const actual = await vi.importActual<typeof import('./transport')>('./transport');
 vi.mocked(submitMiningTaxClaimOriginal).mockImplementation(actual.submitMiningTaxClaimOriginal);
 vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
 const fetch = vi.fn(async () => new Response(JSON.stringify({ wallet: p.wallet, idempotencyKey: p.idempotencyKey, claimId: p.claimId, wire: fixtures.combined.wires[0], delivery: 'submitted', serverNow: p.preparedAt }), { status: 202 }));
 vi.stubGlobal('fetch', fetch);
 await controller.submit();
 expect(controller.snapshot().error).toBeNull(); expect(fetch).toHaveBeenCalledOnce(); expect(store.settlementHeld(p.idempotencyKey, 0)).toBe(true);
 expect((await store.read()).operation!.settlement).toBeNull(); expect((await store.read()).operation!.transactions[0]!.submitAttempted).toBe(true);
 await store.close();
});
it('checks an independent effect guard even when passed a recovery guard', async () => {
 const f = setup(), guard = f.ports.capture(false), retain = async () => undefined;
 f.page.actionsEnabled = false;
 await expect(f.ports.prepare(f.request, guard, retain)).rejects.toThrow();
 await expect(f.ports.currentReview(f.p.idempotencyKey, 0, guard)).rejects.toThrow();
 await expect(f.ports.submit({ idempotencyKey: f.p.idempotencyKey, signedTransaction: f.wire }, guard, retain)).rejects.toThrow();
 expect(prepareMiningTaxClaimOriginal).not.toHaveBeenCalled(); expect(submitMiningTaxClaimOriginal).not.toHaveBeenCalled();
});
it('signs only the opaque exact packet and returns valid late bytes after logout without broadcasting', async () => {
 const f = setup(), prepared = await prepareMiningTaxClaimSigning(f.p, f.trust), guard = f.ports.capture(true);
 vi.mocked(f.signer.signTransaction!).mockImplementation(async () => {
  f.page.epoch++; f.page.visible = false; useApp.setState({ wallet: null, authed: false });
  return Transaction.from(Buffer.from(f.wire, 'base64'));
 });
 const result = await f.ports.sign(prepared, guard);
 expect(result).toEqual(await verifySignedMiningTaxClaim(f.p, f.wire)); expect(f.signer.sendTransaction).not.toHaveBeenCalled();
});
it('rejects forged capabilities and honors current admission immediately before sign-only approval', async () => {
 const f = setup(), guard = f.ports.capture(true), prepared = await prepareMiningTaxClaimSigning(f.p, f.trust);
 await expect(f.ports.sign({ ...prepared }, guard)).rejects.toThrow(); expect(f.signer.signTransaction).not.toHaveBeenCalled();
 let allowed = true; const admission = () => { guard(); if (!allowed) throw Error('consent expired'); };
 allowed = false; await expect(f.ports.sign(prepared, admission)).rejects.toThrow('consent expired');
 expect(f.signer.signTransaction).not.toHaveBeenCalled();
});
it('uses exclusive available-only original locks and refuses unavailable or busy coordination', async () => {
 const f = setup(), run = vi.fn(async () => 42), name = `pkw-mining-tax-v1:${JSON.stringify(f.identity)}`;
 vi.stubGlobal('navigator', {}); await expect(f.ports.lock(name, run)).rejects.toThrow();
 const lock = vi.fn(async (_name, _options, callback) => callback(null)); vi.stubGlobal('navigator', { locks: { request: lock } });
 await expect(f.ports.lock(name, run)).rejects.toThrow(/Another tab/); expect(run).not.toHaveBeenCalled();
 lock.mockImplementation(async (_name, _options, callback) => callback({ name }));
 expect(await f.ports.lock(name, run)).toBe(42); expect(lock).toHaveBeenLastCalledWith(name, { mode: 'exclusive', ifAvailable: true }, expect.any(Function));
});
it('rejects nonfinite or regressing monotonic review clocks', () => {
 const f = setup(); expect(f.ports.clock()).toBe(0); f.tick(10); expect(f.ports.clock()).toBe(10);
 f.tick(9); expect(() => f.ports.clock()).toThrow(/clock/); f.tick(NaN); expect(() => f.ports.clock()).toThrow(/clock/);
});

it('permits providerless continuation GET but independently guards its single POST',async()=>{
 const f=setup(),read=f.ports.capture(false),retain=vi.fn(async()=>undefined),request={idempotencyKey:crypto.randomUUID(),caps:f.p.caps};f.page.actionsEnabled=false;f.changeWallet({...f.signer,publicKey:null,signTransaction:null});await f.ports.getContinuation(f.p.idempotencyKey,read,retain);expect(savedMiningTaxClaimContinuation).toHaveBeenCalledWith(expect.objectContaining({parentIdempotencyKey:f.p.idempotencyKey,retain}));await expect(f.ports.prepareContinuation(f.p.idempotencyKey,request,read,retain)).rejects.toThrow();expect(prepareMiningTaxClaimContinuation).not.toHaveBeenCalled();
 const g=setup(),guard=g.ports.capture(true);await g.ports.prepareContinuation(g.p.idempotencyKey,request,guard,retain);expect(prepareMiningTaxClaimContinuation).toHaveBeenCalledWith(expect.objectContaining({parentIdempotencyKey:g.p.idempotencyKey,request,retain}));
});
