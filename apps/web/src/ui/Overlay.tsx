import { phaseEWebEnabled, phaseEScreenHeld } from './phaseEWebHold';
import { useUserCommand } from './pk/useUserCommand';
import type { Screen } from '../state/store';
import { supportedPlotVersion } from '../game/world/basePlot';
/**
 * React overlay: the 18-screen router over the Phaser canvas. Root never eats
 * pointer events; only `.interactive` children do. HUD values come from server
 * state exclusively (CLAUDE.md hard rule). Screens map 1:1 to the reference
 * App's view set; copy is verbatim, numbers from @shardkeep/shared / server.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ECONOMY, PLAYTEST, warePortraitAliasKey } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { useAuth } from '../auth/useAuth';
import { useGameEntryState, type GameEntryResult } from '../auth/gameEntry';
import { authCookies } from '../auth/authCookieCoordinator';
import { AuthChangedError, AuthCoordinationError } from '../auth/authCookieCoordinatorCore';
import { captureError, EVENTS, track } from '../lib/analytics';
import { isSolanaMobileClient } from '../lib/mobileShell';
import { readGameViewport, readGameUiViewport, subscribeGameViewport } from '../lib/gameViewport';
import { useSocialAuth } from '../auth/useSocialAuth';
import { useSignOut } from '../auth/useSignOut';
import { useWalletSessionFence } from '../auth/useWalletSessionFence';
import { useOptionalReferral } from '../auth/useOptionalReferral';
import { useDevnetFaucet } from '../auth/useDevnetFaucet';
import {
  api, ApiError, baseSelectorAvailable, baseStatePath, isAlphaGated,
  isBaseClientUpgradeRequired, isBaseSelectionError, isLandNotOwned, resolveFreshBaseId,
  setAlphaGatedHandler, setBaseSelectionInvalidHandler, setLandGatedHandler,
  setUnauthorizedHandler, type BasesDto,
} from '../lib/api';
import { versionedPublicAsset } from '../lib/version';
import { SOLANA_CLUSTER } from '../lib/cluster';
import { selectedBasePath, withSelectedBase } from '../lib/baseSelection';
import { playSfx } from '../lib/audio';
import { bus } from '../lib/events';
import { divineBattleSession } from '../lib/divineTrials/battleSession';
import { PhaseEBattleHost } from './phaseE/PhaseEBattleHost';
import { clearStoredReferralCode, readStoredReferralCode } from '../lib/referral';
import {
  browserRaidResumeStorage, installRaidRecoveryLifecycle, reconcileRaidResume,
  reconcileRaidResumeSingleFlight, type RaidRecoveryTarget,
} from '../lib/raidResume';
import { suspendPushSession } from '../lib/pushSubscription';
import { BaseSnapshotMismatchError, hydrateBaseSnapshot } from '../state/baseSnapshot';
import { useAssetPackGate } from '../state/assetPackGate';
import { baseAuthorityRequestScope, recoverBaseAuthority } from '../state/baseAuthorityRecovery';
import { baseAutoRefetchDelay } from './baseAutoRefetch';
import {
  announceDefences, readDefencesSeen, shieldChipView, unreadDefences,
} from './baseDefences';
import {
  captureBaseSnapshotGuard, clearBaseSnapshot, isBaseSnapshotGuardCurrent,
  readDeviceSelectedBaseId, useApp, type BaseSnapshotGuard, type RaidTarget,
} from '../state/store';
import { ConnectSheet } from './ConnectSheet';
import { BrandImage } from './BrandImage';
import { LandGateSheet, NoLandPrompt } from './LandGate';
import { RaidChooser } from './RaidChooser';
import { ScoutHud } from './ScoutHud';
import {
  BarMini, Btn, COLORS as C, fmtDur, fmtN, Icon, Panel9, Phead, Pill, PillSub, PillVal, Sprite, Toast,
} from './primitives';
import {
  baseCameraInsets, CHROME, hudAttention, hudBarPlan, hudHeight, hudOverflowAlert,
  hudTier, tutorialSurfaceInsets, usePortrait,
  useSafeAreaInsets, useWindowSize,
} from './layout';
import {
  HudChip, HudChromeStyle, HudNavButton, HudPlayerMenuButton, HudQueueSummary,
  hudBarRowStyle, hudBarStyle, hudDeckStyle, hudStripStyle, useHudFlash, useHudRoll,
} from './hudChrome';
import { HudOverflowPanel } from './hudOverflow';
import { useMobileBackHandler } from '../lib/mobileBackGuard';
import { GameLoading } from './loading/GameLoading';
import { LoadingStage } from './loading/LoadingStage';
import { useFetch } from './useFetch';
import { useMineStatus } from './useMineStatus';
import { useIsAdmin } from './screens/adminAccess';
import { SeekerDoor } from './screens/seeker';
import type { SeekerStatus } from '../auth/useSeekerLink';
import { useSolBalance } from './useSolBalance';
import {
  BaseRaidInterlockView, deedActionsAllowed, raidInterlockVisible, useActiveBaseRaid,
} from './BaseRaidInterlock';
import { ChatLauncher } from './chat/ChatLauncher';
import type { SheetInset } from './pk/p2Types';
import { mergeBasePanelInsets, usePanelInset } from './pk/panelInsets';
import { LeagueChip, leagueChipAriaLabel } from './screens/leagueChip';
import { leagueRailLabel } from './screens/leagueTier';

// Fetch the battle controller after first paint, like Phaser. Keep it mounted
// once loaded so raid recovery and HOME cleanup retain their existing lifecycle.
const RaidUI = lazy(() => import('./RaidUI').then((m) => ({ default: m.RaidUI })));

// Checkout and its payment recovery hooks are needed only after navigation.
// Keep them off the loading/title graph, like the other destination screens.
const EntryScreen = lazy(() => import('./land/EntryScreen').then((m) => ({ default: m.EntryScreen })));
const TutorialHost = lazy(() => import('./tutorial/TutorialHost').then((m) => ({ default: m.TutorialHost })));
const OverlayHost = lazy(() => import('./pk/OverlayHost').then((m) => ({ default: m.OverlayHost })));
const ActionSheet = lazy(() => import('./sheets').then((m) => ({ default: m.ActionSheet })));
const ObstacleSheet = lazy(() => import('./sheets').then((m) => ({ default: m.ObstacleSheet })));
const BuildTray = lazy(() => import('./sheets').then((m) => ({ default: m.BuildTray })));
const CodexScreen = lazy(() => import('./screens/codex'));
const InventoryScreen = lazy(() => import('./screens/inventory'));
// The roster, its Codex troop copy and the training trays are one chunk the
// camp sheet already loads on demand; a static import here would drag all of
// it into first paint (Overlay.lazyScreens.test.ts pins this boundary).
const ArmyScreen = lazy(() => import('./screens/army').then((m) => ({ default: m.ArmyScreen })));
const BasesScreen = lazy(() => import('./screens/bases'));
const AdminScreen = lazy(() => import('./screens/admin'));
const MapScreen = lazy(() => import('./screens/map').then((m) => ({ default: m.MapScreen })));
const RaidLogScreen = lazy(() => import('./screens/raidlog').then((m) => ({ default: m.RaidLogScreen })));
const ShopScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ShopScreen })));
const QuestsScreen = lazy(() => import('./screens/quests').then((m) => ({ default: m.QuestsScreen })));
const ClaimScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ClaimScreen })));
const ExchangeScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ExchangeScreen })));
const WithdrawScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.WithdrawScreen })));
const DepositScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.DepositScreen })));
const EconomyScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.EconomyScreen })));
const ForgeScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ForgeScreen })));
const MarketScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.MarketScreen })));
const SecurityScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.SecurityScreen })));
const ClansScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ClansScreen })));
const BuildersScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.BuildersScreen })));
const ExpandScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ExpandScreen })));
const LayoutScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.LayoutScreen })));
const ProfileScreen = lazy(() => import('./screens/menu').then((m) => ({ default: m.ProfileScreen })));
const MailScreen = lazy(() => import('./screens/mail'));
const TesterScreen = lazy(() => import('./screens/tester'));
const LeaguesScreen = lazy(() => import('./screens/leagues'));
const WorkshopScreen = lazy(() => import('./WorkshopScreen').then(m => ({ default: m.WorkshopScreen })));
const WorkshopDoor = lazy(() => import('./WorkshopDoor').then(m => ({ default: m.WorkshopDoor })));
const PhaseERegistration = lazy(() => import('./phaseE/PhaseERegistration').then(m => ({ default: m.PhaseERegistration })));
const HeroProgressionProvider = lazy(() => import('./HeroProgression').then(m => ({ default: m.HeroProgressionProvider })));
const ResearchSpeedupProvider = lazy(() => import('./ResearchSpeedup').then(m => ({ default: m.ResearchSpeedupProvider })));
const BuilderJobSpeedupProvider = lazy(() => import('./BuilderJobSpeedup').then(m => ({ default: m.BuilderJobSpeedupProvider })));
const TrainingFinishProvider = lazy(() => import('./TrainingFinish').then(m => ({ default: m.TrainingFinishProvider })));

// brand art shipped in public/ (served at runtime)
const BRAND_BG_PORTRAIT = versionedPublicAsset('/brand/brand_title_bg_portrait.png');
const BRAND_BG_LANDSCAPE = versionedPublicAsset('/brand/brand_title_bg_landscape.png');
/** Wave-2 owner lockup. Its native 844:588 ratio must remain 211:147. */
const BRAND_LOGO_MAIN = versionedPublicAsset('/brand/brand_logo_main.png');

/** Full-cover brand backdrop that picks the LANDSCAPE vs PORTRAIT key art by
 *  viewport orientation (owner 2026-07-20: the portrait art cropped badly on
 *  wide/PC screens). Re-evaluates on resize/rotate — through the shared
 *  usePortrait, which had its own near-copy here; two orientation rules meant
 *  the key art could flip a beat before or after the chrome. */
function BrandBg({ filter }: { filter?: string }): React.JSX.Element {
  const port = usePortrait();
  return (
    <BrandImage
      src={port ? BRAND_BG_PORTRAIT : BRAND_BG_LANDSCAPE}
      alt=""
      loading="eager"
      decoding="sync"
      fetchPriority="high"
      style={{
        // Backdrops paint behind the native-toolbar clearance too. Fixed
        // positioning escapes the smaller control frame's overflow clip.
        position: 'fixed', inset: 0, width: '100%', height: 'var(--game-viewport-frame-height, 100dvh)',
        objectFit: 'cover', imageRendering: 'pixelated', ...(filter ? { filter } : {}),
      }}
    />
  );
}

/**
 * Auto-refetch /base the moment the soonest active timer completes, so a build /
 * upgrade / obstacle-clear job, expiring shield, or hero recovery updates without
 * a manual reload (the server completes jobs lazily on the next /base read).
 * Robust to client-clock skew: an elapsed job or still-unavailable hero triggers
 * a short retry rather than leaving stale world art at 0:00.
 */
export function useBaseAutoRefetch(
  refresh: () => Promise<boolean> = loadServerState,
): void {
  const base = useApp((s) => s.base);
  useEffect(() => {
    if (!base) return;
    let live = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (snapshot: typeof base): void => {
      if (!live) return;
      const delay = baseAutoRefetchDelay(snapshot, Date.now());
      if (delay === null) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!live || inFlight) return;
        inFlight = true;
        const guard = captureBaseSnapshotGuard();
        void refresh()
          .then((selected) => {
            // Committing the snapshot cleans up this effect. Its liveness only
            // owns timers, not the notification that quests must refresh.
            if (selected && isBaseSnapshotGuardCurrent(guard)) bus.emit('base:refresh', undefined);
            if (!live) return;
            // Normally refresh replaces the Zustand snapshot and React re-runs
            // this effect. Scheduling here too covers an unchanged/equal result;
            // the effect cleanup clears this timer before installing its own.
            const next = useApp.getState().base;
            if (next) schedule(next);
          })
          .catch((cause: unknown) => {
            if (!live) return;
            if (!isBaseSelectionError(cause)) {
              bus.emit('ui:toast', { msg: 'BASE REFRESH FAILED — RETRYING' });
            }
            // Recompute from the same authoritative snapshot at the new clock.
            // Elapsed deadlines retry quickly; a phase heartbeat remains bounded
            // to its shared cadence. No timer is armed while refresh is pending.
            schedule(base);
          })
          .finally(() => { inFlight = false; });
      }, delay);
    };

    schedule(base);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [base, refresh]);
}

// 188719c1: Trials stays in its kingdom modal; this union is retained for frozen consumer compatibility.
export type MapFeatureId = 'map.divineTrials' | 'map.divineFragments';
/** Structurally shared with W7's controlled MapScreen props; never persisted. */
export interface MapFeatureDestination {
  featureId: MapFeatureId; wallet: string; baseId: string | null; epoch: number; generation: number;
}

export function Overlay(): React.JSX.Element {
  useWalletSessionFence();
  useOptionalReferral();
  const wallet = useApp((s) => s.wallet);
  const authed = useApp((s) => s.authed);
  const requestedScreen = useApp((s) => s.screen);
  // Sanitize before first paint; retire the retained route in the store as well.
  const screen = phaseEScreenHeld(requestedScreen) ? 'base' : requestedScreen;
  useEffect(() => {
    const current = useApp.getState();
    if (phaseEScreenHeld(current.screen)) current.setScreen('base');
  }, [requestedScreen]);
  const inBase = screen === 'base' || screen === 'build';
  const [panelInset, setPanelInset] = usePanelInset();
  const baseDirectory = useApp((s) => s.baseDirectory);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const mapTab = useApp(s => s.mapTab), epoch = useApp(s => s.baseSelectionEpoch);
  const webEnabled = phaseEWebEnabled();
  const [mapDestination, setMapDestination] = useState<MapFeatureDestination | null>(null);
  const mapTarget = useRef<MapFeatureDestination | null>(null), mapGeneration = useRef(0);
  const requestMapFeature = useUserCommand(() => {
    const live = useApp.getState(); return phaseEWebEnabled() && live.authed && live.wallet !== null;
  });
  const retireMapFeature = useCallback((expectedGeneration?: number): void => {
    const target = mapTarget.current;
    if (!target || expectedGeneration !== undefined && target.generation !== expectedGeneration) return;
    mapTarget.current = null; ++mapGeneration.current; setMapDestination(null);
  }, []);
  useEffect(() => {
    // Retire synchronously on store transitions, including leave-and-return
    // within one React batch. A cached callback can never resurrect a target.
    const off = useApp.subscribe((next, prior) => {
      if (next.wallet !== prior.wallet || next.authed !== prior.authed
        || next.selectedBaseId !== prior.selectedBaseId || next.baseSelectionEpoch !== prior.baseSelectionEpoch
        || next.screen !== prior.screen || next.mapTab !== prior.mapTab) {
        ++mapGeneration.current;
        if (mapTarget.current) { mapTarget.current = null; setMapDestination(null); }
      }
    });
    return () => { off(); ++mapGeneration.current; mapTarget.current = null; };
  }, []);
  useEffect(() => { if (!webEnabled) retireMapFeature(); }, [webEnabled, retireMapFeature]);
  const onOpenMapFeature = useCallback((featureId: MapFeatureId): void => {
    const before = useApp.getState(), sourceWallet = before.wallet, generation = mapGeneration.current;
    if (!sourceWallet || !before.authed || !phaseEWebEnabled()
      || !['base', 'build', 'bases'].includes(before.screen)
      || featureId !== 'map.divineFragments') return;
    requestMapFeature(() => {
      // One admitted synchronous command owns navigation and the local target.
      const live = useApp.getState(); live.setMapTab('world'); live.setScreen('map');
      const target: MapFeatureDestination = { featureId, wallet: sourceWallet, baseId: before.selectedBaseId,
        epoch: before.baseSelectionEpoch, generation: ++mapGeneration.current };
      mapTarget.current = target; setMapDestination(target);
    }, () => {
      const live = useApp.getState();
      return phaseEWebEnabled() && live.authed && live.wallet === sourceWallet
        && live.selectedBaseId === before.selectedBaseId && live.baseSelectionEpoch === before.baseSelectionEpoch
        && live.screen === before.screen && live.mapTab === before.mapTab && mapGeneration.current === generation;
    });
  }, [requestMapFeature]);
  const liveMapDestination = webEnabled && authed && screen === 'map' && mapTab === 'world'
    && mapDestination && mapTarget.current === mapDestination && mapDestination.generation === mapGeneration.current
    && mapDestination.wallet === wallet && mapDestination.baseId === selectedBaseId && mapDestination.epoch === epoch
    ? mapDestination : null;
  const baseMutationsEnabled = !baseSelectorAvailable(baseDirectory)
    || baseDirectory!.capabilities.baseScopedMutations;
  const stableBaseMode = baseSelectorAvailable(baseDirectory)
    && baseDirectory!.capabilities.baseScopedMutations;
  const activeBaseRaid = useActiveBaseRaid(selectedBaseId, stableBaseMode);
  const plotVersion = useApp((s) => s.base?.plotVersion);
  const baseActionsEnabled = supportedPlotVersion(plotVersion)
    && deedActionsAllowed(baseMutationsEnabled, activeBaseRaid);
  const showRaidInterlock = raidInterlockVisible(screen, activeBaseRaid, selectedBaseId);
  useBaseAutoRefetch();
  useEffect(() => installRaidRecoveryLifecycle({
    win: window,
    doc: document,
    reconcile: () => {
      const before = useApp.getState();
      const beforeBaseId = before.selectedBaseId ?? before.base?.baseId ?? null;
      if (!before.authed || !before.base || !before.wallet || !beforeBaseId) return;
      void raidRecoveryDestination().then((destination) => {
        if (!destination) return;
        const state = useApp.getState();
        if (!state.authed || state.wallet !== before.wallet
          || !isBaseSnapshotGuardCurrent(destination.guard)) return;
        if (state.screen !== destination.screen) state.setScreen(destination.screen);
      }).catch(() => {
        // Lifecycle probes are retry signals. The durable pointer and the
        // currently rendered screen remain intact until a canonical read wins.
      });
    },
  }), []);
  // Recover an expired session mid-play: any 401 while authed clears auth and
  // routes to the title for a fresh sign-in (the restore's expected /me 401
  // fires while NOT authed, so it's ignored here).
  useEffect(() => {
    setUnauthorizedHandler(() => {
      const s = useApp.getState();
      if (!s.authed) return;
      track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'signed_out', reason: 'session_expired' });
      // The cookie is already expired, so server retirement may 401; browser
      // unsubscribe + the durable SW suspension fence still stop delivery.
      void suspendPushSession();
      s.setAuth(null);
      s.setScreen('title');
      bus.emit('ui:toast', { msg: 'SESSION EXPIRED — SIGN IN AGAIN' });
    });
  }, []);
  // Closed-alpha 403 (ALPHA_GATED) → the invite-code panel. Registered globally
  // because the gate can fire from many places — the first authed request after
  // sign-in, the /me session restore, or ANY authed request after the owner
  // revokes a wallet mid-play — and each must land on the panel that explains the state,
  // not a screen-specific error toast.
  useEffect(() => {
    setAlphaGatedHandler(() => {
      const s = useApp.getState();
      if (s.screen !== 'alphagate') s.setScreen('alphagate');
    });
  }, []);
  // Land gate 402 (LAND_NOT_OWNED) → the buy-land sheet, registered globally for
  // the same reason as ALPHA_GATED: the gate now fronts the Forge, market
  // selling, PvP raids, PvE bounties, clans and withdrawals, so the refusal
  // arrives from a dozen screens a deedless player can legitimately open.
  //
  // It OFFERS rather than routes. Unlike the alpha gate, this player has a real,
  // playable base to be standing on — yanking them to a full-screen paywall
  // because they tapped the shard pill would make the free tier feel like a
  // trial. It is also NOT raised while they are still on the title/entry flow,
  // where the entry screen already IS the answer.
  useEffect(() => {
    setLandGatedHandler(() => {
      const s = useApp.getState();
      if (s.screen === 'entry' || s.screen === 'title' || s.screen === 'loading') return;
      if (s.landPrompt === null) s.setLandPrompt('refused');
    });
  }, []);
  useEffect(() => {
    setBaseSelectionInvalidHandler(recoverBaseAuthority, baseAuthorityRequestScope);
  }, []);
  return (
    <div id="overlay-root">
      {screen === 'loading' && <LoadingScreen />}
      {screen === 'title' && <TitleScreen />}
      {screen === 'entry' && (
        <Suspense fallback={<>
          <BrandBg filter="brightness(.45)" />
          <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: C.gold }}>
            Opening your land…
          </div>
        </>}>
          <EntryScreen key={wallet} enterGame={enterGame} FaucetControl={DevnetSolClaim} faucetView={devnetSolClaimView} />
        </Suspense>
      )}
      {screen === 'alphagate' && <AlphaGateScreen />}
      {inBase && <BaseHud baseActionsEnabled={baseActionsEnabled} panelInset={panelInset} />}
      <Suspense fallback={null}>
        {authed ? <BuilderJobSpeedupProvider actionsEnabled={baseActionsEnabled}><TrainingFinishProvider actionsEnabled={baseActionsEnabled}><ResearchSpeedupProvider actionsEnabled={baseActionsEnabled}><HeroProgressionProvider actionsEnabled={baseActionsEnabled}>
        {inBase && <OverlayHost baseActionsEnabled={baseActionsEnabled} onInset={setPanelInset}>
          {baseActionsEnabled && <ActionSheet />}
          {baseActionsEnabled && <ObstacleSheet />}
        </OverlayHost>}
        <BuildTray actionsEnabled={baseActionsEnabled} />
        </HeroProgressionProvider>
        {screen === 'army' && <ArmyScreen />}
        {screen === 'bases' && <BasesScreen />}
        </ResearchSpeedupProvider></TrainingFinishProvider></BuilderJobSpeedupProvider> : <>
          {inBase && <OverlayHost baseActionsEnabled={baseActionsEnabled} onInset={setPanelInset}>
            {baseActionsEnabled && <ActionSheet />}
            {baseActionsEnabled && <ObstacleSheet />}
          </OverlayHost>}
        </>}
      </Suspense>
      {inBase && <PlaytestWelcome />}
      {phaseEWebEnabled() && inBase && authed && <Suspense fallback={null}><WorkshopDoor floating /></Suspense>}
      {phaseEWebEnabled() && <Suspense fallback={null}><PhaseERegistration screen={screen} inBase={inBase} authed={authed} actionsEnabled={baseActionsEnabled} onOpenMapFeature={onOpenMapFeature} /></Suspense>}

      <Suspense fallback={null}>
      {screen === 'shop' && <ShopScreen />}
      {screen === 'inventory' && (
        <InventoryScreen />
      )}
      {!authed && screen === 'army' && <ArmyScreen />}
      {!authed && screen === 'bases' && <BasesScreen />}
      {screen === 'codex' && (
        <CodexScreen />
      )}
      {screen === 'quests' && <QuestsScreen />}
      {screen === 'claim' && <ClaimScreen />}
      {screen === 'exchange' && <ExchangeScreen />}
      {screen === 'withdraw' && <WithdrawScreen />}
      {screen === 'deposit' && <DepositScreen />}
      {screen === 'economy' && <EconomyScreen />}
      {screen === 'forge' && <ForgeScreen />}
      {screen === 'workshop' && <WorkshopScreen actionsEnabled={baseActionsEnabled} />}
      {screen === 'market' && <MarketScreen />}
      {screen === 'security' && <SecurityScreen />}
      {screen === 'clans' && <ClansScreen />}
      {screen === 'builders' && <BuildersScreen />}
      {screen === 'expand' && <ExpandScreen />}
      {screen === 'layout' && <LayoutScreen />}
      {screen === 'profile' && <ProfileScreen />}
      {screen === 'mail' && <MailScreen />}
      {screen === 'tester' && <TesterScreen />}
      {screen === 'leagues' && <LeaguesScreen />}
      {screen === 'map' && <MapScreen actionsEnabled={baseActionsEnabled} destination={liveMapDestination} onClose={() => { if (mapDestination) retireMapFeature(mapDestination.generation); }} />}
      {screen === 'raidlog' && <RaidLogScreen />}
      {screen === 'admin' && <AdminScreen />}
      </Suspense>

      {/* battle / victory / defeat are driven by RaidUI (deploy → play → result) */}
      {/* Forced authority/auth exits must retire raid-local state and timers too. */}
      <Suspense fallback={null}><PhaseEBattleHost actionsEnabled={baseActionsEnabled} ordinary={<RaidUI key={screen === 'battle' ? 'battle' : 'idle'} />} /></Suspense>
      {/* scout preview: the base renders in the battle canvas, ScoutHud floats over it */}
      {screen === 'scout' && <ScoutHud />}

      {/* Capability-gated chat is available on base/build only. Map scenes
          retire both the launcher and any open mobile chat surface. */}
      <ChatLauncher />

      {/* Guidance starts after authentication and stays mounted across its
          base, training, land and map destinations. */}
      {authed && <Suspense fallback={null}><TutorialHost /></Suspense>}

      {showRaidInterlock && activeBaseRaid && selectedBaseId && (
        <BaseRaidInterlockView
          raid={activeBaseRaid}
          onWatch={() => {
            useApp.getState().setRaidTarget({
              kind: 'live', raidId: activeBaseRaid.raidId, replayBaseId: selectedBaseId,
            });
            useApp.getState().setScreen('battle');
          }}
          onHistory={() => useApp.getState().setScreen('raidlog')}
          onSwitchBase={() => useApp.getState().setScreen('bases')}
        />
      )}

      {/* Buy-land sheet — outside the screen switch on purpose: a land refusal
          can arrive on any of them. */}
      <LandGateHost />
      <ToastHost />
    </div>
  );
}

// ===========================================================================
// LOADING — rotating gameplay advice + exact progress / restore state
// ===========================================================================

const SESSION_RESTORE_REVEAL_MS = 4_000;
const SESSION_HYDRATION_TIMEOUT_MS = 15_000;
type SessionRestoreState = 'pending' | 'checking-retry' | 'hydrating' | 'retry' | 'restored' | 'anon';
type SessionRestoreFailure = { reason: 'timeout' | 'changed' | 'request'; stage: 'base_snapshot' | 'raid_recovery' };
type SessionCheckFailure = 'timeout' | 'changed' | 'storage' | 'browser' | 'request';

export function LoadingScreen(): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const setAuth = useApp((s) => s.setAuth);
  const booted = useApp((s) => s.booted);
  const reduceMotion = useApp((s) => s.reduceMotion);
  // The Solana Mobile pack slice (D-101): subscribed HERE, not passed down, so
  // a progress tick re-renders this screen and nothing above it.
  const packState = useAssetPackGate((s) => (s.required ? s.state : null));
  const retryPack = useAssetPackGate((s) => s.retry);
  // A timer cannot measure downloaded and decoded artwork. Keep unknown
  // progress indeterminate; file counts include local decode and preparation.
  // GET /me and authenticated game-state hydration are separate phases. A
  // definite anonymous result may reveal the title; a known authenticated
  // session stays on this tip-led screen and offers a local hydration retry.
  const [restore, setRestore] = useState<SessionRestoreState>('pending');
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [restoreFailure, setRestoreFailure] = useState<SessionRestoreFailure | null>(null);
  const [sessionFailure, setSessionFailure] = useState<SessionCheckFailure | null>(null);
  const restoreGuard = useRef<BaseSnapshotGuard | null>(null);
  const restoreTarget = useRef<'base' | 'battle' | 'raidlog' | 'bases' | 'entry'>('base');
  // Loading shows different art from the title. Warm the title backdrop now so
  // a signed-out handoff does not paint the flat fill while it downloads.
  const port = usePortrait();
  useEffect(() => {
    new Image().src = port ? BRAND_BG_PORTRAIT : BRAND_BG_LANDSCAPE;
  }, [port]);


  // Restore the session from the httpOnly cookie so a page reload does NOT force
  // a re-connect + re-sign (the cookie is valid for days). GET /me authenticates
  // via the cookie; if valid, preload game state now and route straight into the
  // game once Phaser has booted (402 → the entry paywall, server-authoritative).
  useEffect(() => {
    let live = true;
    let deadlineHit = false;
    const started = performance.now();
    setSessionFailure(null);
    track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'checking' });
    const controller = new AbortController();
    const revealTimer = setTimeout(() => {
      if (!live) return;
      deadlineHit = true;
      controller.abort();
      setSessionFailure('timeout');
      setRestore('checking-retry');
      track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'retry', reason: 'timeout', elapsed_ms: Math.round(performance.now() - started) });
    }, SESSION_RESTORE_REVEAL_MS);
    void api.get<{ wallet: string; entryPaid: boolean }>('/me', { signal: controller.signal })
      .then((me) => {
        if (!live || deadlineHit) return;
        // This deadline guards only the anonymous session probe. Once
        // /me has answered, do not fire it midway through authenticated state
        // hydration after setAuth has intentionally established the session.
        clearTimeout(revealTimer);
        setAuth(me.wallet, me.entryPaid);
        restoreGuard.current = captureBaseSnapshotGuard();
        track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'accepted' });
        setRestore('hydrating');
      })
      .catch((e: unknown) => {
        if (!live || deadlineHit) return;
        // Closed-alpha 403: a VALID session whose wallet was gated/revoked. The
        // global ALPHA_GATED handler already routed to the invite panel — do not
        // fall through to 'anon', whose navigation effect would clobber it with TITLE.
        if (isAlphaGated(e)) return;
        if (isBaseSelectionError(e)) {
          restoreTarget.current = 'bases';
          setRestore('restored');
          return;
        }
        // Only a definite 401 proves there is no reusable session. A slow or
        // offline probe must never manufacture another wallet approval.
        setRestore(e instanceof ApiError && e.status === 401 ? 'anon' : 'checking-retry');
        const reason = e instanceof AuthCoordinationError ? e.reason : e instanceof AuthChangedError ? 'changed' : 'request';
        setSessionFailure(reason);
        track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: e instanceof ApiError && e.status === 401 ? 'signed_out' : 'retry',
          reason, elapsed_ms: Math.round(performance.now() - started), ...(e instanceof ApiError ? { status: e.status } : {}) });
      })
      .finally(() => clearTimeout(revealTimer));
    return () => {
      live = false;
      clearTimeout(revealTimer);
      controller.abort();
    };
  }, [setAuth, restoreAttempt]);

  // A valid cookie is already authenticated. Hydration therefore retries in
  // place instead of clearing auth and mounting TitleScreen, which would ask a
  // known player to sign in again after an ordinary slow-network timeout.
  // Boot has its own bounded artwork recovery and does not require base state.
  // Finish that network/decode phase before starting the game-state deadline:
  // a new generation's atlas work must not spend the player's sync budget.
  useEffect(() => {
    if (restore !== 'hydrating' || !booted) return;
    let live = true;
    let stage: SessionRestoreFailure['stage'] = 'base_snapshot';
    const started = performance.now();
    setRestoreFailure(null);
    const pause = (reason: SessionRestoreFailure['reason'], error?: unknown): void => {
      setRestoreFailure({ reason, stage });
      track(EVENTS.AUTH_SESSION_PHASE, { operation: 'game', phase: 'retry', reason, stage,
        elapsed_ms: Math.round(performance.now() - started), booted,
        ...(error instanceof ApiError ? { status: error.status, code: error.code ?? 'HTTP_ERROR' } : {}) });
      // Use fixed classifications, never response bodies, wallet/base IDs, or
      // arbitrary exception text. This distinguishes cold-load failures even
      // after the short toast has disappeared.
      captureError('error', { name: 'GameRestoreError', message: `Game restore paused: ${reason} (${stage})`,
        source: 'session-hydration', boundary: 'game', screen: 'loading',
        diagnostics: { restoreReason: reason, restoreStage: stage,
          ...(error instanceof ApiError ? { httpStatus: error.status } : {}) } });
      setRestore('retry');
    };
    // Authentication or selection can change while artwork is still loading.
    if (!restoreGuard.current || !isBaseSnapshotGuardCurrent(restoreGuard.current)) {
      pause('changed');
      return;
    }
    const controller = new AbortController();
    // Mobile browsers may suspend fetch callbacks in a hidden tab. Preserve
    // one 15s foreground allowance across base and raid reads; returning to the
    // page never resets it and never retries a request or changes a raid clock.
    let remainingMs = SESSION_HYDRATION_TIMEOUT_MS;
    let activeSince: number | null = null;
    let hydrationTimer: ReturnType<typeof setTimeout> | null = null;
    const armHydrationDeadline = (): void => {
      if (hydrationTimer !== null) clearTimeout(hydrationTimer);
      hydrationTimer = null;
      if (!live || controller.signal.aborted) return;
      const now = performance.now();
      if (activeSince !== null) remainingMs = Math.max(0, remainingMs - (now - activeSince));
      activeSince = null;
      if (document.visibilityState !== 'visible') return;
      if (remainingMs === 0) {
        controller.abort();
        bus.emit('ui:toast', { msg: 'Loading took too long. Please try again.' });
        pause('timeout');
        return;
      }
      activeSince = now;
      hydrationTimer = setTimeout(armHydrationDeadline, remainingMs);
    };
    const stopHydrationDeadline = (): void => {
      if (hydrationTimer !== null) clearTimeout(hydrationTimer);
      hydrationTimer = null;
      document.removeEventListener('visibilitychange', armHydrationDeadline);
    };
    document.addEventListener('visibilitychange', armHydrationDeadline);
    armHydrationDeadline();

    void loadServerState(controller.signal)
      .then(async (selected) => {
        if (!live || controller.signal.aborted) return;
        // The restore deadline covers raid discovery too. Loading a base does
        // not make a stalled recovery request or changed selection safe to
        // leave on an unbounded loading screen.
        const hydratedGuard = captureBaseSnapshotGuard();
        stage = 'raid_recovery';
        const recovered = selected ? await raidRecoveryDestination(controller.signal) : null;
        if (!live || controller.signal.aborted) return;
        if (!isBaseSnapshotGuardCurrent(recovered?.guard ?? hydratedGuard)) {
          pause('changed');
          return;
        }
        restoreTarget.current = selected ? (recovered?.screen ?? 'base') : 'bases';
        setRestore('restored');
      })
      .catch((e: unknown) => {
        if (!live || controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 402) {
          useApp.getState().setEntryPaid(false);
          restoreTarget.current = 'entry';
          setRestore('restored');
          return;
        }
        // These handlers already chose a specific authenticated destination.
        if (isAlphaGated(e)) return;
        if (isBaseSelectionError(e)) {
          restoreTarget.current = 'bases';
          setRestore('restored');
          return;
        }
        bus.emit('ui:toast', { msg: 'Couldn’t load your kingdom. Please try again.' });
        pause(e instanceof AuthChangedError ? 'changed' : 'request', e);
      })
      .finally(stopHydrationDeadline);

    return () => {
      live = false;
      stopHydrationDeadline();
      controller.abort();
    };
  }, [booted, restore]);

  const packPct = packState?.kind === 'downloading' && packState.totalBytes > 0
    ? Math.floor((packState.downloadedBytes * 100) / packState.totalBytes) : null;
  // Completed art does not mean the independent account sync has completed.
  const waitingForAccount = booted && (restore === 'pending' || restore === 'hydrating');
  const displayPct = waitingForAccount ? null : packPct;
  const msg = restore === 'checking-retry' || restore === 'retry' ? 'Couldn’t load your kingdom'
    : waitingForAccount ? 'Opening your kingdom…'
      : 'Opening your kingdom…';
  // Leave loading as soon as session restore resolves. The verified offline
  // pack is a background optimization: a clean Solana Mobile install must not
  // download ~189 MB before CONNECT WALLET or social sign-in becomes usable.
  //
  // `booted` is required ONLY for the branch that drops into a live scene —
  // never drop into an unbooted one. It is deliberately NOT required for the
  // title screen, which is plain React and needs no canvas.
  //
  // That distinction is the whole point. `booted` flips in BootScene.create(),
  // which runs after Phaser preloads ten @2x atlases — ~4.5 MB — so gating the
  // TITLE on it meant a first-time player downloaded the entire art pack before
  // "CONNECT WALLET" appeared, on a screen that renders none of it. It also made
  // lazy-loading the canvas impossible: the loading screen would wait for a
  // `booted` that could never arrive, because the thing that sets it had not
  // been imported yet.
  useEffect(() => {
    if (restore === 'restored') {
      if ((restoreTarget.current === 'base' || restoreTarget.current === 'battle') && !booted) return;
      setScreen(restoreTarget.current);
      if (restoreTarget.current === 'base') bus.emit('base:refresh', undefined);
    } else if (restore === 'anon') {
      setScreen('title'); // React only; no canvas needed
    }
  }, [booted, restore, setScreen]);

  // One strip for every state (D-193): a restore failure owns the tip line and
  // the TRY AGAIN at the right; a paused optional pack download takes it only
  // while the restore itself is not failed (the pack never gates play, D-050).
  const restoreFailed = restore === 'retry' || restore === 'checking-retry';
  const failureCopy = restore === 'checking-retry'
    ? (sessionFailure === 'storage'
      ? 'Allow site data for this game, then reopen it.'
      : sessionFailure === 'browser'
        ? 'Update your browser, then reopen the game.'
        : sessionFailure === 'changed'
          ? 'Finish signing in in your other game window, then try again.'
          : sessionFailure === 'timeout'
            ? 'Loading took too long. Please try again.'
            : 'Check your connection and try again.')
    : restore === 'retry'
      ? (restoreFailure?.reason === 'timeout'
        ? 'Loading took too long. Please try again.'
        : restoreFailure?.reason === 'changed'
          ? 'Your account or base changed. Try again to continue.'
          : 'Check your connection and try again.')
      : null;
  const packPaused = !restoreFailed && packState?.kind === 'error'
    ? (packState.code === 'quota' ? 'Free up space on your device, then try again.' : 'Download paused. Please try again.')
    : null;
  return (
    <div className="interactive" data-restore-phase={restore}
      data-restore-failure={restoreFailure?.reason} data-restore-stage={restoreFailure?.stage}
      style={{ position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden' }}>
      {/* The bright portrait/landscape loading key art fills the screen behind
          the bottom strip (owner 2026-09-24: the dimmed title art made loading
          too dark; teammate 2026-09-28: players should enjoy the view while the
          game loads). The rejected part of the old loader was its logo lockup,
          not this art. The handout's board.png remains a stale screenshot and
          is never used. */}
      <LoadingStage>
        <GameLoading title={msg} transferPercent={displayPct} reduceMotion={reduceMotion} tips
          failed={restoreFailed} detail={failureCopy ?? packPaused ?? undefined}>
          {restore === 'checking-retry' && (
            <button type="button" onClick={() => { setRestore('pending'); setRestoreAttempt((n) => n + 1); }}>TRY AGAIN</button>
          )}
          {restore === 'retry' && (
            <button type="button" onClick={() => {
              restoreGuard.current = captureBaseSnapshotGuard();
              setRestore('hydrating');
            }}>TRY AGAIN</button>
          )}
          {packPaused && <button type="button" onClick={retryPack}>TRY AGAIN</button>}
        </GameLoading>
      </LoadingStage>
    </div>
  );
}

// ===========================================================================
// TITLE — brand bg + wordmark + PLAY / CONNECT WALLET
// ===========================================================================

/** Social login is available only when Privy is configured (VITE_PRIVY_APP_ID);
 *  App.tsx mounts PrivyProvider under the same condition, so the hooks in
 *  <SocialLoginButton/> only run when a provider is present. */
const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;

/** Social / email sign-in via a Privy embedded Solana wallet (reuses the same
 *  SIWS session flow as CONNECT WALLET; see useSocialAuth). */
function SocialLoginButton({ auth }: {
  auth: ReturnType<typeof useSocialAuth>;
}): React.JSX.Element {
  const { signInWithSocial, signingIn, error } = auth;
  return (
    <>
      <Btn variant="sec" fontSize={20} disabled={signingIn} style={{ padding: '11px 0 13px' }}
        onClick={() => signInWithSocial()}>
        {signingIn ? 'SIGNING IN…' : 'CONTINUE WITH GOOGLE / X / EMAIL'}
      </Btn>
      {error && <div style={{ color: C.danger, textAlign: 'center' }}>{error}</div>}
    </>
  );
}

/** Own one Privy/SIWS attempt for both visible entry points. ConnectSheet is a
 * portal, so its copy of the control can be mounted beside the title control;
 * sharing this hook makes those views one state machine rather than two login
 * owners racing the same embedded wallet. */
function PrivySocialControls({ connectOpen, onClose }: {
  connectOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const auth = useSocialAuth();
  return (
    <>
      <SocialLoginButton auth={auth} />
      {connectOpen && (
        <ConnectSheet onClose={onClose} social={<SocialLoginButton auth={auth} />} />
      )}
    </>
  );
}

/** Compact, non-blocking status for the optional offline file pack. It stays in
 * the title action column so both portrait and short landscape layouts expose
 * progress/retry without covering either authentication route. */
function AssetPackBackgroundStatus(): React.JSX.Element | null {
  // Own subscription (D-101): a 1 Hz progress tick re-renders this line only.
  const state = useAssetPackGate((s) => (s.required ? s.state : null));
  const retry = useAssetPackGate((s) => s.retry);
  if (!state || state.kind === 'ready' || state.kind === 'not-required') return null;

  if (state.kind === 'error') {
    return (
      <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap', color: C.textFaint, fontSize: 13, lineHeight: 1.15, textAlign: 'center' }}>
        <span>{state.code === 'quota' ? 'Free up space to finish the download. You can play online.' : 'Download paused. You can play online.'}</span>
        <Btn variant="ghost" fontSize={13} style={{ padding: '3px 8px 5px' }} onClick={retry}>
          TRY AGAIN
        </Btn>
      </div>
    );
  }

  const totalBytes = state.kind === 'checking' ? 0 : state.totalBytes;
  const completedBytes = state.kind === 'downloading' ? state.downloadedBytes : 0;
  const pct = totalBytes > 0 ? Math.floor((completedBytes * 100) / totalBytes) : 0;
  return (
    <div role="progressbar" aria-label="Background download"
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.kind === 'downloading' && totalBytes > 0 ? pct : undefined}
      style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.15, textAlign: 'center' }}>
      {state.kind === 'downloading' && totalBytes > 0 ? `Downloading · ${pct}%` : 'Loading…'} · You can play online.
    </div>
  );
}

export function TitleScreen(): React.JSX.Element {
  const { connected, publicKey } = useWallet();
  const [connectOpen, setConnectOpen] = useState(false);
  const { signIn, cancelSignIn, signingIn, phase, error } = useAuth();
  const entry = useGameEntryState();
  const authed = useApp((s) => s.authed);
  const port = usePortrait();

  // Signed in → ASK THE SERVER. It used to branch on `entryPaid` here and send
  // every unpaid wallet straight to the paywall without ever calling /base — but
  // "unpaid" no longer means "cannot play": under free onboarding the server
  // opens a base for a deedless wallet. So the single funnel is enterGame, whose
  // 402 branch is the paywall.
  //
  // With FREE_ONBOARDING OFF this is byte-identical in outcome: /base 402s for a
  // deedless wallet, enterGame clears entryPaid and routes to 'entry' — the same
  // screen, from the server's answer instead of from a client guess. The only
  // difference is one request that the paywall path used to skip.
  useEffect(() => {
    if (!authed) return;
    void enterGame();
  }, [authed]);

  // Composed once, placed twice. The buttons ARE the screen — everything else is
  // decoration — so the two orientations must never drift into offering
  // different sign-in options.
  const actions = (
    <>
      {authed ? (
        <Btn fontSize={port ? 26 : 22} disabled={entry.busy} onClick={() => void enterGame()}>
          {entry.busy ? 'LOADING YOUR GAME…' : 'RETRY ENTERING GAME'}
        </Btn>
      ) : !connected ? (
        <Btn fontSize={port ? 26 : 22} style={{ padding: port ? '13px 0 16px' : '9px 0 11px' }} onClick={() => setConnectOpen(true)}>
          <Icon name="sol" size={port ? 22 : 18} />CONNECT WALLET
        </Btn>
      ) : (
        <Btn fontSize={port ? 26 : 22} disabled={signingIn} style={{ padding: port ? '13px 0 16px' : '9px 0 11px' }} onClick={() => void signIn()}>
          {signingIn ? phase === 'verifying' ? 'VERIFYING SIGN-IN…' : phase === 'checking' ? 'PREPARING SIGN-IN…' : 'APPROVE IN YOUR WALLET…' : `PLAY AS ${publicKey?.toBase58().slice(0, 4)}…${publicKey?.toBase58().slice(-4)}`}
        </Btn>
      )}
      {signingIn && <div role="status" style={{ color: C.textFaint, textAlign: 'center' }}>
        {phase === 'waiting' ? 'Your wallet is still waiting. Return to its existing request to approve, or cancel here.' : 'One approval is in progress. Keep this request open.'}
        <Btn variant="ghost" onClick={() => cancelSignIn()}>CANCEL SIGN-IN</Btn>
      </div>}
      {(authed ? entry.error : error) && <div role="alert" style={{ color: C.danger, textAlign: 'center' }}>{authed ? entry.error : error}</div>}
      {!authed && !signingIn && PRIVY_ENABLED && (
        <PrivySocialControls connectOpen={connectOpen} onClose={() => setConnectOpen(false)} />
      )}
      {import.meta.env.DEV && (
        <Btn variant="sec" fontSize={port ? 19 : 16}
          onClick={() => {
            void api.postRaw<{ wallet: string; entryPaid?: boolean }>('/auth/dev-login', {})
              .then((r) => useApp.getState().setAuth(r.wallet, r.entryPaid ?? true));
          }}>
          DEV LOGIN (no wallet)
        </Btn>
      )}
      <AssetPackBackgroundStatus />
      {/* Lives inside `actions` on purpose: ConnectSheet portals itself to
          <body>, so one placement covers both orientation branches below and the
          two can never drift into offering different connect routes. */}
      {connectOpen && !PRIVY_ENABLED && (
        <ConnectSheet
          onClose={() => setConnectOpen(false)}
        />
      )}
    </>
  );

  // LANDSCAPE: art BESIDE the buttons, not above them.
  //
  // Stacked (top:96 + a 171px logo, buttons anchored to the bottom) the two
  // blocks overlap on a ~311px-tall viewport — the first screen a new player
  // sees, broken, in an orientation they may well be holding the phone in.
  // Side by side, each column gets the full height and neither has to shrink.
  // Portrait keeps the original composition byte for byte.
  if (!port) {
    return (
      <div className="interactive" style={{ position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 24, padding: `12px calc(24px + env(safe-area-inset-right)) 12px calc(24px + env(safe-area-inset-left))` }}>
        {/* Dimmed, where portrait uses the art at full brightness. Portrait can:
            its logo sits at top:96, against empty sky. Centred in a landscape
            column the logo lands ON the castle, and unlit it is unreadable. */}
        <BrandBg filter="brightness(.5)" />
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, zIndex: 1 }}>
          {/* width:100% + auto height, capped at 316: the logo scales down on a
              narrow half rather than overflowing it, and never scales UP past
              its native size into blur. */}
          <BrandImage src={BRAND_LOGO_MAIN} width={422} height={294} alt="Pixel Kingdom Wars"
            style={{ imageRendering: 'pixelated', width: '100%', maxWidth: 316, height: 'auto', filter: `drop-shadow(3px 3px 0 ${C.ink})` }} />
          <div style={{ color: C.text, fontSize: 16, letterSpacing: '4px', textShadow: `0 0 6px ${C.ink}, 2px 2px 0 ${C.ink}`, whiteSpace: 'nowrap' }}>MINE · BUILD · RAID</div>
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0, maxWidth: 420, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 9, zIndex: 1 }}>
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className="interactive" style={{ position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden' }}>
      <BrandBg />
      <div style={{ position: 'absolute', top: 96, left: 0, right: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <BrandImage src={BRAND_LOGO_MAIN} width={422} height={294} alt="Pixel Kingdom Wars" style={{ imageRendering: 'pixelated', width: 316, maxWidth: '82vw', height: 'auto' }} />
        <div style={{ color: C.text, fontSize: 20, letterSpacing: '5px', textShadow: `2px 2px 0 ${C.ink}` }}>MINE · BUILD · RAID</div>
      </div>
      <div style={{ position: 'absolute', left: 44, right: 44, bottom: 44, display: 'flex', flexDirection: 'column', gap: 13 }}>
        {actions}
      </div>
    </div>
  );
}

// ===========================================================================
// ENTRY — CLAIM YOUR LAND lives in ./land/EntryScreen.tsx (M35 lane D). It is
// mounted below with this file's enterGame and DevnetSolClaim injected, so the
// land screen never imports Overlay back (tests mock this module).
// ===========================================================================

// ===========================================================================
// ALPHA GATE — Closed Alpha invite-code redemption. Shown whenever the server
// answers 403 ALPHA_GATED (sign-in, session restore, or mid-play revocation).
// Brand-styled like TITLE/ENTRY; compact enough for one centred column in
// both orientations (the ModalWrap pattern: maxHeight + inner scroll).
// ===========================================================================

export function AlphaGateScreen(): React.JSX.Element {
  const wallet = useApp((s) => s.wallet);
  const { publicKey } = useWallet();
  const signOut = useSignOut();
  const { signIn, signingIn, error: signInError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateSeeker, setGateSeeker] = useState<SeekerStatus | null>(null);
  const referralProof = useRef<{ wallet: string; assert(): void } | null>(null);
  const referralRequest = useRef<AbortController | null>(null);
  const [savedAlphaCode, setSavedAlphaCode] = useState<string | null>(null);
  useEffect(() => {
    const suspend = (): void => referralRequest.current?.abort();
    const visibility = (): void => { if (document.visibilityState === 'hidden') suspend(); };
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); window.addEventListener('pagehide', suspend);
    return () => { suspend(); referralProof.current = null; document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('freeze', suspend); window.removeEventListener('pagehide', suspend); };
  }, []);
  // The wallet this gate is actually about is the SESSION wallet. On the
  // restore path the store never saw /me succeed, so it arrives from the
  // Seeker probe below (which answers with the session wallet). It is never
  // substituted with the connected adapter key: on a phone whose wallet app
  // auto-connects, that key can belong to a different, fully admitted account
  // — the owner saw their own admin wallet "gated" because a stale session for
  // a test wallet was what the server had refused (2026-08-21).
  const [probedWallet, setProbedWallet] = useState<string | null>(null);
  const sessionWallet = wallet ?? probedWallet;
  const connectedWallet = publicKey?.toBase58() ?? null;
  const mismatch = sessionWallet !== null && connectedWallet !== null && sessionWallet !== connectedWallet;
  const short = (w: string): string => `${w.slice(0, 4)}…${w.slice(-4)}`;

  // Shared admit path — invite redeem, the mount-time Seeker probe, and a
  // gate-screen Seeker link all end here.
  const admit = (sessionWallet: string | undefined, msg: string): void => {
    bus.emit('ui:toast', { msg });
    const s = useApp.getState();
    // Restore-path gate: /me 403'd before setAuth ever ran, so the store
    // does not know the (valid) session. The server response names the
    // session wallet — hydrate auth from it rather than bouncing a freshly
    // admitted player through a needless re-sign-in.
    if (!s.authed && typeof sessionWallet === 'string' && sessionWallet !== '') s.setAuth(sessionWallet);
    // Straight into the normal flow (enterGame handles the 402 entry
    // paywall). Safety net: still no session known → TITLE.
    if (useApp.getState().authed) { void enterGame(); return; }
    useApp.getState().setScreen('title');
  };

  // Seeker auto-admission probe, once per gate view (owner 2026-08-08: Seekers
  // enter with no code). Session creation intentionally avoids mainnet RPCs, so
  // this is the automatic detection point as well as the restore/revocation
  // recovery path. Silent on failure — the invite path below always still works.
  useEffect(() => {
    let dead = false;
    let assertSession: () => void;
    try {
      const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration();
      assertSession = () => { authCookies.assertResponse(revision); if (dead || !authCookies.current(generation)) throw new AuthChangedError(); };
    } catch { return; }
    void api.postRaw<{ admitted: boolean; seeker: SeekerStatus; wallet: string }>('/alpha/seeker', { mobileClient: isSolanaMobileClient() })
      .then((r) => {
        if (dead) return;
        assertSession();
        if (!r.admitted && typeof r.wallet === 'string' && r.wallet !== '') referralProof.current = { wallet: r.wallet, assert: assertSession };
        setGateSeeker(r.seeker);
        if (typeof r.wallet === 'string' && r.wallet !== '') setProbedWallet(r.wallet);
        if (r.admitted) {
          admit(r.wallet, r.seeker.linked
            ? 'SEEKER VERIFIED — WELCOME TO THE PLAYTEST'
            : 'ACCESS CONFIRMED — WELCOME TO THE PLAYTEST');
        }
      })
      .catch(() => { /* gate stays; the invite code path is unaffected */ });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one probe per mount
  }, []);

  const restoreAlphaReferral = async (): Promise<void> => {
    const proof = referralProof.current; if (!proof) return;
    try {
      const recovery = await import('../lib/referrals/entry'); const saved = await recovery.readAlphaReferral(proof.wallet, proof.assert);
      proof.assert(); if (saved) { setSavedAlphaCode(saved.code); setCode(saved.code); }
    } catch { /* Keep the original failure visible; no command is retried. */ }
  };

  // Preserve closed-alpha admission. A retained request is only read here;
  // process restart/foreground must never automatically repeat its mutation.
  useEffect(() => {
    const proof = referralProof.current; if (!proof || !probedWallet || proof.wallet !== probedWallet) return;
    let dead = false; const controller = new AbortController(); referralRequest.current = controller;
    void import('../lib/referrals/entry').then(async (recovery) => {
      proof.assert(); controller.signal.throwIfAborted();
      const saved = await recovery.readAlphaReferral(proof.wallet, proof.assert);
      if (dead) return;
      if (saved) { setSavedAlphaCode(saved.code); setCode(saved.code); setError('ORIGINAL ADMISSION REQUEST SAVED — RETRY THIS SAME CODE EXPLICITLY'); return; }
      const stored = readStoredReferralCode(); if (!stored) return;
      const result = await recovery.submitAlphaReferral(proof.wallet, stored, controller.signal, proof.assert);
      if (dead) return; clearStoredReferralCode(stored); admit(result.wallet, "FRIEND'S INVITE ACCEPTED — WELCOME TO THE PLAYTEST");
    }).catch(async (error: unknown) => { if (!dead && !controller.signal.aborted) { setError(error instanceof Error ? error.message : 'Check your original referral before trying again.'); await restoreAlphaReferral(); } });
    return () => { dead = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cookie-bound proof is created only by the existing Seeker probe
  }, [probedWallet]);

  const redeem = (): void => {
    const trimmed = code.trim();
    if (savedAlphaCode && /^keep-/i.test(trimmed) && trimmed.toUpperCase() !== savedAlphaCode) { setError('RETRY THE ORIGINAL SAVED REFERRAL CODE'); return; }
    if (trimmed === '') { setError('ENTER THE CODE FROM YOUR INVITE EMAIL'); return; }
    setBusy(true);
    setError(null);
    // ONE input, two code kinds (D-052): a friend's KEEP-XXXXX referral code
    // routes to /alpha/referral; anything else is an admin invite code for
    // /alpha/redeem. Contract verified against apps/api/src/routes-alpha.ts:
    // cookie-authed POST {code}. Referral codes are normalized and saved before
    // submission; admin invite semantics remain unchanged.
    const isReferral = /^keep-/i.test(trimmed);
    referralRequest.current?.abort();
    const controller = new AbortController(); referralRequest.current = controller;
    const proof = referralProof.current;
    const request = isReferral
      ? import('../lib/referrals/entry').then((recovery) => recovery.submitAlphaReferral(proof?.wallet ?? null, trimmed, controller.signal,
        () => { if (!proof) throw new Error('Wait for the signed-in account check.'); proof.assert(); }, savedAlphaCode !== null))
      : api.postRaw<{ ok: boolean; wallet: string }>('/alpha/redeem', { code: trimmed });
    void request
      .then((r) => { if (isReferral) { controller.signal.throwIfAborted(); proof?.assert(); } admit(r.wallet, isReferral
        ? "FRIEND'S INVITE ACCEPTED — WELCOME TO THE PLAYTEST"
        : 'INVITE ACCEPTED — WELCOME TO THE PLAYTEST'); })
      .catch(async (e: unknown) => {
        if (isReferral && controller.signal.aborted) return;
        setError(isReferral && e instanceof Error ? e.message.toUpperCase() : e instanceof ApiError && e.status < 500
          ? e.message.toUpperCase()
          : 'CODE NOT VALID — TRY AGAIN');
        if (isReferral) await restoreAlphaReferral();
      })
      .finally(() => setBusy(false));
  };

  // The gated session belongs to a wallet the player is no longer holding:
  // end it and sign in with the connected one in a single tap. SIWS itself is
  // unchanged (useAuth); this only orders logout → sign-in → enter. If the new
  // wallet is gated too, enterGame's first authed read re-opens this screen for
  // the right wallet; if the signature is declined, the title screen has the
  // connected wallet ready for a plain SIGN IN.
  const signInWithConnected = (): void => {
    if (busy || signingIn || !mismatch) return;
    setBusy(true);
    setError(null);
    const retirePush = suspendPushSession();
    // Fail closed locally while the old cookie remains available to the
    // endpoint DELETE. The connected wallet is authenticated only after both
    // endpoint retirement and logout have had their chance.
    useApp.getState().setAuth(null);
    void api.logout(() => retirePush)
      .then(async () => {
        await signIn();
        const s = useApp.getState();
        // The stale session is gone either way, so this gate no longer
        // describes anything: leave it. Authenticated → enter; a declined or
        // failed signature → the title screen, where the connected wallet's
        // plain SIGN IN is the retry, with a toast naming why it came back.
        s.setScreen('title');
        if (s.authed) { void enterGame(); return; }
        bus.emit('ui:toast', { msg: 'SIGN-IN DID NOT COMPLETE — TAP SIGN IN TO RETRY' });
      })
      .catch((error: unknown) => {
        useApp.getState().setScreen('title');
        bus.emit('ui:toast', { msg: error instanceof Error ? error.message : 'SIGN-OUT DID NOT COMPLETE — TRY AGAIN' });
      })
      .finally(() => setBusy(false));
  };

  // A split-wallet Seeker (social session, or game wallet ≠ Seed Vault wallet)
  // can prove theirs right here — the link routes are reachable pre-gate. A
  // successful link already granted access server-side; re-probe to enter.
  const onDoorChange = (s: SeekerStatus | null): void => {
    setGateSeeker(s);
    if (!s?.linked) return;
    void api.postRaw<{ admitted: boolean; wallet: string }>('/alpha/seeker', { mobileClient: isSolanaMobileClient() })
      .then((r) => {
        if (r.admitted) admit(r.wallet, 'SEEKER VERIFIED — WELCOME TO THE PLAYTEST');
      })
      .catch(() => { /* the next gate view retries */ });
  };

  return (
    <div className="interactive" style={{
      position: 'absolute', inset: 0, background: C.bg, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 'calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left))',
    }}>
      <BrandBg filter="brightness(.45)" />
      <Panel9 style={{ width: 380, maxWidth: '100%', maxHeight: '94%', overflowY: 'auto', zIndex: 1 }}>
        <Phead title="JOIN THE PLAYTEST" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
          <div style={{ color: C.textDim, fontSize: 16, lineHeight: 1.45 }}>
            Pixel Kingdom Wars is in an invite playtest on Solana devnet — free to
            play, nothing in it is real money. Enter the one-time invite code from
            your approval email (or a friend's KEEP- code) to unlock this account.
          </div>
          {sessionWallet && (
            <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
              <span style={{ letterSpacing: '1px' }}>SIGNED IN AS </span>
              <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{sessionWallet}</span>
            </div>
          )}
          {mismatch && connectedWallet && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: `2px solid ${C.goldDp}`, background: C.surface }}>
              <div style={{ color: C.text, fontSize: 14, lineHeight: 1.4 }}>
                YOUR WALLET NOW SHOWS <span style={{ fontFamily: 'monospace' }}>{short(connectedWallet)}</span>, BUT THIS SESSION BELONGS TO <span style={{ fontFamily: 'monospace' }}>{short(sessionWallet)}</span>.
              </div>
              <Btn variant="gold" fontSize={18} disabled={busy || signingIn} onClick={signInWithConnected}>
                {busy || signingIn ? 'SIGNING IN…' : `SIGN IN WITH ${short(connectedWallet)}`}
              </Btn>
              {signInError && <div style={{ color: C.danger, fontSize: 13, textAlign: 'center' }}>{signInError.toUpperCase()}</div>}
            </div>
          )}
          <input
            className="interactive" value={code} autoFocus
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) redeem(); }}
            placeholder="INVITE CODE" maxLength={64}
            style={{ fontFamily: 'inherit', fontSize: 19, letterSpacing: '2px', background: C.surface, color: C.text, border: `2px solid ${C.borderLt}`, padding: '8px 10px' }} />
          <Btn fontSize={22} disabled={busy} style={{ padding: '11px 0 14px' }} onClick={redeem}>
            {busy ? 'REDEEMING…' : 'ENTER THE PLAYTEST'}
          </Btn>
          {error && <div style={{ color: C.danger, fontSize: 15, textAlign: 'center', lineHeight: 1.35 }}>{error}</div>}
          {/* Deep link to the application form's stable anchor (landing #apply) —
              a code-less player should land on the form, not the scroll story. */}
          <a className="interactive" href="https://pixelkingdomwars.com/#apply" target="_blank" rel="noreferrer"
            style={{ color: C.gold, fontSize: 15, textAlign: 'center', textDecoration: 'none' }}>
            NO CODE? GET AN INVITE AT PIXELKINGDOMWARS.COM ↗
          </a>
          {/* Seekers need no code (2026-08-08): the Seed Vault wallet was
              auto-checked above; this door is for the SGT living on a wallet
              other than the session one. A successful link admits via
              onDoorChange. */}
          <SeekerDoor status={gateSeeker} onChange={onDoorChange} />
          <Btn variant="ghost" fontSize={15} style={{ color: C.textFaint }} onClick={() => void signOut()}>
            BACK — SWITCH ACCOUNT
          </Btn>
        </div>
      </Panel9>
    </div>
  );
}

// ===========================================================================
// BASE HUD — App row1/row2 + right rail + navbar (SHOP/BUILD/MAP/CODEX/RAID)
// ===========================================================================

/** Minimal shape of GET /quests needed for the HUD quests-progress pill. */
interface HudQuestBoard {
  quests: Array<{ scope: string; completed: boolean }>;
}

/** Identity slice of GET /me — only the name, and only to decide whether the
 *  first-run "choose a name" nudge is still needed. */
interface HudMe {
  name: string;
}

/**
 * Stops a tap that LANDS on HUD chrome from ALSO reaching the Phaser canvas
 * underneath. Phaser 4's Touch/MouseManager attach `touchstart/end/cancel` and
 * `mousedown/up` to `window`, and their *Window handlers process every event
 * whose target is not the canvas — so a `pointer-events:auto` pill sitting over
 * a tree still lets Phaser commit the obstacle on the same down→up (obstacles
 * select on `pointerup`, BaseScene). Stopping those NATIVE events at the HUD
 * container — which is below `window` in the tree, and React's delegated root
 * listener runs during the bubble — halts propagation before Phaser's window
 * handlers ever see it. Spread onto the interactive HUD wrappers only: a tap in
 * the gaps between pills targets the canvas directly and never enters this
 * subtree, so camera pan/pinch through the gaps is untouched. No preventDefault,
 * so the landscape strip's drag-scroll and each control's own click still fire.
 */
const swallowHudTaps = {
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
  onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
  onTouchEnd: (e: React.TouchEvent) => e.stopPropagation(),
  onTouchCancel: (e: React.TouchEvent) => e.stopPropagation(),
} as const;

function BaseHud({ baseActionsEnabled, panelInset }: { baseActionsEnabled: boolean; panelInset: SheetInset | null }): React.JSX.Element {
  const base = useApp((s) => s.base);
  const balances = useApp((s) => s.balances);
  const hudWallet = useApp((s) => s.wallet);
  const sol = useSolBalance(hudWallet, 60_000);
  const requestCommand = useUserCommand();
  const capability = useRef(baseActionsEnabled); capability.current = baseActionsEnabled;
  const setScreen = (screen: Screen): void => { requestCommand(() => useApp.getState().setScreen(screen),
    () => !['build', 'layout', 'expand', 'claim'].includes(screen) || capability.current); };
  const raidChooserPending = useApp((s) => s.raidChooserPending);
  const consumeRaidChooserRequest = useApp((s) => s.consumeRaidChooserRequest);
  const baseFocusRequest = useApp((s) => s.baseFocusRequest);
  const onboardingStepCode = useApp((s) => s.onboardingStepCode);
  useEffect(() => {
    if (!baseFocusRequest || !base) return;
    const target = baseFocusRequest;
    return requestCommand(() => {
      const app = useApp.getState();
      app.consumeBaseFocusRequest();
      if (app.placing) bus.emit('build:end', undefined);
      app.setScreen('base');
      if (target.kind === 'building') app.select(target.id);
      else app.selectObstacle(target.id);
      bus.emit('base:focus', target);
    }, () => {
      const current = useApp.getState();
      return current.baseFocusRequest === target && (target.kind === 'building'
        ? current.base?.buildings.some(row => row.id === target.id) === true
        : current.base?.obstacles.some(row => row.id === target.id) === true);
    });
  }, [base, baseFocusRequest, requestCommand]);
  /** Which destination the player is IN. BaseHud is mounted for 'base' and
   *  'build' only (inBase), so this is what lets the BUILD tab show that its
   *  tray is open instead of looking identical to the four it is not in. */
  const screen = useApp((s) => s.screen);
  const baseDirectory = useApp((s) => s.baseDirectory);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const selectorEnabled = baseSelectorAvailable(baseDirectory);
  const port = usePortrait();
  const win = useWindowSize();
  const chrome = hudTier(win.w, win.h);
  /** The game's own REDUCE MOTION switch (profile screen). It gates the bar's
   *  value-change acknowledgement in JS; HUD_CHROME_CSS gates the same thing on
   *  the OS switch, so either one on means numbers change with no flash. */
  const reduceMotion = useApp((s) => s.reduceMotion);
  /** null until the server balance arrives, so a cold start never flashes.
   *  Trophies are the same contract: `base` is null until the snapshot lands, so
   *  arriving at 412 trophies is not something to acknowledge — WINNING one is.
   *  SOL is already null until the on-chain read returns. */
  const shardsNum = balances ? Number(balances.shards) : null;
  const gemsEnabled = balances?.features?.gems?.version === 1 && balances.features.gems.receipts === 1 && balances.gems !== undefined;
  const keepNum = balances ? Number(gemsEnabled ? balances.gems : balances.keep) : null;
  const trophiesNum = base ? base.player.trophies : null;
  const shardsFlash = useHudFlash(shardsNum, reduceMotion);
  const keepFlash = useHudFlash(keepNum, reduceMotion);
  // EVERY readout in the row acknowledges its own change, not just the two the
  // craft pass got to first. A raid that moves your trophies and a deposit that
  // moves your SOL are exactly the events a player wants confirmed, and both
  // used to snap silently while the currencies beside them flashed.
  const trophiesFlash = useHudFlash(trophiesNum, reduceMotion);
  const solFlash = useHudFlash(sol, reduceMotion);
  // What the chips DRAW during an increase. The solver below is still handed the
  // TARGET strings, never these — see useHudRoll: an increase's intermediates are
  // always ≤ the final value, so a rolling chip fits the width budgeted for
  // where it is going.
  const shardsRoll = useHudRoll(shardsNum, reduceMotion);
  const keepRoll = useHudRoll(keepNum, reduceMotion);
  const trophiesRoll = useHudRoll(trophiesNum, reduceMotion);
  const safeArea = useSafeAreaInsets();
  /** The overflow panel. Closed on every mount and on every screen change —
   *  BaseHud re-mounts with the base screens — so it is never found open. */
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { setMoreOpen(false); }, [screen, selectedBaseId]);
  useMobileBackHandler(() => setMoreOpen(false), moreOpen, 230);
  const hudRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const hud = hudRef.current;
    const nav = navRef.current;
    const queue = queueRef.current?.firstElementChild;
    if (!hud || !nav) return;
    const publish = (): void => {
      const viewport = readGameViewport();
      const i = baseCameraInsets(
        chrome,
        { width: viewport.w, height: viewport.h },
        hud.getBoundingClientRect(),
        nav.getBoundingClientRect(),
        { ...safeArea, bottom: safeArea.bottom + Math.max(0, viewport.h - readGameUiViewport().h) },
        queue?.getBoundingClientRect(),
      );
      bus.emit('base:insets', mergeBasePanelInsets(i, panelInset, viewport.h - readGameUiViewport().h));
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(publish);
    ro.observe(hud);
    if (queue) ro.observe(queue);
    ro.observe(nav);
    const offViewport = subscribeGameViewport(publish);
    return () => {
      ro.disconnect();
      offViewport();
    };
  }, [chrome.rail, chrome.tier, safeArea, win.w, win.h, panelInset]);
  const [jobNow, setJobNow] = useState(Date.now);
  useEffect(() => {
    if (!base?.jobs.length) return undefined;
    setJobNow(Date.now());
    const timer = setInterval(() => setJobNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [base?.jobs.length]);
  /** Server-confirmed land ownership. False here means the player is on the free
   *  tier WITH a base — the only way to reach this HUD without land — so the
   *  prompt below is the honest label on it, not a paywall. */
  const landOwned = useApp((s) => s.entryPaid);
  /** RAID destination chooser (2026-08-09) — see RaidChooser.tsx. */
  const [raidOpen, setRaidOpen] = useState(false);
  // The quest board unmounts BaseHud before returning here. Consume the stored
  // request only after this owner of the chooser has mounted, so React ordering
  // cannot lose the onboarding action.
  useEffect(() => {
    if (!raidChooserPending) return;
    return requestCommand(() => {
      setRaidOpen(true);
      consumeRaidChooserRequest();
    }, () => capability.current && useApp.getState().raidChooserPending);
  }, [consumeRaidChooserRequest, raidChooserPending, requestCommand, baseActionsEnabled]);
  // Quests-progress pill is driven by the real board (App hardcodes '2/3').
  const { data: questBoard } = useFetch<HudQuestBoard>(
    () => api.get<HudQuestBoard>(selectedBasePath('/quests')),
    [selectedBaseId],
  );
  // Includes same-count Mine upgrades/completions and background-tab recovery.
  const { data: mineStatus } = useMineStatus();
  // Identity (owner 2026-07-29: "why is SET NAME on the main base UI?"). The
  // name now lives in PROFILE → SETTINGS; the HUD keeps only a one-time nudge
  // for an account that has never picked one, which disappears for good once
  // the server says a name exists. Server truth; the screen change back from
  // the profile re-mounts this tree and refetches.
  const { data: me } = useFetch<HudMe>(() => api.get<HudMe>('/me'));
  const { data: mailStatus, reload: reloadMail } = useFetch<{ total: number; unread: number; pendingRewards: number }>(
    () => api.get('/mail/status'),
  );
  // The MAIL badge is the in-app counterpart of the mail push (D-101): a
  // one-shot fetch left it stale for the whole session, so it re-reads on
  // every authoritative /base refresh and whenever the tab comes back.
  useEffect(() => {
    const off = [bus.on('base:refresh', reloadMail), bus.on('mail:refresh', reloadMail)];
    const onVisible = (): void => { if (document.visibilityState === 'visible') reloadMail(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off.forEach((unsubscribe) => unsubscribe()); document.removeEventListener('visibilitychange', onVisible); };
  }, [reloadMail]);
  const [nudgeHidden, setNudgeHidden] = useState(false);
  const needsName = !!me && !me.name && !nudgeHidden;
  // Owner-only: true only after the one-per-wallet /admin/alpha/stats probe
  // succeeded (screens/admin.tsx). Players never render an ADMIN control.
  const isAdmin = useIsAdmin();

  // server commits drag-drop moves coming from the scene (frozen 'base:move')
  useEffect(() =>
    bus.on('base:move', ({ buildingId, tx, ty }) => {
      if (!baseActionsEnabled) {
        bus.emit('ui:toast', { msg: 'BASE CHANGES ARE LOCKED DURING THE MULTI-BASE READ CUTOVER' });
        bus.emit('base:moveSettled', { buildingIds: [buildingId], ok: false });
        bus.emit('base:refresh', undefined);
        return;
      }
      // The scene keeps the dropped tile until this settles: until the PATCH
      // lands the store still says the OLD tile, and a heartbeat refresh in
      // that window would snap the building back for one frame.
      const settle = (ok: boolean) => bus.emit('base:moveSettled', { buildingIds: [buildingId], ok });
      void api.patch(`/base/buildings/${buildingId}/move`, withSelectedBase({ tx, ty }))
        .then(() => loadServerState())
        .then(() => { settle(true); bus.emit('base:refresh', undefined); })
        .catch(() => void loadServerState().then(() => { settle(false); bus.emit('base:refresh', undefined); }));
    }),
  [baseActionsEnabled]);
  // #61: a whole wall LINE moved together → one batch move.
  useEffect(() =>
    bus.on('base:moveLine', ({ moves }) => {
      if (!baseActionsEnabled) {
        bus.emit('ui:toast', { msg: 'BASE CHANGES ARE LOCKED DURING THE MULTI-BASE READ CUTOVER' });
        bus.emit('base:moveSettled', { buildingIds: moves.map((m) => m.id), ok: false });
        bus.emit('base:refresh', undefined);
        return;
      }
      const settleLine = (ok: boolean) =>
        bus.emit('base:moveSettled', { buildingIds: moves.map((m) => m.id), ok });
      void api.post('/base/buildings/move-batch', withSelectedBase({ moves }))
        .then(() => loadServerState())
        .then(() => { settleLine(true); bus.emit('base:refresh', undefined); })
        .catch(() => void loadServerState().then(() => { settleLine(false); bus.emit('base:refresh', undefined); }));
    }),
  [baseActionsEnabled]);

  if (!base) return <></>;
  const free = base.freeBuilders;
  const total = base.player.builders;
  // Mine buffer fill % for the shard-pill mini-bar (collectable / storage cap),
  // from GET /mine/status. Null until the server value loads → the bar is
  // omitted rather than shown at a faked percentage.
  const mining = mineStatus?.mining;
  const bufferPct = mining && mining.storageCap > 0
    ? Math.round((mining.accrued / mining.storageCap) * 100)
    : null;
  // Daily quest completion N/3 (App L167: hardcoded '2/3'); weekly excluded.
  const dailies = questBoard?.quests.filter((q) => q.scope === 'daily') ?? [];
  const questsDone = dailies.filter((q) => q.completed).length;
  const questsTotal = dailies.length;

  // THE BAR'S CONTENT IS SOLVED, NOT LISTED. hudBarPlan() decides which chips
  // the row can hold at this viewport; everything it declines is in the panel
  // behind the overflow control. Union, never intersection — no chip is ever
  // rendered in both places, so "reachable" does not depend on width.
  // The solver is handed the EXACT strings the chips will draw, because a chip
  // is a fixed frame plus one glyph advance per character: budget a "typical"
  // width instead and a player holding 7,038,871 shards on a 320px phone gets a
  // chip narrower than its own number, which clips to "7,038,87".
  const shardsTxt = fmtN(shardsNum ?? 0);
  const keepTxt = fmtN(keepNum ?? 0);
  const trophiesTxt = fmtN(base.player.trophies);
  const solTxt = sol == null ? '…' : sol.toFixed(sol >= 100 ? 1 : 3);
  // The shield chip is the RAIDED indicator while defences newer than this
  // device's seen stamp exist (D-099): the raid log, which REVENGE lives on,
  // writes the stamp, and BaseHud re-mounts on the way back — so a render-time
  // read is always current. Deedless bases carry no defences and no stamp.
  const unreadRaids = unreadDefences(
    base.defences, base.baseId ? readDefencesSeen(base.baseId) : null,
  );
  const shieldView = shieldChipView(base.shield, unreadRaids);
  const plan = hudBarPlan(win.w, win.h, {
    shards: shardsTxt, keep: keepTxt, trophies: trophiesTxt, sol: solTxt, currencyIconSize: gemsEnabled ? 24 : 20,
    leagueRail: leagueRailLabel(base.player.trophies),
    shield: shieldView.label,
  });
  // The count-up's current frame. It equals the target except during an
  // increase, and an increase only ever narrows the string — which is why the
  // plan above is solved from the target and not from these.
  const shardsShown = fmtN(shardsRoll ?? shardsNum ?? 0);
  const keepShown = fmtN(keepRoll ?? keepNum ?? 0);
  const trophiesShownValue = trophiesRoll ?? base.player.trophies;
  const trophiesShown = fmtN(trophiesShownValue);
  // The claim pill's hot state, verbatim from the pill it replaces: a claimable
  // cache is only actionable while base actions are allowed.
  const claimAvailable = !!mineStatus?.cache.claimable && baseActionsEnabled;
  // THE ONE RULE THAT MAKES MOVING CONTROLS SAFE (layout.ts). A time-sensitive
  // action must never become invisible by being moved into a panel.
  const overflowAlert = hudOverflowAlert({
    claimAvailable,
    mailUnread: mailStatus?.unread ?? 0,
    mailPendingRewards: mailStatus?.pendingRewards ?? 0,
  });
  const queueJobs = [...base.jobs].sort((a, b) =>
    Date.parse(a.finishesAt) - Date.parse(b.finishesAt));
  const onboardingJobTypes = [...new Set(queueJobs.flatMap((job) => {
    if (job.kind !== 'build' || !job.buildingId) return [];
    const type = base.buildings.find((building) => building.id === job.buildingId)?.type;
    return type && ['camp', 'mine', 'barracks'].includes(type) ? [type] : [];
  }))];
  const verifyingJobs = queueJobs.filter((job) => Date.parse(job.finishesAt) <= jobNow).length;
  const attention = hudAttention({
    verifyingJobs,
    idleBuilders: free,
    bufferFull: bufferPct != null && bufferPct >= 100,
    overflow: overflowAlert,
  });
  const nextJob = queueJobs[0];
  const nextJobSeconds = nextJob ? Math.max(0, Math.ceil((Date.parse(nextJob.finishesAt) - jobNow) / 1000)) : 0;
  const queue = <div ref={queueRef} style={{ pointerEvents: 'none' }}>
    <HudQueueSummary onboardingJobs={onboardingJobTypes.join(' ') || undefined} onClick={() => setScreen('builders')}>
      <Icon name="builder" size={20} />
      <span>{verifyingJobs ? 'VERIFYING…' : nextJob ? fmtDur(nextJobSeconds) : 'BUILDERS'}</span>
      <span style={{ color: C.goldHi }}>{free}/{total} READY</span>
    </HudQueueSummary>
  </div>;

  // ONE compact row, identical in both orientations — only the plate's top
  // chamfer and the right-hand stop differ (landscape ends at the nav rail).
  const bar = (
    <div
      onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}
      style={hudBarStyle(port, plan.tier, plan.rail)}>
      <div ref={hudRef} style={hudBarRowStyle()}>
        <HudPlayerMenuButton
          art={<Sprite name={warePortraitAliasKey('keep', base.player.keepLevel)} w={25} h={25} />}
          level={base.player.keepLevel}
          open={moreOpen}
          alert={overflowAlert || unreadRaids > 0 || questsDone > 0}
          hot={attention === 'overflow'}
          reduceMotion={reduceMotion}
          onToggle={() => setMoreOpen((value) => !value)}
        />
        {/* (dual-currency split, owner 2026-07-24): SHARDS (soft — mined and
            awarded by quests; builds/troops; carries the mine-buffer bar) and
            KEEP (hard — Forge, eligible Ruined Keep/alpha rewards or verified
            deposits). These two are what every build and train action debits,
            so they are the only readouts that are never displaced. */}
        <HudChip ariaLabel="Shards" onClick={() => setScreen('forge')} flash={shardsFlash}
          // A FULL mine buffer stops accruing: every shard mined from here is
          // lost until the player collects. That is the one state on this chip
          // that is genuinely waiting for them, so it is the one that breathes.
          hot={attention === 'buffer'} reduceMotion={reduceMotion}>
          <Icon name="shard" size={20} /><PillVal color={C.sky}>{shardsShown}</PillVal>
          {/* Real mine-buffer fill % (collectable / cap) — omitted when the
              server value isn't available, never faked. */}
          {plan.showMineBar && bufferPct != null && <BarMini pct={bufferPct} />}
        </HudChip>
        {/* THE PRECIOUS ONE, and the reason this is not a taste question.
            Production feedback #1 was a player spending KEEP by accident because
            it looked like an ordinary resource: shards are mined and refunded,
            KEEP is bought. So the hierarchy is carried three ways at once — the
            gold plate (hudChipStyle), gold numerals rather than the ordinary
            text colour, and a hard 1px charcoal shadow that seats the token on
            the plate instead of letting it float like an icon in a list. All
            three cost zero layout: the plate keeps the measured 3px inset, the
            colour is free, and the shadow has no blur and no spread. */}
        <HudChip ariaLabel={gemsEnabled ? 'GEMS' : 'KEEP'} onClick={() => setScreen('exchange')} {...(gemsEnabled ? {} : { plate: 'keep' as const })} flash={keepFlash}>
          {gemsEnabled ? <Icon name="gem" size={24} />
            : <Icon name="keep" size={20} style={{ filter: `drop-shadow(1px 1px 0 ${C.ink})` }} />}
          <PillVal color={gemsEnabled ? C.sky : C.goldHi}>{keepShown}</PillVal>
        </HudChip>
        {plan.leagueForm && (
          <HudChip ariaLabel={leagueChipAriaLabel(base.player.trophies)}
            onClick={() => setScreen('leagues')} flash={trophiesFlash}
            style={{ width: plan.leagueWidth, flex: 'none' }}>
            <LeagueChip trophies={trophiesShownValue} form={plan.leagueForm} />
          </HudChip>
        )}
        {/* On-chain SOL (owner 2026-08-15, M23 a14) — the wallet's real balance,
            read client-side like the paywall screen, never a server credit
            (v3 dropped server SOL deliberately). It mounts with a placeholder
            (owner: a late-popping pill "sucks") and fills on the first read. */}
        {plan.showSol && (
          <HudChip ariaLabel="SOL balance" onClick={() => setScreen('exchange')} flash={solFlash}>
            <Icon name="sol" size={20} />
            <PillVal color={C.sky}>{solTxt}</PillVal>
          </HudChip>
        )}
        {plan.showShield && (
          <HudChip ariaLabel={shieldView.ariaLabel}
            {...(shieldView.accent ? { accent: shieldView.accent } : {})}
            onClick={() => setScreen(shieldView.go)}>
            <Icon name="shield" size={20} />
            <PillVal color={shieldView.color}>{shieldView.label}</PillVal>
          </HudChip>
        )}
      </div>
      {queue}
    </div>
  );

  return (
    <>
      {bar}
      {moreOpen && (
        <>
          {/* Tap-away close. Transparent, and it swallows the tap so dismissing
              the panel can never also place a building underneath it. */}
          <div
            {...swallowHudTaps}
            onClick={() => setMoreOpen(false)}
            style={{ position: 'absolute', inset: 0, zIndex: 1001, pointerEvents: 'auto' }} />
          <div {...swallowHudTaps} style={{
            position: 'absolute', zIndex: 1002,
            top: 'calc(8px + env(safe-area-inset-top))',
            left: 'calc(8px + env(safe-area-inset-left))',
            width: 'min(480px, calc(100% - 16px - env(safe-area-inset-left) - env(safe-area-inset-right)))',
          }}>
            <HudOverflowPanel
              portrait={port}
              baseActionsEnabled={baseActionsEnabled}
              armyStatus={base.armyStatus}
              resources={{ shards: balances?.shards.toString() ?? '…', keep: balances?.keep.toString() ?? '…' }}
              onFit={() => bus.emit('base:camera', { op: 'fit' })}
              barHasTrophies={plan.showTrophies}
              barHasSol={plan.showSol}
              sol={sol}
              trophies={base.player.trophies}
              energy={{ free: base.energy.free, max: base.energy.max }}
              shield={shieldView}
              quests={{ done: questsDone, total: questsTotal }}
              claim={{
                available: claimAvailable,
                day: mineStatus?.cache.currentDay ?? 0,
                enabled: baseActionsEnabled,
              }}
              mail={{ unread: mailStatus?.unread ?? 0, pending: mailStatus?.pendingRewards ?? 0 }}
              isAdmin={isAdmin}
              selectorEnabled={selectorEnabled}
              needsBaseSelect={!selectedBaseId}
              reduceMotion={reduceMotion}
              onGo={setScreen}
              onClose={() => setMoreOpen(false)}
            />
          </div>
        </>
      )}

      <div style={{ position: 'absolute', zIndex: 1000, left: 'calc(8px + env(safe-area-inset-left))', bottom: 'calc(8px + env(safe-area-inset-bottom))', pointerEvents: 'none' }}>
        <HudChip ariaLabel="Fit base to screen" onClick={() => bus.emit('base:camera', { op: 'fit' })}
          style={{ width: 48, height: 56, padding: 0 }}><Icon name="locate" size={24} /></HudChip>
      </div>

      {/* PROMPT STACK — the two first-run nudges, stacked because a brand-new
          player has BOTH (no name, no land) and they used to occupy the same
          absolute slot. A landowner with a name renders neither, so this whole
          block is invisible in the state the game has always shipped in. */}
      {(needsName || !landOwned) && (
        <div style={{
          position: 'absolute', left: `calc(10px + env(safe-area-inset-left))`,
          right: 'calc(8px + env(safe-area-inset-right))',
          // Raised to clear the base-tools dock, which now occupies the 44px
          // band directly above the navbar (portrait) / the bottom edge
          // (landscape). The prompts are centred and can be wide enough to
          // reach the dock's corner, so the clearance is explicit rather than
          // left to chance.
          bottom: !plan.rail && plan.tier !== 'wide'
            ? `calc(${CHROME.navBar + CHROME.dockGap + CHROME.dockRow + 8}px + env(safe-area-inset-bottom))`
            : `calc(${CHROME.dockRow + 18}px + env(safe-area-inset-bottom))`,
          zIndex: 1001, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
          pointerEvents: 'none',
        }}>
          {/* NO LAND — the standing, honest label on the limited state. Above the
              name nudge because it explains three locked buttons, where the nudge
              is cosmetic. Not dismissible: it is the tier, not a tip. */}
          {!landOwned && (
            <div {...swallowHudTaps}>
              <NoLandPrompt onOpen={() => useApp.getState().setLandPrompt('browse')} />
            </div>
          )}
          {/* FIRST-RUN NAME NUDGE — a prompt, not a permanent control. It exists
              only while the account has no name (raid log, map nametags and market
              listings all label you by it), and dismissing it or setting the name
              removes it. The name itself is set in PROFILE → SETTINGS.

              It wears the FORGED STRIP — this is the third of the three "black
              bar things" the owner named, and it sits directly above the deck
              where the contrast with forged chrome is loudest. hudStripStyle is
              the BAR's own plate, so the nudge is literally the same material
              rather than a lookalike of it. */}
          {needsName && (
            <div {...swallowHudTaps} style={{ ...hudStripStyle(), display: 'flex', alignItems: 'center', gap: 8, padding: '2px 6px 4px', pointerEvents: 'auto' }}>
              <Icon name="settings" size={18} />
              <span className="interactive" onClick={() => setScreen('profile')} style={{ cursor: 'pointer', fontSize: 15, color: C.goldHi }}>
                CHOOSE YOUR NAME — SETTINGS › USERNAME
              </span>
              <span className="interactive" onClick={() => setNudgeHidden(true)} style={{ cursor: 'pointer', fontSize: 15, color: C.textFaint }}>✕</span>
            </div>
          )}
        </div>
      )}

      {/* Three primary destinations float over the full scene. Secondary routes live in the player menu. */}
      <nav ref={navRef} {...swallowHudTaps} style={hudDeckStyle(port, plan.tier, plan.rail)}>
        <HudChromeStyle />
        {/* THE ONLY DESTINATION THAT CAN BE "HERE". BaseHud stays mounted for
            screen==='build' (inBase) and for nothing else, so BUILD is the one
            tab whose screen you can be looking at while the nav is on screen —
            and until now it looked exactly like the four you were not in. */}
        <NavBtn icon="plus" label={baseActionsEnabled ? 'BUILD' : 'READ ONLY'}
          active={screen === 'build'}
          disabled={!baseActionsEnabled} onClick={() => setScreen('build')} />
        <NavBtn icon="map" label="MAP" onClick={() => setScreen('map')} />
        {/* RAID ASKS now (owner 2026-08-09). It used to auto-match on the spot,
            so a player with no eligible ladder target met a dead-end dialog
            instead of the world map or campaign that were right there. */}
        <NavBtn icon="attack" label="RAID" gold disabled={!baseActionsEnabled}
          onClick={() => requestCommand(() => setRaidOpen(true), () => capability.current)} />
      </nav>
      {raidOpen && <RaidChooser onClose={() => setRaidOpen(false)} />}
    </>
  );
}

/**
 * A navigation destination. The look is the forged tab in hudChrome.tsx; this
 * wrapper exists only to keep the call sites reading the way they always have
 * (`icon="map"` rather than an element) and to pin the icon size per shape.
 *
 * `gold` still means RAID — the primary action — and still renders gold. What
 * changed is that it is now a forged gold PLATE rather than a flat #E3AE3C
 * fill, so "primary" and "you are here" are told apart: `active` is the one
 * that sinks.
 */
function NavBtn({ icon, label, gold, rail, wide, active, disabled, onClick }: {
  icon: Parameters<typeof Icon>[0]['name']; label: string; gold?: boolean; rail?: boolean;
  wide?: boolean; active?: boolean; disabled?: boolean; onClick: () => void;
}): React.JSX.Element {
  return (
    <HudNavButton
      label={label}
      icon={<Icon name={icon} size={20} />}
      tab={gold ? 'gold' : 'nav'}
      {...(rail ? { rail } : {})}
      {...(wide ? { wide } : {})}
      {...(active ? { sunk: active } : {})}
      {...(disabled ? { disabled } : {})}
      onClick={onClick}
    />
  );
}

// ===========================================================================
// Land-gate host — renders the buy-land sheet whenever a land-gated action was
// refused (402 LAND_NOT_OWNED) or the player asked what land is.
// ===========================================================================

function LandGateHost(): React.JSX.Element | null {
  const landPrompt = useApp((s) => s.landPrompt);
  const setLandPrompt = useApp((s) => s.setLandPrompt);
  const setScreen = useApp((s) => s.setScreen);
  const setLandPurchase = useApp((s) => s.setLandPurchase);
  if (landPrompt === null) return null;
  return (
    <LandGateSheet
      entryFeeSol={ECONOMY.entryFeeSol}
      reason={landPrompt}
      onClose={() => setLandPrompt(null)}
      // BUY takes them to the one screen that can actually take a payment. It is
      // the SAME screen the old paywall used — reframed, not duplicated, so the
      // pay + claim + deposit-address logic has exactly one home.
      onBuy={() => {
        setLandPrompt(null);
        setLandPurchase({ kind: 'entry', earthCell: null });
        setScreen('entry');
      }}
    />
  );
}

// ===========================================================================
// Toast host — renders 'ui:toast' events (App: top 14%, 1600ms)
// ===========================================================================

type FaucetHandle = ReturnType<typeof useDevnetFaucet>;

/** D-098: the public faucet is named exactly once, as a caveat, and only when
 * the game itself cannot fund the wallet. Plain text, never a link. */
const PUBLIC_FAUCET_NOTE = 'THE PUBLIC FAUCET AT FAUCET.SOLANA.COM MAY ASK FOR A SMALL MAINNET SOL BALANCE ON THE SAME WALLET';

/** What the CLAIM DEVNET SOL control shows for a faucet state — the one place
 * the precedence lives, shared with EntryScreen's layout choice. `null` means
 * render nothing: not devnet, the server has not answered, the faucet is off,
 * or the wallet already holds enough. A stale failure outranks the reason so
 * RETRY (which clears it in the hook) is the only way past it. */
export function devnetSolClaimView(faucet: Pick<FaucetHandle, 'phase' | 'status'>):
  'claim' | 'funding' | 'arrived' | 'cooldown' | 'cap' | 'unavailable' | null {
  const s = faucet.status;
  if (SOLANA_CLUSTER !== 'devnet' || !s) return null;
  if (s.reason === 'disabled' || s.reason === 'not_devnet') return null;
  if (faucet.phase === 'funding' || faucet.phase === 'checking') return 'funding';
  if (faucet.phase === 'funded') return 'arrived';
  if (faucet.phase === 'failed' || faucet.phase === 'unavailable') return 'unavailable';
  switch (s.reason) {
    case 'ok': return 'claim';
    case 'pending': return 'funding';
    case 'cooldown': return 'cooldown';
    case 'cap_reached': return 'cap';
    case 'rpc_unavailable': return 'unavailable';
    default: return null; // balance_ok, no_player
  }
}

/** CLAIM DEVNET SOL (D-098): the persistent, server-driven faucet control on
 * the land screen and in the welcome dialog. Every label is a projection of
 * the status DTO — amount, cap, the cooldown instant — and the client does no
 * policy math of its own. DEVNET ONLY: renders nothing elsewhere; remove with
 * the faucet. */
export function DevnetSolClaim({ wallet, faucet }: { wallet: string; faucet: FaucetHandle }): React.JSX.Element | null {
  const view = devnetSolClaimView(faucet);
  const s = faucet.status;
  const nextAt = view === 'cooldown' && s?.nextEligibleAt ? Date.parse(s.nextEligibleAt) : null;
  // Coarse 30 s countdown (the label is "2h 36m"); once the instant passes the
  // server is asked again so CLAIM reappears without a reload.
  const [now, setNow] = useState(() => Date.now());
  const refresh = faucet.refresh;
  useEffect(() => {
    if (nextAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= nextAt) refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [nextAt, refresh]);
  if (!view || !s) return null;
  const copyAddr = (): void => {
    void navigator.clipboard?.writeText(wallet);
    bus.emit('ui:toast', { msg: 'ADDRESS COPIED' });
  };
  const line = (text: string, color: string): React.JSX.Element => (
    <div role="status" style={{ color, fontSize: 15, textAlign: 'center', letterSpacing: '1px', lineHeight: 1.35 }}>{text}</div>
  );
  const showNote = s.reason === 'cap_reached' || faucet.phase === 'failed' || faucet.phase === 'unavailable';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {view === 'claim' && (
        <div data-devnet-faucet-claim><Btn variant="gold" fontSize={18} onClick={() => faucet.claim()}>{`CLAIM ${s.grantSol} DEVNET SOL`}</Btn></div>
      )}
      {view === 'funding' && <Btn variant="gold" fontSize={18} disabled>FUNDING…</Btn>}
      {view === 'arrived' && line(`+${s.grantSol} DEVNET SOL ARRIVED`, C.success)}
      {view === 'cooldown' && nextAt !== null && (
        <Btn variant="sec" fontSize={18} disabled>{`NEXT GRANT IN ${fmtDur(Math.ceil((nextAt - now) / 1000))}`}</Btn>
      )}
      {view === 'cap' && line(`IN-GAME FAUCET LIFETIME ${s.grantedSol.toFixed(1)}/${s.lifetimeCapSol.toFixed(1)} SOL USED`, C.gold)}
      {view === 'unavailable' && (
        <>
          {line('FAUCET UNAVAILABLE — TRY AGAIN IN A MINUTE', C.gold)}
          <Btn variant="sec" fontSize={15} onClick={() => faucet.refresh()}>RETRY</Btn>
        </>
      )}
      {showNote && (
        <>
          <div style={{ color: C.textFaint, fontSize: 12, textAlign: 'center', lineHeight: 1.4 }}>{PUBLIC_FAUCET_NOTE}</div>
          <Btn variant="sec" fontSize={15} onClick={copyAddr}>
            COPY MY ADDRESS · {wallet.slice(0, 4)}…{wallet.slice(-4)}
          </Btn>
        </>
      )}
    </div>
  );
}

/** PLAYTEST WELCOME (owner 2026-08-22, replacing the faucet-first guide): the
 * first time a base stands on devnet, tell the player three things — their
 * 5,000 KEEP welcome reward is in MAIL, their wallet is being funded with free
 * devnet SOL automatically (status live from useDevnetFaucet), and the CLAIM
 * DEVNET SOL control (D-098) is theirs to tap whenever they run low. The
 * public faucet is a one-line caveat, shown only when the game itself cannot
 * fund the wallet. DEVNET ONLY: the whole component short-circuits on any
 * other cluster; remove with the faucet. */
function PlaytestWelcome(): React.JSX.Element | null {
  const wallet = useApp((s) => s.wallet);
  const base = useApp((s) => s.base);
  const screen = useApp((s) => s.screen);
  const [open, setOpen] = useState(false);
  const faucet = useDevnetFaucet(wallet, SOLANA_CLUSTER === 'devnet' && !!base && screen === 'base');
  useEffect(() => {
    useApp.getState().setPlaytestWelcomeOpen(open);
    return () => useApp.getState().setPlaytestWelcomeOpen(false);
  }, [open]);
  useEffect(() => {
    if (SOLANA_CLUSTER !== 'devnet') return;
    if (!wallet || !base) return;
    if (localStorage.getItem(`skp_playtest_welcome_seen:${wallet}`)) return;
    // Wallets that dismissed the pre-release guide already hold a base and did
    // NOT receive the KEEP welcome mail (deliveryKey is once per wallet) — the
    // popup would promise it falsely. Backfill is an owner decision (K-047).
    if (localStorage.getItem(`skp_alpha_guide_seen:${wallet}`)) return;
    setOpen(true);
  }, [wallet, base]);
  if (SOLANA_CLUSTER !== 'devnet' || !open || !wallet) return null;
  const dismiss = (): void => {
    localStorage.setItem(`skp_playtest_welcome_seen:${wallet}`, '1');
    setOpen(false);
  };
  // Amounts come from the server's status (never a client constant); until
  // the first answer arrives the line stays generic.
  const grantSol = faucet.status?.grantSol;
  const amount = grantSol === undefined ? '' : `${grantSol} `;
  const reason = faucet.status?.reason;
  const fundingLine = faucet.phase === 'funded'
    ? `+${amount}DEVNET SOL HAS ARRIVED IN YOUR WALLET.`
    : faucet.phase === 'funding' || faucet.phase === 'checking'
      ? `FUNDING YOUR WALLET WITH ${amount}FREE DEVNET SOL…`
      : faucet.phase === 'failed'
        ? 'AUTOMATIC FUNDING DID NOT GO THROUGH — RETRY BELOW.'
        : reason === 'disabled' || reason === 'not_devnet' || (faucet.phase === 'unavailable' && !faucet.status)
          ? 'AUTOMATIC FUNDING IS OFF RIGHT NOW.'
          : faucet.phase === 'unavailable' || reason === 'rpc_unavailable'
            ? 'AUTOMATIC FUNDING IS DELAYED — IT ARRIVES ON ITS OWN, OR RETRY BELOW.'
          : reason === 'balance_ok'
            ? 'YOUR WALLET ALREADY HOLDS DEVNET SOL.'
            : reason === 'cap_reached'
              ? 'THE IN-GAME FAUCET HAS PAID YOU ITS PLAYTEST LIFETIME MAXIMUM.'
              : reason === 'cooldown'
                ? 'THE IN-GAME FAUCET TOPS YOU UP AGAIN WHEN YOU RUN LOW — SEE BELOW.'
                : 'YOUR WALLET IS FUNDED WITH FREE DEVNET SOL AUTOMATICALLY.';
  // D-098: cap, cooldown and RPC hiccups are DevnetSolClaim's to show (with
  // its own public-faucet caveat); this block is only for the cases where the
  // control has nothing to stand on — the faucet is off, or the server never
  // answered — so the dialog never carries two COPY MY ADDRESS buttons.
  const showFaucetFallback = reason === 'disabled' || reason === 'not_devnet'
    || ((faucet.phase === 'failed' || faucet.phase === 'unavailable') && !faucet.status);
  return (
    <div role="dialog" aria-label="Welcome to the playtest" className="interactive" style={{
      position: 'absolute', inset: 0, zIndex: 1700, display: 'grid', placeItems: 'center',
      background: 'rgba(10,9,13,.78)', padding: 16, overflowY: 'auto',
    }}>
      <Panel9 style={{ maxWidth: 440, width: '100%', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', padding: '18px 18px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ color: C.goldHi, fontSize: 22, letterSpacing: '2px', textAlign: 'center' }}>
          ⚔ WELCOME TO THE PLAYTEST
        </div>
        <div style={{ color: C.textDim, fontSize: 15, lineHeight: 1.45 }}>
          Your Keep stands. Two gifts are waiting so you can play right away:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ flex: 'none', width: 26, height: 26, display: 'grid', placeItems: 'center', border: `2px solid ${C.gold}`, color: C.goldHi, fontSize: 15 }}>1</span>
            <span style={{ color: C.text, fontSize: 14, lineHeight: 1.4 }}>
              <b style={{ color: C.goldHi }}>{PLAYTEST.welcomeKeep.toLocaleString('en-US')} KEEP</b> is in your MAIL. Tap your Keep (top-left), open MAIL and tap CLAIM.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ flex: 'none', width: 26, height: 26, display: 'grid', placeItems: 'center', border: `2px solid ${C.gold}`, color: C.goldHi, fontSize: 15 }}>2</span>
            <span style={{ color: C.text, fontSize: 14, lineHeight: 1.4 }} role="status" aria-live="polite">
              {fundingLine}
              <span style={{ display: 'block', color: C.textFaint, fontSize: 13, marginTop: 2 }}>
                This playtest runs on Solana DEVNET: SOL here is free test SOL. You need a little to claim your land on the globe.
              </span>
            </span>
          </div>
        </div>
        <DevnetSolClaim wallet={wallet} faucet={faucet} />
        {showFaucetFallback && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, border: `2px solid ${C.borderLt}`, padding: '8px 10px' }}>
            <div style={{ color: C.textDim, fontSize: 13, letterSpacing: '.5px' }}>IF THE GAME CANNOT FUND YOU</div>
            <div style={{ color: C.textFaint, fontSize: 12, lineHeight: 1.4 }}>
              SEND DEVNET SOL TO YOUR GAME WALLET FROM ANY OTHER WALLET. {PUBLIC_FAUCET_NOTE}
            </div>
            <Btn variant="sec" fontSize={15} onClick={() => {
              void navigator.clipboard?.writeText(wallet);
              bus.emit('ui:toast', { msg: 'ADDRESS COPIED' });
            }}>
              COPY MY ADDRESS · {wallet.slice(0, 4)}…{wallet.slice(-4)}
            </Btn>
          </div>
        )}
        <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.4 }}>
          Everything else — shards, troops, more KEEP — you earn by playing. Your MAIL keeps these steps.
        </div>
        <Btn variant="gold" fontSize={18} style={{ flexShrink: 0 }} onClick={dismiss}>LET'S BUILD</Btn>
      </Panel9>
    </div>
  );
}

function ToastHost(): React.JSX.Element | null {
  const [msg, setMsg] = useState<string | null>(null);
  const screen = useApp((s) => s.screen);
  const viewport = useWindowSize();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = bus.on('ui:toast', ({ msg: m }) => {
      setMsg(m);
      // soft UI tap under the toast (§3.11) — quiet so it layers cleanly beneath
      // any richer source sound (claim chime, confirm, etc.).
      playSfx('sfx_tap', { volume: 0.4 });
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 1600);
    });
    return () => { off(); clearTimeout(timer); };
  }, []);
  if (!msg) return null;
  return <Toast msg={msg} top={screen === 'base' || screen === 'build'
    ? `calc(${tutorialSurfaceInsets(viewport.w, viewport.h).top + 8}px + env(safe-area-inset-top))` : 16} />;
}

async function loadServerState(signal?: AbortSignal): Promise<boolean> {
  const read = <T,>(path: string): Promise<T> => signal
    ? api.get<T>(path, { signal })
    : api.get<T>(path);
  const guard = captureBaseSnapshotGuard();
  const directory = await read<BasesDto>('/bases').catch((cause: unknown) => {
    // Rolling deploy compatibility: an older/flag-off server has no capability
    // route, so preserve its exact legacy /base behavior.
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  });
  signal?.throwIfAborted();
  if (!isBaseSnapshotGuardCurrent(guard)) throw new AuthChangedError();
  const state = useApp.getState();
  state.setBaseDirectory(directory);

  let baseId: string | null = null;
  if (baseSelectorAvailable(directory)) {
    const preferred = state.selectedBaseId
      ?? (state.wallet ? readDeviceSelectedBaseId(state.wallet) : null);
    baseId = resolveFreshBaseId(directory!, preferred);
    if (!baseId && directory!.bases.length === 0) {
      // FRESH WALLET: there is nothing to select — founding the free starter
      // base here (GET /base with no baseId creates the deedless identity +
      // starting Keep idempotently) drops the player straight into the game
      // and the tutorial. Routing them to the BASES screen instead showed
      // "select a base / buy a land deed" as their first-ever screen — the
      // top of the funnel died there (PostHog 2026-08-16: 87% never finished
      // onboarding; owner: "base selection is harsh on player").
      try {
        await read(baseStatePath(null));
        const founded = await read<BasesDto>('/bases');
        signal?.throwIfAborted();
        if (!isBaseSnapshotGuardCurrent(guard)) throw new AuthChangedError();
        state.setBaseDirectory(founded);
        baseId = resolveFreshBaseId(founded, null);
      } catch (cause) {
        signal?.throwIfAborted();
        if (!isBaseSnapshotGuardCurrent(guard)) throw new AuthChangedError();
        // Failure to load a fresh base is not proof that the player must pick
        // another deed. Preserve the real gate or recoverable entry failure.
        throw cause;
      }
    }
    if (!baseId) {
      clearBaseSnapshot(false);
      return false;
    }
  }

  try {
    const committed = await hydrateBaseSnapshot(baseId, guard, signal);
    if (!committed && !isBaseSnapshotGuardCurrent(guard)) {
      const current = useApp.getState();
      // Another read may have adopted this exact initial selection first. Its
      // coherent base/balance commit increments the epoch once; that is success,
      // not a user switch. Any additional intent or auth change still fails closed.
      const adoptedByPeer = current.wallet === guard.wallet && current.selectedBaseId === baseId
        && current.baseSelectionEpoch === guard.selectionEpoch + Number(guard.selectedBaseId !== baseId)
        && current.base !== null && current.balances !== null
        && (!baseId || current.base.baseId === baseId);
      if (!adoptedByPeer) throw new AuthChangedError();
    }
    // A base that just loaded is the moment to say it was raided (D-099); the
    // helper stamps a first-seen deed silently and toasts once per session.
    if (committed) announceDefences(useApp.getState().base);
    return committed || useApp.getState().base !== null;
  } catch (cause) {
    if (!(cause instanceof BaseSnapshotMismatchError)) throw cause;
    bus.emit('ui:toast', { msg: 'BASE RESPONSE DID NOT MATCH YOUR FRESH OWNERSHIP' });
    return useApp.getState().base !== null;
  }
}

function raidTargetFromRecovery(target: RaidRecoveryTarget): RaidTarget {
  return target as RaidTarget;
}

/** Decide navigation only after the selected base is freshly hydrated. This is
 * shared by cold session restore, explicit sign-in and lifecycle wakeups so an
 * active march always wins over a queued notification deep link. */
export async function raidRecoveryDestination(signal?: AbortSignal): Promise<{
  screen: 'battle' | 'raidlog'; guard: BaseSnapshotGuard;
} | null> {
  if (divineBattleSession.getSnapshot()) return null;
  const trialEpoch = divineBattleSession.getEpoch();
  const ownsOrdinaryView = () => !divineBattleSession.getSnapshot() && trialEpoch === divineBattleSession.getEpoch();
  const before = useApp.getState();
  const wallet = before.wallet;
  const baseId = before.selectedBaseId ?? before.base?.baseId ?? null;
  if (!before.authed || !wallet || !baseId) return null;
  const guard = captureBaseSnapshotGuard();
  const key = `${wallet}:${baseId}:${guard.selectionEpoch}`;
  const recover = async () => {
    const trialAbort = new AbortController();
    const offTrial = divineBattleSession.subscribe(() => { if (!ownsOrdinaryView()) trialAbort.abort(); });
    const recoverySignal = signal ? AbortSignal.any([signal, trialAbort.signal]) : trialAbort.signal;
    try {
    const decision = await reconcileRaidResume({
      client: { get: async <T,>(path: string) => {
        if (!ownsOrdinaryView()) throw new Error('Battle view changed');
        const value = await api.get<T>(path, { signal: recoverySignal });
        if (!ownsOrdinaryView()) throw new Error('Battle view changed');
        return value;
      } },
      storage: browserRaidResumeStorage(),
      wallet,
      baseId,
      simVersion: SIM_VERSION,
    });
    signal?.throwIfAborted();
    if (!ownsOrdinaryView() || !useApp.getState().authed || !isBaseSnapshotGuardCurrent(guard)) return null;
    let recoveredGuard = guard;
    if (decision.kind === 'resume' && decision.raid.attackerBaseId
      && (decision.raid.attackerBaseId !== guard.selectedBaseId
        || useApp.getState().base?.baseId !== decision.raid.attackerBaseId)) {
      // Base, selected identity and balances commit together. A newer user switch
      // or logout invalidates this guard even before its own request completes.
      const targetBaseId = decision.raid.attackerBaseId;
      if (!await hydrateBaseSnapshot(targetBaseId, guard, recoverySignal)) return null;
      recoveredGuard = {
        ...guard, selectedBaseId: targetBaseId,
        selectionEpoch: guard.selectionEpoch + (guard.selectedBaseId === targetBaseId ? 0 : 1),
      };
    }
    const current = useApp.getState();
    if (!ownsOrdinaryView() || !current.authed || !isBaseSnapshotGuardCurrent(recoveredGuard)) return null;

    if (decision.kind === 'history') return { screen: 'raidlog' as const, guard: recoveredGuard };
    if (decision.kind === 'resume' || decision.kind === 'watch'
      || decision.kind === 'result' || decision.kind === 'offline') {
      current.setRaidTarget({
        ...raidTargetFromRecovery(decision.target),
        recoveryEpoch: Date.now(),
        ...(decision.kind === 'offline' ? { reconnecting: true as const } : {}),
      });
      if (decision.kind === 'offline') {
        bus.emit('ui:toast', { msg: 'RAID OFFLINE — RECONNECTING' });
      } else if (current.screen !== 'battle') {
        bus.emit('ui:toast', { msg: decision.kind === 'result'
          ? 'YOUR RAID SETTLED WHILE YOU WERE AWAY'
          : 'RETURNED TO YOUR UNFINISHED RAID' });
      }
      return { screen: 'battle' as const, guard: recoveredGuard };
    }
    return null;
    } finally { offTrial(); }
  };
  // A bounded restore owns its cancellation. Lifecycle probes still share a
  // flight; they must not keep a timed-out restore or its retry waiting.
  return signal ? recover() : reconcileRaidResumeSingleFlight(key, recover);
}

/** Load state and drop into the base — or route to the paywall on 402 (the
 * server is authoritative about entry payment; a stale entryPaid flag here
 * must never skip it). Shared by TitleScreen and EntryScreen.
 * NEVER throws: callers fire-and-forget from effects, and an unhandled
 * rejection here would strand the player on a dead screen (post-entry
 * black-screen incident, owner 2026-07-24) — surface a toast and stay put
 * instead; the next poll/interaction retries. Exported for the land screen
 * (./land/EntryScreen.tsx), which receives it as a prop. */
let entryFlight: { key: string; promise: Promise<GameEntryResult> } | null = null;
export function enterGame(): Promise<GameEntryResult> {
  const initial = useApp.getState();
  if (!initial.authed || !initial.wallet) return Promise.resolve({ ok: false });
  const authGeneration = authCookies.captureGeneration();
  const key = `${initial.wallet}:${initial.baseSelectionEpoch}:${authGeneration}`;
  if (entryFlight?.key === key) return entryFlight.promise;
  const controller = new AbortController();
  let identityChanged = false;
  const unsubscribe = useApp.subscribe((next, previous) => {
    if (next.authed !== previous.authed || next.wallet !== previous.wallet) {
      identityChanged = true; controller.abort();
    }
  });
  const current = (): boolean => !identityChanged && authCookies.current(authGeneration) && useApp.getState().authed
    && useApp.getState().wallet === initial.wallet;
  const owned = { key, promise: Promise.resolve<GameEntryResult>({ ok: false }) };
  entryFlight = owned;
  useGameEntryState.setState({ busy: true, error: null });
  track(EVENTS.AUTH_SESSION_PHASE, { operation: 'game', phase: 'loading' });
  owned.promise = (async (): Promise<GameEntryResult> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const load = async (): Promise<GameEntryResult> => {
        const selected = await loadServerState(controller.signal);
        if (controller.signal.aborted || !current()) return { ok: false };
        owned.key = `${initial.wallet}:${useApp.getState().baseSelectionEpoch}:${authGeneration}`;
        if (!selected) {
          useApp.getState().setScreen('bases');
          bus.emit('ui:toast', { msg: 'CHOOSE AN ACTIVE BASE ON THIS DEVICE' });
          return { ok: true };
        }
        const hydratedGuard = captureBaseSnapshotGuard();
        const recovered = await raidRecoveryDestination(controller.signal);
        if (controller.signal.aborted || !current()
          || !isBaseSnapshotGuardCurrent(recovered?.guard ?? hydratedGuard)) return { ok: false };
        useApp.getState().setScreen(recovered?.screen ?? 'base');
        if (!recovered) bus.emit('base:refresh', undefined);
        return { ok: true };
      };
      return await Promise.race([load(), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error('Game loading timed out.')); }, SESSION_HYDRATION_TIMEOUT_MS);
      })]);
    } catch (error) {
      if (!current()) return { ok: false };
      if (error instanceof ApiError && error.status === 402) {
        useApp.getState().setEntryPaid(false);
        useApp.getState().setScreen('entry');
        return { ok: true };
      }
      if (isAlphaGated(error)) { useApp.getState().setScreen('alphagate'); return { ok: true }; }
      if (isBaseClientUpgradeRequired(error)) {
        useApp.getState().setScreen('bases');
        return { ok: true };
      }
      if (isBaseSelectionError(error)) return { ok: false };
      useGameEntryState.setState({ error: 'You are signed in. Check your connection and retry entering the game.' });
      track(EVENTS.AUTH_SESSION_PHASE, { operation: 'game', phase: 'retry' });
      return { ok: false };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      if (entryFlight === owned) { entryFlight = null; useGameEntryState.setState({ busy: false }); }
    }
  })();
  return owned.promise;
}
