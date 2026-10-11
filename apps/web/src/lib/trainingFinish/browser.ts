import { TROOP_TYPES, TRAINING_SCHEDULE, LAND_CHECKOUT_RECOVERY, type TroopType } from '@shardkeep/shared';
import { TrainingFinishIntentSchema, type TrainingFinishIntent } from '@shardkeep/shared/trainingFinish';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BalancesDto, type BaseStateDto } from '../../state/store';
import { api, API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { assertGameCurrency, chooseGameCurrency } from '../gameCurrency';
import { trainingFinishLock, type TrainingFinishPorts, type TrainingReviewInput } from './controller';
import { parseTrainingFinishIdentity, parseTrainingRefusal, same, type TrainingFinishIdentity, type TrainingRefusal } from './journal';
const object = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Training account details did not refresh.'); return raw as Record<string, unknown>; };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
export type TrainingQuote = TrainingFinishIntent['consent'];
export type TrainingMoneyArmy = { counts: Record<string, number>; levels: Record<string, number>;
  queue: Array<TrainingQuote['queue'][number] & { troop: TroopType }>;
  finishAllQuote: TrainingQuote; paidAvailable: boolean };
const quoteSchema = TrainingFinishIntentSchema.shape.consent;
function army(raw: unknown): TrainingMoneyArmy {
  const r = object(raw), features = object(r.features), scheduling = object(features.trainingScheduling);
  if (object(features.trainingFinishReceipts).version !== 1 || scheduling.version !== TRAINING_SCHEDULE.version
    || scheduling.mode !== 'sequential' || scheduling.lanes !== TRAINING_SCHEDULE.lanesPerBase || scheduling.consentRequired !== true
    || !Array.isArray(r.queue)) throw new Error('This server cannot prove the reviewed training payment. Update before paying.');
  const counts = object(r.counts), levels = object(r.levels);
  if ([counts, levels].some(values => Object.entries(values).some(([troop, value]) => !(TROOP_TYPES as readonly string[]).includes(troop) || !count(value)))
    || Object.values(levels).some(value => value === 0)) throw new Error('Training roster did not refresh.');
  const queue = r.queue.map(value => {
    const row = object(value);
    if (!(TROOP_TYPES as readonly unknown[]).includes(row.troop)) throw new Error('Training contains an unknown troop.');
    return { ...quoteSchema.shape.queue.element.parse({ id: row.id, startedAt: row.startedAt, finishesAt: row.finishesAt }), troop: row.troop as TroopType };
  });
  const rawQuote = object(r.finishAllQuote);
  const finishAllQuote = queue.length ? quoteSchema.parse(rawQuote) : (() => {
    if (Object.keys(rawQuote).length !== 3 || rawQuote.version !== TRAINING_SCHEDULE.version || rawQuote.maxCostKeep !== '0'
      || !Array.isArray(rawQuote.queue) || rawQuote.queue.length) throw new Error('Empty training queue has an invalid quote.');
    return { version: TRAINING_SCHEDULE.version, queue: [], maxCostKeep: '0' };
  })();
  if (!same(queue.map(({ troop: _troop, ...row }) => row), finishAllQuote.queue)) throw new Error('Training quote does not match the complete current queue.');
  // Missing or ambiguous free eligibility never turns into permission to charge.
  return { counts: counts as Record<string, number>, levels: levels as Record<string, number>, queue, finishAllQuote,
    paidAvailable: r.freeFinishAllOffer === null && r.freeFinishAllReviewRequired === false };
}
function funds(raw: unknown): BalancesDto {
  const r = object(raw);
  if (!amount(r.keep) || !amount(r.shards) || r.gems !== undefined && !amount(r.gems) || !count(r.keepRate) || r.keepRate === 0) throw new Error('Training balances did not refresh.');
  return r as unknown as BalancesDto;
}
function directory(raw: unknown) {
  const r = object(raw), c = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof c.baseScopedReads !== 'boolean' || typeof c.baseScopedMutations !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Training ownership did not refresh.');
  const rows = r.bases.map(object);
  if (rows.some(b => typeof b.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(b.id) || !['active', 'inactive'].includes(String(b.status))
    || !(b.slot === null || count(b.slot) && b.slot > 0)) || new Set(rows.map(b => b.id)).size !== rows.length) throw new Error('Training ownership is invalid.');
  return { enabled: r.enabled, reads: c.baseScopedReads, mutations: c.baseScopedMutations,
    owned: rows.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
const readable = (owned: ReturnType<typeof directory>, id: string | null): boolean => id !== null && owned.enabled && owned.reads && owned.owned.includes(id);
async function readContext(identity: TrainingFinishIdentity, ports: Pick<TrainingFinishPorts, 'get'>, baseId: string | null, guard: () => void, includeBase: boolean) {
  const read = async (path: string) => { guard(); const result = await ports.get(path, guard); guard(); return result; };
  if (object(await read('/me')).wallet !== identity.wallet) throw new Error('The original Training account did not refresh.');
  const before = directory(await read('/bases'));
  if (!readable(before, baseId)) return null;
  const suffix = `?baseId=${encodeURIComponent(baseId!)}`;
  let base: BaseStateDto | null = null;
  if (includeBase) {
    const raw = object(await read(`/base${suffix}`)), player = object(raw.player);
    if (raw.baseId !== baseId || player.wallet !== identity.wallet || !count(player.keepLevel) || player.keepLevel < 1 || !Array.isArray(raw.buildings)
      || !Array.isArray(raw.army) || !Array.isArray(raw.jobs) || !Array.isArray(raw.obstacles)) throw new Error('Training base did not refresh.');
    base = raw as unknown as BaseStateDto;
  }
  const training = army(await read(`/army${suffix}`)), balances = funds(await read(`/balances${suffix}`));
  if (object(await read('/me')).wallet !== identity.wallet || !same(before, directory(await read('/bases')))) throw new Error('Training ownership changed during refresh.');
  if (base) for (const unit of base.army) {
    if ((training.counts[unit.troop] ?? 0) !== unit.count || unit.level !== undefined && training.levels[unit.troop] !== unit.level) throw new Error('Training changed during the base refresh. Read it again.');
  }
  if (base && Object.entries(training.counts).some(([troop, held]) => (base.army.find(unit => unit.troop === troop)?.count ?? 0) !== held)) throw new Error('Training changed during the base refresh. Read it again.');
  return { base, training, balances, mutations: before.mutations };
}
function price(training: TrainingMoneyArmy): TrainingQuote {
  if (!training.paidAvailable) throw new Error('Resolve the server free Finish All offer or eligibility review before a paid command.');
  if (!training.queue.length || BigInt(training.finishAllQuote.maxCostKeep) <= 0n) throw new Error('There is no current paid training quote. Check the original receipt.');
  return training.finishAllQuote;
}
export const trainingFinishIdentity = (wallet: string): TrainingFinishIdentity => parseTrainingFinishIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });
export function createTrainingFinishBrowserPorts(input: { identity: TrainingFinishIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): TrainingFinishPorts {
  const request = async (guard: () => void, send: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    catch (error) { if (abort.signal.aborted) throw new Error('Training request timed out. Keep the original command for recovery.'); throw error; }
    finally { clearTimeout(timer); }
  };
  const get: TrainingFinishPorts['get'] = (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const context = async (intent: TrainingReviewInput, guard: () => void) => {
    const result = await readContext(input.identity, { get }, intent.baseId, guard, false);
    if (!result || !result.mutations) throw new Error('The original Training base is unavailable for new actions.'); return result;
  };
  return {
    capture: baseId => {
      const identity = trainingFinishIdentity(input.identity.wallet);
      if (!same(parseTrainingFinishIdentity(input.identity), identity)) throw new Error('This Training journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch, selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch)) throw new Error('The account, base or Training view changed. Check the original receipt.');
      };
    },
    get, post: (path, body, currency, guard, observeResponseError) => request(guard, signal => api.postRaw(path, body, { signal, expectedCurrency: currency, ...(observeResponseError ? { observeResponseError } : {}), isCurrent: () => { guard(); return true; } })),
    lock: trainingFinishLock, key: () => crypto.randomUUID(),
    prepare: async (review, key, guard) => {
      const result = await context(review, guard), quote = price(result.training);
      return TrainingFinishIntentSchema.parse({ ...review, consent: quote, idempotencyKey: key, expectedCurrency: chooseGameCurrency(quote.maxCostKeep, result.balances) });
    },
    validate: async (intent, guard) => {
      const result = await context(intent, guard), quote = price(result.training);
      // Only an unchanged subset can still be the original queue. Missing rows
      // may have naturally completed or been cancelled; the server distinguishes
      // them under the queue lock. Never replace the persisted original consent.
      if (!quote.queue.every(row => intent.consent.queue.some(original => same(original, row)))) throw new Error('The original training queue changed. Check its saved receipt.');
      if (BigInt(quote.maxCostKeep) > BigInt(intent.consent.maxCostKeep)) throw new Error('The Training price exceeds the original confirmation.');
      assertGameCurrency(intent.expectedCurrency, quote.maxCostKeep, result.balances);
    },
    definitiveRefusal: (error, intent): TrainingRefusal | null => {
      if (!(error instanceof ApiError)) return null;
      if (error.code === 'CURRENCY_CONSENT_CHANGED' && error.details?.expectedCurrency !== intent.expectedCurrency) return null;
      try { return parseTrainingRefusal({ status: error.status, code: error.code }); } catch { return null; }
    },
  };
}
/** Receipt history is independent of today's selected base. Publish current
 * training/base/balances only from fresh, bracketed ownership reads, atomically. */
export async function refreshTrainingFinishSnapshot(identity: TrainingFinishIdentity, ports: TrainingFinishPorts) {
  const scope = captureBaseSnapshotGuard(), session = ports.capture();
  const guard = () => { session(); if (scope.wallet !== identity.wallet || !isBaseSnapshotGuardCurrent(scope)) throw new Error('The Training account or selected base changed.'); };
  const commit = scope.selectedBaseId ? captureBaseSnapshotCommit(scope.selectedBaseId, scope) : null;
  const result = await readContext(identity, ports, scope.selectedBaseId, guard, true); guard();
  if (!result?.base || !commit) return null;
  if (!commit(result.base, result.balances)) throw new Error('A newer base refresh replaced this Training view. Refresh again.');
  return { training: result.training, balances: result.balances };
}
