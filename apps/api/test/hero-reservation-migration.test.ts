import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heroRaidAuthorizationIssue } from '../src/game/raids';

const migration = readFileSync(
  new URL('../drizzle/0069_young_red_hulk.sql', import.meta.url),
  'utf8',
);
const deedMigration = readFileSync(
  new URL('../drizzle/0076_watery_jane_foster.sql', import.meta.url),
  'utf8',
);

describe('hero raid reservation rollout', () => {
  it('backfills one deterministic live SIM7 raid and leaves duplicate legacy rows fail-closed', () => {
    // WHY: production may already contain multiple pending snapshots for the
    // same hero when 0069 lands. Picking one stable winner avoids a migration
    // collision; every unchosen row must then be rejected by submit policy.
    expect(migration).toContain('PARTITION BY "attacker_wallet"');
    expect(migration).toContain('ORDER BY "created_at" ASC, "id" ASC');
    // 0069 is immutable rollout history: it shipped with SIM7 and must not
    // silently follow the current simulator constant after a later protocol
    // bump. SIM8 pending raids are created only after this table already exists.
    expect(migration).toContain('"sim_version" = 7');
    expect(migration).toContain('"orders_deadline_at" >= now()');
    expect(migration).toContain('jsonb_typeof("army_snapshot"->\'heroes\') = \'array\'');
    expect(migration).toContain('AND EXISTS (');
    expect(migration).toContain('ON CONFLICT DO NOTHING');

    expect(heroRaidAuthorizationIssue(['vex'], [], []))
      .toEqual({ hero: 'vex', code: 'HERO_RESERVATION_MISSING' });
    expect(heroRaidAuthorizationIssue(['vex'], ['vex'], ['vex']))
      .toEqual({ hero: 'vex', code: 'HERO_RECOVERING' });
    expect(heroRaidAuthorizationIssue(['vex'], ['vex'], [])).toBeUndefined();
  });

  it('0076 rekeys valid stable rows, preserves legacy uniqueness, and fences owner identity', () => {
    expect(deedMigration).toContain('PARTITION BY r."attacker_base_id", h."hero"');
    expect(deedMigration).toContain('ORDER BY h."created_at", h."raid_id"');
    expect(deedMigration).toContain('r."attacker_wallet" = h."player_wallet"');
    expect(deedMigration).toContain('SET "base_id" = r."attacker_base_id", "player_wallet" = NULL');
    // Historical constraint name is deliberately retained for old-binary 23505
    // translation during the quiescent rollout/rollback boundary.
    expect(deedMigration).toContain('CREATE UNIQUE INDEX "hero_raid_reservations_player_hero_pk"');
    expect(deedMigration).toContain('CREATE UNIQUE INDEX "hero_raid_reservations_base_hero_uq"');
    expect(deedMigration).toContain('num_nonnulls("hero_raid_reservations"."player_wallet", "hero_raid_reservations"."base_id") = 1');
    expect(deedMigration).toContain('"buyer_base_id" = buyer."base_id"');
    expect(deedMigration).toContain('DELETE FROM "base_items"');
    expect(deedMigration).toContain("'skin_keep_gilded', 'skin_keep_frost', 'skin_keep_voidstone'");
  });
});
