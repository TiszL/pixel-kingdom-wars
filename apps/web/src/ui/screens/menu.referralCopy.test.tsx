// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, sendTransaction: null }) }));
import { ReferralCodeChip } from './menu';
import { bus } from '../../lib/events';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function mount(code: { code: string; bonusBps?: number } | null = { code: 'KEEP-CQRPF' }) {
  await act(async () => root.render(<ReferralCodeChip code={code} />));
}
const button = (text: string) => [...host.querySelectorAll('button')].find((el) => el.textContent === text)!;

describe('complete mobile referral code', () => {
  it('keeps prefix and suffix in one selectable value and copies that full value', async () => {
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await mount();
    const code = host.querySelector<HTMLElement>('.copyable-all')!;
    expect(code.textContent).toBe('KEEP-CQRPF'); expect(code.style.whiteSpace).toBe('nowrap');
    expect(button('COPY CODE').style.minHeight).toBe('44px');
    await act(async () => button('COPY CODE').click());
    expect(write).toHaveBeenCalledExactlyOnceWith('KEEP-CQRPF');
  });
  it('shares the complete invite URL and acknowledges only an accepted copy', async () => {
    let resolve!: () => void;
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
    const notice = vi.spyOn(bus, 'emit'); await mount();
    await act(async () => button('SHARE LINK').click());
    expect(write).toHaveBeenCalledWith(`${location.origin}/?ref=KEEP-CQRPF`);
    expect(notice).not.toHaveBeenCalledWith('ui:toast', expect.objectContaining({ msg: expect.stringContaining('COPIED') }));
    await act(async () => resolve());
    expect(notice).toHaveBeenCalledWith('ui:toast', { msg: 'REFERRAL LINK COPIED — OPTIONAL CODE, SAME FRIEND BENEFITS' });
  });
  it('keeps the code available when clipboard permission is rejected', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
    const notice = vi.spyOn(bus, 'emit'); await mount();
    await act(async () => button('COPY CODE').click());
    expect(notice).toHaveBeenCalledWith('ui:toast', { msg: 'COULD NOT COPY — SELECT THE FULL CODE' });
    expect(button('COPY CODE').disabled).toBe(false);
    expect(host.querySelector('.copyable-all')?.textContent).toBe('KEEP-CQRPF');
  });
  it('does not offer an incomplete invite while its code is loading', async () => {
    await mount(null); expect(button('COPY CODE').disabled).toBe(true); expect(button('SHARE LINK').disabled).toBe(true);
  });
});
