/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { FeedbackPrivateImage } from './FeedbackThreadScreenshots';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { getBlob } = vi.hoisted(() => ({ getBlob: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: { getBlob } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); getBlob.mockReset(); });
async function mount() {
  useApp.setState({ wallet: 'owner' });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<FeedbackPrivateImage path="/tester/feedback/report" wallet="owner"
    attachment={{ id: 'image', expired: false, width: 2000, height: 3000, byteLength: 100, contentType: 'image/webp' }} />));
  cleanup.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return { host, create, revoke };
}

it('lets players and staff read full-size evidence and return without another download', async () => {
  getBlob.mockResolvedValue(new Blob(['private'])); const { host, revoke } = await mount();
  const button = host.querySelector('button')!;
  expect(button.textContent).toBe('VIEW FULL SIZE'); expect(button.style.minHeight).toBe('44px');
  await act(async () => button.click());
  const area = host.querySelector<HTMLElement>('[role=region]')!;
  expect(button.getAttribute('aria-expanded')).toBe('true'); expect(button.textContent).toBe('FIT SCREENSHOT');
  expect(area.style.overflow).toBe('auto'); expect(area.tabIndex).toBe(0);
  expect(area.querySelector('img')!.style.maxWidth).toBe('none');
  await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(button.getAttribute('aria-expanded')).toBe('false'); expect(host.querySelector('[role=region]')).toBeNull();
  expect(getBlob).toHaveBeenCalledOnce(); expect(revoke).not.toHaveBeenCalled();
});

it('immediately removes and revokes expanded private bytes when the wallet changes', async () => {
  getBlob.mockResolvedValue(new Blob(['private'])); const { host, revoke } = await mount();
  await act(async () => host.querySelector('button')!.click());
  await act(async () => useApp.setState({ wallet: 'other' }));
  expect(host.querySelector('img')).toBeNull(); expect(host.querySelector('button')).toBeNull();
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:private-test');
  expect(getBlob.mock.calls[0]![1].signal.aborted).toBe(true);
});

it('discards a late image response after an account switch without creating a private URL', async () => {
  let resolve!: (image: Blob) => void;
  getBlob.mockImplementation(() => new Promise<Blob>((done) => { resolve = done; }));
  const { host, create } = await mount();
  await act(async () => useApp.setState({ wallet: 'other' }));
  await act(async () => resolve(new Blob(['old private image'])));
  expect(create).not.toHaveBeenCalled(); expect(host.querySelector('img')).toBeNull();
});
