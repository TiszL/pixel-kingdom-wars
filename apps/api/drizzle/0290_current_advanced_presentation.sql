-- Current appearance only. An overdue original trip remains away until returned.
SET LOCAL lock_timeout = '10s';
CREATE FUNCTION public.shardkeep_current_advanced_presentation(
  actor text, target uuid, current_buildings jsonb, cutoff timestamptz
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  valid boolean;
  unavailable boolean := false;
  actual jsonb;
  supplied jsonb;
  installed public.advanced_vehicle_installations%ROWTYPE;
  lifecycle record;
  active record;
  active_count bigint;
  pointer_count bigint;
  facts jsonb := '[]';
  result jsonb;
  seen_families text[] := ARRAY[]::text[];
  seen_berths uuid[] := ARRAY[]::uuid[];
BEGIN
  IF actor IS NULL OR target IS NULL OR cutoff IS NULL OR NOT isfinite(cutoff)
    OR current_setting('transaction_isolation') <> 'read committed'
    OR current_setting('session_replication_role') <> 'origin'
    OR current_user::regrole::oid <> (SELECT relowner FROM pg_class WHERE oid = 'public.current_advanced_presentation_contract'::regclass)
  THEN RAISE EXCEPTION 'CURRENT_ADVANCED_AUTHORITY'; END IF;
  EXECUTE 'SELECT public.shardkeep_current_advanced_sources_valid() AND public.shardkeep_bound_cosmetic_wake_sources_valid()' INTO valid;
  IF valid IS NOT TRUE THEN RAISE EXCEPTION 'CURRENT_ADVANCED_SOURCE'; END IF;
  PERFORM wallet FROM public.players WHERE wallet = actor FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRENT_ADVANCED_OWNER'; END IF;
  PERFORM id FROM public.bases WHERE id = target AND owner_wallet = actor AND status = 'active' FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRENT_ADVANCED_OWNER'; END IF;
  PERFORM s.base_id FROM public.base_slots s WHERE s.base_id = target AND s.wallet = actor AND s.active FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'CURRENT_ADVANCED_OWNER'; END IF;

  -- Check all mandatory originals even when the optional building copy differs.
  IF jsonb_typeof(current_buildings) IS DISTINCT FROM 'array' THEN
    unavailable := true;
    current_buildings := '[]';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', b.id, 'type', b.type, 'level', b.level, 'underConstruction', EXISTS(
      SELECT 1 FROM public.builder_jobs j WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
    )) ORDER BY b.id), '[]') INTO actual
  FROM public.buildings b WHERE b.base_id = target AND b.type = 'berth';
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', b->'id', 'type', b->'type', 'level', b->'level',
    'underConstruction', coalesce(b->'underConstruction', 'false'::jsonb)
  ) ORDER BY b->>'id'), '[]') INTO supplied
  FROM jsonb_array_elements(current_buildings) b WHERE b->>'type' = 'berth';
  IF actual IS DISTINCT FROM supplied THEN unavailable := true; END IF;

  IF EXISTS(
    SELECT 1 FROM public.vehicle_burn_consumptions c
    JOIN public.vehicle_activation_reservations r ON r.id = c.reservation_id
    LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id = r.id AND i.base_id = r.base_id
    WHERE r.base_id = target AND i.reservation_id IS NULL
  ) THEN RAISE EXCEPTION 'CURRENT_ADVANCED_INSTALLATION_SOURCE'; END IF;
  FOR installed IN SELECT * FROM public.advanced_vehicle_installations WHERE base_id = target ORDER BY reservation_id LOOP
    -- Existing lifecycle takes the installation lock and proves immutable burn,
    -- applied service and completed-return originals. Retain that same authority.
    SELECT * INTO STRICT lifecycle FROM public.shardkeep_vehicle_lifecycle(installed.reservation_id);
    IF lifecycle.base_id <> target OR installed.family = ANY(seen_families) OR installed.berth_id = ANY(seen_berths)
      OR NOT EXISTS(
        SELECT 1 FROM public.buildings b JOIN public.builder_jobs j ON j.building_id = b.id
        WHERE b.id = installed.berth_id AND b.base_id = target AND b.type = 'berth' AND b.level >= 1
          AND j.id = installed.completed_build_job_id AND j.base_id = target AND j.kind = 'build'
          AND j.completed_at = installed.berth_completed_at AND j.cancelled_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM public.builder_jobs pending WHERE pending.building_id = b.id AND pending.kind = 'build' AND pending.completed_at IS NULL)
      ) OR EXISTS(SELECT 1 FROM public.fleet_installations WHERE berth_id = installed.berth_id)
    THEN RAISE EXCEPTION 'CURRENT_ADVANCED_INSTALLATION_SOURCE'; END IF;
    seen_families := array_append(seen_families, installed.family);
    seen_berths := array_append(seen_berths, installed.berth_id);
    IF EXISTS(
      SELECT 1 FROM public.vehicle_service_intents s
      LEFT JOIN public.vehicle_service_consumptions c ON c.intent_id = s.id
      LEFT JOIN public.vehicle_service_applications a ON a.intent_id = s.id
      WHERE s.installation_id = installed.reservation_id AND ((c.intent_id IS NULL) <> (a.intent_id IS NULL))
    ) THEN RAISE EXCEPTION 'CURRENT_ADVANCED_SERVICE_SOURCE'; END IF;
    SELECT count(*) INTO active_count FROM public.advanced_expeditions e
      LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id = e.id
      LEFT JOIN public.advanced_expedition_inflight f ON f.expedition_id = e.id
      WHERE e.installation_id = installed.reservation_id AND (r.id IS NULL OR f.expedition_id IS NOT NULL);
    SELECT count(*) INTO pointer_count FROM public.advanced_expedition_inflight WHERE installation_id = installed.reservation_id;
    IF active_count > 1 OR pointer_count <> active_count OR lifecycle.away IS DISTINCT FROM (active_count = 1)
    THEN RAISE EXCEPTION 'CURRENT_ADVANCED_FLIGHT_SOURCE'; END IF;
    IF active_count = 1 THEN
      SELECT e.*, f.installation_id pointer, f.base_id pointer_base, r.id returned INTO active
      FROM public.advanced_expeditions e
      LEFT JOIN public.advanced_expedition_returns r ON r.expedition_id = e.id
      LEFT JOIN public.advanced_expedition_inflight f ON f.expedition_id = e.id
      WHERE e.installation_id = installed.reservation_id AND (r.id IS NULL OR f.expedition_id IS NOT NULL);
      IF active.returned IS NOT NULL OR active.pointer IS DISTINCT FROM installed.reservation_id
        OR active.pointer_base IS DISTINCT FROM target OR active.base_id <> target
        OR NOT isfinite(active.departed_at) OR NOT isfinite(active.returns_at) OR active.returns_at <= active.departed_at
        OR active.completed_before <> lifecycle.completed_total
        OR active.route_snapshot->>'family' IS DISTINCT FROM lifecycle.family
        OR active.route_snapshot->'tier' IS DISTINCT FROM to_jsonb(lifecycle.tier)
        OR jsonb_typeof(active.route_snapshot->'supplies') IS DISTINCT FROM 'array'
        OR (SELECT count(*) FROM public.advanced_expedition_supplies WHERE expedition_id = active.id) <> jsonb_array_length(active.route_snapshot->'supplies')
      THEN RAISE EXCEPTION 'CURRENT_ADVANCED_FLIGHT_SOURCE'; END IF;
      IF active.departed_at > cutoff THEN unavailable := true; END IF;
    END IF;
    IF NOT isfinite(installed.installed_at) OR NOT isfinite(installed.berth_completed_at)
      OR EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE id = installed.reservation_id AND NOT isfinite(reserved_at))
      OR EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions WHERE reservation_id = installed.reservation_id AND NOT isfinite(recorded_at))
      OR EXISTS(SELECT 1 FROM public.vehicle_service_applications a JOIN public.vehicle_service_consumptions c ON c.intent_id = a.intent_id
        WHERE a.installation_id = installed.reservation_id AND (NOT isfinite(a.applied_at) OR NOT isfinite(c.recorded_at)))
      OR EXISTS(SELECT 1 FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id = r.expedition_id
        WHERE e.installation_id = installed.reservation_id AND NOT isfinite(r.returned_at))
    THEN RAISE EXCEPTION 'CURRENT_ADVANCED_ORIGINAL_CLOCK'; END IF;
    -- A legitimate application after the shared cutoff is unavailable, never
    -- an excuse to advance only this optional field's event clock.
    IF installed.installed_at > cutoff OR installed.berth_completed_at > cutoff
      OR EXISTS(SELECT 1 FROM public.vehicle_activation_reservations WHERE id = installed.reservation_id AND reserved_at > cutoff)
      OR EXISTS(SELECT 1 FROM public.vehicle_burn_consumptions WHERE reservation_id = installed.reservation_id AND recorded_at > cutoff)
      OR EXISTS(SELECT 1 FROM public.vehicle_service_applications a JOIN public.vehicle_service_consumptions c ON c.intent_id = a.intent_id
        WHERE a.installation_id = installed.reservation_id AND (a.applied_at > cutoff OR c.recorded_at > cutoff))
      OR EXISTS(SELECT 1 FROM public.advanced_expedition_returns r JOIN public.advanced_expeditions e ON e.id = r.expedition_id
        WHERE e.installation_id = installed.reservation_id AND r.returned_at > cutoff)
    THEN unavailable := true; END IF;
    facts := facts || jsonb_build_array(jsonb_build_object('buildingId', installed.berth_id::text, 'installation', jsonb_build_object(
      'family', lifecycle.family, 'tier', lifecycle.tier, 'away', lifecycle.away,
      'completedTotal', lifecycle.completed_total::text, 'allowanceStart', lifecycle.allowance_start::text
    )));
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.advanced_expeditions e LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id = e.installation_id
      WHERE e.base_id = target AND (i.base_id IS DISTINCT FROM target OR NOT i.berth_id = ANY(seen_berths)))
    OR EXISTS(SELECT 1 FROM public.advanced_expedition_inflight f LEFT JOIN public.advanced_vehicle_installations i ON i.reservation_id = f.installation_id
      WHERE f.base_id = target AND (i.base_id IS DISTINCT FROM target OR NOT i.berth_id = ANY(seen_berths)))
  THEN RAISE EXCEPTION 'CURRENT_ADVANCED_FLIGHT_SOURCE'; END IF;
  IF unavailable THEN RETURN 'null'::jsonb; END IF;
  SELECT jsonb_build_object('version', 1, 'berths', coalesce(jsonb_agg(jsonb_build_object(
    'buildingId', b->'id', 'installation', coalesce((SELECT f->'installation' FROM jsonb_array_elements(facts) f WHERE f->>'buildingId' = b->>'id'), 'null'::jsonb)
  ) ORDER BY b->>'id'), '[]')) INTO result FROM jsonb_array_elements(actual) b;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_current_advanced_presentation(text,uuid,jsonb,timestamptz) FROM PUBLIC;
