/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import type { FantasyOwnedTile, FantasyParcelData } from '../../data';
import { DEFAULT_REALM_FILTER, IslandPanel, KingdomCard, RealmMapChrome, RealmPanel, WorldHeader, WorldRail, type KingdomCardActions } from '.';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (node: React.ReactNode): Promise<void> => { await act(async () => root.render(node)); };
const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll('button')];
const byText = (text: string): HTMLButtonElement | undefined => buttons().find(b => b.textContent === text);
const click = async (el: Element | undefined | null): Promise<void> => { expect(el).toBeTruthy(); await act(async () => (el as HTMLElement).click()); };
const search = { query: '', onQuery: () => {}, results: null, onPick: () => {} };

describe('globe header and rail', () => {
  it('header: BASE, WORLD MAP / Shattered Realms, CAMPAIGN and the hint; no WORLD tool', async () => {
    const onBack = vi.fn(), onCampaign = vi.fn();
    await render(<WorldHeader hint="Drag to spin · pinch to zoom · tap a realm" onBack={onBack} onCampaign={onCampaign} />);
    expect(host.querySelector('h1')!.textContent).toBe('WORLD MAPShattered Realms');
    expect(host.textContent).toContain('Drag to spin · pinch to zoom · tap a realm');
    await click(host.querySelector('[aria-label="Back to base"]'));
    await click(byText('CAMPAIGN'));
    expect(onBack).toHaveBeenCalledOnce(); expect(onCampaign).toHaveBeenCalledOnce();
    expect(buttons().some(b => b.textContent === 'WORLD')).toBe(false);
    await render(<WorldHeader realmName="Sunscar" onBack={onBack} onCampaign={onCampaign} />);
    expect(host.querySelector('h1')!.textContent).toBe('WORLD MAPSunscar');
  });

  it('rail: 11 destinations with map icons on the realms, then "Find a keeper…"', async () => {
    const onRealm = vi.fn(), onIsland = vi.fn(), onPick = vi.fn();
    await render(<WorldRail selected={{ kind: 'realm', id: 'sunscar' }} onRealm={onRealm} onIsland={onIsland} search={search} />);
    const dests = [...host.querySelectorAll('[data-dest]')];
    expect(dests).toHaveLength(11);
    expect(dests.filter(d => d.querySelector('.hud-i--map'))).toHaveLength(8);
    expect(host.querySelector('[data-dest="realm:sunscar"]')!.getAttribute('aria-pressed')).toBe('true');
    await click(host.querySelector('[data-dest="island:divine-isle"]'));
    await click(host.querySelector('[data-dest="realm:seeker-reach"]'));
    expect(onIsland).toHaveBeenCalledWith('divine-isle'); expect(onRealm).toHaveBeenCalledWith('seeker-reach');
    expect(host.querySelector('[data-dest="realm:seeker-reach"]')!.textContent).toBe('Solana Reach');
    expect(buttons().some(b => b.textContent === 'WORLD')).toBe(false);
    await click(host.querySelector('[aria-label="Find a keeper"]'));
    expect(host.querySelector('input')!.placeholder).toBe('Find a keeper…');
    const result = { tileId: 7, realmId: 'sunscar', name: 'Ada', keepLevel: 9, trophies: 1, seeker: false };
    await render(<WorldRail selected={null} onRealm={onRealm} onIsland={onIsland} search={{ ...search, query: 'zz', results: [] }} />);
    expect(host.textContent).toContain('No keeper by that name');
    await render(<WorldRail selected={null} onRealm={onRealm} onIsland={onIsland} search={{ ...search, query: 'Ad', results: [result], onPick }} />);
    await click(byText('AdaL9'));
    expect(onPick).toHaveBeenCalledWith(result);
  });
});

describe('realm and island panels', () => {
  const counts = { realmId: 'crownlands', total: 9000, occupied: 120, held: 0, available: 50, anchorTileId: null };
  it('choose-land mode offers Choose land here AND Enter map; each calls the host', async () => {
    const onEnterMap = vi.fn(), onChooseLand = vi.fn();
    await render(<RealmPanel realmId="crownlands" counts={counts} mine={1} intent="choose-land" portrait={false} onEnterMap={onEnterMap} onChooseLand={onChooseLand} onClose={() => {}} />);
    await click(byText('Choose land here'));
    await click(byText('Enter map'));
    await click(byText('My base'));
    expect(onChooseLand).toHaveBeenCalledWith('crownlands');
    expect(onEnterMap.mock.calls).toEqual([['crownlands', false], ['crownlands', true]]);
    expect(host.textContent).toContain('Deeds'); expect(host.textContent).toContain('9,000');
  });
  it('Solana Reach shows its reserved variant', async () => {
    await render(<RealmPanel realmId="seeker-reach" counts={{ ...counts, realmId: 'seeker-reach', available: 0 }} mine={0} portrait={false} onEnterMap={() => {}} onChooseLand={() => {}} onClose={() => {}} />);
    const labels = [...host.querySelectorAll('dt')].map(d => d.textContent);
    expect(labels).toEqual(['Deeds', 'Genesis', 'Seeker', 'Open deeds']);
    expect(host.querySelector('h2')!.textContent).toBe('Solana Reach');
    expect(byText('Enter map')).toBeTruthy();
  });
  it('an island panel: coming soon, notes from PHASE_E_POLICY, a disabled map button', async () => {
    await render(<IslandPanel islandId="seeker-island" portrait onClose={() => {}} />);
    expect(host.textContent).toContain('ISLAND · COMING SOON');
    expect(host.textContent).toContain(`${PHASE_E_POLICY.seekerIsland.totalSpots} spots`);
    expect(host.textContent).not.toMatch(/phase\s*e/i);
    const map = byText('Coming soon')!;
    expect(map.disabled).toBe(true);
    expect(host.querySelector('section')!.dataset.layout).toBe('sheet');
    // WHY: K-204 requires the actual island panels, not just the copy builder, to show native's policy figures.
    await render(<IslandPanel islandId="solana-island" portrait onClose={() => {}} />);
    expect(host.textContent).toContain('100 workshop licences for crafting');
    await render(<IslandPanel islandId="divine-isle" portrait onClose={() => {}} />);
    expect(host.textContent).toContain('500 solo trials (west) · 50 clan citadels (east)');
  });
  it('portrait is a bottom sheet whose grip folds it to its foot', async () => {
    await render(<RealmPanel realmId="frostveil" counts={counts} mine={0} portrait onEnterMap={() => {}} onChooseLand={() => {}} onClose={() => {}} />);
    expect(host.querySelector('section')!.className).toContain('hud-panel--sheet');
    await click(host.querySelector('[aria-label="Collapse details"]'));
    expect(host.textContent).not.toContain('Beneath the blue ice');
    expect(byText('Enter map')).toBeTruthy();
  });
});

describe('realm map chrome', () => {
  const base = { realmId: 'sunscar', onExit: () => {}, query: '', onQuery: () => {}, results: null, onPick: () => {}, onGoTo: () => {},
    filter: DEFAULT_REALM_FILTER, onFilter: () => {}, warzoneActive: false };
  // D-191 (owner 2026-09-28): the chip is Unshielded — the raider's target — not Shielded; it still waits for a read that
  // carries the shield key (D-181). Long label "Unshielded", short "No shield", aria "Unshielded"; pressing it asks the
  // host for kind 'unshielded', which the engine hides everything else for.
  it('chips All / Mine / Level 1–20; Unshielded (No shield) only once a read carries the field, never Shielded', async () => {
    await render(<RealmMapChrome {...base} shieldKnown={false} />);
    const chips = (): string[] => [...host.querySelectorAll('[role=toolbar] button')].map(b => b.getAttribute('aria-label')!);
    expect(chips()).toEqual(['All', 'Mine', 'Level 1–20']);
    const onFilter = vi.fn();
    await render(<RealmMapChrome {...base} shieldKnown onFilter={onFilter} />);
    expect(chips()).toEqual(['All', 'Mine', 'Unshielded', 'Level 1–20']);
    const chip = host.querySelector<HTMLButtonElement>('[role=toolbar] [aria-label="Unshielded"]')!;
    expect(chip.querySelector('.wv2-lg')!.textContent).toBe('Unshielded'); expect(chip.querySelector('.wv2-sm')!.textContent).toBe('No shield');
    await click(chip);
    expect(onFilter).toHaveBeenCalledWith({ ...DEFAULT_REALM_FILTER, kind: 'unshielded' });
    expect(host.textContent).not.toContain('WARZONE');
  });
  it('search results elsewhere read "Go to ‹realm›" and call onGoTo; WARZONE shows while active', async () => {
    const onGoTo = vi.fn(), onPick = vi.fn(), onWarzone = vi.fn();
    const far = { tileId: 9, realmId: 'frostveil', name: 'Bo', keepLevel: 4, trophies: 0, seeker: false };
    const near = { ...far, tileId: 10, realmId: 'sunscar', name: 'Cy' };
    await render(<RealmMapChrome {...base} query="Bo" results={[near, far]} onGoTo={onGoTo} onPick={onPick} shieldKnown={false} warzoneActive onWarzone={onWarzone} />);
    expect(host.textContent).toContain('Go to Frostveil');
    await click(buttons().find(b => b.textContent?.startsWith('BoGo to')));
    await click(buttons().find(b => b.textContent?.startsWith('Cy')));
    await click(byText('WARZONE'));
    expect(onGoTo).toHaveBeenCalledWith(far); expect(onPick).toHaveBeenCalledWith(near); expect(onWarzone).toHaveBeenCalledOnce();
    await render(<RealmMapChrome {...base} query="Zed" results={[]} shieldKnown={false} />);
    expect(host.textContent).toContain('No kingdom by that name');
  });
});

describe('kingdom card', () => {
  const actions = (): KingdomCardActions => ({ onOpenBase: vi.fn(), onManageDeed: vi.fn(), onScout: vi.fn(), onRaid: vi.fn(),
    onChooseLand: vi.fn(), onLandGate: vi.fn(), onRetry: vi.fn(), onLookCloser: vi.fn(), onClose: vi.fn() });
  const parcel = (attack: boolean, name = 'Rival'): FantasyParcelData => ({
    worldId: 'fantasy-v1', availability: 'occupied', tile: { worldId: 'fantasy-v1', tileId: 1441, realmId: 'sunscar', allocation: 'ordinary' } as FantasyParcelData['tile'],
    detail: {
      player: { wallet: 'w', name, avatarUrl: null, clanTag: null, seeker: false, keepLevel: 7, trophies: 1200 },
      shield: { active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false },
      shielded: false, warzone: { active: false, boundaryAt: null, remainingMs: null },
      actions: { scout: { allowed: true, blockedBy: null }, attack: attack ? { allowed: true, blockedBy: null } : { allowed: false, blockedBy: 'keep_too_far_below' } },
    } as unknown as FantasyParcelData['detail'],
  });
  it('"You can attack" (red) iff the server allows; RAID enabled exactly then', async () => {
    const a = actions();
    await render(<KingdomCard tileId={1441} parcel={parcel(true)} portrait={false} actions={a} />);
    const tag = [...host.querySelectorAll('.hud-tag')].find(t => t.textContent === 'You can attack')!;
    expect(tag.className).toContain('hud-tag--red');
    await click(byText('Raid')); await click(byText('Scout'));
    expect(a.onRaid).toHaveBeenCalledOnce(); expect(a.onScout).toHaveBeenCalledOnce();
    await render(<KingdomCard tileId={1441} parcel={parcel(false)} portrait={false} actions={a} />);
    expect(host.textContent).not.toContain('You can attack');
    expect(byText('Raid')!.disabled).toBe(true);
    expect(host.textContent).toContain('THEIR KEEP IS TOO FAR BELOW YOURS');
  });
  it('your own base: "Your base", Open base calls the host, no attack tag; a blank name reads "Your kingdom"', async () => {
    const a = actions(), own = { tileId: 1441, name: '', baseId: 'b1', realmId: 'sunscar', active: true, selected: true } as FantasyOwnedTile;
    await render(<KingdomCard tileId={1441} parcel={parcel(true, '')} own={own} portrait={false} actions={a} />);
    expect([...host.querySelectorAll('.hud-tag')].map(t => t.textContent)).toEqual(['Your base']);
    expect(host.querySelector('h2')!.textContent).toBe('Your kingdom');
    await click(byText('Open base'));
    expect(a.onOpenBase).toHaveBeenCalledWith('b1');
  });
  it('open land offers Choose this land; a land gate offers Choose land', async () => {
    const a = actions();
    await render(<KingdomCard tileId={1441} parcel={{ ...parcel(false), availability: 'available', detail: null }} portrait={false} actions={a} />);
    expect(host.querySelector('h2')!.textContent).toBe('Open deed');
    expect(host.textContent).toContain('No kingdom yet · wild land');
    await click(byText('Choose this land'));
    expect(a.onChooseLand).toHaveBeenCalledOnce();
    await render(<KingdomCard tileId={1441} parcel={null} failure={{ kind: 'land-gate', message: 'Acquire a Land Deed' }} portrait actions={a} />);
    await click(byText('Choose land'));
    expect(a.onLandGate).toHaveBeenCalledOnce();
  });
  it('an unreadable occupied deed says so; a silhouette shows while the read runs', async () => {
    await render(<KingdomCard tileId={1441} parcel={{ ...parcel(false), detail: null }} portrait={false} actions={actions()} />);
    expect(host.textContent).toContain('This land is already assigned. Its base is not currently available for inspection.');
    await render(<KingdomCard tileId={1441} parcel={null} pending silhouette={{ name: '', keepLevel: 5 }} portrait={false} actions={actions()} />);
    expect(host.querySelector('h2')!.textContent).toBe('Keeper');
    expect(host.textContent).toContain('Loading details…');
    expect(byText('Look closer')).toBeTruthy();
  });
});
