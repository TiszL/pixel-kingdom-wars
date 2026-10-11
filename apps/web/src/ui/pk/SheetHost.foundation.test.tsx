// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PkSheetHost } from './SheetHost';
import { OverlayHost } from './OverlayHost';
import { configureBasePanels } from '../../state/store';
import { createBaseFeatureRegistry, resolveBaseFeature } from './featureRegistry';
import { useApp } from '../../state/store';
import { bus } from '../../lib/events';
import { mergeBasePanelInsets } from './panelInsets';
import { installOverlayEscapeBridge, registerMobileBackHandler, useMobileBackHandler } from '../../lib/mobileBackGuard';

vi.mock('../../lib/mobileBackGuard', async (importOriginal) => ({ ...await importOriginal<typeof import('../../lib/mobileBackGuard')>(), useMobileBackHandler: vi.fn() }));
vi.mock('./usePkViewport', () => ({ usePkViewport: () => ({ vp: 'phone-portrait', w: 412, h: 915, dpr: 1 }) }));
let node: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); node = document.createElement('div'); document.body.append(node); root = createRoot(node); useApp.getState().setAuth('wallet-a'); useApp.getState().setScreen('base'); });
afterEach(() => { act(() => root.unmount()); node.remove(); vi.useRealTimers(); vi.clearAllMocks(); useApp.getState().setAuth(null); });
const sheet = { key: 'army:train', label: 'Train army', size: 'HALF' as const };

describe('the one kit sheet host', () => {
  it('keeps its named content painted but noninteractive during exit', () => {
    const close = vi.fn(); const subscribe = vi.fn(() => vi.fn());
    act(() => root.render(<PkSheetHost sheet={sheet} onClose={close} subscribeEmptyTap={subscribe}><button className="interactive">Train</button></PkSheetHost>));
    expect(node.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Train army');
    expect(useMobileBackHandler).toHaveBeenLastCalledWith(expect.any(Function), true, 220);
    act(() => root.render(<PkSheetHost sheet={null} onClose={close} subscribeEmptyTap={subscribe}>{null}</PkSheetHost>));
    expect(node.textContent).toContain('Train');
    expect(node.querySelector('.pk-sheethost')?.getAttribute('data-phase')).toBe('out');
    expect(node.querySelector('.pk-sheethost__panel')?.classList.contains('interactive')).toBe(false);
    expect(node.querySelector('.pk-sheethost__panel')?.hasAttribute('inert')).toBe(true);
    act(() => vi.runAllTimers()); expect(node.querySelector('[role="dialog"]')).toBeNull();
  });
  it('uses the same scene empty-tap subscription only while the half sheet is open', () => {
    const close = vi.fn(); const unsubscribe = vi.fn(); const subscribe = vi.fn((_listener: () => void) => unsubscribe);
    act(() => root.render(<PkSheetHost sheet={sheet} onClose={close} subscribeEmptyTap={subscribe}>Content</PkSheetHost>));
    const callback = subscribe.mock.calls[0]?.[0] as (() => void) | undefined;
    act(() => callback?.()); expect(close).toHaveBeenCalledTimes(1);
    act(() => root.render(<PkSheetHost sheet={null} onClose={close} subscribeEmptyTap={subscribe}>{null}</PkSheetHost>));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('uses a compact side panel on the short landscape viewport', () => {
    act(() => root.render(<PkSheetHost sheet={{ ...sheet, size: 'FULL' }} onClose={vi.fn()} subscribeEmptyTap={() => () => undefined} viewport={{ vp: 'phone-landscape', w: 915, h: 311, dpr: 1, short: true }}>Content</PkSheetHost>));
    expect(node.querySelector('.pk-sheethost')?.getAttribute('data-layout')).toBe('side');
    expect(node.querySelector('.pk-sheethost')?.getAttribute('data-header')).toBe('compact');
  });
});

const load = () => Promise.resolve({ default: ({ onClose }: { onClose: () => void }) => <button className="interactive" onClick={onClose}>Recover original operation</button> });
const recovery = { id: 'account.recovery', kind: 'account' as const, label: 'Account recovery', size: 'HALF' as const, readOnly: true, load };
describe('one lazy registry and one sheet host', () => {
  it('refuses duplicate feature ownership instead of silently replacing a loader', () => {
    expect(() => createBaseFeatureRegistry([recovery, recovery])).toThrow(/duplicate/i);
  });
  it('does not resolve unregistered or kind-mismatched feature requests', () => {
    const registry = createBaseFeatureRegistry([recovery]);
    expect(resolveBaseFeature(registry, { kind: 'army', featureId: recovery.id }, true)).toBeNull();
    expect(resolveBaseFeature(registry, { kind: 'account', featureId: 'missing' }, true)).toBeNull();
  });
  it('keeps recovery reachable on a read-only deed but refuses mutation panels', () => {
    const registry = createBaseFeatureRegistry([recovery, { ...recovery, id: 'army.train', kind: 'army', readOnly: false }]);
    expect(resolveBaseFeature(registry, { kind: 'account', featureId: recovery.id }, false)?.id).toBe(recovery.id);
    expect(resolveBaseFeature(registry, { kind: 'army', featureId: 'army.train' }, false)).toBeNull();
  });
  it('keeps a named loading frame while the sheet chunk is pending', async () => {
    const registry = createBaseFeatureRegistry([{ ...recovery, load: () => new Promise(() => undefined) }]);
    configureBasePanels(registry, false); useApp.getState().openBasePanel({ kind: 'account', featureId: recovery.id });
    await act(async () => root.render(<OverlayHost registry={registry} baseActionsEnabled={false} onInset={() => undefined}>{null}</OverlayHost>));
    expect(node.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(node.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(recovery.label);
    expect(node.querySelector('[role="status"]')?.textContent).toContain('Loading Account recovery');
    expect(useApp.getState().screen).toBe('base');
  });
  it('routes empty-ground dismissal through the single scene event without changing screen', async () => {
    const registry = createBaseFeatureRegistry([recovery]);
    configureBasePanels(registry, false); useApp.getState().openBasePanel({ kind: 'account', featureId: recovery.id });
    await act(async () => root.render(<OverlayHost registry={registry} baseActionsEnabled={false} onInset={() => undefined}>{null}</OverlayHost>));
    expect(node.textContent).toContain('Recover original operation');
    act(() => bus.emit('base:emptyTap', undefined));
    expect(useApp.getState().basePanel).toBeNull();
    expect(useApp.getState().screen).toBe('base');
  });
});

describe('one desktop bridge shares mobile Back ownership', () => {
  it('uses priority then newest registration and unregisters cleanly', () => {
    const sheetClose = vi.fn(); const drawerClose = vi.fn(); const sealClose = vi.fn();
    const offSheet = registerMobileBackHandler(sheetClose, 220);
    const offDrawer = registerMobileBackHandler(drawerClose, 230);
    const offSeal = registerMobileBackHandler(sealClose, 300);
    const offBridge = installOverlayEscapeBridge(window);
    try {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      window.dispatchEvent(escape);
      expect(sealClose).toHaveBeenCalledTimes(1); expect(drawerClose).not.toHaveBeenCalled();
      expect(escape.defaultPrevented).toBe(true);
      offSeal(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(drawerClose).toHaveBeenCalledTimes(1); expect(sheetClose).not.toHaveBeenCalled();
      offDrawer(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(sheetClose).toHaveBeenCalledTimes(1);
      offBridge(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(sheetClose).toHaveBeenCalledTimes(1);
    } finally { offBridge(); offSheet(); offDrawer(); offSeal(); }
  });
  it('respects local cancellation and a top owner that declines', () => {
    const close = vi.fn(() => false); const off = registerMobileBackHandler(close);
    const bridge = installOverlayEscapeBridge(window);
    try {
      const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); handled.preventDefault();
      window.dispatchEvent(handled); expect(close).not.toHaveBeenCalled();
      const declined = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      window.dispatchEvent(declined); expect(close).toHaveBeenCalledTimes(1); expect(declined.defaultPrevented).toBe(false);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); expect(close).toHaveBeenCalledTimes(1);
    } finally { bridge(); off(); }
  });
});
describe('the normal-base camera has one merged inset publication', () => {
  const hud = { top: 84, bottom: 90, left: 10, right: 20 };
  it('keeps HUD clearance and adds only the occluded panel edge', () => {
    expect(mergeBasePanelInsets(hud, { bottom: 350, right: 0 })).toEqual({ ...hud, bottom: 350 });
    expect(mergeBasePanelInsets(hud, { bottom: 0, right: 400 })).toEqual({ ...hud, right: 400 });
    expect(mergeBasePanelInsets(hud, null)).toEqual(hud);
    expect(mergeBasePanelInsets(hud, { bottom: 350, right: 0 }, 64)).toEqual({ ...hud, bottom: 414 });
    expect(hud.bottom).toBe(90);
  });
});

describe('sheet geometry follows loaded content, including its edge gap', () => {
  it('measures without transforms, refreshes on content resize and releases the inset', () => {
    const inset = vi.fn(); let notify: (() => void) | undefined; const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe(): void {} disconnect = disconnect;
    });
    try {
      act(() => root.render(<PkSheetHost sheet={sheet} onClose={vi.fn()} subscribeEmptyTap={() => () => undefined} onInset={inset}>Content</PkSheetHost>));
      const panel = node.querySelector('.pk-sheethost__panel') as HTMLDivElement;
      const host = node.querySelector('.pk-sheethost') as HTMLDivElement;
      Object.defineProperties(panel, { offsetHeight: { configurable: true, value: 350 }, offsetTop: { configurable: true, value: 500 } });
      Object.defineProperty(host, 'clientHeight', { configurable: true, value: 900 });
      act(() => notify?.());
      expect(inset).toHaveBeenLastCalledWith({ bottom: 400, right: 0 });
      Object.defineProperty(panel, 'offsetTop', { configurable: true, value: 450 });
      act(() => notify?.()); expect(inset).toHaveBeenLastCalledWith({ bottom: 450, right: 0 });
      act(() => root.render(<PkSheetHost sheet={null} onClose={vi.fn()} subscribeEmptyTap={() => () => undefined} onInset={inset}>{null}</PkSheetHost>));
      expect(inset).toHaveBeenLastCalledWith(null); expect(disconnect).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
