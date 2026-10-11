import { describe, expect, it } from 'vitest';
import { RENDER_RATE_OVERRIDE_KEY, renderFpsLimit, type RenderRateEnvironment } from './renderRate';

class FakeStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

const env = (overrides: Partial<RenderRateEnvironment> = {}): RenderRateEnvironment => ({
  search: '', solanaMobile: true, storage: new FakeStorage(), ...overrides,
});

describe('Solana-Mobile render-rate policy', () => {
  it('caps only the sticky Solana-Mobile client at 60 rendered FPS', () => {
    expect(renderFpsLimit(env())).toBe(60);
    expect(renderFpsLimit(env({ solanaMobile: false }))).toBe(0);
  });

  it('persists ?hz=auto across TWA relaunches and ?hz=60 restores the cap', () => {
    const storage = new FakeStorage();
    expect(renderFpsLimit(env({ search: '?hz=auto', storage }))).toBe(0);
    expect(storage.getItem(RENDER_RATE_OVERRIDE_KEY)).toBe('auto');
    expect(renderFpsLimit(env({ storage }))).toBe(0);

    expect(renderFpsLimit(env({ search: '?hz=60', storage }))).toBe(60);
    expect(storage.getItem(RENDER_RATE_OVERRIDE_KEY)).toBeNull();
  });

  it('keeps desktop behavior uncapped even when the shared origin holds a mobile override', () => {
    const storage = new FakeStorage();
    storage.setItem(RENDER_RATE_OVERRIDE_KEY, 'auto');
    expect(renderFpsLimit(env({ solanaMobile: false, storage }))).toBe(0);
  });

  it('does not let a desktop diagnostic URL change a later TWA launch', () => {
    const storage = new FakeStorage();
    expect(renderFpsLimit(env({ search: '?hz=auto', solanaMobile: false, storage }))).toBe(0);
    expect(storage.getItem(RENDER_RATE_OVERRIDE_KEY)).toBeNull();
  });

  it('fails closed to the mobile cap when storage is unavailable', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(renderFpsLimit(env({ storage: throwing }))).toBe(60);
    expect(renderFpsLimit(env({ search: '?hz=auto', storage: throwing }))).toBe(0);
  });
});
