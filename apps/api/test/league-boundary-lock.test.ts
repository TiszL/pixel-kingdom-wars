import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { recoverMissingLeagueCloses } from '../src/game/leagues';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const databaseName = `shardkeep_league_lock_${randomUUID().replaceAll('-', '')}_test`;
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const databaseUrl = new URL(ADMIN_DATABASE_URL);
databaseUrl.pathname = `/${databaseName}`;
const clients: Array<ReturnType<typeof postgres>> = [];
let baseA = '';
let baseB = '';

function client() {
  const sql = postgres(databaseUrl.toString(), {
    max: 1,
    onnotice: () => {},
    connection: { 'shardkeep.deed_economy_writer': 'v1' },
  });
  clients.push(sql);
  return sql;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label = 'operation', ms = 1_500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`lock test timed out: ${label}`)), ms,
    )),
  ]);
}

beforeAll(async () => {
  if (!/^shardkeep_league_lock_[0-9a-f]{32}_test$/.test(databaseName)) {
    throw new Error('refusing unexpected lock-test database name');
  }
  await admin.unsafe(`CREATE DATABASE ${databaseName}`);
  const migrated = createDb(databaseUrl.toString(), { max: 1 });
  try {
    await migrate(migrated.db, { migrationsFolder: MIGRATIONS });
    const walletA = `lock-a-${randomUUID()}`;
    const walletB = `lock-b-${randomUUID()}`;
    await migrated.sql`INSERT INTO players (wallet) VALUES (${walletA}), (${walletB})`;
    const rows = await migrated.sql<{ id: string }[]>`
      INSERT INTO bases (owner_wallet, deed_asset_id, land_paid_at)
      VALUES (${walletA}, ${`lock-deed-${randomUUID()}`}, now()),
             (${walletB}, ${`lock-deed-${randomUUID()}`}, now())
      RETURNING id
    `;
    baseA = rows[0]!.id;
    baseB = rows[1]!.id;
    await migrated.sql`INSERT INTO base_profiles (base_id) VALUES (${baseA}), (${baseB})`;
    await migrated.sql`
      INSERT INTO league_reward_activations
        (singleton, enabled_at, configured_start_week, first_complete_week)
      VALUES (
        1, now(),
        date_trunc('week', now() AT TIME ZONE 'UTC')::date,
        date_trunc('week', now() AT TIME ZONE 'UTC')::date
      )
    `;
    await migrated.sql`
      INSERT INTO league_week_closures
        (week, closes_at, effective_start_week, feature_enabled_at_close,
         rewards_enabled, participant_count, excluded_count, rewarded_count, frozen_at)
      VALUES (
        date_trunc('week', now() AT TIME ZONE 'UTC')::date - 7,
        (date_trunc('week', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
        date_trunc('week', now() AT TIME ZONE 'UTC')::date,
        true, false, 0, 0, 0, now()
      )
    `;
  } finally {
    await migrated.sql.end();
  }
});

afterAll(async () => {
  await Promise.all(clients.map((sql) => sql.end()));
  await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin.end();
});

describe('league Monday advisory fence lock order', () => {
  it('allows two mutation shared locks while excluding the close', async () => {
    const a = client();
    const b = client();
    const close = client();
    const aReady = deferred();
    const bReady = deferred();
    const releaseA = deferred();
    const releaseB = deferred();
    const txA = a.begin(async (tx) => {
      await tx`UPDATE base_profiles SET trophies = trophies + 1 WHERE base_id = ${baseA}`;
      aReady.resolve();
      await releaseA.promise;
    });
    const txB = b.begin(async (tx) => {
      await tx`UPDATE base_profiles SET trophies = trophies + 1 WHERE base_id = ${baseB}`;
      bReady.resolve();
      await releaseB.promise;
    });
    await within(Promise.all([aReady.promise, bReady.promise]), 'shared mutations ready');
    const [whileBoth] = await close<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(7446001) AS acquired
    `;
    expect(whileBoth!.acquired).toBe(false);
    releaseA.resolve();
    await within(txA, 'first shared mutation commit');
    const [whileOne] = await close<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(7446001) AS acquired
    `;
    expect(whileOne!.acquired).toBe(false);
    releaseB.resolve();
    await within(txB, 'second shared mutation commit');
    const [afterBoth] = await close<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(7446001) AS acquired
    `;
    expect(afterBoth!.acquired).toBe(true);
  });

  it('aborts a prelocked mutation instead of deadlocking close advisory against its row', async () => {
    const mutation = client();
    const close = client();
    const rowLocked = deferred();
    const attemptUpdate = deferred();
    const closeOwnsAdvisory = deferred();
    const mutationResult = mutation.begin(async (tx) => {
      await tx`SELECT base_id FROM base_profiles WHERE base_id = ${baseA} FOR UPDATE`;
      rowLocked.resolve();
      await attemptUpdate.promise;
      await tx`UPDATE base_profiles SET trophies = trophies + 1 WHERE base_id = ${baseA}`;
    }).then(() => null, (error: { code?: string }) => error);
    await within(rowLocked.promise, 'mutation row prelocked');
    const closeResult = close.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7446001)`;
      closeOwnsAdvisory.resolve();
      attemptUpdate.resolve();
      await tx`SELECT base_id FROM base_profiles WHERE base_id = ${baseA} FOR UPDATE`;
    });
    await within(closeOwnsAdvisory.promise, 'close owns advisory');
    const error = await within(mutationResult, 'mutation abort');
    expect(error?.code).toBe('40001');
    await within(closeResult, 'close row lock');
  });

  it('walks earliest missing weeks after a multi-week outage and never backfills them', async () => {
    const conn = createDb(databaseUrl.toString(), { max: 4 });
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const [clock] = await conn.sql<{ week: string }[]>`
        SELECT date_trunc('week', now() AT TIME ZONE 'UTC')::date::text AS week
      `;
      const opening = new Date(`${clock!.week}T00:00:00.000Z`);
      const restart = new Date(opening.getTime() + 22 * 86_400_000);
      const recovered = await recoverMissingLeagueCloses(conn.db, restart, {
        enabled: true,
        startWeek: clock!.week,
      });
      expect(recovered).toHaveLength(3);
      expect(recovered.every((close) => close.rewardsEnabled === false)).toBe(true);
      const terminal = await conn.sql<{
        week: string; feature_enabled_at_close: boolean; rewards_enabled: boolean;
        failure_reason: string | null;
      }[]>`
        SELECT week::text, feature_enabled_at_close, rewards_enabled, failure_reason
        FROM league_week_closures
        WHERE week >= ${clock!.week}::date
        ORDER BY week
      `;
      expect(terminal).toHaveLength(3);
      expect(terminal.every((row) => row.feature_enabled_at_close
        && !row.rewards_enabled && row.failure_reason === 'authority_snapshot_unavailable')).toBe(true);
      const [facts] = await conn.sql<{ snapshots: number; receipts: number }[]>`
        SELECT
          (SELECT count(*)::int FROM league_week_base_snapshots) AS snapshots,
          (SELECT count(*)::int FROM base_league_entitlements) AS receipts
      `;
      expect(facts).toEqual({ snapshots: 0, receipts: 0 });
      expect(await recoverMissingLeagueCloses(conn.db, restart, {
        enabled: true, startWeek: clock!.week,
      })).toEqual([]);
      await conn.sql`UPDATE base_profiles SET trophies = trophies + 1 WHERE base_id = ${baseA}`;
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
      await conn.sql.end();
    }
  });

  it('terminally closes an activated missed boundary after either kill switch turns off', async () => {
    const conn = createDb(databaseUrl.toString(), { max: 4 });
    const prior = process.env['MULTI_BASE_ENABLED'];
    try {
      for (const flags of [
        { multiBase: 'true', rewards: false },
        { multiBase: 'false', rewards: true },
      ] as const) {
        const [state] = await conn.sql<{ latest: string; first_week: string }[]>`
          SELECT
            (SELECT max(week)::text FROM league_week_closures) AS latest,
            (SELECT first_complete_week::text FROM league_reward_activations
             WHERE singleton = 1) AS first_week
        `;
        const latest = new Date(`${state!.latest}T00:00:00.000Z`);
        const opening = new Date(latest.getTime() + 7 * 86_400_000);
        const missed = new Date(opening.getTime() + 7 * 86_400_000);
        const openingWeek = opening.toISOString().slice(0, 10);
        const missedWeek = missed.toISOString().slice(0, 10);
        const missedAt = missed.toISOString();
        await conn.sql`
          INSERT INTO league_week_closures
            (week, closes_at, effective_start_week, feature_enabled_at_close,
             rewards_enabled, participant_count, excluded_count, rewarded_count, frozen_at)
          VALUES (
            ${openingWeek}::date, ${missedAt}::timestamptz, ${state!.first_week}::date,
            true, true, 0, 0, 0, ${missedAt}::timestamptz
          )
        `;

        process.env['MULTI_BASE_ENABLED'] = flags.multiBase;
        const restart = new Date(missed.getTime() + 7 * 86_400_000 + 20 * 60_000);
        const recovered = await recoverMissingLeagueCloses(conn.db, restart, {
          enabled: flags.rewards,
          startWeek: state!.first_week,
        });
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).toMatchObject({
          week: missedWeek, rewardsEnabled: false, participants: 0, frozen: 0,
        });
        const [closed] = await conn.sql<{
          feature_enabled_at_close: boolean; rewards_enabled: boolean;
          failure_reason: string | null;
        }[]>`
          SELECT feature_enabled_at_close, rewards_enabled, failure_reason
          FROM league_week_closures WHERE week = ${missedWeek}::date
        `;
        expect(closed).toEqual({
          feature_enabled_at_close: false,
          rewards_enabled: false,
          failure_reason: null,
        });
        const [facts] = await conn.sql<{ snapshots: number; receipts: number }[]>`
          SELECT
            (SELECT count(*)::int FROM league_week_base_snapshots
             WHERE week = ${missedWeek}::date) AS snapshots,
            (SELECT count(*)::int FROM base_league_entitlements
             WHERE week = ${missedWeek}::date) AS receipts
        `;
        expect(facts).toEqual({ snapshots: 0, receipts: 0 });
      }
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
      await conn.sql.end();
    }
  });

  it('watchdog terminally closes after DB/RPC stays unavailable through 00:15', async () => {
    const conn = createDb(databaseUrl.toString(), { max: 4 });
    const prior = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const [state] = await conn.sql<{ latest: string; first_week: string }[]>`
        SELECT
          (SELECT max(week)::text FROM league_week_closures) AS latest,
          (SELECT first_complete_week::text FROM league_reward_activations
           WHERE singleton = 1) AS first_week
      `;
      const latest = new Date(`${state!.latest}T00:00:00.000Z`);
      const opening = new Date(latest.getTime() + 7 * 86_400_000);
      const missed = new Date(opening.getTime() + 7 * 86_400_000);
      const openingWeek = opening.toISOString().slice(0, 10);
      const missedWeek = missed.toISOString().slice(0, 10);
      const missedAt = missed.toISOString();
      await conn.sql`
        INSERT INTO league_week_closures
          (week, closes_at, effective_start_week, feature_enabled_at_close,
           rewards_enabled, participant_count, excluded_count, rewarded_count, frozen_at)
        VALUES (
          ${openingWeek}::date, ${missedAt}::timestamptz, ${state!.first_week}::date,
          true, true, 0, 0, 0, ${missedAt}::timestamptz
        )
      `;

      // No invocation occurs from 00:00 through 00:15: this represents the DB
      // outage. The still-running five-minute repeat reaches the service at
      // 00:20; missing authority is terminal now, never partially fabricated.
      const watchdogAt = new Date(missed.getTime() + 7 * 86_400_000 + 20 * 60_000);
      const recovered = await recoverMissingLeagueCloses(conn.db, watchdogAt, {
        enabled: true, startWeek: state!.first_week,
      });
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        week: missedWeek, rewardsEnabled: false, participants: 0, frozen: 0,
      });
      const [closed] = await conn.sql<{
        feature_enabled_at_close: boolean; rewards_enabled: boolean;
        failure_reason: string | null;
      }[]>`
        SELECT feature_enabled_at_close, rewards_enabled, failure_reason
        FROM league_week_closures WHERE week = ${missedWeek}::date
      `;
      expect(closed).toEqual({
        feature_enabled_at_close: true,
        rewards_enabled: false,
        failure_reason: 'authority_snapshot_unavailable',
      });
      expect(await recoverMissingLeagueCloses(conn.db, watchdogAt, {
        enabled: true, startWeek: state!.first_week,
      })).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = prior;
      await conn.sql.end();
    }
  });
});
