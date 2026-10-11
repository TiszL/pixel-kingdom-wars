import {
  forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState,
  type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { useMobileBackHandler } from '../../lib/mobileBackGuard';
import { MAPCHROME } from '../layout';
import { MAP_DBL } from '../mapChromeUI';
import { GameLoading } from '../loading/GameLoading';
import { Sprite } from '../primitives';
import { loadFantasyPixels } from './art';
import { layoutWorldMarkers, type MarkerGroup } from './markerLayout';
import {
  createFantasyRenderer, normalizedView, tileFocus, islandFocus, rasterSize, SIZE, REGIONS,
  type FantasyRenderer,
} from './runtime/renderer.mjs';
import type {
  FantasyView, FantasyWorldMarker, FantasyTile, FantasyExploration, FantasyGlobeHandle,
} from './types';
import './fantasy.css';

export { REGIONS as FANTASY_REALMS, ARCHIPELAGOS as FANTASY_CHAINS } from './runtime/renderer.mjs';
export type { FantasyGlobeHandle, FantasyView, FantasyWorldMarker } from './types';

const INITIAL_VIEW: FantasyView = { lon: 26, lat: 23, zoom: 1 };
const EMPTY_MARKERS: readonly FantasyWorldMarker[] = [];
export interface FantasyTerrainStatus {pending:boolean;ready:boolean;error:string|null;retry():void}

export interface FantasyGlobeProps {
  view?: FantasyView;
  markers?: readonly FantasyWorldMarker[];
  selectedTileId?: number | null;
  selectedRealmId?: string;
  /** A collapsed details control does not reserve any camera space. */
  panelOpen?: boolean;
  reduceMotion: boolean;
  onSelect(tile: FantasyTile | null): void;
  onExplore(destination: FantasyExploration): void;
  onRealmSelect(realmId: string): void;
  onViewChange?(view: FantasyView): void;
  onViewportChange?(viewport: {width:number;height:number;centerX:number;centerY:number}): void;
  onTerrainStatus?(status:FantasyTerrainStatus):void;
}

/** Native React surface; only immutable geography and drawing live below it.
 * All owners, available parcels and game actions are injected by the game. */
export const FantasyGlobe = forwardRef<FantasyGlobeHandle, FantasyGlobeProps>(function FantasyGlobe(props, ref) {
  const propsRef = useRef(props); propsRef.current = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cloudRef = useRef<HTMLCanvasElement>(null);
  const effectsRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<FantasyRenderer | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const diagnosticRef = useRef<HTMLOutputElement>(null);
  const [diagnostics] = useState(() => new URLSearchParams(window.location.search).get('diag') === '1');
  const realmNodes = useRef(new Map<string, HTMLButtonElement>());
  const realmSizes = useRef(REGIONS.map(realm => ({width:realm.name.length*7+18,height:28})));
  const [markerGroups, setMarkerGroups] = useState<MarkerGroup[]>([]);
  const [membersFor, setMembersFor] = useState<number|null>(null);
  const markerBounds = useRef({left:0,top:0,right:SIZE,bottom:SIZE});
  const viewportCss = useRef({width:SIZE,height:SIZE});
  const viewRef = useRef(normalizedView(props.view ?? INITIAL_VIEW));
  const cssScale = useRef(1);
  const focusScale = useRef(1);
  const available = useRef({width:SIZE,height:SIZE});
  const autoIsland = useRef<{chainId:string;islandId?:string}|null>(null);
  const center = useRef({x:SIZE/2,y:SIZE/2});
  const invalidateRef = useRef<() => void>(() => {});
  const resizeRef = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(true);
  const [presented, setPresented] = useState(false);
  const [pendingReads, setPendingReads] = useState(0);
  const [detailStatus, setDetailStatus] = useState<{pending:boolean;error:string|null}>({pending:false,error:null});
  const pending = loading || pendingReads > 0 || detailStatus.pending;
  const [loadError, setError] = useState<string | null>(null);
  const error = loadError ?? detailStatus.error;
  const [cloudMotion, setCloudMotion] = useState(true);
  const [osReducedMotion, setOsReducedMotion] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [displayView, setDisplayView] = useState(viewRef.current);
  const markers = props.markers ?? EMPTY_MARKERS;
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const origin = useRef<{x:number;y:number}|null>(null);
  const moved = useRef(false);
  const pinch = useRef<{distance:number;zoom:number}|null>(null);
  const buttonOrigin = useRef(false);
  const wheelCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interacting = useRef(false);
  const lastTap = useRef<{time:number;x:number;y:number}|null>(null);

  const commit = useCallback(() => {
    clearTimeout(wheelCommit.current);
    interacting.current = false;
    // A settled view may equal the last coarse frame. It still needs one full
    // quality redraw, without another gesture or a new server response.
    invalidateRef.current();
    const view = { ...viewRef.current };
    setDisplayView(view);
    propsRef.current.onViewChange?.(view);
  }, []);
  const cancelGesture = useCallback(() => {
    const active = pointers.current.size > 0 || interacting.current;
    pointers.current.clear(); origin.current = null; pinch.current = null;
    moved.current = true; lastTap.current = null;
    if (active) commit();
  }, [commit]);
  const forgetPointer = useCallback((id:number):boolean => {
    if (!pointers.current.delete(id)) return false;
    const [a,b] = [...pointers.current.values()];
    // A third contact can replace either member of the pair. Start its new
    // distance at the current zoom so the remaining fingers neither jump nor stall.
    pinch.current = a && b ? { distance:Math.hypot(a.x-b.x,a.y-b.y), zoom:viewRef.current.zoom } : null;
    return true;
  }, []);
  const changeView = useCallback((view: FantasyView, publish = true) => {
    setMembersFor(null);
    autoIsland.current=null;
    viewRef.current = normalizedView(view);
    invalidateRef.current();
    if (publish) commit();
  }, [commit]);
  const focusRealm = useCallback((id: string) => {
    const realm = REGIONS.find((r) => r.id === id);
    if (!realm) return;
    changeView({ lon: realm.lon, lat: realm.lat, zoom: 1 });
    propsRef.current.onRealmSelect(id);
  }, [changeView]);
  const focusTile = useCallback((id: number) => {
    const tile = getFantasyTile(id);
    if (tile) changeView(tileFocus(tile, focusScale.current));
  }, [changeView]);
  useImperativeHandle(ref, () => ({
    focusRealm, focusTile,
    focusIsland(chainId, islandId) {
      const next = islandFocus(chainId, islandId, focusScale.current,available.current);
      if (next) {changeView(next);autoIsland.current={chainId,...(islandId?{islandId}:{})};}
    },
    setView: changeView,
    view: () => ({ ...viewRef.current }),
    stats: () => rendererRef.current?.stats() ?? null,
  }), [changeView, focusRealm, focusTile]);

  useEffect(() => {
    const canvas = canvasRef.current, cloudCanvas = cloudRef.current, effectCanvas = effectsRef.current;
    if (!canvas || !cloudCanvas || !effectCanvas) return undefined;
    let alive = true, dirty = true, animation = 0, intersecting = true;
    let coreReady = false, firstDraw = false;
    setPresented(false);
    let abort = new AbortController(), readGeneration = 0;
    // StrictMode can replay this effect while preserving React state. Its old
    // canceled reads are fenced, so the new lifetime owns a fresh count.
    setPendingReads(0);
    setDetailStatus({pending:false,error:null});
    const drawTimes = diagnostics ? new Float64Array(120) : null;
    const tickTimes = diagnostics ? new Float64Array(120) : null;
    let samples = 0, sampleIndex = 0, nextDiagnostic = 0;
    const invalidate = (): void => {
      dirty = true;
      if (alive && !animation && !document.hidden && intersecting) animation = requestAnimationFrame(tick);
    };
    const reportError = (cause: unknown): void => {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      if (alive && !abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Terrain could not load');
    };
    let renderer: FantasyRenderer;
    try {
      renderer = createFantasyRenderer({
        canvas, cloudCanvas, effectCanvas,
        read: (path) => {
          const generation = readGeneration;
          setPendingReads(count => count + 1);
          return loadFantasyPixels(path, abort.signal).finally(() => {
            if (alive && generation === readGeneration) setPendingReads(count => Math.max(0, count - 1));
          });
        },
        // Detail status belongs to the sources sampled by the current frame,
        // not all downloads started during this globe lifetime.
        readDetail: path => loadFantasyPixels(path, abort.signal),
        onDetailStatus: status => {
          if (alive && !abort.signal.aborted) setDetailStatus({pending:status.pending,
            error:status.error instanceof Error ? (status.error.name === 'AbortError' ? null : status.error.message) : status.error ? 'Terrain could not load' : null});
        },
        resolveTile: getFantasyTile, invalidate, onError: reportError,
        getReducedMotion: () => propsRef.current.reduceMotion,
      });
    } catch (cause) { reportError(cause); alive = false; abort.abort(); setPendingReads(0); setLoading(false); return undefined; }
    rendererRef.current = renderer;
    invalidateRef.current = invalidate;
    retryRef.current = () => {
      const generation = ++readGeneration;
      abort.abort(); abort = new AbortController();
      setPendingReads(0); setError(null); setLoading(true);
      void renderer.retry().then(() => {
        if (alive && generation === readGeneration) { coreReady = true; setLoading(false); invalidate(); }
      }).catch(cause => {
        if (alive && generation === readGeneration) { setLoading(false); reportError(cause); }
      });
    };
    const tick = (time: number): void => {
      animation = 0;
      if (!alive || document.hidden || !intersecting) return;
      const tickStart = diagnostics ? performance.now() : 0;
      let drawMs = 0;
      const redraw = dirty;
      if (dirty) {
        const p = propsRef.current;
        renderer.draw(viewRef.current, {
          selectedTileId: p.selectedTileId ?? null,
          worldMarkers: p.markers ?? EMPTY_MARKERS,
          realmId: p.selectedRealmId ?? 'crownlands', scale: cssScale.current,
          interacting: interacting.current,
        });
        if (diagnostics) drawMs = performance.now() - tickStart;
        const screen = viewportCss.current;
        const groups = layoutWorldMarkers(renderer.markerPositions().map(marker => ({...marker,
          realmId:marker.realmId??getFantasyTile(marker.tileId)?.realmId??marker.cluster?.realmId??'',
          x:marker.x/canvas.width*screen.width,y:marker.y/canvas.height*screen.height,
          parcelWidth:marker.parcelWidth/canvas.width*screen.width,parcelHeight:marker.parcelHeight/canvas.height*screen.height,
        })), markerBounds.current, p.selectedTileId??null);
        setMarkerGroups(groups);
        const sx=canvas.width/screen.width,sy=canvas.height/screen.height,bounds=markerBounds.current;
        const labels=renderer.realmLabels({
          bounds:{left:bounds.left*sx,right:bounds.right*sx,top:bounds.top*sy,bottom:bounds.bottom*sy},
          exclude:groups.map(group=>({left:(group.x-group.width/2)*sx,right:(group.x+group.width/2)*sx,
            top:(group.y-group.height/2)*sy,bottom:(group.y+group.height/2)*sy})),
          sizes:realmSizes.current.map(size=>({width:size.width*sx,height:size.height*sy})),
        });
        labels.forEach((label, i) => {
          const realm = REGIONS[i], el = realm && realmNodes.current.get(realm.id);
          if (!el) return;
          el.hidden = !label;
          if (label) { el.style.left = `${label.x / canvas.width * 100}%`; el.style.top = `${label.y / canvas.height * 100}%`; el.style.opacity = String(label.alpha); }
        });
        dirty = false;
      }
      renderer.animate(time, redraw);
      if (redraw && coreReady && !firstDraw) { firstDraw = true; setPresented(true); }
      if (drawTimes && tickTimes) {
        const now = performance.now();
        if (redraw) {
          drawTimes[sampleIndex] = drawMs; tickTimes[sampleIndex] = now - tickStart;
          sampleIndex = (sampleIndex + 1) % drawTimes.length; samples = Math.min(samples + 1, drawTimes.length);
        }
        if (samples && now >= nextDiagnostic && diagnosticRef.current) {
          // CPU of actual redraw ticks only, not idle RAF frequency or GPU/FPS.
          const summary = (values: Float64Array): string => {
            const sorted = Array.from(values.subarray(0, samples)).sort((a, b) => a - b);
            return `${sorted[Math.ceil(samples * .95) - 1]!.toFixed(1)}/${sorted[Math.ceil(samples * .99) - 1]!.toFixed(1)}ms`;
          };
          diagnosticRef.current.textContent = `GLOBE CPU p95/p99 · draw ${summary(drawTimes)} · tick ${summary(tickTimes)} · last ${samples} redraws`;
          nextDiagnostic = now + 1000;
        }
      }
      animation = requestAnimationFrame(tick);
    };
    const resize = (): void => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const size = rasterSize(rect.width,rect.height);
        const world=containerRef.current?.closest('.fantasy-world');
        let top=0,right=rect.width,bottom=rect.height;
        for(const element of world?.querySelectorAll('.fantasy-world-top,.fantasy-realm-rail,.fantasy-world-tools')??[]){
          const box=element.getBoundingClientRect();if(box.height>0)top=Math.max(top,box.bottom-rect.top);
        }
        const panel=propsRef.current.panelOpen===false?null:world?.querySelector('.fantasy-world-panel')?.getBoundingClientRect();
        if(panel&&panel.height>0){
          if(panel.width>rect.width*.65)bottom=Math.min(bottom,panel.top-rect.top);
          else if(panel.height>80&&panel.left>rect.left+rect.width*.4)right=Math.min(right,panel.left-rect.left);
        }
        const controls=containerRef.current?.querySelector('.fantasy-controls')?.getBoundingClientRect();
        if(controls&&controls.height>0)bottom=Math.min(bottom,controls.top-rect.top);
        top=Math.max(0,Math.min(top,bottom));
        available.current={width:right,height:bottom-top};
        viewportCss.current={width:rect.width,height:rect.height};
        markerBounds.current={left:6,top:top+6,right:right-6,bottom:bottom-6};
        center.current={x:right/2/rect.width*size.width,y:(top+bottom)/2/rect.height*size.height};
        renderer.resize(size.width,size.height,center.current.x,center.current.y);
        cssScale.current = Math.min(rect.width/size.width,rect.height/size.height);
        // Measure actual font/padding only on layout changes, never per gesture.
        // Hidden labels participate without being painted or gaining focus.
        const nodes=REGIONS.map(realm=>realmNodes.current.get(realm.id));
        const previous=nodes.map(node=>({hidden:node?.hidden,visibility:node?.style.visibility}));
        for(const node of nodes)if(node){node.style.visibility='hidden';node.hidden=false;}
        realmSizes.current=nodes.map((node,index)=>({width:node?.offsetWidth||realmSizes.current[index]!.width,
          height:node?.offsetHeight||realmSizes.current[index]!.height}));
        nodes.forEach((node,index)=>{if(node){node.hidden=previous[index]!.hidden??true;node.style.visibility=previous[index]!.visibility??'';}});
        focusScale.current = cssScale.current*Math.min(size.width,size.height)/SIZE;
        if(autoIsland.current){
          const next=islandFocus(autoIsland.current.chainId,autoIsland.current.islandId,focusScale.current,available.current);
          if(next){viewRef.current=normalizedView(next);commit();}
        }
        propsRef.current.onViewportChange?.({...size,centerX:center.current.x,centerY:center.current.y});
      }
      invalidate();
    };
    resizeRef.current=resize;
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (containerRef.current) resizeObserver?.observe(containerRef.current);
    for(const element of containerRef.current?.closest('.fantasy-world')?.querySelectorAll('.fantasy-world-panel,.fantasy-world-tools,.fantasy-realm-rail')??[])resizeObserver?.observe(element);
    window.addEventListener('resize',resize);
    const intersectionObserver = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => { intersecting = entry?.isIntersecting ?? true; invalidate(); }) : null;
    if (containerRef.current) intersectionObserver?.observe(containerRef.current);
    const visible = (): void => {
      if (document.hidden) {
        if (animation) cancelAnimationFrame(animation); animation = 0;
        // A stationary down still owns contacts even before motion rendering
        // begins. Backgrounding may never deliver their up/cancel events.
        cancelGesture();
        samples = sampleIndex = nextDiagnostic = 0;
        if (diagnosticRef.current) diagnosticRef.current.textContent = 'GLOBE CPU · paused';
      }
      else invalidate();
    };
    const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    const mediaChanged = (): void => { setOsReducedMotion(media?.matches ?? false); invalidate(); };
    media?.addEventListener('change', mediaChanged);
    document.addEventListener('visibilitychange', visible);
    const initialGeneration = readGeneration;
    void renderer.ready.then(() => { if (alive && readGeneration === initialGeneration) { coreReady = true; setLoading(false); invalidate(); } }).catch(() => { if (alive && readGeneration === initialGeneration) setLoading(false); });
    resize();
    void document.fonts?.ready.then(()=>{if(alive)resize();});
    return () => {
      alive = false; abort.abort(); cancelAnimationFrame(animation); clearTimeout(wheelCommit.current);
      resizeObserver?.disconnect(); intersectionObserver?.disconnect();
      window.removeEventListener('resize',resize);
      media?.removeEventListener('change', mediaChanged); document.removeEventListener('visibilitychange', visible);
      renderer.dispose(); rendererRef.current = null; invalidateRef.current = () => {}; resizeRef.current = () => {}; retryRef.current = () => {};
      interacting.current = false;
      pointers.current.clear(); origin.current = null; pinch.current = null;
    };
  }, [commit, diagnostics, cancelGesture]);

  useEffect(() => { resizeRef.current(); }, [props.panelOpen]);
  useEffect(() => { invalidateRef.current(); }, [markers, props.selectedTileId, props.selectedRealmId, props.reduceMotion]);
  useEffect(() => {
    if (props.view && (props.view.lon!==viewRef.current.lon||props.view.lat!==viewRef.current.lat||props.view.zoom!==viewRef.current.zoom)) changeView(props.view, false);
  }, [props.view, changeView]);
  useEffect(() => {
    rendererRef.current?.setCloudMotion(cloudMotion);
    invalidateRef.current();
  }, [cloudMotion]);
  const retryTerrain=useCallback(()=>retryRef.current(),[]);
  useEffect(()=>{props.onTerrainStatus?.({pending,ready:presented,error,retry:retryTerrain});},[pending,presented,error,retryTerrain,props.onTerrainStatus]);

  const point = (e: { clientX: number; clientY: number }): {x:number;y:number} => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: (e.clientX - (rect?.left ?? 0)) / (rect?.width || SIZE) * (canvasRef.current?.width ?? SIZE),
      y: (e.clientY - (rect?.top ?? 0)) / (rect?.height || SIZE) * (canvasRef.current?.height ?? SIZE) };
  };
  const select = (x:number,y:number): void => {
    const picked = rendererRef.current?.pick(x, y, viewRef.current); if (!picked) return;
    if (picked.exploration) propsRef.current.onExplore(picked.exploration);
    else if (picked.tile) propsRef.current.onSelect(picked.tile);
    else if (picked.realmId) propsRef.current.onRealmSelect(picked.realmId);
    else propsRef.current.onSelect(null);
  };
  const spread = (): number => {
    const [a,b] = [...pointers.current.values()]; return a && b ? Math.hypot(a.x-b.x,a.y-b.y) : 0;
  };
  const pointerDown = (e: ReactPointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = point(e); pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) { origin.current = p; moved.current = false; buttonOrigin.current = (e.target as Element).closest('button') !== null; }
    if (pointers.current.size === 2) {
      moved.current = true; pinch.current = { distance: spread(), zoom: viewRef.current.zoom };
      // A zoom can regroup/remove its starting marker. Keep both contacts on
      // the stable map surface; ordinary button taps retain their native click.
      for (const id of pointers.current.keys()) try { e.currentTarget.setPointerCapture(id); } catch { /* Contact ended. */ }
    }
  };
  const pointerMove = (e: ReactPointerEvent): void => {
    const previous = pointers.current.get(e.pointerId); if (!previous) return;
    const p = point(e); pointers.current.set(e.pointerId,p);
    if (pointers.current.size >= 2) {
      const pair = pinch.current;
      if (pair && pair.distance > 0) { interacting.current = true; changeView({ ...viewRef.current, zoom: pair.zoom * spread() / pair.distance }, false); }
      return;
    }
    if (!moved.current && origin.current) {
      if (Math.hypot(p.x-origin.current.x,p.y-origin.current.y) * cssScale.current <= MAPCHROME.dragPx) return;
      moved.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* Element was removed. */ }
    }
    const view = viewRef.current, radius = 176 * view.zoom * Math.min(canvasRef.current?.width??SIZE,canvasRef.current?.height??SIZE)/SIZE;
    interacting.current = true;
    changeView({ ...view, lon: view.lon - (p.x-previous.x)/radius * 180/Math.PI / Math.max(.25,Math.cos(view.lat*Math.PI/180)), lat:view.lat+(p.y-previous.y)/radius*180/Math.PI }, false);
  };
  const release = (e: ReactPointerEvent, cancelled:boolean): void => {
    if (!pointers.current.has(e.pointerId)) return;
    const tap = !moved.current && pointers.current.size === 1 && !cancelled;
    forgetPointer(e.pointerId);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* No capture. */ }
    if (pointers.current.size === 0) { origin.current = null; commit(); }
    if (!tap || buttonOrigin.current) return;
    const p = point(e), previous = lastTap.current, time = performance.now();
    if (previous && time-previous.time < MAP_DBL.ms && Math.hypot(p.x-previous.x,p.y-previous.y)*cssScale.current < MAP_DBL.px) {
      lastTap.current = null;
      const selected = rendererRef.current?.pick(p.x,p.y,viewRef.current);
      if (selected?.tile) changeView({lon:selected.tile.lon,lat:selected.tile.lat,zoom:viewRef.current.zoom*2});
      return;
    }
    lastTap.current = { time, ...p }; select(p.x,p.y);
  };
  useEffect(() => {
    const drop = (e: PointerEvent): void => {
      if (!forgetPointer(e.pointerId)) return;
      moved.current = true;
      if (!pointers.current.size) { origin.current = null; commit(); }
    };
    window.addEventListener('pointerup', drop); window.addEventListener('pointercancel', drop);
    window.addEventListener('blur',cancelGesture);
    return () => { window.removeEventListener('pointerup',drop); window.removeEventListener('pointercancel',drop); window.removeEventListener('blur',cancelGesture); };
  }, [commit, cancelGesture, forgetPointer]);
  useEffect(() => {
    const surface = containerRef.current; if (!surface) return undefined;
    const wheel = (e:WheelEvent): void => {
      e.preventDefault();
      interacting.current = true;
      changeView({...viewRef.current,zoom:viewRef.current.zoom*Math.exp(-Math.max(-200,Math.min(200,e.deltaY))*.001)},false);
      clearTimeout(wheelCommit.current); wheelCommit.current=setTimeout(commit,120);
    };
    surface.addEventListener('wheel',wheel,{passive:false});
    return () => { surface.removeEventListener('wheel',wheel); clearTimeout(wheelCommit.current); };
  }, [changeView,commit]);
  const keyDown = (e:KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const view = viewRef.current, step = 6/view.zoom;
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home','Enter',' '].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Enter' || e.key === ' ') { select(center.current.x,center.current.y); return; }
    if (e.key === 'Home') { focusRealm(props.selectedRealmId ?? 'crownlands'); return; }
    changeView({...view,lon:view.lon+(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0),lat:view.lat+(e.key==='ArrowUp'?step:e.key==='ArrowDown'?-step:0),zoom:view.zoom*(['+','='].includes(e.key)?1.2:e.key==='-'?1/1.2:1)});
  };

  const memberGroup=membersFor===null?undefined:markerGroups.find(group=>group.marker.tileId===membersFor);
  const closeMembers=():void=>{setMembersFor(null);canvasRef.current?.focus({preventScroll:true});};
  return <><div className="fantasy-globe" ref={containerRef} inert={!presented} data-presented={presented}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={(e)=>release(e,false)}
    onPointerCancel={(e)=>release(e,true)}
    onClickCapture={e=>{if(moved.current&&e.detail!==0){e.preventDefault();e.stopPropagation();}}}
    onLostPointerCapture={(e)=>{
      // Touch implicitly captures the starting canvas/marker. Moving capture to
      // this surface fires a bubbling loss from that child; the touch is alive
      // while the surface owns its pending capture, so keep its drag/pinch state.
      if(e.currentTarget.hasPointerCapture(e.pointerId))return;
      if(forgetPointer(e.pointerId)){moved.current=true;if(!pointers.current.size){origin.current=null;commit();}}
    }}>

    <canvas ref={canvasRef} width={SIZE} height={SIZE} tabIndex={0}
      aria-label="Fantasy world. Drag to rotate, pinch or use plus and minus to zoom. Arrow keys rotate; Enter inspects the center."
      onKeyDown={keyDown} />
    <canvas ref={effectsRef} width={SIZE} height={SIZE} aria-hidden="true" className="fantasy-effects" />
    <canvas ref={cloudRef} width={SIZE} height={SIZE} aria-hidden="true" className="fantasy-clouds" />
    <div className="fantasy-labels">{REGIONS.map((realm)=><button key={realm.id}
      ref={(node)=>{ if(node)realmNodes.current.set(realm.id,node);else realmNodes.current.delete(realm.id); }}
      hidden className="fantasy-realm-label" style={{color:realm.color}} onClick={()=>focusRealm(realm.id)}>{realm.name}</button>)}</div>
    <div className="fantasy-markers">{markerGroups.map(group=>{
      const {marker}=group, clustered=group.count>1||!!marker.cluster;
      const label=group.selected?`${marker.name} · selected tile ${marker.tileId}`:marker.name;
      return <button key={marker.tileId}
        className={`fantasy-owner-marker${clustered?' fantasy-owner-cluster':''}${group.owned?' owned':''}${group.selected?' selected':''}`}
        style={{left:group.x,top:group.y,width:group.width,height:group.height}}
        aria-label={clustered?`${group.selected?label+'. ':''}${group.count} ${marker.cluster?'assigned':'nearby'} deeds${marker.cluster?` in ${REGIONS.find(r=>r.id===marker.cluster!.realmId)?.name??marker.cluster.realmId}`:''}. ${viewRef.current.zoom===normalizedView({...viewRef.current,zoom:viewRef.current.zoom*2}).zoom?'Choose a base.':'Zoom to inspect bases.'}`:`${marker.name} · tile ${marker.tileId}${marker.owned?' · your deed':''}`}
        aria-haspopup={clustered?'dialog':undefined}
        title={group.showName?label:undefined}
        onClick={()=>{
          const tile=getFantasyTile(marker.tileId);if(!tile)return;
          if(clustered){
            const next=normalizedView({...tileFocus(tile,focusScale.current),zoom:Math.max(viewRef.current.zoom*2,tileFocus(tile,focusScale.current).zoom)});
            if(next.zoom===viewRef.current.zoom){setMembersFor(marker.tileId);return;}
            if(marker.cluster)propsRef.current.onRealmSelect(marker.cluster.realmId);
            changeView(next);
          }else{propsRef.current.onSelect(tile);focusTile(tile.tileId);}
        }}>
        <span className="fantasy-owner-glyph" aria-hidden="true"><Sprite name={`map_keep_t${Math.min(5,Math.max(1,Math.trunc(marker.keepLevel??1)))}`} w={24} h={24}/></span>
        {group.showName&&<span className="fantasy-owner-name">{marker.name}</span>}
        {clustered&&<strong className="fantasy-owner-count" aria-hidden="true">{group.count>999?'999+':group.count}</strong>}
      </button>;
    })}</div>
    <div className="fantasy-controls">
      <button aria-label="Zoom in" onClick={()=>changeView({...viewRef.current,zoom:viewRef.current.zoom*1.25})}>+</button>
      <button aria-label="Zoom out" onClick={()=>changeView({...viewRef.current,zoom:viewRef.current.zoom/1.25})}>−</button>
      <button aria-label="Cloud motion" aria-pressed={cloudMotion&&!props.reduceMotion&&!osReducedMotion} onClick={()=>setCloudMotion((value)=>!value)}>CLOUDS</button>
    </div>
    <output className="fantasy-coordinate">{displayView.zoom.toFixed(1)}× · {Math.abs(displayView.lat).toFixed(1)}°{displayView.lat<0?'S':'N'} · {Math.abs(displayView.lon).toFixed(1)}°{displayView.lon<0?'W':'E'}</output>
    {diagnostics&&<output ref={diagnosticRef} aria-live="off" data-globe-diagnostics style={{position:'absolute',bottom:70,left:8,maxWidth:'calc(100% - 16px)',pointerEvents:'none',font:'11px monospace',color:'#cfefa2',background:'#101419dd',padding:3,zIndex:4}}>GLOBE CPU · waiting for redraws</output>}

  </div>{!props.onTerrainStatus&&!presented&&<div className="sk-game-loading-shell"><GameLoading title={error?'Couldn’t open the world':'Opening the world…'} failed={!!error} detail={error?'Please try again.':undefined} reduceMotion={props.reduceMotion}>{error&&<button onClick={retryTerrain}>TRY AGAIN</button>}</GameLoading></div>}
  {!props.onTerrainStatus&&presented&&error&&<div className="fantasy-load" role="status">Some map details couldn’t load. <button onClick={retryTerrain}>TRY AGAIN</button></div>}
  {memberGroup&&<ClusterMembers group={memberGroup} bounds={markerBounds.current} onClose={closeMembers}
    onSelect={tileId=>{const tile=getFantasyTile(tileId);if(tile){propsRef.current.onSelect(tile);focusTile(tileId);canvasRef.current?.focus({preventScroll:true});}}}/>}</>;
});

/** Outside the map's touch-action zone: this list scrolls normally on phones. */
function ClusterMembers({group,bounds,onClose,onSelect}:{group:MarkerGroup;bounds:{left:number;right:number;top:number;bottom:number};onClose():void;onSelect(tileId:number):void}){
  const title=useId(),close=useRef<HTMLButtonElement>(null);
  useMobileBackHandler(onClose,true,110);
  useEffect(()=>{close.current?.focus({preventScroll:true});},[]);
  const members=group.members.filter(member=>!member.cluster||member.owned||member.tileId===group.marker.tileId&&group.selected);
  return <section role="dialog" aria-labelledby={title} className="fantasy-owner-members"
    style={{left:bounds.left,top:bounds.top,width:Math.min(340,bounds.right-bounds.left),maxHeight:bounds.bottom-bounds.top}}
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}>
    <header><strong id={title}>Nearby deeds</strong><button ref={close} type="button" onClick={onClose} aria-label="Close nearby deeds">×</button></header>
    <div className="fantasy-owner-members-scroll"><ul>{members.map(member=><li key={member.tileId}><button type="button" onClick={()=>onSelect(member.tileId)}>
      <span>{member.name}</span><small>Tile {member.tileId}{member.owned?' · your deed':''}</small>
    </button></li>)}</ul>{members.length<group.count&&<p>Only currently loaded deeds are listed. Move the map to load more.</p>}</div>
  </section>;
}
