import { readFileSync } from 'node:fs';
import { LEAGUES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import type { FinalizedDeedReader } from '../src/game/baseOwnership';
import {
  firstCompleteLeagueWeek, readCoherentLeagueAuthority, type LeagueAuthorityWave,
} from '../src/game/leagues';

const receiptMigration = readFileSync(
  new URL('../drizzle/0095_league_reward_receipts.sql', import.meta.url),
  'utf8',
);
const participationMigration = readFileSync(
  new URL('../drizzle/0096_league_participation_index.sql', import.meta.url),
  'utf8',
);
const jobsSource = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
const leaguesSource = readFileSync(new URL('../src/game/leagues.ts', import.meta.url), 'utf8');

describe('league release security contract', () => {
  it('fails migration closed on legacy KEEP and makes paid receipts one-way', () => {
    // WHY: silently ignoring a positive legacy entitlement strands real value;
    // clearing paid_at would make the same sellable reward drain twice.
    expect(receiptMigration).toContain('WHERE "keep_amount" <> 0');
    expect(receiptMigration).toContain('require an explicit operator audit');
    expect(receiptMigration).toContain('OLD.paid_at IS NOT NULL');
    expect(receiptMigration).toContain('cannot be cleared or rewritten');
    expect(receiptMigration).toContain('base_league_entitlements_no_delete_trg');
    expect(receiptMigration).toContain('base_league_entitlements_keep_zero_ck');
  });

  it('journals each item grant and makes all close evidence immutable', () => {
    // WHY: paid_at is a completion marker, not the item idempotency key. The
    // composite journal survives retries and operator repair independently.
    expect(receiptMigration).toContain(
      'PRIMARY KEY("week","base_id","item_id")',
    );
    expect(receiptMigration).toContain('league_item_grants_receipt_fk');
    expect(receiptMigration).toContain('league_item_grants_immutable_trg');
    expect(receiptMigration).toContain('league_week_closures_immutable_trg');
    expect(receiptMigration).toContain('league_week_base_snapshots_immutable_trg');
    expect(receiptMigration).toContain('league_reward_activations_immutable_trg');
    expect(receiptMigration).toContain('feature_enabled_at_close');
    expect(receiptMigration).toContain('league_week_closures_failure_reason_ck');
    expect(participationMigration.trim()).toBe(
      'CREATE INDEX "raids_attacker_base_resolved_idx" ON "raids" USING btree ("attacker_base_id","resolved_at");',
    );
  });

  it('has separate 00:00 close and 00:15 settlement jobs', () => {
    expect(LEAGUES.closeCron).toBe('0 0 * * 1');
    expect(LEAGUES.settlementCron).toBe('15 0 * * 1');
    expect(jobsSource).toContain("'sched-league-close'");
    expect(jobsSource).toContain("case 'league-close'");
    expect(jobsSource).toContain('closeLeagueWeek(db, now');
  });

  it('recovers durable activation after either runtime kill switch is off', () => {
    // WHY: the SQL boundary fence survives process flags. Every worker boot
    // must close an already-protected missing week, while a disabled install
    // with no activation must remain a no-op rather than opening rewards.
    expect(jobsSource).toMatch(/\n  await queue\.add\('league-close-recovery', \{\}, \{/);
    expect(LEAGUES.closeRecoveryCron).toBe('*/5 * * * *');
    expect(jobsSource).not.toContain("removeJobScheduler('sched-league-close-recovery')");
    expect(leaguesSource).toContain('const [durableActivation] = await db.select');
    expect(leaguesSource).toContain(
      '?? (featureConfigured ? await ensureLeagueRewardActivation(db, now, policy) : null)',
    );
  });

  it('serializes the exact league inputs across a delayed Monday close', () => {
    // WHY: scheduler liveness cannot define a money boundary. A trophy raid,
    // Keep completion, or deed mutation that races 00:00 must serialize with
    // the immutable close and retry when the marker is not committed yet.
    expect(receiptMigration).toContain('pg_try_advisory_xact_lock_shared(7446001)');
    expect(receiptMigration).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    expect(receiptMigration).toContain('retry this mutation');
    expect(receiptMigration).toContain('UPDATE OF trophies ON "base_profiles"');
    expect(receiptMigration).toContain('FOR EACH STATEMENT');
    expect(receiptMigration).toContain(
      'UPDATE OF keep_level, owner_wallet, deed_asset_id, status, land_paid_at ON "bases"',
    );
    expect(receiptMigration).toContain('league_week_base_exclusions_immutable_trg');
  });

  it('never treats a mid-week flag flip as a complete earning week', () => {
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-07T00:00:00.000Z'), '2026-09-07',
    )).toBe('2026-09-07');
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-07T00:00:00.001Z'), '2026-09-07',
    )).toBe('2026-09-14');
    expect(firstCompleteLeagueWeek(
      new Date('2026-09-10T12:00:00.000Z'), '2026-09-07',
    )).toBe('2026-09-14');
  });

  it('reads all 160 authorities concurrently and retries the whole mixed-slot sweep', async () => {
    const waves: LeagueAuthorityWave[] = Array.from({ length: 5 }, (_, wave) => ({
      requests: Array.from({ length: 32 }, (_, asset) => ({ assetId: `${wave}:${asset}` })),
    }));
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const reader = (async () => null) as FinalizedDeedReader;
    reader.readBatch = async (requests) => {
      const call = calls++;
      const attempt = Math.floor(call / 5);
      const wave = call % 5;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const contextSlot = attempt === 0 && wave === 4 ? 101 : attempt === 0 ? 100 : 200;
      return {
        owners: new Map(requests.map(({ assetId }) => [assetId, null])),
        contextSlot,
        transportSucceeded: true,
      };
    };

    const coherent = await readCoherentLeagueAuthority(reader, waves);
    expect(coherent.slot).toBe(200);
    expect(calls).toBe(10);
    expect(maxInFlight).toBe(5);
    expect(coherent.owners.size).toBe(160);
  });

  it('atomically refuses authority when no whole sweep shares one finalized slot', async () => {
    const waves: LeagueAuthorityWave[] = [0, 1].map((wave) => ({
      requests: [{ assetId: `asset-${wave}` }],
    }));
    let calls = 0;
    const reader = (async () => null) as FinalizedDeedReader;
    reader.readBatch = async (requests) => {
      const contextSlot = 300 + (calls++ % 2);
      return {
        owners: new Map(requests.map(({ assetId }) => [assetId, null])),
        contextSlot,
        transportSucceeded: true,
      };
    };
    await expect(readCoherentLeagueAuthority(reader, waves))
      .rejects.toThrow(/one coherent finalized ownership slot/);
    expect(calls).toBe(LEAGUES.closeAuthoritySweepAttempts * 2);
  });
});
