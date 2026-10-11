import { exactAmount } from '../kitLogic';
import type { FeatureId, ResourceDrawerUi, ResourceGroupLayout, ResourceGroupUi, ResourceRowUi } from '../hudModel';
import { hudAmountText, type HudResourceAmount } from './hudResourceAmount';

/** Local structural inputs for the pure W3 port; these do not register producers or establish freshness. */
export interface ResourceDrawerAccount {
  readonly signedIn: boolean;
  readonly wallet: string | null;
  readonly selectedBaseId: string | null;
}

export interface ResourceDrawerScope {
  readonly wallet: string | null;
  readonly baseId: string | null;
  readonly subject: string | null;
}

/** Preserve the drawer API while sharing one amount contract with the Home producer. */
export type ResourceDrawerAmount = HudResourceAmount;

export interface ResourceDrawerObservation {
  readonly id: string;
  readonly icon: string;
  readonly amount: ResourceDrawerAmount;
  readonly earnedAt: readonly FeatureId[];
  readonly spentAt: readonly FeatureId[];
  readonly kind: 'SPENDABLE' | 'CLAIMABLE' | 'HELD' | 'PROGRESSION';
  readonly scope: ResourceDrawerScope | null;
  readonly coverage: 'COMPLETE' | 'PARTIAL';
}

/** Owner-admitted catalogue copy and art, never a source of balances or navigation authority. */
export interface ResourceDrawerEntry {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly purpose: string;
  readonly earnedAt: string;
  readonly goIcon?: string | null;
  readonly divine?: boolean;
  readonly actionLabel?: string | null;
  readonly action?: FeatureId | null;
}

/** Caller order is retained: EVERY DAY, HARVESTERS, WORKSHOP, LODGE when their owners provide them. */
export interface ResourceDrawerSection {
  readonly id: string;
  readonly title: string;
  readonly icon: string;
  readonly note: string;
  readonly layout: ResourceGroupLayout;
  readonly entries: readonly ResourceDrawerEntry[];
  readonly go?: FeatureId | null;
}

/**
 * Port of native ResourceDrawerProducer.resourceDrawerUi (6e6fef31), with local structural inputs
 * under review f315f363. Only a unique COMPLETE SPENDABLE observation in the expected scope
 * provides an amount or navigation metadata. The host samples live owners on every projection
 * and discards their observations on identity/lifecycle invalidation. Matching scope strings here
 * reject contradictions; they cannot establish A→B→A generation freshness or spend admission.
 *
 * No reads, callbacks, timers, registry, conversion, quotes or routing. The live dispatcher must
 * recheck every GO/action. KEEP is wallet-only with explicit linkage; no custodial fallback or SOL.
 */
export function resourceDrawerUi(
  rows: readonly ResourceDrawerObservation[],
  account: ResourceDrawerAccount,
  expectedScopes: Readonly<Record<string, ResourceDrawerScope>>,
  sections: readonly ResourceDrawerSection[],
  focusRowId: string | null,
  walletLinked = false,
): ResourceDrawerUi {
  if (new Set(sections.map(section => section.id)).size !== sections.length) throw new Error('Duplicate drawer section');
  const entries = sections.flatMap(section => section.entries);
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Duplicate drawer resource');
  if (sections.some(section => !nonblank(section.id) || !nonblank(section.title))) throw new Error('Missing drawer section metadata');
  if (entries.some(entry => !nonblank(entry.id) || !nonblank(entry.name) || !nonblank(entry.icon))) {
    throw new Error('Missing admitted resource presentation metadata');
  }
  const wallet = account.signedIn && nonblank(account.wallet) ? account.wallet : null;
  const base = nonblank(account.selectedBaseId) ? account.selectedBaseId : null;

  const admitted = (id: string): ResourceDrawerObservation | null => {
    const scope = Object.hasOwn(expectedScopes, id) ? expectedScopes[id] : undefined;
    if (!scope || wallet === null || scope.wallet !== wallet) return null;
    if (scope.baseId !== null && scope.baseId !== base) return null;
    if ((id === 'shards' || id === 'gems') && (base === null || scope.baseId !== base)) return null;
    if (id === 'keep' && scope.baseId !== null) return null;
    const matching = rows.filter(row => row.id === id && row.kind === 'SPENDABLE' && sameScope(row.scope, scope));
    const observation = matching.length === 1 ? matching[0] : undefined;
    return observation?.coverage === 'COMPLETE' ? observation : null;
  };

  const groups: ResourceGroupUi[] = [];
  for (const section of sections) {
    const visible: ResourceRowUi[] = [];
    for (const entry of section.entries) {
      if (entry.id.toLowerCase() === 'sol' || (entry.id === 'keep' && (wallet === null || !walletLinked))) continue;
      const observation = admitted(entry.id);
      const amount: ResourceDrawerAmount = observation?.amount ?? { status: 'unavailable' };
      const decimal = hudAmountText(amount);
      const value = decimal === '…' || decimal === '—' ? decimal : exactAmount(decimal, 0);
      const earnedAt = [...new Set(observation?.earnedAt ?? [])];
      const requestedAction = entry.action ?? null;
      const action = requestedAction !== null && nonblank(entry.actionLabel) && observation !== null
        && (observation.earnedAt.includes(requestedAction) || observation.spentAt.includes(requestedAction))
        ? requestedAction : null;
      visible.push(Object.freeze({
        id: entry.id,
        icon: observation && nonblank(observation.icon) ? observation.icon : entry.icon,
        name: entry.name,
        value,
        purpose: entry.purpose,
        earnedAt: entry.earnedAt,
        earnedAtFeature: earnedAt.length === 1 ? earnedAt[0]! : null,
        goIcon: entry.goIcon ?? null,
        empty: amount.status === 'known' && decimal === '0',
        divine: entry.divine ?? false,
        action,
        actionLabel: action !== null ? entry.actionLabel ?? null : null,
      }));
    }
    if (visible.length === 0) continue;
    const requestedGo = section.go ?? null;
    const go = requestedGo !== null && visible.some(row => admitted(row.id)?.earnedAt.includes(requestedGo) === true)
      ? requestedGo : null;
    groups.push(Object.freeze({
      id: section.id, icon: section.icon, title: section.title, note: section.note,
      go, rows: detachedList(visible), layout: section.layout,
    }));
  }
  const ids = new Set(groups.flatMap(group => group.rows).map(row => row.id));
  return Object.freeze({ groups: detachedList(groups), focusRowId: focusRowId !== null && ids.has(focusRowId) ? focusRowId : null });
}

function nonblank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function sameScope(actual: ResourceDrawerScope | null, expected: ResourceDrawerScope): boolean {
  return actual !== null && actual.wallet === expected.wallet && actual.baseId === expected.baseId && actual.subject === expected.subject;
}

/** Keep the kit's array API while matching native detached, unmodifiable collection snapshots. */
function detachedList<T>(values: readonly T[]): T[] {
  const snapshot = [...values];
  Object.freeze(snapshot);
  return snapshot;
}
