import type { MiningContributionLine, MiningContributionResource } from '@shardkeep/shared/miningContribution';
import type { MiningContributionView } from '@shardkeep/shared/miningContributionApi';
import type { MiningContributionState } from '../../../lib/miningContribution/controller';
import type { MiningContributionOperation } from '../../../lib/miningContribution/journal';

/** Presentation admission only. Existing controller guards still own every command.
 * scopeMatches is the original hook's current session identity, not a wallet string
 * comparison. observationCurrent additionally covers the selected base/epoch. */
export interface SmeltAdmission {
  scopeMatches?: boolean;
  observationCurrent?: boolean;
  actionsAllowed?: boolean;
  ownerHandoffReady?: boolean;
  freshEntryAllowed?: boolean;
  refreshError?: string | null;
}
export interface SmeltBasketValue {
  valid: boolean;
  reason: string | null;
  count: string | null;
  value: string | null;
}
export type SmeltOriginalOutcome = 'draft' | 'uncertain' | 'refused' | 'held' | 'consumed' | 'returned';
export interface SmeltOriginal {
  requestKey: string;
  day: string;
  lines: readonly MiningContributionLine[];
  outcome: SmeltOriginalOutcome;
  value: string | null;
}
export interface SmeltProjection {
  day: string | null;
  pool: 'free' | 'deed' | null;
  committed: string | null;
  cap: { kind: 'unknown' | 'limited' | 'uncapped'; amount: string | null };
  resources: readonly MiningContributionView['resources'][number][];
  basket: SmeltBasketValue;
  freshness: 'unknown' | 'retained' | 'current';
  original: SmeltOriginal | null;
  /** Accepted archives may still be held. Route their keys to checkArchived,
   * separately from the active original; never start or retry them as a basket. */
  history: readonly SmeltOriginal[];
  canReviewNew: boolean;
  message: string;
  /** These fields are deliberately unknown: the contribution DTO has no witness. */
  estimate: null;
  qualified: null;
  raidDays: null;
}

const unsigned = (value: string): bigint | null => /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : null;
const invalid = (reason: string): SmeltBasketValue => ({ valid: false, reason, count: null, value: null });

/** Server view is already validated by its owner. Picker input is still checked:
 * quantities never round through Number and the whole invalid basket is rejected. */
function totals(view: MiningContributionView, lines: readonly MiningContributionLine[]): SmeltBasketValue {
  const ids = new Set<string>();
  let count = 0n, value = 0n;
  for (const line of lines) {
    if (ids.has(line.resourceId)) return invalid('Choose each resource once.');
    ids.add(line.resourceId);
    const resource = view.resources.find(row => row.resourceId === line.resourceId);
    if (!resource) return invalid('This resource is no longer available.');
    const quantity = unsigned(line.quantity), available = unsigned(resource.available), unit = unsigned(resource.unitValue);
    if (quantity === null || quantity <= 0n || available === null || unit === null || unit <= 0n) {
      return invalid('Check the basket quantities.');
    }
    if (quantity > available) return invalid('There is not enough of this resource.');
    count += quantity;
    value += quantity * unit;
  }
  return { valid: true, reason: null, count: String(count), value: String(value) };
}

export function smeltBasket(view: MiningContributionView | null, lines: readonly MiningContributionLine[]): SmeltBasketValue {
  if (!view) return invalid('Checking the furnace.');
  if (!lines.length) return invalid('Choose what to smelt.');
  const result = totals(view, lines);
  if (!result.valid || result.value === null) return result;
  if (view.remainingValue !== null) {
    const remaining = unsigned(view.remainingValue);
    if (remaining === null) return invalid('Checking the furnace allowance.');
    if (BigInt(result.value) > remaining) return invalid("Today's allowance is full.");
  }
  return result;
}

/** Maximum TOTAL quantity for this line, not an increment. The UI announces a
 * rejected +1 instead of applying this clamp silently. Null means not known. */
export function smeltMaximum(view: MiningContributionView | null, lines: readonly MiningContributionLine[], resourceId: MiningContributionResource): string | null {
  if (!view || new Set(lines.map(line => line.resourceId)).size !== lines.length) return null;
  const resource = view.resources.find(row => row.resourceId === resourceId);
  if (!resource) return null;
  const available = unsigned(resource.available), unit = unsigned(resource.unitValue);
  if (available === null || unit === null || unit <= 0n) return null;
  const other = totals(view, lines.filter(line => line.resourceId !== resourceId));
  if (!other.valid || other.value === null) return null;
  if (view.remainingValue === null) return String(available);
  const remaining = unsigned(view.remainingValue);
  if (remaining === null) return null;
  const allowance = remaining - BigInt(other.value);
  const maximum = allowance <= 0n ? 0n : allowance / unit;
  return String(maximum < available ? maximum : available);
}

function originalProjection(operation: MiningContributionOperation): SmeltOriginal {
  const accepted = operation?.proof?.status === 'accepted' ? operation.proof : null;
  return {
    requestKey: operation.command.request.idempotencyKey,
    day: operation.command.request.expectedDay,
    lines: operation.command.request.lines,
    outcome: accepted ? accepted.settlement?.outcome ?? 'held'
      : operation.refusal ? 'refused' : operation.attemptRevision === null ? 'draft' : 'uncertain',
    value: accepted?.receipt.totalValue ?? null,
  };
}

export function projectSmelt(state: MiningContributionState, view: MiningContributionView | null,
  lines: readonly MiningContributionLine[], admission: SmeltAdmission = {}): SmeltProjection {
  // Missing identity witness suppresses prior-session amounts and original keys.
  const scoped = admission.scopeMatches === true;
  const data = scoped ? view : null;
  const operation = scoped ? state.journal?.operation : null;
  const original = operation ? originalProjection(operation) : null;
  const history = scoped ? (state.journal?.archives ?? [])
    .filter(row => row.operation.proof?.status === 'accepted')
    .map(row => originalProjection(row.operation)) : [];
  const current = !!data && admission.observationCurrent === true && !admission.refreshError && !state.error;
  const basket = smeltBasket(data, lines);
  const canReviewNew = scoped && current && admission.actionsAllowed === true
    && admission.ownerHandoffReady === true && admission.freshEntryAllowed === true
    && state.loaded && !!state.journal && !state.busy && !state.review && !operation
    && data?.acceptingContributions === true && data.developmentReady && basket.valid;
  let message = 'Choose what to smelt.';
  if (!scoped || !data) message = 'Checking the furnace…';
  else if (!current) message = 'Showing the last furnace reading. Check again before choosing a basket.';
  else if (!data.developmentReady) message = 'Your furnace is not ready yet.';
  else if (!data.acceptingContributions) message = 'The furnace is resting. Saved baskets stay available.';
  else if (admission.freshEntryAllowed !== true) message = 'New baskets are not available here yet.';
  if (original) {
    const messages: Record<SmeltOriginalOutcome, string> = {
      draft: 'Your saved basket is ready to review.',
      uncertain: 'Checking whether your saved basket reached the furnace…',
      refused: 'The furnace declined this basket. Its original record is saved.',
      held: 'Your basket is held in the furnace. Your share is set at payout.',
      consumed: 'This basket melted. Check CLAIM for any coins ready for you.',
      returned: 'This basket came back unused.',
    };
    message = messages[original.outcome];
  }
  return {
    day: data?.day ?? null, pool: data?.pool ?? null, committed: data?.committedValue ?? null,
    cap: !data ? { kind: 'unknown', amount: null } : data.dailyCapValue === null
      ? { kind: 'uncapped', amount: null } : { kind: 'limited', amount: data.dailyCapValue },
    resources: data?.resources ?? [], basket, freshness: data ? current ? 'current' : 'retained' : 'unknown',
    original, history, canReviewNew, message, estimate: null, qualified: null, raidDays: null,
  };
}
