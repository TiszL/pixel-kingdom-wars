import { TROOP_TYPES, TROOP_LEVELING, LAND_CHECKOUT_RECOVERY, type TroopType } from '@shardkeep/shared';
import { ResearchSpeedupIntentSchema, type ResearchSpeedupIntent } from '@shardkeep/shared/researchSpeedup';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BalancesDto, type BaseStateDto } from '../../state/store';
import { api, API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { assertGameCurrency, chooseGameCurrency } from '../gameCurrency';
import { researchSpeedupLock, type ResearchSpeedupPorts, type ResearchReviewInput } from './controller';
import { parseResearchSpeedupIdentity, parseResearchRefusal, same, type ResearchSpeedupIdentity, type ResearchRefusal } from './journal';
const object = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Research account details did not refresh.'); return raw as Record<string, unknown>; };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
export type ResearchQuote = Pick<ResearchSpeedupIntent, 'currentLevel' | 'toLevel' | 'finishesAt' | 'episodeId' | 'maxCostKeep'>;
export type ResearchMoneyRow = { troop: TroopType; toLevel: number; finishesAt: string; episodeId: string | null; finishQuote: ResearchQuote | null };
export type ResearchMoneyArmy = { levels: Record<string, number>; research: ResearchMoneyRow[] };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
function army(raw: unknown): ResearchMoneyArmy {
  const r = object(raw), features = object(r.features), levels = object(r.levels);
  if (object(features.researchConsent).version !== 1 || object(features.researchSpeedupReceipts).version !== 1 || !Array.isArray(r.research)) throw new Error('This server cannot prove the reviewed research payment. Update before paying.');
  const research = r.research.map(value => {
    const row = object(value), level = levels[String(row.troop)], quote = row.finishQuote === null ? null : object(row.finishQuote);
    if (!(TROOP_TYPES as readonly unknown[]).includes(row.troop) || !count(level) || level < 1 || level >= TROOP_LEVELING.maxLevel
      || row.toLevel !== level + 1 || !timestamp(row.finishesAt) || row.episodeId !== null && !uuid(row.episodeId)
      || quote && (Object.keys(quote).length !== 5 || quote.currentLevel !== level || quote.toLevel !== row.toLevel
        || quote.finishesAt !== row.finishesAt || quote.episodeId !== row.episodeId || !amount(quote.maxCostKeep) || BigInt(quote.maxCostKeep) <= 0n)) throw new Error('The original research episode or server quote is invalid.');
    return row as unknown as ResearchMoneyRow;
  });
  if (new Set(research.map(row => row.troop)).size !== research.length) throw new Error('Research contains duplicate episodes.');
  return { levels: levels as Record<string, number>, research };
}
function funds(raw: unknown): BalancesDto {
  const r = object(raw);
  if (!amount(r.keep) || !amount(r.shards) || r.gems !== undefined && !amount(r.gems) || !count(r.keepRate) || r.keepRate === 0) throw new Error('Research balances did not refresh.');
  return r as unknown as BalancesDto;
}
function directory(raw: unknown) {
  const r = object(raw), c = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof c.baseScopedReads !== 'boolean' || typeof c.baseScopedMutations !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Research ownership did not refresh.');
  const rows = r.bases.map(object);
  if (rows.some(b => typeof b.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.id) || !['active', 'inactive'].includes(String(b.status))
    || !(b.slot === null || count(b.slot) && b.slot > 0)) || new Set(rows.map(b => b.id)).size !== rows.length) throw new Error('Research ownership is invalid.');
  return { enabled: r.enabled, reads: c.baseScopedReads, mutations: c.baseScopedMutations,
    owned: rows.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
const readable = (owned: ReturnType<typeof directory>, id: string | null): boolean => id !== null && owned.enabled && owned.reads && owned.owned.includes(id);
async function readContext(identity: ResearchSpeedupIdentity, ports: Pick<ResearchSpeedupPorts, 'get'>, baseId: string | null, guard: () => void, includeBase: boolean) {
  const read = async (path: string) => { guard(); const result = await ports.get(path, guard); guard(); return result; };
  if (object(await read('/me')).wallet !== identity.wallet) throw new Error('The original Research account did not refresh.');
  const before = directory(await read('/bases'));
  if (!readable(before, baseId)) return null;
  const suffix = `?baseId=${encodeURIComponent(baseId!)}`;
  let base: BaseStateDto | null = null;
  if (includeBase) {
    const raw = object(await read(`/base${suffix}`)), player = object(raw.player);
    if (raw.baseId !== baseId || player.wallet !== identity.wallet || !count(player.keepLevel) || player.keepLevel < 1 || !Array.isArray(raw.buildings)
      || !Array.isArray(raw.army) || !Array.isArray(raw.jobs) || !Array.isArray(raw.obstacles)) throw new Error('Research base did not refresh.');
    base = raw as unknown as BaseStateDto;
  }
  const research = army(await read(`/army${suffix}`)), balances = funds(await read(`/balances${suffix}`));
  if (object(await read('/me')).wallet !== identity.wallet || !same(before, directory(await read('/bases')))) throw new Error('Research ownership changed during refresh.');
  if (base) for (const unit of base.army) {
    if (unit.level !== undefined && research.levels[unit.troop] !== unit.level) throw new Error('Research changed during the base refresh. Read it again.');
  }
  return { base, research, balances, mutations: before.mutations };
}
function price(input: ResearchReviewInput, research: ResearchMoneyArmy) {
  const row = research.research.find(row => row.troop === input.troop);
  if (!row?.finishQuote) throw new Error('This research has no current server finish quote. Refresh the original base.');
  return row.finishQuote;
}
export const researchSpeedupIdentity = (wallet: string): ResearchSpeedupIdentity => parseResearchSpeedupIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });
export function createResearchSpeedupBrowserPorts(input: { identity: ResearchSpeedupIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): ResearchSpeedupPorts {
  const request = async (guard: () => void, send: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    catch (error) { if (abort.signal.aborted) throw new Error('Research request timed out. Keep the original command for recovery.'); throw error; }
    finally { clearTimeout(timer); }
  };
  const get: ResearchSpeedupPorts['get'] = (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const context = async (intent: ResearchReviewInput, guard: () => void) => {
    const result = await readContext(input.identity, { get }, intent.baseId, guard, false);
    if (!result || !result.mutations) throw new Error('The original Research base is unavailable for new actions.'); return result;
  };
  return {
    capture: baseId => {
      const identity = researchSpeedupIdentity(input.identity.wallet);
      if (!same(parseResearchSpeedupIdentity(input.identity), identity)) throw new Error('This Research journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch, selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch)) throw new Error('The account, base or Research view changed. Check the original receipt.');
      };
    },
    get, post: (path, body, currency, guard, observeResponseError) => request(guard, signal => api.postRaw(path, body, { signal, expectedCurrency: currency, ...(observeResponseError ? { observeResponseError } : {}), isCurrent: () => { guard(); return true; } })),
    lock: researchSpeedupLock, key: () => crypto.randomUUID(),
    prepare: async (review, key, guard) => {
      const result = await context(review, guard), quote = price(review, result.research);
      return ResearchSpeedupIntentSchema.parse({ ...review, ...quote, idempotencyKey: key, expectedCurrency: chooseGameCurrency(quote.maxCostKeep, result.balances) });
    },
    validate: async (intent, guard) => {
      const result = await context(intent, guard), quote = price(intent, result.research);
      if (quote.currentLevel !== intent.currentLevel || quote.toLevel !== intent.toLevel || quote.finishesAt !== intent.finishesAt || quote.episodeId !== intent.episodeId) throw new Error('The original research episode changed. Check its saved receipt.');
      if (BigInt(quote.maxCostKeep) > BigInt(intent.maxCostKeep)) throw new Error('The Research price exceeds the original confirmation.');
      assertGameCurrency(intent.expectedCurrency, quote.maxCostKeep, result.balances);
    },
    definitiveRefusal: (error, intent): ResearchRefusal | null => {
      if (!(error instanceof ApiError)) return null;
      if (error.code === 'CURRENCY_CONSENT_CHANGED' && error.details?.expectedCurrency !== intent.expectedCurrency) return null;
      try { return parseResearchRefusal({ status: error.status, code: error.code }); } catch { return null; }
    },
  };
}
/** Receipt history is independent of today's selected base. Publish current
 * research/base/balances only from fresh, bracketed ownership reads, atomically. */
export async function refreshResearchSpeedupSnapshot(identity: ResearchSpeedupIdentity, ports: ResearchSpeedupPorts) {
  const scope = captureBaseSnapshotGuard(), session = ports.capture();
  const guard = () => { session(); if (scope.wallet !== identity.wallet || !isBaseSnapshotGuardCurrent(scope)) throw new Error('The Research account or selected base changed.'); };
  const commit = scope.selectedBaseId ? captureBaseSnapshotCommit(scope.selectedBaseId, scope) : null;
  const result = await readContext(identity, ports, scope.selectedBaseId, guard, true); guard();
  if (!result?.base || !commit) return null;
  if (!commit(result.base, result.balances)) throw new Error('A newer base refresh replaced this Research view. Refresh again.');
  return { research: result.research, balances: result.balances };
}
