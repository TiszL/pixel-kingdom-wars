/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import AdminScreen from './admin';
vi.mock('../campaigns/AdminCampaignPanel', () => ({ default: () => <p>Campaign management</p> }));
let root: Root, host: HTMLDivElement;
let open: boolean;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.getState().setAuth('admin'); open = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/admin/alpha/stats') return { pending: 1, approved: 0, rejected: 0, accessOpen: open };
    if (path.startsWith('/admin/alpha/applications')) return { applications: [{ id: 'request', email: 'historical@example.com', status: 'pending', handle: 'Historic captain' }] };
    if (path.startsWith('/admin/alpha/invites')) return { invites: [], nextOffset: null };
    throw new Error(path);
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue({}); vi.spyOn(api, 'post').mockResolvedValue({});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.getState().setAuth(null); vi.restoreAllMocks(); });
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
  await act(async () => button.click());
}
it('retains history while removing admission review and issuance in open mode', async () => {
  await act(async () => root.render(<AdminScreen />)); await click('REQUESTS');
  expect(host.textContent).toContain('historical@example.com');
  expect(host.textContent).toContain('admission is open; invite controls are unavailable here');
  expect(host.textContent).not.toContain('issuance are retired');
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'APPROVE')).toBe(false);
  await click('CODES'); expect(host.textContent).toContain('Existing code history is preserved');
  expect(host.querySelector('input[aria-label="Number of invite codes"]')).toBeNull();
  expect(api.postRaw).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});
it('preserves admission controls when the server reports gated admission', async () => {
  open = false; await act(async () => root.render(<AdminScreen />)); await click('REQUESTS');
  expect([...host.querySelectorAll('button')].some(b => b.textContent === 'APPROVE')).toBe(true);
  await click('CODES'); expect(host.querySelector('input[aria-label="Number of invite codes"]')).not.toBeNull();
});
