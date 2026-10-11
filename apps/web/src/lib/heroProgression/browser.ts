import { HERO_KEYS, HERO_LEVELING, LAND_CHECKOUT_RECOVERY, type HeroKey } from '@shardkeep/shared';
import { HeroProgressionIntentSchema, type HeroProgressionIntent } from '@shardkeep/shared/heroProgression';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BalancesDto, type BaseStateDto } from '../../state/store';
import { api, API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { assertGameCurrency, chooseGameCurrency } from '../gameCurrency';
import { heroProgressionLock, type HeroProgressionPorts, type HeroReviewInput } from './controller';
import { parseHeroProgressionIdentity, parseHeroRefusal, same, type HeroProgressionIdentity, type HeroRefusal } from './journal';
const object = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Hero account details did not refresh.'); return raw as Record<string, unknown>; };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
export type HeroMoneyRow = { hero: HeroKey; recruited: boolean; level: number; available: boolean; recoveryUntil: string | null;
  next: { level: number; costKeep: string } | null; recoveryFinishNow: { costKeep: string; remainingSec: number; affordable: boolean } | null };
export type HeroMoneyRoster = { heroes: HeroMoneyRow[]; keepLevel: number; keepBalance: string };
function roster(raw: unknown): HeroMoneyRoster {
  const r = object(raw), features = object(r.features);
  if (object(features.heroConsent).version !== 1 || object(features.heroReceipts).version !== 1 || !Array.isArray(r.heroes)
    || !amount(r.keepBalance) || !count(r.keepLevel) || r.keepLevel < 1) throw new Error('This server cannot prove the reviewed Hero payment. Update before paying.');
  const heroes = r.heroes.map(value => {
    const h = object(value), next = h.next === null ? null : object(h.next), recovery = h.recoveryFinishNow === null ? null : object(h.recoveryFinishNow);
    if (!(HERO_KEYS as readonly unknown[]).includes(h.hero) || typeof h.recruited !== 'boolean' || !count(h.level) || h.level < 1 || h.level > HERO_LEVELING.maxLevel
      || typeof h.available !== 'boolean' || h.recoveryUntil !== null && !timestamp(h.recoveryUntil)
      || next && (next.level !== h.level + 1 || !amount(next.costKeep) || BigInt(next.costKeep) <= 0n)
      || recovery && (!timestamp(h.recoveryUntil) || !amount(recovery.costKeep) || BigInt(recovery.costKeep) <= 0n || !count(recovery.remainingSec) || recovery.remainingSec === 0 || typeof recovery.affordable !== 'boolean')) throw new Error('The original Hero roster is invalid.');
    return h as unknown as HeroMoneyRow;
  });
  if (new Set(heroes.map(h => h.hero)).size !== heroes.length) throw new Error('Hero roster contains duplicate entries.');
  return { heroes, keepLevel: r.keepLevel, keepBalance: r.keepBalance };
}
function funds(raw: unknown): BalancesDto {
  const r = object(raw);
  if (!amount(r.keep) || !amount(r.shards) || r.gems !== undefined && !amount(r.gems) || !count(r.keepRate) || r.keepRate === 0) throw new Error('Hero balances did not refresh.');
  return r as unknown as BalancesDto;
}
function directory(raw: unknown) {
  const r = object(raw), c = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof c.baseScopedReads !== 'boolean' || typeof c.baseScopedMutations !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Hero ownership did not refresh.');
  const rows = r.bases.map(object);
  if (rows.some(b => typeof b.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.id) || !['active', 'inactive'].includes(String(b.status))
    || !(b.slot === null || count(b.slot) && b.slot > 0)) || new Set(rows.map(b => b.id)).size !== rows.length) throw new Error('Hero ownership is invalid.');
  return { enabled: r.enabled, reads: c.baseScopedReads, mutations: c.baseScopedMutations,
    owned: rows.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
const readable = (owned: ReturnType<typeof directory>, id: string | null): boolean => id !== null && owned.enabled && owned.reads && owned.owned.includes(id);
async function readContext(identity: HeroProgressionIdentity, ports: Pick<HeroProgressionPorts, 'get'>, baseId: string | null, guard: () => void, includeBase: boolean) {
  const read = async (path: string) => { guard(); const result = await ports.get(path, guard); guard(); return result; };
  if (object(await read('/me')).wallet !== identity.wallet) throw new Error('The original Hero account did not refresh.');
  const before = directory(await read('/bases'));
  if (!readable(before, baseId)) return null;
  const suffix = `?baseId=${encodeURIComponent(baseId!)}`;
  let base: BaseStateDto | null = null;
  if (includeBase) {
    const raw = object(await read(`/base${suffix}`)), player = object(raw.player);
    if (raw.baseId !== baseId || player.wallet !== identity.wallet || !count(player.keepLevel) || player.keepLevel < 1 || !Array.isArray(raw.buildings)
      || !Array.isArray(raw.army) || !Array.isArray(raw.jobs) || !Array.isArray(raw.obstacles)) throw new Error('Hero base did not refresh.');
    base = raw as unknown as BaseStateDto;
  }
  const heroes = roster(await read(`/heroes${suffix}`)), balances = funds(await read(`/balances${suffix}`));
  if (object(await read('/me')).wallet !== identity.wallet || !same(before, directory(await read('/bases')))) throw new Error('Hero ownership changed during refresh.');
  if (base?.heroes) for (const h of heroes.heroes.filter(h => h.recruited)) {
    const current = base.heroes.find(row => row.hero === h.hero);
    if (!current || current.level !== undefined && current.level !== h.level || current.available !== h.available || current.recoveryUntil !== h.recoveryUntil) throw new Error('Hero state changed during refresh. Read it again.');
  }
  return { base, heroes, balances, mutations: before.mutations };
}
function price(input: HeroReviewInput, heroes: HeroMoneyRoster) {
  const row = heroes.heroes.find(h => h.hero === input.hero);
  if (!row?.recruited) throw new Error('This Hero is not recruited on the original base.');
  if (input.kind === 'upgrade') {
    if (!row.next) throw new Error('This Hero has no further level to purchase.');
    return { row, cost: row.next.costKeep };
  }
  if (!row.recoveryUntil || !row.recoveryFinishNow || row.available) throw new Error('This Hero no longer needs paid recovery. Refresh the roster.');
  return { row, cost: row.recoveryFinishNow.costKeep };
}
export const heroProgressionIdentity = (wallet: string): HeroProgressionIdentity => parseHeroProgressionIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });
export function createHeroProgressionBrowserPorts(input: { identity: HeroProgressionIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): HeroProgressionPorts {
  const request = async (guard: () => void, send: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    catch (error) { if (abort.signal.aborted) throw new Error('Hero request timed out. Keep the original command for recovery.'); throw error; }
    finally { clearTimeout(timer); }
  };
  const get: HeroProgressionPorts['get'] = (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const context = async (intent: HeroReviewInput, guard: () => void) => {
    const result = await readContext(input.identity, { get }, intent.baseId, guard, false);
    if (!result || !result.mutations) throw new Error('The original Hero base is unavailable for new actions.'); return result;
  };
  return {
    capture: baseId => {
      const identity = heroProgressionIdentity(input.identity.wallet);
      if (!same(parseHeroProgressionIdentity(input.identity), identity)) throw new Error('This Hero journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch, selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch)) throw new Error('The account, base or Hero view changed. Check the original receipt.');
      };
    },
    get, post: (path, body, currency, guard, observeResponseError) => request(guard, signal => api.postRaw(path, body, { signal, expectedCurrency: currency, isCurrent: () => { guard(); return true; }, ...(observeResponseError ? { observeResponseError } : {}) })),
    lock: heroProgressionLock, key: () => crypto.randomUUID(),
    prepare: async (review, key, guard) => {
      const result = await context(review, guard), { row, cost } = price(review, result.heroes);
      return HeroProgressionIntentSchema.parse({ ...review, idempotencyKey: key, maxCostKeep: cost, expectedCurrency: chooseGameCurrency(cost, result.balances),
        ...(review.kind === 'upgrade' ? { expectedLevel: row.level } : { recoveryUntil: row.recoveryUntil }) });
    },
    validate: async (intent, guard) => {
      const result = await context(intent, guard), { row, cost } = price(intent, result.heroes);
      if (intent.kind === 'upgrade' ? row.level !== intent.expectedLevel : row.recoveryUntil !== intent.recoveryUntil) throw new Error('The original Hero level or recovery episode changed. Check its saved receipt.');
      if (BigInt(cost) > BigInt(intent.maxCostKeep)) throw new Error('The Hero price exceeds the original confirmation.');
      assertGameCurrency(intent.expectedCurrency, cost, result.balances);
    },
    definitiveRefusal: (error, intent): HeroRefusal | null => {
      if (!(error instanceof ApiError)) return null;
      if (error.code === 'CURRENCY_CONSENT_CHANGED' && error.details?.expectedCurrency !== intent.expectedCurrency) return null;
      try { return parseHeroRefusal({ status: error.status, code: error.code }, intent.kind); } catch { return null; }
    },
  };
}
/** Receipt history is independent of today's selected base. Publish current
 * roster/base/balances only from fresh, bracketed ownership reads, atomically. */
export async function refreshHeroProgressionSnapshot(identity: HeroProgressionIdentity, ports: HeroProgressionPorts) {
  const scope = captureBaseSnapshotGuard(), session = ports.capture();
  const guard = () => { session(); if (scope.wallet !== identity.wallet || !isBaseSnapshotGuardCurrent(scope)) throw new Error('The Hero account or selected base changed.'); };
  const commit = scope.selectedBaseId ? captureBaseSnapshotCommit(scope.selectedBaseId, scope) : null;
  const result = await readContext(identity, ports, scope.selectedBaseId, guard, true); guard();
  if (!result?.base || !commit) return null;
  if (!commit(result.base, result.balances)) throw new Error('A newer base refresh replaced this Hero view. Refresh again.');
  return { heroes: result.heroes, balances: result.balances };
}
