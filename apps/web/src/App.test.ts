/**
 * The connect flow must have NO unbranded escape hatch. wallet-adapter ships two,
 * and dropping the modal only closes the first:
 *
 *  1. WalletModalProvider — its modal lists wallet-standard wallets and nothing
 *     else, so on iOS it renders an empty state and strands the player. Removed;
 *     any surviving useWalletModal() now throws at mount instead.
 *  2. WalletProviderBase's DEFAULT error handler, which is what runs when no
 *     `onError` prop is passed: on a WalletNotReadyError it does
 *     `window.open(adapter.url, '_blank')`. For the MWA wallet that url is the
 *     hardcoded solanamobile.com/wallets — the exact destination mwa.ts's
 *     onWalletNotFound exists to replace. It fires from handleConnect AND from
 *     every adapter-emitted 'error' event, so it can open a tab with no sheet on
 *     screen at all (autoConnect).
 *
 * A source guard rather than a behaviour test because this repo mounts no React
 * harness (see ui/screens/admin.test.tsx), and because the rule is about what the
 * provider is CONSTRUCTED with — a prop that is absent has no runtime surface to
 * assert on. Same instrument as platform.test.ts's width guard.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const sheetSrc = readFileSync(new URL('./ui/ConnectSheet.tsx', import.meta.url), 'utf8');
const overlaySrc = readFileSync(new URL('./ui/Overlay.tsx', import.meta.url), 'utf8');
const packSrc = readFileSync(new URL('./lib/assetPack.ts', import.meta.url), 'utf8');
const gateSrc = readFileSync(new URL('./state/assetPackGate.ts', import.meta.url), 'utf8');
/** the code, minus comments — the comments name both hatches by design */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const sheetCode = sheetSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const packCode = packSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the wallet providers may not keep an unbranded escape hatch armed', () => {
  it('uses the single validated cluster RPC and omits Privy\'s devnet-branded map on mainnet', () => {
    expect(code).toMatch(/const endpoint = SOLANA_RPC_URL/);
    expect(code).toMatch(/SOLANA_CLUSTER === 'devnet'/);
    expect(code).toMatch(/DEVNET_SOLANA_RPCS \? \{ solana: \{ rpcs: DEVNET_SOLANA_RPCS \} \} : \{\}/);
    expect(code).not.toMatch(/const SOLANA_CHAIN = 'solana:devnet'/);
  });

  it('always creates the dedicated Privy Solana signer promised by social login', () => {
    expect(code).toMatch(/solana:\s*\{\s*createOnLogin:\s*'all-users'\s*\}/);
    expect(code).not.toMatch(/createOnLogin:\s*'users-without-wallets'/);
  });

  it('passes onError to WalletProvider — without it the library force-opens adapter.url in a new tab', () => {
    const tag = /<WalletProvider\b[^>]*>/.exec(code)?.[0];
    expect(tag, 'App must mount WalletProvider').toBeDefined();
    expect(tag).toMatch(/\sonError=/);
  });

  it('routes the provider-owned error to ConnectSheet instead of hiding it', () => {
    // The handler exists and is a real function, not `onError={undefined}` (which
    // reinstates the default handler verbatim).
    expect(code).toMatch(/function onWalletError\s*\(/);
    expect(code).not.toMatch(/onError=\{undefined\}/);
    expect(code).toMatch(/bus\.emit\('wallet:error',\s*notice\)/);
    expect(sheetCode).toMatch(/bus\.on\('wallet:error'/);
  });

  it('keeps WalletProvider as connection owner, including an already-selected Phantom retry', () => {
    const tag = /<WalletProvider\b[^>]*>/.exec(code)?.[0];
    expect(tag).toMatch(/\bautoConnect\b/);
    const walletFields = /const\s*\{([^}]*)\}\s*=\s*useWallet\(\)/.exec(sheetCode)?.[1];
    expect(walletFields).toBeDefined();
    expect(walletFields).toMatch(/connect:\s*connectSelectedWallet/);
    expect(sheetCode).toMatch(/select\(name as WalletName\)/);
    expect(sheetCode).toMatch(/wallet\?\.adapter === direct && !connected/);
    expect(sheetCode).toMatch(/void connectSelectedWallet\(\)\.catch/);
    expect(sheetCode).not.toMatch(/direct\.connect\s*\(/);
  });

  it('registers the direct mobile Phantom adapter while preserving Wallet Standard discovery', () => {
    expect(code).toMatch(/useDetectedMobilePhantomAdapters\(caps\.platform\)/);
    expect(code).toMatch(/<WalletProvider wallets=\{wallets\}/);
    expect(sheetCode).toContain("w.adapter.name === 'Phantom'");
    expect(sheetCode).toContain('candidate.adapter.name === MOBILE_PHANTOM_WALLET_NAME');
    expect(sheetCode).not.toContain('primeInjectedPhantom');
  });

  it('never mounts WalletModalProvider — the first hatch stays removed', () => {
    expect(code).not.toMatch(/WalletModalProvider/);
  });

  it('opens no window of its own: the only navigation out of the sheet is a link the player tapped', () => {
    expect(code).not.toMatch(/window\.open/);
  });
});

describe('Solana Mobile asset-pack gate', () => {
  it('installs the complete pack in background while Phaser uses the online fallback', () => {
    expect(code).not.toMatch(/assetPackReady/);
    expect(code).toMatch(/fetch\(gameFontUrl, \{ cache: 'force-cache', signal: loadController\.signal \}\)/);
    expect(code).toMatch(/new FontFace\('VT323', bytes, \{ style: 'normal', weight: '400' \}\)\.load\(\)/);
    expect(code).toMatch(/setTimeout\(\(\) => loadController\?\.abort\(\), GAME_FONT_LOAD_TIMEOUT_MS\)/);
    expect(code).toMatch(/document\.fonts\.add\(face\);\s+setReady\(true\)/);
    expect(code).toMatch(/useGameFontReady\(true\)/);
    expect(code).toMatch(/setTimeout\(load, Math\.min\(500 \* \(2 \*\* \(attempts - 1\)\), 5_000\)\)/);
    expect(code).toMatch(/\{gameFontReady && gameWorker.state === 'ready' && <Suspense fallback=\{null\}><PhaserGame \/><\/Suspense>\}/);
    expect(code).toMatch(/isSolanaMobileAssetPackClient\(\)/);
    expect(code).toMatch(/!import\.meta\.env\.DEV && isSolanaMobileAssetPackClient\(\)/);
    // D-101 (M33 C1): the deferred-control and deploy-race branches moved with
    // the scheduler into state/assetPackGate; D-050's rule survives verbatim.
    expect(gateSrc).toMatch(/cause\.code === 'build-mismatch' && reloadForBuildMismatch\(\)/);
    expect(gateSrc).toMatch(/sessionStorage\.setItem\(key, '1'\);\s*void reloadToLatest\(\)/);
    expect(gateSrc).toContain("publish({ kind: 'not-required' });");
    expect(gateSrc).toContain("serviceWorker.addEventListener('controllerchange', controllerChanged");
    expect(gateSrc).toContain('serviceWorkerControlsAssetPackBuild(serviceWorker.controller, options.build)');
    expect(gateSrc).toContain("required: state.kind !== 'not-required'");
    expect(packCode).not.toContain('close and reopen the game');
  });

  it('holds only the canvas during an old-worker update and exposes a nonmodal retry after failure', () => {
    // The initial value matters: an effect-only check can let lazy Phaser start
    // fetching all Boot atlases through the previous worker before it runs.
    expect(code).toContain("useState<GameWorkerReadiness>(() => gameWorkerBootBlocked() ? 'waiting' : 'ready')");
    expect(code).toContain('useEffect(() => waitForGameWorker(setState, attempt > 0), [attempt])');
    expect(code).toContain('const gameWorker = useGameWorkerReady()');
    expect(code).toMatch(/<\/GameLoadBoundary>\s*<ErrorBoundary>\s*<Overlay \/>\s*<\/ErrorBoundary>/);
    expect(code).toContain("gameWorker.state === 'error' && <aside role=\"alert\"");
    expect(code).toContain('onClick={gameWorker.retry}');
    expect(code).toContain('RETRY GAME UPDATE');
    expect(code).not.toMatch(/window\.location\.reload|aria-modal/);
  });

  it('starts the transfer only after boot:ready and hands Overlay no pack prop (D-101 transfer discipline)', () => {
    // The 250 ms tick used to be a setState in App: the whole un-memoised
    // Overlay re-rendered at 4 Hz for three consumers. The slice is the fix.
    expect(code).toContain('<Overlay />');
    expect(code).not.toMatch(/<Overlay assetPack=/);
    expect(code).toContain('return startAssetPackTransfer({ build: BUILD.gitSha });');
    expect(code).not.toMatch(/ensureAssetPack\(/);
    expect(gateSrc).toContain("bus.on('boot:ready', onBootReady)");
    expect(gateSrc).toContain('if (useApp.getState().booted) onBootReady();');
    // The fantasy map now paints/animates terrain too; optional pack hashing
    // must not compete with parcel inspection and campaign rendering.
    expect(gateSrc).toContain("new Set(['base', 'build', 'layout', 'battle', 'scout', 'map'])");
    expect(gateSrc).toContain('return hidden || CANVAS_GAMEPLAY_SCREENS.has(screen);');
    expect(gateSrc).toContain('ASSET_PACK_TRANSFER.resumeDelayMs');
    expect(packCode).toContain('ASSET_PACK_TRANSFER.progressPublishMs');
    expect(packCode).not.toMatch(/DOWNLOAD_PROGRESS_INTERVAL_MS/);
    // D-101 protects the subscription boundary, not a fixed hook count.
    // LoadingScreen now folds `required` into its selected state instead of
    // subscribing twice; pack ticks must still never reach the Overlay router.
    const loading = overlaySrc.slice(overlaySrc.indexOf('export function LoadingScreen'), overlaySrc.indexOf('// TITLE —'));
    const background = overlaySrc.slice(overlaySrc.indexOf('function AssetPackBackgroundStatus'), overlaySrc.indexOf('export function TitleScreen'));
    expect(loading).toContain('useAssetPackGate((s) => (s.required ? s.state : null))');
    expect(background).toContain('useAssetPackGate((s) => (s.required ? s.state : null))');
    expect(overlaySrc.replace(loading, '').replace(background, '')).not.toContain('useAssetPackGate(');
    expect(overlaySrc).toMatch(/function TitleScreen\(\)[\s\S]*?<AssetPackBackgroundStatus \/>/);
  });

  it('routes confirmed anonymous installs to sign-in while unknown sessions retain a recoverable check', () => {
    expect(overlaySrc).toMatch(/if \(restore === 'restored'\)[\s\S]*?else if \(restore === 'anon'\) \{\s*setScreen\('title'\)/);
    expect(overlaySrc).toMatch(/\}, \[booted, restore, setScreen\]\)/);
    expect(overlaySrc).not.toMatch(/if \(displayPct < 100 \|\| !packReady\) return/);
    expect(overlaySrc).toContain('const SESSION_RESTORE_REVEAL_MS = 4_000');
    expect(overlaySrc).toContain("api.get<{ wallet: string; entryPaid: boolean }>('/me', { signal: controller.signal })");
    // Owner 2026-09-08: a slow /me is not proof that another wallet signature
    // is needed. Only a definite unauthorized response may show sign-in.
    const timeout = /const revealTimer = setTimeout\(\(\) => \{([\s\S]*?)\}, SESSION_RESTORE_REVEAL_MS\)/.exec(overlaySrc)?.[1];
    expect(timeout).toBeDefined();
    expect(timeout).toMatch(/deadlineHit = true;\s*controller\.abort\(\);\s*setSessionFailure\('timeout'\);\s*setRestore\('checking-retry'\)/);
    expect(timeout).not.toMatch(/setRestore\('anon'\)|setScreen\('title'\)|setAuth\(null/);
    expect(overlaySrc).toContain("setRestore(e instanceof ApiError && e.status === 401 ? 'anon' : 'checking-retry')");
    expect(overlaySrc).toMatch(/if \(!live \|\| deadlineHit\) return/);
    expect(overlaySrc).toContain('TRY AGAIN');
    expect(overlaySrc).not.toContain('SERVER CHECK TIMED OUT · SIGN IN TO RETRY');
  });

  it('keeps a known authenticated session on a race-safe hydration retry screen', () => {
    expect(overlaySrc).toContain("type SessionRestoreState = 'pending' | 'checking-retry' | 'hydrating' | 'retry' | 'restored' | 'anon'");
    expect(overlaySrc).toMatch(/setAuth\(me\.wallet, me\.entryPaid\);[\s\S]*?setRestore\('hydrating'\)/);
    expect(overlaySrc).toContain("if (restore !== 'hydrating' || !booted) return;");
    expect(overlaySrc).toMatch(/bus\.emit\('ui:toast', \{ msg: 'Loading took too long. Please try again.' \}\);\s*pause\('timeout'\);/);
    expect(overlaySrc).toContain('if (!live || controller.signal.aborted) return;');
    expect(overlaySrc).toMatch(/restoreGuard\.current = captureBaseSnapshotGuard\(\);\s*setRestore\('hydrating'\);\s*}}>TRY AGAIN/);
    expect(overlaySrc).not.toMatch(/SESSION_HYDRATION_TIMEOUT_MS[\s\S]{0,500}setAuth\(null\)/);
  });

  it('shows exact background progress and a non-blocking retry on the title screen', () => {
    expect(overlaySrc).toContain('(packState.downloadedBytes * 100) / packState.totalBytes');
    expect(overlaySrc).toContain("packState?.kind === 'downloading' && packState.totalBytes > 0");
    expect(overlaySrc).toContain('Download paused. You can play online.');
    expect(overlaySrc).toContain('Background download');
    expect(overlaySrc).toContain('<TitleScreen />');
    expect(overlaySrc).toContain('role="progressbar"');
    // Owner 15 September: file counts also include local decode; only network
    // transfer bytes may produce the shared loader’s percentage.
    expect(overlaySrc).not.toContain("bus.on('boot:progress', setBootProgress)");
    expect(overlaySrc).toContain('<GameLoading title={msg} transferPercent={displayPct}');
    // Finished artwork cannot claim that the independent account sync is done.
    // Exact transfer progress remains separate from account verification.
    expect(overlaySrc).toContain('const displayPct = waitingForAccount ? null : packPct');
    expect(overlaySrc).not.toMatch(/setPct\(.*Math\.random/);
  });

  it('stores response bytes only and never decodes the complete pack into image/audio/GPU memory', () => {
    expect(packCode).not.toMatch(/createImageBitmap|AudioContext|decodeAudioData|WebGL|Phaser/);
    expect(packCode).toContain('cache.put(');
  });
});

describe('D-101 push boot and deep-link seam', () => {
  it('re-syncs only after authenticated boot and after a later wallet signs in', () => {
    expect(code).toContain('if (!import.meta.env.DEV && useApp.getState().authed) void syncPushSubscription()');
    expect(code).toContain('if (!import.meta.env.DEV && useApp.getState().authed) void resumePushSessionAndSync()');
    expect(code).toMatch(/if \(state\.authed && \(!previous\.authed \|\| state\.wallet !== previous\.wallet\)\)/);
    expect(code).toContain("worker?.addEventListener('controllerchange', syncPushForAuthenticatedWallet)");
    expect(code).toContain('resumePushForAuthenticatedWallet()');
  });

  it('captures the query once and consumes it only on authoritative base entry', () => {
    expect(code).toContain('captureDeepLinkFromUrl()');
    expect(code).toContain('takePendingDeepLinkOnBaseEntry({');
    expect(code).toContain('hydrated: state.base !== null');
    expect(code).toContain('if (deepLink) state.setScreen(deepLink)');
    expect(overlaySrc).not.toContain('takePendingDeepLink');
  });

  it('turns a foreground mail push into a narrow badge refresh', () => {
    expect(code).toContain("if (data.kind === 'mail') bus.emit('mail:refresh', undefined)");
    expect(overlaySrc).toContain("bus.on('mail:refresh', reloadMail)");
  });
});
