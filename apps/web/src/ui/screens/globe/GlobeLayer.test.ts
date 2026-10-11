import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAPCHROME, mapChrome } from '../../layout';
import { coarseCellOfFineCell } from '@shardkeep/shared/globe';
import {
  cameraBrowseContext, chooseLandGround, chooseLandSector, earthCellChoiceEnabled, globeHomeControl,
  globeOwnershipFingerprint, globePeekContext, globePeekRow, globePeekSelection, globeWarzoneActive,
  homeClusterIdFor, homeContextTransition, normaliseSectorResponse,
  ownedParcelSelected, ownedViewportCue,
  parcelDetailEnabled, parcelScopeCount, parcelClusterContext, PEEK_CHIP, peekPillW,
  stickyParcelCluster, tilePurchaseState,
  retainedClaimedSelection, viewportCellOwnership, walletOwnedCellOwnership,
  type PeekContextInput, type PeekSelectionInput,
} from './GlobeLayer';
import { earthCellCentre, type ParcelGridApi } from './tiles';
import * as parcelGrid from '@shardkeep/shared/parcelGrid';

describe('homeContextTransition', () => {
  it('changes sector without selecting into the foreign cluster, then waits for home data', () => {
    // WHY: the sector-change effect clears cluster + cell. Returning SELECT during
    // this first render recreates the production race and makes MY PARCEL vanish.
    expect(homeContextTransition(17, 'c362', 3, 3, ['c900']))
      .toEqual({ kind: 'switch-sector', sectorId: 17 });

    // React has committed sector 17, but GET /globe/sector/17 has not landed yet.
    // Selection must still wait instead of borrowing the stale foreign list.
    expect(homeContextTransition(17, 'c362', 17, null, []))
      .toEqual({ kind: 'wait-for-cluster' });
  });

  it('selects only after the authoritative home cluster list is installed', () => {
    expect(homeContextTransition(17, 'c362', 17, 17, ['c900', 'c362']))
      .toEqual({ kind: 'select', clusterId: 'c362' });
  });

  it('names the home cluster from the deed cell alone (D-097)', () => {
    // WHY: the one-release id-grammar switch (a valley id from an older server) is
    // gone. The cluster is `c<coarseCell>` — the same integer math the server
    // buckets by — so the MY PARCEL flight names its target before the sector has
    // answered, and `homeContextTransition` does the waiting; the server admits
    // the viewer's own clusters first, so the wait always ends.
    const parcel = { earthCell: 28852 };
    expect(homeClusterIdFor(parcel)).toBe(`c${coarseCellOfFineCell(28852)}`);
    expect(homeClusterIdFor(null)).toBeNull();
    expect(homeClusterIdFor(undefined)).toBeNull();
  });
});

describe('GET /globe/sector/:id speaks clusters only (D-097)', () => {
  const source = readFileSync(new URL('./GlobeLayer.tsx', import.meta.url), 'utf8');

  it('reads clusters keyed by coarse cell and keeps an absent active ABSENT', () => {
    const places = normaliseSectorResponse({
      id: 141, name: '52°N 8°W',
      clusters: [
        { id: 362, lon: -0.25, lat: 51.75, players: 3, active: 2, warzone: false },
        { id: 370, lon: 1.25, lat: 51.25, players: 1, warzone: false },
      ],
    });
    expect(places).toEqual({
      id: 141, name: '52°N 8°W',
      clusters: [
        { id: 'c362', lon: -0.25, lat: 51.75, players: 3, active: 2 },
        { id: 'c370', lon: 1.25, lat: 51.25, players: 1 },
      ],
    });
    // The presence-oracle rule survives the reshape: absent stays absent.
    expect(Object.keys(places.clusters[1]!)).not.toContain('active');
  });

  it('has no valleys branch left to reshape an older server’s answer', () => {
    // WHY: the one-release compatibility accepted `valleys` and keyed places by
    // valley id for the legacy roster. deploy.sh drains traffic and every client
    // reloads on the version change, so no mixed window exists in which an older
    // server could answer this client — and a branch nobody can reach is a branch
    // nobody tests. A response carrying the old shape now yields no places, never
    // a valley dressed as a cluster.
    expect(source).not.toMatch(/raw\.valleys/);
    expect(source).not.toContain('SectorValley');
    expect(source).not.toMatch(/legacy: (true|false)/);
    const stale = normaliseSectorResponse({
      id: 141, name: '52°N 8°W', clusters: [],
      valleys: [{ id: 'vale-a', name: 'A', siteId: 9, lon: 0.5, lat: 51, players: 2 }],
    } as never);
    expect(stale.clusters).toEqual([]);
    expect(stale).not.toHaveProperty('legacy');
  });
});

describe('ordinary camera browsing loads the land under the camera', () => {
  const lon = -122;
  const lat = 37;
  const first = cameraBrowseContext(lon, lat, true, null, []);

  it('starts the sector read before a cluster list exists', () => {
    expect(first.clusterId).toBeNull();
  });

  it('adopts the nearest cluster as soon as that asynchronous list arrives', () => {
    // WHY: zoom used to commit once, before GET /globe/sector answered. With no
    // second camera event, no place was in focus and (on a legacy server) every
    // base stayed hidden until MY PARCEL happened to force the state transition.
    expect(cameraBrowseContext(lon, lat, true, first.sectorId, [
      { id: 'c1', lon: -118, lat: 34 },
      { id: 'c2', lon: -122.1, lat: 37.1 },
    ])).toEqual({ sectorId: first.sectorId, clusterId: 'c2' });
  });

  it('focuses ONE cluster, never the whole aggregate region', () => {
    const context = cameraBrowseContext(lon, lat, true, first.sectorId, [
      { id: 'camera-cluster', lon: -122.1, lat: 37.1 },
      { id: 'another-cluster', lon: -118, lat: 34 },
    ]);
    // The return shape has one id, not a list: a focus cannot imply the REGION's
    // base count is enumerated.
    expect(context).toEqual({ sectorId: first.sectorId, clusterId: 'camera-cluster' });
    expect(Array.isArray(context.clusterId)).toBe(false);
  });

  it('never adopts a stale sector response after a pan', () => {
    const moved = cameraBrowseContext(12, 46, true, first.sectorId, [
      { id: 'old-sector', lon, lat },
    ]);
    expect(moved.sectorId).not.toBe(first.sectorId);
    expect(moved.clusterId).toBeNull();
  });

  it('clears sector A immediately while sector B loads, then adopts B without another gesture', () => {
    // WHY: a non-null A focus made the list-arrival effect return early. A normal
    // pan into B therefore kept A's place until Home or another camera gesture
    // happened to clear it.
    const aSector = first.sectorId;
    let state = cameraBrowseContext(lon, lat, true, aSector, [
      { id: 'cluster-a', lon, lat },
    ]);
    expect(state.clusterId).toBe('cluster-a');

    const bLon = 12;
    const bLat = 46;
    state = cameraBrowseContext(bLon, bLat, true, aSector, [
      { id: 'cluster-a', lon, lat },
    ]);
    expect(state.sectorId).not.toBe(aSector);
    expect(state.clusterId).toBeNull();

    state = cameraBrowseContext(bLon, bLat, true, state.sectorId, [
      { id: 'far-b', lon: 18, lat: 48 },
      { id: 'under-b-camera', lon: 12.1, lat: 46.1 },
    ]);
    expect(state.clusterId).toBe('under-b-camera');
  });

  it('keeps an explicitly focused cluster stable through supported viewport pans', () => {
    expect(stickyParcelCluster('focused-cluster', 'nearest-after-pan')).toBe('focused-cluster');
    expect(stickyParcelCluster(null, 'nearest-on-arrival')).toBe('nearest-on-arrival');
    expect(stickyParcelCluster('legacy-fallback', null)).toBe('legacy-fallback');
  });
});

describe('multi-valley viewport truth', () => {
  const grid = {
    parcelOf: (cell: number) => cell === 101 ? { siteId: 9, x: 4, y: 5 } : null,
  } as unknown as ParcelGridApi;

  it('makes a visible cross-valley marker selectable without legacy valley context', () => {
    const marker = { earthCell: 101, name: 'NEIGHBOUR', avatarUrl: null, keepLevel: 4 };
    expect(viewportCellOwnership(101, grid, [marker])).toEqual({
      state: 'claimed', siteId: 9, x: 4, y: 5,
    });
    expect(viewportCellOwnership(102, grid, [marker])).toEqual({
      state: 'unseated', siteId: null, x: null, y: null,
    });
  });

  it('clears claimed detail on a settled omission but retains it off-scope', () => {
    const claimed = { state: 'claimed', siteId: 9, x: 4, y: 5 } as const;
    const elsewhere = { state: 'elsewhere', siteId: 9, x: 4, y: 5 } as const;
    const authority = 'base-a|wallet-a|1';
    const selected = retainedClaimedSelection(null, authority, 101, claimed, false);
    expect(retainedClaimedSelection(selected, authority, 101, elsewhere, false))
      .toEqual({ authority, cell: 101 });
    expect(retainedClaimedSelection(selected, authority, 101, elsewhere, true)).toBeNull();
  });

  it('synchronously clears claimed detail when entry authority is revoked', () => {
    const claimed = { state: 'claimed', siteId: 9, x: 4, y: 5 } as const;
    const paidAuthority = 'same-base|same-wallet|1';
    const unpaidAuthority = 'same-base|same-wallet|0';
    const selected = retainedClaimedSelection(null, paidAuthority, 101, claimed, false);
    // WHY: useParcelDetail's key omits entryPaid. Even if ownership is stale for
    // this transition render, the old owner/loot/action body must become ineligible.
    expect(retainedClaimedSelection(selected, unpaidAuthority, 101, claimed, false)).toBeNull();

    // The unpaid viewport may subsequently reload the public marker. Public
    // occupancy is not land authority and must not recreate its detail/actions.
    const reloaded = retainedClaimedSelection(null, unpaidAuthority, 101, claimed, false);
    expect(reloaded).toEqual({ authority: unpaidAuthority, cell: 101 });
    expect(parcelDetailEnabled(false, false, claimed, reloaded, 101)).toBe(false);
    expect(parcelDetailEnabled(true, false, claimed, reloaded, 101)).toBe(true);
  });

  it('reports only visible bases — with the cap bit — never the 21-base world or a zero-valley roster', () => {
    const worldTotal = 21;
    const page = {
      markers: Array.from({ length: 6 }, (_, i) => ({
        earthCell: i, name: 'X', avatarUrl: null, keepLevel: 1,
      })),
      truncated: false,
      unsupported: false,
    };
    const visible = parcelScopeCount(page, 0);
    expect(visible).toEqual({ count: 6, truncated: false });
    expect(visible.count).not.toBe(worldTotal);
    expect(parcelScopeCount({ markers: null, truncated: false, unsupported: false }, 0))
      .toEqual({ count: null, truncated: false });
    // WHY (D-097): a page the server capped is the NEAREST bases, and the chrome
    // must say "n+" rather than pose as the whole window.
    expect(parcelScopeCount({ ...page, truncated: true }, 0)).toEqual({ count: 6, truncated: true });
    // The legacy one-valley roster answers only when the route is unsupported,
    // and it is never a capped page.
    expect(parcelScopeCount({ markers: null, truncated: true, unsupported: true }, 4))
      .toEqual({ count: 4, truncated: false });
  });
});

describe('deedless land choice', () => {
  it('lets a first-land buyer choose a free globe cell without multi-base rollout', () => {
    expect(earthCellChoiceEnabled('entry', false)).toBe(true);
    expect(earthCellChoiceEnabled(null, true)).toBe(false);
  });

  it('keeps additional land behind the server-advertised capability', () => {
    expect(earthCellChoiceEnabled('deed', false)).toBe(false);
    expect(earthCellChoiceEnabled('deed', true)).toBe(true);
  });

  it('keeps the populated region under the camera and falls back only from empty ground', () => {
    const sectors = [
      { id: 9, valleys: 2, players: 4, active: 0, lon: -46.6, lat: -23.5, warzone: false },
      { id: 2, valleys: 3, players: 40, active: 1, lon: -170.1, lat: 10.2, warzone: false },
      { id: 1, valleys: 3, players: 40, active: 0, lon: -171.3, lat: 22.8, warzone: false },
    ];
    // WHY: CHOOSE LAND must not teleport somebody who deliberately browsed to
    // populated region 9 merely because a different region is busier.
    expect(chooseLandSector(sectors, 9)?.id).toBe(9);
    expect(chooseLandSector(sectors, 99)?.id).toBe(1);
  });
});

describe('choosing land before any base exists', () => {
  it('uses the existing playable Earth mapping when public sector aggregates are empty', () => {
    expect(chooseLandSector([], null)).toBeNull();
    const cell = parcelGrid.patchCells(0)[0]!;
    const at = earthCellCentre(cell)!;
    const ground = chooseLandGround(parcelGrid, at.lon, at.lat, null);
    expect(ground).toEqual({ cell, ...at });
    expect(parcelGrid.parcelOf(ground!.cell)).not.toBeNull();
  });

  it('retains an explicitly chosen parcel even when the current camera is elsewhere', () => {
    const first = parcelGrid.patchCells(0)[0]!;
    const chosen = parcelGrid.patchCells(parcelGrid.patchCount() - 1)[0]!;
    const camera = earthCellCentre(first)!;
    expect(chooseLandGround(parcelGrid, camera.lon, camera.lat, chosen))
      .toEqual({ cell: chosen, ...earthCellCentre(chosen)! });
  });
});

describe('multi-base globe ownership remains wallet-wide', () => {
  const second = {
    baseId: 'base-georgia', active: false, sectorId: 41, valleyId: 'georgia',
    parcel: { siteId: 9, earthCell: 12345, x: 7, y: 8 },
    name: 'TORQUEOND', avatarUrl: null, keepLevel: 2,
  };

  it('overrides a selected-base roster answer for another deed owned by the same wallet', () => {
    // WHY: /map stays selected-base scoped. From the main base, its anonymous
    // roster can call the Georgia deed CLAIMED or ELSEWHERE; wallet-private globe
    // ownership must win so the UI can neither hide it nor offer to buy it again.
    expect(walletOwnedCellOwnership(
      second.parcel.earthCell,
      { state: 'claimed', siteId: 9, x: 7, y: 8 },
      [second],
    )).toEqual({ state: 'yours', siteId: 9, x: 7, y: 8 });
    expect(tilePurchaseState(
      true,
      walletOwnedCellOwnership(
        second.parcel.earthCell,
        { state: 'elsewhere', siteId: 9, x: 7, y: 8 },
        [second],
      ),
      true, 'deed', true,
    )).toMatchObject({ kind: 'blocked', label: null, message: expect.stringContaining('ALREADY YOURS') });
  });

  it('refetches private globe and sector overlays as soon as the directory gains a deed', () => {
    const before = {
      bases: [{ id: 'main', status: 'active', earthCell: 100 }],
    };
    const reordered = {
      bases: [
        { id: 'georgia', status: 'inactive', earthCell: 200 },
        { id: 'main', status: 'active', earthCell: 100 },
      ],
    };
    // WHY: GlobeLayer stays mounted after checkout. A stable primitive dependency
    // must change immediately instead of waiting up to one globe cache interval.
    expect(globeOwnershipFingerprint(reordered)).not.toBe(globeOwnershipFingerprint(before));
    expect(globeOwnershipFingerprint(reordered)).toBe(globeOwnershipFingerprint({
      bases: [...reordered.bases].reverse(),
    }));
  });

  it('keeps the same A+B ownership set while selection switches A → B → A', () => {
    const main = {
      baseId: 'base-main', active: true, sectorId: 1, valleyId: 'main-valley',
      parcel: { siteId: 1, earthCell: 100, x: 1, y: 1 },
      name: 'TORQUEOND', avatarUrl: '/api/avatars/g1.webp', keepLevel: 5,
    };
    const both = [main, second];
    const selected = (baseId: string) => both.map((entry) => ({
      baseId: entry.baseId,
      persistent: true,
      mine: ownedParcelSelected(entry, baseId, null),
    }));

    // WHY: base selection used to scope the whole private globe overlay, so A→B
    // replaced the set instead of moving one highlight. Both directional switches
    // must retain both deeds and move exactly one pulse.
    expect(selected('base-main')).toEqual([
      { baseId: 'base-main', persistent: true, mine: true },
      { baseId: 'base-georgia', persistent: true, mine: false },
    ]);
    expect(selected('base-georgia')).toEqual([
      { baseId: 'base-main', persistent: true, mine: false },
      { baseId: 'base-georgia', persistent: true, mine: true },
    ]);
    expect(selected('base-main')).toHaveLength(2);
  });

  it('focuses an owned deed even when the capped public sector list omitted its place', () => {
    const publicClusters = [{ id: 'c362', lon: 10, lat: 20 }];
    const context = parcelClusterContext('georgia', publicClusters, [second]);

    // WHY: unlimited owned parcels cannot be forced through the bounded public
    // place list. The private stable site/cell is enough to load and place the
    // exact owned parcel without enlarging the public response.
    expect(context).toMatchObject({ id: 'georgia', siteId: 9 });
    expect(context?.lon).toEqual(expect.any(Number));
    expect(context?.lat).toEqual(expect.any(Number));
    // A public cluster answers first, and a D-096 cluster carries no site.
    expect(parcelClusterContext('c362', publicClusters, [second])).toEqual(publicClusters[0]);
  });

  it('keeps the supported viewport YOUR BASE cue for visible or focused owned land', () => {
    expect(ownedViewportCue([second], [
      { x0: 96, y0: 16, x1: 111, y1: 23 },
    ], null)).toEqual([second]);
    expect(ownedViewportCue([second], [
      { x0: 0, y0: 0, x1: 7, y1: 7 },
    ], second.parcel.earthCell)).toEqual([second]);
  });
});

describe('every missing land-purchase action explains itself', () => {
  it('keeps the two eligible purchase paths actionable', () => {
    expect(tilePurchaseState(
      true, { state: 'free', siteId: 1, x: 2, y: 3 }, true, 'deed', true,
    )).toEqual({ kind: 'eligible', label: 'CHOOSE THIS LAND', message: null });
    expect(tilePurchaseState(
      true, { state: 'elsewhere', siteId: 2, x: 2, y: 3 }, true, 'deed', true,
    )).toEqual({ kind: 'eligible', label: 'CHECK & CHOOSE THIS LAND', message: null });
  });

  it('distinguishes claimed, unseated, non-sovereign and still-checking cells', () => {
    const claimed = tilePurchaseState(
      true, { state: 'claimed', siteId: 1, x: 2, y: 3 }, true, 'deed', true,
    );
    const unseated = tilePurchaseState(
      true, { state: 'unseated', siteId: null, x: null, y: null }, true, 'deed', true,
    );
    const sovereign = tilePurchaseState(false, null, true, 'deed', true);
    const checking = tilePurchaseState(true, null, true, 'deed', true);
    expect(claimed).toMatchObject({ kind: 'blocked', message: expect.stringContaining('Another player') });
    expect(unseated).toMatchObject({ kind: 'blocked', message: expect.stringContaining('outside the active playable map') });
    expect(sovereign).toMatchObject({ kind: 'blocked', message: expect.stringContaining('sovereign') });
    expect(checking).toMatchObject({ kind: 'checking', message: expect.stringContaining('CHECKING') });
  });

  it('names account/capability loading instead of silently withholding a valid free-cell CTA', () => {
    const free = { state: 'free' as const, siteId: 1, x: 2, y: 3 };
    expect(tilePurchaseState(true, free, false, null, false))
      .toMatchObject({ kind: 'checking', message: expect.stringContaining('PURCHASE ACCESS') });
    expect(tilePurchaseState(true, free, true, 'deed', false))
      .toMatchObject({ kind: 'blocked', message: expect.stringContaining('ADDITIONAL LAND') });
  });
});

describe('globe chrome has one truthful Home action', () => {
  const source = readFileSync(new URL('./GlobeLayer.tsx', import.meta.url), 'utf8');

  it('puts MY PARCEL in the zoom rail’s home slot and keeps no separate icon rail (D-097)', () => {
    // WHY: on a 390 px phone the globe's own icon rail (MY PARCEL / WARZONE) sat
    // in a column over the map. The zoom rail already had a home slot; the globe
    // names it, so the primary action is still one tap and never collapsed — and
    // there is exactly one Home control, never a RECENTRE beside it.
    expect(source).toMatch(/<ZoomRail[\s\S]*?onHome=\{homeControl\.action === 'home' \? goHome : chooseLand\}/);
    expect(source).toContain('homeLabel={homeControl.label}');
    expect(source).not.toContain('<IconRail');
    expect(source).not.toContain('label="RECENTRE"');
    expect(source).not.toContain('label="MY PARCEL"');
  });

  it('calls the action MY PARCEL only when a parcel can exist, otherwise CHOOSE LAND', () => {
    expect(globeHomeControl(false, false)).toEqual({ action: 'home', label: 'MY PARCEL' });
    expect(globeHomeControl(true, true)).toEqual({ action: 'home', label: 'MY PARCEL' });
    expect(globeHomeControl(true, false)).toEqual({ action: 'choose-land', label: 'CHOOSE LAND' });
  });

  it('asks the solver for no rail and three zoom buttons, and they fit phone layouts', () => {
    // WHY: with no rail the sheet ceiling is the viewport's; the one thing that
    // can still collide is the three-button zoom cluster, which must stay on
    // screen, below the bar and above the sheet at every phone size.
    expect(source).toContain('mapChrome(box.w, box.h, sheetH, 0, 3)');
    for (const [w, h] of [[320, 568], [390, 844], [915, 311]] as const) {
      const L = mapChrome(w, h, MAPCHROME.peek, 0, 3);
      // An empty slot: no height in portrait, no width in landscape (where the
      // solver lays the rail out as a row).
      expect(L.rail.width * L.rail.height).toBe(0);
      expect(L.zoom).not.toBeNull();
      expect(L.zoom!.left).toBeGreaterThanOrEqual(0);
      expect(L.zoom!.top).toBeGreaterThanOrEqual(L.bar.height + MAPCHROME.pad);
      expect(L.zoom!.top + L.zoom!.height).toBeLessThanOrEqual(L.sheet.top);
    }
  });

  it('shows WARZONE as a top-bar badge only while a warzone is live (D-097)', () => {
    // WHY: the rail button it replaces sat on the phone whether or not there was
    // a warzone to read about. The globe's own read carries the live window on
    // every sector, so the badge and the pins can never disagree.
    expect(globeWarzoneActive([])).toBe(false);
    expect(globeWarzoneActive([{ warzone: false }, { warzone: false }])).toBe(false);
    expect(globeWarzoneActive([{ warzone: false }, { warzone: true }])).toBe(true);
    expect(source).toMatch(/\{warzoneActive && \(\s*<IconBtn[\s\S]*?label="WARZONE"/);
    // …and it opens the same sheet the rail button did.
    expect(source).toContain('onClick={() => setWarzoneOpen(true)}');
    expect(source).toContain('<Phead title="WARZONE" onClose={() => setWarzoneOpen(false)} />');
  });

  it('labels aggregate occupancy as bases without exposing allocation-place names', () => {
    // D-124 keeps world occupancy beside the complete owned-base directory.
    expect(source).toContain("World bases ${globe ? fmtN(totals.players) : 'loading'}");
    expect(source).toContain("{globe ? fmtN(totals.players) : '—'}{L.showLabels && ' BASES'}");
    // The authoritative ownership directory has its own row so optional
    // WARZONE chrome cannot push the count off the narrowest supported phone.
    expect(source).toMatch(/<UnderBar[^>]*>\s*<GlobeBaseCounts directory=\{baseDirectory\}/);
    expect(source).toContain("`${c.players} BASES`");
    expect(source).not.toContain("`${v.name} · ${v.players} BASES`");
    expect(source).not.toContain("`${v.players} BASES`");
    expect(source).not.toContain('>PARCELS ›</span>');
    expect(source).not.toContain('PATCH {selOwn.siteId}');
    expect(source).not.toContain('PARCEL {selOwn.x},{selOwn.y}');
    expect(source).not.toContain('const valleyLabel =');
    expect(source).not.toContain('<PillSub>PLAYERS</PillSub>');
  });

  it('replaces a failed selected-avatar node when the immutable URL changes', () => {
    expect(source).toContain('<img key={url} src={url}');
    expect(source).toContain('event.currentTarget.hidden = false');
  });

  it('labels the selected owner and gross ranges without exposing raw balance', () => {
    expect(source).toContain('OWNER PROFILE');
    expect(source).toContain('CURRENT ESTIMATED GROSS LOOT');
    expect(source).toContain('not the defender’s raw balance');
  });
});

// ===========================================================================
// THE PEEK ROW FITS A PHONE — three items, measured, never a scroll away (D-097)
//
// The resting sheet used to be a horizontally scrolling strip of up to nine
// pills plus a 176 px art plate, so on a 390 px phone the answer to "where am I
// and what is that" was usually off-screen to the right. It is now planned by
// pure functions from the strings that will actually be drawn, and asserted here
// the way layout.test.ts asserts the top bar: as a fit, not an eyeballing.
// ===========================================================================

describe('the peek row is exactly three items, and they fit a 390×844 phone (D-097)', () => {
  const source = readFileSync(new URL('./GlobeLayer.tsx', import.meta.url), 'utf8');
  const PHONE_W = 390;
  const none = { count: null, truncated: false };
  const base = { loaded: true, error: null, pending: false, worldBases: 41, region: null, visible: none };

  /** Every shape the context pill can take, worst strings first. */
  const contexts: PeekContextInput[] = [
    { ...base, view: 'globe', loaded: false, error: 'Globe unavailable', pending: false },
    { ...base, view: 'globe', loaded: false, error: 'Globe unavailable', pending: true },
    { ...base, view: 'globe', loaded: false, error: null, pending: true },
    { ...base, view: 'globe', worldBases: 59_000 },
    { ...base, view: 'region', region: { bases: 4_000, inReach: true } },
    { ...base, view: 'region', region: { bases: 0, inReach: false } },
    { ...base, view: 'region' },
    { ...base, view: 'parcel', visible: { count: 1_024, truncated: true } },
    { ...base, view: 'parcel', visible: { count: 6, truncated: false } },
    { ...base, view: 'parcel' },
  ];
  const idle = {
    home: 'off' as const, selected: null, ownedCue: 0, ownedCell: null,
    region: null, country: null, aimLive: true,
  };
  const farCorner = { lon: 179.75, lat: -89.75, cell: 258_000 };
  /** Every shape the selection pill can take. The "primary" ones carry an
   *  answer the player is about to act on and must never be cut short. */
  const primaries: PeekSelectionInput[] = [
    { ...idle, view: 'parcel', home: 'seeking' },
    { ...idle, view: 'parcel', home: 'noparcel' },
    { ...idle, view: 'parcel', home: 'unplaceable' },
    { ...idle, view: 'parcel', selected: { ...farCorner, cell: 28852, state: 'yours', claimable: true } },
    { ...idle, view: 'parcel', selected: { ...farCorner, state: 'claimed', claimable: true } },
    { ...idle, view: 'parcel', selected: { ...farCorner, state: 'free', claimable: true } },
    { ...idle, view: 'parcel', ownedCue: 1, ownedCell: 258_000 },
    { ...idle, view: 'parcel', ownedCue: 3 },
  ];
  const unbounded: PeekSelectionInput[] = [
    { ...idle, view: 'globe' },
    { ...idle, view: 'parcel', selected: { ...farCorner, state: 'unseated', claimable: true } },
    { ...idle, view: 'parcel', selected: { ...farCorner, state: undefined, claimable: false } },
    {
      ...idle, view: 'parcel', region: '52°N 8°W', aimLive: false,
      country: 'United Kingdom of Great Britain and Northern Ireland',
    },
    { ...idle, view: 'region', region: 'REGION 141' },
    { ...idle, view: 'region', region: null, country: 'Russia' },
  ];

  it('never plans more than fits: every context against every selection at 390 px', () => {
    for (const c of contexts) {
      for (const s of [...primaries, ...unbounded]) {
        const plan = globePeekRow(PHONE_W, globePeekContext(c), globePeekSelection(s));
        expect(plan.used).toBeLessThanOrEqual(plan.inner);
        expect(plan.fits).toBe(true);
        // The context pill and the caret are never clamped, so THEY have to fit
        // with room for a legible selection beside them.
        expect(plan.selectionMaxW).toBeGreaterThanOrEqual(120);
      }
    }
  });

  it('never cuts a primary answer short — a cell number or a coordinate truncated is a lie', () => {
    const widest = contexts
      .map((c) => globePeekContext(c))
      .sort((a, b) => peekPillW(b) - peekPillW(a))[0]!;
    for (const s of primaries) {
      const pill = globePeekSelection(s);
      const plan = globePeekRow(PHONE_W, widest, pill);
      expect(plan.selectionW).toBeLessThanOrEqual(plan.selectionMaxW);
    }
    // An unbounded name clamps ITSELF (`clamp: 'main'`); a long ownership word
    // gives way to the coordinate it qualifies (`clamp: 'sub'`). Either way the
    // span that is the answer is drawable inside the slot.
    for (const s of unbounded) {
      const pill = globePeekSelection(s);
      const plan = globePeekRow(PHONE_W, widest, pill);
      if (pill.clamp === 'sub') {
        expect(PEEK_CHIP.base + pill.main.length * PEEK_CHIP.mainCharW)
          .toBeLessThanOrEqual(plan.selectionMaxW);
      }
    }
  });

  it('models the real pill: a fixed frame plus one glyph advance per character', () => {
    // Pill: 4 + 8 px padding and a 2 px border each side (primitives.tsx), VT323
    // at 18 px is 7.2 px per glyph (layout.ts HUD_CHIP measured it in headless
    // Chromium) and the 14 px sub 5.6; 5 px gap between them; the caret is one
    // 44 px control. If someone changes the pill and does not re-measure, the plan
    // silently starts lying — so the model is pinned with its numbers.
    expect(peekPillW({ main: 'EARTH', sub: null })).toBeCloseTo(16 + 5 * 7.2, 1);
    expect(peekPillW({ main: 'EARTH', sub: '41 BASES' })).toBeCloseTo(16 + 5 * 7.2 + 5 + 8 * 5.6, 1);
    expect(PEEK_CHIP.caret).toBe(MAPCHROME.tap);
  });

  it('folds every transient state into the two pills instead of adding a fourth', () => {
    expect(globePeekContext(contexts[0]!)).toMatchObject({ main: 'NO PLANET', sub: 'TAP TO RETRY', tone: 'danger', action: 'retry' });
    expect(globePeekContext(contexts[1]!)).toMatchObject({ main: 'NO PLANET', sub: 'RETRYING…' });
    expect(globePeekContext(contexts[2]!)).toMatchObject({ main: 'READING' });
    expect(globePeekContext(contexts[3]!)).toMatchObject({ main: 'EARTH', sub: '59,000 BASES' });
    expect(globePeekContext(contexts[4]!)).toMatchObject({ main: 'REGION', sub: '4,000 BASES', ring: true });
    expect(globePeekContext(contexts[7]!)).toMatchObject({ main: '1,024+', sub: 'VISIBLE' });
    expect(globePeekContext(contexts[8]!)).toMatchObject({ main: '6', sub: 'VISIBLE' });
    expect(globePeekContext(contexts[9]!)).toMatchObject({ main: '—', sub: 'VISIBLE' });
    expect(globePeekSelection(primaries[0]!)).toMatchObject({ main: 'FINDING…', sub: 'YOUR PARCEL' });
    expect(globePeekSelection(primaries[1]!)).toMatchObject({ main: 'NO PARCEL', action: 'buy-land' });
    expect(globePeekSelection(primaries[3]!)).toMatchObject({ main: 'CELL 28852', sub: 'YOUR BASE', tone: 'gold' });
    expect(globePeekSelection(primaries[4]!)).toMatchObject({ main: '89.8°S 179.8°E', sub: 'CLAIMED' });
    expect(globePeekSelection(primaries[6]!)).toMatchObject({ main: 'CELL 258000', sub: 'YOUR BASE' });
    expect(globePeekSelection(primaries[7]!)).toMatchObject({ main: '3', sub: 'YOUR BASES' });
    expect(globePeekSelection(unbounded[0]!)).toMatchObject({ main: 'TAP A REGION' });
    expect(globePeekSelection(unbounded[3]!)).toMatchObject({
      main: 'United Kingdom of Great Britain and Northern Ireland', sub: 'PINCH IN TO AIM', clamp: 'main',
    });
    expect(globePeekSelection(unbounded[4]!)).toMatchObject({ main: 'REGION 141', sub: 'REGION' });
    expect(globePeekSelection(unbounded[5]!)).toMatchObject({ main: 'Russia', sub: 'CROSSHAIR' });
    // The tapped tile beats the owned cue: it is what the player just did.
    expect(globePeekSelection({ ...primaries[4]!, ownedCue: 1, ownedCell: 1 })).toMatchObject({ sub: 'CLAIMED' });
    // And the source draws exactly two pills plus the caret, nothing beside them.
    expect(source.match(/<PeekPillView /g)).toHaveLength(2);
    expect(source).not.toContain('REGIONS IN REACH');
    expect(source).not.toContain('<RegionPlate');
  });
});
