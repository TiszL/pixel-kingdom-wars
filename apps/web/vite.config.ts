/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { configDefaults } from 'vitest/config';
import { offlineMwaFonts } from './scripts/offline-mwa-fonts';
import { stableAssetFileNames } from './scripts/stable-asset-names';

const buildSha = process.env['GIT_SHA'] ?? 'dev';

/** The retained loading/title art must start before the React module graph.
 * Keep the static document's URL byte-identical to versionedPublicAsset(). */
const versionPreReactBackdrop = (): Plugin => {
  const stamp = (html: string) => html.replaceAll(
    '__PKW_BUILD_SHA__', encodeURIComponent(buildSha),
  );
  return {
    name: 'pkw-version-pre-react-backdrop',
    transformIndexHtml: {
      order: 'post',
      handler: stamp,
    },
    // Vite's HTML build restores <source srcset> after transformIndexHtml hooks
    // have run. Stamp the emitted asset too; the post-build verifier below is
    // the second, independent tripwire for this exact partial-transform bug.
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const index = bundle['index.html'];
        if (!index || index.type !== 'asset') {
          throw new Error('Vite did not emit index.html');
        }
        const html = typeof index.source === 'string'
          ? index.source
          : new TextDecoder().decode(index.source);
        index.source = stamp(html);
      },
    },
  };
};

export default defineConfig(({ mode }) => ({
  plugins: [versionPreReactBackdrop(), offlineMwaFonts(), react(), tailwindcss()],
  // Env lives in the REPO ROOT .env alongside the api's — that file already
  // declares VITE_API_URL / VITE_SOLANA_RPC_URL / VITE_SOLANA_CLUSTER, but vite
  // defaults envDir to the package root and so never read them, silently falling
  // back to the in-code defaults. Vite still only exposes VITE_-prefixed keys, so
  // the server secrets sharing that file stay out of the bundle.
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  // web3.js 1.x expects node globals (research: solana-client-stack §1)
  define: {
    'process.env': {},
    global: 'globalThis',
    // Build identity, frozen INTO the bundle. It has to be baked at build time
    // rather than read at runtime: the whole point is for a cached bundle to be
    // able to say which build it is, and anything it fetches at runtime would
    // describe the CURRENT server, not itself. CI passes these; a local build
    // gets the dev markers, which is honest — an unstamped build says so.
    __APP_VERSION__: JSON.stringify(process.env['APP_VERSION'] ?? '0.0.0-dev'),
    __GIT_SHA__: JSON.stringify(buildSha),
    __BUILD_TIME__: JSON.stringify(process.env['BUILD_TIME'] ?? null),
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
      // Privy's Solana bundle imports getAddMemoInstruction (memo txns we never
      // build); the real @solana-program/memo version-conflicts with Privy's
      // pinned @solana/kit. Alias to a stub (see src/shims/solana-memo.ts).
      '@solana-program/memo': fileURLToPath(new URL('./src/shims/solana-memo.ts', import.meta.url)),
    },
  },
  optimizeDeps: { include: ['buffer'] },
  test: {
    // The world v2 engine suites are the concept's node:test files; vitest's
    // default include would collect them and fail each with "No test suite
    // found". The package `test` script runs them with `node --test` instead.
    exclude: [...configDefaults.exclude, 'src/ui/fantasy/worldv2/**/*.test.mjs'],
  },
  server: {
    port: 5173,
    // WEB_ORIGIN deliberately permits exactly localhost:5173 in development.
    // Silently moving to 5174 makes every credentialed API request fail CORS
    // with a misleading browser-level "Failed to fetch".
    strictPort: true,
    proxy: {
      // Only the SDK relay uses same-origin local transport. Keep the existing
      // absolute VITE_API_URL path for game/auth requests unchanged.
      '^/api/rpc/solana/(devnet|mainnet-beta)$': {
        target: loadEnv(mode, fileURLToPath(new URL('../..', import.meta.url)), '').VITE_API_URL
          || 'http://localhost:8787',
        ws: true,
        rewrite: (url) => url.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    /**
     * NEVER INLINE ASSETS AS DATA URIs.
     *
     * ui/icons.ts eagerly globs ~2,000 SVG masters with `?url`. Vite's default
     * inlines anything under 4 KB, so 910 of them were percent-encoded straight
     * into the entry chunk: 2.87 MB, about 41% of it. Percent-encoding INFLATES
     * them, they are parsed as JavaScript string literals on every single load,
     * they cannot be cached separately, and a player who renders a dozen icons
     * still downloads all 910.
     *
     * As emitted files they are content-hashed, so the service worker's
     * cache-first `/assets/*` rule keeps them forever and only the handful
     * actually referenced are ever fetched. `sprite()` still returns a URL
     * string, so nothing downstream changes.
     */
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: { assetFileNames: stableAssetFileNames },
    },
    /**
     * A budget, not a formality. This was 2048 — high enough that a 7 MB entry
     * chunk shipped without anyone noticing. Phaser is legitimately large and
     * lives in its own lazily-loaded chunk, so the limit now applies to the
     * chunks that gate first paint.
     */
    chunkSizeWarningLimit: 700,
  },
}));
