/** @vitest-environment happy-dom */
/** Inventory handoff tests: the lazy screen must expose both live heroes, all
 * ten slots, server-provided stats/capacity, and basis-point copy without ever
 * inventing the handout's off-world roster or mechanics. */
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEAR_MODIFIER_STATS, type GearModifierStat } from '@shardkeep/shared';
import { api, ApiError } from '../../lib/api';
import { bus } from '../../lib/events';
import {
  beginBaseSelectionGuard, useApp, type BalancesDto, type BaseStateDto,
} from '../../state/store';
import InventoryScreen, {
  InventoryView,
  acquisitionLabel,
  modifierIsBeneficial,
  modifierLabel,
  type InventoryDto,
} from './inventory';

const zeroModifiers = (): Record<GearModifierStat, number> => Object.fromEntries(
  GEAR_MODIFIER_STATS.map((stat) => [stat, 0]),
) as Record<GearModifierStat, number>;

function fixture(): InventoryDto {
  return {
    catalogRevision: 2,
    heroGearCombatEnabled: false,
    catalog: [{
      id: 'wardens_helm', name: "WARDEN'S HELM", kind: 'gear', slot: 'helm',
      rarity: 'rare', weight: 4, costKeep: 40_000, asset: 'itm_helm',
      desc: 'A fixed-stat helm.', acquisition: { type: 'campaign_three_star', stage: 6 },
      maxOwned: 2, modifiers: [
        { stat: 'hero_hp_bps', value: 600 }, { stat: 'ability_damage_bps', value: 400 },
      ],
    }],
    owned: [{ itemId: 'wardens_helm', qty: 1 }],
    discovery: [],
    capacity: { used: 4, max: 160, overflow: false },
    deeds: [],
    heroLoadouts: [
      {
        hero: 'vex', recruited: true, level: 1, recoveryUntil: null, available: true,
        version: 0, equipment: {},
        modifiers: zeroModifiers(), setBonus: { id: 'warden', pieces: 0, required: 9, active: false },
        baseStats: { hp: 1_400, basicDamage: 95, skillDamageSeed: 95 },
        effectiveStats: { hp: 1_484, basicDamage: 101, skillDamageSeed: 105 },
      },
      {
        hero: 'theodor', recruited: false, level: 1, recoveryUntil: null, available: true,
        version: 0, equipment: {},
        modifiers: zeroModifiers(), setBonus: { id: 'warden', pieces: 0, required: 9, active: false },
        baseStats: { hp: 4_200, basicDamage: 38, skillDamageSeed: 38 },
        effectiveStats: { hp: 4_200, basicDamage: 38, skillDamageSeed: 38 },
      },
    ],
  };
}

function consumableFixture(
  itemId: 'keg_of_haste' | 'finishers_seal', name: string, qty: number,
): InventoryDto {
  const data = fixture();
  data.catalog = [{
    id: itemId, name, kind: 'consumable', rarity: 'common', weight: 1,
    costKeep: 60, asset: 'ui_icon_timer', desc: 'Finish one timer.',
    acquisition: { type: 'shop' }, maxOwned: null,
  }];
  data.owned = [{ itemId, qty }];
  data.discovery = [{ itemId, seenAt: '2026-09-03T00:00:00Z' }];
  return data;
}

function baseFixture(baseId: string, busy: boolean): BaseStateDto {
  return {
    baseId,
    player: {
      wallet: 'wallet', name: 'KEEPER', keepLevel: 3, trophies: 0,
      league: 'bronze', builders: 1, expansions: 0,
    },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [{
      id: 'building-1', type: 'camp', level: 1, tx: 4, ty: 4,
      underConstruction: busy,
    }],
    obstacles: [], army: [], heroes: [],
    jobs: busy ? [{
      id: 'job-1', kind: 'build', buildingId: 'building-1', obstacleId: null,
      startedAt: '2026-09-03T10:00:00Z', finishesAt: '2026-09-03T10:20:00Z',
    }] : [],
    freeBuilders: busy ? 0 : 1,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  useApp.getState().setAuth(null);
  useApp.getState().setSelectedBaseId(null, false);
  useApp.getState().setBase(null);
  useApp.getState().setMarketSellItemId(null);
  useApp.getState().setScreen('base');
  vi.restoreAllMocks();
});

describe('inventory copy and responsive view contract', () => {
  it('formats positive bonuses, tradeoffs and reductions without string-valued gameplay stats', () => {
    expect(modifierLabel('hero_hp_bps', 600)).toBe('HERO HP +6%');
    expect(modifierLabel('move_speed_bps', -500)).toBe('MOVE SPEED −5%');
    expect(modifierLabel('cooldown_reduction_bps', 800)).toBe('COOLDOWN −8%');
    expect(modifierIsBeneficial('hero_hp_bps', 600)).toBe(true);
    expect(modifierIsBeneficial('cooldown_reduction_bps', 800)).toBe(true);
    expect(modifierIsBeneficial('cooldown_reduction_bps', -800)).toBe(false);
    expect(acquisitionLabel({ type: 'campaign_three_star', stage: 18, requiresMaxHero: true }))
      .toBe('CAMPAIGN 18 · 3★ · MAX HERO');
  });

  it('renders only Vex/Theodor, all ten slots, capacity and the server-provided item', () => {
    const html = renderToStaticMarkup(<InventoryView
      data={fixture()} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('VEX');
    expect(html).toContain('THEODOR');
    expect(html).not.toMatch(/SELENE|OZYMUND|VANTOR|BRANNOCH|HELIUM-3|LUNAR LAND/);
    expect(html).toContain('Backpack capacity 4 of 160');
    expect(html).toContain('>4/160<');
    expect(html).toContain("WARDEN&#x27;S HELM");
    for (const slot of ['helm', 'amulet', 'chest', 'cloak', 'gloves', 'ring', 'boots', 'banner', 'weapon', 'offhand']) {
      expect(html).toContain(`${slot}: empty`);
    }
    expect(html).toContain('min-height:48px');
    expect(html).toContain('EQUIPMENT SAVED · COMBAT ROLLOUT OFF');
    expect(html).toContain('1,400');
    expect(html).not.toContain('1,484');
  });

  it('renders only personal holdings and never turns Inventory into a purchase catalog', () => {
    const data = fixture();
    data.catalog.push({
      id: 'unowned_shop_item', name: 'UNOWNED SHOP ITEM', kind: 'consumable', rarity: 'common',
      weight: 1, costKeep: 60, asset: 'ui_icon_timer', desc: 'Sold in the Shop.',
      acquisition: { type: 'shop' }, maxOwned: null,
    });
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="unowned_shop_item" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).not.toContain('UNOWNED SHOP ITEM');
    expect(html).not.toMatch(/>BUY(?: ·)?</);
    expect(html).toContain("WARDEN&#x27;S HELM");
  });

  it('explains when a hero is recovering instead of making equipment look causal', () => {
    const data = fixture();
    const theodor = data.heroLoadouts.find((hero) => hero.hero === 'theodor')!;
    theodor.recruited = true;
    theodor.level = 20;
    theodor.available = false;
    theodor.recoveryUntil = new Date(Date.now() + 63 * 60_000).toISOString();
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="theodor" selectedId={null} tab="all" mobilePane="equipment"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('RECOVERING · 1H 3M');
    expect(html).toContain('UNAVAILABLE FOR ATTACK OR DEFENCE');
    expect(html).toContain('is-recovering');
  });

  it('offers use and market handoff only for an owned tradable consumable', () => {
    const data = fixture();
    data.catalog = [{
      id: 'keg_of_haste', name: 'KEG OF HASTE', kind: 'consumable', rarity: 'common',
      weight: 1, costKeep: 60, asset: 'ui_icon_swiftboots', desc: 'A personal consumable.',
      acquisition: { type: 'shop' }, maxOwned: null,
    }];
    data.owned = [{ itemId: 'keg_of_haste', qty: 2 }];
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="keg_of_haste" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('>USE<');
    expect(html).toContain('>SELL ON MARKET<');
    expect(html).not.toContain('BUY ·');
  });

  it('keeps equipped gear in custody and sells only an additional loose copy', () => {
    const data = fixture();
    data.heroLoadouts[0]!.equipment.helm = 'wardens_helm';
    const render = () => renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="gear" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(render()).toContain('>UNEQUIP<');
    expect(render()).not.toContain('SELL ON MARKET');
    data.owned[0]!.qty = 2;
    expect(render()).toContain('SELL ON MARKET');
  });

  it('counts duplicate equipped copies across heroes before offering a loose copy', () => {
    const data = fixture();
    data.owned[0]!.qty = 2;
    data.heroLoadouts[0]!.equipment.helm = 'wardens_helm';
    data.heroLoadouts[1]!.equipment.helm = 'wardens_helm';
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="gear" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('2 equipped');
    expect(html).toContain('>E×2<');
    expect(html).not.toContain('SELL ON MARKET');
  });

  it('blocks equipping an unrecruited hero but not equipment-neutral recovery', () => {
    const data = fixture();
    const action = (dto: InventoryDto): HTMLButtonElement => {
      const host = document.createElement('div');
      host.innerHTML = renderToStaticMarkup(<InventoryView
        data={dto} loading={false} error={null} busy={false}
        selectedHero="theodor" selectedId="wardens_helm" tab="gear" mobilePane="equipment"
        onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
        onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
        onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
      />);
      return Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('EQUIP · HELM'))!;
    };
    expect(action(data).disabled).toBe(true);
    const theodor = data.heroLoadouts[1]!;
    theodor.recruited = true;
    theodor.available = false;
    theodor.recoveryUntil = new Date(Date.now() + 60_000).toISOString();
    expect(action(data).disabled).toBe(false);
  });

  it('shows server-authorized effective stats only after combat rollout is enabled', () => {
    const data = fixture();
    data.heroGearCombatEnabled = true;
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('1,484');
    expect(html).toContain('BASE 1,400');
    expect(html).not.toContain('COMBAT ROLLOUT OFF');
  });

  it('renders a usable cube for an earned drop-only consumable', () => {
    const data = fixture();
    data.catalog.push({
      id: 'warzone_aegis', name: 'WARZONE AEGIS', kind: 'consumable', rarity: 'legendary',
      weight: 3, costKeep: 8_000, asset: 'ui_icon_shield', desc: 'A scarce earned shield.',
      acquisition: { type: 'drop' }, maxOwned: null, dropOnly: true,
    });
    data.owned.push({ itemId: 'warzone_aegis', qty: 1 });
    const use = vi.fn();
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="warzone_aegis" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={use} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('WARZONE AEGIS');
    // Drop-acquired items name their source: everything with acquisition
    // 'drop' comes from Gold Forge settlement rolls (gear included since the
    // owner made gear forge-drop-exclusive, 2026-08-16).
    expect(html).toContain('DROPS FROM GOLD FORGE');
    expect(html).toContain('>USE<');
    expect(html).not.toContain('BUY ·');
    expect(html).not.toContain('SELL ON MARKET');

    const consumableHtml = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="warzone_aegis" tab="consumable" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={use} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(consumableHtml).toContain('WARZONE AEGIS');
  });

  it('compares a candidate against the item equipped in the same slot', () => {
    const data = fixture();
    data.catalog.push({
      id: 'iron_helm', name: 'IRON HELM', kind: 'gear', slot: 'helm', rarity: 'common',
      weight: 3, costKeep: 20_000, asset: 'itm_helm', desc: 'The current helm.',
      acquisition: { type: 'shop' }, maxOwned: 2,
      modifiers: [{ stat: 'hero_hp_bps', value: 200 }],
    });
    data.owned.push({ itemId: 'iron_helm', qty: 1 });
    data.heroLoadouts[0]!.equipment.helm = 'iron_helm';
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="gear" mobilePane="equipment"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('VS IRON HELM');
    expect(html).toContain('HERO HP +4%');
    expect(html).toContain('ABILITY DAMAGE +4%');
  });

  it('renders authoritative Earth deeds and all handout filters', () => {
    const data = fixture();
    data.deeds.push({
      id: 'deed-earth-1', baseId: '00000000-0000-4000-8000-000000000123',
      name: 'EARTH LAND DEED · KEEP 7', kind: 'deed', asset: 'itm_deed_earth', status: 'active',
    });
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="deed-earth-1" tab="deed" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('EARTH LAND DEED · KEEP 7');
    expect(html).toContain('>ACTIVE<');
    for (const tab of ['ALL', 'GEAR', 'CONSUMABLE', 'RELIC', 'DEED', 'COSMETIC']) expect(html).toContain(`>${tab}<`);
    expect(html).toContain('EQUIPMENT');
    expect(html).toContain('BACKPACK');
  });

  it('labels inactive deeds honestly instead of calling them ready', () => {
    const data = fixture();
    data.deeds.push({
      id: 'deed-inactive', baseId: '00000000-0000-4000-8000-000000000124',
      name: 'EARTH LAND DEED · KEEP 3', kind: 'deed', asset: 'itm_deed_earth', status: 'inactive',
    });
    const html = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="deed-inactive" tab="deed" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('>INACTIVE<');
    expect(html).not.toContain('1 UNEQUIPPED');
  });

  it('renders server overflow and the handout warning band without inventing capacity', () => {
    const data = fixture();
    data.capacity = { used: 161, max: 160, overflow: true };
    const overflow = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId={null} tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(overflow).toContain('OVER CAPACITY');
    expect(overflow).toContain('Backpack capacity 161 of 160, over capacity');
    expect(overflow).toContain('is-overflow');

    data.capacity = { used: 128, max: 160, overflow: false };
    const warning = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId={null} tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(warning).toContain('NEAR CAPACITY');
    expect(warning).toContain('is-warning');
  });

  it('announces load and action errors', () => {
    const html = renderToStaticMarkup(<InventoryView
      data={null} loading={false} error="loadout changed" busy={false}
      selectedHero="vex" selectedId={null} tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('LOADOUT CHANGED');
  });

  it('fetches inventory for the device-selected stable base', async () => {
    const baseId = '00000000-0000-4000-8000-000000000123';
    useApp.getState().setSelectedBaseId(baseId, false);
    const get = vi.spyOn(api, 'get').mockResolvedValue(fixture());
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledWith(`/items?baseId=${baseId}`);
    await act(async () => root.unmount());
  });

  it('keeps the authoritative base and loadout version on equip intent', async () => {
    const data = fixture();
    data.heroLoadouts[0]!.version = 7;
    const baseId = 'deed-versioned-equip';
    useApp.getState().setSelectedBaseId(baseId, false);
    vi.spyOn(api, 'get').mockResolvedValue(data);
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    const equip = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('EQUIP · HELM'))!;
    await act(async () => {
      equip.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(put).toHaveBeenCalledWith('/heroes/vex/equipment/helm', {
      baseId, itemId: 'wardens_helm', expectedVersion: 7,
    });
    await act(async () => root.unmount());
  });

  it('refreshes a stale loadout after 409 so the next equip uses the new version', async () => {
    // WHY: without the refresh, every retry reuses the same rejected optimistic
    // version until the player closes and reopens Inventory.
    const stale = fixture();
    stale.heroLoadouts[0]!.version = 7;
    stale.discovery = [{ itemId: 'wardens_helm', seenAt: '2026-08-31T00:00:00Z' }];
    const fresh = structuredClone(stale);
    fresh.heroLoadouts[0]!.version = 8;
    const baseId = 'deed-version-conflict';
    useApp.getState().setSelectedBaseId(baseId, false);
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(stale).mockResolvedValue(fresh);
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const put = vi.spyOn(api, 'put')
      .mockRejectedValueOnce(new ApiError(409, 'loadout version changed', 'HERO_LOADOUT_STALE'))
      .mockResolvedValue(undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    const equipButton = (): HTMLButtonElement => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('EQUIP · HELM'))!;

    await act(async () => equipButton().click());
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(host.textContent).toContain('REFRESHED — TRY AGAIN'));
    await act(async () => equipButton().click());
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]).toEqual(['/heroes/vex/equipment/helm', {
      baseId, itemId: 'wardens_helm', expectedVersion: 8,
    }]);
    await act(async () => root.unmount());
  });

  it('refreshes its screen snapshot when authoritative base recovery changes', async () => {
    const baseId = 'deed-recovery';
    const recovering = fixture();
    const theodor = recovering.heroLoadouts.find((hero) => hero.hero === 'theodor')!;
    theodor.recruited = true;
    theodor.available = false;
    theodor.recoveryUntil = '2026-08-13T12:00:00.000Z';
    const ready = structuredClone(recovering);
    ready.heroLoadouts.find((hero) => hero.hero === 'theodor')!.available = true;
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase({
      baseId,
      player: { wallet: 'wallet', name: 'TEST', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
      claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
      buildings: [], obstacles: [], army: [], jobs: [], freeBuilders: 1,
      heroes: [{ hero: 'theodor', available: false, recoveryUntil: theodor.recoveryUntil }],
    });
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(recovering).mockResolvedValue(ready);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(1);

    await act(async () => {
      useApp.getState().setBase({
        ...useApp.getState().base!,
        heroes: [{ hero: 'theodor', available: true, recoveryUntil: theodor.recoveryUntil }],
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it('opens with no item selected so mobile actions never cover the bag by default', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(fixture());
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('.inventory-item.is-selected')).toBeNull();
    expect(host.querySelector('.inventory-layout.has-detail')).toBeNull();
    expect(host.querySelector('.inventory-detail.is-empty')).not.toBeNull();
    expect(host.querySelector('[aria-label="Close item details"]')).toBeNull();
    expect(host.textContent).not.toContain('SELL ON MARKET');
    await act(async () => root.unmount());
  });

  it('opens item actions only on demand and dismisses them without closing Inventory', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(fixture());
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const closeInventory = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen onClose={closeInventory} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const item = host.querySelector<HTMLButtonElement>('.inventory-item')!;
    await act(async () => item.click());
    const closeDetails = host.querySelector<HTMLButtonElement>('[aria-label="Close item details"]')!;
    expect(item.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.inventory-layout.has-detail')).not.toBeNull();
    expect(document.activeElement).toBe(closeDetails);

    await act(async () => closeDetails.click());
    expect(item.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('.inventory-detail.is-empty')).not.toBeNull();
    expect(closeInventory).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(item);

    await act(async () => item.click());
    await act(async () => item.click());
    expect(item.getAttribute('aria-pressed')).toBe('false');
    expect(closeInventory).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
  });

  it('focuses the modal close control on open and restores the remounted BAG control on close', async () => {
    // WHY: the inventory route unmounts BaseHud, so the opener cannot be kept
    // as a live ref; it must be found only after the HUD remounts.
    vi.spyOn(api, 'get').mockResolvedValue(fixture());
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      setTimeout(() => callback(0), 0);
      return 1;
    });
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return open
        ? <InventoryScreen onClose={() => setOpen(false)} />
        : <button aria-label="Inventory">BAG</button>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close inventory"]')!;
    expect(document.activeElement).toBe(close);

    await act(async () => close.click());
    await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Inventory'));
    await act(async () => root.unmount());
    host.remove();
  });

  it('restores focus to a stable pane control when a filter removes the opening cube', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(fixture());
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    const consumables = Array.from(host.querySelectorAll<HTMLButtonElement>('.inventory-tabs button'))
      .find((button) => button.textContent === 'CONSUMABLE')!;
    await act(async () => consumables.click());
    const closeDetails = host.querySelector<HTMLButtonElement>('[aria-label="Close item details"]')!;
    await act(async () => closeDetails.click());
    expect(document.activeElement?.textContent).toBe('BACKPACK');

    await act(async () => root.unmount());
    host.remove();
  });

  it('shows an honest empty backpack and makes empty equipment sockets non-actions', () => {
    const data = fixture();
    data.owned = [];
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId={null} tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />);
    expect(host.textContent).toContain('YOUR BACKPACK IS EMPTY');
    expect(host.textContent).toContain('OPEN SHOP');
    expect(host.querySelectorAll('.inventory-slot:disabled')).toHaveLength(10);
    expect(host.querySelector('.inventory-item')).toBeNull();
  });

  it('keeps the handout two-pane density and reserves a separate action column', () => {
    const css = readFileSync(`${process.cwd()}/src/ui/screens/inventory.css`, 'utf8');
    // WHY: the handout's useful information density depends on equipment and
    // backpack remaining side by side until the true phone breakpoint.
    expect(css).toContain('grid-template-columns: 300px minmax(0, 1fr);');
    expect(css).toContain('repeat(auto-fill, minmax(58px, 1fr))');
    expect(css).toContain('@media (min-width: 560px) and (max-width: 639px)');
    expect(css).toContain('@media (max-width: 559px)');
    expect(css).toContain('env(safe-area-inset-right)');
    expect(css).toContain('env(safe-area-inset-bottom)');
    // Item actions have a dedicated wide-screen column, clear of the absolute
    // 48px close target in the sheet's top-right corner.
    expect(css).toContain('.inventory-detail > button:not(.inventory-detail-close) { grid-column: 4;');
    expect(css).toContain('min-height: 48px !important;');
    expect(css).not.toContain('min-height: 42px');
  });

  it('keeps item selection through filters and compact pane changes but resets it for a new hero', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(fixture());
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const item = host.querySelector<HTMLButtonElement>('.inventory-item')!;
    const button = (label: string): HTMLButtonElement => Array.from(host.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.trim() === label)!;

    await act(async () => item.click());
    await act(async () => button('CONSUMABLE').click());
    expect(host.querySelector('[aria-label="Close item details"]')).not.toBeNull();
    expect(host.textContent).toContain("WARDEN'S HELM");

    await act(async () => button('EQUIPMENT').click());
    expect(host.querySelector('[aria-label="Close item details"]')).not.toBeNull();

    const theodor = button('THEODORNOT RECRUITED');
    theodor.focus();
    await act(async () => theodor.click());
    expect(host.querySelector('.inventory-item.is-selected')).toBeNull();
    expect(host.querySelector('.inventory-detail.is-empty')).not.toBeNull();
    expect(document.activeElement).toBe(theodor);
    await act(async () => root.unmount());
    host.remove();
  });

  it('does not jump to another item after using the selected last copy', async () => {
    const beforeUse = fixture();
    beforeUse.catalog = [
      {
        id: 'keg_of_haste', name: 'KEG OF HASTE', kind: 'consumable', rarity: 'common',
        weight: 1, costKeep: 60, asset: 'ui_icon_swiftboots', desc: 'Finish one timer.',
        acquisition: { type: 'shop' }, maxOwned: null,
      },
      {
        id: 'powder_charge', name: 'POWDER CHARGE', kind: 'consumable', rarity: 'common',
        weight: 1, costKeep: 60, asset: 'ui_icon_bomb', desc: 'Another usable item.',
        acquisition: { type: 'shop' }, maxOwned: null,
      },
    ];
    beforeUse.owned = [{ itemId: 'keg_of_haste', qty: 1 }, { itemId: 'powder_charge', qty: 1 }];
    beforeUse.discovery = beforeUse.owned.map(({ itemId }) => ({ itemId, seenAt: '2026-08-13T00:00:00Z' }));
    const afterUse = structuredClone(beforeUse);
    afterUse.owned = [{ itemId: 'powder_charge', qty: 1 }];
    vi.spyOn(api, 'get').mockResolvedValueOnce(beforeUse).mockResolvedValue(afterUse);
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    const use = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'USE')!;
    await act(async () => {
      use.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('.inventory-item.is-selected')).toBeNull();
    expect(host.querySelector('.inventory-layout.has-detail')).toBeNull();
    expect(host.textContent).toContain('POWDER CHARGE');
    expect(host.textContent).not.toContain('SELL ON MARKET');
    await act(async () => root.unmount());
  });

  it.each([
    ['keg_of_haste', 'KEG OF HASTE'],
    ['finishers_seal', "FINISHER'S SEAL"],
  ] as const)('refreshes Inventory and commits the current base after using %s', async (itemId, name) => {
    // WHY: both items finish a builder job in the POST transaction. Refreshing
    // only the bag removes the item but leaves the completed timer on the base
    // until a manual reload, making a successful consumable look ineffective.
    const baseId = `deed-${itemId}`;
    const before = consumableFixture(itemId, name, 2);
    const after = consumableFixture(itemId, name, 1);
    const finishedBase = baseFixture(baseId, false);
    const balances: BalancesDto = { shards: '100', keep: '200', keepRate: 1 };
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.startsWith('/items?baseId=')) {
        itemReads++;
        return Promise.resolve(itemReads === 1 ? before : after) as never;
      }
      if (path === `/base?baseId=${baseId}`) return Promise.resolve(finishedBase) as never;
      if (path === `/balances?baseId=${baseId}`) return Promise.resolve(balances) as never;
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ used: itemId });
    const refreshes: unknown[] = [];
    const off = bus.on('base:refresh', (payload) => refreshes.push(payload));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const use = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;
      await act(async () => {
        use.click();
        await vi.waitFor(() => expect(itemReads).toBe(2));
        await vi.waitFor(() => expect(useApp.getState().base?.jobs).toEqual([]));
      });
      expect(post).toHaveBeenCalledWith('/items/use', { baseId, itemId });
      expect(get).toHaveBeenCalledWith(`/base?baseId=${baseId}`);
      expect(get).toHaveBeenCalledWith(`/balances?baseId=${baseId}`);
      expect(useApp.getState().balances).toEqual(balances);
      expect(refreshes).toHaveLength(1);
      expect(host.querySelector('.inventory-item')?.getAttribute('aria-label'))
        .toContain(`${name}, 1 owned, 1 available`);
    } finally {
      off();
      await act(async () => root.unmount());
    }
  });

  it('keeps USE locked until the authoritative Inventory refresh settles', async () => {
    // WHY: the POST can finish before GET /items. Unlocking on the mutation
    // alone exposes the stale quantity and lets a second tap debit another keg.
    const baseId = 'deed-use-awaits-items';
    const before = consumableFixture('keg_of_haste', 'KEG OF HASTE', 2);
    const after = consumableFixture('keg_of_haste', 'KEG OF HASTE', 1);
    const inventoryRead = deferred<InventoryDto>();
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === `/items?baseId=${baseId}`) {
        itemReads++;
        return (itemReads === 1 ? Promise.resolve(before) : inventoryRead.promise) as never;
      }
      if (path === `/base?baseId=${baseId}`) return Promise.resolve(baseFixture(baseId, false)) as never;
      if (path === `/balances?baseId=${baseId}`) {
        return Promise.resolve({ shards: '100', keep: '200', keepRate: 1 }) as never;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ used: 'keg_of_haste' });
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const use = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;

      await act(async () => {
        use.click();
        await vi.waitFor(() => expect(itemReads).toBe(2));
      });
      expect(use.disabled).toBe(true);
      use.click();
      expect(post).toHaveBeenCalledTimes(1);

      await act(async () => {
        inventoryRead.resolve(after);
        await inventoryRead.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(use.disabled).toBe(false));
      expect(post).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.inventory-item')?.getAttribute('aria-label'))
        .toContain('KEG OF HASTE, 1 owned, 1 available');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps USE locked when an unseen-item acknowledgement supersedes the item refresh', async () => {
    // WHY: selecting a newly discovered item writes /seen. If that write
    // finishes after USE, its reload supersedes the post-debit GET. The
    // discarded GET must not release USE while the replacement is pending.
    const baseId = 'deed-use-superseded-items';
    const before = consumableFixture('keg_of_haste', 'KEG OF HASTE', 2);
    before.discovery = [];
    const after = consumableFixture('keg_of_haste', 'KEG OF HASTE', 1);
    const supersededRead = deferred<InventoryDto>();
    const authoritativeRead = deferred<InventoryDto>();
    const seenWrite = deferred<unknown>();
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === `/items?baseId=${baseId}`) {
        itemReads++;
        if (itemReads === 1) return Promise.resolve(before) as never;
        if (itemReads === 2) return supersededRead.promise as never;
        return authoritativeRead.promise as never;
      }
      if (path === `/base?baseId=${baseId}`) return Promise.resolve(baseFixture(baseId, false)) as never;
      if (path === `/balances?baseId=${baseId}`) {
        return Promise.resolve({ shards: '100', keep: '200', keepRate: 1 }) as never;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ used: 'keg_of_haste' });
    const postRaw = vi.spyOn(api, 'postRaw').mockReturnValue(seenWrite.promise as never);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      expect(postRaw).toHaveBeenCalledWith(`/items/keg_of_haste/seen`, { baseId });
      const useButton = (): HTMLButtonElement => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;

      await act(async () => {
        useButton().click();
        await vi.waitFor(() => expect(itemReads).toBe(2));
      });
      expect(useButton().disabled).toBe(true);

      await act(async () => {
        seenWrite.resolve(undefined);
        await seenWrite.promise;
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(itemReads).toBe(3));
      await act(async () => {
        supersededRead.resolve(after);
        await supersededRead.promise;
        await Promise.resolve();
      });
      expect(useButton().disabled).toBe(true);
      useButton().click();
      expect(post).toHaveBeenCalledTimes(1);

      await act(async () => {
        authoritativeRead.resolve(after);
        await authoritativeRead.promise;
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(useButton().disabled).toBe(false));
      expect(post).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.inventory-item')?.getAttribute('aria-label'))
        .toContain('KEG OF HASTE, 1 owned, 1 available');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('does not report a committed item use as failed when the base refresh fails', async () => {
    // WHY: retrying because a secondary GET failed can consume another
    // valuable item. The POST result and the refresh result are separate facts.
    const baseId = 'deed-use-refresh-failure';
    const before = consumableFixture('keg_of_haste', 'KEG OF HASTE', 2);
    const after = consumableFixture('keg_of_haste', 'KEG OF HASTE', 1);
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === `/items?baseId=${baseId}`) {
        itemReads++;
        return Promise.resolve(itemReads === 1 ? before : after) as never;
      }
      if (path === `/base?baseId=${baseId}`) {
        return Promise.reject(new Error('secondary base refresh failed')) as never;
      }
      if (path === `/balances?baseId=${baseId}`) {
        return Promise.resolve({ shards: '100', keep: '200', keepRate: 1 }) as never;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    vi.spyOn(api, 'post').mockResolvedValue({ used: 'keg_of_haste' });
    const refreshes: unknown[] = [];
    const off = bus.on('base:refresh', (payload) => refreshes.push(payload));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const use = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;
      await act(async () => {
        use.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(itemReads).toBe(2));
      await vi.waitFor(() => expect(Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')?.disabled).toBe(false));
      expect(host.textContent).not.toContain('SECONDARY BASE REFRESH FAILED');
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(useApp.getState().base?.jobs).toHaveLength(1);
      expect(refreshes).toHaveLength(0);
    } finally {
      off();
      await act(async () => root.unmount());
    }
  });

  it('locks stale USE after a committed item debit when Inventory cannot refresh', async () => {
    // WHY: the debit succeeded, so an old positive quantity is unsafe. A
    // second tap would use a fresh idempotency key and could consume another
    // valuable finisher against a different eligible job.
    const baseId = 'deed-use-items-refresh-failure';
    const before = consumableFixture('finishers_seal', "FINISHER'S SEAL", 2);
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === `/items?baseId=${baseId}`) {
        itemReads++;
        return (itemReads === 1
          ? Promise.resolve(before)
          : Promise.reject(new Error('authoritative Inventory read failed'))) as never;
      }
      if (path === `/base?baseId=${baseId}`) return Promise.resolve(baseFixture(baseId, false)) as never;
      if (path === `/balances?baseId=${baseId}`) {
        return Promise.resolve({ shards: '100', keep: '200', keepRate: 1 }) as never;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ used: 'finishers_seal' });
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const useButton = (): HTMLButtonElement => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;

      await act(async () => {
        useButton().click();
        await vi.waitFor(() => expect(itemReads).toBe(2));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(host.textContent)
        .toContain('ITEM MAY ALREADY HAVE BEEN USED, BUT INVENTORY COULD NOT VERIFY THE NEW QUANTITY.'));
      expect(useButton().disabled).toBe(true);
      useButton().click();
      expect(post).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.inventory-item')?.getAttribute('aria-label'))
        .toContain("FINISHER'S SEAL, 2 owned, 2 available");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('locks stale USE when an ambiguous POST is followed by an older successful read', async () => {
    // WHY: finish-job completion performs fallible work after the debit
    // transaction commits, and a lost response is equally ambiguous. The GET
    // can win before that transaction, so one old successful read is no proof
    // that it is safe to issue a fresh idempotency key.
    const baseId = 'deed-use-ambiguous-post';
    const before = consumableFixture('keg_of_haste', 'KEG OF HASTE', 2);
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(baseFixture(baseId, true));
    let itemReads = 0;
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path === `/items?baseId=${baseId}`) {
        itemReads++;
        return Promise.resolve(before) as never;
      }
      if (path === `/base?baseId=${baseId}`) return Promise.resolve(baseFixture(baseId, true)) as never;
      if (path === `/balances?baseId=${baseId}`) {
        return Promise.resolve({ shards: '100', keep: '200', keepRate: 1 }) as never;
      }
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    const post = vi.spyOn(api, 'post')
      .mockRejectedValue(new ApiError(0, 'connection lost while the server may still be working'));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const useButton = (): HTMLButtonElement => Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;

      await act(async () => {
        useButton().click();
        await vi.waitFor(() => expect(itemReads).toBe(2));
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(host.textContent)
        .toContain('INVENTORY WAS REFRESHED, BUT THE ITEM-USE OUTCOME IS STILL UNCERTAIN.'));
      expect(useButton().disabled).toBe(true);
      useButton().click();
      expect(post).toHaveBeenCalledTimes(1);
      expect(host.querySelector('.inventory-item')?.getAttribute('aria-label'))
        .toContain('KEG OF HASTE, 2 owned, 2 available');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('does not commit or announce a completed-job snapshot after a newer base-selection intent', async () => {
    // WHY: a slow refresh from the deed that spent the item must not overwrite
    // a newer deed selection, nor tell Phaser to repaint that stale snapshot.
    const baseId = 'deed-use-old';
    const before = consumableFixture('finishers_seal', "FINISHER'S SEAL", 2);
    const after = consumableFixture('finishers_seal', "FINISHER'S SEAL", 1);
    const baseRead = deferred<BaseStateDto>();
    const balanceRead = deferred<BalancesDto>();
    const originalBase = baseFixture(baseId, true);
    useApp.getState().setAuth('wallet');
    useApp.getState().setSelectedBaseId(baseId, false);
    useApp.getState().setBase(originalBase);
    let itemReads = 0;
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.startsWith('/items?baseId=')) {
        itemReads++;
        return Promise.resolve(itemReads === 1 ? before : after) as never;
      }
      if (path === `/base?baseId=${baseId}`) return baseRead.promise as never;
      if (path === `/balances?baseId=${baseId}`) return balanceRead.promise as never;
      return Promise.reject(new Error(`unexpected GET ${path}`)) as never;
    });
    vi.spyOn(api, 'post').mockResolvedValue({ used: 'finishers_seal' });
    const refreshes: unknown[] = [];
    const off = bus.on('base:refresh', (payload) => refreshes.push(payload));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<InventoryScreen />);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const use = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.trim() === 'USE')!;
      await act(async () => {
        use.click();
        await vi.waitFor(() => expect(get).toHaveBeenCalledWith(`/base?baseId=${baseId}`));
      });

      await act(async () => {
        // This is the epoch fence a real deed switch raises before its own
        // network response arrives; the old complete deed remains visible.
        beginBaseSelectionGuard();
        baseRead.resolve(baseFixture(baseId, false));
        balanceRead.resolve({ shards: 'old', keep: 'old', keepRate: 1 });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      // The new selection epoch remounts Inventory and reads its own snapshot.
      await vi.waitFor(() => expect(itemReads).toBe(3));
      expect(useApp.getState().base).toBe(originalBase);
      expect(useApp.getState().balances).toBeNull();
      expect(refreshes).toHaveLength(0);
    } finally {
      off();
      await act(async () => root.unmount());
    }
  });

  it('keeps the mobile pane switch as a real 44px interaction', async () => {
    const mobilePane = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<InventoryView
      data={fixture()} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="wardens_helm" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={mobilePane}
      onEquip={vi.fn()} onUse={vi.fn()} onSell={vi.fn()}
      onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />));
    const equipment = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'EQUIPMENT');
    expect(equipment).toBeTruthy();
    await act(async () => equipment!.click());
    expect(mobilePane).toHaveBeenCalledWith('equipment');
    await act(async () => root.unmount());
  });

  it('hands an owned sale directly to the existing Market listing editor', async () => {
    const data = fixture();
    data.catalog = [{
      id: 'keg_of_haste', name: 'KEG OF HASTE', kind: 'consumable', rarity: 'common',
      weight: 1, costKeep: 60, asset: 'ui_icon_swiftboots', desc: 'A personal consumable.',
      acquisition: { type: 'shop' }, maxOwned: null,
    }];
    data.owned = [{ itemId: 'keg_of_haste', qty: 1 }];
    vi.spyOn(api, 'get').mockResolvedValue(data);
    vi.spyOn(api, 'postRaw').mockResolvedValue(undefined);
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(<InventoryScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    const sell = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('SELL ON MARKET'));
    expect(sell).toBeTruthy();
    await act(async () => sell!.click());
    expect(useApp.getState().marketSellItemId).toBe('keg_of_haste');
    expect(useApp.getState().screen).toBe('market');
    await act(async () => root.unmount());
  });
});


describe('unused contracts and activated benefits', () => {
  it.each(['hero', 'troop'] as const)('keeps an activated %s item sellable without offering a second activation', async (kind) => {
    const data = fixture();
    data.catalog = [{ ...data.catalog[0]!, id: 'unlock-item', kind: 'consumable',
      activation: { kind, active: true }, maxOwned: 1 }];
    data.owned = [{ itemId: 'unlock-item', qty: 1 }];
    const sell = vi.fn(); const use = vi.fn();
    const host = document.createElement('div'); const root = createRoot(host);
    await act(async () => root.render(<InventoryView
      data={data} loading={false} error={null} busy={false}
      selectedHero="vex" selectedId="unlock-item" tab="all" mobilePane="backpack"
      onClose={vi.fn()} onHero={vi.fn()} onSelect={vi.fn()} onTab={vi.fn()} onMobilePane={vi.fn()}
      onEquip={vi.fn()} onUse={use} onSell={sell} onViewDeeds={vi.fn()} onOpenShop={vi.fn()}
    />));
    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.startsWith('USE'))).toBe(false);
    expect(host.textContent).toContain('UNUSED ×1');
    await act(async () => buttons.find((button) => button.textContent === 'SELL ON MARKET')!.click());
    expect(sell).toHaveBeenCalledWith('unlock-item'); expect(use).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('uses an unused hero contract through the guarded recruitment tray, without an item-use debit', async () => {
    const data = fixture();
    data.catalog = [{ ...data.catalog[0]!, id: 'item_hero_theodor', kind: 'consumable',
      activation: { kind: 'hero', active: false, availableContracts: 1 } }];
    data.owned = [{ itemId: 'item_hero_theodor', qty: 1 }];
    data.discovery = [{ itemId: 'item_hero_theodor', seenAt: '2026-09-05T00:00:00Z' }];
    vi.spyOn(api, 'get').mockResolvedValue(data);
    const post = vi.spyOn(api, 'post');
    const host = document.createElement('div'); const root = createRoot(host);
    await act(async () => root.render(<InventoryScreen />));
    await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
    await act(async () => Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'USE · PLACE HERO ALTAR')!.click());
    expect(useApp.getState().screen).toBe('build');
    expect(useApp.getState().buildCategory).toBe('her');
    expect(post).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});


describe('inventory identity boundaries', () => {
  it.each(['base', 'wallet', 'epoch'] as const)('clears stale holdings and actions when %s changes beneath an open bag', async (change) => {
    const data = consumableFixture('keg_of_haste', 'KEG OF HASTE', 2);
    useApp.setState({ wallet: 'wallet', selectedBaseId: 'base-a', base: baseFixture('base-a', true) });
    let reads = 0;
    const get = vi.spyOn(api, 'get').mockImplementation(() => {
      if (++reads === 1) return Promise.resolve(data) as never;
      return Promise.reject(new Error('new inventory unavailable')) as never;
    });
    const post = vi.spyOn(api, 'post'); const put = vi.spyOn(api, 'put'); const close = vi.fn();
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      await act(async () => root.render(<InventoryScreen onClose={close} />));
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      const staleUse = [...host.querySelectorAll('button')].find(x => x.textContent === 'USE')!;
      const staleSell = [...host.querySelectorAll('button')].find(x => x.textContent === 'SELL ON MARKET')!;
      const staleClose = host.querySelector<HTMLButtonElement>('[aria-label="Close inventory"]')!;
      await act(async () => {
        // A late server-state handoff can replace the base while BAG stays open.
        if (change === 'base') useApp.setState({ selectedBaseId: 'base-b', base: baseFixture('base-b', true) });
        else if (change === 'wallet') useApp.setState({ wallet: 'other-wallet' });
        else beginBaseSelectionGuard();
        staleUse.click(); staleSell.click(); staleClose.click();
      });
      expect(get).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('NEW INVENTORY UNAVAILABLE');
      expect(host.querySelector('.inventory-item')).toBeNull();
      expect([...host.querySelectorAll('button')].some(x => x.textContent === 'USE')).toBe(false);
      expect(post).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
      expect(useApp.getState().marketSellItemId).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });

  it('does not refresh or announce another base after a late successful item-use response', async () => {
    const data = consumableFixture('finishers_seal', "FINISHER'S SEAL", 2);
    useApp.setState({ wallet: 'wallet', selectedBaseId: 'base-a', base: baseFixture('base-a', true) });
    const get = vi.spyOn(api, 'get').mockResolvedValue(data);
    const pending = deferred<unknown>();
    const post = vi.spyOn(api, 'post').mockReturnValue(pending.promise as never);
    const refreshed = vi.fn(); const off = bus.on('base:refresh', refreshed);
    const host = document.createElement('div'); const root = createRoot(host);
    try {
      await act(async () => root.render(<InventoryScreen />));
      await act(async () => host.querySelector<HTMLButtonElement>('.inventory-item')!.click());
      await act(async () => [...host.querySelectorAll('button')].find(x => x.textContent === 'USE')!.click());
      expect(post).toHaveBeenCalledWith('/items/use', { itemId: 'finishers_seal', baseId: 'base-a' });
      await act(async () => useApp.setState({ selectedBaseId: 'base-b', base: baseFixture('base-b', true) }));
      const before = get.mock.calls.length;
      await act(async () => pending.resolve({ used: 'finishers_seal' }));
      expect(get).toHaveBeenCalledTimes(before);
      expect(refreshed).not.toHaveBeenCalled();
      expect(useApp.getState().base?.baseId).toBe('base-b');
    } finally { off(); await act(async () => root.unmount()); }
  });
});
