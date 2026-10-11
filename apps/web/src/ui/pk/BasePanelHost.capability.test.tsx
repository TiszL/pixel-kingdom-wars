// @vitest-environment happy-dom
import { act, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configureBasePanels, useApp } from '../../state/store';
import { OverlayHost } from './OverlayHost';
import { createBaseFeatureRegistry, type BaseFeatureProps } from './featureRegistry';

vi.mock('./usePkViewport', () => ({ usePkViewport: () => ({ vp: 'phone-portrait', w: 412, h: 915, dpr: 1 }) }));
let root: Root, node: HTMLDivElement, received: BaseFeatureProps;
let mounts: number, unmounts: number, begin: () => boolean, release: () => void;
let hold: Promise<void>, pending: Promise<void> | undefined, send: ReturnType<typeof vi.fn<() => void>>;
const onInset = () => undefined;
function ControllerProbe(props: BaseFeatureProps): React.JSX.Element {
  received = props;
  const allowed = useRef(props.actionsEnabled); allowed.current = props.actionsEnabled;
  useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  useLayoutEffect(() => props.session.setDismissPolicy(() => undefined), [props.session]);
  // Deferred fixture boundary: proves the host delivers the new prop to the
  // SAME retained owner. Real Workshop/expedition pre-POST checks belong to F2b.
  begin = () => props.session.dispatch('mutate', () => {
    pending = hold.then(() => { if (allowed.current === true) send(); });
  });
  return <input aria-label="Retained draft" />;
}
const definition = { id: 'hub.capability-probe', kind: 'hub' as const, label: 'Capability probe', size: 'HALF' as const,
  readOnly: false, dismissal: 'controller' as const, canMutate: () => true, canRecover: () => true,
  load: async () => ({ default: ControllerProbe }) };
const registry = createBaseFeatureRegistry([definition]);
const panel = { kind: 'hub' as const, featureId: definition.id };
async function render(enabled: boolean): Promise<void> {
  await act(async () => root.render(<OverlayHost registry={registry} baseActionsEnabled={enabled} onInset={onInset}>
    <span>Legacy</span>
  </OverlayHost>));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers();
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  mounts = 0; unmounts = 0; send = vi.fn(); pending = undefined;
  hold = new Promise<void>(resolve => { release = resolve; });
  configureBasePanels(registry, true);
  useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a', false); useApp.getState().setScreen('base');
});
afterEach(() => {
  act(() => root.unmount()); node.remove(); useApp.getState().setAuth(null);
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('passes true, false and restored capability to the same mounted draft and session', async () => {
  useApp.getState().openBasePanel(panel); await render(true);
  expect(received.actionsEnabled).toBe(true); const session = received.session;
  const input = node.querySelector<HTMLInputElement>('input')!; input.value = 'preserved draft';
  await render(false); expect(received.actionsEnabled).toBe(false);
  expect(received.session).toBe(session); expect(node.querySelector('input')).toBe(input);
  expect(input.value).toBe('preserved draft'); expect(mounts).toBe(1); expect(unmounts).toBe(0);
  await render(true); expect(received.actionsEnabled).toBe(true);
  expect(received.session).toBe(session); expect(node.querySelector('input')).toBe(input);
  expect(input.value).toBe('preserved draft'); expect(mounts).toBe(1); expect(unmounts).toBe(0);
});
it.each([true, false])('updates the retained owner before a pending continuation; capability loss=%s', async loss => {
  useApp.getState().openBasePanel(panel); await render(true); expect(begin()).toBe(true);
  expect(pending).toBeDefined(); expect(send).not.toHaveBeenCalled();
  await render(!loss); expect(received.actionsEnabled).toBe(!loss);
  await act(async () => { release(); await pending; });
  expect(send).toHaveBeenCalledTimes(loss ? 0 : 1); expect(mounts).toBe(1); expect(unmounts).toBe(0);
});
it('supplies explicit false for a recovery-only mount while preserving dispatch admission', async () => {
  configureBasePanels(registry, false); useApp.getState().openBasePanel(panel); await render(false);
  expect(received.actionsEnabled).toBe(false); expect(mounts).toBe(1);
  const mutate = vi.fn(), recover = vi.fn();
  expect(received.session.dispatch('mutate', mutate)).toBe(false); expect(mutate).not.toHaveBeenCalled();
  expect(received.session.dispatch('recover', recover)).toBe(true); expect(recover).toHaveBeenCalledOnce();
});
