// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBasePanels, requestUserCommand, useApp } from '../../state/store';
import { bus } from '../../lib/events';
import { createMobileBackGuard, registerMobileBackHandler } from '../../lib/mobileBackGuard';
import { OverlayHost } from './OverlayHost';
import * as featureResolution from './featureRegistry';
import { createBaseFeatureRegistry, type BaseFeatureProps } from './featureRegistry';
import { createPanelSession, type PanelDismissRequest } from './panelSession';
import { usePanelInset } from './panelInsets';
import type { SheetInset } from './p2Types';

vi.mock('./usePkViewport', () => ({ usePkViewport: () => ({ vp: 'phone-portrait', w: 412, h: 915, dpr: 1 }) }));
let root: Root; let node: HTMLDivElement; let onInset: ReturnType<typeof vi.fn<(inset: SheetInset | null) => void>>;
let pending: PanelDismissRequest[]; let session: BaseFeatureProps['session']; let allowMutation: boolean; let allowRecovery: boolean;
function Controlled({ session: current, onClose }: BaseFeatureProps): React.JSX.Element {
  session = current;
  useLayoutEffect(() => current.setDismissPolicy((request) => { pending.push(request); }), [current]);
  return <><button onClick={onClose}>Close draft</button><input aria-label="Draft" /><button>Last control</button></>;
}
const definition = { id: 'hub.draft', kind: 'hub' as const, label: 'Draft', size: 'HALF' as const,
  readOnly: false, dismissal: 'controller' as const, canMutate: () => allowMutation,
  canRecover: () => allowRecovery, load: async () => ({ default: Controlled }) };
const registry = createBaseFeatureRegistry([definition, { ...definition, id: 'hub.next', label: 'Next', dismissal: 'allow' }]);
const fullRegistry = createBaseFeatureRegistry([{ ...definition, size: 'FULL' }]);
const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
async function render(enabled = true, full = false): Promise<void> {
  const selectedRegistry = full ? fullRegistry : registry;
  await act(async () => root.render(<OverlayHost registry={selectedRegistry} baseActionsEnabled={enabled} onInset={onInset}><span>Legacy sheet</span></OverlayHost>));
}
function escape(repeat = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', repeat, cancelable: true, bubbles: true });
  act(() => window.dispatchEvent(event)); return event;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers();
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  onInset = vi.fn(); pending = []; allowMutation = true; allowRecovery = false;
  configureBasePanels(registry, true);
  useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a', false); useApp.getState().setScreen('base');
});
afterEach(() => { act(() => root.unmount()); node.remove(); useApp.getState().setAuth(null); vi.useRealTimers(); });

describe('one current-controller host policy', () => {
  it.each(['button', 'escape', 'empty-tap', 'store-close'] as const)('defers %s to the same draft controller', async (source) => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => {
      if (source === 'button') (node.querySelector('button') as HTMLButtonElement).click();
      if (source === 'escape') escape();
      if (source === 'empty-tap') bus.emit('base:emptyTap', undefined);
      if (source === 'store-close') useApp.getState().closeBasePanel();
    });
    expect(pending).toHaveLength(1); expect(pending[0]?.reason).toBe('close');
    expect(useApp.getState().basePanel?.featureId).toBe(panel.featureId);
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toBeNull();
    expect(pending[0]?.proceed()).toBe(false);
  });
  it('routes full-sheet scrim through that policy', async () => {
    configureBasePanels(fullRegistry, true); useApp.getState().openBasePanel(panel); await render(true, true);
    act(() => (node.querySelector('.pk-sheethost__scrim') as HTMLDivElement).click());
    expect(pending).toHaveLength(1); expect(useApp.getState().basePanel).not.toBeNull();
  });
  it('holds draft-bearing replacement and makes an older confirmation inert', async () => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => useApp.getState().openBasePanel({ kind: 'hub', featureId: 'hub.next' }));
    expect(pending[0]?.reason).toBe('replace'); expect(pending[0]?.nextPanel?.featureId).toBe('hub.next');
    expect(useApp.getState().basePanel?.featureId).toBe('hub.draft');
    act(() => useApp.getState().closeBasePanel());
    expect(pending).toHaveLength(2); expect(pending[0]?.proceed()).toBe(false);
    act(() => { expect(pending[1]?.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toBeNull();
  });
  it.each(['route', 'placement', 'building', 'obstacle'] as const)('holds a user %s transition behind the current draft policy', async (change) => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => requestUserCommand(() => {
      if (change === 'route') useApp.getState().setScreen('inventory');
      if (change === 'placement') useApp.getState().setPlacing('wall');
      if (change === 'building') useApp.getState().select('b2');
      if (change === 'obstacle') useApp.getState().selectObstacle('o2');
    }));
    expect(pending).toHaveLength(1); expect(useApp.getState().basePanel?.featureId).toBe('hub.draft');
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().placing).toBeNull();
    expect(useApp.getState().selectedBuildingId).toBeNull(); expect(useApp.getState().selectedObstacleId).toBeNull();
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toBeNull();
    if (change === 'route') expect(useApp.getState().screen).toBe('inventory');
    if (change === 'placement') expect(useApp.getState().placing).toBe('wall');
    if (change === 'building') expect(useApp.getState().selectedBuildingId).toBe('b2');
    if (change === 'obstacle') expect(useApp.getState().selectedObstacleId).toBe('o2');
  });
  it.each(['loading', 'title', 'entry', 'alphagate', 'battle'] as const)('does not let a draft veto the existing %s authority fence', async (screen) => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => useApp.getState().setScreen(screen));
    expect(useApp.getState().screen).toBe(screen); expect(useApp.getState().basePanel).toBeNull();
    expect(pending).toHaveLength(0);
  });
  it('required gates swallow dismissal when the controller declines', async () => {
    useApp.getState().openBasePanel(panel); await render();
    session.setDismissPolicy(() => undefined);
    const event = escape();
    expect(event.defaultPrevented).toBe(true); expect(pending).toHaveLength(0);
    expect(useApp.getState().basePanel?.featureId).toBe('hub.draft');
  });
  it('does not close multiple owners when Escape repeats', async () => {
    useApp.getState().openBasePanel(panel); await render();
    escape(true); expect(pending).toHaveLength(0);
    escape(); expect(pending).toHaveLength(1);
  });
  it('leaves the higher-priority owner first and unregisters the real sheet with the host', async () => {
    useApp.getState().openBasePanel(panel); await render();
    const higher = vi.fn(); const off = registerMobileBackHandler(higher, 300);
    try { escape(); expect(higher).toHaveBeenCalledTimes(1); expect(pending).toHaveLength(0); } finally { off(); }
    escape(); expect(pending).toHaveLength(1);
    act(() => root.render(null)); expect(onInset).toHaveBeenLastCalledWith(null);
    escape(); expect(pending).toHaveLength(1);
  });
  it('shows legacy children only when no feature resolves', async () => {
    await render(); expect(node.textContent).toContain('Legacy sheet');
    act(() => useApp.getState().openBasePanel(panel)); await render();
    expect(node.textContent).not.toContain('Legacy sheet'); expect(node.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    act(() => useApp.getState().setAuth(null));
    expect(node.textContent).toContain('Legacy sheet');
  });
});

describe('authority is checked at each dispatch, including saved callbacks', () => {
  it('keeps authorized original recovery visible after mutation capability is lost', async () => {
    allowRecovery = true; useApp.getState().openBasePanel(panel); await render(false);
    expect(node.textContent).toContain('Close draft');
    const callback = vi.fn();
    expect(session.dispatch('mutate', callback)).toBe(false); expect(callback).not.toHaveBeenCalled();
    expect(session.dispatch('recover', callback)).toBe(true); expect(callback).toHaveBeenCalledTimes(1);
    allowRecovery = false; expect(session.dispatch('recover', callback)).toBe(false); expect(callback).toHaveBeenCalledTimes(1);
  });
  it('checks the controller currentness predicate without waiting for a render', async () => {
    useApp.getState().openBasePanel(panel); await render(); const callback = vi.fn();
    expect(session.dispatch('mutate', callback)).toBe(true);
    allowMutation = false; expect(session.dispatch('mutate', callback)).toBe(false); expect(callback).toHaveBeenCalledTimes(1);
  });
  it.each(['wallet', 'base', 'epoch', 'replacement', 'unmount'] as const)('refuses retained callbacks and confirmations after %s changes', async (change) => {
    useApp.getState().openBasePanel(panel); await render(); const old = session; const callback = vi.fn();
    act(() => useApp.getState().closeBasePanel()); const request = pending[0];
    act(() => {
      if (change === 'wallet') useApp.getState().setAuth('wallet-b');
      if (change === 'base') useApp.getState().setSelectedBaseId('base-b', false);
      if (change === 'epoch') useApp.setState((state) => ({ baseSelectionEpoch: state.baseSelectionEpoch + 1 }));
      if (change === 'replacement') { request?.proceed(); useApp.getState().openBasePanel(panel); }
      if (change === 'unmount') root.render(null);
    });
    expect(old.dispatch('read', callback)).toBe(false); expect(old.dispatch('mutate', callback)).toBe(false);
    expect(old.dispatch('recover', callback)).toBe(false); expect(request?.proceed()).toBe(false); expect(callback).not.toHaveBeenCalled();
  });
});

describe('sheet focus lifecycle', () => {
  it('enters the sheet, wraps Tab, and returns focus on close without waiting for exit animation', async () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    try {
      useApp.getState().openBasePanel(panel); await render();
      const dialog = node.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog.contains(document.activeElement)).toBe(true);
      const buttons = node.querySelectorAll('button'); const first = buttons[0] as HTMLButtonElement; const last = buttons[1] as HTMLButtonElement;
      last.focus(); const next = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      act(() => last.dispatchEvent(next)); expect(next.defaultPrevented).toBe(true); expect(document.activeElement).toBe(first);
      const previous = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
      act(() => first.dispatchEvent(previous)); expect(document.activeElement).toBe(last);
      act(() => useApp.getState().closeBasePanel()); act(() => pending[0]?.proceed());
      expect(document.activeElement).toBe(opener); expect(dialog.hasAttribute('inert')).toBe(true);
    } finally { opener.remove(); }
  });
});

// D3: observe the consumer effect that publishes camera insets, not just a comparator.
describe('inset observer deduplication', () => {
  it('does not re-publish equal geometry or repeated null cleanup', () => {
    let publish: (next: SheetInset | null) => void = () => { throw new Error('not mounted'); };
    const consumer = vi.fn();
    function Harness(): React.JSX.Element {
      const [inset, update] = usePanelInset(); publish = update;
      useEffect(() => { consumer(inset); }, [inset]); return <span>HUD consumer</span>;
    }
    act(() => root.render(<Harness />)); expect(consumer).toHaveBeenCalledTimes(1);
    act(() => publish({ bottom: 300, right: 0 })); expect(consumer).toHaveBeenCalledTimes(2);
    act(() => publish({ bottom: 300, right: 0 })); expect(consumer).toHaveBeenCalledTimes(2);
    act(() => publish({ bottom: 301, right: 0 })); expect(consumer).toHaveBeenCalledTimes(3);
    act(() => publish(null)); expect(consumer).toHaveBeenCalledTimes(4);
    act(() => publish(null)); expect(consumer).toHaveBeenCalledTimes(4);
  });
});


// Whole-command delta: existing expectation blocks above remain unchanged.
describe('review check 9: authority and dismissal coverage', () => {
  it.each(['wallet', 'base', 'epoch', 'replacement'] as const)('rejects %s changes synchronously before React cleanup', async (change) => {
    useApp.getState().openBasePanel(panel); await render(); const old = session; const callback = vi.fn();
    act(() => useApp.getState().closeBasePanel()); const request = pending[0];
    act(() => {
      if (change === 'wallet') useApp.setState({ wallet: 'wallet-b' });
      if (change === 'base') useApp.setState({ selectedBaseId: 'base-b' });
      if (change === 'epoch') useApp.setState((state) => ({ baseSelectionEpoch: state.baseSelectionEpoch + 1 }));
      if (change === 'replacement') useApp.setState({ basePanel: { ...panel } });
      // Inside this act callback: the old layout effect has not cleaned up.
      expect(old.dispatch('read', callback)).toBe(false);
      expect(old.dispatch('mutate', callback)).toBe(false);
      expect(old.dispatch('recover', callback)).toBe(false);
      expect(request?.proceed()).toBe(false); expect(callback).not.toHaveBeenCalled();
    });
  });
  it.each(['mutate', 'recover'] as const)('readOnly with no predicates grants no %s dispatch', async (kind) => {
    const { canMutate: _mutate, canRecover: _recover, ...withoutPredicates } = definition;
    const readRegistry = createBaseFeatureRegistry([{ ...withoutPredicates, readOnly: true }]);
    configureBasePanels(readRegistry, true);
    useApp.getState().openBasePanel(panel);
    await act(async () => root.render(<OverlayHost registry={readRegistry} baseActionsEnabled onInset={onInset}>Legacy</OverlayHost>));
    const callback = vi.fn(); expect(session.dispatch(kind, callback)).toBe(false); expect(callback).not.toHaveBeenCalled();
  });
  it('an unarmed controlled loader permits dismissal; no timeout is needed', async () => {
    const loadingRegistry = createBaseFeatureRegistry([{ ...definition, load: () => new Promise(() => undefined) }]);
    configureBasePanels(loadingRegistry, true); useApp.getState().openBasePanel(panel);
    await act(async () => root.render(<OverlayHost registry={loadingRegistry} baseActionsEnabled onInset={onInset}>Legacy</OverlayHost>));
    expect(node.textContent).toContain('Loading Draft');
    escape(); act(() => useApp.getState().closeBasePanel());
    expect(useApp.getState().basePanel).toBeNull();
    expect(pending).toHaveLength(0);
  });
  it('routes real popstate Back to the mounted sheet policy', async () => {
    useApp.getState().openBasePanel(panel); await render();
    const goToBase = vi.fn(); const toast = vi.fn();
    const off = createMobileBackGuard({ win: window, enabled: true, trustedActivation: () => true,
      getScreen: () => useApp.getState().screen, goToBase, toast });
    try {
      window.dispatchEvent(new Event('pointerdown'));
      act(() => window.dispatchEvent(new PopStateEvent('popstate')));
      expect(pending).toHaveLength(1); expect(pending[0]?.reason).toBe('close');
      expect(useApp.getState().basePanel).not.toBeNull(); expect(goToBase).not.toHaveBeenCalled(); expect(toast).not.toHaveBeenCalled();
      act(() => { expect(pending[0]?.proceed()).toBe(true); });
      expect(useApp.getState().basePanel).toBeNull(); expect(pending[0]?.proceed()).toBe(false);
    } finally { off(); }
  });
  it('replacement of a policy invalidates its retained continuation before cleanup', async () => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => useApp.getState().closeBasePanel()); const old = pending[0];
    session.setDismissPolicy(() => undefined);
    expect(old?.proceed()).toBe(false); expect(useApp.getState().basePanel).not.toBeNull();
  });
});

describe('whole user command admission', () => {
  it('holds every coupled effect and consumes one confirmation only', async () => {
    useApp.getState().openBasePanel(panel); await render(); const effect = vi.fn();
    act(() => requestUserCommand(() => { useApp.getState().setPlacing('wall'); effect(); }));
    expect(pending).toHaveLength(1); expect(pending[0]?.reason).toBe('navigate');
    expect(useApp.getState().placing).toBeNull(); expect(effect).not.toHaveBeenCalled();
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().placing).toBe('wall'); expect(effect).toHaveBeenCalledTimes(1);
    expect(pending[0]?.proceed()).toBe(false); expect(effect).toHaveBeenCalledTimes(1);
  });
  it('rechecks live target admission when the continuation executes', async () => {
    useApp.getState().openBasePanel(panel); await render(); let admitted = true; const effect = vi.fn();
    act(() => requestUserCommand(effect, () => admitted)); admitted = false;
    expect(pending[0]?.proceed()).toBe(false); expect(effect).not.toHaveBeenCalled();
    expect(useApp.getState().basePanel).not.toBeNull();
  });
  it('cancels a retired producer without executing its captured effect', async () => {
    useApp.getState().openBasePanel(panel); await render(); const effect = vi.fn();
    const cancel = requestUserCommand(effect); cancel();
    expect(pending[0]?.proceed()).toBe(false); expect(effect).not.toHaveBeenCalled();
  });
  it.each(['inventory', 'battle', 'entry'] as const)('distinguishes a user %s command from a synchronous authority setter', async (screen) => {
    useApp.getState().openBasePanel(panel); await render();
    act(() => requestUserCommand(() => useApp.getState().setScreen(screen)));
    expect(pending).toHaveLength(1); expect(useApp.getState().screen).toBe('base');
    act(() => { useApp.getState().setScreen(screen); expect(useApp.getState().screen).toBe(screen); });
    expect(pending[0]?.proceed()).toBe(false); expect(pending).toHaveLength(1);
  });
  it('invalidates an older whole command when a newer command asks the same policy', async () => {
    useApp.getState().openBasePanel(panel); await render(); const first = vi.fn(); const second = vi.fn();
    requestUserCommand(first); requestUserCommand(second);
    expect(pending).toHaveLength(2); expect(pending[0]?.proceed()).toBe(false);
    act(() => { expect(pending[1]?.proceed()).toBe(true); });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  });
});

// c6ad5ad9: activation fixes, authored before implementation; no execution claim.
describe('p1-fixes settlement and admission', () => {
  it('refuses a controlled panel synchronously before its owner mounts', () => {
    useApp.getState().openBasePanel(panel); const opened = useApp.getState().basePanel;
    const effect = vi.fn(); const settled = vi.fn();
    const handle = requestUserCommand(effect); handle.onSettled(settled);
    useApp.getState().closeBasePanel();
    expect(useApp.getState().basePanel).toBe(opened); expect(effect).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith({ status: 'cancelled' });
  });
  it('keeps a mounted draft and its input through capability loss, but refuses new opens', async () => {
    useApp.getState().openBasePanel(panel); await render(); const old = session;
    const input = node.querySelector('input')!; input.value = 'unsaved';
    await render(false);
    expect(node.querySelector('input')).toBe(input); expect(input.value).toBe('unsaved'); expect(session).toBe(old);
    expect(session.dispatch('mutate', vi.fn())).toBe(false);
    act(() => useApp.getState().openBasePanel({ kind: 'hub', featureId: 'hub.next' }));
    expect(pending).toHaveLength(0); expect(useApp.getState().basePanel?.featureId).toBe('hub.draft');
  });
  it('clears a truly removed feature in the registry authority transition', async () => {
    useApp.getState().openBasePanel(panel); await render(); const seen: unknown[] = [];
    const off = useApp.subscribe(state => seen.push(state.basePanel));
    act(() => configureBasePanels(createBaseFeatureRegistry([]), true)); off();
    expect(seen).toEqual([null]); expect(useApp.getState().basePanel).toBeNull();
  });
  it('refuses between policies after the first policy has armed the session', async () => {
    useApp.getState().openBasePanel(panel); await render();
    const release = session.setDismissPolicy(() => undefined); release();
    const effect = vi.fn(); const settled = vi.fn(); requestUserCommand(effect).onSettled(settled);
    expect(effect).not.toHaveBeenCalled(); expect(useApp.getState().basePanel).not.toBeNull();
    expect(settled).toHaveBeenCalledWith({ status: 'cancelled' });
  });
  it('settles supersession and explicit cancellation exactly once', async () => {
    useApp.getState().openBasePanel(panel); await render(); const first = vi.fn(); const second = vi.fn();
    requestUserCommand(vi.fn()).onSettled(first); const next = requestUserCommand(vi.fn()); next.onSettled(second);
    expect(first).toHaveBeenCalledTimes(1); expect(first).toHaveBeenCalledWith({ status: 'cancelled' });
    next(); next(); expect(second).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(pending[0]?.proceed()).toBe(false); expect(pending[1]?.proceed()).toBe(false);
  });
  it('lets a nested panel replacement consume the admitted request without a second policy', async () => {
    useApp.getState().openBasePanel(panel); await render();
    requestUserCommand(() => useApp.getState().openBasePanel({ kind: 'hub', featureId: 'hub.next' }));
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(pending).toHaveLength(1); expect(useApp.getState().basePanel?.featureId).toBe('hub.next');
  });
  it.each(['info', 'obstacle'] as const)('retargets a wrapped %s selection without pre-clearing the panel', kind => {
    configureBasePanels(createBaseFeatureRegistry([{ ...definition, id: 'target', kind, dismissal: 'allow' }]), true);
    useApp.getState().openBasePanel({ kind, featureId: 'target', ...(kind === 'info' ? { buildingId: 'old' } : { obstacleId: 'old' }) });
    requestUserCommand(() => kind === 'info' ? useApp.getState().select('new') : useApp.getState().selectObstacle('new'));
    expect(useApp.getState().basePanel).toMatchObject({ kind, featureId: 'target', ...(kind === 'info' ? { buildingId: 'new' } : { obstacleId: 'new' }) });
  });
  it('preserves an unscoped hub through a wrapped deselection and repeated same-panel commands', async () => {
    useApp.getState().openBasePanel(panel); await render(); const original = useApp.getState().basePanel;
    requestUserCommand(() => useApp.getState().select(null));
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toBe(original);
    requestUserCommand(() => useApp.getState().select(null));
    expect(pending).toHaveLength(2); act(() => { expect(pending[1]?.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toBe(original);
  });
});

describe('p1-fixes supplemental authority assertions', () => {
  it('resolves the mounted feature only once for both overlay and panel host', async () => {
    useApp.getState().openBasePanel(panel);
    const resolve = vi.spyOn(featureResolution, 'resolveBaseFeature');
    try { await render(); expect(resolve).toHaveBeenCalledTimes(1); } finally { resolve.mockRestore(); }
  });
  it.each(['wallet', 'base', 'epoch'] as const)('settles a retained command on direct %s invalidation without changing panel identity', async change => {
    useApp.getState().openBasePanel(panel); await render(); const original = useApp.getState().basePanel;
    const effect = vi.fn(); const settled = vi.fn(); requestUserCommand(effect).onSettled(settled);
    act(() => {
      if (change === 'wallet') useApp.setState({ wallet: 'wallet-b' });
      if (change === 'base') useApp.setState({ selectedBaseId: 'base-b' });
      if (change === 'epoch') useApp.setState(state => ({ baseSelectionEpoch: state.baseSelectionEpoch + 1 }));
      expect(useApp.getState().basePanel).toBe(original);
      expect(settled).toHaveBeenCalledTimes(1); expect(settled).toHaveBeenCalledWith({ status: 'cancelled' });
      expect(pending[0]?.proceed()).toBe(false); expect(effect).not.toHaveBeenCalled();
    });
  });
  it('carries the controlled marker through retarget before the replacement owner mounts', () => {
    configureBasePanels(createBaseFeatureRegistry([{ ...definition, id: 'info', kind: 'info' }]), true);
    useApp.getState().openBasePanel({ kind: 'info', featureId: 'info', buildingId: 'a' });
    const current = useApp.getState().basePanel!; const requests: PanelDismissRequest[] = [];
    const owner = createPanelSession({ panel: current, controlled: true, isCurrent: () => useApp.getState().basePanel === current, canMutate: () => false, canRecover: () => false });
    const off = owner.mount(); owner.setDismissPolicy(request => requests.push(request));
    try {
      requestUserCommand(() => useApp.getState().select('b')); expect(requests[0]?.proceed()).toBe(true);
      const effect = vi.fn(); const settled = vi.fn(); requestUserCommand(effect).onSettled(settled);
      expect(useApp.getState().basePanel?.buildingId).toBe('b'); expect(effect).not.toHaveBeenCalled();
      expect(settled).toHaveBeenCalledWith({ status: 'cancelled' });
    } finally { off(); }
  });
  it('preserves the same scoped panel when its current building is selected again', () => {
    configureBasePanels(createBaseFeatureRegistry([{ ...definition, id: 'army', kind: 'army', dismissal: 'allow' }]), true);
    useApp.getState().openBasePanel({ kind: 'army', featureId: 'army', buildingId: 'a' }); const current = useApp.getState().basePanel;
    requestUserCommand(() => useApp.getState().select('a'));
    expect(useApp.getState().basePanel).toBe(current); expect(useApp.getState().selectedBuildingId).toBe('a');
  });
});
