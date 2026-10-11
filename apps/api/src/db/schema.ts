/**
 * SHARDKEEP — Drizzle schema (ARCHITECTURE §5, GDD v1.5 §4.9).
 *
 * Foundation phase: the FULL table set is defined now so later phases
 * (raids, emission, quests, …) only add code, not migrations-with-renames.
 * Only ledger + auth tables are exercised by code in this phase.
 *
 * Conventions:
 * - players are keyed by base58 wallet pubkey — the wallet IS the identity (GDD §4.9).
 * - all token amounts are bigint (KEEP base units / lamports).
 * - ledger is append-only double-entry; compensating entries only, never UPDATE
 *   (research-security-economy.md §1). accounts.balance is a cache maintained
 *   inside the same db transaction as the entries that move it.
 * - enum string values mirror @shardkeep/shared types.ts (TROOP_TYPES,
 *   BuildingType, League). Inlined because drizzle-kit bundles this file
 *   standalone; a drift test belongs in the next phase when game code lands.
 */
import { sql } from 'drizzle-orm';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

// D-128: catalog and claims are independent of immutable legacy Earth plots.
// Coordinates derive from the versioned shared catalog, never another mutable
// copy. Native purchase address discriminators are a separate migration.
export const fantasyWorldCatalog = pgTable('fantasy_world_catalog', {
  worldId: text('world_id').primaryKey(),
  catalogHash: text('catalog_hash').notNull(),
  tileCount: integer('tile_count').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('fantasy_catalog_hash_ck', sql`${t.catalogHash} ~ '^[a-f0-9]{64}$'`),
  check('fantasy_catalog_count_ck', sql`${t.tileCount} > 0`),
]);

export const fantasyWorldTiles = pgTable('fantasy_world_tiles', {
  worldId: text('world_id').notNull().references(() => fantasyWorldCatalog.worldId),
  tileId: integer('tile_id').notNull(),
  realmId: text('realm_id').notNull(),
  allocation: text('allocation').$type<'ordinary' | 'genesis' | 'seeker'>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.worldId, t.tileId] }),
  check('fantasy_tile_id_ck', sql`${t.tileId} >= 0`),
  check('fantasy_tile_allocation_ck', sql`${t.allocation} IN ('ordinary','genesis','seeker')`),
]);

export const fantasyRetirementExclusions = pgTable('fantasy_retirement_exclusions', {
  baseId: uuid('base_id').primaryKey().references((): AnyPgColumn => bases.id),
  mintId: text('mint_id'),
  receiptId: uuid('receipt_id').notNull().references((): AnyPgColumn => ledgerTransactions.id),
  abandonReceiptId: uuid('abandon_receipt_id').notNull().references((): AnyPgColumn => baseAbandons.id),
  evidenceHash: text('evidence_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('fantasy_retirement_hash_ck', sql`${t.evidenceHash} ~ '^[a-f0-9]{64}$'`)]);

export const fantasyMigrationBatches = pgTable('fantasy_migration_batches', {
  manifestHash: text('manifest_hash').primaryKey(),
  worldId: text('world_id').notNull().references(() => fantasyWorldCatalog.worldId),
  manifest: jsonb('manifest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('fantasy_manifest_hash_ck', sql`${t.manifestHash} ~ '^[a-f0-9]{64}$'`)]);

export const fantasyLandClaims = pgTable('fantasy_land_claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  worldId: text('world_id').notNull(),
  tileId: integer('tile_id').notNull(),
  baseId: uuid('base_id').notNull().references((): AnyPgColumn => bases.id),
  state: text('state').$type<'held' | 'assigned' | 'released'>().notNull(),
  source: text('source').$type<'migration-active' | 'migration-inactive' | 'purchase'>().notNull(),
  expectedMint: text('expected_mint'),
  depositId: uuid('deposit_id').references((): AnyPgColumn => deposits.id),
  manifestHash: text('manifest_hash').references(() => fantasyMigrationBatches.manifestHash),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.worldId, t.tileId], foreignColumns: [fantasyWorldTiles.worldId, fantasyWorldTiles.tileId] }),
  uniqueIndex('fantasy_claim_live_tile_uq').on(t.worldId, t.tileId).where(sql`${t.state} IN ('held','assigned')`),
  uniqueIndex('fantasy_claim_live_base_uq').on(t.baseId).where(sql`${t.state} IN ('held','assigned')`),
  uniqueIndex('fantasy_claim_live_deposit_uq').on(t.depositId).where(sql`${t.state} IN ('held','assigned')`),
  check('fantasy_claim_state_ck', sql`${t.state} IN ('held','assigned','released')`),
  check('fantasy_claim_source_kind_ck', sql`${t.source} IN ('migration-active','migration-inactive','purchase')`),
  check('fantasy_claim_source_ck', sql`(${t.source}='purchase' AND ${t.depositId} IS NOT NULL AND ${t.manifestHash} IS NULL)
    OR (${t.source} IN ('migration-active','migration-inactive') AND ${t.expectedMint} IS NOT NULL AND ${t.depositId} IS NULL AND ${t.manifestHash} IS NOT NULL)`),
  check('fantasy_claim_time_ck', sql`(${t.state}='held' AND ${t.assignedAt} IS NULL AND ${t.releasedAt} IS NULL)
    OR (${t.state}='assigned' AND ${t.assignedAt} IS NOT NULL AND ${t.releasedAt} IS NULL)
    OR (${t.state}='released' AND ${t.releasedAt} IS NOT NULL)`),
]);

/** Drizzle has no built-in Postgres bytea builder. Replay timelines are binary
 * protocol artifacts, not JSON; preserving bytes avoids base64 inflation and
 * makes the stored digest meaningful. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// One-way purchase cutover. Disabling the runtime flag pauses new quotes;
// retained reservations remain recoverable using their original address.
export const fantasyPurchaseCutover = pgTable('fantasy_purchase_cutover', {
  worldId: text('world_id').primaryKey().references(() => fantasyWorldCatalog.worldId),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const leagueEnum = pgEnum('league', ['bronze', 'silver', 'gold', 'sol']);

/** Mirrors @shardkeep/shared BuildingType. */
export const buildingTypeEnum = pgEnum('building_type', [
  'keep', 'mine', 'vault', 'barracks', 'forge', 'camp',
  'cannon', 'archertower', 'mortar', 'spiketrap', 'wall',
  // Pixel Kingdom Wars epic defenses (owner 2026-07-20; migration 0017). Present in
  // the enum so the type checks + a future enable can insert them; ships DARK.
  'electrictower', 'magetower', 'lasertower', 'dragonnest',
  // Gold Forge — shards→KEEP fusion building (owner 2026-07-24), migration 0028.
  'goldforge',
  // Hero altars (HEROES MVP, overnight 2026-07-26), migration 0039.
  'heroaltar', 'siegestool',
  // M22 owner-authored defences/traps + Clan Hall (owner 2026-08-15).
  'airdefence', 'powdermine', 'pitfall', 'airmine', 'clanhall',
  // Phase E service buildings + berth (D-152 §5 commit A, owner 2026-09-20).
  // Present so the type checks; ships DARK — placement is refused until
  // PHASE_E_BUILDINGS_ENABLED (commit B). ⚠ The Postgres enum needs the matching
  // `ALTER TYPE building_type ADD VALUE` migration (drizzle-kit generate) before
  // any row of these types can exist (E2-WORKSHOP-CONTRACT §1 createWorkshop).
  'workshop', 'lodge', 'market', 'harvester', 'berth',
]);

/** Mirrors @shardkeep/shared TROOP_TYPES. */
export const troopTypeEnum = pgEnum('troop_type', [
  'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
  // Pixel Kingdom Wars new roster (owner 2026-07-20; migration 0017). Ships DARK.
  'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
  // Dark attacker family (owner-delegated balance, SIM6). Barrowling is an enum
  // member for replay/JSON typing only; army mutations reject spawn-only units.
  'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling', 'wyrmling',
]);

/** Mirrors @shardkeep/shared HERO_KEYS (hero leveling, D-Q1; migration 0042). */
export const heroKeyEnum = pgEnum('hero_key', ['vex', 'theodor']);
/** Mirrors @shardkeep/shared GEAR_SLOTS. */
export const gearSlotEnum = pgEnum('gear_slot', [
  'helm', 'amulet', 'chest', 'cloak', 'gloves',
  'ring', 'boots', 'banner', 'weapon', 'offhand',
]);

export const builderJobKindEnum = pgEnum('builder_job_kind', ['build', 'upgrade', 'clear_obstacle', 'repair']);
export const layoutSlotEnum = pgEnum('layout_slot', ['A', 'B', 'C']);
export const shieldSourceEnum = pgEnum('shield_source', ['loss', 'purchase', 'warzone']);
/** #46 shieldless/warzone mode switch: normal / predictable weekend / unannounced purge. */
export const shieldlessModeEnum = pgEnum('shieldless_mode', ['off', 'scheduled', 'purge']);
/** 'onboarding' (2026-08-28) is the first-run chain: rows live on one sentinel
 *  `activeOn` day forever rather than rotating, so a new player's five first
 *  objectives reuse this table, quest_progress and the claim route unchanged. */
export const questScopeEnum = pgEnum('quest_scope', ['daily', 'weekly', 'onboarding']);
// 'resolving' is the atomic-claim state: submitOrders transitions
// pending_orders→resolving in one conditional UPDATE so two racing order
// submissions can't both resolve (trophy/quest double-apply). Only the claimer
// proceeds; it then writes 'resolved'.
export const raidStatusEnum = pgEnum('raid_status', ['pending_orders', 'resolving', 'resolved', 'expired']);
/** Which energy bucket a PvP raid consumed — so an ABANDONED (expired) raid can
 *  refund it (free is auto-refunded by not counting; purchased needs the +1). NULL for PvE. */
export const raidEnergySourceEnum = pgEnum('raid_energy_source', ['free', 'purchased']);
/** A defender base has at most one live raid lock. The short `reserved` phase
 * freezes loot/snapshot state; `live` begins once combat accepts its first
 * command. Releasing is explicit so a crashed worker never silently unlocks. */
export const baseRaidLockStateEnum = pgEnum('base_raid_lock_state', ['reserved', 'live', 'releasing']);
export const raidLootReservationStateEnum = pgEnum('raid_loot_reservation_state', [
  'reserved', 'settled', 'released',
]);
export const raidBattleRoleEnum = pgEnum('raid_battle_role', ['attacker', 'defender']);
/** Clans (Phase 3 pulled forward — docs/CLANS-SELLABLE-DEEDS-PLAN.md C1). */
export const clanInviteModeEnum = pgEnum('clan_invite_mode', ['open', 'invite']);

/**
 * Ledger account kinds (ARCHITECTURE §5). Player kinds carry an owner wallet;
 * system kinds (owner NULL, one row each) represent the outside world / pools.
 * Mint/world accounts may go negative; finite allocations and collected pools
 * are guarded non-negative by the ledger engine.
 */
export const accountKindEnum = pgEnum('account_kind', [
  'player_keep', 'player_sol_credit',
  'emission_pool', 'burn', 'league_pool', 'league_entitlement_escrow', 'treasury', 'quest_bucket', 'sol_treasury',
  /** Requested-withdrawal funds frozen during unbonding (GDD §4.9). */
  'withdrawal_escrow',
  /** World account: KEEP that left custody to the chain (payouts). */
  'onchain_outflow',
  /** World account: KEEP that ENTERED custody from the chain (player deposits).
   * Mirror of onchain_outflow — a deposit posts player_keep +amt / this −amt, so
   * the player's balance grows by real deposited KEEP backed by the hot wallet. */
  'onchain_inflow',
  /** Fixed-supply mint that seeds the play pool (ECONOMY.md §4b, v3). The genesis
   * transaction moves TOKEN.allocation.playPool from keep_genesis (→ −500M) into
   * emission_pool (→ +500M); emission_pool is then non-negative so its balance
   * IS the remaining play allocation (the lifetime cap is a ledger invariant). */
  'keep_genesis',
  /** SOL-side league prize pool: LEAGUES.solSliceBps of every ledger SOL sink
   * lands here; the Monday reset pays it out as SOL credit (owner 2026-07-18). */
  'league_sol_pool',
  /** Player's soft-currency balance (Gold Forge dual-currency split — DARK
   * until the mining re-split; ITEMS plan §3, owner rules 2026-07-24). */
  'player_shards',
  /** Shards contributed to the CURRENT forge day, held until settlement burns
   * the counted portion and refunds the 30%-cap excess. */
  'forge_escrow',
  /** SETTLED-but-UNCLAIMED Gold Forge KEEP (2026-07-29). Settlement moves the
   * day's payout emission_pool → here; the player's CLAIM moves it here →
   * player_keep, and an unclaimed allocation past FORGE.claimWindowDays sweeps
   * back to emission_pool. It is a real custodial obligation, so it lives in a
   * NAMED account (NON_NEGATIVE_KINDS) rather than inside emission_pool — the
   * ledger's FOR UPDATE + non-negative check then turns any claim-gate bug from
   * a silent double-credit into a loud InsufficientFundsError. */
  'forge_payout_escrow',
  /** Pooled clan-chest shards (CLANS-SELLABLE-DEEDS-PLAN C3): ONE system row;
   * per-clan attribution lives in clans.chest_shards, kept in the SAME tx as
   * every posting here — the league_pool pattern (accounts_owner_kind_unique is
   * NULLS NOT DISTINCT, so per-clan NULL-owner rows are impossible by design). */
  'clan_chest',
  /** Shard mint source (mirror of keep_genesis): mining posts shard_genesis −
   * / player_shards + once the split lands, so −balance = shards ever minted. */
  'shard_genesis',
  /** Shard sink: forge-settlement burns counted shards here (SHARDS currency —
   * the KEEP 'burn' account can't take them, the ledger is per-currency). */
  'shard_burn',
  /** Spendable SHARDS belong to the deed/base, not its current wallet owner. */
  'base_shards',
  /** Open Gold Forge contributions remain part of the deed's raidable wealth. */
  'base_forge_escrow',
  /** Pooled, non-negative freeze account for exact private raid reservations.
   * Per-raid attribution lives in raid_loot_reservations. */
  'raid_loot_escrow',
  /** Pooled, non-negative reward-mail escrows. Per-recipient attribution lives
   * in mail_messages/mail_attachments until claim or expiry. */
  'mail_keep_escrow',
  'mail_shards_escrow',
  /** D-150 original-term SHARDS tax backing; nonnegative, no payout here. */
  'shards_tax_escrow',
  /** Gems (D-152, GEMS-CURRENCY §3): non-withdrawable in-game KEEP, a fourth
   * ledger currency. The player's balance; wallet-scoped like player_keep. */
  'player_gems',
  /** Reserved store lane (E2-GEMS-CONTRACT §1.1): zero postings until a store
   * exists; never converts to SHARDS, never buys listable items, never scores. */
  'player_gems_store',
  /** The only Gems source (shard_genesis shape, may go negative): −balance =
   * outstanding + sunk Gems. G-3: every debit here is backed by a same-amount
   * KEEP debit from player_keep, onchain_inflow or gems_reward_budget. */
  'gems_mint',
  /** Where spent Gems go (shard_burn shape); refunds mirror out of it bounded
   * by the original debit, so it is non-negative. */
  'gems_sink',
  /** KEEP that backs grants (tasks, welcome, refunds): funded only by a
   * journaled operator posting from the recycled leg, capped per UTC day. */
  'gems_reward_budget',
  /** D153.154 original Charter liability; no terminal payout in this block. */
  'charter_creation_escrow', 'mining_contribution_escrow',
]);

/** 'GEMS' (D-152): the ledger balances per currency, so a KEEP pair and a GEMS
 * pair share one transaction — that is the G-3 backing shape. */
export const currencyEnum = pgEnum('currency', ['KEEP', 'SOL', 'SHARDS', 'GEMS']);
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'failed']);
// 'energy' / 'shield' are the pay-per-action SOL sinks (v3): a repeatable
// on-chain SOL payment (shardkeep-core buy_sink) verified at finalized, then the
// in-game grant. They replace the retired prepaid player_sol_credit balance.
// 'gems_buy' (E2-GEMS-CONTRACT §2): a wallet-KEEP transfer to the emission
// reserve ATA that mints Gems 1:1 on finality; credited like a KEEP deposit.
export const depositKindEnum = pgEnum('deposit_kind', ['entry', 'deed', 'builder', 'expansion', 'sol_topup', 'keep_deposit', 'energy', 'energy_pack', 'shield', 'mine', 'mine_build', 'warzone_shield', 'keep_vend', 'gems_buy']);
// 'failed' = the on-chain SOL WAS paid (provable by reference/signature) but the
// in-game grant could never apply within the TTL (e.g. the target Mine was
// destroyed or its level advanced past the paid price). Terminal + surfaced so
// the SOL is never silently lost — ops resolves it (refund or manual grant).
export const depositStatusEnum = pgEnum('deposit_status', ['pending', 'finalized', 'credited', 'expired', 'failed']);
// 'refunded' is the terminal state of a FAILED payout whose gross was returned
// from withdrawal_escrow to the player's play balance (money/withdrawals.ts
// refundFailedWithdrawal). Before it existed, a failed row stranded the player's
// KEEP in escrow with no code path back — recoverable only by DB surgery.
export const withdrawalStatusEnum = pgEnum('withdrawal_status', ['unbonding', 'cancelled', 'processing', 'sent', 'failed', 'refunded']);
/** Durable on-chain payout attempt. `broadcast` is deliberately non-terminal:
 * an RPC acknowledgement (or timeout) says nothing about finality. */
export const withdrawalAttemptStatusEnum = pgEnum('withdrawal_attempt_status', [
  'prepared', 'broadcast', 'finalized_success', 'finalized_error',
]);
/** 2FA email-code purpose. Recovery has its own cryptographic namespace so a
 * code issued for export/factor management can never clear an authenticator. */
export const twoFaPurposeEnum = pgEnum('two_fa_purpose', ['enroll', 'withdraw', 'totp_recovery']);
export const totpRecoveryStatusEnum = pgEnum('totp_recovery_status', [
  'email_pending', 'holding', 'cancelled', 'completed', 'expired',
]);
/** What a signed challenge authorizes. See authNonces.purpose — a link
 *  signature must NEVER be usable as a sign-in signature. */
export const authNoncePurposeEnum = pgEnum('auth_nonce_purpose', ['signin', 'seeker_link']);
export const baseStatusEnum = pgEnum('base_status', ['active', 'inactive']);
export const deedObservationStatusEnum = pgEnum('deed_observation_status', [
  'owned', 'mismatch', 'ineligible', 'unavailable',
]);
export const plotReservationStateEnum = pgEnum('plot_reservation_state', [
  'reserved', 'paid', 'converted', 'expired', 'failed',
]);

// ---------------------------------------------------------------------------
// Players & base state
// ---------------------------------------------------------------------------

export const players = pgTable('players', {
  /** base58 ed25519 pubkey — primary identity (GDD §4.9). */
  wallet: text('wallet').primaryKey(),
  /** Optional PKW login factor; ordinary social login remains signature-free. */
  loginTotpRequired: boolean('login_totp_required').notNull().default(false),
  name: text('name').notNull().default(''),
  /** Wallet-level public profile picture. The bytes are normalized before the
   * hash is written. Every changed upload also receives an immutable generation,
   * so a retired object key can never become current again (the deletion outbox
   * may therefore retry safely). */
  avatarHash: text('avatar_hash'),
  avatarGeneration: uuid('avatar_generation'),
  /** Last pointer change, including clearing an avatar. A cleared row retains
   * this timestamp so clients can invalidate an older cached identity. */
  avatarUpdatedAt: timestamp('avatar_updated_at', { withTimezone: true }),
  /** Case-folded uniqueness key for `name` (lower(name)); '' = unnamed.
   *  UNIQUE where <> '' — `clans.name` has been unique since day one but
   *  `players.name` never was, so two players could share a display name and
   *  one could rename INTO another's (free impersonation on a money surface).
   *  Written ONLY by game/username.ts, always in the same statement as `name`. */
  nameKey: text('name_key').notNull().default(''),
  /** Last successful rename — drives USERNAMES.changeCooldownDays. */
  nameChangedAt: timestamp('name_changed_at', { withTimezone: true }),
  /** Denormalized Seeker badge (truth = seeker_links; maintained in the SAME
   *  transaction, the accounts.balance convention). Exists so the hot map
   *  roster / clan roster reads need no extra join. */
  seekerVerified: boolean('seeker_verified').notNull().default(false),
  /** Last sign-in SGT auto-probe that COMPLETED with a definitive answer for a
   *  wallet with no live seeker_links row (owner 2026-08-08). The negative
   *  cache: a "no SGT" younger than SEEKER.autoDetectRecheckHours is not
   *  re-asked, which is what keeps auto-detection off the mainnet quota for
   *  the 99% of sign-ins that are not Seekers. Never written on an outage —
   *  no answer is not an answer. */
  sgtCheckedAt: timestamp('sgt_checked_at', { withTimezone: true }),
  keepLevel: integer('keep_level').notNull().default(1),
  trophies: integer('trophies').notNull().default(0),
  league: leagueEnum('league').notNull().default('bronze'),
  /** Trophies at the Monday league reset — the weekly league snapshot (ARCHITECTURE §5). */
  weekStartTrophies: integer('week_start_trophies').notNull().default(0),
  /** Builders owned 1–6 (Addendum B7). */
  builders: integer('builders').notNull().default(1),
  /** Land expansions purchased 0–2 (GDD §4.6). */
  expansions: integer('expansions').notNull().default(0),
  /** Bought raid-energy balance (ECONOMY.md §4, v3): SOL-purchased energy that
   * covers PvP raids beyond the 3 free/day, up to the 6/day ceiling. Consumed
   * atomically with the raid INSERT (never "paid but no raid"). */
  purchasedEnergy: integer('purchased_energy').notNull().default(0),
  /** Durable cross-process admission spacing for CPU-heavy raid simulation. */
  raidSimulationAdmittedAt: timestamp('raid_simulation_admitted_at', { withTimezone: true }),
  referralCode: text('referral_code').unique(),
  referredBy: text('referred_by').references((): AnyPgColumn => players.wallet),
  /** Map-eligibility 5-min logoff grace (ARCHITECTURE §5). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  /** Client that created this player row at first sign-in (D-103):
   *  'solana-mobile' when the sign-in carried the installed Solana Mobile
   *  shell marker, else 'browser'. Null for rows older than migration 0103.
   *  Cohorts the public playtest statistics; never used for access. */
  firstClient: text('first_client'),
  /**
   * Set when the on-chain 0.2 SOL payment is credited (deposit watcher). Means
   * exactly one thing and has never meant anything else: "this wallet paid 0.2
   * SOL on-chain". Since free onboarding (2026-08-09) that payment BUYS THE LAND
   * rather than admission, so this is also THE LAND-OWNERSHIP COLUMN — the one
   * `requireLandOwned` reads (auth/session.ts) and the one `hasLand` wraps
   * (game/land.ts). Deliberately NOT a second `landPurchasedAt` column: keeping
   * the meaning is what leaves deedMetadata's Founded trait, the watcher stamp
   * and baseTransfer untouched.
   */
  entryPaidAt: timestamp('entry_paid_at', { withTimezone: true }),
  /** Land Deed Core NFT asset address (Phase 6) — the title to the player's
   * parcel, minted after the 0.2 SOL purchase is credited; null when deed
   * minting isn't configured or hasn't landed yet. TRADEABLE, not soulbound:
   * mintLandDeed freezes only when MARKETPLACE.tradingEnabled is false, and it
   * is true, which is what makes baseClaim/baseTransfer meaningful.
   * The deed conveys structures/land ONLY (never currency), and attackability is
   * a pure function of server state — this column is record-keeping, gameplay
   * never reads on-chain deed state (ITEMS-LOOTBOX-MARKETPLACE-PLAN §8/§9). */
  /** UNIQUE while set (partial index, review #9): two rows sharing a deed would
   * make the transfer sweep ping-pong the base between them every pass. */
  deedAssetId: text('deed_asset_id'),
  /** Rolling-deploy compatibility shadow for the sole-base mint reservation.
   * New authority lives on bases.deedMintAssetId. A `legacy-unknown:*` value is
   * a durable 0072 cutover quarantine for historical paid/deedless state whose
   * old random-signer outcome cannot be inferred from a cleared timestamp. */
  deedMintAssetId: text('deed_mint_asset_id'),
  /**
   * Deed-mint CLAIM (2026-07-29). Set by whichever caller wins the right to mint;
   * cleared when the mint lands or fails.
   *
   * The guard used to be an in-process `Set`, and it did not close the window
   * even in ONE process: the membership check ran, then an `await` yielded the
   * event loop, and only then was the wallet added. Two overlapping calls both
   * passed. They overlap at the single highest-concurrency moment in the game —
   * the entry credit fires a mint (money/depositWatcher.ts) while the client's
   * GET /base poll fires another (game/routes.ts). The `deed_asset_id IS NULL`
   * write guard stopped the second id being RECORDED but not the second NFT
   * being MINTED, leaving a real, unfrozen, collection-verified, royalty-bearing
   * Land Deed that conveys nothing — base claim only ever matches the recorded
   * id, so a marketplace buyer of the orphan gets an empty asset.
   *
   * A timestamp rather than a boolean so a crashed fixed-address mint
   * self-heals: a claim older than the staleness window is reclaimable. Since
   * 0072 the trigger rejects timestamp acquisition without an exact reservation
   * and the new-code transaction marker, fencing old random-signer pods.
   */
  deedMintingAt: timestamp('deed_minting_at', { withTimezone: true }),
  /** DEAD (M23 a8 skin removal): the retired equipped-keep-skin slot. The
   * refund sweep (game/skinRefunds.ts) NULLs it; kept, no schema migration. */
  keepSkin: text('keep_skin'),
  /** Account security factors (owner 2026-08-11). Only a mature authenticator
   * may authorize an INSTANT custody withdrawal; verified email remains a contact
   * and factor-management/key-export proof because its Privy login provenance is
   * unavailable to this server. totpSecret is a versioned AES-256-GCM envelope (legacy base32 is
   * read only long enough to rotate it in place); it exists once enroll starts,
   * and totpEnabled latches true only after the first correct code. */
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  /** First successful verification of the current TOTP enrollment. Instant
   * custody withdrawals mature only after the normal unbonding window. Null when
   * disabled or an enrollment has not yet been verified. */
  totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
  /** Latched by a completed lost-authenticator recovery and cleared only when
   * the replacement TOTP is successfully verified. This durable flag survives
   * the all-session revocation at completion and keeps export/withdrawals
   * fail-closed until the account has a new PKW factor. */
  totpReenrollmentRequired: boolean('totp_reenrollment_required').notNull().default(false),
  /** Highest TOTP time-step already accepted for a withdrawal — enforces RFC 6238
   * §5.2 single-use: a code whose step ≤ this is a replay and is rejected. */
  totpLastUsedStep: bigint('totp_last_used_step', { mode: 'bigint' }),
  email: text('email'),
  emailVerified: boolean('email_verified').notNull().default(false),
  /** Candidate replacement address. The verified `email` remains active until
   * a code bound to this exact value is consumed and promotes it atomically. */
  pendingEmail: text('pending_email'),
  /** Consecutive failed withdrawal-2FA attempts (any method); resets on success. */
  twofaFailedAttempts: integer('twofa_failed_attempts').notNull().default(0),
  /** Account is locked out of withdrawal-2FA until this time (brute-force guard). */
  twofaLockedUntil: timestamp('twofa_locked_until', { withTimezone: true }),
  /** Fixed UTC-day successful training-refund budget. NULL/0 is the untouched
   * state; the day rolls only when a new cancellation actually commits. */
  trainingCancelDay: date('training_cancel_day'),
  trainingCancelCount: integer('training_cancel_count').notNull().default(0),
  /** Same fixed UTC-day budgets for cancelled building upgrades and troop
   * research (UPGRADE_CANCELLATION / RESEARCH_CANCELLATION). */
  upgradeCancelDay: date('upgrade_cancel_day'),
  upgradeCancelCount: integer('upgrade_cancel_count').notNull().default(0),
  researchCancelDay: date('research_cancel_day'),
  researchCancelCount: integer('research_cancel_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Review 2026-07-27 #9: a deed may point at ONE player only, or the transfer
  // sweep would ping-pong the base between duplicate holders every pass.
  uniqueIndex('players_deed_asset_uq').on(t.deedAssetId).where(sql`deed_asset_id IS NOT NULL`),
  // Usernames are unique case-insensitively. Partial so the many un-named
  // accounts (name_key = '') don't collide with each other. The DB is the
  // authority — the setter INSERTs and catches 23505 rather than
  // check-then-write, which races.
  uniqueIndex('players_name_key_uq').on(t.nameKey).where(sql`name_key <> ''`),
  // Opaque avatar routes resolve this immutable generation without exposing a
  // wallet. Uniqueness makes that lookup both indexed and unambiguous; NULL is
  // intentionally allowed for every player who has no current avatar.
  uniqueIndex('players_avatar_generation_uq')
    .on(t.avatarGeneration)
    .where(sql`avatar_generation IS NOT NULL`),
  check('players_avatar_hash_ck', sql`avatar_hash IS NULL OR avatar_hash ~ '^[0-9a-f]{64}$'`),
  check('players_avatar_pointer_ck', sql`(avatar_hash IS NULL) = (avatar_generation IS NULL)`),
  check('players_totp_enabled_at_ck', sql`(totp_enabled AND totp_enabled_at IS NOT NULL) OR (NOT totp_enabled AND totp_enabled_at IS NULL)`),
  check('players_training_cancel_count_ck', sql`${t.trainingCancelCount} >= 0`),
  check('players_training_cancel_day_ck', sql`(${t.trainingCancelDay} IS NULL) = (${t.trainingCancelCount} = 0)`),
  check('players_upgrade_cancel_count_ck', sql`${t.upgradeCancelCount} >= 0`),
  check('players_upgrade_cancel_day_ck', sql`(${t.upgradeCancelDay} IS NULL) = (${t.upgradeCancelCount} = 0)`),
  check('players_research_cancel_count_ck', sql`${t.researchCancelCount} >= 0`),
  check('players_research_cancel_day_ck', sql`(${t.researchCancelDay} IS NULL) = (${t.researchCancelCount} = 0)`),
]);

/**
 * Seeker Genesis Token links (owner 2026-07-29). One row per game account.
 *
 * Every field here was established by a SERVER-side mainnet read after the
 * Seeker wallet signed a purpose-scoped challenge — never by a client claim.
 */
export const seekerLinks = pgTable('seeker_links', {
  /** The GAME account. Differs from seekerWallet for Privy/social players,
   *  whose embedded wallet can never hold an SGT. */
  wallet: text('wallet').primaryKey().references(() => players.wallet),
  /** The wallet that actually holds the SGT and signed the link challenge. */
  seekerWallet: text('seeker_wallet').notNull(),
  /** THE ANTI-SYBIL GUARANTEE: one SGT (= one physical Seeker) backs at most one
   *  game account, forever. Deliberately NOT partial on revoked_at — otherwise
   *  unlink→relink would let one device seed unlimited farm accounts. */
  sgtMint: text('sgt_mint').notNull(),
  /** tokenGroupMember.memberNumber — display only ("SEEKER #76095"). */
  memberNumber: integer('member_number'),
  /** Verified `.skr` domain at link time (naming only, never the badge). */
  skrDomain: text('skr_domain'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull().defaultNow(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when a recheck finds the SGT gone: badge drops, the mint claim stays. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('seeker_links_sgt_mint_uq').on(t.sgtMint),
  uniqueIndex('seeker_links_seeker_wallet_uq').on(t.seekerWallet),
]);

/** Stable identity for state that travels with a deed. Legacy wallet columns
 * remain during the compare/dual-write transition; this row is the new owner
 * boundary and deliberately contains no wallet-owned currency/army/item data. */
export const bases = pgTable('bases', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerWallet: text('owner_wallet').notNull().references(() => players.wallet),
  deedAssetId: text('deed_asset_id'),
  /** Exact Core account reserved for this base's mint before any transaction is
   * broadcast. Retained across ambiguous failures; retries may only use this
   * address. The private signer is deterministically re-derived from the admin
   * key + base UUID and is never stored. A `legacy-unknown:<uuid>` marker means
   * pre-0072 paid/deedless history may have an unrecoverable random signer and
   * must fail closed pending manual chain reconciliation. */
  deedMintAssetId: text('deed_mint_asset_id'),
  status: baseStatusEnum('status').notNull().default('active'),
  keepLevel: integer('keep_level').notNull().default(1),
  builders: integer('builders').notNull().default(1),
  expansions: integer('expansions').notNull().default(0),
  landPaidAt: timestamp('land_paid_at', { withTimezone: true }),
  deedMintingAt: timestamp('deed_minting_at', { withTimezone: true }),
  /** Travels with the deed so selling a cancellation-heavy base cannot reset
   * its fixed UTC-day refund budget. */
  trainingCancelDay: date('training_cancel_day'),
  trainingCancelCount: integer('training_cancel_count').notNull().default(0),
  upgradeCancelDay: date('upgrade_cancel_day'),
  upgradeCancelCount: integer('upgrade_cancel_count').notNull().default(0),
  researchCancelDay: date('research_cancel_day'),
  researchCancelCount: integer('research_cancel_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('bases_deed_asset_uq').on(t.deedAssetId).where(sql`deed_asset_id IS NOT NULL`),
  uniqueIndex('bases_deed_mint_asset_uq').on(t.deedMintAssetId).where(sql`deed_mint_asset_id IS NOT NULL`),
  index('bases_owner_status_idx').on(t.ownerWallet, t.status),
  check('bases_keep_level_ck', sql`${t.keepLevel} BETWEEN 1 AND 20`),
  check('bases_builders_ck', sql`${t.builders} BETWEEN 1 AND 6`),
  // Mirrors CAPS.expansionsMax (owner 2026-09-16); forward migration 0132.
  check('bases_expansions_ck', sql`${t.expansions} BETWEEN 0 AND 12`),
  check('bases_training_cancel_count_ck', sql`${t.trainingCancelCount} >= 0`),
  check('bases_training_cancel_day_ck', sql`(${t.trainingCancelDay} IS NULL) = (${t.trainingCancelCount} = 0)`),
  check('bases_upgrade_cancel_count_ck', sql`${t.upgradeCancelCount} >= 0`),
  check('bases_upgrade_cancel_day_ck', sql`(${t.upgradeCancelDay} IS NULL) = (${t.upgradeCancelCount} = 0)`),
  check('bases_research_cancel_count_ck', sql`${t.researchCancelCount} >= 0`),
  check('bases_research_cancel_day_ck', sql`(${t.researchCancelDay} IS NULL) = (${t.researchCancelCount} = 0)`),
]);

/** At most five active slots per wallet. A sixth deed remains an inactive base;
 * replacing a slot changes only this mapping and never deletes either base. */
export const baseSlots = pgTable('base_slots', {
  wallet: text('wallet').notNull().references(() => players.wallet),
  slot: smallint('slot').notNull(),
  baseId: uuid('base_id').notNull().references(() => bases.id),
  active: boolean('active').notNull().default(true),
  selectedAt: timestamp('selected_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.wallet, t.slot] }),
  uniqueIndex('base_slots_base_uq').on(t.baseId),
  check('base_slots_slot_ck', sql`${t.slot} BETWEEN 1 AND 5`),
]);

// Global-chat content and moderation evidence. Wallets never leave the API;
// public DTOs join the current profile name/avatar instead.
export const globalChatMessages = pgTable('global_chat_messages', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  authorWallet: text('author_wallet').notNull().references(() => players.wallet),
  clientMessageId: uuid('client_message_id').notNull(),
  text: text('text').notNull(),
  textHash: text('text_hash').notNull(),
  /** Private send-time recipients; public DTOs expose only spans and a viewer flag. */
  mentions: jsonb('mentions').$type<Array<{ start: number; end: number; wallet: string }>>()
    .notNull().default([]),
  /** Immutable public identity evidence at send time. Renames/badge changes
   * must not rewrite history or idempotent replay responses. */
  authorNameAtSend: text('author_name_at_send').notNull(),
  authorSeekerVerifiedAtSend: boolean('author_seeker_verified_at_send').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  redactedAt: timestamp('redacted_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('global_chat_messages_author_client_uq').on(t.authorWallet, t.clientMessageId),
  index('global_chat_messages_visible_idx').on(t.createdAt.desc(), t.id.desc()),
]);

export const globalChatEvents = pgTable('global_chat_events', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  kind: text('kind').notNull(),
  messageId: bigint('message_id', { mode: 'bigint' }).notNull().references(() => globalChatMessages.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('global_chat_events_cursor_idx').on(t.id),
  check('global_chat_events_kind_ck', sql`${t.kind} IN ('message', 'redaction')`),
]);

export const globalChatReports = pgTable('global_chat_reports', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  messageId: bigint('message_id', { mode: 'bigint' }).notNull().references(() => globalChatMessages.id, { onDelete: 'cascade' }),
  reporterWallet: text('reporter_wallet').notNull().references(() => players.wallet),
  reason: text('reason').notNull(),
  evidenceText: text('evidence_text').notNull(),
  evidenceTextHash: text('evidence_text_hash').notNull(),
  evidenceAuthorWallet: text('evidence_author_wallet').notNull().references(() => players.wallet),
  evidenceAuthorName: text('evidence_author_name').notNull(),
  evidenceSeekerVerified: boolean('evidence_seeker_verified').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => players.wallet),
  resolution: text('resolution'),
}, (t) => [
  uniqueIndex('global_chat_reports_message_reporter_uq').on(t.messageId, t.reporterWallet),
  index('global_chat_reports_retention_idx').on(t.createdAt, t.id),
  check('global_chat_reports_resolution_ck', sql`
    (${t.resolvedAt} IS NULL AND ${t.resolvedBy} IS NULL AND ${t.resolution} IS NULL)
    OR
    (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL
      AND ${t.resolution} IN ('dismissed', 'redacted'))
  `),
]);

export const globalChatMutes = pgTable('global_chat_mutes', {
  wallet: text('wallet').primaryKey().references(() => players.wallet),
  /** NULL means permanent; permanence is never encoded as a sentinel date. */
  mutedUntil: timestamp('muted_until', { withTimezone: true }),
  reason: text('reason').notNull(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const globalChatModerationAudit = pgTable('global_chat_moderation_audit', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  action: text('action').notNull(),
  targetWallet: text('target_wallet').references(() => players.wallet),
  messageId: bigint('message_id', { mode: 'bigint' }).references(() => globalChatMessages.id, { onDelete: 'set null' }),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('global_chat_moderation_audit_action_ck', sql`
  ${t.action} IN ('redact', 'mute', 'unmute', 'resolve_report', 'toggle_chat')
`)]);

/** Personal chat filtering. Public APIs expose only this row id and the current
 * blocked player's profile; wallet identities remain internal join keys. */
export const globalChatBlocks = pgTable('global_chat_blocks', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  blockerWallet: text('blocker_wallet').notNull().references(() => players.wallet),
  blockedWallet: text('blocked_wallet').notNull().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('global_chat_blocks_pair_uq').on(t.blockerWallet, t.blockedWallet),
  index('global_chat_blocks_owner_cursor_idx').on(t.blockerWallet, t.id.desc()),
  check('global_chat_blocks_not_self_ck', sql`${t.blockerWallet} <> ${t.blockedWallet}`),
]);

/** Fail-closed distributed abuse buckets. Subjects are SHA-256(IP/wallet),
 * never raw IPs, and each fixed window is transactionally serialized. */
export const globalChatRateLimits = pgTable('global_chat_rate_limits', {
  kind: text('kind').notNull(),
  subjectHash: text('subject_hash').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull(),
}, (t) => [
  primaryKey({ columns: [t.kind, t.subjectHash, t.windowStart] }),
  index('global_chat_rate_limits_retention_idx').on(t.windowStart, t.kind, t.subjectHash),
  check('global_chat_rate_limits_count_ck', sql`${t.count} > 0`),
]);

/** Durable finalized-chain evidence. Webhooks may trigger a refresh but never
 * create an authoritative observation themselves. */
export const deedOwnershipObservations = pgTable('deed_ownership_observations', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  baseId: uuid('base_id').notNull().references(() => bases.id),
  assetId: text('asset_id').notNull(),
  owner: text('owner'),
  slot: bigint('slot', { mode: 'bigint' }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull(),
  status: deedObservationStatusEnum('status').notNull(),
  auditHash: text('audit_hash').notNull(),
}, (t) => [index('deed_observations_base_checked_idx').on(t.baseId, t.checkedAt.desc())]);

export const buildings = pgTable('buildings', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  type: buildingTypeEnum('type').notNull(),
  /** For walls this is the TIER (1–3); otherwise the level. */
  level: integer('level').notNull().default(1),
  tx: integer('tx').notNull(),
  ty: integer('ty').notNull(),
  /** Triggered traps stay visibly spent and inert until the authoritative
   * repair action clears this timestamp. NULL means armed/non-trap. */
  trapSpentAt: timestamp('trap_spent_at', { withTimezone: true }),
}, (t) => [index('buildings_player_idx').on(t.playerWallet), index('buildings_base_idx').on(t.baseId)]);

export const obstacles = pgTable('obstacles', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  /** Asset key, e.g. obs_rock_1 — purely cosmetic except occupancy. */
  spriteKey: text('sprite_key').notNull(),
  tx: integer('tx').notNull(),
  ty: integer('ty').notNull(),
  /** Tombstone: cleared obstacles never respawn (HANDOFF §3.9); row kept for
   * the builder_jobs FK + audit. NULL = still standing. */
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
}, (t) => [index('obstacles_player_idx').on(t.playerWallet), index('obstacles_base_idx').on(t.baseId)]);

export const builderJobs = pgTable('builder_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  kind: builderJobKindEnum('kind').notNull(),
  buildingId: uuid('building_id').references(() => buildings.id),
  obstacleId: uuid('obstacle_id').references(() => obstacles.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishesAt: timestamp('finishes_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** Refund receipt of a cancellable SHARD-paid upgrade: the exact debit the
   * job recorded when it started, so cancellation never guesses from mutable
   * cost tables. NULL on placement/clear/repair jobs, on SOL-priced upgrade
   * steps and on every job started before this receipt existed — none of
   * those can be cancelled. A cancelled job carries completed_at too, so every
   * "active job" predicate (builder slot, lazy completion) frees it. */
  paidShardCost: bigint('paid_shard_cost', { mode: 'bigint' }),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelIdempotencyKey: text('cancel_idempotency_key'),
}, (t) => [
  index('builder_jobs_player_idx').on(t.playerWallet),
  index('builder_jobs_base_idx').on(t.baseId),
  // M33 push sweep reads the global due-time window every 30 s. The historical
  // wallet/base indexes cannot bound that scan because finishes_at is not their
  // leading column.
  index('builder_jobs_notification_due_idx').on(t.finishesAt),
  uniqueIndex('builder_jobs_player_cancel_key_uq').on(t.playerWallet, t.cancelIdempotencyKey),
  check('builder_jobs_cancel_state_ck', sql`
    (${t.paidShardCost} IS NULL AND ${t.debitLedgerTxnId} IS NULL
      AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
    OR (${t.paidShardCost} > 0 AND ${t.debitLedgerTxnId} IS NOT NULL AND ${t.kind} = 'upgrade' AND (
      (${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
      OR (${t.cancelledAt} IS NOT NULL AND ${t.completedAt} IS NOT NULL AND ${t.refundLedgerTxnId} IS NOT NULL
        AND ${t.refundLedgerTxnId} <> ${t.debitLedgerTxnId} AND ${t.cancelIdempotencyKey} IS NOT NULL)
    ))
  `),
]);

export const army = pgTable('army', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  troop: troopTypeEnum('troop').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.troop] })]);

/** Barracks training queue: one row per unit in training; lazily completed
 * into `army` (camp-held roster) like builder jobs. */
export const trainingQueue = pgTable('training_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  troop: troopTypeEnum('troop').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishesAt: timestamp('finishes_at', { withTimezone: true }).notNull(),
  /** V1 promises remain fixed; V2 uses scheduled (possibly future) startedAt. */
  scheduleVersion: integer('schedule_version').notNull().default(1),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** V1 rows predate refundable training and were already quest-credited at
   * enqueue. V2 snapshots the exact debit so cancellation never guesses from
   * mutable troop constants. */
  economyVersion: integer('economy_version').notNull().default(1),
  paidShardCost: bigint('paid_shard_cost', { mode: 'bigint' }),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelIdempotencyKey: text('cancel_idempotency_key'),
  /** Default-now is a rolling-deploy fence: old writers still enqueue v1 and
   * already award quests immediately. Current v2 writers explicitly insert
   * NULL until the troop reaches camp. */
  questCreditedAt: timestamp('quest_credited_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  check('training_queue_schedule_ck', sql`${t.scheduleVersion} IN (1, 2) AND (${t.scheduleVersion} = 1 OR ${t.finishesAt} > ${t.startedAt})`),
  index('training_queue_player_idx').on(t.playerWallet, t.finishesAt),
  index('training_queue_notification_due_idx').on(t.finishesAt)
    .where(sql`${t.cancelledAt} IS NULL`),
  uniqueIndex('training_queue_player_cancel_key_uq').on(t.playerWallet, t.cancelIdempotencyKey),
  check('training_queue_economy_version_ck', sql`${t.economyVersion} IN (1, 2)`),
  check('training_queue_state_ck', sql`
    (${t.economyVersion} = 1 AND ${t.paidShardCost} IS NULL AND ${t.debitLedgerTxnId} IS NULL
      AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
      AND ${t.cancelIdempotencyKey} IS NULL AND ${t.questCreditedAt} IS NOT NULL)
    OR (${t.economyVersion} = 2 AND ${t.paidShardCost} > 0 AND ${t.debitLedgerTxnId} IS NOT NULL AND (
      (${t.completedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
        AND ${t.cancelIdempotencyKey} IS NULL AND ${t.questCreditedAt} IS NULL)
      OR (${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
        AND ${t.cancelIdempotencyKey} IS NULL)
      OR (${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NOT NULL AND ${t.refundLedgerTxnId} IS NOT NULL
        AND ${t.refundLedgerTxnId} <> ${t.debitLedgerTxnId}
        AND ${t.cancelIdempotencyKey} IS NOT NULL AND ${t.questCreditedAt} IS NULL)
    ))
  `),
]);

export const troopResearch = pgTable('troop_research', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  troop: troopTypeEnum('troop').notNull(),
  /** Current level 1–3, gated by Forge level (Addendum B1). */
  level: integer('level').notNull().default(1),
  /** Set while research is running (one at a time, enforced in code). */
  researchingToLevel: integer('researching_to_level'),
  finishesAt: timestamp('finishes_at', { withTimezone: true }),
  /** Refund receipt of the CURRENT research episode (the row is reused per
   * troop): the exact SHARD debit recorded at start and — once cancelled — its
   * exact compensation. A new start rewrites the debit and clears the
   * cancellation, so the row always describes one episode. NULL debit = a
   * research started before this receipt existed; it finishes normally. */
  paidShardCost: bigint('paid_shard_cost', { mode: 'bigint' }),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelIdempotencyKey: text('cancel_idempotency_key'),
}, (t) => [
  primaryKey({ columns: [t.playerWallet, t.troop] }),
  uniqueIndex('troop_research_player_cancel_key_uq').on(t.playerWallet, t.cancelIdempotencyKey),
  check('troop_research_cancel_state_ck', sql`
    (${t.paidShardCost} IS NULL AND ${t.debitLedgerTxnId} IS NULL
      AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
    OR (${t.paidShardCost} > 0 AND ${t.debitLedgerTxnId} IS NOT NULL AND (
      (${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
      OR (${t.cancelledAt} IS NOT NULL AND ${t.researchingToLevel} IS NULL AND ${t.refundLedgerTxnId} IS NOT NULL
        AND ${t.refundLedgerTxnId} <> ${t.debitLedgerTxnId} AND ${t.cancelIdempotencyKey} IS NOT NULL)
    ))
  `),
]);

/**
 * Hero levels (D-Q1, owner 2026-07-28) — one row per (wallet, hero), created
 * lazily on the first upgrade; a missing row means level 1 (HERO_LEVELING index
 * 0), so recruiting a hero needs no write.
 *
 * A TABLE rather than a jsonb column on `players` because (a) it mirrors the
 * existing troop_research precedent for exactly this shape, (b) the enum key is
 * validated by the DB instead of by convention, and (c) an upgrade is a
 * single-row upsert inside the spend transaction — a jsonb blob would need a
 * read-modify-write of the hot players row for every level.
 */
export const heroLevels = pgTable('hero_levels', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  hero: heroKeyEnum('hero').notNull(),
  /** Current level 1..HERO_LEVELING.maxLevel; upgrades cost KEEP. */
  level: integer('level').notNull().default(1),
  /** Attacker knockout recovery. NULL/expired = deployable. Defensive knockouts
   * never write this field; legacy rows backfill naturally as NULL. */
  recoveryUntil: timestamp('recovery_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.hero] })]);

export const layouts = pgTable('layouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  slot: layoutSlotEnum('slot').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  /** Positions only: [{buildingId, tx, ty}] (ARCHITECTURE §5). */
  positions: jsonb('positions').notNull().default([]),
}, (t) => [
  uniqueIndex('layouts_legacy_player_slot_uq').on(t.playerWallet, t.slot).where(sql`base_id IS NULL`),
  uniqueIndex('layouts_base_slot_uq').on(t.baseId, t.slot).where(sql`base_id IS NOT NULL`),
]);

export const shields = pgTable('shields', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  source: shieldSourceEnum('source').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('shields_player_expires_idx').on(t.playerWallet, t.expiresAt), index('shields_base_expires_idx').on(t.baseId, t.expiresAt)]);

/**
 * Singleton runtime levers (owner 2026-07-20). Baselines live in @shardkeep/shared
 * (MINING.EPOCH_RATE_BPS, WARZONE.*); THIS row holds the runtime OVERRIDE that a job
 * or admin mutates — the treasury-aware emission multiplier (#45) and the shieldless/
 * warzone mode switch (#46). Exactly one row, guarded by the constant PK id=true (a
 * second insert conflicts). Same durable-singleton idea as the system ledger accounts.
 */
export const gameConfig = pgTable('game_config', {
  id: boolean('id').primaryKey().default(true),
  /** #45: emission multiplier bps, 10000 = 1.0× nominal. The 10-min controller
   *  drives it within [EMISSION_CONTROL.minBps, maxBps]; getMiningQuota reads it. */
  emissionMultBps: integer('emission_mult_bps').notNull().default(10_000),
  /** When the controller last recomputed emissionMultBps (telemetry / staleness). */
  emissionUpdatedAt: timestamp('emission_updated_at', { withTimezone: true }),
  /** #46: 'off' = normal shields; 'scheduled' = predictable weekend window
   *  (WARZONE constants, request-time computed); 'purge' = an UNANNOUNCED admin-set
   *  window (purgeStartAt/EndAt) that no player-facing endpoint ever reveals. */
  shieldlessMode: shieldlessModeEnum('shieldless_mode').notNull().default('off'),
  purgeStartAt: timestamp('purge_start_at', { withTimezone: true }),
  purgeEndAt: timestamp('purge_end_at', { withTimezone: true }),
  /** Server-authoritative emergency brake for public global chat. */
  globalChatEnabled: boolean('global_chat_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Quests, streaks, referrals (GDD §5)
// ---------------------------------------------------------------------------

/** Global quest instances — the daily 3 / weekly 1 rotation (GDD §5). */
export const quests = pgTable('quests', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: questScopeEnum('scope').notNull(),
  /** Template id from the ~12-template pool, e.g. 'win_raid_2star'. */
  templateCode: text('template_code').notNull(),
  /** Counter target, e.g. steal 500 → 500. */
  target: integer('target').notNull(),
  rewardKeep: bigint('reward_keep', { mode: 'bigint' }).notNull(),
  /** Day (daily) or week-start day (weekly) this instance is live. */
  activeOn: date('active_on').notNull(),
}, (t) => [unique('quests_scope_day_template_unique').on(t.scope, t.activeOn, t.templateCode)]);

export const questProgress = pgTable('quest_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  questId: uuid('quest_id').notNull().references(() => quests.id),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  progress: integer('progress').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
}, (t) => [
  unique('quest_progress_quest_player_unique').on(t.questId, t.playerWallet),
  index('quest_progress_player_idx').on(t.playerWallet),
]);

/**
 * Daily-cache streak state (ECONOMY.md §3). Economy v2: `currentDays` is the
 * consecutive-active-day streak, advanced by claimDailyCache (gap>1 day → reset
 * to 1). `everCompletedWeek1` latches true on the first D7 — after that the
 * onboarding ladder never returns. `cacheClaimedDay` enforces once-per-UTC-day.
 * `streakBps` is retained (dropped from the mining math) but no longer read.
 */
export const streaks = pgTable('streaks', {
  playerWallet: text('player_wallet').primaryKey().references(() => players.wallet),
  /** Consecutive active days; the streak≥7 state turns on the 1.4× mining bonus. */
  currentDays: integer('current_days').notNull().default(0),
  /** Last day (UTC) that counted toward the streak. */
  lastActiveDate: date('last_active_date'),
  /** Latches on the first 7-day completion; gates the lifetime 500/100 path. */
  everCompletedWeek1: boolean('ever_completed_week1').notNull().default(false),
  /** UTC day of the last cache claim — once-per-day guard + gap detection. */
  cacheClaimedDay: date('cache_claimed_day'),
  /** LEGACY (Economy v1): power-streak bps, no longer read by mining. Kept to
   * avoid a destructive migration; safe to drop later. */
  streakBps: integer('streak_bps').notNull().default(0),
});

/**
 * First-run tutorial progress (M23 a6, owner 2026-08-15).
 *
 * WHY A SERVER TABLE AND NOT localStorage: the client must never decide game
 * state (CLAUDE.md hard rule), and the tutorial has to survive device changes
 * and be REPLAYABLE on purpose — the settings screen resets this row and the
 * whole run plays again. `step` is the index into the shared TUTORIAL_STEPS.ids
 * order (@shardkeep/shared); the server only ever accepts current+1 (or an
 * idempotent replay ≤ current), so a client can never skip itself ahead.
 * Advancing onto the terminal 'done' index stamps `completedAt`.
 *
 * WALLET-KEYED, not base-keyed, deliberately: the tutorial teaches the PLAYER
 * the UI once, it is not per-base progression — a second base must not replay
 * the coach marks.
 */
export const tutorialProgress = pgTable('tutorial_progress', {
  playerWallet: text('player_wallet').primaryKey().references(() => players.wallet),
  /** Index into TUTORIAL_STEPS.ids; 0 = the welcome card. */
  step: integer('step').notNull().default(0),
  /** Stamped when `step` reaches the terminal 'done' index; null after a reset. */
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /**
   * "STOP LEADING ME BY THE HAND" (owner 2026-08-29: players "should be able to
   * skip tutorial if they dont want to"). Set when the player dismisses the
   * GUIDED first-run flow — the coach marks, the spotlight and the objective
   * strip — and cleared when they turn guidance back on in settings.
   *
   * SEPARATE FROM `completedAt` because it means something different. The card
   * deck is finished for everyone who reaches the chain; this says the player
   * declined the hand-holding that comes AFTER it. The onboarding QUESTS are
   * untouched by it: they stay on the board, keep ticking and keep paying, which
   * is the whole reason skipping guidance is not the same as abandoning them.
   */
  guideSkippedAt: timestamp('guide_skipped_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Mine accrual buffer (ECONOMY.md §2). CoC-style lazy accrual: the Mine fills
 * `accruedShards` over real time at the player's fixed quota rate, clamped to a
 * 1-day storage cap; COLLECT credits it to the ledger and clears it. One row
 * per player, created on first settle. Integer base units (no float in the
 * ledger). `accruedShards` NEVER decreases on settle (we don't seize).
 */
export const mineState = pgTable('mine_state', {
  playerWallet: text('player_wallet').primaryKey().references(() => players.wallet),
  accruedShards: bigint('accrued_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  /** Last time accrual was settled into accruedShards. */
  lastAccrualAt: timestamp('last_accrual_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Proof-of-play per day (GDD §4.4): an "active miner" claimed at the Mine AND
 * completed ≥1 raid or ≥1 build/upgrade action. The daily emission cron reads
 * this table for the day being settled.
 */
export const dailyActivity = pgTable('daily_activity', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  /** UTC day being tracked. */
  day: date('day').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  raids: integer('raids').notNull().default(0),
  builds: integer('builds').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.day] })]);

export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  referrerWallet: text('referrer_wallet').notNull().references(() => players.wallet),
  /** A referee can be referred exactly once. STRICTLY ONE LEVEL (GDD §5). */
  refereeWallet: text('referee_wallet').notNull().unique().references(() => players.wallet),
  /** Set when the anti-sybil quality gate passes (paid + Keep L2 + 7d active). */
  qualifiedAt: timestamp('qualified_at', { withTimezone: true }),
  /** End of the 90-day 5%-match window (from qualification). */
  matchEndsAt: timestamp('match_ends_at', { withTimezone: true }),
  /** Running total paid to the referrer — bookkeeping for the ≤2× cap. */
  totalMatchedKeep: bigint('total_matched_keep', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('referrals_referrer_idx').on(t.referrerWallet)]);

// ---------------------------------------------------------------------------
// World map (GDD §3.4)
// ---------------------------------------------------------------------------

export const valleys = pgTable('valleys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /**
   * THE VALLEY'S PLACE ON THE PLANET, FROZEN (docs/WORLDMAP-GLOBE-PLAN.md §1.2,
   * LAND-DEED-ONBOARDING-PLAN P5). 0-based, dense at creation, UNIQUE.
   *
   * `siteOf(site_id)` (packages/shared/src/globe.ts) is what turns this into a
   * land cell + slot, and from there into a lon/lat. Until this column existed the
   * same number was DERIVED per request as
   * `row_number() over (order by created_at, id) - 1`, which made every base's
   * place on the globe a function of the valley TABLE'S CONTENTS: deleting one
   * valley row, or a clock skew that reordered two `created_at`s, renumbered every
   * valley after it and teleported every base inside them — silently, because a
   * pin has no way to look wrong. A deed that names a place cannot be built on
   * that. Backfilled from the very same row_number in migration 0052, so the globe
   * did not visibly move on the day it landed.
   *
   * WHY ONE INTEGER AND NOT (site_cell, site_slot): `siteOf` stays the ONE place
   * that decides ordinal → place, which is the whole point of lib/globeGeo.ts's
   * seam — the server and the web renderer must agree about where valley #7 is, and
   * two columns would let the DB hold a third opinion. UNIQUE is the no-two-valleys-
   * on-one-pin guarantee, in the only place that can actually enforce it.
   *
   * NOT `created_at`-derived and never reused: `createValley` assigns
   * `max(site_id) + 1`, so a deleted row leaves a HOLE (one unused Hilbert slot)
   * rather than shifting anybody. Gaps are harmless — `siteOf` is pure in the
   * number, it does not care that they are contiguous.
   */
  siteId: integer('site_id').notNull(),
  /**
   * WHICH BODY THIS VALLEY IS ON (docs/EARTH-TILES-PLAN.md §5.3, P5). 0 = Earth,
   * and nothing writes anything else yet.
   *
   * It exists now because Earth is FINITE and the ceiling is inside launch range:
   * `parcelGrid.patchCount()` seats 120 valleys / 58,920 parcels, and `siteOf` and
   * `patchCells` both THROW rather than wrap past the end (owner decision
   * 2026-08-10 Q1 — selling out is what unlocks the next planet). A second body is
   * then a new mask plus rows at `planet_id = 1`, with no schema rewrite and no
   * migration of Earth's rows. The alternative — namespacing by stride
   * (`planet = site_id / STRIDE`) — was rejected because `max(site_id) + 1` would
   * then allocate ACROSS planets and the invariant would be invisible to Postgres.
   *
   * THE UNIQUE IS NOW COMPOSITE — `(planet_id, site_id)`, because site ids are only
   * unique WITHIN a body: Earth's site 7 and the Moon's site 7 are different places.
   * Its NAME is deliberately still `valleys_site_id_uq`: `isSiteIdCollision`
   * (game/world.ts) matches on that exact string to decide "another signup took
   * this site — join their valley instead of failing", and a migration-first deploy
   * (R18) runs the OLD code against the NEW schema for a few seconds. Renaming the
   * constraint would make that window turn a routine concurrent rollover into a
   * failed signup.
   */
  planetId: smallint('planet_id').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('valleys_site_id_uq').on(t.planetId, t.siteId)]);

export const plots = pgTable('plots', {
  addressKind: text('address_kind').$type<'legacy-earth' | 'fantasy'>().notNull().default('legacy-earth'),
  fantasyWorldId: text('fantasy_world_id'),
  fantasyTileId: integer('fantasy_tile_id'),
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').references(() => bases.id),
  valleyId: uuid('valley_id').references(() => valleys.id),
  x: integer('x'),
  y: integer('y'),
  /**
   * THE PARCEL'S REAL PLACE ON EARTH, FROZEN (docs/EARTH-TILES-PLAN.md P5) — a
   * 0.5° land cell id on the FINE mask, `iy * 720 + ix`, ~55 km across, in a real
   * country. `cellCentreDeg` turns it into degrees and `countryIdOfCell` into a
   * sovereign; both go through lib/globeGeo.ts, the one seam.
   *
   * WHY IT IS STORED RATHER THAN DERIVED. Since P4 the cell has been a pure
   * function of two already-frozen integers — `parcelCell(valleys.site_id, x, y)`
   * — and that was safe only while nothing outside the process depended on the
   * answer. The owner then decided the COUNTRY GOES ON THE DEED (2026-08-10 Q3),
   * and a deed is a published document on a chain that cannot be recalled. The
   * derivation reads the generated Earth mask + country index, which
   * `pnpm --filter @shardkeep/scripts earth:mask` can legitimately rebuild — so a
   * build step would have been able to move land a minted deed already names.
   * Writing the answer down once makes that impossible: deed metadata reads THIS
   * column, never the mask (P6), and regenerating the Earth becomes a migration
   * with a backfill rather than an invisible build step (R15).
   *
   * FREEZING THE CELL IS NOT ENOUGH ON ITS OWN, and that gap is what `country_a3`
   * below closes: the cell → country lookup itself runs through the mask's land
   * ENUMERATION (`landCellRank`) and the index's own 1-based ids, both of which a
   * regeneration renumbers. So the address was frozen while the answer a deed
   * actually prints was still being recomputed. Both halves are columns now.
   *
   * NOT NULL, so a plot without an Earth cell cannot exist: it is written in the
   * same INSERT that creates the plot (`tryAssignInValley`, game/world.ts) and
   * backfilled for every pre-existing row by migration 0053.
   *
   * UNIQUE is the no-two-deeds-on-one-place guarantee, in the only layer that can
   * actually refuse it — the same argument `valleys_site_id_uq` makes one level up.
   * It is EARTH-ONLY on purpose: cell ids are mask-relative, so when a second body
   * lands this becomes `UNIQUE (planet, earth_cell)`, exactly as
   * `valleys_site_id_uq` just became composite. Until a row exists with
   * `valleys.planet_id <> 0` the plain UNIQUE is exact.
   *
   * A PvE CAMP HAS NO EARTH CELL AND MUST NOT GET ONE: camps hold a grid tile but
   * are not deeded land (R2), which is why `pve_camps` has no such column and why
   * `parcelCell` throws for a camp tile instead of inventing an address.
   */
  earthCell: integer('earth_cell'),
  /**
   * WHICH COUNTRY HOLDS THAT CELL, FROZEN TOO (migration 0054) — Natural Earth
   * `ADM0_A3`, three uppercase letters, or `'ZZZ'` for "no sovereign".
   *
   * WHY A SECOND COLUMN INSTEAD OF LOOKING THE CELL UP. `plots.earth_cell` is
   * frozen, but the lookup that turns it into a country was not: `countryIdOfCell`
   * resolves the cell to a RANK in the fine mask's land enumeration
   * (`landCellRank`) and then reads the country index at that rank, and the id it
   * returns is a 1-based position in an `ADM0_A3`-sorted list. Regenerate the Earth
   * data and any of those three can shift — one land cell gained anywhere below a
   * cell moves every rank after it — so the SAME frozen cell would have printed a
   * DIFFERENT country on a deed after a build step. That is precisely the objection
   * that got Earth lat/lon refused on 2026-08-09, and the reason owner decision Q3
   * ("the country goes on the deed") was only ever safe against a frozen column.
   * `ADM0_A3` is the right thing to store because it is the country's IDENTITY:
   * unique in the index, and the sort key the ids are ranks in, so it is the one
   * value a renumbering cannot touch. `earth_countries` turns it into the name.
   *
   * `'ZZZ'` IS THE NO-SOVEREIGN VALUE, AND IT IS NOT A LIE. ISO 3166-1 reserves
   * `ZZ`/`ZZZ` for user assignment, so it can never collide with a real ADM0_A3
   * (asserted against all 240 features in earth-address.test.ts), and there is
   * deliberately NO `earth_countries` row for it: a parcel whose cell has no
   * sovereign gets no Country trait rather than a fabricated one, the same way a
   * plot-less wallet gets no Location trait. On Earth it is unreachable —
   * `claimableCells` is "land cells with a country" ∪ the sub-tile countries'
   * cells, so every seatable cell has one — but it is exactly what a parcel on
   * ANOTHER BODY has (cell ids are mask-relative and the country index is Earth's),
   * which is why the column can be NOT NULL without lying about the Moon.
   *
   * NOT NULL for the same reason `earth_cell` is: it is written in the same INSERT
   * that creates the plot, so a plot cannot exist — for even one transaction —
   * without the country a deed would name.
   */
  countryA3: text('country_a3'),
  /** Legacy occupant/denormalized owner during multi-base dual-write. */
  playerWallet: text('player_wallet').references(() => players.wallet),
}, (t) => [
  unique('plots_valley_xy_unique').on(t.valleyId, t.x, t.y),
  unique('plots_earth_cell_uq').on(t.earthCell),
  foreignKey({ columns: [t.fantasyWorldId, t.fantasyTileId], foreignColumns: [fantasyWorldTiles.worldId, fantasyWorldTiles.tileId] }),
  uniqueIndex('plots_fantasy_tile_uq').on(t.fantasyWorldId, t.fantasyTileId).where(sql`${t.addressKind}='fantasy'`),
  check('plots_address_shape_ck', sql`(${t.addressKind}='legacy-earth' AND ${t.valleyId} IS NOT NULL
    AND ${t.x} IS NOT NULL AND ${t.y} IS NOT NULL AND ${t.earthCell} IS NOT NULL AND ${t.countryA3} IS NOT NULL
    AND ${t.fantasyWorldId} IS NULL AND ${t.fantasyTileId} IS NULL)
    OR (${t.addressKind}='fantasy' AND ${t.baseId} IS NOT NULL AND ${t.fantasyWorldId} IS NOT NULL AND ${t.fantasyTileId} IS NOT NULL
      AND ${t.valleyId} IS NULL AND ${t.x} IS NULL AND ${t.y} IS NULL AND ${t.earthCell} IS NULL AND ${t.countryA3} IS NULL)`),
  uniqueIndex('plots_base_uq').on(t.baseId).where(sql`base_id IS NOT NULL`),
  // During the flag-off/dual-write epoch, callers can still create a plot before
  // a stable base exists. NULL base ids must retain the old one-plot-per-wallet
  // invariant; PostgreSQL's ordinary UNIQUE(base_id) cannot protect NULL rows.
  uniqueIndex('plots_legacy_player_uq').on(t.playerWallet).where(sql`base_id IS NULL`),
  index('plots_player_idx').on(t.playerWallet),
  // The shape, in the only layer that can actually refuse a bad write. An
  // ADM0_A3 is always three uppercase letters; anything else is a bug that would
  // otherwise reach a deed as a silently omitted Country trait.
  check('plots_country_a3_shape', sql`${t.countryA3} ~ '^[A-Z]{3}$'`),
]);

/**
 * THE FROZEN COUNTRY REGISTRY (migration 0054) — `ADM0_A3` → the name a deed
 * prints. Seeded once with all 240 Natural Earth admin_0 features the checked-in
 * country index carries, `NAME` verbatim.
 *
 * WHY IT IS A TABLE AND NOT A LOOKUP INTO THE GENERATED INDEX. The deed path must
 * import NOTHING from the mask or the country index — that is the whole point of
 * freezing the address — and a name is the last thing that would have dragged the
 * index back in. So the naming authority moves into the layer that is already the
 * system's frozen record: changing what a deed calls a country now takes a
 * migration, exactly as R15 requires of everything else the Earth data feeds.
 *
 * NAME, VERBATIM, AND NEVER A FLAG (EARTH-TILES-PLAN R20): no boundary this
 * codebase redrew and no viewpoint it picked. `'ZZZ'` deliberately has no row.
 */

export const earthCountries = pgTable('earth_countries', {
  /** Natural Earth `ADM0_A3` — unique at both resolutions, three uppercase
   *  letters, and the sort key the index's ids are ranks in. */
  a3: text('a3').primaryKey(),
  /** Natural Earth `NAME`, verbatim — what a player and a marketplace read. */
  name: text('name').notNull(),
});

export const pveCamps = pgTable('pve_camps', {
  id: uuid('id').primaryKey().defaultRandom(),
  valleyId: uuid('valley_id').notNull().references(() => valleys.id),
  x: integer('x').notNull(),
  y: integer('y').notNull(),
  tier: integer('tier').notNull(),
  /** Frozen base layout the sim consumes (BaseSnapshot shape). */
  snapshot: jsonb('snapshot').notNull(),
  lootKeep: bigint('loot_keep', { mode: 'bigint' }).notNull(),
  /** NULL = alive; set when cleared, daily cron respawns (ARCHITECTURE §5). */
  respawnsAt: timestamp('respawns_at', { withTimezone: true }),
}, (t) => [unique('pve_camps_valley_xy_unique').on(t.valleyId, t.x, t.y)]);

// ---------------------------------------------------------------------------
// Raids (ARCHITECTURE §5–§6) — replay = (snapshot, orders, seed)
// ---------------------------------------------------------------------------

export const raids = pgTable('raids', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Client idempotency key (ECONOMY.md §4, v3): a retried create returns the
   * existing raid instead of consuming another energy — the energy consume and
   * this INSERT commit together, so a retry never double-charges. */
  idempotencyKey: text('idempotency_key').unique(),
  attackerWallet: text('attacker_wallet').notNull().references(() => players.wallet),
  attackerBaseId: uuid('attacker_base_id').references(() => bases.id),
  /** NULL for PvE raids (then pveCampId is set) — exactly-one enforced in code. */
  defenderWallet: text('defender_wallet').references(() => players.wallet),
  defenderBaseId: uuid('defender_base_id').references(() => bases.id),
  pveCampId: uuid('pve_camp_id').references(() => pveCamps.id),
  /** Campaign stage (1-60) this raid fights, NULL otherwise (campaign expansion, 2026-08-11).
   * Mutually exclusive with defenderWallet AND pveCampId — a campaign raid's
   * snapshot comes straight from the stage's parametric tier layout. */
  campaignStage: integer('campaign_stage'),
  /** mulberry32 seed, server-chosen. */
  seed: bigint('seed', { mode: 'bigint' }).notNull(),
  /** Frozen defender base (BaseSnapshot). */
  snapshot: jsonb('snapshot').notNull(),
  /** Frozen scenery, kept out of simulator inputs. NULL historical rows use Crownlands. */
  visualContext: jsonb('visual_context').$type<BaseVisualContext>(),
  /** Attacker army + buffs at raid start. */
  armySnapshot: jsonb('army_snapshot').notNull(),
  /** Validated DeployOrder[]; NULL until submitted (60s window). */
  orders: jsonb('orders'),
  ordersDeadlineAt: timestamp('orders_deadline_at', { withTimezone: true }).notNull(),
  status: raidStatusEnum('status').notNull().default('pending_orders'),
  /** Energy bucket this PvP raid consumed at creation (#58) — refunded if the raid
   *  expires unattacked. NULL for PvE (energy-free). */
  energySource: raidEnergySourceEnum('energy_source'),
  /** RaidResult: stars, destruction, loot, trophy deltas. */
  result: jsonb('result'),
  /** Sim event log — feeds the replay renderer. */
  events: jsonb('events'),
  /**
   * SIM_VERSION that produced `result`/`events` (packages/sim/src/version.ts).
   *
   * A raid is replayed by re-running the simulator over (snapshot, orders, seed),
   * so a raid is only replayable by a simulator that agrees with the one that
   * resolved it. Without this column there is no way to tell — the client would
   * happily re-simulate a v1 raid on a v2 sim and render a battle that never
   * happened, with a result that contradicts the player's own history.
   *
   * Backfilled to 1 for every pre-existing row, which is the truth: everything
   * recorded before 2026-07-29 was resolved by sim v1.
   */
  simVersion: integer('sim_version').notNull().default(1),
  /** Expiring distributed single-flight for synchronous simulation. Nullable
   * keeps pre-SIM6 rows forward-compatible; token ownership prevents an old,
   * expired worker from claiming resolution after a retry took over. */
  simulationLeaseToken: uuid('simulation_lease_token'),
  simulationLeaseUntil: timestamp('simulation_lease_until', { withTimezone: true }),
  /** Durable evidence that valid orders met a server-side admission/resolution
   * failure; stale expiry refunds rather than treating it as abandonment. */
  simulationSystemAttemptedAt: timestamp('simulation_system_attempted_at', { withTimezone: true }),
  /** D-118: bulk input has no command journal. Preserve the validated request
   * time so delayed resolution never fabricates another day of activity. */
  bulkDeploymentAcceptedAt: timestamp('bulk_deployment_accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  // same-target-once-per-day + attack history
  index('raids_attacker_created_idx').on(t.attackerWallet, t.createdAt),
  // revenge locks + defense log
  index('raids_defender_created_idx').on(t.defenderWallet, t.createdAt),
  /** Monday settlement counts resolved attacker-side deed PvP in one bounded
   * time window; this keeps the money transaction off the growing raid heap. */
  index('raids_attacker_base_resolved_idx').on(t.attackerBaseId, t.resolvedAt),
  index('raids_notification_due_idx').on(t.resolvedAt)
    .where(sql`${t.status} = 'resolved' AND ${t.defenderWallet} IS NOT NULL`),
  check('raids_visual_context_valid', sql`${t.visualContext} IS NULL OR (
    jsonb_typeof(${t.visualContext}) = 'object'
    AND ${t.visualContext}->'version' = '1'::jsonb
    AND ${t.visualContext}->'artVersion' IN ('1'::jsonb, '2'::jsonb)
    AND ${t.visualContext}->>'realmId' IN ('frostveil', 'elderwood', 'sunscar', 'crownlands',
      'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall')
  ) IS TRUE`),
]);

/** One unresolved raid may freeze a given attacker hero at a time. Stable
 * multi-base rows use baseId so two deeds may commit their independent copy of
 * the same hero; the nullable wallet arm is retained only for flag-off raids.
 * The XOR check and partial unique indexes make the mode fence structural. */
export const heroRaidReservations = pgTable('hero_raid_reservations', {
  playerWallet: text('player_wallet')
    .references(() => players.wallet, { onDelete: 'cascade' }),
  baseId: uuid('base_id')
    .references(() => bases.id, { onDelete: 'cascade' }),
  hero: heroKeyEnum('hero').notNull(),
  raidId: uuid('raid_id').notNull()
    .references(() => raids.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Keep the historical name so a quiescent rollback binary still translates
  // the wallet-arm 23505 into HERO_ALREADY_COMMITTED.
  uniqueIndex('hero_raid_reservations_player_hero_pk')
    .on(t.playerWallet, t.hero).where(sql`player_wallet IS NOT NULL`),
  uniqueIndex('hero_raid_reservations_base_hero_uq')
    .on(t.baseId, t.hero).where(sql`base_id IS NOT NULL`),
  uniqueIndex('hero_raid_reservations_raid_hero_uq').on(t.raidId, t.hero),
  index('hero_raid_reservations_raid_idx').on(t.raidId),
  check('hero_raid_reservations_owner_xor_ck', sql`num_nonnulls(${t.playerWallet}, ${t.baseId}) = 1`),
]);

// ---------------------------------------------------------------------------
// Ledger — append-only double-entry (ARCHITECTURE §5, research §1)
// ---------------------------------------------------------------------------

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Wallet-owned accounts set ownerWallet. Deed-owned accounts set baseId.
   * System accounts set neither. A deed sale never rewrites ledger ownership:
   * the base account remains attached to the stable base UUID. */
  ownerWallet: text('owner_wallet').references(() => players.wallet),
  baseId: uuid('base_id').references(() => bases.id),
  kind: accountKindEnum('kind').notNull(),
  currency: currencyEnum('currency').notNull(),
  /**
   * Balance cache, maintained ONLY by the ledger engine inside the same db
   * transaction as the entries. Source of truth = sum(ledger_entries.delta).
   */
  balance: bigint('balance', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // coalesce reproduces NULLS-NOT-DISTINCT for system rows while the partial
  // predicate leaves base accounts to their own stable identity below.
  uniqueIndex('accounts_owner_kind_unique')
    .on(sql`coalesce(${t.ownerWallet}, '')`, t.kind)
    .where(sql`${t.baseId} IS NULL`),
  uniqueIndex('accounts_base_kind_unique')
    .on(t.baseId, t.kind)
    .where(sql`${t.baseId} IS NOT NULL`),
  check('accounts_owner_scope_ck', sql`
    (${t.baseId} IS NOT NULL AND ${t.ownerWallet} IS NULL AND ${t.kind} IN ('base_shards', 'base_forge_escrow'))
    OR
    (${t.baseId} IS NULL AND ${t.ownerWallet} IS NOT NULL AND ${t.kind} IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store'))
    OR
    (${t.baseId} IS NULL AND ${t.ownerWallet} IS NULL AND ${t.kind} NOT IN ('player_keep', 'player_sol_credit', 'player_shards', 'player_gems', 'player_gems_store', 'base_shards', 'base_forge_escrow'))
  `),
]);

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Duplicate posts return the original txn — never double-post (GDD §4.9). */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  /** e.g. 'emission.daily', 'raid.loot', 'shop.purchase', 'withdrawal.payout'. */
  type: text('type').notNull(),
  metadata: jsonb('metadata').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable wallet-lifetime welcome promise. The backing-funded grant journal
 * is completion evidence; neither mail nor a transferable base owns this aid. */
export const welcomeGemsObligations = pgTable('welcome_gems_obligations', {
  wallet: text('wallet').primaryKey().references(() => players.wallet),
  gems: bigint('gems', { mode: 'bigint' }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('welcome_gems_obligations_positive_ck', sql`${t.gems} > 0`)]);

export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  txnId: uuid('txn_id').notNull().references(() => ledgerTransactions.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
  /** Account balance after applying delta — audit chain per account. */
  balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
}, (t) => [
  index('ledger_entries_txn_idx').on(t.txnId),
  index('ledger_entries_account_id_idx').on(t.accountId, t.id),
]);

/** One-way retirement latch for the obsolete KEEP quest allocation. The
 * account and its entries remain readable history; `ready` means every active
 * reward source uses emission_pool and PostgreSQL rejects old writers. */
export const questBucketRetirementState = pgTable('quest_bucket_retirement_state', {
  id: boolean('id').primaryKey().default(true),
  phase: text('phase').notNull().default('fenced'),
  fencedAt: timestamp('fenced_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  reconciliationTxnId: uuid('reconciliation_txn_id')
    .references(() => ledgerTransactions.id)
    .unique(),
}, (t) => [
  check('quest_bucket_retirement_state_singleton_ck', sql`${t.id} = true`),
  check('quest_bucket_retirement_state_phase_ck', sql`${t.phase} IN ('fenced', 'ready')`),
  check('quest_bucket_retirement_state_ready_ck', sql`
    (${t.phase} = 'fenced' AND ${t.readyAt} IS NULL AND ${t.reconciliationTxnId} IS NULL)
    OR (${t.phase} = 'ready' AND ${t.readyAt} IS NOT NULL)
  `),
]);

// ---------------------------------------------------------------------------
// Wallet mail — private inbox and escrow-backed rewards (M22)
// ---------------------------------------------------------------------------

/** Message ids are random UUIDs and every read is additionally recipient-
 * scoped. The sender wallet is audit-only and is never serialized to players. */
export const mailMessages = pgTable('mail_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  recipientWallet: text('recipient_wallet').notNull().references(() => players.wallet),
  senderKind: text('sender_kind').notNull(),
  senderWallet: text('sender_wallet').references(() => players.wallet),
  kind: text('kind').notNull(),
  /** Code/admin supplied retry identity. It is namespaced by the recipient so
   * one informational broadcast can use the same key for every inbox. */
  dedupeKey: text('dedupe_key').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  rewardState: text('reward_state'),
  reserveLedgerTxnId: uuid('reserve_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  claimLedgerTxnId: uuid('claim_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  unwindLedgerTxnId: uuid('unwind_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  /** Set only when a claimed reward contained deed-owned SHARDS/items. */
  claimBaseId: uuid('claim_base_id').references(() => bases.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
}, (t) => [
  unique('mail_messages_recipient_dedupe_uq').on(t.recipientWallet, t.dedupeKey),
  index('mail_messages_inbox_idx').on(t.recipientWallet, t.archivedAt, t.createdAt, t.id),
  index('mail_messages_expiry_idx').on(t.rewardState, t.expiresAt, t.id),
  index('mail_messages_notification_due_idx').on(t.createdAt),
  check('mail_messages_sender_ck', sql`
    (${t.senderKind} = 'system' AND ${t.senderWallet} IS NULL)
    OR (${t.senderKind} = 'admin' AND ${t.senderWallet} IS NOT NULL)
  `),
  check('mail_messages_lifecycle_ck', sql`
    (${t.kind} = 'info' AND ${t.rewardState} IS NULL AND ${t.expiresAt} IS NULL
      AND ${t.reserveLedgerTxnId} IS NULL AND ${t.claimLedgerTxnId} IS NULL
      AND ${t.unwindLedgerTxnId} IS NULL AND ${t.claimBaseId} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.expiredAt} IS NULL)
    OR
    (${t.kind} = 'reward' AND ${t.rewardState} IN ('pending', 'claimed', 'expired')
      AND ${t.expiresAt} IS NOT NULL
      AND (
        (${t.rewardState} = 'pending' AND ${t.claimLedgerTxnId} IS NULL
          AND ${t.unwindLedgerTxnId} IS NULL AND ${t.claimedAt} IS NULL AND ${t.expiredAt} IS NULL)
        OR (${t.rewardState} = 'claimed' AND ${t.unwindLedgerTxnId} IS NULL
          AND ${t.claimedAt} IS NOT NULL AND ${t.expiredAt} IS NULL)
        OR (${t.rewardState} = 'expired' AND ${t.claimLedgerTxnId} IS NULL
          AND ${t.claimBaseId} IS NULL AND ${t.claimedAt} IS NULL AND ${t.expiredAt} IS NOT NULL)
      ))
  `),
]);

/** Attachments are immutable after insertion; message lifecycle + the ledger
 * transaction ids above are the single atomic claim/unwind authority. */
export const mailAttachments = pgTable('mail_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').notNull().references(() => mailMessages.id, { onDelete: 'cascade' }),
  position: smallint('position').notNull(),
  kind: text('kind').notNull(),
  amount: bigint('amount', { mode: 'bigint' }),
  itemId: text('item_id'),
  qty: integer('qty'),
}, (t) => [
  unique('mail_attachments_message_position_uq').on(t.messageId, t.position),
  index('mail_attachments_message_idx').on(t.messageId),
  check('mail_attachments_payload_ck', sql`
    (${t.kind} IN ('KEEP', 'SHARDS') AND ${t.amount} > 0
      AND ${t.itemId} IS NULL AND ${t.qty} IS NULL)
    OR (${t.kind} = 'ITEM' AND ${t.amount} IS NULL
      AND ${t.itemId} IS NOT NULL AND ${t.qty} > 0)
  `),
]);

/**
 * Weekly proof-of-liabilities snapshots (GDD §1 pillar 4 / §4.9): the frozen
 * per-player balances behind each on-chain EpochRoot. Leaves are kept so
 * inclusion proofs can be served all week (PoR page).
 */
export const merkleSnapshots = pgTable('merkle_snapshots', {
  /** Epoch number = UTC weeks since 1970-01-05 (Monday-aligned). */
  epoch: bigint('epoch', { mode: 'bigint' }).primaryKey(),
  /** hex-encoded 32-byte root, matching the on-chain EpochRoot. */
  root: text('root').notNull(),
  totalBalance: bigint('total_balance', { mode: 'bigint' }).notNull(),
  leafCount: integer('leaf_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const merkleLeaves = pgTable('merkle_leaves', {
  epoch: bigint('epoch', { mode: 'bigint' }).notNull(),
  /** Position in the wallet-ascending leaf order (proof derivation). */
  leafIndex: integer('leaf_index').notNull(),
  wallet: text('wallet').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.epoch, t.leafIndex] }),
  unique('merkle_leaves_epoch_wallet_unique').on(t.epoch, t.wallet),
]);

/** Transactional outbox for external effects (root posting, object retirement). */
export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  status: outboxStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** Devnet signature of the on-chain post_root, kept as an audit trail proving
   * the epoch root was actually published (was discarded before). */
  txSignature: text('tx_signature'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Durable eligibility clock for retryable external effects. Root rows ignore
   * it; avatar retirement advances it after each transient R2 failure. */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  /** Optional relay ownership lease. Recovery security email uses it so an API
   * immediate drain and the worker cannot deliver the same row concurrently. */
  deliveryLeaseToken: text('delivery_lease_token'),
  deliveryLeaseExpiresAt: timestamp('delivery_lease_expires_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => [
  index('outbox_status_id_idx').on(t.status, t.id),
  index('outbox_avatar_due_idx').on(t.kind, t.status, t.nextAttemptAt, t.id),
]);

// ---------------------------------------------------------------------------
// Money plumbing (GDD §4.9)
// ---------------------------------------------------------------------------

export const deposits = pgTable('deposits', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  kind: depositKindEnum('kind').notNull(),
  /** Solana Pay-style reference pubkey the watcher polls for. */
  reference: text('reference').notNull().unique(),
  /** Authenticated client-submitted broadcast signature. Verification tries
   * this exact finalized transaction before the public reference history. */
  paymentSignature: text('payment_signature').unique(),
  status: depositStatusEnum('status').notNull().default('pending'),
  /** Credited idempotently on tx signature (GDD §4.9). */
  txSignature: text('tx_signature').unique(),
  /** Observed amount (lamports or KEEP base units). */
  amount: bigint('amount', { mode: 'bigint' }),
  /** WHICH TOKEN `amount` counts (security review 2026-07-28, mint rotation).
   *  The KEEP mint has rotated twice on devnet (legacy 8u6x… → v2 2yuk… → v3
   *  5GQh…) and the books recorded only a number, so per-mint reserve
   *  reconstruction was impossible after the fact. Stores the SPL mint for
   *  KEEP-denominated rows and the native-SOL mint for lamport rows, read from
   *  infra/devnet.addresses.json AT CREDIT TIME (money/mintDimension.ts).
   *  NULL = pre-migration history whose token is not knowable from the books —
   *  see drizzle/0046. Bookkeeping only: no payout path reads this. */
  mint: text('mint'),
  /** Action payload for kinds that target a specific thing — e.g. a Mine upgrade
   * carries { buildingId } so the verified SOL payment applies to that Mine. */
  payload: jsonb('payload'),
  ledgerTxnId: uuid('ledger_txn_id').references(() => ledgerTransactions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
}, (t) => [
  index('deposits_player_idx').on(t.playerWallet),
  uniqueIndex('deposits_base_purchase_key_uq').on(t.playerWallet, sql`(${t.payload}->'basePurchaseV1'->'request'->>'idempotencyKey')`)
    .where(sql`${t.payload} ? 'basePurchaseV1'`),
  // E2-GEMS-CONTRACT §1.1: one gems_buy intent per (wallet, idempotencyKey).
  // 0134_gems_schema creates this index after the enum-only migration commits.
  uniqueIndex('deposits_gems_buy_key_uq').on(t.playerWallet, sql`(${t.payload}->>'idempotencyKey')`)
    .where(sql`${t.kind} = 'gems_buy'`),
  uniqueIndex('deposits_shield_purchase_pending_uq').on(t.kind, sql`(${t.payload}->>'baseId')`)
    .where(sql`${t.payload}->'basePurchaseV1'->'request'->>'kind' in ('shield','warzone_shield') AND ${t.status}='pending' AND ${t.payload} ? 'basePurchaseV1'`),
  // One payable reference per builder slot. The API also serializes quote
  // creation on players FOR UPDATE; this constraint is the final authority if
  // a future caller forgets that lock.
  uniqueIndex('deposits_builder_slot_pending_uq')
    .on(sql`(${t.payload}->>'baseId')`, sql`((${t.payload}->>'expectedBuilders')::integer)`)
    .where(sql`${t.kind} = 'builder' AND ${t.status} = 'pending' AND ${t.payload} ? 'baseId' AND ${t.payload} ? 'expectedBuilders'`),
  uniqueIndex('deposits_builder_legacy_slot_pending_uq')
    .on(t.playerWallet, sql`((${t.payload}->>'expectedBuilders')::integer)`)
    .where(sql`${t.kind} = 'builder' AND ${t.status} = 'pending' AND NOT (${t.payload} ? 'baseId') AND ${t.payload} ? 'expectedBuilders'`),
  uniqueIndex('deposits_expansion_slot_pending_uq')
    .on(sql`(${t.payload}->>'baseId')`, sql`((${t.payload}->>'expectedExpansions')::integer)`)
    .where(sql`${t.kind} = 'expansion' AND ${t.status} = 'pending' AND ${t.payload} ? 'baseId' AND ${t.payload} ? 'expectedExpansions'`),
  uniqueIndex('deposits_expansion_legacy_slot_pending_uq')
    .on(t.playerWallet, sql`((${t.payload}->>'expectedExpansions')::integer)`)
    .where(sql`${t.kind} = 'expansion' AND ${t.status} = 'pending' AND NOT (${t.payload} ? 'baseId') AND ${t.payload} ? 'expectedExpansions'`),
  uniqueIndex('deposits_mine_target_pending_uq')
    .on(sql`((${t.payload}->>'buildingId')::uuid)`)
    // Do not compare the enum here: drizzle applies a clean migration history
    // in one transaction, and PostgreSQL forbids using any value added by an
    // earlier ALTER TYPE until commit. The UUID cast makes casing/accepted UUID
    // spellings one identity across pre-baseId and stable-base pending intents.
    .where(sql`${t.status} = 'pending' AND ${t.payload} ? 'buildingId'`),
  uniqueIndex('deposits_mine_build_slot_pending_uq')
    .on(sql`(${t.payload}->>'baseId')`, sql`((${t.payload}->>'expectedMines')::integer)`)
    .where(sql`${t.status} = 'pending' AND ${t.payload} ? 'baseId' AND ${t.payload} ? 'expectedMines'`),
  // Per-mint reserve reconstruction ("how much of token X ever entered custody")
  // is a full-table scan without this; it is the whole point of the column.
  index('deposits_mint_idx').on(t.mint),
]);

/** A payable land intent freezes one cell before signing. `deposit_id` makes
 * retries return that identity; the Earth-cell unique is the race authority. */
/** A closed unquoted command cannot mint a late payment reference. */
export const basePurchaseCancellations = pgTable('base_purchase_cancellations', {
  wallet: text('wallet').notNull().references(() => players.wallet),
  idempotencyKey: uuid('idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.wallet, t.idempotencyKey] })]);

/** Immutable effect of a paid shield; current shield rows can expire or be broken. */
export const basePurchaseShieldReceipts = pgTable('base_purchase_shield_receipts', {
  depositId: uuid('deposit_id').primaryKey().references(() => deposits.id),
  granted: boolean('granted').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

export const plotReservations = pgTable('plot_reservations', {
  addressKind: text('address_kind').$type<'legacy-earth' | 'fantasy'>().notNull().default('legacy-earth'),
  fantasyWorldId: text('fantasy_world_id'),
  fantasyTileId: integer('fantasy_tile_id'),
  id: uuid('id').primaryKey().defaultRandom(),
  depositId: uuid('deposit_id').notNull().unique().references(() => deposits.id),
  baseId: uuid('base_id').notNull().references(() => bases.id),
  earthCell: integer('earth_cell'),
  /** Frozen inverse address. Credit never reinterprets the chosen cell against
   * a later Earth-data build. */
  siteId: integer('site_id'),
  x: integer('x'),
  y: integer('y'),
  countryA3: text('country_a3'),
  state: plotReservationStateEnum('state').notNull().default('reserved'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('plot_reservations_expiry_idx').on(t.state, t.expiresAt),
  uniqueIndex('plot_reservations_live_earth_cell_uq').on(t.earthCell)
    .where(sql`state IN ('reserved', 'paid', 'converted')`),
  uniqueIndex('plot_reservations_live_base_uq').on(t.baseId)
    .where(sql`state IN ('reserved', 'paid', 'converted')`),
  foreignKey({ columns: [t.fantasyWorldId, t.fantasyTileId], foreignColumns: [fantasyWorldTiles.worldId, fantasyWorldTiles.tileId] }),
  uniqueIndex('plot_reservations_live_fantasy_tile_uq').on(t.fantasyWorldId, t.fantasyTileId)
    .where(sql`${t.state} IN ('reserved','paid','converted')`),
  check('plot_reservations_address_shape_ck', sql`(${t.addressKind}='legacy-earth' AND ${t.earthCell} IS NOT NULL
    AND ${t.siteId} IS NOT NULL AND ${t.x} IS NOT NULL AND ${t.y} IS NOT NULL AND ${t.countryA3} IS NOT NULL
    AND ${t.fantasyWorldId} IS NULL AND ${t.fantasyTileId} IS NULL)
    OR (${t.addressKind}='fantasy' AND ${t.fantasyWorldId} IS NOT NULL AND ${t.fantasyTileId} IS NOT NULL
      AND ${t.earthCell} IS NULL AND ${t.siteId} IS NULL AND ${t.x} IS NULL AND ${t.y} IS NULL AND ${t.countryA3} IS NULL)`),
  check('plot_reservations_country_a3_shape', sql`${t.countryA3} ~ '^[A-Z]{3}$'`),
]);

export const withdrawals = pgTable('withdrawals', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  currency: currencyEnum('currency').notNull(),
  /** Gross amount requested (fee comes out of this). */
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  /** 2% burned on KEEP withdrawals (GDD §4.9). */
  feeBurned: bigint('fee_burned', { mode: 'bigint' }).notNull().default(sql`0`),
  destination: text('destination').notNull(),
  status: withdrawalStatusEnum('status').notNull().default('unbonding'),
  /** 48h unbonding — cancellable, raid-protected until then (GDD §4.9). */
  unbondsAt: timestamp('unbonds_at', { withTimezone: true }).notNull(),
  txSignature: text('tx_signature').unique(),
  /** WHICH TOKEN actually left the hot wallet (security review 2026-07-28).
   *  13,959 KEEP of outflow was paid across at least two different SPL mints
   *  (legacy 8u6x… / v2 2yuk… / v3 5GQh…) and the books recorded only a number,
   *  so "what do we owe holders of mint X" was unanswerable. Written AT PAYOUT
   *  from infra/devnet.addresses.json — the same file the hot-wallet sender
   *  reads for the transfer — never at request time, because a row created
   *  before a rotation is paid with the mint that is current when it settles.
   *  NULL = paid before this column existed; not knowable from the books (the
   *  rotation cutover is a process restart, which leaves no row). */
  mint: text('mint'),
  // UNIQUE: one withdrawal row per escrow-freeze ledger txn. Stops a concurrent
  // same-idempotencyKey request from inserting a SECOND row against one freeze
  // (which would double-send on-chain) — security review 2026-07-19 #4.
  requestLedgerTxnId: uuid('request_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  payoutLedgerTxnId: uuid('payout_ledger_txn_id').references(() => ledgerTransactions.id),
  // The compensating escrow→player posting that unwound a FAILED payout. UNIQUE
  // for the requestLedgerTxnId reason: two rows can never claim one refund
  // posting, so a double-refund is structurally impossible even if the status
  // guard were ever weakened.
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  /** Why the last payout attempt failed — the only shortfall/ops signal a
   *  'failed' row carries (previously swallowed by a bare catch). */
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  // per-player daily cap scans (GDD §4.9: 25k/day)
  index('withdrawals_player_created_idx').on(t.playerWallet, t.createdAt),
  // "how much of mint X did we actually send" — the reserve question the
  // rotation made unanswerable.
  index('withdrawals_mint_idx').on(t.mint),
]);

/**
 * Raw wallet authorization submitted atomically with the escrow freeze.
 *
 * The API may insert only the untrusted challenge/signature pair. The signer
 * worker independently verifies it and writes the digest once. Migration 0089
 * installs an append-only trigger; the runtime role provisioner gives the API
 * no UPDATE/DELETE access and reserves validation fields for the worker.
 */
export const withdrawalAuthorizations = pgTable('withdrawal_authorizations', {
  withdrawalId: uuid('withdrawal_id').primaryKey()
    .references(() => withdrawals.id),
  challengeToken: text('challenge_token').notNull(),
  walletSignature: text('wallet_signature').notNull(),
  /** Frozen network identity selected by the validated server configuration.
   * A proof cannot cross a cluster or survive an unreviewed mint rotation. */
  cluster: text('cluster').notNull(),
  keepMint: text('keep_mint').notNull(),
  /** Database time, not a caller-provided timestamp. The worker verifies the
   * five-minute challenge at this instant even when payout matures 24h later. */
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  /** SHA-256 of the exact challenge+signature. UNIQUE is the durable replay
   * fence: one wallet proof can authorize at most one withdrawal row. */
  validatedDigest: text('validated_digest').unique(),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
}, (t) => [
  check('withdrawal_authorizations_challenge_size_ck', sql`
    length(${t.challengeToken}) BETWEEN 32 AND 4096
  `),
  check('withdrawal_authorizations_signature_shape_ck', sql`
    length(${t.walletSignature}) BETWEEN 80 AND 100
    AND ${t.walletSignature} ~ '^[1-9A-HJ-NP-Za-km-z]+$'
  `),
  check('withdrawal_authorizations_cluster_ck', sql`${t.cluster} IN ('devnet', 'mainnet-beta')`),
  check('withdrawal_authorizations_mint_shape_ck', sql`
    length(${t.keepMint}) BETWEEN 32 AND 44
    AND ${t.keepMint} ~ '^[1-9A-HJ-NP-Za-km-z]+$'
  `),
  check('withdrawal_authorizations_validation_pair_ck', sql`
    (${t.validatedDigest} IS NULL AND ${t.validatedAt} IS NULL)
    OR (${t.validatedDigest} ~ '^[0-9a-f]{64}$' AND ${t.validatedAt} IS NOT NULL)
  `),
]);

/** Worker-owned evidence enforcing the player's rolling-24h payout allowance.
 * It is intentionally per wallet: one player can never consume another's cap. */
export const withdrawalPayoutReservations = pgTable('withdrawal_payout_reservations', {
  withdrawalId: uuid('withdrawal_id').primaryKey().references(() => withdrawals.id),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  grossKeep: bigint('gross_keep', { mode: 'bigint' }).notNull(),
  status: text('status').notNull().default('reserved'),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('withdrawal_payout_reservations_gross_positive_ck', sql`${t.grossKeep} > 0`),
  check('withdrawal_payout_reservations_status_ck', sql`
    ${t.status} IN ('reserved', 'sent', 'released')
  `),
  index('withdrawal_payout_reservations_wallet_window_idx')
    .on(t.playerWallet, t.reservedAt, t.status),
]);

/** One immutable database-to-chain binding. Serving code never rebinds it;
 * devnet→mainnet requires a separate owner-reviewed drained migration. */
export const economyChainIdentity = pgTable('economy_chain_identity', {
  singleton: boolean('singleton').primaryKey().default(true),
  cluster: text('cluster').notNull(),
  keepMint: text('keep_mint').notNull(),
  coreProgram: text('core_program').notNull(),
  configPda: text('config_pda').notNull(),
  gemsReserveOwner: text('gems_reserve_owner'),
  gemsReserveAta: text('gems_reserve_ata'),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('economy_chain_identity_singleton_ck', sql`${t.singleton} = true`),
  check('economy_chain_identity_cluster_ck', sql`${t.cluster} IN ('devnet', 'mainnet-beta')`),
  check('economy_chain_identity_gems_reserve_ck', sql`
    (${t.gemsReserveOwner} IS NULL AND ${t.gemsReserveAta} IS NULL) OR
    (${t.gemsReserveOwner} IS NOT NULL AND ${t.gemsReserveAta} IS NOT NULL
      AND ${t.gemsReserveOwner} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      AND ${t.gemsReserveAta} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
  `),
  check('economy_chain_identity_addresses_ck', sql`
    ${t.keepMint} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.coreProgram} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.configPda} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  `),
]);

/** Separately reviewed Phase E wallet-token identity. Schema installation is
 * empty; serving only compares. The owner binding guard derives boundAt and
 * refuses all earlier publication/claim/market/recovery and input-custody rows. */
export const phaseEChainIdentity = pgTable('phase_e_chain_identity', {
  singleton: boolean('singleton').primaryKey().default(true),
  cluster: text('cluster').notNull(),
  genesisHash: text('genesis_hash').notNull(),
  keepMint: text('keep_mint').notNull(),
  economyProgram: text('economy_program').notNull(),
  craftProgram: text('craft_program').notNull(),
  treasury: text('treasury').notNull(),
  reserveOwner: text('reserve_owner').notNull(),
  reserveAta: text('reserve_ata').notNull(),
  bindingReceiptSha256: text('binding_receipt_sha256').notNull(),
  boundAt: timestamp('bound_at', { withTimezone: true }).notNull(),
}, (t) => [
  check('phase_e_chain_identity_singleton_ck', sql`${t.singleton} = true`),
  check('phase_e_chain_identity_cluster_ck', sql`${t.cluster} = 'devnet'`),
  check('phase_e_chain_identity_genesis_ck', sql`${t.genesisHash} = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'`),
  check('phase_e_chain_identity_addresses_ck', sql`
    ${t.keepMint} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.economyProgram} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.craftProgram} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.treasury} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.reserveOwner} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND ${t.reserveAta} ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  `),
  check('phase_e_chain_identity_roles_ck', sql`
    ${t.keepMint} NOT IN (${t.economyProgram}, ${t.craftProgram}, ${t.treasury},
      ${t.reserveOwner}, ${t.reserveAta})
    AND ${t.economyProgram} <> ${t.craftProgram}
    AND ${t.reserveOwner} <> ${t.reserveAta}
  `),
  check('phase_e_chain_identity_receipt_ck', sql`${t.bindingReceiptSha256} ~ '^[0-9a-f]{64}$'`),
  check('phase_e_chain_identity_time_ck', sql`isfinite(${t.boundAt})`),
]);

/**
 * One immutable signed Solana transaction per withdrawal payout.
 *
 * The signed bytes and their signature are committed before the first RPC
 * broadcast. Retries therefore rebroadcast exactly the same transaction rather
 * than signing a second transfer after an ambiguous timeout. A blockhash that
 * expires is not proof of absence: null results from ordinary RPC history stay
 * unresolved and non-refundable even when multiple providers agree.
 */
export const withdrawalAttempts = pgTable('withdrawal_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  withdrawalId: uuid('withdrawal_id').notNull().references(() => withdrawals.id).unique(),
  status: withdrawalAttemptStatusEnum('status').notNull().default('prepared'),
  txSignature: text('tx_signature').notNull().unique(),
  /** Exact wire transaction signed by the hot wallet. Never reconstructed. */
  signedTransaction: bytea('signed_transaction').notNull(),
  recentBlockhash: text('recent_blockhash').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  /** Locally decoded and validated economic intent corresponding to the bytes. */
  transferSnapshot: jsonb('transfer_snapshot').notNull(),
  broadcastCount: integer('broadcast_count').notNull().default(0),
  firstBroadcastAt: timestamp('first_broadcast_at', { withTimezone: true }),
  lastBroadcastAt: timestamp('last_broadcast_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  /** Sanitized transport/finality diagnostic; never used as proof of absence. */
  lastError: text('last_error'),
  /** Endpoint labels that observed expiry/null history; diagnostic only. */
  absenceProofSources: jsonb('absence_proof_sources'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('withdrawal_attempts_status_idx').on(t.status, t.updatedAt),
  check('withdrawal_attempts_broadcast_count_nonnegative', sql`${t.broadcastCount} >= 0`),
  check('withdrawal_attempts_last_valid_height_nonnegative', sql`${t.lastValidBlockHeight} >= 0`),
  check('withdrawal_attempts_terminal_finalized_at', sql`
    ${t.status} NOT IN ('finalized_success', 'finalized_error')
    OR ${t.finalizedAt} IS NOT NULL
  `),
]);

// ---------------------------------------------------------------------------
// Auth (ARCHITECTURE §5 — SIWS-style)
// ---------------------------------------------------------------------------

/** Single-use, 5-min-TTL challenge nonces. No FK: challenged wallets may not be players yet. */
/** Gold Forge daily contributions (owner rules 2026-07-24): one row per
 * (day, player), shards accumulate across a UTC day; settlement stamps the
 * results. Day format 'YYYY-MM-DD' (UTC). Settlement math lives in
 * game/forge.ts and mirrors scripts/src/forge-model.ts EXACTLY. */
export const forgeContributions = pgTable('forge_contributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  day: text('day').notNull(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  shards: bigint('shards', { mode: 'bigint' }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  keepPaid: bigint('keep_paid', { mode: 'bigint' }),
  shardsRefunded: bigint('shards_refunded', { mode: 'bigint' }),
  /** ItemId dropped at settlement (FORGE_DROPS, owner 2026-07-24) or null. */
  itemDropped: text('item_dropped'),
  /** Ledger txn that moved this day's payout emission_pool → forge_payout_escrow.
   *  NULL ⇒ the KEEP was NEVER escrowed: either the payout rounded to 0, or the
   *  row was settled by the PRE-CLAIM auto-credit code and is already in the
   *  player's spendable balance. Structural gate: a row with NULL here is
   *  UNCLAIMABLE forever (see migration 0045's double-pay firebreak). */
  keepEscrowTxnId: uuid('keep_escrow_txn_id').references(() => ledgerTransactions.id),
  /** Set when the player claims. Legacy auto-credited rows were backfilled to
   *  settled_at by migration 0045 — the money reached them at settlement. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** UNIQUE: one claim posting per row, DB-enforced (the
   *  withdrawals.requestLedgerTxnId precedent) — two rows can never point at
   *  the same payout txn. */
  claimTxnId: uuid('claim_txn_id').references(() => ledgerTransactions.id).unique(),
  /** Set when an unclaimed allocation lapsed and swept back to emission_pool. */
  expiredAt: timestamp('expired_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('forge_day_player_uq').on(t.day, t.playerWallet),
  index('forge_day_idx').on(t.day),
  /** Personal history (GET /forge/allocations), keyset on day DESC. */
  index('forge_player_day_idx').on(t.playerWallet, t.day.desc()),
  /** Global list keyset pagination + rank counts (GET /forge/global). */
  index('forge_day_keep_idx').on(t.day, t.keepPaid.desc(), t.playerWallet),
  /** The expiry sweep and the claimable summary. */
  index('forge_unclaimed_idx').on(t.settledAt)
    .where(sql`claimed_at is null and expired_at is null and keep_escrow_txn_id is not null`),
]);

/** Stable-base daily usage fence for Gold Forge contributions. The ordinary
 * forge_contributions row remains wallet/day payout aggregation; this separate
 * counter prevents selling one Forge through fresh wallets from resetting the
 * same building's daily allowance. */
export const forgeBaseDailyUsage = pgTable('forge_base_daily_usage', {
  day: text('day').notNull(),
  baseId: uuid('base_id').notNull().references(() => bases.id),
  /** Frozen on the first contribution. A deed transfer cannot reset either
   * the base/day cap or its drop entrant until the next UTC forge day. */
  dayOwnerWallet: text('day_owner_wallet').notNull().references(() => players.wallet),
  shards: bigint('shards', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.day, t.baseId] }),
  check('forge_base_daily_usage_nonnegative_ck', sql`${t.shards} >= 0`),
]);

/** Item inventory (ITEMS phase 1 — cosmetics). One row per owned item; the
 * unique pair makes cosmetic purchases naturally idempotent at the DB layer
 * (buy twice → second insert conflicts → rejected before any charge). qty is
 * reserved for future stackable consumables (always 1 for cosmetics). */
export const playerItems = pgTable('player_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  /** ItemId from @shardkeep/shared ITEMS (the catalog is code, not DB). */
  itemId: text('item_id').notNull(),
  qty: integer('qty').notNull().default(1),
  /** Persists the inventory NEW-marker even when qty returns to zero. */
  seenAt: timestamp('seen_at', { withTimezone: true }),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  /** Provenance (E2-GEMS-CONTRACT §3): shop_gems items are account-bound, so
   * listItem refuses them; every pre-0134 row is 'legacy'. */
  acquiredVia: text('acquired_via').notNull().default('legacy'),
}, (t) => [
  uniqueIndex('player_items_owner_item_uq').on(t.playerWallet, t.itemId),
  index('player_items_owner_idx').on(t.playerWallet),
  check('player_items_qty_nonnegative_ck', sql`${t.qty} >= 0`),
  check('player_items_acquired_via_ck', sql`${t.acquiredVia} IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant')`),
]);

/** Optimistic-version anchor for one hero's ten equipment slots. Missing means
 * version zero and an empty loadout; the first equip creates it atomically. */
export const heroLoadouts = pgTable('hero_loadouts', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet, { onDelete: 'cascade' }),
  hero: heroKeyEnum('hero').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.playerWallet, t.hero] }),
  check('hero_loadouts_version_nonnegative_ck', sql`${t.version} >= 0`),
]);

/** One item copy occupies one hero slot. Ownership stays in player_items; API
 * availability is qty minus rows here, allowing two owned copies across heroes. */
export const heroEquipment = pgTable('hero_equipment', {
  playerWallet: text('player_wallet').notNull(),
  hero: heroKeyEnum('hero').notNull(),
  slot: gearSlotEnum('slot').notNull(),
  itemId: text('item_id').notNull(),
  equippedAt: timestamp('equipped_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.playerWallet, t.hero, t.slot] }),
  foreignKey({
    columns: [t.playerWallet, t.hero],
    foreignColumns: [heroLoadouts.playerWallet, heroLoadouts.hero],
    name: 'hero_equipment_loadout_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.playerWallet, t.itemId],
    foreignColumns: [playerItems.playerWallet, playerItems.itemId],
    name: 'hero_equipment_owned_item_fk',
  }).onDelete('cascade'),
  index('hero_equipment_owner_item_idx').on(t.playerWallet, t.itemId),
]);

/**
 * Idempotency anchor for consuming a consumable (E2, audit 2026-07-26). Unlike
 * /items/buy — which rides the LEDGER's idempotency via spendKeep — a USE moves
 * no ledger money: it decrements `player_items.qty` in place, and that qty is
 * SOL-denominated value (items are bought and traded for SOL). With no anchor a
 * true double-submit burned two units for one intent. The INSERT happens inside
 * the same transaction as the decrement, so the unique key is what serialises
 * them: the loser conflicts and rolls its decrement back.
 */
/**
 * Clans (Phase 3 pulled forward — CLANS-SELLABLE-DEEDS-PLAN C1). MVP: identity +
 * membership only; the weekly chest (C3) adds its ledger plumbing separately so
 * clan money never bypasses double-entry. Leadership is `leader_wallet` on the
 * clan row — no role column to drift out of sync with it.
 */
export const clans = pgTable('clans', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Display name, unique game-wide (case-preserving; uniqueness is exact). */
  name: text('name').notNull().unique(),
  /** Short badge shown next to member names (raid log, leaderboard). */
  tag: text('tag').notNull().unique(),
  leaderWallet: text('leader_wallet').notNull().references(() => players.wallet),
  inviteMode: clanInviteModeEnum('invite_mode').notNull().default('open'),
  /** Join secret when inviteMode='invite'; NULL for open clans. */
  inviteCode: text('invite_code'),
  /** This clan's slice of the pooled clan_chest system account (C3). CACHE like
   *  accounts.balance: only ever written in the SAME tx as the ledger posting
   *  that moves the pooled account, so sum(chest_shards) == pool balance. */
  chestShards: bigint('chest_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Historical command identities survive clan dissolution and later deed/member
// changes. The snapshots intentionally do not reference the deletable clan row.
export const clanCommandReceipts = pgTable('clan_command_receipts', {
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  requestKey: uuid('request_key').notNull(),
  kind: text('kind').notNull(),
  clanId: uuid('clan_id').notNull(),
  baseId: uuid('base_id'),
  targetWallet: text('target_wallet'),
  state: text('state').notNull(),
  payoutShards: bigint('payout_shards', { mode: 'bigint' }).notNull(),
  ledgerTransactionId: uuid('ledger_transaction_id').references(() => ledgerTransactions.id),
  refusalCode: text('refusal_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.actorWallet, t.requestKey] }),
  uniqueIndex('clan_command_payout_uq').on(t.ledgerTransactionId).where(sql`${t.ledgerTransactionId} IS NOT NULL`),
  check('clan_command_consent_ck', sql`(${t.kind} = 'leave' AND ${t.targetWallet} IS NULL AND ${t.state} IN ('left','disbanded','refused'))
    OR (${t.kind} = 'kick' AND ${t.baseId} IS NULL AND ${t.targetWallet} IS NOT NULL AND ${t.state} IN ('kicked','refused'))`),
  check('clan_command_outcome_ck', sql`${t.payoutShards} >= 0 AND
    ((${t.state} = 'refused' AND ${t.refusalCode} IS NOT NULL AND ${t.refusalCode} IN ('CLAN_CHANGED','CLAN_LEADER_NOT_ALONE','CLAN_NOT_LEADER','CLAN_SELF_KICK','CLAN_TARGET_ABSENT'))
      OR (${t.state} <> 'refused' AND ${t.refusalCode} IS NULL)) AND
    ((${t.state} = 'disbanded' AND ((${t.payoutShards} > 0 AND ${t.ledgerTransactionId} IS NOT NULL)
      OR (${t.payoutShards} = 0 AND ${t.ledgerTransactionId} IS NULL)))
      OR (${t.state} <> 'disbanded' AND ${t.payoutShards} = 0 AND ${t.ledgerTransactionId} IS NULL))`),
]);

export const clanMembers = pgTable('clan_members', {
  /** PRIMARY KEY = one clan per player, enforced by the table shape itself. */
  playerWallet: text('player_wallet').primaryKey().references(() => players.wallet),
  clanId: uuid('clan_id').notNull().references(() => clans.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('clan_members_clan_idx').on(t.clanId)]);

/** Campaign star progression (MAPS handout split, 2026-07-26). One row per
 *  cleared-or-attempted stage; bestStars only ever ratchets UP. */
export const campaignProgress = pgTable('campaign_progress', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  stage: integer('stage').notNull(),
  bestStars: integer('best_stars').notNull().default(0),
  /** Stamped once, on the first 3★ — the one-time reward's idempotency anchor. */
  firstThreeStarAt: timestamp('first_three_star_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.stage] })]);

/**
 * Base-transfer audit (security review 2026-07-27 #2b): every handover records
 * the FULL prior state in the same tx, so a bad transfer is reconstructible and
 * invertible by ops. Append-only.
 */
export const baseTransfers = pgTable('base_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  deedAssetId: text('deed_asset_id').notNull(),
  fromWallet: text('from_wallet').notNull(),
  toWallet: text('to_wallet').notNull(),
  priorKeepLevel: integer('prior_keep_level').notNull(),
  priorExpansions: integer('prior_expansions').notNull(),
  priorEntryPaidAt: timestamp('prior_entry_paid_at', { withTimezone: true }),
  buildingsMoved: integer('buildings_moved').notNull(),
  jobsMoved: integer('jobs_moved').notNull(),
  shieldsMoved: integer('shields_moved').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Free-base abandon audit (security review 2026-08-09 F13). Same purpose and shape
 * as base_transfers above, for the game's ONLY destructive route: `abandonFreeBase`
 * deletes buildings and jobs, tombstones the terrain and resets keepLevel/expansions,
 * and wrote no record at all — so "my base is gone" was an unanswerable support
 * case. Full prior state, written inside the same transaction, append-only, never
 * updated. Unlike base_transfers this carries an FK: the row is written while the
 * player row is held FOR UPDATE, so the wallet provably exists.
 */
export const baseAbandons = pgTable('base_abandons', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  priorKeepLevel: integer('prior_keep_level').notNull(),
  priorExpansions: integer('prior_expansions').notNull(),
  buildingsDeleted: integer('buildings_deleted').notNull(),
  /** Tombstoned, not deleted — the terrain is generated once per wallet (F5). */
  obstaclesTombstoned: integer('obstacles_tombstoned').notNull(),
  jobsDeleted: integer('jobs_deleted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('base_abandons_player_idx').on(t.playerWallet)]);

/**
 * Permanent per-WALLET elite-troop training unlocks (owner 2026-08-16, D-058).
 * A row exists ⇔ the wallet may train/research that troop. Writers: consuming a
 * TRAINING WRIT (items.ts useItem, source 'item'), the one-shot worker-boot
 * grandfather backfill (troopUnlocks.ts, source 'grandfather'), and the lazy
 * self-heal for wallets already fielding the troop (source 'lazy_grandfather').
 * Deliberately WALLET-scoped, not deed-scoped: training knowledge is account
 * knowledge — selling a base must never make a player's army untrainable.
 */
export const troopUnlocks = pgTable('troop_unlocks', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  troop: troopTypeEnum('troop').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.playerWallet, t.troop] }),
]);

export const itemUses = pgTable('item_uses', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  itemId: text('item_id').notNull(),
  /** NAMESPACED per wallet+op by the caller, mirroring `item:${wallet}:${key}`
   *  in buyItem — a bare client key must not collide across players or ops. */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('item_uses_owner_idx').on(t.playerWallet),
]);

/**
 * In-app item market (Lane B, owner 2026-07-24: in-game items sold for SOL). A
 * listing HOLDS one unequipped unit of a DB item — qty decremented from the seller's
 * inventory on list and held here until it sells (→ buyer) or cancels (→ back to
 * seller), so an item can't be double-sold or used while listed.
 *
 * Settlement is a DIRECT, non-custodial SOL payment: the buyer RESERVES the
 * listing (locks it to them for a window), pays the seller 95% + our fee
 * treasury 5% in one buyer-signed on-chain tx (reference-tagged), and the server
 * grants the item once it verifies the finalized payment. No SOL ever pools in a
 * game wallet; the item is reserved before payment so it can't vanish under a
 * paying buyer (MARKETPLACE-ESCROW-SPEC §3 Lane, direct-split settlement).
 */
export const itemListings = pgTable('item_listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  sellerWallet: text('seller_wallet').notNull().references(() => players.wallet),
  /** Stable source custody for gear/consumables. NULL is deliberately either
   * an account cosmetic or a fenced flag-off/legacy listing. */
  baseId: uuid('base_id').references(() => bases.id, { onDelete: 'restrict' }),
  /** Namespaced `item-list:${wallet}:${clientKey}`. Exact retries return the
   * original held listing; a reused key with another item/price is rejected. */
  idempotencyKey: text('idempotency_key').notNull().unique(),
  itemId: text('item_id').notNull(),
  /** Lamports the buyer pays total; the seller nets price − 5% fee. */
  priceLamports: bigint('price_lamports', { mode: 'bigint' }).notNull(),
  /** active → reserved → sold | (reserved → active on expiry) | cancelled. */
  status: text('status').notNull().default('active'),
  /** Reservation (set while status='reserved'): who's buying, until when, and
   *  the reference pubkey their payment tx must include (for finalized lookup). */
  reservedBy: text('reserved_by').references(() => players.wallet),
  reservedUntil: timestamp('reserved_until', { withTimezone: true }),
  reference: text('reference'),
  buyerWallet: text('buyer_wallet').references(() => players.wallet),
  /** Frozen destination deed for a stable reservation. Payment completion must
   * still deliver here if that deed transfers before finalization. */
  buyerBaseId: uuid('buyer_base_id').references(() => bases.id, { onDelete: 'restrict' }),
  /** Committed payment signature the buyer registered right after broadcasting
   *  (safeguard, owner 2026-07-24): while set, the reservation is LOCKED to that
   *  buyer and can't be reclaimed until a valid payment can no longer finalize —
   *  so a paid buyer never loses the item to a reopen, even under network lag. */
  paymentSig: text('payment_sig'),
  /** The verified settlement payment signature (set on sale). */
  txSignature: text('tx_signature'),
  /** When the worker reconciler last read this reservation GENERATION's proof
   *  (migration 0133). Reset with every new reservation/release. Rows tried
   *  within MARKETPLACE.itemMarket.reconcileRetrySec are skipped, and the queue
   *  runs never-attempted first, so a batch of stuck rows cannot starve a
   *  newer lapsed reservation (security review 2026-09-17 #1). */
  reconcileAttemptedAt: timestamp('reconcile_attempted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => [
  index('item_listings_status_idx').on(t.status),
  index('item_listings_seller_idx').on(t.sellerWallet),
  index('item_listings_base_idx').on(t.baseId),
  index('item_listings_buyer_base_idx').on(t.buyerBaseId),
  // One finalized payment settles at most ONE listing (security review 2026-07-24
  // #1): without this a buyer can tag one transfer with many reservation
  // references and settle every one. Postgres treats NULLs as distinct, so
  // active/reserved rows (tx_signature NULL) are unconstrained; only sold rows
  // (non-NULL sig) must be unique.
  uniqueIndex('item_listings_tx_sig_uq').on(t.txSignature),
  check('item_listings_base_custody_ck', sql`
    (${t.baseId} IS NULL AND ${t.buyerBaseId} IS NULL)
    OR (${t.baseId} IS NOT NULL AND (
      (${t.status} IN ('active', 'cancelled') AND ${t.buyerBaseId} IS NULL)
      OR (${t.status} IN ('reserved', 'sold') AND ${t.buyerBaseId} IS NOT NULL)
    ))
  `),
]);

/** Every post-contract reservation keeps its original public quote after the mutable book
 * moves on. No backfill guesses fee/network terms for a pre-contract reservation. */
export const itemMarketReservations = pgTable('item_market_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => itemListings.id, { onDelete: 'restrict' }),
  contractVersion: integer('contract_version').notNull().default(1),
  buyerWallet: text('buyer_wallet').notNull().references(() => players.wallet),
  requestKey: text('request_key'),
  requestPayload: jsonb('request_payload').$type<import('@shardkeep/shared/market').MarketReserveRequest>(),
  itemId: text('item_id').notNull(),
  sourceBaseId: uuid('source_base_id').references(() => bases.id, { onDelete: 'restrict' }),
  buyerBaseId: uuid('buyer_base_id').references(() => bases.id, { onDelete: 'restrict' }),
  sellerWallet: text('seller_wallet').notNull().references(() => players.wallet),
  cluster: text('cluster').$type<'devnet' | 'mainnet-beta'>().notNull(),
  reference: text('reference').notNull().unique(),
  priceLamports: bigint('price_lamports', { mode: 'bigint' }).notNull(),
  feeBps: integer('fee_bps').notNull(),
  sellerLamports: bigint('seller_lamports', { mode: 'bigint' }).notNull(),
  feeLamports: bigint('fee_lamports', { mode: 'bigint' }).notNull(),
  feeTreasury: text('fee_treasury').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  payableUntil: timestamp('payable_until', { withTimezone: true }).notNull(),
  state: text('state').$type<'reserved' | 'committed' | 'settled' | 'superseded' | 'cancelled'>().notNull().default('reserved'),
  paymentSig: text('payment_sig'),
  txSignature: text('tx_signature'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('item_market_reservation_key_uq').on(t.buyerWallet, t.requestKey).where(sql`${t.requestKey} IS NOT NULL`),
  index('item_market_reservation_listing_idx').on(t.listingId),
  index('item_market_reservation_buyer_idx').on(t.buyerWallet, t.createdAt),
  index('item_market_reservation_payment_idx').on(t.paymentSig),
  uniqueIndex('item_market_reservation_tx_uq').on(t.txSignature),
  check('item_market_reservation_quote_ck', sql`
    ${t.contractVersion} = 1 AND ${t.cluster} IN ('devnet','mainnet-beta')
    AND ${t.buyerWallet} <> ${t.sellerWallet} AND ${t.buyerWallet} <> ${t.feeTreasury} AND ${t.sellerWallet} <> ${t.feeTreasury}
    AND (${t.sourceBaseId} IS NULL) = (${t.buyerBaseId} IS NULL)
    AND (${t.requestKey} IS NULL) = (${t.requestPayload} IS NULL)
    AND ${t.priceLamports} > 0 AND ${t.sellerLamports} > 0 AND ${t.feeLamports} >= 0
    AND ${t.feeBps} BETWEEN 0 AND 10000
    AND ${t.priceLamports} = ${t.sellerLamports} + ${t.feeLamports}
    AND ${t.feeLamports} = floor(${t.priceLamports}::numeric * ${t.feeBps} / 10000)
    AND ${t.payableUntil} > ${t.createdAt}`),
  check('item_market_reservation_state_ck', sql`
    (${t.state} = 'reserved' AND ${t.paymentSig} IS NULL AND ${t.txSignature} IS NULL AND ${t.resolvedAt} IS NULL)
    OR (${t.state} = 'committed' AND ${t.paymentSig} IS NOT NULL AND ${t.txSignature} IS NULL AND ${t.resolvedAt} IS NULL)
    OR (${t.state} = 'settled' AND ${t.txSignature} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND (${t.paymentSig} IS NULL OR ${t.paymentSig} = ${t.txSignature}))
    OR (${t.state} IN ('superseded','cancelled') AND ${t.txSignature} IS NULL AND ${t.resolvedAt} IS NOT NULL)`),
]);

/** A cancellation may rescue a paid buyer before its own response. Preserve the
 * original caller/consent so loss or deed transfer cannot authorize a new unwind. */
export const itemMarketCancellations = pgTable('item_market_cancellations', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  requestKey: text('request_key').notNull(),
  listingId: uuid('listing_id').notNull().references(() => itemListings.id, { onDelete: 'restrict' }),
  itemId: text('item_id').notNull(),
  sourceBaseId: uuid('source_base_id').references(() => bases.id, { onDelete: 'restrict' }),
  priceLamports: bigint('price_lamports', { mode: 'bigint' }).notNull(),
  expectedStatus: text('expected_status').$type<'active' | 'reserved'>().notNull(),
  expectedReference: text('expected_reference'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  state: text('state').$type<'pending' | 'cancelled' | 'settled' | 'refused'>().notNull().default('pending'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  refusalCode: text('refusal_code'),
  settledReference: text('settled_reference'),
  settledTxSignature: text('settled_tx_signature'),
  settledBuyer: text('settled_buyer').references(() => players.wallet),
  settledBuyerBaseId: uuid('settled_buyer_base_id').references(() => bases.id, { onDelete: 'restrict' }),
}, (t) => [
  uniqueIndex('item_market_cancellation_key_uq').on(t.actorWallet, t.requestKey),
  index('item_market_cancellation_listing_idx').on(t.listingId),
  check('item_market_cancellation_consent_ck', sql`${t.priceLamports} > 0 AND (
    (${t.expectedStatus} = 'active' AND ${t.expectedReference} IS NULL)
    OR (${t.expectedStatus} = 'reserved' AND ${t.expectedReference} IS NOT NULL))`),
  check('item_market_cancellation_state_ck', sql`
    (${t.state} = 'pending' AND ${t.resolvedAt} IS NULL AND ${t.refusalCode} IS NULL AND ${t.settledReference} IS NULL AND ${t.settledTxSignature} IS NULL AND ${t.settledBuyer} IS NULL AND ${t.settledBuyerBaseId} IS NULL)
    OR (${t.state} = 'cancelled' AND ${t.resolvedAt} IS NOT NULL AND ${t.refusalCode} IS NULL AND ${t.settledReference} IS NULL AND ${t.settledTxSignature} IS NULL AND ${t.settledBuyer} IS NULL AND ${t.settledBuyerBaseId} IS NULL)
    OR (${t.state} = 'settled' AND ${t.resolvedAt} IS NOT NULL AND ${t.refusalCode} IS NULL AND ${t.settledReference} IS NOT NULL AND ${t.settledTxSignature} IS NOT NULL AND ${t.settledBuyer} IS NOT NULL AND (${t.sourceBaseId} IS NULL) = (${t.settledBuyerBaseId} IS NULL))
    OR (${t.state} = 'refused' AND ${t.resolvedAt} IS NOT NULL AND ${t.refusalCode} IS NOT NULL AND ${t.settledReference} IS NULL AND ${t.settledTxSignature} IS NULL AND ${t.settledBuyer} IS NULL AND ${t.settledBuyerBaseId} IS NULL)`),
]);

export const authNonces = pgTable('auth_nonces', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull(),
  nonce: text('nonce').notNull().unique(),
  /** Set by the server in JS (not defaultNow) so the signed message round-trips exactly. */
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  /** SCOPE of the challenge (owner 2026-07-29, Seeker link). Without this, a
   *  second challenge type sharing this table is a session-takeover primitive:
   *  /auth/verify picks "the latest unused nonce for this wallet" and rebuilds
   *  the SIGN-IN message from it, so a nonce issued for linking would mint a
   *  session for the Seeker wallet — and, conversely, a pending link nonce
   *  would 401 a legitimate concurrent sign-in. Both selects filter on it. */
  purpose: authNoncePurposeEnum('purpose').notNull().default('signin'),
  /** For 'seeker_link': the GAME account the signer is binding to. Part of the
   *  signed message, so a signature can't be replayed onto another account. */
  subject: text('subject'),
}, (t) => [index('auth_nonces_wallet_idx').on(t.wallet, t.expiresAt)]);

/** Issued JWT sessions (id = jti). Audit + future revocation; JWTs verify statelessly. */
export const sessions = pgTable('sessions', {
  scope: text('scope').notNull().default('full'),
  loginMfaAt: timestamp('login_mfa_at', { withTimezone: true }),
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  /** 'solana-mobile' | 'browser' as declared by the client at SIWS verify
   *  (D-103). Statistics only. */
  client: text('client'),
}, (t) => [
  index('sessions_wallet_idx').on(t.wallet),
  check('sessions_scope_ck', sql`${t.scope} IN ('full', 'login_pending')`),
]);

/**
 * Durable lost-authenticator recovery. The old encrypted TOTP secret stays on
 * `players` throughout the hold and is cleared only by a completed recovery;
 * expiry/cancellation therefore preserve the old factor by construction.
 *
 * `id` is supplied by the client before its wallet proof is requested. This is
 * deliberate: the recent-auth capability can then bind the exact recovery UUID
 * and action instead of authorizing an unspecified future recovery row.
 */
export const totpRecoveries = pgTable('totp_recoveries', {
  id: uuid('id').primaryKey(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  startedSessionId: uuid('started_session_id').notNull().references(() => sessions.id),
  completedSessionId: uuid('completed_session_id').references(() => sessions.id),
  status: totpRecoveryStatusEnum('status').notNull().default('email_pending'),
  /** Normalized verified-contact snapshot. Codes bind this exact recipient. */
  targetEmail: text('target_email').notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** Durable confirmation receipt: a lost HTTP response must replay the exact
   * cancellation/refund outcome rather than fabricate zeroes. */
  cancelledWithdrawalCount: integer('cancelled_withdrawal_count').notNull().default(0),
  inFlightWithdrawalCount: integer('in_flight_withdrawal_count').notNull().default(0),
  refundedKeep: bigint('refunded_keep', { mode: 'bigint' }).notNull().default(sql`0`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex('totp_recoveries_one_active_wallet_uq').on(t.playerWallet)
    .where(sql`status IN ('email_pending', 'holding')`),
  index('totp_recoveries_wallet_requested_idx').on(t.playerWallet, t.requestedAt),
  check('totp_recoveries_email_ck', sql`${t.targetEmail} = lower(${t.targetEmail}) AND length(${t.targetEmail}) BETWEEN 3 AND 254`),
  check('totp_recoveries_refund_nonnegative_ck', sql`
    ${t.cancelledWithdrawalCount} >= 0 AND ${t.inFlightWithdrawalCount} >= 0
    AND ${t.refundedKeep} >= 0
  `),
  check('totp_recoveries_timeline_ck', sql`
    (${t.status} = 'email_pending'
      AND ${t.confirmedAt} IS NULL AND ${t.readyAt} IS NULL
      AND ${t.expiresAt} > ${t.requestedAt}
      AND ${t.cancelledAt} IS NULL AND ${t.completedAt} IS NULL
      AND ${t.completedSessionId} IS NULL)
    OR (${t.status} = 'holding'
      AND ${t.confirmedAt} >= ${t.requestedAt} AND ${t.readyAt} > ${t.confirmedAt}
      AND ${t.expiresAt} > ${t.readyAt}
      AND ${t.cancelledAt} IS NULL AND ${t.completedAt} IS NULL
      AND ${t.completedSessionId} IS NULL)
    OR (${t.status} = 'cancelled'
      AND ${t.cancelledAt} >= ${t.requestedAt} AND ${t.completedAt} IS NULL
      AND ${t.completedSessionId} IS NULL)
    OR (${t.status} = 'completed'
      AND ${t.confirmedAt} IS NOT NULL AND ${t.readyAt} IS NOT NULL
      AND ${t.expiresAt} IS NOT NULL AND ${t.completedAt} >= ${t.readyAt}
      AND ${t.completedAt} < ${t.expiresAt} AND ${t.completedSessionId} IS NOT NULL
      AND ${t.cancelledAt} IS NULL)
    OR (${t.status} = 'expired'
      AND ${t.expiresAt} IS NOT NULL AND ${t.completedAt} IS NULL
      AND ((${t.confirmedAt} IS NULL AND ${t.readyAt} IS NULL)
        OR (${t.confirmedAt} IS NOT NULL AND ${t.readyAt} IS NOT NULL))
      AND ${t.cancelledAt} IS NULL AND ${t.completedSessionId} IS NULL)
  `),
]);

/**
 * Short-lived email 2FA codes (owner 2026-07-19). One row per issued code: the
 * 6-digit plaintext is emailed, and ONLY a keyed HMAC is stored. TTL'd +
 * single-use (consumedAt) + attempt-capped to resist brute
 * force. `purpose` separates an enrollment code from a per-withdrawal challenge
 * so a code minted for one can never authorize the other.
 */
export const emailOtps = pgTable('email_otps', {
  id: uuid('id').primaryKey().defaultRandom(),
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  purpose: twoFaPurposeEnum('purpose').notNull(),
  /** Versioned/key-id'd HMAC — never store the plaintext. */
  codeHash: text('code_hash').notNull(),
  /** Exact normalized enrollment recipient. NULL only on pre-0059 expired rows. */
  targetEmail: text('target_email'),
  /** Keyed digest of the exact action/request this code authorizes. */
  challengeContext: text('challenge_context'),
  /** Set only after the provider accepts delivery. Verification ignores rows
   * left reserved by a crash/provider failure. */
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('email_otps_wallet_purpose_idx').on(t.playerWallet, t.purpose, t.createdAt)]);

// ---------------------------------------------------------------------------
// Closed alpha — applications + invite codes (owner decisions 2026-08-05)
// ---------------------------------------------------------------------------

export const alphaApplicationStatusEnum = pgEnum('alpha_application_status', ['pending', 'approved', 'rejected']);
/** How a wallet got on the access list: invite-code redemption ('invite'),
 *  ops by hand ('manual'), a migration of an env-list entry ('env'), or a
 *  proven Seeker Genesis Token ('seeker' — owner 2026-08-08: holding a Seeker
 *  IS the invite; granted by the seeker_links claim, sticky like an invite). */
// 'referral' since M23 a16 (D-052): an alpha member's referral code admits
// their friend — Seeker owners can invite non-Seeker friends (owner
// 2026-08-15). Insert-once sticky, same as every other source.
export const alphaAccessSourceEnum = pgEnum('alpha_access_source', ['env', 'invite', 'manual', 'seeker', 'referral']);

/**
 * Closed-alpha access applications (landing form → admin review → invite code).
 *
 * The form collects EMAIL ONLY — no wallet. Deliberate: Privy social/email
 * players have no wallet before their first login, and asking for one upfront
 * hands airdrop farmers exactly the field they want. The wallet binds at
 * REDEMPTION instead (redeemed_wallet), whichever kind it turns out to be.
 *
 * `email` is stored LOWERCASED and unique, so a duplicate submit can't create
 * a second row or trigger a second email — and the route returns the identical
 * success body either way, so the endpoint is not an address-enumeration
 * oracle. `invite_code` is a 128-bit base32 one-time code minted at approval;
 * unique so redemption is an indexed point lookup.
 */
export const alphaApplications = pgTable('alpha_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  /** Optional self-reported identity/answers from the form — review context
   * only; nothing in the game ever reads these. */
  handle: text('handle'),
  socials: text('socials'),
  answers: jsonb('answers'),
  status: alphaApplicationStatusEnum('status').notNull().default('pending'),
  inviteCode: text('invite_code').unique(),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  /** Single-use anchor: the first (and only) wallet the code unlocked. */
  redeemedWallet: text('redeemed_wallet'),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  reviewerNote: text('reviewer_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // The admin queue: list-by-status, newest first.
  index('alpha_applications_status_idx').on(t.status, t.createdAt),
]);

/**
 * Owner-generated playtest invites that do not originate from an application.
 *
 * A batch is the idempotency and audit boundary: retrying a lost response with
 * the same wallet/key returns the same complete set, while a changed count is
 * refused. The 1..100 bound is duplicated in the route and here so a future
 * caller cannot bypass the owner's 2026-08-24 per-generation ceiling.
 */
export const alphaInviteBatches = pgTable('alpha_invite_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  idempotencyKey: uuid('idempotency_key').notNull(),
  createdByWallet: text('created_by_wallet').notNull(),
  requestedCount: smallint('requested_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('alpha_invite_batches_creator_idem_uq')
    .on(t.createdByWallet, t.idempotencyKey),
  index('alpha_invite_batches_created_idx').on(t.createdAt),
  check('alpha_invite_batches_count_ck', sql`${t.requestedCount} BETWEEN 1 AND 100`),
]);

/** One cryptographically-random, single-use code inside an admin batch. */
export const alphaInviteCodes = pgTable('alpha_invite_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => alphaInviteBatches.id),
  code: text('code').notNull().unique(),
  /** Stable generation order makes copy-all retries byte-identical. */
  ordinal: smallint('ordinal').notNull(),
  redeemedWallet: text('redeemed_wallet'),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('alpha_invite_codes_batch_ordinal_uq').on(t.batchId, t.ordinal),
  index('alpha_invite_codes_created_idx').on(t.createdAt),
  check('alpha_invite_codes_ordinal_ck', sql`${t.ordinal} BETWEEN 0 AND 99`),
  check('alpha_invite_codes_shape_ck', sql`${t.code} ~ '^[A-Z2-7]{26}$'`),
  check(
    'alpha_invite_codes_redemption_pair_ck',
    sql`(${t.redeemedWallet} IS NULL) = (${t.redeemedAt} IS NULL)`,
  ),
]);

/**
 * The DB half of the closed-alpha gate: assertAlphaAccess (auth/session.ts)
 * allows env ALPHA_WALLETS ∪ ADMIN_WALLETS ∪ THIS TABLE, so redeeming an invite
 * is an INSERT here — and revocation is a DELETE, taking effect on the next
 * authed request. Wallet is the PK, so the per-request check is an indexed
 * point read, never a scan. No FK to players: ops may allowlist a wallet before
 * it has ever signed in (the authNonces precedent).
 */
export const alphaAccess = pgTable('alpha_access', {
  wallet: text('wallet').primaryKey(),
  source: alphaAccessSourceEnum('source').notNull(),
  applicationId: uuid('application_id').references(() => alphaApplications.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Stable-base playable ownership + live-raid foundation (owner 2026-08-12)
// ---------------------------------------------------------------------------

/** One deterministic legacy-wallet → primary-base cutover row. The migration
 * copies non-ledger gameplay state immediately, but deliberately DOES NOT edit
 * an account balance: `ledgerStatus='pending'` is a fail-loud activation gate
 * until a service posts player_shards → base_shards through postTransaction. */
export const baseEconomyBackfills = pgTable('base_economy_backfills', {
  legacyWallet: text('legacy_wallet').primaryKey().references(() => players.wallet),
  primaryBaseId: uuid('primary_base_id').notNull().references(() => bases.id),
  sourceShardAccountId: uuid('source_shard_account_id').references(() => accounts.id),
  destinationShardAccountId: uuid('destination_shard_account_id').notNull().references(() => accounts.id),
  legacyShardBalance: bigint('legacy_shard_balance', { mode: 'bigint' }).notNull().default(sql`0`),
  sourceForgeEscrowAccountId: uuid('source_forge_escrow_account_id').notNull().references(() => accounts.id),
  destinationForgeEscrowAccountId: uuid('destination_forge_escrow_account_id').notNull().references(() => accounts.id),
  legacyForgeEscrowShards: bigint('legacy_forge_escrow_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  ledgerStatus: text('ledger_status').notNull().default('pending'),
  ledgerTransferTxnId: uuid('ledger_transfer_txn_id').references(() => ledgerTransactions.id).unique(),
  forgeLedgerTransferTxnId: uuid('forge_ledger_transfer_txn_id').references(() => ledgerTransactions.id).unique(),
  /** A physical Mine receives this buffer during SQL backfill when one exists.
   * Otherwise it remains here until the first Mine is completed. */
  legacyMineBufferPending: bigint('legacy_mine_buffer_pending', { mode: 'bigint' }).notNull().default(sql`0`),
  mineBackfilledAt: timestamp('mine_backfilled_at', { withTimezone: true }),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('base_economy_backfills_primary_base_uq').on(t.primaryBaseId),
  check('base_economy_backfills_shards_nonnegative_ck', sql`
    ${t.legacyShardBalance} >= 0 AND ${t.legacyForgeEscrowShards} >= 0 AND ${t.legacyMineBufferPending} >= 0
  `),
  check('base_economy_backfills_sources_ck', sql`
    ${t.legacyShardBalance} = 0 OR ${t.sourceShardAccountId} IS NOT NULL
  `),
  check('base_economy_backfills_status_ck', sql`${t.ledgerStatus} IN ('pending', 'posting', 'complete', 'failed')`),
  check('base_economy_backfills_completion_ck', sql`
    (${t.ledgerStatus} = 'complete' AND ${t.completedAt} IS NOT NULL
      AND ((${t.legacyShardBalance} = 0 AND ${t.ledgerTransferTxnId} IS NULL)
        OR (${t.legacyShardBalance} > 0 AND ${t.ledgerTransferTxnId} IS NOT NULL))
      AND ((${t.legacyForgeEscrowShards} = 0 AND ${t.forgeLedgerTransferTxnId} IS NULL)
        OR (${t.legacyForgeEscrowShards} > 0 AND ${t.forgeLedgerTransferTxnId} IS NOT NULL)))
    OR (${t.ledgerStatus} <> 'complete' AND ${t.completedAt} IS NULL)
  `),
]);

/** One-way activation latch for the deed-owned economy. `fenced` means the
 * schema is installed but legacy mode may still serve; `ready` is irreversible
 * and makes the database reject writes from pre-cutover binaries. */
export const deedEconomyCutoverState = pgTable('deed_economy_cutover_state', {
  id: boolean('id').primaryKey().default(true),
  phase: text('phase').notNull().default('fenced'),
  fencedAt: timestamp('fenced_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
}, (t) => [
  check('deed_economy_cutover_state_singleton_ck', sql`${t.id} = true`),
  check('deed_economy_cutover_state_phase_ck', sql`${t.phase} IN ('fenced', 'ready')`),
  check('deed_economy_cutover_state_ready_ck', sql`
    (${t.phase} = 'fenced' AND ${t.readyAt} IS NULL)
    OR (${t.phase} = 'ready' AND ${t.readyAt} IS NOT NULL)
  `),
]);

/** Wallet progression that affects a playable kingdom now follows the deed. */
export const baseProfiles = pgTable('base_profiles', {
  baseId: uuid('base_id').primaryKey().references(() => bases.id, { onDelete: 'cascade' }),
  trophies: integer('trophies').notNull().default(0),
  league: leagueEnum('league').notNull().default('bronze'),
  weekStartTrophies: integer('week_start_trophies').notNull().default(0),
  purchasedEnergy: integer('purchased_energy').notNull().default(0),
  /** DEAD (M23 a8 skin removal): all-NULL since 0077; kept, no schema migration. */
  keepSkin: text('keep_skin'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('base_profiles_trophies_nonnegative_ck', sql`${t.trophies} >= 0`),
  check('base_profiles_energy_nonnegative_ck', sql`${t.purchasedEnergy} >= 0`),
]);

/** Frozen weekly league receipt. The rollout rejects every legacy KEEP row;
 * receipts freeze only deed-owned SHARDS/items. Reward columns never change
 * after insert; paidAt is the per-base atomic settlement marker. */
export const baseLeagueEntitlements = pgTable('base_league_entitlements', {
  week: date('week', { mode: 'string' }).notNull(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  tier: leagueEnum('tier').notNull(),
  trophies: integer('trophies').notNull(),
  keepAmount: bigint('keep_amount', { mode: 'bigint' }).notNull(),
  /** Keep level used to price the deterministic cache. */
  keepLevelGranted: integer('keep_level_granted').notNull().default(1),
  /** Exact SHARDS frozen for this base (zero means participation/wallet gate failed). */
  cacheShardsGranted: bigint('cache_shards_granted', { mode: 'bigint' }).notNull().default(sql`0`),
  /** Exact deterministic consumables frozen alongside the cache. */
  itemsGranted: jsonb('items_granted').$type<Array<{
    itemId: 'keg_of_haste' | 'finishers_seal'; qty: number;
  }>>().notNull().default([]),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.week, t.baseId] }),
  index('base_league_entitlements_pending_idx').on(t.paidAt, t.lastAttemptAt, t.week),
  check('base_league_entitlements_trophies_nonnegative_ck', sql`${t.trophies} >= 0`),
  check('base_league_entitlements_keep_nonnegative_ck', sql`${t.keepAmount} >= 0`),
  check('base_league_entitlements_keep_zero_ck', sql`${t.keepAmount} = 0`),
  check('base_league_entitlements_keep_level_ck', sql`${t.keepLevelGranted} BETWEEN 1 AND 20`),
  check('base_league_entitlements_cache_nonnegative_ck', sql`${t.cacheShardsGranted} >= 0`),
  check('base_league_entitlements_items_array_ck', sql`jsonb_typeof(${t.itemsGranted}) = 'array'`),
]);

/** Durable feature boundary. The first paid week is computed once from the
 * actual enable instant, so a mid-week flag flip can never pay a partial week. */
export const leagueRewardActivations = pgTable('league_reward_activations', {
  singleton: integer('singleton').primaryKey().default(1),
  enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull(),
  configuredStartWeek: date('configured_start_week', { mode: 'string' }).notNull(),
  firstCompleteWeek: date('first_complete_week', { mode: 'string' }).notNull(),
}, (t) => [
  check('league_reward_activations_singleton_ck', sql`${t.singleton} = 1`),
  check(
    'league_reward_activations_complete_after_config_ck',
    sql`${t.firstCompleteWeek} >= ${t.configuredStartWeek}`,
  ),
]);

/** One immutable marker proves the whole Monday-close transaction committed.
 * Settlement refuses to infer a missing marker from mutable live state. */
export const leagueWeekClosures = pgTable('league_week_closures', {
  week: date('week', { mode: 'string' }).primaryKey(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull().unique(),
  effectiveStartWeek: date('effective_start_week', { mode: 'string' }).notNull(),
  /** Flag state at this boundary opens (or fences) the following earning week. */
  featureEnabledAtClose: boolean('feature_enabled_at_close').notNull(),
  rewardsEnabled: boolean('rewards_enabled').notNull(),
  /** Non-null only when an enabled close was terminally denied before payout. */
  failureReason: text('failure_reason'),
  participantCount: integer('participant_count').notNull(),
  excludedCount: integer('excluded_count').notNull().default(0),
  rewardedCount: integer('rewarded_count').notNull(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('league_week_closures_participant_count_ck', sql`${t.participantCount} >= 0`),
  check('league_week_closures_excluded_count_ck', sql`${t.excludedCount} >= 0`),
  check('league_week_closures_failure_reason_ck', sql`
    ${t.failureReason} IS NULL OR (
      ${t.failureReason} = 'authority_snapshot_unavailable' AND ${t.rewardsEnabled} = false
    )
  `),
  check('league_week_closures_rewarded_count_ck', sql`
    ${t.rewardedCount} >= 0 AND ${t.rewardedCount} <= ${t.participantCount}
  `),
]);

/** A bad legacy row or unverifiable deed is denied a reward without denying the
 * whole week. These immutable rows are the operator-visible reason. */
export const leagueWeekBaseExclusions = pgTable('league_week_base_exclusions', {
  week: date('week', { mode: 'string' }).notNull(),
  baseId: uuid('base_id').notNull(),
  reason: text('reason').notNull(),
  detail: jsonb('detail').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.week, t.baseId] }),
  foreignKey({
    columns: [t.week], foreignColumns: [leagueWeekClosures.week],
    name: 'league_week_base_exclusions_week_fk',
  }).onDelete('restrict'),
]);

/** Exact finalized-deed/trophy inputs frozen at the earning-window close. */
export const leagueWeekBaseSnapshots = pgTable('league_week_base_snapshots', {
  week: date('week', { mode: 'string' }).notNull(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  ownerWalletAtClose: text('owner_wallet_at_close').notNull().references(() => players.wallet),
  deedAssetId: text('deed_asset_id').notNull(),
  /** Null for the close worker's direct finalized batch read. */
  deedObservationId: bigint('deed_observation_id', { mode: 'bigint' }),
  deedObservationSlot: bigint('deed_observation_slot', { mode: 'bigint' }).notNull(),
  deedObservationHash: text('deed_observation_hash').notNull(),
  deedObservedAt: timestamp('deed_observed_at', { withTimezone: true }).notNull(),
  trophies: integer('trophies').notNull(),
  keepLevel: integer('keep_level').notNull(),
  ratedAttacks: integer('rated_attacks').notNull(),
  tier: leagueEnum('tier').notNull(),
  rewardEligible: boolean('reward_eligible').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.week, t.baseId] }),
  foreignKey({
    columns: [t.week],
    foreignColumns: [leagueWeekClosures.week],
    name: 'league_week_base_snapshots_week_fk',
  }).onDelete('restrict'),
  index('league_week_base_snapshots_owner_idx').on(t.week, t.ownerWalletAtClose),
  check('league_week_base_snapshots_trophies_ck', sql`${t.trophies} >= 0`),
  check('league_week_base_snapshots_keep_level_ck', sql`${t.keepLevel} BETWEEN 1 AND 20`),
  check('league_week_base_snapshots_rated_attacks_ck', sql`${t.ratedAttacks} >= 0`),
  check('league_week_base_snapshots_observation_slot_ck', sql`${t.deedObservationSlot} >= 0`),
]);

/** Per-item idempotency journal. Its composite key remains authoritative even
 * if an operator later repairs a receipt marker by hand. */
export const leagueItemGrants = pgTable('league_item_grants', {
  week: date('week', { mode: 'string' }).notNull(),
  baseId: uuid('base_id').notNull(),
  itemId: text('item_id').$type<'keg_of_haste' | 'finishers_seal'>().notNull(),
  qty: integer('qty').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.week, t.baseId, t.itemId] }),
  foreignKey({
    columns: [t.week, t.baseId],
    foreignColumns: [baseLeagueEntitlements.week, baseLeagueEntitlements.baseId],
    name: 'league_item_grants_receipt_fk',
  }).onDelete('restrict'),
  check('league_item_grants_qty_ck', sql`${t.qty} > 0`),
  check('league_item_grants_item_ck', sql`${t.itemId} IN ('keg_of_haste', 'finishers_seal')`),
]);

export const baseArmy = pgTable('base_army', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  troop: troopTypeEnum('troop').notNull(),
  count: integer('count').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.troop] }),
  check('base_army_count_nonnegative_ck', sql`${t.count} >= 0`),
]);

export const baseTrainingQueue = pgTable('base_training_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  troop: troopTypeEnum('troop').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishesAt: timestamp('finishes_at', { withTimezone: true }).notNull(),
  /** V1 promises remain fixed; V2 uses scheduled (possibly future) startedAt. */
  scheduleVersion: integer('schedule_version').notNull().default(1),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  legacyQueueId: uuid('legacy_queue_id').unique(),
  economyVersion: integer('economy_version').notNull().default(1),
  paidShardCost: bigint('paid_shard_cost', { mode: 'bigint' }),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelIdempotencyKey: text('cancel_idempotency_key'),
  questCreditedAt: timestamp('quest_credited_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  check('base_training_queue_schedule_ck', sql`${t.scheduleVersion} IN (1, 2) AND (${t.scheduleVersion} = 1 OR ${t.finishesAt} > ${t.startedAt})`),
  index('base_training_queue_due_idx').on(t.baseId, t.finishesAt),
  index('base_training_queue_notification_due_idx').on(t.finishesAt)
    .where(sql`${t.cancelledAt} IS NULL`),
  uniqueIndex('base_training_queue_base_cancel_key_uq').on(t.baseId, t.cancelIdempotencyKey),
  check('base_training_queue_economy_version_ck', sql`${t.economyVersion} IN (1, 2)`),
  check('base_training_queue_state_ck', sql`
    (${t.economyVersion} = 1 AND ${t.paidShardCost} IS NULL AND ${t.debitLedgerTxnId} IS NULL
      AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
      AND ${t.cancelIdempotencyKey} IS NULL AND ${t.questCreditedAt} IS NOT NULL)
    OR (${t.economyVersion} = 2 AND ${t.paidShardCost} > 0 AND ${t.debitLedgerTxnId} IS NOT NULL AND (
      (${t.completedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
        AND ${t.cancelIdempotencyKey} IS NULL AND ${t.questCreditedAt} IS NULL)
      OR (${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL
        AND ${t.cancelIdempotencyKey} IS NULL)
      OR (${t.completedAt} IS NOT NULL AND ${t.cancelledAt} IS NOT NULL AND ${t.refundLedgerTxnId} IS NOT NULL
        AND ${t.refundLedgerTxnId} <> ${t.debitLedgerTxnId}
        AND ${t.cancelIdempotencyKey} IS NOT NULL AND ${t.questCreditedAt} IS NULL)
    ))
  `),
]);

export const baseTroopResearch = pgTable('base_troop_research', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  troop: troopTypeEnum('troop').notNull(),
  level: integer('level').notNull().default(1),
  researchingToLevel: integer('researching_to_level'),
  finishesAt: timestamp('finishes_at', { withTimezone: true }),
  /** Same current-episode refund receipt as troop_research, deed-keyed. */
  paidShardCost: bigint('paid_shard_cost', { mode: 'bigint' }),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  refundLedgerTxnId: uuid('refund_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelIdempotencyKey: text('cancel_idempotency_key'),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.troop] }),
  check('base_troop_research_level_ck', sql`${t.level} BETWEEN 1 AND 20`),
  uniqueIndex('base_troop_research_base_cancel_key_uq').on(t.baseId, t.cancelIdempotencyKey),
  check('base_troop_research_cancel_state_ck', sql`
    (${t.paidShardCost} IS NULL AND ${t.debitLedgerTxnId} IS NULL
      AND ${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
    OR (${t.paidShardCost} > 0 AND ${t.debitLedgerTxnId} IS NOT NULL AND (
      (${t.cancelledAt} IS NULL AND ${t.refundLedgerTxnId} IS NULL AND ${t.cancelIdempotencyKey} IS NULL)
      OR (${t.cancelledAt} IS NOT NULL AND ${t.researchingToLevel} IS NULL AND ${t.refundLedgerTxnId} IS NOT NULL
        AND ${t.refundLedgerTxnId} <> ${t.debitLedgerTxnId} AND ${t.cancelIdempotencyKey} IS NOT NULL)
    ))
  `),
]);

/** Recruitment remains truthful to the deed-owned altar building. This table
 * owns level/recovery; no separate recruited boolean can drift from the altar. */
export const baseHeroProgress = pgTable('base_hero_progress', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  hero: heroKeyEnum('hero').notNull(),
  level: integer('level').notNull().default(1),
  recoveryUntil: timestamp('recovery_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.hero] }),
  check('base_hero_progress_level_ck', sql`${t.level} >= 1`),
]);

export const baseItems = pgTable('base_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  qty: integer('qty').notNull().default(1),
  seenAt: timestamp('seen_at', { withTimezone: true }),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  /** Provenance (E2-GEMS-CONTRACT §3, E2-WORKSHOP-CONTRACT §2): ingots enter
   * as 'craft'; shop_gems rows are account-bound. Pre-0134 rows are 'legacy'. */
  acquiredVia: text('acquired_via').notNull().default('legacy'),
}, (t) => [
  unique('base_items_base_item_uq').on(t.baseId, t.itemId),
  check('base_items_qty_nonnegative_ck', sql`${t.qty} >= 0`),
  check('base_items_acquired_via_ck', sql`${t.acquiredVia} IN ('legacy', 'shop_keep', 'shop_gems', 'drop', 'craft', 'market', 'grant')`),
]);

/** Workshop refining jobs (E2-WORKSHOP-CONTRACT §3). SHARDS are spent at start
 * and the debit id is stored on the row; `collect` is the only completion path
 * (lazy, no worker), so readiness is `ready_at <= now` on read. Base-scoped:
 * the job and its ingots follow the deed. */
export const workshopJobs = pgTable('workshop_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  startedByWallet: text('started_by_wallet').notNull().references(() => players.wallet),
  workshopLevelAtStart: integer('workshop_level_at_start').notNull(),
  // NULL preserves historical uncertainty; it counts against both day scopes.
  capacityScopeAtStart: text('capacity_scope_at_start').$type<'free_wallet' | 'deed_base'>(),
  recipeVersion: integer('recipe_version').notNull(),
  ingots: integer('ingots').notNull(),
  shardsCharged: bigint('shards_charged', { mode: 'bigint' }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  collectedByWallet: text('collected_by_wallet'),
  debitLedgerTxnId: uuid('debit_ledger_txn_id').notNull().references(() => ledgerTransactions.id).unique(),
  startIdempotencyKey: text('start_idempotency_key').notNull(),
  collectIdempotencyKey: text('collect_idempotency_key'),
}, (t) => [
  unique('workshop_jobs_start_key_uq').on(t.startedByWallet, t.startIdempotencyKey),
  unique('workshop_jobs_collect_key_uq').on(t.collectedByWallet, t.collectIdempotencyKey),
  index('workshop_jobs_base_collected_idx').on(t.baseId, t.collectedAt),
  index('workshop_jobs_base_started_idx').on(t.baseId, t.startedAt),
  index('workshop_jobs_wallet_started_idx').on(t.startedByWallet, t.startedAt),
  check('workshop_jobs_capacity_scope_ck', sql`${t.capacityScopeAtStart} IN ('free_wallet', 'deed_base')`),
  check('workshop_jobs_ingots_ck', sql`${t.ingots} > 0`),
  // 10000 is PHASE_E_POLICY.forge.shardsPerIngot (D-149 lock). A CHECK cannot
  // import the constant; migrations-fresh-db.test.ts pins this literal to it.
  check('workshop_jobs_shards_charged_ck', sql`${t.shardsCharged} = ${t.ingots} * 10000`),
]);

export const baseHeroLoadouts = pgTable('base_hero_loadouts', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  hero: heroKeyEnum('hero').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.hero] }),
  check('base_hero_loadouts_version_ck', sql`${t.version} >= 0`),
]);

export const baseHeroEquipment = pgTable('base_hero_equipment', {
  baseId: uuid('base_id').notNull(),
  hero: heroKeyEnum('hero').notNull(),
  slot: gearSlotEnum('slot').notNull(),
  itemId: text('item_id').notNull(),
  equippedAt: timestamp('equipped_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.hero, t.slot] }),
  foreignKey({
    columns: [t.baseId, t.hero],
    foreignColumns: [baseHeroLoadouts.baseId, baseHeroLoadouts.hero],
    name: 'base_hero_equipment_loadout_fk',
  }).onDelete('cascade'),
  foreignKey({
    columns: [t.baseId, t.itemId],
    foreignColumns: [baseItems.baseId, baseItems.itemId],
    name: 'base_hero_equipment_item_fk',
  }).onDelete('cascade'),
  index('base_hero_equipment_item_idx').on(t.baseId, t.itemId),
]);

/** ClaimedAt follows the deed, so selling a kingdom never makes its already
 * claimed quest reward claimable by the buyer. */
export const baseQuestProgress = pgTable('base_quest_progress', {
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  questId: uuid('quest_id').notNull().references(() => quests.id),
  progress: integer('progress').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
}, (t) => [
  unique('base_quest_progress_quest_base_uq').on(t.questId, t.baseId),
  index('base_quest_progress_base_idx').on(t.baseId),
  check('base_quest_progress_nonnegative_ck', sql`${t.progress} >= 0`),
]);

export const baseStreaks = pgTable('base_streaks', {
  baseId: uuid('base_id').primaryKey().references(() => bases.id, { onDelete: 'cascade' }),
  currentDays: integer('current_days').notNull().default(0),
  lastActiveDate: date('last_active_date'),
  everCompletedWeek1: boolean('ever_completed_week1').notNull().default(false),
  cacheClaimedDay: date('cache_claimed_day'),
}, (t) => [check('base_streaks_days_nonnegative_ck', sql`${t.currentDays} >= 0`)]);

export const baseDailyActivity = pgTable('base_daily_activity', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  raids: integer('raids').notNull().default(0),
  builds: integer('builds').notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.day] }),
  check('base_daily_activity_counts_ck', sql`${t.raids} >= 0 AND ${t.builds} >= 0`),
]);

export const baseCampaignProgress = pgTable('base_campaign_progress', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  stage: integer('stage').notNull(),
  bestStars: integer('best_stars').notNull().default(0),
  firstThreeStarAt: timestamp('first_three_star_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.stage] }),
  check('base_campaign_progress_stage_ck', sql`${t.stage} >= 1`),
  check('base_campaign_progress_stars_ck', sql`${t.bestStars} BETWEEN 0 AND 3`),
]);

/** One accrual buffer per physical Mine. The building FK prevents a deleted
 * Mine retaining loot; services additionally assert building.type='mine'. */
export const mineAccrualStates = pgTable('mine_accrual_states', {
  mineBuildingId: uuid('mine_building_id').primaryKey().references(() => buildings.id, { onDelete: 'cascade' }),
  accruedShards: bigint('accrued_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  lastAccrualAt: timestamp('last_accrual_at', { withTimezone: true }).notNull().defaultNow(),
  /** NULL keeps historical lazy behavior; a real Phase E settlement preserves
   * an earned numerator over MINE_DAY_MS without repricing it later. */
  productionRemainder: bigint('production_remainder', { mode: 'bigint' }),
  version: integer('version').notNull().default(0),
  /** A cycle advances only when SHARDS permanently leave this physical Mine.
   * Temporary raid reservation/restoration and quota re-anchors retain it. */
  fullNotificationCycle: integer('full_notification_cycle').notNull().default(0),
  /** Exact projected fill boundary under the rate anchored by the last settle.
   * NULL means this cycle is already terminal/suppressed or cannot produce. */
  fullNotificationCheckAt: timestamp('full_notification_check_at', { withTimezone: true }),
  /** One-shot M34 upgrade latch. Only rows predating 0101 are true; a bounded
   * worker pass classifies their real buffer without replaying old fullness. */
  fullNotificationBootstrapPending: boolean('full_notification_bootstrap_pending').notNull().default(false),
}, (t) => [
  check('mine_accrual_states_shards_nonnegative_ck', sql`${t.accruedShards} >= 0`),
  check('mine_accrual_states_version_nonnegative_ck', sql`${t.version} >= 0`),
  check('mine_accrual_states_full_notification_cycle_nonnegative_ck', sql`${t.fullNotificationCycle} >= 0`),
  index('mine_accrual_states_full_notification_due_idx').on(t.fullNotificationCheckAt)
    .where(sql`${t.fullNotificationCheckAt} IS NOT NULL`),
  index('mine_accrual_states_full_notification_bootstrap_idx').on(t.mineBuildingId)
    .where(sql`${t.fullNotificationBootstrapPending} = true`),
]);

/** A deed/day position may receive any number of contribution transactions.
 * Raid theft increases raidDebitedShards, reducing both payout stake and used
 * daily cap; the base_forge_escrow account must reconcile to all open net rows. */
export const baseForgePositions = pgTable('base_forge_positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  day: text('day').notNull(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  contributedShards: bigint('contributed_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  raidDebitedShards: bigint('raid_debited_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  countedShards: bigint('counted_shards', { mode: 'bigint' }),
  shardsRefunded: bigint('shards_refunded', { mode: 'bigint' }),
  keepPaid: bigint('keep_paid', { mode: 'bigint' }),
  /** Audit-only owner at settlement. Claim authority follows the base's current
   * owner so an unclaimed payout transfers with its deed. */
  settlementOwnerWallet: text('settlement_owner_wallet').references(() => players.wallet),
  itemsDropped: jsonb('items_dropped').notNull().default([]),
  /** Both settlement legs are named so a row can never say "settled" without
   * auditable custody. A zero payout legitimately has no KEEP escrow posting. */
  shardSettlementTxnId: uuid('shard_settlement_txn_id').references(() => ledgerTransactions.id).unique(),
  keepEscrowTxnId: uuid('keep_escrow_txn_id').references(() => ledgerTransactions.id).unique(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  /** Claim ownership is resolved from the stable base at claim time. These
   * columns record custody completion, not a wallet baked into the position. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  claimTxnId: uuid('claim_txn_id').references(() => ledgerTransactions.id).unique(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  expireTxnId: uuid('expire_txn_id').references(() => ledgerTransactions.id).unique(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('base_forge_positions_day_base_uq').on(t.day, t.baseId),
  index('base_forge_positions_open_idx').on(t.baseId, t.day),
  check('base_forge_positions_amounts_ck', sql`
    ${t.contributedShards} >= 0
    AND ${t.raidDebitedShards} >= 0
    AND ${t.raidDebitedShards} <= ${t.contributedShards}
    AND (${t.countedShards} IS NULL OR ${t.countedShards} >= 0)
    AND (${t.shardsRefunded} IS NULL OR ${t.shardsRefunded} >= 0)
    AND (${t.keepPaid} IS NULL OR ${t.keepPaid} >= 0)
    AND (${t.countedShards} IS NULL OR ${t.countedShards} <= ${t.contributedShards} - ${t.raidDebitedShards})
  `),
  check('base_forge_positions_custody_ck', sql`
    (${t.settledAt} IS NULL
      AND ${t.countedShards} IS NULL AND ${t.shardsRefunded} IS NULL AND ${t.keepPaid} IS NULL
      AND ${t.settlementOwnerWallet} IS NULL
      AND ${t.shardSettlementTxnId} IS NULL AND ${t.keepEscrowTxnId} IS NULL
      AND ${t.claimedAt} IS NULL AND ${t.claimTxnId} IS NULL
      AND ${t.expiredAt} IS NULL AND ${t.expireTxnId} IS NULL)
    OR
    (${t.settledAt} IS NOT NULL
      AND ${t.countedShards} IS NOT NULL AND ${t.shardsRefunded} IS NOT NULL AND ${t.keepPaid} IS NOT NULL
      AND ${t.settlementOwnerWallet} IS NOT NULL
      AND ((${t.countedShards} = 0 AND ${t.shardSettlementTxnId} IS NULL)
        OR (${t.countedShards} > 0 AND ${t.shardSettlementTxnId} IS NOT NULL))
      AND ((${t.keepPaid} = 0 AND ${t.keepEscrowTxnId} IS NULL
          AND ${t.claimedAt} IS NULL AND ${t.claimTxnId} IS NULL
          AND ${t.expiredAt} IS NULL AND ${t.expireTxnId} IS NULL)
        OR (${t.keepPaid} > 0 AND ${t.keepEscrowTxnId} IS NOT NULL
          AND ((${t.claimedAt} IS NULL AND ${t.claimTxnId} IS NULL
              AND ${t.expiredAt} IS NULL AND ${t.expireTxnId} IS NULL)
            OR (${t.claimedAt} IS NOT NULL AND ${t.claimTxnId} IS NOT NULL
              AND ${t.expiredAt} IS NULL AND ${t.expireTxnId} IS NULL)
            OR (${t.claimedAt} IS NULL AND ${t.claimTxnId} IS NULL
              AND ${t.expiredAt} IS NOT NULL AND ${t.expireTxnId} IS NOT NULL)))))
  `),
]);

/** One row structurally prevents concurrent raids against the same deed. A
 * stale lock is never deleted merely by time: recovery must release the linked
 * private reservation in the same transaction. */
export const baseRaidLocks = pgTable('base_raid_locks', {
  baseId: uuid('base_id').primaryKey().references(() => bases.id, { onDelete: 'cascade' }),
  raidId: uuid('raid_id').notNull().references(() => raids.id, { onDelete: 'cascade' }).unique(),
  token: uuid('token').notNull().defaultRandom().unique(),
  state: baseRaidLockStateEnum('state').notNull().default('reserved'),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('base_raid_locks_expiry_idx').on(t.expiresAt)]);

// ---------------------------------------------------------------------------
// M33 Web Push notifications (D-101). Subscriptions are the browser's push
// endpoints per wallet; `push_events` is the at-most-once ledger the worker
// sweep claims with INSERT … ON CONFLICT DO NOTHING RETURNING — the (kind,
// ref_id) primary key IS the idempotency lock, so two workers never push twice.
// ---------------------------------------------------------------------------
export const pushSubscriptions = pgTable('push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  /** Push-service URL; the browser's identity for one (device, profile, SW). */
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Consent epoch for this live association. Boot refreshes preserve it;
   * revival after opt-out resets it so OFF-period events cannot backfill. */
  enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Consecutive delivery failures; reset on success, disables at the cap. */
  failures: integer('failures').notNull().default(0),
  /** Retired: unsubscribed, replaced, evicted, 404/410 from the push service,
   * or too many failures. Never deleted so a stale endpoint stays known. */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  index('push_subscriptions_live_wallet_idx').on(t.wallet, t.enabledAt).where(sql`${t.disabledAt} IS NULL`),
  check('push_subscriptions_failures_nonnegative_ck', sql`${t.failures} >= 0`),
]);

/** D-134 FCM consent; token ownership never transfers, including retired rows. */
export const nativePushSubscriptions = pgTable('native_push_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  token: text('token').notNull().unique(),
  bindingId: uuid('binding_id').notNull(),
  packageName: text('package_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  failures: integer('failures').notNull().default(0),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [
  index('native_push_subscriptions_live_wallet_idx').on(t.wallet, t.enabledAt).where(sql`${t.disabledAt} IS NULL`),
  check('native_push_subscriptions_failures_ck', sql`${t.failures} >= 0`),
  check('native_push_subscriptions_token_ck', sql`length(${t.token}) BETWEEN 1 AND 2048 AND ${t.token} ~ '^[!-~]+$'`),
  check('native_push_subscriptions_package_ck', sql`${t.packageName} IN ('gg.pixelkingdomwars.twa', 'gg.pixelkingdomwars.twa.debug')`),
]);

/** A consent UUID is never revived after explicit opt-out/logout. Kept apart
 * from token rows so DELETE-before-POST and later token/binding changes are safe. */
export const nativePushRevocations = pgTable('native_push_revocations', {
  wallet: text('wallet').notNull().references(() => players.wallet),
  bindingId: uuid('binding_id').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.wallet, t.bindingId] })]);

export const pushEvents = pgTable('push_events', {
  kind: text('kind').notNull(),
  /** Source row id (raid id, builder job id, `<table>:<id>` for training, mail id). */
  refId: text('ref_id').notNull(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** One logical push shared by every source row collapsed into its batch.
   * Counting this UUID (not sent_at, which is identical for a whole sweep)
   * enforces the rolling wallet cap without charging once per source row. */
  deliveryId: uuid('delivery_id'),
  /** `sent`, `failed`, `capped`, or `suppressed` (ineligible history/consent). */
  outcome: text('outcome'),
}, (t) => [
  primaryKey({ columns: [t.kind, t.refId] }),
  index('push_events_wallet_idx').on(t.wallet, t.createdAt),
  index('push_events_wallet_sent_idx').on(t.wallet, t.sentAt)
    .where(sql`${t.sentAt} IS NOT NULL`),
  check('push_events_kind_ck', sql`${t.kind} IN ('raided', 'mine_full', 'build', 'training', 'mail')`),
  check('push_events_outcome_ck', sql`
    (${t.outcome} IS NULL AND ${t.sentAt} IS NULL AND ${t.deliveryId} IS NULL)
    OR (${t.outcome} = 'sent' AND ${t.sentAt} IS NOT NULL AND ${t.deliveryId} IS NOT NULL)
    OR (${t.outcome} IN ('failed', 'capped', 'suppressed') AND ${t.sentAt} IS NULL AND ${t.deliveryId} IS NULL)
  `),
]);

/** Accepted commands are append-only and sequenced by the server. This is the
 * authoritative live stream and reconnect cursor; client retries dedupe by
 * (raid, clientCommandId), never by arrival timing. */
export const raidCommands = pgTable('raid_commands', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  raidId: uuid('raid_id').notNull().references(() => raids.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  clientCommandId: text('client_command_id').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  serverOffsetMs: integer('server_offset_ms').notNull(),
  payloadHash: text('payload_hash').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('raid_commands_raid_sequence_uq').on(t.raidId, t.sequence),
  unique('raid_commands_raid_client_uq').on(t.raidId, t.clientCommandId),
  index('raid_commands_reconnect_idx').on(t.raidId, t.sequence),
  check('raid_commands_sequence_ck', sql`${t.sequence} >= 0 AND ${t.serverOffsetMs} >= 0`),
]);

/** One-to-one live clock/cursor. `raids.status='pending_orders'` remains the
 * rolling-deploy umbrella for both pre-start reservation and live command
 * collection; base_raid_locks.state distinguishes reserved from live. Once the
 * stream closes, the existing resolving→resolved state machine owns outcome. */
export const raidLiveStates = pgTable('raid_live_states', {
  raidId: uuid('raid_id').primaryKey().references(() => raids.id, { onDelete: 'cascade' }),
  /** D-099: 'live' is the stable PvP command stream (defender lock, server
   * clock). 'batch' journals a PvE/campaign/legacy raid's client-stamped
   * orders so the worker can finish it without the client; it holds no lock
   * and keeps the ordinary batch expiry until its first order arrives. */
  mode: text('mode').notNull().default('live'),
  commandProtocolVersion: integer('command_protocol_version').notNull(),
  lastSequence: integer('last_sequence').notNull().default(-1),
  /** V2 clock state is an integer piecewise anchor. Revision/rate defaults are
   * compatible with legacy V1 rows; anchors stay null until a V2 battle starts. */
  clockRevision: integer('clock_revision').notNull().default(0),
  clockRate: integer('clock_rate').notNull().default(1),
  clockAnchorWallAt: timestamp('clock_anchor_wall_at', { withTimezone: true }),
  clockAnchorSimMs: integer('clock_anchor_sim_ms'),
  armedAt: timestamp('armed_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  battleEndsAt: timestamp('battle_ends_at', { withTimezone: true }),
  streamClosedAt: timestamp('stream_closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('raid_live_states_deadline_idx').on(t.battleEndsAt),
  check('raid_live_states_mode_ck', sql`${t.mode} IN ('live', 'batch')`),
  check('raid_live_states_version_ck', sql`${t.commandProtocolVersion} >= 1 AND ${t.lastSequence} >= -1`),
  check('raid_live_states_clock_v2_range_ck', sql`
    ${t.clockRevision} >= 0
    AND ${t.clockRate} IN (1, 2)
    AND (${t.clockAnchorSimMs} IS NULL OR ${t.clockAnchorSimMs} BETWEEN 0 AND 90000)
  `),
  check('raid_live_states_clock_v2_pair_ck', sql`
    (${t.clockAnchorWallAt} IS NULL) = (${t.clockAnchorSimMs} IS NULL)
  `),
  check('raid_live_states_clock_v2_state_ck', sql`
    ${t.commandProtocolVersion} != 2
    OR (
      (${t.startedAt} IS NULL AND ${t.battleEndsAt} IS NULL
        AND ${t.clockAnchorWallAt} IS NULL AND ${t.clockAnchorSimMs} IS NULL)
      OR (${t.startedAt} IS NOT NULL AND ${t.battleEndsAt} IS NOT NULL AND ${t.battleEndsAt} > ${t.startedAt}
        AND ${t.clockAnchorWallAt} IS NOT NULL AND ${t.clockAnchorSimMs} IS NOT NULL)
    )
  `),
  check('raid_live_states_clock_ck', sql`
    (${t.startedAt} IS NULL AND ${t.battleEndsAt} IS NULL)
    OR (${t.startedAt} IS NOT NULL AND ${t.battleEndsAt} > ${t.startedAt})
  `),
]);

/** Exact defender wealth is private and frozen at raid start. Money sources are
 * split so settlement/release can reverse the exact accounts; the pooled
 * raid_loot_escrow ledger balance reconciles to spendable+forge reserved sums. */
export const raidLootReservations = pgTable('raid_loot_reservations', {
  raidId: uuid('raid_id').primaryKey().references(() => raids.id, { onDelete: 'cascade' }),
  formulaVersion: integer('formula_version').notNull(),
  rowVersion: integer('row_version').notNull().default(0),
  attackerBaseId: uuid('attacker_base_id').notNull().references(() => bases.id),
  defenderBaseId: uuid('defender_base_id').notNull().references(() => bases.id),
  state: raidLootReservationStateEnum('state').notNull().default('reserved'),
  spendableReservedShards: bigint('spendable_reserved_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  forgeReservedShards: bigint('forge_reserved_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  mineReservedShards: bigint('mine_reserved_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  /** Hash commits to the exact private inputs without exposing them in raid DTOs. */
  privateSnapshotHash: text('private_snapshot_hash').notNull(),
  reserveLedgerTxnId: uuid('reserve_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  terminalLedgerTxnId: uuid('terminal_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
}, (t) => [
  index('raid_loot_reservations_defender_idx').on(t.defenderBaseId, t.reservedAt),
  check('raid_loot_reservations_versions_ck', sql`${t.formulaVersion} >= 1 AND ${t.rowVersion} >= 0`),
  check('raid_loot_reservations_amounts_ck', sql`
    ${t.spendableReservedShards} >= 0 AND ${t.forgeReservedShards} >= 0 AND ${t.mineReservedShards} >= 0
  `),
  check('raid_loot_reservations_terminal_ck', sql`
    (${t.state} = 'reserved' AND ${t.settledAt} IS NULL AND ${t.releasedAt} IS NULL)
    OR (${t.state} = 'settled' AND ${t.settledAt} IS NOT NULL AND ${t.releasedAt} IS NULL)
    OR (${t.state} = 'released' AND ${t.releasedAt} IS NOT NULL AND ${t.settledAt} IS NULL)
  `),
]);

/** Per-Mine frozen contents preserve the physical destroyed/not-destroyed rule. */
export const raidMineLootReservations = pgTable('raid_mine_loot_reservations', {
  raidId: uuid('raid_id').notNull().references(() => raidLootReservations.raidId, { onDelete: 'cascade' }),
  mineBuildingId: uuid('mine_building_id').notNull().references(() => buildings.id),
  frozenShards: bigint('frozen_shards', { mode: 'bigint' }).notNull(),
  awardedShards: bigint('awarded_shards', { mode: 'bigint' }),
}, (t) => [
  primaryKey({ columns: [t.raidId, t.mineBuildingId] }),
  check('raid_mine_loot_reservations_amount_ck', sql`
    ${t.frozenShards} >= 0 AND (${t.awardedShards} IS NULL OR (${t.awardedShards} >= 0 AND ${t.awardedShards} <= ${t.frozenShards}))
  `),
]);

/** Compact replay protocol bytes. Raw SimEvent JSON remains a rolling-deploy
 * compatibility field on raids; this immutable timeline is the archival truth. */
export const raidReplayTimelines = pgTable('raid_replay_timelines', {
  raidId: uuid('raid_id').primaryKey().references(() => raids.id, { onDelete: 'cascade' }),
  formatVersion: integer('format_version').notNull(),
  codec: text('codec').notNull(),
  timeline: bytea('timeline').notNull(),
  byteLength: integer('byte_length').notNull(),
  eventCount: integer('event_count').notNull(),
  durationMs: integer('duration_ms').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('raid_replay_timelines_counts_ck', sql`
    ${t.formatVersion} >= 1 AND ${t.byteLength} >= 0 AND ${t.eventCount} >= 0 AND ${t.durationMs} >= 0
  `),
  check('raid_replay_timelines_byte_length_ck', sql`octet_length(${t.timeline}) = ${t.byteLength}`),
]);

/** History belongs to each participating deed. ownerWalletAtBattle gates exact
 * monetary details after a deed sale; the new owner retains the battle/replay
 * record but services redact loot fields from the previous owner's battles. */
export const baseBattleRecords = pgTable('base_battle_records', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'cascade' }),
  raidId: uuid('raid_id').notNull().references(() => raids.id, { onDelete: 'cascade' }),
  role: raidBattleRoleEnum('role').notNull(),
  ownerWalletAtBattle: text('owner_wallet_at_battle').notNull().references(() => players.wallet),
  counterpartyBaseId: uuid('counterparty_base_id').references(() => bases.id),
  stars: integer('stars').notNull(),
  destructionPct: integer('destruction_pct').notNull(),
  lootDeltaShards: bigint('loot_delta_shards', { mode: 'bigint' }).notNull().default(sql`0`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.baseId, t.raidId, t.role] }),
  unique('base_battle_records_raid_role_uq').on(t.raidId, t.role),
  index('base_battle_records_history_idx').on(t.baseId, t.createdAt.desc()),
  index('base_battle_records_owner_history_idx').on(t.ownerWalletAtBattle, t.createdAt.desc()),
  check('base_battle_records_stars_ck', sql`${t.stars} BETWEEN 0 AND 3`),
  check('base_battle_records_destruction_ck', sql`${t.destructionPct} BETWEEN 0 AND 100`),
]);

// ---------------------------------------------------------------------------
// Tester program (owner 2026-08-21): alpha testers earn points for verified game
// actions plus rated feedback; the public board at pixelkingdomwars.com/leaderboard
// and the in-game TESTER screen read from these two tables only.
// ---------------------------------------------------------------------------

/**
 * One row per (wallet, milestone key): a milestone is earned once and never
 * un-earned, even when the underlying signal can regress (tutorial reset,
 * 2FA disabled, gear unequipped). Rows are inserted by
 * game/tester.ts `recomputeTesterMilestones` (idempotent derivation from the
 * authoritative tables — the ledger, raids, deposits, …) and by the few hooks
 * whose signal is not retroactively derivable. `points` is frozen at insert so
 * a later retune of TESTER_PROGRAM never rewrites history; `achievedAt` is the
 * source event time when one exists, else the detection time.
 */
export const testerMilestones = pgTable('tester_milestones', {
  wallet: text('wallet').notNull().references(() => players.wallet),
  key: text('key').notNull(),
  points: integer('points').notNull(),
  /** 'derived' (backfill/sweep), 'hook' (commit-point), 'feedback' (admin award). */
  source: text('source').notNull(),
  achievedAt: timestamp('achieved_at', { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb('meta'),
}, (t) => [
  primaryKey({ columns: [t.wallet, t.key] }),
  index('tester_milestones_key_idx').on(t.key),
  check('tester_milestones_points_ck', sql`${t.points} >= 0`),
]);

export const testerFeedbackStatusEnum = pgEnum('tester_feedback_status', [
  'new', 'reviewed', 'accepted', 'rejected', 'duplicate',
  /** D-103: the report led to a shipped change; counted publicly as
   *  "issues fixed from tester feedback". Set only by an admin. */
  'fixed',
]);
export const testerFeedbackImportanceEnum = pgEnum('tester_feedback_importance', [
  'low', 'medium', 'high', 'critical',
]);

/**
 * In-game feedback with the submitting wallet. Base points are awarded on
 * submit (bounded per UTC day — TESTER_PROGRAM.feedback); an admin rating adds
 * the importance bonus exactly once. `points` is the total awarded for this
 * row and is what the leaderboard sums, so re-rating replaces (never stacks).
 */
export const testerFeedback = pgTable('tester_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  category: text('category').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  /** Client context at submit: screen, build sha, platform, base id. Bounded. */
  context: jsonb('context'),
  status: testerFeedbackStatusEnum('status').notNull().default('new'),
  importance: testerFeedbackImportanceEnum('importance'),
  basePoints: integer('base_points').notNull().default(0),
  bonusPoints: integer('bonus_points').notNull().default(0),
  points: integer('points').notNull().default(0),
  adminNote: text('admin_note'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  /** D-103 / owner 2026-09-04: FIXED is a flag beside the triage status — a
   *  report can be accepted AND fixed, never rejected/duplicate and fixed.
   *  `fixed_at` is stamped once when the report first becomes fixed; `fixed_ref`
   *  is the public change reference (commit / release) an admin cites. The
   *  enum value 'fixed' is no longer written (migration 0105 folded it into
   *  'accepted' + this stamp). */
  fixedAt: timestamp('fixed_at', { withTimezone: true }),
  fixedRef: text('fixed_ref'),
  /** Owner 2026-09-04: first time the report was included in a text export,
   *  so the admin panel can mark it EXPORTED and filter the rest. */
  exportedAt: timestamp('exported_at', { withTimezone: true }),
  /** Policy 1 rows retain historical awards; policy 2 submissions start at zero in the service. */
  rewardPolicyVersion: integer('reward_policy_version').notNull().default(2),
  requestId: text('request_id'),
  requestHash: text('request_hash'),
  submissionReceipt: jsonb('submission_receipt'),
  reporterRevision: integer('reporter_revision').notNull().default(1),
  revision: integer('revision').notNull().default(1),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Admin trash hides the report without rewriting rewards, receipts or closure. */
  trashedAt: timestamp('trashed_at', { withTimezone: true }),
  trashedBy: text('trashed_by'),
  trashReason: text('trash_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('tester_feedback_request_uq').on(t.wallet, t.requestId),
  check('tester_feedback_request_ck', sql`(${t.requestId} IS NULL AND ${t.requestHash} IS NULL AND ${t.submissionReceipt} IS NULL) OR (${t.requestId} IS NOT NULL AND ${t.requestHash} IS NOT NULL AND ${t.submissionReceipt} IS NOT NULL)`),
  index('tester_feedback_wallet_idx').on(t.wallet, t.createdAt.desc()),
  index('tester_feedback_status_idx').on(t.status, t.createdAt.desc()),
  check('tester_feedback_revision_ck', sql`${t.revision} >= ${t.reporterRevision} AND ${t.reporterRevision} > 0 AND ${t.rewardPolicyVersion} IN (1, 2)`),
  check('tester_feedback_points_ck', sql`${t.points} >= 0 AND ${t.basePoints} >= 0 AND ${t.bonusPoints} >= 0`),
  check('tester_feedback_trash_ck', sql`(${t.trashedAt} IS NULL AND ${t.trashedBy} IS NULL AND ${t.trashReason} IS NULL) OR (${t.trashedAt} IS NOT NULL AND ${t.trashedBy} IS NOT NULL AND ${t.trashReason} IS NOT NULL AND length(btrim(${t.trashReason})) > 0)`),
]);


/** Private feedback foundation. Service transactions enforce authorization, revisions,
 * retention and award rules. Never serialize these rows as a public issue DTO. */
export const feedbackMessages = pgTable('feedback_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  author: text('author').notNull(),
  visibility: text('visibility').notNull(),
  kind: text('kind').notNull(),
  body: text('body'),
  context: jsonb('context'),
  reporterRevision: integer('reporter_revision'),
  revision: integer('revision').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_messages_report_id_uq').on(t.reportId, t.id),
  unique('feedback_messages_reporter_revision_uq').on(t.reportId, t.reporterRevision),
  check('feedback_messages_reporter_revision_ck', sql`(${t.visibility} = 'reporter' AND ${t.reporterRevision} IS NOT NULL AND ${t.reporterRevision} > 1 AND ${t.reporterRevision} <= ${t.revision}) OR (${t.visibility} = 'admin' AND ${t.reporterRevision} IS NULL)`),
  unique('feedback_messages_revision_uq').on(t.reportId, t.revision),
  unique('feedback_messages_request_uq').on(t.author, t.requestId),
  check('feedback_messages_visibility_ck', sql`${t.visibility} IN ('reporter', 'admin')`),
  check('feedback_messages_kind_ck', sql`${t.kind} IN ('reply', 'status', 'note')`),
  check('feedback_messages_revision_ck', sql`${t.revision} > 0`),
  check('feedback_messages_note_private_ck', sql`${t.kind} <> 'note' OR ${t.visibility} = 'admin'`)
]);

export const feedbackReaders = pgTable('feedback_readers', {
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  reader: text('reader').notNull(),
  revision: integer('revision').notNull().default(0),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_readers_reader_uq').on(t.reportId, t.reader),
  check('feedback_readers_revision_ck', sql`${t.revision} >= 0`)
]);

export const feedbackAttachments = pgTable('feedback_attachments', {
  uploadRole: text('upload_role').notNull().default('reporter'),
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  reportId: uuid('report_id').references(() => testerFeedback.id),
  messageId: uuid('message_id'),
  requestId: text('request_id').notNull(),
  state: text('state').notNull().default('uploading'),
  objectKey: text('object_key'),
  sha256: text('sha256'),
  byteLength: integer('byte_length'),
  width: integer('width'),
  height: integer('height'),
  contentType: text('content_type'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  preservedAt: timestamp('preserved_at', { withTimezone: true }),
  preservedBy: text('preserved_by'),
  preservationReason: text('preservation_reason'),
  deleteAfter: timestamp('delete_after', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deleteAttempts: integer('delete_attempts').notNull().default(0),
  lastErrorCode: text('last_error_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_attachments_request_uq').on(t.wallet, t.requestId),
  check('feedback_attachments_upload_role_ck', sql`${t.uploadRole} IN ('reporter', 'admin')`),
  unique('feedback_attachments_object_uq').on(t.objectKey),
  check('feedback_attachments_state_ck', sql`${t.state} IN ('uploading', 'stored', 'attached', 'deleting', 'deleted', 'failed')`),
  index('feedback_attachments_report_idx').on(t.reportId),
  index('feedback_attachments_expiry_idx').on(t.state, t.expiresAt),
  foreignKey({ name: 'feedback_attachments_message_fk', columns: [t.reportId, t.messageId], foreignColumns: [feedbackMessages.reportId, feedbackMessages.id] }),
  check('feedback_attachments_message_ck', sql`${t.messageId} IS NULL OR ${t.reportId} IS NOT NULL`),
  check('feedback_attachments_complete_ck', sql`(${t.state} <> 'attached' OR ${t.reportId} IS NOT NULL) AND (${t.state} NOT IN ('stored', 'attached') OR (${t.objectKey} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.sha256} ~ '^[0-9a-f]{64}$' AND ${t.byteLength} IS NOT NULL AND ${t.byteLength} > 0 AND ${t.width} IS NOT NULL AND ${t.width} > 0 AND ${t.height} IS NOT NULL AND ${t.height} > 0 AND ${t.contentType} IS NOT NULL AND ${t.contentType} = 'image/webp')) AND ${t.deleteAttempts} >= 0`),
  check('feedback_attachments_preserve_ck', sql`(${t.preservedAt} IS NULL AND ${t.preservedBy} IS NULL AND ${t.preservationReason} IS NULL) OR (${t.preservedAt} IS NOT NULL AND ${t.preservedBy} IS NOT NULL AND ${t.preservationReason} IS NOT NULL)`)
]);

export const feedbackIssues = pgTable('feedback_issues', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  category: text('category').notNull().default('other'),
  workaround: text('workaround'),
  fixedRelease: text('fixed_release'),
  status: text('status').notNull().default('open'),
  revision: integer('revision').notNull().default(1),
  approvedBy: text('approved_by').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  mergedInto: uuid('merged_into').references((): AnyPgColumn => feedbackIssues.id),
  recurrenceOf: uuid('recurrence_of').references((): AnyPgColumn => feedbackIssues.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('feedback_issues_status_ck', sql`${t.status} IN ('open', 'investigating', 'planned', 'fixed', 'closed', 'merged')`),
  index('feedback_issues_public_idx').on(t.publishedAt, t.status),
  check('feedback_issues_links_ck', sql`${t.revision} > 0 AND (${t.mergedInto} IS NULL OR ${t.mergedInto} <> ${t.id}) AND (${t.recurrenceOf} IS NULL OR ${t.recurrenceOf} <> ${t.id}) AND ((${t.status} = 'merged') = (${t.mergedInto} IS NOT NULL))`)
]);

export const feedbackIssueLinks = pgTable('feedback_issue_links', {
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  issueId: uuid('issue_id').notNull().references(() => feedbackIssues.id),
  linkedBy: text('linked_by').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_issue_links_report_uq').on(t.reportId),
  index('feedback_issue_links_issue_idx').on(t.issueId)
]);

export const feedbackConfirmations = pgTable('feedback_confirmations', {
  issueId: uuid('issue_id').notNull().references(() => feedbackIssues.id),
  wallet: text('wallet').notNull().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_confirmations_wallet_uq').on(t.issueId, t.wallet)
]);

export const feedbackRewardDecisions = pgTable('feedback_reward_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  wallet: text('wallet').notNull().references(() => players.wallet),
  admin: text('admin').notNull(),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  policyVersion: integer('policy_version').notNull(),
  reportRevision: integer('report_revision').notNull(),
  reason: text('reason').notNull(),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_reward_decisions_request_uq').on(t.admin, t.requestId),
  index('feedback_reward_decisions_wallet_idx').on(t.wallet, t.createdAt),
  check('feedback_reward_decisions_policy_ck', sql`${t.policyVersion} IN (1, 2) AND ${t.reportRevision} > 0`)
]);

export const feedbackExportJobs = pgTable('feedback_export_jobs', {
  preparationGeneration: uuid('preparation_generation'),
  preparationLeaseUntil: timestamp('preparation_lease_until', { withTimezone: true }),
  preparationAttempts: integer('preparation_attempts').notNull().default(0),
  id: uuid('id').primaryKey().defaultRandom(),
  requestedBy: text('requested_by').notNull(),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  format: text('format').notNull(),
  schemaVersion: integer('schema_version').notNull(),
  selection: jsonb('selection').notNull(),
  state: text('state').notNull().default('pending'),
  objectKey: text('object_key'),
  sha256: text('sha256'),
  manifest: jsonb('manifest'),
  errorCode: text('error_code'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  downloadRequestedAt: timestamp('download_requested_at', { withTimezone: true }),
  deleteAfter: timestamp('delete_after', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deleteAttempts: integer('delete_attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('feedback_export_jobs_preparation_attempts_ck', sql`${t.preparationAttempts} >= 0`),
  unique('feedback_export_jobs_request_uq').on(t.requestedBy, t.requestId),
  unique('feedback_export_jobs_object_uq').on(t.objectKey),
  check('feedback_export_jobs_format_ck', sql`${t.format} IN ('text', 'json', 'zip')`),
  check('feedback_export_jobs_state_ck', sql`${t.state} IN ('pending', 'preparing', 'ready', 'failed', 'deleting', 'deleted')`),
  index('feedback_export_jobs_expiry_idx').on(t.state, t.expiresAt),
  check('feedback_export_jobs_version_ck', sql`${t.schemaVersion} > 0 AND ${t.deleteAttempts} >= 0`)
]);

export const feedbackExportReports = pgTable('feedback_export_reports', {
  jobId: uuid('job_id').notNull().references(() => feedbackExportJobs.id),
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  revision: integer('revision').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  sha256: text('sha256').notNull(),
}, (t) => [
  unique('feedback_export_reports_job_uq').on(t.jobId, t.reportId),
  check('feedback_export_reports_revision_ck', sql`${t.revision} > 0`)
]);

/** Admin-hidden wallets for the public tester board (owner 2026-08-22: remove
 * ghost/test accounts from the leaderboard). Hiding is reversible and never
 * touches points, milestones, feedback or any game row. */
export const testerBoardHidden = pgTable('tester_board_hidden', {
  wallet: text('wallet').primaryKey().references(() => players.wallet),
  reason: text('reason'),
  hiddenBy: text('hidden_by').notNull(),
  hiddenAt: timestamp('hidden_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Daily tester points (D-103). One row per (wallet, UTC day, key), derived
 * idempotently from authoritative ledgers by the tester recompute — the
 * per-day counterpart of tester_milestones. `count` is the paid count for
 * capped sources (TESTER_DAILY.sources[].cap); `points` = count × per-unit
 * points, frozen at write. Rows are never deleted or reduced.
 */
export const testerDailyPoints = pgTable('tester_daily_points', {
  wallet: text('wallet').notNull().references(() => players.wallet),
  day: date('day').notNull(),
  key: text('key').notNull(),
  count: integer('count').notNull().default(1),
  points: integer('points').notNull(),
  firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
  lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb('meta'),
}, (t) => [
  primaryKey({ columns: [t.wallet, t.day, t.key] }),
  index('tester_daily_points_day_idx').on(t.day, t.key),
  check('tester_daily_points_ck', sql`${t.points} >= 0 AND ${t.count} >= 1`),
]);

/**
 * Public playtest statistics snapshots (D-103). The worker writes one JSON
 * payload per PLAYTEST_STATS.refreshEveryMs; the uncredentialed endpoint
 * serves only the latest row. History feeds the post-playtest report.
 */
export const playtestStatsSnapshots = pgTable('playtest_stats_snapshots', {
  computedAt: timestamp('computed_at', { withTimezone: true }).primaryKey().defaultNow(),
  payload: jsonb('payload').notNull(),
});

// ---------------------------------------------------------------------------
// DEVNET PLAYTEST ONLY — in-game devnet SOL faucet (owner 2026-08-22). The API
// records a request; the worker (the only process holding the faucet keypair)
// pays it and writes the signature. Remove this table, money/devnetFaucet.ts,
// routes-devnet-faucet.ts and the DEVNET_FAUCET_* env before mainnet.
// ---------------------------------------------------------------------------
export const devnetFaucetStatusEnum = pgEnum('devnet_faucet_status', ['requested', 'sent', 'failed']);

export const devnetFaucetGrants = pgTable('devnet_faucet_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  lamports: bigint('lamports', { mode: 'bigint' }).notNull(),
  status: devnetFaucetStatusEnum('status').notNull().default('requested'),
  /** Confirmed transfer signature once sent. */
  txSignature: text('tx_signature'),
  /** Bounded operator reason when failed (e.g. treasury_low, rpc). */
  error: text('error'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => [
  index('devnet_faucet_grants_wallet_idx').on(t.wallet, t.requestedAt.desc()),
  index('devnet_faucet_grants_status_idx').on(t.status, t.requestedAt.asc()),
  check('devnet_faucet_grants_lamports_ck', sql`${t.lamports} > 0`),
]);

/** Devnet SKR daily reservations; SQL guards retain originals and signed bytes. */
export const devnetSkrFaucetGrants = pgTable('devnet_skr_faucet_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id),
  deedAssetId: text('deed_asset_id').notNull(), day: date('day').notNull(), mint: text('mint').notNull(),
  decimals: integer('decimals').notNull(), amountRaw: numeric('amount_raw', { precision: 20, scale: 0 }).notNull(),
  status: text('status').$type<'requested' | 'sent' | 'failed'>().notNull().default('requested'), error: text('error'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => [
  unique('devnet_skr_faucet_wallet_day_uq').on(t.wallet, t.day),
  unique('devnet_skr_faucet_deed_day_uq').on(t.deedAssetId, t.day),
  index('devnet_skr_faucet_pending_idx').on(t.status, t.requestedAt),
  check('devnet_skr_faucet_decimals_ck', sql`${t.decimals} BETWEEN 0 AND 19`),
  check('devnet_skr_faucet_amount_ck', sql`${t.amountRaw} > 0 AND ${t.amountRaw} <= 18446744073709551615`),
  check('devnet_skr_faucet_status_ck', sql`${t.status} IN ('requested','sent','failed')`),
  check('devnet_skr_faucet_error_ck', sql`${t.error} IS NULL OR ${t.error} ~ '^[a-z_]{1,64}$'`),
  check('devnet_skr_faucet_day_ck', sql`${t.day} = (${t.requestedAt} AT TIME ZONE 'UTC')::date`),
  check('devnet_skr_faucet_sent_ck', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
]);
export const devnetSkrFaucetAttempts = pgTable('devnet_skr_faucet_attempts', {
  id: uuid('id').primaryKey().defaultRandom(), grantId: uuid('grant_id').notNull().references(() => devnetSkrFaucetGrants.id),
  attemptNo: integer('attempt_no').notNull(),
  phase: text('phase').$type<'prepared' | 'player_signed' | 'submitted' | 'finalized' | 'failed' | 'expired' | 'abandoned'>().notNull().default('prepared'),
  message: bytea('message').notNull(), reference: text('reference').notNull().unique(), recentBlockhash: text('recent_blockhash').notNull(),
  lastValidBlockHeight: bigint('last_valid_block_height', { mode: 'bigint' }).notNull(),
  playerWire: bytea('player_wire'), signature: text('signature').unique(),
  mutation: text('mutation').$type<'none' | 'compute_budget_added'>(), faucetWire: bytea('faucet_wire'), landedSignature: text('landed_signature').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => [
  unique('devnet_skr_faucet_attempt_no_uq').on(t.grantId, t.attemptNo),
  uniqueIndex('devnet_skr_faucet_live_attempt_uq').on(t.grantId).where(sql`${t.phase} IN ('prepared','player_signed','submitted')`),
  check('devnet_skr_faucet_attempt_no_ck', sql`${t.attemptNo} >= 1`),
  check('devnet_skr_faucet_height_ck', sql`${t.lastValidBlockHeight} > 0`),
  check('devnet_skr_faucet_phase_ck', sql`${t.phase} IN ('prepared','player_signed','submitted','finalized','failed','expired','abandoned')`),
  check('devnet_skr_faucet_message_ck', sql`octet_length(${t.message}) > 0 AND octet_length(${t.message}) <= 1103`),
  check('devnet_skr_faucet_wire_length_ck', sql`(${t.playerWire} IS NULL OR octet_length(${t.playerWire}) <= 1232) AND (${t.faucetWire} IS NULL OR octet_length(${t.faucetWire}) <= 1232)`),
  check('devnet_skr_faucet_mutation_ck', sql`${t.mutation} IS NULL OR ${t.mutation} IN ('none','compute_budget_added')`),
  check('devnet_skr_faucet_player_wire_ck', sql`(${t.playerWire} IS NULL) = (${t.signature} IS NULL) AND (${t.playerWire} IS NULL) = (${t.mutation} IS NULL)`),
  check('devnet_skr_faucet_player_phase_ck', sql`${t.phase} NOT IN ('player_signed','submitted','finalized','failed','expired') OR ${t.playerWire} IS NOT NULL`),
  check('devnet_skr_faucet_faucet_phase_ck', sql`(${t.phase} IN ('submitted','finalized','failed','expired')) = (${t.faucetWire} IS NOT NULL)`),
  check('devnet_skr_faucet_settled_ck', sql`(${t.phase} IN ('finalized','failed','expired','abandoned')) = (${t.settledAt} IS NOT NULL)`),
  check('devnet_skr_faucet_landed_ck', sql`(${t.phase} IN ('finalized','failed')) = (${t.landedSignature} IS NOT NULL)`),
]);

/** Verified provider identity is uniquely bound to the existing wallet identity. */
export const privyIdentities = pgTable('privy_identities', {
  subject: text('subject').primaryKey(),
  wallet: text('wallet').notNull().unique().references(() => players.wallet),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Saved plans contain no snapshotted economy values; current server rules quote them. */
export const armyPresets = pgTable('army_presets', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  slot: integer('slot').notNull(),
  name: text('name').notNull(),
  composition: jsonb('composition').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.slot] })]);

/** The entire batch and this receipt commit together, including every per-unit debit. */
export const armyTrainingBatches = pgTable('army_training_batches', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  idempotencyKey: text('idempotency_key').notNull(),
  baseId: uuid('base_id').references(() => bases.id),
  request: jsonb('request').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.idempotencyKey] })]);

/** Permanent owner-confirmed closure of an unaccepted key. Training acceptance
 * and closure serialize on the wallet row; accepted receipts stay immutable. */
export const armyTrainingBatchClosures = pgTable('army_training_batch_closures', {
  playerWallet: text('player_wallet').notNull().references(() => players.wallet),
  idempotencyKey: text('idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.playerWallet, t.idempotencyKey] })]);

/** Immutable staff curation receipts; never part of a public issue response. */
export const feedbackIssueActions = pgTable('feedback_issue_actions', {
  id: uuid('id').primaryKey().defaultRandom(),
  admin: text('admin').notNull(),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  action: text('action').notNull(),
  reason: text('reason').notNull(),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique('feedback_issue_actions_request_uq').on(t.admin, t.requestId),
  check('feedback_issue_actions_action_ck', sql`${t.action} IN ('create', 'update', 'publish', 'link', 'merge', 'split', 'reopen')`),
]);

/** Reporter evidence operations are independent from staff curation receipts. */
export const feedbackEvidenceRequests = pgTable('feedback_evidence_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  wallet: text('wallet').notNull().references(() => players.wallet),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  issueId: uuid('issue_id').notNull().references(() => feedbackIssues.id),
  reportId: uuid('report_id').notNull().references(() => testerFeedback.id),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('feedback_evidence_requests_request_uq').on(t.wallet, t.requestId)]);

export * from './playtestActivitySchema';
export * from './playtestCampaignSchema';
export * from './onboardingTrainingSchema';
export * from './playtestMintStatusSchema';

/** Immutable complete claim result, including an empty result. No FK to a
 * transferable/deletable base: the actor's historical payout proof survives. */
export const forgeClaimCommands = pgTable('forge_claim_commands', {
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  requestKey: uuid('request_key').notNull(),
  baseId: uuid('base_id'),
  day: date('day'),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.actorWallet, t.requestKey] })]);

/** Accepted hero construction retains original consent and actual funding even
 * after the building/job changes or its original deed is transferred. */
export const heroRecruitmentCommands = pgTable('hero_recruitment_commands', {
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  requestKey: uuid('request_key').notNull(),
  receipt: jsonb('receipt').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.actorWallet, t.requestKey] }),
  check('hero_recruitment_commands_identity_ck', sql`(jsonb_typeof(${t.receipt}) = 'object'
    AND ${t.receipt}->>'version' = '1' AND ${t.receipt}->>'actor' = ${t.actorWallet}
    AND ${t.receipt}->>'idempotencyKey' = ${t.requestKey}::text
    AND ${t.receipt}->'request'->>'idempotencyKey' = ${t.requestKey}::text) IS TRUE`),
]);

/** Null receipt permanently cancels an unaccepted key; accepted evidence is immutable. */
export const baseClaimCommands = pgTable('base_claim_commands', {
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  requestKey: uuid('request_key').notNull(),
  transferId: uuid('transfer_id').references(() => baseTransfers.id),
  receipt: jsonb('receipt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.actorWallet, t.requestKey] }), uniqueIndex('base_claim_commands_transfer_uq').on(t.transferId)]);

/** DARK E2 raw stock. Stable-base custody; reservations remain raid-exposed.
 * IDs mirror the isolated phaseEResources catalogue (migration drift test).
 * No opening-stock/issuance writer is exposed by the runtime service. */
export const resourceStocks = pgTable('resource_stocks', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  resourceId: text('resource_id').notNull(),
  miningPending: bigint('mining_pending', { mode: 'bigint' }).notNull().default(0n),
  available: bigint('available', { mode: 'bigint' }).notNull().default(0n),
  reserved: bigint('reserved', { mode: 'bigint' }).notNull().default(0n),
}, t => [
  primaryKey({ columns: [t.baseId, t.resourceId] }),
  check('resource_stocks_id_ck', sql`${t.resourceId} IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')`),
  check('resource_mining_capacity', sql`${t.miningPending} >= 0 AND ${t.available}::numeric + ${t.reserved}::numeric + ${t.miningPending}::numeric <= 9223372036854775807`),
  check('resource_stocks_quantity_ck', sql`${t.available} >= 0 AND ${t.reserved} >= 0 AND ${t.available}::numeric + ${t.reserved}::numeric <= 9223372036854775807`),
]);

/** A reserve row IS the reservation. One immutable terminal row may release
 * OR consume it in full. Release may return an explicit raid-impaired residual.
 * Original quantity and receipts survive base/custody changes. */
export const resourceStockOperations = pgTable('resource_stock_operations', {
  id: uuid('id').primaryKey(),
  kind: text('kind').$type<'reserve' | 'release' | 'consume'>().notNull(),
  baseId: uuid('base_id').notNull(),
  resourceId: text('resource_id').notNull(),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  effectiveQuantity: bigint('effective_quantity', { mode: 'bigint' }),
  custodyWallet: text('custody_wallet').notNull(),
  reservationId: uuid('reservation_id').references((): AnyPgColumn => resourceStockOperations.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('resource_stock_terminal_uq').on(t.reservationId).where(sql`${t.reservationId} IS NOT NULL`),
  index('resource_stock_base_idx').on(t.baseId, t.createdAt),
  check('resource_stock_operations_id_ck', sql`${t.resourceId} IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')`),
  check('resource_stock_operations_quantity_ck', sql`${t.quantity} > 0`),
  check('resource_stock_effective_ck', sql`${t.effectiveQuantity} IS NULL OR (${t.kind} = 'release' AND ${t.effectiveQuantity} >= 0 AND ${t.effectiveQuantity} <= ${t.quantity})`),
  check('resource_stock_operations_kind_ck', sql`(${t.kind} = 'reserve' AND ${t.reservationId} IS NULL) OR (${t.kind} IN ('release','consume') AND ${t.reservationId} IS NOT NULL AND ${t.reservationId} <> ${t.id})`),
]);

/** Exactly two signed original entries per operation, enforced at COMMIT by
 * migration 0139. Consumed is an accounting sink, never spendable inventory. */
export const resourceStockEntries = pgTable('resource_stock_entries', {
  operationId: uuid('operation_id').notNull().references(() => resourceStockOperations.id),
  bucket: text('bucket').$type<'available' | 'reserved' | 'consumed'>().notNull(),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
}, t => [
  primaryKey({ columns: [t.operationId, t.bucket] }),
  check('resource_stock_entries_bucket_ck', sql`${t.bucket} IN ('available','reserved','consumed')`),
  check('resource_stock_entries_delta_ck', sql`${t.delta} >= -9223372036854775807`),
]);

/** D-153.17: persisted free home, retained after first-land upgrade/transfer. */
export const expeditionFreeHomes = pgTable('expedition_free_homes', {
  baseId: uuid('base_id').primaryKey().references(() => bases.id, { onDelete: 'restrict' }),
  id: uuid('id').notNull().unique().defaultRandom(),
  assignedWallet: text('assigned_wallet').notNull().references(() => players.wallet),
  realmId: text('realm_id').notNull(),
  policyVersion: integer('policy_version').notNull(),
  provenance: text('provenance').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('expedition_free_homes_policy_ck', sql`${t.policyVersion} = 1 AND ${t.realmId} = 'crownlands' AND ${t.provenance} = 'authenticated_free_home_v1'`),
]);

/** DARK accepted five-family layout, starter only so far. No NFT/tier/uses or
 * dispatch state. The immutable berth/job links deliberately restrict deletion. */
export const fleetInstallations = pgTable('fleet_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  berthId: uuid('berth_id').notNull().references(() => buildings.id, { onDelete: 'restrict' }),
  family: text('family').$type<'starter'>().notNull(),
  installedWallet: text('installed_wallet').notNull().references(() => players.wallet),
  completedBuildJobId: uuid('completed_build_job_id').notNull().references(() => builderJobs.id, { onDelete: 'restrict' }),
  berthCompletedAt: timestamp('berth_completed_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('fleet_installations_base_family_uq').on(t.baseId, t.family),
  unique('fleet_installations_berth_uq').on(t.berthId),
  check('fleet_installations_family_ck', sql`${t.family} = 'starter'`),
]);

/** D153.30 original free starter acceptance. Historical installedWallet is not
 * a command's actor after custody transfer; no old registry rows are backfilled. */
export const starterFleetCommands = pgTable('starter_fleet_commands', {
  id: uuid('id').primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  berthId: uuid('berth_id').notNull().references(() => buildings.id, { onDelete: 'restrict' }),
  installationId: uuid('installation_id').notNull().references(() => fleetInstallations.id, { onDelete: 'restrict' }),
  completedBuildJobId: uuid('completed_build_job_id').notNull().references(() => builderJobs.id, { onDelete: 'restrict' }),
  berthCompletedAt: timestamp('berth_completed_at', { withTimezone: true }).notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
}, t => [check('starter_fleet_command_time_ck', sql`${t.acceptedAt} >= ${t.installedAt} AND ${t.installedAt} >= ${t.berthCompletedAt}`)]);

/** Immutable original Seeker term content. A stored shape/hash is not auction
 * authority. Only the server-reader adapter may supply new canonical snapshots. */
export const expeditionTermSnapshots = pgTable('expedition_term_snapshots', {
  termId: uuid('term_id').primaryKey(),
  snapshotHash: text('snapshot_hash').notNull(),
  canonical: text('canonical').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  genesisHash: text('genesis_hash').notNull(),
  programId: text('program_id').notNull(),
  auctionConfig: text('auction_config').notNull(),
  round: text('round').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  unique('expedition_term_id_hash_uq').on(t.termId, t.snapshotHash),
  unique('expedition_term_source_round_uq').on(t.genesisHash, t.programId, t.auctionConfig, t.round),
  index('expedition_term_interval_idx').on(t.genesisHash, t.programId, t.auctionConfig, t.startsAt),
  check('expedition_term_hash_ck', sql`${t.snapshotHash} ~ '^[0-9a-f]{64}$' AND ${t.snapshotHash} = encode(sha256(convert_to(${t.canonical}, 'UTF8')), 'hex')`),
  check('expedition_term_size_ck', sql`octet_length(${t.canonical}) BETWEEN 1 AND 131072`),
  check('expedition_term_interval_ck', sql`${t.endsAt} - ${t.startsAt} = interval '7 days'`),
  check('expedition_term_round_ck', sql`${t.round} ~ '^(0|[1-9][0-9]{0,19})$' AND ${t.round}::numeric <= 18446744073709551615`),
  check('expedition_term_snapshot_ck', sql`(${t.snapshot} = ${t.canonical}::jsonb AND jsonb_typeof(${t.snapshot}) = 'object'
    AND ${t.snapshot}->>'version' = '1' AND ${t.snapshot}->>'termId' = ${t.termId}::text
    AND (${t.snapshot}->>'startsAt')::timestamptz = ${t.startsAt} AND (${t.snapshot}->>'endsAt')::timestamptz = ${t.endsAt}
    AND ${t.snapshot}->'source'->>'kind' = 'solana_auction_round'
    AND ${t.snapshot}->'source'->>'genesisHash' = ${t.genesisHash} AND ${t.snapshot}->'source'->>'programId' = ${t.programId}
    AND ${t.snapshot}->'source'->>'auctionConfig' = ${t.auctionConfig} AND ${t.snapshot}->'source'->>'round' = ${t.round}
    AND jsonb_typeof(${t.snapshot}->'spots') = 'array' AND jsonb_array_length(${t.snapshot}->'spots') = 100) IS TRUE`),
]);

/** Accepted source entitlement, not current permission. Original evidence is
 * append-only; migration0143 requires exactly one active flight OR return. */
export const starterExpeditions = pgTable('starter_expeditions', {
  id: uuid('id').primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  installationId: uuid('installation_id').notNull().references(() => fleetInstallations.id, { onDelete: 'restrict' }),
  routeId: text('route_id').notNull(),
  routeVersion: integer('route_version').notNull(),
  rewardVersion: integer('reward_version').notNull(),
  homeEvidence: jsonb('home_evidence').notNull(),
  routeSnapshot: jsonb('route_snapshot').notNull(),
  termId: uuid('term_id').notNull(),
  termHash: text('term_hash').notNull(),
  finality: jsonb('finality').notNull(),
  resourceId: text('resource_id').notNull(),
  gross: bigint('gross', { mode: 'bigint' }).notNull(),
  net: bigint('net', { mode: 'bigint' }).notNull(),
  tax: bigint('tax', { mode: 'bigint' }).notNull(),
  departedAt: timestamp('departed_at', { withTimezone: true }).notNull(),
  returnsAt: timestamp('returns_at', { withTimezone: true }).notNull(),
}, t => [
  foreignKey({ columns: [t.termId, t.termHash], foreignColumns: [expeditionTermSnapshots.termId, expeditionTermSnapshots.snapshotHash], name: 'starter_expedition_term_fk' }),
  index('starter_expeditions_due_idx').on(t.baseId, t.returnsAt, t.id),
  check('starter_expeditions_amount_ck', sql`${t.gross} > 0 AND ${t.net} >= 0 AND ${t.tax} >= 0 AND ${t.net}::numeric + ${t.tax}::numeric = ${t.gross}::numeric`),
  check('starter_expeditions_time_ck', sql`${t.returnsAt} > ${t.departedAt}`),
  check('starter_expeditions_version_ck', sql`${t.routeVersion} > 0 AND ${t.rewardVersion} > 0`),
]);
export const starterExpeditionInflight = pgTable('starter_expedition_inflight', {
  installationId: uuid('installation_id').primaryKey().references(() => fleetInstallations.id),
  expeditionId: uuid('expedition_id').notNull().unique().references(() => starterExpeditions.id),
});
export const starterExpeditionReturns = pgTable('starter_expedition_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  expeditionId: uuid('expedition_id').notNull().unique().references(() => starterExpeditions.id),
  // Historical label; no player FK lock after the base-only return lock.
  custodyWallet: text('custody_wallet').notNull(),
  returnedAt: timestamp('returned_at', { withTimezone: true }).notNull(),
});
/** Original term/resource liability is the immutable island_pool entry; there
 * is deliberately no cross-base mutable pool row or authorized payout here. */
export const starterExpeditionEntries = pgTable('starter_expedition_entries', {
  returnId: uuid('return_id').notNull().references(() => starterExpeditionReturns.id),
  bucket: text('bucket').$type<'issued' | 'base_stock' | 'island_pool'>().notNull(),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
}, t => [
  primaryKey({ columns: [t.returnId, t.bucket] }),
  check('starter_expedition_entries_bucket_ck', sql`${t.bucket} IN ('issued','base_stock','island_pool')`),
  check('starter_expedition_entries_domain_ck', sql`${t.delta} >= -9223372036854775807`),
]);

/** D153.20 immutable raw raid allocation and exact terminal evidence. No player
 * FKs: settlement already holds base locks and must not then lock a player. */
export const rawRaidSnapshots = pgTable('raw_raid_snapshots', {
  raidId: uuid('raid_id').primaryKey().references(() => raids.id),
  attackerBaseId: uuid('attacker_base_id').notNull().references(() => bases.id),
  defenderBaseId: uuid('defender_base_id').notNull().references(() => bases.id),
  keepId: uuid('keep_id'),
  frozenDivisor: integer('frozen_divisor').notNull(),
  theftVersion: integer('theft_version').notNull(),
  frozenAt: timestamp('frozen_at', { withTimezone: true }).notNull(),
}, t => [check('raw_raid_snapshot_ck', sql`${t.attackerBaseId} <> ${t.defenderBaseId} AND ${t.frozenDivisor} > 0 AND ${t.theftVersion} > 0`)]);
export const rawRaidResources = pgTable('raw_raid_resources', {
  raidId: uuid('raid_id').notNull().references(() => rawRaidSnapshots.raidId),
  resourceId: text('resource_id').notNull(),
  available: bigint('available', { mode: 'bigint' }).notNull(),
  reserved: bigint('reserved', { mode: 'bigint' }).notNull(),
  maximum: bigint('maximum', { mode: 'bigint' }).notNull(),
  fromAvailable: bigint('from_available', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.raidId, t.resourceId] }),
  check('raw_raid_resource_id_ck', sql`${t.resourceId} IN ('frost_quartz','heartwood_logs','sunstone_rubble','crown_iron_ore','rough_prism','storm_ore','thorn_fibre','ember_nodules')`),
  check('raw_raid_resource_amount_ck', sql`${t.available} >= 0 AND ${t.reserved} >= 0 AND ${t.available}::numeric + ${t.reserved}::numeric <= 9223372036854775807 AND ${t.maximum} >= 0 AND ${t.fromAvailable} >= 0 AND ${t.fromAvailable} <= ${t.maximum}`),
]);
export const rawRaidAllocations = pgTable('raw_raid_allocations', {
  raidId: uuid('raid_id').notNull(), resourceId: text('resource_id').notNull(),
  reservationId: uuid('reservation_id').notNull().references(() => resourceStockOperations.id),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.raidId, t.resourceId, t.reservationId] }),
  foreignKey({ columns: [t.raidId, t.resourceId], foreignColumns: [rawRaidResources.raidId, rawRaidResources.resourceId], name: 'raw_raid_allocation_resource_fk' }),
  check('raw_raid_allocation_quantity_ck', sql`${t.quantity} > 0`),
]);
export const rawRaidTerminals = pgTable('raw_raid_terminals', {
  raidId: uuid('raid_id').primaryKey().references(() => rawRaidSnapshots.raidId),
  outcome: text('outcome').$type<'transferred' | 'released'>().notNull(),
  reason: text('reason').notNull(), settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
}, t => [check('raw_raid_terminal_ck', sql`${t.outcome} IN ('transferred','released') AND length(${t.reason}) BETWEEN 1 AND 128`)]);
export const rawRaidEntries = pgTable('raw_raid_entries', {
  raidId: uuid('raid_id').notNull().references(() => rawRaidTerminals.raidId),
  resourceId: text('resource_id').notNull(),
  bucket: text('bucket').$type<'defender_available' | 'defender_reserved' | 'attacker_available'>().notNull(),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.raidId, t.resourceId, t.bucket] }),
  foreignKey({ columns: [t.raidId, t.resourceId], foreignColumns: [rawRaidResources.raidId, rawRaidResources.resourceId], name: 'raw_raid_entry_resource_fk' }),
  check('raw_raid_entry_ck', sql`${t.bucket} IN ('defender_available','defender_reserved','attacker_available') AND ${t.delta} >= -9223372036854775807`),
]);
export const rawRaidReservationDebits = pgTable('raw_raid_reservation_debits', {
  raidId: uuid('raid_id').notNull().references(() => rawRaidTerminals.raidId),
  resourceId: text('resource_id').notNull(),
  reservationId: uuid('reservation_id').notNull(),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  bucket: text('bucket').$type<'reserved' | 'available'>().notNull(),
  releaseOperationId: uuid('release_operation_id').references(() => resourceStockOperations.id),
}, t => [primaryKey({ columns: [t.raidId, t.resourceId, t.reservationId] }),
  foreignKey({ columns: [t.raidId, t.resourceId, t.reservationId], foreignColumns: [rawRaidAllocations.raidId, rawRaidAllocations.resourceId, rawRaidAllocations.reservationId], name: 'raw_raid_debit_allocation_fk' }),
  index('raw_raid_debit_reservation_idx').on(t.reservationId),
  check('raw_raid_debit_ck', sql`${t.quantity} > 0 AND ((${t.bucket} = 'reserved' AND ${t.releaseOperationId} IS NULL) OR (${t.bucket} = 'available' AND ${t.releaseOperationId} IS NOT NULL))`),
]);

/** D153.27 protected crafting inventory, distinct from raw stock/legacy items. */
export const craftingStocks = pgTable('crafting_stocks', {
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  itemId: text('item_id').notNull(),
  miningPending: bigint('mining_pending', { mode: 'bigint' }).notNull().default(0n),
  available: bigint('available', { mode: 'bigint' }).notNull().default(0n),
  marketOutgoing: bigint('market_outgoing', { mode: 'bigint' }).notNull().default(0n),
  marketIncoming: bigint('market_incoming', { mode: 'bigint' }).notNull().default(0n),
  pendingOutput: bigint('pending_output', { mode: 'bigint' }).notNull().default(0n),
}, t => [primaryKey({ columns: [t.baseId, t.itemId] }),
  check('crafting_mining_capacity', sql`${t.miningPending} >= 0 AND ${t.available}::numeric + ${t.pendingOutput}::numeric + ${t.marketOutgoing}::numeric + ${t.marketIncoming}::numeric + ${t.miningPending}::numeric <= 9223372036854775807`),
  check('crafting_market_capacity_ck', sql`${t.marketOutgoing} >= 0 AND ${t.marketIncoming} >= 0 AND ${t.available}::numeric + ${t.pendingOutput}::numeric + ${t.marketOutgoing}::numeric + ${t.marketIncoming}::numeric <= 9223372036854775807`),
  check('crafting_stock_bounds_ck', sql`${t.available} >= 0 AND ${t.pendingOutput} >= 0 AND ${t.available}::numeric + ${t.pendingOutput}::numeric <= 9223372036854775807`),
]);

/** Frozen original recipe and consumed-input proof; only completedAt may advance. */
export const ordinaryCraftingJobs = pgTable('ordinary_crafting_jobs', {
  id: uuid('id').primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  recipeId: text('recipe_id').notNull(),
  recipeVersion: integer('recipe_version').notNull(),
  quantity: integer('quantity').notNull(),
  recipeSnapshot: jsonb('recipe_snapshot').notNull(),
  outputItemId: text('output_item_id').notNull(),
  outputQuantity: bigint('output_quantity', { mode: 'bigint' }).notNull(),
  workshopId: uuid('workshop_id').notNull(),
  workshopCompletedJobId: uuid('workshop_completed_job_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, t => [uniqueIndex('ordinary_crafting_one_pending_uq').on(t.baseId).where(sql`${t.completedAt} IS NULL`),
  index('ordinary_crafting_due_idx').on(t.baseId, t.readyAt, t.id),
  check('ordinary_crafting_job_bounds_ck', sql`${t.recipeVersion} > 0 AND ${t.quantity} > 0 AND ${t.outputQuantity} > 0 AND ${t.readyAt} > ${t.startedAt}`),
]);
export const ordinaryCraftingInputs = pgTable('ordinary_crafting_inputs', {
  jobId: uuid('job_id').notNull().references(() => ordinaryCraftingJobs.id),
  position: integer('position').notNull(),
  kind: text('kind').$type<'raw' | 'crafting' | 'shards'>().notNull(),
  itemId: text('item_id').notNull(),
  quantity: bigint('quantity', { mode: 'bigint' }).notNull(),
  reserveOperationId: uuid('reserve_operation_id').references(() => resourceStockOperations.id).unique(),
  consumeOperationId: uuid('consume_operation_id').references(() => resourceStockOperations.id).unique(),
  shardsLedgerTxnId: uuid('shards_ledger_txn_id').references(() => ledgerTransactions.id).unique(),
}, t => [primaryKey({ columns: [t.jobId, t.position] }),
  check('ordinary_crafting_input_ck', sql`${t.position} >= 0 AND ${t.quantity} > 0 AND ((${t.kind} = 'raw' AND ${t.reserveOperationId} IS NOT NULL AND ${t.consumeOperationId} IS NOT NULL AND ${t.reserveOperationId} <> ${t.consumeOperationId} AND ${t.shardsLedgerTxnId} IS NULL) OR (${t.kind} = 'crafting' AND ${t.reserveOperationId} IS NULL AND ${t.consumeOperationId} IS NULL AND ${t.shardsLedgerTxnId} IS NULL) OR (${t.kind} = 'shards' AND ${t.itemId} = 'shards' AND ${t.reserveOperationId} IS NULL AND ${t.consumeOperationId} IS NULL AND ${t.shardsLedgerTxnId} IS NOT NULL))`),
]);
export const ordinaryCraftingCompletions = pgTable('ordinary_crafting_completions', {
  jobId: uuid('job_id').primaryKey().references(() => ordinaryCraftingJobs.id),
  // Never reference players here: automatic completion holds the base first.
  custodyWallet: text('custody_wallet').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull(),
});


/** D153.28 immutable admission only, not daily allocation or an output receipt. */
export const harvesterSources = pgTable('harvester_sources', {
  id: uuid('id').primaryKey(),
  /** SQL derives this from an exact command visible during source insertion. */
  publicAdmission: boolean('public_admission').notNull().default(false),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  harvesterId: uuid('harvester_id').notNull(),
  harvesterCompletedJobId: uuid('harvester_completed_job_id').notNull(),
  harvesterCompletedAt: timestamp('harvester_completed_at', { withTimezone: true }).notNull(),
  policyVersion: integer('policy_version').notNull(),
  realmId: text('realm_id').notNull(), resourceId: text('resource_id').notNull(),
  homeEvidence: jsonb('home_evidence').notNull(), intervalSnapshot: jsonb('interval_snapshot').notNull(),
  termId: uuid('term_id').notNull(), termHash: text('term_hash').notNull(), finality: jsonb('finality').notNull(),
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
}, t => [foreignKey({ columns: [t.termId, t.termHash], foreignColumns: [expeditionTermSnapshots.termId, expeditionTermSnapshots.snapshotHash], name: 'harvester_source_term_fk' }),
  unique('harvester_source_scope_uq').on(t.id, t.actorWallet, t.baseId),
  index('harvester_source_base_idx').on(t.baseId, t.admittedAt),
  index('harvester_source_actor_idx').on(t.actorWallet, t.admittedAt),
  check('harvester_source_time_ck', sql`${t.leaseExpiresAt} > ${t.admittedAt} AND ${t.harvesterCompletedAt} <= ${t.admittedAt}`),
]);
/** D153.33 append-only public consent. Its ID is the original source ID; SQL
 * defers the source binding so the pending command precedes source insertion. */
export const harvesterSourceCommands = pgTable('harvester_source_commands', {
  id: uuid('id').primaryKey(),
  actorWallet: text('actor_wallet').notNull().references(() => players.wallet),
  baseId: uuid('base_id').notNull().references(() => bases.id, { onDelete: 'restrict' }),
  harvesterId: uuid('harvester_id').notNull(),
  expectedSourceId: uuid('expected_source_id'),
  policyVersion: integer('policy_version').notNull(),
}, t => [check('harvester_public_command_policy_ck', sql`${t.policyVersion} > 0`),
  check('harvester_public_command_expected_ck', sql`${t.expectedSourceId} IS NULL OR ${t.expectedSourceId} <> ${t.id}`)]);

/** One pending obligation per wallet/base. Only a proven immutable closure can
 * release this head; the original source and its receipts remain retained. */
export const harvesterSourceHeads = pgTable('harvester_source_heads', {
  wallet: text('wallet').primaryKey(), baseId: uuid('base_id').notNull().unique(), sourceId: uuid('source_id').notNull().unique(),
}, t => [foreignKey({ columns: [t.sourceId, t.wallet, t.baseId], foreignColumns: [harvesterSources.id, harvesterSources.actorWallet, harvesterSources.baseId], name: 'harvester_head_original_source_fk' })]);

/** A dedicated accounting lock, never a player lock after a locked base. */
export const harvesterWalletLocks = pgTable('harvester_wallet_locks', {
  wallet: text('wallet').primaryKey(),
});
/** Immutable decisions for every processed cadence, including capped zeroes.
 * Indexed history is authoritative daily usage and resource-lineage carry. */
export const harvesterEvents = pgTable('harvester_events', {
  sourceId: uuid('source_id').notNull().references(() => harvesterSources.id),
  ordinal: integer('ordinal').notNull(),
  actorWallet: text('actor_wallet').notNull().references(() => harvesterWalletLocks.wallet),
  walletSequence: bigint('wallet_sequence', { mode: 'bigint' }).notNull(),
  policyVersion: integer('policy_version').notNull(),
  resourceId: text('resource_id').notNull(),
  earnedAt: timestamp('earned_at', { withTimezone: true }).notNull(),
  utcDay: timestamp('utc_day', { withTimezone: true }).notNull(),
  taxPolicyVersion: integer('tax_policy_version').notNull(),
  taxBasisPoints: integer('tax_basis_points').notNull(),
  islandPoolBps: integer('island_pool_bps').notNull(),
  gross: bigint('gross', { mode: 'bigint' }).notNull(),
  net: bigint('net', { mode: 'bigint' }).notNull(),
  tax: bigint('tax', { mode: 'bigint' }).notNull(),
  carryBefore: bigint('carry_before', { mode: 'bigint' }).notNull(),
  carryAfter: bigint('carry_after', { mode: 'bigint' }).notNull(),
  // No player FK: accepted output follows the original stable base.
  custodyWallet: text('custody_wallet').notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
}, t => [primaryKey({ columns: [t.sourceId, t.ordinal] }),
  unique('harvester_event_wallet_sequence_uq').on(t.actorWallet, t.walletSequence),
  index('harvester_event_day_idx').on(t.actorWallet, t.policyVersion, t.utcDay),
  index('harvester_event_carry_idx').on(t.actorWallet, t.resourceId, t.taxPolicyVersion, t.walletSequence),
  check('harvester_event_amount_ck', sql`${t.gross} >= 0 AND ${t.net} >= 0 AND ${t.tax} >= 0 AND ${t.net}::numeric + ${t.tax}::numeric = ${t.gross}::numeric`),
]);
export const harvesterEntries = pgTable('harvester_entries', {
  sourceId: uuid('source_id').notNull(), ordinal: integer('ordinal').notNull(),
  bucket: text('bucket').$type<'issued' | 'base_stock' | 'island_pool'>().notNull(),
  delta: bigint('delta', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.sourceId, t.ordinal, t.bucket] }),
  foreignKey({ columns: [t.sourceId, t.ordinal], foreignColumns: [harvesterEvents.sourceId, harvesterEvents.ordinal], name: 'harvester_entry_event_fk' }),
  check('harvester_entry_bucket_ck', sql`${t.bucket} IN ('issued','base_stock','island_pool')`),
]);

/** Frozen source cutoff. No rewriting the original term/lease or incomplete
 * cadence into inventory; processedOrdinal proves every completed candidate. */
export const harvesterSourceClosures = pgTable('harvester_source_closures', {
  sourceId: uuid('source_id').primaryKey().references(() => harvesterSources.id),
  cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
  reason: text('reason').notNull(),
  custodyWallet: text('custody_wallet').notNull(),
  processedOrdinal: integer('processed_ordinal').notNull(),
});

/** First accepted finalized custody loss, retained even if owed output cannot
 * fit yet. Copied observation identity survives mutable ownership projections. */
export const harvesterCustodyStops = pgTable('harvester_custody_stops', {
  sourceId: uuid('source_id').primaryKey().references(() => harvesterSources.id),
  cutoffAt: timestamp('cutoff_at', { withTimezone: true }).notNull(),
  custodyWallet: text('custody_wallet').notNull(),
  observationId: bigint('observation_id', { mode: 'bigint' }).notNull(),
  assetId: text('asset_id').notNull(),
  observedOwner: text('observed_owner').notNull(),
  observedSlot: bigint('observed_slot', { mode: 'bigint' }).notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  observationStatus: text('observation_status').notNull(),
  observationSource: text('observation_source').notNull(),
  auditHash: text('audit_hash').notNull(),
});

// M47 §5 public release history (0500): see releaseHistorySchema.ts.
export * from './releaseHistorySchema';

/** M45 §2 native update channel (0170). Written only by the operator CLI
 * (native/updateChannelCli.ts); DB triggers refuse DELETE/TRUNCATE and every
 * UPDATE except tester->stable, pending->published and mandatory false->true.
 * size_bytes is bounded at 300 MiB, so number mode is exact. */
export const nativeUpdateChannel = pgTable('native_update_channel', {
  versionCode: integer('version_code').primaryKey(),
  versionName: text('version_name').notNull(),
  sourceCommit: text('source_commit').notNull(),
  apkPath: text('apk_path').notNull().unique('native_update_channel_apk_path_key'),
  sha256: text('sha256').notNull().unique('native_update_channel_sha256_key'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  signerSha256: text('signer_sha256').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  storeStatus: text('store_status').notNull().default('pending'),
  channel: text('channel').notNull(),
  mandatory: boolean('mandatory').notNull().default(false),
  notesUrl: text('notes_url'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check('native_update_channel_version_code_ck', sql`${t.versionCode} > 0 AND ${t.versionCode} <= 999999`),
  check('native_update_channel_version_name_ck', sql`${t.versionName} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'`),
  check('native_update_channel_source_commit_ck', sql`${t.sourceCommit} ~ '^[0-9a-f]{40}$'`),
  check('native_update_channel_sha256_ck', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
  check('native_update_channel_signer_ck', sql`${t.signerSha256} ~ '^[0-9a-f]{64}$'`),
  check('native_update_channel_apk_path_ck', sql`${t.apkPath} = '/native/releases/' || ${t.versionCode} || '-' || ${t.sha256} || '.apk'`),
  check('native_update_channel_size_ck', sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 314572800`),
  check('native_update_channel_store_status_ck', sql`${t.storeStatus} IN ('pending','published')`),
  check('native_update_channel_channel_ck', sql`${t.channel} IN ('tester','stable')`),
  check('native_update_channel_notes_url_ck', sql`${t.notesUrl} IS NULL OR ${t.notesUrl} ~ '^https://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'`),
]);
// Phase E mining evidence: additive, no allocation or runtime authority.
export * from './miningActivitySchema';
export * from './miningIngotSchema';
export * from './miningFreeCohortSchema';
export * from './miningFreeShadowSchema';
export * from './miningFreeBaseSchema';
export * from './miningWalletExperienceSchema';
export * from './miningDevelopmentSchema';
export * from './miningFreeGemsSchema';
export * from './miningRosterSchema';

/** Phase E custody fence. OPEN preserves legacy admission; activation and
 * money-table trigger migration remain separately held under WORKING-RULES S5. */
export const keepCustodyCutoverState = pgTable('keep_custody_cutover_state', {
  id: boolean('id').primaryKey().default(true),
  phase: text('phase').notNull().default('open'),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [check('keep_custody_cutover_state_id_check', sql`${t.id}`),
  check('keep_custody_cutover_state_phase_check', sql`${t.phase} IN ('open','fenced','withdrawals_closed','frozen','retired')`)]);

/** Phase E immutable operator journal. The initial writer admits only local
 * L1 fixtures; it confers no production retirement authority. */
export const keepCustodyJournal = pgTable('keep_custody_journal', {
  id: uuid('id').primaryKey(),
  operation: text('operation').notNull().unique(),
  scope: text('scope').notNull(),
  subcommand: text('subcommand').notNull(),
  dryRun: boolean('dry_run').notNull(),
  inputHash: text('input_hash').notNull(),
  operatorName: text('operator_name').notNull(),
  databaseName: text('database_name').notNull(),
  request: jsonb('request').notNull(),
  receipts: jsonb('receipts').notNull(),
  sourceEvidence: jsonb('source_evidence').notNull().default({}),
  /** Complete expired/unknown KEEP intents observed under the freeze barrier;
   * only these immutable sources can back the fixture late-credit executor. */
  lateDepositSources: jsonb('late_deposit_sources').notNull().default([]),
  /** v2 F authority is tied to the actual inserting transaction, never a GUC. */
  custodySourceXid: customType<{ data: string }>({ dataType: () => 'xid8' })('custody_source_xid'),
  beforeState: jsonb('before_state').notNull(),
  afterState: jsonb('after_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone:true }).notNull().defaultNow(),
}, t => [check('keep_custody_journal_input_hash_check', sql`${t.inputHash} ~ '^[a-f0-9]{64}$'`)]);

/** Immutable per-KEEP-leg custody retirement proof; original reward remains. */
export const mailKeepRetirements = pgTable('mail_keep_retirements', {
  attachmentId: uuid('attachment_id').primaryKey().references(() => mailAttachments.id),
  messageId: uuid('message_id').notNull().references(() => mailMessages.id),
  recipientWallet: text('recipient_wallet').notNull().references(() => players.wallet),
  amount: bigint('amount', { mode:'bigint' }).notNull(),
  originalExpiresAt: timestamp('original_expires_at', { withTimezone:true }).notNull(),
  ledgerTxnId: uuid('ledger_txn_id').notNull().references(() => ledgerTransactions.id),
  journalId: uuid('journal_id').notNull().references(() => keepCustodyJournal.id),
  receipt: jsonb('receipt').notNull(),
});

/** D153.186 private prospective custody observation/window evidence. */
export * from './keepCustodySourceSchema';
