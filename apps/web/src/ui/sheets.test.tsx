/** @vitest-environment happy-dom */
import {
  ART_V2, BUILD_COSTS, PHASE_E_VEHICLES, buildCountCapForKeep, CAPS, fmtDur, HEROES, MINING, OBSTACLES, speedupCostKeep, TRAP_REPAIR,
  TRAP_TYPES, WARE_PORTRAIT_ART, warePortraitAliasKey,
} from '@shardkeep/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../state/store';
import { bus } from '../lib/events';
import { createPanelSession, type PanelDismissRequest } from './pk/panelSession';
import { KEEP_CONFIRM_KEY } from '../lib/keepConfirm';
import { ApiError } from '../lib/api';

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), reload: vi.fn(), heroReview: vi.fn(), heroPayment: vi.fn(), heroHistory: vi.fn(), heroPending: false, heroIntent: false, builderReview: vi.fn(), builderAvailable: true, berthArt: false }));

vi.mock('./icons', async (importOriginal) => {
  const original = await importOriginal<typeof import('./icons')>();
  return { ...original, sprite: (key: string) => key === 'bld_berth_l1' ? (mocks.berthArt ? '/test/berth.png' : '') : original.sprite(key) };
});

vi.mock('../lib/api', async (importOriginal) => ({
  ApiError: (await importOriginal<typeof import('../lib/api')>()).ApiError,
  api: { get: mocks.get, post: mocks.post },
  idemKey: () => 'test-intent-key',
  isLandNotOwned: () => false,
}));
// Hero placement now delegates to durable review; the controller/browser suites
// exercise exact contract-only submission and changed-stock refusal.
// The altar delegates only to the shared durable payment owner. Real confirmation,
// cancellation and receipt behavior are exercised by HeroProgression/roster suites.
vi.mock('./HeroRecruitmentPanel', () => ({ HeroRecruitmentPanel: () => <div>Hero placement controller</div> }));
vi.mock('../lib/heroProgression/context', () => ({ useHeroProgressionView: () => ({
  begin: mocks.heroPayment, openHistory: mocks.heroHistory, actionsEnabled: true,
  state: { loaded: true, busy: false, journal: { operation: mocks.heroPending ? {} : null } },
}) }));
vi.mock('../lib/builderJobSpeedup/context', () => ({ useBuilderJobSpeedupView: () => mocks.builderAvailable ? ({
  begin: mocks.builderReview, actionsEnabled: true, state: { loaded: true, busy: false },
}) : null }));
vi.mock('../auth/useHeroRecruitmentRecovery', () => ({ useHeroRecruitmentRecovery: () => ({
  controller: { review: mocks.heroReview }, state: { journal: mocks.heroIntent ? { intent: {} } : null, review: null, busy: false, error: null },
}) }));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: mocks.reload, reloadCurrentBaseSnapshot: mocks.reload }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));

// Importing the sheet normally reaches wallet adapters through this hook;
// this pure-contract suite does not exercise the purchase flow. (The old
// useMineBuild mock left with the hook itself — mine builds are SOL-free
// since D-057.)
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
import {
  ActionSheet, BUILD_TRAY, BuildTray, berthConstructionAvailable, buildCountPresentation, ObstacleSheet, sheetPortrait,
  spentTrapRepairs, spriteFor, trapRepairDetails, trayLabel,
} from './sheets';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mocks.berthArt = false;
  mocks.builderReview.mockReset(); mocks.builderAvailable = true;
  mocks.heroPayment.mockReset(); mocks.heroHistory.mockReset(); mocks.heroPending = false; mocks.heroIntent = false;
  mocks.heroReview.mockReset().mockResolvedValue(undefined);
  mocks.post.mockReset().mockResolvedValue({});
  mocks.get.mockReset().mockResolvedValue({ catalog: [] });
  mocks.reload.mockReset().mockResolvedValue(true);
  localStorage.clear(); // the KEEP-confirm opt-out is a localStorage preference
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

/** The KEEP confirmation portals to <body>, so it is never inside `host`. */
const keepDialog = (): HTMLElement | null => document.querySelector('[role="alertdialog"]');


afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useApp.setState({ base: null, selectedBuildingId: null, selectedObstacleId: null, selectedBaseId: null, screen: 'base', buildCategory: 'def', placing: null });
});

describe('M22 build and detail surfaces', () => {
  it('shows unavailable Mine status honestly and refreshes the visible balance after collecting', async () => {
    useApp.setState({ screen: 'base', selectedBuildingId: 'mine-a', selectedBaseId: 'deed-a',
      base: { player: { keepLevel: 2, builders: 1 }, buildings: [
        { id: 'mine-a', type: 'mine', level: 1, tx: 8, ty: 8 },
        { id: 'mine-b', type: 'mine', level: 1, tx: 9, ty: 8 },
      ], jobs: [], freeBuilders: 1 } as never });
    let fail!: (reason: Error) => void;
    mocks.get.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    await act(async () => root.render(<ActionSheet />));
    const miningButton = () => [...host.querySelectorAll('button')]
      .find((button) => /MINING|COLLECT MINING/.test(button.textContent ?? ''))!;
    expect(miningButton().textContent).toContain('LOADING MINING');
    expect(miningButton().disabled).toBe(true);
    expect(host.textContent).not.toContain('0 / 0');
    await act(async () => fail(new Error('offline')));
    expect(miningButton().textContent).toContain('MINING STATUS UNAVAILABLE');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('could not refresh');

    const status = (accrued: number) => ({ mining: {
      accrued, storageCap: 1000, ratePerHour: 41, mineCount: 2,
    } });
    mocks.get.mockResolvedValue(status(12));
    await act(async () => [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retry')!.click());
    expect(miningButton().textContent).toContain('12 / 1,000');
    expect(host.textContent).toContain('all 2 mine buffers');
    mocks.post.mockResolvedValue({ amount: '12' });
    mocks.get.mockResolvedValue(status(0));
    await act(async () => miningButton().click());
    expect(mocks.post).toHaveBeenCalledWith('/mine/collect', { baseId: 'deed-a' });
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(miningButton().textContent).toContain('0 / 1,000');
    expect(miningButton().disabled).toBe(false);
  });

  it.each([0, 1, 2, 7])('quotes the same next-mine price in catalog and placement with %i owned mines', async (owned) => {
    // The next slot counts identities still being built, just like the locked
    // server purchase. The catalog must not advertise the first-mine SHARDS fee.
    useApp.setState({ screen: 'build', buildCategory: 'bld', placing: null, entryPaid: true,
      selectedBaseId: null, base: { player: { keepLevel: 20 }, freeBuilders: 1,
        buildings: Array.from({ length: owned }, (_, i) => ({ id: `mine-${i}`, type: 'mine', underConstruction: i === owned - 1 })),
      } as never });
    await act(async () => root.render(<BuildTray />));
    const expected = `${MINING.MINE_BUILD_KEEP[owned]!.toLocaleString()} ${owned === 0 ? 'SHARDS' : 'KEEP'}`;
    const mine = host.querySelector<HTMLButtonElement>('[data-build-type="mine"]')!;
    expect(mine.querySelector('[data-build-price]')?.textContent).toBe(expected);
    expect(mine.getAttribute('aria-label')).toContain(expected);
    await act(async () => mine.click());
    expect(host.querySelector('[data-build-price]')?.textContent).toBe(expected);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('opens current Vault information before placement without a purchase or placement intent', async () => {
    useApp.setState({ screen: 'build', buildCategory: 'bld', placing: null, base: null, entryPaid: true });
    const start = vi.fn(); const off = bus.on('build:start', start);
    try {
      await act(async () => root.render(<BuildTray />));
      const info = host.querySelector<HTMLButtonElement>('[aria-label="Info about VAULT"]')!;
      expect(info.disabled).toBe(false);
      await act(async () => info.click());
      await vi.waitFor(() => expect(host.textContent).toContain('Your best STANDING Vault shields part of that'));
      expect(host.querySelector('[role="region"]')?.textContent).not.toContain('AT LEVEL 2');
      expect(host.querySelector('[role="region"]')?.textContent).toContain('SHIELDS');
      expect(useApp.getState().placing).toBeNull();
      expect(start).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
      await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'CLOSE INFO')!.click());
      expect(host.querySelector('[role="region"]')).toBeNull();
      expect(host.querySelector('[data-build-type="vault"]')).toBeTruthy();
    } finally { off(); useApp.setState({ buildCategory: 'def' }); }
  });

  it('retires an accepted placement before a failed refresh so retry cannot buy it twice', async () => {
    useApp.setState({ screen: 'build', placing: 'camp', selectedBaseId: null, base: null });
    mocks.reload.mockRejectedValueOnce(new Error('offline'));
    const end = vi.fn();
    const off = bus.on('build:end', end);
    await act(async () => root.render(<BuildTray />));
    await act(async () => bus.emit('build:spot', { tx: 10, ty: 10, valid: true }));
    const place = [...host.querySelectorAll('button')].find((button) => button.textContent === '✓ PLACE')!;
    await act(async () => place.click());
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(useApp.getState().placing).toBeNull();
    expect(end).toHaveBeenCalledOnce();
    expect(useApp.getState().screen).toBe('loading');
    expect(host.textContent).not.toContain('PLACE');
    off();
  });

  it('shows current contract stock and delegates Hero placement to explicit durable review', async () => {
    useApp.getState().setAuth('wallet-contract');
    useApp.setState({ screen: 'build', placing: 'heroaltar', selectedBaseId: null, base: null });
    mocks.get.mockResolvedValue({ catalog: [{ id: HEROES.vex.recruitItemId,
      activation: { kind: 'hero', active: false, availableContracts: 1 } }] });
    await act(async () => root.render(<BuildTray />));
    expect(host.textContent).toContain('USES 1 HERO CONTRACT · NO GEMS OR KEEP');
    expect(host.textContent).not.toContain('OR 1 HERO CONTRACT');
    await act(async () => bus.emit('build:spot', { tx: 10, ty: 10, valid: true }));
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'REVIEW PLACEMENT')!.click());
    expect(mocks.heroReview).toHaveBeenCalledExactlyOnceWith({ baseId: null, type: 'heroaltar', tx: 10, ty: 10 });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(host.textContent).toContain('USES 1 HERO CONTRACT · NO GEMS OR KEEP');
  });

  it('requires price review when neither currency capability nor contract stock can be verified', async () => {
    useApp.getState().setAuth('wallet-contract');
    useApp.setState({ screen: 'build', placing: 'heroaltar', selectedBaseId: null, base: null });
    mocks.get.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(<BuildTray />));
    // Cached game constants cannot authorize a currency on an unknown server.
    expect(host.textContent).toContain('REVIEW PRICE');
    expect(host.textContent).toContain('OR 1 HERO CONTRACT');
    expect(host.textContent).not.toContain('USES 1 HERO CONTRACT');
  });

  it('offers every exact M22 runtime type without renaming stored identities', () => {
    const defenses = BUILD_TRAY.def;
    const buildings = BUILD_TRAY.bld;
    expect(defenses).toEqual(expect.arrayContaining([
      'airdefence', 'spiketrap', 'powdermine', 'pitfall', 'airmine',
    ]));
    expect(buildings).toContain('clanhall');
    expect(buildings).toContain('forge');
  });

  it('keeps every build-header destination in the 320px compact form', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 568 });
    useApp.setState({ screen: 'build', entryPaid: true, placing: null, base: null });
    await act(async () => root.render(<BuildTray />));
    const header = host.querySelector('[data-build-tray-header]') as HTMLElement;
    expect(header.dataset.compact).toBe('1');
    expect(header.querySelector('[data-build-tray-tabs]')?.textContent).toBe('DEFENSESBUILDINGSHEROES');
    expect(header.querySelector('[data-build-tray-tools] [aria-label="Base layout"]')).toBeTruthy();
    const close = header.querySelector<HTMLButtonElement>('[data-build-tray-tools] button[aria-label="Close build tray"]');
    expect(close).toBeTruthy(); // Native button also makes the exit keyboard accessible.
    expect(header.querySelector('button[aria-label="Minimise build tray"]')).toBeTruthy();
    await act(async () => close!.click());
    expect(useApp.getState().screen).toBe('base');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  });

  it('presents the legacy forge identity as Alchemy Lab without renaming it', () => {
    expect(trayLabel('forge')).toBe('ALCHEMY LAB');
    expect(trayLabel('goldforge')).toBe('GOLD FORGE');
  });

  it('routes every reworked tray card through its generated current-pack portrait', () => {
    for (const type of Object.keys(WARE_PORTRAIT_ART) as Array<keyof typeof WARE_PORTRAIT_ART>) {
      expect(spriteFor(type), type).toBe(warePortraitAliasKey(type, 1));
    }
    expect(spriteFor('wall')).toBe('wall5_t1_straight_intact_f1');
    expect(spriteFor('heroaltar')).toBe('hero_vex_portrait');
    expect(spriteFor('siegestool')).toBe('hero_theo_portrait');
    expect(sheetPortrait('heroaltar', 1, 15)).toBe('hero_vex_portrait');
    expect(sheetPortrait('heroaltar', 1, 16)).toBe('hero_vex_portrait_t4');
    expect(sheetPortrait('siegestool', 1, 16)).toBe('hero_theo_portrait_t4');
    expect(sheetPortrait('cannon', 6)).toBe('ui_portrait_cannon_t2');
    expect(sheetPortrait('mortar', 16)).toBe('ui_portrait_mortar_t4');
    expect(sheetPortrait('wall', 11)).toBe('wall5_t3_straight_intact_f1');
    // Owner progression changes only walls, especially reinforced → shard at16→17.
    for (const [level, tier] of [[1, 1], [4, 1], [5, 2], [8, 2], [9, 3], [12, 3], [13, 4], [16, 4], [17, 5], [20, 5]]) {
      expect(sheetPortrait('wall', level!)).toBe(`wall5_t${tier}_straight_intact_f1`);
    }
    expect(sheetPortrait('cannon', 17)).toBe('ui_portrait_cannon_t4');
  });

  it('derives every spent-trap repair offer from shared tier constants', () => {
    for (const type of TRAP_TYPES) {
      const repair = trapRepairDetails(type, 16, '2026-08-15T10:00:00.000Z');
      expect(repair).toEqual({
        costShards: TRAP_REPAIR[type].costShardsByTier[ART_V2.tiers - 1],
        repairSec: TRAP_REPAIR[type].repairSec,
      });
    }
    expect(trapRepairDetails('spiketrap', 1, null)).toBeNull();
    expect(trapRepairDetails('cannon', 1, '2026-08-15T10:00:00.000Z')).toBeNull();
  });

  it('shows and enforces the aggregate mixed-family trap cap before placement', async () => {
    const traps = Array.from({ length: 20 }, (_, index) => ({
      id: `trap-${index}`,
      type: TRAP_TYPES[index % TRAP_TYPES.length],
      level: 20,
      tx: 2 + (index % 10),
      ty: 2 + Math.floor(index / 10),
      underConstruction: false,
      trapSpentAt: null,
    }));
    useApp.setState({
      screen: 'build', entryPaid: true, placing: null, selectedBaseId: null,
      base: {
        player: {
          wallet: 'wallet', name: 'Keeper', keepLevel: 20, trophies: 0,
          league: 'Bronze', builders: 1, expansions: 0,
        },
        claim: { min: 2, max: 28 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: traps, obstacles: [], army: [], jobs: [], freeBuilders: 1,
      } as never,
    });
    await act(async () => root.render(<BuildTray />));

    for (const type of TRAP_TYPES) {
      const label = trayLabel(type);
      const card = [...host.querySelectorAll('button')]
        .find((button) => button.textContent?.includes(label));
      expect(card, type).toBeDefined();
      expect(card!.querySelector('[data-build-count]')?.textContent)
        .toContain('TRAPS 20 / 20');
      expect(card!.textContent).toContain('MAX');
      expect(card!.disabled).toBe(true);
      await act(async () => card!.click());
      expect(useApp.getState().placing).toBeNull();
    }
  });

  it('derives ordinary, mine and aggregate-trap owned/max counts from shared Keep tables', () => {
    const rows = [
      { type: 'cannon', underConstruction: false },
      { type: 'cannon', underConstruction: true },
      { type: 'mine', underConstruction: false },
      { type: 'spiketrap', underConstruction: false },
      { type: 'airmine', underConstruction: true },
    ];
    expect(buildCountPresentation('cannon', 3, rows)).toEqual({
      owned: 2,
      max: buildCountCapForKeep('cannon', 3),
      atCap: true,
    });
    expect(buildCountPresentation('mine', 3, rows)).toEqual({
      owned: 1,
      max: MINING.MAX_MINES_BY_KEEP[2],
      atCap: false,
    });
    expect(buildCountPresentation('spiketrap', 3, rows)).toEqual({
      owned: 1,
      max: CAPS.trapsByKeepLevel[2],
      familyOwned: 2,
      atCap: false,
    });
  });

  it('uses authoritative berth capacity without widening old snapshots or other building caps', () => {
    const level = BUILD_COSTS.berth.requiresKeepLevel;
    const buildings = [{ type: 'berth' }];
    const capacity = { version: 1, berth: { max: PHASE_E_VEHICLES.installationsPerBaseMax } };
    expect(buildCountPresentation('berth', level, buildings, capacity)).toEqual({ owned: 1, max: PHASE_E_VEHICLES.installationsPerBaseMax, atCap: false });
    for (const invalid of [undefined, { version: 2, berth: { max: 5 } }, { version: 1, berth: { max: '5' } }]) {
      expect(buildCountPresentation('berth', level, buildings, invalid)).toEqual({ owned: 1, max: 1, atCap: true });
    }
    expect(buildCountPresentation('cannon', level, buildings, capacity)).toEqual(buildCountPresentation('cannon', level, buildings));
    const feature = { features: { phaseEBuildings: { version: 1, enabledTypes: ['berth'] } } };
    expect(berthConstructionAvailable(feature, true)).toBe(true);
    expect(berthConstructionAvailable(feature, false)).toBe(false);
    expect(berthConstructionAvailable(null, true)).toBe(false);
    expect(berthConstructionAvailable({ features: { phaseEBuildings: { version: 2, enabledTypes: ['berth'] } } }, true)).toBe(false);
  });

  it('offers admitted berths up to the current server cap and counts unfinished installations', async () => {
    const max = PHASE_E_VEHICLES.installationsPerBaseMax;
    const base = { player: { keepLevel: BUILD_COSTS.berth.requiresKeepLevel }, freeBuilders: 1,
      features: { phaseEBuildings: { version: 1, enabledTypes: ['berth'] } },
      constructionCapacity: { version: 1, berth: { max } },
      buildings: Array.from({ length: max - 1 }, (_, i) => ({ id: `berth-${i}`, type: 'berth', underConstruction: i > 0 })),
    };
    useApp.setState({ screen: 'build', buildCategory: 'bld', placing: null, entryPaid: true, base: base as never });
    await act(async () => root.render(<BuildTray />));
    expect(host.querySelector('[data-build-type="berth"]')).toBeNull();
    mocks.berthArt = true;
    await act(async () => root.render(<BuildTray />));
    const berth = () => host.querySelector<HTMLButtonElement>('[data-build-type="berth"]')!;
    expect(berth().textContent).toContain(`OWNED ${max - 1} / MAX ${max}`);
    expect(berth().disabled).toBe(false);
    await act(async () => useApp.setState({ base: { ...base, buildings: [...base.buildings, { id: 'unfinished-fifth', type: 'berth', underConstruction: true }] } as never }));
    expect(berth().textContent).toContain(`OWNED ${max} / MAX ${max}`);
    expect(berth().disabled).toBe(true);
    await act(async () => useApp.setState({ base: { ...base, features: { phaseEBuildings: { version: 1, enabledTypes: [] } } } as never }));
    expect(host.querySelector('[data-build-type="berth"]')).toBeNull();
  });

  it('refuses a held berth placement when current server capacity drops', async () => {
    mocks.berthArt = true;
    const base = { player: { keepLevel: BUILD_COSTS.berth.requiresKeepLevel }, freeBuilders: 1,
      features: { phaseEBuildings: { version: 1, enabledTypes: ['berth'] } },
      constructionCapacity: { version: 1, berth: { max: PHASE_E_VEHICLES.installationsPerBaseMax } },
      buildings: [{ id: 'original-berth', type: 'berth' }],
    };
    useApp.setState({ screen: 'build', buildCategory: 'bld', placing: 'berth', entryPaid: true, base: base as never });
    await act(async () => root.render(<BuildTray />));
    await act(async () => bus.emit('build:spot', { tx: 15, ty: 17, valid: true }));
    const place = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '✓ PLACE')!;
    expect(place().disabled).toBe(false);
    await act(async () => useApp.setState({ base: { ...base, constructionCapacity: { version: 1, berth: { max: 1 } } } as never }));
    expect(place().disabled).toBe(true);
    await act(async () => place().click());
    expect(mocks.post).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('CURRENT BUILD CAPACITY');
  });

  it('shows a normal structure cap clearly and blocks another placement at max', async () => {
    useApp.setState({
      screen: 'build', entryPaid: true, placing: null, selectedBaseId: null,
      base: {
        player: {
          wallet: 'wallet', name: 'Keeper', keepLevel: 3, trophies: 0,
          league: 'Bronze', builders: 1, expansions: 0,
        },
        claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [
          { id: 'cannon-1', type: 'cannon', level: 1, tx: 8, ty: 8, underConstruction: false },
          { id: 'cannon-2', type: 'cannon', level: 1, tx: 9, ty: 8, underConstruction: true },
        ],
        obstacles: [], army: [], jobs: [], freeBuilders: 1,
      } as never,
    });
    await act(async () => root.render(<BuildTray />));
    const cannon = host.querySelector('[data-build-type="cannon"]') as HTMLButtonElement;
    expect(cannon.querySelector('[data-build-count]')?.textContent).toBe('OWNED 2 / MAX 2');
    expect(cannon.textContent).toContain('MAX');
    expect(cannon.disabled).toBe(true);
    expect(cannon.getAttribute('aria-label')).toContain('2 of 2 owned');
  });

  it('renders the Keep-level mine cap and counts a mine still under construction', async () => {
    // WHY: the server counts the building identity as soon as construction
    // starts; showing only completed mines would advertise a placement it must
    // reject.
    useApp.setState({
      screen: 'build', entryPaid: true, placing: null, selectedBaseId: null,
      base: {
        player: {
          wallet: 'wallet', name: 'Keeper', keepLevel: 1, trophies: 0,
          league: 'Bronze', builders: 1, expansions: 0,
        },
        claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [
          { id: 'mine-1', type: 'mine', level: 1, tx: 8, ty: 8, underConstruction: false },
          { id: 'mine-2', type: 'mine', level: 1, tx: 9, ty: 8, underConstruction: true },
        ],
        obstacles: [], army: [], jobs: [], freeBuilders: 0,
      } as never,
    });
    await act(async () => root.render(<BuildTray />));
    const buildingsTab = [...host.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === 'BUILDINGS')!;
    await act(async () => buildingsTab.click());
    const mine = host.querySelector('[data-build-type="mine"]') as HTMLButtonElement;
    expect(mine.querySelector('[data-build-count]')?.textContent).toBe('OWNED 2 / MAX 2');
    expect(mine.textContent).toContain('MAX');
    expect(mine.disabled).toBe(true);
  });

  it('row selection replaces the single-wall purchase and returns it only after selecting one wall', async () => {
    useApp.getState().setAuth('wall-wallet');
    useApp.setState({ screen: 'base', selectedBuildingId: 'wall-a', wallRow: false, selectedBaseId: null,
      base: { player: { wallet: 'wall-wallet', name: 'Keeper', keepLevel: 5, trophies: 0,
        league: 'bronze', builders: 1, expansions: 0 }, claim: { min: 8, max: 22 },
        energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [{ id: 'wall-a', type: 'wall', level: 1, tx: 8, ty: 8 }],
        obstacles: [], army: [], jobs: [], freeBuilders: 1 } as never });
    await act(async () => root.render(<ActionSheet />));
    const buttons = () => [...host.querySelectorAll('button')];
    expect(buttons().filter((b) => b.textContent?.startsWith('UPGRADE ·'))).toHaveLength(1);
    await act(async () => buttons().find((b) => b.textContent?.includes('SELECT WHOLE ROW'))!.click());
    expect(buttons().filter((b) => b.textContent?.startsWith('UPGRADE ·'))).toHaveLength(0);
    expect(buttons().some((b) => b.textContent?.includes('UPGRADE ROW'))).toBe(true);
    await act(async () => buttons().find((b) => b.textContent?.includes('SELECT SINGLE WALL'))!.click());
    expect(buttons().filter((b) => b.textContent?.startsWith('UPGRADE ·'))).toHaveLength(1);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('renders a spent trap as inert and posts REPAIR instead of UPGRADE', async () => {
    useApp.setState({
      screen: 'base', selectedBuildingId: 'trap-7', selectedBaseId: null,
      base: {
        player: {
          wallet: 'wallet', name: 'Keeper', keepLevel: 16, trophies: 0,
          league: 'Bronze', builders: 1, expansions: 0,
        },
        claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [{
          id: 'trap-7', type: 'pitfall', level: 16, tx: 8, ty: 8,
          underConstruction: false, trapSpentAt: '2026-08-15T10:00:00.000Z',
        }],
        obstacles: [], army: [], jobs: [], freeBuilders: 1,
      } as never,
    });
    await act(async () => root.render(<ActionSheet />));
    expect(host.textContent).toContain('REPAIR SPENT TRAP');
    expect(host.textContent).not.toContain('UPGRADE ·');
    const repairButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('REPAIR'));
    expect(repairButton).toBeDefined();
    await act(async () => repairButton!.click());
    expect(mocks.post).toHaveBeenCalledWith('/base/buildings/trap-7/repair', {});
  });
});

describe('hero recovery speed-up on the altar sheet (owner 2026-08-16)', () => {
  // WHY: the KEEP recovery finish existed only on the BUILD ▸ HEROES roster, so
  // from the downed hero's own altar the feature looked missing ("instant
  // recover is not available for keep"). The altar sheet is where the
  // RECOVERING state is announced, so the paid finish must be offered THERE,
  // priced by the same shared helper the server charges with.
  const altarBase = (heroes: Array<{ hero: string; recoveryUntil: string | null; available: boolean }>) => ({
    player: {
      wallet: 'wallet', name: 'Keeper', keepLevel: 10, trophies: 0,
      league: 'Bronze', builders: 1, expansions: 0,
    },
    claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [{
      id: 'altar-1', type: 'heroaltar', level: 1, tx: 10, ty: 10, underConstruction: false,
    }],
    obstacles: [], army: [], heroes, jobs: [], freeBuilders: 1,
  });

  it('opens a fresh exact-currency review from the altar without pricing or posting from the device countdown', async () => {
    useApp.setState({
      screen: 'base', selectedBuildingId: 'altar-1', selectedBaseId: 'original-base',
      base: altarBase([{ hero: 'vex', recoveryUntil: new Date(Date.now() + 85_000).toISOString(), available: false }]) as never,
    });
    await act(async () => root.render(<ActionSheet />));
    expect(host.textContent).toContain('RECOVERING'); expect(host.textContent).toContain('CANNOT ATTACK OR DEFEND');
    const recoverButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'REVIEW RECOVERY');
    expect(recoverButton).toBeDefined();
    await act(async () => recoverButton!.click());
    expect(mocks.heroPayment).toHaveBeenCalledExactlyOnceWith({ kind: 'recovery', hero: 'vex', baseId: 'original-base' });
    expect(mocks.post).not.toHaveBeenCalled(); expect(keepDialog()).toBeNull();
  });

  it('reopening the altar retains the shared original request instead of creating another recovery payment', async () => {
    mocks.heroPending = true;
    useApp.setState({
      screen: 'base', selectedBuildingId: 'altar-1', selectedBaseId: 'original-base',
      base: altarBase([{ hero: 'vex', recoveryUntil: new Date(Date.now() + 85_000).toISOString(), available: false }]) as never,
    });
    await act(async () => root.render(<ActionSheet />));
    const recoverButton = [...host.querySelectorAll('button')].find(button => button.textContent === 'REVIEW RECOVERY');
    await act(async () => recoverButton!.click());
    expect(mocks.heroHistory).toHaveBeenCalledOnce(); expect(mocks.heroPayment).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('offers no paid finish for a ready hero — READY must never carry a price', async () => {
    useApp.setState({
      screen: 'base', selectedBuildingId: 'altar-1', selectedBaseId: null,
      base: altarBase([{ hero: 'vex', recoveryUntil: null, available: true }]) as never,
    });
    await act(async () => root.render(<ActionSheet />));

    expect(host.textContent).toContain('READY · ATTACK + DEFENCE');
    expect([...host.querySelectorAll('button')]
      .some((button) => button.textContent?.includes('REVIEW RECOVERY'))).toBe(false);
  });
});

describe('⚡ FINISH on a builder job asks before spending KEEP (player report 2026-08-29)', () => {
  // This is the exact reported accident: "I accidentally spent KEEP to instantly
  // finish a building because there was no confirmation warning before the
  // purchase." The sheet's builder-job FINISH is the button that did it.
  const jobBase = (kind: string) => ({
    player: {
      wallet: 'wallet', name: 'Keeper', keepLevel: 10, trophies: 0,
      league: 'Bronze', builders: 1, expansions: 0,
    },
    claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [{
      id: 'bar-1', type: 'barracks', level: 3, tx: 10, ty: 10, underConstruction: true,
    }],
    obstacles: [], army: [], heroes: [], freeBuilders: 0,
    jobs: [{
      id: 'job-1', kind, buildingId: 'bar-1', obstacleId: null,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      // 85 s pins ceil(remaining/30) at 3 units for the whole run (see above).
      finishesAt: new Date(Date.now() + 85_000).toISOString(),
    }],
  });

  const renderJob = async (kind: string): Promise<HTMLButtonElement> => {
    useApp.setState({
      screen: 'base', selectedBuildingId: 'bar-1', selectedBaseId: null,
      base: jobBase(kind) as never,
    });
    await act(async () => root.render(<ActionSheet />));
    const finish = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('REVIEW FINISH PAYMENT'));
    expect(finish).toBeDefined();
    return finish!;
  };

  it('finishes a server-quoted free initial build in one tap without a KEEP dialog', async () => {
    const base = jobBase('build');
    base.buildings[0]!.level = 1;
    useApp.setState({ screen: 'base', selectedBuildingId: 'bar-1', selectedBaseId: null,
      base: { ...base, jobs: base.jobs.map((job) => ({ ...job, finishCostKeep: '0' })) } });
    await act(async () => root.render(<ActionSheet />));
    const finish = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'FINISH NOW · FREE');
    expect(finish).toBeDefined();
    await act(async () => finish!.click());
    expect(keepDialog()).toBeNull();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/base/jobs/job-1/speedup', {});
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('delegates a paid upgrade to the one durable owner without posting or using a local price', async () => {
    const finish = await renderJob('upgrade');
    expect(finish.textContent).toBe('REVIEW FINISH PAYMENT');
    await act(async () => finish.click());
    expect(mocks.builderReview).toHaveBeenCalledExactlyOnceWith({ jobId: 'job-1', baseId: null });
    expect(mocks.post).not.toHaveBeenCalled(); expect(keepDialog()).toBeNull();
  });

  it('a missing free-build verdict cannot be silently converted into paid construction', async () => {
    const finish = await renderJob('build'); expect(finish.disabled).toBe(true);
    await act(async () => finish.click());
    expect(mocks.builderReview).not.toHaveBeenCalled(); expect(mocks.post).not.toHaveBeenCalled();
  });

  it('legacy KEEP confirmation opt-out cannot bypass the durable paid review or its availability', async () => {
    localStorage.setItem(KEEP_CONFIRM_KEY, '0');
    const finish = await renderJob('upgrade'); await act(async () => finish.click());
    expect(mocks.builderReview).toHaveBeenCalledTimes(1); expect(mocks.post).not.toHaveBeenCalled();
    mocks.builderAvailable = false; const unavailable = await renderJob('upgrade');
    expect(unavailable.disabled).toBe(true); await act(async () => unavailable.click());
    expect(mocks.builderReview).toHaveBeenCalledTimes(1); expect(mocks.post).not.toHaveBeenCalled();
  });
});


describe('obstacle sheet follows the running clearing job (tester reports fca93288 + e7cab252, 2026-09-17)', () => {
  // fca93288: tap ROCK S → CLEAR → tap it again while the builder is on it: the
  // sheet still offered cost, "1m" and a yellow CLEAR — a second CLEAR the
  // server 422s with "already clearing". e7cab252: upgrades could be finished
  // with KEEP but a clearing could not. Both are the same missing read of
  // base.jobs, which is where the server says what this obstacle is doing.
  const obstacleBase = (jobs: unknown[]) => ({
    player: {
      wallet: 'wallet', name: 'Keeper', keepLevel: 10, trophies: 0,
      league: 'Bronze', builders: 1, expansions: 0,
    },
    claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], army: [], heroes: [], freeBuilders: 1 - jobs.length,
    obstacles: [
      { id: 'rock-1', spriteKey: 'rock_s', tx: 10, ty: 10 },
      { id: 'bush-2', spriteKey: 'bush', tx: 12, ty: 10 },
    ],
    jobs,
  });
  // 85 s pins ceil(remaining/30) at 3 units for the whole run, like the
  // builder-job suite above, so the asserted price cannot tick mid-test.
  const clearJob = (obstacleId: string, remainingMs = 85_000) => ({
    id: 'job-1', kind: 'clear_obstacle', buildingId: null, obstacleId,
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    finishesAt: new Date(Date.now() + remainingMs).toISOString(),
    finishCostKeep: String(speedupCostKeep(85)), canCancel: false, refundShards: null,
  });
  const renderObstacle = async (jobs: unknown[]): Promise<void> => {
    useApp.setState({ screen: 'base', selectedObstacleId: 'rock-1', selectedBaseId: null,
      base: obstacleBase(jobs) as never });
    await act(async () => root.render(<ObstacleSheet />));
  };
  const button = (label: string): HTMLButtonElement | undefined =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));

  it('offers the shard price, the tier duration and CLEAR only while no job is running', async () => {
    await renderObstacle([]);
    expect(host.textContent).toContain(`${OBSTACLES.tiers.small.costKeep} · ${fmtDur(OBSTACLES.tiers.small.clearSec)}`);
    expect(button('CLEAR')).toBeDefined();
    expect(button('FINISH')).toBeUndefined();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => button('CLEAR')!.click());
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/base/obstacles/rock-1/clear', {});
  });

  it('shows the countdown and live progress instead of the pre-clearing sheet once its job runs', async () => {
    await renderObstacle([clearJob('rock-1')]);
    // The offending state: cost line, "1m" and CLEAR must all be gone.
    expect(button('CLEAR')).toBeUndefined();
    expect(host.textContent).not.toContain(`${OBSTACLES.tiers.small.costKeep} · ${fmtDur(OBSTACLES.tiers.small.clearSec)}`);
    expect(host.textContent).toContain(`CLEARING · ${fmtDur(85)}`);
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Clearing progress');
    // 5 s elapsed of 90 s: a real fraction, not 0 and not the finished 100.
    const now = Number(bar!.getAttribute('aria-valuenow'));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(100);
    // The server refuses to cancel a clearing (JOB_NOT_CANCELLABLE); no
    // control may promise a refund the API has no rule for.
    expect(button('CANCEL')).toBeUndefined();
  });

  it('a clearing delegates its original job to the shared paid owner, never a plain or free POST', async () => {
    await renderObstacle([clearJob('rock-1')]);
    const finish = button('REVIEW FINISH PAYMENT')!; await act(async () => finish.click());
    expect(mocks.builderReview).toHaveBeenCalledExactlyOnceWith({ jobId: 'job-1', baseId: null });
    expect(mocks.post).not.toHaveBeenCalled(); expect(keepDialog()).toBeNull();
  });

  it('a job on ANOTHER obstacle does not put this sheet in progress', async () => {
    await renderObstacle([clearJob('bush-2')]);
    expect(button('CLEAR')).toBeDefined();
    expect(button('FINISH')).toBeUndefined();
    expect(host.textContent).not.toContain('CLEARING ·');
  });

  it('hides FINISH once the timer has elapsed — nothing is left to sell before the snapshot lands', async () => {
    await renderObstacle([clearJob('rock-1', -1_000)]);
    expect(button('FINISH')).toBeUndefined();
    expect(button('CLEAR')).toBeUndefined();
    expect(host.textContent).toContain('CLEARING · VERIFYING');
  });
});

it('keeps building actions visible while optional statistics reset on the next selection', async () => {
  useApp.setState({ screen: 'base', selectedBuildingId: 'cannon-a', selectedBaseId: 'deed-a',
    base: { player: { keepLevel: 20, builders: 1 }, buildings: [
      { id: 'cannon-a', type: 'cannon', level: 1, tx: 8, ty: 8 },
      { id: 'cannon-b', type: 'cannon', level: 2, tx: 10, ty: 8 },
    ], jobs: [], freeBuilders: 1 } as never });
  await act(async () => root.render(<ActionSheet />));
  expect(host.textContent).toContain('UPGRADE');
  expect(host.querySelector('[aria-label="Building statistics"]')).toBeNull();
  const details = [...host.querySelectorAll('button')].find((b) => b.textContent === 'DETAILS')!;
  expect(details.getAttribute('aria-expanded')).toBe('false');
  await act(async () => details.click());
  expect(host.querySelector('[aria-label="Building statistics"]')).not.toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
  await act(async () => useApp.getState().select('cannon-b'));
  expect(host.querySelector('[aria-label="Building statistics"]')).toBeNull();
  expect(host.textContent).toContain('LEVEL 2');
  expect(host.textContent).toContain('UPGRADE');
  expect(mocks.post).not.toHaveBeenCalled();
});

describe('REPAIR ALL TRAPS plan (tester reports 2026-09-16 ×2)', () => {
  // WHY: the button posts the SAME per-trap endpoint once per spent trap and
  // quotes the sum of what each single REPAIR would have shown. A plan that
  // included an armed trap would post a guaranteed 422; one that priced a row
  // differently from the single button would quote money the server won't charge.
  const spent = '2026-09-16T00:00:00.000Z';
  it('lists every spent trap with its own tier price, in base order, and nothing else', () => {
    const [trap, other] = TRAP_TYPES;
    const buildings = [
      { id: 'a', type: trap, level: 1, trapSpentAt: spent },
      { id: 'armed', type: trap, level: 1, trapSpentAt: null },
      { id: 'wall', type: 'wall', level: 3, trapSpentAt: spent },
      { id: 'b', type: other, level: 1, trapSpentAt: spent },
      { id: 'legacy', type: trap, level: 1 },
    ];
    expect(spentTrapRepairs(buildings)).toEqual([
      { id: 'a', costShards: trapRepairDetails(trap, 1, spent)!.costShards },
      { id: 'b', costShards: trapRepairDetails(other, 1, spent)!.costShards },
    ]);
  });
  it('is empty when nothing is spent — the button disables instead of posting', () => {
    expect(spentTrapRepairs([{ id: 'x', type: TRAP_TYPES[0], level: 2, trapSpentAt: null }])).toEqual([]);
  });
});


describe('BuildTray complete placement command', () => {
  it.each(['confirm', 'wallet', 'cap-reached', 'capability', 'unmount'] as const)('keeps build:start and placement together: %s', async change => {
    const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
    useApp.setState({ screen: 'build', basePanel: panel, buildCategory: 'bld', placing: null, entryPaid: true,
      base: { player: { keepLevel: 20 }, buildings: [], jobs: [], freeBuilders: 1 } as never });
    const pending: PanelDismissRequest[] = []; const events: unknown[] = [];
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel,
      canMutate: () => false, canRecover: () => false });
    const off = session.mount(); session.setDismissPolicy(request => { pending.push(request); });
    const offBus = bus.on('build:start', event => events.push(event));
    try {
      await act(async () => root.render(<BuildTray />));
      const card = host.querySelector<HTMLButtonElement>('[data-build-type="mine"]')!;
      expect(card).not.toBeNull(); expect(card.disabled).toBe(false);
      act(() => card.click());
      expect(pending).toHaveLength(1); expect(events).toEqual([]); expect(useApp.getState().placing).toBeNull();
      if (change === 'wallet') act(() => useApp.getState().setAuth('different-wallet'));
      if (change === 'cap-reached') act(() => useApp.setState({ base: { ...useApp.getState().base!, buildings:
        Array.from({ length: MINING.MAX_MINES_BY_KEEP.at(-1)! }, (_, i) => ({ id: 'mine-' + i, type: 'mine' })) } as never }));
      if (change === 'capability') await act(async () => root.render(<BuildTray actionsEnabled={false} />));
      if (change === 'unmount') act(() => root.render(null));
      act(() => { expect(pending[0]?.proceed()).toBe(change === 'confirm'); });
      expect(pending[0]?.proceed()).toBe(false);
      expect(events).toEqual(change === 'confirm' ? [{ type: 'mine' }] : []);
      expect(useApp.getState().placing).toBe(change === 'confirm' ? 'mine' : null);
    } finally { offBus(); off(); useApp.setState({ basePanel: null }); }
  });
});

it('defers REVIEW HERO PLACEMENT with its tab and route in one command', async () => {
  mocks.heroIntent = true; const panel = { kind: 'hub' as const, featureId: 'draft' };
  useApp.setState({ screen: 'base', buildCategory: 'def', basePanel: panel, authed: true });
  const pending: PanelDismissRequest[] = [];
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
  const off = session.mount(); session.setDismissPolicy(request => pending.push(request));
  try {
    await act(async () => root.render(<BuildTray actionsEnabled />));
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'REVIEW HERO PLACEMENT')!;
    expect(button).toBeDefined(); act(() => button.click());
    expect(pending).toHaveLength(1); expect(pending[0]?.reason).toBe('navigate');
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().buildCategory).toBe('def');
    act(() => { expect(pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().screen).toBe('build'); expect(useApp.getState().buildCategory).toBe('her');
    expect(pending[0]?.proceed()).toBe(false); expect(pending).toHaveLength(1);
  } finally { off(); }
});

it('keeps pending hero-placement recovery reachable while base actions are paused', async () => {
  // Recovery of a pending recruitment must remain reachable while base actions are paused.
  mocks.heroIntent = true;
  useApp.setState({ screen: 'base', buildCategory: 'def', basePanel: null, authed: true });
  await act(async () => root.render(<BuildTray actionsEnabled={false} />));
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'REVIEW HERO PLACEMENT')!;
  expect(button).toBeDefined(); act(() => button.click());
  expect(useApp.getState().screen).toBe('build');
  expect(useApp.getState().buildCategory).toBe('her');
  expect(mocks.post).not.toHaveBeenCalled();
});

// Existing scenarios explicitly exercise the admitted web build; hold cases override it.
beforeEach(() => vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'));
afterEach(() => vi.unstubAllEnvs());

it('holds the server-enabled Berth card while keeping ordinary build choices', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); mocks.berthArt = true;
  useApp.setState({ screen: 'build', buildCategory: 'bld', placing: null, entryPaid: true,
    base: { player: { keepLevel: 20 }, buildings: [], jobs: [], freeBuilders: 1,
      features: { phaseEBuildings: { version: 1, enabledTypes: ['berth'] } } } as never });
  expect(berthConstructionAvailable(useApp.getState().base, true)).toBe(false);
  await act(async () => root.render(<BuildTray />));
  expect(host.querySelector('[data-build-type="berth"]')).toBeNull();
  expect(host.querySelector('[data-build-type="vault"]')).not.toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('refuses a retained Berth placement after the web hold, even with valid server facts', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); mocks.berthArt = true;
  useApp.setState({ screen: 'build', placing: 'berth', entryPaid: true,
    base: { player: { keepLevel: 20 }, buildings: [], jobs: [], freeBuilders: 1,
      features: { phaseEBuildings: { version: 1, enabledTypes: ['berth'] } } } as never });
  await act(async () => root.render(<BuildTray />));
  await act(async () => bus.emit('build:spot', { tx: 10, ty: 10, valid: true }));
  const place = [...host.querySelectorAll('button')].find(b => b.textContent === '✓ PLACE')!;
  expect(place.disabled).toBe(true); act(() => place.click()); expect(mocks.post).not.toHaveBeenCalled();
});
it.each(['workshop', 'lodge', 'market', 'harvester', 'berth'])('keeps placed %s visible without Phase E actions while held', async type => {
  // Native can populate these buildings before the new web interface is admitted.
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  useApp.setState({ screen: 'base', selectedBuildingId: 'phase-e-a', authed: true, wallet: 'hold-wallet',
    base: { player: { keepLevel: 20 }, buildings: [{ id: 'phase-e-a', type, level: 1, tx: 8, ty: 8 }], jobs: [], freeBuilders: 1 } as never });
  await act(async () => root.render(<ActionSheet />));
  expect(host.textContent).toContain('LEVEL 1'); expect(host.textContent).toContain('Available in the Android app for now.');
  expect(host.textContent).not.toContain('UPGRADE'); expect(host.textContent).not.toContain('REVIEW FINISH');
  expect(host.textContent).not.toContain('OPEN WORKSHOP'); expect(mocks.post).not.toHaveBeenCalled();
  expect(useApp.getState().base?.buildings[0]?.id).toBe('phase-e-a');
});
it('does not load a Phase E Gold Forge door while retaining the ordinary forge action', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  useApp.setState({ screen: 'base', selectedBuildingId: 'forge-a', authed: true, wallet: 'hold-wallet',
    base: { player: { keepLevel: 20 }, buildings: [{ id: 'forge-a', type: 'goldforge', level: 1 }], jobs: [], freeBuilders: 1 } as never });
  await act(async () => root.render(<ActionSheet />));
  expect(host.textContent).toContain('SMELT SHARDS'); expect(host.textContent).not.toContain('KEEP MINING');
  expect(mocks.post).not.toHaveBeenCalled();
});
