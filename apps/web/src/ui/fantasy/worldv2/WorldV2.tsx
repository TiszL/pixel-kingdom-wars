// World v2 root (D-186, lanes L6 + L8): the flat globe (chunk A, static here) and the realm-map engine (chunk B,
// imported mid-approach) behind the host contract, conducted by controller.ts, under lane L5's HUD. While this root
// is live the host (FantasyWorldLayer) hides its own header, rail, tools and panel; the HUD here is the player's
// world chrome (owner parity items 4, 8, 9, 10): WorldHeader (BASE, WORLD MAP, CAMPAIGN, the hint), WorldRail (8
// realms, 3 island chips, "Find a keeper…"), RealmPanel (stats, intent, Enter map in every mode), KingdomCard (the
// server's tags and actions), IslandPanel, the exploration panel and the realm-map chrome. It decides nothing the
// server decides and owns no server read: every value comes from the host's `hud` feed, and every action calls the
// host (`hud.actions`, onSelect / onRealmSelect / onExplore), so scout, raid, choose land and open base keep the
// host's one code path.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { fantasyTileAt, getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { useMobileBackHandler } from '../../../lib/mobileBackGuard';
import { useApp, type WorldIntent } from '../../../state/store';
import { loadFantasyPixels } from '../art';
import type { FantasySearchResult } from '../data';
import { realmWindowBounds } from '../realmFeed';
import { ARCHIPELAGOS, REGIONS } from '../runtime/renderer.mjs';
import type { FantasyView } from '../types';
import { reportWorldV2Fallback, worldV2Capability } from '../worldV2Support';
import type { WorldV2Handle, WorldV2Props, WorldV2SpecialIslandId } from './contract';
import { createWorldController, type WorldController, type WorldMode } from './controller';
import { WORLD_COPY, realmInfo, worldHint, type WorldHudIntent } from './copy';
import { createGlobe, type GlobeLabelAnchor, type GlobeRect } from './globe/globe.mjs';
import { placeLabels } from './globe/labels.mjs';
import {
  DEFAULT_REALM_FILTER, ExplorePanel, IslandPanel, KingdomCard, RealmMapChrome, RealmPanel, WorldHeader, WorldRail, markersCarryShield, minesIn,
  type RealmFilter,
} from './hud';
import { WORLD_V2_PACK_ROOT, worldPackUrl } from './packUrl';
import './WorldV2.css';

/** The store's reason for opening WORLD → the HUD's intent (copy.ts INTENT_HINTS). */
export function hudIntent(intent: WorldIntent | null): WorldHudIntent | null {
  switch (intent) {
    case 'choose-land': return 'choose-land';
    case 'find-rival': return 'rivals';
    case 'view-deeds': return 'my-deeds';
    default: return null;
  }
}

/** Back above the host's own chain (priority 100): island panel, dive in flight, realm map → globe. */
export const WORLD_V2_BACK_PRIORITY = 110;
const INITIAL_VIEW: FantasyView = { lon: 26, lat: 23, zoom: 1 };
/** The HUD's top bars: the globe's header and rail, or the realm map's chrome. Everything below them is stage. */
const TOP_BARS = '.wv2-header, .wv2-rail, .wv2-realm-chrome';

const WorldV2 = forwardRef<WorldV2Handle, WorldV2Props>(function WorldV2(props, ref) {
  const propsRef = useRef(props); propsRef.current = props;
  const root = useRef<HTMLDivElement>(null), globeLayer = useRef<HTMLDivElement>(null), realmLayer = useRef<HTMLDivElement>(null);
  const control = useRef<WorldController | null>(null), chrome = useRef<GlobeRect[]>([]);
  const [mode, setMode] = useState<WorldMode>('starting');
  const [island, setIsland] = useState<WorldV2SpecialIslandId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<GlobeLabelAnchor[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<RealmFilter>(DEFAULT_REALM_FILTER);
  const [realmId, setRealmId] = useState<string | null>(null);
  /** The realm whose panel is open on the globe: the player's pick (globe, rail, label), closed by its ×. */
  const [panelRealm, setPanelRealm] = useState<string | null>(null);
  const intent = useApp(s => s.worldIntent);
  const markers = props.markers, selectedTileId = props.selectedTileId ?? null, hud = props.hud;
  // D-181 / D-191: the Unshielded chip exists only while a read carries the shield key, and on a realm map its predicate
  // goes with it: a feed without the key would otherwise hide every kingdom behind a chip the player can no longer see or
  // release. The toolbar falls back to All (a pressed chip), so the engine is sent 'all'. Only on a realm map: the globe's
  // markers are realm clusters (never keyed), and a trip through it must not drop the player's filter.
  const shieldKnown = markersCarryShield(markers);
  if (mode === 'realm' && !shieldKnown && filter.kind === 'unshielded') setFilter({ ...filter, kind: 'all' });

  useEffect(() => {
    const globeRoot = globeLayer.current, realmRoot = realmLayer.current;
    if (!globeRoot || !realmRoot) return undefined;
    const canvas = (layer: HTMLElement): HTMLCanvasElement => {
      const node = document.createElement('canvas'); node.className = 'wv2-canvas'; layer.append(node); return node;
    };
    const status = (ready: boolean): void => propsRef.current.onTerrainStatus?.({ pending: !ready, ready, error: null, retry: () => {} });
    const ctl = createWorldController({
      capability: worldV2Capability,
      createGlobe,
      createRealm: async o => (await import('./realm/adapter')).createRealmView({ ...o, packRoot: WORLD_V2_PACK_ROOT }),
      globeOptions: { chains: ARCHIPELAGOS, fileUrl: worldPackUrl, readIslandArt: loadFantasyPixels, phaseEIslands: true },
      newCanvas: layer => canvas(layer === 'globe' ? globeRoot : realmRoot),
      newRealmUi: () => { const node = document.createElement('div'); node.className = 'wv2-realm-ui'; realmRoot.append(node); return node; },
      tileRealm: tileId => { const tile = getFantasyTile(tileId); return tile ? { realmId: tile.realmId, lon: tile.lon, lat: tile.lat } : null; },
      realmAt: (lon, lat) => fantasyTileAt(lon, lat)?.realmId ?? null,
      realmBounds: window => realmWindowBounds(window),
    }, {
      ready: () => status(true),
      fallback: reason => { reportWorldV2Fallback(reason); propsRef.current.fallbackTo2D(reason); },
      select: tileId => propsRef.current.onSelect(tileId === null ? null : getFantasyTile(tileId)),
      realmSelect: id => { setPanelRealm(id); propsRef.current.onRealmSelect(id); },
      explore: destination => propsRef.current.onExplore(destination),
      island: id => { setIsland(id); if (id) propsRef.current.onSpecialIsland(id); },
      view: view => propsRef.current.onViewChange?.(view),
      bounds: bounds => propsRef.current.onViewportBounds(bounds),
      mode: next => { setMode(next); setRealmId(control.current?.realmId ?? null); if (next !== 'globe' && next !== 'approach') setAnchors([]); },
      notice: setNotice,
      landed: () => { if (useApp.getState().worldIntent === 'choose-land') useApp.getState().setWorldIntent(null); },
      labels: setAnchors,
      panelOpen: () => propsRef.current.selectedTileId != null && propsRef.current.panelOpen !== false,
      chromeRects: () => chrome.current.map(r => [r.x0, r.y0, r.x1, r.y1] as [number, number, number, number]),
    }, { view: propsRef.current.view ?? INITIAL_VIEW, markers: propsRef.current.markers ?? [], selectedTileId: propsRef.current.selectedTileId ?? null,
      reducedMotion: propsRef.current.reduceMotion });
    control.current = ctl;
    status(false);
    void ctl.start();
    const visible = (): void => ctl.visibility(document.hidden);
    document.addEventListener('visibilitychange', visible);
    return () => { document.removeEventListener('visibilitychange', visible); ctl.stop(); control.current = null; };
  }, []);
  // The intent belongs to one visit to the world: the store clears it when the screen or tab leaves the world
  // (setScreen/setMapTab), never an effect cleanup here, which StrictMode also runs on its simulated unmount.
  // D-181: the player's own /base shield read rides with the feed, so their dome never depends on the feed alone.
  const own = hud.ownShield, ownTile = own?.tileId ?? null, ownShielded = own?.shielded === true;
  useEffect(() => {
    control.current?.setMarkers(markers ?? [], ownTile === null ? null : { tileId: ownTile, shielded: ownShielded });
  }, [markers, ownTile, ownShielded]);
  useEffect(() => { control.current?.setSelected(selectedTileId); }, [selectedTileId]);
  useEffect(() => { control.current?.setReducedMotion(props.reduceMotion); }, [props.reduceMotion]);
  useEffect(() => { control.current?.setFilter({ kind: filter.kind, lvl: [filter.lo, filter.hi] }); }, [filter, realmId]);

  // Layout: the HUD (the host's chrome is hidden while this root is live) as rects in stage px, for the globe's
  // home frame, its labels and the realm's tags.
  const panelKey = island ? `island:${island}` : selectedTileId !== null ? `card:${selectedTileId}` : hud.explore ? 'explore'
    : panelRealm && (mode === 'globe' || mode === 'approach' || mode === 'starting') ? `realm:${panelRealm}` : '';
  useEffect(() => {
    const stage = root.current; if (!stage) return undefined;
    const measure = (): void => {
      const box = stage.getBoundingClientRect();
      const rect = (node: Element): GlobeRect | null => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0
        ? { x0: r.left - box.left, y0: r.top - box.top, x1: r.right - box.left, y1: r.bottom - box.top } : null; };
      const all = (selector: string): GlobeRect[] => [...stage.querySelectorAll(selector)].map(rect).filter((r): r is GlobeRect => !!r);
      const tops = all(TOP_BARS), panelNode = stage.querySelector('.wv2-panel'), panel = panelNode ? rect(panelNode) : null;
      const ours = all('.wv2-chrome');
      chrome.current = [...tops, ...(panel ? [panel] : []), ...ours];
      const headerBottom = Math.max(0, ...tops.map(r => r.y1));
      const W = box.width, H = box.height, sheet = !!panel && panel.x0 <= 8 && panel.x1 >= W - 8;
      const panelFree = panel
        ? (sheet ? { x0: 0, y0: headerBottom, x1: W, y1: panel.y0 } : { x0: 0, y0: headerBottom, x1: panel.x0, y1: H }) : null;
      control.current?.setLayout({ top: headerBottom, obstacles: ours, panelFree });
      setSize(previous => (previous.width === W && previous.height === H ? previous : { width: W, height: H }));
      propsRef.current.onViewportChange?.({ width: W, height: H, centerX: W / 2, centerY: H / 2 });
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [props.panelOpen, mode, panelKey]);

  useImperativeHandle(ref, () => ({
    focusRealm: id => control.current?.focusRealm(id),
    focusTile: id => control.current?.focusTile(id),
    focusIsland: (chainId, islandId) => control.current?.focusIsland(chainId, islandId),
    setView: view => control.current?.setView(view),
    view: () => control.current?.view() ?? propsRef.current.view ?? INITIAL_VIEW,
    stats: () => null,
  }), []);


  const onGlobe = mode === 'globe' || mode === 'approach';
  const globeHud = onGlobe || mode === 'starting';
  const hint = globeHud ? worldHint(hudIntent(intent), notice) : null;
  const owned = hud.directory?.me.ownedTiles ?? null;
  // "Your realms are marked" (my-deeds intent): the realms holding your deeds (the directory, and the host's owned markers).
  const mineRealms = useMemo(() => new Set<string>(intent === 'view-deeds' ? [...(owned ?? []).map(t => t.realmId), ...(markers ?? []).flatMap(m => {
    const realm = m.owned && !m.cluster ? getFantasyTile(m.tileId)?.realmId : undefined; return realm ? [realm] : [];
  })] : []), [intent, markers, owned]);
  const labels = useMemo(() => (onGlobe && size.width > 0
    ? placeLabels(anchors, a => [a.name.length * 8 + 20, 24], chrome.current, size.width, size.height) : []), [anchors, onGlobe, size]);
  // Kingdom search on a realm map: the kingdoms the map draws (the host's feed); "Find a keeper…" on the globe is global.
  const results = useMemo<FantasySearchResult[] | null>(() => {
    const q = query.trim().toLowerCase(); if (q.length < 2) return null;
    return (markers ?? []).flatMap(m => {
      const tile = m.cluster ? null : getFantasyTile(m.tileId);
      return tile && m.name.toLowerCase().includes(q)
        ? [{ ...m, keepLevel: m.keepLevel ?? 1, realmId: tile.realmId, trophies: 0, seeker: false }] : []; // the chrome shows name and level only
    }).slice(0, 20);
  }, [markers, query]);
  /** Select a kingdom and fly to it (a dive when it lies in another realm), as the host's owner search does. */
  const selectAndFocus = (tileId: number): void => {
    const tile = getFantasyTile(tileId); if (!tile) return;
    props.onSelect(tile); control.current?.focusTile(tileId);
  };
  const pick = (result: FantasySearchResult): void => { selectAndFocus(result.tileId); setQuery(''); };
  const focusRealm = (id: string): void => { setPanelRealm(id); control.current?.focusRealm(id); props.onRealmSelect(id); };
  /** Enter map: the dive the controller runs for the host's setView at zoom 16 (INSPECT LAND TILES on the CPU globe).
   *  "My base" lands on your deed in that realm with it selected (native 62ff4e1). */
  const enterMap = (id: string, mine: boolean): void => {
    const deed = mine ? (owned ?? []).filter(t => t.realmId === id).sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.active) - Number(a.active))[0] : undefined;
    if (deed) { selectAndFocus(deed.tileId); return; }
    const region = REGIONS.find(r => r.id === id); if (region) control.current?.setView({ lon: region.lon, lat: region.lat, zoom: 16 });
  };

  const realmPanelOpen = globeHud && !!panelRealm && !island && selectedTileId === null && !hud.explore;
  // Back: the island panel, a dive in flight, the realm map, then the realm panel; the host's chain after.
  const backWanted = island !== null || mode === 'approach' || mode === 'diving' || (mode === 'realm' && selectedTileId === null) || realmPanelOpen;
  useMobileBackHandler(() => {
    if (control.current?.back()) return true;
    if (realmPanelOpen) { setPanelRealm(null); return true; }
    return false;
  }, backWanted, WORLD_V2_BACK_PRIORITY);
  let panel: ReactNode = null;
  if (island) panel = <IslandPanel islandId={island} onClose={() => control.current?.closeIsland()} />;
  else if (selectedTileId !== null) {
    const tile = getFantasyTile(selectedTileId), info = realmInfo(tile?.realmId);
    const drawn = (markers ?? []).find(m => m.tileId === selectedTileId && !m.cluster);
    const read = hud.parcel.tileId === selectedTileId ? hud.parcel : null;
    panel = <KingdomCard tileId={selectedTileId} realmName={info?.name} accent={info?.accent} parcel={read?.data} pending={read?.pending ?? true}
      failure={read?.failure} own={hud.ownTile} silhouette={drawn ? { name: drawn.name, keepLevel: drawn.keepLevel } : null} busy={hud.busy}
      actions={{
        onOpenBase: baseId => hud.actions.openBase(baseId), onManageDeed: () => hud.actions.manageDeed(),
        onScout: () => hud.actions.scout(), onRaid: () => hud.actions.raid(), onChooseLand: () => hud.actions.chooseLand(),
        // No Land Deed yet (402/403): the way in is choosing open land, so the card hands the player that mode.
        onLandGate: () => { useApp.getState().setWorldIntent('choose-land'); props.onSelect(null); },
        onRetry: () => read?.retry(), onClose: () => props.onSelect(null),
      }}>{hud.cardExtras}</KingdomCard>;
  } else if (hud.explore) {
    panel = <ExplorePanel explore={hud.explore} chains={ARCHIPELAGOS} onPick={destination => hud.actions.explore(destination)} onClose={() => props.onSelect(null)} />;
  } else if (realmPanelOpen) {
    panel = <RealmPanel realmId={panelRealm} counts={hud.directory?.realms.find(r => r.realmId === panelRealm)} mine={minesIn(owned, panelRealm)}
      intent={hudIntent(intent)} notice={notice} onEnterMap={enterMap} onChooseLand={id => enterMap(id, false)} onClose={() => setPanelRealm(null)} />;
  }

  return <div ref={root} className="wv2-root" data-mode={mode}>
    <div ref={globeLayer} className="wv2-layer wv2-globe-layer" />
    <div ref={realmLayer} className="wv2-layer wv2-realm-layer" aria-hidden={mode !== 'realm'} />
    {labels.length > 0 && <div className="wv2-labels">{labels.map(l =>
      <button type="button" key={`${l.kind}:${l.id}`} className={`hud-pill wv2-label${mineRealms.has(l.id) ? ' is-mine' : ''}`} style={{ left: l.left, top: l.top } as CSSProperties}
        aria-label={mineRealms.has(l.id) ? `${l.name}, ${WORLD_COPY.rail.yourBases}` : l.name}
        onClick={() => { if (l.kind === 'island') control.current?.openIsland(l.id as WorldV2SpecialIslandId); else focusRealm(l.id); }}>{l.name}</button>)}</div>}
    {globeHud && <>
      <WorldHeader realmName={realmPanelOpen ? realmInfo(panelRealm)?.name : null} hint={hint}
        onBack={() => hud.actions.back()} onCampaign={() => hud.actions.openCampaign()} />
      <WorldRail selected={island ? { kind: 'island', id: island } : hud.explore ? null : panelRealm ? { kind: 'realm', id: panelRealm } : null}
        mineRealms={mineRealms} onRealm={focusRealm} onIsland={id => control.current?.openIsland(id as WorldV2SpecialIslandId)}
        search={{ query: hud.search.query, onQuery: hud.search.setQuery, results: hud.search.results, pending: hud.search.pending,
          error: hud.search.error, onRetry: hud.search.retry, onPick: r => selectAndFocus(r.tileId) }} />
    </>}
    {mode === 'realm' && realmId && <div className="wv2-chrome wv2-realm-bar">
      <RealmMapChrome realmId={realmId} onExit={() => { void control.current?.exitRealm(); }}
        query={query} onQuery={setQuery} results={results} onPick={pick} onGoTo={pick}
        filter={filter} onFilter={setFilter} shieldKnown={shieldKnown}
        warzoneActive={hud.warzone.active} warzoneOpen={hud.warzone.open} onWarzone={() => hud.actions.setWarzoneOpen(!hud.warzone.open)}
        warzonePanel={hud.warzone.panel} />
    </div>}
    {panel}
  </div>;
});
export default WorldV2;
