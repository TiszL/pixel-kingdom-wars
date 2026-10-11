/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferralRecoveryPanel } from './referralRecovery';
import { ReferralController, type ReferralPorts } from '../../lib/referrals/controller';
import { ReferralJournalStore } from '../../lib/referrals/journal';
import { identity, relationship, response, status } from '../../lib/referrals/fixtures.test-support';
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
let host: HTMLDivElement; let root: Root; let store: ReferralJournalStore; let controller: ReferralController; let ports: ReferralPorts;
const legacy = vi.fn(); const retryLegacy = vi.fn();
function Fixture() { const state = useSyncExternalStore(controller.subscribe, controller.snapshot); return <ReferralRecoveryPanel controller={controller} state={state} legacy={legacy} retryLegacy={retryLegacy} initialCode=" keep-abcde " />; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); store = new ReferralJournalStore(identity, new IDBFactory());
  ports = { get: vi.fn(async () => status()), post: vi.fn(async () => response()), lock: async (_n, run) => run(), capture: () => () => undefined,
    unsupported: (e) => e instanceof Error && e.message === 'unsupported', firstRefusal: () => false };
  controller = new ReferralController(store, ports); legacy.mockReset().mockResolvedValue(undefined); retryLegacy.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await store.close(); vi.unstubAllGlobals(); });
const render = async () => { await controller.open(); await act(async () => root.render(<Fixture />)); };
const until = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); assertion(); });
const click = async (label: string) => { const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label); expect(button, label).toBeDefined(); expect(button!.disabled).toBe(false); await act(async () => button!.click()); await until(() => expect(controller.snapshot().busy).toBe(false)); };
describe('visible referral consent and recovery', () => {
  it('shows normalized irreversible consent and Back/Escape produces zero commands', async () => {
    await render(); await click('REVIEW CODE'); expect(host.textContent).toContain('REVIEW · KEEP-ABCDE'); expect(host.textContent).toContain('cannot be changed later');
    await click('BACK'); expect(ports.post).not.toHaveBeenCalled(); await click('REVIEW CODE');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(controller.snapshot().review).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
    await click('REVIEW CODE'); await click('CONFIRM REFERRAL'); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/referrals/v1/use', { code: 'KEEP-ABCDE' });
  });
  it.each(['applied', 'already_applied', 'already_bound'] as const)('renders precise %s outcome and preserves the immutable referrer after Finish', async (outcome) => {
    ports.post = vi.fn(async () => response(outcome)); await render(); await click('REVIEW CODE'); await click('CONFIRM REFERRAL');
    expect(host.textContent).toContain(outcome === 'applied' ? 'was applied' : outcome === 'already_applied' ? 'was already applied' : 'did not change its referrer');
    expect(host.textContent).toContain(relationship.referrerWallet); await click('FINISH REVIEW'); expect((await store.read()).relationship).toEqual(relationship);
    expect(host.querySelector('input')).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('observed attribution names no successful submitted code and exposes no new entry', async () => {
    ports.get = vi.fn(async () => status(true)); await render(); expect(host.textContent).toContain('does not prove which code'); expect(host.querySelector('input')).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('uncertainty offers only exact retry and status; a null read cannot make Finish or new code available', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await render(); await click('REVIEW CODE'); await click('CONFIRM REFERRAL');
    expect(host.textContent).toContain('SAVED CODE · KEEP-ABCDE'); expect(host.querySelector('input')).toBeNull(); expect(host.textContent).not.toContain('FINISH REVIEW');
    await click('CHECK REFERRAL STATUS'); expect(ports.post).toHaveBeenCalledOnce(); await click('RETRY SAME CODE'); expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it('offers legacy entry only for unsupported empty state and retains original legacy route after uncertainty', async () => {
    ports.get = vi.fn().mockRejectedValue(new Error('unsupported')); await render(); await click('USE CODE'); expect(legacy).toHaveBeenCalledWith('keep-abcde'); expect(ports.post).not.toHaveBeenCalled();
    await store.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE', legacy: { route: '/referrals/use', code: 'KEEP-ABCDE', result: null } }));
    await click('CHECK REFERRAL STATUS'); expect(host.querySelector('input')).toBeNull(); await click('RETRY ORIGINAL CODE'); expect(retryLegacy).toHaveBeenCalledOnce();
  });
  it('unresolved alpha admission stays distinct from a positive attribution and cannot finish from it', async () => {
    await store.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE', legacy: { route: '/alpha/referral', code: 'KEEP-ABCDE', result: null }, relationship, outcome: 'observed' }));
    ports.get = vi.fn(async () => status(true)); await render(); expect(host.textContent).toContain('does not prove admission'); expect(host.textContent).not.toContain('FINISH REVIEW');
    expect(host.textContent).not.toContain('RETRY ORIGINAL CODE'); expect(ports.post).not.toHaveBeenCalled();
  });
});
