-- S5 HELD: backfills money history and changes legacy deposit writes even with
-- Phase E disabled. Requires the owner's separate migration/release approval.
-- The migrator executes this entire file in ONE transaction. This lock excludes
-- deposit writers until the complete backfill and trigger are committed together.
SET LOCAL lock_timeout='10s';
LOCK TABLE public.deposits IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
 IF current_user::regrole::oid<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.deposits'::regclass)
  OR current_user::regrole::oid<>(SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.payment_signature_claims'::regclass)
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_MIGRATION_OWNER' USING ERRCODE='42501';END IF;
 -- Existing per-column unique indexes do not exclude a cross-column duplicate.
 -- Refuse the historical ambiguity before claiming any row; never choose a winner.
 IF EXISTS(SELECT signature FROM (
  SELECT id,payment_signature AS signature FROM public.deposits WHERE payment_signature IS NOT NULL
  UNION SELECT id,tx_signature FROM public.deposits WHERE tx_signature IS NOT NULL
 ) originals GROUP BY signature HAVING count(DISTINCT id)>1)
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_HISTORICAL_CONFLICT' USING ERRCODE='23505';END IF;
END $$;
--> statement-breakpoint
DO $$ DECLARE original record;
BEGIN
 FOR original IN SELECT id,signature FROM (
  SELECT id,payment_signature AS signature FROM public.deposits WHERE payment_signature IS NOT NULL
  UNION SELECT id,tx_signature FROM public.deposits WHERE tx_signature IS NOT NULL
 ) originals ORDER BY signature COLLATE "C",id LOOP
  -- No base58 filter: historical pda:<wallet> identifiers remain reserved too.
  PERFORM public.shardkeep_claim_payment_signature(original.signature,'deposit',original.id);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.shardkeep_deposit_payment_signature_capture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE payment text;
BEGIN
 IF TG_RELID<>'public.deposits'::regclass OR TG_NAME<>'deposits_payment_signature_claims'
  OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_OP NOT IN('INSERT','UPDATE')
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=TG_RELID AND tgname=TG_NAME
   AND tgfoid='public.shardkeep_deposit_payment_signature_capture()'::regprocedure AND tgenabled='O')
 THEN RAISE EXCEPTION 'PAYMENT_SIGNATURE_TRIGGER';END IF;
 -- AFTER excludes INSERT ... ON CONFLICT DO NOTHING attempts which wrote no
 -- consumer. Sort both columns before acquiring unique-index claim locks.
 FOR payment IN SELECT DISTINCT signature COLLATE "C" FROM (VALUES(NEW.payment_signature),(NEW.tx_signature)) originals(signature)
  WHERE signature IS NOT NULL ORDER BY 1 LOOP
  PERFORM public.shardkeep_claim_payment_signature(payment,'deposit',NEW.id);
 END LOOP;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.shardkeep_deposit_payment_signature_capture() FROM PUBLIC;
CREATE OR REPLACE TRIGGER deposits_payment_signature_claims AFTER INSERT OR UPDATE ON public.deposits
 FOR EACH ROW EXECUTE FUNCTION public.shardkeep_deposit_payment_signature_capture();
