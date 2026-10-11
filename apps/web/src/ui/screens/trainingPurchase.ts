/** A saved intent is the exact purchase the player confirmed, not a live queue.
 * Unknown or malformed receipts cannot authorize another paid request. */
import { TRAINING_PRESETS, TROOP_TYPES, type TrainingBatchResult, type TrainingComposition, type TrainingQuote, type TrainingScheduleConsent } from '@shardkeep/shared';

export interface TrainingPurchase {
  version: 1;
  wallet: string;
  baseId: string | null;
  idempotencyKey: string;
  composition: TrainingComposition;
  confirmedCostShards: string;
  consent?: TrainingScheduleConsent;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 32;
const date = (value: unknown): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const walletKey = (wallet: string): string => `pkw:training-purchase:v1:${wallet}`;
const key = (wallet: string, id: string): string => `${walletKey(wallet)}:${id}`;
const storageMessage = 'Saved training purchase could not be verified. Keep this browser data and retry recovery.';

function composition(value: unknown): value is TrainingComposition {
  return Array.isArray(value) && value.length > 0 && value.length <= TROOP_TYPES.length
    && value.every((row: unknown) => record(row) && TROOP_TYPES.includes(row.troop as never) && Number.isSafeInteger(row.count) && Number(row.count) > 0)
    && new Set(value.map((row: { troop: string }) => row.troop)).size === value.length
    && value.reduce((sum: number, row: { count: number }) => sum + row.count, 0) <= TRAINING_PRESETS.maxCompositionUnits;
}

function scheduleConsent(value: unknown, troops: TrainingComposition): value is TrainingScheduleConsent {
  if (!record(value) || value.version !== 2 || !Array.isArray(value.queue) || !Array.isArray(value.unitDurations)) return false;
  const durations = value.unitDurations;
  return value.queue.every((row: unknown) => record(row) && uuid(row.id) && date(row.startedAt) && date(row.finishesAt)
      && Date.parse(String(row.finishesAt)) >= Date.parse(String(row.startedAt)))
    && new Set(value.queue.map((row: { id: string }) => row.id)).size === value.queue.length
    && value.unitDurations.length === troops.length
    && troops.every((troop, index) => {
      const row: unknown = durations[index];
      return record(row) && row.troop === troop.troop && Number.isSafeInteger(row.durationMs) && Number(row.durationMs) > 0;
    });
}

export function verifyTrainingQuote(quote: TrainingQuote): void {
  if (!scheduleConsent(quote.consent, quote.queueable) || !quote.schedule || quote.schedule.version !== 2
    || quote.schedule.mode !== 'sequential' || !date(quote.schedule.serverNow) || !date(quote.schedule.startsAt)
    || !date(quote.schedule.finishesAt) || !Number.isSafeInteger(quote.schedule.waitMs) || quote.schedule.waitMs < 0
    || !Number.isSafeInteger(quote.schedule.durationMs) || quote.schedule.durationMs < 0) {
    throw new Error('Training schedule is unavailable or requires a game update. Reload before purchasing.');
  }
  const duration = quote.queueable.reduce((sum, row, index) => sum + row.count * quote.consent.unitDurations[index]!.durationMs, 0);
  if (duration !== quote.schedule.durationMs
    || Date.parse(quote.schedule.finishesAt) - Date.parse(quote.schedule.startsAt) !== duration
    || Date.parse(quote.schedule.startsAt) - Date.parse(quote.schedule.serverNow) !== quote.schedule.waitMs
    || quote.completionSec !== (quote.queueable.length ? (quote.schedule.waitMs + duration) / 1000 : 0)) {
    throw new Error('Training completion estimates disagree. Refresh the preview before purchasing.');
  }
}

function decodePurchase(raw: string, wallet: string, id?: string): TrainingPurchase {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(storageMessage); }
  if (!record(value) || value.version !== 1 || value.wallet !== wallet || !uuid(value.idempotencyKey)
    || (id !== undefined && value.idempotencyKey !== id)
    || !(value.baseId === null || typeof value.baseId === 'string') || !composition(value.composition)
    || !decimal(value.confirmedCostShards) || (value.consent !== undefined && !scheduleConsent(value.consent, value.composition))) throw new Error(storageMessage);
  return value as unknown as TrainingPurchase;
}

/** The initial browser draft used a single wallet slot. Copy and verify before
 * removing it; a failed migration preserves the original evidence. */
function migrateLegacyPurchase(wallet: string): void {
  const raw = localStorage.getItem(walletKey(wallet));
  if (!raw) return;
  const intent = decodePurchase(raw, wallet);
  const target = key(wallet, intent.idempotencyKey);
  const existing = localStorage.getItem(target);
  if (existing && !same(decodePurchase(existing, wallet, intent.idempotencyKey), intent)) throw new Error(storageMessage);
  localStorage.setItem(target, raw);
  if (localStorage.getItem(target) !== raw) throw new Error(storageMessage);
  localStorage.removeItem(walletKey(wallet));
}

export function readTrainingPurchase(wallet: string, id?: string): TrainingPurchase | null {
  migrateLegacyPurchase(wallet);
  const prefix = `${walletKey(wallet)}:`;
  const entryKey = id ? key(wallet, id) : Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((entry): entry is string => entry !== null && entry.startsWith(prefix)).sort()[0];
  if (!entryKey) return null;
  const raw = localStorage.getItem(entryKey);
  return raw ? decodePurchase(raw, wallet, entryKey.slice(prefix.length)) : null;
}

export function saveTrainingPurchase(intent: TrainingPurchase): void {
  // Tabs may both observe no pending purchase. Their unique keys must never
  // overwrite one another, even if the server rejects one stale queue consent.
  const prior = readTrainingPurchase(intent.wallet, intent.idempotencyKey);
  if (prior && !same(prior, intent)) throw new Error('This training purchase key already records a different request.');
  const raw = JSON.stringify(intent);
  localStorage.setItem(key(intent.wallet, intent.idempotencyKey), raw);
  if (localStorage.getItem(key(intent.wallet, intent.idempotencyKey)) !== raw) throw new Error('Training purchase could not be saved. Nothing was submitted.');
}

export function clearTrainingPurchase(intent: TrainingPurchase): void {
  const existing = readTrainingPurchase(intent.wallet, intent.idempotencyKey);
  // Another tab may already have acknowledged this exact key. Never delete
  // whichever unrelated pending purchase currently sorts first.
  if (existing && !same(existing, intent)) throw new Error('Saved training purchase changed. Check its status again.');
  localStorage.removeItem(key(intent.wallet, intent.idempotencyKey));
  if (localStorage.getItem(key(intent.wallet, intent.idempotencyKey)) !== null) throw new Error('Purchase status is known, but browser storage could not be updated. Retry recovery before another purchase.');
}

/** Check the immutable acknowledgement, including every actually purchased unit.
 * Its old finishesAt values must never replace the current GET /army snapshot. */
export function verifyTrainingBatch(value: unknown, intent: TrainingPurchase): TrainingBatchResult {
  if (!record(value) || value.costShards !== intent.confirmedCostShards || typeof value.replayed !== 'boolean' || !Array.isArray(value.queue)) throw new Error('Training acknowledgement could not be verified. Check purchase status.');
  const counts = new Map<string, number>(); const ids = new Set<string>();
  for (const row of value.queue) {
    if (!record(row) || !uuid(row.id) || ids.has(row.id) || typeof row.troop !== 'string' || !date(row.finishesAt)) throw new Error('Training acknowledgement could not be verified. Check purchase status.');
    ids.add(row.id); counts.set(row.troop, (counts.get(row.troop) ?? 0) + 1);
  }
  if (counts.size !== intent.composition.length || intent.composition.some((row) => counts.get(row.troop) !== row.count)) throw new Error('Training acknowledgement differs from the confirmed troops. Check purchase status.');
  return value as unknown as TrainingBatchResult;
}

export function verifyTrainingRecovery(value: unknown, intent: TrainingPurchase): 'accepted' | 'unknown' | 'closed' {
  if (!record(value) || value.version !== 1 || value.idempotencyKey !== intent.idempotencyKey) throw new Error('Training receipt could not be verified. Keep the original purchase.');
  if (value.status === 'unknown') return 'unknown';
  if (value.status === 'closed' && date(value.closedAt)) return 'closed';
  if (value.status === 'accepted' && value.baseId === intent.baseId && date(value.acceptedAt)
    && record(value.request) && same(value.request.composition, intent.composition)
    && value.request.confirmedCostShards === intent.confirmedCostShards) {
    verifyTrainingBatch(value.result, intent);
    if (!record(value.result) || value.result.replayed !== true) throw new Error('Training receipt could not be verified.');
    return 'accepted';
  }
  throw new Error('Training receipt differs from the original purchase. Keep it and retry recovery.');
}
