// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IDBFactory } from 'fake-indexeddb';
import { PublicKey, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MiningTaxClaimPreparationSchema } from '@shardkeep/shared/miningTaxClaimsApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { MiningTaxClaimJournalStore } from './journal';
import { miningTaxClaimIdentity } from './browser';
import { prepareMiningTaxClaimOriginal, savedMiningTaxClaimOriginal, failedMiningTaxClaimOriginal, reviewMiningTaxClaimOriginal, submitMiningTaxClaimOriginal } from './transport';
import { useMiningTaxClaims } from './useMiningTaxClaims';

const wallet = vi.hoisted(() => ({ publicKey: null as PublicKey | null, signTransaction: vi.fn() }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => wallet }));
vi.mock('./transport', () => ({ prepareMiningTaxClaimOriginal: vi.fn(), savedMiningTaxClaimOriginal: vi.fn(), failedMiningTaxClaimOriginal: vi.fn(), reviewMiningTaxClaimOriginal: vi.fn(), submitMiningTaxClaimOriginal: vi.fn() }));
const p = MiningTaxClaimPreparationSchema.parse(fixtures.combined.preparation);
const trust = { genesisHash: p.identity.genesisHash, programId: p.identity.programId, configAddress: p.identity.configAddress, keepMint: p.identity.keepMint,
 reserveOwner: p.identity.reserveOwner, reviewedDeploymentSlot: p.source.reviewedDeploymentSlot, reviewedProgramDataSha256: p.source.reviewedProgramDataSha256 };
let live: ReturnType<typeof useMiningTaxClaims>, root: Root, host: HTMLDivElement;
function Harness({ enabled = true, pins = true, recovery = true }: { enabled?: boolean; pins?: boolean; recovery?: boolean }) {
 live = useMiningTaxClaims(enabled, pins ? trust : null, recovery ? trust : null); return <p>{live.state.error}</p>;
}
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); check(); });
const store = () => new MiningTaxClaimJournalStore(miningTaxClaimIdentity(p.wallet), trust);
async function seed() {
 const s = store(); let row = await s.compareAndSet(0, old => ({ ...old, operation: { request: { idempotencyKey: p.idempotencyKey, round: p.round, spot: p.spot, caps: p.caps }, prepareAttempted: false, preparation: null, transactions: [], observed: [], unattributedObserved: false, setup: null, settlement: null } }));
 row = await s.compareAndSet(row.revision, old => ({ ...old, operation: { ...old.operation!, prepareAttempted: true } }));
 await s.compareAndSet(row.revision, old => ({ ...old, operation: { ...old.operation!, preparation: p } })); await s.close();
}
beforeEach(() => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
 Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
 Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, run: (lock: object) => unknown) => run({}) } });
 vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
 wallet.publicKey = new PublicKey(p.wallet); wallet.signTransaction.mockReset();
 useApp.getState().setAuth(p.wallet, true); useApp.getState().setScreen('bases');
 vi.mocked(prepareMiningTaxClaimOriginal).mockReset(); vi.mocked(reviewMiningTaxClaimOriginal).mockReset(); vi.mocked(submitMiningTaxClaimOriginal).mockReset();
 vi.mocked(savedMiningTaxClaimOriginal).mockReset().mockImplementation(async input => { const value = { ...fixtures.combined, status: 'prepared', wires: [], settlement: null }; await input.retain(value); input.isCurrent(); return value; });
 vi.mocked(failedMiningTaxClaimOriginal).mockReset().mockImplementation(async input => {const value={recovery:{...fixtures.combined,status:'prepared',wires:[],settlement:null},failures:[]};await input.retain(value);input.isCurrent();return value;});
 host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it('StrictMode, focus and resume perform only original GET recovery and never automatic effects', async () => {
 await seed(); await act(async () => root.render(<StrictMode><Harness /></StrictMode>));
 await until(() => { expect(live.state.loaded).toBe(true); expect(live.state.busy).toBe(false); });
 await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(live.state.busy).toBe(false));
 expect(savedMiningTaxClaimOriginal).toHaveBeenCalled(); expect(prepareMiningTaxClaimOriginal).not.toHaveBeenCalled(); expect(wallet.signTransaction).not.toHaveBeenCalled(); expect(submitMiningTaxClaimOriginal).not.toHaveBeenCalled();
});
it('uses independent historical pins for paused providerless recovery and holds safely when every pin is absent', async () => {
 await seed(); wallet.publicKey = null;
 await act(async () => root.render(<Harness enabled={false} pins={false} />));
 await until(() => expect(live.state.journal?.operation?.preparation).toEqual(p)); expect(live.actionsAllowed).toBe(false);
 await act(async () => root.render(<Harness enabled={false} pins={false} recovery={false} />));
 await until(() => expect(host.textContent).toContain('Independent deployment pins are unavailable'));
 expect(live.state.settlementHeld).toBe(true); const s = store(); expect((await s.read()).operation?.preparation).toEqual(p); await s.close();
});
it('keeps original storage alive until an already received recovery response drains after unmount', async () => {
 await seed(); let release!: () => void; const wait = new Promise<void>(r => { release = r; });
 vi.mocked(savedMiningTaxClaimOriginal).mockImplementationOnce(async input => { await wait; const value = { ...fixtures.combined, status: 'prepared', wires: [], settlement: null }; await input.retain(value); input.isCurrent(); return value; });
 const close = vi.spyOn(MiningTaxClaimJournalStore.prototype, 'close');
 await act(async () => root.render(<Harness />)); await until(() => expect(savedMiningTaxClaimOriginal).toHaveBeenCalledOnce());
 await act(async () => root.render(null)); expect(close).not.toHaveBeenCalled();
 await act(async () => release()); await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
 expect(submitMiningTaxClaimOriginal).not.toHaveBeenCalled();
});
it('retains a valid late wallet signature through unmount without submitting or reopening approval', async () => {
 await seed();
 const tx = p.transactions[0]!;
 vi.mocked(reviewMiningTaxClaimOriginal).mockResolvedValue({ wallet: p.wallet, idempotencyKey: p.idempotencyKey, ordinal: 0, status: 'ready', serverNow: p.preparedAt, review: {
  wallet: p.wallet, idempotencyKey: p.idempotencyKey, claimId: p.claimId, ordinal: 0, status: 'ready', messageSha256: tx.messageSha256, blockhash: p.blockhash,
  preparedAt: p.preparedAt, expiresAt: p.expiresAt, observedAt: p.preparedAt, feeLamports: tx.feeLamports, rentLamports: tx.rentLamports,
  totalLamports: p.fees.totalLamports, paidFeeLamports: '0', paidRentLamports: '0', source: { genesisHash: p.source.genesisHash, programId: p.source.programId,
   reviewedDeploymentSlot: p.source.reviewedDeploymentSlot, reviewedProgramDataSha256: p.source.reviewedProgramDataSha256, snapshotSlot: p.source.snapshotSlot,
   feeSlot: p.source.snapshotSlot, blockHeight: p.blockHeight, lastValidBlockHeight: p.lastValidBlockHeight }, currentSigningAuthorized: false, relayAuthorized: false, settlementAuthorized: false,
 } });
 let release!: () => void;
 wallet.signTransaction.mockImplementation(() => new Promise(resolve => { release = () => resolve(Transaction.from(Buffer.from(fixtures.combined.wires[0]!.signedTransactionHex, 'hex'))); }));
 await act(async () => root.render(<Harness />)); await until(() => expect(live.state.busy).toBe(false));
 await act(async () => live.run(c => c.review())); await until(() => expect(live.state.review).not.toBeNull());
 await act(async () => live.run(c => c.sign())); await until(() => expect(wallet.signTransaction).toHaveBeenCalledOnce());
 await act(async () => root.render(null)); await act(async () => release());
 await vi.waitFor(async () => { const s = store(); try { expect((await s.read()).operation?.transactions[0]?.signed?.signature).toBe(fixtures.combined.wires[0]!.signature); } finally { await s.close(); } });
 expect(submitMiningTaxClaimOriginal).not.toHaveBeenCalled(); expect(wallet.signTransaction).toHaveBeenCalledOnce();
});
it('queues one recovery refresh after a hidden-page read drains and clears the busy indicator', async () => {
 await seed(); let release!: () => void; const wait = new Promise<void>(r => { release = r; });
 const original = vi.mocked(savedMiningTaxClaimOriginal).getMockImplementation()!;
 vi.mocked(savedMiningTaxClaimOriginal).mockImplementationOnce(async input => { await wait; return original(input); });
 await act(async () => root.render(<Harness />)); await until(() => expect(savedMiningTaxClaimOriginal).toHaveBeenCalledOnce());
 await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
 await act(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
 await act(async () => release()); await until(() => { expect(vi.mocked(savedMiningTaxClaimOriginal).mock.calls.length).toBeGreaterThan(1); expect(live.state.busy).toBe(false); });
 expect(wallet.signTransaction).not.toHaveBeenCalled(); expect(submitMiningTaxClaimOriginal).not.toHaveBeenCalled();
});
