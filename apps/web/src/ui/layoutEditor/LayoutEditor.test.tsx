/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { createMobileBackGuard, type MobileBackHistory, type MobileBackWindow } from '../../lib/mobileBackGuard';
import type { BaseStateDto } from '../../state/store';
import { sprite } from '../icons';

/** LayoutEditor reuses the build sheet's current-art portrait resolver. The
 * sheet reaches Privy's Solana bundle through this payment hook, whose optional
 * memo peer is supplied only by Vite's browser alias. Nothing in this editor
 * suite signs or buys, so keep the same hermetic boundary as quests.test.tsx. */
vi.mock('../../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));

import { LayoutEditor, layoutEditorMode } from './LayoutEditor';
import type { LayoutClient, LayoutsDto } from './types';

const baseId = '00000000-0000-4000-8000-000000000099';
const keepId = '00000000-0000-4000-8000-000000000001';
const mineId = '00000000-0000-4000-8000-000000000002';
const altarId = '00000000-0000-4000-8000-000000000003';
const base: BaseStateDto = {
  baseId,
  player: { wallet: 'wallet', name: 'Keeper', keepLevel: 4, trophies: 10, league: 'silver', builders: 2, expansions: 0 },
  claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
  buildings: [
    { id: keepId, type: 'keep', level: 4, tx: 8, ty: 8, underConstruction: false },
    { id: mineId, type: 'mine', level: 3, tx: 10, ty: 8, underConstruction: false },
  ],
  obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 2,
};

const etag = (char: string): string => `sha256:${char.repeat(64)}`;
const layouts = (farmLocked = true): LayoutsDto => ({
  baseId, geometryVersion: 1, claim: { min: 8, max: 22, size: 14 },
  active: { slot: null, etag: etag('c') },
  farmUnlock: { locked: farmLocked, costShards: 500 },
  slots: [
    {
      slot: 'HOME', locked: false, etag: etag('a'), compatibility: 'ready',
      positions: base.buildings.map(({ id, tx, ty }) => ({ buildingId: id, tx, ty })),
      unplacedBuildingIds: [], removedBuildingIds: [],
    },
    {
      slot: 'FARM', locked: farmLocked, etag: etag('b'), compatibility: 'empty',
      positions: [], unplacedBuildingIds: [keepId, mineId], removedBuildingIds: [],
    },
  ],
});

let host: HTMLDivElement;
let root: Root;

class BackWindow extends EventTarget implements MobileBackWindow {
  readonly location = { href: 'https://play.pixelkingdomwars.com/?client=solana-mobile' };
  private entries: unknown[] = [{ page: 'game' }];
  private cursor = 0;
  readonly history: MobileBackHistory;
  constructor() {
    super();
    const owner = this;
    this.history = {
      get state() { return owner.entries[owner.cursor]; },
      pushState(data) { owner.entries.splice(owner.cursor + 1); owner.entries.push(data); owner.cursor++; },
      back() { owner.cursor--; owner.dispatchEvent(new Event('popstate')); },
    };
  }
  setTimeout(): number { return 1; }
  clearTimeout(): void {}
}

const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`missing ${label} button`);
  return found;
};

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function client(first = layouts()): LayoutClient & {
  read: ReturnType<typeof vi.fn>;
  unlockFarm: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn().mockResolvedValue(first),
    unlockFarm: vi.fn().mockResolvedValue({
      baseId, slot: 'FARM', locked: false, chargedShards: '500', balanceShards: '0',
    }),
    save: vi.fn().mockResolvedValue({
      baseId, slot: 'HOME', geometryVersion: 1, slotEtag: etag('d'),
      activeEtag: etag('e'), activeSlot: 'HOME', moved: 0, unchanged: 2, replayed: false,
    }),
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  if (!globalThis.crypto.randomUUID) {
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => 'test-idempotency-key' });
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('authoritative layout editor', () => {
  it('guards dirty Android Back, then lets the dialog own Back as cancel', async () => {
    const win = new BackWindow();
    const dispose = createMobileBackGuard({
      win, enabled: true, trustedActivation: () => true,
      getScreen: () => 'base', goToBase: vi.fn(), toast: vi.fn(),
    });
    const close = vi.fn();
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={close}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client()} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());
    win.dispatchEvent(new Event('pointerdown'));
    await act(async () => win.history.back());
    expect(host.querySelector('[role="alertdialog"]')?.getAttribute('aria-label')).toBe('DISCARD LAYOUT?');
    expect(close).not.toHaveBeenCalled();
    await act(async () => win.history.back());
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(close).not.toHaveBeenCalled();
    dispose();
  });

  it('cancel exits the draft without sending any unlock/save mutation', async () => {
    const transport = client();
    const close = vi.fn();
    const reloadBase = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={close}
        reloadBase={reloadBase} client={transport} />,
    ));
    await settle();
    await act(async () => button('CANCEL').click());
    expect(close).toHaveBeenCalledOnce();
    expect(transport.unlockFarm).not.toHaveBeenCalled();
    expect(transport.save).not.toHaveBeenCalled();
    expect(reloadBase).not.toHaveBeenCalled();
  });

  it('pick-up-all trays the Keep as a visual identity card and disables save until undo', async () => {
    const transport = client();
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={transport} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());
    const keepCard = host.querySelector(`[data-layout-tray-id="${keepId}"]`);
    const mineCard = host.querySelector(`[data-layout-tray-id="${mineId}"]`);
    expect(keepCard?.querySelector('img')).toBeTruthy();
    expect(keepCard?.textContent).toContain('KEEP');
    expect(mineCard?.querySelector('img')).toBeTruthy();
    expect(host.textContent).toContain('KEEP REQUIRED · PLACE IT BEFORE SAVING');
    expect(button('SAVE & APPLY').disabled).toBe(true);
    await act(async () => button('UNDO').click());
    expect(button('SAVE & APPLY').disabled).toBe(false);
  });

  it('uses the authoritative hero tier for an altar identity card in the tray', async () => {
    const heroBase: BaseStateDto = {
      ...base,
      buildings: [
        ...base.buildings,
        { id: altarId, type: 'heroaltar', level: 1, tx: 12, ty: 8, underConstruction: false },
      ],
      heroes: [{ hero: 'vex', level: 16, recoveryUntil: null, available: true }],
    };
    const heroLayouts = layouts();
    heroLayouts.slots[0]!.positions.push({ buildingId: altarId, tx: 12, ty: 8 });
    heroLayouts.slots[1]!.unplacedBuildingIds.push(altarId);
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={heroBase} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client(heroLayouts)} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());
    const portrait = host.querySelector<HTMLImageElement>(
      `[data-layout-tray-id="${altarId}"] img`,
    );
    expect(portrait?.getAttribute('src')).toBe(sprite('hero_vex_portrait_t4'));
  });

  it('uses each placed structure tier for Cannon, Mortar, and Wall tray cards', async () => {
    const tiered = [
      { id: '00000000-0000-4000-8000-000000000010', type: 'cannon', level: 6, tx: 12, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000011', type: 'mortar', level: 16, tx: 14, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000012', type: 'wall', level: 11, tx: 16, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000013', type: 'wall', level: 16, tx: 17, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000014', type: 'wall', level: 17, tx: 18, ty: 8 },
    ] as const;
    const tierBase: BaseStateDto = {
      ...base,
      buildings: [
        ...base.buildings,
        ...tiered.map((building) => ({ ...building, underConstruction: false })),
      ],
    };
    const tierLayouts = layouts();
    tierLayouts.slots[0]!.positions.push(...tiered.map(({ id, tx, ty }) => ({
      buildingId: id, tx, ty,
    })));
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={tierBase} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client(tierLayouts)} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());

    for (const [id, key] of [
      [tiered[0].id, 'ui_portrait_cannon_t2'],
      [tiered[1].id, 'ui_portrait_mortar_t4'],
      [tiered[2].id, 'wall5_t3_straight_intact_f1'],
      [tiered[3].id, 'wall5_t4_straight_intact_f1'],
      [tiered[4].id, 'wall5_t5_straight_intact_f1'],
    ] as const) {
      const expected = sprite(key);
      expect(expected, key).not.toBe('');
      const selector = key.startsWith('wall5')
        ? `[data-layout-wall-level="${tiered.find(building => building.id === id)!.level}"] img`
        : `[data-layout-tray-id="${id}"] img`;
      expect(host.querySelector<HTMLImageElement>(selector)?.getAttribute('src')).toBe(expected);
    }
  });

  it('groups trayed walls into one paint card per exact server level', async () => {
    const walls = [
      { id: '00000000-0000-4000-8000-000000000020', type: 'wall', level: 2, tx: 12, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000021', type: 'wall', level: 3, tx: 13, ty: 8 },
      { id: '00000000-0000-4000-8000-000000000022', type: 'wall', level: 2, tx: 14, ty: 8 },
    ] as const;
    const wallBase: BaseStateDto = {
      ...base,
      buildings: [...base.buildings, ...walls.map((wall) => ({ ...wall, underConstruction: false }))],
    };
    const wallLayouts = layouts();
    wallLayouts.slots[0]!.positions.push(...walls.map(({ id, tx, ty }) => ({ buildingId: id, tx, ty })));
    const drafts: unknown[] = [];
    const off = bus.on('base:layoutDraft', (command) => drafts.push(command));
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={wallBase} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client(wallLayouts)} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());
    const cards = host.querySelectorAll('[data-layout-wall-level]');
    expect(cards).toHaveLength(2);
    expect(host.querySelector('[data-layout-wall-level="2"]')?.textContent).toContain('WALLS ×2');
    expect(host.querySelector('[data-layout-wall-level="3"]')?.textContent).toContain('WALLS ×1');
    await act(async () => (host.querySelector('[data-layout-wall-level="2"]') as HTMLButtonElement).click());
    expect(drafts.at(-1)).toMatchObject({ op: 'show', wallPaintLevel: 2 });
    off();
  });

  it('requires every identity even after the trayed Keep itself is replaced', async () => {
    const transport = client();
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={transport} />,
    ));
    await settle();
    await act(async () => button('PICK UP ALL').click());
    await act(async () => bus.emit('base:layoutEdit', {
      kind: 'move', buildingId: keepId, tx: 8, ty: 8,
    }));
    expect(host.textContent).not.toContain('KEEP REQUIRED · PLACE IT BEFORE SAVING');
    expect(host.querySelector(`[data-layout-tray-id="${keepId}"]`)).toBeNull();
    expect(host.querySelector(`[data-layout-tray-id="${mineId}"]`)).toBeTruthy();
    expect(button('SAVE & APPLY').disabled).toBe(true);
    expect(transport.save).not.toHaveBeenCalled();
  });

  it('defaults phone tools to a collapsed strip while preserving every primary control', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 568 });
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client()} />,
    ));
    await settle();
    const editor = host.querySelector('[data-layout-editor]') as HTMLElement;
    expect(editor.dataset.layoutMode).toBe('compact');
    expect(editor.dataset.toolsOpen).toBe('false');
    // D-099 (owner 2026-09-02: "remove wording FARM … we have BASE"): the slot
    // tabs read HOME / BASE and the header LAYOUTS, so BASE names one thing.
    expect(button('HOME')).toBeTruthy();
    expect(button('BASE')).toBeTruthy();
    expect(host.querySelector('.layout-editor-title')?.textContent).toContain('LAYOUTS');
    expect(host.textContent).not.toContain('FARM');
    expect(button('SAVE & APPLY')).toBeTruthy();
    const tools = host.querySelector('[aria-label="Open layout tools"]') as HTMLButtonElement;
    await act(async () => tools.click());
    expect(editor.dataset.toolsOpen).toBe('true');
    expect(button('PICK UP ALL')).toBeTruthy();
  });

  it('save/apply sends one complete ETagged request then reloads server layouts and base', async () => {
    const transport = client();
    transport.read.mockResolvedValueOnce(layouts()).mockResolvedValueOnce({
      ...layouts(), active: { slot: 'HOME', etag: etag('e') },
    });
    const reloadBase = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={reloadBase} client={transport} />,
    ));
    await settle();
    await act(async () => button('SAVE & APPLY').click());
    await vi.waitFor(() => expect(transport.save).toHaveBeenCalledOnce());
    await settle();
    expect(transport.save).toHaveBeenCalledWith(baseId, 'HOME', {
      geometryVersion: 1,
      mode: 'save_apply',
      expectedSlotEtag: etag('a'),
      expectedActiveEtag: etag('c'),
      positions: expect.arrayContaining([
        { buildingId: keepId, tx: 8, ty: 8 },
        { buildingId: mineId, tx: 10, ty: 8 },
      ]),
    });
    expect(reloadBase).toHaveBeenCalledOnce();
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it('unlocks only slot B — labelled BASE, wired as FARM — with a fresh idempotency key and refreshes the balance', async () => {
    const transport = client();
    transport.read.mockResolvedValueOnce(layouts(true)).mockResolvedValueOnce(layouts(false));
    const reloadBase = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={reloadBase} client={transport} />,
    ));
    await settle();
    await act(async () => button('BASE').click());
    // The lock notice and the unlock toast are copy: BASE on screen, never FARM.
    expect(host.textContent).toContain('BASE SLOT LOCKED');
    expect(host.textContent).not.toContain('FARM');
    await act(async () => button('UNLOCK').click());
    await vi.waitFor(() => expect(transport.unlockFarm).toHaveBeenCalledOnce());
    // The wire id is untouched (D-087): the client still calls the FARM unlock.
    expect(transport.unlockFarm.mock.calls[0]![0]).toBe(baseId);
    expect(typeof transport.unlockFarm.mock.calls[0]![1]).toBe('string');
    expect(reloadBase).toHaveBeenCalledOnce();
    expect(transport.read).toHaveBeenCalledTimes(2);
    await settle();
    expect(host.textContent).toContain('BASE UNLOCKED · 500 SHARDS');
    expect(host.textContent).not.toContain('FARM');
  });

  it('accepts scene drag intents into the draft without invoking the API', async () => {
    const transport = client();
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={transport} />,
    ));
    await settle();
    await act(async () => bus.emit('base:layoutEdit', {
      kind: 'move', buildingId: mineId, tx: 13, ty: 10,
    }));
    expect(transport.save).not.toHaveBeenCalled();
    await act(async () => button('SAVE').click());
    await vi.waitFor(() => expect(transport.save).toHaveBeenCalledOnce());
    expect(transport.save.mock.calls[0]![2].positions)
      .toContainEqual({ buildingId: mineId, tx: 13, ty: 10 });
  });

  it('warns when a live base change invalidates and reloads the draft', async () => {
    const transport = client();
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={transport} />,
    ));
    await settle();
    const changedBase: BaseStateDto = {
      ...base,
      buildings: base.buildings.map((building) => building.id === mineId
        ? { ...building, tx: building.tx + 1 }
        : building),
    };
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={changedBase} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={transport} />,
    ));
    expect(host.textContent).toContain('BASE CHANGED — DRAFTS RELOADED FROM THE LIVE BASE');
  });
});

describe('layout editor viewport contract', () => {
  it('keeps the save notice over the shared column so landscape controls retain the viewport width', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 844 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 390 });
    const style = document.createElement('style');
    style.textContent = readFileSync('src/ui/layoutEditor/layoutEditor.css', 'utf8');
    document.head.appendChild(style);
    try {
      await act(async () => root.render(
        <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
          reloadBase={vi.fn().mockResolvedValue(undefined)} client={client()} />,
      ));
      await settle();
      await act(async () => button('SAVE & APPLY').click());
      await settle();
      const editor = host.querySelector<HTMLElement>('[data-layout-editor]')!;
      expect(editor.dataset.layoutMode).toBe('short-landscape');
      expect(editor.querySelector('.layout-editor-notice')?.textContent).toContain('HOME APPLIED');
      // Both row-2 items need an explicit shared column. Auto placement otherwise
      // creates a notice column and narrows the header/footer's control area.
      for (const name of ['head', 'side', 'footer', 'notice']) {
        const element = editor.querySelector<HTMLElement>(`.layout-editor-${name}`)!;
        expect(getComputedStyle(element).gridColumn, name).toBe('1');
      }
    } finally {
      style.remove();
    }
  });

  it('uses the shared compact and short-landscape thresholds', () => {
    expect(layoutEditorMode(320, 568)).toBe('compact');
    expect(layoutEditorMode(412, 915)).toBe('compact');
    expect(layoutEditorMode(915, 412)).toBe('short-landscape');
    expect(layoutEditorMode(1024, 768)).toBe('full');
  });

  it('measures the collapsed short-landscape rail and expands locked BASE (slot B) without covering the canvas', async () => {
    // WHY: CSS-looking-correct is insufficient here—the Phaser camera must
    // receive the actual occupied chrome, including the 44px collapsed rail.
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 915 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 412 });
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left, y: top, left, top, width, height,
      right: left + width, bottom: top + height,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function measure(this: HTMLElement) {
      if (this.classList.contains('layout-editor-head')) return rect(0, 0, 915, 48);
      if (this.classList.contains('layout-editor-footer')) return rect(0, 346, 915, 66);
      if (this.classList.contains('layout-editor-side')) {
        const open = this.closest<HTMLElement>('[data-layout-editor]')?.dataset.toolsOpen === 'true';
        return rect(0, 48, open ? 230 : 44, 298);
      }
      return rect(0, 0, 0, 0);
    });
    const insets: Array<{ top: number; bottom: number; left?: number; right?: number }> = [];
    const off = bus.on('base:insets', (next) => insets.push(next));
    await act(async () => root.render(
      <LayoutEditor baseId={baseId} base={base} onClose={vi.fn()}
        reloadBase={vi.fn().mockResolvedValue(undefined)} client={client()} />,
    ));
    await settle();
    const editor = host.querySelector<HTMLElement>('[data-layout-editor]')!;
    expect(editor.dataset.layoutMode).toBe('short-landscape');
    expect(editor.dataset.toolsOpen).toBe('false');
    expect(insets.at(-1)).toEqual({ top: 48, bottom: 66, left: 44, right: 0 });

    await act(async () => button('BASE').click());
    await settle();
    expect(editor.dataset.toolsOpen).toBe('true');
    expect(insets.at(-1)).toEqual({ top: 48, bottom: 0, left: 230, right: 0 });
    off();
  });
});
