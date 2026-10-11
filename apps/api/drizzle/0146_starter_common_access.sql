-- D153.26: retain HOME v1/v2 evidence; add explicit common-starter access.
-- GENERATED frozen economics/geography projection from
-- packages/shared/src/constants.ts PHASE_E_STARTER_ROUTES.commonV1 and
-- PHASE_E_POLICY.taxes.resources/basisPoints, plus phaseEResources registry.
-- commonV1 is immutable; future policies append a new version/migration.
-- No existing rows, immutable triggers, return entries or custody rules change.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_expedition_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE trip public.starter_expeditions%ROWTYPE; custody text; expected_realm text; expected_resource text; access_ok boolean;
BEGIN
  IF TG_TABLE_NAME = 'starter_expeditions' THEN
    IF NEW.route_snapshot ? 'access' THEN
      expected_realm := CASE NEW.route_id
        WHEN 'common_frostveil' THEN 'frostveil'
        WHEN 'common_elderwood' THEN 'elderwood'
        WHEN 'common_sunscar' THEN 'sunscar'
        WHEN 'common_crownlands' THEN 'crownlands'
        WHEN 'common_seeker_reach' THEN 'seeker-reach'
        WHEN 'common_stormcairn' THEN 'stormcairn'
        WHEN 'common_thornwake' THEN 'thornwake'
        WHEN 'common_cinderfall' THEN 'cinderfall'
        ELSE NULL END;
      expected_resource := CASE expected_realm
        WHEN 'frostveil' THEN 'frost_quartz'
        WHEN 'elderwood' THEN 'heartwood_logs'
        WHEN 'sunscar' THEN 'sunstone_rubble'
        WHEN 'crownlands' THEN 'crown_iron_ore'
        WHEN 'seeker-reach' THEN 'rough_prism'
        WHEN 'stormcairn' THEN 'storm_ore'
        WHEN 'thornwake' THEN 'thorn_fibre'
        WHEN 'cinderfall' THEN 'ember_nodules'
        ELSE NULL END;
      access_ok := expected_realm IS NOT NULL
        AND NEW.route_version = 2 AND NEW.reward_version = 2
        AND NEW.route_snapshot->'access' = '{"kind":"starter_common","policyVersion":1}'::jsonb
        AND NEW.route_snapshot->>'realmId' = expected_realm AND NEW.resource_id = expected_resource
        AND NEW.gross = 5 AND NEW.net = 4 AND NEW.tax = 1
        AND NEW.returns_at - NEW.departed_at = interval '1800 seconds';
    ELSE
      access_ok := NEW.route_id IN ('introduction','coastal_survey','long_survey')
        AND NEW.route_snapshot->>'realmId' = NEW.home_evidence->>'realmId';
    END IF;
    IF access_ok IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM public.fleet_installations WHERE id = NEW.installation_id AND base_id = NEW.base_id AND family = 'starter')
      OR NOT EXISTS (SELECT 1 FROM public.expedition_term_snapshots WHERE term_id = NEW.term_id AND snapshot_hash = NEW.term_hash AND starts_at <= NEW.departed_at AND NEW.departed_at < ends_at)
      OR (jsonb_typeof(NEW.route_snapshot) = 'object'
        AND NEW.route_snapshot - ARRAY['routeCatalogueVersion','rewardTableVersion','routeId','realmId','resourceId',
          'vehicleFamily','durationSec','grossQuantity','netQuantity','islandPoolQuantity','access'] = '{}'::jsonb
        AND NEW.route_snapshot->'routeCatalogueVersion' = to_jsonb(NEW.route_version)
        AND NEW.route_snapshot->'rewardTableVersion' = to_jsonb(NEW.reward_version)
        AND NEW.route_snapshot->'grossQuantity' = to_jsonb(NEW.gross::text)
        AND NEW.route_snapshot->'netQuantity' = to_jsonb(NEW.net::text)
        AND NEW.route_snapshot->'islandPoolQuantity' = to_jsonb(NEW.tax::text)
        AND jsonb_typeof(NEW.route_snapshot->'durationSec') = 'number'
        AND NEW.home_evidence->>'baseId' = NEW.base_id::text
        AND NEW.home_evidence->>'custodyWallet' = NEW.actor_wallet
        AND NEW.route_snapshot->>'routeId' = NEW.route_id
        AND (NEW.route_snapshot->>'routeCatalogueVersion')::integer = NEW.route_version
        AND (NEW.route_snapshot->>'rewardTableVersion')::integer = NEW.reward_version
        AND NEW.route_snapshot->>'resourceId' = NEW.resource_id
        AND NEW.route_snapshot->>'vehicleFamily' = 'starter'
        AND (NEW.route_snapshot->>'grossQuantity')::bigint = NEW.gross
        AND (NEW.route_snapshot->>'netQuantity')::bigint = NEW.net
        AND (NEW.route_snapshot->>'islandPoolQuantity')::bigint = NEW.tax
        AND NEW.returns_at - NEW.departed_at = (NEW.route_snapshot->>'durationSec')::bigint * interval '1 second'
        AND NEW.finality->>'commitment' = 'finalized'
        AND (NEW.finality->>'observedAt')::timestamptz <= NEW.departed_at) IS NOT TRUE
    THEN RAISE EXCEPTION 'starter expedition original binding mismatch' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'starter_expedition_inflight' THEN
    IF NOT EXISTS (SELECT 1 FROM public.starter_expeditions WHERE id = NEW.expedition_id AND installation_id = NEW.installation_id)
    THEN RAISE EXCEPTION 'starter flight differs from original installation' USING ERRCODE = '23514'; END IF;
  ELSE
    SELECT * INTO STRICT trip FROM public.starter_expeditions WHERE id = NEW.expedition_id;
    SELECT owner_wallet INTO custody FROM public.bases WHERE id = trip.base_id FOR UPDATE;
    IF custody IS DISTINCT FROM NEW.custody_wallet OR NEW.returned_at < trip.returns_at
    THEN RAISE EXCEPTION 'starter return custody or deadline mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.shardkeep_starter_expedition_insert_guard() FROM PUBLIC;
