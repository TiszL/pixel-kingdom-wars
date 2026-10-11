/**
 * API client — thin fetch wrapper over apps/api. Session rides an httpOnly
 * cookie (credentials: include); every mutation auto-attaches a fresh
 * idempotency key unless the caller pins one (retry-safe by default).
 */
import type { GameCurrency } from './gameCurrency';
import { mutationGate } from './mutationGate';
import { authCookies } from '../auth/authCookieCoordinator';
import { AuthChangedError } from '../auth/authCookieCoordinatorCore';
import { SIM_VERSION } from '@shardkeep/sim';
import { PHASE_E_DIVINE_TRIALS } from '@shardkeep/shared';
import type { FantasyTile } from '@shardkeep/shared/fantasyWorld';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
const BASE = API_URL;

export class ApiError extends Error {
  /** `code` is the server's machine-readable reason (`error.code`), when it
   *  sends one — e.g. the closed-alpha gate's ALPHA_GATED. Messages are for
   *  humans and get reworded; branching on them is how the 401→"session
   *  expired" lie happened, so reasons the client must ACT on ride a code. */
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** Bounded machine-readable fields returned beside code/message. Raid clock
     * CAS failures use this to carry the canonical replacement clock. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** GET /bases. `slot` is activation capacity, never a server-global selection. */
export interface WalletBaseDto {
  id: string;
  deedAssetId: string | null;
  status: 'active' | 'inactive';
  keepLevel: number;
  builders: number;
  expansions: number;
  landPaidAt: string | null;
  slot: 1 | 2 | 3 | 4 | 5 | null;
  earthCell: number | null;
  countryA3: string | null;
  /** Only an assigned, persisted location. Held destinations remain private. */
  fantasyLocation?: FantasyTile | null;
}

export interface BasesDto {
  enabled: boolean;
  /** Optional for older dual-address servers; never infer an Earth address. */
  worldId?: 'fantasy-v1' | 'legacy-earth';
  maxActive: number;
  /** Init-once entry vs repeatable deed rail, resolved from durable server history. */
  nextLandPurchaseKind: 'entry' | 'deed';
  capabilities: {
    baseScopedReads: boolean;
    baseScopedMutations: boolean;
    cellReservations: boolean;
  };
  bases: WalletBaseDto[];
}

export function baseSelectorAvailable(directory: BasesDto | null): boolean {
  return directory?.enabled === true && directory.capabilities.baseScopedReads;
}

/** A device preference is accepted only when this fresh response still owns it. */
export function resolveFreshBaseId(directory: BasesDto, preferred: string | null): string | null {
  if (!baseSelectorAvailable(directory)) return null;
  const active = directory.bases.filter((base) => base.status === 'active' && base.slot !== null);
  if (preferred && active.some((base) => base.id === preferred)) return preferred;
  return active.length === 1 ? active[0]!.id : null;
}

/** The closed-alpha gate's machine-readable 403 reason (apps/api assertAlphaAccess). */
export const ALPHA_GATED = 'ALPHA_GATED';

/** True when this error is the closed-alpha gate — the caller should route to
 *  the invite-code panel instead of surfacing a failed action. */
export function isAlphaGated(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.code === ALPHA_GATED;
}

/** The land gate's machine-readable 402 reason (apps/api requireLandOwned). */
export const LAND_NOT_OWNED = 'LAND_NOT_OWNED';
/** A valid session needs a fresh purpose-bound wallet signature. Unlike 401,
 *  this is an action precondition and must never force-log-out the player. */
export const RECENT_AUTH_REQUIRED = 'RECENT_AUTH_REQUIRED';
export const RECENT_AUTH_HEADER = 'x-shardkeep-recent-auth';
export const BASE_CLIENT_UPGRADE_REQUIRED = 'BASE_CLIENT_UPGRADE_REQUIRED';
const BASE_SELECTION_ERROR_CODES = new Set([
  BASE_CLIENT_UPGRADE_REQUIRED, 'BASE_NOT_OWNED', 'DEED_OWNERSHIP_CHANGED',
  'DEED_AUTHORITY_UNAVAILABLE',
]);

export function isBaseClientUpgradeRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 426 && e.code === BASE_CLIENT_UPGRADE_REQUIRED;
}

export function isBaseSelectionError(e: unknown): boolean {
  return e instanceof ApiError && !!e.code && BASE_SELECTION_ERROR_CODES.has(e.code);
}

export function baseStatePath(baseId: string | null): string {
  return baseId ? `/base?baseId=${encodeURIComponent(baseId)}` : '/base';
}

/**
 * True when this error is the LAND gate — the caller should offer "buy your
 * land" instead of surfacing a failed action.
 *
 * THE CODE IS REQUIRED, and that is the whole flag-off safety story. Two OTHER
 * 402s already exist and are CODELESS (auth/session.ts requireEntryPaid, and
 * routes.ts' non-`entry` deposit refusal), and one of them is what the
 * pre-free-onboarding paywall is built on: `enterGame` reads `status === 402`
 * off the /base load and routes to the blocking ENTRY screen. Matching on the
 * status alone would therefore hijack today's paywall into the new soft prompt
 * on a server that has not shipped the free tier yet. Matching on the code means
 * the new path cannot fire until the API sends it.
 */
export function isLandNotOwned(e: unknown): boolean {
  return e instanceof ApiError && e.status === 402 && e.code === LAND_NOT_OWNED;
}

/** Called on any ALPHA_GATED 403 (registered by the UI, like onUnauthorized).
 *  Global on purpose: the gate can fire from sign-in, session restore, or ANY
 *  authed request after a mid-play revocation, and every one of those call
 *  sites must land the player on the same redeem panel — not a dead toast. */
let onAlphaGated: (() => void) | null = null;
export function setAlphaGatedHandler(fn: () => void): void { onAlphaGated = fn; }

/** Called on any LAND_NOT_OWNED 402 (registered by the UI, exactly like
 *  onAlphaGated). Global for the same reason: the land gate now sits in front of
 *  the Forge, market selling, raiding, PvE bounties, clans and withdrawals, so it
 *  can fire from a dozen screens a deedless player can still legitimately open —
 *  and every one of those must land on "buy your land", never a dead toast
 *  reading "entry payment required". */
let onLandGated: (() => void) | null = null;
export function setLandGatedHandler(fn: () => void): void { onLandGated = fn; }

/** Called on any 401 so the app can recover an expired session (registered by
 *  the UI; kept as a callback to avoid coupling this low-level client to the
 *  store). */
let onLoginRequired: (() => void) | null = null;
export function setLoginRequiredHandler(fn: (() => void) | null): void { onLoginRequired = fn; }

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

/** Called on a 426 so the app can force the update (registered by the UI). */
let onOutdated: (() => void) | null = null;
export function setOutdatedHandler(fn: () => void): void { onOutdated = fn; }

/** Called on a 503 whose body carries code MAINTENANCE — the deploy drain
 *  window's Caddy page (M23 a18). The UI shows a hold banner and watches for
 *  the server to return rather than surfacing dead-end request errors. */
let onMaintenance: (() => void) | null = null;
export function setMaintenanceHandler(fn: () => void): void { onMaintenance = fn; }

/** Let the UI distinguish confirmed ownership loss from uncertain chain reads.
 * Old wallet/base responses must never navigate a newer selection. */
let onBaseSelectionInvalid: ((code: string) => void) | null = null;
let baseSelectionScope: (() => string) | null = null;
export function setBaseSelectionInvalidHandler(fn: (code: string) => void, scope?: () => string): void {
  onBaseSelectionInvalid = fn;
  baseSelectionScope = scope ?? null;
}

type ErrorEnvelope = { error?: { code?: string; message?: string } & Record<string, unknown> };

function throwResponseError(
  res: Pick<Response, 'status'>, json: ErrorEnvelope,
  authorityScopeReader: typeof baseSelectionScope, authorityScope: string | undefined,
  deferAuthorityUnavailable = false,
): never {
  if (json.error?.code === 'LOGIN_TOTP_REQUIRED') onLoginRequired?.();
  if (res.status === 401) onUnauthorized?.();
  // 426 Upgrade Required — this bundle is stale. Surface it as an update, not
  // as a failed action: retrying cannot help and the player needs to reload.
  if (res.status === 426 && json.error?.code !== BASE_CLIENT_UPGRADE_REQUIRED) {
    mutationGate.close();
    onOutdated?.();
  }
  // 503 MAINTENANCE — the deploy drain window (M23 a18). CODED only: an
  // ordinary overloaded-API 503 must keep failing the action loudly.
  if (res.status === 503 && json.error?.code === 'MAINTENANCE') {
    mutationGate.close();
    onMaintenance?.();
  }
  // Closed-alpha 403 — route to the invite-code panel (see setAlphaGatedHandler).
  if (res.status === 403 && json.error?.code === ALPHA_GATED) onAlphaGated?.();
  // Land gate 402 — offer the buy-land flow (see setLandGatedHandler). CODED
  // only: the two codeless 402s already in the API must keep behaving exactly
  // as they do today (see isLandNotOwned).
  if (res.status === 402 && json.error?.code === LAND_NOT_OWNED) onLandGated?.();
  if (json.error?.code && BASE_SELECTION_ERROR_CODES.has(json.error.code)
    && !(deferAuthorityUnavailable && res.status === 503 && json.error.code === 'DEED_AUTHORITY_UNAVAILABLE')
    && authorityScopeReader === baseSelectionScope && authorityScope === baseSelectionScope?.()) {
    onBaseSelectionInvalid?.(json.error.code);
  }
  throw new ApiError(
    res.status,
    json.error?.message ?? `HTTP ${res.status}`,
    json.error?.code,
    json.error,
  );
}

async function transport<T>(
  method: string,
  path: string,
  body?: unknown,
  recentAuthGrant?: string,
  rawContentType?: string,
  signal?: AbortSignal,
  privateResponse?: 'json' | 'blob' | 'stream',
  isCurrent?: () => boolean,
  deferAuthorityUnavailable = false,
  expectedCurrency?: GameCurrency,
  observeResponseError?: (error: ApiError) => Promise<void>,
): Promise<T> {
  const authorityScopeReader = baseSelectionScope;
  const authorityScope = authorityScopeReader?.();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body !== undefined ? { 'content-type': rawContentType ?? 'application/json' } : {}),
        ...(privateResponse === 'stream' ? { accept: 'text/event-stream' } : {}),
        ...(recentAuthGrant ? { [RECENT_AUTH_HEADER]: recentAuthGrant } : {}),
        ...(expectedCurrency ? { 'x-pkw-expected-currency': expectedCurrency } : {}),
        // Which simulator this bundle ships. The server refuses to START a raid for
        // a client that would simulate it differently (426), because the client
        // renders the battle locally and the server scores it — disagreement means
        // watching a fight you did not have. Sent on every request so the check is
        // one place, not remembered per call site.
        'x-sim-version': String(SIM_VERSION),
      },
      body: body !== undefined
        ? rawContentType ? body as BodyInit : JSON.stringify(body)
        : null,
      ...(signal ? { signal } : {}),
      ...(privateResponse ? { cache: 'no-store' as const } : {}),
    });
  } catch {
    // Browsers collapse a stopped local API, DNS failure and rejected CORS
    // preflight into the same opaque TypeError. Do not leak the useless native
    // "Failed to fetch" into the wallet/login UI.
    throw new ApiError(
      0,
      'Unable to reach the game server. Check your connection and try again.',
      'NETWORK_UNAVAILABLE',
    );
  }
  // SSE must release the shared cookie lock at headers, including failures.
  // Its error body and long-lived event body are consumed outside that lock.
  if (privateResponse === 'stream') return res as T;
  if (res.ok && privateResponse === 'blob') {
    const blob = await res.blob();
    signal?.throwIfAborted();
    if (isCurrent?.() === false) throw new AuthChangedError();
    return blob as T;
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string } & Record<string, unknown>;
  };
  // A command's original durable journal may retain a typed refusal even when
  // the responding view is obsolete. Only postRaw can opt in; no response
  // handler or current-session publication runs before the guards below.
  if (!res.ok && observeResponseError && json.error && typeof json.error === 'object' && !Array.isArray(json.error)) {
    const error = json.error;
    await observeResponseError(new ApiError(res.status,
      typeof error.message === 'string' ? error.message : `HTTP ${res.status}`,
      typeof error.code === 'string' ? error.code : undefined, error));
  }
  // A cancelled recovery read must not apply old-session response handlers.
  signal?.throwIfAborted();
  if (isCurrent?.() === false) throw new AuthChangedError();
  if (!res.ok) {
    throwResponseError(res, json, authorityScopeReader, authorityScope, deferAuthorityUnavailable);
  }
  if (COOKIE_LOGINS.has(path)) {
    const login = json as { wallet?: unknown; loginRequired?: unknown; entryPaid?: unknown; expiresAt?: unknown };
    if (typeof login.wallet !== 'string' || !login.wallet
      || (login.loginRequired === true ? typeof login.expiresAt !== 'string' : typeof login.entryPaid !== 'boolean')) {
      // A successful header may already have installed an HttpOnly cookie.
      // Treat missing/malformed bodies as uncertain, never as a finished login.
      throw new ApiError(0, 'Sign-in response was interrupted. Please try again.', 'LOGIN_RESPONSE_INVALID');
    }
  }
  return json as T;
}

const COOKIE_LOGINS = new Set(['/auth/verify', '/auth/social', '/auth/login/verify', '/auth/dev-login']);
const COOKIE_LOGOUTS = new Set(['/auth/logout', '/2fa/totp/recovery/complete']);
const clearAuthCookies = (): Promise<unknown> => transport('POST', '/auth/logout', {});

async function request<T>(
  method: string, path: string, body?: unknown, recentAuthGrant?: string,
  rawContentType?: string, signal?: AbortSignal, isCurrent?: () => boolean,
  privateResponse?: 'json' | 'blob',
  deferAuthorityUnavailable = false,
  expectedCurrency?: GameCurrency,
  observeResponseError?: (error: ApiError) => Promise<void>,
): Promise<T> {
  const operation = () => {
    signal?.throwIfAborted();
    if (isCurrent?.() === false) throw new AuthChangedError();
    // Status runs beside stable reads but still excludes cookie issuance. Fence
    // its errors before a delayed response can navigate a newer auth attempt.
    const revision = path === '/auth/login/status' ? authCookies.assertSession() : undefined;
    // Cookie-owning requests are never aborted once dispatched: a browser may
    // still apply their headers. Their coordinator owns response + cleanup.
    return transport<T>(method, path, body, recentAuthGrant, rawContentType, undefined, privateResponse,
      () => { if (revision !== undefined) authCookies.assertResponse(revision); return isCurrent?.() !== false; }, deferAuthorityUnavailable, expectedCurrency);
  };
  if (COOKIE_LOGINS.has(path) || COOKIE_LOGOUTS.has(path) || path === '/auth/login/status') {
    return authCookies.run({
      kind: COOKIE_LOGINS.has(path) ? 'login' : COOKIE_LOGOUTS.has(path) ? 'logout' : 'status',
      operation, clear: clearAuthCookies, ...(isCurrent ? { isCurrent } : {}),
      // This route returns 422 before sendLoginSession, with no Set-Cookie.
      unchangedOnError: (error) => path === '/auth/login/verify' && error instanceof ApiError && error.status === 422,
    });
  }
  // Bootstrap waits for a dirty previous-page transition to be revoked. Game
  // commands never wait then execute under a different wallet's new cookie.
  if (path === '/me' || path.startsWith('/auth/challenge')) await authCookies.ready(clearAuthCookies, signal);
  const revision = authCookies.assertSession();
  const current = (): boolean => { authCookies.assertResponse(revision); return isCurrent?.() !== false; };
  let evidenceTransport: Promise<T> | undefined;
  try {
    return await authCookies.session(() => {
      if (!current()) throw new AuthChangedError();
      const pending = transport<T>(method, path, body, recentAuthGrant, rawContentType, signal, privateResponse, current, deferAuthorityUnavailable, expectedCurrency, observeResponseError);
      if (observeResponseError) evidenceTransport = pending;
      return pending;
    }, signal);
  } finally {
    // The cookie coordinator may release a cancelled caller before transport
    // finishes. An opted-in journal must remain open through its original
    // response/evidence write. Fetch still aborts; no undispatched work waits.
    if (evidenceTransport) await evidenceTransport.catch(() => undefined);
  }
}

export function idemKey(): string {
  return crypto.randomUUID();
}

/** Internal opt-in for unpaid original receipts only. Protocol validation and
 * durable persistence belong to unpaidResources/transport, never UI callbacks.
 * Current-view reads and existing command transports do not use this path. */
type OriginalRequest<T> = {
  method: 'GET' | 'POST'; path: string; body?: unknown; signal?: AbortSignal;
  isCurrent: () => boolean; timeoutMs: number;
  observe: (status: number, body: unknown, headers?: Headers) => Promise<T | undefined>;
};
export function requestUnpaidOriginal<T>(input: OriginalRequest<T>): Promise<T> {
  return requestOriginal(input, 'unpaid');
}
/** Mining uses the same owned response drain, with its own exact endpoint allowlist.
 * Signed bytes are retained by its journal before this transport may submit. */
export function requestMiningClaimOriginal<T>(input: OriginalRequest<T>): Promise<T> {
  return requestOriginal(input, 'mining');
}
/** Realm sales retain original consent under a separate exact endpoint family. */
export function requestRealmSaleOriginal<T>(input: OriginalRequest<T>): Promise<T> {
  return requestOriginal(input, 'exactrealm-sale');
}
export function requestCharterOriginal<T>(input: OriginalRequest<T>): Promise<T> {
  return requestOriginal(input, 'charter');
}
/** Tournament responses retain owned evidence before an obsolete view is rejected. */
export function requestCharterTournamentOriginal<T>(input: OriginalRequest<T>): Promise<T> {
  return requestOriginal(input, 'charter-tournament');
}
export function requestVehicleOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'vehicle'); }
export function requestVehicleCraftOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'vehicle-craft'); }
export function requestDivineTrialOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'divine-trial'); }
export function requestRouteCompassOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'route-compass'); }
export function requestKeepEquipmentOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'keep-equipment'); }
/** D192 original fragment custody receipts use a separate exact endpoint family. */
export function requestDivineFragmentOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'divine-fragment'); }
/** Bound appearances retain the exact original before a stale view is rejected. */
export function requestBoundCosmeticOriginal<T>(input: OriginalRequest<T>): Promise<T> { return requestOriginal(input, 'bound-cosmetic'); }
async function requestOriginal<T>(input: OriginalRequest<T>, family: 'unpaid' | 'mining' | 'exactrealm-sale' | 'charter' | 'charter-tournament' | 'vehicle' | 'vehicle-craft' | 'divine-trial' | 'route-compass' | 'keep-equipment' | 'divine-fragment' | 'bound-cosmetic'): Promise<T> {
  const roots = ['/seeker/resource-claims', '/seeker/shards/claims', '/bases/free-purchases', '/ordinary-crafting/jobs', '/starter-fleet/installations', '/starter-expeditions', '/harvesters/sources', '/mining/contributions'];
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const charterRoot = '/clans/charter/client';
  const charterAllowed = input.method === 'GET'
    ? new RegExp(`^${charterRoot}/(?:creations/${uuid}|sales/(?:by-key/)?${uuid}|activity(?:\\?cursor=[A-Za-z0-9%_.!~*'()-]{1,768})?)$`).test(input.path)
    : input.method === 'POST' && (input.path === `${charterRoot}/creations` || input.path === `${charterRoot}/sales`
      || new RegExp(`^${charterRoot}/(?:creations/${uuid}/(?:prepare|recover-preparation|recover|signed|refund|deliver)|sales/${uuid}/(?:accept|pay-members|prepare|recover-preparation|recover|cancel|signature|deliver))$`).test(input.path));
  // Original-only lifecycle requests share the same auth and late-response
  // retention boundary, with exact routes rather than a general clan prefix.
  const charterLifecycleAllowed = input.method === 'GET'
    ? new RegExp(`^/clans/charter/(?:retirements|migrations)/(?:by-key/)?${uuid}$`).test(input.path)
    : input.method === 'POST' && (['/clans/charter/retirements', '/clans/charter/migrations'].includes(input.path)
      || new RegExp(`^/clans/charter/(?:retirements|migrations)/${uuid}/(?:prepare|recover-preparation|recover|cancel|signed|deliver)$`).test(input.path)
      || new RegExp(`^/clans/charter/retirements/${uuid}/pay-members$`).test(input.path));
  const tournamentRoot = '/clans/charter/tournaments';
  const tournamentAllowed = input.method === 'GET'
    ? new RegExp(`^${tournamentRoot}/(?:events(?:\\?cursor=[A-Za-z0-9%_.!~*'()-]{1,768})?|events/${uuid}(?:/participation|/raids/by-key/${uuid})?|entries/(?:by-key/)?${uuid}|operations/${uuid})$`).test(input.path)
    : input.method === 'POST' && (input.path === `${tournamentRoot}/entries`
      || new RegExp(`^${tournamentRoot}/(?:entries/${uuid}/clear|operations/${uuid}/(?:prepare|recover-preparation|recover|cancel|signed|deliver)|events/${uuid}/(?:raids|raids/by-key/${uuid}/cancel|prize|close)|raids/${uuid}/replay)$`).test(input.path));
  const encoded = "[A-Za-z0-9%_.!~*'()-]{1,768}";
  const vehicleAllowed = input.method === 'GET'
    ? new RegExp(`^/vehicles/client/(?:(?:installations|services)/(?:${uuid}|by-key/${encoded})|(?:activity|assets|assets-v2)(?:\\?cursor=${encoded})?|routes\\?baseId=${uuid}(?:&policyVersion=[12])?)$`).test(input.path)
      || new RegExp(`^/(?:vehicles/fleet\\?baseId=${uuid}|advanced-expeditions/by-key/${uuid})$`).test(input.path)
    : input.method === 'POST' && (['/vehicles/client/installations','/vehicles/client/services','/advanced-expeditions','/advanced-expeditions/collect'].includes(input.path)
      || new RegExp(`^/vehicles/client/(?:installations|services)/${uuid}/(?:prepare|signed|recover|review|deliver)$`).test(input.path));
  const vehicleCraftAllowed = input.method === 'GET'
    ? new RegExp(`^/vehicles/craft/(?:by-key/${uuid}|history(?:\\?cursor=[A-Za-z0-9_-]{1,256})?)$`).test(input.path)
    : input.method === 'POST' && (input.path === '/vehicles/craft/quote' || new RegExp(`^/vehicles/craft/by-key/${uuid}/recover$`).test(input.path));
  const divineAllowed = input.method === 'GET'
    ? new RegExp(`^/divine-trials/(?:events(?:\\?cursor=[A-Za-z0-9_-]{1,256})?|events/${uuid}/participant|attempts/${uuid})$`).test(input.path)
    : input.method === 'POST' && new RegExp(`^/divine-trials/(?:events/${uuid}/(?:entries|attempts|prize)|attempts/${uuid}/(?:submit|abandon))$`).test(input.path);
  const compassFitting = 'fitting=(?:route_compass|survey_lens&resourceId=(?:frost_quartz|heartwood_logs|sunstone_rubble|crown_iron_ore|rough_prism|storm_ore|thorn_fibre|ember_nodules))';
  const compassAllowed = input.method === 'GET'
    ? new RegExp(`^/(?:ordinary-equipment(?:\\?baseId=${uuid}(?:&catalogueVersion=2)?|/jobs/by-key/${uuid})|starter-expeditions(?:\\?baseId=${uuid}&${compassFitting}|/paid-route\\?baseId=${uuid}&realm=[0-7]&${compassFitting}|/by-key/${uuid})|vehicles/fleet\\?baseId=${uuid}|vehicles/client/routes\\?baseId=${uuid}&policyVersion=2&${compassFitting}|advanced-expeditions/by-key/${uuid})$`).test(input.path)
    : input.method === 'POST' && ['/ordinary-equipment/jobs','/starter-expeditions','/advanced-expeditions','/advanced-expeditions/collect'].includes(input.path);
  const marketAllowed = family === 'keep-equipment' && (await import('./keepEquipmentMarket/transport')).keepMarketEndpointAllowed(input.method,input.path);
  const fragmentAllowed = input.method === 'GET'
    ? new RegExp(`^/divine-fragments/(?:deliveries|seeker/claims)/${uuid}$`).test(input.path)
    : input.method === 'POST' && (input.path === '/divine-fragments/seeker/claims' || new RegExp(`^/divine-fragments/events/${uuid}/delivery$`).test(input.path));
  const cosmeticAllowed = input.method === 'GET'
    ? new RegExp(`^/bound-cosmetics/jobs/by-key/${uuid}$`).test(input.path)
    : input.method === 'POST' && (input.path === '/bound-cosmetics/jobs'
      || family === 'bound-cosmetic' && input.path === '/bound-cosmetics/wakes/v1/jobs'
        && (await import('@shardkeep/shared/boundCosmeticApi')).BoundCosmeticRequestSchema
          .refine(value => value.recipeId === 'craft_aurora_wake_v1')
          .safeParse(input.body).success);
  const allowed = family === 'bound-cosmetic' ? cosmeticAllowed : family === 'vehicle-craft' ? vehicleCraftAllowed : family === 'divine-fragment' ? fragmentAllowed : family === 'keep-equipment' ? marketAllowed : family === 'route-compass' ? compassAllowed : family === 'divine-trial'  ? divineAllowed : family === 'vehicle' ? vehicleAllowed : family === 'charter-tournament' ? tournamentAllowed : family === 'charter' ? (charterAllowed || charterLifecycleAllowed) : family === 'unpaid'
    ? roots.some(root => input.method === 'POST' ? input.path === root : input.method === 'GET' && new RegExp(`^${root}/by-key/${uuid}$`).test(input.path))
    : family === 'mining'
      ? input.method === 'POST' ? ['/claims/mining/prepare', '/claims/mining/submit'].includes(input.path) || new RegExp(`^/claims/mining/${uuid}/continue$`).test(input.path)
        : input.method === 'GET' && (new RegExp(`^/claims/mining/(?:prepare/by-key/)?${uuid}$`).test(input.path) || new RegExp(`^/claims/mining/${uuid}/continuation$`).test(input.path))
      : input.method === 'POST' ? ['/seeker/realm-sales/prepare', '/seeker/realm-sales/submit'].includes(input.path)
        : input.method === 'GET' && new RegExp(`^/seeker/realm-sales/(?:prepare/by-key|review/by-key|failures/by-key|by-key)/${uuid}$`).test(input.path);
  if (Object.keys(input).some(key => !['method', 'path', 'body', 'signal', 'isCurrent', 'timeoutMs', 'observe'].includes(key))
    || !allowed
    || (input.method === 'GET' && input.body !== undefined)
    || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('Invalid unpaid original request');
  input.signal?.throwIfAborted();
  const revision = authCookies.assertSession();
  const current = (): void => {
    input.signal?.throwIfAborted(); authCookies.assertResponse(revision);
    if (!input.isCurrent()) throw new AuthChangedError();
  };
  const authorityScopeReader = baseSelectionScope, authorityScope = authorityScopeReader?.();
  let owned: Promise<T> | undefined;
  try {
    return await authCookies.session(() => {
      current(); // Includes the actual enqueue after any cross-tab auth wait.
      owned = (async () => {
        const abort = new AbortController();
        const cancel = (): void => abort.abort(input.signal?.reason);
        input.signal?.addEventListener('abort', cancel, { once: true });
        const deadline = new ApiError(0, 'Original response timed out. Keep the command for recovery.', 'ORIGINAL_RESPONSE_TIMEOUT');
        const timer = setTimeout(() => abort.abort(deadline), input.timeoutMs);
        // Race each network operation as well as aborting fetch: stalled body
        // readers must not retain the cookie lock indefinitely.
        const bounded = <V,>(pending: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
          const stopped = (): void => { cleanup(); reject(abort.signal.reason); };
          const cleanup = (): void => abort.signal.removeEventListener('abort', stopped);
          abort.signal.addEventListener('abort', stopped, { once: true });
          pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
          if (abort.signal.aborted) stopped();
        });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
          const res = await bounded(fetch(`${BASE}${input.path}`, {
            method: input.method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: abort.signal,
            headers: { 'x-sim-version': String(SIM_VERSION), ...(input.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
            body: input.method === 'POST' ? JSON.stringify(input.body) : null,
          }));
          input.signal?.removeEventListener('abort', cancel); // Headers now own a bounded original body drain.
          if (res.redirected || res.status >= 300 && res.status < 400 || !res.body) throw new Error('Invalid original response');
          reader = res.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let bytes = 0, text = '';
          while (true) {
            const part = await bounded(reader.read());
            if (part.done) break;
            bytes += part.value.byteLength;
            // Transport safety bound, not a game number. Includes the largest
            // bounded Harvester event receipt without admitting unbounded JSON.
            if (bytes > (family === 'divine-trial' ? PHASE_E_DIVINE_TRIALS.maxPayloadBytes * (PHASE_E_DIVINE_TRIALS.attemptsPerWallet + 1) : 1_048_576)) throw new Error('Original response exceeds byte limit');
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          const json: unknown = JSON.parse(text);
          clearTimeout(timer);
          // Hold both the cookie lock and returned promise until the original
          // journal commits. Storage/validation failures must never be hidden
          // behind an obsolete-view or cancellation error.
          const proof = await input.observe(res.status, json, res.headers);
          current();
          if (!res.ok) throwResponseError(res, json as ErrorEnvelope, authorityScopeReader, authorityScope);
          if (proof === undefined) throw new Error('Invalid original proof');
          return proof;
        } finally {
          clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
          abort.abort(); void reader?.cancel().catch(() => undefined);
        }
      })();
      return owned;
    }, input.signal);
  } finally {
    // session() allows its caller to cancel early; this evidence owner does not.
    // Await without swallowing errors so a failed durable write stays visible.
    if (owned) await owned;
  }
}

/** Fetch only the stream handshake under the shared auth lock. A never-ending
 * body must not prevent this or another tab from signing out. */
async function openStream(path: string, options: { signal: AbortSignal; isCurrent?: () => boolean }): Promise<Response> {
  const authorityScopeReader = baseSelectionScope;
  const authorityScope = authorityScopeReader?.();
  const revision = authCookies.assertSession();
  let response: Response | undefined;
  const check = (): void => {
    options.signal.throwIfAborted();
    authCookies.assertResponse(revision);
    if (options.isCurrent?.() === false) throw new AuthChangedError();
  };
  try {
    await authCookies.session(async () => {
      response = await transport<Response>('GET', path, undefined, undefined, undefined, options.signal, 'stream');
    });
    const res = response!;
    check();
    if (!res.ok) {
      const json = await res.json().catch(() => ({})) as ErrorEnvelope;
      check();
      throwResponseError(res, json, authorityScopeReader, authorityScope);
    }
    if (!res.body || res.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream') {
      throw new ApiError(0, 'Live raid updates are unavailable.', 'RAID_EVENTS_INVALID');
    }
    return res;
  } catch (error) {
    void response?.body?.cancel().catch(() => undefined);
    throw error;
  }
}

export const api = {
  openStream,
  /** Phase E authenticated entitlement snapshots must bypass browser caches. */
  getPrivate: <T>(path: string, options?: { signal?: AbortSignal; isCurrent?: () => boolean }) =>
    request<T>('GET', path, undefined, undefined, undefined, options?.signal, options?.isCurrent, 'json'),
  waitForAuth: () => authCookies.ready(clearAuthCookies),
  logout: (before?: () => Promise<unknown>, after?: () => Promise<unknown>) => authCookies.run({
    kind: 'logout', operation: clearAuthCookies, clear: clearAuthCookies,
    ...(before ? { before } : {}), ...(after ? { after } : {}),
  }),
  postAuth: <T>(path: string, body: unknown, isCurrent: () => boolean) =>
    request<T>('POST', path, body, undefined, undefined, undefined, isCurrent),
  /** Startup probes may opt into cancellation without imposing a timeout on
   * long-running gameplay or money mutations. */
  get: <T>(path: string, options?: {
    signal?: AbortSignal; isCurrent?: () => boolean;
    /** A background snapshot owns its final delayed-refresh notice. All actual
     * ownership-loss, authentication and land-gate handlers remain immediate. */
    deferAuthorityUnavailable?: boolean;
  }) => request<T>('GET', path, undefined, undefined, undefined, options?.signal, options?.isCurrent,
    undefined, options?.deferAuthorityUnavailable),
  post: <T>(path: string, body?: Record<string, unknown>, options?: { signal?: AbortSignal; isCurrent?: () => boolean; expectedCurrency?: GameCurrency }) =>
    request<T>('POST', path, body && 'idempotencyKey' in body ? body : { ...body, idempotencyKey: idemKey() }, undefined, undefined, options?.signal, options?.isCurrent, undefined, false, options?.expectedCurrency),
  postRaw: <T>(path: string, body?: unknown, options?: { signal?: AbortSignal; isCurrent?: () => boolean; expectedCurrency?: GameCurrency; observeResponseError?: (error: ApiError) => Promise<void> }) =>
    request<T>('POST', path, body, undefined, undefined, options?.signal, options?.isCurrent, undefined, false, options?.expectedCurrency, options?.observeResponseError),
  /** Sensitive action with an already-proved, in-memory recent-auth grant.
   *  Callers provide their own idempotency key when the action needs one so the
   *  exact same key can be bound into the signed intent. */
  postRecent: <T>(path: string, body: unknown, recentAuthGrant: string) =>
    request<T>('POST', path, body, recentAuthGrant),
  put: <T>(path: string, body?: unknown, options?: { signal?: AbortSignal; isCurrent?: () => boolean }) =>
    request<T>('PUT', path, body, undefined, undefined, options?.signal, options?.isCurrent),
  patch: <T>(path: string, body?: unknown, options?: { signal?: AbortSignal }) =>
    request<T>('PATCH', path, body, undefined, undefined, options?.signal),
  /** Binary upload with the caller's verified browser MIME. Avatar upload uses
   *  this instead of multipart so the server can bound and decode one image
   *  body without accepting filenames or extra form fields. */
  patchBinary: <T>(path: string, body: Blob) => request<T>('PATCH', path, body, undefined, body.type),
  /** Private media uses the same session fence and typed errors as JSON reads.
   * Upload callers pin the immutable request ID in their route before sending. */
  postBinary: <T>(path: string, body: Blob, options?: { signal?: AbortSignal }) =>
    request<T>('POST', path, body, undefined, body.type, options?.signal, undefined, 'json'),
  getBlob: (path: string, options?: { signal?: AbortSignal }) =>
    request<Blob>('GET', path, undefined, undefined, undefined, options?.signal, undefined, 'blob'),
  del: <T>(path: string) => request<T>('DELETE', path),
  delRaw: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

// ---------------------------------------------------------------------------
// Tester program DTOs (D-103 Founding Kingdoms). Everything here is SERVER
// truth: points, days and counts are derived from ledgers by apps/api and the
// client only renders them. Fields added in M35 are optional so a client that
// ships ahead of the API cut degrades to the M28 shape instead of crashing.
// ---------------------------------------------------------------------------

export interface TesterMilestoneDto {
  key: string; category: string; title: string; hint: string; points: number; achievedAt: string | null;
}

/** One TESTER_DAILY source or streak, as the catalog rides on /tester/me. */
export interface TesterDailyCatalogEntryDto {
  key: string; category?: string; title: string; hint: string; points: number; cap?: number; days?: number;
}

/** A daily row that fired today: `count` is capped server-side. */
export interface TesterDailyKeyDto { key: string; count: number; points: number }

export interface TesterCampaignDto {
  name: string; totalDays: number; startAt: string | null; endAt: string | null; dayIndex: number | null;
  rewardCopy?: string;
  /** Owner 2026-09-04: a minted Land Deed is the whitelist ticket; points rank past the cap. */
  whitelist?: { requiresLandDeed: boolean; spots: number };
}

export interface TesterReferralsDto { invited: number; qualified: number; activeToday: number }

export interface TesterMeDto {
  wallet: string; name: string | null; points: number; rank: number | null;
  milestonePoints: number; feedbackPoints: number; feedbackCount: number;
  /** A minted Land Deed — whitelist eligibility (PLAYTEST_CAMPAIGN.whitelist). */
  landOwner?: boolean;
  /** All-time daily / referral points (mirror the leaderboard row fields). */
  dailyPoints?: number;
  referralPoints?: number;
  milestones: TesterMilestoneDto[];
  justEarned: Array<{ key: string; points: number }>;
  listed?: boolean;
  /** Human line that says how to get on the public board (only meaningful when !listed). */
  listedReason?: string;
  daily?: {
    todayPoints: number; streakDays: number; byKey: TesterDailyKeyDto[];
    catalog?: { sources: TesterDailyCatalogEntryDto[]; streaks: TesterDailyCatalogEntryDto[] };
  };
  referrals?: TesterReferralsDto;
  campaign?: TesterCampaignDto;
}

export interface TesterBoardDto {
  entries: Array<{
    rank: number; name: string | null; wallet: string; points: number; milestones: number; feedback: number;
    dailyPoints?: number; referralPoints?: number;
  }>;
  totals: { testers: number; points: number; feedback: number };
  campaign?: TesterCampaignDto;
}
