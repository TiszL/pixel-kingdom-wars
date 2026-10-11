import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { BuilderJobSpeedupConsentSchema, BuilderJobSpeedupIntentSchema, type BuilderJobSpeedupConsent } from '@shardkeep/shared/builderJobSpeedup';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotCommit } from '../../state/baseSnapshot';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp, type BalancesDto, type BaseStateDto } from '../../state/store';
import { api, API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { mutationGate } from '../mutationGate';
import { assertGameCurrency, chooseGameCurrency } from '../gameCurrency';
import { builderJobSpeedupLock, type BuilderJobSpeedupPorts, type BuilderReviewInput } from './controller';
import { parseBuilderJobSpeedupIdentity, parseBuilderRefusal, same, type BuilderJobSpeedupIdentity, type BuilderRefusal } from './journal';
const object = (raw: unknown): Record<string, unknown> => { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Builder account details did not refresh.'); return raw as Record<string, unknown>; };
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
function funds(raw: unknown): BalancesDto {
  const r = object(raw);
  if (!amount(r.keep) || !amount(r.shards) || r.gems !== undefined && !amount(r.gems) || !count(r.keepRate) || r.keepRate === 0) throw new Error('Builder balances did not refresh.');
  return r as unknown as BalancesDto;
}
function directory(raw: unknown) {
  const r = object(raw), c = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof c.baseScopedReads !== 'boolean' || typeof c.baseScopedMutations !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Builder ownership did not refresh.');
  const rows = r.bases.map(object);
  if (rows.some(b => !uuid(b.id) || !['active', 'inactive'].includes(String(b.status)) || !(b.slot === null || count(b.slot) && b.slot > 0))
    || new Set(rows.map(b => b.id)).size !== rows.length) throw new Error('Builder ownership is invalid.');
  return { enabled: r.enabled, reads: c.baseScopedReads, mutations: c.baseScopedMutations,
    owned: rows.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
async function readContext(identity: BuilderJobSpeedupIdentity, ports: Pick<BuilderJobSpeedupPorts, 'get'>, baseId: string | null, guard: () => void) {
  const read = async (path: string) => { guard(); const result = await ports.get(path, guard); guard(); return result; };
  if (object(await read('/me')).wallet !== identity.wallet) throw new Error('The original Builder account did not refresh.');
  const before = directory(await read('/bases'));
  if (!baseId || !before.enabled || !before.reads || !before.owned.includes(baseId)) return null;
  const suffix = `?baseId=${encodeURIComponent(baseId)}`;
  const raw = object(await read(`/base${suffix}`)), player = object(raw.player);
  if (raw.baseId !== baseId || player.wallet !== identity.wallet || !count(player.keepLevel) || player.keepLevel < 1
    || !Array.isArray(raw.buildings) || !Array.isArray(raw.army) || !Array.isArray(raw.jobs) || !Array.isArray(raw.obstacles)) throw new Error('Builder base did not refresh.');
  const balances = funds(await read(`/balances${suffix}`));
  if (object(await read('/me')).wallet !== identity.wallet || !same(before, directory(await read('/bases')))) throw new Error('Builder ownership changed during refresh.');
  return { base: raw as unknown as BaseStateDto, balances, mutations: before.mutations };
}
/** The selected row and its server quote must describe the same complete episode.
 * Initial construction's free verdict never becomes a paid fallback. */
export function builderPaidQuote(raw: unknown, jobId: string): BuilderJobSpeedupConsent {
  const base = object(raw), capability = object(object(base.features).builderJobSpeedup);
  if (capability.version !== 1 || capability.receipts !== 1 || !Array.isArray(base.jobs)) throw new Error('This server cannot prove a reviewed builder payment. Update before paying.');
  const jobs = base.jobs.map(object);
  if (jobs.some(j => !uuid(j.id)) || new Set(jobs.map(j => j.id)).size !== jobs.length) throw new Error('Builder jobs did not refresh.');
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.kind === 'build' || job.finishCostKeep === '0') throw new Error('This job has no paid finish. Keep initial construction on its free path.');
  const quote = BuilderJobSpeedupConsentSchema.parse(job.paidFinishQuote);
  if (job.kind !== quote.kind || job.buildingId !== quote.buildingId || job.obstacleId !== quote.obstacleId
    || job.startedAt !== quote.startedAt || job.finishesAt !== quote.finishesAt || job.finishCostKeep !== quote.maxCostKeep)
    throw new Error('Builder quote differs from the original job. Refresh again.');
  return quote;
}
export const builderJobSpeedupIdentity = (wallet: string): BuilderJobSpeedupIdentity => parseBuilderJobSpeedupIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });
export function createBuilderJobSpeedupBrowserPorts(input: { identity: BuilderJobSpeedupIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): BuilderJobSpeedupPorts {
  const request = async (guard: () => void, send: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    catch (error) { if (abort.signal.aborted) throw new Error('Builder request timed out. Keep the original command for recovery.'); throw error; }
    finally { clearTimeout(timer); }
  };
  const get: BuilderJobSpeedupPorts['get'] = (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const context = async (intent: BuilderReviewInput, guard: () => void) => {
    const result = await readContext(input.identity, { get }, intent.baseId, guard);
    if (!result || !result.mutations) throw new Error('The original Builder base is unavailable for new actions.'); return result;
  };
  return {
    capture: baseId => {
      const identity = builderJobSpeedupIdentity(input.identity.wallet);
      if (!same(parseBuilderJobSpeedupIdentity(input.identity), identity)) throw new Error('This Builder journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch, selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch)) throw new Error('The account, base or Builder view changed. Check the original receipt.');
      };
    },
    get, post: (path, body, currency, guard, observeResponseError) => request(guard, signal => api.postRaw(path, body, { signal, expectedCurrency: currency, ...(observeResponseError ? { observeResponseError } : {}), isCurrent: () => { guard(); return true; } })),
    lock: builderJobSpeedupLock, key: () => crypto.randomUUID(),
    prepare: async (review, key, guard) => {
      const result = await context(review, guard), quote = builderPaidQuote(result.base, review.jobId);
      return BuilderJobSpeedupIntentSchema.parse({ ...review, consent: quote, idempotencyKey: key, expectedCurrency: chooseGameCurrency(quote.maxCostKeep, result.balances) });
    },
    validate: async (intent, guard) => {
      const result = await context(intent, guard), quote = builderPaidQuote(result.base, intent.jobId);
      if (!same({ ...quote, maxCostKeep: intent.consent.maxCostKeep }, intent.consent)) throw new Error('The original builder job changed. Check its saved receipt.');
      if (BigInt(quote.maxCostKeep) > BigInt(intent.consent.maxCostKeep)) throw new Error('The Builder price exceeds the original confirmation.');
      assertGameCurrency(intent.expectedCurrency, quote.maxCostKeep, result.balances);
    },
    definitiveRefusal: (error, intent): BuilderRefusal | null => {
      if (!(error instanceof ApiError)) return null;
      if (error.code === 'CURRENCY_CONSENT_CHANGED' && error.details?.expectedCurrency !== intent.expectedCurrency) return null;
      try { return parseBuilderRefusal({ status: error.status, code: error.code }); } catch { return null; }
    },
  };
}
/** History never patches the current job/building HUD; this separate read is
 * bracketed by original ownership and atomic latest-read/base epoch guards. */
export async function refreshBuilderJobSpeedupSnapshot(identity: BuilderJobSpeedupIdentity, ports: BuilderJobSpeedupPorts) {
  const scope = captureBaseSnapshotGuard(), session = ports.capture();
  const guard = () => { session(); if (scope.wallet !== identity.wallet || !isBaseSnapshotGuardCurrent(scope)) throw new Error('The Builder account or selected base changed.'); };
  const commit = scope.selectedBaseId ? captureBaseSnapshotCommit(scope.selectedBaseId, scope) : null;
  const result = await readContext(identity, ports, scope.selectedBaseId, guard); guard();
  if (!result || !commit) return null;
  if (!commit(result.base, result.balances)) throw new Error('A newer base refresh replaced this Builder view. Refresh again.');
  return { base: result.base, balances: result.balances };
}
