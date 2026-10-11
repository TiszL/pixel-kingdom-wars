/**
 * Solana Mobile asset-pack gate — the store slice and the transfer scheduler.
 *
 * D-101 transfer discipline (M33 C1). The verified pack is optional background
 * work, and until this module it lived in App state: every 250 ms progress
 * tick was a `setState` in <App>, which re-rendered the whole un-memoised
 * <Overlay> at 4 Hz although only TitleScreen, LoadingScreen and
 * AssetPackBackgroundStatus read it. Now the three surfaces subscribe to this
 * slice directly and nothing else re-renders on a tick.
 *
 * The scheduler also decides WHEN the transfer runs:
 *   - never before `boot:ready` — BootScene's own eager atlas fetches must not
 *     compete with a 200+ MB download for the phone's bandwidth and main
 *     thread (and, once the worker controls the page, those eager objects are
 *     stored by the worker's fetch path, so the pack inventory finds them
 *     instead of downloading and hashing them a second time);
 *   - never while any canvas-visible gameplay screen is open or the tab is hidden — the
 *     transfer is aborted and, because resume is missing-only, restarted
 *     cheaply ASSET_PACK_TRANSFER.resumeDelayMs after the coast is clear.
 *
 * D-050 is unchanged: the pack never gates the title or onboarding, and a
 * deferred first page (worker cannot control it yet) is indistinguishable from
 * ordinary online play (`required` false).
 */
import { ASSET_PACK_TRANSFER } from '@shardkeep/shared';
import { create } from 'zustand';
import {
  AssetPackError, assetPackErrorMessage, ensureAssetPack, serviceWorkerControlsAssetPackBuild,
  type AssetPackEnvironment, type AssetPackGateState, type AssetPackManifest,
} from '../lib/assetPack';
import { bus } from '../lib/events';
import { reloadToLatest } from '../lib/version';
import { useApp } from './store';

export interface AssetPackGateSlice {
  /** True only for the TWA client while pack UI applies; false again once a
   * deferred first page hides it (D-050: online play is never "waiting"). */
  required: boolean;
  state: AssetPackGateState;
  /** Bumped by RETRY; the transfer hook restarts on it. */
  attempt: number;
  retry: () => void;
}

export const useAssetPackGate = create<AssetPackGateSlice>((set) => ({
  required: false,
  state: { kind: 'not-required' },
  attempt: 0,
  retry: () => set((slice) => ({ attempt: slice.attempt + 1 })),
}));

// dev-only handle for preview-driven captures (mirrors window.__store / __bus):
// the loading strip's measured percent comes only from this slice.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __assetPackGate?: typeof useAssetPackGate }).__assetPackGate = useAssetPackGate;
}

/** Publish a gate state for a client that IS the TWA. `required` follows the
 * D-050 rule exactly: a `not-required` state hides pack UI entirely. */
export function publishAssetPackGate(state: AssetPackGateState): void {
  useAssetPackGate.setState({ state, required: state.kind !== 'not-required' });
}

/** The map now renders the animated fantasy globe/campaign on a canvas too.
 * Keep optional pack hashing away from their terrain and parcel downloads. */
const CANVAS_GAMEPLAY_SCREENS = new Set(['base', 'build', 'layout', 'battle', 'scout', 'map']);

export function assetPackTransferBlocked(screen: string, hidden: boolean): boolean {
  return hidden || CANVAS_GAMEPLAY_SCREENS.has(screen);
}

export interface AssetPackTransferOptions {
  build: string;
  publish?: (state: AssetPackGateState) => void;
  /** Test seams — production uses the real installer, document and worker. */
  ensure?: (environment: AssetPackEnvironment) => Promise<AssetPackManifest | null>;
  hidden?: () => boolean;
  subscribeHidden?: (listener: () => void) => () => void;
  serviceWorker?: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener' | 'removeEventListener'> | undefined;
  /** Returns true when a one-shot reload was issued for a deploy race. */
  reloadForBuildMismatch?: () => boolean;
}

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function subscribeDocumentHidden(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

function reloadOnceForBuildMismatch(build: string): boolean {
  // The deploy switched between this HTML and its manifest request. One
  // cache-preserving reload gets the matching shell; the session marker
  // prevents a bad CDN edge from turning that recovery into a loop.
  const key = `pkw:asset-pack-build-reload:${build}`;
  try {
    if (sessionStorage.getItem(key) === '1') return false;
    sessionStorage.setItem(key, '1');
    void reloadToLatest();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one gate attempt under the transfer discipline. Returns a disposer; the
 * caller (the App hook) re-invokes it per RETRY. Phases:
 *   boot → running ⇄ paused (abort + delayed resume) → done.
 */
export function startAssetPackTransfer(options: AssetPackTransferOptions): () => void {
  const ensure = options.ensure ?? ensureAssetPack;
  const publish = options.publish ?? publishAssetPackGate;
  const hidden = options.hidden ?? documentHidden;
  const subscribeHidden = options.subscribeHidden ?? subscribeDocumentHidden;
  const serviceWorker = options.serviceWorker
    ?? (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker);
  const reloadForBuildMismatch = options.reloadForBuildMismatch
    ?? (() => reloadOnceForBuildMismatch(options.build));

  let live = true;
  let phase: 'boot' | 'running' | 'paused' | 'done' = 'boot';
  let controller: AbortController | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let controllerChanged: (() => void) | null = null;
  const blocked = (): boolean => assetPackTransferBlocked(useApp.getState().screen, hidden());

  const clearResume = (): void => {
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
  };

  const run = (): void => {
    phase = 'running';
    const attempt = new AbortController();
    controller = attempt;
    publish({ kind: 'checking' });
    void ensure({
      build: options.build,
      signal: attempt.signal,
      onProgress: (next) => { if (live && controller === attempt) publish(next); },
    }).then((installed) => {
      if (!live || controller !== attempt) return;
      controller = null;
      phase = 'done';
      if (installed !== null) return;
      // clients.claim() is not guaranteed to control the page that registered
      // a worker. That is online mode, not a startup error. Hide pack UI and
      // retry once the exact build takes control; a new launch also retries.
      publish({ kind: 'not-required' });
      if (!serviceWorker) return;
      controllerChanged = () => {
        if (!live || !serviceWorkerControlsAssetPackBuild(serviceWorker.controller, options.build)) return;
        serviceWorker.removeEventListener('controllerchange', controllerChanged!);
        controllerChanged = null;
        useAssetPackGate.getState().retry();
      };
      serviceWorker.addEventListener('controllerchange', controllerChanged);
      // Close the tiny timeout-to-listener race without reloading the page.
      if (serviceWorkerControlsAssetPackBuild(serviceWorker.controller, options.build)) controllerChanged();
    }).catch((cause: unknown) => {
      if (!live || controller !== attempt) return;
      controller = null;
      if (cause instanceof AssetPackError && cause.code === 'aborted') {
        // A pause aborted us: `phase` is already 'paused' and the resume timer
        // (or the next unblocked input) restarts the missing-only transfer.
        return;
      }
      phase = 'done';
      if (cause instanceof AssetPackError && cause.code === 'build-mismatch' && reloadForBuildMismatch()) return;
      publish({
        kind: 'error',
        code: cause instanceof AssetPackError ? cause.code : 'network',
        message: assetPackErrorMessage(cause),
      });
    });
  };

  const pause = (): void => {
    clearResume();
    if (phase !== 'running') return;
    phase = 'paused';
    const aborting = controller;
    controller = null;
    aborting?.abort();
  };

  const resumeLater = (): void => {
    clearResume();
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      if (!live || phase !== 'paused' || blocked()) return;
      run();
    }, ASSET_PACK_TRANSFER.resumeDelayMs);
  };

  const onInputs = (): void => {
    if (!live || phase === 'boot' || phase === 'done') return;
    if (blocked()) pause();
    else if (phase === 'paused' && resumeTimer === null) resumeLater();
  };

  const onBootReady = (): void => {
    if (!live || phase !== 'boot') return;
    if (blocked()) phase = 'paused';
    else run();
  };

  const unsubscribeScreen = useApp.subscribe((state, previous) => {
    if (state.screen !== previous.screen) onInputs();
  });
  const unsubscribeHidden = subscribeHidden(onInputs);
  const unsubscribeBoot = bus.on('boot:ready', onBootReady);
  // `booted` is state, not an event, so a RETRY after boot cannot miss it.
  if (useApp.getState().booted) onBootReady();

  return () => {
    live = false;
    clearResume();
    unsubscribeScreen();
    unsubscribeHidden();
    unsubscribeBoot();
    controller?.abort();
    controller = null;
    if (controllerChanged && serviceWorker) serviceWorker.removeEventListener('controllerchange', controllerChanged);
    controllerChanged = null;
  };
}
