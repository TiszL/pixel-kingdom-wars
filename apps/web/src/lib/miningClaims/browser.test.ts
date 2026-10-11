/** @vitest-environment happy-dom */
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { Keypair, Transaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { api } from '../api';
import { mutationGate } from '../mutationGate';
import { createMiningClaimBrowserPorts, miningClaimIdentity } from './browser';
import { miningClaimFixture } from './fixtures.test-support';
import { verifySignedMiningClaim } from './signing';
import { claimMiningOriginal, prepareMiningClaimOriginal, submitMiningOriginal } from './transport';

vi.mock('./transport', () => ({ claimMiningOriginal: vi.fn(), prepareMiningClaimOriginal: vi.fn(), submitMiningOriginal: vi.fn() }));
vi.mock('../mutationGate', () => ({ mutationGate: { getSnapshot: vi.fn(() => true) } }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; };
beforeEach(() => {
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  vi.spyOn(authCookies, 'current').mockReturnValue(true); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true);
  vi.mocked(prepareMiningClaimOriginal).mockReset(); vi.mocked(claimMiningOriginal).mockReset(); vi.mocked(submitMiningOriginal).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });
function setup(trusted = true) {
  const f = miningClaimFixture(), page = { active: true, visible: true, epoch: 0, actionsEnabled: true }, identity = miningClaimIdentity(f.preparation.wallet);
  useApp.getState().setAuth(identity.wallet, true);
  const rpc = { getGenesisHash: vi.fn(async () => f.trust.genesisHash), getBlockHeight: vi.fn(async () => 100) };
  const signer: GameWallet = { publicKey: f.signer.publicKey, signMessage: null, isEmbedded: false, sendTransaction: vi.fn(),
    signTransaction: vi.fn(async (tx: Transaction) => { tx.partialSign(f.signer); return tx; }) };
  let currentWallet = signer;
  const trust = trusted ? { ...f.trust } : null;
  const ports = createMiningClaimBrowserPorts({ identity, connection: rpc, trust, wallet: () => currentWallet, lifecycle: () => page });
  return { ...f, page, identity, rpc, signer, trust, ports, changeWallet(next: GameWallet) { currentWallet = next; } };
}
describe('mining claim browser ports', () => {
  it('pins origin/API/network/session and ignores base selection for wallet-owned recovery', () => {
    const f = setup(), guard = f.ports.capture(false);
    useApp.getState().setSelectedBaseId(crypto.randomUUID(), false); useApp.getState().setSelectedBaseId(null, false); expect(guard).not.toThrow();
    const foreign = createMiningClaimBrowserPorts({ identity: { ...f.identity, api: 'https://other.example/api' }, connection: f.rpc, trust: f.trust, wallet: () => f.signer, lifecycle: () => f.page });
    expect(() => foreign.capture(false)).toThrow(/origin|server|network/);
    vi.mocked(authCookies.current).mockReturnValue(false); expect(guard).toThrow();
    vi.mocked(authCookies.current).mockReturnValue(true); useApp.setState({ wallet: Keypair.generate().publicKey.toBase58() }); expect(guard).toThrow();
  });
  it('freezes cookie revision and view epoch, including account/view ABA', () => {
    const f = setup(), guard = f.ports.capture(false);
    f.page.epoch++; f.page.epoch++; expect(guard).toThrow();
    const g = setup(), original = g.ports.capture(false);
    vi.mocked(authCookies.assertResponse).mockImplementation(() => { throw Error('retired session revision'); }); expect(original).toThrow(/retired session/);
  });
  it('new actions require the exact captured sign-only provider, visible view and mutation gate while recovery remains readable', () => {
    const f = setup(), action = f.ports.capture(true), historical = f.ports.capture(false);
    f.changeWallet({ ...f.signer, signTransaction: async tx => tx }); expect(action).toThrow(); expect(historical).not.toThrow();
    f.changeWallet(f.signer); f.page.actionsEnabled = false; expect(action).toThrow(); expect(historical).not.toThrow();
    f.page.actionsEnabled = true; vi.mocked(mutationGate.getSnapshot).mockReturnValue(false); expect(action).toThrow(); expect(historical).not.toThrow();
    f.page.visible = false; expect(historical).toThrow();
  });
  it('keeps GET recovery available with default-null deployment trust and never opens a wallet', async () => {
    const f = setup(false), guard = f.ports.capture(false), retain = vi.fn(async () => undefined);
    await f.ports.getPreparation({ idempotencyKey: f.preparation.idempotencyKey }, guard, retain);
    await f.ports.getClaim(f.preparation.claimId, guard, retain);
    expect(() => f.ports.capture(true)).toThrow(/trust|deployment/i);
    await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(/trust|deployment/i);
    await expect(f.ports.sign(f.preparation, guard)).rejects.toThrow(/trust|deployment/i);
    expect(f.signer.signTransaction).not.toHaveBeenCalled(); expect(f.rpc.getGenesisHash).not.toHaveBeenCalled();
  });
  it('copies all independent trust pins and checks finalized genesis and height without signing', async () => {
    const f = setup(), guard = f.ports.capture(true); f.trust!.programId = Keypair.generate().publicKey.toBase58();
    await f.ports.live(f.preparation, guard);
    expect(f.rpc.getBlockHeight).toHaveBeenCalledExactlyOnceWith('finalized'); expect(f.signer.signTransaction).not.toHaveBeenCalled();
    expect(f.signer.sendTransaction).not.toHaveBeenCalled();
    f.preparation.identity.keepMint = Keypair.generate().publicKey.toBase58();
    await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(/TRUST/); expect(f.rpc.getGenesisHash).toHaveBeenCalledTimes(1);
  });
  it('refuses network/height contradictions, expiry and retirement between reads before signing', async () => {
    const f = setup(), guard = f.ports.capture(true);
    f.rpc.getGenesisHash.mockResolvedValue(Keypair.generate().publicKey.toBase58());
    await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(/network/i); expect(f.rpc.getBlockHeight).not.toHaveBeenCalled();
    f.rpc.getGenesisHash.mockResolvedValue(f.preparation.identity.genesisHash);
    for (const height of [251, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) { f.rpc.getBlockHeight.mockResolvedValue(height); await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(/height|expired/i); }
    f.rpc.getGenesisHash.mockImplementation(async () => { f.page.visible = false; return f.preparation.identity.genesisHash; });
    const previous = f.rpc.getBlockHeight.mock.calls.length;
    await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(); expect(f.rpc.getBlockHeight).toHaveBeenCalledTimes(previous);
  });
  it('times out a hanging RPC, forbids overlapping retries until it drains, and discards the late answer', async () => {
    vi.useFakeTimers(); const f = setup(), gate = deferred<string>(), guard = f.ports.capture(true);
    f.rpc.getGenesisHash.mockReturnValueOnce(gate.promise);
    const work = f.ports.live(f.preparation, guard), failure = expect(work).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs); await failure;
    await expect(f.ports.live(f.preparation, guard)).rejects.toThrow(/pending/i); expect(f.rpc.getGenesisHash).toHaveBeenCalledTimes(1);
    gate.resolve(f.preparation.identity.genesisHash); await vi.advanceTimersByTimeAsync(0);
    expect(f.rpc.getBlockHeight).not.toHaveBeenCalled(); await f.ports.live(f.preparation, guard); expect(f.rpc.getGenesisHash).toHaveBeenCalledTimes(2);
  });
  it('status GET has a deadline and a session-bound response without using any original mutation transport', async () => {
    vi.useFakeTimers(); const f = setup(), gate = deferred<never>(), guard = f.ports.capture(false);
    const get = vi.spyOn(api, 'get').mockReturnValueOnce(gate.promise).mockResolvedValue(f.status() as never);
    const work = f.ports.getStatus(guard), failed = expect(work).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs); await failed;
    expect(get.mock.calls[0]?.[0]).toBe('/claims/mining/status'); expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(f.ports.getStatus(guard)).rejects.toThrow(/pending/i);
    gate.resolve(f.status() as never); await vi.advanceTimersByTimeAsync(0);
    await expect(f.ports.getStatus(guard)).resolves.toEqual(f.status());
    expect(prepareMiningClaimOriginal).not.toHaveBeenCalled(); expect(submitMiningOriginal).not.toHaveBeenCalled();
    f.page.epoch++; expect(get.mock.calls.at(-1)?.[1]?.isCurrent).toThrow();
  });
  it('delegates exact original methods and awaited retention/refusal callbacks without a view cancellation wrapper', async () => {
    const f = setup(), guard = f.ports.capture(true), retain = vi.fn(async () => undefined), refusal = vi.fn(async () => undefined);
    const request = { idempotencyKey: f.preparation.idempotencyKey };
    await f.ports.prepare(request, guard, retain, refusal); await f.ports.getPreparation(request, guard, retain); await f.ports.getClaim(f.preparation.claimId, guard, retain);
    const signed = f.signed(), submit = { claimId: f.preparation.claimId, signedTransaction: signed.wire }; await f.ports.submit(submit, guard);
    expect(vi.mocked(prepareMiningClaimOriginal).mock.calls.map(([x]) => [x.method, x.request, x.retain])).toEqual([['POST', request, retain], ['GET', request, retain]]);
    expect(vi.mocked(prepareMiningClaimOriginal).mock.calls[0]![0].refusal).toBe(refusal);
    expect(vi.mocked(claimMiningOriginal).mock.calls[0]![0]).toMatchObject({ claimId: f.preparation.claimId, retain });
    expect(vi.mocked(submitMiningOriginal).mock.calls[0]![0].request).toBe(submit);
    const original = vi.mocked(prepareMiningClaimOriginal).mock.calls[0]![0]; expect(original.isCurrent()).toBe(true);
    f.page.visible = false; await original.retain(f.preparation); await original.refusal!({ status: 503, code: 'PHASE_E_DISABLED' });
    expect(retain).toHaveBeenCalledOnce(); expect(refusal).toHaveBeenCalledOnce(); expect(original.isCurrent).toThrow();
  });
  it('uses the real sign-only boundary and retains a valid late signature after logout/view retirement without broadcasting', async () => {
    const f = setup(), guard = f.ports.capture(true), original = structuredClone(f.preparation);
    // The fixture's generated keypair is distinct from the GameWallet facade.
    const captured = f.signer.signTransaction;
    f.changeWallet({ ...f.signer, signTransaction: async tx => tx });
    await expect(f.ports.sign(f.preparation, guard)).rejects.toThrow(); expect(captured).not.toHaveBeenCalled();
    f.changeWallet(f.signer);
    vi.mocked(f.signer.signTransaction!).mockImplementation(async tx => {
      const signed = Transaction.from(Buffer.from(f.signed().wire, 'base64'));
      useApp.setState({ wallet: null, authed: false }); f.page.visible = false; f.page.epoch++; return signed;
    });
    const result = await f.ports.sign(f.preparation, guard);
    expect(verifySignedMiningClaim(original, result.wire)).toEqual(result); expect(f.signer.sendTransaction).not.toHaveBeenCalled();
  });
});
