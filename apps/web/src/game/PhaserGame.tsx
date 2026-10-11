/**
 * Phaser mount — created once in a layout effect with a ref guard (React 19
 * StrictMode double-mounts effects in dev; without the guard you get two
 * canvases and two AudioContexts — research: engine-pipeline §2).
 */
import Phaser from 'phaser';
import { useLayoutEffect, useRef, useState } from 'react';
import { captureError, type ErrorDiagnostics } from '../lib/analytics';
import { serviceWorkerControlsAssetPackBuild } from '../lib/assetPack';
import { BUILD } from '../lib/version';
import { bus, type SceneVisualProgress } from '../lib/events';
import { subscribeGameViewport } from '../lib/gameViewport';
import { isSolanaMobileClient } from '../lib/mobileShell';
import { resolvePerfDiagFromUrl, subscribePerfDiag } from '../lib/perfDiagFlag';
import { GameLoading } from '../ui/loading/GameLoading';
import { LoadingStage } from '../ui/loading/LoadingStage';
import { useApp, type Screen } from '../state/store';
import { renderFpsLimit } from './renderRate';
import { BaseScene } from './scenes/BaseScene';
import { BattleScene } from './scenes/BattleScene';
import { BootScene } from './scenes/BootScene';
import { StepTimingSampler } from './stepTiming';
import { RENDER_HEARTBEAT, RenderHeartbeat } from './renderHeartbeat';
import { sceneCleanup } from './sceneCleanup';

/** Screens where the canvas is actually visible (Overlay.tsx): the base scene
 *  under base/build/layout, the battle scene under battle/scout. Layout keeps
 *  only its control chrome interactive so the real base remains editable;
 *  every other screen is a fully-opaque React cover. */
const CANVAS_SCREENS: ReadonlySet<Screen> = new Set(['base', 'build', 'layout', 'battle', 'scout']);

function preparationDiagnostics(progress: SceneVisualProgress | undefined): ErrorDiagnostics {
  if (!progress) return {};
  const out: ErrorDiagnostics = { prepPhase: progress.phase, prepCompleted: progress.completed, prepTotal: progress.total };
  const timing = progress.timings;
  if (!timing) return out;
  for (const [key, field] of Object.entries({ downloadMs: 'prepDownloadMs', verifyMs: 'prepVerifyMs',
    decodeMs: 'prepDecodeMs', paintMs: 'prepPaintMs', uploadMs: 'prepUploadMs', maxPaintBatchMs: 'prepMaxPaintBatchMs',
    width: 'prepWidth', height: 'prepHeight', loadAttempt: 'prepLoadAttempt', loadActiveMs: 'prepLoadActiveMs' } as const)) {
    const value = timing[key as keyof typeof timing];
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = Math.round(value);
  }
  if (timing.loadProtocol) out.prepLoadProtocol = timing.loadProtocol;
  if (timing.loadReason) out.prepLoadReason = timing.loadReason;
  if (typeof timing.cacheHit === 'boolean') out.prepCacheHit = timing.cacheHit;
  return out;
}

export function PhaserGame(): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const [displayStopped, setDisplayStopped] = useState(false);
  const [contextLost, setContextLost] = useState(false);
  const [visualProgress, setVisualProgress] = useState<Partial<Record<'base' | 'battle', SceneVisualProgress>>>({});
  // The last measured (uncached) byte report of the current preparation.
  const [transfers, setTransfers] = useState<Partial<Record<'base' | 'battle', { completed: number; total: number }>>>({});
  const [artworkFailed, setArtworkFailed] = useState(false);
  // Raid creation/recovery owns its request and error UI. No battle artwork
  // exists to prepare until an accepted snapshot actually enters the scene.
  const [battleEntered, setBattleEntered] = useState(false);
  const [visualStates, setVisualStates] = useState<Record<'base' | 'battle', 'loading' | 'ready' | 'failed'>>({ base: 'loading', battle: 'loading' });
  const currentScreen = useApp((state) => state.screen);
  const reduceMotion = useApp((state) => state.reduceMotion);

  useLayoutEffect(() => {
    if (gameRef.current || !containerRef.current) return undefined;
    containerRef.current.innerHTML = ''; // drop any canvas a torn-down game left behind
    const params = new URLSearchParams(location.search);
    let solanaMobile = params.get('client') === 'solana-mobile';
    try { solanaMobile = isSolanaMobileClient(); } catch { /* URL result survives denied storage */ }
    let rateStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null;
    try { rateStorage = localStorage; } catch { /* private/denied storage: query + safe default still work */ }
    const fpsLimit = renderFpsLimit({
      search: location.search,
      solanaMobile,
      storage: rateStorage,
    });
    const unsubBootFailure = bus.on('boot:failed', ({ files, diagnostics }) => {
      setArtworkFailed(true);
      const round = diagnostics?.rounds.at(-1);
      const first = diagnostics?.rounds[0];
      let failureSummary = '';
      for (const file of round?.files ?? []) {
        if (file.phase === 'complete') continue;
        const entry = `${file.key}:${file.kind}:${file.phase}:${file.state ?? '-'}:${file.status ?? '-'}:${file.loadedBytes}/${file.totalBytes}`;
        const next = failureSummary ? `${failureSummary};${entry}` : entry;
        // Keep complete records within the telemetry sink's field limit.
        if (next.length > 200) break;
        failureSummary = next;
      }
      let workerState: ErrorDiagnostics['workerState'] = 'none';
      try {
        const controller = navigator.serviceWorker?.controller;
        if (controller) workerState = serviceWorkerControlsAssetPackBuild(controller, BUILD.gitSha) ? 'current' : 'previous';
      } catch { /* Storage-denied browsers may not expose a controller. */ }
      const details: ErrorDiagnostics = { workerState,
        // A fast failed retry must not erase the original interruption.
        ...(first ? { loadFirstReason: first.reason, loadFirstActiveMs: Math.round(first.activeMs),
          loadFirstLoadedBytes: first.files.reduce((sum, file) => sum + file.loadedBytes, 0) } : {}),
        ...(round && diagnostics ? { loadProfile: diagnostics.profile, loadReason: round.reason,
          loadAttempt: round.attempt, loadActiveMs: Math.round(round.activeMs), loadBudgetMs: round.budgetMs,
          loadQueued: round.queued, loadInflight: round.inflight, loadProcessing: round.processing,
          loadFailures: failureSummary } : {}) };

      captureError('error', { name: 'BootAssetLoadError',
        message: `Required game artwork did not load: ${files.join(', ')}`,
        source: 'phaser-boot-assets', boundary: 'game', screen: useApp.getState().screen, diagnostics: details });
    });
    const sceneStates: Record<'base' | 'battle', 'loading' | 'ready' | 'failed'> = { base: 'loading', battle: 'loading' };
    const sceneProgress: Partial<Record<'base' | 'battle', SceneVisualProgress>> = {};
    const unsubBattleEnter = bus.on('battle:enter', () => setBattleEntered(true));
    const unsubBattleExit = bus.on('battle:exit', () => setBattleEntered(false));
    const unsubVisual = bus.on('scene:visual', ({ scene, state }) => {
      if (state === 'failed' && sceneStates[scene] !== 'failed') {
        captureError('error', { name: 'ScenePreparationFailed', message: 'Realm artwork preparation failed',
          source: 'scene-visual-preparation', boundary: 'game', screen: useApp.getState().screen,
          diagnostics: { activeScene: scene, sceneState: state, ...preparationDiagnostics(sceneProgress[scene]) } });
      }
      sceneStates[scene] = state;
      if (state === 'loading') {
        delete sceneProgress[scene];
        setVisualProgress(previous => ({ ...previous, [scene]: undefined }));
        setTransfers(previous => ({ ...previous, [scene]: undefined }));
      }
      setVisualStates(previous => previous[scene] === state ? previous : { ...previous, [scene]: state });
    });
    const unsubVisualProgress = bus.on('scene:visualProgress', progress => {
      if (!Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)
        || progress.completed < 0 || progress.completed > 100_000_000
        || progress.total < 0 || (progress.total > 0 && progress.total < progress.completed) || progress.total > 100_000_000) return;
      sceneProgress[progress.scene] = progress;
      setVisualProgress(previous => ({ ...previous, [progress.scene]: progress }));
      if (progress.phase === 'download') {
        const measured = progress.timings?.cacheHit !== true && progress.total > 0;
        setTransfers(previous => ({ ...previous,
          [progress.scene]: measured ? { completed: progress.completed, total: progress.total } : undefined }));
      }
    });
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: '#100E14',
      // The app mixer owns SFX/music. Phaser's unused second AudioContext also
      // resumes on focus, where a missing audio device can reject its promise.
      audio: { noAudio: true },
      // A secondary press never owns a game gesture; suppress the browser menu
      // too so right-clicking the battlefield cannot break the game surface.
      disableContextMenu: true,
      // A 90/120 Hz Seeker panel otherwise makes Phaser render identical game
      // state 90/120 times per second. Keep desktop/browser behavior unchanged;
      // `?hz=auto` is a sticky diagnostic escape and `?hz=60` restores this cap.
      fps: { limit: fpsLimit },
      render: {
        pixelArt: true, // antialias off + roundPixels + NEAREST
        // Phaser 4.1 defaults autoMobileTextures to TRUE, which forces ONE
        // texture unit per batch on every mobile device — and the scenes
        // interleave ~10 atlases by depth, so draw calls explode on the Seeker
        // (perf audit 2026-07-31). False keeps multi-texture batching on
        // mobile. A/B escape: the flag exists because some mobile GPUs run the
        // multi-texture shader SLOWER — if the Seeker regresses, reverting
        // this one line is the whole rollback, and ?mtex=1 restores Phaser's
        // default on-device without a rebuild.
        autoMobileTextures: params.get('mtex') === '1',
      },
      scale: {
        mode: Phaser.Scale.RESIZE,
        width: '100%',
        height: '100%',
      },
      scene: [BootScene, BaseScene, BattleScene],
    });
    gameRef.current = game;

    // A STEP heartbeat can succeed before an update/render callback throws.
    // POST_RENDER proves the whole frame completed. This timer belongs to
    // React/the browser, so a stranded Phaser RAF cannot strand the notice.
    const heartbeat = new RenderHeartbeat();
    let disposed = false;
    let canvas: HTMLCanvasElement | null = null;
    let contextRecoveryPending = false;
    let pagePresented = true;
    const rendererLost = (): boolean => !!(game.renderer as Phaser.Renderer.WebGL.WebGLRenderer | undefined)?.contextLost;
    const rendererDiagnostics = (): ErrorDiagnostics => {
      const screen = useApp.getState().screen;
      const activeScene = CANVAS_SCREENS.has(screen) ? (screen === 'scout' || screen === 'battle' ? 'battle' : 'base') : 'none';
      return { ...heartbeat.diagnostics(performance.now()), activeScene,
        sceneActive: activeScene !== 'none' && game.scene.isActive(activeScene),
        sceneVisible: activeScene !== 'none' && game.scene.isVisible(activeScene),
        ...(activeScene === 'none' ? {} : { sceneState: sceneStates[activeScene], ...preparationDiagnostics(sceneProgress[activeScene]) }) };
    };
    const onContextLost = (): void => {
      if (disposed || !heartbeat.contextLost()) return;
      contextRecoveryPending = true;
      setContextLost(true);
      captureError('error', { name: 'WebGLContextLost', message: 'Game graphics context was lost',
        source: 'phaser-webgl-context', boundary: 'game', screen: useApp.getState().screen,
        diagnostics: { ...rendererDiagnostics(), renderState: 'context-lost' } });
    };
    const onContextRestored = (): void => {
      // Phaser can reject this DOM event while gl.isContextLost() remains true.
      // Keep the loss episode until the renderer accepts a real restoration.
      if (!disposed && !rendererLost()) heartbeat.contextRestored(performance.now());
      // The browser event alone does not prove that Phaser submitted a frame.
    };
    const attachContext = (): void => {
      if (canvas || !game.canvas) return;
      canvas = game.canvas;
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
      if (rendererLost()) onContextLost();
    };
    // Phaser4 refresh() consumes cached parentSize; it does not measure DOM.
    // A first READY/rotation during browser chrome animation can otherwise keep
    // restoring an obsolete canvas height even though the root is now correct.
    const settleTimers: number[] = [];
    const reconcileScale = (): void => {
      const parent = containerRef.current;
      const scale = game.scale;
      if (disposed || document.visibilityState === 'hidden' || !parent || !scale?.canvas) return;
      const rect = parent.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const changed = scale.getParentBounds();
      const canvasRect = scale.canvas.getBoundingClientRect();
      if (changed || Math.abs(scale.width - rect.width) >= 1 || Math.abs(scale.height - rect.height) >= 1
        || Math.abs(canvasRect.width - rect.width) >= 1 || Math.abs(canvasRect.height - rect.height) >= 1) {
        scale.refresh();
      } else scale.updateBounds();
    };
    const settleScale = (): void => {
      for (const timer of settleTimers.splice(0)) window.clearTimeout(timer);
      reconcileScale();
      if (disposed || document.visibilityState === 'hidden') return;
      for (const delay of [50, 150, 350, 700, 1200]) {
        settleTimers.push(window.setTimeout(reconcileScale, delay));
      }
    };
    const parentResize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(settleScale);
    parentResize?.observe(containerRef.current!);
    window.addEventListener('orientationchange', settleScale);
    screen.orientation?.addEventListener?.('change', settleScale);
    window.visualViewport?.addEventListener('resize', settleScale);
    document.addEventListener('visibilitychange', settleScale);
    const unsubViewport = subscribeGameViewport(() => {
      // Origin-only corrections must update input bounds too.
      if (game.scale.canvas) game.scale.updateBounds();
      settleScale();
    });
    const unsubScaleVisual = bus.on('scene:visual', ({ state }) => { if (state === 'ready') settleScale(); });
    const onReady = (): void => { heartbeat.markReady(performance.now()); attachContext(); settleScale(); };
    const onStepped = (): void => heartbeat.stepped(performance.now());
    const onRendered = (): void => {
      // Phaser emits Core.POST_RENDER even when WebGLRenderer returned early
      // because its context is lost. Such a callback is not a completed image.
      if (rendererLost() || heartbeat.isContextLost()) return;
      heartbeat.rendered(performance.now());
      if (contextRecoveryPending) { contextRecoveryPending = false; setContextLost(false); }
    };
    const resetRenderGrace = (): void => heartbeat.resetGrace(performance.now());
    // BFCache can restore a page without focus/visibility events. An overdue
    // interval must not classify the suspended page as a stranded game loop.
    const onPageHide = (): void => { pagePresented = false; resetRenderGrace(); };
    const onPageShow = (): void => { pagePresented = true; resetRenderGrace(); settleScale(); };
    game.events.once(Phaser.Core.Events.READY, onReady);
    attachContext();
    if (game.isRunning) onReady();
    else settleScale();
    game.events.on(Phaser.Core.Events.STEP, onStepped);
    game.events.on(Phaser.Core.Events.POST_RENDER, onRendered);
    game.events.on(Phaser.Core.Events.PAUSE, resetRenderGrace);
    game.events.on(Phaser.Core.Events.RESUME, resetRenderGrace);
    document.addEventListener('visibilitychange', resetRenderGrace);
    window.addEventListener('focus', resetRenderGrace);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    const heartbeatTimer = window.setInterval(() => {
      const pendingDestroy = (game as Phaser.Game & { readonly pendingDestroy?: boolean }).pendingDestroy;
      const diagnostics = rendererDiagnostics();
      const visible = pagePresented && !disposed && !pendingDestroy && !game.isPaused
        && !rendererLost()
        && document.visibilityState === 'visible'
        && diagnostics.sceneActive === true && diagnostics.sceneVisible === true && diagnostics.sceneState === 'ready'
        && !!canvas?.isConnected && canvas.clientWidth > 0 && canvas.clientHeight > 0;
      if (!heartbeat.check(performance.now(), visible)) return;
      setDisplayStopped(true);
      captureError('error', { name: 'RendererStopped', message: 'Game display stopped rendering',
        source: 'phaser-render-heartbeat', boundary: 'game', screen: useApp.getState().screen,
        diagnostics: { ...diagnostics, renderState: 'loop-stopped' } });
    }, RENDER_HEARTBEAT.checkMs);

    if (import.meta.env.DEV) {
      (window as unknown as { __game?: Phaser.Game }).__game = game;
    }

    // FPS overlay (?fps=1) — the measurement tool for the Seeker perf fixes;
    // ships in prod behind the query param. Shows rendered FPS plus the WORST
    // frame delta since the last sample (stutter spikes that an average hides).
    let fpsCleanup: (() => void) | undefined;
    if (params.get('fps') === '1') {
      (window as unknown as { __game?: Phaser.Game }).__game = game; // prod too
      const div = document.createElement('div');
      div.dataset['fpsDiag'] = '1';
      div.style.cssText =
        'position:fixed;top:2px;left:2px;z-index:99999;pointer-events:none;' +
        'font:12px monospace;color:#7CFC00;background:rgba(0,0,0,.6);padding:2px 6px';
      document.body.appendChild(div);
      let maxDelta = 0;
      const timing = new StepTimingSampler();
      const limited = fpsLimit > 0;
      const onStep = (time: number): void => {
        const dt = timing.sample(time, game.loop.rawDelta, limited);
        if (dt !== null && dt > maxDelta) maxDelta = dt;
      };
      const onPause = (): void => timing.dropBaseline();
      game.events.on(Phaser.Core.Events.STEP, onStep);
      game.events.on(Phaser.Core.Events.PAUSE, onPause);
      const timer = window.setInterval(() => {
        const screen = useApp.getState().screen;
        div.textContent = CANVAS_SCREENS.has(screen)
          ? `Phaser loop ${screen} · ${timing.fps(limited ? 0 : game.loop.actualFps, limited).toFixed(1)} fps · max ${maxDelta.toFixed(0)}ms`
          : `Phaser inactive · ${screen}${screen === 'map' ? ' (globe measured separately)' : ''}`;
        maxDelta = 0;
        timing.clearWindow();
      }, 250);
      fpsCleanup = () => {
        window.clearInterval(timer);
        game.events.off(Phaser.Core.Events.STEP, onStep);
        game.events.off(Phaser.Core.Events.PAUSE, onPause);
        div.remove();
      };
    }

    // Diagnostics overlay + perf_summary telemetry (?diag=1 / Settings row,
    // D-101 "measure first"). The measurement module is imported on demand so
    // a session that never opts in never loads it; the Settings toggle mounts
    // and unmounts it live through the flag's subscription. `diagWanted`
    // covers on→off before the import resolves: the late mount is skipped.
    let diagDispose: (() => void) | undefined;
    let diagWanted = false;
    const applyDiag = (on: boolean): void => {
      diagWanted = on;
      if (on && !diagDispose) {
        void import('../lib/perfDiag').then(({ mountPerfDiag }) => {
          if (diagWanted && !diagDispose && gameRef.current === game) {
            diagDispose = mountPerfDiag(game, scene => ({ state: sceneStates[scene], progress: sceneProgress[scene] }));
          }
        }).catch(() => null);
      } else if (!on && diagDispose) {
        diagDispose();
        diagDispose = undefined;
      }
    };
    applyDiag(resolvePerfDiagFromUrl(location.search));
    const unsubDiag = subscribePerfDiag(applyDiag);

    // Sleep the base scene under fully-opaque React screens — it otherwise
    // renders ~2,850 objects every frame beneath them (perf audit). sleep()
    // (not pause) is what skips RENDER, and it is the same mechanism
    // battle:enter already uses on this scene; BaseScene's bus/store
    // subscriptions live until SHUTDOWN, which sleep never fires, so nothing
    // needs re-arming on wake. The battle scene manages its own lifecycle
    // via battle:enter/exit — entering battle/scout keeps an already-sleeping
    // base asleep while the snapshot arrives. Only home routes need to wake
    // its renderFromStore; battle:exit owns the return from an active battle.
    const unsubScreen = useApp.subscribe((state, previous) => {
      // Authentication/deed gates can leave battle without pressing HOME. The
      // view transition must still retire enemy art; it never submits orders.
      if ((previous.screen === 'battle' || previous.screen === 'scout')
        && state.screen !== 'battle' && state.screen !== 'scout' && game.scene.isActive('battle')) {
        sceneCleanup('screen-battle-exit', () => bus.emit('battle:exit', undefined));
      }
      const visible = CANVAS_SCREENS.has(state.screen);
      const homeVisible = state.screen === 'base' || state.screen === 'build' || state.screen === 'layout';
      if (!visible && game.scene.isActive('base')) game.scene.sleep('base');
      else if (homeVisible && game.scene.isSleeping('base') && !game.scene.isActive('battle')) {
        game.scene.wake('base');
      }
    });

    return () => {
      disposed = true;
      unsubBootFailure();
      unsubBattleEnter();
      unsubBattleExit();
      unsubVisual();
      unsubVisualProgress();
      canvas?.removeEventListener('webglcontextlost', onContextLost);
      canvas?.removeEventListener('webglcontextrestored', onContextRestored);
      window.clearInterval(heartbeatTimer);
      game.events.off(Phaser.Core.Events.READY, onReady);
      game.events.off(Phaser.Core.Events.STEP, onStepped);
      game.events.off(Phaser.Core.Events.POST_RENDER, onRendered);
      game.events.off(Phaser.Core.Events.PAUSE, resetRenderGrace);
      game.events.off(Phaser.Core.Events.RESUME, resetRenderGrace);
      document.removeEventListener('visibilitychange', resetRenderGrace);
      window.removeEventListener('focus', resetRenderGrace);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      unsubScreen();
      unsubDiag();
      diagWanted = false;
      diagDispose?.();
      diagDispose = undefined;
      fpsCleanup?.();
      parentResize?.disconnect();
      unsubViewport();
      unsubScaleVisual();
      document.removeEventListener('visibilitychange', settleScale);
      window.removeEventListener('orientationchange', settleScale);
      screen.orientation?.removeEventListener?.('change', settleScale);
      window.visualViewport?.removeEventListener('resize', settleScale);
      for (const t of settleTimers) window.clearTimeout(t);
      gameRef.current?.destroy(true);
      gameRef.current = null;
    };
  }, []);

  const visualScene = currentScreen === 'battle' || currentScreen === 'scout' ? 'battle' : 'base';
  const visualState = visualStates[visualScene];
  const progress = visualProgress[visualScene];
  const place = visualScene === 'base' ? 'your kingdom' : 'the battlefield';
  const preparationLabel = visualScene === 'base' ? 'Opening your kingdom…'
    : currentScreen === 'scout' ? 'Opening the base…' : 'Entering battle…';
  // A download has a measurable denominator. Local rendering work is not an
  // overall completion estimate, so it keeps an indeterminate meter. A streamed
  // ground verifies, decodes and uploads each page between its byte reports;
  // those steps belong to the transfer until its bytes are complete. Dropping
  // to indeterminate for each one flipped the meter and its "Downloading" line
  // 14-52 times per load (owner 2026-09-27: "flickering or dizzying").
  const transfer = transfers[visualScene];
  const inTransfer = progress?.phase === 'download' || (!!transfer && transfer.completed < transfer.total
    && (progress?.phase === 'verify' || progress?.phase === 'decode' || progress?.phase === 'upload'));
  const downloadPct = transfer && inTransfer ? Math.min(100, Math.floor(transfer.completed * 100 / transfer.total)) : null;
  return <>
    <div ref={containerRef} data-game-canvas-container style={{ position: 'absolute', inset: 0 }} />
    {CANVAS_SCREENS.has(currentScreen) && (visualScene === 'base' || battleEntered)
      && visualState !== 'ready' && !artworkFailed && !displayStopped && !contextLost && (
      <div className="interactive sk-game-loading-shell" style={{ position: 'fixed', zIndex: 99999 }}>
        <LoadingStage>
          <GameLoading title={visualState === 'failed' ? `Couldn’t open ${place}` : preparationLabel}
            failed={visualState === 'failed'} detail={visualState === 'failed' ? 'Please try again.' : undefined}
            transferPercent={downloadPct} reduceMotion={reduceMotion} tips>
            {visualState === 'failed' && <button type="button" onClick={() => bus.emit('scene:visualRetry', { scene: visualScene })}>TRY AGAIN</button>}
          </GameLoading>
        </LoadingStage>
      </div>
    )}
    {(artworkFailed || (displayStopped || contextLost) && CANVAS_SCREENS.has(currentScreen)) && (
      <div role="alertdialog" aria-modal="true" aria-labelledby="renderer-stopped-title"
        className="interactive" style={{ position: 'fixed', inset: 0, zIndex: 100000,
          display: 'grid', placeItems: 'center', padding: 16, background: 'rgba(16,14,20,.94)' }}>
        <div style={{ width: '100%', maxWidth: 420, textAlign: 'center', color: '#f4d77b' }}>
          <h2 id="renderer-stopped-title" style={{ fontSize: 24 }}>{artworkFailed ? 'Couldn’t load your kingdom' : 'Game paused'}</h2>
          <p style={{ color: '#ded8ce', fontSize: 18 }}>{artworkFailed ? 'Please try again.' : contextLost ? 'Please wait a moment, or reload to continue.' : 'Reload to continue.'}</p>
          <button type="button" autoFocus onClick={() => window.location.reload()}
            style={{ minHeight: 48, width: '100%', padding: '10px 16px', font: 'inherit',
              fontSize: 20, background: '#d5a735', color: '#171219', border: '2px solid #f4d77b', cursor: 'pointer' }}>
            {artworkFailed ? 'TRY AGAIN' : 'RELOAD GAME'}
          </button>
        </div>
      </div>
    )}
  </>;
}
