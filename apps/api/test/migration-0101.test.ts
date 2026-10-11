/** M34 rollout proof: all 103 migrations install fresh and upgrade 0100 without
 * changing existing V1 marches. Mine bootstrap is exact and resumable; V2 clock
 * constraints reject malformed state at the PostgreSQL boundary. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMiningQuota, MINING, RAID_RULES } from '@shardkeep/shared';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { classifyMineFullNotificationBootstrap, mineFullRef } from '../src/notifications';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const PREFIX = 'shardkeep_migration_0101_';

interface Journal { entries: Array<{ idx: number; tag: string; when: number }> }

async function disposable(run: (
  conn: ReturnType<typeof createDb>, dir: string, fullJournal: string,
) => Promise<void>): Promise<void> {
  const name = `${PREFIX}${randomUUID().replaceAll('-', '')}_test`;
  if (!new RegExp(`^${PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing unsafe disposable database name ${name}`);
  }
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0101-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await cp(MIGRATIONS, dir, { recursive: true });
    const fullJournal = await readFile(path.join(dir, 'meta/_journal.json'), 'utf8');
    conn = createDb(url.toString(), { max: 4 });
    await run(conn, dir, fullJournal);
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

async function migrateThrough0100(
  conn: ReturnType<typeof createDb>, dir: string, fullJournal: string,
): Promise<void> {
  const prior = JSON.parse(fullJournal) as Journal;
  const head = prior.entries.findIndex((entry) => entry.tag === '0101_mine_full_notifications');
  expect(head).toBeGreaterThan(0);
  prior.entries = prior.entries.slice(0, head);
  expect(prior.entries.at(-1)?.tag).toBe('0100_push_notifications');
  await writeFile(path.join(dir, 'meta/_journal.json'), `${JSON.stringify(prior, null, 2)}\n`);
  await migrate(conn.db, { migrationsFolder: dir });
}

async function expectM34MigrationCount(
  conn: ReturnType<typeof createDb>, fullJournal: string,
): Promise<void> {
  const journal = JSON.parse(fullJournal) as Journal;
  // M34's two migrations sit at journal idx 101 and 102, in order; later
  // releases append after them (0103 did), so the pin is their position and
  // that EVERY journal entry was applied — never the journal's total length.
  const tags = journal.entries.map((entry) => entry.tag);
  expect(tags.indexOf('0101_mine_full_notifications')).toBe(101);
  expect(tags.indexOf('0102_live_raid_clock')).toBe(102);
  expect(journal.entries.length).toBeGreaterThanOrEqual(103);
  const [applied] = await conn.sql<{ count: number }[]>`
    SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations
  `;
  expect(applied?.count).toBe(journal.entries.length);
}

describe('migration 0101 Mine-full rollout bootstrap', () => {
  it('upgrades 0100 without a blanket claim, then suppresses full and schedules partial', async () => {
    await disposable(async (conn, dir, fullJournal) => {
      await migrateThrough0100(conn, dir, fullJournal);
      const wallet = `mine-rollout-${randomUUID()}`;
      const anchor = new Date();
      const capacity = BigInt(getMiningQuota(1, [1], 0))
        * BigInt(MINING.MINE_STORAGE_DAYS);
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const [base] = await conn.sql<{ id: string }[]>`
        INSERT INTO bases (owner_wallet, status, land_paid_at, deed_asset_id)
        VALUES (${wallet}, 'active', ${anchor.toISOString()}, ${`deed-${randomUUID()}`})
        RETURNING id
      `;
      await conn.sql`
        INSERT INTO base_slots (wallet, slot, base_id, active)
        VALUES (${wallet}, 1, ${base!.id}, true)
      `;
      const mines = await conn.sql<{ id: string }[]>`
        INSERT INTO buildings (player_wallet, base_id, type, level, tx, ty)
        VALUES
          (${wallet}, ${base!.id}, 'mine', 1, 1, 1),
          (${wallet}, ${base!.id}, 'mine', 1, 2, 2)
        RETURNING id
      `;
      await conn.sql`
        INSERT INTO mine_accrual_states
          (mine_building_id, accrued_shards, last_accrual_at)
        VALUES
          (${mines[0]!.id}, ${capacity.toString()}, ${anchor.toISOString()}),
          (${mines[1]!.id}, 0, ${anchor.toISOString()})
      `;
      const priorMailRef = `migration-preserve-${randomUUID()}`;
      await conn.sql`
        INSERT INTO push_events (kind, ref_id, wallet, created_at)
        VALUES ('mail', ${priorMailRef}, ${wallet}, ${anchor.toISOString()})
      `;
      // A started compatible march is deliberately not upgraded to V2. Its
      // deadline and command sequence must survive migration byte-for-byte.
      const raidId = randomUUID();
      const startedAt = new Date('2026-09-04T12:00:00.000Z');
      const battleEndsAt = new Date('2026-09-04T12:01:30.000Z');
      await conn.sql`
        INSERT INTO raids (id, attacker_wallet, attacker_base_id, campaign_stage,
          seed, snapshot, army_snapshot, orders_deadline_at, sim_version)
        VALUES (${raidId}, ${wallet}, ${base!.id}, 1,
          7, '{"buildings":[]}', '{"counts":{"highlander":1}}', ${battleEndsAt.toISOString()}, 13)
      `;
      await conn.sql`
        INSERT INTO raid_live_states (raid_id, command_protocol_version, last_sequence,
          started_at, battle_ends_at, updated_at, mode)
        VALUES (${raidId}, 1, 0, ${startedAt.toISOString()}, ${battleEndsAt.toISOString()},
          ${startedAt.toISOString()}, 'batch')
      `;
      await conn.sql`
        INSERT INTO raid_commands (raid_id, sequence, client_command_id, kind,
          payload, server_offset_ms, payload_hash, accepted_at)
        VALUES (${raidId}, 0, 'pre-migration-deploy', 'deploy',
          '{"troop":"highlander","tx":1,"ty":1,"tMs":0}', 0,
          'pre-migration-payload-hash', ${startedAt.toISOString()})
      `;
      const [raidBefore] = await conn.sql<{ raid: unknown; live: Record<string, unknown> }[]>`
        SELECT to_jsonb(r) AS raid, to_jsonb(l) AS live
        FROM raids r JOIN raid_live_states l ON l.raid_id=r.id WHERE r.id=${raidId}
      `;
      const commandsBefore = await conn.sql`
        SELECT * FROM raid_commands WHERE raid_id=${raidId} ORDER BY sequence
      `;

      await writeFile(path.join(dir, 'meta/_journal.json'), fullJournal);
      await migrate(conn.db, { migrationsFolder: dir });
      await expectM34MigrationCount(conn, fullJournal);
      const [raidAfter] = await conn.sql<{ raid: Record<string, unknown>; live: Record<string, unknown> }[]>`
        SELECT to_jsonb(r) AS raid, to_jsonb(l) AS live
        FROM raids r JOIN raid_live_states l ON l.raid_id=r.id WHERE r.id=${raidId}
      `;
      // 0114 adds a durable acceptance receipt; it must not invent a receipt
      // for this legacy march or change any of its existing fields.
      const { bulk_deployment_accepted_at, visual_context, ...preservedRaid } = raidAfter!.raid;
      expect(bulk_deployment_accepted_at).toBeNull();
      // Historical battles default to Crownlands; migration must not invent a frozen context.
      expect(visual_context).toBeNull();
      expect(preservedRaid).toEqual(raidBefore?.raid);
      expect(await conn.sql`
        SELECT * FROM raid_commands WHERE raid_id=${raidId} ORDER BY sequence
      `).toEqual(commandsBefore);
      const {
        clock_revision, clock_rate, clock_anchor_wall_at, clock_anchor_sim_ms, armed_at,
        ...preservedLiveState
      } = raidAfter!.live;
      expect(preservedLiveState).toEqual(raidBefore!.live);
      expect({ clock_revision, clock_rate, clock_anchor_wall_at, clock_anchor_sim_ms, armed_at })
        .toEqual({ clock_revision: 0, clock_rate: 1, clock_anchor_wall_at: null, clock_anchor_sim_ms: null, armed_at: null });
      const before = await conn.sql<{
        id: string; pending: boolean; checkAt: string | null; cycle: number;
      }[]>`
        SELECT mine_building_id AS id,
          full_notification_bootstrap_pending AS pending,
          full_notification_check_at AS "checkAt",
          full_notification_cycle AS cycle
        FROM mine_accrual_states ORDER BY mine_building_id
      `;
      expect(before).toHaveLength(2);
      expect(before.every((row) => row.pending && row.checkAt === null && row.cycle === 0)).toBe(true);
      expect(await conn.sql`SELECT 1 FROM push_events WHERE kind='mine_full'`).toHaveLength(0);

      expect(await classifyMineFullNotificationBootstrap(conn.db)).toMatchObject({
        classified: 2, suppressed: 1, scheduled: 1,
      });
      const after = await conn.sql<{
        id: string; pending: boolean; checkAt: string | null;
      }[]>`
        SELECT mine_building_id AS id,
          full_notification_bootstrap_pending AS pending,
          full_notification_check_at AS "checkAt"
        FROM mine_accrual_states ORDER BY mine_building_id
      `;
      expect(after.every((row) => !row.pending)).toBe(true);
      const full = after.find((row) => row.id === mines[0]!.id)!;
      const partial = after.find((row) => row.id === mines[1]!.id)!;
      expect(full.checkAt).toBeNull();
      expect(partial.checkAt).not.toBeNull();
      expect(new Date(partial.checkAt!)).toEqual(new Date(
        anchor.getTime() + MINING.MINE_STORAGE_DAYS * 86_400_000,
      ));
      expect(await conn.sql`
        SELECT 1 FROM push_events
        WHERE kind='mine_full' AND ref_id=${mineFullRef(mines[0]!.id, 0)}
          AND outcome='suppressed'
      `).toHaveLength(1);
      expect(await conn.sql`
        SELECT 1 FROM push_events WHERE kind='mail' AND ref_id=${priorMailRef}
      `).toHaveLength(1);

      const [newMine] = await conn.sql<{ id: string }[]>`
        INSERT INTO buildings (player_wallet, base_id, type, level, tx, ty)
        VALUES (${wallet}, ${base!.id}, 'mine', 1, 3, 3) RETURNING id
      `;
      await conn.sql`
        INSERT INTO mine_accrual_states (mine_building_id, last_accrual_at)
        VALUES (${newMine!.id}, ${anchor.toISOString()})
      `;
      const [newState] = await conn.sql<{ pending: boolean }[]>`
        SELECT full_notification_bootstrap_pending AS pending
        FROM mine_accrual_states WHERE mine_building_id=${newMine!.id}
      `;
      expect(newState?.pending).toBe(false);
    });
  });

  it('installs the final false default and empty partial index on a fresh database', async () => {
    await disposable(async (conn, dir, fullJournal) => {
      await migrate(conn.db, { migrationsFolder: dir });
      await expectM34MigrationCount(conn, fullJournal);
      const [column] = await conn.sql<{ nullable: string; defaultValue: string }[]>`
        SELECT is_nullable AS nullable, column_default AS "defaultValue"
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='mine_accrual_states'
          AND column_name='full_notification_bootstrap_pending'
      `;
      expect(column).toEqual({ nullable: 'NO', defaultValue: 'false' });
      const [index] = await conn.sql<{ definition: string }[]>`
        SELECT indexdef AS definition FROM pg_indexes
        WHERE schemaname='public'
          AND indexname='mine_accrual_states_full_notification_bootstrap_idx'
      `;
      expect(index?.definition).toContain('full_notification_bootstrap_pending = true');
    });
  });

  it('rejects malformed V2 clock anchors, rates and a started clock with no deadline', async () => {
    await disposable(async (conn, dir, fullJournal) => {
      await migrate(conn.db, { migrationsFolder: dir });
      await expectM34MigrationCount(conn, fullJournal);
      const wallet = `clock-check-${randomUUID()}`;
      const raidId = randomUUID();
      const startedAt = '2026-09-04T12:00:00.000Z';
      const battleEndsAt = '2026-09-04T12:01:30.000Z';
      const durationMs = RAID_RULES.battleDurationSec * 1000;
      await conn.sql`INSERT INTO players (wallet) VALUES (${wallet})`;
      const [base] = await conn.sql<{ id: string }[]>`
        INSERT INTO bases (owner_wallet, status, land_paid_at, deed_asset_id)
        VALUES (${wallet}, 'active', ${startedAt}, ${`deed-${randomUUID()}`}) RETURNING id
      `;
      await conn.sql`
        INSERT INTO raids (id, attacker_wallet, attacker_base_id, campaign_stage,
          seed, snapshot, army_snapshot, orders_deadline_at, sim_version)
        VALUES (${raidId}, ${wallet}, ${base!.id}, 1,
          7, '{"buildings":[]}', '{"counts":{}}', ${battleEndsAt}, 13)
      `;
      await conn.sql`
        INSERT INTO raid_live_states (raid_id, command_protocol_version, started_at,
          battle_ends_at, clock_anchor_wall_at, clock_anchor_sim_ms)
        VALUES (${raidId}, 2, ${startedAt}, ${battleEndsAt}, ${startedAt}, 0)
      `;

      await expect(conn.sql`
        UPDATE raid_live_states SET clock_anchor_wall_at=NULL WHERE raid_id=${raidId}
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'raid_live_states_clock_v2_pair_ck' });
      await expect(conn.sql`
        UPDATE raid_live_states SET clock_anchor_sim_ms=NULL WHERE raid_id=${raidId}
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'raid_live_states_clock_v2_pair_ck' });
      for (const simMs of [-1, durationMs + 1]) {
        await expect(conn.sql`
          UPDATE raid_live_states SET clock_anchor_sim_ms=${simMs} WHERE raid_id=${raidId}
        `).rejects.toMatchObject({ code: '23514', constraint_name: 'raid_live_states_clock_v2_range_ck' });
      }
      for (const rate of [0, 3]) {
        await expect(conn.sql`
          UPDATE raid_live_states SET clock_rate=${rate} WHERE raid_id=${raidId}
        `).rejects.toMatchObject({ code: '23514', constraint_name: 'raid_live_states_clock_v2_range_ck' });
      }
      // PostgreSQL CHECK passes NULL. A bare `battle_ends_at > started_at`
      // does not reject NULL; a started V2 branch must require IS NOT NULL too.
      await expect(conn.sql`
        UPDATE raid_live_states SET battle_ends_at=NULL WHERE raid_id=${raidId}
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'raid_live_states_clock_v2_state_ck' });

      const [valid] = await conn.sql<{ protocol: number; rate: number; simMs: number; endsAt: string }[]>`
        UPDATE raid_live_states SET clock_rate=2, clock_anchor_sim_ms=${durationMs}
        WHERE raid_id=${raidId}
        RETURNING command_protocol_version AS protocol, clock_rate AS rate,
          clock_anchor_sim_ms AS "simMs", battle_ends_at AS "endsAt"
      `;
      expect(valid).toMatchObject({ protocol: 2, rate: 2, simMs: durationMs });
      expect(new Date(valid!.endsAt)).toEqual(new Date(battleEndsAt));
    });
  });
});
