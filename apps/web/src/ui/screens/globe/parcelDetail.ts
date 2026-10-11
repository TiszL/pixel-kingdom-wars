import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
/**
 * One explicitly selected deed parcel. Bulk globe/sector/map payloads remain
 * anonymous; this module only resolves the single frozen `earthCell` a player
 * tapped, through the authenticated and rate-limited API route.
 */
import { useCallback, useEffect, useState } from 'react';
import { GLOBE, WARZONE, fmtDur } from '@shardkeep/shared';
import { API_URL, api } from '../../../lib/api';

/** Why the server preview refuses an action. `keep_too_far_below` is the D-099
 * Keep-asymmetry gate; `outside_trophy_window` is what an API one release behind
 * still sends and stays in the switch for exactly that release. */
export type ParcelActionBlock =
  | 'self'
  | 'keep_too_far_below'
  | 'shielded'
  | 'outside_trophy_window'
  | 'temporarily_unavailable';

export interface ParcelDetail {
  parcel: {
    earthCell: number;
    x: number;
    y: number;
    valleyId: string;
    valleyName: string;
    siteId: number;
    planetId: number;
    country: { a3: string; name: string } | null;
  };
  player: {
    wallet: string;
    name: string;
    avatarUrl: string | null;
    clanTag: string | null;
    seeker: boolean;
    keepLevel: number;
    trophies: number;
  };
  deed: {
    assetId: string | null;
    status: 'minted' | 'minting' | 'pending';
    metadata: {
      name: string;
      symbol: 'DEED';
      description: string;
      external_url: string;
      image: string;
      attributes: Array<{ trait_type: string; value: string | number }>;
    };
  };
  base: {
    /** Stable base identity, present while multi-base reads are enabled. */
    id?: string;
    completedStructures: number;
    defenses: number;
    walls: number;
    landWidth: number;
  };
  /** Effective protection for this selected deed. Ordinary loss/purchase
   * shields remain visible but are explicitly marked suppressed in a warzone. */
  shield: {
    active: boolean;
    source: 'loss' | 'purchase' | 'warzone' | null;
    expiresAt: string | null;
    remainingMs: number;
    suppressedByWarzone: boolean;
  };
  /** Next server rule boundary for this selected parcel. The UI refreshes the
   * authoritative action state there; it never flips shield rules locally. */
  warzone: {
    active: boolean;
    boundaryAt: string | null;
    remainingMs: number | null;
  };
  /** Rolling-version alias. New UI copy/countdown is derived from `shield`. */
  shielded: boolean;
  actions: {
    /** The current API blocks scouting only for self (D-099: shields never gate a
     * scout); `shielded` is what an API one release behind may still send. */
    scout: { allowed: boolean; blockedBy: Extract<ParcelActionBlock, 'self' | 'shielded'> | null };
    attack: {
      allowed: boolean;
      blockedBy: ParcelActionBlock | null;
      /** The two Keep levels the server compared and the bar it applied — the
       * copy says "L3 vs your L11" from these, never from a client rule.
       * Optional only because an API one release behind does not send it. */
      keepReach?: { attackerKeep: number; defenderKeep: number; minDefenderKeep: number };
    };
  };
  /** Combined Mine + balance buckets by victory tier; neither source nor the
   * exact defender balance is disclosed. */
  availableLootRanges: {
    oneStar: { min: string; max: string };
    twoStars: { min: string; max: string };
    threeStars: { min: string; max: string };
  };
}

export function compactRemaining(deadline: string | null, now = Date.now()): string | null {
  if (!deadline) return null;
  const remaining = Math.max(0, Date.parse(deadline) - now);
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  // Same d/h/m vocabulary as every other countdown ("1D 23H", "5M 3S").
  return fmtDur(Math.ceil(remaining / 1000)).toUpperCase();
}

/** Selected-land shield truth. The raid gate uses the same effective state;
 * this function only turns its absolute deadline into live player copy. */
export function parcelShieldText(
  shield: ParcelDetail['shield'] | undefined,
  legacyShielded: boolean,
  now = Date.now(),
): string {
  if (!shield) return legacyShielded ? 'SHIELD ACTIVE' : 'UNSHIELDED';
  const left = compactRemaining(shield.expiresAt, now);
  if (shield.suppressedByWarzone && left) {
    return `${(shield.source ?? 'LOSS').toUpperCase()} SHIELD SUPPRESSED · EXPIRES IN ${left}`;
  }
  if (shield.active && left) {
    const kind = shield.source === 'warzone' ? 'WARZONE SHIELD' : 'SHIELD';
    return `${kind} ACTIVE · ${left} LEFT`;
  }
  if (shield.active || shield.suppressedByWarzone) return 'VERIFYING SHIELD STATUS…';
  return 'UNSHIELDED';
}

export function nextParcelRuleRefreshMs(
  detail: Pick<ParcelDetail, 'shield' | 'warzone'>,
): number | null {
  const clocks = [
    (detail.shield.active || detail.shield.suppressedByWarzone)
      && detail.shield.expiresAt !== null ? detail.shield.remainingMs : null,
    detail.warzone.boundaryAt !== null ? detail.warzone.remainingMs : null,
  ].filter((value): value is number => value !== null && Number.isFinite(value));
  return clocks.length > 0 ? Math.max(0, Math.min(...clocks)) : null;
}

export interface ParcelScoutReport {
  visualContext?: BaseVisualContext | undefined;
  wallet: string;
  name: string;
  keepLevel: number;
  trophies: number;
  buildings: Array<{ id: string; type: string; level: number; tx: number; ty: number }>;
  obstacles: Array<{ id: string; spriteKey: string; tx: number; ty: number }>;
  claimMin: number;
  claimMax: number;
  previewSec: number;
}

interface CacheEntry { data: ParcelDetail; loadedAt: number }

/** The immediately previous API exposed only the effective `shielded` alias.
 * Normalize that rolling-deploy shape once at the read boundary so every
 * mounted inspector can keep using the current authoritative DTO. */
type RollingParcelDetail = Omit<ParcelDetail, 'shield' | 'warzone'>
  & Partial<Pick<ParcelDetail, 'shield' | 'warzone'>>;

function normalizeParcelDetail(data: RollingParcelDetail): ParcelDetail {
  if (data.shield && data.warzone) return data as ParcelDetail;
  return {
    ...data,
    shield: data.shield ?? {
      active: data.shielded,
      source: null,
      expiresAt: null,
      remainingMs: 0,
      suppressedByWarzone: false,
    },
    warzone: data.warzone ?? { active: false, boundaryAt: null, remainingMs: null },
  };
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ParcelDetail>>();

/**
 * Deduplicate a fast re-selection without asking a no-store private endpoint on
 * every render. The cache lasts no longer than the globe snapshot itself; every
 * actual scout or raid still revalidates shield/range/cooldown server-side.
 */
export function loadParcelDetail(
  earthCell: number, viewerWallet: string, selectedBaseId: string | null, force = false,
): Promise<ParcelDetail> {
  const now = Date.now();
  const key = `${viewerWallet}:${selectedBaseId ?? ''}:${earthCell}`;
  // Keep the session cache bounded by relevance, not by how long the tab remains
  // open while somebody browses the planet.
  for (const [cachedKey, entry] of cache) {
    if (now - entry.loadedAt >= GLOBE.cacheSec * 1000) cache.delete(cachedKey);
  }
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.loadedAt < GLOBE.cacheSec * 1000) {
    return Promise.resolve(hit.data);
  }
  if (!force) {
    const running = pending.get(key);
    if (running) return running;
  }
  const path = `/map/parcel/${earthCell}${selectedBaseId
    ? `?baseId=${encodeURIComponent(selectedBaseId)}`
    : ''}`;
  const request = api.get<RollingParcelDetail>(path)
    .then((raw) => {
      const data = normalizeParcelDetail(raw);
      if (data.parcel.earthCell !== earthCell) {
        throw new Error('parcel address mismatch');
      }
      cache.set(key, { data, loadedAt: Date.now() });
      return data;
    })
    .finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
  pending.set(key, request);
  return request;
}

export function useParcelDetail(
  earthCell: number | null, enabled: boolean, viewerWallet: string | null,
  selectedBaseId: string | null,
): { data: ParcelDetail | null; error: string | null; pending: boolean; retry(): void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string | null; data: ParcelDetail | null; error: string | null; pending: boolean;
  }>({ key: null, data: null, error: null, pending: false });

  const key = enabled && earthCell !== null && viewerWallet
    ? `${viewerWallet}:${selectedBaseId ?? ''}:${earthCell}`
    : null;

  useEffect(() => {
    if (key === null || earthCell === null || viewerWallet === null) return undefined;
    let live = true;
    setState({ key, data: null, error: null, pending: true });
    // A manual retry and the shield-expiry refresh must cross the short private
    // cache. Force only if this render was already showing the same selection;
    // moving to another parcel keeps its normal cache semantics.
    const force = attempt > 0 && state.key === key;
    void loadParcelDetail(earthCell, viewerWallet, selectedBaseId, force)
      .then((data) => {
        if (live) setState({ key, data, error: null, pending: false });
      })
      .catch((error: Error) => {
        if (live) setState({ key, data: null, error: error.message, pending: false });
      });
    return () => { live = false; };
  }, [key, earthCell, viewerWallet, selectedBaseId, attempt]);

  // Current mode can be changed by an admin before any previously disclosed
  // boundary, so every open, warzone-aware parcel gets the same bounded pulse.
  const currentPhasePoll = state.key === key && state.data !== null;
  useEffect(() => {
    if (!currentPhasePoll || key === null || earthCell === null || viewerWallet === null) {
      return undefined;
    }
    let live = true;
    let timer: number | undefined;
    const schedule = (): void => {
      timer = window.setTimeout(() => {
        void loadParcelDetail(earthCell, viewerWallet, selectedBaseId, true)
          .then((data) => {
            if (live) setState({ key, data, error: null, pending: false });
          })
          // A background phase check must not replace a usable inspector with a
          // transient error. Keep the current data and try again at normal cadence.
          .catch(() => undefined)
          .finally(() => { if (live) schedule(); });
      }, WARZONE.currentPhasePollSec * 1_000);
    };
    schedule();
    return () => {
      live = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentPhasePoll, earthCell, key, selectedBaseId, viewerWallet]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (key === null) {
    return { data: null, error: null, pending: false, retry };
  }
  if (state.key !== key) {
    return { data: null, error: null, pending: true, retry };
  }
  return { data: state.data, error: state.error, pending: state.pending, retry };
}

function deedApiBaseUrl(): URL | null {
  try {
    const origin = typeof window === 'undefined' ? undefined : window.location.origin;
    const url = new URL(`${API_URL.replace(/\/$/, '')}/`, origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Canonical metadata can use an API-relative image in local deployments. */
export function deedImageUrl(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    // Preserve an absolute canonical R2 URL. Relative metadata belongs under the
    // configured API prefix (`/api` in production), not at the web origin root.
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    const base = deedApiBaseUrl();
    if (!base || raw.startsWith('//')) return null;
    try {
      const url = new URL(raw.replace(/^\/+/, ''), base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
}

/** The API renderer is the durable fallback when an R2 copy has not been pushed
 * yet (common for a local-only deed, possible briefly after a production mint). */
export function deedFallbackImageUrl(wallet: string): string {
  const relative = `/deed/${encodeURIComponent(wallet)}.png`;
  return deedImageUrl(relative) ?? `${API_URL.replace(/\/$/, '')}${relative}`;
}

/** Replace one broken canonical image with the API renderer exactly once, then
 * hide a genuinely unavailable preview instead of leaving the browser's broken
 * image glyph in the deed inspector. `key={earthCell}` gives each parcel a fresh
 * element and therefore a fresh one-attempt budget. */
export function recoverDeedImage(
  image: HTMLImageElement, fallbackUrl: string,
): void {
  const fallback = deedImageUrl(fallbackUrl);
  if (!fallback || image.dataset.deedFallback === '1' || image.src === fallback) {
    image.hidden = true;
    image.removeAttribute('src');
    return;
  }
  image.dataset.deedFallback = '1';
  image.src = fallback;
}

/** What the copy needs beyond the code: the Keep levels the server compared and
 * the shield clock. Both are ATTACK context — a scout is never shield-gated by
 * the current API, so its caller passes nothing. */
export interface ParcelActionBlockContext {
  keepReach?: ParcelDetail['actions']['attack']['keepReach'];
  shield?: ParcelDetail['shield'];
  now?: number;
}

/** Human copy for preview-only disabled states; server errors remain
 * authoritative. Says WHY in the player's numbers (D-099: "THEIR KEEP IS TOO
 * FAR BELOW YOURS (L3 vs your L11)", "SHIELDED UNTIL …") so a disabled button
 * is never a shrug. */
export function parcelActionBlockText(
  reason: ParcelActionBlock | null, ctx: ParcelActionBlockContext = {},
): string | null {
  switch (reason) {
    case 'self': return 'THIS IS YOUR PARCEL';
    case 'keep_too_far_below':
      return ctx.keepReach
        ? `THEIR KEEP IS TOO FAR BELOW YOURS (L${ctx.keepReach.defenderKeep} vs your L${ctx.keepReach.attackerKeep})`
        : 'THEIR KEEP IS TOO FAR BELOW YOURS';
    case 'shielded': {
      // With the shield clock the line says WHEN the attack opens; without one (a
      // scout block from an older API, or a shield with no deadline) only that it
      // is shut — a made-up countdown would be a second clock the server never set.
      const left = ctx.shield ? compactRemaining(ctx.shield.expiresAt, ctx.now) : null;
      return left ? `SHIELDED UNTIL ${left}` : 'SHIELD ACTIVE';
    }
    // One release of compatibility with an API that still gates by trophies.
    case 'outside_trophy_window': return 'OUTSIDE TROPHY RANGE';
    case 'temporarily_unavailable': return 'TEMPORARILY UNAVAILABLE';
    default: return null;
  }
}
