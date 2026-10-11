-- Additive current identity: the SAME locked appearance read plus its installed reservation identities.
-- Distinct namespace (shardkeep_advanced_identity_*): it must not enter the 0291 prefix-based seal. No predecessor changes.
SET LOCAL lock_timeout = '10s';
CREATE FUNCTION public.shardkeep_advanced_identity_current(
  actor text, target uuid, current_buildings jsonb, cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  valid boolean;
  appearance jsonb;
  identity jsonb;
BEGIN
  IF actor IS NULL OR target IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff)
    OR current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('session_replication_role') <> 'origin'
    OR current_user::regrole::oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.advanced_identity_current_contract'::regclass)
  THEN RAISE EXCEPTION 'ADVANCED_IDENTITY_AUTHORITY'; END IF;
  EXECUTE 'SELECT public.shardkeep_advanced_identity_sources_valid() AND public.shardkeep_current_advanced_sources_valid()' INTO valid;
  IF valid IS NOT TRUE THEN RAISE EXCEPTION 'ADVANCED_IDENTITY_SOURCE'; END IF;
  -- The protected predecessor reader keeps its ownership, owner/base/slot/installation locks, cutoff, complete originals and
  -- mandatory source validation. Its appearance is returned byte-for-byte; nothing here re-reads or re-derives it.
  appearance := public.shardkeep_current_advanced_presentation(actor, target, current_buildings, cutoff);
  IF appearance IS NULL OR jsonb_typeof(appearance) = 'null' THEN
    RETURN jsonb_build_object('appearance', 'null'::jsonb, 'identity', 'null'::jsonb);
  END IF;
  -- SAME locked read: the installed reservation identity of each appearance berth. The tier is the appearance's own (the same
  -- lifecycle projection); the family must agree with the installation original.
  SELECT jsonb_build_object('version', 1, 'berths', coalesce(jsonb_agg(jsonb_build_object(
    'buildingId', b->'buildingId',
    'installation', CASE WHEN b->'installation' = 'null'::jsonb THEN 'null'::jsonb ELSE (
      SELECT jsonb_build_object('installationId', i.reservation_id::text, 'family', i.family, 'tier', b->'installation'->'tier')
      FROM public.advanced_vehicle_installations i
      WHERE i.base_id = target AND i.berth_id::text = b->>'buildingId'
    ) END
  ) ORDER BY b->>'buildingId'), '[]')) INTO identity
  FROM jsonb_array_elements(appearance->'berths') b;
  IF (SELECT count(*) FROM jsonb_array_elements(identity->'berths')) <> (SELECT count(*) FROM jsonb_array_elements(appearance->'berths'))
    OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(appearance->'berths') b
      LEFT JOIN jsonb_array_elements(identity->'berths') d ON d->>'buildingId' = b->>'buildingId'
      WHERE d IS NULL
        OR (b->'installation' = 'null'::jsonb) <> (d->'installation' = 'null'::jsonb)
        OR (b->'installation' <> 'null'::jsonb AND (
          d->'installation'->>'installationId' IS NULL
          OR d->'installation'->>'family' IS DISTINCT FROM b->'installation'->>'family'
          OR d->'installation'->'tier' IS DISTINCT FROM b->'installation'->'tier'
          OR (SELECT count(*) FROM public.advanced_vehicle_installations i WHERE i.base_id = target AND i.berth_id::text = b->>'buildingId') <> 1)))
  THEN RAISE EXCEPTION 'ADVANCED_IDENTITY_SOURCE'; END IF;
  RETURN jsonb_build_object('appearance', appearance, 'identity', identity);
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_advanced_identity_current(text,uuid,jsonb,timestamptz) FROM PUBLIC;
