/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ get: vi.fn(), postRaw: vi.fn(), setAuth: vi.fn(), signOut: vi.fn(), handler: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { get: h.get, postRaw: h.postRaw, postAuth: (path: string, body: unknown) => h.postRaw(path, body), waitForAuth: () => Promise.resolve() }, setLoginRequiredHandler: h.handler }));
vi.mock('../state/store', () => ({ useApp: { getState: () => ({ setAuth: h.setAuth, authed: false }) } }));
vi.mock('./useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('../ui/primitives', () => ({
  COLORS: { ink: '#111', text: '#fff', surface: '#222', border: '#444', danger: '#f00' },
  Btn: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) =>
    <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
vi.mock('../ui/screens/menu', () => ({ SecurityScreen: ({ loginRecovery }: { loginRecovery: boolean }) =>
  <div>{loginRecovery ? 'CONSTRAINED RECOVERY' : 'FULL SECURITY'}</div> }));
import { LoginProtectionGate } from './LoginProtectionGate';
import { acceptLoginResponse, useLoginChallenge } from './loginChallenge';
let root: Root;
beforeEach(() => {
  h.get.mockReset().mockResolvedValue({ loginRequired: false });
  h.postRaw.mockReset(); h.setAuth.mockReset(); h.signOut.mockReset();
  useLoginChallenge.getState().setWallet(null);
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
async function render() { await act(async () => root.render(<LoginProtectionGate />)); }
async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find((el) => el.textContent === text);
  if (!button) throw new Error(`missing ${text}`);
  await act(async () => button.click());
}
describe('limited-login UI', () => {
  it('does not enqueue another cookie-status request while its initial response is stalled', async () => {
    let resolve!: (value: { loginRequired: boolean }) => void;
    h.get.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render();
    const restore = h.handler.mock.calls.at(-1)![0] as () => void;
    restore(); restore();
    expect(h.get).toHaveBeenCalledOnce();
    await act(async () => resolve({ loginRequired: false }));
    await act(async () => restore());
    expect(h.get).toHaveBeenCalledTimes(2);
  });
  it('never publishes game auth until the server promotes the limited credential', async () => {
    acceptLoginResponse({ wallet: 'pending-wallet', loginRequired: true }, h.setAuth);
    expect(h.setAuth).toHaveBeenCalledWith(null);
    expect(h.setAuth).not.toHaveBeenCalledWith('pending-wallet', expect.anything());
    await render();
    const input = document.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    h.postRaw.mockResolvedValue({ wallet: 'pending-wallet', entryPaid: true });
    await click('VERIFY & SIGN IN');
    expect(h.setAuth).toHaveBeenLastCalledWith('pending-wallet', true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('restores the login challenge after reload and offers constrained recovery and sign out', async () => {
    h.get.mockResolvedValue({ loginRequired: true, wallet: 'restored-wallet' });
    await render();
    expect(document.body.textContent).toContain('PKW AUTHENTICATOR');
    await click('LOST AUTHENTICATOR?');
    expect(document.body.textContent).toContain('CONSTRAINED RECOVERY');
    expect(document.body.textContent).not.toContain('FULL SECURITY');
    await click('SIGN OUT');
    expect(h.signOut).toHaveBeenCalledOnce();
  });
  it('ignores an old pending-status response after a different login succeeds', async () => {
    let resolve!: (value: { loginRequired: boolean; wallet: string }) => void;
    h.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    acceptLoginResponse({ wallet: 'new-wallet', entryPaid: false }, h.setAuth);
    await act(async () => resolve({ loginRequired: true, wallet: 'old-wallet' }));
    expect(useLoginChallenge.getState().wallet).toBeNull();
    expect(h.setAuth).toHaveBeenLastCalledWith('new-wallet', false);
  });
});
