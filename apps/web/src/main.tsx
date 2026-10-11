// Buffer polyfill MUST land before any web3.js import executes (Vite
// externalizes node builtins; wallet signing breaks without this).
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { migrateMobilePhantomWalletStorage } from './auth/mobilePhantomAdapter';
import { initAnalytics } from './lib/analytics';
import { caps } from './lib/platform';
import { installGameViewport } from './lib/gameViewport';
import { installPreloadErrorReload } from './lib/preloadError';
import { captureReferralFromUrl } from './lib/referral';
import { registerServiceWorker } from './lib/sw';
import './styles.css';

// Before render: ?ref=KEEP-XXXXX from a friend's link is stashed for the
// alpha gate to auto-redeem after sign-in (D-052).
migrateMobilePhantomWalletStorage(caps.platform);
captureReferralFromUrl();
// Telemetry shim (M23 a13): session context + global error capture. A no-op
// end to end until the server has analytics keys configured.
initAnalytics();
// A deploy's stale-chunk failure reloads to the new bundle instead of
// stranding the player (and instead of paging Sentry) — see preloadError.ts.
installPreloadErrorReload();
registerServiceWorker();

const removeGameViewport = installGameViewport();
import.meta.hot?.dispose(removeGameViewport);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
