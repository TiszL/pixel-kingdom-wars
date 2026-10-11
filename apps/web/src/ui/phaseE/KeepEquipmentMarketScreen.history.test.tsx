/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeepEquipmentMarketScreen } from './KeepEquipmentMarketScreen';
import { useKeepMarket } from '../../lib/keepEquipmentMarket/useKeepMarket';
vi.mock('../../lib/keepEquipmentMarket/useKeepMarket', () => ({ useKeepMarket: vi.fn() }));
const run = vi.fn();
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(useKeepMarket).mockReturnValue({
    state: { category: 'items', loaded: true, busy: false, journal: null, offers: null, history: null, stock: null, policy: null, selected: null, reviewed: null, error: null },
    actionsAllowed: false, signingAllowed: false, run, dismiss: vi.fn(),
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it('history-only entry starts on saved activity and has no browse or sell controls', async () => {
  await act(async () => root.render(<KeepEquipmentMarketScreen actionsEnabled historyOnly onClose={() => undefined} />));
  expect(useKeepMarket).toHaveBeenCalledWith(false, null);
  expect(host.querySelector('[aria-label="KEEP market history"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Market offers"]')).toBeNull();
  expect([...host.querySelectorAll('button')].some(button => ['browse', 'sell'].includes(button.textContent?.toLowerCase() ?? ''))).toBe(false);
});
it('the world panel retains ordinary browsing when history-only is not requested', async () => {
  await act(async () => root.render(<KeepEquipmentMarketScreen actionsEnabled onClose={() => undefined} />));
  expect(useKeepMarket).toHaveBeenCalledWith(true, null);
  expect(host.querySelector('[aria-label="Market offers"]')).not.toBeNull();
});
