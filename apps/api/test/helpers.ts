import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { asc, eq, inArray } from 'drizzle-orm';
import { parcelCell, patchCount } from '@shardkeep/shared/parcelGrid';
import { countryIdOfCell, countryOfId } from '@shardkeep/shared/globe';
import { EARTH_COUNTRIES_FINE } from '@shardkeep/shared/earthCountriesFine';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import type { Config } from '../src/config';
import { createDb, type DbOrTx, type DbTx } from '../src/db/client';
import { bases, baseSlots, players, plots, valleys } from '../src/db/schema';
import { NO_SOVEREIGN_A3 } from '../src/lib/globeGeo';
import { isSiteIdCollision } from '../src/game/world';
import {
  bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction, type PostedTransaction,
} from '../src/ledger';
import { TEST_DATABASE_URL } from './db-url';

// Test workers exercise the real encryption/HMAC paths with an explicit,
// deterministic non-production key. Production has no fallback (config.test.ts).
process.env['TWOFA_ENCRYPTION_KEYS'] ??= 'test-v1:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';

/** Pool sized for the concurrency property tests. */
export function connectTestDb() {
  // Migration 0077 intentionally blocks every retired wallet-gameplay writer
  // after activation. Legacy fixture suites opt into its doubly gated escape:
  // this exact session GUC AND current_database()='shardkeep_test'.
  return createDb(TEST_DATABASE_URL, { max: 20, legacyTestEscape: true });
}

export const TEST_CONFIG: Config = {
  MINING_CLAIM_ORDERED_ENABLED: 'false',
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-test-secret-test-secret!',
  LANDING_ORIGINS: ['https://pixelkingdomwars.com', 'https://www.pixelkingdomwars.com'],
  WEB_ORIGIN: ['http://localhost:5173'],
  PORT: 0,
  HOST: '127.0.0.1',
  NODE_ENV: 'test',
  RATE_LIMIT_MAX: 300,
  RATE_LIMIT_WINDOW_MS: 60_000,
  SOLANA_CLUSTER: 'devnet',
  RPC_RELAY_ENABLED: 'false',
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  REDIS_URL: process.env.TEST_REDIS_URL ?? 'redis://localhost:6380',
  ENABLE_WORKERS: 'false',
  // M33 push is OFF here like the config default; the notification suites
  // build their own app with the flag on and a test VAPID trio.
  PUSH_NOTIFICATIONS_ENABLED: 'false',
  FCM_NOTIFICATIONS_ENABLED: 'false',
  MINE_FULL_NOTIFICATIONS_ENABLED: 'false',
  TOTP_RECOVERY_ENABLED: 'true',
  SOCIAL_TOKEN_LOGIN_ENABLED: 'false',
  DEV_LOGIN: 'false',
  // Matches the config default: the free tier ships DARK until the owner flips
  // it, so the suite keeps asserting today's paywall behaviour. Suites that
  // exercise free onboarding set process.env.FREE_ONBOARDING before buildApp —
  // the flag is read from the live env (config.freeOnboardingEnabled), not here.
  FREE_ONBOARDING: 'false',
  MULTI_BASE_ENABLED: 'false',
  FANTASY_WORLD_ENABLED: 'false',
  PHASE_E_CATALOG_ENABLED: 'false',
  // D-152 Gems ship DARK (E2-GEMS-CONTRACT §4); the Gems suites flip the live
  // env (config.gemsEnabled) per test, never this static config.
  GEMS_ENABLED: 'false',
  GEMS_WALLET_BUY_ENABLED: 'false',
  DEVNET_WELCOME_GEMS_ENABLED: 'false',
  // Phase E dark buildings + Workshop refining (E2-WORKSHOP-CONTRACT §6); the
  // Workshop suite flips the live env (config.forgeIngotsEnabled) per test.
  PHASE_E_BUILDINGS_ENABLED: 'false',
  PHASE_E_ART_ENABLED: 'false',
  PHASE_E_MINING_ENABLED: 'false',
  // Match the identity/publication schema defaults; fixture construction grants no admission.
  PHASE_E_KEEP_IDENTITY: 'disabled',
  MINING_PUBLICATION_TESTER_STACK: 'false',
  MINING_PUBLICATION_RECOVERY_ENABLED: 'false',
  MINING_PUBLICATION_JOB_ENABLED: 'false',
  PHASE_E_SEEKER_ENABLED: 'false',
  PHASE_E_VEHICLES_ENABLED: 'false',
  PHASE_E_CHARTER_ENABLED: 'false',
  KEEP_EQUIPMENT_MARKET_ENABLED: 'false',
  FORGE_INGOTS_ENABLED: 'false',
  ORDINARY_CRAFTING_ENABLED: 'false',
  STARTER_EXPEDITIONS_ENABLED: 'false',
  HARVESTERS_ENABLED: 'false',
  LIVE_RAID_V2_ENABLED: 'false',
  RAID_EVENTS_ENABLED: 'false',
  // M45 §1 update channel ships DARK; its suites build their own app with it on.
  NATIVE_UPDATE_CHANNEL_ENABLED: 'false',
  // D-NEXT native new-world kill switch ships ON (its default).
  NATIVE_WORLD_V2_ENABLED: 'true',
  LEAGUE_REWARDS_ENABLED: 'false',
  LEAGUE_REWARD_START_WEEK: '2026-09-07',
  DEVNET_FAUCET_ENABLED: 'false',
  MAIL_DELIVERY_ENABLED: 'false',
  MAINNET_COMMUNITY_KEEP_MAIL_ENABLED: 'false',
  // M23 a17: clans are COMING SOON — create/join routes refuse while reads,
  // leave and the chest settle continue. Service-level suites are unaffected.
  CLANS_ENABLED: 'false',
  // Runtime rollout authority for SIM6's dark attacker roster. Default-off in
  // every broad API suite; focused feature tests opt in through process.env.
  DARK_ATTACKER_ROSTER_ENABLED: 'false',
  // Matches the D-059 config default: gear combat ships ON. The live gate is
  // read from process.env (config.heroGearCombatEnabled), not from here — the
  // gate-specific suites (raids/world) pin process.env around their own cases.
  HERO_GEAR_COMBAT_ENABLED: 'true',
  // Vend ON in tests: the rail's coverage (pricing, credit, idempotency)
  // must run; the fail-closed default is an ops posture, not a test one.
  KEEP_VEND_ENABLED: 'true',
  // (There is no PARCEL_CELLS here any more — D6, 2026-08-10: it gated nothing, so
  // it was deleted rather than left in the config as a rollback path that does
  // nothing. At deletion time no API response carried a cell or country; the
  // authenticated deed map now intentionally exposes frozen parcel identity;
  // the removed flag still would not be the privacy boundary for those routes.)
  // Matches the config default. The deed's Country/Tile traits are read from the
  // live env inside buildDeedMetadata (config.deedLocationV2Enabled), not from
  // here, so deed.test.ts sets process.env.DEED_LOCATION_V2 around the tests that
  // exercise them — and every other suite keeps asserting the pre-P6 trait set.
  DEED_LOCATION_V2: 'false',
  WITHDRAWAL_SIGNER_MODE: 'legacy',
  WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'file',
  WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'false',
  WITHDRAWAL_PAYOUT_POLL_MS: 10_000,
  DEED_MINT_RECONCILE_POLL_MS: 60_000,
  CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP: 'false',
  WITHDRAWALS_ENABLED: 'true',
};

/**
 * A base the way every production writer creates one (deed.ts, deposits.ts,
 * baseOwnership.ts, freeBasePurchase.ts): the `bases` row AND its active
 * `base_slots` row for the owner, in one step. The slot is the owner's next
 * free one, under the owner's player-row lock, so a fixture wallet may hold
 * several bases and concurrent callers cannot pick the same slot.
 *
 * WHY (2026-10-10, D153.235 / D153.238): migrations 0284 and 0286 freeze the
 * defender's fleet presentation in `raids` AFTER INSERT triggers and refuse a
 * PvP raid (RAID_STARTER/ADVANCED_CAPTURE_SOURCE) unless the defender base is
 * active AND has an active slot for its owner. A slotless base is a state no
 * production writer reaches, so raid fixtures must not invent one.
 */
export async function insertActiveTestBase(
  db: DbOrTx, values: typeof bases.$inferInsert,
): Promise<typeof bases.$inferSelect> {
  return db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, values.ownerWallet)).for('update');
    const [base] = await tx.insert(bases).values(values).returning();
    const held = await tx.select({ slot: baseSlots.slot }).from(baseSlots)
      .where(eq(baseSlots.wallet, values.ownerWallet));
    const slot = Math.max(0, ...held.map((row) => row.slot)) + 1;
    await tx.insert(baseSlots).values({ wallet: values.ownerWallet, slot, baseId: base!.id, active: true });
    return base!;
  });
}

/** Random base58 "wallet" (not a real keypair) for ledger fixtures. */
export function randomWallet(): string {
  return bs58.encode(randomBytes(32));
}

/** Inserts a players row + its KEEP account; returns ids. */
export async function createTestPlayer(db: ReturnType<typeof connectTestDb>['db']) {
  const wallet = randomWallet();
  await db.insert(players).values({ wallet });
  const account = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  return { wallet, keepAccountId: account.id };
}

/**
 * Runs `work` in a transaction that took the wallet's players row FOR UPDATE
 * first, as every key-claiming command does, and holds it uncommitted until the
 * returned `finish` is awaited. Receipt tests use it to prove a reader waits
 * for a command in flight rather than reading past its uncommitted key claim.
 */
export async function holdPlayerLock(
  db: ReturnType<typeof connectTestDb>['db'], wallet: string,
  work: (tx: DbTx) => Promise<unknown>,
  outcome: 'commit' | 'rollback',
): Promise<() => Promise<void>> {
  let claimed!: () => void; let release!: () => void;
  const ready = new Promise<void>((resolve) => { claimed = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const done = db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet)).for('update');
    await work(tx); claimed(); await held;
    if (outcome === 'rollback') throw new Error('held transaction rollback');
  }).catch((error: Error) => { if (error.message !== 'held transaction rollback') throw error; });
  await Promise.race([ready, done]);
  return async () => { release(); await done; };
}
/** True when `pending` settles within `ms`; a reader blocked on a lock does not. */
export function settlesWithin(pending: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([pending.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

/**
 * TEST-ONLY KEEP faucet for arbitrary fixture balances.
 *
 * Production rewards must debit their finite named allocation through
 * `rewardKeep`. Fixtures are not rewards: charging them to `emission_pool`
 * makes unrelated suites consume the finite live allocation and eventually turns
 * test order/concurrency into an InsufficientFundsError. `keep_genesis` is the
 * ledger's mint-dimension account and is explicitly allowed to go negative, so
 * it isolates setup volume without weakening any production pool invariant.
 */
export async function fundTestKeep(
  db: DbOrTx,
  wallet: string,
  amount: bigint,
  type: string,
  idempotencyKey: string,
  metadata?: Record<string, unknown>,
): Promise<PostedTransaction> {
  if (amount <= 0n) throw new RangeError(`fundTestKeep: amount must be positive, got ${amount}`);
  const sys = await bootstrapSystemAccounts(db);
  const player = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  return postTransaction(db, {
    idempotencyKey,
    type,
    entries: [
      { account: sys.keep_genesis, delta: -amount },
      { account: player.id, delta: amount },
    ],
    metadata: { wallet, testFixture: true, ...metadata },
  });
}

/**
 * A valley WITH A SITE (P5). Every suite that seeds its own isolated valley needs
 * one, because `valleys.site_id` is NOT NULL + UNIQUE: it is the frozen place the
 * globe puts that valley, and a place two valleys share is the bug the constraint
 * exists to prevent.
 *
 * Allocate the lowest unused Earth site, mirroring `createValley` (game/world.ts).
 * Land-purchase tests may legitimately create a sparse high site first; using
 * `max(site_id) + 1` would then strand every valid gap and eventually invent site
 * 120+. The retry is still required because concurrent callers can choose the
 * same gap and the unique constraint must make one retry.
 */
export async function createTestValley(
  db: ReturnType<typeof connectTestDb>['db'],
  values: { name: string; createdAt?: Date },
): Promise<{ id: string; siteId: number }> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const used = await db.select({ siteId: valleys.siteId }).from(valleys)
      .where(eq(valleys.planetId, 0)).orderBy(asc(valleys.siteId));
    let siteId = 0;
    for (const row of used) {
      if (row.siteId < siteId) continue;
      if (row.siteId === siteId) siteId++;
      else break;
    }
    if (siteId >= patchCount()) throw new Error('createTestValley: Earth has no free site_id');
    try {
      const [v] = await db.insert(valleys)
        // Bare fixture valleys have no production PvE camp seed. Backdate them
        // by default so `ensurePlotAssigned` cannot mistake one for the newest
        // production cohort; tests that exercise newest-valley behavior opt in
        // with an explicit timestamp.
        .values({ createdAt: new Date('2000-01-01T00:00:00Z'), ...values, siteId, planetId: 0 })
        .returning({ id: valleys.id, siteId: valleys.siteId });
      return v!;
    } catch (err) {
      // The SAME predicate production uses — another suite took this site id.
      // Anything else is a real fault and must fail the test loudly.
      if (!isSiteIdCollision(err)) throw err;
    }
  }
  throw new Error('createTestValley: could not claim a free site_id');
}

/** The `ADM0_A3` of a fine cell, the way the WRITE path derives it before freezing
 *  it (lib/globeGeo.ts's `countryA3`): `'ZZZ'` for ground with no sovereign. */
export function countryA3OfCell(cell: number): string {
  const id = countryIdOfCell(EARTH_FINE, EARTH_COUNTRIES_FINE, cell);
  return id === 0 ? NO_SOVEREIGN_A3 : countryOfId(EARTH_COUNTRIES_FINE, id)?.a3 ?? NO_SOVEREIGN_A3;
}

/** A fixture plot — the same shape the suites always passed to `insert(plots)`. */
export interface PlotSeed {
  valleyId: string;
  x: number;
  y: number;
  playerWallet?: string;
  /** Stable-base fixtures must name identity explicitly once a wallet owns more than one. */
  baseId?: string;
}

/**
 * Seed plots DIRECTLY, with their real Earth cells AND their frozen country (P5,
 * and `country_a3` since D1).
 *
 * Every suite that seats a player without going through `ensurePlotAssigned`
 * needs this, because `plots.earth_cell` is NOT NULL + UNIQUE since migration
 * 0053: the parcel's 0.5° Earth cell is a STORED fact, not a derivation, because
 * the country on it goes on the deed and a deed cannot be recalled. A fixture
 * that invented its own cell would be seeding land that does not exist, so the
 * value comes from the very same `parcelCell` production writes.
 *
 * TWO WAYS THIS FAILS, AND BOTH ARE TELLING THE TRUTH:
 *  - "Earth is full" — all `patchCount()` = 120 Earth sites are occupied. Earth
 *    really does seat only 120 valleys; the answer is fewer live valleys per run,
 *    not a fake cell.
 *  - "that tile is a PvE camp" — camps hold a grid tile but are not deeded land
 *    (EARTH-TILES-PLAN R2), so a plot cannot be seeded on one. Pick another tile.
 *
 * NOT `globeGeo()`: suites that install a fake planet through `setGlobeGeo` still
 * seed real rows into the real `plots` table, so the cell must come from Earth
 * regardless of which planet the aggregation under test is pretending to use.
 *
 * THE COUNTRY IS DERIVED HERE ONCE, EXACTLY AS PRODUCTION DERIVES IT AT PLOT
 * CREATION — from the cell, through the fine mask + fine country index — and then
 * stored. Fixtures may compute it; the DEED may not. That asymmetry is the point of
 * D1: freezing happens on the write path, and every read is a column.
 */
export async function seedPlots(
  db: ReturnType<typeof connectTestDb>['db'], rows: readonly PlotSeed[],
): Promise<void> {
  if (rows.length === 0) return;
  const ids = [...new Set(rows.map((r) => r.valleyId))];
  const vs = await db.select({ id: valleys.id, siteId: valleys.siteId })
    .from(valleys).where(inArray(valleys.id, ids));
  const site = new Map(vs.map((v) => [v.id, v.siteId]));
  await db.insert(plots).values(rows.map((r) => {
    const siteId = site.get(r.valleyId);
    if (siteId === undefined) throw new Error(`seedPlots: no valley ${r.valleyId}`);
    const earthCell = parcelCell(siteId, r.x, r.y);
    return { ...r, earthCell, countryA3: countryA3OfCell(earthCell) };
  }));
}

/** `seedPlots` for one row. */
export async function seedPlot(
  db: ReturnType<typeof connectTestDb>['db'], row: PlotSeed,
): Promise<void> {
  await seedPlots(db, [row]);
}

/** Legacy fixture reads must prove their required address after dual-address schema. */
export function requiredFixture<T>(value: T, label = 'legacy fixture field'): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`Missing ${label}`);
  return value;
}
