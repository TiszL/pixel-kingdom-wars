/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PK_KIT } from '../kitLogic';
import type { Currency, PriceUi, SealUi } from '../types';
import BuildingGemsSeal, { type BuildingGemsSealProps } from './BuildingGemsSeal';

// Real PkSeal interactions: no mock money button, transport, or controller.
const review = (price: PriceUi = { currency: 'GEMS', amount: '12', status: 'OK' }): SealUi => ({
  title: 'Finish upgrade', lines: ['Finish the reviewed building job.'], price,
  confirmLabel: 'FINISH NOW', armedAtMs: 0,
});
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="FINISH NOW"]');
const tap = () => act(() => button()?.click());
const props = (overrides: Partial<BuildingGemsSealProps> = {}): BuildingGemsSealProps => ({
  ui: review(), reviewKey: 'job-a/request-a', canConfirm: () => true,
  onConfirm: vi.fn(), onCancel: vi.fn(), clock: () => PK_KIT.SEAL_ARM_MS, ...overrides,
});
const paint = async (value: BuildingGemsSealProps) => { await act(async () => root.render(<BuildingGemsSeal {...value} />)); };

describe('BuildingGemsSeal', () => {
  it('uses the real shared Seal arming boundary and never queues an early tap', async () => {
    let now = PK_KIT.SEAL_ARM_MS - 1;
    const value = props({ clock: () => now }); await paint(value);
    expect(host.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    tap(); expect(value.onConfirm).not.toHaveBeenCalled();
    now = PK_KIT.SEAL_ARM_MS;
    expect(value.onConfirm).not.toHaveBeenCalled();
    tap(); expect(value.onConfirm).toHaveBeenCalledExactlyOnceWith('job-a/request-a');
  });

  it('rechecks the original controller when admission changes before React paints', async () => {
    let allowed = true; const value = props({ canConfirm: () => allowed }); await paint(value);
    allowed = false; tap(); expect(value.onConfirm).not.toHaveBeenCalled();
    allowed = true; tap(); expect(value.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('uses the latest admission and callback props for the same reviewed request', async () => {
    const original = props(); await paint(original);
    const latest = props({ canConfirm: () => false }); await paint(latest);
    tap(); expect(original.onConfirm).not.toHaveBeenCalled(); expect(latest.onConfirm).not.toHaveBeenCalled();
    await paint({ ...latest, canConfirm: () => true });
    tap(); expect(latest.onConfirm).toHaveBeenCalledExactlyOnceWith(original.reviewKey);
  });

  it.each(['SHARDS', 'KEEP', 'SKR', 'SOL', 'ITEM'] satisfies Currency[])
  ('never confirms a %s price through the buildings Gems consumer', async currency => {
    const value = props({ ui: review({ currency, amount: '12', status: 'OK' }) }); await paint(value);
    tap(); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it.each(['CHECKING', 'UNAVAILABLE', 'SHORT'] as const)
  ('never confirms a %s price even with an old visible amount', async status => {
    const value = props({ ui: review({ currency: 'GEMS', amount: '12', status }) }); await paint(value);
    tap(); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('never treats the unknown OK amount %j as payable', async amount => {
    const value = props({ ui: review({ currency: 'GEMS', amount, status: 'OK' }) }); await paint(value);
    tap(); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it('accepts an authoritative server zero using the same Android payable rule', async () => {
    const value = props({ ui: review({ currency: 'GEMS', amount: null, status: 'SERVER_ZERO' }) }); await paint(value);
    tap(); expect(value.onConfirm).toHaveBeenCalledExactlyOnceWith(value.reviewKey);
  });

  it('does not send twice while the owner has not yet repainted after confirmation', async () => {
    const value = props(); await paint(value);
    act(() => { button()!.click(); button()!.click(); });
    await paint({ ...value, ui: review() }); tap();
    expect(value.onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(['BACK', 'Escape', 'scrim'] as const)
  ('keeps %s cancellation available and consumes that review immediately', async action => {
    const value = props(); await paint(value);
    act(() => {
      if (action === 'BACK') host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click();
      else if (action === 'Escape') host.querySelector('[role="alertdialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else host.querySelector<HTMLElement>('.pk-seal__scrim')!.click();
    });
    tap(); expect(value.onCancel).toHaveBeenCalledTimes(1); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it('allows cancellation while admission is unavailable', async () => {
    const value = props({ canConfirm: () => false }); await paint(value);
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
    expect(value.onCancel).toHaveBeenCalledTimes(1); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it.each(['initially', 'at the tap'] as const)
  ('treats admission throwing %s as false and preserves BACK', async when => {
    let throws = when === 'initially';
    const canConfirm = vi.fn(() => {
      if (throws) throw new Error('Original controller temporarily unavailable');
      return true;
    });
    const value = props({ canConfirm });
    const windowError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', windowError);
    try {
      await paint(value);
      expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
      if (when === 'at the tap') canConfirm.mockClear();
      throws = true; tap();
      // Pins the consumer catch against the base kit. Composed Seal v2 also catches admission errors.
      if (when === 'at the tap') expect(canConfirm).toHaveBeenCalled();
      expect(windowError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(value.onConfirm).not.toHaveBeenCalled();
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
      expect(value.onCancel).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('error', windowError);
      consoleError.mockRestore();
    }
  });

  it('keeps a review with absent gets and clock cancellable through the real kit', async () => {
    const value: BuildingGemsSealProps = {
      ui: review(), reviewKey: 'job-a/request-a', canConfirm: () => false,
      onConfirm: vi.fn(), onCancel: vi.fn(),
    };
    await paint(value);
    expect(host.querySelectorAll('.pk-seal__token')).toHaveLength(1);
    tap(); expect(value.onConfirm).not.toHaveBeenCalled();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="BACK"]')!.click());
    expect(value.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not render an initially absent review', async () => {
    const value = props({ ui: null }); await paint(value);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull(); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it('cannot confirm the retained exit picture or reopen dismissed consent with the same timestamp', async () => {
    const value = props(); await paint(value); await paint({ ...value, ui: null }); tap();
    expect(host.querySelector('.pk-seal-root--leaving')).not.toBeNull();
    await paint(value); tap(); expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it.each(['request', 'price', 'terms'] as const)
  ('invalidates a changed %s instead of retargeting the old consent', async change => {
    const value = props(); await paint(value);
    const changed = { ...value, ui: review() };
    if (change === 'request') changed.reviewKey = 'job-b/request-b';
    else if (change === 'price') changed.ui.price.amount = '24';
    else changed.ui.lines = ['Different reviewed terms.'];
    await paint(changed); tap();
    expect(host.querySelector('.pk-seal-root--leaving')).not.toBeNull();
    expect(host.textContent).toContain('Finish the reviewed building job.');
    await paint(value); tap(); // Reverting props must not resurrect consumed consent.
    expect(value.onConfirm).not.toHaveBeenCalled();
  });

  it('requires a fresh full arm after the owner raises a changed review', async () => {
    let now = PK_KIT.SEAL_ARM_MS;
    const value = props({ clock: () => now }); await paint(value);
    const next = { ...value, reviewKey: 'job-b/request-b', ui: { ...review(), armedAtMs: now } };
    await paint(next); tap(); expect(value.onConfirm).not.toHaveBeenCalled();
    now += PK_KIT.SEAL_ARM_MS - 1; tap(); expect(value.onConfirm).not.toHaveBeenCalled();
    now += 1; tap(); expect(value.onConfirm).toHaveBeenCalledExactlyOnceWith(next.reviewKey);
  });

  it('keeps an empty controller identity closed', async () => {
    const value = props({ reviewKey: ' ' }); await paint(value); tap();
    expect(value.onConfirm).not.toHaveBeenCalled();
  });
});
