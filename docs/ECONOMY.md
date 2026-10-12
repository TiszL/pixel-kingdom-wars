# Game economy

These are the current **open-playtest settings** on Solana devnet, not final
mainnet tokenomics. Costs, rewards, limits, splits, and emission curves may be
retuned when player data shows that progression or the in-game economy needs
adjustment. Devnet SOL and devnet KEEP have no represented monetary value.

Every tunable number has one code authority:
[`packages/shared/src/constants.ts`](../packages/shared/src/constants.ts). This
page explains what the server currently enforces without replacing that source.

## Economy at a glance

| Asset | Where it lives | Main sources | Main uses |
|---|---|---|---|
| **SHARDS** | One base/Land Deed | Starter grant, Mines, daily and weekly quests, cache, campaign and raid loot | Construction, upgrades, troop training/research, trap repair, PvP ante, Gold Forge |
| **KEEP** | Player wallet/account | Gold Forge claims, eligible Ruined Keep bounties, admin-issued devnet alpha rewards, explicitly enabled and budgeted mainnet campaigns, or a verified token deposit | Heroes, items/buffs, timer speed-ups, additional Mines, KEEP-to-SHARDS conversion |
| **SOL** | Player wallet or credited deposit | External to the game | Land, builders, expansions, energy, shields, selected Mine/Gold Forge upgrades, item-market settlement |

SHARDS belong to a base and move with its Land Deed. KEEP, SOL, identity, and
account-wide state stay with the wallet. Gameplay balances and settlement use
an append-only double-entry ledger; the API, not the browser, authorizes every
spend.

The basic flow is:

```text
play + Mines ──> base SHARDS ──> progression / training / PvP
                         └─────> capped daily Gold Forge ──> wallet KEEP
wallet KEEP ──> heroes / items / speed-ups / extra Mines ──> emission pool
            └─> 1:1 SHARDS for the selected base ─────────> emission pool
            └─> withdrawal: 98% net + 2% internal burn sink
```

## SHARDS progression curve

New bases receive **5,000 SHARDS**. The first Mine costs 400 SHARDS and one L1
Mine beside an L1 Keep produces 500 SHARDS per day at the full alpha emission
multiplier. Each physical Mine contributes according to its own level; the sum
is then scaled by Keep level, the runtime emission multiplier, eligible referral
bonus, and a **1.4×** consistency bonus from a seven-day cache streak. Each Mine
has a one-day buffer, so production pauses when that buffer is full.

A base can grow from two available Mines at Keep L1 to eight at Keep L7. At the
full alpha multiplier, with no referral bonus, eight L20 Mines beside an L20
Keep and an active streak produce approximately **250,000 SHARDS/day**. This is
base currency, not withdrawable KEEP. The Gold Forge is the only gameplay path
from contributed SHARDS to KEEP.

PvP mostly redistributes existing deed-local SHARDS: the attacker pays an ante,
the server freezes the defender's economic snapshot, and a successful result
can move available SHARDS from that deed. PvP does not mint KEEP.

### Construction prices

All ordinary construction is paid in SHARDS. The Keep is included when a base
is created; hero altars instead consume a hero contract or the stated KEEP
recruitment price.

| Construction | SHARDS | Construction | SHARDS |
|---|---:|---|---:|
| Cannon | 200 | Archer Tower | 250 |
| Mortar | 400 | Air Defence | 1,100 |
| Electric Tower | 900 | Mage Tower | 1,400 |
| Laser Tower | 2,200 | Dragon Nest | 3,500 |
| Barracks | 300 | Camp | 1,000 |
| First Mine | 400 | Vault | 800 |
| Forge | 1,500 | Gold Forge | 2,500 |
| Wall segment | 150 | Clan Hall | 2,000 |
| Spike Trap | 30 | Powder Mine | 75 |
| Pitfall | 90 | Air Mine | 120 |

### L1-to-L20 structure-upgrade prices

The following table summarizes the 19-step SHARDS arrays as the first
upgrade (L1→L2), final upgrade (L19→L20), and total for one structure. A base's
aggregate cost depends on how many structures and wall segments it owns.

| Structure | First step | Final step | L1→L20 total |
|---|---:|---:|---:|
| Keep | 182 | 826,000 | 2,210,957 |
| Gold Forge | 182 | 826,000 | 2,210,957 |
| Mine | 61 | 182,000 | 507,261 |
| Vault | 49 | 107,000 | 307,132 |
| Cannon | 97 | 78,900 | 253,900 |
| Archer Tower | 121 | 85,000 | 278,109 |
| Mortar | 194 | 121,000 | 402,889 |
| Air Defence or Electric Tower | 182 | 85,000 | 293,561 each |
| Mage Tower | 304 | 97,200 | 353,703 |
| Laser Tower | 486 | 97,200 | 379,624 |
| Dragon Nest | 729 | 107,000 | 439,171 |
| Barracks, Camp, Forge, or Clan Hall | 146 | 95,900 | 316,476 each |
| Spike Trap | 24 | 19,440 | 62,568 |
| Powder Mine | 36 | 29,160 | 93,852 |
| Pitfall | 42 | 34,020 | 109,494 |
| Air Mine | 48 | 38,880 | 125,136 |
| Wall | 48 | 38,880 | 125,136 per segment |

Mine upgrades to L5+ and every Gold Forge upgrade also require the SOL overlay
shown below. Other structure upgrades do not.

Additional SHARDS progression sinks are straightforward:

- troop training costs **8–190 SHARDS per unit**, depending on troop;
- troop research costs 400, 800, …, 7,600 SHARDS, or **76,000 SHARDS** for one
  troop from L1 to L20;
- clearing small, medium, or large obstacles costs 10, 25, or 60 SHARDS;
- a PvP attack costs one energy plus **100–2,000 SHARDS**, scaling with Keep
  level;
- used traps require a SHARDS repair payment before they can trigger again.

## KEEP economy

### Where KEEP comes from

Quests award **SHARDS**, never KEEP. The **Gold Forge is the only
SHARDS-to-KEEP gameplay faucet**. Forge payouts, eligible Ruined Keep KEEP
bounties, admin-issued devnet alpha rewards, and explicitly enabled and budgeted
mainnet community campaigns all debit the single bounded gameplay emission pool.
There is no separate active KEEP allocation for quests.

A verified SPL-token deposit creates a matching player liability for KEEP already
transferred into custody. Deposited KEEP never funds rewards and is not new
issuance. The retained SOL-to-KEEP vend is unavailable to players and has no
active UI.

### How the emission pool works

`emission_pool` is a bounded account in the server's append-only double-entry
ledger. It is **not** another SPL mint, an on-chain token account, or the inactive
Merkle distributor. A fresh economy assigns 500,000,000 KEEP of gameplay budget
to this account. Its non-negative balance is the hard accounting limit: a
reward transaction fails atomically when the pool cannot cover it.

| Event | Double-entry movement | Effect on available reward budget |
|---|---|---|
| Gold Forge allocation | `emission_pool → forge_payout_escrow` | Decreases while the claim is pending |
| Gold Forge claim | `forge_payout_escrow → player_keep` | No further pool change |
| Expired Forge claim | `forge_payout_escrow → emission_pool` | Returns the unclaimed allocation |
| Eligible Ruined Keep bounty | `emission_pool → player_keep` | Decreases by the awarded KEEP |
| KEEP reward mail | `emission_pool → mail_keep_escrow → player_keep` | Devnet alpha rewards are admin-issued; mainnet requires an explicitly enabled campaign with a cumulative budget. An expired unclaimed reward returns |
| Ordinary in-game KEEP spend | `player_keep → emission_pool` | Recycles the full spend for future rewards |
| KEEP-to-SHARDS conversion | `player_keep → emission_pool`, with equal deed-local SHARDS issued | Recycles the KEEP; the exchange is one-way |
| Verified KEEP deposit | `onchain_inflow → player_keep` | No pool change; custody and player liability rise together |
| KEEP withdrawal | `player_keep → withdrawal_escrow → onchain_outflow + internal fee sink` | No pool change; only the net amount leaves custody |

This separates three quantities that should not be conflated:

- **reward budget** is the current `emission_pool` balance;
- **player liability** is KEEP already owed to players or held in payout escrows;
- **custody reserve** is eligible on-chain KEEP controlled by the payout wallet.

The pool can recycle gameplay spending, but it cannot create SPL tokens. Proof
of Reserves independently requires eligible custody to cover player and escrow
liabilities before a withdrawal can settle. Deposits never become reward
inventory, and moving tokens to the inactive distributor would neither refill
the ledger pool nor preserve withdrawal coverage.

For the stable Gold Forge path, if a deed contributes `c` SHARDS and all deeds
contribute `T` that UTC day, its integer payout is:

```text
floor(c × 273,972 / max(T, 350,000)) KEEP
```

- The daily budget is **273,972 KEEP**.
- The 350,000-SHARD soft cap keeps the maximum rate below parity: approximately
  **0.782777 KEEP per SHARD**. Above it, the rate dilutes pro rata.
- One deed's daily contribution cap grows with its Gold Forge from **2,000
  SHARDS at L1** to **200,000 at L20**.
- Contributed SHARDS settle out of play. KEEP becomes claimable; an allocation
  not claimed within 30 days returns to the emission pool.

### Where KEEP is spent

Ordinary in-game KEEP spend is **recycled 100% to the emission pool**. It does
not burn and does not become team revenue.

| KEEP use | Current curve |
|---|---|
| Additional Mines | Mines 2–8 cost 1,500 / 4,000 / 10,000 / 22,000 / 45,000 / 80,000 / 130,000 KEEP |
| Hero recruitment | Vex 3,000 KEEP; Theodor 10,000 KEEP, unless a matching contract is consumed |
| Hero leveling | Vex L1→L20 totals 2,171,700 KEEP; Theodor totals 1,911,400 KEEP |
| Item shop | Current priced examples range from a 60-KEEP Keg to 10,000-KEEP hero contracts; drop-only items are not free shop items |
| Raid buffs | War Horn 40 KEEP; Swift Boots 30 KEEP; raid Powder Charge 35 KEEP |
| Timer speed-up | With `u = ceil(seconds remaining / 30)`, cost is `max(1, 2u + ceil(2u² / 9,000))` KEEP |
| Buy SHARDS | **1 KEEP → 1 SHARD** for the selected base |

The KEEP-to-SHARDS conversion accepts a positive whole amount, returns the KEEP
to the emission pool, and credits the same number of SHARDS to the selected
base. It has no unlimited reverse exchange: SHARDS can reach KEEP only through
the bounded daily Gold Forge.

### Phase E — Gems

Specified by D-152; the Gems ledger, the KEEP → Gems conversion and the
Workshop spend path are live on devnet since October 2026 (the production server
reports them under `economy.gems` and `economy.workshop` in `GET /native/capabilities`). In Phase E
the sinks in the table above charge **Gems**, an in-game currency obtained only by
converting KEEP → Gems at 1:1 (LOCKED, D-152), with the KEEP recycled to the emission
reserve exactly as spent KEEP is today. **Gems → SHARDS at 1:1**, unlimited, replaces
the "Buy SHARDS" KEEP row; Gems never convert back to KEEP and are never withdrawable
or listable. The resource market and the in-game item market stay KEEP-denominated
with the D-150 90% seller / 10% real burn, and NFTs settle in SOL. At the custody
cutover every custodial KEEP balance becomes Gems 1:1 (no genesis claim); withdrawals
stay open until the announced close.

### KEEP withdrawal and the 2% fee

A withdrawal deducts a **2% fee from the gross KEEP request** and transfers the
98% net amount on-chain. For example, a 1,000-KEEP request records a 20-KEEP fee
and sends 980 KEEP. The fee is posted to the ledger's internal burn sink; no
separate SPL Token burn instruction is submitted.

Current guards include a 500-KEEP minimum, normally a 24-hour cancellable
unbonding period, one withdrawal per rolling 24 hours, wallet-wide limits that
scale from 50,000 KEEP at Keep L1 to 250,000 at L20, reserve/Proof-of-Reserves
checks, idempotency, and a kill switch. Strong mature authentication plus exact
wallet proof can qualify for the instant path.

## SOL prices and destinations

The player signs a SOL transaction and the API verifies the required destination
legs, amounts, and eligible gameplay effect before granting anything.

### Standard 40% / 35% / 25% routing

The active `shardkeep-core` payment path sends **40% to liquidity, 35% to
development, and 25% to operations**. Integer rounding dust goes to liquidity.

| Purchase | Current devnet-SOL price |
|---|---:|
| First or additional Land Deed | 0.20 each |
| Builders 2–6 | 0.50 / 0.75 / 1.00 / 1.50 / 3.00 |
| One raid energy | 0.03 |
| Six-energy pack | 0.09 |
| Ordinary shield extension (+12h, within the 48h cap) | 0.05 |

### Direct 100%-liquidity routing

These paths intentionally pay the liquidity wallet directly rather than using
the standard split:

| Purchase | Current devnet-SOL curve |
|---|---:|
| Land expansions 1–6 | 0.15 / 0.25 / 0.40 / 0.65 / 1.00 / 1.50 |
| Mine upgrades to L5–L20 | 0.50 at L5, rising to 3.20 at L20; 29.56 total |
| Gold Forge upgrades to L2–L20 | 0.10 at L2, +0.05 each level, 1.00 at L20; 10.45 total |

Mine upgrades to L2–L4 use SHARDS only. Every paid Mine or Gold Forge step also
charges its SHARDS upgrade price.

The separate **10-SOL Warzone shield** uses a composite transaction: half goes
straight to liquidity and half uses the standard split, for an effective
destination of **70% liquidity / 17.5% development / 12.5% operations**.

## Marketplace charges are not the withdrawal fee

Two distinct market paths exist:

- The direct in-game **item market** uses one buyer-signed SOL transaction:
  **95% goes to the seller and 5% to the configured fee treasury**. The 2%
  KEEP-withdrawal fee does not apply.
- Land Deeds trade through external Metaplex Core marketplaces. Each deed has a
  **5% royalty policy**, but the rule is marketplace-honoured rather than
  enforced on every direct transfer. Royalty handling and venue fees vary by
  marketplace.

A Land Deed transfer conveys the complete playable base and its local SHARDS.
It does not convey the seller's wallet KEEP or SOL.

## Current token state versus future design

The current branded Classic SPL devnet mint is
[`5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC`](https://explorer.solana.com/address/5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC?cluster=devnet).
An RPC check on 2026-08-18 showed **500,000,000 KEEP**, with mint and freeze
authorities still enabled.

Fixed supply, allocation, migration, and authority revocation remain future
mainnet design work. Internal ledger pools are named accounting sources and
cannot be added together to determine the on-chain supply. The withdrawal
worker separately checks reserves.

## Verification map

- Game prices, curves, splits, and limits:
  [`packages/shared/src/constants.ts`](../packages/shared/src/constants.ts)
- Mining formula: [`packages/shared/src/mining.ts`](../packages/shared/src/mining.ts)
- Ledger-backed spending and Forge settlement:
  [`apps/api/src/game`](../apps/api/src/game)
- Deposits and withdrawals: [`apps/api/src/money`](../apps/api/src/money)
- SOL program and marketplace boundary: [`SOLANA.md`](SOLANA.md)
- Current limitations and inactive paths:
  [`KNOWN_LIMITATIONS.md`](KNOWN_LIMITATIONS.md)
