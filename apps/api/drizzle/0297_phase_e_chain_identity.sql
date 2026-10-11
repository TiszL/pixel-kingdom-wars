-- UNNUMBERED CEDAR QUEUE ARTIFACT. Not installed or executed by MS-S.
-- Beacon 68d06fbe + 91c793ff: separate immutable Phase E identity, empty on
-- schema installation. No legacy identity/guard, money row or journal changes.
-- A separately reviewed one-time owner binding requires finalized ceremony and
-- deployment evidence. This DDL grants no authority to create that binding.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE TABLE public.phase_e_chain_identity (
 singleton boolean PRIMARY KEY DEFAULT true,
 cluster text NOT NULL,
 genesis_hash text NOT NULL,
 keep_mint text NOT NULL,
 economy_program text NOT NULL,
 craft_program text NOT NULL,
 treasury text NOT NULL,
 reserve_owner text NOT NULL,
 reserve_ata text NOT NULL,
 binding_receipt_sha256 text NOT NULL,
 bound_at timestamptz NOT NULL,
 CONSTRAINT phase_e_chain_identity_singleton_ck CHECK(singleton),
 CONSTRAINT phase_e_chain_identity_cluster_ck CHECK(cluster='devnet'),
 CONSTRAINT phase_e_chain_identity_genesis_ck CHECK(genesis_hash='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
 CONSTRAINT phase_e_chain_identity_addresses_ck CHECK(
   keep_mint ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND economy_program ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND craft_program ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND treasury ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND reserve_owner ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
   AND reserve_ata ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
 CONSTRAINT phase_e_chain_identity_roles_ck CHECK(
   keep_mint NOT IN(economy_program,craft_program,treasury,reserve_owner,reserve_ata)
   AND economy_program<>craft_program AND reserve_owner<>reserve_ata),
 CONSTRAINT phase_e_chain_identity_receipt_ck CHECK(binding_receipt_sha256 ~ '^[0-9a-f]{64}$'),
 CONSTRAINT phase_e_chain_identity_time_ck CHECK(isfinite(bound_at))
);
REVOKE ALL ON public.phase_e_chain_identity FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.shardkeep_phase_e_chain_identity_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 history_table text;
 has_history boolean;
 -- Publication/claim/tax/market/recovery history, plus unsigned input custody.
 -- No matching-tuple exemption. Seeded policy and observational coverage rows
 -- are not transactional mint obligations. See the companion inventory README.
 history_tables CONSTANT text[] := ARRAY[
  'keep_equipment_deliveries',
  'keep_equipment_fill_releases',
  'keep_equipment_fills',
  'keep_equipment_listing_cancellations',
  'keep_equipment_listings',
  'keep_equipment_payment_preparations',
  'keep_equipment_payment_wires',
  'mining_claim_continuations',
  'mining_claim_entitlement_headers',
  'mining_claim_entitlement_leaves',
  'mining_claim_failures',
  'mining_claim_preparations',
  'mining_claim_receipts',
  'mining_claim_signed_wires',
  'mining_contribution_lines',
  'mining_contribution_receipts',
  'mining_contribution_terminals',
  'mining_ingot_aborts',
  'mining_ingot_dispositions',
  'mining_ingot_epochs',
  'mining_ingot_releases',
  'mining_ingot_reservations',
  'mining_publication_attempts',
  'mining_publication_manifests',
  'mining_publication_settlements',
  'mining_publication_signed_wires',
  'mining_publication_signing_reservations',
  'mining_tax_claim_continuations',
  'mining_tax_claim_failures',
  'mining_tax_claim_preparations',
  'mining_tax_claim_receipts',
  'mining_tax_claim_signed_wires',
  'payment_signature_claims'
 ];
BEGIN
 IF TG_RELID<>'public.phase_e_chain_identity'::regclass OR TG_WHEN<>'BEFORE'
  OR NOT ((TG_NAME='phase_e_chain_identity_guard' AND TG_LEVEL='ROW' AND TG_OP IN('INSERT','UPDATE','DELETE'))
   OR (TG_NAME='phase_e_chain_identity_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'PHASE_E_IDENTITY_TRIGGER' USING ERRCODE='42501'; END IF;
 IF TG_OP<>'INSERT' THEN
  RAISE EXCEPTION 'PHASE_E_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID)
  OR session_user<>current_user THEN
  RAISE EXCEPTION 'PHASE_E_IDENTITY_OWNER' USING ERRCODE='42501'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'PHASE_E_IDENTITY_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 IF NEW.bound_at IS NOT NULL THEN
  RAISE EXCEPTION 'PHASE_E_IDENTITY_DERIVED_FIELDS' USING ERRCODE='23514'; END IF;

 -- Existing history writers do not take a common advisory lock. Acquire the
 -- actual table locks first, in deterministic order, so an uncommitted writer
 -- cannot hide behind MVCC and a new writer cannot cross the absence check.
 -- Missing tables fail closed. NOWAIT avoids a migration/binder deadlock with
 -- an existing custody operation. These locks last until the binding commits.
 FOREACH history_table IN ARRAY history_tables LOOP
  EXECUTE format('LOCK TABLE public.%I IN SHARE MODE NOWAIT',history_table);
 END LOOP;
 FOREACH history_table IN ARRAY history_tables LOOP
  IF history_table='payment_signature_claims' THEN
   -- This shared append-only registry outlives market rows. Old deposit claims
   -- belong to v3 custody and are deliberately not Phase E market history.
   SELECT EXISTS(SELECT 1 FROM public.payment_signature_claims WHERE consumer_kind='keep_equipment_market') INTO has_history;
  ELSE
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',history_table) INTO has_history;
  END IF;
  IF has_history THEN
   RAISE EXCEPTION 'PHASE_E_IDENTITY_HISTORY: %',history_table USING ERRCODE='23514';
  END IF;
 END LOOP;
 NEW.bound_at:=clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_phase_e_chain_identity_guard() FROM PUBLIC;
CREATE TRIGGER phase_e_chain_identity_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.phase_e_chain_identity
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_phase_e_chain_identity_guard();
CREATE TRIGGER phase_e_chain_identity_no_truncate
 BEFORE TRUNCATE ON public.phase_e_chain_identity
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_phase_e_chain_identity_guard();
--> statement-breakpoint
-- Existing serving roles receive only the SELECT needed by the startup
-- assertion. No INSERT/UPDATE/DELETE/TRUNCATE or security-definer capability.
DO $$
DECLARE runtime_role text;
BEGIN
 FOREACH runtime_role IN ARRAY ARRAY['shardkeep_api_runtime','shardkeep_worker_runtime'] LOOP
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=runtime_role) THEN
   EXECUTE format('GRANT SELECT ON public.phase_e_chain_identity TO %I',runtime_role);
  END IF;
 END LOOP;
END $$;
