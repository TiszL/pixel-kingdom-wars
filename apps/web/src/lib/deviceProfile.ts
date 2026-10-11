/**
 * Which art residency profile this device gets (D-101).
 *
 * The eager boot set is 141.7 MiB of decoded texture at @2x and 64.5 MiB at
 * @1x, and the canvas is CSS-pixel sized, so a phone never displayed a @2x
 * texel anyway. A constrained device — the Solana-Mobile shell, or anything
 * with little memory or few cores — therefore fetches the @1x atlas files
 * (`deviceAtlasScale` in @shardkeep/shared decides per group).
 *
 * `?art=1x` / `?art=2x` override the heuristic and PERSIST, like the
 * `?client=solana-mobile` marker: the TWA's start URL is the only place a
 * query can be set, and the APK cannot re-launch with a new one. `?art=auto`
 * clears a stored override. Everything read is injectable so the rule is
 * testable without a browser; the defaults read the real globals and never
 * throw (private mode, thumbnail capture, SSR).
 */
import { DEVICE_ART, type DeviceArtProfile } from '@shardkeep/shared';
import { isSolanaMobileClient } from './mobileShell';

export const ART_PROFILE_KEY = 'skp_art';

type ArtOverride = '1x' | '2x';

export interface DeviceProfileEnv {
  /** `location.search` */
  search: string;
  /** localStorage, or null when unavailable; every call is guarded. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  /** `navigator.deviceMemory` (Chromium only; undefined elsewhere). */
  deviceMemory: number | undefined;
  /** `navigator.hardwareConcurrency` */
  hardwareConcurrency: number | undefined;
  /** `isSolanaMobileClient()` — the sticky TWA marker. */
  solanaMobile: boolean;
}

export function readDeviceProfileEnv(): DeviceProfileEnv {
  const nav = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { deviceMemory?: number });
  const search = typeof location === 'undefined' ? '' : location.search;
  let solanaMobile = new URLSearchParams(search).get('client') === 'solana-mobile';
  try { solanaMobile = isSolanaMobileClient(); } catch { /* storage may be unavailable; URL result survives */ }
  return {
    search,
    storage: typeof localStorage === 'undefined' ? null : localStorage,
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    solanaMobile,
  };
}

const isOverride = (value: string | null | undefined): value is ArtOverride =>
  value === '1x' || value === '2x';

const profileOf = (override: ArtOverride): DeviceArtProfile =>
  override === '1x' ? 'constrained' : 'full';

export function deviceArtProfile(env: DeviceProfileEnv = readDeviceProfileEnv()): DeviceArtProfile {
  const fromUrl = new URLSearchParams(env.search).get('art');
  if (isOverride(fromUrl)) {
    try { env.storage?.setItem(ART_PROFILE_KEY, fromUrl); } catch { /* private mode: the query still wins this session */ }
    return profileOf(fromUrl);
  }
  if (fromUrl === 'auto') {
    try { env.storage?.removeItem(ART_PROFILE_KEY); } catch { /* nothing stored to clear */ }
  } else {
    let stored: string | null = null;
    try { stored = env.storage?.getItem(ART_PROFILE_KEY) ?? null; } catch { /* unreadable storage: fall through to the heuristic */ }
    if (isOverride(stored)) return profileOf(stored);
  }
  const constrained = env.solanaMobile
    || (env.deviceMemory !== undefined && env.deviceMemory <= DEVICE_ART.constrainedDeviceMemoryGb)
    || (env.hardwareConcurrency !== undefined
      && env.hardwareConcurrency <= DEVICE_ART.constrainedHardwareConcurrency);
  return constrained ? 'constrained' : 'full';
}
