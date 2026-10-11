# Pixel Kingdom Wars — native Android client

The native Android client for [Pixel Kingdom Wars](../README.md): Kotlin, Jetpack Compose for menus and sheets, a libGDX renderer for the base, battle and globe scenes, and Solana Mobile wallet integration (Mobile Wallet Adapter, with an optional Privy social sign-in path). It talks to the same authoritative API as the web client at `https://play.pixelkingdomwars.com`, so an account, base and economy are shared across both clients.

The shipped release line is **0.7.1 (version code 34)**, published through the Solana dApp Store for Seeker and other Android devices (API 28+).

## Modules

| Module | Responsibility |
|---|---|
| `app` | Compose navigation, Android lifecycle, the libGDX fragment, sheets and HUD |
| `renderer` | Atlas sprites, scene textures, camera and touch, canonical battle playback, realm map and globe |
| `network` | HTTPS cookie session, async HTTP, generated DTO validation, exact decimal balances |
| `wallet` | Mobile Wallet Adapter signing, Seeker auction and faucet transactions, optional Privy SDK |
| `content` | Hash and size verification, atomic activation and last-known-good recovery of in-app content updates |
| `tools` | Node scripts that export, verify and import the client content pack and world bundle |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/APP_SHELL.md](docs/APP_SHELL.md), [docs/PERFORMANCE.md](docs/PERFORMANCE.md) and [docs/TELEMETRY.md](docs/TELEMETRY.md).

## Build

Requirements: JDK 17, an Android SDK with platform 36 and build tools (set `ANDROID_HOME` or write `sdk.dir` into `local.properties`), and Node.js 22 for the `tools/` scripts. Gradle 8.11.1 is pinned through the wrapper with its distribution checksum; every dependency has an explicit version.

```bash
cd android
./gradlew :app:assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. It uses the application id `gg.pixelkingdomwars.twa.debug`, so it installs next to the store build.

The shipped content pack (`app/src/main/assets/native`) and world bundle (`app/src/main/assets/world`) are committed, together with `client-pack.lock.json` and `world-shaders.lock.json`, which pin their identity. Gradle verifies the world bundle's `content.json` against the lock file at build time, so a fresh clone builds without any download or export step.

Optional:

- `-PnativeVersionCode=34 -PnativeVersionName=0.7.1` stamps a specific version (the defaults are `1` / `0.1.0-foundation`).
- `app/google-services.json` enables Firebase Cloud Messaging; without it the build simply reports `NATIVE_FCM_CONFIGURED=false`.
- `:app:assembleRelease` produces an **unsigned** release APK. Signing material is never part of the repository.

## Tests

```bash
./gradlew :renderer:test :content:test :network:testDebugUnitTest :wallet:testDebugUnitTest :app:testDebugUnitTest :app:lintDebug
node tools/check-compatibility.mjs
```

`native-compatibility.json` records the renderer contract, presentation protocol and simulator versions this client accepts; the server refuses clients below its admission floor and the client refuses content it cannot render.

## Content pack and world bundle

The content pack is exported from the monorepo at the root of this repository by `tools/export-client-pack.mjs` (reads the web client's atlases, animation clips and shared constants, and checks the simulator goldens) and imported with `tools/sync-client-pack.mjs`, which writes the assets and regenerates `network/.../generated/NativeContracts.kt`. The world bundle is produced by `tools/world-debug-content.mjs` from the web client's world pack. Both steps are only needed when the game content changes; the committed output is the one shipped in 0.7.1.

## Authority

Every cost, stat and cap comes from `packages/shared/src/constants.ts` in the monorepo and from server responses. The client keeps no economy tables of its own, submits explicit player orders, and renders server state. Balances travel as decimal strings and are never rounded through floating point.
