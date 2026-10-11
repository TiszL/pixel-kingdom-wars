# MAP — scale & interest plan

> **Historical planning record.** The former KEEP `quest_bucket` described
> below is retired. Current reward sources and closed-alpha economy parameters
> are documented in [ECONOMY.md](ECONOMY.md); use


Owner brief (2026-07-29): *"maps are not well implemented — make it interesting and brainstorm how it should scale to 20,000 players."*

Synthesised from three independent proposals (territory / scale / matchmaking). Every claim below was re-verified against the code on 2026-07-29; line numbers are from that read.

---

## 0. Diagnosis — what is actually wrong

Three findings, in order of how much they matter.

**(a) The map is strictly dominated by a button.** `createRaid` (`apps/api/src/game/raids.ts:320`) never reads `plots` or `valleys`. Verified by grep: `plots` is referenced outside `schema.ts` only in `apps/api/src/game/world.ts` and `apps/api/src/game/baseTransfer.ts:81`. The only gates on a map attack are `RAID_RULES.mapTrophyWindow` (`raids.ts:343`), shields, `attackedToday`, and `logoffGraceMin` — none of which are spatial. So the map costs the same energy as `POST /raids` with no `defenderWallet`, gives a worse guarantee (auto-match *always* finds a legal opponent; the map hands you ~490 markers of which most are un-attackable), and offers nothing the button cannot. **This is the bug.** Terrain does not fix it.

**(b) `GET /map` is an N+1 with writes on the read path.** `getMapChunk` (`world.ts:317-338`) loops every player row and issues, per marker, one `shields` SELECT plus `getOrCreatePlayerAccount` — which is `INSERT … ON CONFLICT DO NOTHING` followed by a SELECT (`apps/api/src/ledger/accounts.ts:107`). That is **3 round trips and 1 write attempt per marker**. `MapQuery` (`routes.ts:691`) defaults the rect to the whole 25×20 grid and `map.tsx:220` calls bare `api.get('/map')`, so every open requests the whole valley.

**(c) The map has no memory.** `RAID_RULES.revengeLockHours = 4` exists at `constants.ts:883` and is **read by nothing in the repo** (verified by grep — the only other hit is a comment at `constants.ts:1034`). `raids_defender_created_idx` exists at `schema.ts:488` and its own comment says "revenge locks". The data and the index are already there; nothing consumes them.

Two smaller, real defects:

- **The terrain is 52% fiction.** `WORLD_GRID` (`mapTerrain.ts:51`) is 12 cols × 20 rows; the server grid is 25×20. `map.tsx:259` centres it with `OX = 6`, so columns 0–5 and 18–24 — **13 of 25 columns, 52% of all plots** — fall outside the authored art into `valleyFrontier` mountains and are force-patched back to grass by the `landSet` hack at `map.tsx:278`. `WORLD_ZONES` (`mapTerrain.ts:219`) carries a comment admitting its bands are decorative fictions.
- **Valley creation can storm.** `ensurePlotAssigned` (`world.ts:243`) reads `taken.size < WORLD.valleyCapacity` with no lock and calls `createValley` on the else branch. Concurrent signups against a nearly-full valley each create their own valley, fragmenting the world into half-empty cohorts.

---

## 1. The spine, and what was cut

**Spine: the matchmaking proposal (C).** It is the only one that diagnoses (a). A prettier map (A) or a better-sharded map (B) is polish on a screen that is strictly dominated; fixing dominance is what makes the other two worth building.

**Grafted in:**

- The N+1 / read-path-INSERT fix — all three proposals independently converged on it. Uncontested, ships first.
- From A: `burning` / `online` / `clanTag` marker state (all from tables and indexes that already exist), real valley names, and exposing `warzoneActive` — which `world.ts:316` already computes and then throws away.
- From B: the viewer-agnostic / per-viewer cache split, and deferring `wallet` off non-attackable markers.

**Cut, with reasons:**

| Cut | Why |
|---|---|
| B's chunk addressing (`chunk_id` generated column, `/map/chunks`, zoom tiers) | **On a 25×20 grid, chunking buys nothing.** 500 tiles for 500 players; a 1280×800 viewport at zoom 1 (TILE 46) covers ~28×17 = 476 tiles — i.e. *the entire valley is one screenful already*. Spatial chunking is a no-op until the grid grows. The correct bound today is semantic (cap candidates), not spatial. Deferred to L8, gated on L7. |
| B's grid growth 25×20 → 40×32 + `packages/shared/src/mapgen.ts` | Real, but it is a terrain-generator rewrite plus terrain-aware placement plus deleting `landSet`/`OX`/`OY`. Correct destination, not a today item. L7. |
| A's `district_holdings` table + `districtHolderBountyBonusBps` | A new table, a new cron job, and a **multiplier on a payout from the capped quest bucket** — for a flag on a hill. The free half (clan tag on markers) ships now; the money half waits. L9. |
| A's cross-valley gates / signposts | Signposting travel that does not exist is a worse lie than the current mountains. |
| C's Shard Rifts | The defender dividend **mints shards** from the capped 5% quest bucket. Owner decision #3 before any design work. |
| C's clan war (widened `warTrophyWindow`) | Whale-vs-minnow farming vector. Owner decision #4. |
| C's bands + weekly re-home | The one genuinely disruptive act (a player's keep physically moves valleys). Correct long-term shape; needs owner sign-off on the fiction. L6. |
| Moving `TILE`/`ZOOM`/`PAD` out of `map.tsx` into constants (B) | These are render constants, not game numbers. Moving them is Rule 3 scope creep. Revisit only if zoom starts gating what the server returns (L8). |

---

## 2. Payload & query math at 20,000 players

**Sizing.** 20,000 ÷ `WORLD.valleyCapacity` (500) = **40 valleys**. Grid is 25×20 = 500 tiles minus `WORLD.campsPerValley` (9) → up to **491 player markers** per valley. Assume 10% concurrent (2,000 online) and 20% of those on the map = **400 concurrent map viewers**.

**Today, measured off the code:**

- Round trips per `GET /map`: 1 (`plots ⋈ players`) + 1 (`getGameConfig`) + 491 × 3 + 1 (camps) ≈ **1,476, sequential**. Plus up to **491 INSERT attempts into `accounts`** — the ledger table — on a GET.
- At ~0.3 ms/round trip that is **~440 ms of held pool connection per map open**. postgres.js default pool of 10 → ceiling **~22 map opens/s**.
- Payload: a marker serialises to ~190 B (44-char `wallet` ≈ 55 B, `name`, `kind`, `x`, `y`, `keepLevel`, `trophies`, `shielded`, `surplusTease`, `isMe`). 491 × 190 ≈ **93 KB**, uncached, no ETag.
- `useFetch` (`map.tsx:220`) is fetch-once-on-mount, so today there is no polling. One open per screen entry, say every 3 min → 2.2 opens/s → **~3,250 q/s** and ~10% pool utilisation. Survivable-looking, but every open writes to the ledger table.
- **The moment the map polls** — which is the whole point of a live map — at 20 s: 400/20 = 20 opens/s × 0.44 s = **8.8 seconds of connection-time demanded per wall-clock second against a pool of 10**. The queue grows without bound. Egress would be 20 × 93 KB = **1.86 MB/s (15 Mbps)** for one screen. *Today's map cannot be polled at all.*

**After SHIP NOW:**

- `getMapChunk` becomes **4 flat queries**, zero writes: roster (`plots ⋈ players ⋈ clan_members ⋈ clans`), `shields WHERE player_wallet = ANY($wallets) AND expires_at > now`, `accounts WHERE owner_wallet = ANY($wallets) AND kind='player_keep'`, `pve_camps` by valley.
- The roster is **viewer-agnostic** → cached in-process for `WORLD.mapCacheSec` (20 s) under `${valleyId}:${warzoneActive ? 1 : 0}`. The per-viewer half (`isMe`, `inWindow`, `revenge`, `burning`, ranking, capping) is 2 indexed `raids` queries + in-memory work over ≤500 rows.
- DB load at 20k = 40 valleys × 4 ÷ 20 s (roster, **flat in viewer count**) + 400 viewers ÷ 20 s × 2 (overlay) = 8 + 40 = **~48 q/s**. Down from ~3,250 q/s at *lower* freshness.
- Payload: ≤ `WORLD.mapCandidateCap` (120) full markers at 190 B = 22.8 KB, plus ~370 non-attackable silhouettes as 4-field tuples (~28 B) = 10.4 KB, plus 9 camps ≈ 0.5 KB → **~34 KB**, a 63% cut *with more information on screen*. Polled at 20 s × 400 viewers = 680 KB/s (5.4 Mbps), and ETag/304 collapses most polls to ~200 B because the roster only changes on raid resolution and shield expiry.
- Memory: 40 valleys × 500 rows × ~150 B ≈ **3 MB** of roster cache in the API process.

---

## SHIP NOW

**One implementer, one day. Zero migrations, zero money code, zero sim code, zero program code.** Every table, column and index this needs already exists.

### S1 — Kill the N+1 and the write-on-read (`apps/api/src/game/world.ts`)

Replace the `for (const p of playerRows)` loop at `world.ts:317-338` with three set-based queries:

1. Roster: the existing `plots ⋈ players` join at `world.ts:298`, extended with `leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet)).leftJoin(clans, eq(clans.id, clanMembers.clanId))` to pick up `clans.tag`, and selecting `players.lastSeenAt`. Uses `plots_valley_xy_unique` (`schema.ts:432`) and `clan_members` PK — both exist.
2. `select({ playerWallet: shields.playerWallet }).from(shields).where(and(inArray(shields.playerWallet, wallets), gt(shields.expiresAt, now), warzoneActive ? eq(shields.source, 'warzone') : undefined))` → `Set<wallet>`. Uses `shields_player_expires_idx` (`schema.ts:297`). **The warzone-suppression semantics at `world.ts:325-329` must be preserved verbatim** — during a purge only `source='warzone'` shields count.
3. `select({ ownerWallet: accounts.ownerWallet, balance: accounts.balance }).from(accounts).where(and(inArray(accounts.ownerWallet, wallets), eq(accounts.kind, 'player_keep')))` → `Map<wallet, bigint>`.

**Delete the `getOrCreatePlayerAccount` call from this path entirely.** A missing `accounts` row means balance 0, which is exactly correct for `surplusTease`. Before deleting, grep the callers of `getOrCreatePlayerAccount` to confirm nothing relies on the map having lazily created accounts as a side effect.

### S2 — Roster cache (`apps/api/src/lib/mapCache.ts`, new, ~40 lines)

A `Map<string, { at: number; rows: RosterRow[] }>` with TTL `WORLD.mapCacheSec`, keyed `${valleyId}:${warzoneActive ? 1 : 0}`.

The warzone segment is **not optional**: `isWarzoneActive` flips shield visibility globally, and without it in the key a purge start would serve up to 20 s of markers claiming shielded bases the raid gate will happily let you attack.

Deliberately **in-process, not Redis**. Redis is currently workers-only (`apps/api/src/jobs.ts:164`, gated on `ENABLE_WORKERS`) — there is no request-path Redis client today, and `apps/api/src/lib/` contains only `errors.ts` and `validation.ts`. `ioredis` is already a dependency, so the swap is trivial when it is needed (L2), but adding a hard Redis dependency to the map's read path today would mean the map 500s when Redis blinks. Keep the module's interface `getRoster(valleyId, warzoneActive, loader)` so L2 is a one-file change.

**Enforce the public/private split with types, not review:** `RosterRow` (cached, public) vs `Marker = RosterRow & ViewerOverlay`. If `isMe`, `inWindow` or `revenge` ever leak into the cached struct, one player sees another's revenge list — make that a compile error.

### S3 — Server-side `inWindow` + candidate cap (`world.ts`, `getMapChunk`)

This is the change that stops the map being decoration. Compute, server-side, using the exact predicate from `raids.ts:343`:

```
window = Math.max(RAID_RULES.minTrophyWindow, Math.round(viewer.trophies * RAID_RULES.mapTrophyWindow))
inWindow = Math.abs(target.trophies - viewer.trophies) <= window
```

Then shape the response:

- **Full markers** (`wallet`, `name`, `keepLevel`, `trophies`, `shielded`, `surplusTease`, `clanTag`, `online`, `burning`, `revenge`) for: your own plot, all `revenge` targets, and the top `WORLD.mapCandidateCap` (120) in-window targets ranked by expected value — `surplusTease` first, then `!shielded`, then `keepLevel`, then trophy proximity.
- **Silhouettes** `{ x, y, keepLevel, trophies }` for everyone else. **No `wallet`, no `name`.** Side benefit: `GET /map` stops handing out every wallet in your valley in one request.
- Camps unchanged.
- Response gains `warzoneActive` — already computed at `world.ts:316` and currently discarded.

`map.tsx:247 outOfWindow()` stays as the pre-tap guard (its comment correctly notes server truth wins) but is no longer the only filter.

### S4 — The map remembers (read-only revenge, no migration)

Two indexed queries per viewer, both using indexes that already exist:

- `raids` where `defenderWallet = viewer`, `status = 'resolved'`, `createdAt > now - RAID_RULES.revengeLockHours` → `revenge: true` on those attackers' markers (`raids_defender_created_idx`, `schema.ts:488`).
- `raids` where `defenderWallet IN (wallets)`, `createdAt > now - WORLD.mapBurningHours` → `burning: true` (same index).

Plus `online = lastSeenAt > now - WORLD.mapOnlineMin` from the roster (`players.lastSeenAt`, `schema.ts:166`).

**In this step revenge is a badge and a sort key, not a rule change.** The trophy window still applies. A revenge target you cannot legally hit renders as `REVENGE — OUT OF RANGE`. That is honest, costs nothing, and creates the demand that L1 answers. It also finally reads `RAID_RULES.revengeLockHours`, which has been dead since it was written.

### S5 — WAR ROOM panel (`apps/web/src/ui/screens/map.tsx`)

`getMapChunk` returns `recommended: string[]` — `WORLD.recommendedTargets` (12) wallets, revenge-and-in-window first, then ranked in-window. A new `Pill` on the existing right rail (`map.tsx:382`, beside HIDE SHIELDED / LEGEND) opens a sheet; tapping an entry calls the existing `mapCam.centerOn` and opens the existing bottom sheet. Browsing 490 markers is a chore; this makes the map's ranking directly actionable while the terrain makes it legible.

Marker rendering: silhouettes at ~35% opacity, no nametag, not tappable. `revenge` reuses the `@keyframes skmapPulse` already defined at `map.tsx:584` inside `CampaignMap` — lift it to module scope so both maps share it. `burning` = scorch decal. `clanTag` = a chip beside the nametag, own-clan gold. `surplusTease` stays a boolean glint, **never a number** (GDD §3.4, correctly honoured today at `map.tsx:356`).

### S6 — Real valley names

`createValley` (`world.ts:216`) currently writes `Valley ${n}`; the banner at `map.tsx:374` prints `VALLEY ${valleyId.slice(0,8)}` — a UUID fragment shown to a human. Generate the name deterministically from `WORLD.valleyNameParts` and the valley's ordinal (*Grey Tarn*, *Ashfall Hollow*), return `valleyName` in the `/map` response, and show it in `Banner`. Backfill existing rows with a one-off in `apps/api/src/db/` alongside `reseedCamps.ts`. `valleys.name` already exists — no DDL.

### S7 — Client fetches its rect and polls (`map.tsx`)

Send the actual viewport rect instead of bare `api.get('/map')` at `map.tsx:220`, and poll on `WORLD.mapPollSec` (20 s, aligned to `mapCacheSec` so the client is not fighting the cache). **Pause polling on `document.visibilityState !== 'visible'`** — a backgrounded tab polling forever is how 400 concurrent viewers silently becomes 4,000. Add `ETag` / `If-None-Match` on `/map`.

`MapQuery` (`routes.ts:691`) gains a **warn-and-clamp** size guard against `WORLD.mapChunkMaxTiles` — clamp, do not reject, until telemetry shows no bare `/map` calls remain (see L8). Rejecting today would silently truncate any client that has not shipped.

### S8 — Valley-creation race (`world.ts:243`, ~30 min)

Wrap the occupancy scan and the plot INSERT in a transaction that takes `SELECT id FROM valleys WHERE id = $1 FOR UPDATE` first, so concurrent signups against a nearly-full valley serialise instead of each calling `createValley`. The two-attempt retry loop and the unique-violation handling stay exactly as written. This is the one item to drop if the day runs out — it only misfires at a valley boundary.

### Constants (all in `packages/shared/src/constants.ts`, `WORLD` block at `constants.ts:1185`, each with a source comment)

| Constant | Value | Purpose |
|---|---|---|
| `WORLD.mapCacheSec` | 20 | Roster cache TTL; client poll aligns to it |
| `WORLD.mapPollSec` | 20 | Client refetch cadence for the visible rect |
| `WORLD.mapCandidateCap` | 120 | Max **full** markers; revenge + own are additional |
| `WORLD.recommendedTargets` | 12 | WAR ROOM shortlist size |
| `WORLD.mapBurningHours` | 12 | How long after being raided a keep renders scorched |
| `WORLD.mapOnlineMin` | 10 | `lastSeenAt` window for the lit-window marker. **Not** `RAID_RULES.logoffGraceMin` — that is a raid gate ("just logged off"), different semantics; do not overload it |
| `WORLD.mapChunkMaxTiles` | 600 | Rect-size guard (clamp now, reject at L8) |
| `WORLD.valleyNameParts` | `{ prefixes, suffixes }` | Deterministic valley names from the ordinal |

### Tests (`apps/api/src/game/world.test.ts`, extend)

Per Rule 9, each test states *why*:

1. **"A brand-new player who has never held KEEP must still appear on the map."** Create a player with no `accounts` row, call `getMapChunk`, assert they appear with `surplusTease: false` — and assert the `accounts` row count is unchanged, because a GET must never write to the ledger.
2. **"The map must not leak the valley's wallet list."** Assert every non-attackable marker has no `wallet` and no `name` field.
3. **"A purge must not serve stale attackability."** Two `getMapChunk` calls inside `mapCacheSec` with `warzoneActive` flipped between them must not return the same `shielded` values.
4. **"Marker count is bounded by meaning, not by valley size."** Fill a valley to capacity; assert full markers ≤ `mapCandidateCap` + 1 (own) + revenge count.
5. **"One roster query serves every viewer of a valley."** Two different viewers inside the TTL issue one roster query, not two.

### Verification

- `pnpm --filter @shardkeep/api test` and `pnpm -r typecheck` green (Docker compose up first — Postgres :5433 / Redis :6380).
- Manual: a full valley `GET /map` goes from ~1,476 round trips to 6, and issues zero INSERTs.

### Explicitly NOT in SHIP NOW

No schema migration. No change to `createRaid`, loot, trophies, or the quest bucket. No change to `campCoords()` — **camps must not move**, because `raids.pveCampId` FKs `pve_camps.id` (`schema.ts:460`) so camps can never be hard-deleted, and `reseedValleyCamps` upserts on `(valleyId, x, y)`, meaning new coordinates would *orphan* the old camps rather than move them (a valley would end up with 18 camps, 9 at stale positions with stale `lootKeep`). That is a money path and gets its own commit, later. No change to `WORLD.gridCols/gridRows`, so every existing plot keeps its `(x, y)`.

---

## LATER — staged, each with its trigger

| # | Stage | Trigger | Notes |
|---|---|---|---|
| **L1** | **Revenge as a real rule** — bypass `mapTrophyWindow` and `attackedToday` for a specific resolved raid. Migration: `raids.revengedByRaidId uuid UNIQUE REFERENCES raids(id)`. | **Owner decision #1.** Highest gameplay value per line in the whole plan. | Non-farmable by construction: bound to one raid row, DB-unique so consumed once, requires `result.stars >= 1`, and **loot capped at the loot actually taken, trophies capped at the trophies actually lost** (both already in `raids.result`). Net across a colluding pair is ≤ 0 by arithmetic, not by policy. The consume **must** be stamped inside the existing Phase-2 transaction at `raids.ts:404`, following the idempotency re-check pattern at `raids.ts:410` — stamped outside, two concurrent revenge creates both pass. Needs a ledger-invariant test. |
| **L2** | Swap `mapCache.ts` to Redis (`ioredis`, already a dep; `REDIS_URL` already in config). | API instance count > 1, **or** `/map` p95 > 150 ms. | Must degrade to a direct query on any Redis error and log once a minute, not once a request. The map going slow is acceptable; the map going 500 is not. Jitter per-valley TTL ±20% to avoid a rollover herd. |
| **L3** | Rewrite auto-match's `orderBy(sql\`abs(trophies - me)\`)` (`raids.ts:388`) as two index-friendly range scans merged in JS; add `players_trophies_idx`. | `players` > 5,000 rows, **or** `POST /raids` p95 > 200 ms. | `abs()` is unindexable — today it is a full scan + sort of `players` on every auto-match. Semantics identical (nearest-rated first). |
| **L4** | `pg_trgm` GIN on `players.name` + `text_pattern_ops` btree on `players.wallet`; run `searchPlayers` (`world.ts:434`) as two queries **UNION'd**, never `OR`'d. | `players` > 10,000. | The current `ilike '%needle%' OR ilike 'needle%'` defeats every index — a full seq scan per keystroke past the 250 ms debounce. ~40–80 ms at 20k; a p99 incident at 200k. Also raise `searchMinChars` 2 → 3. |
| **L5** | Dormant-plot reclamation + fill-the-gaps assignment: null `plots.playerWallet` (already nullable, `schema.ts:431` — no DDL) when `lastSeenAt` is older than `WORLD.dormantReclaimDays`; `ensurePlotAssigned` picks the *least-full valley under a soft cap* instead of `orderBy(desc(valleys.createdAt))`. | Any valley's 30-day-active population < 40% of `valleyCapacity`. | **Owner decision #5.** Safe because all base state is keyed on `wallet`, never on plot — a returning player is re-seated by the existing idempotent path with their base intact. Verified: `deed.ts` / `deedMetadata.ts` do not reference plot coordinates, so this cannot desync a minted Land Deed. |
| **L6** | **Marches** — `valleys.band` + `bandEpoch`, band-aware assignment, weekly re-home piggybacking `runWeeklyLeagueReset` (`social.ts:49`). | ≥ 8 valleys (~4,000 players). Below that a single cohort is fine. | **Owner decision #2.** Makes "who is near me" ≈ "who I can legally fight", and gives climbing a visible consequence. Guards: hysteresis (`bandHysteresisTrophies`) so nobody ping-pongs weekly; skip players with a `pending_orders` raid; **no-op entirely while `isWarzoneActive`**. |
| **L7** | Grid 25×20 → 40×32; move the generator to `packages/shared/src/mapgen.ts` seeded on `valleys.seed`; terrain-aware placement (`plotFillOrder` → `buildableOrder(seed)`); **delete `landSet` and `OX`/`OY`**. | After L6, or whenever the 52%-of-columns art defect is prioritised. | **Owner decision #7.** 25×20 nests inside 40×32, so every existing `(x,y)` stays valid — no plot data migration. Keep `WORLD_GRID` as the authored valley *core* stamped at centre; it is the owner's handout art, not disposable. `mapTerrain.test.ts` must stay green and must guarantee "a plot tile is never water" *by construction*. Once placement is terrain-aware, a keep in the sea is a bug that must be visible, not papered over. |
| **L8** | Chunked fetching: `chunk_id` STORED generated column on `plots`/`pve_camps` (DDL string generated from `WORLD.chunkTiles` so the number has one source), `GET /map/chunks`, `GET /map/plot/:id`, zoom tiers. Flip the `MapQuery` guard from clamp to reject. | **Strictly after L7.** | On today's 25×20 grid the whole valley is one viewport — chunking is a no-op and pure cost. It becomes necessary only once the grid exceeds a screenful. Rate-limit `/map/plot/:id` with the existing `paid` limiter so a script cannot walk plot ids to rebuild the wallet list the silhouette format withholds. |
| **L9** | Districts + clan holder banners + per-district aggregates, recomputed by a job beside `pve-respawn` (`jobs.ts:171`) — never on read. | After L7 (needs a grid worth partitioning). | Replaces `WORLD_ZONES`, whose own comment admits it is fiction. Ship the *display* half first. The `districtHolderBountyBonusBps` payout multiplier is a separate decision (owner #6) — if built, it must be re-derived server-side from the holdings table **at payout time**, inside the payout transaction, and **never baked into `pve_camps.lootKeep`**, which `reseedValleyCamps` overwrites. |
| **L10** | Camp relocation / seeding `campCoords()` on the valley (`world.ts:152` — identical nine coordinates in every valley today). | Bundled with L7. **Its own commit, always.** | Requires `pve_camps.active boolean default true` and a soft-deactivate pass, because `raids.pveCampId` is an FK and replay integrity depends on the rows. Must reuse the existing in-flight guard at `world.ts:185-192` verbatim — its reasoning (a live raid pays the camp's *current* `lootKeep` against a *frozen* snapshot) is sound and must be preserved. Test: reseed with a new seed, assert `count(pve_camps) == campsPerValley` and that an in-flight camp survived byte-identical. |
| **L11** | Shard Rifts (rotating hotspots, request-time derived like `isWarzoneActive` at `warzone.ts:23` — no cron, no state). | **Owner decision #3.** | The attacker-side bonus is safe by design if it raises `LOOT.capPerAttackerKeepLevel` only — loot stays zero-sum against the defender's real surplus, so a rift cannot mint. The **defender dividend does mint** and must be funded from the capped 5% quest bucket like `PVE.bountyByTier`. If the bucket cannot fund it at 20k, cut the dividend rather than uncap the bucket. |
| **L12** | Clan war / declared feuds. | **Owner decision #4.** Ship last, watch hardest. | Widening the trophy window is a real fairness hole. Bound by `CLANS.warTrophyWindow` (never unlimited), a median-trophy proximity requirement, a per-day war-raid cap, and a shard cost to declare. |
| **L13** | Region sharding (`region_id` as partition key). | > 200,000 players, or Postgres primary CPU > 60% sustained. | Everything a single player touches is already region-local; only the global leaderboard and `/map/search` cross regions, and both are cache-fronted aggregates by then. |

---

## Owner decisions needed

1. **Does revenge bypass the trophy window?** (L1) — the single highest-value gameplay change here. The proposed guard is restitution-only: capped at exactly what was taken, so a colluding pair nets ≤ 0. Yes/no, and sign-off on the cap being the *actual* loot and trophies from the triggering raid.
2. **May a player's keep move valleys?** (L6) — bands only work if re-homing is acceptable fiction. If not, valleys stay signup cohorts and matchmaking quality degrades as trophies diverge.
3. **May the map mint shards?** (L11) — the rift defender dividend. If yes, it comes out of the capped 5% quest bucket; if the bucket cannot fund it at 20k, the dividend is cut, not the cap.
4. **Widened trophy window for clan feuds** (L12) — `CLANS.warTrophyWindow` proposed at 0.5 vs the standard 0.2. This is deliberately not "unlimited", but 0.5 still lets a strong clan reach further down than normal. Number needs an explicit call, not an alpha placeholder.
5. **Dormant plot reclamation at 14 days** (L5) — reclaiming a plot is safe for base state (wallet-keyed) and does not touch the deed, but it is a visible "your spot was taken" moment. Confirm the day count and whether returning players should be told.
6. **Territory bonus on PvE bounty** (L9) — `districtHolderBountyBonusBps`. Any multiplier on a quest-bucket payout is money code. Recommend shipping districts as pure display first and deciding this separately.
7. **Grid growth 25×20 → 40×32** (L7) — halves valley density (500-in-500 tiles → 450-in-1280). Makes the terrain readable and fixes the 52%-fiction defect, but changes how crowded a valley *feels*. Art call as much as an engineering one.

**Pre-existing behaviour that L6 will make visible, flagged not changed:** `mapTrophyWindow` is computed from the *attacker's* trophies (`raids.ts:343`), so reach is asymmetric — a 5,000-trophy player reaches down 1,000 while a 4,000-trophy player reaches up only 800. Banding puts that asymmetry on screen for the first time (the top of a march can hit the bottom, not vice versa). It is the current live rule and this plan does not touch it, but the owner should decide whether it is intended before L6 ships.

**Adjacent open item:** `RAID_RULES.sameTargetCooldownHours` (`constants.ts:885`) is also unread — `attackedToday` enforces the once-per-day rule directly. Per Rule 7, either wire it or delete it; do not leave two contradictory sources for the same rule.
