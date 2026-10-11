import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { BasePanel, BasePanelKind } from './basePanel';
import type { SheetSize } from './p2Types';
import type { PanelSession } from './panelSession';

export interface BaseFeatureProps {
  panel: BasePanel;
  onClose: () => void;
  session: PanelSession;
  /** Rendered host base capability; feed the original hooks so capability loss
   * reaches their lifecycle/pre-POST guards. This is not complete money authority:
   * keep session.dispatch and each controller's live guards and building access. */
  actionsEnabled: boolean;
}
export interface BaseFeatureDefinition {
  id: string;
  kind: BasePanelKind;
  label: string;
  size: SheetSize;
  /** Explicitly read-only/recovery; a presentation group alone is no permission. */
  readOnly: boolean;
  /** Controller mode requires a mounted owner; its first policy arms draft refusal. */
  dismissal?: 'allow' | 'controller';
  /** Live original-controller predicates; never captured render flags. */
  canMutate?: (panel: BasePanel) => boolean;
  canRecover?: (panel: BasePanel) => boolean;
  load: () => Promise<{ default: ComponentType<BaseFeatureProps> }>;
}
export type BaseFeature = Omit<BaseFeatureDefinition, 'load'> & { Component: LazyExoticComponent<ComponentType<BaseFeatureProps>> };
export type BaseFeatureRegistry = Readonly<Record<string, BaseFeature>>;

export function createBaseFeatureRegistry(definitions: readonly BaseFeatureDefinition[]): BaseFeatureRegistry {
  const entries: Record<string, BaseFeature> = Object.create(null) as Record<string, BaseFeature>;
  for (const { load, ...definition } of definitions) {
    if (Object.hasOwn(entries, definition.id)) throw new Error(`Duplicate base feature: ${definition.id}`);
    entries[definition.id] = Object.freeze({ ...definition, Component: lazy(load) });
  }
  return Object.freeze(entries);
}

export function resolveBaseFeature(registry: BaseFeatureRegistry, panel: BasePanel, baseActionsEnabled: boolean): BaseFeature | null {
  const feature = Object.hasOwn(registry, panel.featureId) ? registry[panel.featureId] : undefined;
  return feature && feature.kind === panel.kind && (baseActionsEnabled || feature.readOnly || feature.canRecover?.(panel) === true) ? feature : null;
}

// Intake is serialized by F2ab after each artifact freeze and applicable money
// review. No fake placeholder or retired M48 route is registered to fill the gap.
export const BASE_FEATURES = createBaseFeatureRegistry([]);
