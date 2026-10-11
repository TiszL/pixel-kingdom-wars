-- Owner 2026-09-05: explicit training between Barracks and Land. Frozen snapshot
-- of QUESTS.first_troops (L1 Camp capacity; train_20_points reward). This is a
-- compatibility marker, never a payout or a second progression subsystem.
INSERT INTO quests (scope, template_code, target, reward_keep, active_on)
VALUES ('onboarding', 'first_troops', 20, 25, '2000-01-01')
ON CONFLICT (scope, active_on, template_code) DO NOTHING;
--> statement-breakpoint
INSERT INTO base_quest_progress (base_id, quest_id, progress, completed_at, claimed_at)
SELECT b.id, training.id, training.target, now(), now()
FROM bases b CROSS JOIN quests training
WHERE training.scope = 'onboarding' AND training.active_on = '2000-01-01'
  AND training.template_code = 'first_troops'
  AND (b.land_paid_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM base_quest_progress p JOIN quests q ON q.id = p.quest_id
      WHERE p.base_id = b.id AND q.scope = 'onboarding'
        AND ((q.template_code = 'first_barracks' AND p.claimed_at IS NOT NULL)
          OR (q.template_code IN ('first_land', 'first_raid')
            AND (p.progress > 0 OR p.completed_at IS NOT NULL OR p.claimed_at IS NOT NULL))))
    OR EXISTS (SELECT 1 FROM raids r WHERE r.attacker_base_id = b.id AND r.status = 'resolved'))
ON CONFLICT (quest_id, base_id) DO UPDATE SET
  progress = EXCLUDED.progress,
  completed_at = COALESCE(base_quest_progress.completed_at, EXCLUDED.completed_at),
  claimed_at = COALESCE(base_quest_progress.claimed_at, EXCLUDED.claimed_at);
--> statement-breakpoint
-- Ready deed installations permanently fence retired wallet gameplay tables.
-- Preserve that boundary; only installations still in legacy mode need these
-- compatibility markers. Production progression is already base-scoped.
DO $$
BEGIN
  IF NOT shardkeep_deed_economy_ready() THEN
    INSERT INTO quest_progress (player_wallet, quest_id, progress, completed_at, claimed_at)
    SELECT player.wallet, training.id, training.target, now(), now()
    FROM players player CROSS JOIN quests training
    WHERE training.scope = 'onboarding' AND training.active_on = '2000-01-01'
      AND training.template_code = 'first_troops'
      AND (player.entry_paid_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM quest_progress p JOIN quests q ON q.id = p.quest_id
          WHERE p.player_wallet = player.wallet AND q.scope = 'onboarding'
            AND ((q.template_code = 'first_barracks' AND p.claimed_at IS NOT NULL)
              OR (q.template_code IN ('first_land', 'first_raid')
                AND (p.progress > 0 OR p.completed_at IS NOT NULL OR p.claimed_at IS NOT NULL))))
        OR EXISTS (SELECT 1 FROM raids r WHERE r.attacker_wallet = player.wallet
          AND r.attacker_base_id IS NULL AND r.status = 'resolved'))
    ON CONFLICT (quest_id, player_wallet) DO UPDATE SET
      progress = EXCLUDED.progress,
      completed_at = COALESCE(quest_progress.completed_at, EXCLUDED.completed_at),
      claimed_at = COALESCE(quest_progress.claimed_at, EXCLUDED.claimed_at);
  END IF;
END $$;
