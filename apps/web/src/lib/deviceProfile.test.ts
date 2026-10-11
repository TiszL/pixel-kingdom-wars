/**
 * The profile decides whether a device decodes 141.7 MiB or 64.5 MiB of eager
 * art. Getting it wrong in the "full" direction is the Seeker freeze this
 * exists to cure; getting it wrong in the "constrained" direction silently
 * downgrades a desktop. Each case pins one input the rule reads, and the
 * override cases pin that a tester's `?art=` survives the TWA's single-URL
 * launch the same way the Solana-Mobile marker does.
 */
import { DEVICE_ART } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { ART_PROFILE_KEY, deviceArtProfile, type DeviceProfileEnv } from './deviceProfile';

class FakeStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

const desktop = (over: Partial<DeviceProfileEnv> = {}): DeviceProfileEnv => ({
  search: '',
  storage: new FakeStorage(),
  deviceMemory: 8,
  hardwareConcurrency: 10,
  solanaMobile: false,
  ...over,
});

describe('deviceArtProfile', () => {
  it('is full on an unmarked desktop above both thresholds', () => {
    expect(deviceArtProfile(desktop())).toBe('full');
  });

  it('is constrained in the Solana-Mobile shell regardless of the hardware it reports', () => {
    expect(deviceArtProfile(desktop({ solanaMobile: true }))).toBe('constrained');
  });

  it('is constrained at or below the memory threshold, full just above it', () => {
    expect(deviceArtProfile(desktop({ deviceMemory: DEVICE_ART.constrainedDeviceMemoryGb })))
      .toBe('constrained');
    expect(deviceArtProfile(desktop({ deviceMemory: DEVICE_ART.constrainedDeviceMemoryGb + 0.5 })))
      .toBe('full');
  });

  it('is constrained at or below the core threshold, full just above it', () => {
    expect(deviceArtProfile(desktop({ hardwareConcurrency: DEVICE_ART.constrainedHardwareConcurrency })))
      .toBe('constrained');
    expect(deviceArtProfile(desktop({ hardwareConcurrency: DEVICE_ART.constrainedHardwareConcurrency + 1 })))
      .toBe('full');
  });

  it('treats an unreported signal as no evidence (Safari/Firefox have no deviceMemory)', () => {
    expect(deviceArtProfile(desktop({ deviceMemory: undefined, hardwareConcurrency: undefined })))
      .toBe('full');
    expect(deviceArtProfile(desktop({ deviceMemory: undefined, hardwareConcurrency: 2 })))
      .toBe('constrained');
  });

  it('?art=1x forces constrained on a desktop and persists like the mobile marker', () => {
    const storage = new FakeStorage();
    expect(deviceArtProfile(desktop({ search: '?art=1x', storage }))).toBe('constrained');
    expect(storage.getItem(ART_PROFILE_KEY)).toBe('1x');
    // Next launch without the query (the TWA only ever has its start URL).
    expect(deviceArtProfile(desktop({ storage }))).toBe('constrained');
  });

  it('?art=2x restores full art on the Seeker and persists', () => {
    const storage = new FakeStorage();
    expect(deviceArtProfile(desktop({ search: '?client=solana-mobile&art=2x', storage, solanaMobile: true })))
      .toBe('full');
    expect(storage.getItem(ART_PROFILE_KEY)).toBe('2x');
    expect(deviceArtProfile(desktop({ storage, solanaMobile: true }))).toBe('full');
  });

  it('?art=auto clears a stored override and returns to the heuristic', () => {
    const storage = new FakeStorage();
    storage.setItem(ART_PROFILE_KEY, '1x');
    expect(deviceArtProfile(desktop({ search: '?art=auto', storage }))).toBe('full');
    expect(storage.getItem(ART_PROFILE_KEY)).toBeNull();
  });

  it('ignores an unknown ?art value and a corrupt stored value', () => {
    const storage = new FakeStorage();
    storage.setItem(ART_PROFILE_KEY, '3x');
    expect(deviceArtProfile(desktop({ search: '?art=big', storage }))).toBe('full');
    expect(deviceArtProfile(desktop({ search: '?art=big', storage, solanaMobile: true })))
      .toBe('constrained');
  });

  it('still answers when storage is missing or throws (private mode, thumbnail capture)', () => {
    expect(deviceArtProfile(desktop({ search: '?art=1x', storage: null }))).toBe('constrained');
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(deviceArtProfile(desktop({ search: '?art=1x', storage: throwing }))).toBe('constrained');
    expect(deviceArtProfile(desktop({ storage: throwing }))).toBe('full');
  });
});
