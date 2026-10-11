import type { BasePanel } from './basePanel';

export interface PanelDismissRequest {
  reason: 'close' | 'replace' | 'navigate';
  nextPanel?: BasePanel;
  /** One-shot continuation; false means its panel/scope/request is stale. */
  proceed: () => boolean;
  /** Refusal, supersession and owner retirement settle deferred callers. */
  cancel?: () => void;
}
export type PanelDismissPolicy = (request: PanelDismissRequest) => void;
export type PanelAction = 'read' | 'mutate' | 'recover';
export interface PanelSession {
  setDismissPolicy: (policy: PanelDismissPolicy) => () => void;
  dispatch: (kind: PanelAction, action: () => void) => boolean;
}
let owner: { panel: BasePanel; request: PanelDismissPolicy } | null = null;
const controlledPanels = new WeakSet<BasePanel>();
let admittedPanel: BasePanel | null = null;

/** Called by the store at open, before React can mount the owner. */
export function markControlledPanel(panel: BasePanel): void { controlledPanels.add(panel); }
export function carryPanelControl(previous: BasePanel | null, next: BasePanel | null): BasePanel | null {
  if (previous && next && controlledPanels.has(previous)) markControlledPanel(next);
  return next;
}
export function withAdmittedPanelChange<T>(panel: BasePanel | null, command: () => T): T {
  const previous = admittedPanel; admittedPanel = panel;
  try { return command(); } finally { admittedPanel = previous; }
}
/** Authority setters remain direct. Nested synchronous commands share only the
 * already admitted panel, without destroying selection/retarget state. */
export function requestBasePanelChange(panel: BasePanel | null, request: PanelDismissRequest): void {
  if (panel && admittedPanel === panel) request.proceed();
  else if (panel && owner?.panel === panel) owner.request(request);
  else if (panel && controlledPanels.has(panel)) request.cancel?.();
  else request.proceed();
}
export function createPanelSession(options: {
  panel: BasePanel; isCurrent: () => boolean; canMutate: () => boolean;
  canRecover: () => boolean; controlled: boolean;
}): PanelSession & { mount: () => () => void; isCurrent: () => boolean } {
  let mounted = false; let generation = 0; let armed = false;
  let policy: PanelDismissPolicy | null = null;
  let retained: PanelDismissRequest | null = null;
  const isCurrent = (): boolean => mounted && options.isCurrent();
  const retire = (): void => { ++generation; const old = retained; retained = null; old?.cancel?.(); };
  const request: PanelDismissPolicy = (requested) => {
    retire();
    if (!isCurrent()) { requested.cancel?.(); return; }
    const version = generation; retained = requested;
    const cancel = (): void => { if (version === generation) retire(); else requested.cancel?.(); };
    const proceed = (): boolean => {
      if (!isCurrent() || version !== generation || retained !== requested) { cancel(); return false; }
      ++generation; retained = null;
      return requested.proceed();
    };
    if (policy) policy({ ...requested, proceed, cancel });
    else if (!options.controlled || !armed) proceed();
    else cancel();
  };
  const binding = { panel: options.panel, request };
  return {
    isCurrent,
    mount: () => {
      mounted = true; owner = binding;
      return () => { mounted = false; retire(); if (owner === binding) owner = null; };
    },
    setDismissPolicy: (next) => {
      retire(); armed = true; policy = next;
      return () => { if (policy === next) { policy = null; retire(); } };
    },
    dispatch: (kind, action) => {
      if (!isCurrent()) return false;
      if (kind === 'mutate' && !options.canMutate()) return false;
      if (kind === 'recover' && !options.canRecover()) return false;
      action(); return true;
    },
  };
}
