# Gameplay

Pixel Kingdom Wars is a persistent base-building strategy game. A player grows a Keep, lays out defenses, trains an army, raids other bases, and advances through an authored campaign.

All tunable gameplay numbers come from [`packages/shared/src/constants.ts`](../packages/shared/src/constants.ts). This document explains systems rather than becoming a second balance table.

Costs, rewards, and emission curves are current playtest settings and may be retuned to improve progression and in-game economy health.

## Core loop

1. **Build** — place and upgrade a Keep, economy buildings, barracks, camps, walls, defenses, and traps.
2. **Collect** — physical Mines buffer SHARDS until collected; a Vault shields part of your raid-lootable SHARDS by level (D-065); quests and combat add other rewards.
3. **Prepare** — train one of fourteen player-trainable troop types, research levels, recruit/equip heroes, and choose a saved layout.
4. **Attack** — play authored campaign stages, raid Ruined Keeps, or spend raid energy and a SHARDS ante to attack another player.
5. **Defend and iterate** — replay the result, improve the layout, repair traps, adjust the army, and progress the Keep toward level 20.

## Onboarding and Land Deeds

The alpha supports a limited deedless base so a player can learn the building loop without first paying. Buying the first land uses a 0.2 devnet-SOL on-chain entry payment. The API then creates a world parcel and mints a Metaplex Core Land Deed. Additional deeds use the repeatable deed payment rail.

A deed unlocks the full land-backed loop, including world presence, deed-owner PvP pools, the Gold Forge, land trading, and deed-scoped economic state. Deedless and deed-backed bases remain separate PvP pools.

One wallet may own more deeds than it actively plays, but at most five bases can be active. Each active slot points to a stable `base_id`; gameplay is never keyed only to whichever wallet currently holds a deed.

### What transfers with a deed

The complete playable base transfers when deed ownership finalizes:

- parcel and layout;
- Keep/structure progression, expansions, jobs, builders, research, and army;
- heroes, equipment, inventory, and saved layouts;
- deed-local SHARDS, Mine buffers, and Gold Forge positions;
- trophies, shields, raid locks, battle history, and other base-scoped state.

Wallet identity, wallet KEEP/SOL, authentication factors, clan membership, referrals, and account-wide cosmetics remain with the wallet. The server rechecks fresh chain ownership before privileged deed actions and fails closed when ownership is stale or unavailable.

## Fantasy world and exploration

The globe has eight named realms: Frostveil, Elderwood, Sunscar, Crownlands,
Solana Reach, Stormcairn, Thornwake and Cinderfall. Its frozen catalog contains
85,414 deed tiles, including reserved Genesis and Seeker allocations. Reserved
land cannot be acquired through ordinary checkout. Genesis award distribution
and Seeker claiming are not implemented.

Real keep markers cluster when nearby parcels would overlap. Zooming, owner
search, My Parcel and cluster member lists provide access to parcel inspection,
owned-base navigation and available scouting actions. Assignment coordinates
persist through transfers and deactivation.

Seven exploration chains contain 32 islands. These are permanently non-owned
locations with close-up resource scenery and ambient animation. Dispatch remains
locked; harvesting, inventories and expedition rewards are not implemented.

Each realm themes the full base ground and surroundings. Visual themes, sanctuary
clouds and decorative effects do not alter building footprints, deployment bounds,
resource rates or battle outcomes. New replay visual context preserves the
battle's terrain; older records without that context default to Crownlands.

## Progression and base systems

The Keep progresses from level 1 to 20. Keep level gates structures, quantities, troop research, army capacity, and other progression. The buildable claim begins at 14×14 tiles and expands, while the full plot retains a two-tile attacker deployment ring.

Persistent structure families include:

- **Economy/support:** Keep, Mine, Vault, Barracks, Camp, Forge, Gold Forge, hero altar, Clan Hall, and walls.
- **Eight defense families:** Cannon, Archer Tower, Mortar, Air Defence, Electric Tower, Mage Tower, Laser Tower, and Dragon Nest.
- **Four trap families:** Spike Trap, Powder Mine, Pitfall, and Air Mine.

Walls have five visual tiers: reinforced timber (levels 1–4), hewn stone (5–8),
dressed stone (9–12), reinforced stone (13–16), and Shard crown (17–20).
Connections account for adjacent tiers in bases, layout editing and battles.
The art progression does not change wall statistics or upgrade rules.

Mines are physical buildings rather than an account-only emission multiplier. They accrue into a one-day local buffer, must be collected, can be looted when destroyed, and scale up to eight per base through progression. Traps persist but require repair after use.

## Currencies and value

### SHARDS

SHARDS are the soft, deed-local base currency. They pay for ordinary construction and progression, serve as the PvP attack ante, and can be committed to the Gold Forge. A deed sale therefore conveys both the base and its local SHARDS economy.

### KEEP

KEEP is the wallet-level devnet SPL token and custodial game-ledger balance. It pays for hero recruitment and leveling, items and raid buffs, timer speed-ups, and Mines two through eight. Ordinary troop training, research, construction, and structure upgrades use SHARDS. In-game KEEP sinks recycle to the emission pool; the 2% withdrawal fee is the exception and is accounted to an internal ledger sink, not burned on-chain. KEEP does not transfer with a Land Deed.

Players can convert KEEP to SHARDS at 1:1 inside the game. The KEEP returns to the emission pool and the SHARDS are credited to the selected base. The reverse direction is deliberately limited to the capped daily Gold Forge rather than being an unlimited exchange.

Players may deposit or withdraw the current devnet KEEP subject to confirmation, unbonding/authentication rules, minimums, and rolling wallet limits. Buying KEEP for SOL is currently unavailable and fails closed.

### SOL

Devnet SOL pays for land and selected premium actions such as additional builders, raid energy, shield extension, high-level Mine and Gold Forge progression, and marketplace purchases. The API verifies finalized or confirmed transactions, depending on the path, before granting the effect.

## Gold Forge

The Gold Forge is the only gameplay path that converts SHARDS into newly allocated KEEP. A deed contributes SHARDS up to a Forge-level daily cap. At settlement, all eligible deed positions split a bounded daily KEEP budget pro rata. Participation below the soft cap scales total distribution down; the exchange rate cannot exceed parity under the configured invariant.

Allocations become claimable and expire back to the emission pool if left unclaimed. Forge contribution state and payout history belong to the deed; claimed KEEP belongs to the wallet.

## Combat

The simulator contains sixteen troop actor types:

- **Fourteen trainable attackers:** Highlander, Bowman, Keg Runner, Tunneler, Tur Rider, Plunderer, Giant, Troll, Dragon, Mage, Bilgewraith, Gloamfang, Direwyvern, and Hexbarrow.
- **Two generated actors:** Barrowling (spawned by Hexbarrow) and Wyrmling (Dragon Nest defender).

Troops have authored target preferences and wall policies. Examples include Keg Runner wall blasts, Tunneler/Bilgewraith burrowing, Plunderer resource targeting, Giant defense hunting, Dragon/Direwyvern flight, Gloamfang support/control, Direwyvern fire zones, and Hexbarrow broods.

Two heroes are playable:

- **Vex** — offensive hero progression and abilities.
- **Theodor** — defensive/tank-oriented hero progression and abilities.

Heroes can carry Forge-dropped gear. Their equipped loadouts are frozen into a raid snapshot so a later equipment change cannot alter an existing battle.

### Resolution and stars

Combat runs at a fixed 100 ms tick with seeded RNG and integer positions. The simulator awards one star for each condition met: at least 50% destruction, destroying the Keep, and 100% destruction. The server freezes a raid snapshot, accepts an append-only command stream, resolves with a pinned simulator version, and settles once.

Historical playback uses the archived authoritative event timeline. It does not ask a future browser to re-simulate an old battle under newer code.

## PvP

- Every player regenerates six free raid-energy units per UTC day.
- Extra energy can be bought with devnet SOL and stockpiles; there is no separate hard raids-per-day ceiling.
- Starting an attack also spends a Keep-level-scaled SHARDS ante.
- Target previews expose approximate loot bands, never the defender's exact private balance.
- The defender base and economic snapshot lock when the raid begins.
- A zero-star attack pays no loot and grants no loss shield.
- When the defender loses (the attacker earns at least one star), that base receives a 48-hour shield; paid extension is capped at the same 48-hour horizon.
- Exact settled loot can come from liquid SHARDS, open Forge stake, and destroyed Mine buffers under the frozen snapshot rules. Up to 50% of a deed's liquid + open-Forge SHARDS is at stake; the highest Vault still standing at the end shields 1.5 points of that per level (30 points at L20, leaving 20% lootable), and a Vault that falls protects nothing (D-065).

## PvE and campaign

The campaign has 100 authored encounters in ten chapters across Crownlands, Elderwood, Sunscar and Frostveil, five encounters per Keep level. Each stage pins a formation, defenses, walls, traps, mines, threat tier, and sometimes a defending hero. Difficulty is tested with recommended-budget simulation armies.

Ruined Keeps are a separate PvE system. They cost no PvP energy, do not break shields, and do not award trophies. Eligible victories can award rare KEEP prizes from the bounded gameplay emission pool. A controlled maximum-tier practice camp exercises the full defense roster outside ordinary world rotation.

## Quests, items, and social systems

- Fifty daily quest templates are active together. Completing any three earns the daily bonus.
- One weekly quest rotates from five templates.
- Forge drops, loot boxes, hero contracts, troop unlock writs, gear, and consumables use an inventory system with a direct player item market. Each item-market purchase sends 95% of the buyer's SOL payment directly to the seller and 5% to the configured fee treasury.
- Profiles, chat, mail, referrals, leaderboards, blocking/reporting, and moderation paths are implemented.
- Clan data and preservation paths exist, but the player UI intentionally presents clan warfare and interactive clan play as **coming soon**.

## Authority and privacy

The client never decides whether a player can afford or perform an action. The API re-resolves the selected base, current deed owner, balances, limits, collision rules, timers, and locks inside authoritative transactions. Defenders do not reveal exact wealth before a raid. Public map responses expose only the data intended for discovery; sensitive account and ownership actions require authentication and fresh proof.

For the system boundary behind these mechanics, see [ARCHITECTURE.md](ARCHITECTURE.md). For chain behavior, see [SOLANA.md](SOLANA.md).
