-- D153.91 paid departure admission; HELD S5: replaces an existing insert guard.
-- Frozen projection: PHASE_E_PAID_STARTER_ROUTES v3/reward2, coastal survey
-- duration/gross, resource tax, and PHASE_E_SEEKER_AUCTION observation age.
-- HOME/common branches and immutable history/return/custody rules are preserved.
-- No backfill, existing-row mutation or payment authority. SQL checks historical
-- binding; the server's finalized adapter establishes actual chain authority.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_starter_expedition_insert_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE trip public.starter_expeditions%ROWTYPE; custody text; expected_realm text; expected_resource text; access_ok boolean; coverage jsonb; coverage_source jsonb; coverage_finality jsonb; expected_index integer; account_row jsonb; account_index integer;
BEGIN
  IF TG_TABLE_NAME = 'starter_expeditions' THEN
    IF NEW.route_snapshot->'access'->>'kind' = 'paid_realm' THEN
      expected_realm := CASE NEW.route_id
        WHEN 'paid_frostveil' THEN 'frostveil' WHEN 'paid_elderwood' THEN 'elderwood'
        WHEN 'paid_sunscar' THEN 'sunscar' WHEN 'paid_crownlands' THEN 'crownlands'
        WHEN 'paid_seeker_reach' THEN 'seeker-reach' WHEN 'paid_stormcairn' THEN 'stormcairn'
        WHEN 'paid_thornwake' THEN 'thornwake' WHEN 'paid_cinderfall' THEN 'cinderfall' ELSE NULL END;
      expected_resource := CASE expected_realm
        WHEN 'frostveil' THEN 'frost_quartz' WHEN 'elderwood' THEN 'heartwood_logs'
        WHEN 'sunscar' THEN 'sunstone_rubble' WHEN 'crownlands' THEN 'crown_iron_ore'
        WHEN 'seeker-reach' THEN 'rough_prism' WHEN 'stormcairn' THEN 'storm_ore'
        WHEN 'thornwake' THEN 'thorn_fibre' WHEN 'cinderfall' THEN 'ember_nodules' ELSE NULL END;
      expected_index := array_position(ARRAY['frostveil','elderwood','sunscar','crownlands','seeker-reach','stormcairn','thornwake','cinderfall'],expected_realm)-1;
      coverage := NEW.route_snapshot->'access'->'observation'; coverage_source := coverage->'source'; coverage_finality := coverage->'finality';
      access_ok := expected_realm IS NOT NULL AND NEW.route_version = 3 AND NEW.reward_version = 2
        AND (NEW.route_snapshot->'access') - ARRAY['kind','policyVersion','observation'] = '{}'::jsonb
        AND NEW.route_snapshot->'access'->'policyVersion' = '1'::jsonb
        AND NEW.route_snapshot->>'realmId' = expected_realm AND NEW.resource_id = expected_resource
        AND NEW.gross = 25 AND NEW.net = 20 AND NEW.tax = 5
        AND NEW.returns_at - NEW.departed_at = interval '1800 seconds'
        AND jsonb_typeof(coverage) = 'object'
        AND coverage - ARRAY['version','wallet','realm','accessAddress','configAddress','expiresAt','finality','source'] = '{}'::jsonb
        AND coverage->'version' = '1'::jsonb AND jsonb_typeof(coverage->'wallet') = 'string' AND coverage->>'wallet' = NEW.actor_wallet
        AND coverage->'realm' = to_jsonb(expected_index)
        AND jsonb_typeof(coverage->'accessAddress') = 'string' AND coverage->>'accessAddress' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage->'configAddress') = 'string' AND coverage->>'configAddress' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage->'expiresAt') = 'string' AND coverage->>'expiresAt' ~ '^[1-9][0-9]{0,18}$'
        AND (coverage->>'expiresAt')::numeric <= 9223372036854775807
        AND (coverage->>'expiresAt')::numeric > extract(epoch FROM NEW.departed_at)
        AND jsonb_typeof(coverage_finality) = 'object'
        AND coverage_finality - ARRAY['commitment','contextSlot','observedAt','chainUnixTimestamp'] = '{}'::jsonb
        AND jsonb_typeof(coverage_finality->'commitment') = 'string' AND coverage_finality->>'commitment' = 'finalized'
        AND jsonb_typeof(coverage_finality->'contextSlot') = 'string' AND coverage_finality->>'contextSlot' ~ '^(0|[1-9][0-9]{0,19})$'
        AND (coverage_finality->>'contextSlot')::numeric <= 18446744073709551615
        AND jsonb_typeof(coverage_finality->'observedAt') = 'string' AND coverage_finality->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
        AND (coverage_finality->>'observedAt')::timestamptz <= NEW.departed_at
        AND NEW.departed_at - (coverage_finality->>'observedAt')::timestamptz <= interval '10 seconds'
        AND jsonb_typeof(coverage_finality->'chainUnixTimestamp') = 'string'
        AND coverage_finality->>'chainUnixTimestamp' ~ '^[1-9][0-9]{0,18}$'
        AND (coverage_finality->>'chainUnixTimestamp')::numeric <= extract(epoch FROM NEW.departed_at)
        AND jsonb_typeof(coverage_source) = 'object'
        AND coverage_source - ARRAY['trust','stateProvenance','genesisHash','programId','reviewedDeploymentSlot','reviewedProgramDataSha256','upgradeAuthority','accounts'] = '{}'::jsonb
        AND jsonb_typeof(coverage_source->'trust') = 'string' AND coverage_source->>'trust' = 'trusted-finalized-rpc-reviewed-program'
        AND jsonb_typeof(coverage_source->'stateProvenance') = 'string' AND coverage_source->>'stateProvenance' = 'fresh-reviewed-deployment'
        AND jsonb_typeof(coverage_source->'genesisHash') = 'string' AND coverage_source->>'genesisHash' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage_source->'programId') = 'string' AND coverage_source->>'programId' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND jsonb_typeof(coverage_source->'reviewedProgramDataSha256') = 'string' AND coverage_source->>'reviewedProgramDataSha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(coverage_source->'reviewedDeploymentSlot') = 'number'
        AND coverage_source->>'reviewedDeploymentSlot' ~ '^(0|[1-9][0-9]{0,15})$'
        AND (coverage_source->>'reviewedDeploymentSlot')::numeric <= 9007199254740991
        AND (coverage_source->>'reviewedDeploymentSlot')::numeric <= (coverage_finality->>'contextSlot')::numeric
        AND (coverage_source->'upgradeAuthority' = 'null'::jsonb OR (jsonb_typeof(coverage_source->'upgradeAuthority') = 'string' AND coverage_source->>'upgradeAuthority' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'))
        AND jsonb_typeof(coverage_source->'accounts') = 'array' AND jsonb_array_length(coverage_source->'accounts') = 5
        AND EXISTS (SELECT 1 FROM public.expedition_term_snapshots t WHERE t.term_id = NEW.term_id AND t.snapshot_hash = NEW.term_hash
          AND t.genesis_hash = coverage_source->>'genesisHash' AND t.program_id = coverage_source->>'programId');
      IF access_ok IS TRUE THEN
        FOR account_row, account_index IN SELECT value, ordinality::integer-1 FROM jsonb_array_elements(coverage_source->'accounts') WITH ORDINALITY LOOP
          IF (jsonb_typeof(account_row) = 'object' AND account_row - ARRAY['address','exists','owner','executable','dataSha256'] = '{}'::jsonb
            AND jsonb_typeof(account_row->'address') = 'string' AND account_row->>'address' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND account_row->'exists' = 'true'::jsonb
            AND account_row->'executable' = to_jsonb(account_index = 0) AND jsonb_typeof(account_row->'dataSha256') = 'string' AND account_row->>'dataSha256' ~ '^[a-f0-9]{64}$'
            AND jsonb_typeof(account_row->'owner') = 'string' AND account_row->>'owner' = CASE WHEN account_index < 2 THEN 'BPFLoaderUpgradeab1e11111111111111111111111'
              WHEN account_index = 4 THEN 'Sysvar1111111111111111111111111111111111111' ELSE coverage_source->>'programId' END
            AND CASE account_index WHEN 0 THEN account_row->>'address' = coverage_source->>'programId'
              WHEN 1 THEN account_row->>'dataSha256' = coverage_source->>'reviewedProgramDataSha256'
              WHEN 2 THEN account_row->>'address' = coverage->>'configAddress'
              WHEN 3 THEN account_row->>'address' = coverage->>'accessAddress'
              WHEN 4 THEN account_row->>'address' = 'SysvarC1ock11111111111111111111111111111111' ELSE false END) IS NOT TRUE
          THEN access_ok := false; EXIT; END IF;
        END LOOP;
        IF (SELECT count(DISTINCT value->>'address') FROM jsonb_array_elements(coverage_source->'accounts')) <> 5 THEN access_ok := false; END IF;
      END IF;
    ELSIF NEW.route_snapshot ? 'access' THEN
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

COMMENT ON FUNCTION public.shardkeep_starter_expedition_insert_guard() IS 'phase-e:starter-expedition-guard:paid-access-v1';
