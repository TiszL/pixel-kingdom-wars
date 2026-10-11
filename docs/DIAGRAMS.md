# Architecture and game-flow diagrams

These diagrams show the current devnet-alpha architecture and value flows.
See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the detailed boundary and
[`GAMEPLAY.md`](GAMEPLAY.md) for mechanics.

## Request and battle flow

```mermaid
flowchart LR
  Player["Browser or Solana Mobile TWA"] --> UI["Phaser game + React interface"]
  UI -->|"signed session and player intents"| API["Fastify API"]
  API --> Auth["wallet authentication and authorization"]
  API --> Game["authoritative game services"]
  Game --> DB["PostgreSQL + append-only ledger"]
  Game --> Sim["deterministic raid simulator"]
  Sim -->|"result + event log"| DB
  DB -->|"archived event log"| UI
  UI -->|"render only"| Player
  API --> Redis["Redis jobs, locks and ephemeral state"]
```

The server validates costs, timers, ownership and battle inputs. New battles are
resolved by `packages/sim`; a replay renders the stored result rather than
running historical inputs under current simulator rules.

## Solana boundary

```mermaid
flowchart TB
  Wallet["Player wallet"] -->|"SOL payment"| Core["shardkeep-core<br/>active devnet program"]
  Core --> Receipt["entry Player PDA / PaymentMade event"]
  Core --> Root["immutable proof-of-liabilities roots"]
  Wallet <--> Deed["Metaplex Core Land Deed NFT"]
  API -->|"finalized verification"| Receipt
  API -->|"mint / ownership reads"| Deed
  API <--> Token["SPL KEEP mint and custody ledger"]
  Prepared["shardkeep-distributor<br/>deployed but inactive"] -. "authority-gated; current-mint PDA absent; no callers or funds" .-> Token
  GameState["bases, armies, battles, quests, market"] --> DB[("PostgreSQL")]
```

The two custom Anchor programs do not hold the base map, armies or combat. The
Core program records payments and weekly liability commitments. Land Deeds use
Metaplex Core, not Bubblegum. The distributor is prepared for a future Merkle
distribution but is not an active player rail.

## Player economy and market flows

```mermaid
flowchart LR
  Mine["Mines + daily activities"] --> Shards["deed-local SHARDS"]
  Raid["Campaign and PvP loot"] --> Shards
  Shards --> Build["build, upgrade, train, attack"]
  Shards --> Forge["Gold Forge daily position"]
  Forge --> Keep["wallet-level KEEP claim"]
  Ruined["eligible Ruined Keep bounty"] --> Pool["KEEP emission pool"]
  Campaign["devnet admin reward / budgeted mainnet campaign"] --> Pool
  Keep --> Hard["items, recruits, speed-ups, Mine purchases"]
  Hard --> Pool
  Pool --> Forge
  Keep --> Convert["1:1 KEEP-to-SHARDS conversion"]
  Convert --> Shards
  Convert -->|"spent KEEP returns"| Pool
  Keep --> Withdraw["guarded SPL withdrawal"]
  Withdraw -->|"98%"| Wallet["player wallet"]
  Withdraw -->|"2%"| Burn["internal ledger sink (not an SPL burn)"]
  Buyer["item-market buyer"] -->|"SOL payment"| Sale["verified direct split"]
  Sale -->|"95%"| Seller["item seller"]
  Sale -->|"5%"| Fee["fee treasury"]
  Land["Land Deed transfer"] -->|"moves the full base and its SHARDS"| NewOwner["new deed owner"]
```

## Land purchase and transfer

```mermaid
sequenceDiagram
  participant W as Player wallet
  participant C as shardkeep-core
  participant A as API
  participant M as Metaplex Core
  participant D as Database

  W->>C: pay_entry or typed buy_sink
  A->>C: verify finalized receipt
  A->>D: create land/base records once
  A->>M: mint Land Deed
  M-->>W: Core asset
  W->>M: transfer asset
  A->>M: read finalized ownership
  A->>D: authorize the new owner for the complete base
```
