import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
const signOut = readFileSync(new URL('../auth/useSignOut.ts', import.meta.url), 'utf8');
const fence = readFileSync(new URL('../auth/useWalletSessionFence.ts', import.meta.url), 'utf8');
const overlay = readFileSync(new URL('../ui/Overlay.tsx', import.meta.url), 'utf8');
const menu = readFileSync(new URL('../ui/screens/menu.tsx', import.meta.url), 'utf8');

function ordered(source: string, ...needles: string[]): boolean {
  let cursor = -1;
  for (const needle of needles) {
    cursor = source.indexOf(needle, cursor + 1);
    if (cursor < 0) return false;
  }
  return true;
}

describe('private push endpoint follows authenticated-session lifetime', () => {
  it('retires push before explicit sign-out revokes the server cookie', () => {
    expect(ordered(signOut,
      'const retirePush = suspendPushSession()',
      's.setAuth(null)',
      // D-109 keeps endpoint retirement inside the serialized cookie change.
      'api.logout(() => Promise.all([retirePush, disconnectAdapter]), afterLogout)',
    )).toBe(true);
  });

  it('covers the wallet fence, expired-session handler, profile UNLINK and alpha wallet switch', () => {
    const fenceInvalidation = fence.slice(fence.indexOf('function invalidateSession'));
    expect(ordered(fenceInvalidation,
      'const retirePush = suspendPushSession()', 'state.setAuth(null)', 'api.logout(() => retirePush)',
    )).toBe(true);

    const unauthorized = overlay.slice(
      overlay.indexOf('setUnauthorizedHandler'), overlay.indexOf('// Closed-alpha 403'),
    );
    expect(ordered(unauthorized, 'suspendPushSession()', 's.setAuth(null)')).toBe(true);

    const walletSwitch = overlay.slice(
      overlay.indexOf('const signInWithConnected'), overlay.indexOf('// A split-wallet Seeker'),
    );
    expect(ordered(walletSwitch,
      'const retirePush = suspendPushSession()', 'setAuth(null)', 'api.logout(() => retirePush)', 'await signIn()',
    )).toBe(true);

    const unlink = menu.slice(menu.indexOf('const unlink ='), menu.indexOf('// SIGN OUT ends'));
    expect(ordered(unlink, 'suspendPushSession()', 'setAuth(null)', 'disconnect()')).toBe(true);
  });

  it('resumes only for authenticated boot/login; controller takeover cannot lift suspension', () => {
    expect(app).toContain('void resumePushSessionAndSync()');
    expect(app).toContain("worker?.addEventListener('controllerchange', syncPushForAuthenticatedWallet)");
    expect(app).not.toContain("worker?.addEventListener('controllerchange', resumePushForAuthenticatedWallet)");
  });

  it('refreshes the Settings switch after OS permission changes while the profile stays mounted', () => {
    const profile = menu.slice(menu.indexOf('export function ProfileScreen'), menu.indexOf('// CLANS ('));
    expect(profile).toContain("window.addEventListener('focus', refreshPushStatus)");
    expect(profile).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(profile).toContain("if (document.visibilityState === 'visible') refreshPushStatus()");
  });

  it('describes the single consent toggle with every delivered notification source', () => {
    // WHY: Mine fullness shares the existing OS capability and consent epoch;
    // presenting a second toggle would promise a preference the server does not store.
    expect(menu).toContain('RAIDS · MINES · BUILDS · TROOPS · MAIL');
  });
});
