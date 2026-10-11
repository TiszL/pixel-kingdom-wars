import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { useApp } from '../state/store';
import { selectedBasePath, withSelectedBase } from './baseSelection';

describe('selected stable base request identity', () => {
  beforeEach(() => useApp.getState().setSelectedBaseId(null, false));

  it('refuses new actions for a future plot while retaining read-only receipt recovery', () => {
    const previous = useApp.getState().base;
    try {
      useApp.setState({ base: { ...previous, plotVersion: 99 } as never });
      expect(() => withSelectedBase({ idempotencyKey: 'new-order' })).toThrow('unsupported plot version');
      expect(selectedBasePath('/base/expansions/receipts/original-order')).toBe('/base/expansions/receipts/original-order');
      useApp.setState({ base: { ...previous, plotVersion: 2 } as never });
      expect(withSelectedBase({ tx: -10, ty: 39 })).toEqual({ tx: -10, ty: 39 });
    } finally { useApp.setState({ base: previous }); }
  });

  it('carries the selected base without changing a legacy single-base request', () => {
    expect(withSelectedBase({ troop: 'bowman' })).toEqual({ troop: 'bowman' });
    expect(selectedBasePath('/army')).toBe('/army');
    useApp.getState().setSelectedBaseId('00000000-0000-4000-8000-000000000123', false);
    expect(withSelectedBase({ troop: 'bowman' })).toEqual({
      troop: 'bowman', baseId: '00000000-0000-4000-8000-000000000123',
    });
    expect(selectedBasePath('/army')).toBe(
      '/army?baseId=00000000-0000-4000-8000-000000000123',
    );
    expect(selectedBasePath('/map?x0=1&y0=2')).toBe(
      '/map?x0=1&y0=2&baseId=00000000-0000-4000-8000-000000000123',
    );
  });

  it('binds every polled map/globe read to selection and refetches when it changes', () => {
    // WHY: adding baseId to mutations alone leaves WORLD and GLOBE silently on
    // slot 1. These hooks are intentionally source-pinned because they are local
    // closures whose rendered surfaces pull in Phaser/canvas and cannot be
    // isolated without replacing the behavior under test.
    const map = readFileSync(new URL('../ui/screens/map.tsx', import.meta.url), 'utf8');
    const scout = readFileSync(new URL('../ui/scoutNavigation.ts', import.meta.url), 'utf8');
    const globe = readFileSync(new URL('../ui/screens/globe/GlobeLayer.tsx', import.meta.url), 'utf8');
    const parcels = readFileSync(new URL('../ui/screens/globe/parcels.ts', import.meta.url), 'utf8');

    expect(map).toContain('api.get<MapChunk>(selectedBasePath(`/map${qs}`))');
    // Map and battle history now share the scout request; its selected-deed
    // contract moves with that request rather than pinning its former closure.
    expect(map).toContain('openScout(');
    expect(scout).toContain('api.get<ScoutSnapshot>(selectedBasePath(');
    expect(map).toContain("|${selectedBaseId ?? ''}`");
    expect(globe).toContain("api.get<GlobeResponse>(selectedBasePath('/globe'))");
    expect(globe).toContain('api.get<SectorResponse>(selectedBasePath(`/globe/sector/${id}`))');
    expect(globe).toContain('api.get<ParcelScoutReport>(selectedBasePath(`/map/scout/${targetId}`))');
    // A newly purchased deed refreshes the directory while GlobeLayer remains
    // mounted. Ownership is therefore also a request dependency; otherwise the
    // new base stays absent until the periodic globe poll.
    expect(globe).toContain('[attempt, selectedBaseId, wallet, entryPaid, ownershipFingerprint]');
    expect(globe).toContain('[id, selectedBaseId, wallet, entryPaid, ownershipFingerprint]');
    expect(parcels).toContain('api.get<ParcelWireChunk>(selectedBasePath(`/map?${qs}`))');
    expect(parcels).toContain('[valleyId, want, selectedBaseId, wallet, entryPaid]');
  });

  it('binds every deed-owned progression, inventory, and market request to selection', () => {
    // WHY: the server deliberately rejects an omitted baseId once a wallet has
    // multiple active deeds. A single missed call can therefore make a core UI
    // work for the first deed and fail (or reuse stale data) after switching.
    const overlay = readFileSync(new URL('../ui/Overlay.tsx', import.meta.url), 'utf8');
    const sheets = readFileSync(new URL('../ui/sheets.tsx', import.meta.url), 'utf8');
    // Mine reads now share one refresh hook so both surfaces use the same
    // selected-deed guard; keep the request contract pinned at its new owner.
    const mineStatus = readFileSync(new URL('../ui/useMineStatus.ts', import.meta.url), 'utf8');
    const menu = readFileSync(new URL('../ui/screens/menu.tsx', import.meta.url), 'utf8');
    // The quest board became its own screen on 2026-08-28 (quest-onboarding
    // lane). Same two requests, same rule — a per-deed read and a per-deed
    // mutation — so the assertions move with the code rather than lapsing.
    const quests = readFileSync(new URL('../ui/screens/quests.tsx', import.meta.url), 'utf8');
    // The first-run objective strip claims the SAME quest route from the base
    // screen, and it is per-deed for the same reason the board is.
    const strip = readFileSync(new URL('../ui/tutorial/OnboardingStrip.tsx', import.meta.url), 'utf8');
    // The chain's live step is per-deed too: the probe that drives the strip has
    // to name the selected deed or a two-deed player sees deed A's objective
    // while standing on deed B.
    const tutorialHost = readFileSync(new URL('../ui/tutorial/TutorialHost.tsx', import.meta.url), 'utf8');
    const army = readFileSync(new URL('../ui/screens/army.tsx', import.meta.url), 'utf8');
    const map = readFileSync(new URL('../ui/screens/map.tsx', import.meta.url), 'utf8');
    const inventory = readFileSync(new URL('../ui/screens/inventory.tsx', import.meta.url), 'utf8');
    const heroes = readFileSync(new URL('../ui/screens/heroes.tsx', import.meta.url), 'utf8');
    const marketBuy = readFileSync(new URL('../auth/useMarketBuy.ts', import.meta.url), 'utf8');

    expect(sheets).toContain('useMineStatus()');
    expect(mineStatus).toContain("api.get<MineStatusDto>(selectedBasePath('/mine/status'))");
    expect(sheets).toContain("api.post<{ amount?: string }>('/mine/collect', withSelectedBase({}))");
    expect(quests).toContain("api.get<QuestBoard>(selectedBasePath('/quests'))");
    expect(quests).toContain("api.post(`/quests/${id}/claim`, withSelectedBase({}))");
    expect(strip).toContain('`/quests/${step.questId}/claim`, withSelectedBase({})');
    expect(tutorialHost).toContain("api.get<TutorialStateDto>(selectedBasePath('/tutorial'))");
    expect(menu).toContain("api.post<{ amount?: string }>('/mine/claim', withSelectedBase({}))");
    expect(overlay).toContain("api.get<HudQuestBoard>(selectedBasePath('/quests'))");
    expect(overlay).toContain('useMineStatus()');
    // Paid training now hands the original base to its durable currency/queue
    // review. The controller preserves that immutable scope through retries;
    // rebuilding a transient body here could charge today's different deed.
    expect(army).toContain('money.begin({ baseId: selectedBaseId })');
    expect(army).toContain('if (data?.freeFinishAllOffer || pendingFree) { finishFree(); return; }');
    expect(army).toContain('...(request.baseId ? { baseId: request.baseId } : {}), freeOffer: request.freeOffer, consent: request.consent');
    // Research freezes its original base/episode inside the durable payment review.
    expect(army).toContain('money.begin({ troop: troop as TroopType, baseId: selectedBaseId })');
    expect(army).not.toContain("api.post('/army/research/speedup'");
    expect(map).toContain("api.get(selectedBasePath('/campaign'))");
    expect(menu).toContain("api.post('/market/list', withSelectedBase({");
    expect(marketBuy).toContain('`/market/listings/${listingId}/reserve`, withSelectedBase({})');
    expect(inventory).toContain('`/items/${encodeURIComponent(id)}/seen`, withSelectedBase({})');
    // Hero payments now freeze the selected base in the shared durable review.
    // Pin that handoff rather than the removed transient POST: rebuilding its
    // body from today's selection could charge a different deed after review.
    expect(heroes).toContain('money.begin({ kind, hero, baseId: selectedBaseId })');
    expect(heroes).toContain('`/heroes?baseId=${encodeURIComponent(scope.selectedBaseId)}`');
    expect(heroes).toContain('isBaseSnapshotGuardCurrent(scope)');
  });
});
