import type { FeatureId, ResourceAccent, ResourceChipUi } from '../hudModel';
import { compactAmount, exactAmount } from '../kitLogic';
import { hudAmountText, type HudResourceAmount } from './hudResourceAmount';
import type { ResourceDrawerAccount, ResourceDrawerObservation, ResourceDrawerScope } from './resourceDrawerMapper';

/** Minimal metadata projection; source-door visibility/enabled gates do not remove currency readouts. */
export interface HomeResourceFeature {
  readonly id: FeatureId;
  readonly hostKind: string;
  readonly surface: string;
  readonly visible?: boolean;
  readonly enabled?: boolean;
}

/**
 * Passive port of HomeResourceChips.kt (e7b83e0e). The caller samples the live resource
 * getter on every projection and supplies only current, owner-admitted scopes and icons.
 * Scope equality rejects contradictions; it cannot prove A→B→A generation freshness.
 * walletLinked is true only for the owner's explicitly observed WalletLinked gate pass.
 *
 * Exactly one COMPLETE SPENDABLE observation supplies each amount. No balance reads,
 * callbacks, registry mutations, fill, gain or conversion are inferred. Strict shared
 * normalization precedes the existing compact/exact kit formatters at zero extra scale.
 * The current wallet-only KEEP ruling also rejects a base-scoped custodial expectation.
 *
 * IDs identify fixed readouts; every tap still dispatches through the live hud.resources
 * owner. hudResourceFocus supplies only row focus. General drawer opens use null focus.
 */
export function homeResourceChips(
  rows: readonly ResourceDrawerObservation[],
  account: ResourceDrawerAccount,
  expectedScopes: Readonly<Record<string, ResourceDrawerScope>>,
  icons: Readonly<Record<string, string>>,
  registry: readonly HomeResourceFeature[],
  walletLinked = false,
): ResourceChipUi[] {
  const features = new Map<string, HomeResourceFeature>();
  for (const feature of registry) {
    if (features.has(feature.id)) throw new Error(`Duplicate Home resource feature metadata: ${feature.id}`);
    features.set(feature.id, feature);
  }
  const wallet = account.signedIn && nonblank(account.wallet) ? account.wallet : null;
  const baseId = nonblank(account.selectedBaseId) ? account.selectedBaseId : null;
  const showKeep = wallet !== null && walletLinked;

  function amount(id: string): HudResourceAmount {
    const unknown: HudResourceAmount = { status: 'unavailable' };
    const scope = Object.hasOwn(expectedScopes, id) ? expectedScopes[id] : undefined;
    if (!scope || wallet === null || scope.wallet !== wallet) return unknown;
    if (scope.baseId !== null && scope.baseId !== baseId) return unknown;
    if ((id === 'shards' || id === 'gems') && (baseId === null || scope.baseId !== baseId)) return unknown;
    if (id === 'keep' && scope.baseId !== null) return unknown;
    const eligible = rows.filter(row => row.id === id && row.kind === 'SPENDABLE' && sameScope(row.scope, scope));
    const row = eligible.length === 1 ? eligible[0] : undefined;
    return row?.coverage === 'COMPLETE' ? row.amount : unknown;
  }

  function chip(id: string, featureId: FeatureId, name: string, accent: ResourceAccent, drawerHandle = false): ResourceChipUi {
    const feature = features.get(featureId);
    if (!feature) throw new Error(`Required Home resource feature metadata is missing: ${featureId}`);
    if (feature.hostKind !== 'HUD' || feature.surface !== 'HUD_SLOT') {
      throw new Error(`Required Home resource feature is not a HUD slot: ${featureId}`);
    }
    const icon = Object.hasOwn(icons, id) ? icons[id] : undefined;
    if (!nonblank(icon)) throw new Error(`An admitted Home resource icon is required: ${id}`);
    const admitted = hudAmountText(amount(id));
    const marker = admitted === '…' || admitted === '—';
    return Object.freeze({
      id: feature.id, icon, name, accent, drawerHandle,
      value: marker ? admitted : compactAmount(admitted, 0),
      exactDescription: `${name} ${marker ? admitted : exactAmount(admitted, 0)}`,
      fill: null, plus: false, badge: null, gain: null,
    });
  }

  const chips = [chip('shards', 'hud.shards', 'Shards', 'SHARDS'), chip('gems', 'hud.gems', 'Gems', 'GEMS')];
  if (showKeep) chips.push(chip('keep', 'hud.keep', 'KEEP', 'KEEP'));
  chips.push(chip('skr', 'hud.resources', 'SKR', 'SKR', true));
  Object.freeze(chips);
  return chips;
}

/** Readout focus only. General drawer opening supplies null separately. */
export function hudResourceFocus(id: FeatureId): string | null {
  switch (id) {
    case 'hud.shards': return 'shards';
    case 'hud.gems': return 'gems';
    case 'hud.keep': return 'keep';
    case 'hud.resources': return 'skr';
    default: return null;
  }
}

function nonblank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function sameScope(actual: ResourceDrawerScope | null, expected: ResourceDrawerScope): boolean {
  return actual !== null && actual.wallet === expected.wallet && actual.baseId === expected.baseId && actual.subject === expected.subject;
}
