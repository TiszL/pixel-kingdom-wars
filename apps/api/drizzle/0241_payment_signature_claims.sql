-- D-190 prerequisite only: permanent cross-consumer payment identities.
-- Additive; no existing money table or writer is changed by this migration.
SET LOCAL lock_timeout='10s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.payment_signature_claims(
 signature text PRIMARY KEY,
 consumer_kind text NOT NULL CHECK(consumer_kind IN('deposit','keep_equipment_market')),
 consumer_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Deliberately no consumer FK/cascade: identity survives expiry, clearing and
-- deletion, and claiming must not acquire a lock on another consumer's row.
REVOKE ALL ON public.payment_signature_claims FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_payment_signature_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'public.payment_signature_claims'::regclass OR TG_WHEN<>'BEFORE'
  OR NOT ((TG_NAME='payment_signature_guard' AND TG_LEVEL='ROW' AND TG_OP IN('INSERT','UPDATE','DELETE'))
   OR (TG_NAME='payment_signature_no_truncate' AND TG_LEVEL='STATEMENT' AND TG_OP='TRUNCATE'))
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_TRIGGER';END IF;
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_OWNER' USING ERRCODE='42501';END IF;
 IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_IMMUTABLE' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_payment_signature_guard() FROM PUBLIC;
CREATE OR REPLACE TRIGGER payment_signature_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payment_signature_claims
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_payment_signature_guard();
CREATE OR REPLACE TRIGGER payment_signature_no_truncate BEFORE TRUNCATE ON public.payment_signature_claims
 FOR EACH STATEMENT EXECUTE FUNCTION public.shardkeep_payment_signature_guard();
--> statement-breakpoint
-- Invoker security: only the owner or an owner-defined, table-bound capture
-- trigger can claim. Future market capture must derive its own consumer ID.
CREATE OR REPLACE FUNCTION public.shardkeep_claim_payment_signature(p_signature text,p_consumer_kind text,p_consumer_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE claimed text;
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.payment_signature_claims'::regclass)
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_OWNER' USING ERRCODE='42501';END IF;
 INSERT INTO public.payment_signature_claims(signature,consumer_kind,consumer_id)
 VALUES(p_signature,p_consumer_kind,p_consumer_id)
 ON CONFLICT(signature) DO UPDATE SET signature=EXCLUDED.signature
 WHERE payment_signature_claims.consumer_kind=EXCLUDED.consumer_kind AND payment_signature_claims.consumer_id=EXCLUDED.consumer_id
 RETURNING signature INTO claimed;
 IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_ALREADY_CLAIMED' USING ERRCODE='23505';END IF;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_claim_payment_signature(text,text,uuid) FROM PUBLIC;
