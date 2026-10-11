/**
 * App shell: wallet providers (Wallet Standard auto-detects injected wallets;
 * mobile Phantom uses its direct provider to avoid a second account store; MWA
 * registers via wallet-standard-mobile on Android Chrome/TWA), react-query, the Phaser
 * canvas underneath, and the screen overlay on top.
 *
 * PrivyProvider (social/email → embedded Solana wallet) wraps the tree ABOVE the
 * wallet-adapter providers, but ONLY when VITE_PRIVY_APP_ID is set — so the app
 * runs unchanged for wallet-only users and in envs without a Privy key.
 */
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import type { Adapter, WalletError } from '@solana/wallet-adapter-base';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivyProvider } from '@privy-io/react-auth';
import { createSolanaRpc, createSolanaRpcSubscriptions, devnet } from '@solana/kit';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { isSolanaMobileAssetPackClient } from './lib/assetPack';
import gameFontUrl from './assets/fonts/VT323-latin-v18.woff2?url';
import { installAudioUnlock, setMusicScreen } from './lib/audio';
import { bus, walletErrorNotice } from './lib/events';
import { SOLANA_CLUSTER, SOLANA_RPC_URL, SOLANA_WS_URL } from './lib/cluster';
import { registerMwa } from './lib/mwa';
import {
  captureDeepLinkFromUrl, parseDeepLinkScreen, setPendingDeepLink,
  takePendingDeepLinkOnBaseEntry,
} from './lib/deepLink';
import { installMobileBackGuard } from './lib/mobileBackGuard';
import { applyLandscapePref, naturalCompletionToasts, watchJobsForNotifications } from './lib/mobileShell';
import { resumePushSessionAndSync, syncPushSubscription } from './lib/pushSubscription';
import { caps } from './lib/platform';
import { BUILD, versionedPublicAsset } from './lib/version';
import { gameWorkerBootBlocked, waitForGameWorker, type GameWorkerReadiness } from './lib/sw';
import { setAuthCookieDiagnosticHandler, setAuthCookieInvalidatedHandler } from './auth/authCookieCoordinator';
import { EVENTS, track } from './lib/analytics';
import { cancelNativeSignIn } from './auth/useAuth';
import { useLoginChallenge } from './auth/loginChallenge';
import { useDetectedMobilePhantomAdapters } from './auth/mobilePhantomAdapter';
import { publishAssetPackGate, startAssetPackTransfer, useAssetPackGate } from './state/assetPackGate';
import { useApp } from './state/store';
import { UpdateGate } from './ui/UpdateGate';

/**
 * The game canvas, and the whole Phaser engine with it, loads on demand.
 *
 * Phaser plus the scene graph is the single largest dependency in the client,
 * and none of it is needed for the loading screen, the title, wallet connect or
 * the entry paywall — the screens every first-time player sees before they ever
 * reach a base. Splitting it here is only possible because two other things were
 * fixed first: lib/events.ts no longer VALUE-imports Phaser (it pinned the
 * engine into the entry chunk regardless of this boundary), and the loading
 * screen no longer gates the title on `booted` (it would have waited forever for
 * a scene that had not been imported).
 *
 * Mounted eagerly but loaded lazily: React starts fetching the chunk on first
 * render, so by the time a player finishes connecting a wallet it is almost
 * always already there. Suspense falls back to nothing — the canvas sits behind
 * the overlay, so there is no spinner to show.
 */
const LoginProtectionGate = lazy(() => import('./auth/LoginProtectionGate').then((m) => ({ default: m.LoginProtectionGate })));

const PhaserGame = lazy(() => import('./game/PhaserGame').then((m) => ({ default: m.PhaserGame })));

import { Overlay } from './ui/Overlay';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { GameLoadBoundary } from './ui/GameLoadBoundary';
import { Btn, COLORS } from './ui/primitives';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
const PRIVY_CLIENT_ID = import.meta.env.VITE_PRIVY_CLIENT_ID as string | undefined;
const WALLET_CONNECTION_CONFIG = { wsEndpoint: SOLANA_WS_URL };

const GAME_FONT_LOAD_TIMEOUT_MS = 10_000;

/** Phaser rasterizes Text once and does not redraw it when a web font arrives.
 * Keep the React loading/title UI visible, but do not mount the canvas until the
 * exact pinned local face has decoded successfully. */
export function useGameFontReady(enabled: boolean): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let loadController: AbortController | undefined;
    let attempts = 0;

    const load = (): void => {
      loadController = new AbortController();
      const timeout = setTimeout(() => loadController?.abort(), GAME_FONT_LOAD_TIMEOUT_MS);
      void fetch(gameFontUrl, { cache: 'force-cache', signal: loadController.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error(`VT323 fetch failed with HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const face = await new FontFace('VT323', bytes, { style: 'normal', weight: '400' }).load();
          if (!live) return;
          document.fonts.add(face);
          setReady(true);
        }).catch((error: unknown) => {
          if (!live) return;
          attempts += 1;
          console.error('[font] VT323 preload failed; retrying before Phaser mounts', error);
          retryTimer = setTimeout(load, Math.min(500 * (2 ** (attempts - 1)), 5_000));
        }).finally(() => {
          clearTimeout(timeout);
        });
    };

    load();

    return () => {
      live = false;
      loadController?.abort();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [enabled]);

  return ready;
}

/** Read synchronously so the first render cannot start Boot under an old worker.
 * Once ready, the waiter detaches; a later update cannot unmount a live raid. */
export function useGameWorkerReady(): { state: GameWorkerReadiness; retry: () => void } {
  const [state, setState] = useState<GameWorkerReadiness>(() => gameWorkerBootBlocked() ? 'waiting' : 'ready');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => waitForGameWorker(setState, attempt > 0), [attempt]);
  return { state, retry: () => setAttempt((previous) => previous + 1) };
}

/** The one RPC endpoint the client talks to — wallet-adapter's ConnectionProvider
 *  AND Privy's Solana hooks both read it, so an embedded wallet and an injected
 *  wallet can never end up pointed at different clusters. */
/**
 * Privy's `useSolanaRpcClient` throws "No RPC configuration found for chain
 * solana:devnet" unless the app supplies an RPC for the chain in use — its own
 * defaults only cover chains enabled in the Privy dashboard, and devnet is not
 * one of them. Without this the social-login flow dies BEFORE it can mint a
 * SIWS session, which is why a Privy login left the player with no session and
 * an empty plot (owner report 2026-07-26). Built once at module scope: the
 * config object identity is stable, so the provider does not re-init per render.
 */
const DEVNET_SOLANA_RPCS = SOLANA_CLUSTER === 'devnet' ? {
  'solana:devnet': {
    // devnet()/testnet() are compile-time brands (identity at runtime) that tell
    // kit which api surface the endpoint serves — without one it infers the
    // all-clusters union, which lacks the airdrop method Privy's type demands.
    rpc: createSolanaRpc(devnet(SOLANA_RPC_URL)),
    rpcSubscriptions: createSolanaRpcSubscriptions(devnet(SOLANA_WS_URL), {
      maxSubscriptionsPerChannel: 8, minChannels: 1,
    }),
  },
} : undefined;

/** Mount PrivyProvider only when configured; otherwise render children as-is so
 *  wallet-only users and key-less envs are unaffected. */
function MaybePrivy({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (!PRIVY_APP_ID) return <>{children}</>;
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      {...(PRIVY_CLIENT_ID ? { clientId: PRIVY_CLIENT_ID } : {})}
      config={{
        loginMethods: ['google', 'twitter', 'email'],
        // Match the game's own chrome (owner 2026-07-26: the default modal "looks
        // off during login"). Privy renders its modal in our DOM, so its theme and
        // accent take the same ink/gold palette as ui/primitives COLORS — the
        // login stops looking like a third-party interruption and reads as part of
        // the kingdom. The pixel FONT cannot be pushed into their components, so
        // the wordmark plus our copy carry the identity instead.
        appearance: {
          theme: '#1A171E',        // COLORS.ink — the game's darkest surface
          accentColor: '#E3AE3C',  // COLORS.gold — same as every primary button
          logo: versionedPublicAsset('/brand/brand_logo_main.png'),
          landingHeader: 'ENTER THE KINGDOM',
          loginMessage: 'Claim your keep. Your wallet is created for you — no seed phrase to write down.',
          showWalletLoginFirst: false, // social/email first: that is who this flow is for
        },
        embeddedWallets: {
          // Social login is a distinct, stable identity path. `users-without-wallets`
          // skips creation when the Privy account merely has a linked external
          // wallet, which can leave this flow without the embedded signer promised
          // by the launch-screen copy (or accidentally authenticate as that external
          // wallet). `all-users` guarantees the Solana signer before login completes.
          solana: { createOnLogin: 'all-users' },
          // The GAME is the confirmation surface (our PAY/BUY buttons state the
          // price); Privy's own near-black confirmation modal is redundant AND
          // its backdrop could stick over the app after signing (black-screen
          // incident, owner 2026-07-24). Silent signing for the embedded wallet.
          showWalletUIs: false,
        },
        // Key-export MFA (ONRAMP-WALLETS-PLAN Flow B): client-created wallets can
        // be exported by an authenticated Privy client, outside our UI and API.
        // Vendor MFA enrollment is therefore required before SecurityScreen
        // exposes its export action. Once enrolled, false (the default, pinned
        // here) lets Privy show its verification modal for MFA-protected actions
        // such as exportWallet(). SHARDKEEP's server challenge is explicitly
        // defense in depth for our button, not a vendor-enforced export policy.
        // showWalletUIs:false above silences transaction-confirmation UIs only;
        // enrollment and MFA verification modals still render.
        mfa: { noPromptOnMfaRequired: false },
        // Privy's installed type only accepts the test-cluster RPC surface here
        // (it requires requestAirdrop). Supply our explicit map on devnet; on
        // mainnet omit it and use the mainnet RPC configured in Privy's dashboard
        // instead of weakening the types with a cast that could cross clusters.
        ...(DEVNET_SOLANA_RPCS ? { solana: { rpcs: DEVNET_SOLANA_RPCS } } : {}),
      }}
    >
      {children}
    </PrivyProvider>
  );
}

/**
 * The SECOND unbranded escape hatch, and the one removing WalletModalProvider
 * does not close. With no `onError`, WalletProviderBase falls back to its own
 * handler, which on a WalletNotReadyError does `window.open(adapter.url,
 * '_blank')` — for the MWA wallet that url is hardcoded solanamobile.com/wallets,
 * the exact dead end mwa.ts's onWalletNotFound was written to replace. It fires
 * from handleConnect AND from every adapter-emitted 'error' event, so it can rip
 * a tab open at any moment, including during autoConnect with no sheet on screen.
 *
 * Supplying a handler at all closes that hatch. WalletProvider is also the sole
 * owner of connect(), so its rejection has no component promise to catch; send a
 * sanitized notice to ConnectSheet, which renders connectError() under the row
 * that failed and leaves every other route tappable.
 *
 * Module scope so the identity is stable: an inline arrow re-runs the provider's
 * onError effect on every render of App.
 */
function onWalletError(error: WalletError, adapter?: Adapter): void {
  const notice = walletErrorNotice(error, adapter?.name ?? null);
  console.error(`[wallet:${notice.walletName ?? 'unknown'}] ${notice.name}: ${notice.message}`);
  bus.emit('wallet:error', notice);
}

/** Android cannot run a TWA during APK installation, so its exact equivalent is
 * a build-bound first-launch gate. The query marker is baked into the APK's
 * startUrl and persists locally; normal browser tabs never enter this effect.
 *
 * The gate state lives in state/assetPackGate — a slice only the title, loading
 * and background-status surfaces subscribe to. This hook owns nothing but the
 * transfer's lifetime: one scheduler per attempt, restarted by RETRY. */
export function useAssetPackTransfer(): void {
  // Like the normal SW registrar, never install persistent caches over Vite's
  // mutable development graph. Production preview/E2E exercises the real gate.
  const required = useMemo(() => !import.meta.env.DEV && isSolanaMobileAssetPackClient(), []);
  const attempt = useAssetPackGate((s) => s.attempt);

  useEffect(() => {
    if (!required) return;
    // `checking` until boot:ready lets the transfer start — the loading bar
    // reads the same phase it always showed before the worker took control.
    publishAssetPackGate({ kind: 'checking' });
    return startAssetPackTransfer({ build: BUILD.gitSha });
  }, [attempt, required]);
}

export function App(): React.JSX.Element {
  const endpoint = SOLANA_RPC_URL;
  // Phantom mobile publishes two independently stateful APIs. Register one
  // adapter over the injected provider and never ask its Wallet Standard twin
  // to connect; all other Wallet Standard wallets still self-register.
  const wallets = useDetectedMobilePhantomAdapters(caps.platform);
  useAssetPackTransfer();
  const gameFontReady = useGameFontReady(true);
  const gameWorker = useGameWorkerReady();

  useEffect(() => {
    setAuthCookieDiagnosticHandler((event) => track(EVENTS.AUTH_SESSION_PHASE, { operation: 'cookie', ...event }));
    setAuthCookieInvalidatedHandler(() => {
      cancelNativeSignIn('cross_tab');
      useLoginChallenge.getState().setWallet(null);
      const state = useApp.getState();
      state.setAuth(null);
      state.setScreen('title');
    });
    registerMwa();
    installAudioUnlock(); // arm Web Audio on the first user gesture (GDD §3.11)
    const removeMobileBackGuard = installMobileBackGuard();
    // Solana-Mobile shell prefs (owner 2026-08-16): honor a stored landscape
    // lock at boot, and keep the away-from-tab upgrade-finished notifier fed
    // with the live builder-job list.
    applyLandscapePref();
    setMusicScreen(useApp.getState().screen);
    // Push notifications (D-101). `?screen=` is a push's landing target; it is
    // stashed until the store enters an authoritative hydrated base. The
    // subscription re-syncs after EVERY authenticated boot because UPDATE NOW
    // unregisters the worker and the PushSubscription dies with it. Waiting for
    // auth also binds a shared device's endpoint to the wallet now signed in.
    captureDeepLinkFromUrl();
    const syncPushForAuthenticatedWallet = (): void => {
      if (!import.meta.env.DEV && useApp.getState().authed) void syncPushSubscription();
    };
    const resumePushForAuthenticatedWallet = (): void => {
      if (!import.meta.env.DEV && useApp.getState().authed) void resumePushSessionAndSync();
    };
    resumePushForAuthenticatedWallet();
    const onWorkerMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; screen?: unknown; kind?: unknown } | null;
      if (data?.type === 'notification-received') {
        if (data.kind === 'mail') bus.emit('mail:refresh', undefined);
        return;
      }
      const screen = data?.type === 'open-screen' ? parseDeepLinkScreen(data.screen) : null;
      if (!screen) return;
      // A hydrated game routes at once; anything earlier (loading, title, the
      // paywall) hands the target to the base-entry point instead. A running
      // battle or scout is never torn down by a shade tap.
      const { base, screen: current, setScreen } = useApp.getState();
      if (current === 'battle' || current === 'scout') {
        setPendingDeepLink(screen);
      } else if (base) {
        if (current !== screen) setScreen(screen);
      } else {
        setPendingDeepLink(screen);
      }
    };
    const worker = 'serviceWorker' in navigator ? navigator.serviceWorker : null;
    worker?.addEventListener('message', onWorkerMessage);
    worker?.addEventListener('controllerchange', syncPushForAuthenticatedWallet);
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.screen !== previous.screen) setMusicScreen(state.screen);
      if (state.authed && (!previous.authed || state.wallet !== previous.wallet)) {
        resumePushForAuthenticatedWallet();
      }
      if (state.base !== previous.base) {
        for (const msg of naturalCompletionToasts(previous.base, state.base, Date.now())) {
          bus.emit('ui:toast', { msg });
        }
      }
      const deepLink = takePendingDeepLinkOnBaseEntry({
        hydrated: state.base !== null,
        wasHydrated: previous.base !== null,
        screen: state.screen,
        previousScreen: previous.screen,
      });
      if (deepLink) state.setScreen(deepLink);
      if (state.base?.jobs !== previous.base?.jobs) {
        watchJobsForNotifications(state.base?.jobs ?? []);
      }
    });
    return () => {
      setAuthCookieInvalidatedHandler(null);
      setAuthCookieDiagnosticHandler(null);
      removeMobileBackGuard();
      unsubscribe();
      worker?.removeEventListener('message', onWorkerMessage);
      worker?.removeEventListener('controllerchange', syncPushForAuthenticatedWallet);
    };
  }, []);

  return (
    <MaybePrivy>
      <ConnectionProvider endpoint={endpoint} config={WALLET_CONNECTION_CONFIG}>
        {/* NO WalletModalProvider. Its modal only knows how to list
            wallet-standard wallets, so on iOS — no injected provider, and MWA
            never registers there — it renders its empty state and the player is
            stranded. ui/ConnectSheet replaces it. Removing the provider (and its
            stylesheet) is the guarantee it cannot come back: any surviving
            useWalletModal() now throws at mount instead of silently rendering
            the dead end. ConnectionProvider/WalletProvider/autoConnect are
            untouched — wallet-standard still detects every wallet except the
            direct mobile Phantom adapter registered above.
            onError is NOT optional here: see onWalletError above — without it
            the library keeps a second, unbranded window.open() hatch armed. */}
        <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <QueryClientProvider client={queryClient}>
            {/* Solana Mobile installs the complete verified static pack in the
                background, after boot:ready and never during a raid (D-101).
                Phaser keeps the same service-worker/network fallback as a
                browser tab, so a clean install can reach sign-in immediately
                and play online while the optional offline pack is still filling.
                Overlay takes no pack prop: progress ticks reach only the three
                surfaces that subscribe to the assetPackGate slice. */}
            <GameLoadBoundary>
              {gameFontReady && gameWorker.state === 'ready' && <Suspense fallback={null}><PhaserGame /></Suspense>}
            </GameLoadBoundary>
            <ErrorBoundary>
              <Overlay />
            </ErrorBoundary>
            {gameWorker.state === 'error' && <aside role="alert" style={{
              position: 'fixed', top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
              left: 16, right: 16, margin: '0 auto', maxWidth: 360, zIndex: 3500,
              padding: 12, background: COLORS.surface, color: COLORS.text,
              border: `2px solid ${COLORS.border}`, textAlign: 'center',
            }}>
              <p style={{ margin: '0 0 8px' }}>Game update is not ready. Check your connection and try again.</p>
              <Btn onClick={gameWorker.retry} fontSize={16} style={{ minHeight: 44 }}>RETRY GAME UPDATE</Btn>
            </aside>}
            {/* OUTSIDE the ErrorBoundary on purpose: if a stale bundle is
                crashing the overlay, the update prompt is the one thing that
                still has to render — it is the way out of the crash. */}
            <UpdateGate />
            <Suspense fallback={null}><LoginProtectionGate /></Suspense>
          </QueryClientProvider>
        </WalletProvider>
      </ConnectionProvider>
    </MaybePrivy>
  );
}
