# E2 — Workshop refining contract (frozen for implementation; M41 B3)

Status: **specified** (2026-09-20); **implemented, dark** the same evening (M41 B4 sub-block D: `apps/api/src/game/workshop.ts`, `workshopRoutes.ts`, `test/workshop-jobs.test.ts` 26/26) behind `FORGE_INGOTS_ENABLED=false` (child of `PHASE_E_BUILDINGS_ENABLED=false`). Implementation notes that differ from or extend the frozen text: the capacity ladder input `progressBps` is a PROPOSED stand-in (K-154) and `FORGE_INGOT.capacity` holds the 4/24 deed bounds; extra registry code `JOB_NOT_FOUND` 404 for an unknown or foreign job id; a former owner replaying a start POST after a deed transfer gets `BASE_NOT_OWNED` and recovers through the by-key receipt; the routes are registered by `registerWorkshopRoutes(app, db, { market })` from `app.ts`; D-153 adds `economy.workshop { enabled, recipeVersion }`; pausing starts preserves authenticated view/collect/receipt recovery, and owned ingots remain visible (K-154). Authority: D-149 (ingot = 10,000 SHARDS LOCKED; Workshop required; capped refining and storage; protected final commitment), D-150 (SHARDS tax applies at earning, never at refining — a conversion), native `PHASE_E_GOLD_FORGE.md` @ `11504e2` §"September 20 addition" (deterministic refining, no random failure, no SOL fee, batch jobs completing into the producing base, unreserved ingots tradable, jobs follow the base on transfer, no new theft rule), `E1-CONTRACTS.md` §1.2/§4.1, `E1-NUMERICAL-SPEC.md` §6, journey model §3. This file freezes the first stateful E2 slice: the Workshop building (dark), the Forge Ingot item, the refining job, its persistence, idempotency, replay, caps, exposure, flags and tests. Gold Forge v2 commitment (`/forge/v2/*`) is **not** in this slice (E4 with mining). Code cited at `943240ca`.

## Continuation amendment — Workshop-only capacity v1 (D-153.13)

On 2026-09-21 the owner's delegation selects the existing Keep-level deed ladder,
refining multiplier and holding multiplier for Workshop-only use. This supersedes
those rows' PROPOSED status below, while E4 mining qualification/activity/roster
remains unapproved and separate. Capacity evidence
records the bounds. Accounting implementation and migration are in progress.

All free bases share one wallet allowance, including inactive free-base holdings.
Deed daily usage follows all that base's starts across transfers. Free daily usage
follows the original starter and frozen free classification across upgrades/sales.
Historical unclassified jobs retain NULL scope and count conservatively against both
applicable daily limits. New starts sample time after ownership locks; UTC intervals
exclude the next day. Paid collection and immutable receipts remain recoverable even
above a later/imported capacity. Client responses distinguish selected-base stock
from aggregate allowance. No marketplace reservation or E4 mining path is implied.

## 0. Locked vs PROPOSED
| Rule | Value | Status |
|---|---|---|
| Recipe | 10,000 SHARDS → 1 Forge Ingot, deterministic, no failure, no SOL | LOCKED (D-149 §5) |
| Workshop required | a base refines only with a standing Workshop | LOCKED (D-149 §5) |
| Refining cap | ≤ `refineDailyCapMultiplier × allowance capacity` ingots started per UTC day | LOCKED shape (D-149), D-153.13 Workshop v1 multiplier 3 |
| Holding cap | held + listed + reserved + in-progress ≤ `holdingCapMultiplier × allowance capacity` | LOCKED shape, D-153.13 Workshop v1 multiplier 7 |
| Batch | `min(batch.max, batch.baseSize + workshopLevel × batch.perWorkshopLevel)` ingots per job | PROPOSED 30 / 10 / 1 |
| Duration | `ingots × refineSecPerIngot × (1 − refineSpeedupBpsPerLevel × (level − 1) / 10,000)` | PROPOSED 360 s/ingot at L1, −2 %/level |
| Cancellation | **none** — a started job is final (refining is a spend, like a build) | PROPOSED, reason §5 |
| Workshop build | `BUILD_COSTS.workshop` PROPOSED ≤ 2,000 SHARDS at Keep L3 (journey model §3.1), 2×2, one per base, 20 levels, 4 visual tiers | PROPOSED (D-149 §10 delegated tuning) |
| Capacity source before E4 | `PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay` (2) for a deedless wallet; deed base `4 + floor(20 × progressBps / 10,000)` (the wallet model's PROPOSED ladder) | D-153.13 Workshop v1; does not select E4 mining qualification |

Delegated-tuning rule for constants: values above enter `packages/shared/src/constants.ts` (`FORGE_INGOT`, `BUILD_COSTS.workshop`, `UPGRADE_COSTS.workshop`, `UPGRADE_TIMES_SEC.workshop`, `STRUCTURES.workshop`) with a `// D-149 §10 delegated tuning — PROPOSED, dark` comment; the Phase E catalogue does **not** advertise them; every routed value is read from constants, never inlined.

## 1. Building (commit A + dark placement)
- `BuildingType` += `workshop`, `lodge`, `market`, `harvester`, `berth` (D-152 §2.1-4). Commit A adds the enum values, `STRUCTURES` rows (`footprint: [2,2]`, `hp` PROPOSED, `maxLevel: 20`), `BUILD_COSTS`, `UPGRADE_COSTS`, `UPGRADE_TIMES_SEC`, `BUILD_COUNT_CAP_BY_KEEP` (one per base), `sim/stats.ts:buildingMaxHp`, `api/footprints.ts` — with **byte-identical SIM output** proven by the 15 golden fixtures and the SIM_VERSION CI check (no placement possible, so no replay can contain them).
- Placement of the five types is refused with `PHASE_E_DISABLED` 503 P unless `PHASE_E_BUILDINGS_ENABLED=true` (commit B, SIM 18, later gate). The Workshop slice is therefore exercised in tests by inserting a `buildings` row of type `workshop` directly (fixture helper `createWorkshop(baseId, level)`).
- `workshop.level` is the standing building's level (`buildings.level`); an in-progress upgrade keeps the previous level for batch/speed until completion (the builder-job rule).

## 2. Item: `forge_ingot`
`ITEMS.forge_ingot = { name: 'FORGE INGOT', kind: 'material', costKeep: 0, asset: 'pe_ingot', desc: …, rarity: 'uncommon', weight: 0, acquisition: { type: 'craft' }, maxOwned: null }`. New `ItemKind` `'material'` and `ItemAcquisition` `{ type: 'craft' }` (`constants.ts:4062`, `:4083`). Never sold by the system (`costKeep: 0` = never sold, the gear convention), never `dropOnly` (owner: ordinary tradable material), **base-scoped** inventory (`base_items`, `schema.ts:2793`; follows the base on deed transfer), `acquired_via: 'craft'`. Ingots enter `base_items` only through `collect` (§4) and leave through Gold Forge commitment (E4), a KEEP-market listing (E3a/E4 market slice) or a future recipe. No EXP for refining (E1-NUMERICAL §6).

## 3. Persistence
```
workshop_jobs (
  id uuid pk, base_id uuid not null → bases (cascade), started_by_wallet text not null → players,
  workshop_level_at_start int not null, recipe_version int not null,
  ingots int not null check (ingots > 0), shards_charged bigint not null check (shards_charged = ingots * 10000) -- literal replaced by the constant in the check builder
  started_at timestamptz not null default now(), ready_at timestamptz not null, collected_at timestamptz,
  collected_by_wallet text, debit_ledger_txn_id uuid not null unique → ledger_transactions,
  start_idempotency_key text not null, collect_idempotency_key text,
  unique (started_by_wallet, start_idempotency_key), unique (collected_by_wallet, collect_idempotency_key),
  index (base_id, collected_at), index (base_id, started_at)
)
```
- SHARDS are **spent at start**: `postTransaction` type `workshop.refine`, entries `base_shards −shards / shard_burn +shards` (the `spendBaseShards` shape), key `workshop:<baseId>:<wallet>:<key>`, metadata `{ wallet, baseId, ingots, shards, recipeVersion, workshopLevel }`. The debit id is stored on the row; refining is a conversion under D-150 (no tax, no receipt).
- `refined_today(base)` = Σ `ingots` of jobs with `started_at` in the current UTC day; `holding(base)` = `base_items.qty(forge_ingot)` + listed (E4 market) + reserved (E4 commit) + Σ `ingots` of uncollected jobs.
- No worker: readiness is `ready_at ≤ now` on read; `collect` is the only completion path (the builder-job "lazy completion" rule; the M33 push sweep may notify at `ready_at` later).

## 4. Commands and routes (E1-CONTRACTS §4.0 conventions; `authOnly` + `mutationBaseId` + `stablePrerequisiteContext`)
| Route | Body | 2xx | Codes (D = definitive, P = pre-write refusal) |
|---|---|---|---|
| `GET /workshop?baseId=` | — | `{ features.workshop: { version: 1, receipts: 1 }, acceptingJobs, level, recipeVersion, batch: { size, max }, secPerIngot, dailyRefineCap, refinedToday, holding: { held, listed, reserved, inProgress, cap }, capacity, jobs: [{ jobId, ingots, shards, startedAt, readyAt, ready, collectedAt }], serverNow }` | 404 `BASE_NOT_OWNED`; available while paused with `acceptingJobs:false` |
| `POST /workshop/jobs` | `{ idempotencyKey, baseId, ingots, recipeVersion }` | 201 `{ jobId, ingots, shardsCharged, readyAt, serverNow }` | `WORKSHOP_REQUIRED` 409 D (no standing Workshop); `RECIPE_VERSION_STALE` 409 D; `BATCH_EXCEEDED` 422 D; `REFINE_CAP_EXCEEDED` 422 D (`refinedToday + ingots > dailyRefineCap`); `HOLDING_CAP_EXCEEDED` 422 D (counts in-progress); `INSUFFICIENT_SHARDS` 422 D; `IDEMPOTENCY_BODY_MISMATCH` 409 D |
| `GET /workshop/jobs/by-key/:key` | — | `{ wallet, idempotencyKey, status: 'unknown'\|'accepted', receipt\|null, serverNow }` | receipt = the job row + its `workshop.refine` transaction (verifier checks base, wallet, ingots × recipe = shards, `base_shards`/`shard_burn` entries) |
| `POST /workshop/jobs/:jobId/collect` | `{ idempotencyKey }` | 201 `{ jobId, ingotsCredited, held, serverNow }` | `JOB_NOT_READY` 409 D (poll after `readyAt`); `JOB_ALREADY_COLLECTED` 409 R (returns the existing receipt); `BASE_NOT_OWNED` 404 (collect by the **current** owner only) |
| `GET /workshop/jobs/:jobId/collect/by-key/:key` | — | receipt envelope | |

Native intent kinds (code 26): `workshop-job`, `workshop-collect` (one outstanding per kind per wallet; a second job cannot start while the first POST is Unknown — receipts resolve it).

## 5. Rules that must not drift
- **Start is final.** No cancel/refund: a cancellable job would be a free raid shelter (start a job with all base SHARDS before a raid, cancel after). The builder-job cancel receipt pattern (`builder_jobs.paidShardCost`, `schema.ts:705-732`) is deliberately not reused.
- **Exposure.** SHARDS spent at start are gone (not raidable, like a build). Ingots in progress and held ingots are **not raid loot** (`raidLoot.ts` reads `base_shards` only; no new theft rule — native record); their shelter is bounded by the holding cap, and the journey model reports it per controller. Committed ingots (E4) are protected and final.
- **Replay and transfer.** Jobs and held ingots are base-scoped and follow the deed on transfer; `collect` needs the current owner's authority (`lockStablePrerequisiteBase`); the starter's receipt (`by-key`) still resolves after a transfer without disclosing the new owner's state (the `conversionReceipt.ts` rule).
- **Versioning.** `recipeVersion` is frozen into the job; a running job finishes under its frozen recipe; the catalogue bump answers `RECIPE_VERSION_STALE` only at start.
- **Clock.** `readyAt` and `serverNow` come from the server; the device clock is never authority.
- **Caps count the day in UTC** (`refinedToday` resets at 00:00 UTC — the Forge day rule); the holding cap counts uncollected jobs.

## 6. Flags
| Flag | Default | Parent | Gates |
|---|---|---|---|
| `PHASE_E_BUILDINGS_ENABLED` | false | — | placement/upgrade of the five types (commit B) |
| `FORGE_INGOTS_ENABLED` | false | `PHASE_E_BUILDINGS_ENABLED` | New `POST /workshop/jobs` only; unowned `forge_ingot` catalogue entries. Views, collect, receipts and owned inventory stay available while paused (D-153). |

(M41 named the second flag `PHASE_E_WORKSHOP_ENABLED`; the E1 flag table's `FORGE_INGOTS_ENABLED` is the frozen name.) Both literal `process.env` reads; boot refinement on the parent; names in both env examples. Capabilities: `economy.workshop: { enabled, recipeVersion }` (additive).

## 7. SIM and content
No SIM change in this slice (no placement). Commit B (placement, SIM 18, golden `phase_e_structures.json`, compatible APK) is a later gate. Content pack: the `forge_ingot` icon and Workshop art are already illustrated in the package (`E1-ASSET-INTEGRATION.md`); admission is not part of this slice.

## 8. Tests (names frozen)
`apps/api/test/workshop-jobs.test.ts`: start/collect happy path with `createWorkshop`; `WORKSHOP_REQUIRED` without the building; batch, refine-cap (UTC reset), holding-cap (counts in-progress) and insufficient-SHARDS refusals; idempotent start (same key → same row; different body → 409); `JOB_NOT_READY` before `readyAt`, collect after; double collect → existing receipt; deed transfer between start and collect (new owner collects; starter's receipt still resolves; old owner cannot collect); recipe bump → `RECIPE_VERSION_STALE`; SHARDS burned at start are absent from raid loot (`raidLoot` fixture); flags off → starts refuse 503 before any write; views advertise `acceptingJobs:false`; paid jobs remain discoverable/collectible with current-owner authority, exact receipts and no duplicate credits; `commit-a-sim-stability.test.ts`: golden fixtures byte-identical with the five enum values present; `constants.test.ts`: `FORGE_INGOT.shardsPerIngot === PHASE_E_POLICY.forge.shardsPerIngot`, one Workshop per base, batch/caps positive.

## 9. Open items (not blocking B4)
Workshop upgrade ladder values (PROPOSED, delegated); whether the M33 push sweep notifies at `readyAt` (nice-to-have); the E4 capacity read model replacing the PROPOSED ladder; the KEEP-market listing of ingots (E3a/E4).
