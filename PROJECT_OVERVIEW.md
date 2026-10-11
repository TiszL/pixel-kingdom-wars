# Pixel Kingdom Wars — Project Overview

Pixel Kingdom Wars is a persistent, mobile-first base-building strategy game on Solana devnet. Players grow a kingdom, design defenses, train specialized armies, raid rivals, complete an authored campaign, and can own the entire playable base as a transferable Land Deed.

[Play the devnet alpha](https://play.pixelkingdomwars.com) · [Visit the product site](https://pixelkingdomwars.com) · [Explore the repository](README.md)

## Product vision

Most strategy games keep ownership and progression inside a closed account database. Pixel Kingdom Wars keeps real-time play fast and server-authoritative while giving the player a verifiable ownership layer for the asset that matters most: the developed kingdom itself.

A Land Deed is a Metaplex Core NFT tied to one stable base. When ownership changes, the layout, structures, progression, army, heroes, inventory, local SHARDS balance, economic positions, and battle history move with it. Wallet identity, SOL, KEEP, clan membership, and account-wide cosmetics stay with the wallet.

## Playable experience

- Build and expand a persistent base through 20 Keep levels.
- Place and upgrade economy buildings, eight defense families, four trap families, walls, and support structures.
- Train 14 player-controlled troop types and develop two heroes with equipment and abilities.
- Fight deterministic PvP battles, 100 campaign stages across ten acts, and separate Ruined Keep encounters.
- Explore an eight-realm fantasy globe, inspect parcels and nearby bases, manage multiple deed-backed bases, and follow external Land Deed market links.
- Complete daily and weekly quests, trade game items, use chat and mail, follow leaderboards, and watch authoritative replays.

New players can learn the build loop on a limited deedless base. The Land Deed path unlocks the full land-backed experience, including world presence, deed-owner PvP, the Gold Forge, and transferable base ownership.

## Fantasy geography and presentation

Eight distinct realms share a fixed catalog of 85,414 deed tiles. Crownlands,
Frostveil, Elderwood, Sunscar, Stormcairn, Thornwake and Cinderfall provide ordinary
land. Solana Reach contains two reserved allocations: Genesis Sanctuary and the
surrounding Seeker land. Exploration islands have no deed supply or ownership.

Realm themes cover bases and their surroundings, and the defender's theme follows
scouting and battle views. Decorative motion does not change collision or combat.
Walls use five visual tiers with contextual connections; campaign chapters retain
their 100 existing encounters and progression.

## How it works

```text
Player + Solana wallet
          │
          ▼
React UI + Phaser game
          │ authenticated commands
          ▼
Fastify API ── PostgreSQL / Redis
     │
     ├── deterministic combat and replay events
     └── Solana devnet
            ├── two Anchor programs
            ├── Metaplex Core Land Deeds
            └── Classic SPL KEEP
```

The client renders state and submits intent. The API validates ownership, costs, progression, timers, collision, locks, and settlement. This keeps private defender state, moderation, anti-cheat checks, and fast-changing gameplay under authoritative control.

Solana provides wallet authorization and public verification for:

- player-signed SOL payments and settlement receipts;
- Metaplex Core Land Deed ownership and transfer observation;
- Classic SPL KEEP deposits and withdrawals;
- atomic SOL settlement for direct item-market purchases;
- immutable proof-of-liabilities commitments.

## Deterministic battles

[`packages/sim`](packages/sim) resolves combat with a fixed 100 ms tick, integer positions at 256 units per tile, seeded randomness, and stable actor ordering. It excludes wall-clock access, `Math.random`, and transcendental `Math` functions.

The API freezes each raid snapshot, accepts validated player commands, resolves with a pinned simulator version, and settles once. Authoritative events are archived so historical replays remain stable across client releases.

## Solana components

The project contains exactly two custom Anchor programs:

| Program | Current devnet role |
|---|---|
| [`shardkeep-core`](programs/shardkeep-core/src/lib.rs) | Active payment routing, receipts, pause and administrative controls, and immutable proof-of-liabilities roots |
| [`shardkeep-distributor`](programs/shardkeep-distributor/src/lib.rs) | Deployed but inactive one-claim distribution program; initialization is upgrade-authority-gated, with no current-mint Distributor PDA, production caller, or funds |

Land Deeds use **Metaplex Core NFTs**, with dynamic metadata, a permanent freeze delegate, and a 5% marketplace-honoured royalty policy. The current Classic SPL devnet mint has **500 million KEEP** and retains mint and freeze authorities during alpha. A fixed-supply, authority-revoked configuration remains a future launch target.

See [Solana Integration](docs/SOLANA.md) for deployed program IDs, accounts, instructions, and verified chain state.

## Economy design

Three assets have distinct jobs:

| Asset | Scope | Primary role |
|---|---|---|
| **SHARDS** | Base / Land Deed | Construction, upgrades, training, research, trap repair, PvP entry, and Gold Forge contributions |
| **KEEP** | Wallet / account | Heroes, items, buffs, timer speed-ups, additional Mines, and optional conversion into SHARDS |
| **SOL** | Player wallet | Land, builders, expansions, energy, shields, selected upgrades, and marketplace settlement |

Mines, quests, campaign play, and raids feed the SHARDS progression loop; quests award SHARDS, never KEEP. The Gold Forge is the only gameplay conversion from SHARDS to KEEP, splitting a bounded daily KEEP pool across eligible contributions. Gold Forge payouts, eligible Ruined Keep KEEP bounties, admin-issued devnet alpha rewards, and explicitly enabled and budgeted mainnet community campaigns debit one bounded gameplay emission pool. Verified KEEP deposits create matching player liabilities and never fund rewards. Players can convert KEEP to SHARDS at 1:1; the reverse direction remains limited by the Forge rather than operating as an unlimited exchange.

Ordinary KEEP spent in-game returns to the emission pool. A KEEP withdrawal transfers 98% of the requested amount and records the 2% fee to an internal ledger sink; no SPL token burn occurs. Direct item-market purchases split buyer-signed SOL 95% to the seller and 5% to the fee treasury. Other SOL purchases follow the routes documented in [Playtest Economy](docs/ECONOMY.md).

All current costs, rewards, caps, routes, and emission curves are playtest parameters. They may be retuned when player data shows that progression or the in-game economy needs adjustment; they are not final mainnet tokenomics.

## Code map

| Area | Start here |
|---|---|
| Player experience | [`apps/web`](apps/web) and [Gameplay](docs/GAMEPLAY.md) |
| Authoritative game services | [`apps/api`](apps/api) and [Architecture](docs/ARCHITECTURE.md) |
| Deterministic combat | [`packages/sim`](packages/sim) |
| Solana clients | [`packages/chain`](packages/chain) |
| Anchor programs | [`programs`](programs) and [Solana Integration](docs/SOLANA.md) |
| Canonical game constants | [`packages/shared/src/constants.ts`](packages/shared/src/constants.ts) |
| Test strategy | [Testing](docs/TESTING.md) |
| Current boundaries | [Known Limitations](docs/KNOWN_LIMITATIONS.md) |

## Current stage

- Live open playtest on Solana devnet. Everyone can join without an invite code; referral codes are optional.
- Android web delivery uses a signed Trusted Web Activity; the native Android client is developed separately.
- Workspace verification covers typechecks, lint, tests, builds, and replay-version gates; Anchor validator tests run as a separate release gate.
- The Anchor programs have adversarial tests and internal review, but no third-party audit.
- Devnet SOL and KEEP have no represented monetary value; current custody and authority controls are not presented as mainnet-ready.

The running API publishes its release and simulator protocol at [`/api/version`](https://play.pixelkingdomwars.com/api/version). Security reports follow [SECURITY.md](SECURITY.md).
