/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FantasyShieldStatus } from './FantasyShieldStatus';
import type { ParcelDetail } from '../screens/globe/parcelDetail';
let root: Root, host: HTMLDivElement;
beforeEach(() => {
 (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
 vi.useFakeTimers(); host = document.createElement('div'); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const detail = (remainingMs: number): Pick<ParcelDetail, 'shield' | 'shielded' | 'warzone'> => ({
 shield: { active: true, source: 'purchase', expiresAt: '2026-09-10T00:00:30.000Z', remainingMs, suppressedByWarzone: false },
 shielded: true, warzone: { active: false, boundaryAt: null, remainingMs: null },
});
describe('fantasy parcel rules retain the production clock contract', () => {
 it('uses server remaining time instead of the device clock and refreshes one time at expiry', async () => {
  vi.setSystemTime(new Date('2099-01-01'));
  const refresh = vi.fn();
  await act(async () => root.render(<FantasyShieldStatus detail={detail(30000)} onExpire={refresh} />));
  expect(host.textContent).toContain('30S LEFT');
  await act(async () => vi.advanceTimersByTimeAsync(30250));
  expect(refresh).toHaveBeenCalledOnce();
  await act(async () => root.render(<FantasyShieldStatus detail={detail(30000)} onExpire={refresh} />));
  await act(async () => vi.advanceTimersByTimeAsync(60000));
  expect(refresh).toHaveBeenCalledOnce();
 });
 it('refreshes at an earlier warzone rule boundary without assuming a client-side shield result', async () => {
  const refresh = vi.fn(), current = detail(30000);
  current.warzone = { active: false, boundaryAt: '2026-09-10T00:00:05.000Z', remainingMs: 5000 };
  await act(async () => root.render(<FantasyShieldStatus detail={current} onExpire={refresh} />));
  await act(async () => vi.advanceTimersByTimeAsync(5250));
  expect(refresh).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('SHIELD ACTIVE');
 });
});
