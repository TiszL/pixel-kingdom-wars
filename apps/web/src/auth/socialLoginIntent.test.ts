/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeSocialLoginIntent, rememberSocialLoginIntent } from './socialLoginIntent';

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('one-use OAuth continuation intent', () => {
  it('rejects an intent after another tab changed the cookie identity', () => {
    rememberSocialLoginIntent('cookie-before-logout');
    expect(consumeSocialLoginIntent('cookie-after-logout')).toBe(false);
    expect(consumeSocialLoginIntent('cookie-before-logout')).toBe(false);
  });
  it('cannot continue when consuming the tab intent fails to persist', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => JSON.stringify({ cookieRevision: 'stable', startedAt: Date.now() }),
      removeItem: () => { throw new Error('read-only'); },
    });
    expect(consumeSocialLoginIntent('stable')).toBe(false);
  });
});
