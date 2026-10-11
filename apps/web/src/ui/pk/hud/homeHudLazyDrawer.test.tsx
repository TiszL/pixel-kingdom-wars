// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeHudActions, HomeHudUi, ResourceDrawerUi } from '../hudModel';
import { HomeHud } from '../HomeHud';

const drawerModule = vi.hoisted(() => ({
  loads: 0,
  defer: false,
  release: null as (() => void) | null,
}));

vi.mock('../pkViewport', () => ({ usePkViewportClass: () => 'phone-portrait' }));
vi.mock('../Button', () => ({ PkBadge: () => null }));
vi.mock('../StatusChip', () => ({ PkStatusChip: () => <span data-status-chip /> }));
vi.mock('../HudArt', () => ({
  ChunkyFace: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  HudIcon: () => <span data-hud-icon />,
}));
vi.mock('../ResourceDrawer', async () => {
  drawerModule.loads += 1;
  // An eager import resolves immediately during test-module loading and is caught
  // by loads===0 below. Only the requested dynamic import is delayed in this test.
  if (drawerModule.defer) await new Promise<void>(resolve => { drawerModule.release = resolve; });
  return {
    ResourceDrawer: ({ ui, on }: { ui: ResourceDrawerUi | null; on: HomeHudActions }) => (
      <section data-resource-drawer data-focus={ui?.focusRowId ?? 'closed'}>
        <button data-close onClick={on.closeDrawer}>Close</button>
        <button data-focus-row onClick={() => on.focusResource('gems')}>Focus Gems</button>
        <button data-go onClick={() => on.openFeature('owner.destination')}>Go</button>
      </section>
    ),
  };
});

const ui: HomeHudUi = {
  profile: { id: 'hud.profile', level: '…', portrait: null, description: 'Profile' },
  builders: { id: 'hud.builders', icon: 'builder', value: '…', description: 'Builders' },
  shield: { id: 'hud.shield', icon: 'shield', value: '…', description: 'Shield' },
  resources: [], rightEdge: [], leftEdge: [], herald: null, deck: [], deckVisible: true,
};
const actions = (): HomeHudActions => ({
  openFeature: vi.fn(), openDrawer: vi.fn(), focusResource: vi.fn(), closeDrawer: vi.fn(),
});
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  drawerModule.release?.();
  if (root) await act(async () => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe('HomeHud lazy ResourceDrawer contract — review 88814cdb M5', () => {
  it('loads only after an open and retains the drawer with current props across pending close and reopen', async () => {
    // Keep the lifecycle in one case: the real module-scope React.lazy cache must
    // survive close/reopen, while a fresh initial closed render must load nothing.
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    const firstActions = actions();
    const render = async (drawer: ResourceDrawerUi | null, on = firstActions) => {
      await act(async () => root!.render(<HomeHud ui={ui} on={on} drawer={drawer} />));
    };
    await render(null);
    expect(drawerModule.loads).toBe(0);
    expect(container.querySelector('.pk-hud')).not.toBeNull();
    expect(container.querySelector('[data-resource-drawer]')).toBeNull();

    drawerModule.defer = true;
    await render({ groups: [], focusRowId: 'shards' });
    await vi.waitFor(() => expect(drawerModule.release).toBeTypeOf('function'));
    expect(drawerModule.loads).toBe(1);
    expect(container.querySelector('.pk-hud')).not.toBeNull(); // Suspense is drawer-local.
    expect(container.querySelector('[data-resource-drawer]')).toBeNull();

    // Closing while the chunk is pending must pass the latest null, not replay Shards.
    const currentActions = actions();
    await render(null, currentActions);
    await act(async () => { drawerModule.release?.(); });
    await vi.waitFor(() => expect(container!.querySelector('[data-resource-drawer]')).not.toBeNull());
    const drawerNode = container.querySelector('[data-resource-drawer]')!;
    expect(drawerNode.getAttribute('data-focus')).toBe('closed');

    await render({ groups: [], focusRowId: 'gems' }, currentActions);
    expect(container.querySelector('[data-resource-drawer]')).toBe(drawerNode);
    expect(drawerNode.getAttribute('data-focus')).toBe('gems');
    await act(async () => {
      (drawerNode.querySelector('[data-close]') as HTMLButtonElement).click();
      (drawerNode.querySelector('[data-focus-row]') as HTMLButtonElement).click();
      (drawerNode.querySelector('[data-go]') as HTMLButtonElement).click();
    });
    expect(currentActions.closeDrawer).toHaveBeenCalledTimes(1);
    expect(currentActions.focusResource).toHaveBeenCalledWith('gems');
    expect(currentActions.openFeature).toHaveBeenCalledWith('owner.destination');
    expect(firstActions.closeDrawer).not.toHaveBeenCalled();
    expect(firstActions.focusResource).not.toHaveBeenCalled();
    expect(firstActions.openFeature).not.toHaveBeenCalled();

    // ResourceDrawer owns its kept payload and animation. It must remain mounted
    // with ui=null to run that exit; the wrapper must not unmount it on close.
    await render(null, currentActions);
    expect(container.querySelector('[data-resource-drawer]')).toBe(drawerNode);
    expect(drawerNode.getAttribute('data-focus')).toBe('closed');
    await render({ groups: [], focusRowId: 'skr' }, currentActions);
    expect(container.querySelector('[data-resource-drawer]')).toBe(drawerNode);
    expect(drawerNode.getAttribute('data-focus')).toBe('skr');
    expect(drawerModule.loads).toBe(1);
  });
});
