/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClanRecoveryPanel } from './clanRecovery';
import { ClanController, type ClanPorts } from '../../lib/clans/controller';
import { ClanJournalStore } from '../../lib/clans/journal';
import { baseA, clanId, identity, intent, key, receipt, status, target } from '../../lib/clans/fixtures.test-support';
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() })); vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
let host: HTMLDivElement; let root: Root; let store: ClanJournalStore; let controller: ClanController; let ports: ClanPorts;
function Fixture() { const state = useSyncExternalStore(controller.subscribe, controller.snapshot); return <ClanRecoveryPanel controller={controller} state={state} />; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); store = new ClanJournalStore(identity, new IDBFactory());
  ports = { get: vi.fn(async () => status()), post: vi.fn(async () => receipt()), key: () => key,
    lock: async (_n, run) => run(), capture: () => () => undefined, unsupported: (e) => e instanceof Error && e.message === 'unsupported',
    consent: async (input) => intent(input.kind), validate: async () => undefined,
    hydrate: async (r) => ({ membershipAvailable: false, originalPayout: r.state === 'disbanded' ? 'unavailable' : 'not-applicable' }) };
  controller = new ClanController(store, ports); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); await store.close(); vi.unstubAllGlobals(); });
const render = async () => { await controller.open(); await act(async () => root.render(<Fixture />)); };
const until = async (assertion: () => void) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (attempt === 99) throw error; }
  }
};
const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const click = async (label: string) => { expect(button(label), label).toBeDefined(); expect(button(label)!.disabled).toBe(false); await act(async () => button(label)!.click()); await until(() => expect(controller.snapshot().busy).toBe(false)); };
describe('visible original clan recovery', () => {
  it('review names exact clan/destination; Back and Escape cause zero commands', async () => {
    await render(); await act(async () => controller.review({ kind: 'leave', clanId }));
    expect(host.textContent).toContain(baseA); expect(host.textContent).toContain(clanId); expect(host.textContent).toContain('determined by the server');
    await click('BACK'); await act(async () => controller.review({ kind: 'leave', clanId }));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(controller.snapshot().review).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('unknown result shows only original request/retry and read-only unsupported copy', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await render(); await act(async () => controller.review({ kind: 'leave', clanId }));
    await click('CONFIRM LEAVE / DISBAND'); expect(host.textContent).toContain(key); expect(host.textContent).toContain('does not prove failure');
    expect(button('FINISH REVIEW')).toBeUndefined(); await click('CHECK ORIGINAL RECEIPT'); expect(ports.post).toHaveBeenCalledOnce();
    ports.get = vi.fn().mockRejectedValue(new Error('unsupported')); await click('CHECK ORIGINAL RECEIPT'); expect(button('RETRY ORIGINAL COMMAND')?.disabled).toBe(true);
    expect(host.textContent).toContain('Management stays read-only');
  });
  it.each(['left', 'disbanded', 'kicked', 'refused'] as const)('renders exact %s proof and immutable Finish without another command', async (state) => {
    const kind = state === 'kicked' ? 'kick' : 'leave'; const proof = { ...receipt(kind), state,
      payoutShards: state === 'disbanded' ? '456' : '0', ledgerTransactionId: state === 'disbanded' ? receipt().ledgerTransactionId : null,
      refusalCode: state === 'refused' ? 'CLAN_CHANGED' as const : null };
    await store.compareAndSet(0, (r) => ({ ...r, intent: intent(kind) })); ports.get = vi.fn(async () => status(proof)); await render();
    expect(host.textContent).toContain(state === 'disbanded' ? '456 SHARDS credited' : state === 'left' ? 'LEFT ORIGINAL CLAN' : state === 'kicked' ? 'ORIGINAL MEMBER REMOVED' : 'REFUSED — NO CHANGE');
    if (kind === 'kick') expect(host.textContent).toContain(target); if (state === 'disbanded') expect(host.textContent).toContain('unavailable in the current account directory');
    await click('FINISH REVIEW'); expect((await store.read()).receipt).toEqual(proof); expect(ports.post).not.toHaveBeenCalled();
  });
  it('confirmed proof cannot Finish until original hydration completes', async () => {
    await store.compareAndSet(0, (r) => ({ ...r, intent: intent() })); ports.get = vi.fn(async () => status(receipt())); ports.hydrate = vi.fn().mockRejectedValue(new Error('offline'));
    await render(); expect(button('FINISH REVIEW')?.disabled).toBe(true); expect(host.textContent).toContain('command is confirmed'); expect(ports.post).not.toHaveBeenCalled();
  });
});
