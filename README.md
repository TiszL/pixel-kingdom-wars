# Pixel Kingdom Wars

**A mobile-first strategy game where players build persistent kingdoms, raid deterministic battlefields, and own transferable Land Deeds on Solana.**

![Pixel Kingdom Wars — eight realms and 100 campaign stages](docs/media/github-banner.png)

Pixel Kingdom Wars combines the responsiveness of a server-authoritative game with on-chain ownership and settlement. Players develop a Keep, train armies, defend their land, complete a 100-stage campaign, compete in PvP, and can transfer an entire playable base through a Metaplex Core NFT.

[Play in the browser](https://play.pixelkingdomwars.com) · [Product site](https://pixelkingdomwars.com) · [Project overview](PROJECT_OVERVIEW.md) · [Android client](android/README.md)

> The game runs as an open playtest on **Solana devnet**. Devnet SOL and KEEP have no represented monetary value. Balance and economy parameters are current playtest settings and may be retuned.

`SHARDKEEP` is the internal codename used by packages and programs.

## Two clients, one authoritative server

| Client | Stack | Where |
|---|---|---|
| **Web** | React 19 overlay + Phaser 4 game scenes, Vite, wallet adapters | [`apps/web`](apps/web) |
| **Android (native)** | Kotlin, Jetpack Compose, libGDX renderer, Solana Mobile wallet integration | [`android`](android) |

Both clients talk to the same Fastify API. The server validates every order, runs the deterministic combat simulator, keeps the custody ledger, and talks to Solana. Clients render state and submit intent; they never decide costs, timers, ownership or battle outcomes.

## The game

1. **Build** a persistent base with economy buildings, defenses, walls, traps, and up to 20 Keep levels.
2. **Collect and progress** with deed-local SHARDS from Mines, quests, campaign rewards, and raids.
3. **Prepare an army** from 14 trainable troop types, two heroes, research, equipment, and saved layouts.
4. **Battle** through 100 authored campaign stages, Ruined Keep encounters, or player bases.
5. **Improve and trade** by studying authoritative replays, refining defenses, and optionally transferring the complete base through its Land Deed.

The world spans eight realms (Frostveil, Elderwood, Sunscar, Crownlands, Solana Reach, Stormcairn, Thornwake and Cinderfall) on a fantasy globe with 85,414 deed tiles. Daily and weekly quests, inventory and item trading, chat, mail, referrals, leaderboards and replay history are live. See [Gameplay](docs/GAMEPLAY.md) for the full feature set and [Playtest Economy](docs/ECONOMY.md) for the numbers.

### Phase E (live on devnet since October 2026)

Phase E is the economy expansion that moved the game from "build and raid" to a working production chain:

- **Phase E buildings** — Workshop, Lodge, Market, Harvesters and the Berth — with ordinary crafting (raw to refined resources), Forge ingots, starter expeditions and Harvester source selection.
- **Gems** — the in-game spend currency, converted from KEEP at 1:1 through the ledger, with exact-consent spend receipts on both clients.
- **On-chain Seeker auctions and realm land sales** through the `shardkeep-economy` program, paid in the devnet test SKR mint, with a signed-quote flow that both clients verify against the same public pins (`android/app/chain-pins.release.properties`).
- **Crafting program** (`shardkeep-craft`) deployed with its accepted identity; the league program identity is accepted but not yet deployed; KEEP mining claims and the mining tax stay dark until the KEEP reserve identity is served.

Every Phase E family is behind a server switch (`PHASE_E_*`, `GEMS_*`, `HARVESTERS_ENABLED`, …) and the web client additionally gates its new screens behind `VITE_PHASE_E_WEB_ENABLED`. The production server reports what is on through `GET /native/capabilities`.

## Architecture

```text
   Web client (React + Phaser)        Android client (Compose + libGDX)
                 │ authenticated player commands │
                 ▼                               ▼
              Fastify authoritative API (apps/api)
                 │            │             │
                 │            ├── PostgreSQL / Redis
                 │            └── deterministic combat simulator (packages/sim)
                 ▼
   Solana devnet: Anchor programs · Metaplex Core Land Deeds · SPL KEEP
```

- [`packages/sim`](packages/sim) resolves combat with a fixed 100 ms tick, integer positions at 256 units per tile, seeded randomness and stable actor ordering. It excludes wall-clock access, `Math.random` and transcendental `Math` functions, so every replay is reproducible.
- [`packages/shared`](packages/shared) is the single source of every game number and shared type.
- [`packages/chain`](packages/chain) holds the server-side Solana program, SPL Token and Metaplex Core clients.
- [`programs`](programs) contains the Anchor programs and their validator test suites.

Read [Architecture](docs/ARCHITECTURE.md), [Diagrams](docs/DIAGRAMS.md) and [Solana integration](docs/SOLANA.md) for the full design.

## On-chain components (devnet)

| Component | Address | Role |
|---|---|---|
| `shardkeep-economy` program | [`5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr`](https://explorer.solana.com/address/5qyN1Xbe2L16t7MPwwcD5QGmLYAnGF4VjN9BXtazvzkr?cluster=devnet) | Phase E economy: KEEP mining claims, Seeker auctions, realm sales |
| `shardkeep-craft` program | [`4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59`](https://explorer.solana.com/address/4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59?cluster=devnet) | Crafting and vehicle issuance |
| `shardkeep-core` program | [`mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b`](https://explorer.solana.com/address/mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b?cluster=devnet) | SOL payment routing, receipts, admin controls, proof-of-liabilities roots |
| `shardkeep-distributor` program | [`6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU`](https://explorer.solana.com/address/6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU?cluster=devnet) | Deployed, inactive Merkle distribution program |
| KEEP mint (SPL) | [`5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC`](https://explorer.solana.com/address/5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC?cluster=devnet) | In-game KEEP currency (devnet) |
| tSKR mint (SPL) | [`GhGdHTMAorprWg1YNtjw7z72owJyGKE5KbFi1fW1j9eB`](https://explorer.solana.com/address/GhGdHTMAorprWg1YNtjw7z72owJyGKE5KbFi1fW1j9eB?cluster=devnet) | Devnet test SKR used by the Seeker auction flow |
| Land Deed collection (Metaplex Core) | [`56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT`](https://explorer.solana.com/address/56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT?cluster=devnet) | Transferable base ownership |

The published address registry is [`infra/devnet.addresses.json`](infra/devnet.addresses.json). Program IDs are also declared in [`programs/Anchor.toml`](programs/Anchor.toml). The accepted production deployment of `shardkeep-economy` is pinned in [`android/app/chain-pins.release.properties`](android/app/chain-pins.release.properties): deployment slot `509790748`, ProgramData sha256 `f1a4e173…0688cd`, upgrade authority `Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8`, realm-sale policy revision `phase-e-devnet-r12-2026-10`; both clients verify every signed quote against these values.

## Quickstart — API + web client

Requirements: Node.js 22+, pnpm 10.19 (`corepack enable` picks the pinned version), Docker with Compose.

```bash
git clone https://github.com/TiszL/pixel-kingdom-wars.git
cd pixel-kingdom-wars
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d     # PostgreSQL on :5433, Redis on :6380 (local only)
pnpm dev                                             # API on http://localhost:8787, web on http://localhost:5173
```

Open <http://localhost:5173>. Both the API and the web app are required: authentication and all game state come from the API. The committed `.env.example` contains no secrets; the defaults point at the local Docker services and the public Solana devnet RPC, and the API applies the database migrations itself on first boot (`RUN_MIGRATIONS_ON_BOOT=true` in the template). To run the migrations as a separate step instead:

```bash
DATABASE_URL=postgres://shardkeep:shardkeep@localhost:5433/shardkeep pnpm --filter @shardkeep/api db:migrate
```

Signing in with a Solana wallet (devnet) works out of the box. For local exploration without a wallet set `DEV_LOGIN=true` in `.env` (a signature-less development login that the server refuses in production).

The template switches on the same Phase E families production runs (Phase E buildings, Workshop crafting, Forge ingots, starter expeditions, Harvesters, Gems, and the web screens behind `VITE_PHASE_E_WEB_ENABLED=1`); `GET http://localhost:8787/native/capabilities` reports what the running server has enabled. The on-chain Seeker auction and realm-sale families need the accepted program pins and an RPC-funded crank, so they stay off locally.

Runtime atlases, audio and brand files under `apps/web/public/{atlas,audio,brand}` are committed, so no asset generation step is needed. The original art masters and the rasterisation pipeline that produces them are not part of this repository.

## Verify

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test          # the API suite needs the Docker services above
pnpm -r build
```

The API test suite is large (it exercises real PostgreSQL transactions and the double-entry ledger); CI runs it in sixteen shards. See [Testing](docs/TESTING.md).

## Programs (Anchor)

```bash
cd programs
anchor build
anchor test            # spins a local validator and runs the adversarial suites
```

Toolchain: **Anchor 0.32.1** and **Agave (Solana CLI) 2.3.13**. `programs/Cargo.lock` is load-bearing (it pins edition-2024 crates for this toolchain); do not run `cargo update`.

## Quickstart — Android client

See [android/README.md](android/README.md). In short: JDK 17 and an Android SDK with platform 36, then

```bash
cd android
./gradlew :app:assembleDebug
```

The shipped content pack and world bundle are committed under `android/app/src/main/assets`, so a fresh clone builds without any download step. The debug APK lands in `android/app/build/outputs/apk/debug/`.

## Repository map

| Path | Responsibility |
|---|---|
| [`apps/web`](apps/web) | React 19, Phaser 4, wallet integration, and responsive game UI |
| [`apps/api`](apps/api) | Fastify API, authoritative rules, persistence, jobs, custody, and chain observers |
| [`android`](android) | Native Android client (Kotlin, Compose, libGDX, Solana Mobile) |
| [`packages/shared`](packages/shared) | Shared types and the canonical source for game constants |
| [`packages/sim`](packages/sim) | Pure deterministic combat and versioned replay protocol |
| [`packages/chain`](packages/chain) | Solana program, SPL Token, and Metaplex Core clients |
| [`programs`](programs) | Anchor programs and validator tests |
| [`scripts`](scripts) | Devnet bootstrap, economy simulations, release-note tooling |
| [`infra`](infra) | Local Docker services, deployment configuration, backups, public addresses |
| [`mobile`](mobile) | Trusted Web Activity shell for the web client |
| [`docs`](docs) | Architecture, gameplay, economy, testing and Solana documentation |
| [`release-notes`](release-notes) | Player-facing changelog fragments |

## Security

See [SECURITY.md](SECURITY.md) for the trust boundary, reporting address and the list of mainnet prerequisites. The programs have adversarial validator coverage and internal review but no third-party audit yet.

## Licence

Source-available for evaluation; see [LICENSE](LICENSE). Art, audio, fonts and brand material are not licensed for reuse.
