/** @vitest-environment happy-dom */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeepMarketController, type KeepMarketPorts } from './controller';
import { KeepMarketJournalStore, marketKey } from './journal';
import { keepMarketReleasedFixture } from './fixtures.testHelpers';
import { createKeepMarketBrowserPorts } from './browser';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
vi.mock('./current', () => ({ createKeepEquipmentCurrentChecks: () => async () => undefined }));
// The production gate is frozen. Mock its reader at the module boundary,
// retaining a frozen export rather than trying to redefine its property.
vi.mock('../mutationGate',()=>({mutationGate:Object.freeze({getSnapshot:vi.fn(()=>true)})}));
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session-1'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined); vi.spyOn(authCookies, 'captureGeneration').mockReturnValue(1); vi.spyOn(authCookies, 'current').mockReturnValue(true); vi.mocked(mutationGate.getSnapshot).mockReturnValue(true); });
afterEach(() => { useApp.getState().setAuth(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('saved-wire delivery requests its own guard so history need not grant new orders', async () => {
  const f = keepMarketReleasedFixture();
  const identity = { origin: 'http://localhost', api: 'http://localhost/api', cluster: 'devnet' as const, wallet: f.signed.fill.buyerWallet };
  const store = new KeepMarketJournalStore(identity, new IDBFactory());
  const command = { kind: 'fill' as const, key: f.signed.fill.id, request: null };
  const capture = vi.fn<KeepMarketPorts['capture']>(() => () => undefined);
  const ports: KeepMarketPorts = { capture, key: () => crypto.randomUUID(), lock: async (_key, run) => run(),
    request: async (_request, _guard, retain) => { await retain(f.released); return f.released; },
    review: async () => { throw Error('no review for released original'); }, sign: async () => { throw Error('history must never sign'); } };
  try {
    await store.begin(command); await store.retain(marketKey(command), f.signed);
    const controller = new KeepMarketController(store, ports); controller.select(marketKey(command)); await controller.deliver();
    expect(capture).toHaveBeenCalledWith(true, undefined, 'saved-delivery');
    expect((await store.read()).pending[0]!.original).toEqual(f.released);
  } finally { await store.close(); }
});
it('saved-delivery guard is denied for new-order capture and still respects the global mutation pause', async () => {
  const f = keepMarketReleasedFixture(); useApp.getState().setAuth(f.buyer.publicKey.toBase58(), true);
  // Read the actual browser scope instead of fabricating origin/API identity.
  const { browserKeepMarketIdentity } = await import('./browser');
  const page = { active: true, visible: true, epoch: 0, actionsEnabled: false, recoveryEnabled: true };
  const ports = createKeepMarketBrowserPorts({ identity: browserKeepMarketIdentity(f.buyer.publicKey.toBase58()), trust: null, wallet: () => f.signer as never, connection: {} as never, lifecycle: () => page });
  expect(() => ports.capture(true)).toThrow();
  expect(() => ports.capture(true, undefined, 'saved-delivery')).not.toThrow();
  const savedGuard=ports.capture(true,undefined,'saved-delivery');expect(savedGuard).not.toThrow();
  vi.mocked(mutationGate.getSnapshot).mockReturnValue(false);
  expect(savedGuard).toThrow();
  expect(() => ports.capture(true, undefined, 'saved-delivery')).toThrow();
});
