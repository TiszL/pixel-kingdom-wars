/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { GemsJournalStore } from '../../lib/gems/journal';
import { gemsIdentity } from '../../lib/gems/browser';
import { parseGemsIntent, type GemsIntent } from '../../lib/gems/contracts';
import { base, identity, overview, proof, envelope } from '../../lib/gems/fixtures.test-support';
import { GemsRecoveryDoor, GemsWalletScreen } from './gems';
let root: Root, host: HTMLDivElement, factory: IDBFactory, receipt: ReturnType<typeof proof> | null, savedIntent: GemsIntent | null, posted: boolean;
const balances = () => ({ keep: posted ? '90' : '100', shards: '100', keepRate: 1, gems: posted ? '120' : '100', features: { gems: { version: 1, receipts: 1 } } });
const directory = () => ({ enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: base, status: 'active', slot: 1 }] });
const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label); if (!found) throw new Error(`Missing ${label}`); return found;
};
const until = async (check: () => void) => act(async () => vi.waitFor(check));
const click = async (label: string) => act(async () => button(label).click());
const enter = async (label: string, text: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
async function mount() { await act(async () => root.render(<GemsWalletScreen />)); await until(() => expect(button('REFRESH GEMS').disabled).toBe(false)); }
const journal = async () => new GemsJournalStore(gemsIdentity(identity.wallet), factory).read();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posted = false; receipt = null; savedIntent = null; factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('navigator', { userAgent: 'Gems-test', locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('exchange'); useApp.getState().setSelectedBaseId(base, false); useApp.getState().setBalances(balances());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/gems') return { ...overview(), gems: posted ? '120' : '100' } as never;
    if (path === '/me') return { wallet: identity.wallet, entryPaid: true } as never;
    if (path === '/bases') return directory() as never;
    if (path.startsWith('/balances')) return balances() as never;
    if (path.includes('/by-key/') || path.startsWith('/gems/to-shards/receipt')) return (receipt ?? envelope(savedIntent!, null)) as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (path, body) => {
    const { expected, ...b } = body as Record<string, unknown>;
    const consent = expected === undefined ? {} : { consent: expected };
    savedIntent = parseGemsIntent(path === '/gems/from-keep' ? { kind: 'gems-from-keep', ...b, ...consent }
      : path === '/gems/to-shards' ? { kind: 'gems-to-shards', ...b, baseId: b.baseId ?? null, ...consent } : { kind: 'gems-task-claim', ...b, taskId: 'first-task', ...consent });
    expect(await journal()).toMatchObject({ intent: savedIntent, attempted: true, receipt: null });
    posted = true; receipt = proof(savedIntent); return { gems: '20' } as never;
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });

it('reviews the exact custodial currency and cancellation sends no request', async () => {
  await mount(); expect(host.textContent).not.toContain('DEPOSIT KEEP');
  await enter('KEEP amount', '10'); await click('REVIEW GET GEMS');
  await until(() => expect(host.querySelector('[aria-label="Confirm Gems operation"]')?.textContent).toContain('10 CUSTODIAL KEEP → 20 GEMS'));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm Gems operation"]'));
  await click('CANCEL'); expect(api.postRaw).not.toHaveBeenCalled(); expect((await journal()).intent).toBeNull();
});
it('receipt proof and refreshed balances precede the successful Gems message', async () => {
  await mount(); await enter('KEEP amount', '10'); await click('REVIEW GET GEMS');
  await until(() => expect(button('CONFIRM 10 KEEP').disabled).toBe(false)); await click('CONFIRM 10 KEEP');
  await until(() => expect(host.textContent).toContain('Original receipt confirmed: +20 GEMS'));
  expect(document.activeElement?.textContent).toContain('Original receipt confirmed: +20 GEMS');
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(useApp.getState().balances).toMatchObject({ keep: '90', gems: '120' });
  expect((await journal()).finished).toBe(true); expect(api.get).toHaveBeenCalledWith(`/balances?baseId=${base}`, expect.anything());
});
it('the review displays its saved output and refuses changed conversion terms', async () => {
  await mount(); await enter('KEEP amount', '10'); await click('REVIEW GET GEMS');
  await until(() => expect(button('CONFIRM 10 KEEP').disabled).toBe(false));
  const get = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, opts) => path === '/gems' ? { ...overview(), gemsPerKeep: 3 } as never : get(path, opts));
  expect(host.querySelector('[aria-label="Confirm Gems operation"]')?.textContent).toContain('10 CUSTODIAL KEEP → 20 GEMS');
  await click('CONFIRM 10 KEEP');
  await until(() => expect(host.textContent).toContain('rate or reward changed'));
  expect(api.postRaw).not.toHaveBeenCalled(); expect((await journal()).intent).toBeNull();
});
it('a lost acknowledgement shows durable recovery and remount only observes the original key', async () => {
  vi.mocked(api.postRaw).mockImplementation(async (_path, raw) => {
    const { expected, ...body } = raw as Record<string, unknown>;
    savedIntent = parseGemsIntent({ kind: 'gems-from-keep', ...body, consent: expected }); throw new Error('Response lost');
  });
  await mount(); await enter('KEEP amount', '10'); await click('REVIEW GET GEMS');
  await until(() => expect(button('CONFIRM 10 KEEP').disabled).toBe(false)); await click('CONFIRM 10 KEEP');
  // Pending is published before the attempted journal write and POST. This
  // case must reach the lost transport response before invalidating the view.
  await until(() => {
    expect(host.textContent).toContain('REQUEST OUTCOME PENDING');
    expect(api.postRaw).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response lost');
    expect(button('CHECK ORIGINAL RECEIPT').disabled).toBe(false);
  });
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(host.textContent).toContain('RETRY SAME REQUEST');
  posted = true; receipt = proof(savedIntent!); await click('CHECK ORIGINAL RECEIPT');
  await until(() => expect(host.textContent).toContain('Original receipt confirmed: +20 GEMS')); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('task already claimed in another tab ends only the definitively rejected first request', async () => {
  vi.mocked(api.postRaw).mockRejectedValue(new ApiError(409, 'Task was already claimed', 'CLAIM_ALREADY_SETTLED'));
  await mount(); await click('REVIEW CLAIM'); await until(() => expect(button('CONFIRM CLAIM').disabled).toBe(false)); await click('CONFIRM CLAIM');
  await until(() => expect(host.textContent).toContain('REQUEST DECLINED')); expect((await journal()).refusal?.code).toBe('CLAIM_ALREADY_SETTLED');
  expect(host.textContent).not.toContain('REQUEST OUTCOME PENDING');
});
it('multi-base SHARDS conversion refuses a null scope before creating a journal or POST', async () => {
  useApp.getState().setSelectedBaseId(null, false); await mount(); await enter('Gems amount', '10'); await click('REVIEW CONVERSION');
  await until(() => expect(host.textContent).toContain('Select the original base'));
  expect(api.postRaw).not.toHaveBeenCalled(); expect((await journal()).intent).toBeNull();
});

it('paused Gems still finishes an accepted original receipt and never resends it', async () => {
  const original = parseGemsIntent({ kind: 'gems-from-keep', idempotencyKey: 'paused-operation', keep: '10' });
  const store = new GemsJournalStore(gemsIdentity(identity.wallet), factory);
  await store.compareAndSet(0, saved => ({ ...saved, intent: original, attempted: true }));
  savedIntent = original; receipt = proof(original);
  const get = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, opts) => {
    if (path === '/gems') throw new ApiError(503, 'Gems are not enabled', 'PHASE_E_DISABLED');
    if (path.startsWith('/balances')) return { keep: '90', shards: '100', keepRate: 1 } as never;
    return get(path, opts);
  });
  await mount(); await until(() => expect(host.textContent).toContain('Original receipt confirmed: +20 GEMS'));
  expect((await journal()).finished).toBe(true); expect(api.postRaw).not.toHaveBeenCalled(); expect(button('REVIEW CONVERSION').disabled).toBe(true);
});
it('legacy recovery door uses only local evidence and remains reachable when feature capabilities disappear', async () => {
  const store = new GemsJournalStore(gemsIdentity(identity.wallet), factory), onOpen = vi.fn();
  await store.compareAndSet(0, saved => ({ ...saved, intent: parseGemsIntent({ kind: 'gems-from-keep', idempotencyKey: 'paused-operation', keep: '10' }), attempted: true }));
  await act(async () => root.render(<GemsRecoveryDoor onOpen={onOpen} />));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(button('CHECK SAVED GEMS REQUEST')).toBeTruthy();
  });
  await click('CHECK SAVED GEMS REQUEST'); expect(onOpen).toHaveBeenCalledOnce(); expect(api.get).not.toHaveBeenCalled(); expect(api.postRaw).not.toHaveBeenCalled();
});

// Existing scenarios explicitly exercise the admitted web build; hold cases override it.
beforeEach(() => vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'));
afterEach(() => vi.unstubAllEnvs());

it('holds fresh Gems conversions and claims while preserving the server balance', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount();
  expect(host.textContent).toContain('100'); expect(host.textContent).toContain('GEMS AVAILABLE');
  expect(host.querySelector('[aria-label="KEEP amount"]')).toBeNull();
  expect(host.querySelector('[aria-label="Gems amount"]')).toBeNull();
  expect(host.textContent).not.toContain('REVIEW GET GEMS'); expect(host.textContent).not.toContain('REVIEW CONVERSION');
  expect(host.textContent).not.toContain('REVIEW CLAIM'); expect(api.postRaw).not.toHaveBeenCalled();
});
it('keeps a paid original discoverable and recoverable through the web hold', async () => {
  // The browser that began the original must keep its recovery when native flags switch on.
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  const original = parseGemsIntent({ kind: 'gems-from-keep', idempotencyKey: 'held-original', keep: '10' });
  const store = new GemsJournalStore(gemsIdentity(identity.wallet), factory);
  await store.compareAndSet(0, saved => ({ ...saved, intent: original, attempted: true })); await store.close();
  savedIntent = original; receipt = proof(original); const onOpen = vi.fn();
  await act(async () => root.render(<GemsRecoveryDoor onOpen={onOpen} />));
  await until(() => expect(button('CHECK SAVED GEMS REQUEST')).toBeTruthy());
  await click('CHECK SAVED GEMS REQUEST'); expect(onOpen).toHaveBeenCalledOnce();
  await mount(); await until(() => expect(host.textContent).toContain('Original receipt confirmed: +20 GEMS'));
  expect((await journal()).finished).toBe(true); expect(api.postRaw).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('REVIEW CONVERSION');
});
